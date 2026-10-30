/**
 * Loan Amortization Utility Functions
 *
 * Provides calculations for loan payment schedules, including:
 * - Principal/interest split for each payment
 * - Total number of payments
 * - End date calculation
 */

import { roundMoney } from "../common/round.util";
import { paymentsToClear } from "./amortization-count.util";
import {
  LOAN_FREQUENCY_TO_RECURRENCE,
  LOAN_PERIODS_PER_YEAR,
  MAX_DATEABLE_PAYMENTS,
  PaymentFrequency,
  advancePaymentDates,
  unpayableEndDate,
} from "./payment-frequency.util";

/**
 * Payment frequencies, the recurrence tables and the dateable ceiling live in
 * `payment-frequency.util.ts` -- shared with the mortgage helpers without the
 * two utils importing each other. Re-exported here because callers have always
 * taken `PaymentFrequency` from this module.
 */
export type { PaymentFrequency } from "./payment-frequency.util";
export {
  LOAN_FREQUENCY_TO_RECURRENCE,
  MAX_DATEABLE_PAYMENTS,
  SCHEDULED_FREQUENCY_BY_PAYMENT_FREQUENCY,
  advancePaymentDates,
} from "./payment-frequency.util";

export interface AmortizationResult {
  /** Principal portion of the current payment */
  principalPayment: number;
  /** Interest portion of the current payment */
  interestPayment: number;
  /** Balance remaining after this payment */
  remainingBalance: number;
  /** Total number of payments to pay off the loan */
  totalPayments: number;
  /** Estimated end date of the loan */
  endDate: Date;
}

export interface PaymentSplit {
  /** Principal portion of the payment */
  principal: number;
  /** Interest portion of the payment */
  interest: number;
}

/**
 * Get the number of payment periods per year based on frequency
 */
export function getPeriodsPerYear(frequency: PaymentFrequency): number {
  // The runtime fallback survives only for callers reaching this through a cast;
  // `periodsPerYearForStoredFrequency` is what a value out of the database
  // should go through, because it answers `null` instead of guessing monthly.
  return LOAN_PERIODS_PER_YEAR[frequency] ?? 12;
}

/**
 * Calculate the principal/interest split for a payment based on remaining balance
 *
 * @param remainingBalance - Current loan balance (positive number)
 * @param annualRate - Annual interest rate as percentage (e.g., 5.5 for 5.5%)
 * @param paymentAmount - Payment amount per period
 * @param frequency - Payment frequency
 * @returns The principal and interest portions of the payment
 */
export function calculatePaymentSplit(
  remainingBalance: number,
  annualRate: number,
  paymentAmount: number,
  frequency: PaymentFrequency,
): PaymentSplit {
  const periodsPerYear = getPeriodsPerYear(frequency);
  const periodicRate = annualRate / 100 / periodsPerYear;

  // Calculate interest for this period
  const interest = roundMoney(remainingBalance * periodicRate);

  // Principal is the remainder after the ROUNDED interest, so the two lines
  // sum to the payment exactly (rounding each apart drifts by 0.0001).
  let principal = roundMoney(paymentAmount - interest);

  // Handle case where payment is less than interest (shouldn't happen with valid inputs)
  if (principal < 0) {
    principal = 0;
  }

  // If principal would exceed remaining balance, cap it
  if (principal > remainingBalance) {
    principal = remainingBalance;
  }

  // Round to storage precision for currency
  return {
    principal: roundMoney(principal),
    interest,
  };
}

/**
 * Calculate the total number of payments needed to pay off a loan
 *
 * Uses the standard amortization formula:
 * n = -ln(1 - (P * r) / A) / ln(1 + r)
 *
 * Where:
 * - n = number of payments
 * - P = principal (loan amount)
 * - r = periodic interest rate
 * - A = payment amount
 *
 * @param principal - Loan amount (positive number)
 * @param annualRate - Annual interest rate as percentage
 * @param paymentAmount - Payment amount per period
 * @param frequency - Payment frequency
 * @returns Number of payments needed (rounded up)
 */
export function calculateTotalPayments(
  principal: number,
  annualRate: number,
  paymentAmount: number,
  frequency: PaymentFrequency,
): number {
  // One implementation of the count, shared with the mortgage helpers; Infinity
  // when the payment never covers the interest.
  return paymentsToClear(
    principal,
    annualRate / 100 / getPeriodsPerYear(frequency),
    paymentAmount,
  );
}

/**
 * Date of the final payment, given the date of the *first* one.
 *
 * `startDate` is payment number 1 (the loan form labels it "First Payment Date"
 * and the account's `paymentStartDate` carries it), so a schedule of N payments
 * advances only N - 1 intervals: 12 monthly payments from 2026-01-01 end on
 * 2026-12-01, not 2027-01-01. Advancing N put every displayed payoff date -- and
 * the linked scheduled transaction's `endDate` -- one full payment period late.
 *
 * The stepping is `calculateNextDueDate`, the recurrence engine that will
 * actually post those payments, rather than a second calendar of its own. That
 * is not a preference: this date's whole job is to bound the linked scheduled
 * transaction, so it has to be a date the scheduler reaches. A hand-rolled
 * semi-monthly step (1st, 15th, 1st...) against the engine's (15th, last day of
 * month...) put the final installment past its own `endDate`, and the schedule
 * posted 23 of 24 payments. It follows that month-end drift here is whatever the
 * scheduler's drift is, by construction.
 *
 * @param startDate - Date of the first payment
 * @param frequency - Payment frequency
 * @param totalPayments - Number of payments
 * @returns Date of the last payment
 */
export function calculateEndDate(
  startDate: Date,
  frequency: PaymentFrequency,
  totalPayments: number,
): Date {
  const date = new Date(startDate);

  // Handle infinite payments case. The ceiling matches `calculateMortgageEndDate`
  // and `createLoanAccount`'s own `totalPayments < 10000` guard: at 2500 a
  // perfectly ordinary 2600-payment weekly loan got a year-2126 payoff date
  // beside a reported count of 2600, so the date and the count described
  // different schedules.
  // A negative count is unknown, not "at most one payment": -1 is the sentinel
  // the amortization helpers use for a schedule they could not work out, and
  // dating from it produced a plausible payoff on the start date.
  if (
    !isFinite(totalPayments) ||
    totalPayments < 0 ||
    totalPayments > MAX_DATEABLE_PAYMENTS
  ) {
    // Return a far future date to indicate the loan won't be paid off
    return unpayableEndDate(date);
  }

  // No payments at all: there is no final payment to date, so the caller gets
  // the start date back rather than a date before it. One payment lands on the
  // start date itself.
  if (totalPayments <= 1) {
    return date;
  }

  return advancePaymentDates(
    date,
    LOAN_FREQUENCY_TO_RECURRENCE[frequency],
    totalPayments - 1,
  );
}

/**
 * Calculate full amortization details for a loan
 *
 * @param principal - Loan amount (positive number)
 * @param annualRate - Annual interest rate as percentage (e.g., 5.5 for 5.5%)
 * @param paymentAmount - Payment amount per period
 * @param frequency - Payment frequency
 * @param startDate - Date of first payment
 * @returns Full amortization details including first payment split and end date
 */
export function calculateAmortization(
  principal: number,
  annualRate: number,
  paymentAmount: number,
  frequency: PaymentFrequency,
  startDate: Date,
): AmortizationResult {
  // Calculate first payment split
  const { principal: principalPayment, interest: interestPayment } =
    calculatePaymentSplit(principal, annualRate, paymentAmount, frequency);

  // Calculate remaining balance after first payment
  const remainingBalance = Math.max(
    0,
    roundMoney(principal - principalPayment),
  );

  // Calculate total payments
  const totalPayments = calculateTotalPayments(
    principal,
    annualRate,
    paymentAmount,
    frequency,
  );

  // Calculate end date
  const endDate = calculateEndDate(startDate, frequency, totalPayments);

  return {
    principalPayment,
    interestPayment,
    remainingBalance,
    totalPayments: isFinite(totalPayments) ? totalPayments : -1, // -1 indicates infinite
    endDate,
  };
}

/**
 * Calculate the installment that amortizes a balance over a fixed number of
 * remaining periods -- the annuity `A = B*r / (1 - (1 + r)^(-n))`.
 *
 * This is the inverse of `calculateTotalPayments` (which solves for n given the
 * payment): it solves for the payment given the term. A bank recomputes this
 * for the *obniżenie raty* (lower-installment) overpayment mode, where the
 * payoff date is held fixed and the installment shrinks after an overpayment.
 *
 * @param balance - Balance to amortize (positive number)
 * @param annualRate - Annual interest rate as percentage (e.g., 5.5)
 * @param periods - Number of remaining payment periods (must be > 0)
 * @param frequency - Payment frequency
 * @returns The installment; a 0% rate splits the balance evenly
 */
export function calculatePaymentForTerm(
  balance: number,
  annualRate: number,
  periods: number,
  frequency: PaymentFrequency,
): number {
  if (balance <= 0 || periods <= 0) return 0;

  const periodicRate = annualRate / 100 / getPeriodsPerYear(frequency);
  if (periodicRate === 0) {
    return roundMoney(balance / periods);
  }
  return roundMoney(
    (balance * periodicRate) / (1 - Math.pow(1 + periodicRate, -periods)),
  );
}
