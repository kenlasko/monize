import { Account } from '@/types/account';
import { LoanHistoryResult } from '@/lib/loan-history';
import {
  LoanScheduleInput,
  LoanScheduleResult,
  RateTimelineRow,
  ScheduleFrequency,
  buildRateTimeline,
  calculateMortgagePaymentAmount,
  firstPeriodInterest,
  generateLoanSchedule,
  getPeriodsPerYear,
  monthsBetween,
  round2,
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
   * Total extra principal already paid: the principal from payments recognized
   * as overpayments (by the loan's overpayment category or memo). Matches the
   * Extra Principal column of the installment schedule, which surfaces the same
   * classified payments.
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
 * effect of extra payments even across rate changes.
 *
 * `currentProjection` is the loan detail page's forward projection from today's
 * balance (the no-overpayment baseline). It is passed in rather than recomputed
 * here so both views share one projection.
 */
export function computePastImpact(
  account: Account,
  history: LoanHistoryResult,
  currentProjection: LoanScheduleResult | null = null,
  rateChanges: RateTimelineRow[] = [],
): PastImpactResult | null {
  // The original principal is the configured value, or the loan's opening
  // balance (mortgages store the original amount as the negative opening
  // balance). When neither is available -- common for loans imported from
  // Quicken/MS Money without an opening balance, where any draw or adjustment
  // also pushes derivation onto the ledger path and leaves startingBalance at
  // zero -- reconstruct the starting debt from the payment history itself:
  // today's balance plus every principal dollar already repaid. That equals
  // the opening balance whenever one is known and stays positive when it is
  // blank, so the contractual baseline can still be built from transactions.
  const reconstructedPrincipal = round2(
    history.currentBalance + history.cumulativePrincipal,
  );
  const originalPrincipal =
    account.originalPrincipal && account.originalPrincipal > 0
      ? account.originalPrincipal
      : history.startingBalance > 0
        ? history.startingBalance
        : reconstructedPrincipal;

  // The schedule starts at the earliest actual payment; the configured
  // first-payment date is only a fallback for when there are no payments yet.
  // Preferring the real transaction keeps the baseline aligned with the data
  // the user actually has, rather than a stale configured value.
  const startDate = history.events[0]?.date || account.paymentStartDate || null;

  // The configured repayment period. Prefer the amortization period; fall back
  // to the term. It is required (the loan/mortgage form collects it), so
  // without it there is no contractual baseline to compare against.
  const configuredTermMonths =
    account.amortizationMonths && account.amortizationMonths > 0
      ? account.amortizationMonths
      : account.termMonths && account.termMonths > 0
        ? account.termMonths
        : null;

  if (
    originalPrincipal <= 0 ||
    !startDate ||
    account.interestRate == null ||
    !account.paymentFrequency ||
    !configuredTermMonths
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

  const periodsPerYear = getPeriodsPerYear(frequency);

  // --- The contractual "if I never overpaid" schedule ---
  // Prefer the loan's real origination installment -- the payment recorded on
  // the initial rate row, sized for the full original principal -- and follow
  // its recorded steps. This plots the loan's true payoff, so a loan paid down
  // faster than its nominal amortization (a large regular payment on a
  // long-amortization mortgage) is not stretched onto the theoretical
  // minimum-payment curve that a fresh PMT over the configured term would draw.
  //
  // Fall back to that PMT only when no usable installment is recorded: interest
  // booked separately leaves the rate rows' payment null (recording it would
  // capture a principal-only figure), and a recorded payment that cannot even
  // cover the first period's interest is unusable. The fallback path is
  // unchanged from before, so loans that already relied on it are unaffected.
  const configuredTermPeriods = Math.round((configuredTermMonths * periodsPerYear) / 12);
  const recordedInstallment = timeline.startingPaymentAmount;
  const useRecordedInstallment =
    recordedInstallment != null &&
    recordedInstallment >
      firstPeriodInterest(
        originalPrincipal,
        timeline.startingAnnualRate,
        frequency,
        isCanadian,
        isVariableRate,
      );

  const contractualPayment = useRecordedInstallment
    ? recordedInstallment
    : calculateMortgagePaymentAmount(
        originalPrincipal,
        timeline.startingAnnualRate,
        configuredTermMonths,
        frequency,
        isCanadian,
        isVariableRate,
      );
  if (contractualPayment <= 0) return null;

  const base: LoanScheduleInput = {
    startingBalance: originalPrincipal,
    annualRate: timeline.startingAnnualRate,
    paymentAmount: contractualPayment,
    frequency,
    isCanadian,
    isVariableRate,
    firstPaymentDate: parseIsoDate(startDate),
  };
  const originalSchedule = generateLoanSchedule(
    useRecordedInstallment
      ? {
          ...base,
          // Keep the timeline's payment steps so the contractual installment
          // tracks the lender period to period (e.g. a variable rate that
          // re-levelled the payment upward), then run to the loan's own payoff.
          rateChanges: timeline.rateChanges,
          // Re-level toward the configured term ONLY if a rate rise would
          // otherwise stall the payment; unlike fixedEndPeriod this never forces
          // payoff at the term, so a faster real schedule keeps its earlier one.
          rescueEndPeriod: configuredTermPeriods,
          maxPayments: ORIGINAL_SCHEDULE_MAX_PAYMENTS,
        }
      : {
          ...base,
          // Keep the recorded rate steps but drop their payment overrides (often
          // principal-only figures that would stall a fixed payment);
          // re-levelling sets the installment instead.
          rateChanges: timeline.rateChanges.map((change) => ({ ...change, paymentAmount: null })),
          fixedEndPeriod: configuredTermPeriods,
          // One-period buffer so a rounding remainder on the final payment is kept.
          maxPayments: Math.min(
            configuredTermPeriods + Math.ceil(periodsPerYear / 12),
            ORIGINAL_SCHEDULE_MAX_PAYMENTS,
          ),
        },
  );

  // --- Current payoff, from the caller's forward projection ---
  const isPaidOff = history.currentBalance <= 0.01;
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

  // Extra principal already paid = the principal from payments recognized as
  // overpayments (by the loan's overpayment category or memo). This is the sum
  // the installment schedule shows in its Extra Principal column, so the two
  // views agree. Integer-cents arithmetic avoids floating-point drift.
  const extraPrincipalCents = history.events
    .filter((event) => event.type === 'OVERPAYMENT')
    .reduce((sum, event) => sum + Math.round(event.principal * 100), 0);
  const extraPrincipalPaid = extraPrincipalCents / 100;

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

function parseIsoDate(isoDate: string): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day);
}
