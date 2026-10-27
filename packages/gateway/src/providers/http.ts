import { ProviderError, parseRetryAfter, providerErrorFromStatus } from '../core/errors.js';
import { injectTraceHeaders } from '../observability/tracing.js';
import { ClientAbortError, DeadlineExceededError } from '../util/abort.js';
import { parseSSE, type SSEEvent } from '../util/sse.js';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface UpstreamRequest {
  provider: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal: AbortSignal;
  fetch?: FetchLike;
}

/** Converts fetch/abort failures into classified ProviderErrors. */
export function mapFetchError(provider: string, err: unknown, signal: AbortSignal): ProviderError {
  if (err instanceof ProviderError) return err;
  if (signal.aborted) {
    const reason: unknown = signal.reason;
    if (reason instanceof DeadlineExceededError) {
      return new ProviderError({
        status: 504,
        code: 'upstream_timeout',
        message: `${provider}: ${reason.message}`,
        provider,
        retryable: true,
        cause: err,
      });
    }
    const message = reason instanceof ClientAbortError ? reason.message : 'request aborted';
    return new ProviderError({
      status: 499,
      code: 'aborted',
      message,
      provider,
      countsAsFailure: false,
      cause: err,
    });
  }
  const message = err instanceof Error ? `${err.message}${causeSuffix(err)}` : String(err);
  return new ProviderError({
    status: 502,
    code: 'network_error',
    message: `${provider}: network error: ${message}`,
    provider,
    retryable: true,
    cause: err,
  });
}

const causeSuffix = (err: Error): string => {
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  if (!cause) return '';
  return ` (${cause.code ?? cause.message ?? 'unknown cause'})`;
};

/** Extracts a human readable message from common upstream error bodies. */
export function extractUpstreamMessage(text: string): string {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const err = json.error;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
      const m = (err as Record<string, unknown>).message;
      if (typeof m === 'string') return m;
    }
    if (typeof json.message === 'string') return json.message;
    if (typeof json.detail === 'string') return json.detail;
  } catch {
    // not JSON
  }
  return text.length > 500 ? `${text.slice(0, 500)}…` : text || '(empty body)';
}

/**
 * Performs a request and throws a classified ProviderError for non-2xx responses. The active trace
 * context (the attempt span) is injected as `traceparent`/`tracestate`/`baggage`.
 */
export async function upstreamFetch(req: UpstreamRequest): Promise<Response> {
  const f = req.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(req.url, {
      method: req.method ?? (req.body === undefined ? 'GET' : 'POST'),
      headers: injectTraceHeaders({
        ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...req.headers,
      }),
      body: req.body === undefined ? null : JSON.stringify(req.body),
      signal: req.signal,
    });
  } catch (err) {
    throw mapFetchError(req.provider, err, req.signal);
  }
  if (!res.ok) {
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw mapFetchError(req.provider, err, req.signal);
    }
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    throw providerErrorFromStatus(
      req.provider,
      res.status,
      `${req.provider}: upstream ${res.status}: ${extractUpstreamMessage(text)}`,
      retryAfter,
    );
  }
  return res;
}

export async function upstreamJson<T>(req: UpstreamRequest): Promise<T> {
  const res = await upstreamFetch(req);
  try {
    return (await res.json()) as T;
  } catch (err) {
    if (req.signal.aborted) throw mapFetchError(req.provider, err, req.signal);
    throw new ProviderError({
      status: 502,
      code: 'upstream_error',
      message: `${req.provider}: upstream returned invalid JSON`,
      provider: req.provider,
      retryable: true,
      cause: err,
    });
  }
}

/** Opens an SSE stream; yields parsed events. Read errors are mapped to ProviderErrors. */
export async function* upstreamSSE(req: UpstreamRequest): AsyncGenerator<SSEEvent> {
  const res = await upstreamFetch({
    ...req,
    headers: { accept: 'text/event-stream', ...req.headers },
  });
  if (!res.body) {
    throw new ProviderError({
      status: 502,
      code: 'upstream_error',
      message: `${req.provider}: empty stream body`,
      provider: req.provider,
      retryable: true,
    });
  }
  try {
    for await (const ev of parseSSE(res.body, req.signal)) yield ev;
    if (req.signal.aborted) throw mapFetchError(req.provider, req.signal.reason, req.signal);
  } catch (err) {
    throw mapFetchError(req.provider, err, req.signal);
  } finally {
    // Ensure the socket is released if the consumer stops early.
    res.body.cancel().catch(() => undefined);
  }
}
