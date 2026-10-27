import { startMockServer, type RunningMockServer } from '@switchyard/mock-provider';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readSSE, testConfig, testGateway, type TestGateway } from '../helpers.js';

/**
 * Gateway in-process → real HTTP → standalone mock provider (OpenAI-, Anthropic- and rerank-style
 * endpoints). Exercises the openai-compatible and anthropic adapters end to end.
 */
let mock: RunningMockServer;
let gw: TestGateway;

beforeAll(async () => {
  mock = await startMockServer({ port: 0, host: '127.0.0.1', embeddingDim: 64 });
  const v1 = `${mock.url}/v1`;
  gw = testGateway(
    testConfig({
      retry: { attempts: 2, backoff_ms: 1, max_backoff_ms: 2 },
      providers: {
        compat: { type: 'openai-compatible', base_url: v1 },
        // Faults are injected through static upstream headers (client headers are never forwarded).
        compat400: { type: 'openai-compatible', base_url: v1, headers: { 'x-mock-status': '400' } },
        compat503: {
          type: 'openai-compatible',
          base_url: v1,
          headers: { 'x-mock-status': '503', 'x-mock-retry-after': '1' },
        },
        claude: { type: 'anthropic', base_url: mock.url, api_key: 'test-anthropic-key' },
        claude529: {
          type: 'anthropic',
          base_url: mock.url,
          api_key: 'test-anthropic-key',
          headers: { 'x-mock-status': '529' },
        },
      },
      models: {
        echo: { provider: 'compat', model: 'mock-echo' },
        bad: { provider: 'compat400', model: 'mock-echo' },
        flaky: { provider: 'compat503', model: 'mock-echo' },
        overloaded: { provider: 'claude529', model: 'mock-echo' },
        tools: { provider: 'compat', model: 'mock-tools' },
        emb: {
          provider: 'compat',
          model: 'mock-embed',
          kind: 'embedding',
          base_url: v1,
          input_templates: {
            query: 'task: search result | query: {text}',
            document: 'title: {title} | text: {text}',
          },
        },
        rr: { provider: 'compat', model: 'mock-rerank', kind: 'rerank', base_url: v1 },
        sonnet: { provider: 'claude', model: 'mock-echo' },
        sonnet_tools: { provider: 'claude', model: 'mock-tools' },
      },
      routes: {
        chat: { targets: ['echo'] },
        'bad-then-echo': { targets: ['bad', 'echo'] },
        'flaky-only': { targets: ['flaky'] },
        'chat-tools': { targets: ['tools'] },
        embed: { targets: ['emb'] },
        rerank: { targets: ['rr'] },
        anthropic: { targets: ['sonnet'] },
        'anthropic-tools': { targets: ['sonnet_tools'] },
        'anthropic-then-compat': { targets: ['overloaded', 'echo'] },
      },
    }),
  );
});

afterAll(async () => {
  await gw.gateway.close();
  await mock.close();
});

beforeEach(() => mock.reset());

const hits = (path: string): number => mock.stats().requests[`POST ${path}`] ?? 0;
const lastBody = (path: string): Record<string, unknown> =>
  (mock
    .stats()
    .recent.filter((r) => r.path === path)
    .at(-1)?.body ?? {}) as Record<string, unknown>;

describe('openai-compatible upstream', () => {
  it('proxies chat and maps usage', async () => {
    const res = await gw.chat({ model: 'chat', messages: [{ role: 'user', content: 'ping' }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      model: 'chat',
      choices: [{ message: { content: 'ping' } }],
      usage: { prompt_tokens: expect.any(Number) },
    });
    expect(hits('/v1/chat/completions')).toBe(1);
  });

  it('does not retry or fall back on upstream 400', async () => {
    const res = await gw.chat({
      model: 'bad-then-echo',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(hits('/v1/chat/completions')).toBe(1);
    expect(res.headers.get('x-sy-fallbacks')).toBe('0');
  });

  it('retries upstream 503 (attempts = 2) and honors retry-after', async () => {
    const started = Date.now();
    const res = await gw.chat({ model: 'flaky-only', messages: [{ role: 'user', content: 'x' }] });
    expect(res.status).toBe(503);
    expect(hits('/v1/chat/completions')).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(res.headers.get('retry-after')).toBe('1');
  });

  it('streams through with include_usage forced upstream', async () => {
    const res = await gw.chat({
      model: 'chat',
      stream: true,
      messages: [{ role: 'user', content: 'a b c d' }],
    });
    const events = await readSSE(res);
    expect(events.at(-1)).toBe('[DONE]');
    const body = lastBody('/v1/chat/completions') as {
      stream_options?: { include_usage?: boolean };
    };
    expect(body.stream_options?.include_usage).toBe(true);
    expect((events.slice(0, -1) as { usage?: unknown }[]).every((e) => e.usage === undefined)).toBe(
      true,
    );
  });

  it('passes native tools through', async () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'lookup',
          parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        },
      },
    ];
    const res = (await (
      await gw.chat({ model: 'chat-tools', tools, messages: [{ role: 'user', content: 'find x' }] })
    ).json()) as {
      choices: {
        finish_reason: string;
        message: { tool_calls: { function: { name: string } }[] };
      }[];
    };
    expect(res.choices[0]!.finish_reason).toBe('tool_calls');
    expect(res.choices[0]!.message.tool_calls[0]!.function.name).toBe('lookup');
    expect((lastBody('/v1/chat/completions') as { tools: unknown[] }).tools).toHaveLength(1);
  });
});

describe('embeddings & rerank', () => {
  it('applies per-model input templates by input_type and strips extension fields', async () => {
    const res = await gw.request('/v1/embeddings', {
      model: 'embed',
      input: ['what is hono?'],
      input_type: 'query',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string; data: { embedding: number[] }[] };
    expect(body.model).toBe('embed');
    expect(body.data[0]!.embedding).toHaveLength(64);
    const upstream = lastBody('/v1/embeddings');
    expect(upstream.input).toEqual(['task: search result | query: what is hono?']);
    expect(upstream).not.toHaveProperty('input_type');

    await gw.request('/v1/embeddings', {
      model: 'embed',
      input: ['chunk text'],
      input_type: 'document',
      input_titles: ['Routing'],
    });
    expect((lastBody('/v1/embeddings') as { input: string[] }).input).toEqual([
      'title: Routing | text: chunk text',
    ]);
  });

  it('embeddings without input_type are passed through unchanged', async () => {
    await gw.request('/v1/embeddings', { model: 'embed', input: 'raw' });
    expect((lastBody('/v1/embeddings') as { input: unknown }).input).toBe('raw');
  });

  it('rerank passes through and normalizes order, top_n and documents', async () => {
    const res = await gw.request('/v1/rerank', {
      model: 'rerank',
      query: 'hono middleware',
      documents: [
        'bananas are yellow',
        'hono middleware runs before handlers',
        { text: 'middleware in express' },
      ],
      top_n: 2,
      return_documents: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      model: string;
      results: { index: number; relevance_score: number; document?: { text: string } }[];
    };
    expect(body.model).toBe('rerank');
    expect(body.results).toHaveLength(2);
    expect(body.results[0]!.index).toBe(1);
    expect(body.results[0]!.relevance_score).toBeGreaterThanOrEqual(
      body.results[1]!.relevance_score,
    );
    expect(body.results[0]!.document?.text).toBe('hono middleware runs before handlers');
    expect(hits('/v1/rerank')).toBe(1);
  });
});

describe('anthropic upstream (Messages API translation)', () => {
  it('translates chat requests and responses', async () => {
    const res = await gw.chat({
      model: 'anthropic',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hola' },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      choices: [{ message: { content: 'hola' }, finish_reason: 'stop' }],
    });
    const upstream = lastBody('/v1/messages') as { system?: unknown; max_tokens?: number };
    expect(upstream.system).toBeDefined();
    expect(upstream.max_tokens).toBe(4096);
  });

  it('translates streaming events into OpenAI chunks', async () => {
    const res = await gw.chat({
      model: 'anthropic',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'stream this text' }],
    });
    const events = (await readSSE(res)).slice(0, -1) as {
      choices: { delta: { content?: string }; finish_reason: string | null }[];
      usage?: unknown;
    }[];
    expect(events.map((e) => e.choices[0]?.delta.content ?? '').join('')).toBe('stream this text');
    expect(events.some((e) => e.choices[0]?.finish_reason === 'stop')).toBe(true);
    expect(events.at(-1)!.usage).toBeTruthy();
  });

  it('translates tool_use blocks into tool_calls (stream and non-stream)', async () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ];
    const res = (await (
      await gw.chat({
        model: 'anthropic-tools',
        tools,
        messages: [{ role: 'user', content: 'weather?' }],
      })
    ).json()) as {
      choices: {
        finish_reason: string;
        message: { tool_calls: { function: { name: string; arguments: string } }[] };
      }[];
    };
    expect(res.choices[0]!.finish_reason).toBe('tool_calls');
    expect(JSON.parse(res.choices[0]!.message.tool_calls[0]!.function.arguments)).toEqual({
      city: 'mock',
    });
    const streamed = (
      await readSSE(
        await gw.chat({
          model: 'anthropic-tools',
          stream: true,
          tools,
          messages: [{ role: 'user', content: 'weather?' }],
        }),
      )
    ).slice(0, -1) as {
      choices: { delta: { tool_calls?: { function?: { arguments?: string } }[] } }[];
    }[];
    const args = streamed
      .flatMap((e) => e.choices[0]?.delta.tool_calls ?? [])
      .map((t) => t.function?.arguments ?? '')
      .join('');
    expect(JSON.parse(args)).toEqual({ city: 'mock' });
  });

  it('falls back from a failing Anthropic upstream to the next provider', async () => {
    const res = await gw.chat({
      model: 'anthropic-then-compat',
      messages: [{ role: 'user', content: 'fallback ok' }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-sy-fallbacks')).toBe('1');
    expect(res.headers.get('x-sy-provider')).toBe('compat');
    expect(hits('/v1/messages')).toBe(2); // 529 overloaded is retryable: 2 attempts
    expect(hits('/v1/chat/completions')).toBe(1);
  });
});
