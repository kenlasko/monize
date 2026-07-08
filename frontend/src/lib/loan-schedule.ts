import { format } from 'date-fns';

/**
 * Shared loan/mortgage schedule engine.
 *
 * Single source of the period-projection math that was previously duplicated
 * inline in LoanAmortizationReport and DebtPayoffTimelineReport, extended with
 * overpayment support (recurring extra amounts and one-off lump sums) for the
 * loan detail view's simulator.
 *
 * The rate math mirrors backend/src/accounts/mortgage-amortization.util.ts
 * (including Canadian fixed-rate semi-annual compounding); parity is pinned by
 * fixtures in loan-schedule.test.ts. When no overpayments are supplied the
 * loop reproduces the reports' historical projection behaviour exactly:
 * unrounded internal accumulation, per-row values rounded to 2 decimals.
 */

export type ScheduleFrequency =
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'SEMI_MONTHLY'
  | 'MONTHLY'
  | 'QUARTERLY'
  | 'YEARLY'
  | 'ACCELERATED_WEEKLY'
  | 'ACCELERATED_BIWEEKLY';

export interface LumpSum {
  /** ISO date (yyyy-MM-dd) the lump sum is paid */
  date: string;
  amount: number;
}

export interface RecurringExtra {
  amount: number;
  /** ISO date (yyyy-MM-dd); applies from the first payment when omitted */
  startDate?: string;
  /** ISO date (yyyy-MM-dd); applies until payoff when omitted */
  endDate?: string;
}

export interface OverpaymentPlan {
  recurringExtra?: RecurringExtra;
  lumpSums?: LumpSum[];
}

/** A step on the loan's interest-rate timeline, applied during generation */
export interface RateChange {
  /** ISO date (yyyy-MM-dd) the new rate takes effect */
  effectiveDate: string;
  /** Annual rate as a percentage, e.g. 4.9 */
  annualRate: number;
  /** New regular payment from this date; omitted/null = payment unchanged */
  paymentAmount?: number | null;
}

/** A persisted rate-history row, as returned by the rate-changes API */
export interface RateTimelineRow {
  effectiveDate: string;
  annualRate: number;
  newPaymentAmount?: number | null;
}

export interface RateTimeline {
  /** Rate in effect at the schedule start */
  startingAnnualRate: number;
  /** Payment in effect at the schedule start, when the timeline knows it */
  startingPaymentAmount: number | null;
  /** Steps dated after the schedule start, ready for generateLoanSchedule */
  rateChanges: RateChange[];
}

export interface LoanScheduleInput {
  /** Positive remaining balance to amortize */
  startingBalance: number;
  /** Annual rate as a percentage, e.g. 5.5 */
  annualRate: number;
  /** Regular contractual payment per period */
  paymentAmount: number;
  frequency: ScheduleFrequency;
  /** Canadian fixed-rate mortgages compound semi-annually */
  isCanadian?: boolean;
  isVariableRate?: boolean;
  /** Date of the first projected payment (row 1) */
  firstPaymentDate: Date;
  overpayments?: OverpaymentPlan;
  /** Known rate steps; each applies from the first payment on/after its date */
  rateChanges?: RateChange[];
  /** Maximum projected payments; defaults to 600, clamped to 10000 */
  maxPayments?: number;
  /** Seed for cumulative principal (e.g. historical principal already paid) */
  initialCumulativePrincipal?: number;
  /** Seed for cumulative interest (e.g. historical interest already paid) */
  initialCumulativeInterest?: number;
}

export interface ScheduleRow {
  paymentNumber: number;
  /** ISO date (yyyy-MM-dd) */
  date: string;
  /** Regular payment applied this period (principal + interest) */
  payment: number;
  /** Principal portion of the regular payment */
  principal: number;
  interest: number;
  /** Recurring extra + lump sums applied this period */
  extraPrincipal: number;
  /** Balance after this payment */
  balance: number;
  /** Annual rate (percentage) in effect for this payment */
  annualRate: number;
  /** Running principal incl. extra, seeded by initialCumulativePrincipal */
  cumulativePrincipal: number;
  /** Running interest, seeded by initialCumulativeInterest */
  cumulativeInterest: number;
}

export interface LoanScheduleResult {
  rows: ScheduleRow[];
  /** Date of the final payment, or null when not paid off within maxPayments */
  payoffDate: string | null;
  totalInterest: number;
  /** Regular payments + extra principal contributed across the schedule */
  totalPaid: number;
  totalExtraPrincipal: number;
  numPayments: number;
  paidOff: boolean;
}

export interface ScenarioComparison {
  baseline: LoanScheduleResult;
  scenario: LoanScheduleResult;
  paymentsSaved: number;
  monthsSaved: number;
  interestSaved: number;
}

const DEFAULT_MAX_PAYMENTS = 600;
const HARD_MAX_PAYMENTS = 10000;
/** Balances at or below this are considered paid off (matches the reports) */
const PAYOFF_EPSILON = 0.01;

export function getPeriodsPerYear(frequency: ScheduleFrequency): number {
  switch (frequency) {
    case 'WEEKLY':
    case 'ACCELERATED_WEEKLY':
      return 52;
    case 'BIWEEKLY':
    case 'ACCELERATED_BIWEEKLY':
      return 26;
    case 'SEMI_MONTHLY':
      return 24;
    case 'QUARTERLY':
      return 4;
    case 'YEARLY':
      return 1;
    case 'MONTHLY':
    default:
      return 12;
  }
}

export function getPeriodicRate(
  annualRate: number,
  periodsPerYear: number,
  isCanadian: boolean,
  isVariableRate: boolean,
): number {
  if (annualRate === 0) return 0;
  if (isCanadian && !isVariableRate) {
    // Canadian fixed-rate: semi-annual compounding
    const semiAnnualRate = annualRate / 100 / 2;
    return Math.pow(1 + semiAnnualRate, 2 / periodsPerYear) - 1;
  }
  return annualRate / 100 / periodsPerYear;
}

export function advanceDate(date: Date, frequency: ScheduleFrequency): Date {
  const next = new Date(date);
  switch (frequency) {
    case 'WEEKLY':
    case 'ACCELERATED_WEEKLY':
      next.setDate(next.getDate() + 7);
      break;
    case 'BIWEEKLY':
    case 'ACCELERATED_BIWEEKLY':
      next.setDate(next.getDate() + 14);
      break;
    case 'SEMI_MONTHLY':
      if (next.getDate() < 15) {
        next.setDate(15);
      } else {
        next.setMonth(next.getMonth() + 1);
        next.setDate(1);
      }
      break;
    case 'QUARTERLY':
      next.setMonth(next.getMonth() + 3);
      break;
    case 'YEARLY':
      next.setFullYear(next.getFullYear() + 1);
      break;
    case 'MONTHLY':
    default:
      next.setMonth(next.getMonth() + 1);
      break;
  }
  return next;
}

/**
 * Contractual payment for a mortgage amortized over a given period.
 * Port of backend calculateMortgagePayment: accelerated frequencies pay
 * half (bi-weekly) or a quarter (weekly) of the monthly payment; other
 * frequencies solve the standard PMT formula at their own period count.
 */
export function calculateMortgagePaymentAmount(
  principal: number,
  annualRate: number,
  amortizationMonths: number,
  frequency: ScheduleFrequency,
  isCanadian: boolean,
  isVariableRate: boolean,
): number {
  if (principal <= 0 || amortizationMonths <= 0) return 0;

  if (frequency === 'ACCELERATED_BIWEEKLY' || frequency === 'ACCELERATED_WEEKLY') {
    const monthlyRate = getPeriodicRate(annualRate, 12, isCanadian, isVariableRate);
    // Accelerated payments derive from the monthly payment, rounded to
    // storage precision first as the backend does
    const monthlyPayment = round4(solvePayment(principal, monthlyRate, amortizationMonths));
    const divisor = frequency === 'ACCELERATED_BIWEEKLY' ? 2 : 4;
    return round4(monthlyPayment / divisor);
  }

  const periodsPerYear = getPeriodsPerYear(frequency);
  const totalPayments = Math.round((amortizationMonths * periodsPerYear) / 12);
  const periodicRate = getPeriodicRate(annualRate, periodsPerYear, isCanadian, isVariableRate);
  return round4(solvePayment(principal, periodicRate, totalPayments));
}

/** Standard amortization payment: PMT = P * [r(1+r)^n] / [(1+r)^n - 1] */
function solvePayment(principal: number, periodicRate: number, totalPayments: number): number {
  if (totalPayments <= 0) return 0;
  if (periodicRate === 0) {
    return principal / totalPayments;
  }
  const growth = Math.pow(1 + periodicRate, totalPayments);
  return (principal * (periodicRate * growth)) / (growth - 1);
}

/**
 * Generate a period-by-period schedule. With no overpayments this reproduces
 * the reports' projection loop exactly; with a plan, extra principal is
 * applied after the regular payment each period (capped at the remaining
 * balance), shortening the schedule.
 */
export function generateLoanSchedule(input: LoanScheduleInput): LoanScheduleResult {
  const {
    startingBalance,
    annualRate,
    paymentAmount,
    frequency,
    isCanadian = false,
    isVariableRate = false,
    firstPaymentDate,
    overpayments,
    initialCumulativePrincipal = 0,
    initialCumulativeInterest = 0,
  } = input;

  const maxPayments = Math.min(
    Math.max(1, input.maxPayments ?? DEFAULT_MAX_PAYMENTS),
    HARD_MAX_PAYMENTS,
  );

  const periodsPerYear = getPeriodsPerYear(frequency);

  const rateChanges = [...(input.rateChanges ?? [])].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate),
  );
  let currentAnnualRate = annualRate;
  let currentPayment = paymentAmount;
  let currentPeriodicRate = getPeriodicRate(
    currentAnnualRate,
    periodsPerYear,
    isCanadian,
    isVariableRate,
  );
  let rateChangeIndex = 0;

  const recurringExtra = overpayments?.recurringExtra;
  const lumpSums = [...(overpayments?.lumpSums ?? [])].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  const rows: ScheduleRow[] = [];
  // Unrounded internal accumulation, matching the reports' float behaviour so
  // the refactor is numerically identical; rows are rounded on emission only.
  let balance = startingBalance;
  let cumulativePrincipal = initialCumulativePrincipal;
  let cumulativeInterest = initialCumulativeInterest;
  let totalPaid = 0;
  let totalExtraPrincipal = 0;
  let coveredInterest = true;

  let currentDate = new Date(firstPaymentDate);
  let lumpSumIndex = 0;
  let paymentNumber = 0;

  while (balance > PAYOFF_EPSILON && paymentNumber < maxPayments) {
    const rowDate = format(currentDate, 'yyyy-MM-dd');

    // Rate steps land on the first payment on or after their effective date
    // (steps dated before the first payment apply to row 1)
    while (
      rateChangeIndex < rateChanges.length &&
      rateChanges[rateChangeIndex].effectiveDate <= rowDate
    ) {
      const change = rateChanges[rateChangeIndex];
      currentAnnualRate = change.annualRate;
      currentPeriodicRate = getPeriodicRate(
        currentAnnualRate,
        periodsPerYear,
        isCanadian,
        isVariableRate,
      );
      if (change.paymentAmount != null && change.paymentAmount > 0) {
        currentPayment = change.paymentAmount;
      }
      rateChangeIndex++;
    }

    const interest = balance * currentPeriodicRate;
    let principal = currentPayment - interest;

    if (principal <= 0) {
      // Payment doesn't cover interest: the loan never amortizes
      coveredInterest = false;
      break;
    }
    if (principal > balance) {
      principal = balance;
    }
    balance = Math.max(0, balance - principal);

    let extraPrincipal = 0;
    if (
      recurringExtra &&
      recurringExtra.amount > 0 &&
      (!recurringExtra.startDate || recurringExtra.startDate <= rowDate) &&
      (!recurringExtra.endDate || rowDate <= recurringExtra.endDate)
    ) {
      extraPrincipal += recurringExtra.amount;
    }
    // Lump sums land on the first payment on or after their date (sums dated
    // before the first payment attach to row 1)
    while (lumpSumIndex < lumpSums.length && lumpSums[lumpSumIndex].date <= rowDate) {
      extraPrincipal += lumpSums[lumpSumIndex].amount;
      lumpSumIndex++;
    }
    if (extraPrincipal > balance) {
      extraPrincipal = balance;
    }
    balance = Math.max(0, balance - extraPrincipal);

    cumulativePrincipal += principal + extraPrincipal;
    cumulativeInterest += interest;
    totalPaid += principal + interest + extraPrincipal;
    totalExtraPrincipal += extraPrincipal;
    paymentNumber++;

    rows.push({
      paymentNumber,
      date: rowDate,
      payment: round2(principal + interest),
      principal: round2(principal),
      interest: round2(interest),
      extraPrincipal: round2(extraPrincipal),
      balance: round2(balance),
      annualRate: round4(currentAnnualRate),
      cumulativePrincipal: round2(cumulativePrincipal),
      cumulativeInterest: round2(cumulativeInterest),
    });

    currentDate = advanceDate(currentDate, frequency);
  }

  const paidOff = coveredInterest && balance <= PAYOFF_EPSILON;

  return {
    rows,
    payoffDate: paidOff && rows.length > 0 ? rows[rows.length - 1].date : null,
    totalInterest: round2(cumulativeInterest - initialCumulativeInterest),
    totalPaid: round2(totalPaid),
    totalExtraPrincipal: round2(totalExtraPrincipal),
    numPayments: rows.length,
    paidOff,
  };
}

/**
 * Resolve a persisted rate history into engine inputs for a schedule that
 * starts at `scheduleStartIso`: the rate in effect at the start is the
 * latest row on or before that date (before the earliest row, the earliest
 * row's rate applies; with no rows, the fallback), the payment in effect is
 * the latest non-null payment on or before the start, and the remaining
 * rows become steps for generateLoanSchedule.
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
  const startingAnnualRate =
    atOrBefore.length > 0
      ? atOrBefore[atOrBefore.length - 1].annualRate
      : (sorted[0]?.annualRate ?? fallbackAnnualRate);
  const startingPaymentAmount =
    [...atOrBefore].reverse().find((row) => row.newPaymentAmount != null)
      ?.newPaymentAmount ?? null;

  const rateChanges = sorted
    .filter((row) => row.effectiveDate > scheduleStartIso)
    .map((row) => ({
      effectiveDate: row.effectiveDate,
      annualRate: row.annualRate,
      paymentAmount: row.newPaymentAmount ?? null,
    }));

  return { startingAnnualRate, startingPaymentAmount, rateChanges };
}

export function compareSchedules(
  baseline: LoanScheduleResult,
  scenario: LoanScheduleResult,
): ScenarioComparison {
  return {
    baseline,
    scenario,
    paymentsSaved: baseline.numPayments - scenario.numPayments,
    monthsSaved: monthsBetween(scenario.payoffDate, baseline.payoffDate),
    interestSaved: round2(baseline.totalInterest - scenario.totalInterest),
  };
}

/** Whole months from `fromDate` to `toDate` (0 when either is missing) */
function monthsBetween(fromDate: string | null, toDate: string | null): number {
  if (!fromDate || !toDate) return 0;
  const from = parseIsoDateParts(fromDate);
  const to = parseIsoDateParts(toDate);
  return (to.year - from.year) * 12 + (to.month - from.month);
}

function parseIsoDateParts(isoDate: string): { year: number; month: number } {
  const [year, month] = isoDate.split('-').map(Number);
  return { year, month };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Storage precision (decimal(20,4)), matching backend roundMoney */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
