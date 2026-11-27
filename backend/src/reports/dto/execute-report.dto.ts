import { IsOptional, IsDateString, IsEnum } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { TimeframeType, TableColumn } from "../entities/custom-report.entity";

export class ExecuteReportDto {
  @ApiPropertyOptional({
    description: "Override timeframe type",
    enum: TimeframeType,
  })
  @IsOptional()
  @IsEnum(TimeframeType)
  timeframeType?: TimeframeType;

  @ApiPropertyOptional({ description: "Override start date (YYYY-MM-DD)" })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: "Override end date (YYYY-MM-DD)" })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

// Response interfaces
export interface AggregatedDataPoint {
  label: string;
  /**
   * The figure in {@link ReportResult.currency}. `null` only on a listed
   * transaction (metric NONE, no grouping) with no rate into it on its date:
   * the row stays listed under its own `accountAmount` so it can be matched
   * against a statement, and is in no total (`excludedCount` counts it).
   */
  value: number | null;
  id?: string;
  color?: string;
  percentage?: number;
  count?: number;
  // Transaction-specific fields (for no-aggregation mode)
  date?: string;
  payee?: string;
  description?: string;
  memo?: string;
  category?: string;
  account?: string;
  /** The row's own tags (and, for a split line, its own plus the parent's), joined for display. */
  tags?: string;
  /**
   * The row's own amount in its account's currency, unconverted, signed as
   * `value` is; `accountCurrency` names its currency. A column of these holds
   * several currencies, so it has no total.
   */
  accountAmount?: number;
  accountCurrency?: string;
  /**
   * What a row entered in a foreign currency was entered as, unconverted and
   * signed as `value` is; `originalCurrency` names its currency. Absent on an
   * ordinary row and on a split line. A column of these has no total.
   */
  originalAmount?: number;
  originalCurrency?: string;
  /**
   * Under a transfer measure, a part of this group was left out for want of a
   * rate: the figure is partial and is labelled so. Absent otherwise.
   */
  incomplete?: true;
  /** The known part of a group whose `value` is withheld (`incomplete`). */
  knownValue?: number;
  // Budget variance fields (for BUDGET_VARIANCE metric)
  budgeted?: number;
  actual?: number;
}

/**
 * A data point whose value is known: every grouped point is, since a group's
 * sum leaves a row with no rate out rather than listing it.
 */
export type KnownDataPoint = AggregatedDataPoint & { value: number };

export interface ReportTimeframe {
  startDate: string;
  endDate: string;
  label: string;
}

export interface ReportSummary {
  /**
   * The report's total, rounded once from the underlying sums. Under a signed
   * tag total each component contributes once even if several tag rows show it.
   * For disjoint groups the figure is the sum before row-level rounding (so it
   * can sit a ten-thousandth from the sum of the rounded values,
   * docs/specs/report-rounding-and-aggregation.md rule 4), or `null` when any
   * row could not be converted into {@link ReportResult.currency} -- a missing
   * rate makes the total unknowable, never smaller. `knownTotal` carries the
   * part that did convert. The count metric sums counts, which need no rate,
   * so it is `null` only for a truncated read.
   */
  total: number | null;
  /**
   * The known part of the same report population, rounded once. Equals `total` when
   * nothing was excluded; otherwise it is a subtotal and must be labelled as
   * one, never under "Total".
   */
  knownTotal: number;
  /**
   * Rows counted in the report population (once across overlapping tags for
   * signed totals); rows left out for want of a rate are not in it,
   * except on a transaction list, which lists them with a `null` value.
   */
  count: number;
  /** `null` with `total`: a mean over the rows that converted is not the mean. */
  average: number | null;
  /**
   * How many provisional transfer amounts (`amountIsProvisional`: Monize's
   * estimate until the other account's file is imported or the amount is
   * confirmed) are inside `total` / `knownTotal`. The figures include them;
   * nothing is withheld for it. A row left out for want of a rate is not
   * counted, and the count metric, which sums no amount, is always 0.
   */
  provisionalCount: number;
}

export interface ReportResult {
  reportId: string;
  /** Present for aggregates computed from signed postings, including average numerators. */
  signedTotal?: true;
  name: string;
  viewType: string;
  groupBy: string;
  timeframe: ReportTimeframe;
  data: AggregatedDataPoint[];
  summary: ReportSummary;
  /** Reporting currency every money figure in `data` and `summary` is in. */
  currency: string;
  /**
   * Source currencies with no usable rate into {@link currency}, so their rows
   * are in none of the figures. Empty when the report is complete.
   */
  missingCurrencies: string[];
  /**
   * Rows (or split lines) excluded because a rate was missing. Signed TOTAL_AMOUNT
   * excludes the incomplete category/currency across every display group and
   * counts each affected component once. Other metrics retain their group-level
   * conversion policy.
   */
  excludedCount: number;
  /** {@link ReportSummary.provisionalCount}, beside the other completeness fields. */
  provisionalCount: number;
  /**
   * True when the row limit cut the read short (the newest rows are the ones
   * dropped): every figure is then a subtotal and `summary.total` is `null`.
   */
  truncated: boolean;
  tableColumns?: TableColumn[];
}
