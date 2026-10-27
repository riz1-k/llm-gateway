/**
 * Error model.
 *
 * - `GatewayError` is what the HTTP layer renders (OpenAI error envelope).
 * - `ProviderError` is what provider adapters throw; the router classifies it (retry same target,
 *   fall back to the next target, or fail the request) and finally converts it to a GatewayError.
 */

export type GatewayErrorCode =
  | 'invalid_api_key'
  | 'model_not_allowed'
  | 'model_not_found'
  | 'invalid_request'
  | 'unsupported_content'
  | 'budget_exceeded'
  | 'rate_limit_exceeded'
  | 'upstream_unavailable'
  | 'upstream_timeout'
  | 'upstream_error'
  | 'upstream_invalid_output'
  | 'request_aborted'
  | 'internal_error'
  | 'not_found'
  | 'conflict'
  | 'service_unavailable';

export type OpenAIErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'insufficient_quota'
  | 'rate_limit_error'
  | 'api_error'
  | 'upstream_error';

const DEFAULT_TYPE: Record<number, OpenAIErrorType> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  402: 'insufficient_quota',
  403: 'permission_error',
  404: 'invalid_request_error',
  409: 'invalid_request_error',
  413: 'invalid_request_error',
  422: 'invalid_request_error',
  429: 'rate_limit_error',
};

export interface ErrorEnvelope {
  error: { message: string; type: string; code: string; param: string | null };
}

export class GatewayError extends Error {
  readonly status: number;
  readonly code: GatewayErrorCode;
  readonly type: OpenAIErrorType;
  readonly param: string | null;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    code: GatewayErrorCode,
    message: string,
    opts: {
      type?: OpenAIErrorType;
      param?: string | null;
      headers?: Record<string, string>;
      cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    this.type =
      opts.type ?? DEFAULT_TYPE[status] ?? (status >= 500 ? 'api_error' : 'invalid_request_error');
    this.param = opts.param ?? null;
    this.headers = opts.headers ?? {};
  }

  toJSON(): ErrorEnvelope {
    return {
      error: { message: this.message, type: this.type, code: this.code, param: this.param },
    };
  }

  static invalidRequest(message: string, param?: string): GatewayError {
    return new GatewayError(400, 'invalid_request', message, { param: param ?? null });
  }
}

/**
 * Provider error classification.
 *
 * - `retryable`: transient; the same target may be retried (429, 5xx, timeouts, network, busy).
 * - `fallback`: the next target may be tried (true for every retryable error, plus misconfigured or
 *   unauthorized upstreams and invalid model output).
 * - neither: the request itself is bad (upstream 400/422) and the error is returned to the client.
 */
export type ProviderErrorCode =
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'upstream_timeout'
  | 'upstream_busy'
  | 'network_error'
  | 'upstream_error'
  | 'upstream_auth'
  | 'upstream_not_found'
  | 'invalid_request'
  | 'unsupported_content'
  | 'upstream_invalid_output'
  | 'circuit_open'
  | 'aborted';

export interface ProviderErrorInit {
  status: number;
  code: ProviderErrorCode;
  message: string;
  provider: string;
  retryable?: boolean;
  fallback?: boolean;
  retryAfterMs?: number;
  /** Upstream failure that should count against the circuit breaker. Defaults to `fallback`. */
  countsAsFailure?: boolean;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly status: number;
  readonly code: ProviderErrorCode;
  readonly provider: string;
  readonly retryable: boolean;
  readonly fallback: boolean;
  readonly countsAsFailure: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(init: ProviderErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ProviderError';
    this.status = init.status;
    this.code = init.code;
    this.provider = init.provider;
    this.retryable = init.retryable ?? false;
    this.fallback = init.fallback ?? this.retryable;
    this.countsAsFailure = init.countsAsFailure ?? this.fallback;
    this.retryAfterMs = init.retryAfterMs;
  }
}

/** Maps an upstream HTTP status to a classified ProviderError. */
export function providerErrorFromStatus(
  provider: string,
  status: number,
  message: string,
  retryAfterMs?: number,
): ProviderError {
  if (status === 429) {
    return new ProviderError({
      status,
      code: 'rate_limited',
      message,
      provider,
      retryable: true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (status === 408 || status === 504) {
    return new ProviderError({
      status,
      code: 'upstream_timeout',
      message,
      provider,
      retryable: true,
    });
  }
  if (status >= 500) {
    return new ProviderError({
      status,
      code: status === 503 ? 'upstream_unavailable' : 'upstream_error',
      message,
      provider,
      retryable: true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (status === 401 || status === 403) {
    return new ProviderError({ status, code: 'upstream_auth', message, provider, fallback: true });
  }
  if (status === 404) {
    return new ProviderError({
      status,
      code: 'upstream_not_found',
      message,
      provider,
      fallback: true,
    });
  }
  return new ProviderError({ status, code: 'invalid_request', message, provider });
}

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Converts the final dispatch failure into the client-facing error. */
export function toGatewayError(err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;
  if (err instanceof ProviderError) {
    const headers: Record<string, string> = {};
    if (err.retryAfterMs !== undefined)
      headers['retry-after'] = String(Math.ceil(err.retryAfterMs / 1000));
    switch (err.code) {
      case 'invalid_request':
        return new GatewayError(err.status === 422 ? 422 : 400, 'invalid_request', err.message, {
          cause: err,
        });
      case 'unsupported_content':
        return new GatewayError(400, 'unsupported_content', err.message, { cause: err });
      case 'upstream_timeout':
        return new GatewayError(504, 'upstream_timeout', err.message, {
          cause: err,
          type: 'upstream_error',
        });
      case 'rate_limited':
      case 'upstream_unavailable':
      case 'upstream_busy':
      case 'circuit_open':
        return new GatewayError(503, 'upstream_unavailable', err.message, {
          cause: err,
          headers,
          type: 'upstream_error',
        });
      case 'upstream_invalid_output':
        return new GatewayError(502, 'upstream_invalid_output', err.message, {
          cause: err,
          type: 'upstream_error',
        });
      case 'aborted':
        return new GatewayError(499, 'request_aborted', err.message, { cause: err });
      case 'upstream_auth':
        // Upstream auth errors can echo (masked) provider credentials; keep them in the logs.
        return new GatewayError(
          502,
          'upstream_error',
          `${err.provider}: upstream rejected the gateway's credentials`,
          { cause: err, type: 'upstream_error' },
        );
      default:
        return new GatewayError(502, 'upstream_error', err.message, {
          cause: err,
          type: 'upstream_error',
        });
    }
  }
  // Unexpected errors (e.g. a Redis/Postgres failure) may name internal hosts: the message stays in
  // the logs (`cause`), clients get a generic one.
  return new GatewayError(500, 'internal_error', 'Internal server error', {
    cause: err,
    type: 'api_error',
  });
}
