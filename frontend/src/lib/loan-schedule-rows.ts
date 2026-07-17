import type { LoanPaymentEvent } from './loan-history';
import type { ScheduleRow } from './loan-schedule';
import type { LoanRateChange } from '@/types/loan-rate-change';

/**
 * A single per-payment row of the loan schedule -- one historical payment or
 * one projected installment. Shared by the on-screen amortization table, its
 * CSV export, and the PDF report so the three never drift apart.
 */
export interface DisplayRow {
  paymentNumber: number;
  date: string;
  payment: number;
  principal: number;
  interest: number;
  extraPrincipal: number;
  balance: number;
  isProjected: boolean;
  /** Annual rate (percentage) in effect on this row's date, when known */
  annualRate: number | null;
  /** The rate-change effective exactly on this date, if any (a change point) */
  change?: LoanRateChange;
  /** Historical row tagged as a standalone overpayment (100% principal) */
  isOverpayment?: boolean;
  /** Set on the first projected row of a new rate segment */
  rateChange?: { from: number; to: number };
  /** This row's date follows a gap in payments (missing installments). */
  precededByGap?: boolean;
}

/** Whole days between two yyyy-MM-dd keys, timezone-safe. */
function daysBetween(aKey: string, bKey: string): number {
  const a = new Date(`${aKey}T00:00:00Z`).getTime();
  const b = new Date(`${bKey}T00:00:00Z`).getTime();
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

/**
 * The set of historical payment dates that follow a gap -- a stretch longer
 * than ~1.8x the typical interval between payments, i.e. one or more expected
 * installments with no recorded payment (a payment holiday, or missing data).
 * The row on such a date is flagged so the schedule can highlight it. Needs at
 * least three payments to establish a median interval; returns empty otherwise.
 */
export function datesFollowingAGap(dateKeys: string[]): Set<string> {
  const flagged = new Set<string>();
  const dates = [...dateKeys].sort();
  if (dates.length < 3) return flagged;
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!(median > 0)) return flagged;
  const threshold = median * 1.8;
  for (let i = 1; i < dates.length; i++) {
    if (daysBetween(dates[i - 1], dates[i]) > threshold) flagged.add(dates[i]);
  }
  return flagged;
}

/**
 * The flat per-payment schedule: historical payments (numbered in order)
 * followed by the projected installments. This is the analysis-ready list --
 * every entry on its own row, no month grouping -- used by the CSV/PDF exports
 * and, after month-grouping, by the on-screen table.
 */
export function buildScheduleDisplayRows(
  historyEvents: LoanPaymentEvent[],
  projectionRows: ScheduleRow[],
  rateChanges: LoanRateChange[] = [],
): DisplayRow[] {
  const changeByDate = new Map(rateChanges.map((change) => [change.effectiveDate, change]));
  const gapDates = datesFollowingAGap(historyEvents.map((e) => e.date.split('T')[0]));

  const historical: DisplayRow[] = historyEvents.map((event, index) => {
    const isOverpayment = event.type === 'OVERPAYMENT';
    return {
      paymentNumber: index + 1,
      date: event.date,
      payment: event.principal + event.interest,
      // A standalone overpayment is entirely extra principal, not a scheduled
      // installment, so surface its amount in the extra-principal column
      // rather than the regular principal column.
      principal: isOverpayment ? 0 : event.principal,
      interest: event.interest,
      extraPrincipal: isOverpayment ? event.principal : 0,
      balance: event.balance,
      isProjected: false,
      isOverpayment,
      annualRate: event.annualRate ?? null,
      precededByGap: gapDates.has(event.date.split('T')[0]),
      change: changeByDate.get(event.date),
    };
  });

  const projected: DisplayRow[] = projectionRows.map((row, index) => {
    const previousRate = index > 0 ? projectionRows[index - 1].annualRate : row.annualRate;
    return {
      paymentNumber: historyEvents.length + row.paymentNumber,
      date: row.date,
      // Payment is the total cash that period. The schedule's `payment` is
      // principal + interest only, so add the overpayment to match the
      // historical rows (where an overpayment's amount is part of its
      // payment) -- otherwise the totals row mixes the two conventions.
      payment: row.payment + row.extraPrincipal,
      principal: row.principal,
      interest: row.interest,
      extraPrincipal: row.extraPrincipal,
      balance: row.balance,
      isProjected: true,
      annualRate: row.annualRate,
      change: changeByDate.get(row.date),
      ...(previousRate !== row.annualRate
        ? { rateChange: { from: previousRate, to: row.annualRate } }
        : {}),
    };
  });

  return [...historical, ...projected];
}
