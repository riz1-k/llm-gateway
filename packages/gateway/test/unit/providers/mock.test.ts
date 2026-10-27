import { describe, expect, it } from 'vitest';
import { ChunkAccumulator, isMeaningfulChunk } from '../../../src/core/chunks.js';
import { ProviderError } from '../../../src/core/errors.js';
import type { ChatChunk, ChatRequest } from '../../../src/core/types.js';
import {
  mockProviderSchema,
  modelSchema,
  type MockProviderConfig,
} from '../../../src/config/schema.js';
import type { ResolvedModel, ResolvedRoute } from '../../../src/config/resolve.js';
import type { AttemptContext } from '../../../src/providers/base.js';
import { MockAdapter } from '../../../src/providers/mock.js';
import { silentLogger } from '../../../src/observability/logger.js';
import { DeadlineExceededError } from '../../../src/util/abort.js';

const logger = silentLogger();

function provider(overrides: Record<string, unknown> = {}): MockProviderConfig {
  return mockProviderSchema.parse({ type: 'mock', ...overrides });
}

function target(
  name: string,
  upstream: string,
  kind: 'chat' | 'embedding' | 'rerank' = 'chat',
  options: Record<string, unknown> = {},
): ResolvedModel {
  const config = modelSchema.parse({ provider: 'mock', model: upstream, kind, options });
  return {
    name,
    providerName: 'mock',
    provider: provider(),
    upstreamModel: upstream,
    kind,
    baseUrl: undefined,
    inputTemplates: undefined,
    pricing: undefined,
    timeoutMs: 1000,
    params: {},
    options,
    enabled: true,
    disabledReason: undefined,
    config,
  };
}

const route: ResolvedRoute = {
  name: 'mock-chat',
  kind: 'chat',
  description: undefined,
  targets: [{ model: 'mock-chat', weight: 1, timeoutMs: undefined }],
  strategy: 'fallback',
  retry: { attempts: 1, backoff_ms: 0, max_backoff_ms: 0, max_retry_after_ms: 0 },
  timeoutMs: 1000,
  cache: undefined,
  defaults: {},
  hidden: false,
  direct: false,
};

function ctx(
  headers: Record<string, string> = {},
  signal: AbortSignal = new AbortController().signal,
): AttemptContext {
  return {
    requestId: 'req_test',
    signal,
    logger,
    requestHeaders: new Headers(headers),
    route,
    attempt: 1,
  };
}

const chatReq = (content: string, extra: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'mock-chat',
  messages: [{ role: 'user', content }],
  ...extra,
});

async function collect(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe('MockAdapter chat', () => {
  it('echoes with usage and the upstream model id', async () => {
    const a = new MockAdapter('mock', provider(), { logger });
    const res = await a.chat(chatReq('hello gateway'), target('mock-chat', 'mock-echo'), ctx());
    expect(res.model).toBe('mock-echo');
    expect(res.choices[0]!.message.content).toBe('hello gateway');
    expect(res.choices[0]!.finish_reason).toBe('stop');
    expect(res.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(res.usage!.total_tokens).toBe(res.usage!.prompt_tokens + res.usage!.completion_tokens);
  });

  it('uses configured fixed text and extractive threshold', async () => {
    const a = new MockAdapter(
      'mock',
      provider({ fixed_text: 'FIXED', extractive_threshold: 0.99 }),
      { logger },
    );
    expect(
      (await a.chat(chatReq('x'), target('f', 'mock-fixed'), ctx())).choices[0]!.message.content,
    ).toBe('FIXED');
    const rag = chatReq(
      '<source id="1">Cats purr loudly. Dogs bark.</source>\nQuestion: Do cats purr or meow?',
    );
    expect(
      (await a.chat(rag, target('e', 'mock-extractive'), ctx())).choices[0]!.message.content,
    ).toBe('NO_ANSWER');
  });

  it('returns OpenAI tool_calls for mock-tools', async () => {
    const a = new MockAdapter('mock', provider(), { logger });
    const res = await a.chat(
      chatReq('find order', {
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_order',
              parameters: {
                type: 'object',
                properties: { order_id: { type: 'string' } },
                required: ['order_id'],
              },
            },
          },
        ],
      }),
      target('t', 'mock-tools'),
      ctx(),
    );
    const msg = res.choices[0]!.message;
    expect(res.choices[0]!.finish_reason).toBe('tool_calls');
    expect(msg.content).toBeNull();
    expect(msg.tool_calls![0]!.id).toMatch(/^call_/);
    expect(JSON.parse(msg.tool_calls![0]!.function.arguments)).toEqual({ order_id: 'mock' });
  });

  it('follows provider-level scripts by id', async () => {
    const a = new MockAdapter('mock', provider({ scripts: { s: [{ content: 'scripted!' }] } }), {
      logger,
    });
    const res = await a.chat(
      chatReq('x', { metadata: { mock_script_id: 's' } }),
      target('t', 'mock-tools'),
      ctx(),
    );
    expect(res.choices[0]!.message.content).toBe('scripted!');
  });
});

describe('MockAdapter streaming', () => {
  it('streams role → content → finish → usage and reassembles to the same text', async () => {
    const a = new MockAdapter('mock', provider(), { logger });
    const chunks = await collect(
      a.chatStream(
        chatReq('one two three four five six seven eight'),
        target('m', 'mock-echo'),
        ctx(),
      ),
    );
    expect(chunks[0]!.choices[0]!.delta.role).toBe('assistant');
    expect(isMeaningfulChunk(chunks[0]!)).toBe(false);
    const acc = new ChunkAccumulator();
    chunks.forEach((c) => acc.push(c));
    const res = acc.toResponse();
    expect(res.choices[0]!.message.content).toBe('one two three four five six seven eight');
    expect(res.choices[0]!.finish_reason).toBe('stop');
    expect(chunks.at(-1)!.usage).toBeDefined();
    expect(chunks.at(-1)!.choices).toEqual([]);
  });

  it('streams tool call deltas', async () => {
    const a = new MockAdapter('mock', provider(), { logger });
    const chunks = await collect(
      a.chatStream(
        chatReq('x', {
          tools: [
            {
              type: 'function',
              function: { name: 'ping', parameters: { type: 'object', properties: {} } },
            },
          ],
        }),
        target('t', 'mock-tools'),
        ctx(),
      ),
    );
    const acc = new ChunkAccumulator();
    chunks.forEach((c) => acc.push(c));
    const res = acc.toResponse();
    expect(res.choices[0]!.finish_reason).toBe('tool_calls');
    expect(res.choices[0]!.message.tool_calls![0]!.function).toEqual({
      name: 'ping',
      arguments: '{}',
    });
  });

  it('fails mid-stream after N content chunks (stream_fail_after)', async () => {
    const a = new MockAdapter('mock', provider({ allow_header_faults: true }), { logger });
    const seen: ChatChunk[] = [];
    const run = async (): Promise<void> => {
      for await (const c of a.chatStream(
        chatReq('a b c d e f g h i'),
        target('m', 'mock-echo'),
        ctx({ 'x-mock-stream-fail-after': '1' }),
      ))
        seen.push(c);
    };
    await expect(run()).rejects.toMatchObject({ code: 'upstream_error', retryable: true });
    expect(seen.filter((c) => c.choices[0]?.delta.content).length).toBe(1);
  });

  it('fails before the first meaningful chunk with stream_fail_after = 0', async () => {
    const a = new MockAdapter('mock', provider({ faults: { stream_fail_after: 0 } }), { logger });
    const seen: ChatChunk[] = [];
    const run = async (): Promise<void> => {
      for await (const c of a.chatStream(chatReq('a b c'), target('m', 'mock-echo'), ctx()))
        seen.push(c);
    };
    await expect(run()).rejects.toBeInstanceOf(ProviderError);
    expect(seen.some(isMeaningfulChunk)).toBe(false);
  });
});

describe('MockAdapter faults', () => {
  it('ignores headers unless allow_header_faults is set', async () => {
    const a = new MockAdapter('mock', provider(), { logger });
    await expect(
      a.chat(chatReq('x'), target('m', 'mock-echo'), ctx({ 'x-mock-status': '503' })),
    ).resolves.toBeDefined();
  });

  it('throws classified ProviderErrors with retry-after from headers', async () => {
    const a = new MockAdapter('mock', provider({ allow_header_faults: true }), { logger });
    const err = await a
      .chat(
        chatReq('x'),
        target('m', 'mock-echo'),
        ctx({ 'x-mock-status': '429', 'x-mock-retry-after': '2' }),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({
      code: 'rate_limited',
      retryable: true,
      retryAfterMs: 2000,
      status: 429,
    });
    const bad = await a
      .chat(chatReq('x'), target('m', 'mock-echo'), ctx({ 'x-mock-status': '400' }))
      .catch((e: unknown) => e);
    expect(bad).toMatchObject({ code: 'invalid_request', retryable: false, fallback: false });
  });

  it('scopes header faults to a target via x-mock-fault-target', async () => {
    const a = new MockAdapter('mock', provider({ allow_header_faults: true }), { logger });
    const headers = { 'x-mock-status': '503', 'x-mock-fault-target': 'mock-down' };
    await expect(
      a.chat(chatReq('x'), target('mock-down', 'mock-echo'), ctx(headers)),
    ).rejects.toMatchObject({ code: 'upstream_unavailable' });
    await expect(
      a.chat(chatReq('x'), target('mock-up', 'mock-echo'), ctx(headers)),
    ).resolves.toBeDefined();
  });

  it('applies model-level options.fault (always-down model)', async () => {
    const a = new MockAdapter('mock', provider(), { logger });
    await expect(
      a.chat(chatReq('x'), target('down', 'mock-echo', 'chat', { fault: { status: 503 } }), ctx()),
    ).rejects.toMatchObject({ status: 503, retryable: true });
  });

  it('uses the injected RNG for fail_rate', async () => {
    const always = new MockAdapter(
      'mock',
      provider({ faults: { fail_rate: 0.5, status: 500 } }),
      { logger },
      () => 0.1,
    );
    const never = new MockAdapter(
      'mock',
      provider({ faults: { fail_rate: 0.5, status: 500 } }),
      { logger },
      () => 0.9,
    );
    await expect(always.chat(chatReq('x'), target('m', 'mock-echo'), ctx())).rejects.toMatchObject({
      status: 500,
    });
    await expect(never.chat(chatReq('x'), target('m', 'mock-echo'), ctx())).resolves.toBeDefined();
  });

  it('maps an attempt deadline during injected latency to upstream_timeout', async () => {
    const a = new MockAdapter('mock', provider({ allow_header_faults: true }), { logger });
    const ac = new AbortController();
    setTimeout(() => ac.abort(new DeadlineExceededError(20)), 20);
    const t0 = Date.now();
    await expect(
      a.chat(
        chatReq('x'),
        target('m', 'mock-echo'),
        ctx({ 'x-mock-latency-ms': '5000' }, ac.signal),
      ),
    ).rejects.toMatchObject({ code: 'upstream_timeout', retryable: true });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('maps a client abort to a non-failure aborted error', async () => {
    const a = new MockAdapter('mock', provider({ allow_header_faults: true }), { logger });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    await expect(
      a.chat(
        chatReq('x'),
        target('m', 'mock-echo'),
        ctx({ 'x-mock-latency-ms': '5000' }, ac.signal),
      ),
    ).rejects.toMatchObject({ code: 'aborted', countsAsFailure: false });
  });
});

describe('MockAdapter embeddings & rerank', () => {
  it('returns deterministic embeddings of the configured dimension', async () => {
    const a = new MockAdapter('mock', provider({ embedding_dim: 48 }), { logger });
    const t = target('emb', 'mock-embed', 'embedding');
    const r1 = await a.embed({ model: 'x', input: ['alpha beta', 'gamma'] }, t, ctx());
    const r2 = await a.embed({ model: 'x', input: 'alpha beta' }, t, ctx());
    expect(r1.data).toHaveLength(2);
    expect(r1.data[0]!.embedding).toHaveLength(48);
    expect(r2.data[0]!.embedding).toEqual(r1.data[0]!.embedding);
    expect(r1.usage.prompt_tokens).toBeGreaterThan(0);
    expect(
      (await a.embed({ model: 'x', input: 'a', dimensions: 8 }, t, ctx())).data[0]!.embedding,
    ).toHaveLength(8);
    expect(
      typeof (await a.embed({ model: 'x', input: 'a', encoding_format: 'base64' }, t, ctx()))
        .data[0]!.embedding,
    ).toBe('string');
  });

  it('rejects token-array input with a non-retryable error', async () => {
    const a = new MockAdapter('mock', provider(), { logger });
    await expect(
      a.embed({ model: 'x', input: [1, 2, 3] }, target('emb', 'mock-embed', 'embedding'), ctx()),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('reranks by lexical overlap with top_n and return_documents', async () => {
    const a = new MockAdapter('mock', provider(), { logger });
    const docs = [
      'bananas are yellow',
      'the cors middleware sets headers',
      'middleware runs first',
    ];
    const res = await a.rerank(
      {
        model: 'x',
        query: 'cors middleware headers',
        documents: docs,
        top_n: 2,
        return_documents: true,
      },
      target('rr', 'mock-rerank', 'rerank'),
      ctx(),
    );
    expect(res.results.map((r) => r.index)).toEqual([1, 2]);
    expect(res.results[0]!.document).toEqual({ text: docs[1] });
    expect(res.id).toMatch(/^rerank-/);
    expect(res.usage.total_tokens).toBeGreaterThan(0);
  });
});
