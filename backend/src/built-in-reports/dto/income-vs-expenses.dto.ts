import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * One month of the Cash Flow report, which buckets by month and nothing else.
 * Income vs Expenses answers at a granularity its caller chooses and uses
 * {@link IncomeExpensePeriodItem}.
 */
export class MonthlyIncomeExpenseItem {
  @ApiProperty({ example: "2024-01" })
  month: string;

  @ApiProperty({ example: 5000.0 })
  income: number;

  @ApiProperty({ example: 3500.0 })
  expenses: number;

  @ApiProperty({ example: 1500.0 })
  net: number;
}

/** One bar of Income vs Expenses: a month or a week, with the dates it covers. */
export class IncomeExpensePeriodItem {
  /** `YYYY-MM` for a month bucket, the week's first day for a week bucket. */
  @ApiProperty({ example: "2024-01" })
  period: string;

  /** First day the bar covers, inclusive. */
  @ApiProperty({ example: "2024-01-01" })
  periodStart: string;

  /** Last day the bar covers, inclusive. Drill-downs use the pair as-is. */
  @ApiProperty({ example: "2024-01-31" })
  periodEnd: string;

  /**
   * Money in over the period, in {@link IncomeVsExpensesResponse.currency}.
   * Rows that could not be converted are in none of the figures, so when
   * `missingCurrencies` is non-empty this is the part that converted.
   */
  @ApiProperty({ example: 5000.0 })
  income: number;

  @ApiProperty({ example: 3500.0 })
  expenses: number;

  @ApiProperty({ example: 1500.0 })
  net: number;
}

/**
 * One bar of a tag-key bucket: the categorized figures plus the tagged
 * transfer flows that fell in the period (INV-REPORT-003). The flows are never
 * part of `income`, `expenses` or `net` (I2).
 */
export class IncomeExpenseTagPeriodItem extends IncomeExpensePeriodItem {
  /** Tagged transfer legs in this period, positive side; zero when none. */
  @ApiProperty({ example: 1000.0 })
  taggedInflows: number;

  /** Tagged transfer legs in this period, negative side, as a positive magnitude. */
  @ApiProperty({ example: 1000.0 })
  taggedOutflows: number;

  /**
   * The period's Balance with this bucket's flows: the All figure's income +
   * taggedInflows - the All figure's expenses - taggedOutflows, the four
   * aggregates folded before it is read; the known part while a row was left
   * out.
   */
  @ApiProperty({ example: 500.0 })
  balance: number;

  /**
   * The balance over income + taggedInflows in percent, two places, divided
   * from the unrounded figures; `null` when nothing came in.
   */
  @ApiProperty({ example: 12.5, nullable: true })
  balancePercent: number | null;
}

export class IncomeExpenseTotals {
  /**
   * Total money in over the window, or `null` when a row could not be
   * converted -- a missing rate makes the total unknowable, never smaller.
   */
  @ApiProperty({ example: 60000.0, nullable: true })
  income: number | null;

  @ApiProperty({ example: 42000.0, nullable: true })
  expenses: number | null;

  @ApiProperty({ example: 18000.0, nullable: true })
  net: number | null;

  /**
   * The part that did convert. Equals the field above it when nothing was
   * excluded; otherwise a subtotal, to be labelled as one and never shown under
   * a caption that says "Total".
   */
  @ApiProperty({ example: 60000.0 })
  knownIncome: number;

  @ApiProperty({ example: 42000.0 })
  knownExpenses: number;

  @ApiProperty({ example: 18000.0 })
  knownNet: number;
}

/**
 * The reserved id of the "untagged" value bucket (`docs/specs/report-tag-key-breakdown.md`
 * section 1.1, rule B2): rows carrying no `K:*` tag for the requested key. Not
 * a value a user can create -- the frontend renders it from
 * `reports.tagBreakdown.untagged` rather than showing this id.
 */
export const UNTAGGED_TAG_BUCKET_ID = "__untagged__";

/**
 * One value bucket of a tag-key breakdown (Income vs Expenses / Cash Flow
 * only carry `taggedInflows`/`taggedOutflows`; section 4 of the spec).
 *
 * `data`/`totals`/`missingCurrencies`/`excludedCount` are computed through the
 * exact same per-currency conversion and completeness path as the top-level
 * (All) figures (I4): one bucket's missing rate never blanks another's.
 */
export class IncomeExpenseTagBucket {
  /** The tag's value, or {@link UNTAGGED_TAG_BUCKET_ID} for the reserved bucket. */
  @ApiProperty({ example: "household" })
  value: string;

  /** True only for the reserved untagged bucket. */
  @ApiProperty({ example: false })
  isUntagged: boolean;

  @ApiProperty({ type: [IncomeExpenseTagPeriodItem] })
  data: IncomeExpenseTagPeriodItem[];

  @ApiProperty({ type: IncomeExpenseTotals })
  totals: IncomeExpenseTotals;

  /**
   * Window total of the per-period `taggedInflows` in `data` (their sum, by
   * construction). Transfer legs carrying this bucket's value, positive side (INV-REPORT-003).
   * Never folded into `income`, `expenses` or `net` -- a transfer is never
   * income (I2). The part that converted; see `missingCurrencies` below.
   */
  @ApiProperty({ example: 1000.0 })
  taggedInflows: number;

  /** Transfer legs carrying this bucket's value, negative side, as a positive magnitude. */
  @ApiProperty({ example: 1000.0 })
  taggedOutflows: number;

  /**
   * Source currencies with no usable rate into the report's currency, across
   * both this bucket's categorized rows and its tagged transfer legs.
   */
  @ApiProperty({ type: [String], example: [] })
  missingCurrencies: string[];

  /** How many aggregate rows this bucket left out, by any cause. */
  @ApiProperty({ example: 0 })
  excludedCount: number;
}

export class IncomeVsExpensesResponse {
  /**
   * Every bucket in the window, in order, including the ones nothing happened
   * in -- a week with no activity earned and spent zero, which is a bar of
   * height zero rather than a gap the chart closes up.
   */
  @ApiProperty({ type: [IncomeExpensePeriodItem] })
  data: IncomeExpensePeriodItem[];

  @ApiProperty({ type: IncomeExpenseTotals })
  totals: IncomeExpenseTotals;

  /** Reporting currency every figure above is expressed in. */
  @ApiProperty({ example: "CAD" })
  currency: string;

  /**
   * Source currencies with no usable rate into {@link currency}, so their rows
   * are in none of the figures above. Empty when the report is complete.
   */
  @ApiProperty({ type: [String], example: ["JPY"] })
  missingCurrencies: string[];

  /** How many aggregate rows were left out, by any cause. */
  @ApiProperty({ example: 0 })
  excludedCount: number;

  /**
   * The tag key the caller asked to break the report down by. Present only
   * when the request carried `tagKey` (I1: absent otherwise, not `null`).
   */
  @ApiPropertyOptional({ example: "scope" })
  tagKey?: string;

  /**
   * One bucket per discovered value of `tagKey`, plus the reserved untagged
   * bucket ({@link UNTAGGED_TAG_BUCKET_ID}). Present only when `tagKey` was
   * supplied; the fields above keep describing the unpartitioned (All) figure,
   * so a client ignoring this field still renders today's report.
   */
  @ApiPropertyOptional({ type: [IncomeExpenseTagBucket] })
  buckets?: IncomeExpenseTagBucket[];
}
