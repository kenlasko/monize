/**
 * Mortgage Amortization Utility Functions
 *
 * Key differences from loan amortization:
 * - Canadian fixed-rate mortgages: semi-annual compounding (required by law),
 *   converted to the payment period by `calculateCanadianPeriodicRate`.
 * - Every other mortgage (Canadian variable-rate, US/other): the quoted rate is
 *   a *nominal annual rate compounded at the payment frequency*, so the periodic
 *   rate is `annualRate / periodsPerYear` -- see
 *   `calculateStandardPeriodicRate` for why that is the convention and not
 *   monthly compounding converted to the period.
 * - Supports additional payment frequencies including accelerated options
 * - Calculates payment amount based on amortization period
 */

import { roundMoney } from "../common/round.util";
import { paymentsToClear } from "./amortization-count.util";
import {
  MAX_DATEABLE_PAYMENTS,
  MORTGAGE_FREQUENCY_TO_RECURRENCE,
  MORTGAGE_PERIODS_PER_YEAR,
  MortgagePaymentFrequency,
  advancePaymentDates,
  unpayableEndDate,
} from "./payment-frequency.util";
import {
  MortgageType,
  amortizationMethodFor,
  compoundingFor,
} from "./mortgage-type.util";
import { assertMortgageMethodTerms } from "./mortgage-installment.util";

/**
 * The frequency type, the recurrence table and the domain conversion live in
 * `payment-frequency.util.ts`, shared with the loan helpers without the two
 * utils importing each other. Re-exported because callers have always taken
 * `MortgagePaymentFrequency` from this module.
 */
export type { MortgagePaymentFrequency } from "./payment-frequency.util";
export {
  MORTGAGE_FREQUENCY_TO_RECURRENCE,
  toMortgagePaymentFrequency,
} from "./payment-frequency.util";

export interface MortgageAmortizationInput {
  principal: number;
  annualRate: number; // As percentage (e.g., 5.5)
  amortizationMonths: number; // Total amortization period
  paymentFrequency: MortgagePaymentFrequency;
  /** The account's type, read through `mortgageTypeOf`. */
  mortgageType: MortgageType;
  startDate: Date;
}

export interface MortgageAmortizationResult {
  /** Calculated payment amount */
  paymentAmount: number;
  /** Principal portion of first payment */
  principalPayment: number;
  /** Interest portion of first payment */
  interestPayment: number;
  /** Total number of payments */
  totalPayments: number;
  /**
   * The last payment, which is the residual payoff (remaining balance plus that
   * period's interest), not another full installment. Equal to `paymentAmount`
   * only when the analytic payment count happens to be a whole number; -1 when
   * the payment never amortizes.
   *
   * Deliberately not called `finalPaymentAmount`: `LoanScheduleResult` in the
   * frontend engine already uses that name for the ending regular *installment*
   * (what a LOWER_INSTALLMENT overpayment reduced it to), and both are
   * loan-domain numbers reachable from the same component tree with the same
   * type. Two meanings under one name is a defect the compiler cannot catch.
   */
  residualPayoffAmount: number;
  /** Estimated payoff date */
  endDate: Date;
  /**
   * Total interest over the life of the mortgage: the sum of every period's
   * interest, with the final period charging only the residual payoff. Never
   * `paymentAmount * totalPayments - principal`, which bills a full installment
   * for a partial final payment. -1 when the payment never amortizes.
   */
  totalInterest: number;
  /** Effective annual rate after compounding */
  effectiveAnnualRate: number;
}

/**
 * Get payment periods per year for each frequency
 */
export function getMortgagePeriodsPerYear(
  frequency: MortgagePaymentFrequency,
): number {
  // As with the loan table: the fallback is only reachable through a cast, and
  // `periodsPerYearForStoredFrequency` is the door for a stored string.
  return MORTGAGE_PERIODS_PER_YEAR[frequency] ?? 12;
}

/**
 * Calculate the effective periodic interest rate for Canadian fixed-rate mortgages
 *
 * Canadian fixed-rate mortgages use semi-annual compounding by law.
 * Formula: r_periodic = ((1 + r_annual/2)^(2/n)) - 1
 * Where n = number of payment periods per year
 *
 * @param annualRate - Annual rate as percentage (e.g., 5.5)
 * @param periodsPerYear - Number of payment periods per year
 * @returns Periodic rate as decimal
 */
export function calculateCanadianPeriodicRate(
  annualRate: number,
  periodsPerYear: number,
): number {
  const semiAnnualRate = annualRate / 100 / 2;
  return Math.pow(1 + semiAnnualRate, 2 / periodsPerYear) - 1;
}

/**
 * Periodic rate for the nominal-rate convention: the quoted annual rate divided
 * by the number of payments per year.
 *
 * This is the convention, not an approximation of monthly compounding. A rate
 * quoted as "6% nominal, compounded at the payment frequency" costs
 * `6 / n` per period for any n, so a biweekly mortgage's periodic rate is
 * `0.06 / 26`, not `(1 + 0.06/12)^(12/26) - 1`. Both are defensible contracts
 * and they differ (the second is ~0.0000031 lower per biweekly period, about
 * 443 over a 650-payment 300k mortgage), so the choice is named here rather
 * than left to a formula: everything outside the Canadian fixed-rate branch
 * uses the nominal convention, and `calculateEffectiveAnnualRate` compounds at
 * the *payment* frequency so the displayed EAR describes this same rate.
 *
 * The Canadian fixed-rate exception is legal, not stylistic: those mortgages
 * must compound semi-annually, which `calculateCanadianPeriodicRate` converts
 * to the payment period.
 *
 * @param annualRate - Annual rate as percentage (e.g., 5.5)
 * @param periodsPerYear - Number of payment periods per year
 * @returns Periodic rate as decimal
 */
export function calculateStandardPeriodicRate(
  annualRate: number,
  periodsPerYear: number,
): number {
  return annualRate / 100 / periodsPerYear;
}

/**
 * The periodic rate for a mortgage type, by its compounding trait
 * (`compoundingFor`): `SEMI_ANNUAL` (Canadian fixed-rate, required by law)
 * converts the semi-annual rate to the payment period; `NOMINAL` divides the
 * annual rate by the payment frequency -- see calculateStandardPeriodicRate.
 */
export function getPeriodicRate(
  annualRate: number,
  periodsPerYear: number,
  type: MortgageType,
): number {
  if (compoundingFor(type) === "SEMI_ANNUAL") {
    return calculateCanadianPeriodicRate(annualRate, periodsPerYear);
  }
  return calculateStandardPeriodicRate(annualRate, periodsPerYear);
}

/**
 * Calculate mortgage payment amount using standard amortization formula
 *
 * Formula: PMT = P * [r(1+r)^n] / [(1+r)^n - 1]
 *
 * @param principal - Loan amount
 * @param periodicRate - Interest rate per period as decimal
 * @param totalPayments - Total number of payments
 * @returns Payment amount
 */
export function calculatePaymentAmount(
  principal: number,
  periodicRate: number,
  totalPayments: number,
): number {
  // Handle 0% interest
  if (periodicRate === 0) {
    return roundMoney(principal / totalPayments);
  }

  const payment =
    (principal * (periodicRate * Math.pow(1 + periodicRate, totalPayments))) /
    (Math.pow(1 + periodicRate, totalPayments) - 1);

  return roundMoney(payment);
}

/**
 * Calculate the monthly payment (used as basis for accelerated payments)
 */
function calculateMonthlyPayment(
  principal: number,
  annualRate: number,
  amortizationMonths: number,
  mortgageType: MortgageType,
): number {
  const periodicRate = getPeriodicRate(annualRate, 12, mortgageType);
  return calculatePaymentAmount(principal, periodicRate, amortizationMonths);
}

/**
 * Calculate payment amount for a specific frequency
 */
export function calculateMortgagePayment(
  input: MortgageAmortizationInput,
): number {
  const {
    principal,
    annualRate,
    amortizationMonths,
    paymentFrequency,
    mortgageType,
  } = input;

  // For accelerated payments, calculate based on monthly payment
  if (paymentFrequency === "ACCELERATED_BIWEEKLY") {
    const monthlyPayment = calculateMonthlyPayment(
      principal,
      annualRate,
      amortizationMonths,
      mortgageType,
    );
    return roundMoney(monthlyPayment / 2);
  }

  if (paymentFrequency === "ACCELERATED_WEEKLY") {
    const monthlyPayment = calculateMonthlyPayment(
      principal,
      annualRate,
      amortizationMonths,
      mortgageType,
    );
    return roundMoney(monthlyPayment / 4);
  }

  // For standard frequencies, calculate based on that frequency's periods
  const periodsPerYear = getMortgagePeriodsPerYear(paymentFrequency);
  const totalPayments = Math.round((amortizationMonths * periodsPerYear) / 12);
  const periodicRate = getPeriodicRate(
    annualRate,
    periodsPerYear,
    mortgageType,
  );

  return calculatePaymentAmount(principal, periodicRate, totalPayments);
}

/**
 * Date of the final payment, given the date of the *first* one.
 *
 * `startDate` is payment number 1 (the mortgage form labels it "First Payment
 * Date" and the account's `paymentStartDate` carries it), so a schedule of N
 * payments advances only N - 1 intervals. Advancing N put every displayed payoff
 * date -- and the linked scheduled transaction's `endDate` -- one full payment
 * period late.
 */
export function calculateMortgageEndDate(
  startDate: Date,
  frequency: MortgagePaymentFrequency,
  totalPayments: number,
): Date {
  const date = new Date(startDate);

  // Unknown, or too long to date: the far-future sentinel. A NEGATIVE count is
  // unknown too -- -1 is what calculateResidualPayoff returns for a schedule it
  // could not work out, and reading it as "at most one payment" answered with the
  // start date: a precise payoff date on a response whose every other figure says
  // it is unknown.
  if (
    !isFinite(totalPayments) ||
    totalPayments < 0 ||
    totalPayments > MAX_DATEABLE_PAYMENTS
  ) {
    return unpayableEndDate(date);
  }

  // No payments at all: there is no final payment to date, so the caller gets
  // the start date back rather than a date before it. One payment lands on the
  // start date itself.
  if (totalPayments <= 1) {
    return date;
  }
  const advances = totalPayments - 1;

  // Stepped by the recurrence engine that will post these payments, through the
  // one frequency table -- not a second calendar. See calculateEndDate for why
  // that is a requirement rather than a preference.
  return advancePaymentDates(
    date,
    MORTGAGE_FREQUENCY_TO_RECURRENCE[frequency],
    advances,
  );
}

/**
 * Effective annual rate for display: the rate the mortgage actually costs over
 * a year, compounded the way its own periodic rate is derived, by the type's
 * compounding trait (`compoundingFor`).
 *
 * For `SEMI_ANNUAL` (Canadian fixed-rate): EAR = (1 + r/2)^2 - 1 (by law).
 * For `NOMINAL` the periodic rate is `r / periodsPerYear`
 * (`calculateStandardPeriodicRate`), so the EAR compounds at the *payment*
 * frequency: EAR = (1 + r/n)^n - 1. Compounding at 12 regardless of n
 * described a rate the schedule never used -- a biweekly mortgage charges
 * `r/26` twenty-six times, not `r/12` twelve times.
 *
 * @param periodsPerYear - Payments per year, from getMortgagePeriodsPerYear
 */
export function calculateEffectiveAnnualRate(
  annualRate: number,
  periodsPerYear: number,
  type: MortgageType,
): number {
  if (compoundingFor(type) === "SEMI_ANNUAL") {
    // Semi-annual compounding
    const ear = Math.pow(1 + annualRate / 100 / 2, 2) - 1;
    return Math.round(ear * 10000) / 100; // Return as percentage with 2 decimals
  }
  // Nominal rate compounded at the payment frequency
  const ear =
    Math.pow(1 + annualRate / 100 / periodsPerYear, periodsPerYear) - 1;
  return Math.round(ear * 10000) / 100;
}

/**
 * Balance left after `payments` full installments.
 *
 *   B_k = P(1 + r)^k - A((1 + r)^k - 1) / r        (B_k = P - A*k when r = 0)
 */
function balanceAfterPayments(
  principal: number,
  periodicRate: number,
  paymentAmount: number,
  payments: number,
): number {
  if (periodicRate === 0) {
    return principal - paymentAmount * payments;
  }
  const growth = Math.pow(1 + periodicRate, payments);
  return principal * growth - (paymentAmount * (growth - 1)) / periodicRate;
}

/**
 * The last payment of a schedule, the number of payments it really takes, and
 * the lifetime interest that follows from both.
 *
 * `totalPayments` is a whole number of periods, but the payment that clears the
 * balance is almost never a full installment: an accelerated schedule's analytic
 * payoff count is fractional (`Math.ceil` rounds it up), and even a standard
 * schedule's installment is rounded to storage precision, so a remainder is left
 * over. `paymentAmount * totalPayments - principal` bills a whole installment for
 * that partial period -- 569.13 too much interest on a 25-year accelerated
 * biweekly mortgage, reported as lifetime interest under a total's label.
 *
 * So the residual is computed instead: the balance left after n-1 full
 * installments, closed out with that period's interest.
 *
 * `totalPayments` is a ceiling, not a promise. An installment large enough to
 * clear the balance sooner makes the caller's count too high, and clamping only
 * the final payment to zero while still billing n-1 installments charged
 * interest for periods the schedule never reaches (1000 at 1% paying 600 over a
 * claimed 3 periods reported 200 of interest against a true 14.10). The
 * effective count is therefore derived here and returned, so the caller can date
 * the payoff from the payment that actually happens.
 *
 * @param principal - Amount borrowed (positive)
 * @param periodicRate - Interest rate per payment period, as a decimal
 * @param paymentAmount - The regular installment
 * @param totalPayments - Whole number of payments, finite and at least 1
 * @returns The final payment, the effective payment count, and the sum of every
 *          period's interest. All three are -1 when the schedule is unknowable:
 *          a non-finite count, or an installment that never covers the interest.
 */
export function calculateResidualPayoff(
  principal: number,
  periodicRate: number,
  paymentAmount: number,
  totalPayments: number,
): {
  residualPayoffAmount: number;
  effectivePayments: number;
  totalInterest: number;
} {
  // Nothing owed is a KNOWN zero, not an unknown: a mortgage already paid off
  // reaches here through recalculateMortgageAfterRateChange with a zero balance,
  // and reporting -1 ("could not be worked out") for it would be wrong.
  if (principal === 0) {
    return { residualPayoffAmount: 0, effectivePayments: 0, totalInterest: 0 };
  }
  if (!isFinite(totalPayments) || totalPayments < 1 || principal < 0) {
    return {
      residualPayoffAmount: -1,
      effectivePayments: -1,
      totalInterest: -1,
    };
  }

  // An installment that never covers the interest has no payoff at all, so the
  // caller's finite count describes nothing. Falling back to it produced a
  // precise, enormous total for an unknowable schedule -- the inverse of
  // defaulting an unknown to zero, and worse, because the number looks measured.
  const clearing = paymentsToClear(principal, periodicRate, paymentAmount);
  if (!isFinite(clearing)) {
    return {
      residualPayoffAmount: -1,
      effectivePayments: -1,
      totalInterest: -1,
    };
  }
  // The schedule ends at whichever comes first: the caller's count, or the
  // period the installment actually clears the balance in.
  const effectivePayments = Math.max(1, Math.min(totalPayments, clearing));

  const balanceBeforeFinal = balanceAfterPayments(
    principal,
    periodicRate,
    paymentAmount,
    effectivePayments - 1,
  );
  const residualPayoffAmount = roundMoney(
    Math.max(0, balanceBeforeFinal * (1 + periodicRate)),
  );
  const totalPaid =
    paymentAmount * (effectivePayments - 1) + residualPayoffAmount;
  return {
    residualPayoffAmount,
    effectivePayments,
    totalInterest: roundMoney(totalPaid - principal),
  };
}

/**
 * The preview of a LINEAR or INTEREST_ONLY mortgage, by spec section 5.1's
 * closed forms. There are no events in a preview, so `r` is the scalar rate
 * throughout and the debt falls by exactly `c` a period:
 *
 * - LINEAR: the first installment is `c + roundMoney(P * r)` with
 *   `c = roundMoney(P / N)`; lifetime interest `roundMoney(P * r * (N + 1) / 2)`;
 *   the last payment `roundMoney((P - (N - 1) * c) * (1 + r))`, which carries
 *   the leftover of rounding `c` (decision 8).
 * - INTEREST_ONLY: every installment `roundMoney(P * r)`, principal 0; lifetime
 *   interest `roundMoney(P * r * N)`; the last payment is the bullet,
 *   `roundMoney(P * (1 + r))` (INV-LOAN-004).
 *
 * Both run `N` payments, the last on payment `N` (INV-LOAN-005).
 */
function calculateNonAnnuityAmortization(
  input: MortgageAmortizationInput,
  method: "LINEAR" | "INTEREST_ONLY",
): MortgageAmortizationResult {
  const {
    principal,
    annualRate,
    amortizationMonths,
    paymentFrequency,
    mortgageType,
    startDate,
  } = input;
  const periodsPerYear = getMortgagePeriodsPerYear(paymentFrequency);
  const periodicRate = getPeriodicRate(
    annualRate,
    periodsPerYear,
    mortgageType,
  );
  const totalPayments = Math.round((amortizationMonths * periodsPerYear) / 12);
  const interestPayment = roundMoney(principal * periodicRate);
  const effectiveAnnualRate = calculateEffectiveAnnualRate(
    annualRate,
    periodsPerYear,
    mortgageType,
  );
  const endDate = calculateMortgageEndDate(
    startDate,
    paymentFrequency,
    totalPayments,
  );

  if (method === "INTEREST_ONLY") {
    return {
      paymentAmount: interestPayment,
      principalPayment: 0,
      interestPayment,
      totalPayments,
      residualPayoffAmount: roundMoney(principal * (1 + periodicRate)),
      endDate,
      totalInterest: roundMoney(principal * periodicRate * totalPayments),
      effectiveAnnualRate,
    };
  }

  const constantPrincipal = roundMoney(principal / totalPayments);
  return {
    paymentAmount: roundMoney(constantPrincipal + interestPayment),
    principalPayment: constantPrincipal,
    interestPayment,
    totalPayments,
    residualPayoffAmount: roundMoney(
      Math.max(0, principal - (totalPayments - 1) * constantPrincipal) *
        (1 + periodicRate),
    ),
    endDate,
    totalInterest: roundMoney(
      (principal * periodicRate * (totalPayments + 1)) / 2,
    ),
    effectiveAnnualRate,
  };
}

/**
 * Calculate full mortgage amortization details.
 *
 * Branches on the type's amortization method (`amortizationMethodFor`,
 * INV-LOAN-007) before anything annuity-shaped is computed: LINEAR and
 * INTEREST_ONLY have their own closed forms, and refuse an accelerated
 * cadence or a missing term with a 400 (spec sections 5.1 and 8).
 */
export function calculateMortgageAmortization(
  input: MortgageAmortizationInput,
): MortgageAmortizationResult {
  const {
    principal,
    annualRate,
    amortizationMonths,
    paymentFrequency,
    mortgageType,
    startDate,
  } = input;

  const method = amortizationMethodFor(mortgageType);
  if (method !== "ANNUITY") {
    assertMortgageMethodTerms(mortgageType, {
      originalPrincipal: principal,
      amortizationMonths,
      paymentStartDate: startDate,
      paymentFrequency,
    });
    return calculateNonAnnuityAmortization(input, method);
  }

  // Calculate payment amount
  const paymentAmount = calculateMortgagePayment(input);

  const periodsPerYear = getMortgagePeriodsPerYear(paymentFrequency);
  const periodicRate = getPeriodicRate(
    annualRate,
    periodsPerYear,
    mortgageType,
  );

  // An accelerated schedule pays a fraction of the monthly installment on a
  // faster cadence, so its term is not the nominal amortization -- it is however
  // long that installment takes to clear the balance. Called directly rather
  // than through a `calculateAcceleratedPayments` wrapper whose whole body was
  // this line plus a second `getPeriodicRate` on the same arguments.
  const totalPayments =
    paymentFrequency === "ACCELERATED_BIWEEKLY" ||
    paymentFrequency === "ACCELERATED_WEEKLY"
      ? paymentsToClear(principal, periodicRate, paymentAmount)
      : Math.round((amortizationMonths * periodsPerYear) / 12);
  const interestPayment = roundMoney(principal * periodicRate);
  const principalPayment = roundMoney(paymentAmount - interestPayment);

  // Lifetime interest, with the last period charging only the residual payoff
  // rather than another full installment. The effective count can be lower than
  // the count above when the installment clears the balance sooner, and the
  // payoff date is taken from it so the date and the totals describe one
  // schedule rather than two.
  const { residualPayoffAmount, effectivePayments, totalInterest } =
    calculateResidualPayoff(
      principal,
      periodicRate,
      paymentAmount,
      totalPayments,
    );
  // -1 means the schedule is unknowable, and Infinity is the signal
  // calculateMortgageEndDate and createMortgageAccount's guard already
  // understand. The date function refuses a negative count on its own too, so
  // this is the explicit statement of intent rather than the only defence.
  const scheduledPayments =
    !isFinite(totalPayments) || effectivePayments < 0
      ? Infinity
      : effectivePayments;

  // Calculate end date
  const endDate = calculateMortgageEndDate(
    startDate,
    paymentFrequency,
    scheduledPayments,
  );

  // Calculate effective annual rate
  const effectiveAnnualRate = calculateEffectiveAnnualRate(
    annualRate,
    periodsPerYear,
    mortgageType,
  );

  return {
    paymentAmount,
    principalPayment: Math.max(0, principalPayment),
    interestPayment,
    totalPayments: isFinite(scheduledPayments) ? scheduledPayments : -1,
    residualPayoffAmount,
    endDate,
    totalInterest: isFinite(totalInterest) ? totalInterest : -1,
    effectiveAnnualRate,
  };
}

/**
 * Hold the routing rule in code: the two helpers below are the annuity
 * re-levelling and split, and a LINEAR or INTEREST_ONLY caller is priced
 * through `nonAnnuityInstallment` instead. A misrouted call is a programming
 * error, so it throws rather than answering with an annuity figure.
 */
function assertAnnuityMethod(helper: string, type: MortgageType): void {
  if (amortizationMethodFor(type) !== "ANNUITY") {
    throw new Error(
      `${helper} prices annuity mortgages only; a ${type} mortgage is priced through nonAnnuityInstallment`,
    );
  }
}

/**
 * Recalculate mortgage details after a rate change
 *
 * Uses current balance and remaining amortization to determine new payment.
 * The annuity re-levelling: a LINEAR or INTEREST_ONLY installment is not a
 * function of the balance and the remaining months alone (SHORTEN_TERM keeps
 * the original `c`), so the rate-change paths price those through
 * `nonAnnuityInstallment` on the dated debt instead of calling this
 * (spec section 5.3).
 */
export function recalculateMortgageAfterRateChange(
  currentBalance: number,
  newRate: number,
  remainingAmortizationMonths: number,
  paymentFrequency: MortgagePaymentFrequency,
  mortgageType: MortgageType,
): {
  paymentAmount: number;
  principalPayment: number;
  interestPayment: number;
} {
  assertAnnuityMethod("recalculateMortgageAfterRateChange", mortgageType);
  const input: MortgageAmortizationInput = {
    principal: currentBalance,
    annualRate: newRate,
    amortizationMonths: remainingAmortizationMonths,
    paymentFrequency,
    mortgageType,
    startDate: new Date(),
  };

  const result = calculateMortgageAmortization(input);

  return {
    paymentAmount: result.paymentAmount,
    principalPayment: result.principalPayment,
    interestPayment: result.interestPayment,
  };
}

/**
 * Calculate the principal/interest split for a mortgage payment based on remaining balance.
 *
 * The annuity split: the principal is what is left of a constant payment
 * after the interest. LINEAR and INTEREST_ONLY have no constant payment, so
 * payment setup prices their first installment through
 * `nonAnnuityInstallment` (spec section 5.5).
 *
 * The periodic rate follows the type's compounding (`getPeriodicRate`), so a
 * `CANADIAN_FIXED` mortgage accrues at the semi-annual conversion and every
 * other type at the nominal rate over `periodsPerYear`. Takes the count rather
 * than a mortgage cadence so a stored loan-domain spelling (quarterly, yearly)
 * reaches it through `periodsPerYearForStoredFrequency` instead of a cast.
 */
export function calculateMortgagePaymentSplit(
  remainingBalance: number,
  annualRate: number,
  paymentAmount: number,
  periodsPerYear: number,
  mortgageType: MortgageType,
): { principal: number; interest: number } {
  assertAnnuityMethod("calculateMortgagePaymentSplit", mortgageType);
  const periodicRate = getPeriodicRate(
    annualRate,
    periodsPerYear,
    mortgageType,
  );

  const interest = remainingBalance * periodicRate;
  let principal = paymentAmount - interest;

  if (principal < 0) {
    principal = 0;
  }

  if (principal > remainingBalance) {
    principal = remainingBalance;
  }

  return {
    principal: roundMoney(principal),
    interest: roundMoney(interest),
  };
}
