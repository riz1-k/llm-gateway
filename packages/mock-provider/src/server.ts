import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import {
  approxTokens,
  createRng,
  decideFailure,
  embeddingToBase64,
  faultsFromHeaders,
  mergeFaults,
  messageText,
  mockEmbeddings,
  mockRerank,
  runMockChat,
  wordGroups,
  type MockChatRequest,
  type MockChatResult,
  type MockEngineOptions,
  type MockFault,
  type MockMessage,
  type MockTool,
} from './engine/index.js';

/**
 * Standalone fake upstream: OpenAI-style (`/v1/chat/completions`, `/v1/embeddings`), Jina /
 * llama.cpp-style rerank (`/v1/rerank`, `/rerank`) and Anthropic-style (`/v1/messages`) endpoints
 * backed by the deterministic mock engine. `x-mock-*` fault headers are always honored.
 */

export interface MockServerOptions {
  /** Latency added to every request. */
  latencyMs?: number;
  /** Probability of an injected failure for every request. */
  failRate?: number;
  /** Status for injected failures (always fails when set without failRate). */
  failStatus?: number;
  retryAfterS?: number;
  fixedText?: string;
  embeddingDim?: number;
  extractiveThreshold?: number;
  scripts?: Record<string, readonly unknown[]>;
  /** Seed for the fail-rate RNG (reproducible chaos). */
  seed?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  at: number;
  body: unknown;
}

export interface MockStats {
  total: number;
  requests: Record<string, number>;
  /** Most recent requests (bounded), oldest first. */
  recent: RecordedRequest[];
}

export interface MockApp {
  app: Hono;
  stats(): MockStats;
  reset(): void;
}

export interface StartMockServerOptions extends MockServerOptions {
  /** 0 = ephemeral port (default). */
  port?: number;
  host?: string;
}

export interface RunningMockServer {
  url: string;
  port: number;
  close(): Promise<void>;
  stats(): MockStats;
  reset(): void;
}

const MAX_RECENT = 50;
/** Upper bound for a client-requested `dimensions` (vectors are allocated per input). */
const MAX_EMBEDDING_DIM = 8192;
const MOCK_MODELS = [
  'mock-echo',
  'mock-fixed',
  'mock-extractive',
  'mock-tools',
  'mock-embed',
  'mock-rerank',
];

type JsonRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is JsonRecord =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const now = (): number => Math.floor(Date.now() / 1000);
const shortId = (): string => randomUUID().replace(/-/g, '').slice(0, 24);

class BadRequest extends Error {}

export function createMockApp(opts: MockServerOptions = {}): MockApp {
  const random = opts.seed === undefined ? Math.random : createRng(opts.seed);
  const engineOpts: MockEngineOptions = {
    ...(opts.fixedText === undefined ? {} : { fixedText: opts.fixedText }),
    ...(opts.extractiveThreshold === undefined
      ? {}
      : { extractiveThreshold: opts.extractiveThreshold }),
    ...(opts.scripts === undefined ? {} : { scripts: opts.scripts }),
  };
  const baseFault: Partial<MockFault> = {
    latencyMs: opts.latencyMs,
    failRate: opts.failRate,
    status: opts.failStatus,
    retryAfterS: opts.retryAfterS,
  };
  const embeddingDim = opts.embeddingDim ?? 256;

  let stats: MockStats = { total: 0, requests: {}, recent: [] };
  const record = (method: string, path: string, body: unknown): void => {
    stats.total++;
    const key = `${method} ${path}`;
    stats.requests[key] = (stats.requests[key] ?? 0) + 1;
    stats.recent.push({ method, path, at: Date.now(), body });
    if (stats.recent.length > MAX_RECENT) stats.recent.shift();
  };

  const app = new Hono();

  app.onError((err, c) => {
    const status = err instanceof BadRequest ? 400 : 500;
    return c.json(
      { error: { message: err.message, type: 'invalid_request_error', code: null } },
      status,
    );
  });

  /** Parses the JSON body, records the request, applies latency and decides injected failure. */
  const prelude = async (
    c: Context,
  ): Promise<{ body: JsonRecord; fault: MockFault; failStatus: number | undefined }> => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      record(c.req.method, c.req.path, null);
      throw new BadRequest('request body must be valid JSON');
    }
    record(c.req.method, c.req.path, body);
    if (!isRecord(body)) throw new BadRequest('request body must be a JSON object');
    const model = typeof body.model === 'string' ? body.model : '';
    const fault = mergeFaults(baseFault, faultsFromHeaders(c.req.raw.headers, [model]));
    if (fault.latencyMs > 0) await sleep(fault.latencyMs);
    return { body, fault, failStatus: decideFailure(fault, random) };
  };

  const retryHeaders = (fault: MockFault): Record<string, string> =>
    fault.retryAfterS === undefined ? {} : { 'retry-after': String(fault.retryAfterS) };

  const openaiFailure = (c: Context, status: number, fault: MockFault): Response =>
    c.json(
      {
        error: {
          message: `mock: injected ${status} failure`,
          type:
            status === 429
              ? 'rate_limit_error'
              : status >= 500
                ? 'server_error'
                : 'invalid_request_error',
          code: status === 429 ? 'rate_limit_exceeded' : 'mock_fault',
        },
      },
      status as 400,
      retryHeaders(fault),
    );

  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/v1/models', (c) =>
    c.json({
      object: 'list',
      data: MOCK_MODELS.map((id) => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'switchyard-mock',
      })),
    }),
  );
  app.get('/__mock/stats', (c) => c.json(stats));
  app.post('/__mock/reset', (c) => {
    stats = { total: 0, requests: {}, recent: [] };
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------------------------------
  // OpenAI chat completions
  // ------------------------------------------------------------------------------------------
  app.post('/v1/chat/completions', async (c) => {
    const { body, fault, failStatus } = await prelude(c);
    if (failStatus !== undefined) return openaiFailure(c, failStatus, fault);
    const req = toChatRequest(body);
    const result = runMockChat(req, engineOpts);
    const model = req.model || 'mock-echo';
    const usage = openaiUsage(req, result);
    const id = `chatcmpl-${shortId()}`;
    const toolCalls = result.toolCalls.map((tc, i) => ({
      id: `call_${shortId()}`,
      type: 'function' as const,
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      index: i,
    }));

    if (body.stream !== true) {
      return c.json({
        id,
        object: 'chat.completion',
        created: now(),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.content,
              ...(toolCalls.length > 0
                ? { tool_calls: toolCalls.map(({ index: _i, ...tc }) => tc) }
                : {}),
            },
            finish_reason: result.finishReason,
          },
        ],
        usage,
      });
    }

    const includeUsage =
      isRecord(body.stream_options) && body.stream_options.include_usage === true;
    const created = now();
    const chunk = (delta: JsonRecord, finish: string | null = null): JsonRecord => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const events: JsonRecord[] = [chunk({ role: 'assistant', content: '' })];
    const contentChunks = wordGroups(result.content ?? '').map((piece) =>
      chunk({ content: piece }),
    );
    const tail: JsonRecord[] = [];
    for (const tc of toolCalls) {
      tail.push(
        chunk({
          tool_calls: [
            {
              index: tc.index,
              id: tc.id,
              type: 'function',
              function: { name: tc.function.name, arguments: '' },
            },
          ],
        }),
      );
      tail.push(
        chunk({
          tool_calls: [{ index: tc.index, function: { arguments: tc.function.arguments } }],
        }),
      );
    }
    tail.push(chunk({}, result.finishReason));
    if (includeUsage)
      tail.push({ id, object: 'chat.completion.chunk', created, model, choices: [], usage });

    return sseResponse((emit, fail) => {
      for (const ev of events) emit(JSON.stringify(ev));
      for (const [i, ev] of contentChunks.entries()) {
        if (fault.streamFailAfter !== undefined && i >= fault.streamFailAfter) return fail();
        emit(JSON.stringify(ev));
      }
      // With no content (tool calls only), `stream_fail_after: 0` still fails before any payload.
      if (fault.streamFailAfter === 0) return fail();
      for (const ev of tail) emit(JSON.stringify(ev));
      emit('[DONE]');
    });
  });

  // ------------------------------------------------------------------------------------------
  // Embeddings
  // ------------------------------------------------------------------------------------------
  app.post('/v1/embeddings', async (c) => {
    const { body, fault, failStatus } = await prelude(c);
    if (failStatus !== undefined) return openaiFailure(c, failStatus, fault);
    const input = body.input;
    const texts =
      typeof input === 'string'
        ? [input]
        : Array.isArray(input) && input.every((x) => typeof x === 'string')
          ? input
          : null;
    if (!texts) throw new BadRequest('input must be a string or an array of strings');
    const dim =
      typeof body.dimensions === 'number' && body.dimensions > 0
        ? Math.min(Math.trunc(body.dimensions), MAX_EMBEDDING_DIM)
        : embeddingDim;
    const base64 = body.encoding_format === 'base64';
    const vectors = mockEmbeddings(texts, dim);
    const tokens = texts.reduce((acc, t) => acc + approxTokens(t), 0);
    return c.json({
      object: 'list',
      data: vectors.map((v, index) => ({
        object: 'embedding',
        index,
        embedding: base64 ? embeddingToBase64(v) : v,
      })),
      model: typeof body.model === 'string' ? body.model : 'mock-embed',
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    });
  });

  // ------------------------------------------------------------------------------------------
  // Rerank (Jina / llama.cpp / Cohere shape)
  // ------------------------------------------------------------------------------------------
  const rerankHandler = async (c: Context): Promise<Response> => {
    const { body, fault, failStatus } = await prelude(c);
    if (failStatus !== undefined) return openaiFailure(c, failStatus, fault);
    if (typeof body.query !== 'string') throw new BadRequest('query must be a string');
    if (!Array.isArray(body.documents)) throw new BadRequest('documents must be an array');
    const docs = body.documents.map((d) =>
      typeof d === 'string' ? d : isRecord(d) && typeof d.text === 'string' ? d.text : '',
    );
    const topN = typeof body.top_n === 'number' ? body.top_n : undefined;
    const results = mockRerank(body.query, docs, topN).map((r) => ({
      ...r,
      ...(body.return_documents === true ? { document: { text: docs[r.index] } } : {}),
    }));
    const tokens =
      approxTokens(body.query) * docs.length + docs.reduce((acc, d) => acc + approxTokens(d), 0);
    return c.json({
      id: `rerank-${shortId()}`,
      model: typeof body.model === 'string' ? body.model : 'mock-rerank',
      object: 'list',
      results,
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    });
  };
  app.post('/v1/rerank', rerankHandler);
  app.post('/rerank', rerankHandler);

  // ------------------------------------------------------------------------------------------
  // Anthropic Messages API
  // ------------------------------------------------------------------------------------------
  app.post('/v1/messages', async (c) => {
    const { body, fault, failStatus } = await prelude(c);
    if (failStatus !== undefined) {
      return c.json(
        {
          type: 'error',
          error: {
            type: anthropicErrorType(failStatus),
            message: `mock: injected ${failStatus} failure`,
          },
        },
        failStatus as 400,
        retryHeaders(fault),
      );
    }
    const req = anthropicToChatRequest(body);
    const result = runMockChat(req, engineOpts);
    const model = req.model || 'mock-echo';
    const inputTokens = req.messages.reduce((acc, m) => acc + approxTokens(messageText(m)) + 4, 0);
    const toolBlocks = result.toolCalls.map((tc) => ({
      type: 'tool_use',
      id: `toolu_${shortId()}`,
      name: tc.name,
      input: tc.arguments,
    }));
    const outputTokens = Math.max(
      1,
      approxTokens(result.content ?? '') +
        toolBlocks.reduce((acc, b) => acc + approxTokens(JSON.stringify(b.input)), 0),
    );
    const stopReason = result.finishReason === 'tool_calls' ? 'tool_use' : 'end_turn';
    const id = `msg_${shortId()}`;
    const usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };

    if (body.stream !== true) {
      return c.json({
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [
          ...(result.content ? [{ type: 'text', text: result.content }] : []),
          ...toolBlocks,
        ],
        stop_reason: stopReason,
        stop_sequence: null,
        usage,
      });
    }

    return sseResponse((emit) => {
      const send = (type: string, data: JsonRecord): void =>
        emit(JSON.stringify({ type, ...data }), type);
      send('message_start', {
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...usage, output_tokens: 1 },
        },
      });
      send('ping', {});
      let index = 0;
      if (result.content) {
        send('content_block_start', { index, content_block: { type: 'text', text: '' } });
        for (const [i, piece] of wordGroups(result.content).entries()) {
          if (fault.streamFailAfter !== undefined && i >= fault.streamFailAfter) {
            send('error', {
              error: { type: 'overloaded_error', message: 'mock: injected mid-stream failure' },
            });
            return;
          }
          send('content_block_delta', { index, delta: { type: 'text_delta', text: piece } });
        }
        send('content_block_stop', { index });
        index++;
      } else if (fault.streamFailAfter === 0) {
        send('error', {
          error: { type: 'overloaded_error', message: 'mock: injected mid-stream failure' },
        });
        return;
      }
      for (const block of toolBlocks) {
        send('content_block_start', {
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        });
        const json = JSON.stringify(block.input);
        const mid = Math.ceil(json.length / 2);
        for (const part of [json.slice(0, mid), json.slice(mid)]) {
          if (part)
            send('content_block_delta', {
              index,
              delta: { type: 'input_json_delta', partial_json: part },
            });
        }
        send('content_block_stop', { index });
        index++;
      }
      send('message_delta', {
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      });
      send('message_stop', {});
    });
  });

  return {
    app,
    stats: () => structuredClone(stats),
    reset: () => {
      stats = { total: 0, requests: {}, recent: [] };
    },
  };
}

/** Starts the mock server (port 0 = ephemeral). */
export async function startMockServer(
  opts: StartMockServerOptions = {},
): Promise<RunningMockServer> {
  const mock = createMockApp(opts);
  const host = opts.host ?? '127.0.0.1';
  const server = await new Promise<ServerType>((resolve, reject) => {
    const s = serve({ fetch: mock.app.fetch, port: opts.port ?? 0, hostname: host }, () =>
      resolve(s),
    );
    s.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return {
    url: `http://${displayHost}:${port}`,
    port,
    stats: () => mock.stats(),
    reset: () => mock.reset(),
    close: () =>
      new Promise<void>((resolve, reject) => {
        const s = server as ServerType & { closeAllConnections?: () => void };
        server.close((err) => (err ? reject(err) : resolve()));
        s.closeAllConnections?.();
      }),
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/**
 * Builds an SSE response. `produce` emits events synchronously; calling `fail()` errors the
 * stream, which makes the HTTP layer destroy the connection mid-response.
 */
function sseResponse(
  produce: (emit: (data: string, event?: string) => void, fail: () => void) => void,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let failed = false;
      const emit = (data: string, event?: string): void => {
        controller.enqueue(encoder.encode(`${event ? `event: ${event}\n` : ''}data: ${data}\n\n`));
      };
      const fail = (): void => {
        failed = true;
        controller.error(new Error('mock: injected mid-stream failure'));
      };
      produce(emit, fail);
      if (!failed) controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

function toChatRequest(body: JsonRecord): MockChatRequest {
  if (!Array.isArray(body.messages)) throw new BadRequest('messages must be an array');
  return {
    model: typeof body.model === 'string' ? body.model : '',
    messages: body.messages.filter(isRecord).map((m) => m as unknown as MockMessage),
    ...(Array.isArray(body.tools)
      ? { tools: body.tools.filter(isRecord) as unknown as MockTool[] }
      : {}),
    ...(body.tool_choice === undefined ? {} : { tool_choice: body.tool_choice }),
    ...(isRecord(body.metadata) ? { metadata: body.metadata } : {}),
  };
}

function openaiUsage(
  req: MockChatRequest,
  result: MockChatResult,
): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const prompt = req.messages.reduce((acc, m) => acc + approxTokens(messageText(m)) + 4, 3);
  const completion = Math.max(
    1,
    approxTokens(result.content ?? '') +
      result.toolCalls.reduce((acc, tc) => acc + approxTokens(JSON.stringify(tc.arguments)) + 4, 0),
  );
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

function anthropicErrorType(status: number): string {
  if (status === 429) return 'rate_limit_error';
  if (status === 529 || status === 503) return 'overloaded_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status >= 500) return 'api_error';
  return 'invalid_request_error';
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('');
}

/** Converts an Anthropic Messages request into the engine's OpenAI-ish request. */
export function anthropicToChatRequest(body: JsonRecord): MockChatRequest {
  if (!Array.isArray(body.messages)) throw new BadRequest('messages must be an array');
  const messages: MockMessage[] = [];
  const system = blockText(body.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const m of body.messages.filter(isRecord)) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (typeof m.content === 'string') {
      messages.push({ role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content.filter(isRecord) : [];
    const text = blockText(blocks);
    if (role === 'assistant') {
      const toolCalls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: typeof b.id === 'string' ? b.id : '',
          function: {
            name: typeof b.name === 'string' ? b.name : 'tool',
            arguments: JSON.stringify(b.input ?? {}),
          },
        }));
      messages.push({
        role,
        content: text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    for (const b of blocks.filter((x) => x.type === 'tool_result')) {
      messages.push({
        role: 'tool',
        tool_call_id: typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
        content: blockText(b.content),
      });
    }
    if (text || blocks.every((b) => b.type !== 'tool_result'))
      messages.push({ role: 'user', content: text });
  }
  const tools: MockTool[] = Array.isArray(body.tools)
    ? body.tools.filter(isRecord).map((t) => ({
        type: 'function',
        function: {
          name: typeof t.name === 'string' ? t.name : 'tool',
          ...(typeof t.description === 'string' ? { description: t.description } : {}),
          ...(isRecord(t.input_schema) ? { parameters: t.input_schema } : {}),
        },
      }))
    : [];
  let toolChoice: unknown;
  if (isRecord(body.tool_choice)) {
    const tc = body.tool_choice;
    if (tc.type === 'tool' && typeof tc.name === 'string')
      toolChoice = { type: 'function', function: { name: tc.name } };
    else if (tc.type === 'none') toolChoice = 'none';
    else if (tc.type === 'any') toolChoice = 'required';
    else toolChoice = 'auto';
  }
  return {
    model: typeof body.model === 'string' ? body.model : '',
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(isRecord(body.metadata) ? { metadata: body.metadata } : {}),
  };
}
