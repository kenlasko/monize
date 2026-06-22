import { ApiProperty } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  MaxLength,
  IsBoolean,
  IsIn,
  IsArray,
  IsUUID,
  IsNumber,
  Min,
  Max,
  ValidateNested,
  ArrayMaxSize,
} from "class-validator";
import { Type } from "class-transformer";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { IsCurrencyCode } from "../../common/validators/is-currency-code.validator";

/**
 * One slice of a manual allocation breakdown (e.g. a country and its share of
 * the fund). `weight` is a decimal 0-1, matching the `sectorWeightings`
 * convention. The slices need not sum to 1.0 -- any shortfall is shown as
 * "Other" and is not stored.
 */
export class AllocationWeightDto {
  @ApiProperty({ example: "United States" })
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  name: string;

  @ApiProperty({ example: 0.6, description: "Decimal 0-1 share" })
  @IsNumber()
  @Min(0)
  @Max(1)
  weight: number;
}

export class CreateSecurityDto {
  @ApiProperty({ example: "AAPL", description: "Stock symbol or ticker" })
  @IsString()
  @MaxLength(20)
  @SanitizeHtml()
  symbol: string;

  @ApiProperty({
    example: "Apple Inc.",
    description: "Full name of the security",
  })
  @IsString()
  @MaxLength(255)
  @SanitizeHtml()
  name: string;

  @ApiProperty({
    example: "STOCK",
    description: "Type of security",
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @SanitizeHtml()
  securityType?: string;

  @ApiProperty({
    example: "NASDAQ",
    description: "Stock exchange",
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @SanitizeHtml()
  exchange?: string;

  @ApiProperty({ example: "USD", description: "Currency code" })
  @IsCurrencyCode()
  currencyCode: string;

  @ApiProperty({
    example: "Global aggregate bond ETF. ~99% bonds, ~1% cash. TER 0.10%.",
    description: "Free-text description of the security",
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  @SanitizeHtml()
  description?: string;

  @ApiProperty({
    description: "Tag IDs to classify this security",
    required: false,
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  tagIds?: string[];

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({
    example: false,
    description: "Pin to the dashboard Favourite Securities widget",
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  isFavourite?: boolean;

  @ApiProperty({
    example: "msn",
    description:
      "Per-security provider override; omit or null to use the user default",
    required: false,
    enum: ["yahoo", "msn"],
  })
  @IsOptional()
  @IsIn(["yahoo", "msn"])
  quoteProvider?: "yahoo" | "msn";

  @ApiProperty({
    example: "a1u3p2",
    description: "MSN Financial Instrument ID (advanced override)",
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @SanitizeHtml()
  msnInstrumentId?: string;

  @ApiProperty({
    description:
      "Manual country allocation for ETFs/funds: [{name, weight}] where weight " +
      "is a decimal 0-1. Slices need not sum to 1.0 (the remainder is 'Other').",
    required: false,
    type: [AllocationWeightDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => AllocationWeightDto)
  countryWeightings?: AllocationWeightDto[];
}
