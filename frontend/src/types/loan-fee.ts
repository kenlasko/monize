/**
 * A fee collected with a mortgage payment (docs/specs/mortgage-fees.md): its
 * own categorized line of the scheduled payment, priced by the server for
 * each installment.
 */
export const LOAN_FEE_CALCULATIONS = [
  'FIXED',
  'PERCENT_CURRENT_BALANCE',
  'PERCENT_ORIGINAL_BALANCE',
] as const;
export type LoanFeeCalculation = (typeof LOAN_FEE_CALCULATIONS)[number];

export const LOAN_FEE_BASES = ['PER_PAYMENT', 'ANNUAL'] as const;
export type LoanFeeBasis = (typeof LOAN_FEE_BASES)[number];

/** The most fees one mortgage carries; the server refuses more. */
export const MAX_LOAN_FEES = 10;

/** A fee as the server stores and answers it. */
export interface LoanFee {
  id: string;
  categoryId: string;
  name: string;
  calculation: LoanFeeCalculation;
  basis: LoanFeeBasis;
  /** A FIXED fee's amount; null for a percentage. */
  amount: number | null;
  /** A percentage fee's rate, in percent; null for a FIXED fee. */
  rate: number | null;
  sortOrder: number;
}

/** A fee as the create and the replace send it. */
export interface LoanFeeInput {
  categoryId: string;
  name: string;
  calculation: LoanFeeCalculation;
  basis: LoanFeeBasis;
  amount?: number | null;
  rate?: number | null;
}
