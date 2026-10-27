import { describe, expect, it } from 'vitest';
import {
  cosineSimilarity,
  createRng,
  decideFailure,
  extractiveAnswer,
  faultsFromHeaders,
  mergeFaults,
  mockEmbedding,
  mockRerank,
  NO_ANSWER,
  parseSources,
  resolveMode,
  runMockChat,
  synthesizeFromSchema,
  wordGroups,
  type MockChatRequest,
} from '../src/index.js';

const RAG_PROMPT = `Answer using only the sources. Cite as [n].
<source id="1" title="Routing">Hono routes requests with a trie-based router. The router supports wildcards.</source>
<source id="2" title="Middleware">Middleware runs before handlers. CORS middleware adds Access-Control headers.</source>
Question: What does CORS middleware add?`;

describe('mode resolution', () => {
  it('maps model names to behaviors with echo as default', () => {
    expect(resolveMode('mock-extractive')).toBe('extractive');
    expect(resolveMode('acme-tools-v2')).toBe('tools');
    expect(resolveMode('mock-fixed')).toBe('fixed');
    expect(resolveMode('anything')).toBe('echo');
  });
});

describe('mock-echo / mock-fixed', () => {
  it('echoes the last user message text (content parts supported)', () => {
    const r = runMockChat({
      model: 'mock-echo',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'x' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello ' },
            { type: 'image_url' },
            { type: 'text', text: 'world' },
          ] as never,
        },
      ],
    });
    expect(r).toMatchObject({ content: 'hello world', finishReason: 'stop', toolCalls: [] });
  });
  it('returns configured fixed text', () => {
    expect(runMockChat({ model: 'mock-fixed', messages: [] }, { fixedText: 'FIXED' }).content).toBe(
      'FIXED',
    );
  });
});

describe('mock-extractive', () => {
  it('parses source blocks with quoted and unquoted ids', () => {
    expect(parseSources(`<source id='a7'>x</source><source title="t" id=3>y</source>`)).toEqual([
      { id: 'a7', text: 'x' },
      { id: '3', text: 'y' },
    ]);
  });
  it('answers with the best sentence and its citation', () => {
    const answer = extractiveAnswer([{ role: 'user', content: RAG_PROMPT }]);
    expect(answer.startsWith('CORS middleware adds Access-Control headers. [2]')).toBe(true);
  });
  it('finds sources in the system message and the question in the user message', () => {
    const answer = extractiveAnswer([
      {
        role: 'system',
        content: '<source id="9">The trie router supports wildcards in paths.</source>',
      },
      { role: 'user', content: 'Does the router support wildcards?' },
    ]);
    expect(answer).toBe('The trie router supports wildcards in paths. [9]');
  });
  it('returns exactly NO_ANSWER when nothing overlaps or there are no sources', () => {
    const unrelated = RAG_PROMPT.replace(
      'What does CORS middleware add?',
      'Who won the 1998 football world cup?',
    );
    expect(extractiveAnswer([{ role: 'user', content: unrelated }])).toBe(NO_ANSWER);
    expect(extractiveAnswer([{ role: 'user', content: 'What is CORS?' }])).toBe(NO_ANSWER);
  });
  it('respects the threshold', () => {
    expect(extractiveAnswer([{ role: 'user', content: RAG_PROMPT }], 1.01)).toBe(NO_ANSWER);
  });
  it('is deterministic', () => {
    const msgs = [{ role: 'user', content: RAG_PROMPT }];
    expect(extractiveAnswer(msgs)).toBe(extractiveAnswer(msgs));
  });
});

describe('mock-tools', () => {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'get_order',
        parameters: {
          type: 'object',
          properties: {
            order_id: { type: 'string' },
            verbose: { type: 'boolean' },
            mode: { enum: ['fast', 'slow'] },
          },
          required: ['order_id', 'mode'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'refund',
        parameters: {
          type: 'object',
          properties: { amount: { type: 'number' } },
          required: ['amount'],
        },
      },
    },
  ];

  it('synthesizes arguments from the schema for the first tool', () => {
    const r = runMockChat({
      model: 'mock-tools',
      messages: [{ role: 'user', content: 'where is my order' }],
      tools,
    });
    expect(r.finishReason).toBe('tool_calls');
    expect(r.toolCalls).toEqual([
      { name: 'get_order', arguments: { order_id: 'mock', mode: 'fast' } },
    ]);
  });

  it('honors a forced tool_choice', () => {
    const r = runMockChat({
      model: 'mock-tools',
      messages: [{ role: 'user', content: 'refund' }],
      tools,
      tool_choice: { type: 'function', function: { name: 'refund' } },
    });
    expect(r.toolCalls).toEqual([{ name: 'refund', arguments: { amount: 1 } }]);
  });

  it('summarizes trailing tool results into a final answer', () => {
    const r = runMockChat({
      model: 'mock-tools',
      tools,
      messages: [
        { role: 'user', content: 'where is my order' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', function: { name: 'get_order', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"status":"shipped"}' },
      ],
    });
    expect(r.finishReason).toBe('stop');
    expect(r.content).toBe('Done. Tool results: get_order: {"status":"shipped"}');
  });

  it('follows an inline script by assistant-turn index', () => {
    const script = [
      { tool_calls: [{ name: 'refund', arguments: { amount: 5 } }] },
      { content: 'Refunded $5.' },
    ];
    const base: MockChatRequest = {
      model: 'mock-tools',
      tools,
      messages: [{ role: 'user', content: 'refund 5' }],
      metadata: { mock_script: script },
    };
    expect(runMockChat(base).toolCalls).toEqual([{ name: 'refund', arguments: { amount: 5 } }]);
    const step2 = runMockChat({
      ...base,
      messages: [
        ...base.messages,
        { role: 'assistant', content: null },
        { role: 'tool', tool_call_id: 'x', content: 'ok' },
      ],
    });
    expect(step2).toMatchObject({ content: 'Refunded $5.', finishReason: 'stop' });
  });

  it('resolves scripts by id from options and accepts JSON-string arguments', () => {
    const r = runMockChat(
      {
        model: 'mock-tools',
        messages: [{ role: 'user', content: 'x' }],
        metadata: { mock_script_id: 's1' },
      },
      {
        scripts: {
          s1: [
            {
              tool_calls: [{ function: { name: 'get_order', arguments: '{"order_id":"ORD-1"}' } }],
            },
          ],
        },
      },
    );
    expect(r.toolCalls).toEqual([{ name: 'get_order', arguments: { order_id: 'ORD-1' } }]);
  });

  it('synthesizes nested objects and arrays', () => {
    expect(
      synthesizeFromSchema({
        type: 'object',
        required: ['a', 'b', 'c'],
        properties: {
          a: { type: 'object', required: ['x'], properties: { x: { type: 'integer' } } },
          b: { type: 'array' },
          c: { type: ['null', 'string'] },
        },
      }),
    ).toEqual({ a: { x: 1 }, b: [], c: 'mock' });
  });
});

describe('embeddings', () => {
  it('is deterministic, has the requested dimension and unit norm', () => {
    const a = mockEmbedding('Hono middleware runs before handlers', 64);
    const b = mockEmbedding('Hono middleware runs before handlers', 64);
    expect(a).toEqual(b);
    expect(a).toHaveLength(64);
    expect(Math.sqrt(a.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 10);
  });
  it('places lexically similar texts closer than unrelated ones', () => {
    const q = mockEmbedding('cors middleware headers');
    const near = mockEmbedding('The CORS middleware adds headers');
    const far = mockEmbedding('Quarterly revenue grew in Europe');
    expect(cosineSimilarity(q, near)).toBeGreaterThan(cosineSimilarity(q, far));
  });
  it('handles empty text with a non-zero unit vector', () => {
    const v = mockEmbedding('', 16);
    expect(Math.sqrt(v.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1);
  });
});

describe('rerank', () => {
  it('orders documents by lexical overlap and applies top_n', () => {
    const docs = ['Bananas are yellow.', 'CORS middleware sets headers.', 'Middleware runs first.'];
    const results = mockRerank('what headers does cors middleware set', docs);
    expect(results.map((r) => r.index)).toEqual([1, 2, 0]);
    expect(results.every((r) => r.relevance_score >= 0 && r.relevance_score <= 1)).toBe(true);
    expect(mockRerank('cors', docs, 1)).toHaveLength(1);
  });
});

describe('faults', () => {
  const headers = (h: Record<string, string>): Headers => new Headers(h);

  it('reads x-mock-* headers', () => {
    expect(
      faultsFromHeaders(
        headers({
          'x-mock-status': '503',
          'x-mock-retry-after': '2',
          'x-mock-latency-ms': '10',
          'x-mock-stream-fail-after': '3',
        }),
      ),
    ).toEqual({
      latencyMs: 10,
      failRate: undefined,
      status: 503,
      retryAfterS: 2,
      streamFailAfter: 3,
    });
  });
  it('scopes header faults with x-mock-fault-target', () => {
    const h = headers({ 'x-mock-status': '503', 'x-mock-fault-target': 'mock-a, mock-b' });
    expect(faultsFromHeaders(h, ['mock-b', 'mock-echo']).status).toBe(503);
    expect(faultsFromHeaders(h, ['mock-c'])).toEqual({});
  });
  it('merges layers with later layers winning', () => {
    expect(mergeFaults({ latencyMs: 5, status: 500 }, { status: 429 }, undefined)).toMatchObject({
      latencyMs: 5,
      status: 429,
      failRate: 0,
    });
  });
  it('decides failures: status alone always fails; fail rate uses the RNG', () => {
    expect(decideFailure(mergeFaults({ status: 500 }))).toBe(500);
    expect(decideFailure(mergeFaults({}))).toBeUndefined();
    const rng = createRng(42);
    const outcomes = Array.from({ length: 1000 }, () =>
      decideFailure(mergeFaults({ failRate: 0.3 }), rng),
    );
    const failures = outcomes.filter((o) => o === 503).length;
    expect(failures).toBeGreaterThan(240);
    expect(failures).toBeLessThan(360);
    const again = createRng(42);
    expect(
      Array.from({ length: 1000 }, () => decideFailure(mergeFaults({ failRate: 0.3 }), again)),
    ).toEqual(outcomes);
  });
});

describe('wordGroups', () => {
  it('splits into word groups that concatenate back to the original', () => {
    const text = 'one two three four five six seven';
    const groups = wordGroups(text, 3);
    expect(groups).toEqual(['one two three ', 'four five six ', 'seven']);
    expect(groups.join('')).toBe(text);
    expect(wordGroups('')).toEqual([]);
  });
});
