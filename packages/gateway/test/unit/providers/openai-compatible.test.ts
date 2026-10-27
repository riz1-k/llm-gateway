import { describe, expect, it } from 'vitest';
import type { ResolvedModel, ResolvedRoute } from '../../../src/config/resolve.js';
import { modelSchema, providerSchema, type ProviderConfig } from '../../../src/config/schema.js';
import { ChunkAccumulator } from '../../../src/core/chunks.js';
import { ProviderError } from '../../../src/core/errors.js';
import type { ChatChunk, ChatRequest } from '../../../src/core/types.js';
import { silentLogger } from '../../../src/observability/logger.js';
import type { AttemptContext } from '../../../src/providers/base.js';
import { OpenAIAdapter } from '../../../src/providers/openai.js';
import { OpenAICompatibleAdapter } from '../../../src/providers/openai-compatible.js';
import { DeadlineExceededError } from '../../../src/util/abort.js';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

type Responder = (req: Recorded, init: RequestInit | undefined) => Response | Promise<Response>;

function fakeFetch(responder: Responder): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const rec: Recorded = {
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      headers,
      body:
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
    };
    calls.push(rec);
    return responder(rec, init);
  };
  return { fetch: f, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const sse = (events: (string | object)[]): Response =>
  new Response(
    events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );

function provider(raw: Record<string, unknown>): ProviderConfig {
  return providerSchema.parse(raw);
}

function target(p: ProviderConfig, overrides: Record<string, unknown> = {}): ResolvedModel {
  const config = modelSchema.parse({ provider: 'local', model: 'qwen3.5-2b', ...overrides });
  return {
    name: 'local-qwen',
    providerName: 'local',
    provider: p,
    upstreamModel: config.model,
    kind: config.kind,
    baseUrl: config.base_url,
    inputTemplates: config.input_templates,
    pricing: undefined,
    timeoutMs: 10_000,
    params: config.params,
    options: config.options,
    enabled: true,
    disabledReason: undefined,
    config,
  };
}

const route: ResolvedRoute = {
  name: 'test-route',
  kind: 'chat',
  description: undefined,
  targets: [{ model: 'local-qwen', weight: 1, timeoutMs: undefined }],
  strategy: 'fallback',
  retry: { attempts: 1, backoff_ms: 0, max_backoff_ms: 0, max_retry_after_ms: 0 },
  timeoutMs: 10_000,
  cache: undefined,
  defaults: {},
  hidden: false,
  direct: false,
};

function ctx(signal: AbortSignal = new AbortController().signal): AttemptContext {
  return {
    requestId: 'req_test',
    signal,
    logger: silentLogger(),
    requestHeaders: new Headers(),
    route,
    attempt: 1,
  };
}

async function collect(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

async function rejection(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  }
  throw new Error('expected rejection');
}

const compatConfig = provider({
  type: 'openai-compatible',
  base_url: 'http://127.0.0.1:8081/v1/',
  api_key: 'sk-local',
  headers: { 'x-extra': 'yes' },
});

const baseReq: ChatRequest = {
  model: 'test-route',
  messages: [{ role: 'user', content: 'Hello there' }],
};

const okCompletion = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'qwen3.5-2b',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
};

// ---------------------------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------------------------

describe('OpenAICompatibleAdapter.chat', () => {
  it('sanitizes the body, merges model params and sends auth + custom headers', async () => {
    const { fetch, calls } = fakeFetch(() => json(okCompletion));
    const adapter = new OpenAICompatibleAdapter('local', compatConfig as never, {
      logger: silentLogger(),
      fetch,
    });
    const t = target(compatConfig, {
      params: { temperature: 0.2, top_k: 20 },
      base_url: 'http://127.0.0.1:9999/v1',
    });
    const res = await adapter.chat(
      {
        ...baseReq,
        temperature: 0.7,
        metadata: { include_reasoning: true },
        input_type: 'query',
        stop: null,
        reasoning_effort: 'none',
        stream: false,
        stream_options: { include_usage: true },
      },
      t,
      ctx(),
    );
    expect(res.choices[0]!.message.content).toBe('Hi!');
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('http://127.0.0.1:9999/v1/chat/completions');
    expect(call.headers.authorization).toBe('Bearer sk-local');
    expect(call.headers['x-extra']).toBe('yes');
    expect(call.body).toEqual({
      model: 'qwen3.5-2b',
      messages: [{ role: 'user', content: 'Hello there' }],
      temperature: 0.7,
      top_k: 20,
    });
  });

  it('keeps a real reasoning_effort and native tools', async () => {
    const { fetch, calls } = fakeFetch(() => json(okCompletion));
    const adapter = new OpenAICompatibleAdapter('local', compatConfig as never, {
      logger: silentLogger(),
      fetch,
    });
    const tools = [
      {
        type: 'function' as const,
        function: { name: 'get_order', parameters: { type: 'object' } },
      },
    ];
    await adapter.chat(
      { ...baseReq, reasoning_effort: 'low', tools, tool_choice: 'auto' },
      target(compatConfig),
      ctx(),
    );
    expect(calls[0]!.body).toMatchObject({ reasoning_effort: 'low', tools, tool_choice: 'auto' });
    expect(calls[0]!.url).toBe('http://127.0.0.1:8081/v1/chat/completions');
  });

  it('estimates usage when the upstream omits it and fills missing fields', async () => {
    const { fetch } = fakeFetch(() =>
      json({ choices: [{ message: { content: 'Some answer text' } }] }),
    );
    const adapter = new OpenAICompatibleAdapter('local', compatConfig as never, {
      logger: silentLogger(),
      fetch,
    });
    const res = await adapter.chat(baseReq, target(compatConfig), ctx());
    expect(res.object).toBe('chat.completion');
    expect(res.id).toMatch(/^chatcmpl-/);
    expect(res.model).toBe('qwen3.5-2b');
    expect(res.choices[0]!.finish_reason).toBe('stop');
    expect(res.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(res.usage!.completion_tokens).toBeGreaterThan(0);
    expect(res.usage!.total_tokens).toBe(res.usage!.prompt_tokens + res.usage!.completion_tokens);
  });

  it('rejects tools when the upstream does not support them (fallback-eligible)', async () => {
    const cfg = provider({
      type: 'openai-compatible',
      base_url: 'http://x/v1',
      supports_tools: false,
    });
    const { fetch, calls } = fakeFetch(() => json(okCompletion));
    const adapter = new OpenAICompatibleAdapter('local', cfg as never, {
      logger: silentLogger(),
      fetch,
    });
    const err = await rejection(
      adapter.chat(
        { ...baseReq, tools: [{ type: 'function', function: { name: 'f' } }] },
        target(cfg),
        ctx(),
      ),
    );
    expect(err.code).toBe('unsupported_content');
    expect(err.status).toBe(400);
    expect(err.fallback).toBe(true);
    expect(err.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it.each([
    [429, 'rate_limited', true, true],
    [503, 'upstream_unavailable', true, true],
    [500, 'upstream_error', true, true],
    [401, 'upstream_auth', false, true],
    [404, 'upstream_not_found', false, true],
    [400, 'invalid_request', false, false],
  ] as const)('maps upstream %i to %s', async (status, code, retryable, fallback) => {
    const { fetch } = fakeFetch(() =>
      json(
        { error: { message: `boom ${status}` } },
        status,
        status === 429 ? { 'retry-after': '3' } : {},
      ),
    );
    const adapter = new OpenAICompatibleAdapter('local', compatConfig as never, {
      logger: silentLogger(),
      fetch,
    });
    const err = await rejection(adapter.chat(baseReq, target(compatConfig), ctx()));
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
    expect(err.fallback).toBe(fallback);
    expect(err.message).toContain(`boom ${status}`);
    if (status === 429) expect(err.retryAfterMs).toBe(3000);
  });

  it('maps network failures to a retryable network_error', async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    });
    const adapter = new OpenAICompatibleAdapter('local', compatConfig as never, {
      logger: silentLogger(),
      fetch,
    });
    const err = await rejection(adapter.chat(baseReq, target(compatConfig), ctx()));
    expect(err.code).toBe('network_error');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('ECONNREFUSED');
  });

  it('maps a deadline abort to upstream_timeout', async () => {
    const controller = new AbortController();
    const { fetch } = fakeFetch((_req, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error));
        controller.abort(new DeadlineExceededError(50));
      });
    });
    const adapter = new OpenAICompatibleAdapter('local', compatConfig as never, {
      logger: silentLogger(),
      fetch,
    });
    const err = await rejection(
      adapter.chat(baseReq, target(compatConfig), ctx(controller.signal)),
    );
    expect(err.code).toBe('upstream_timeout');
    expect(err.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------------------------

describe('OpenAICompatibleAdapter.chatStream', () => {
  const chunk = (delta: object, finish: string | null = null): object => ({
    id: 'chatcmpl-s',
    object: 'chat.completion.chunk',
    created: 5,
    model: 'qwen3.5-2b',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  it('forces include_usage and passes chunks and the usage chunk through', async () => {
    const { fetch, calls } = fakeFetch(() =>
      sse([
        chunk({ role: 'assistant', content: '' }),
        chunk({ content: 'Hel' }),
        chunk({ content: 'lo' }),
        chunk({}, 'stop'),
        {
          id: 'chatcmpl-s',
          object: 'chat.completion.chunk',
          created: 5,
          model: 'qwen3.5-2b',
          choices: [],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        },
        '[DONE]',
      ]),
    );
    const adapter = new OpenAICompatibleAdapter('local', compatConfig as never, {
      logger: silentLogger(),
      fetch,
    });
    const chunks = await collect(
      adapter.chatStream({ ...baseReq, stream: true }, target(compatConfig), ctx()),
    );
    expect(calls[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(calls[0]!.headers.accept).toBe('text/event-stream');
    const acc = new ChunkAccumulator();
    chunks.forEach((c) => acc.push(c));
    expect(acc.content).toBe('Hello');
    expect(acc.finishReason).toBe('stop');
    expect(acc.usage).toEqual({ prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
    expect(chunks.filter((c) => c.usage)).toHaveLength(1);
  });

  it('normalizes sparse chunks and synthesizes usage when the upstream sends none', async () => {
    const cfg = provider({
      type: 'openai-compatible',
      base_url: 'http://x/v1',
      supports_stream_usage: false,
    });
    const { fetch, calls } = fakeFetch(() =>
      sse([
        { choices: [{ delta: { content: 'Partial answer' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]',
      ]),
    );
    const adapter = new OpenAICompatibleAdapter('local', cfg as never, {
      logger: silentLogger(),
      fetch,
    });
    const chunks = await collect(
      adapter.chatStream(
        { ...baseReq, stream: true, stream_options: { include_usage: true } },
        target(cfg),
        ctx(),
      ),
    );
    expect(calls[0]!.body!.stream_options).toBeUndefined();
    expect(chunks[0]!.object).toBe('chat.completion.chunk');
    expect(chunks[0]!.choices[0]!.index).toBe(0);
    expect(chunks[0]!.choices[0]!.finish_reason).toBeNull();
    expect(chunks[1]!.id).toBe(chunks[0]!.id);
    const last = chunks[chunks.length - 1]!;
    expect(last.choices).toEqual([]);
    expect(last.usage!.completion_tokens).toBeGreaterThan(0);
    expect(last.usage!.prompt_tokens).toBeGreaterThan(0);
  });

  it('turns an in-band error payload into a ProviderError', async () => {
    const { fetch } = fakeFetch(() =>
      sse([chunk({ content: 'a' }), { error: { message: 'model crashed' } }]),
    );
    const adapter = new OpenAICompatibleAdapter('local', compatConfig as never, {
      logger: silentLogger(),
      fetch,
    });
    const err = await rejection(collect(adapter.chatStream(baseReq, target(compatConfig), ctx())));
    expect(err.code).toBe('upstream_error');
    expect(err.message).toContain('model crashed');
  });

  it('fails before streaming when the upstream answers non-2xx', async () => {
    const { fetch } = fakeFetch(() => json({ error: { message: 'busy' } }, 503));
    const adapter = new OpenAICompatibleAdapter('local', compatConfig as never, {
      logger: silentLogger(),
      fetch,
    });
    const err = await rejection(collect(adapter.chatStream(baseReq, target(compatConfig), ctx())));
    expect(err.code).toBe('upstream_unavailable');
  });
});

// ---------------------------------------------------------------------------------------------
// Embeddings & rerank
// ---------------------------------------------------------------------------------------------

describe('OpenAICompatibleAdapter.embed', () => {
  it('strips gateway-only fields, sorts by index and keeps upstream usage', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({
        object: 'list',
        model: 'embeddinggemma-300m',
        data: [
          { object: 'embedding', index: 1, embedding: [0.3, 0.4] },
          { object: 'embedding', index: 0, embedding: [0.1, 0.2] },
        ],
        usage: { prompt_tokens: 7, total_tokens: 7 },
      }),
    );
    const adapter = new OpenAICompatibleAdapter('local', compatConfig as never, {
      logger: silentLogger(),
      fetch,
    });
    const t = target(compatConfig, {
      model: 'embeddinggemma-300m',
      kind: 'embedding',
      base_url: 'http://127.0.0.1:8082/v1',
    });
    const res = await adapter.embed(
      {
        model: 'docsqa-embed',
        input: ['task: a', 'task: b'],
        input_type: 'query',
        input_titles: ['x'],
      },
      t,
      ctx(),
    );
    expect(calls[0]!.url).toBe('http://127.0.0.1:8082/v1/embeddings');
    expect(calls[0]!.body).toEqual({ model: 'embeddinggemma-300m', input: ['task: a', 'task: b'] });
    expect(res.data.map((d) => d.index)).toEqual([0, 1]);
    expect(res.data[0]!.embedding).toEqual([0.1, 0.2]);
    expect(res.usage).toEqual({ prompt_tokens: 7, total_tokens: 7 });
  });

  it('estimates usage when absent and rejects malformed responses', async () => {
    let body: unknown = { data: [{ embedding: [1] }] };
    const { fetch } = fakeFetch(() => json(body));
    const adapter = new OpenAICompatibleAdapter('local', compatConfig as never, {
      logger: silentLogger(),
      fetch,
    });
    const t = target(compatConfig, { kind: 'embedding' });
    const res = await adapter.embed({ model: 'e', input: 'hello world' }, t, ctx());
    expect(res.usage.prompt_tokens).toBeGreaterThan(0);
    body = { nope: true };
    const err = await rejection(adapter.embed({ model: 'e', input: 'x' }, t, ctx()));
    expect(err.code).toBe('upstream_error');
  });
});

describe('OpenAICompatibleAdapter.rerank', () => {
  const docs = ['alpha', 'beta', 'gamma'];

  it('normalizes llama.cpp results: sorted desc, top_n, documents', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({
        model: 'jina-reranker-v1-tiny-en.f16',
        object: 'list',
        usage: { prompt_tokens: 30, total_tokens: 30 },
        results: [
          { index: 0, relevance_score: -2.1 },
          { index: 1, relevance_score: 3.5 },
          { index: 2, relevance_score: 0.4 },
        ],
      }),
    );
    const adapter = new OpenAICompatibleAdapter('local', compatConfig as never, {
      logger: silentLogger(),
      fetch,
    });
    const t = target(compatConfig, {
      model: 'jina-reranker-v1-tiny-en.f16',
      kind: 'rerank',
      base_url: 'http://127.0.0.1:8083/v1',
    });
    const res = await adapter.rerank(
      { model: 'docsqa-rerank', query: 'b?', documents: docs, top_n: 2, return_documents: true },
      t,
      ctx(),
    );
    expect(calls[0]!.url).toBe('http://127.0.0.1:8083/v1/rerank');
    expect(calls[0]!.body).toEqual({
      model: 'jina-reranker-v1-tiny-en.f16',
      query: 'b?',
      documents: docs,
      top_n: 2,
    });
    expect(res.results).toEqual([
      { index: 1, relevance_score: 3.5, document: { text: 'beta' } },
      { index: 2, relevance_score: 0.4, document: { text: 'gamma' } },
    ]);
    expect(res.usage.total_tokens).toBe(30);
    expect(res.id).toMatch(/^rerank-/);
  });

  it('accepts `score` fields and estimates usage when missing', async () => {
    const { fetch } = fakeFetch(() =>
      json({
        results: [
          { index: 2, score: 0.9 },
          { index: 0, score: 0.1 },
          { index: 9, score: 5 },
        ],
      }),
    );
    const adapter = new OpenAICompatibleAdapter('local', compatConfig as never, {
      logger: silentLogger(),
      fetch,
    });
    const res = await adapter.rerank(
      { model: 'r', query: 'q', documents: docs },
      target(compatConfig, { kind: 'rerank' }),
      ctx(),
    );
    expect(res.results).toEqual([
      { index: 2, relevance_score: 0.9 },
      { index: 0, relevance_score: 0.1 },
    ]);
    expect(res.usage.total_tokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Health & OpenAI native
// ---------------------------------------------------------------------------------------------

describe('health', () => {
  it('reports ok / failure from GET /models', async () => {
    let status = 200;
    const { fetch, calls } = fakeFetch(() => json({ data: [] }, status));
    const adapter = new OpenAICompatibleAdapter('local', compatConfig as never, {
      logger: silentLogger(),
      fetch,
    });
    await expect(adapter.health()).resolves.toMatchObject({ ok: true });
    expect(calls[0]!.url).toBe('http://127.0.0.1:8081/v1/models');
    status = 500;
    const h = await adapter.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain('500');
  });
});

describe('OpenAIAdapter', () => {
  const cfg = provider({
    type: 'openai',
    api_key: 'sk-openai',
    organization: 'org-1',
    project: 'proj-1',
  });

  it('targets api.openai.com with organization/project headers', async () => {
    const { fetch, calls } = fakeFetch(() => json(okCompletion));
    const adapter = new OpenAIAdapter('openai', cfg as never, { logger: silentLogger(), fetch });
    expect(adapter.type).toBe('openai');
    await adapter.chat(
      { ...baseReq, metadata: { a: 1 } },
      target(cfg, { model: 'gpt-5.1' }),
      ctx(),
    );
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]!.headers).toMatchObject({
      authorization: 'Bearer sk-openai',
      'openai-organization': 'org-1',
      'openai-project': 'proj-1',
    });
    expect(calls[0]!.body!.metadata).toBeUndefined();
    expect(calls[0]!.body!.model).toBe('gpt-5.1');
  });

  it('has no rerank: fails fallback-eligible without calling upstream', async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    const adapter = new OpenAIAdapter('openai', cfg as never, { logger: silentLogger(), fetch });
    const err = await rejection(
      adapter.rerank({ model: 'r', query: 'q', documents: ['a'] }, target(cfg), ctx()),
    );
    expect(err.fallback).toBe(true);
    expect(err.retryable).toBe(false);
    expect(err.countsAsFailure).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
