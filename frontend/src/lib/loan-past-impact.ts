import { Account } from '@/types/account';
import { LoanHistoryResult } from '@/lib/loan-history';
import {
  LoanScheduleResult,
  RateTimelineRow,
  ScheduleFrequency,
  advanceDate,
  buildRateTimeline,
  calculateMortgagePaymentAmount,
  generateLoanSchedule,
} from '@/lib/loan-schedule';

/**
 * "How much have my overpayments already helped?" — compares the original
 * contractual schedule (from origination) against what actually happened
 * plus the current projection from today's balance.
 *
 * Extra principal is measured against the contractual schedule, not from
 * memos or split structure, so it captures overpayments however they were
 * recorded -- including plain transfers to the loan or an extra transfer
 * alongside the regular split payment.
 */
export interface PastImpactResult {
  /** Contractual schedule from the original principal at paymentStartDate */
  originalSchedule: LoanScheduleResult;
  /** Projection from the current balance; null when the loan is paid off */
  currentProjection: LoanScheduleResult | null;
  originalPayoffDate: string | null;
  /** Projected payoff, or the final actual payment when already paid off */
  currentPayoffDate: string | null;
  monthsAlreadySaved: number;
  interestAlreadySaved: number;
  /**
   * How far ahead of the original contractual balance you are today, i.e. the
   * net extra principal already applied. Floored at zero.
   */
  extraPrincipalPaid: number;
}

/** Original schedules can be longer than the reports' 600-payment cap
 * (e.g. a 25-year weekly mortgage), so give them room to complete. */
const ORIGINAL_SCHEDULE_MAX_PAYMENTS = 10000;

/**
 * Compute the past impact of overpayments, or null when the account lacks the
 * data to reconstruct its original schedule (a positive original principal,
 * a start date, rate, frequency, and a determinable contractual payment).
 *
 * `rateChanges` is the account's persisted rate history. The contractual
 * baseline starts at the origination rate (the timeline's initial row, not
 * the account's current scalar) and applies the recorded steps as they
 * happened -- without overpayments -- so the comparison isolates the pure
 * effect of extra payments even across rate changes. The current projection
 * applies only future-dated steps.
 *
 * `asOf` defaults to now; it is injectable for deterministic tests.
 */
export function computePastImpact(
  account: Account,
  history: LoanHistoryResult,
  asOf: Date = new Date(),
  rateChanges: RateTimelineRow[] = [],
): PastImpactResult | null {
  // The original principal is the configured value, or the loan's opening
  // balance (mortgages store the original amount as the negative opening
  // balance), falling back to the reconstructed starting balance.
  const originalPrincipal =
    account.originalPrincipal && account.originalPrincipal > 0
      ? account.originalPrincipal
      : history.startingBalance;

  // The schedule starts at the configured first-payment date, or the earliest
  // actual payment when that is unset.
  const startDate = account.paymentStartDate || history.events[0]?.date || null;

  if (
    originalPrincipal <= 0 ||
    !startDate ||
    account.interestRate == null ||
    !account.paymentFrequency
  ) {
    return null;
  }

  const frequency = account.paymentFrequency as ScheduleFrequency;
  const isCanadian = account.isCanadianMortgage || false;
  const isVariableRate = account.isVariableRate || false;

  // The origination rate comes from the rate history when one exists; the
  // account's scalar rate is only the *current* rate and would corrupt the
  // baseline after any recorded change.
  const timeline = buildRateTimeline(rateChanges, startDate, account.interestRate);

  // Mortgages derive their contractual payment from the amortization period;
  // plain loans use the payment in effect at origination.
  const contractualPayment =
    account.accountType === 'MORTGAGE' && account.amortizationMonths
      ? calculateMortgagePaymentAmount(
          originalPrincipal,
          timeline.startingAnnualRate,
          account.amortizationMonths,
          frequency,
          isCanadian,
          isVariableRate,
        )
      : (timeline.startingPaymentAmount ?? account.paymentAmount ?? 0);
  if (contractualPayment <= 0) return null;

  const originalSchedule = generateLoanSchedule({
    startingBalance: originalPrincipal,
    annualRate: timeline.startingAnnualRate,
    paymentAmount: contractualPayment,
    frequency,
    isCanadian,
    isVariableRate,
    firstPaymentDate: parseIsoDate(startDate),
    rateChanges: timeline.rateChanges,
    maxPayments: ORIGINAL_SCHEDULE_MAX_PAYMENTS,
  });

  const isPaidOff = history.currentBalance <= 0.01;
  const canProjectCurrent =
    !isPaidOff && account.paymentAmount != null && account.paymentAmount > 0;

  // The scalar rate is already current; only future-dated steps apply ahead
  const futureTimeline = buildRateTimeline(
    rateChanges,
    isoDate(asOf),
    account.interestRate,
  );

  const currentProjection = canProjectCurrent
    ? generateLoanSchedule({
        startingBalance: history.currentBalance,
        annualRate: account.interestRate,
        paymentAmount: account.paymentAmount!,
        frequency,
        isCanadian,
        isVariableRate,
        firstPaymentDate: advanceDate(asOf, frequency),
        rateChanges: futureTimeline.rateChanges,
      })
    : null;

  const lastActualPaymentDate =
    history.events.length > 0 ? history.events[history.events.length - 1].date : null;
  const currentPayoffDate = isPaidOff
    ? lastActualPaymentDate
    : (currentProjection?.payoffDate ?? null);

  const projectedRemainingInterest = currentProjection?.totalInterest ?? 0;
  const interestAlreadySaved = Math.max(
    0,
    round2(
      originalSchedule.totalInterest -
        (history.cumulativeInterest + projectedRemainingInterest),
    ),
  );

  // Extra principal already paid = how far the actual balance is below where
  // the contract would have it today. Captures every form of overpayment
  // because it is measured purely from the balance.
  const contractualBalanceToday = scheduledBalanceAsOf(
    originalSchedule,
    originalPrincipal,
    isoDate(asOf),
  );
  const extraPrincipalPaid = Math.max(
    0,
    round2(contractualBalanceToday - history.currentBalance),
  );

  return {
    originalSchedule,
    currentProjection,
    originalPayoffDate: originalSchedule.payoffDate,
    currentPayoffDate,
    monthsAlreadySaved: Math.max(
      0,
      monthsBetween(currentPayoffDate, originalSchedule.payoffDate),
    ),
    interestAlreadySaved,
    extraPrincipalPaid,
  };
}

/** Contractual remaining balance at `isoAsOf`: the last scheduled row on or
 * before that date, or the full principal when no payment is yet due. */
function scheduledBalanceAsOf(
  schedule: LoanScheduleResult,
  originalPrincipal: number,
  isoAsOf: string,
): number {
  let balance = originalPrincipal;
  for (const row of schedule.rows) {
    if (row.date <= isoAsOf) {
      balance = row.balance;
    } else {
      break;
    }
  }
  return balance;
}

/** Whole months from `fromDate` to `toDate` (0 when either is missing) */
function monthsBetween(fromDate: string | null, toDate: string | null): number {
  if (!fromDate || !toDate) return 0;
  const [fromYear, fromMonth] = fromDate.split('-').map(Number);
  const [toYear, toMonth] = toDate.split('-').map(Number);
  return (toYear - fromYear) * 12 + (toMonth - fromMonth);
}

function parseIsoDate(isoDate: string): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/** Local-time yyyy-MM-dd, matching the ISO dates the schedule emits. */
function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
