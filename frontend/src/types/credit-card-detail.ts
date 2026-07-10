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
  /** Running balance as of the last settlement (same sign as currentBalance). */
  statementBalance: number;
  /** Payments/credits applied since the last settlement (positive). */
  amountPaidSinceStatement: number;
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
