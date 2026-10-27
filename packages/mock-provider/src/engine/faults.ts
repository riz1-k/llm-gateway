import type { HeaderLike, MockFault } from './types.js';

/**
 * Fault injection. Faults come from configuration and (optionally) request headers:
 *
 * | header                     | effect                                                     |
 * |----------------------------|------------------------------------------------------------|
 * | `x-mock-latency-ms`        | added latency before responding                            |
 * | `x-mock-fail-rate`         | probability (0..1) of failing                              |
 * | `x-mock-status`            | failure status (always fails if no fail rate is given)     |
 * | `x-mock-retry-after`       | `retry-after` seconds on injected failures                 |
 * | `x-mock-stream-fail-after` | abort a stream after N content chunks                      |
 * | `x-mock-fault-target`      | comma list; header faults only apply to these model names  |
 */

export const NO_FAULT: MockFault = {
  latencyMs: 0,
  failRate: 0,
  status: undefined,
  retryAfterS: undefined,
  streamFailAfter: undefined,
};

/** Later layers override earlier ones field by field (undefined fields are ignored). */
export function mergeFaults(...layers: readonly (Partial<MockFault> | undefined)[]): MockFault {
  const out: MockFault = { ...NO_FAULT };
  for (const layer of layers) {
    if (!layer) continue;
    for (const key of Object.keys(layer) as (keyof MockFault)[]) {
      const value = layer[key];
      if (value !== undefined) (out as unknown as Record<string, number | undefined>)[key] = value;
    }
  }
  return out;
}

function num(headers: HeaderLike, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw == null || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Reads `x-mock-*` headers. When `x-mock-fault-target` is present the faults only apply if one of
 * `targetNames` (gateway model name, upstream model id, …) is listed.
 */
export function faultsFromHeaders(
  headers: HeaderLike,
  targetNames: readonly string[] = [],
): Partial<MockFault> {
  const scope = headers.get('x-mock-fault-target');
  if (scope != null && scope.trim() !== '') {
    const allowed = new Set(
      scope
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (!targetNames.some((t) => allowed.has(t))) return {};
  }
  const status = num(headers, 'x-mock-status');
  const failRate = num(headers, 'x-mock-fail-rate');
  return {
    latencyMs: num(headers, 'x-mock-latency-ms'),
    failRate: failRate === undefined ? undefined : Math.min(1, failRate),
    status: status !== undefined && status >= 400 && status <= 599 ? Math.trunc(status) : undefined,
    retryAfterS: num(headers, 'x-mock-retry-after'),
    streamFailAfter: num(headers, 'x-mock-stream-fail-after'),
  };
}

/**
 * Decides whether this request fails. A status without a fail rate always fails; a fail rate
 * without a status fails with 503.
 */
export function decideFailure(
  fault: MockFault,
  random: () => number = Math.random,
): number | undefined {
  if (fault.failRate > 0) return random() < fault.failRate ? (fault.status ?? 503) : undefined;
  return fault.status;
}

/** Seedable PRNG (mulberry32) for reproducible fail-rate tests. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
