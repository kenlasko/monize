import { ApiProperty } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { IsCurrencyCode } from "../../common/validators/is-currency-code.validator";
import {
  QUOTE_PROVIDER_NAMES,
  QuoteProviderName,
} from "../providers/quote-provider.interface";

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
  @ApiProperty({ required: false, default: false })
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  priceChartEnabled?: boolean;

  /**
   * The alert threshold, in percent, at the column's own scale: NUMERIC(9,4),
   * the same as its sibling `notification_portfolio_state.move_alert_percent`.
   *
   * Four, not two, and the number is not a taste: the column, this validator
   * and `NumericInput decimalPlaces={4}` in `SecurityForm` all state the same
   * precision, so a stored value always round-trips through the form exactly.
   * Where they disagree the finer side is displayed rounded and then committed
   * at that rounding on the next blur (`NumericInput.handleBlur` re-emits when
   * rounding moved the value), which moves a threshold on a save the user made
   * about another field.
   *
   * The bound is on the DTO because the form is not the only writer -- the API,
   * the AI assistant and MCP reach this too, and PostgreSQL would silently
   * round a finer value into the column rather than refuse it.
   */
  @ApiProperty({ required: false, nullable: true, minimum: 0.1, maximum: 1000 })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 4 })
  @Min(0.1)
  @Max(1000)
  priceAlertPercent?: number | null;

  /**
   * Turns off every scheduled and background price fetch for this security
   * (`isRefreshEligible` in `security-price.service.ts`). Imports set it on a
   * symbol they had to invent; the user sets it for anything a provider cannot
   * price. Prices entered by hand or carried by transactions still count.
   */
  @ApiProperty({
    required: false,
    default: false,
    description: "Disable automatic price updates for this security",
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  skipPriceUpdates?: boolean;

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
    example: "https://www.apple.com",
    description:
      "The issuer's or product's own page. The protocol is optional (https is assumed).",
    required: false,
  })
  @IsOptional()
  // An optional field cleared in the form arrives as "", and `@IsOptional`
  // only waives validation for undefined and null -- so without this the URL
  // check runs on the empty string, rejects it, and every save from a form that
  // leaves the address blank returns 400. The service reads "" as "clear it".
  @ValidateIf((_o, value) => value !== null && value !== "")
  @IsString()
  @MaxLength(2048)
  // Rendered as a link on the detail page, so the scheme is a security control:
  // without the protocol whitelist `javascript:...` validates and the anchor
  // becomes a way to run it. `require_protocol: false` keeps typing "apple.com"
  // working -- the service normalises it to https before storing.
  @IsUrl({
    protocols: ["http", "https"],
    require_protocol: false,
    require_tld: true,
  })
  website?: string | null;

  @ApiProperty({
    example: "https://investor.apple.com",
    description:
      "The investor-relations page. No quote provider supplies this, so it is manual.",
    required: false,
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null && value !== "")
  @IsString()
  @MaxLength(2048)
  @IsUrl({
    protocols: ["http", "https"],
    require_protocol: false,
    require_tld: true,
  })
  irWebsite?: string | null;

  @ApiProperty({
    example: "msn",
    description:
      "Per-security provider override; omit or null to use the user default",
    required: false,
    enum: QUOTE_PROVIDER_NAMES,
  })
  @IsOptional()
  @IsIn([...QUOTE_PROVIDER_NAMES])
  quoteProvider?: QuoteProviderName;

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
    example:
      "https://www.ariva.de/1-unze-kruegerrand-gold-kurs/kurse/historische-kurse",
    description:
      "Web page whose price table the 'html_table' provider reads; empty or null clears it",
    required: false,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null && value !== "")
  @IsString()
  @MaxLength(2048)
  @IsUrl({
    protocols: ["http", "https"],
    require_protocol: true,
    require_tld: true,
  })
  quoteUrl?: string | null;

  @ApiProperty({
    description:
      "The bond program (GET /bonds/programs) to link this security to; " +
      "null unlinks. A linked security is priced by the bond engine only, and " +
      "its currency must equal the program's.",
    required: false,
    nullable: true,
    format: "uuid",
  })
  // One canonical spelling (lower case) before anything compares or stores the
  // id: the same instrument in capitals is not a different link.
  @Transform(({ value }) =>
    typeof value === "string" ? value.toLowerCase() : value,
  )
  @IsOptional()
  @ValidateIf((_o, value) => value !== null && value !== undefined)
  @IsUUID()
  bondProgramId?: string | null;

  @ApiProperty({
    description:
      "Fetch every new series of the linked program automatically (the daily series job). Off by default.",
    required: false,
  })
  // Not nullable: the column is NOT NULL, so null is refused here rather than
  // reaching the database.
  @ValidateIf((_o, value) => value !== undefined)
  @IsBoolean()
  bondAutoFetch?: boolean;

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

  @ApiProperty({
    description:
      "Manual asset-class allocation for ETFs/funds: [{name, weight}] where " +
      "weight is a decimal 0-1 and name is free text. Slices need not sum to " +
      "1.0 (the remainder is 'Other').",
    required: false,
    type: [AllocationWeightDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => AllocationWeightDto)
  assetWeightings?: AllocationWeightDto[];
}
