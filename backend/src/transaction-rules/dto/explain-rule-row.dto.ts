import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
  ValidateNested,
  ValidationOptions,
  registerDecorator,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { MONEY_SCALE, roundMoney } from "../../common/round.util";
import { TRANSACTION_NOTE_MAX_LENGTH } from "../../common/transaction-note";
import { IsCalendarDate } from "../../common/validators/is-calendar-date.validator";
import { IsCurrencyCode } from "../../common/validators/is-currency-code.validator";
import { TransactionStatus } from "../../transactions/entities/transaction-status.enum";
import { RULE_TRIGGERS, RuleTrigger } from "../rule-trigger.types";
import {
  MAX_EXPLAIN_ROW_AMOUNT_DIGITS,
  MAX_EXPLAIN_ROW_PAYEE_LENGTH,
  MAX_EXPLAIN_ROW_REFERENCE_LENGTH,
  MAX_EXPLAIN_ROW_TAGS,
} from "../transaction-rules.limits";

const DECIMAL_STRING = new RegExp(
  `^-?\\d{1,${MAX_EXPLAIN_ROW_AMOUNT_DIGITS}}(\\.\\d{1,8})?$`,
);
const MAX_ABS_AMOUNT = 10 ** MAX_EXPLAIN_ROW_AMOUNT_DIGITS;

/**
 * Money as the row input takes it: a decimal string of at most eight decimals
 * (what the column stores) or a finite number of at most eight decimals, within
 * the column's range.
 */
function isRowAmount(value: unknown): boolean {
  if (typeof value === "string") return DECIMAL_STRING.test(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (Math.abs(value) >= MAX_ABS_AMOUNT) return false;
  return roundMoney(value, MONEY_SCALE) === value;
}

function IsRowAmount(options?: ValidationOptions): PropertyDecorator {
  return (object, propertyName) =>
    registerDecorator({
      name: "isRowAmount",
      target: object.constructor,
      propertyName: propertyName as string,
      options: {
        message: `${String(propertyName)} must be a decimal string or a number with at most eight decimals`,
        ...options,
      },
      validator: { validate: isRowAmount },
    });
}

/** A nullable optional field: absent and null are both accepted, any other value is checked. */
const notNull = (_o: unknown, v: unknown): boolean => v !== null;

/**
 * The facts of one row, as the rules read them: the shape of `RuleRowInput`
 * field for field (`transaction-rules-applier.service.ts`), with every field
 * bounded. The category's ancestors are not accepted: the server derives them.
 */
export class RuleRowInputDto {
  @ApiProperty({
    format: "uuid",
    description: "The account the row is posted to",
  })
  @IsUUID()
  accountId: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "ISO code; it must be the account's currency, which the server derives",
  })
  @IsOptional()
  @ValidateIf(notNull)
  @IsCurrencyCode()
  currencyCode: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "Signed, in the account currency: a decimal string or a number",
  })
  @IsOptional()
  @ValidateIf(notNull)
  @IsRowAmount()
  amount: number | string | null;

  @ApiProperty({ description: "True when the row is a leg of a transfer" })
  @IsBoolean()
  isTransfer: boolean;

  @ApiPropertyOptional({ format: "uuid", nullable: true })
  @IsOptional()
  @ValidateIf(notNull)
  @IsUUID()
  fromAccountId?: string | null;

  @ApiPropertyOptional({ format: "uuid", nullable: true })
  @IsOptional()
  @ValidateIf(notNull)
  @IsUUID()
  toAccountId?: string | null;

  @ApiPropertyOptional({ format: "uuid", nullable: true })
  @IsOptional()
  @ValidateIf(notNull)
  @IsUUID()
  payeeId: string | null;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: MAX_EXPLAIN_ROW_PAYEE_LENGTH,
    description: "The raw payee text the source supplied",
  })
  @IsOptional()
  @ValidateIf(notNull)
  @IsString()
  @MaxLength(MAX_EXPLAIN_ROW_PAYEE_LENGTH)
  payeeText: string | null;

  @ApiPropertyOptional({ format: "uuid", nullable: true })
  @IsOptional()
  @ValidateIf(notNull)
  @IsUUID()
  categoryId: string | null;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: TRANSACTION_NOTE_MAX_LENGTH,
  })
  @IsOptional()
  @ValidateIf(notNull)
  @IsString()
  @MaxLength(TRANSACTION_NOTE_MAX_LENGTH)
  description: string | null;

  @ApiProperty({
    type: [String],
    maxItems: MAX_EXPLAIN_ROW_TAGS,
    description: "Tags the row carries when the rules run",
  })
  @IsArray()
  @ArrayMaxSize(MAX_EXPLAIN_ROW_TAGS)
  @ArrayUnique()
  @IsUUID("all", { each: true })
  tagIds: string[];

  @ApiProperty()
  @IsBoolean()
  hasSplits: boolean;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: MAX_EXPLAIN_ROW_REFERENCE_LENGTH,
  })
  @IsOptional()
  @ValidateIf(notNull)
  @IsString()
  @MaxLength(MAX_EXPLAIN_ROW_REFERENCE_LENGTH)
  referenceNumber?: string | null;

  @ApiPropertyOptional({ nullable: true, example: "2026-01-31" })
  @IsOptional()
  @ValidateIf(notNull)
  @IsCalendarDate({
    message: "transactionDate must be a real YYYY-MM-DD calendar date",
  })
  transactionDate?: string | null;

  @ApiPropertyOptional({ nullable: true, enum: TransactionStatus })
  @IsOptional()
  @ValidateIf(notNull)
  @IsIn(Object.values(TransactionStatus))
  status?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  hasAttachment?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: MAX_EXPLAIN_ROW_PAYEE_LENGTH,
    description: "The name stored on the row, for the trace of a payee change",
  })
  @IsOptional()
  @ValidateIf(notNull)
  @IsString()
  @MaxLength(MAX_EXPLAIN_ROW_PAYEE_LENGTH)
  payeeName?: string | null;
}

/** `POST /transaction-rules/explain-row`: one row and the trigger whose rules to test it with. */
export class ExplainRuleRowDto {
  @ApiProperty({ enum: ["import", "create"] })
  @IsIn(RULE_TRIGGERS)
  trigger: RuleTrigger;

  @ApiProperty({ type: RuleRowInputDto })
  // ValidateNested alone lets a missing or null input through.
  @IsObject()
  @ValidateNested()
  @Type(() => RuleRowInputDto)
  input: RuleRowInputDto;
}
