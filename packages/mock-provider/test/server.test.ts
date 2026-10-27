import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockServer, type RunningMockServer } from '../src/index.js';

let server: RunningMockServer;

beforeAll(async () => {
  server = await startMockServer({ port: 0, embeddingDim: 32, fixedText: 'fixed!' });
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => server.reset());

const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

/** Reads an SSE body into [event, data] pairs. */
async function readSSE(res: Response): Promise<{ event: string | undefined; data: string }[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split('\n');
      const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
      const data = lines
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      return { event, data };
    });
}

describe('mock server: OpenAI endpoints', () => {
  it('serves health and models', async () => {
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
    const models = (await (await fetch(`${server.url}/v1/models`)).json()) as {
      data: { id: string }[];
    };
    expect(models.data.map((m) => m.id)).toContain('mock-extractive');
  });

  it('returns a non-streaming chat completion with usage', async () => {
    const res = await post('/v1/chat/completions', {
      model: 'mock-echo',
      messages: [{ role: 'user', content: 'ping pong' }],
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      object: string;
      choices: { message: { content: string }; finish_reason: string }[];
      usage: { total_tokens: number };
    };
    expect(json.object).toBe('chat.completion');
    expect(json.choices[0]!.message.content).toBe('ping pong');
    expect(json.choices[0]!.finish_reason).toBe('stop');
    expect(json.usage.total_tokens).toBeGreaterThan(0);
  });

  it('streams role, content, finish and usage chunks then [DONE]', async () => {
    const res = await post('/v1/chat/completions', {
      model: 'mock-echo',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'one two three four five six seven' }],
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = await readSSE(res);
    expect(events.at(-1)!.data).toBe('[DONE]');
    const chunks = events.slice(0, -1).map(
      (e) =>
        JSON.parse(e.data) as {
          choices: { delta: { role?: string; content?: string }; finish_reason: string | null }[];
          usage?: unknown;
        },
    );
    expect(chunks[0]!.choices[0]!.delta.role).toBe('assistant');
    const text = chunks.map((c) => c.choices[0]?.delta.content ?? '').join('');
    expect(text).toBe('one two three four five six seven');
    expect(chunks.some((c) => c.choices[0]?.finish_reason === 'stop')).toBe(true);
    expect(chunks.at(-1)!.usage).toBeDefined();
    expect(chunks.at(-1)!.choices).toEqual([]);
  });

  it('streams tool call deltas for mock-tools', async () => {
    const res = await post('/v1/chat/completions', {
      model: 'mock-tools',
      stream: true,
      messages: [{ role: 'user', content: 'order?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_order',
            parameters: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
            },
          },
        },
      ],
    });
    const chunks = (await readSSE(res))
      .filter((e) => e.data !== '[DONE]')
      .map(
        (e) =>
          JSON.parse(e.data) as {
            choices: {
              delta: { tool_calls?: { function?: { name?: string; arguments?: string } }[] };
              finish_reason: string | null;
            }[];
          },
      );
    const calls = chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []);
    expect(calls[0]!.function!.name).toBe('get_order');
    expect(calls.map((c) => c.function?.arguments ?? '').join('')).toBe('{"id":"mock"}');
    expect(chunks.some((c) => c.choices[0]?.finish_reason === 'tool_calls')).toBe(true);
    expect(chunks.every((c) => !('usage' in c))).toBe(true);
  });

  it('injects failures from headers with retry-after and the OpenAI envelope', async () => {
    const res = await post(
      '/v1/chat/completions',
      { model: 'mock-echo', messages: [{ role: 'user', content: 'x' }] },
      { 'x-mock-status': '503', 'x-mock-retry-after': '3' },
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('3');
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('503');
  });

  it('scopes header faults to the targeted model', async () => {
    const h = { 'x-mock-status': '500', 'x-mock-fault-target': 'mock-down' };
    expect(
      (
        await post(
          '/v1/chat/completions',
          { model: 'mock-down', messages: [{ role: 'user', content: 'x' }] },
          h,
        )
      ).status,
    ).toBe(500);
    expect(
      (
        await post(
          '/v1/chat/completions',
          { model: 'mock-echo', messages: [{ role: 'user', content: 'x' }] },
          h,
        )
      ).status,
    ).toBe(200);
  });

  it('aborts the stream mid-way with x-mock-stream-fail-after', async () => {
    const res = await post(
      '/v1/chat/completions',
      {
        model: 'mock-echo',
        stream: true,
        messages: [{ role: 'user', content: 'a b c d e f g h i j k l' }],
      },
      { 'x-mock-stream-fail-after': '1' },
    );
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow();
  });

  it('applies latency', async () => {
    const t0 = Date.now();
    await post(
      '/v1/chat/completions',
      { model: 'mock-echo', messages: [{ role: 'user', content: 'x' }] },
      { 'x-mock-latency-ms': '120' },
    );
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
  });

  it('returns 400 for invalid JSON and records it', async () => {
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(res.status).toBe(400);
    expect(server.stats().total).toBe(1);
  });

  it('returns deterministic embeddings (float and base64)', async () => {
    const a = (await (
      await post('/v1/embeddings', { model: 'mock-embed', input: ['hello world', 'bye'] })
    ).json()) as { data: { embedding: number[] }[]; usage: { prompt_tokens: number } };
    const b = (await (
      await post('/v1/embeddings', { model: 'mock-embed', input: 'hello world' })
    ).json()) as { data: { embedding: number[] }[] };
    expect(a.data).toHaveLength(2);
    expect(a.data[0]!.embedding).toHaveLength(32);
    expect(b.data[0]!.embedding).toEqual(a.data[0]!.embedding);
    expect(a.usage.prompt_tokens).toBeGreaterThan(0);
    const c = (await (
      await post('/v1/embeddings', {
        model: 'mock-embed',
        input: 'hello world',
        encoding_format: 'base64',
      })
    ).json()) as { data: { embedding: string }[] };
    const buf = Buffer.from(c.data[0]!.embedding, 'base64');
    expect(buf.readFloatLE(0)).toBeCloseTo(a.data[0]!.embedding[0]!, 5);
  });

  it('reranks on /v1/rerank and /rerank', async () => {
    for (const path of ['/v1/rerank', '/rerank']) {
      const res = (await (
        await post(path, {
          model: 'mock-rerank',
          query: 'cors headers',
          documents: ['bananas', 'cors adds headers'],
          top_n: 1,
          return_documents: true,
        })
      ).json()) as {
        results: { index: number; relevance_score: number; document?: { text: string } }[];
      };
      expect(res.results).toHaveLength(1);
      expect(res.results[0]).toMatchObject({ index: 1, document: { text: 'cors adds headers' } });
    }
  });

  it('tracks stats per path and resets', async () => {
    await post('/v1/embeddings', { model: 'm', input: 'x' });
    await post('/v1/embeddings', { model: 'm', input: 'y' });
    const s = server.stats();
    expect(s.requests['POST /v1/embeddings']).toBe(2);
    expect(s.recent.at(-1)!.body).toEqual({ model: 'm', input: 'y' });
    const viaHttp = (await (await fetch(`${server.url}/__mock/stats`)).json()) as { total: number };
    expect(viaHttp.total).toBe(2);
    await fetch(`${server.url}/__mock/reset`, { method: 'POST' });
    expect(server.stats().total).toBe(0);
  });

  it('records trace-context headers, and only those', async () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    await post(
      '/v1/chat/completions',
      { model: 'mock-echo', messages: [{ role: 'user', content: 'hi' }] },
      { traceparent, baggage: 'k=v', authorization: 'Bearer secret' },
    );
    await post('/v1/embeddings', { model: 'm', input: 'x' });
    const [traced, plain] = server.stats().recent;
    expect(traced!.trace).toEqual({ traceparent, baggage: 'k=v' });
    expect(plain!.trace).toBeUndefined();
  });
});

describe('mock server: Anthropic endpoint', () => {
  const tools = [
    {
      name: 'get_order',
      description: 'Find an order',
      input_schema: {
        type: 'object',
        properties: { order_id: { type: 'string' } },
        required: ['order_id'],
      },
    },
  ];

  it('returns a Messages API response', async () => {
    const res = await post('/v1/messages', {
      model: 'mock-echo',
      max_tokens: 100,
      system: 'be nice',
      messages: [{ role: 'user', content: 'hi there' }],
    });
    const json = (await res.json()) as {
      type: string;
      content: { type: string; text: string }[];
      stop_reason: string;
      usage: { input_tokens: number };
    };
    expect(json.type).toBe('message');
    expect(json.content).toEqual([{ type: 'text', text: 'hi there' }]);
    expect(json.stop_reason).toBe('end_turn');
    expect(json.usage.input_tokens).toBeGreaterThan(0);
  });

  it('returns tool_use blocks and consumes tool_result turns', async () => {
    const first = (await (
      await post('/v1/messages', {
        model: 'mock-tools',
        max_tokens: 100,
        tools,
        messages: [{ role: 'user', content: 'where is my order' }],
      })
    ).json()) as {
      content: { type: string; id: string; name: string; input: unknown }[];
      stop_reason: string;
    };
    expect(first.stop_reason).toBe('tool_use');
    const toolUse = first.content.find((b) => b.type === 'tool_use')!;
    expect(toolUse).toMatchObject({ name: 'get_order', input: { order_id: 'mock' } });
    const second = (await (
      await post('/v1/messages', {
        model: 'mock-tools',
        max_tokens: 100,
        tools,
        messages: [
          { role: 'user', content: 'where is my order' },
          { role: 'assistant', content: first.content },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: [{ type: 'text', text: 'shipped' }],
              },
            ],
          },
        ],
      })
    ).json()) as { content: { text: string }[]; stop_reason: string };
    expect(second.stop_reason).toBe('end_turn');
    expect(second.content[0]!.text).toBe('Done. Tool results: get_order: shipped');
  });

  it('streams the full Anthropic event sequence', async () => {
    const res = await post('/v1/messages', {
      model: 'mock-tools',
      max_tokens: 100,
      stream: true,
      tools,
      messages: [{ role: 'user', content: 'order' }],
    });
    const events = await readSSE(res);
    const types = events.map((e) => e.event);
    expect(types).toEqual([
      'message_start',
      'ping',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    const json = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => (JSON.parse(e.data) as { delta: { partial_json: string } }).delta.partial_json)
      .join('');
    expect(JSON.parse(json)).toEqual({ order_id: 'mock' });
    expect(
      (JSON.parse(events[6]!.data) as { delta: { stop_reason: string } }).delta.stop_reason,
    ).toBe('tool_use');
  });

  it('streams text deltas and emits an error event on mid-stream faults', async () => {
    const ok = await readSSE(
      await post('/v1/messages', {
        model: 'mock-echo',
        max_tokens: 50,
        stream: true,
        messages: [{ role: 'user', content: 'a b c d e f g' }],
      }),
    );
    const text = ok
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => (JSON.parse(e.data) as { delta: { text: string } }).delta.text)
      .join('');
    expect(text).toBe('a b c d e f g');
    const failing = await readSSE(
      await post(
        '/v1/messages',
        {
          model: 'mock-echo',
          max_tokens: 50,
          stream: true,
          messages: [{ role: 'user', content: 'a b c d e f g' }],
        },
        { 'x-mock-stream-fail-after': '1' },
      ),
    );
    expect(failing.at(-1)!.event).toBe('error');
    expect(failing.map((e) => e.event)).not.toContain('message_stop');
  });

  it('uses the Anthropic error envelope for injected failures', async () => {
    const res = await post(
      '/v1/messages',
      { model: 'mock-echo', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] },
      { 'x-mock-status': '529' },
    );
    expect(res.status).toBe(529);
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'overloaded_error' } });
  });
});

describe('mock server: global options', () => {
  it('fails every request when failStatus is configured', async () => {
    const flaky = await startMockServer({ failStatus: 500, retryAfterS: 1 });
    try {
      const res = await fetch(`${flaky.url}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', input: 'x' }),
      });
      expect(res.status).toBe(500);
      expect(res.headers.get('retry-after')).toBe('1');
    } finally {
      await flaky.close();
    }
  });
});
