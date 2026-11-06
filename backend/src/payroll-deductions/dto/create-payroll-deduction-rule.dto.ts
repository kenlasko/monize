import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { IsCalendarDate } from "../../common/validators/is-calendar-date.validator";
import {
  PAYROLL_RESET_PERIODS,
  PayrollResetPeriod,
} from "../entities/payroll-deduction-rule.entity";
import { IsMoneyAmount } from "../../common/validators/is-money-amount.validator";

/** The largest magnitude a rule stores; `NUMERIC(20,4)` holds far more. */
export const PAYROLL_AMOUNT_MAX = 1_000_000_000;

/**
 * `POST /payroll-deductions` (docs/specs/payroll-deductions.md section 5.2).
 * No `userId`: the owner is the JWT's. The bill and the category are checked
 * against that owner by the service, inside the transaction that writes.
 */
export class CreatePayrollDeductionRuleDto {
  @ApiProperty({ description: "The payroll scheduled bill" })
  @IsUUID()
  scheduledTransactionId: string;

  @ApiProperty({ description: "The deduction category the maximum applies to" })
  @IsUUID()
  categoryId: string;

  @ApiProperty({
    example: 1077.48,
    description: "The most the category collects in one period, a magnitude",
  })
  @IsMoneyAmount(4)
  @Min(0)
  @Max(PAYROLL_AMOUNT_MAX)
  yearlyMaximum: number;

  @ApiPropertyOptional({ enum: PAYROLL_RESET_PERIODS, default: "YEARLY" })
  @IsOptional()
  @IsIn(PAYROLL_RESET_PERIODS)
  resetPeriod?: PayrollResetPeriod;

  @ApiProperty({
    example: "2026-01-01",
    description: "The anchor the periods are the anniversaries of",
  })
  @IsCalendarDate({
    message: "resetDate must be a real YYYY-MM-DD calendar date",
  })
  resetDate: string;

  @ApiPropertyOptional({
    example: 64,
    nullable: true,
    description:
      "Expected per paycheque, read only when the bill has no line for the category",
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsMoneyAmount(4)
  @Min(0)
  @Max(PAYROLL_AMOUNT_MAX)
  expectedPerPaycheque?: number | null;
}

/** `PATCH /payroll-deductions/:id`: any subset of the create fields. */
export class UpdatePayrollDeductionRuleDto extends PartialType(
  CreatePayrollDeductionRuleDto,
) {}

/** The most categories one batch names; a paycheque has far fewer lines. */
export const PAYROLL_BATCH_MAX_LINES = 50;

/** One category of a batch: the fields that differ per deduction line. */
export class PayrollDeductionLineDto {
  @ApiProperty({ description: "The deduction category the maximum applies to" })
  @IsUUID()
  categoryId: string;

  @ApiProperty({ example: 1077.48, description: "The period maximum" })
  @IsMoneyAmount(4)
  @Min(0)
  @Max(PAYROLL_AMOUNT_MAX)
  yearlyMaximum: number;

  @ApiPropertyOptional({ example: 64, nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsMoneyAmount(4)
  @Min(0)
  @Max(PAYROLL_AMOUNT_MAX)
  expectedPerPaycheque?: number | null;
}

/**
 * `POST /payroll-deductions/batch`: several categories of one bill sharing a
 * reset, written in one transaction so a refused line leaves nothing behind.
 */
export class CreatePayrollDeductionRulesDto {
  @ApiProperty({ description: "The payroll scheduled bill" })
  @IsUUID()
  scheduledTransactionId: string;

  @ApiPropertyOptional({ enum: PAYROLL_RESET_PERIODS, default: "YEARLY" })
  @IsOptional()
  @IsIn(PAYROLL_RESET_PERIODS)
  resetPeriod?: PayrollResetPeriod;

  @ApiProperty({ example: "2026-01-01" })
  @IsCalendarDate({
    message: "resetDate must be a real YYYY-MM-DD calendar date",
  })
  resetDate: string;

  @ApiProperty({ type: [PayrollDeductionLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PAYROLL_BATCH_MAX_LINES)
  @ValidateNested({ each: true })
  @Type(() => PayrollDeductionLineDto)
  lines: PayrollDeductionLineDto[];
}
