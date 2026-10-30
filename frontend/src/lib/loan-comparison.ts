/**
 * The rate timeline a projection follows, and the comparison of two schedules.
 *
 * Split out of `loan-schedule.ts` for its size. Two related jobs: turning a
 * loan's recorded rate history into the `rateChanges` the generator consumes,
 * and subtracting one generated schedule from another. `loan-schedule.ts`
 * re-exports both, because every consumer has always imported from there.
 */

import type {
  LoanScheduleResult,
  RateTimeline,
  RateTimelineRow,
  ScenarioComparison,
} from '@/lib/loan-schedule-types';
import { roundToCents } from '@/lib/format';
import { financialTodayYmd } from '@/lib/financial-today';

/**
 * The annual rate (percentage) in effect on a given date: the latest row with
 * `effectiveDate <= date`. Before the first row, the earliest row when it is
 * dated on or before today (the loan's recorded history start, so an
 * origination-era payment keeps the origination rate), else the fallback (the
 * account's rate: a history that starts in the future). Shared by the schedule table (per-row historical rate) and
 * `buildRateTimeline`'s starting rate.
 */
export function effectiveAnnualRateOn(
  rows: RateTimelineRow[],
  dateIso: string,
  fallbackAnnualRate: number,
  todayYmd: string = financialTodayYmd(undefined),
): number {
  const sorted = [...rows].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate),
  );
  const atOrBefore = sorted.filter((row) => row.effectiveDate <= dateIso);
  if (atOrBefore.length > 0) {
    return atOrBefore[atOrBefore.length - 1].annualRate;
  }
  // Nothing on or before the date. A history that already began (earliest row
  // not in the future) gives its origination rate to earlier payments; one that
  // only starts ahead says nothing about today, so the account's own rate.
  if (sorted.length > 0 && sorted[0].effectiveDate <= todayYmd) {
    return sorted[0].annualRate;
  }
  return fallbackAnnualRate;
}

/**
 * Resolve a persisted rate history into engine inputs for a schedule that
 * starts at `scheduleStartIso`: the rate in effect at the start is the
 * latest row on or before that date (before the earliest row, the earliest
 * row's rate applies; with no rows, the fallback), the payment in effect is
 * the latest non-null payment on or before the start (before the earliest
 * row, that row's payment applies -- the origination installment), and the
 * remaining rows become steps for generateLoanSchedule.
 */
export function buildRateTimeline(
  rows: RateTimelineRow[],
  scheduleStartIso: string,
  fallbackAnnualRate: number,
): RateTimeline {
  const sorted = [...rows].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate),
  );

  const atOrBefore = sorted.filter(
    (row) => row.effectiveDate <= scheduleStartIso,
  );
  // A schedule anchored at origination may start before the first row: the
  // earliest row is then the origination rate (unlike `effectiveAnnualRateOn`).
  const startingAnnualRate =
    atOrBefore.length === 0 && sorted.length > 0
      ? sorted[0].annualRate
      : effectiveAnnualRateOn(rows, scheduleStartIso, fallbackAnnualRate);
  // Mirror the rate's "before the earliest row, the earliest row applies"
  // fallback for the payment: a schedule starting shortly before the first
  // recorded row (payment_start_date precedes the first installment, which is
  // where detection dates the initial row) still starts at the origination
  // installment that row records. Only the earliest row is consulted -- later
  // rows describe later rate levels and become steps anyway.
  const startingPaymentAmount =
    [...atOrBefore].reverse().find((row) => row.newPaymentAmount != null)
      ?.newPaymentAmount ??
    (atOrBefore.length === 0 ? (sorted[0]?.newPaymentAmount ?? null) : null);

  const rateChanges = sorted
    .filter((row) => row.effectiveDate > scheduleStartIso)
    .map((row) => ({
      effectiveDate: row.effectiveDate,
      annualRate: row.annualRate,
      paymentAmount: row.newPaymentAmount ?? null,
    }));

  return { startingAnnualRate, startingPaymentAmount, rateChanges };
}

/**
 * The loan's terms in effect on `asOfIso`, resolved from the persisted rate
 * history: the latest row dated at or before that day.
 *
 * Deliberately NOT `buildRateTimeline`'s `startingAnnualRate` /
 * `startingPaymentAmount`, and it lives here so the difference is visible in one
 * file. Those fields carry a "before the earliest row, the earliest row applies"
 * fallback, which is right for a schedule anchored at **origination**
 * (`loan-past-impact.ts` builds the contractual schedule that way, and needs the
 * origination terms) and wrong for one anchored at a date the history already
 * covers: under it a change dated next year would become today's terms *and* be
 * applied again as a future step. A row dated ahead is a step, never the current
 * state.
 *
 * `paymentAmount` is null when no applicable row states one -- which includes a
 * loan whose only row is `initial`, since that payment may be a copy of the
 * account field the caller already has. The rate has no such distinction: an
 * `initial` row's rate is the origination rate, which is a fact about the loan.
 */
export interface EffectiveLoanTerms {
  /** Null only when no row applies and the account carries no rate either. */
  annualRate: number | null;
  /** Stated by an applicable `manual` or `inferred` row; authoritative. */
  paymentAmount: number | null;
  /**
   * The effective date of the row that stated `paymentAmount`, so a caller can
   * tell whether an actual installment observed AFTER it has superseded the
   * statement. Null whenever `paymentAmount` is null. A payment stated in a
   * rate-change row is a snapshot of the contractual installment on that day;
   * for a loan whose lender re-amortizes after each overpayment (a lower
   * installment), every later payment is a newer statement of what is owed.
   */
  paymentEffectiveDate: string | null;
  /**
   * From an applicable `initial` row. Either a real observed installment or a
   * stale copy of `account.paymentAmount` -- see `RateTimelineRow.source` -- so a
   * caller ranks it with the account's own scalar rather than above it.
   */
  snapshotPaymentAmount: number | null;
}

export function resolveEffectiveLoanTerms(
  rows: RateTimelineRow[],
  asOfIso: string,
  fallbackAnnualRate: number | null,
): EffectiveLoanTerms {
  const applied = rows
    .filter((row) => row.effectiveDate <= asOfIso)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  const latest = applied[applied.length - 1];
  const byLatest = [...applied].reverse();
  const statedPayment = byLatest.find(
    (row) => row.newPaymentAmount != null && row.source !== 'initial',
  );
  const snapshotPayment = byLatest.find(
    (row) => row.newPaymentAmount != null && row.source === 'initial',
  );
  return {
    // `??`, not `||`: a recorded 0% is a rate, and the absence has to survive
    // to the caller as null rather than becoming a measured zero.
    annualRate: latest?.annualRate ?? fallbackAnnualRate ?? null,
    paymentAmount: statedPayment?.newPaymentAmount ?? null,
    paymentEffectiveDate: statedPayment?.effectiveDate ?? null,
    snapshotPaymentAmount: snapshotPayment?.newPaymentAmount ?? null,
  };
}

export function compareSchedules(
  baseline: LoanScheduleResult,
  scenario: LoanScheduleResult,
): ScenarioComparison {
  // Every saving is a difference of two lifetime figures, so both sides must
  // have paid off within the horizon. A truncated schedule's `numPayments` is
  // the horizon's row count and its `totalInterest` the interest over it, so
  // subtracting either from a real lifetime figure says nothing about the loan
  // (a truncated baseline made every scenario look better than it is, and could
  // even report a negative saving). `monthsSaved` needs the same gate for a
  // different reason: `monthsBetween` returns 0 for a missing payoff date, which
  // reads as "the overpayment bought no time" rather than "not known".
  const comparable = baseline.paidOff && scenario.paidOff;
  return {
    baseline,
    scenario,
    paymentsSaved: comparable
      ? baseline.numPayments - scenario.numPayments
      : null,
    monthsSaved: comparable
      ? monthsBetween(scenario.payoffDate, baseline.payoffDate)
      : null,
    interestSaved: comparable
      ? roundToCents(baseline.totalInterest - scenario.totalInterest)
      : null,
    // A truncated schedule's `finalPaymentAmount` is the installment at its last
    // PROJECTED row, not its last payment -- there is no last payment -- so a
    // drop measured from it is as unknown as the rest.
    installmentReduction:
      comparable && scenario.levelInstallment !== false
        ? roundToCents(baseline.finalPaymentAmount - scenario.finalPaymentAmount)
        : null,
  };
}

/** Whole months from `fromDate` to `toDate` (0 when either is missing) */
export function monthsBetween(
  fromDate: string | null,
  toDate: string | null,
): number {
  if (!fromDate || !toDate) return 0;
  const from = parseIsoDateParts(fromDate);
  const to = parseIsoDateParts(toDate);
  return (to.year - from.year) * 12 + (to.month - from.month);
}

function parseIsoDateParts(isoDate: string): { year: number; month: number } {
  const [year, month] = isoDate.split("-").map(Number);
  return { year, month };
}

/** Round to 2 decimals (cents), avoiding floating-point drift. */
