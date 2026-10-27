import type { Redis } from 'ioredis';

/** Flat [k1, v1, k2, v2, …] reply → object. */
export function toMap(flat: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = flat[i + 1];
  return out;
}

/** Consumer-group lag (entries not yet delivered) and pending count, via XINFO GROUPS. */
export async function streamLag(
  redis: Redis,
  stream: string,
  group: string,
): Promise<{ lag: number; pending: number } | null> {
  try {
    const groups = (await redis.call('XINFO', 'GROUPS', stream)) as unknown[][];
    for (const g of groups) {
      const m = toMap(g);
      if (String(m.name) !== group) continue;
      let lag = m.lag === null || m.lag === undefined ? NaN : Number(m.lag);
      if (Number.isNaN(lag)) {
        // Redis cannot compute lag after XDEL/trimming past the group; fall back to XLEN.
        lag = Number(await redis.xlen(stream));
      }
      return { lag, pending: Number(m.pending ?? 0) };
    }
    // No group yet: everything in the stream is waiting.
    return { lag: Number(await redis.xlen(stream)), pending: 0 };
  } catch (err) {
    if (err instanceof Error && /no such key/i.test(err.message)) return { lag: 0, pending: 0 };
    throw err;
  }
}
