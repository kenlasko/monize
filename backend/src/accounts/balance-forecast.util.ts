import {
  FrequencyType,
  calculateNextDueDate,
  ensureYMD,
} from "../common/recurrence";

export interface ForecastScheduleInput {
  accountId: string;
  transferAccountId: string | null;
  amount: number;
  frequency: FrequencyType;
  nextDueDate: string;
  endDate: string | null;
  occurrencesRemaining: number | null;
}

export interface ForecastPoint {
  date: string;
  balance: number;
}

function roundCents(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Add whole days to a `YYYY-MM-DD` string, returning `YYYY-MM-DD`. */
export function addDaysYMD(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/** Signed effect a schedule has on `accountId` per occurrence (transfers land positive). */
function scheduleDelta(s: ForecastScheduleInput, accountId: string): number {
  let delta = 0;
  if (s.accountId === accountId) delta += Number(s.amount) || 0;
  if (s.transferAccountId === accountId)
    delta += Math.abs(Number(s.amount) || 0);
  return delta;
}

/**
 * Accumulate scheduled occurrence deltas that fall strictly after `today` and
 * on or before `horizon` into a per-date map, merged with any `actualByDate`
 * (future-dated real transactions). Occurrences are expanded with the shared
 * recurrence stepper, respecting each schedule's end date and remaining count.
 */
export function accumulateForecastDeltas(
  schedules: ForecastScheduleInput[],
  accountId: string,
  today: string,
  horizon: string,
  actualByDate: Map<string, number> = new Map(),
): Map<string, number> {
  const byDate = new Map(actualByDate);
  for (const s of schedules) {
    const delta = scheduleDelta(s, accountId);
    if (delta === 0) continue;
    let d = ensureYMD(s.nextDueDate);
    const end = s.endDate ? ensureYMD(s.endDate) : null;
    let remaining = s.occurrencesRemaining ?? Number.POSITIVE_INFINITY;
    let guard = 0;
    while (d <= horizon && remaining > 0 && guard++ < 2000) {
      if (end && d > end) break;
      if (d > today) {
        byDate.set(d, roundCents((byDate.get(d) ?? 0) + delta));
      }
      remaining -= 1;
      if (s.frequency === "ONCE") break;
      const next = calculateNextDueDate(d, s.frequency);
      if (next <= d) break;
      d = next;
    }
  }
  return byDate;
}

/**
 * Build a forecast balance series from `today` (anchored at `startBalance`)
 * through `horizon`, applying the per-date deltas. Emits a point at today plus
 * one at each date that carries a delta.
 */
export function buildForecastSeries(
  startBalance: number,
  today: string,
  horizon: string,
  deltaByDate: Map<string, number>,
): ForecastPoint[] {
  const dates = [...deltaByDate.keys()]
    .filter((d) => d > today && d <= horizon)
    .sort();
  let balance = roundCents(startBalance);
  const series: ForecastPoint[] = [{ date: today, balance }];
  for (const d of dates) {
    balance = roundCents(balance + (deltaByDate.get(d) ?? 0));
    series.push({ date: d, balance });
  }
  return series;
}
