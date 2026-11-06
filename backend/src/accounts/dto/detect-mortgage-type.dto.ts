import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  MORTGAGE_PAYMENT_FREQUENCIES,
  MortgagePaymentFrequency,
} from "./create-account.dto";
import { MORTGAGE_TYPES, MortgageType } from "../mortgage-type.util";
import {
  MORTGAGE_TYPE_DETECTION_REASONS,
  MortgageTypeDetectionReason,
} from "../mortgage-type-detection.util";
import { IsMoneyAmount } from "../../common/validators/is-money-amount.validator";

/** The most installments a detection request may carry. */
export const MAX_MORTGAGE_TYPE_SAMPLES = 12;

export class MortgageTypeSampleDto {
  @ApiProperty({
    example: 833.33,
    description: "Principal portion of the installment, as a positive amount",
  })
  @IsMoneyAmount(4)
  @Min(0)
  @Max(999999999999)
  principal: number;

  @ApiProperty({
    example: 500,
    description: "Interest portion of the installment, as a positive amount",
  })
  @IsMoneyAmount(4)
  @Min(0)
  @Max(999999999999)
  interest: number;

  @ApiPropertyOptional({
    example: 300000,
    description:
      "The debt the installment was charged on, when the statement shows it. Lets the interest-to-balance ratio decide the compounding.",
  })
  @IsOptional()
  @IsMoneyAmount(4)
  @IsPositive()
  @Max(999999999999)
  balanceBefore?: number | null;
}

export class DetectMortgageTypeDto {
  @ApiProperty({
    type: [MortgageTypeSampleDto],
    description:
      "Two or three consecutive installments, oldest first. Fewer than two is answered with no type and a reason, not refused.",
  })
  @IsArray()
  @ArrayMaxSize(MAX_MORTGAGE_TYPE_SAMPLES)
  @ValidateNested({ each: true })
  @Type(() => MortgageTypeSampleDto)
  samples: MortgageTypeSampleDto[];

  @ApiPropertyOptional({
    example: 6,
    description:
      "The quoted annual rate as a percentage. Without it the compounding cannot be checked.",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  interestRate?: number | null;

  @ApiProperty({
    example: "MONTHLY",
    description: "Payment frequency of the installments",
    enum: MORTGAGE_PAYMENT_FREQUENCIES,
  })
  @IsIn(MORTGAGE_PAYMENT_FREQUENCIES)
  paymentFrequency: MortgagePaymentFrequency;
}

export class MortgageTypeDetectionResponseDto {
  @ApiProperty({
    example: "CANADIAN_FIXED",
    nullable: true,
    enum: MORTGAGE_TYPES,
    description:
      "The suggested type, or null when the installments do not decide one. A suggestion: nothing is saved.",
  })
  type: MortgageType | null;

  @ApiProperty({ example: "high", enum: ["high", "low"] })
  confidence: "high" | "low";

  @ApiProperty({
    example: "CONSTANT_INSTALLMENT_SEMI_ANNUAL",
    enum: MORTGAGE_TYPE_DETECTION_REASONS,
    description: "Why the detector answered as it did; always present",
  })
  reason: MortgageTypeDetectionReason;
}

export class DatedMortgageTypeSampleDto {
  @ApiProperty({ example: "2026-09-01", description: "Payment date" })
  date: string;

  @ApiProperty({ example: 709.95 })
  principal: number;

  @ApiProperty({ example: 1660.05 })
  interest: number;

  @ApiProperty({
    example: 384293.1,
    nullable: true,
    description: "Ledger balance owed before the payment date",
  })
  balanceBefore: number | null;
}

export class MortgageTypeHistoryDetectionResponseDto extends MortgageTypeDetectionResponseDto {
  @ApiProperty({
    example: 5.24,
    nullable: true,
    description:
      "The annual rate in effect on the latest sample's date (rate history, else the account's rate)",
  })
  quotedAnnualRate: number | null;

  @ApiProperty({
    example: "MONTHLY",
    nullable: true,
    enum: MORTGAGE_PAYMENT_FREQUENCIES,
  })
  paymentFrequency: MortgagePaymentFrequency | null;

  @ApiProperty({
    type: [DatedMortgageTypeSampleDto],
    description:
      "The posted installments the suggestion was read from, oldest first: up to three, all at the latest sample's rate",
  })
  samples: DatedMortgageTypeSampleDto[];
}
