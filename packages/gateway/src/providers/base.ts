import type { Logger } from '../observability/logger.js';
import type { ResolvedModel, ResolvedRoute } from '../config/resolve.js';
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  RerankRequest,
  RerankResponse,
} from '../core/types.js';

/**
 * Per-attempt context handed to adapters. `signal` aborts on client disconnect, per-attempt
 * timeout (reason: DeadlineExceededError) or route deadline.
 */
export interface AttemptContext {
  requestId: string;
  signal: AbortSignal;
  logger: Logger;
  /** Incoming client request headers (mock fault injection, tracing). */
  requestHeaders: Headers;
  route: ResolvedRoute;
  /** 1-based attempt number on this target. */
  attempt: number;
}

/** Result of an adapter health probe (`/readyz?probe=1`). */
export interface ProviderHealth {
  ok: boolean;
  latencyMs?: number;
  detail?: string;
}

/**
 * A provider adapter translates canonical (OpenAI-shaped) requests to one upstream API.
 * Adapters throw `ProviderError` for every upstream failure (see core/errors.ts) and must
 * honor `ctx.signal`.
 *
 * Streaming contract: `chatStream` yields OpenAI chunk objects. It should always try to deliver a
 * final usage chunk (`choices: []`, `usage: {...}`); the pipeline strips it if the client did not
 * request `stream_options.include_usage`.
 */
export interface ProviderAdapter {
  readonly type: string;
  readonly name: string;
  chat(req: ChatRequest, target: ResolvedModel, ctx: AttemptContext): Promise<ChatResponse>;
  chatStream(
    req: ChatRequest,
    target: ResolvedModel,
    ctx: AttemptContext,
  ): AsyncIterable<ChatChunk>;
  embed?(
    req: EmbeddingRequest,
    target: ResolvedModel,
    ctx: AttemptContext,
  ): Promise<EmbeddingResponse>;
  rerank?(req: RerankRequest, target: ResolvedModel, ctx: AttemptContext): Promise<RerankResponse>;
  health?(signal?: AbortSignal): Promise<ProviderHealth>;
  /** Release long-lived resources (event subscriptions, sockets). */
  close?(): Promise<void>;
}

/** Dependencies injected into every adapter constructor: `new XAdapter(name, config, deps)`. */
export interface AdapterDeps {
  logger: Logger;
  /** Override for tests (defaults to global fetch). */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

/** Strips trailing slashes so paths can be appended safely. */
export const joinUrl = (base: string, path: string): string =>
  `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
