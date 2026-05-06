import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";

export const INTRADAY_RANGES = ["1d", "1w", "1m"] as const;
export type IntradayRangeKey = (typeof INTRADAY_RANGES)[number];

export class IntradayValueQueryDto {
  @ApiProperty({ enum: INTRADAY_RANGES })
  @IsIn(INTRADAY_RANGES as unknown as string[])
  range: IntradayRangeKey;

  @ApiProperty({
    required: false,
    description: "Comma-separated account IDs to filter by",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  accountIds?: string;

  @ApiProperty({
    required: false,
    description:
      "ISO currency code to convert all values to. Defaults to the user's preferred currency.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  displayCurrency?: string;
}

export interface IntradayValuePoint {
  timestamp: string;
  value: number;
}

export interface IntradayValueResponse {
  points: IntradayValuePoint[];
  interval: "1m" | "5m" | "15m";
  currency: string;
  /** Range that was actually returned (echoes the request). */
  range: IntradayRangeKey;
  /** ISO timestamp of when this series was computed (server clock). */
  fetchedAt: string;
  /**
   * Symbols of holdings whose quote provider does not expose intraday data
   * (e.g. MSN Money). They were skipped from the aggregated series.
   */
  skippedSymbols: string[];
  /**
   * True when at least one holding's quote provider has no intraday support
   * AND the requested range has a sensible daily-resolution fallback (1W/1M).
   * The frontend should call the existing daily-snapshot endpoint instead of
   * rendering this (partial) intraday series. 1D has no daily fallback so
   * this stays false even when securities are skipped.
   */
  fallbackToDaily: boolean;
}
