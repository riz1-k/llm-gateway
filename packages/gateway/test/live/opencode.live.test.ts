import { describe, expect, it } from 'vitest';
import { readSSE, testConfig, testGateway } from '../helpers.js';

/**
 * Live smoke tests against the real opencode bridge (GitHub Copilot). Opt-in:
 *   SWITCHYARD_LIVE=1 OPENCODE_SERVER_PASSWORD=… pnpm test:live
 * Exactly 5 real model calls: plain, stream, json_schema, tool call + tool-result follow-up.
 */
const enabled =
  process.env.SWITCHYARD_LIVE === '1' && Boolean(process.env.OPENCODE_SERVER_PASSWORD);
const model = process.env.SWITCHYARD_LIVE_MODEL ?? 'claude-sonnet-5.5';

const gw = enabled
  ? testGateway(
      testConfig(
        {
          server: { request_timeout_ms: 200_000 },
          retry: { attempts: 1 },
          providers: {
            copilot: {
              type: 'opencode',
              base_url: process.env.OPENCODE_BASE_URL ?? 'http://127.0.0.1:4096',
              username: process.env.OPENCODE_SERVER_USERNAME ?? 'opencode',
              password: process.env.OPENCODE_SERVER_PASSWORD,
              timeout_ms: 180_000,
            },
          },
          models: { sonnet: { provider: 'copilot', model, pricing: { input: 2, output: 10 } } },
          routes: { live: { targets: ['sonnet'], timeout_ms: 200_000 } },
        },
        process.env as Record<string, string>,
      ),
    )
  : undefined;

interface ChatJson {
  choices: {
    finish_reason: string;
    message: {
      content: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    };
  }[];
  usage: { prompt_tokens: number; completion_tokens: number };
}

describe.skipIf(!enabled)('live: opencode bridge', () => {
  it('plain chat', async () => {
    const res = await gw!.chat({
      model: 'live',
      messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatJson;
    console.log(
      '[live] plain:',
      JSON.stringify(body.choices[0]!.message.content),
      body.usage,
      'cost',
      res.headers.get('x-sy-cost-usd'),
    );
    expect(body.choices[0]!.message.content?.toLowerCase()).toContain('pong');
    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
  });

  it('streaming delivers several chunks before completion', async () => {
    const started = Date.now();
    const res = await gw!.chat({
      model: 'live',
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'user', content: 'Count from 1 to 30 in words, comma separated, nothing else.' },
      ],
    });
    expect(res.status).toBe(200);
    const events = await readSSE(res);
    const chunks = events.slice(0, -1) as {
      choices: { delta: { content?: string } }[];
      usage?: unknown;
    }[];
    const contentChunks = chunks.filter((c) => c.choices[0]?.delta.content);
    const text = contentChunks.map((c) => c.choices[0]!.delta.content).join('');
    console.log(
      `[live] stream: ${contentChunks.length} content chunks in ${Date.now() - started} ms:`,
      JSON.stringify(text.slice(0, 80)),
    );
    expect(events.at(-1)).toBe('[DONE]');
    expect(contentChunks.length).toBeGreaterThan(1);
    expect(text.toLowerCase()).toContain('thirty');
    expect(chunks.at(-1)!.usage).toBeTruthy();
  });

  it('json_schema structured output (emulated)', async () => {
    const res = await gw!.chat({
      model: 'live',
      messages: [
        {
          role: 'user',
          content: 'Classify the sentiment of: "The refund arrived quickly, great service!"',
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'sentiment',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              label: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
            },
            required: ['label', 'confidence'],
          },
        },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatJson;
    console.log('[live] json_schema:', body.choices[0]!.message.content);
    const parsed = JSON.parse(body.choices[0]!.message.content!) as {
      label: string;
      confidence: number;
    };
    expect(parsed.label).toBe('positive');
  });

  it('tool call round trip (emulated tool calling)', async () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_order_status',
          description: 'Get the shipping status of an order',
          parameters: {
            type: 'object',
            properties: { order_id: { type: 'string' } },
            required: ['order_id'],
            additionalProperties: false,
          },
        },
      },
    ];
    const messages: Record<string, unknown>[] = [
      { role: 'system', content: 'You are a support agent. Use tools to look up facts.' },
      { role: 'user', content: 'What is the status of order ORD-1042?' },
    ];
    const first = (await (await gw!.chat({ model: 'live', tools, messages })).json()) as ChatJson;
    console.log('[live] tool call:', JSON.stringify(first.choices[0]!.message));
    expect(first.choices[0]!.finish_reason).toBe('tool_calls');
    const call = first.choices[0]!.message.tool_calls![0]!;
    expect(call.function.name).toBe('get_order_status');
    expect(JSON.parse(call.function.arguments)).toEqual({ order_id: 'ORD-1042' });

    messages.push(first.choices[0]!.message, {
      role: 'tool',
      tool_call_id: call.id,
      content: '{"status":"shipped","carrier":"DHL","eta":"2026-10-30"}',
    });
    const second = (await (await gw!.chat({ model: 'live', tools, messages })).json()) as ChatJson;
    console.log('[live] final answer:', JSON.stringify(second.choices[0]!.message.content));
    expect(second.choices[0]!.finish_reason).toBe('stop');
    expect(second.choices[0]!.message.content).toMatch(/shipped/i);
  });
});
