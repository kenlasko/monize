/** Statement-cycle figures returned by GET /accounts/:id/statement-cycle. */
export interface StatementCycle {
  accountId: string;
  currencyCode: string;
  cycleStart: string;
  cycleEnd: string;
  lastSettlementDate: string;
  nextSettlementDate: string;
  daysUntilSettlement: number;
  paymentDueDate: string | null;
  daysUntilPaymentDue: number | null;
  /** Ending balance of the last reconciled statement (same sign as currentBalance). */
  statementBalance: number;
  /** Date of the most recent reconciliation, or null when nothing is reconciled. */
  statementBalanceDate: string | null;
  /** Payments/credits made since the last reconciled statement (positive). */
  amountPaidSinceStatement: number;
  /**
   * Expenses (charges) incurred since the last reconciled statement (positive
   * magnitude) -- unreconciled charges not yet on a closed statement.
   */
  expensesSinceStatement: number;
  currentBalance: number;
}

/** Interest/fees charged in a range from GET /accounts/:id/interest-paid. */
export interface InterestPaid {
  amount: number;
  count: number;
}

/** A single carried-balance payoff projection (computed client-side). */
export interface PayoffScenario {
  monthlyPayment: number;
  payoffMonths: number | null;
  totalInterest: number;
  payoffDate: string | null;
  /** True when the monthly payment never covers the monthly interest. */
  neverPaysOff: boolean;
}
