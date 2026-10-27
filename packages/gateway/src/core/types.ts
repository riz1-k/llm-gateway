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

export interface ImageContentPart {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}

/** Other part types (input_audio, file, …) are carried through untouched for OpenAI-family upstreams. */
export interface OtherContentPart {
  type: string;
  [key: string]: unknown;
}

export type ContentPart = TextContentPart | ImageContentPart | OtherContentPart;
export type MessageContent = string | ContentPart[] | null;

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface SystemMessage {
  role: 'system' | 'developer';
  content: string | ContentPart[];
  name?: string;
}

export interface UserMessage {
  role: 'user';
  content: string | ContentPart[];
  name?: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content?: MessageContent;
  name?: string;
  tool_calls?: ToolCall[];
  /** Non-standard but widely used (DeepSeek, vLLM, llama.cpp): reasoning text. */
  reasoning_content?: string | null;
  refusal?: string | null;
}

export interface ToolMessage {
  role: 'tool';
  content: string | ContentPart[];
  tool_call_id: string;
  name?: string;
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface FunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean | null;
}

export interface ToolDefinition {
  type: 'function';
  function: FunctionDefinition;
}

export type ToolChoice =
  'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };

export interface JsonSchemaSpec {
  name: string;
  description?: string;
  schema?: Record<string, unknown>;
  strict?: boolean | null;
}

export type ResponseFormat =
  { type: 'text' } | { type: 'json_object' } | { type: 'json_schema'; json_schema: JsonSchemaSpec };

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'none';

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

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call';

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface ChatChoice {
  index: number;
  message: AssistantMessage & { content: string | null };
  finish_reason: FinishReason | null;
  logprobs?: unknown;
}

export interface ChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: Usage;
  system_fingerprint?: string | null;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface ChatChunkDelta {
  role?: 'assistant';
  content?: string | null;
  tool_calls?: ToolCallDelta[];
  reasoning_content?: string | null;
  refusal?: string | null;
}

export interface ChatChunkChoice {
  index: number;
  delta: ChatChunkDelta;
  finish_reason: FinishReason | null;
  logprobs?: unknown;
}

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

export type EmbeddingInputType = 'query' | 'document';

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

export interface EmbeddingData {
  object: 'embedding';
  index: number;
  embedding: number[] | string;
}

export interface EmbeddingResponse {
  object: 'list';
  data: EmbeddingData[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

// ---------------------------------------------------------------------------------------------
// Rerank (Cohere / Jina shape)
// ---------------------------------------------------------------------------------------------

export interface RerankRequest {
  model: string;
  query: string;
  documents: string[];
  top_n?: number;
  return_documents?: boolean;
}

export interface RerankResult {
  index: number;
  relevance_score: number;
  document?: { text: string };
}

export interface RerankResponse {
  id: string;
  model: string;
  results: RerankResult[];
  usage: { total_tokens: number };
}

// ---------------------------------------------------------------------------------------------
// Models list
// ---------------------------------------------------------------------------------------------

export interface ModelCard {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  /** Switchyard extension fields. */
  kind?: 'chat' | 'embedding' | 'rerank';
  description?: string;
}

export type OperationKind = 'chat' | 'embedding' | 'rerank';
