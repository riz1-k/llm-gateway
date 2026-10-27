import { describe, expect, it } from 'vitest';
import type { BreakerConfig, RetryConfig } from '../../src/config/schema.js';
import { ProviderError } from '../../src/core/errors.js';
import {
  decide,
  initialBreakerState,
  MemoryBreakerStore,
  record,
  type BreakerState,
} from '../../src/resilience/circuit-breaker.js';
import { Semaphore } from '../../src/resilience/concurrency.js';
import { computeBackoff, fitsDeadline } from '../../src/resilience/retry.js';

const cfg: BreakerConfig = {
  enabled: true,
  window_s: 30,
  min_requests: 10,
  failure_rate: 0.5,
  consecutive_failures: 5,
  cooldown_s: 30,
  max_cooldown_s: 300,
};

const fail = (s: BreakerState, now: number, n = 1): BreakerState => {
  let st = s;
  for (let i = 0; i < n; i++) st = record(st, 'failure', now, cfg);
  return st;
};

describe('circuit breaker state machine', () => {
  it('opens after N consecutive failures', () => {
    const s = fail(initialBreakerState(), 1000, 4);
    expect(s.state).toBe('closed');
    const opened = fail(s, 1000);
    expect(opened.state).toBe('open');
    expect(opened.openUntil).toBe(1000 + 30_000);
  });

  it('opens on failure rate over the rolling window with enough samples', () => {
    let s = initialBreakerState();
    // alternate ok/fail: never 5 consecutive failures, 50 % failure rate
    for (let i = 0; i < 10; i++) s = record(s, i % 2 === 0 ? 'success' : 'failure', 1000 + i, cfg);
    expect(s.state).toBe('open');
  });

  it('ignores failures that fell out of the window', () => {
    let s = initialBreakerState();
    for (let i = 0; i < 9; i++) s = record(s, i % 2 === 0 ? 'failure' : 'success', 0, cfg);
    // 31 s later the old samples are pruned; a couple more results do not trip the rate rule
    s = record(s, 'failure', 31_000, cfg);
    expect(s.state).toBe('closed');
  });

  it('success resets the consecutive failure streak', () => {
    let s = fail(initialBreakerState(), 0, 4);
    s = record(s, 'success', 0, cfg);
    s = fail(s, 0, 4);
    expect(s.state).toBe('closed');
  });

  it('denies while open, then admits exactly one half-open probe', () => {
    const open = fail(initialBreakerState(), 0, 5);
    expect(decide(open, 10_000, cfg).decision).toMatchObject({
      allowed: false,
      state: 'open',
      retryAt: 30_000,
    });
    const { decision, next } = decide(open, 30_000, cfg);
    expect(decision).toMatchObject({ allowed: true, state: 'half_open', probe: true });
    expect(decide(next, 30_001, cfg).decision.allowed).toBe(false);
  });

  it('half-open probe success closes; failure re-opens with doubled cooldown', () => {
    const open = fail(initialBreakerState(), 0, 5);
    const half = decide(open, 30_000, cfg).next;
    expect(record(half, 'success', 30_100, cfg, true).state).toBe('closed');
    const reopened = record(half, 'failure', 30_100, cfg, true);
    expect(reopened.state).toBe('open');
    expect(reopened.openUntil).toBe(30_100 + 60_000);
    expect(reopened.trips).toBe(2);
  });

  it('caps the exponential cooldown', () => {
    let s = fail(initialBreakerState(), 0, 5);
    let now = 0;
    for (let i = 0; i < 6; i++) {
      now = s.openUntil!;
      s = record(decide(s, now, cfg).next, 'failure', now, cfg, true);
    }
    expect(s.openUntil! - now).toBe(300_000);
  });

  it('neutral outcome releases the probe without a transition', () => {
    const half = decide(fail(initialBreakerState(), 0, 5), 30_000, cfg).next;
    const released = record(half, 'neutral', 30_001, cfg, true);
    expect(released.state).toBe('half_open');
    expect(decide(released, 30_002, cfg).decision).toMatchObject({ allowed: true, probe: true });
  });

  it('a stale probe is replaced after one cooldown', () => {
    const half = decide(fail(initialBreakerState(), 0, 5), 30_000, cfg).next;
    expect(decide(half, 30_000 + 30_001, cfg).decision.allowed).toBe(true);
  });

  it('disabled breaker always allows', () => {
    const off = { ...cfg, enabled: false };
    const s = fail(initialBreakerState(), 0, 50);
    expect(decide(s, 0, off).decision.allowed).toBe(true);
  });

  it('MemoryBreakerStore applies the machine per target', async () => {
    let now = 0;
    const store = new MemoryBreakerStore(() => now);
    for (let i = 0; i < 5; i++) await store.record('a', 'failure', cfg);
    expect((await store.acquire('a', cfg)).allowed).toBe(false);
    expect((await store.acquire('b', cfg)).allowed).toBe(true);
    now = 30_000;
    const probe = await store.acquire('a', cfg);
    expect(probe.probe).toBe(true);
    expect(await store.record('a', 'success', cfg, true)).toBe('closed');
    const snap = await store.snapshot(cfg);
    expect(snap.find((s) => s.target === 'a')?.state).toBe('closed');
  });
});

describe('retry backoff', () => {
  const retry: RetryConfig = {
    attempts: 3,
    backoff_ms: 100,
    max_backoff_ms: 1000,
    max_retry_after_ms: 5000,
  };

  it('uses full jitter within the exponential ceiling', () => {
    expect(computeBackoff(0, retry, undefined, () => 0.999)).toBe(99);
    expect(computeBackoff(2, retry, undefined, () => 0.5)).toBe(200);
    expect(computeBackoff(10, retry, undefined, () => 0.999)).toBe(999); // capped at max_backoff
    expect(computeBackoff(3, retry, undefined, () => 0)).toBe(0);
  });

  it('honors Retry-After as a lower bound', () => {
    expect(computeBackoff(0, retry, 2000, () => 0.5)).toBe(2000);
  });

  it('refuses to wait when Retry-After exceeds the cap', () => {
    expect(computeBackoff(0, retry, 6000, () => 0.5)).toBeNull();
  });

  it('checks the remaining deadline', () => {
    expect(fitsDeadline(100, 1000, 0)).toBe(true);
    expect(fitsDeadline(990, 1000, 0)).toBe(false);
  });
});

describe('Semaphore', () => {
  it('limits concurrency and hands slots over FIFO', async () => {
    const sem = new Semaphore('p', 2);
    const r1 = await sem.acquire(1000);
    const r2 = await sem.acquire(1000);
    const order: number[] = [];
    const p3 = sem.acquire(1000).then((r) => (order.push(3), r));
    const p4 = sem.acquire(1000).then((r) => (order.push(4), r));
    expect(sem.stats).toEqual({ inflight: 2, queued: 2, max: 2 });
    r1();
    r1(); // double release is a no-op
    const r3 = await p3;
    expect(sem.stats.inflight).toBe(2);
    r2();
    const r4 = await p4;
    expect(order).toEqual([3, 4]);
    r3();
    r4();
    expect(sem.stats).toEqual({ inflight: 0, queued: 0, max: 2 });
  });

  it('times out in the queue with a retryable upstream_busy error', async () => {
    const sem = new Semaphore('p', 1);
    await sem.acquire(1000);
    const err = await sem.acquire(20).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: 'upstream_busy', retryable: true, countsAsFailure: false });
    expect(sem.stats.queued).toBe(0);
  });

  it('rejects queued waiters on abort', async () => {
    const sem = new Semaphore('p', 1);
    await sem.acquire(1000);
    const ac = new AbortController();
    const p = sem.acquire(1000, ac.signal);
    ac.abort(new Error('gone'));
    await expect(p).rejects.toThrow('gone');
    expect(sem.stats.queued).toBe(0);
  });

  it('max 0 means unlimited', async () => {
    const sem = new Semaphore('p', 0);
    await Promise.all(Array.from({ length: 50 }, () => sem.acquire(1)));
    expect(sem.stats.inflight).toBe(50);
  });
});
