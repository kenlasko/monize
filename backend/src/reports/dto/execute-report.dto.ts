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
  value: number;
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
  // Budget variance fields (for BUDGET_VARIANCE metric)
  budgeted?: number;
  actual?: number;
}

export interface ReportTimeframe {
  startDate: string;
  endDate: string;
  label: string;
}

export interface ReportSummary {
  /**
   * Sum of `data`, or `null` when any row could not be converted into
   * {@link ReportResult.currency} -- a missing rate makes the total unknowable,
   * never smaller. `knownTotal` carries the part that did convert. The count
   * metric sums counts, which need no rate, so it is never `null`.
   */
  total: number | null;
  /**
   * Sum of `data`. Equals `total` when nothing was excluded; otherwise it is a
   * subtotal and must be labelled as one, never under "Total".
   */
  knownTotal: number;
  /** Rows counted in `data`; rows left out for want of a rate are not in it. */
  count: number;
  /** `null` with `total`: a mean over the rows that converted is not the mean. */
  average: number | null;
}

export interface ReportResult {
  reportId: string;
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
   * How many rows (or split lines) were left out for want of a rate: those
   * with none, and those of the same currency in the same group and category
   * that left with them where no other group kept them, so a refund struck on
   * a day with no rate never leaves its debit standing alone. The amounts of a
   * part with no rate could not be converted as a whole, as a built-in
   * report's group with a day no rate reaches cannot.
   */
  excludedCount: number;
  /**
   * True when the row limit cut the read short (the newest rows are the ones
   * dropped): every figure is then a subtotal and `summary.total` is `null`.
   */
  truncated: boolean;
  tableColumns?: TableColumn[];
}
