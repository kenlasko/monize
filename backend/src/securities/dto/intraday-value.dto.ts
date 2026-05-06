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
  interval: "1m" | "2m" | "5m" | "15m" | "30m" | "60m" | "90m";
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
   * Symbols whose intraday fetch failed at the provider level (network error,
   * empty/invalid response, etc.) even though the provider does support
   * intraday in principle. Distinguished from skippedSymbols so the frontend
   * can show a distinct error message.
   */
  failedSymbols: string[];
  /**
   * True when the frontend must not render this intraday series and should
   * instead use the daily-snapshot endpoint. Set when:
   *   - any holding's quote provider has no intraday support (skippedSymbols),
   *   - or any holding's intraday fetch failed (failedSymbols).
   * In either case the points array is empty.
   */
  fallbackToDaily: boolean;
}
