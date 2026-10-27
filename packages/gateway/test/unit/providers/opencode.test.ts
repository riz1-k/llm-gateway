import { afterEach, describe, expect, it } from 'vitest';
import { ChunkAccumulator } from '../../../src/core/chunks.js';
import { ProviderError } from '../../../src/core/errors.js';
import type { ChatChunk, ChatRequest, ToolDefinition } from '../../../src/core/types.js';
import { opencodeProviderSchema } from '../../../src/config/schema.js';
import { silentLogger } from '../../../src/observability/logger.js';
import {
  applyStop,
  mapUsage,
  OpencodeAdapter,
  reasoningToVariant,
} from '../../../src/providers/opencode/index.js';
import { DeadlineExceededError } from '../../../src/util/abort.js';
import { FakeOpencode } from '../../fixtures/fake-opencode.js';
import { attemptContext, testConfig } from '../../helpers.js';

const tools: ToolDefinition[] = [
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

let adapters: OpencodeAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.map((a) => a.close()));
  adapters = [];
});

function setup(overrides: Record<string, unknown> = {}) {
  const fake = new FakeOpencode();
  const config = opencodeProviderSchema.parse({
    type: 'opencode',
    base_url: fake.base,
    password: 'secret',
    ...overrides,
  });
  const adapter = new OpencodeAdapter('copilot', config, {
    logger: silentLogger(),
    fetch: fake.fetch,
  });
  adapters.push(adapter);
  const cfg = testConfig({
    providers: { copilot: { type: 'opencode', base_url: fake.base, password: 'secret' } },
    models: { sonnet: { provider: 'copilot', model: 'claude-sonnet-5.5' } },
    routes: { r: { targets: ['sonnet'] } },
  });
  return { fake, adapter, target: cfg.models.sonnet! };
}

const req = (extra: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'r',
  messages: [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Hi' },
  ],
  ...extra,
});

async function collect(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe('opencode helpers', () => {
  it('maps reasoning_effort to variants', () => {
    expect(reasoningToVariant('medium')).toBe('medium');
    expect(reasoningToVariant('xhigh')).toBe('xhigh');
    expect(reasoningToVariant('minimal')).toBeUndefined();
    expect(reasoningToVariant(null)).toBeUndefined();
  });

  it('maps opencode tokens to OpenAI usage', () => {
    expect(
      mapUsage({ input: 100, output: 20, reasoning: 30, cacheRead: 400, cacheWrite: 50 }),
    ).toEqual({
      prompt_tokens: 550,
      completion_tokens: 50,
      total_tokens: 600,
      prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 50 },
      completion_tokens_details: { reasoning_tokens: 30 },
    });
  });

  it('emulates stop sequences', () => {
    expect(applyStop('one two STOP three', ['STOP', 'two'])).toEqual({
      text: 'one ',
      stopped: true,
    });
    expect(applyStop('abc', [])).toEqual({ text: 'abc', stopped: false });
  });
});

describe('OpencodeAdapter.chat', () => {
  it('creates a session, sends system/model/variant, maps usage, deletes the session', async () => {
    const { fake, adapter, target } = setup();
    fake.replies.push({
      text: 'Hello!',
      tokens: { input: 12, output: 3, reasoning: 2, cache: { read: 4, write: 0 } },
    });
    const res = await adapter.chat(
      req({ reasoning_effort: 'medium', temperature: 0.2 }),
      target,
      attemptContext(),
    );
    expect(res.choices[0]!.message.content).toBe('Hello!');
    expect(res.choices[0]!.finish_reason).toBe('stop');
    expect(res.usage).toMatchObject({
      prompt_tokens: 16,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 4 },
    });
    expect(fake.prompts[0]!.body).toMatchObject({
      agent: 'gateway',
      model: { providerID: 'github-copilot', modelID: 'claude-sonnet-5.5' },
      system: 'Be brief.',
      variant: 'medium',
      parts: [{ type: 'text', text: 'Hi' }],
    });
    expect(fake.prompts[0]!.body).not.toHaveProperty('temperature');
    expect(fake.authHeaders[0]).toBe(`Basic ${Buffer.from('opencode:secret').toString('base64')}`);
    expect(fake.created).toHaveLength(1);
    expect(fake.openSessions).toEqual([]);
  });

  it('disables every opencode tool on each prompt (defense in depth, SR-06)', async () => {
    const { fake, adapter, target } = setup();
    fake.replies.push({ text: 'ok' });
    await adapter.chat(req(), target, attemptContext());
    expect(fake.prompts[0]!.body.tools).toMatchObject({
      '*': false,
      bash: false,
      edit: false,
      write: false,
      webfetch: false,
      task: false,
    });
    const tools = fake.prompts[0]!.body.tools as Record<string, boolean>;
    expect(Object.values(tools).every((v) => v === false)).toBe(true);
  });

  it('returns reasoning only when metadata.include_reasoning is set', async () => {
    const { fake, adapter, target } = setup();
    fake.replies.push({ text: 'A', reasoning: 'thinking…' }, { text: 'B', reasoning: 'thinking…' });
    const plain = await adapter.chat(req(), target, attemptContext());
    expect(plain.choices[0]!.message).not.toHaveProperty('reasoning_content');
    const withReasoning = await adapter.chat(
      req({ metadata: { include_reasoning: true } }),
      target,
      attemptContext(),
    );
    expect(withReasoning.choices[0]!.message.reasoning_content).toBe('thinking…');
  });

  it('emulates tool calls (instructions in system, parsed tool_calls)', async () => {
    const { fake, adapter, target } = setup();
    fake.replies.push({
      text: 'Checking.\n<tool_call>{"name":"get_order","arguments":{"order_id":"ORD-1"}}</tool_call>',
    });
    const res = await adapter.chat(req({ tools }), target, attemptContext());
    expect(String(fake.prompts[0]!.body.system)).toContain('<tools>');
    expect(res.choices[0]!.finish_reason).toBe('tool_calls');
    expect(res.choices[0]!.message.content).toBe('Checking.');
    expect(res.choices[0]!.message.tool_calls![0]!.function).toEqual({
      name: 'get_order',
      arguments: '{"order_id":"ORD-1"}',
    });
  });

  it('repairs malformed tool calls with one round-trip in the same session', async () => {
    const { fake, adapter, target } = setup();
    fake.replies.push(
      {
        text: '<tool_call>{"name":"get_order","arguments":{}}</tool_call>',
        tokens: { input: 10, output: 5 },
      },
      {
        text: '<tool_call>{"name":"get_order","arguments":{"order_id":"ORD-9"}}</tool_call>',
        tokens: { input: 20, output: 6 },
      },
    );
    const res = await adapter.chat(req({ tools }), target, attemptContext());
    expect(fake.prompts).toHaveLength(2);
    expect(fake.prompts[1]!.sessionId).toBe(fake.prompts[0]!.sessionId);
    expect(JSON.stringify(fake.prompts[1]!.body.parts)).toContain('order_id');
    expect(res.choices[0]!.message.tool_calls![0]!.function.arguments).toBe('{"order_id":"ORD-9"}');
    expect(res.usage).toMatchObject({ prompt_tokens: 30, completion_tokens: 11 });
    expect(fake.openSessions).toEqual([]);
  });

  it('falls back to plain content when the repair also fails', async () => {
    const { fake, adapter, target } = setup();
    fake.replies.push(
      { text: '<tool_call>{bad json}</tool_call>' },
      { text: '<tool_call>still {bad</tool_call>' },
    );
    const res = await adapter.chat(req({ tools }), target, attemptContext());
    expect(res.choices[0]!.finish_reason).toBe('stop');
    expect(res.choices[0]!.message.content).toContain('<tool_call>{bad json}');
    expect(res.choices[0]!.message.tool_calls).toBeUndefined();
  });

  it('does not repair plain answers when tools are optional', async () => {
    const { fake, adapter, target } = setup();
    fake.replies.push({ text: 'No tool needed: 42.' });
    const res = await adapter.chat(req({ tools }), target, attemptContext());
    expect(fake.prompts).toHaveLength(1);
    expect(res.choices[0]!.message.content).toBe('No tool needed: 42.');
  });

  it('emulates JSON schema mode with validation and repair', async () => {
    const { fake, adapter, target } = setup();
    const response_format = {
      type: 'json_schema' as const,
      json_schema: {
        name: 'v',
        schema: { type: 'object', properties: { score: { type: 'integer' } }, required: ['score'] },
      },
    };
    fake.replies.push({ text: '```json\n{"score": "high"}\n```' }, { text: '{"score": 4}' });
    const res = await adapter.chat(req({ response_format }), target, attemptContext());
    expect(String(fake.prompts[0]!.body.system)).toContain('"score"');
    expect(res.choices[0]!.message.content).toBe('{"score":4}');
  });

  it('fails with upstream_invalid_output when JSON stays invalid', async () => {
    const { fake, adapter, target } = setup();
    fake.replies.push({ text: 'nope' }, { text: 'still nope' });
    const err = await adapter
      .chat(req({ response_format: { type: 'json_object' } }), target, attemptContext())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({
      code: 'upstream_invalid_output',
      status: 502,
      fallback: true,
      retryable: false,
    });
    expect(fake.openSessions).toEqual([]);
  });

  it('maps opencode API errors (429 with retry-after) and still deletes the session', async () => {
    const { fake, adapter, target } = setup();
    fake.replies.push({
      error: {
        name: 'APIError',
        data: {
          message: 'slow down',
          statusCode: 429,
          isRetryable: true,
          responseHeaders: { 'retry-after': '7' },
        },
      },
    });
    const err = await adapter.chat(req(), target, attemptContext()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'rate_limited', retryable: true, retryAfterMs: 7000 });
    expect(fake.deleted).toEqual(fake.created);
  });

  it('maps auth failures to upstream_auth (fallback, counts for the breaker)', async () => {
    const { fake, adapter, target } = setup();
    fake.replies.push({
      error: {
        name: 'ProviderAuthError',
        data: { providerID: 'github-copilot', message: 'expired' },
      },
    });
    expect(
      await adapter.chat(req(), target, attemptContext()).catch((e: unknown) => e),
    ).toMatchObject({ code: 'upstream_auth', fallback: true, countsAsFailure: true });
    fake.replies.push({ httpStatus: 401 });
    expect(
      await adapter.chat(req(), target, attemptContext()).catch((e: unknown) => e),
    ).toMatchObject({ code: 'upstream_auth' });
  });

  it('treats output-length errors as finish_reason length', async () => {
    const { fake, adapter, target } = setup();
    fake.replies.push({ text: 'partial', error: { name: 'MessageOutputLengthError', data: {} } });
    const res = await adapter.chat(req(), target, attemptContext());
    expect(res.choices[0]!.finish_reason).toBe('length');
    expect(res.choices[0]!.message.content).toBe('partial');
  });

  it('aborts and deletes the session when the attempt times out', async () => {
    const { fake, adapter, target } = setup();
    fake.replies.push({ text: 'slow', delayMs: 5000 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(new DeadlineExceededError(30)), 30);
    const err = await adapter
      .chat(req(), target, attemptContext({ signal: ac.signal }))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'upstream_timeout', retryable: true });
    expect(fake.aborted).toEqual(fake.created);
    expect(fake.deleted).toEqual(fake.created);
  });

  it('rejects n > 1 and remote images', async () => {
    const { adapter, target } = setup();
    await expect(adapter.chat(req({ n: 2 }), target, attemptContext())).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(
      adapter.chat(
        {
          model: 'r',
          messages: [
            {
              role: 'user',
              content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }],
            },
          ],
        },
        target,
        attemptContext(),
      ),
    ).rejects.toMatchObject({ code: 'unsupported_content', fallback: true });
  });
});

describe('OpencodeAdapter.chatStream', () => {
  it('streams real text deltas from /event, then finish + usage chunks', async () => {
    const { fake, adapter, target } = setup();
    fake.replies.push({
      text: 'one, two, three, four',
      deltas: ['one, ', 'two, ', 'three, four'],
      tokens: { input: 9, output: 4 },
    });
    const chunks = await collect(adapter.chatStream(req(), target, attemptContext()));
    const contents = chunks.map((c) => c.choices[0]?.delta.content).filter((c) => c);
    expect(contents).toEqual(['one, ', 'two, ', 'three, four']);
    expect(chunks[0]!.choices[0]!.delta.role).toBe('assistant');
    const finish = chunks.find((c) => c.choices[0]?.finish_reason);
    expect(finish?.choices[0]?.finish_reason).toBe('stop');
    expect(chunks.at(-1)!.usage).toMatchObject({ prompt_tokens: 9, completion_tokens: 4 });
    expect(fake.openSessions).toEqual([]);
  });

  it('ignores the echoed user part and reasoning (unless requested)', async () => {
    const { fake, adapter, target } = setup();
    fake.replies.push({ text: 'answer', reasoning: 'hmm' });
    const acc = new ChunkAccumulator();
    for await (const c of adapter.chatStream(req(), target, attemptContext())) acc.push(c);
    expect(acc.toResponse().choices[0]!.message).toEqual({ role: 'assistant', content: 'answer' });
  });

  it('streams the preamble, then emits emulated tool_calls deltas', async () => {
    const { fake, adapter, target } = setup();
    fake.replies.push({
      text: 'Let me check. <tool_call>{"name":"get_order","arguments":{"order_id":"ORD-5"}}</tool_call>',
      deltas: [
        'Let me check. <tool',
        '_call>{"name":"get_order",',
        '"arguments":{"order_id":"ORD-5"}}</tool_call>',
      ],
    });
    const chunks = await collect(adapter.chatStream(req({ tools }), target, attemptContext()));
    const acc = new ChunkAccumulator();
    chunks.forEach((c) => acc.push(c));
    const res = acc.toResponse();
    expect(chunks.some((c) => (c.choices[0]?.delta.content ?? '').includes('<tool'))).toBe(false);
    expect(res.choices[0]!.message.content).toBe('Let me check. ');
    expect(res.choices[0]!.message.tool_calls![0]!.function).toEqual({
      name: 'get_order',
      arguments: '{"order_id":"ORD-5"}',
    });
    expect(res.choices[0]!.finish_reason).toBe('tool_calls');
  });

  it('still delivers the full reply when the event stream is unavailable', async () => {
    const { fake, adapter, target } = setup();
    fake.eventsEnabled = false;
    fake.replies.push({ text: 'fallback text that arrives at the end' });
    const acc = new ChunkAccumulator();
    for await (const c of adapter.chatStream(req(), target, attemptContext())) acc.push(c);
    expect(acc.toResponse().choices[0]!.message.content).toBe(
      'fallback text that arrives at the end',
    );
    expect(fake.openSessions).toEqual([]);
  });

  it('uses synthetic streaming for JSON mode (validated before sending)', async () => {
    const { fake, adapter, target } = setup();
    fake.replies.push({ text: '{"ok":true}' });
    const acc = new ChunkAccumulator();
    for await (const c of adapter.chatStream(
      req({ response_format: { type: 'json_object' } }),
      target,
      attemptContext(),
    ))
      acc.push(c);
    expect(acc.toResponse().choices[0]!.message.content).toBe('{"ok":true}');
  });

  it('propagates upstream errors before any content and cleans up', async () => {
    const { fake, adapter, target } = setup();
    fake.replies.push({
      error: { name: 'APIError', data: { message: 'down', statusCode: 503, isRetryable: true } },
    });
    await expect(
      collect(adapter.chatStream(req(), target, attemptContext())),
    ).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(fake.openSessions).toEqual([]);
  });

  it('aborts the session if the consumer stops early', async () => {
    const { fake, adapter, target } = setup();
    fake.replies.push({
      text: 'a long answer streamed slowly',
      deltas: ['a ', 'long ', 'answer'],
      delayMs: 2000,
    });
    const it = adapter.chatStream(req(), target, attemptContext())[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value?.choices[0]?.delta.content).toBe('a ');
    await it.return?.(undefined);
    expect(fake.aborted).toEqual(fake.created);
    expect(fake.deleted).toEqual(fake.created);
  });

  it('health reports the bridge version', async () => {
    const { adapter } = setup();
    expect(await adapter.health()).toMatchObject({ ok: true, detail: 'opencode fake' });
  });
});
