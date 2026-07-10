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

/**
 * Before/after summary of how a mortgage's linked scheduled bill payment would
 * change to match a newly recorded rate/payment. Present on a create response
 * when the account has an applicable linked scheduled payment; the user is
 * asked for permission before it is applied.
 */
export interface ScheduledPaymentPreview {
  scheduledTransactionId: string;
  scheduledTransactionName: string | null;
  currencyCode: string;
  currentPaymentAmount: number | null;
  proposedPaymentAmount: number;
  currentPrincipal: number | null;
  proposedPrincipal: number;
  currentInterest: number | null;
  proposedInterest: number;
  extraPrincipal: number;
}

/** A created rate change plus the pending scheduled-payment change, if any. */
export interface CreateLoanRateChangeResult extends LoanRateChange {
  scheduledPaymentPreview: ScheduledPaymentPreview | null;
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
