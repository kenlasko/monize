import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../../common/decorators/sanitize-html.decorator";
import { IsCalendarDate } from "../../../common/validators/is-calendar-date.validator";
import { IsMoneyAmount } from "../../../common/validators/is-money-amount.validator";
import {
  TRANSACTION_AMOUNT_MAX_MAGNITUDE,
  TRANSACTION_PAYEE_NAME_MAX_LENGTH,
} from "../../dto/create-transaction.dto";
import {
  QUICK_ADD_CLEARABLE_FIELDS,
  QUICK_ADD_KINDS,
  QuickAddClearableField,
  QuickAddKind,
} from "../quick-add.types";
import {
  QUICK_ADD_TEXT_MAX_LENGTH,
  normalizeQuickAddText,
} from "../quick-add-text.util";

export { QUICK_ADD_TEXT_MAX_LENGTH };

/**
 * At most `max` code points once normalized as the reader normalizes it
 * (NFKC, whitespace runs as one space). `@MaxLength` counts what was sent,
 * and NFKC can turn one character into eighteen (U+FDFA), so a line that
 * passes it can still be far longer than the reader is sized for. A value
 * already over `max` before normalizing is refused without normalizing it.
 */
function MaxNormalizedLength(max: number, options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "maxNormalizedLength",
      target: object.constructor,
      propertyName,
      constraints: [max],
      options,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== "string") return true;
          if (value.length > max * 2) return false;
          return [...normalizeQuickAddText(value)].length <= max;
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be shorter than or equal to ${max} characters`;
        },
      },
    });
  };
}

/** A blank optional field (`null`, `""`) is absent; anything else is validated. */
const present = (_o: unknown, value: unknown) => value !== null && value !== "";

/**
 * Fields the reader set by hand on a chip. Each one wins over the text and
 * is never re-read from it. Every id must be the caller's own (404 otherwise).
 */
export class QuickAddPinsDto {
  @ApiPropertyOptional({ enum: QUICK_ADD_KINDS })
  @IsOptional()
  @ValidateIf(present)
  @IsIn(QUICK_ADD_KINDS)
  kind?: QuickAddKind | null;

  @ApiPropertyOptional({
    description: "The magnitude, in the account's currency; the kind signs it",
  })
  @IsOptional()
  @ValidateIf(present)
  @IsMoneyAmount()
  @IsPositive()
  @Max(TRANSACTION_AMOUNT_MAX_MAGNITUDE)
  amount?: number | null;

  @ApiPropertyOptional({ description: "YYYY-MM-DD" })
  @IsOptional()
  @ValidateIf(present)
  @IsCalendarDate()
  date?: string | null;

  @ApiPropertyOptional({
    description: "The account (the FROM account of a transfer)",
  })
  @IsOptional()
  @ValidateIf(present)
  @IsUUID()
  accountId?: string | null;

  @ApiPropertyOptional({ description: "The TO account of a transfer" })
  @IsOptional()
  @ValidateIf(present)
  @IsUUID()
  toAccountId?: string | null;

  @ApiPropertyOptional({ description: "An existing payee" })
  @IsOptional()
  @ValidateIf(present)
  @IsUUID()
  payeeId?: string | null;

  @ApiPropertyOptional({
    description: "A new payee's name (ignored when payeeId is given)",
    maxLength: TRANSACTION_PAYEE_NAME_MAX_LENGTH,
  })
  @IsOptional()
  @ValidateIf(present)
  @IsString()
  @MaxLength(TRANSACTION_PAYEE_NAME_MAX_LENGTH)
  @SanitizeHtml()
  payeeName?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf(present)
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional({
    description:
      "Fields the reader cleared on a chip: answered as none and never guessed again. A value pinned for the same field wins.",
    enum: QUICK_ADD_CLEARABLE_FIELDS,
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(QUICK_ADD_CLEARABLE_FIELDS.length)
  @IsIn(QUICK_ADD_CLEARABLE_FIELDS, { each: true })
  clear?: QuickAddClearableField[] | null;
}

/** `POST /transactions/quick-add/interpret`: read a typed line. Writes nothing. */
export class QuickAddInterpretDto {
  @ApiProperty({
    description: "The typed line; may be empty",
    maxLength: QUICK_ADD_TEXT_MAX_LENGTH,
  })
  @IsString()
  @MaxLength(QUICK_ADD_TEXT_MAX_LENGTH)
  @MaxNormalizedLength(QUICK_ADD_TEXT_MAX_LENGTH)
  @SanitizeHtml()
  text: string;

  @ApiProperty({
    description: "The reader's financial today (YYYY-MM-DD): the default date",
  })
  @IsCalendarDate()
  today: string;

  @ApiPropertyOptional({
    description:
      "The register's single filtered account, used as the default account when it is one the reader may enter into",
  })
  @IsOptional()
  @ValidateIf(present)
  @IsUUID()
  contextAccountId?: string | null;

  @ApiPropertyOptional({ type: QuickAddPinsDto })
  @IsOptional()
  // `@ValidateNested()` alone accepts an array and validates each element.
  @IsObject()
  @ValidateNested()
  @Type(() => QuickAddPinsDto)
  pins?: QuickAddPinsDto;
}
