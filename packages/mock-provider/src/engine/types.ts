/**
 * Minimal, self-contained OpenAI-ish types used by the mock engine. They are intentionally loose
 * (structural) so that both the gateway's canonical types and raw JSON bodies are accepted.
 */

/** Any content part; only `{ type: 'text', text }` parts contribute text. */
export interface MockContentPart {
  type: string;
}

export interface MockMessageToolCall {
  id?: string;
  function: { name: string; arguments: string };
}

export interface MockMessage {
  role: string;
  content?: string | readonly MockContentPart[] | null;
  name?: string;
  tool_calls?: readonly MockMessageToolCall[];
  tool_call_id?: string;
}

export interface MockTool {
  type?: string;
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface MockChatRequest {
  model: string;
  messages: readonly MockMessage[];
  tools?: readonly MockTool[];
  tool_choice?: unknown;
  metadata?: Record<string, unknown>;
}

export type MockMode = 'echo' | 'fixed' | 'extractive' | 'tools';

export interface MockEngineOptions {
  /** Text returned by `mock-fixed`. */
  fixedText?: string;
  /** Minimum lexical overlap for `mock-extractive` to answer (default 0.2). */
  extractiveThreshold?: number;
  /** Scripted `mock-tools` conversations keyed by script id (`metadata.mock_script_id`). */
  scripts?: Record<string, readonly unknown[]>;
}

export interface MockToolCallResult {
  name: string;
  arguments: Record<string, unknown>;
}

export interface MockChatResult {
  mode: MockMode;
  content: string | null;
  toolCalls: MockToolCallResult[];
  finishReason: 'stop' | 'tool_calls';
}

export interface MockRerankResult {
  index: number;
  relevance_score: number;
}

/** Normalized fault description (camelCase). */
export interface MockFault {
  latencyMs: number;
  failRate: number;
  status: number | undefined;
  retryAfterS: number | undefined;
  streamFailAfter: number | undefined;
}

/** Anything with a `get(name)` method (WHATWG Headers, Hono request headers adapter). */
export interface HeaderLike {
  get(name: string): string | null | undefined;
}
