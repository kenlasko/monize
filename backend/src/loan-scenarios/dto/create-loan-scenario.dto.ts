import {
  IsString,
  IsOptional,
  IsNumber,
  IsDateString,
  IsArray,
  IsIn,
  MaxLength,
  Min,
  Max,
  ArrayMaxSize,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import {
  OVERPAYMENT_MODES,
  OverpaymentMode,
  OVERPAYMENT_FREQUENCIES,
  OverpaymentFrequency,
} from "../entities/loan-scenario.entity";

const MAX_AMOUNT = 100_000_000;

export class LumpSumDto {
  @ApiProperty({ description: "ISO date (yyyy-MM-dd) the lump sum is paid" })
  @IsDateString()
  date: string;

  @ApiProperty({ description: "Lump sum amount" })
  @IsNumber()
  @Min(0.01)
  @Max(MAX_AMOUNT)
  amount: number;

  @ApiPropertyOptional({
    description: "Effect: shorten the term or lower the installment",
    enum: OVERPAYMENT_MODES,
  })
  @IsOptional()
  @IsIn(OVERPAYMENT_MODES)
  mode?: OverpaymentMode;
}

export class CreateLoanScenarioDto {
  @ApiProperty({ description: "Scenario name" })
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  name: string;

  @ApiPropertyOptional({ description: "Recurring extra amount per payment" })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(MAX_AMOUNT)
  recurringExtraAmount?: number | null;

  @ApiPropertyOptional({
    description:
      "Effect of the recurring extra: shorten term or lower installment",
    enum: OVERPAYMENT_MODES,
  })
  @IsOptional()
  @IsIn(OVERPAYMENT_MODES)
  recurringExtraMode?: OverpaymentMode | null;

  @ApiPropertyOptional({
    description:
      "Cadence of the recurring overpayment (null = every loan payment)",
    enum: OVERPAYMENT_FREQUENCIES,
  })
  @IsOptional()
  @IsIn(OVERPAYMENT_FREQUENCIES)
  recurringExtraFrequency?: OverpaymentFrequency | null;

  @ApiPropertyOptional({
    description: "First date the recurring extra applies",
  })
  @IsOptional()
  @IsDateString()
  recurringExtraStartDate?: string | null;

  @ApiPropertyOptional({ description: "Last date the recurring extra applies" })
  @IsOptional()
  @IsDateString()
  recurringExtraEndDate?: string | null;

  @ApiPropertyOptional({
    description: "Fixed total spent on the loan each period (budget mode)",
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(MAX_AMOUNT)
  targetMonthlyPayment?: number | null;

  @ApiPropertyOptional({
    description: "How the budget's installment/overpayment split is shown",
    enum: OVERPAYMENT_MODES,
  })
  @IsOptional()
  @IsIn(OVERPAYMENT_MODES)
  targetMonthlyPaymentMode?: OverpaymentMode | null;

  @ApiPropertyOptional({ description: "First date the budget applies" })
  @IsOptional()
  @IsDateString()
  targetMonthlyPaymentStartDate?: string | null;

  @ApiPropertyOptional({ description: "Last date the budget applies" })
  @IsOptional()
  @IsDateString()
  targetMonthlyPaymentEndDate?: string | null;

  @ApiPropertyOptional({
    description: "One-off lump sum payments",
    type: [LumpSumDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => LumpSumDto)
  lumpSums?: LumpSumDto[];
}
