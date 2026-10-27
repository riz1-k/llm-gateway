import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { UsageEvent } from '../core/services.js';
import type { Database } from '../db/client.js';
import type { RedisBudgetGuard } from '../limits/redis-budgets.js';
import type { Logger } from '../observability/logger.js';
import { USAGE_FIELD } from './stream-sink.js';
import { reconcileBudgets } from './reconcile.js';
import { toMap } from './stream.js';
import { dropExpiredPartitions, ensurePartitions, monthsOf, writeUsageBatch } from './writer.js';

type StreamEntry = [id: string, fields: string[]];

export interface UsageWorkerOptions {
  /** Dedicated connection: XREADGROUP BLOCK holds it. */
  redis: Redis;
  database: Database;
  stream: string;
  group: string;
  consumer?: string;
  batchSize: number;
  /** XREADGROUP BLOCK timeout = max time between flushes when idle. */
  blockMs: number;
  claimIdleMs: number;
  retentionDays: number;
  partitionsAhead: number;
  logger: Logger;
  /** Enables periodic budget reconciliation from usage_daily. */
  budgets?: RedisBudgetGuard;
  reconcileIntervalMs?: number;
  maintenanceIntervalMs?: number;
  /** Observability hooks (the worker CLI maps them to Prometheus counters). */
  onBatch?: (b: {
    read: number;
    inserted: number;
    duplicates: number;
    deadLettered: number;
  }) => void;
  onError?: () => void;
}

export interface WorkerStats {
  batches: number;
  read: number;
  inserted: number;
  duplicates: number;
  deadLettered: number;
  claimed: number;
  errors: number;
  lastBatchAt: number | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function parseEntry(fields: string[]): UsageEvent | null {
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] !== USAGE_FIELD) continue;
    try {
      const e = JSON.parse(fields[i + 1]!) as Partial<UsageEvent>;
      if (
        typeof e.ts !== 'string' ||
        Number.isNaN(Date.parse(e.ts)) ||
        typeof e.request_id !== 'string' ||
        typeof e.team !== 'string' ||
        typeof e.route !== 'string'
      )
        return null;
      return {
        team_id: e.team,
        key_id: 'unknown',
        kind: 'chat',
        provider: null,
        model: null,
        status: 0,
        error_code: null,
        cache: 'bypass',
        stream: false,
        prompt_tokens: 0,
        cached_tokens: 0,
        completion_tokens: 0,
        reasoning_tokens: 0,
        cost_usd: 0,
        saved_usd: 0,
        latency_ms: 0,
        ttft_ms: null,
        attempts: 0,
        fallbacks: 0,
        end_user: null,
        tags: [],
        ...e,
      } as UsageEvent;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * `switchyard worker` (SPEC §10): drains the usage stream into Postgres.
 *
 * - consumer group (`XGROUP CREATE … 0 MKSTREAM`, so a backlog written before the first worker
 *   started is not lost); batched `XREADGROUP`; on startup and after a failed write the worker
 *   first re-reads its own pending entries (`0`) before taking new ones (`>`);
 * - one transactional statement per batch (events + rollup, idempotent on (ts, request_id)),
 *   then `XACK`; nothing is acknowledged before it is committed;
 * - `XAUTOCLAIM` takes over entries left pending by crashed consumers;
 * - malformed entries go to `<stream>:dead` and are acknowledged;
 * - maintenance: monthly partitions ahead + retention, idle consumer cleanup, budget
 *   reconciliation.
 */
export class UsageWorker {
  readonly consumer: string;
  readonly stats: WorkerStats = {
    batches: 0,
    read: 0,
    inserted: 0,
    duplicates: 0,
    deadLettered: 0,
    claimed: 0,
    errors: 0,
    lastBatchAt: null,
  };
  private running = false;
  private loop: Promise<void> | undefined;
  private readOwnPending = true;
  private lastClaim = 0;
  private lastMaintenance = 0;
  private lastReconcile = 0;
  private readonly knownMonths = new Set<string>();
  private failures = 0;

  constructor(private readonly opts: UsageWorkerOptions) {
    this.consumer =
      opts.consumer ?? `${hostname()}-${process.pid}-${randomBytes(2).toString('hex')}`;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async ensureGroup(): Promise<void> {
    try {
      await this.opts.redis.xgroup('CREATE', this.opts.stream, this.opts.group, '0', 'MKSTREAM');
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('BUSYGROUP'))) throw err;
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.ensureGroup();
    await this.maintenance();
    this.running = true;
    this.opts.logger.info(
      { consumer: this.consumer, stream: this.opts.stream, group: this.opts.group },
      'usage worker started',
    );
    this.loop = this.run();
  }

  /** Stops after the current batch is committed and acknowledged. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.loop;
    this.opts.logger.info({ consumer: this.consumer, stats: this.stats }, 'usage worker stopped');
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
        this.failures = 0;
      } catch (err) {
        this.stats.errors++;
        this.opts.onError?.();
        this.failures++;
        this.readOwnPending = true;
        const backoff = Math.min(30_000, 250 * 2 ** Math.min(this.failures, 7));
        this.opts.logger.error(
          { err: err instanceof Error ? err.message : String(err), retry_in_ms: backoff },
          'usage worker batch failed',
        );
        await sleep(backoff);
      }
    }
  }

  /** One iteration: (periodic jobs) → read → write → ack. Exposed for tests. */
  async tick(): Promise<number> {
    const now = Date.now();
    if (now - this.lastMaintenance > (this.opts.maintenanceIntervalMs ?? 3_600_000)) {
      await this.maintenance();
    }
    if (
      this.opts.budgets &&
      now - this.lastReconcile > (this.opts.reconcileIntervalMs ?? 300_000)
    ) {
      this.lastReconcile = now;
      await this.reconcile().catch((err: unknown) =>
        this.opts.logger.warn({ err: (err as Error).message }, 'budget reconciliation failed'),
      );
    }
    if (now - this.lastClaim > Math.max(1000, this.opts.claimIdleMs / 2)) {
      this.lastClaim = now;
      const claimed = await this.claimStale();
      if (claimed > 0) return claimed;
    }
    const entries = await this.read(this.readOwnPending ? '0' : '>');
    if (this.readOwnPending && entries.length === 0) {
      this.readOwnPending = false;
      return 0;
    }
    if (entries.length === 0) return 0;
    await this.process(entries);
    return entries.length;
  }

  private async read(id: '0' | '>'): Promise<StreamEntry[]> {
    const args: (string | number)[] = [
      'GROUP',
      this.opts.group,
      this.consumer,
      'COUNT',
      this.opts.batchSize,
    ];
    if (id === '>') args.push('BLOCK', this.opts.blockMs);
    args.push('STREAMS', this.opts.stream, id);
    const res = (await this.opts.redis.call('XREADGROUP', ...args)) as unknown[] | null;
    if (!res || res.length === 0) return [];
    // RESP2 replies [[stream, entries]]; ioredis 6 flattens a single stream to [stream, entries].
    const entries = (typeof res[0] === 'string' ? res[1] : (res[0] as unknown[])[1]) as
      StreamEntry[] | undefined;
    // Pending entries that were trimmed by MAXLEN come back as [id, null].
    return (entries ?? []).map(([eid, fields]) => [eid, fields ?? []] as StreamEntry);
  }

  /** XAUTOCLAIM entries idle longer than claimIdleMs (crashed consumers) and process them. */
  async claimStale(): Promise<number> {
    let cursor = '0-0';
    let total = 0;
    do {
      const res = (await this.opts.redis.call(
        'XAUTOCLAIM',
        this.opts.stream,
        this.opts.group,
        this.consumer,
        this.opts.claimIdleMs,
        cursor,
        'COUNT',
        this.opts.batchSize,
      )) as [string, StreamEntry[], string[]?];
      cursor = res[0];
      const entries = (res[1] ?? []).filter((e): e is StreamEntry => Array.isArray(e));
      if (entries.length > 0) {
        this.stats.claimed += entries.length;
        this.opts.logger.info({ count: entries.length }, 'reclaimed stale usage entries');
        await this.process(entries.map(([eid, f]) => [eid, f ?? []] as StreamEntry));
        total += entries.length;
      }
    } while (cursor !== '0-0' && this.running);
    return total;
  }

  private async process(entries: StreamEntry[]): Promise<void> {
    const ids: string[] = [];
    let inserted = 0;
    let duplicates = 0;
    const events: UsageEvent[] = [];
    const dead: StreamEntry[] = [];
    for (const entry of entries) {
      const ev = parseEntry(entry[1]);
      if (ev) {
        ids.push(entry[0]);
        events.push(ev);
      } else {
        dead.push(entry);
      }
    }
    if (events.length > 0) {
      const months = monthsOf(events).filter((m) => !this.knownMonths.has(m));
      if (months.length > 0) {
        await ensurePartitions(this.opts.database, months);
        months.forEach((m) => this.knownMonths.add(m));
      }
      ({ inserted, duplicates } = await writeUsageBatch(this.opts.database, events));
      this.stats.inserted += inserted;
      this.stats.duplicates += duplicates;
    }
    if (dead.length > 0) {
      const p = this.opts.redis.pipeline();
      for (const [eid, fields] of dead) {
        p.xadd(
          `${this.opts.stream}:dead`,
          'MAXLEN',
          '~',
          100_000,
          '*',
          'source_id',
          eid,
          ...fields,
        );
      }
      await p.exec();
      this.stats.deadLettered += dead.length;
      this.opts.logger.warn({ count: dead.length }, 'malformed usage entries dead-lettered');
    }
    const ack = [...ids, ...dead.map((d) => d[0])];
    if (ack.length > 0) await this.opts.redis.xack(this.opts.stream, this.opts.group, ...ack);
    this.stats.batches++;
    this.stats.read += entries.length;
    this.stats.lastBatchAt = Date.now();
    this.opts.onBatch?.({ read: entries.length, inserted, duplicates, deadLettered: dead.length });
  }

  /** Partitions ahead, retention, idle consumer cleanup. */
  async maintenance(): Promise<void> {
    this.lastMaintenance = Date.now();
    const now = new Date();
    const months: string[] = [];
    for (let i = 0; i <= this.opts.partitionsAhead; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      months.push(d.toISOString().slice(0, 10));
    }
    await ensurePartitions(this.opts.database, months);
    months.forEach((m) => this.knownMonths.add(m));
    const dropped = await dropExpiredPartitions(this.opts.database, this.opts.retentionDays, now);
    if (dropped.length > 0) this.opts.logger.info({ dropped }, 'dropped expired usage partitions');
    await this.cleanupConsumers().catch(() => undefined);
  }

  private async cleanupConsumers(): Promise<void> {
    const info = (await this.opts.redis.call(
      'XINFO',
      'CONSUMERS',
      this.opts.stream,
      this.opts.group,
    )) as unknown[][];
    for (const c of info) {
      const m = toMap(c);
      const name = String(m.name);
      if (name === this.consumer) continue;
      if (Number(m.pending) === 0 && Number(m.idle) > 86_400_000) {
        await this.opts.redis.xgroup('DELCONSUMER', this.opts.stream, this.opts.group, name);
      }
    }
  }

  async reconcile(): Promise<void> {
    if (!this.opts.budgets) return;
    const res = await reconcileBudgets({
      database: this.opts.database,
      redis: this.opts.redis,
      guard: this.opts.budgets,
      stream: this.opts.stream,
      group: this.opts.group,
    });
    if (res.adjusted.length > 0) this.opts.logger.info(res, 'budget counters reconciled');
  }
}
