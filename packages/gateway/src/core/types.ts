/**
 * Canonical request/response types. The OpenAI Chat Completions schema is the canonical shape;
 * every provider adapter translates to and from it.
 */

// ---------------------------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------------------------

export interface TextContentPart {
  type: 'text';
  text: string;
}

/** Image input (URL or data URL). */
export interface ImageContentPart {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}

/**
 * Other part types (input_audio, file, …) are carried through untouched for OpenAI-family
 * upstreams.
 */
export interface OtherContentPart {
  type: string;
  [key: string]: unknown;
}

/** A part of multi-part message content. */
export type ContentPart = TextContentPart | ImageContentPart | OtherContentPart;
/** Message content: plain text, parts, or `null` (assistant turns with tool calls). */
export type MessageContent = string | ContentPart[] | null;

/** A function call requested by the model. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** A system or developer instruction. */
export interface SystemMessage {
  role: 'system' | 'developer';
  content: string | ContentPart[];
  name?: string;
}

/** A user turn. */
export interface UserMessage {
  role: 'user';
  content: string | ContentPart[];
  name?: string;
}

/** An assistant turn, optionally with tool calls. */
export interface AssistantMessage {
  role: 'assistant';
  content?: MessageContent;
  name?: string;
  tool_calls?: ToolCall[];
  /** Non-standard but widely used (DeepSeek, vLLM, llama.cpp): reasoning text. */
  reasoning_content?: string | null;
  refusal?: string | null;
}

/** The result of a tool call, sent back by the client. */
export interface ToolMessage {
  role: 'tool';
  content: string | ContentPart[];
  tool_call_id: string;
  name?: string;
}

/** Any message of a chat request. */
export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/** A callable function exposed to the model. */
export interface FunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean | null;
}

/** A tool offered to the model. */
export interface ToolDefinition {
  type: 'function';
  function: FunctionDefinition;
}

/** Controls whether and which tool the model must call. */
export type ToolChoice =
  'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };

/** Schema for structured output (`response_format: json_schema`). */
export interface JsonSchemaSpec {
  name: string;
  description?: string;
  schema?: Record<string, unknown>;
  strict?: boolean | null;
}

/** Requested output format (JSON mode / structured output). */
export type ResponseFormat =
  { type: 'text' } | { type: 'json_object' } | { type: 'json_schema'; json_schema: JsonSchemaSpec };

/** Reasoning effort hint; mapped per provider (`thinking`, opencode variants, …) or dropped. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'none';

/**
 * OpenAI-compatible `/v1/chat/completions` request body (`model` is a Switchyard route name).
 * Unknown fields pass through to OpenAI-family upstreams.
 */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean | null;
  stream_options?: { include_usage?: boolean } | null;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  parallel_tool_calls?: boolean;
  response_format?: ResponseFormat;
  max_tokens?: number | null;
  max_completion_tokens?: number | null;
  temperature?: number | null;
  top_p?: number | null;
  stop?: string | string[] | null;
  seed?: number | null;
  n?: number | null;
  presence_penalty?: number | null;
  frequency_penalty?: number | null;
  reasoning_effort?: ReasoningEffort | null;
  user?: string;
  metadata?: Record<string, unknown>;
  /** Unknown fields are passed through to OpenAI-family upstreams. */
  [extra: string]: unknown;
}

/** Why generation stopped. */
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call';

/** Token usage (OpenAI shape) plus the Switchyard cost extension fields. */
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  /**
   * Switchyard extension (OpenRouter convention): USD charged for this request, priced from the
   * gateway's pricing table. Same value as the `x-sy-cost-usd` header; `0` for cache hits. Set on
   * chat completion responses and on the final streamed usage chunk
   * (`stream_options.include_usage`), where headers cannot carry it.
   */
  cost?: number;
  /** Switchyard extension: cache outcome, same value as the `x-sy-cache` header. */
  sy_cache?: 'hit' | 'miss' | 'bypass' | 'semantic-hit';
  /** Switchyard extension: USD saved by a cache hit (same as `x-sy-saved-usd`); hits only. */
  sy_saved_cost?: number;
}

/** One choice of a non-streamed chat completion. */
export interface ChatChoice {
  index: number;
  message: AssistantMessage & { content: string | null };
  finish_reason: FinishReason | null;
  logprobs?: unknown;
}

/**
 * OpenAI-compatible chat completion (`model` is the route name; the upstream model is in
 * `x-sy-model`).
 */
export interface ChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: Usage;
  system_fingerprint?: string | null;
}

/** Incremental tool-call data in a streamed chunk (arguments arrive in pieces). */
export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

/** Incremental message content carried by a streamed chunk. */
export interface ChatChunkDelta {
  role?: 'assistant';
  content?: string | null;
  tool_calls?: ToolCallDelta[];
  reasoning_content?: string | null;
  refusal?: string | null;
}

/** One choice of a streamed chunk. */
export interface ChatChunkChoice {
  index: number;
  delta: ChatChunkDelta;
  finish_reason: FinishReason | null;
  logprobs?: unknown;
}

/** One server-sent event of a streamed chat completion (`chat.completion.chunk`). */
export interface ChatChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatChunkChoice[];
  usage?: Usage | null;
  system_fingerprint?: string | null;
}

// ---------------------------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------------------------

/** Switchyard extension: selects the model's `input_templates` entry (query vs document). */
export type EmbeddingInputType = 'query' | 'document';

/**
 * OpenAI-compatible `/v1/embeddings` request body, plus the `input_type` / `input_titles`
 * extensions.
 */
export interface EmbeddingRequest {
  model: string;
  input: string | string[] | number[] | number[][];
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
  user?: string;
  /** Switchyard extension: selects the per-model input template. */
  input_type?: EmbeddingInputType;
  [extra: string]: unknown;
}

/** One embedding vector of an embeddings response. */
export interface EmbeddingData {
  object: 'embedding';
  index: number;
  embedding: number[] | string;
}

/** OpenAI-compatible embeddings response. */
export interface EmbeddingResponse {
  object: 'list';
  data: EmbeddingData[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

// ---------------------------------------------------------------------------------------------
// Rerank (Cohere / Jina shape)
// ---------------------------------------------------------------------------------------------

/** Cohere/Jina-shaped `/v1/rerank` request body. */
export interface RerankRequest {
  model: string;
  query: string;
  documents: string[];
  top_n?: number;
  return_documents?: boolean;
}

/** One scored document of a rerank response. */
export interface RerankResult {
  index: number;
  relevance_score: number;
  document?: { text: string };
}

/** Cohere/Jina-shaped rerank response, sorted by relevance. */
export interface RerankResponse {
  id: string;
  model: string;
  results: RerankResult[];
  usage: { total_tokens: number };
}

// ---------------------------------------------------------------------------------------------
// Models list
// ---------------------------------------------------------------------------------------------

/** One entry of `GET /v1/models` (a route visible to the caller). */
export interface ModelCard {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  /** Switchyard extension fields. */
  kind?: 'chat' | 'embedding' | 'rerank';
  description?: string;
}

/** What a route or model serves. */
export type OperationKind = 'chat' | 'embedding' | 'rerank';
