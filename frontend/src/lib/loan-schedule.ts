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
  /**
   * Whether this overpayment shortens the term (keep the installment) or lowers
   * the installment (keep the end date). Defaults to SHORTEN_TERM when omitted.
   */
  mode?: OverpaymentMode;
}

/**
 * How often a recurring overpayment is made. ONE_OFF is a single dated payment
 * (modelled as a lump sum, not a RecurringExtra); the rest recur. When an
 * overpayment cadence differs from the loan's own payment cadence, the extra is
 * approximated as an equivalent amount spread across every loan payment (e.g. a
 * weekly extra on a monthly loan is applied as extra * 52/12 each month).
 */
export type OverpaymentFrequency =
  | 'ONE_OFF'
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'MONTHLY'
  | 'QUARTERLY'
  | 'ANNUALLY';

/** Overpayments per year for each recurring frequency (ONE_OFF is not recurring). */
export function overpaymentsPerYear(frequency: OverpaymentFrequency): number {
  switch (frequency) {
    case 'WEEKLY':
      return 52;
    case 'BIWEEKLY':
      return 26;
    case 'MONTHLY':
      return 12;
    case 'QUARTERLY':
      return 4;
    case 'ANNUALLY':
      return 1;
    default:
      return 0;
  }
}

/**
 * The equivalent extra applied on every loan payment for a recurring
 * overpayment made `amount` per `frequency` (approximate model: the cadence is
 * levelled across the loan's payment periods).
 */
export function perPaymentExtraAmount(
  amount: number,
  frequency: OverpaymentFrequency,
  loanFrequency: ScheduleFrequency,
): number {
  const per = overpaymentsPerYear(frequency);
  if (per <= 0) return 0;
  return (amount * per) / getPeriodsPerYear(loanFrequency);
}

export interface RecurringExtra {
  /** Amount per `frequency` (levelled across loan payments during projection). */
  amount: number;
  /** ISO date (yyyy-MM-dd); applies from the first payment when omitted */
  startDate?: string;
  /** ISO date (yyyy-MM-dd); applies until payoff when omitted */
  endDate?: string;
  /**
   * Cadence of the overpayment. Omitted means the amount is applied on every
   * loan payment as-is (legacy "extra per payment"); a set frequency levels the
   * amount across payments (e.g. QUARTERLY spreads a quarterly amount over the
   * quarter's payments).
   */
  frequency?: OverpaymentFrequency;
  /**
   * Whether this overpayment shortens the term or lowers the installment.
   * Defaults to SHORTEN_TERM when omitted.
   */
  mode?: OverpaymentMode;
}

export interface OverpaymentPlan {
  recurringExtra?: RecurringExtra;
  lumpSums?: LumpSum[];
  /**
   * A fixed total to spend on the loan each period (installment + overpayment).
   * Modelled in the lower-installment style: every period the installment is
   * recomputed over the remaining contractual term, and the rest of the budget
   * is overpaid -- so as the installment falls the overpayment grows to keep the
   * total constant. When set, recurringExtra and lumpSums are ignored.
   */
  targetMonthlyPayment?: number;
  /**
   * How the budget's installment/overpayment split is shown. LOWER_INSTALLMENT
   * re-amortizes the installment each period (it shrinks, the overpayment
   * grows); SHORTEN_TERM (default) keeps the contractual installment fixed and
   * the overpayment constant. The balance and payoff are identical either way --
   * only the split differs.
   */
  targetMonthlyPaymentMode?: OverpaymentMode;
  /** ISO date (yyyy-MM-dd); the budget applies from the first payment when
   *  omitted. Before it, only the regular installment is paid. */
  targetMonthlyPaymentStart?: string;
  /** ISO date (yyyy-MM-dd); the budget applies until payoff when omitted. After
   *  it, the loan reverts to the regular installment. */
  targetMonthlyPaymentEnd?: string;
}

/**
 * What a bank holds fixed after an overpayment:
 * - SHORTEN_TERM (PL *skrócenie okresu*): keep the installment, pay off sooner.
 * - LOWER_INSTALLMENT (PL *obniżenie raty*): keep the end date, recompute a
 *   smaller installment that amortizes the reduced balance over the remaining
 *   periods.
 */
export type OverpaymentMode = 'SHORTEN_TERM' | 'LOWER_INSTALLMENT';

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
  /**
   * Amortize to zero over exactly this many payments, re-levelling the payment
   * each period (so it also adjusts on every rate change). Models a
   * variable-rate loan that holds its term by adjusting the installment when
   * the rate moves, so a fixed payment can neither stall nor stretch the
   * schedule. Superseded by the LOWER_INSTALLMENT overpayment mode, which
   * derives its own fixed end from the baseline.
   */
  fixedEndPeriod?: number;
  /**
   * Term (in periods) to re-level the installment toward ONLY when a rate rise
   * would push the current payment below the period's interest (a stall).
   * Unlike `fixedEndPeriod` it does not re-level every period, so a schedule can
   * follow its real recorded payment amounts and still be rescued from a stall
   * instead of stopping. Superseded by `fixedEndPeriod` (which already rescues).
   */
  rescueEndPeriod?: number;
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
  /**
   * The regular installment in effect at the end of the schedule. Equal to the
   * contractual payment for SHORTEN_TERM; the recomputed lower payment for
   * LOWER_INSTALLMENT (PL *obniżenie raty*).
   */
  finalPaymentAmount: number;
}

export interface ScenarioComparison {
  baseline: LoanScheduleResult;
  scenario: LoanScheduleResult;
  paymentsSaved: number;
  monthsSaved: number;
  interestSaved: number;
  /**
   * How much lower the scenario's ending installment is than the baseline's.
   * Zero for SHORTEN_TERM (the installment is unchanged); positive for
   * LOWER_INSTALLMENT (PL *obniżenie raty*).
   */
  installmentReduction: number;
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

/**
 * Interest accrued on `balance` over one payment period at `annualRate`. A
 * candidate installment amortizes only when it exceeds this, so it is the
 * shared guard for seeding a projection or the contractual schedule -- rejecting
 * a principal-only figure that would never reduce the balance.
 */
export function firstPeriodInterest(
  balance: number,
  annualRate: number,
  frequency: ScheduleFrequency,
  isCanadian = false,
  isVariableRate = false,
): number {
  return (
    balance *
    getPeriodicRate(annualRate, getPeriodsPerYear(frequency), isCanadian, isVariableRate)
  );
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

/**
 * Installment that amortizes `balance` over exactly `periods` payments at the
 * given rate -- the annuity `A = B*r / (1 - (1 + r)^(-n))`. This is the payment
 * a bank recomputes for the *obniżenie raty* (lower-installment) overpayment
 * mode, keeping the end date fixed. A 0% rate splits the balance evenly.
 */
export function calculatePaymentForTerm(
  balance: number,
  annualRate: number,
  periods: number,
  frequency: ScheduleFrequency,
  isCanadian = false,
  isVariableRate = false,
): number {
  if (balance <= 0 || periods <= 0) return 0;
  const periodicRate = getPeriodicRate(
    annualRate,
    getPeriodsPerYear(frequency),
    isCanadian,
    isVariableRate,
  );
  if (periodicRate === 0) return round4(balance / periods);
  return round4((balance * periodicRate) / (1 - Math.pow(1 + periodicRate, -periods)));
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
 * Fixed-total-payment ("monthly budget") schedule. Every period the whole
 * `budget` goes to the loan: the installment is recomputed over the remaining
 * contractual term (the lower-installment behaviour), and the rest of the budget
 * is overpaid. As the balance falls the installment shrinks, so the overpayment
 * grows and the total stays constant -- exactly the borrower's "I spend X per
 * month on the loan" plan. The row's `payment` is the recomputed installment and
 * `extraPrincipal` is that period's overpayment, so installment + overpayment =
 * budget. Rate steps are honoured; the loan pays off when the balance clears.
 */
export function generateBudgetSchedule(
  input: LoanScheduleInput,
  budget: number,
  mode: OverpaymentMode = 'SHORTEN_TERM',
  window: { startDate?: string; endDate?: string } = {},
): LoanScheduleResult {
  const {
    startingBalance,
    annualRate,
    paymentAmount,
    frequency,
    isCanadian = false,
    isVariableRate = false,
    firstPaymentDate,
    maxPayments,
    initialCumulativePrincipal = 0,
    initialCumulativeInterest = 0,
  } = input;

  const periodsPerYear = getPeriodsPerYear(frequency);
  const cap = Math.min(maxPayments ?? DEFAULT_MAX_PAYMENTS, HARD_MAX_PAYMENTS);

  // LOWER_INSTALLMENT re-amortizes the installment over the remaining
  // contractual term (it steps down as the balance falls); SHORTEN_TERM keeps
  // the contractual installment fixed and the overpayment constant. Either way
  // the total paid is the budget, so the balance/payoff are identical.
  const lowerInstallment = mode === 'LOWER_INSTALLMENT';
  const contractualPeriods = lowerInstallment
    ? Math.max(1, generateLoanSchedule({ ...input, overpayments: undefined }).numPayments)
    : 0;

  const rateChanges = [...(input.rateChanges ?? [])].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate),
  );

  let balance = startingBalance;
  let cumulativePrincipal = initialCumulativePrincipal;
  let cumulativeInterest = initialCumulativeInterest;
  let totalPaid = 0;
  let totalExtraPrincipal = 0;
  let coveredInterest = true;
  let currentAnnualRate = annualRate;
  let currentPeriodicRate = getPeriodicRate(
    currentAnnualRate,
    periodsPerYear,
    isCanadian,
    isVariableRate,
  );
  let rateChangeIndex = 0;
  let lastInstallment = 0;

  const rows: ScheduleRow[] = [];
  let currentDate = new Date(firstPaymentDate);
  let paymentNumber = 0;

  while (balance > PAYOFF_EPSILON && paymentNumber < cap) {
    const rowDate = format(currentDate, 'yyyy-MM-dd');
    while (
      rateChangeIndex < rateChanges.length &&
      rateChanges[rateChangeIndex].effectiveDate <= rowDate
    ) {
      currentAnnualRate = rateChanges[rateChangeIndex].annualRate;
      currentPeriodicRate = getPeriodicRate(
        currentAnnualRate,
        periodsPerYear,
        isCanadian,
        isVariableRate,
      );
      rateChangeIndex++;
    }

    const interest = balance * currentPeriodicRate;

    // The installment for the split: re-amortized over the remaining
    // contractual term (LOWER_INSTALLMENT) or the fixed contractual installment
    // (SHORTEN_TERM). The overpayment is whatever is left of the budget.
    const installment = lowerInstallment
      ? calculatePaymentForTerm(
          balance,
          currentAnnualRate,
          Math.max(1, contractualPeriods - paymentNumber),
          frequency,
          isCanadian,
          isVariableRate,
        )
      : paymentAmount;

    // The budget only tops up within its window; outside it (before the start
    // or after the end) the loan pays just the regular installment.
    const budgetActive =
      (!window.startDate || window.startDate <= rowDate) &&
      (!window.endDate || rowDate <= window.endDate);
    // Total cash this period: the budget while active, else the installment --
    // capped at the payoff amount on the final period.
    const totalDue = balance + interest;
    const payment = Math.min(budgetActive ? budget : installment, totalDue);
    // A payment that can't cover the interest never amortizes.
    if (payment <= interest) {
      coveredInterest = false;
      break;
    }
    // The installment can't exceed the total actually paid this period.
    const regularInstallment = Math.min(installment, payment);
    const regularPrincipal = Math.max(0, regularInstallment - interest);
    const overpayment = Math.max(0, payment - regularInstallment);

    balance = Math.max(0, balance - (regularPrincipal + overpayment));
    cumulativePrincipal += regularPrincipal + overpayment;
    cumulativeInterest += interest;
    totalPaid += payment;
    totalExtraPrincipal += overpayment;
    lastInstallment = regularInstallment;
    paymentNumber++;

    rows.push({
      paymentNumber,
      date: rowDate,
      payment: round2(regularPrincipal + interest),
      principal: round2(regularPrincipal),
      interest: round2(interest),
      extraPrincipal: round2(overpayment),
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
    finalPaymentAmount: round2(lastInstallment),
  };
}

/**
 * Generate a period-by-period schedule. With no overpayments this reproduces
 * the reports' projection loop exactly; with a plan, extra principal is
 * applied after the regular payment each period (capped at the remaining
 * balance), shortening the schedule.
 */
export function generateLoanSchedule(input: LoanScheduleInput): LoanScheduleResult {
  const budget = input.overpayments?.targetMonthlyPayment;
  if (budget && budget > 0) {
    return generateBudgetSchedule(
      input,
      budget,
      input.overpayments?.targetMonthlyPaymentMode ?? 'SHORTEN_TERM',
      {
        startDate: input.overpayments?.targetMonthlyPaymentStart,
        endDate: input.overpayments?.targetMonthlyPaymentEnd,
      },
    );
  }
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

  // Each overpayment carries its own mode; SHORTEN_TERM is the default for
  // those that omit one.
  const modeOf = (m?: OverpaymentMode): OverpaymentMode => m ?? 'SHORTEN_TERM';
  const hasOverpayments = Boolean(
    overpayments?.recurringExtra || (overpayments?.lumpSums?.length ?? 0) > 0,
  );
  const anyLowerOverpayment =
    hasOverpayments &&
    ((overpayments?.recurringExtra != null &&
      modeOf(overpayments.recurringExtra.mode) === 'LOWER_INSTALLMENT') ||
      (overpayments?.lumpSums ?? []).some((l) => modeOf(l.mode) === 'LOWER_INSTALLMENT'));

  // Two re-levelling ends. `reLevelEveryPeriod` (a passed fixedEndPeriod) holds
  // a variable-rate contractual schedule on its term every period. `lowerEnd`
  // is the no-overpayment payoff length that a LOWER_INSTALLMENT overpayment
  // re-levels the installment toward -- applied only in the period such an
  // overpayment lands, so SHORTEN_TERM overpayments keep the installment (and
  // shorten the term) alongside it.
  const reLevelEveryPeriod = input.fixedEndPeriod ?? null;
  const lowerEnd =
    reLevelEveryPeriod === null && anyLowerOverpayment
      ? generateLoanSchedule({ ...input, overpayments: undefined }).numPayments
      : null;
  // Term to re-level toward if a rate rise would otherwise stall the payment.
  // An explicit `rescueEndPeriod` supplies this rescue without the every-period
  // re-levelling of `fixedEndPeriod`, so a contractual schedule keeps following
  // its real recorded payments and only re-levels to avoid a stall.
  const rescueEnd = reLevelEveryPeriod ?? input.rescueEndPeriod ?? lowerEnd;

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
  // How the recurring extra lands on the schedule:
  // - no frequency (legacy): the amount on every payment.
  // - frequency at least as frequent as the loan's payments (e.g. weekly on a
  //   monthly loan): levelled to an equivalent amount on every payment.
  // - frequency sparser than the loan's payments (e.g. quarterly on a monthly
  //   loan): the full amount as a real overpayment every Nth payment, so a
  //   sparse cadence genuinely pays down less than the same total spread out.
  const overPerYear = recurringExtra?.frequency
    ? overpaymentsPerYear(recurringExtra.frequency)
    : 0;
  const recurringIsSparse = overPerYear > 0 && overPerYear < periodsPerYear;
  const recurringInterval = recurringIsSparse
    ? Math.max(1, Math.round(periodsPerYear / overPerYear))
    : 1;
  const recurringPerHit = recurringExtra
    ? recurringIsSparse
      ? recurringExtra.amount
      : recurringExtra.frequency
        ? perPaymentExtraAmount(recurringExtra.amount, recurringExtra.frequency, frequency)
        : recurringExtra.amount
    : 0;
  let recurringHits = 0;
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

    if (principal <= 0 && rescueEnd !== null) {
      // Holding a fixed term: a rate rise can push the current installment
      // below the interest for a period. Re-level it now, at the new rate, to
      // amortize the remaining balance over the periods left -- so the schedule
      // adjusts on the rate change instead of stalling.
      const remaining = rescueEnd - paymentNumber;
      if (remaining > 0) {
        currentPayment = calculatePaymentForTerm(
          balance,
          currentAnnualRate,
          remaining,
          frequency,
          isCanadian,
          isVariableRate,
        );
        principal = currentPayment - interest;
      }
    }

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
    // Whether a LOWER_INSTALLMENT-mode overpayment landed this period, so the
    // installment is re-levelled below (SHORTEN_TERM ones leave it unchanged).
    let lowerApplied = false;
    if (
      recurringExtra &&
      recurringPerHit > 0 &&
      (!recurringExtra.startDate || recurringExtra.startDate <= rowDate) &&
      (!recurringExtra.endDate || rowDate <= recurringExtra.endDate)
    ) {
      // Dense/levelled cadences hit every in-window payment (interval 1); a
      // sparse cadence lands on the first in-window payment and every Nth after.
      if (recurringHits % recurringInterval === 0) {
        extraPrincipal += recurringPerHit;
        if (modeOf(recurringExtra.mode) === 'LOWER_INSTALLMENT') lowerApplied = true;
      }
      recurringHits++;
    }
    // Lump sums land on the first payment on or after their date (sums dated
    // before the first payment attach to row 1)
    while (lumpSumIndex < lumpSums.length && lumpSums[lumpSumIndex].date <= rowDate) {
      extraPrincipal += lumpSums[lumpSumIndex].amount;
      if (modeOf(lumpSums[lumpSumIndex].mode) === 'LOWER_INSTALLMENT') lowerApplied = true;
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

    // Re-level the installment to amortize the remaining balance over the
    // periods left to the target end. `reLevelEveryPeriod` (contractual
    // variable-rate schedule) re-levels every period, so it also tracks rate
    // changes; a LOWER_INSTALLMENT overpayment re-levels toward `lowerEnd`
    // only in the period it lands, stepping the payment down while
    // SHORTEN_TERM overpayments leave it unchanged (shortening the term).
    const reLevelEnd =
      reLevelEveryPeriod !== null ? reLevelEveryPeriod : lowerApplied ? lowerEnd : null;
    if (reLevelEnd !== null) {
      const remaining = reLevelEnd - paymentNumber;
      if (remaining > 0 && balance > PAYOFF_EPSILON) {
        currentPayment = calculatePaymentForTerm(
          balance,
          currentAnnualRate,
          remaining,
          frequency,
          isCanadian,
          isVariableRate,
        );
      }
    }

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
    finalPaymentAmount: round2(currentPayment),
  };
}

/**
 * The annual rate (percentage) in effect on a given date: the latest row with
 * `effectiveDate <= date`, else the earliest row's rate (a date before the
 * first recorded change still amortizes at the origination rate), else the
 * fallback. Shared by the schedule table (per-row historical rate) and
 * `buildRateTimeline`'s starting rate.
 */
export function effectiveAnnualRateOn(
  rows: RateTimelineRow[],
  dateIso: string,
  fallbackAnnualRate: number,
): number {
  const sorted = [...rows].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate),
  );
  const atOrBefore = sorted.filter((row) => row.effectiveDate <= dateIso);
  if (atOrBefore.length > 0) {
    return atOrBefore[atOrBefore.length - 1].annualRate;
  }
  return sorted[0]?.annualRate ?? fallbackAnnualRate;
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
  const startingAnnualRate = effectiveAnnualRateOn(
    rows,
    scheduleStartIso,
    fallbackAnnualRate,
  );
  // Mirror the rate's "before the earliest row, the earliest row applies"
  // fallback for the payment: a schedule starting shortly before the first
  // recorded row (payment_start_date precedes the first installment, which is
  // where detection dates the initial row) still starts at the origination
  // installment that row records. Only the earliest row is consulted -- later
  // rows describe later rate levels and become steps anyway.
  const startingPaymentAmount =
    [...atOrBefore].reverse().find((row) => row.newPaymentAmount != null)
      ?.newPaymentAmount ??
    (atOrBefore.length === 0 ? sorted[0]?.newPaymentAmount ?? null : null);

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
    installmentReduction: round2(
      baseline.finalPaymentAmount - scenario.finalPaymentAmount,
    ),
  };
}

/** Whole months from `fromDate` to `toDate` (0 when either is missing) */
export function monthsBetween(fromDate: string | null, toDate: string | null): number {
  if (!fromDate || !toDate) return 0;
  const from = parseIsoDateParts(fromDate);
  const to = parseIsoDateParts(toDate);
  return (to.year - from.year) * 12 + (to.month - from.month);
}

function parseIsoDateParts(isoDate: string): { year: number; month: number } {
  const [year, month] = isoDate.split('-').map(Number);
  return { year, month };
}

/** Round to 2 decimals (cents), avoiding floating-point drift. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Storage precision (decimal(20,4)), matching backend roundMoney */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
