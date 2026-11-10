/**
 * Payroll deduction rules, mirrored from
 * `backend/src/payroll-deductions/` (docs/specs/payroll-deductions.md).
 *
 * Every amount is a magnitude in the bill's account currency. `paidToDate`
 * is the server's reading of the ledger for the period containing today and
 * is never recomputed here; `remaining` is the room left under the maximum.
 */

export const PAYROLL_RESET_PERIODS = ['YEARLY'] as const;
export type PayrollResetPeriod = (typeof PAYROLL_RESET_PERIODS)[number];

/** Where the expected amount came from: the bill's own line, the user, or nowhere. */
export type ExpectedSource = 'line' | 'entered' | null;

/** The next period's figures beside the current ones (spec section 11.4). */
export interface PayrollDeductionNextPeriod {
  /** The first day of the next period: the current period's `nextResetOn`. */
  periodStart: string;
  yearlyMaximum: number;
  expectedPerPaycheque: number | null;
  expectedSource: ExpectedSource;
  /** The next period has figures of its own, not the current ones carried. */
  scheduled: boolean;
}

/** The figures a rule carries on every surface (spec section 5.3). */
export interface PayrollDeductionFigures {
  /** The current period's maximum. */
  yearlyMaximum: number;
  periodStart: string;
  periodEnd: string;
  nextResetOn: string;
  paidToDate: number;
  remaining: number;
  /** Rows of the category in the period in another currency, not converted. */
  foreignCurrencyRows: number;
  currencyCode: string;
  /** `null` when neither a line nor an entered value gives one. */
  expectedPerPaycheque: number | null;
  expectedSource: ExpectedSource;
  /** Absent from an older backend, which kept one figure for every period. */
  nextPeriod?: PayrollDeductionNextPeriod;
}

/** One rule as `GET /payroll-deductions` answers it. */
export interface PayrollDeductionRule extends PayrollDeductionFigures {
  id: string;
  userId: string;
  scheduledTransactionId: string;
  scheduledTransactionName: string;
  categoryId: string;
  categoryName: string;
  resetPeriod: PayrollResetPeriod;
  resetDate: string;
  createdAt: string;
  updatedAt: string;
}

/** The field every scheduled bill carries (`ScheduledTransaction.payrollDeductions`). */
export interface ScheduledPayrollDeduction extends PayrollDeductionFigures {
  ruleId: string;
  categoryId: string;
  categoryName: string;
  /** The anchor the periods are anniversaries of; absent from an older backend. */
  resetDate?: string;
}

/** `GET /payroll-deductions/history`: one category's closed periods, newest first. */
export interface PayrollDeductionHistory {
  categoryId: string;
  categoryName: string;
  currencyCode: string;
  periods: {
    periodStart: string;
    periodEnd: string;
    paidToDate: number;
    foreignCurrencyRows: number;
  }[];
}

export interface CreatePayrollDeductionRuleData {
  scheduledTransactionId: string;
  categoryId: string;
  yearlyMaximum: number;
  resetPeriod?: PayrollResetPeriod;
  resetDate: string;
  expectedPerPaycheque?: number | null;
  /** The next period's maximum; `null` drops its own figures (spec section 11). */
  nextYearlyMaximum?: number | null;
  nextExpectedPerPaycheque?: number | null;
}

export type UpdatePayrollDeductionRuleData = Partial<CreatePayrollDeductionRuleData>;

/** One category of a batch: what differs per deduction line of the bill. */
export interface PayrollDeductionLineData {
  categoryId: string;
  yearlyMaximum: number;
  expectedPerPaycheque?: number | null;
  nextYearlyMaximum?: number | null;
  nextExpectedPerPaycheque?: number | null;
}

/** The most categories one batch names (`PAYROLL_BATCH_MAX_LINES` on the server). */
export const PAYROLL_BATCH_MAX_LINES = 50;

/**
 * `POST /payroll-deductions/batch`: several categories of one bill sharing a
 * reset, written in one transaction so a refused line leaves nothing behind.
 */
export interface CreatePayrollDeductionRulesData {
  scheduledTransactionId: string;
  resetPeriod?: PayrollResetPeriod;
  resetDate: string;
  lines: PayrollDeductionLineData[];
}

/**
 * `GET /payroll-deductions/suggest`: the bill's own line, else the magnitude
 * the category's deduction rows most often carry over the last year.
 */
export interface ExpectedAmountSuggestion {
  expectedPerPaycheque: number | null;
  expectedSource: 'line' | 'ledger' | null;
  /**
   * The maximum the ledger suggests: the last full period's total, or the
   * current period's when that is already higher; `null` when nothing was
   * collected or no reset date was sent.
   */
  yearlyMaximum: number | null;
  yearlyMaximumSource: 'previousPeriod' | 'currentPeriod' | 'currentPeriodCapped' | null;
}

/** One period's collected total for one category of the report, in its currency. */
export interface PayrollReportPeriodTotal {
  periodStart: string;
  periodEnd: string;
  paidToDate: number;
  /** Rows of the category in the period in another currency, not converted. */
  foreignCurrencyRows: number;
  /** Transactions that deducted to the category in the period. */
  paycheques: number;
  /** `null` when no paycheque deducted. */
  averagePerPaycheque: number | null;
  /** The period contains today, so its total is still growing. */
  isCurrent: boolean;
}

/** The selected year's period of one category, with the rule's ceiling beside it. */
export interface PayrollReportCategorySummary extends PayrollReportPeriodTotal {
  /** The binding maximum; `null` for a closed period, whose own maximum was never stored. */
  yearlyMaximum: number | null;
  remaining: number | null;
  percentOfMaximum: number | null;
  /** The date of the paycheque that brought the total to the maximum. */
  maximumReachedOn: string | null;
}

export interface PayrollReportCategory {
  /** `categoryId|currencyCode`, the key of `PayrollReportPaycheque.amounts`. */
  key: string;
  categoryId: string;
  categoryName: string;
  currencyCode: string;
  resetDate: string;
  billNames: string[];
  summary: PayrollReportCategorySummary;
  /** Every period the ledger holds for the category, newest first. */
  history: PayrollReportPeriodTotal[];
}

export interface PayrollReportPaycheque {
  transactionId: string;
  transactionDate: string;
  payeeName: string | null;
  currencyCode: string;
  /** Deducted magnitude by category key; a category it did not deduct is absent. */
  amounts: Record<string, number>;
  total: number;
}

/** `GET /payroll-deductions/report?year=` (docs/specs/payroll-deductions.md section 10). */
export interface PayrollDeductionReport {
  year: number;
  /** Newest first. */
  availableYears: number[];
  categories: PayrollReportCategory[];
  /** The selected year's paycheques, oldest first. */
  paycheques: PayrollReportPaycheque[];
  /** `null` when the categories span currencies, which are not added together. */
  total: number | null;
  totalCurrencyCode: string | null;
}
