import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../../src/core/errors.js';
import type { ChatRequest } from '../../../src/core/types.js';
import {
  anthropicError,
  fromAnthropicResponse,
  JSON_TOOL_NAME,
  mapStopReason,
  stripCodeFence,
  toAnthropicRequest,
  translateToolChoice,
  type AnthropicResponse,
  type TranslateOptions,
} from '../../../src/providers/anthropic/translate.js';

const opts: TranslateOptions = {
  model: 'claude-sonnet-4-5',
  provider: 'anthropic',
  defaultMaxTokens: 4096,
  jsonMode: 'tool',
};

const req = (r: Partial<ChatRequest>): ChatRequest => ({ model: 'route', messages: [], ...r });

const fixture = (name: string): AnthropicResponse =>
  JSON.parse(
    readFileSync(new URL(`../../fixtures/anthropic/${name}`, import.meta.url), 'utf8'),
  ) as AnthropicResponse;

describe('toAnthropicRequest: messages', () => {
  it('hoists system/developer messages and merges consecutive same-role turns', () => {
    const { body } = toAnthropicRequest(
      req({
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'developer', content: [{ type: 'text', text: 'Cite sources.' }] },
          { role: 'user', content: 'First' },
          { role: 'user', content: 'Second' },
          { role: 'assistant', content: 'Answer' },
        ],
      }),
      opts,
    );
    expect(body.system).toBe('You are terse.\n\nCite sources.');
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'First' },
          { type: 'text', text: 'Second' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] },
    ]);
    expect(body.model).toBe('claude-sonnet-4-5');
    expect(body.max_tokens).toBe(4096);
  });

  it('translates a full tool round trip (tool_use + tool_result in one user turn)', () => {
    const { body } = toAnthropicRequest(
      req({
        messages: [
          { role: 'user', content: 'Where is ORD-1?' },
          {
            role: 'assistant',
            content: 'Checking.',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_order', arguments: '{"order_id":"ORD-1"}' },
              },
              {
                id: 'call_2',
                type: 'function',
                function: { name: 'get_customer', arguments: 'not json' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '{"status":"shipped"}' },
          { role: 'tool', tool_call_id: 'call_2', content: [{ type: 'text', text: 'Jane' }] },
          { role: 'user', content: 'Thanks, summarize.' },
        ],
      }),
      opts,
    );
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 'call_1', name: 'get_order', input: { order_id: 'ORD-1' } },
        { type: 'tool_use', id: 'call_2', name: 'get_customer', input: {} },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: '{"status":"shipped"}' },
        { type: 'tool_result', tool_use_id: 'call_2', content: [{ type: 'text', text: 'Jane' }] },
        { type: 'text', text: 'Thanks, summarize.' },
      ],
    });
  });

  it('converts data: and http(s) image URLs and rejects others', () => {
    const { body } = toAnthropicRequest(
      req({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
              { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } },
            ],
          },
        ],
      }),
      opts,
    );
    expect(body.messages[0]!.content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/cat.jpg' } },
    ]);
    expect(() =>
      toAnthropicRequest(
        req({
          messages: [
            { role: 'user', content: [{ type: 'image_url', image_url: { url: 'ftp://x/y.png' } }] },
          ],
        }),
        opts,
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'unsupported_content', fallback: true }) as Error,
    );
  });

  it('rejects n > 1', () => {
    expect(() =>
      toAnthropicRequest(req({ n: 2, messages: [{ role: 'user', content: 'x' }] }), opts),
    ).toThrow(ProviderError);
  });
});

describe('toAnthropicRequest: tools, limits, sampling', () => {
  const tools = [
    {
      type: 'function' as const,
      function: {
        name: 'get_order',
        description: 'Look up an order',
        parameters: { type: 'object', properties: { order_id: { type: 'string' } } },
      },
    },
    { type: 'function' as const, function: { name: 'ping' } },
  ];

  it('maps tool definitions', () => {
    const { body } = toAnthropicRequest(
      req({ messages: [{ role: 'user', content: 'x' }], tools }),
      opts,
    );
    expect(body.tools).toEqual([
      {
        name: 'get_order',
        description: 'Look up an order',
        input_schema: tools[0]!.function.parameters,
      },
      { name: 'ping', input_schema: { type: 'object', properties: {} } },
    ]);
    expect(body.tool_choice).toBeUndefined();
  });

  it.each([
    ['auto', undefined, { type: 'auto' }],
    ['none', undefined, { type: 'none' }],
    ['required', undefined, { type: 'any' }],
    [{ type: 'function', function: { name: 'ping' } }, undefined, { type: 'tool', name: 'ping' }],
    ['required', false, { type: 'any', disable_parallel_tool_use: true }],
    [undefined, false, { type: 'auto', disable_parallel_tool_use: true }],
    [undefined, undefined, undefined],
  ] as const)('tool_choice %j (parallel=%s)', (choice, parallel, expected) => {
    expect(translateToolChoice(choice as never, parallel)).toEqual(expected);
  });

  it('applies max_tokens precedence: request > route default > provider default', () => {
    const m = [{ role: 'user' as const, content: 'x' }];
    expect(
      toAnthropicRequest(req({ messages: m, max_completion_tokens: 10, max_tokens: 20 }), {
        ...opts,
        routeMaxTokens: 30,
      }).body.max_tokens,
    ).toBe(10);
    expect(
      toAnthropicRequest(req({ messages: m, max_tokens: 20 }), { ...opts, routeMaxTokens: 30 }).body
        .max_tokens,
    ).toBe(20);
    expect(
      toAnthropicRequest(req({ messages: m }), { ...opts, routeMaxTokens: 30 }).body.max_tokens,
    ).toBe(30);
    expect(toAnthropicRequest(req({ messages: m }), opts).body.max_tokens).toBe(4096);
  });

  it('maps stop, user, temperature (clamped) and top_p', () => {
    const { body } = toAnthropicRequest(
      req({
        messages: [{ role: 'user', content: 'x' }],
        stop: 'END',
        user: 'u-1',
        temperature: 1.6,
        top_p: 0.9,
      }),
      opts,
    );
    expect(body.stop_sequences).toEqual(['END']);
    expect(body.metadata).toEqual({ user_id: 'u-1' });
    expect(body.temperature).toBe(1);
    expect(body.top_p).toBe(0.9);
  });

  it('maps reasoning_effort to extended thinking, raising max_tokens and dropping sampling params', () => {
    const { body } = toAnthropicRequest(
      req({
        messages: [{ role: 'user', content: 'x' }],
        reasoning_effort: 'high',
        max_tokens: 1000,
        temperature: 0.5,
      }),
      opts,
    );
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
    expect(body.max_tokens).toBeGreaterThan(16384);
    expect(body.temperature).toBeUndefined();
    for (const effort of ['minimal', 'none'] as const) {
      expect(
        toAnthropicRequest(
          req({ messages: [{ role: 'user', content: 'x' }], reasoning_effort: effort }),
          opts,
        ).body.thinking,
      ).toBeUndefined();
    }
  });

  it('drops thinking when a tool is forced (Anthropic rejects the combination)', () => {
    const { body } = toAnthropicRequest(
      req({
        messages: [{ role: 'user', content: 'x' }],
        reasoning_effort: 'medium',
        tools,
        tool_choice: 'required',
      }),
      opts,
    );
    expect(body.thinking).toBeUndefined();
    expect(body.tool_choice).toEqual({ type: 'any' });
  });
});

describe('toAnthropicRequest: JSON mode', () => {
  const schema = {
    type: 'object',
    properties: { answer: { type: 'number' } },
    required: ['answer'],
  };
  const rf = { type: 'json_schema' as const, json_schema: { name: 'result', schema } };

  it('tool mode forces the synthetic json_response tool', () => {
    const t = toAnthropicRequest(
      req({ messages: [{ role: 'user', content: 'x' }], response_format: rf }),
      opts,
    );
    expect(t.jsonTool).toBe(true);
    expect(t.body.tools).toEqual([
      {
        name: JSON_TOOL_NAME,
        description: 'Return the final answer as result.',
        input_schema: schema,
      },
    ]);
    expect(t.body.tool_choice).toEqual({ type: 'tool', name: JSON_TOOL_NAME });
  });

  it('prompt mode / json_object / json_schema with user tools instruct via system', () => {
    const p = toAnthropicRequest(
      req({
        messages: [
          { role: 'system', content: 'Sys' },
          { role: 'user', content: 'x' },
        ],
        response_format: rf,
      }),
      { ...opts, jsonMode: 'prompt' },
    );
    expect(p.jsonTool).toBe(false);
    expect(p.body.system).toContain('Sys\n\nRespond with a single valid JSON value only');
    expect(p.body.system).toContain(JSON.stringify(schema));

    const o = toAnthropicRequest(
      req({ messages: [{ role: 'user', content: 'x' }], response_format: { type: 'json_object' } }),
      opts,
    );
    expect(o.jsonOutput).toBe(true);
    expect(o.body.system).toContain('single valid JSON value');

    const withTools = toAnthropicRequest(
      req({
        messages: [{ role: 'user', content: 'x' }],
        response_format: rf,
        tools: [{ type: 'function', function: { name: 'f' } }],
      }),
      opts,
    );
    expect(withTools.jsonTool).toBe(false);
    expect(withTools.body.tools).toHaveLength(1);
    expect(withTools.body.system).toContain('JSON Schema');
  });
});

describe('fromAnthropicResponse', () => {
  it('maps text, tool_use, stop reason and cache-aware usage', () => {
    const res = fromAnthropicResponse(fixture('message_tool_use.json'), {
      jsonTool: false,
      jsonOutput: false,
      includeReasoning: false,
    });
    const choice = res.choices[0]!;
    expect(res.id).toBe('msg_01NonStream');
    expect(choice.message.content).toBe('Checking the order.');
    expect(choice.message.tool_calls).toEqual([
      {
        id: 'toolu_01X',
        type: 'function',
        function: { name: 'get_order', arguments: '{"order_id":"ORD-1"}' },
      },
    ]);
    expect(choice.message.reasoning_content).toBeUndefined();
    expect(choice.finish_reason).toBe('tool_calls');
    expect(res.usage).toEqual({
      prompt_tokens: 420,
      completion_tokens: 45,
      total_tokens: 465,
      prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 20 },
    });
  });

  it('includes reasoning only when requested', () => {
    const res = fromAnthropicResponse(fixture('message_tool_use.json'), {
      jsonTool: false,
      jsonOutput: false,
      includeReasoning: true,
    });
    expect(res.choices[0]!.message.reasoning_content).toBe('Need the order first.');
  });

  it('returns the json_response tool input as content with finish stop', () => {
    const res = fromAnthropicResponse(
      {
        id: 'msg_j',
        type: 'message',
        role: 'assistant',
        model: 'claude',
        content: [{ type: 'tool_use', id: 't', name: JSON_TOOL_NAME, input: { answer: 42 } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 3 },
      },
      { jsonTool: true, jsonOutput: true, includeReasoning: false },
    );
    expect(res.choices[0]!.message.content).toBe('{"answer":42}');
    expect(res.choices[0]!.message.tool_calls).toBeUndefined();
    expect(res.choices[0]!.finish_reason).toBe('stop');
  });

  it('strips code fences from prompt-mode JSON answers', () => {
    const res = fromAnthropicResponse(
      {
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: 'claude',
        content: [{ type: 'text', text: '```json\n{"a":1}\n```' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      { jsonTool: false, jsonOutput: true, includeReasoning: false },
    );
    expect(res.choices[0]!.message.content).toBe('{"a":1}');
    expect(stripCodeFence('plain')).toBe('plain');
  });
});

describe('mappings', () => {
  it.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['tool_use', 'tool_calls'],
    ['max_tokens', 'length'],
    ['refusal', 'content_filter'],
    [null, 'stop'],
  ] as const)('stop_reason %s → %s', (reason, finish) => {
    expect(mapStopReason(reason, false)).toBe(finish);
  });

  it.each([
    ['overloaded_error', 'upstream_unavailable', true, true],
    ['rate_limit_error', 'rate_limited', true, true],
    ['api_error', 'upstream_error', true, true],
    ['invalid_request_error', 'invalid_request', false, false],
    ['authentication_error', 'upstream_auth', false, true],
    ['not_found_error', 'upstream_not_found', false, true],
  ] as const)('error %s → %s', (type, code, retryable, fallback) => {
    const err = anthropicError('anthropic', type, 'msg');
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
    expect(err.fallback).toBe(fallback);
  });
});
