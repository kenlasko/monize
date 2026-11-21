import { ApiProperty } from "@nestjs/swagger";
import { IsString, Matches, MaxLength } from "class-validator";

/**
 * A request for a series the catalog lacks: only a country and a series code.
 * The terms come from the official source, never from the caller (INV-BOND-006).
 */
export class FetchBondSeriesDto {
  @ApiProperty({ example: "PL", description: "Two-letter country code" })
  @IsString()
  @Matches(/^[A-Z]{2}$/, {
    message: "countryCode must be two upper-case letters",
  })
  countryCode: string;

  // 16 is a deliberate bound on the official code formats the supported
  // adapters issue (PL's "EDO1036"-style codes, the US's 9-character CUSIP),
  // not a copy of bond_instruments.series_code's generic VARCHAR(40) ceiling,
  // which is sized for whatever a future country's format needs.
  @ApiProperty({ example: "EDO1036", maxLength: 16 })
  @IsString()
  @MaxLength(16)
  @Matches(/^[A-Za-z0-9]+$/, {
    message: "seriesCode must be letters and digits only",
  })
  seriesCode: string;
}
