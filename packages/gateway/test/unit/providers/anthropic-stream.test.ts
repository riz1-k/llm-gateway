import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ResolvedModel, ResolvedRoute } from '../../../src/config/resolve.js';
import {
  modelSchema,
  providerSchema,
  type AnthropicProviderConfig,
} from '../../../src/config/schema.js';
import { ChunkAccumulator } from '../../../src/core/chunks.js';
import { ProviderError } from '../../../src/core/errors.js';
import type { ChatChunk, ChatRequest } from '../../../src/core/types.js';
import { silentLogger } from '../../../src/observability/logger.js';
import { AnthropicAdapter } from '../../../src/providers/anthropic/index.js';
import type { AttemptContext } from '../../../src/providers/base.js';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const fixtureText = (name: string): string =>
  readFileSync(new URL(`../../fixtures/anthropic/${name}`, import.meta.url), 'utf8');

/** Streams text in tiny byte slices to exercise event reassembly across chunk boundaries. */
function slicedStream(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(respond: () => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      headers,
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >,
    });
    return respond();
  };
  return { fetch: f, calls };
}

const sseResponse =
  (name: string, slice = 0): (() => Response) =>
  () =>
    new Response(slice > 0 ? slicedStream(fixtureText(name), slice) : fixtureText(name), {
      headers: { 'content-type': 'text/event-stream' },
    });

const config = providerSchema.parse({
  type: 'anthropic',
  api_key: 'sk-ant-test',
}) as AnthropicProviderConfig;

function target(): ResolvedModel {
  const m = modelSchema.parse({ provider: 'anthropic', model: 'claude-sonnet-4-5' });
  return {
    name: 'claude-sonnet',
    providerName: 'anthropic',
    provider: config,
    upstreamModel: m.model,
    kind: 'chat',
    baseUrl: undefined,
    inputTemplates: undefined,
    pricing: undefined,
    timeoutMs: 10_000,
    params: {},
    options: {},
    enabled: true,
    disabledReason: undefined,
    config: m,
  };
}

const route: ResolvedRoute = {
  name: 'claude-route',
  kind: 'chat',
  description: undefined,
  targets: [{ model: 'claude-sonnet', weight: 1, timeoutMs: undefined }],
  strategy: 'fallback',
  retry: { attempts: 1, backoff_ms: 0, max_backoff_ms: 0, max_retry_after_ms: 0 },
  timeoutMs: 10_000,
  cache: undefined,
  defaults: { max_tokens: 777 },
  hidden: false,
  direct: false,
};

const ctx = (): AttemptContext => ({
  requestId: 'req_t',
  signal: new AbortController().signal,
  logger: silentLogger(),
  requestHeaders: new Headers(),
  route,
  attempt: 1,
});

const baseReq: ChatRequest = {
  model: 'claude-route',
  stream: true,
  messages: [{ role: 'user', content: 'Hi' }],
};

async function run(
  adapter: AnthropicAdapter,
  req: ChatRequest = baseReq,
): Promise<{ chunks: ChatChunk[]; acc: ChunkAccumulator }> {
  const chunks: ChatChunk[] = [];
  const acc = new ChunkAccumulator();
  for await (const c of adapter.chatStream(req, target(), ctx())) {
    chunks.push(c);
    acc.push(c);
  }
  return { chunks, acc };
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe('AnthropicAdapter.chatStream', () => {
  it('sends a well-formed streaming Messages request', async () => {
    const { fetch, calls } = fakeFetch(sseResponse('text.sse'));
    await run(new AnthropicAdapter('anthropic', config, { logger: silentLogger(), fetch }));
    const call = calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers['x-api-key']).toBe('sk-ant-test');
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
    expect(call.headers.accept).toBe('text/event-stream');
    expect(call.body).toMatchObject({ model: 'claude-sonnet-4-5', stream: true, max_tokens: 777 });
  });

  it('translates a text stream into OpenAI chunks with a final usage chunk', async () => {
    const { fetch } = fakeFetch(sseResponse('text.sse'));
    const { chunks, acc } = await run(
      new AnthropicAdapter('anthropic', config, { logger: silentLogger(), fetch }),
    );
    expect(chunks[0]!.choices[0]!.delta).toEqual({ role: 'assistant', content: '' });
    expect(chunks[0]!.id).toBe('msg_01TextStream');
    expect(acc.content).toBe('Hello, world!');
    expect(acc.finishReason).toBe('stop');
    const last = chunks[chunks.length - 1]!;
    expect(last.choices).toEqual([]);
    expect(last.usage).toEqual({
      prompt_tokens: 35,
      completion_tokens: 12,
      total_tokens: 47,
      prompt_tokens_details: { cached_tokens: 10 },
    });
  });

  it('streams parallel tool calls with incremental arguments even when bytes are split mid-event', async () => {
    const { fetch } = fakeFetch(sseResponse('tool_use.sse', 7));
    const { chunks, acc } = await run(
      new AnthropicAdapter('anthropic', config, { logger: silentLogger(), fetch }),
    );
    const res = acc.toResponse();
    expect(res.choices[0]!.message.content).toBe('Let me look that up.');
    expect(res.choices[0]!.finish_reason).toBe('tool_calls');
    expect(res.choices[0]!.message.tool_calls).toEqual([
      {
        id: 'toolu_01A',
        type: 'function',
        function: { name: 'get_order', arguments: '{"order_id": "ORD-1"}' },
      },
      {
        id: 'toolu_01B',
        type: 'function',
        function: { name: 'get_customer', arguments: '{"customer_id": 42}' },
      },
    ]);
    // Arguments arrive incrementally (one delta per input_json_delta), never as a single blob.
    const argDeltas = chunks
      .flatMap((c) => c.choices.flatMap((ch) => ch.delta.tool_calls ?? []))
      .filter((t) => t.index === 0 && t.function?.arguments);
    expect(argDeltas.length).toBe(3);
    expect(acc.usage!.prompt_tokens).toBe(412);
    expect(acc.usage!.completion_tokens).toBe(89);
  });

  it('hides thinking by default and exposes it as reasoning_content on request', async () => {
    let fx = fakeFetch(sseResponse('thinking.sse'));
    let r = await run(
      new AnthropicAdapter('anthropic', config, { logger: silentLogger(), fetch: fx.fetch }),
      { ...baseReq, reasoning_effort: 'low' },
    );
    expect(r.acc.content).toBe('4');
    expect(r.acc.reasoning).toBe('');
    expect(fx.calls[0]!.body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });

    fx = fakeFetch(sseResponse('thinking.sse'));
    r = await run(
      new AnthropicAdapter('anthropic', config, { logger: silentLogger(), fetch: fx.fetch }),
      {
        ...baseReq,
        metadata: { include_reasoning: true },
      },
    );
    expect(r.acc.reasoning).toBe('The user wants 2+2. That is 4.');
  });

  it('streams json_schema tool-mode output as plain content', async () => {
    const { fetch } = fakeFetch(sseResponse('json_tool.sse'));
    const { acc } = await run(
      new AnthropicAdapter('anthropic', config, { logger: silentLogger(), fetch }),
      {
        ...baseReq,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'r', schema: { type: 'object' } },
        },
      },
    );
    expect(acc.content).toBe('{"answer": 42}');
    expect(acc.finishReason).toBe('stop');
    expect(acc.toResponse().choices[0]!.message.tool_calls).toBeUndefined();
  });

  it('throws a retryable ProviderError on a mid-stream overloaded error event', async () => {
    const { fetch } = fakeFetch(sseResponse('error.sse'));
    const adapter = new AnthropicAdapter('anthropic', config, { logger: silentLogger(), fetch });
    const seen: ChatChunk[] = [];
    const err = await (async () => {
      try {
        for await (const c of adapter.chatStream(baseReq, target(), ctx())) seen.push(c);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('upstream_unavailable');
    expect((err as ProviderError).retryable).toBe(true);
    expect(seen.some((c) => c.choices[0]?.delta.content === 'Partial')).toBe(true);
  });

  it('fails when the stream ends without message_stop', async () => {
    const truncated = fixtureText('text.sse').split('event: message_delta')[0]!;
    const { fetch } = fakeFetch(
      () => new Response(truncated, { headers: { 'content-type': 'text/event-stream' } }),
    );
    await expect(
      run(new AnthropicAdapter('anthropic', config, { logger: silentLogger(), fetch })),
    ).rejects.toMatchObject({
      code: 'upstream_error',
      retryable: true,
    });
  });
});

describe('AnthropicAdapter.chat', () => {
  it('translates a non-streaming tool_use response', async () => {
    const { fetch, calls } = fakeFetch(
      () =>
        new Response(fixtureText('message_tool_use.json'), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    const adapter = new AnthropicAdapter('anthropic', config, { logger: silentLogger(), fetch });
    const res = await adapter.chat({ ...baseReq, stream: false }, target(), ctx());
    expect(calls[0]!.body.stream).toBeUndefined();
    expect(res.choices[0]!.finish_reason).toBe('tool_calls');
    expect(res.choices[0]!.message.tool_calls![0]!.function.name).toBe('get_order');
    expect(res.usage!.prompt_tokens).toBe(420);
  });

  it('maps 529 overloaded to a retryable upstream_unavailable', async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'overloaded_error', message: 'Overloaded' },
          }),
          { status: 529 },
        ),
    );
    const adapter = new AnthropicAdapter('anthropic', config, { logger: silentLogger(), fetch });
    await expect(adapter.chat(baseReq, target(), ctx())).rejects.toMatchObject({
      code: 'upstream_unavailable',
      status: 529,
      retryable: true,
    });
  });

  it('maps 400 to a non-retryable invalid_request with the upstream message', async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'messages: field required' },
          }),
          {
            status: 400,
          },
        ),
    );
    const adapter = new AnthropicAdapter('anthropic', config, { logger: silentLogger(), fetch });
    const err = await adapter.chat(baseReq, target(), ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('invalid_request');
    expect((err as ProviderError).fallback).toBe(false);
    expect((err as ProviderError).message).toContain('messages: field required');
  });
});
