import type { ReportingProvenance } from "../../accruals/reporting-provenance";
import type { ReportingBasis } from "../../accruals/reporting-basis";
import { IsOptional, IsDateString, IsEnum, IsIn } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { TimeframeType, TableColumn } from "../entities/custom-report.entity";

export class ExecuteReportDto {
  @ApiPropertyOptional({ enum: ["cash", "accrual"] })
  @IsOptional()
  @IsIn(["cash", "accrual"])
  basis?: ReportingBasis;

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
  reportingProvenance?: ReportingProvenance;
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
  basis?: ReportingBasis;
  fxComplete?: boolean;
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
  /** How many rows (or split lines) were left out for want of a rate. */
  excludedCount: number;
  tableColumns?: TableColumn[];
}
