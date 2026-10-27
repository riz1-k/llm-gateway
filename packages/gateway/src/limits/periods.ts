/** UTC budget periods. */
export type BudgetPeriod = 'daily' | 'monthly';

export interface PeriodWindow {
  period: BudgetPeriod;
  /** `YYYYMMDD` (daily) or `YYYYMM` (monthly). */
  key: string;
  start: Date;
  end: Date;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

export function periodWindow(period: BudgetPeriod, at: Date = new Date()): PeriodWindow {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  if (period === 'daily') {
    const d = at.getUTCDate();
    return {
      period,
      key: `${y}${pad(m + 1)}${pad(d)}`,
      start: new Date(Date.UTC(y, m, d)),
      end: new Date(Date.UTC(y, m, d + 1)),
    };
  }
  return {
    period,
    key: `${y}${pad(m + 1)}`,
    start: new Date(Date.UTC(y, m, 1)),
    end: new Date(Date.UTC(y, m + 1, 1)),
  };
}

/** Fraction of the period elapsed at `at` (0..1]. */
export function elapsedFraction(w: PeriodWindow, at: Date = new Date()): number {
  const total = w.end.getTime() - w.start.getTime();
  const done = Math.min(total, Math.max(1, at.getTime() - w.start.getTime()));
  return done / total;
}

/** Linear projection of end-of-period spend. */
export function projectSpend(spent: number, w: PeriodWindow, at: Date = new Date()): number {
  return spent / elapsedFraction(w, at);
}

/** `YYYY-MM-DD` of a Date in UTC. */
export const utcDay = (d: Date): string =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
