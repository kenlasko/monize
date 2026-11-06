import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
  registerDecorator,
} from "class-validator";

import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { IsCalendarDate } from "../../common/validators/is-calendar-date.validator";
import { IsCurrencyCode } from "../../common/validators/is-currency-code.validator";
import { WARRANTY_KINDS, WarrantyKind } from "../entities/warranty.entity";
import { IsMoneyAmount } from "../../common/validators/is-money-amount.validator";

/** The most serial numbers one warranty carries (design 6.1). */
export const WARRANTY_MAX_SERIAL_NUMBERS = 10;

/** A nullable optional field with a format: absent, null and blank are no value. */
export const hasValue = (_o: unknown, v: unknown): boolean =>
  v !== null && v !== "";

/**
 * A duration from the purchase date, turned into `expiresOn` by
 * `termToExpiresOn`. Absent parts are zero; a term that is zero in total is
 * refused by the service (the helper's own refusal), not here, so the message
 * names the term rather than one of its parts.
 */
export class WarrantyTermDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  years?: number | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 1200 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1200)
  months?: number | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 36500 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(36500)
  days?: number | null;
}

/**
 * Every field a warranty's create and update accept, validated one at a time.
 * The rules that relate two fields are class-level and differ between the two
 * verbs, so they are declared on `CreateWarrantyDto` and `UpdateWarrantyDto`
 * rather than here: `PartialType` makes every inherited property optional, and
 * an optional property's validators are skipped when it is absent, which would
 * switch a cross-field rule hung on one of them off.
 *
 * No `userId`: the owner is the JWT's. No status: it is derived.
 */
export class WarrantyFieldsDto {
  @ApiProperty({ maxLength: 200, example: "ThinkPad X1 Carbon" })
  @IsString()
  @Matches(/\S/, { message: "name must not be blank" })
  @MaxLength(200)
  @SanitizeHtml()
  name: string;

  @ApiPropertyOptional({ maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @SanitizeHtml()
  vendorName?: string | null;

  @ApiPropertyOptional({ format: "uuid", nullable: true })
  @IsOptional()
  @ValidateIf(hasValue)
  @IsUUID()
  payeeId?: string | null;

  @ApiPropertyOptional({
    format: "uuid",
    nullable: true,
    description:
      "The purchase this warranty came from: a parent row, never a split line",
  })
  @IsOptional()
  @ValidateIf(hasValue)
  @IsUUID()
  transactionId?: string | null;

  @ApiPropertyOptional({ maxLength: 100, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  modelNumber?: string | null;

  @ApiPropertyOptional({
    type: [String],
    maxItems: WARRANTY_MAX_SERIAL_NUMBERS,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(WARRANTY_MAX_SERIAL_NUMBERS)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @SanitizeHtml()
  serialNumbers?: string[];

  // Absent means the default; `null` is refused, the column being NOT NULL.
  @ApiPropertyOptional({ enum: WARRANTY_KINDS, default: "manufacturer" })
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(WARRANTY_KINDS)
  warrantyKind?: WarrantyKind;

  @ApiProperty({ example: "2026-10-01" })
  @IsCalendarDate({
    message: "purchaseDate must be a real YYYY-MM-DD calendar date",
  })
  purchaseDate: string;

  @ApiPropertyOptional({ example: "2028-10-01", nullable: true })
  @IsOptional()
  @ValidateIf(hasValue)
  @IsCalendarDate({
    message: "expiresOn must be a real YYYY-MM-DD calendar date",
  })
  expiresOn?: string | null;

  @ApiPropertyOptional({
    type: WarrantyTermDto,
    nullable: true,
    description: "A duration from purchaseDate, instead of expiresOn",
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => WarrantyTermDto)
  term?: WarrantyTermDto | null;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isLifetime?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: "Informational only; set together with currencyCode",
  })
  @IsOptional()
  @IsMoneyAmount(4)
  @Min(0)
  @Max(999999999999)
  purchasePrice?: number | null;

  @ApiPropertyOptional({ example: "CAD", nullable: true })
  @IsOptional()
  @ValidateIf(hasValue)
  @IsCurrencyCode()
  currencyCode?: string | null;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @ValidateIf(hasValue)
  @IsString()
  @MaxLength(500)
  @IsUrl({ require_protocol: true, protocols: ["http", "https"] })
  productUrl?: string | null;

  @ApiPropertyOptional({ maxLength: 2000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @SanitizeHtml()
  notes?: string | null;
}

/** Null, undefined and the blank a cleared input sends are all "no value". */
export function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** A nullable text field as the services store it: blank becomes null, else trimmed. */
export function nullableText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * How many of the three ways to say when a warranty ends a payload uses:
 * `expiresOn`, `term`, or `isLifetime: true` (design decision 1).
 * `isLifetime: false` is not a source; it is what the other two imply.
 */
export function expirySourceCount(dto: {
  expiresOn?: unknown;
  term?: unknown;
  isLifetime?: unknown;
}): number {
  return (
    (isBlank(dto.expiresOn) ? 0 : 1) +
    (isBlank(dto.term) ? 0 : 1) +
    (dto.isLifetime === true ? 1 : 0)
  );
}

/** `chk_warranty_price_currency`, as the payload states it. */
export function priceAndCurrencyAgree(dto: {
  purchasePrice?: unknown;
  currencyCode?: unknown;
}): boolean {
  return isBlank(dto.purchasePrice) === isBlank(dto.currencyCode);
}

/**
 * A rule over the whole payload, reported under its own name.
 *
 * class-validator has no class-level validator, so the rule is registered on a
 * property no client sends: a property validator runs on an absent property
 * unless `@IsOptional` waives it, and nothing here does. A client that does
 * send the name gets a 400 rather than a field the service never reads.
 */
export function PayloadRule(
  name: string,
  holds: (dto: Record<string, unknown>) => boolean,
  message: string,
): ClassDecorator {
  return (target) => {
    registerDecorator({
      name,
      target,
      propertyName: name,
      options: { message },
      validator: {
        validate: (value: unknown, args?: ValidationArguments) =>
          value === undefined &&
          args !== undefined &&
          holds(args.object as Record<string, unknown>),
      },
    });
  };
}

/**
 * `POST /warranties`. Exactly one of `expiresOn`, `term` or
 * `isLifetime: true`; a price with its currency or neither; an expiry on or
 * after the purchase (the three CHECKs on `warranties`, refused here with a
 * field-shaped 400 rather than by the database as a 500).
 */
@PayloadRule(
  "expirySource",
  (dto) => expirySourceCount(dto) === 1,
  "Give exactly one of expiresOn, term or isLifetime: true",
)
@PayloadRule(
  "priceCurrency",
  priceAndCurrencyAgree,
  "purchasePrice and currencyCode are set together or not at all",
)
@PayloadRule(
  "expiryAfterPurchase",
  (dto) =>
    isBlank(dto.expiresOn) ||
    typeof dto.expiresOn !== "string" ||
    typeof dto.purchaseDate !== "string" ||
    dto.expiresOn >= dto.purchaseDate,
  "expiresOn must be on or after purchaseDate",
)
export class CreateWarrantyDto extends WarrantyFieldsDto {}
