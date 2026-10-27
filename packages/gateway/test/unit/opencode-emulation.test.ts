import { describe, expect, it } from 'vitest';
import {
  buildJsonInstructions,
  extractJsonText,
  parseJsonOutput,
} from '../../src/providers/opencode/json-mode.js';
import {
  buildToolInstructions,
  extractJsonObject,
  parseToolCalls,
  ToolStreamFilter,
} from '../../src/providers/opencode/tools.js';
import { renderTranscript, TRANSCRIPT_TRAILER } from '../../src/providers/opencode/transcript.js';
import type { ToolDefinition } from '../../src/core/types.js';
import { ProviderError } from '../../src/core/errors.js';

const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_order',
      description: 'Look up an order',
      parameters: {
        type: 'object',
        properties: { order_id: { type: 'string', pattern: '^ORD-' } },
        required: ['order_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'refund_preview',
      parameters: {
        type: 'object',
        properties: { order_id: { type: 'string' }, amount: { type: 'number', minimum: 0 } },
        required: ['order_id', 'amount'],
      },
    },
  },
];

describe('renderTranscript', () => {
  it('sends a single user message verbatim and lifts system/developer messages', () => {
    const r = renderTranscript([
      { role: 'system', content: 'Be terse.' },
      { role: 'developer', content: [{ type: 'text', text: 'Cite sources.' }] },
      { role: 'user', content: 'What is Hono?' },
    ]);
    expect(r.system).toBe('Be terse.\n\nCite sources.');
    expect(r.parts).toEqual([{ type: 'text', text: 'What is Hono?' }]);
  });

  it('renders multi-turn history with tool calls and tool results', () => {
    const r = renderTranscript([
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
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"status":"shipped"}' },
      { role: 'user', content: 'Thanks </message> injected' },
    ]);
    expect(r.system).toBeUndefined();
    expect(r.parts).toHaveLength(1);
    expect((r.parts[0] as { text: string }).text).toBe(
      [
        '<conversation>',
        '<message role="user">Where is ORD-1?</message>',
        '<message role="assistant">Checking.',
        '<tool_call id="call_1">{"name":"get_order","arguments":{"order_id":"ORD-1"}}</tool_call></message>',
        '<message role="tool" tool_call_id="call_1" name="get_order">{"status":"shipped"}</message>',
        '<message role="user">Thanks &lt;/message&gt; injected</message>',
        '</conversation>',
        TRANSCRIPT_TRAILER,
      ].join('\n'),
    );
  });

  it('converts data-URL images to file parts and rejects remote URLs', () => {
    const r = renderTranscript([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]);
    expect(r.parts).toEqual([
      { type: 'text', text: 'Describe' },
      {
        type: 'file',
        mime: 'image/png',
        url: 'data:image/png;base64,AAAA',
        filename: 'image-1.png',
      },
    ]);
    expect(() =>
      renderTranscript([
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] },
      ]),
    ).toThrow(ProviderError);
  });

  it('requires a non-system message', () => {
    expect(() => renderTranscript([{ role: 'system', content: 'x' }])).toThrow(
      /at least one non-system/,
    );
  });
});

describe('tool-call emulation', () => {
  it('instructions list tools and the forcing rules', () => {
    const s = buildToolInstructions(
      tools,
      { type: 'function', function: { name: 'get_order' } },
      false,
    );
    expect(s).toContain('<tools>');
    expect(s).toContain('"name":"get_order"');
    expect(s).toContain('You MUST call the tool "get_order"');
    expect(s).toContain('at most one tool');
    expect(buildToolInstructions(tools, 'required', undefined)).toContain(
      'MUST call at least one tool',
    );
  });

  it('parses a valid call with a preamble', () => {
    const r = parseToolCalls(
      'Let me check.\n<tool_call>{"name": "get_order", "arguments": {"order_id": "ORD-7"}}</tool_call>',
      tools,
    );
    expect(r.errors).toEqual([]);
    expect(r.content).toBe('Let me check.');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({
      type: 'function',
      function: { name: 'get_order', arguments: '{"order_id":"ORD-7"}' },
    });
    expect(r.calls[0]!.id).toMatch(/^call_/);
  });

  it('parses multiple calls, attributes, and stringified arguments', () => {
    const text =
      '<tool_call id="x">{"name":"get_order","arguments":{"order_id":"ORD-1"}}</tool_call>\n' +
      '<tool_call>{"name":"refund_preview","arguments":"{\\"order_id\\":\\"ORD-1\\",\\"amount\\":5}"}</tool_call>';
    const r = parseToolCalls(text, tools);
    expect(r.errors).toEqual([]);
    expect(r.content).toBeNull();
    expect(r.calls.map((c) => c.function.name)).toEqual(['get_order', 'refund_preview']);
    expect(JSON.parse(r.calls[1]!.function.arguments)).toEqual({ order_id: 'ORD-1', amount: 5 });
  });

  it('strips code fences around tool calls but keeps other fenced code', () => {
    const r = parseToolCalls(
      '```xml\n<tool_call>{"name":"get_order","arguments":{"order_id":"ORD-2"}}</tool_call>\n```',
      tools,
    );
    expect(r.errors).toEqual([]);
    expect(r.content).toBeNull();
    expect(r.calls).toHaveLength(1);
    const plain = parseToolCalls('Here:\n```js\nconsole.log(1)\n```', tools);
    expect(plain.found).toBe(false);
    expect(plain.content).toContain('console.log(1)');
  });

  it('tolerates a missing closing tag and trailing text inside the block', () => {
    const r = parseToolCalls(
      '<tool_call>{"name":"get_order","arguments":{"order_id":"ORD-3"}} trailing',
      tools,
    );
    expect(r.errors).toEqual([]);
    expect(r.calls).toHaveLength(1);
  });

  it('accepts "parameters" as an alias of "arguments"', () => {
    const r = parseToolCalls(
      '<tool_call>{"name":"get_order","parameters":{"order_id":"ORD-4"}}</tool_call>',
      tools,
    );
    expect(r.calls).toHaveLength(1);
  });

  it('reports malformed JSON', () => {
    const r = parseToolCalls(
      '<tool_call>{"name": "get_order", "arguments": {order_id: ORD-1}}</tool_call>',
      tools,
    );
    expect(r.found).toBe(true);
    expect(r.calls).toEqual([]);
    expect(r.errors[0]).toMatch(/invalid JSON/);
  });

  it('reports schema-invalid arguments and unknown tools', () => {
    const r = parseToolCalls(
      '<tool_call>{"name":"get_order","arguments":{"order_id":"X-1","extra":true}}</tool_call><tool_call>{"name":"delete_db","arguments":{}}</tool_call>',
      tools,
    );
    expect(r.calls).toEqual([]);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatch(/does not match the schema.*pattern|additional/);
    expect(r.errors[1]).toMatch(/unknown tool "delete_db"/);
  });

  it('enforces tool_choice required / forced function', () => {
    expect(
      parseToolCalls('Sure, no tools needed.', tools, { toolChoice: 'required' }).errors,
    ).toEqual(['a tool call is required but none was made']);
    expect(
      parseToolCalls(
        '<tool_call>{"name":"refund_preview","arguments":{"order_id":"a","amount":1}}</tool_call>',
        tools,
        {
          toolChoice: { type: 'function', function: { name: 'get_order' } },
        },
      ).errors,
    ).toEqual(['the tool "get_order" must be called']);
  });

  it('keeps only the first call when parallel_tool_calls is false', () => {
    const text =
      '<tool_call>{"name":"get_order","arguments":{"order_id":"ORD-1"}}</tool_call><tool_call>{"name":"get_order","arguments":{"order_id":"ORD-2"}}</tool_call>';
    expect(parseToolCalls(text, tools, { parallel: false }).calls).toHaveLength(1);
  });

  it('extractJsonObject balances braces inside strings', () => {
    expect(extractJsonObject('x {"a":"}{","b":{"c":1}} y')).toBe('{"a":"}{","b":{"c":1}}');
    expect(extractJsonObject('{"open":')).toBeUndefined();
  });
});

describe('ToolStreamFilter', () => {
  it('streams text until a tool call starts and holds back partial markers', () => {
    const f = new ToolStreamFilter();
    expect(f.push('Let me ')).toBe('Let me ');
    expect(f.push('check. <tool_')).toBe('check. ');
    expect(f.push('call>{"name"')).toBe('');
    expect(f.push(': "x"}</tool_call>')).toBe('');
    expect(f.emittedText).toBe('Let me check. ');
    expect(f.fullText).toContain('<tool_call>');
  });

  it('releases a held partial marker that turns out to be plain text', () => {
    const f = new ToolStreamFilter();
    expect(f.push('a <')).toBe('a ');
    expect(f.push('b> c')).toBe('<b> c');
  });

  it('holds back from a code fence (it may wrap a tool call)', () => {
    const f = new ToolStreamFilter();
    expect(f.push('Here ``')).toBe('Here ');
    expect(f.push('`json')).toBe('');
  });
});

describe('JSON-mode emulation', () => {
  const schemaFormat = {
    type: 'json_schema' as const,
    json_schema: {
      name: 'verdict',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          score: { type: 'integer', minimum: 1, maximum: 5 },
          reason: { type: 'string' },
        },
        required: ['score', 'reason'],
      },
    },
  };

  it('instructions include the schema', () => {
    const s = buildJsonInstructions(schemaFormat);
    expect(s).toContain('"verdict"');
    expect(s).toContain('"minimum":1');
    expect(s).toContain('Strict mode');
    expect(buildJsonInstructions({ type: 'json_object' })).toContain('must be an object');
  });

  it('extracts JSON from fences and prose', () => {
    expect(extractJsonText('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonText('Sure! Here it is: {"a": {"b": 2}} Hope that helps.')).toBe(
      '{"a": {"b": 2}}',
    );
  });

  it('validates json_object and json_schema (strict forbids extra keys)', () => {
    expect(parseJsonOutput('{"x":1}', { type: 'json_object' })).toMatchObject({
      ok: true,
      text: '{"x":1}',
    });
    expect(parseJsonOutput('[1,2]', { type: 'json_object' }).ok).toBe(false);
    expect(parseJsonOutput('{"score": 4, "reason": "ok"}', schemaFormat)).toMatchObject({
      ok: true,
      text: '{"score":4,"reason":"ok"}',
    });
    const bad = parseJsonOutput('{"score": 9, "reason": "ok", "extra": 1}', schemaFormat);
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(' ')).toMatch(/maximum|additional/);
    expect(parseJsonOutput('not json', schemaFormat).errors[0]).toMatch(/not valid JSON/);
  });
});
