/**
 * Mortgage Amortization Utility Functions
 *
 * Key differences from loan amortization:
 * - Canadian fixed-rate mortgages: Semi-annual compounding (required by law)
 * - Canadian variable-rate mortgages: Monthly compounding
 * - US/Other mortgages: Monthly compounding
 * - Supports additional payment frequencies including accelerated options
 * - Calculates payment amount based on amortization period
 */

export type MortgagePaymentFrequency =
  | 'MONTHLY'
  | 'SEMI_MONTHLY' // 24 payments/year (1st and 15th)
  | 'BIWEEKLY' // 26 payments/year
  | 'ACCELERATED_BIWEEKLY' // 26 payments/year, but each = monthly/2
  | 'WEEKLY' // 52 payments/year
  | 'ACCELERATED_WEEKLY'; // 52 payments/year, but each = monthly/4

export interface MortgageAmortizationInput {
  principal: number;
  annualRate: number; // As percentage (e.g., 5.5)
  amortizationMonths: number; // Total amortization period
  paymentFrequency: MortgagePaymentFrequency;
  isCanadian: boolean;
  isVariableRate: boolean;
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
  /** Estimated payoff date */
  endDate: Date;
  /** Total interest over life of mortgage */
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
  switch (frequency) {
    case 'MONTHLY':
      return 12;
    case 'SEMI_MONTHLY':
      return 24;
    case 'BIWEEKLY':
    case 'ACCELERATED_BIWEEKLY':
      return 26;
    case 'WEEKLY':
    case 'ACCELERATED_WEEKLY':
      return 52;
    default:
      return 12;
  }
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
 * Calculate standard periodic rate (monthly compounding)
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
 * Determine the correct periodic rate based on mortgage type
 */
export function getPeriodicRate(
  annualRate: number,
  periodsPerYear: number,
  isCanadian: boolean,
  isVariableRate: boolean,
): number {
  // Canadian fixed-rate mortgages use semi-annual compounding
  // Variable-rate and non-Canadian use monthly compounding
  if (isCanadian && !isVariableRate) {
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
    return Math.round((principal / totalPayments) * 100) / 100;
  }

  const payment =
    (principal *
      (periodicRate * Math.pow(1 + periodicRate, totalPayments))) /
    (Math.pow(1 + periodicRate, totalPayments) - 1);

  return Math.round(payment * 100) / 100;
}

/**
 * Calculate the monthly payment (used as basis for accelerated payments)
 */
function calculateMonthlyPayment(
  principal: number,
  annualRate: number,
  amortizationMonths: number,
  isCanadian: boolean,
  isVariableRate: boolean,
): number {
  const periodicRate = getPeriodicRate(annualRate, 12, isCanadian, isVariableRate);
  return calculatePaymentAmount(principal, periodicRate, amortizationMonths);
}

/**
 * Calculate payment amount for a specific frequency
 */
export function calculateMortgagePayment(
  input: MortgageAmortizationInput,
): number {
  const { principal, annualRate, amortizationMonths, paymentFrequency, isCanadian, isVariableRate } = input;

  // For accelerated payments, calculate based on monthly payment
  if (paymentFrequency === 'ACCELERATED_BIWEEKLY') {
    const monthlyPayment = calculateMonthlyPayment(
      principal,
      annualRate,
      amortizationMonths,
      isCanadian,
      isVariableRate,
    );
    return Math.round((monthlyPayment / 2) * 100) / 100;
  }

  if (paymentFrequency === 'ACCELERATED_WEEKLY') {
    const monthlyPayment = calculateMonthlyPayment(
      principal,
      annualRate,
      amortizationMonths,
      isCanadian,
      isVariableRate,
    );
    return Math.round((monthlyPayment / 4) * 100) / 100;
  }

  // For standard frequencies, calculate based on that frequency's periods
  const periodsPerYear = getMortgagePeriodsPerYear(paymentFrequency);
  const totalPayments = Math.round((amortizationMonths * periodsPerYear) / 12);
  const periodicRate = getPeriodicRate(annualRate, periodsPerYear, isCanadian, isVariableRate);

  return calculatePaymentAmount(principal, periodicRate, totalPayments);
}

/**
 * Calculate how many payments needed to pay off with accelerated payments
 *
 * Accelerated payments result in more payments per year than standard,
 * which reduces the amortization period.
 */
function calculateAcceleratedPayments(
  principal: number,
  annualRate: number,
  paymentAmount: number,
  periodsPerYear: number,
  isCanadian: boolean,
  isVariableRate: boolean,
): number {
  if (annualRate === 0) {
    return Math.ceil(principal / paymentAmount);
  }

  const periodicRate = getPeriodicRate(annualRate, periodsPerYear, isCanadian, isVariableRate);
  const minPayment = principal * periodicRate;

  if (paymentAmount <= minPayment) {
    return Infinity;
  }

  // Use amortization formula to find number of payments
  const numerator = -Math.log(1 - (principal * periodicRate) / paymentAmount);
  const denominator = Math.log(1 + periodicRate);

  return Math.ceil(numerator / denominator);
}

/**
 * Calculate end date based on payment frequency and count
 */
export function calculateMortgageEndDate(
  startDate: Date,
  frequency: MortgagePaymentFrequency,
  totalPayments: number,
): Date {
  const date = new Date(startDate);

  if (!isFinite(totalPayments) || totalPayments > 10000) {
    date.setFullYear(date.getFullYear() + 100);
    return date;
  }

  // Map accelerated frequencies to their base frequency for date calculation
  const baseFrequency =
    frequency === 'ACCELERATED_BIWEEKLY'
      ? 'BIWEEKLY'
      : frequency === 'ACCELERATED_WEEKLY'
        ? 'WEEKLY'
        : frequency;

  for (let i = 0; i < totalPayments; i++) {
    switch (baseFrequency) {
      case 'WEEKLY':
        date.setDate(date.getDate() + 7);
        break;
      case 'BIWEEKLY':
        date.setDate(date.getDate() + 14);
        break;
      case 'SEMI_MONTHLY':
        // Move to next semi-monthly date (1st or 15th)
        if (date.getDate() < 15) {
          date.setDate(15);
        } else {
          date.setMonth(date.getMonth() + 1);
          date.setDate(1);
        }
        break;
      case 'MONTHLY':
      default:
        date.setMonth(date.getMonth() + 1);
        break;
    }
  }

  return date;
}

/**
 * Calculate the effective annual rate for display purposes
 *
 * For Canadian fixed-rate: EAR = (1 + r/2)^2 - 1
 * For monthly compounding: EAR = (1 + r/12)^12 - 1
 */
export function calculateEffectiveAnnualRate(
  annualRate: number,
  isCanadian: boolean,
  isVariableRate: boolean,
): number {
  if (isCanadian && !isVariableRate) {
    // Semi-annual compounding
    const ear = Math.pow(1 + annualRate / 100 / 2, 2) - 1;
    return Math.round(ear * 10000) / 100; // Return as percentage with 2 decimals
  }
  // Monthly compounding
  const ear = Math.pow(1 + annualRate / 100 / 12, 12) - 1;
  return Math.round(ear * 10000) / 100;
}

/**
 * Calculate full mortgage amortization details
 */
export function calculateMortgageAmortization(
  input: MortgageAmortizationInput,
): MortgageAmortizationResult {
  const {
    principal,
    annualRate,
    amortizationMonths,
    paymentFrequency,
    isCanadian,
    isVariableRate,
    startDate,
  } = input;

  // Calculate payment amount
  const paymentAmount = calculateMortgagePayment(input);

  // Determine total payments
  const periodsPerYear = getMortgagePeriodsPerYear(paymentFrequency);
  let totalPayments: number;

  if (
    paymentFrequency === 'ACCELERATED_BIWEEKLY' ||
    paymentFrequency === 'ACCELERATED_WEEKLY'
  ) {
    // Accelerated payments pay off faster
    totalPayments = calculateAcceleratedPayments(
      principal,
      annualRate,
      paymentAmount,
      periodsPerYear,
      isCanadian,
      isVariableRate,
    );
  } else {
    totalPayments = Math.round((amortizationMonths * periodsPerYear) / 12);
  }

  // Calculate first payment split
  const periodicRate = getPeriodicRate(annualRate, periodsPerYear, isCanadian, isVariableRate);
  const interestPayment = Math.round(principal * periodicRate * 100) / 100;
  const principalPayment = Math.round((paymentAmount - interestPayment) * 100) / 100;

  // Calculate end date
  const endDate = calculateMortgageEndDate(startDate, paymentFrequency, totalPayments);

  // Calculate total interest
  const totalPaid = paymentAmount * totalPayments;
  const totalInterest = Math.round((totalPaid - principal) * 100) / 100;

  // Calculate effective annual rate
  const effectiveAnnualRate = calculateEffectiveAnnualRate(
    annualRate,
    isCanadian,
    isVariableRate,
  );

  return {
    paymentAmount,
    principalPayment: Math.max(0, principalPayment),
    interestPayment,
    totalPayments: isFinite(totalPayments) ? totalPayments : -1,
    endDate,
    totalInterest: isFinite(totalInterest) ? totalInterest : -1,
    effectiveAnnualRate,
  };
}

/**
 * Recalculate mortgage details after a rate change
 *
 * Uses current balance and remaining amortization to determine new payment
 */
export function recalculateMortgageAfterRateChange(
  currentBalance: number,
  newRate: number,
  remainingAmortizationMonths: number,
  paymentFrequency: MortgagePaymentFrequency,
  isCanadian: boolean,
  isVariableRate: boolean,
): { paymentAmount: number; principalPayment: number; interestPayment: number } {
  const input: MortgageAmortizationInput = {
    principal: currentBalance,
    annualRate: newRate,
    amortizationMonths: remainingAmortizationMonths,
    paymentFrequency,
    isCanadian,
    isVariableRate,
    startDate: new Date(),
  };

  const result = calculateMortgageAmortization(input);

  return {
    paymentAmount: result.paymentAmount,
    principalPayment: result.principalPayment,
    interestPayment: result.interestPayment,
  };
}
