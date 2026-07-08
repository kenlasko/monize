export type LoanRateChangeSource = 'manual' | 'inferred' | 'initial';

/**
 * A point on a loan/mortgage account's interest-rate timeline. 'initial'
 * rows snapshot the origination rate; 'inferred' rows come from detection
 * over payment history. A null newPaymentAmount means the payment did not
 * change with the rate.
 */
export interface LoanRateChange {
  id: string;
  accountId: string;
  /** ISO date (yyyy-MM-dd) */
  effectiveDate: string;
  /** Annual rate as a percentage, e.g. 4.9 */
  annualRate: number;
  newPaymentAmount: number | null;
  source: LoanRateChangeSource;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLoanRateChangeData {
  effectiveDate: string;
  annualRate: number;
  newPaymentAmount?: number | null;
  /** Recalculate the payment to hold remaining amortization (mortgages only) */
  recalculatePayment?: boolean;
  note?: string | null;
}

export type UpdateLoanRateChangeData = Partial<
  Omit<CreateLoanRateChangeData, 'recalculatePayment'>
>;

export interface DetectRateChangesResult {
  created: LoanRateChange[];
  /** Number of previously inferred rows replaced by this run */
  replacedCount: number;
  warnings: string[];
}
