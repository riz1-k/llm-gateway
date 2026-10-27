import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGateway, type Gateway } from '../../src/app.js';
import { MemoryCacheStore } from '../../src/cache/store.js';
import { silentLogger } from '../../src/observability/logger.js';
import { KEY, testConfig } from '../helpers.js';

/** The official `openai` SDK must work unmodified against the gateway (real HTTP, mock upstream). */
let server: ServerType;
let gateway: Gateway;
let client: OpenAI;

beforeAll(async () => {
  gateway = createGateway({
    logger: silentLogger(),
    services: { cache: new MemoryCacheStore() },
    config: testConfig({
      providers: { mock: { type: 'mock', allow_header_faults: true, embedding_dim: 32 } },
      models: {
        echo: { provider: 'mock', model: 'mock-echo' },
        down: { provider: 'mock', model: 'mock-echo', options: { fault: { status: 503 } } },
        tools: { provider: 'mock', model: 'mock-tools' },
        emb: { provider: 'mock', model: 'mock-embed', kind: 'embedding' },
        priced: {
          provider: 'mock',
          model: 'mock-echo',
          pricing: { input: 2_000_000, output: 10_000_000 }, // $2 / $10 per token: easy to assert
        },
      },
      routes: {
        chat: { targets: ['down', 'echo'] },
        agent: { targets: ['tools'] },
        embed: { targets: ['emb'] },
        cached: { targets: ['priced'], cache: { exact: { ttl_s: 60 } }, hidden: true },
      },
    }),
  });
  server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: gateway.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  client = new OpenAI({ apiKey: KEY, baseURL: `http://127.0.0.1:${port}/v1`, maxRetries: 0 });
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await gateway.close();
});

describe('openai SDK contract', () => {
  it('lists models', async () => {
    const page = await client.models.list();
    expect(page.data.map((m) => m.id).sort()).toEqual(['agent', 'chat', 'embed']);
  });

  it('chat completion (with fallback) and raw headers', async () => {
    const { data, response } = await client.chat.completions
      .create({ model: 'chat', messages: [{ role: 'user', content: 'hello sdk' }] })
      .withResponse();
    expect(data.choices[0]!.message.content).toBe('hello sdk');
    expect(data.usage?.total_tokens).toBeGreaterThan(0);
    expect(response.headers.get('x-sy-fallbacks')).toBe('1');
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('streaming with include_usage', async () => {
    const stream = await client.chat.completions.create({
      model: 'chat',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'streamed words arrive in pieces' }],
    });
    let text = '';
    let usage: OpenAI.CompletionUsage | null | undefined;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta.content ?? '';
      if (chunk.usage) usage = chunk.usage;
    }
    expect(text).toBe('streamed words arrive in pieces');
    expect(usage?.completion_tokens).toBeGreaterThan(0);
  });

  it('tool calling round trip', async () => {
    const tools: OpenAI.ChatCompletionTool[] = [
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
    ];
    const first = await client.chat.completions.create({
      model: 'agent',
      tools,
      messages: [{ role: 'user', content: 'Where is my order?' }],
    });
    const call = first.choices[0]!.message.tool_calls![0]!;
    expect(first.choices[0]!.finish_reason).toBe('tool_calls');
    expect(call.type).toBe('function');
    const second = await client.chat.completions.create({
      model: 'agent',
      tools,
      messages: [
        { role: 'user', content: 'Where is my order?' },
        first.choices[0]!.message,
        { role: 'tool', tool_call_id: call.id, content: '{"status":"shipped"}' },
      ],
    });
    expect(second.choices[0]!.finish_reason).toBe('stop');
    expect(second.choices[0]!.message.content).toContain('shipped');
  });

  it('embeddings (float and base64 decoding by the SDK)', async () => {
    const res = await client.embeddings.create({ model: 'embed', input: ['alpha', 'beta'] });
    expect(res.data).toHaveLength(2);
    expect(res.data[0]!.embedding).toHaveLength(32);
  });

  it('errors surface as typed SDK errors with the gateway code', async () => {
    const err = await client.chat.completions
      .create({ model: 'missing', messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAI.NotFoundError);
    expect((err as InstanceType<typeof OpenAI.APIError>).code).toBe('model_not_found');
    const auth = await new OpenAI({
      apiKey: 'sk-wrong',
      baseURL: client.baseURL,
      maxRetries: 0,
    }).models
      .list()
      .catch((e: unknown) => e);
    expect(auth).toBeInstanceOf(OpenAI.AuthenticationError);
  });

  /** Switchyard extension fields on `usage` (not in the SDK types, reachable as extra fields). */
  type CostUsage = OpenAI.CompletionUsage & {
    cost?: number;
    sy_cache?: string;
    sy_saved_cost?: number;
  };

  async function streamUsage(content: string): Promise<CostUsage | undefined> {
    const stream = await client.chat.completions.create({
      model: 'cached',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content }],
    });
    let usage: CostUsage | undefined;
    for await (const chunk of stream) if (chunk.usage) usage = chunk.usage;
    return usage;
  }

  it('streamed usage carries usage.cost; cache replays report cost 0 and the saving', async () => {
    const miss = await streamUsage('price this streamed answer');
    expect(miss).toBeDefined();
    const expected = miss!.prompt_tokens * 2 + miss!.completion_tokens * 10;
    expect(miss!.cost).toBeCloseTo(expected, 6);
    expect(miss!.sy_cache).toBe('miss');
    expect(miss!.sy_saved_cost).toBeUndefined();

    const hit = await streamUsage('price this streamed answer');
    expect(hit!.cost).toBe(0);
    expect(hit!.sy_cache).toBe('hit');
    expect(hit!.sy_saved_cost).toBeCloseTo(expected, 6);
  });

  it('non-streamed usage.cost equals the x-sy-cost-usd header', async () => {
    const { data, response } = await client.chat.completions
      .create({ model: 'cached', messages: [{ role: 'user', content: 'price this json answer' }] })
      .withResponse();
    const usage = data.usage as CostUsage;
    expect(usage.cost).toBe(Number(response.headers.get('x-sy-cost-usd')));
    expect(usage.cost).toBeGreaterThan(0);
    expect(usage.sy_cache).toBe('miss');

    const again = await client.chat.completions
      .create({ model: 'cached', messages: [{ role: 'user', content: 'price this json answer' }] })
      .withResponse();
    expect(again.response.headers.get('x-sy-cache')).toBe('hit');
    expect((again.data.usage as CostUsage).cost).toBe(0);
    expect((again.data.usage as CostUsage).sy_saved_cost).toBe(usage.cost);
  });

  it('streams without include_usage carry no usage at all', async () => {
    const stream = await client.chat.completions.create({
      model: 'cached',
      stream: true,
      messages: [{ role: 'user', content: 'no usage please' }],
    });
    for await (const chunk of stream) expect(chunk.usage ?? undefined).toBeUndefined();
  });
});
