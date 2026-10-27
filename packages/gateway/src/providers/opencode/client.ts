import { ProviderError, parseRetryAfter, providerErrorFromStatus } from '../../core/errors.js';
import type { OpencodeProviderConfig } from '../../config/schema.js';
import { joinUrl } from '../base.js';
import { injectTraceHeaders } from '../../observability/tracing.js';
import { extractUpstreamMessage, mapFetchError, type FetchLike } from '../http.js';
import type { OpencodePart } from './transcript.js';

/** Minimal typed client for the subset of the opencode server API the adapter uses. */

export interface OpencodeTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export interface OpencodeErrorInfo {
  name: string;
  data?: {
    message?: string;
    statusCode?: number;
    isRetryable?: boolean;
    responseHeaders?: Record<string, string>;
    providerID?: string;
  };
}

export interface OpencodeMessageInfo {
  id: string;
  sessionID: string;
  role: 'assistant' | 'user';
  tokens?: OpencodeTokens;
  error?: OpencodeErrorInfo;
  finish?: string;
  modelID?: string;
  providerID?: string;
}

export interface OpencodeResultPart {
  id?: string;
  type: string;
  text?: string;
}

export interface OpencodeMessageResult {
  info: OpencodeMessageInfo;
  parts: OpencodeResultPart[];
}

export interface PromptBody {
  agent: string;
  model: { providerID: string; modelID: string };
  system?: string;
  variant?: string;
  /** Per-message tool switches (opencode merges them into the agent's permissions). */
  tools?: Record<string, boolean>;
  parts: OpencodePart[];
}

/**
 * Defense in depth: every prompt disables opencode's tools, so a missing or misconfigured
 * `gateway` agent can never let request content (which API clients control, including
 * prompt-injected documents) run shell commands, edit files or fetch URLs on the opencode host.
 * The gateway emulates tool calling itself; opencode only ever needs to generate text.
 */
export const OPENCODE_DISABLED_TOOLS: Readonly<Record<string, boolean>> = Object.freeze({
  '*': false,
  bash: false,
  read: false,
  list: false,
  glob: false,
  grep: false,
  edit: false,
  write: false,
  patch: false,
  apply_patch: false,
  multiedit: false,
  task: false,
  webfetch: false,
  websearch: false,
  codesearch: false,
  todowrite: false,
  todoread: false,
  skill: false,
  lsp: false,
  batch: false,
  question: false,
});

export class OpencodeClient {
  readonly authHeader: string | undefined;

  constructor(
    private readonly provider: string,
    private readonly config: OpencodeProviderConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.authHeader = config.password
      ? `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`
      : undefined;
  }

  get headers(): Record<string, string> {
    return {
      ...this.config.headers,
      ...(this.authHeader ? { authorization: this.authHeader } : {}),
    };
  }

  url(path: string): string {
    return joinUrl(this.config.base_url, path);
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        method,
        // Per-attempt calls carry the attempt span's traceparent (the shared /event subscription
        // does not: it outlives any one request).
        headers: injectTraceHeaders({
          ...this.headers,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        }),
        body: body === undefined ? null : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw mapFetchError(this.provider, err, signal);
    }
    const text = await res.text().catch((err: unknown) => {
      throw mapFetchError(this.provider, err, signal);
    });
    if (!res.ok) {
      const message = `${this.provider}: opencode ${method} ${path.split('?')[0]} → ${res.status}: ${extractUpstreamMessage(text)}`;
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError({
          status: 502,
          code: 'upstream_auth',
          message,
          provider: this.provider,
          fallback: true,
        });
      }
      throw providerErrorFromStatus(
        this.provider,
        res.status,
        message,
        parseRetryAfter(res.headers.get('retry-after')),
      );
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new ProviderError({
        status: 502,
        code: 'upstream_error',
        message: `${this.provider}: opencode returned invalid JSON`,
        provider: this.provider,
        retryable: true,
        cause: err,
      });
    }
  }

  async createSession(title: string, signal: AbortSignal): Promise<string> {
    const s = await this.request<{ id?: string }>(
      'POST',
      '/session',
      { title, agent: this.config.agent },
      signal,
    );
    if (!s?.id) {
      throw new ProviderError({
        status: 502,
        code: 'upstream_error',
        message: `${this.provider}: session creation returned no id`,
        provider: this.provider,
        retryable: true,
      });
    }
    return s.id;
  }

  /** Sends a message and waits for the complete assistant reply. */
  prompt(sessionId: string, body: PromptBody, signal: AbortSignal): Promise<OpencodeMessageResult> {
    return this.request<OpencodeMessageResult>(
      'POST',
      `/session/${encodeURIComponent(sessionId)}/message`,
      body,
      signal,
    );
  }

  async abort(sessionId: string, signal: AbortSignal): Promise<void> {
    await this.request<unknown>(
      'POST',
      `/session/${encodeURIComponent(sessionId)}/abort`,
      undefined,
      signal,
    );
  }

  async deleteSession(sessionId: string, signal: AbortSignal): Promise<void> {
    await this.request<unknown>(
      'DELETE',
      `/session/${encodeURIComponent(sessionId)}`,
      undefined,
      signal,
    );
  }

  async health(signal: AbortSignal): Promise<{ healthy: boolean; version?: string }> {
    return this.request<{ healthy: boolean; version?: string }>(
      'GET',
      '/global/health',
      undefined,
      signal,
    );
  }
}

/** Maps an opencode assistant-message error into a classified ProviderError. */
export function mapOpencodeError(provider: string, error: OpencodeErrorInfo): ProviderError {
  const message = `${provider}: ${error.name}: ${error.data?.message ?? 'unknown error'}`;
  switch (error.name) {
    case 'ProviderAuthError':
      return new ProviderError({
        status: 502,
        code: 'upstream_auth',
        message,
        provider,
        fallback: true,
      });
    case 'ContextOverflowError':
      return new ProviderError({ status: 400, code: 'invalid_request', message, provider });
    case 'MessageAbortedError':
      return new ProviderError({
        status: 504,
        code: 'upstream_timeout',
        message,
        provider,
        retryable: true,
      });
    case 'APIError': {
      const status = error.data?.statusCode;
      const headers = error.data?.responseHeaders ?? {};
      const retryAfter = parseRetryAfter(headers['retry-after'] ?? headers['Retry-After']);
      if (status === 401 || status === 403) {
        return new ProviderError({
          status: 502,
          code: 'upstream_auth',
          message,
          provider,
          fallback: true,
        });
      }
      if (status !== undefined)
        return providerErrorFromStatus(provider, status, message, retryAfter);
      return new ProviderError({
        status: 502,
        code: 'upstream_error',
        message,
        provider,
        retryable: error.data?.isRetryable ?? true,
      });
    }
    default:
      return new ProviderError({
        status: 502,
        code: 'upstream_error',
        message,
        provider,
        retryable: true,
      });
  }
}
