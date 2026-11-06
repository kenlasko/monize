import { ApiProperty } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  MaxLength,
  IsBoolean,
  IsInt,
  Min,
  Max,
  IsIn,
  Matches,
} from "class-validator";
import { Transform } from "class-transformer";
import { IsCurrencyCode } from "../../common/validators/is-currency-code.validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { CURRENCY_KINDS, CurrencyKind } from "../entities/currency.entity";
import { MONEY_SCALE } from "../../common/round.util";

/**
 * What a price symbol may be spelled with: Yahoo's coin tickers and the hyphen
 * between the coin and the fiat. Whether it is a `<COIN>-<FIAT>` pair at all
 * (`cryptoPairFiat`), and whether the currency's kind admits one, is the
 * service's decision, because an update that omits `kind` keeps the row's.
 */
const QUOTE_SYMBOL_CHARACTERS = /^[A-Z0-9-]+$/;

export class CreateCurrencyDto {
  @ApiProperty({ example: "CAD", description: "ISO 4217 currency code" })
  @Transform(({ value }) =>
    typeof value === "string" ? value.toUpperCase() : value,
  )
  @IsCurrencyCode()
  code: string;

  @ApiProperty({ example: "Canadian Dollar" })
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  name: string;

  @ApiProperty({ example: "$" })
  @IsString()
  @MaxLength(10)
  @SanitizeHtml()
  symbol: string;

  /**
   * Bounded by the money columns' scale, `NUMERIC(24,8)` (`MONEY_SCALE`): a
   * currency cannot carry more places than an amount is stored at
   * (`docs/specs/money-precision.md` decision 2). The table's
   * `currencies_decimal_places_check` holds the same range.
   */
  @ApiProperty({
    example: 2,
    required: false,
    minimum: 0,
    maximum: MONEY_SCALE,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MONEY_SCALE)
  decimalPlaces?: number;

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({
    example: "FIAT",
    enum: CURRENCY_KINDS,
    required: false,
    description: "FIAT (the default) or CRYPTO",
  })
  @IsOptional()
  @IsIn(CURRENCY_KINDS)
  kind?: CurrencyKind;

  @ApiProperty({
    example: "BTC-EUR",
    required: false,
    nullable: true,
    description:
      "The Yahoo <COIN>-<FIAT> symbol a CRYPTO currency is priced from; null or blank for none",
  })
  @Transform(({ value }) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim().toUpperCase();
    return trimmed === "" ? null : trimmed;
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(QUOTE_SYMBOL_CHARACTERS)
  quoteSymbol?: string | null;
}
