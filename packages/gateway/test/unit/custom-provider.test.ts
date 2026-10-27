import { describe, expect, it } from 'vitest';
import {
  makeChunk,
  usageChunk,
  type AdapterFactory,
  type ChatResponse,
  type ProviderAdapter,
} from '../../src/index.js';
import { readSSE, testConfig, testGateway } from '../helpers.js';

/** A `type: custom` provider backed by a user-supplied adapter factory (library extension point). */
const shout: AdapterFactory = (name, config) => {
  const raw = config.type === 'custom' ? config.options.suffix : undefined;
  const suffix = typeof raw === 'string' ? raw : '';
  const reply = (text: string): ChatResponse => ({
    id: 'chatcmpl-custom',
    object: 'chat.completion',
    created: 0,
    model: 'shout-1',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: `${text.toUpperCase()}${suffix}` },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });
  const lastText = (messages: { content?: unknown }[]): string => {
    const c = messages.at(-1)?.content;
    return typeof c === 'string' ? c : '';
  };
  const adapter: ProviderAdapter = {
    type: 'custom',
    name,
    chat: async (req) => reply(lastText(req.messages)),
    async *chatStream(req) {
      const meta = { id: 'chatcmpl-custom', created: 0, model: 'shout-1' };
      yield makeChunk(meta, { role: 'assistant', content: lastText(req.messages).toUpperCase() });
      yield makeChunk(meta, {}, 'stop');
      yield usageChunk(meta, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    },
  };
  return adapter;
};

const config = testConfig({
  providers: { loud: { type: 'custom', factory: 'shout', options: { suffix: '!' } } },
  models: { 'shout-1': { provider: 'loud', model: 'shout-1', pricing: { input: 1, output: 1 } } },
  routes: { shout: { targets: ['shout-1'] } },
});

describe('custom providers', () => {
  it('routes requests to the registered factory, with options', async () => {
    const t = testGateway(config, { adapterFactories: { shout } });
    const res = await t.chat({ model: 'shout', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-sy-provider')).toBe('loud');
    const body = (await res.json()) as ChatResponse;
    expect(body.choices[0]!.message.content).toBe('HI!');
    expect(body.usage?.cost).toBeCloseTo(5 / 1_000_000, 12);
    await t.gateway.close();
  });

  it('streams through the pipeline (usage chunk gets the cost)', async () => {
    const t = testGateway(config, { adapterFactories: { shout } });
    const res = await t.chat({
      model: 'shout',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'quiet' }],
    });
    const events = await readSSE(res);
    expect(events.at(-1)).toBe('[DONE]');
    const usage = (events.at(-2) as { usage: { cost: number; sy_cache: string } }).usage;
    expect(usage.cost).toBeCloseTo(5 / 1_000_000, 12);
    expect(usage.sy_cache).toBe('bypass');
    await t.gateway.close();
  });

  it('fails fast with a clear message when the factory is missing', () => {
    expect(() => testGateway(config)).toThrow(/no adapter factory registered for "shout"/);
  });

  it('defaults the factory key to the provider name', async () => {
    const byName = testConfig({
      providers: { shout: { type: 'custom' } },
      models: { m: { provider: 'shout', model: 'x' } },
      routes: { r: { targets: ['m'] } },
    });
    const t = testGateway(byName, { adapterFactories: { shout } });
    const res = await t.chat({ model: 'r', messages: [{ role: 'user', content: 'a' }] });
    expect(((await res.json()) as ChatResponse).choices[0]!.message.content).toBe('A');
    await t.gateway.close();
  });
});
