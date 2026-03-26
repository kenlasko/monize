import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsNumber,
  IsUUID,
  IsOptional,
  IsBoolean,
  IsDateString,
  IsIn,
  Min,
  Max,
  MaxLength,
} from "class-validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

export class SetupLoanPaymentsDto {
  @ApiProperty({
    description: "Payment amount per period (positive number)",
    example: 1500,
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.01)
  @Max(999999999999)
  paymentAmount: number;

  @ApiProperty({
    description: "Payment frequency",
    example: "MONTHLY",
  })
  @IsString()
  @IsIn(["WEEKLY", "BIWEEKLY", "SEMIMONTHLY", "MONTHLY", "QUARTERLY", "YEARLY"])
  paymentFrequency: string;

  @ApiProperty({
    description: "Source account ID where payments come from",
  })
  @IsUUID()
  sourceAccountId: string;

  @ApiProperty({
    description: "Next payment due date (YYYY-MM-DD)",
    example: "2026-04-01",
  })
  @IsDateString()
  nextDueDate: string;

  @ApiPropertyOptional({
    description: "Annual interest rate as percentage (e.g., 5.5 for 5.5%)",
    example: 5.5,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  interestRate?: number;

  @ApiPropertyOptional({
    description: "Interest expense category ID",
  })
  @IsOptional()
  @IsUUID()
  interestCategoryId?: string;

  @ApiPropertyOptional({
    description: "Payee ID for the scheduled transaction",
  })
  @IsOptional()
  @IsUUID()
  payeeId?: string;

  @ApiPropertyOptional({
    description: "Payee name for the scheduled transaction",
    example: "Bank of America",
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @SanitizeHtml()
  payeeName?: string;

  @ApiPropertyOptional({
    description: "Whether to auto-post the scheduled transaction when due",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  autoPost?: boolean;

  @ApiPropertyOptional({
    description:
      "For mortgages: whether this is a Canadian mortgage (semi-annual compounding)",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isCanadianMortgage?: boolean;

  @ApiPropertyOptional({
    description: "For mortgages: whether this is a variable rate mortgage",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isVariableRate?: boolean;

  @ApiPropertyOptional({
    description: "For mortgages: total amortization period in months",
    example: 300,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(600)
  amortizationMonths?: number;

  @ApiPropertyOptional({
    description: "For mortgages: mortgage term length in months",
    example: 60,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(600)
  termMonths?: number;

  @ApiPropertyOptional({
    description:
      "Extra principal amount per payment period. Added to the principal portion of the split.",
    example: 200,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(999999999999)
  extraPrincipal?: number;

  @ApiPropertyOptional({
    description:
      "Interest amount from detected transaction history. When provided, uses this for the interest split instead of calculating from the amortization formula.",
    example: 1000,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(999999999999)
  detectedInterestAmount?: number;
}

export class DetectedLoanPaymentResponseDto {
  @ApiProperty()
  paymentAmount: number;

  @ApiProperty()
  paymentFrequency: string;

  @ApiProperty()
  confidence: number;

  @ApiProperty({ nullable: true })
  sourceAccountId: string | null;

  @ApiProperty({ nullable: true })
  sourceAccountName: string | null;

  @ApiProperty({ nullable: true })
  interestCategoryId: string | null;

  @ApiProperty({ nullable: true })
  interestCategoryName: string | null;

  @ApiProperty({ nullable: true })
  principalCategoryId: string | null;

  @ApiProperty({ nullable: true })
  estimatedInterestRate: number | null;

  @ApiProperty()
  suggestedNextDueDate: string;

  @ApiProperty()
  firstPaymentDate: string;

  @ApiProperty()
  lastPaymentDate: string;

  @ApiProperty()
  paymentCount: number;

  @ApiProperty()
  currentBalance: number;

  @ApiProperty()
  isMortgage: boolean;

  @ApiProperty({ description: "Average extra principal per payment period" })
  averageExtraPrincipal: number;

  @ApiProperty({
    description: "Number of extra principal payments detected",
  })
  extraPrincipalCount: number;

  @ApiProperty({
    nullable: true,
    description: "Principal portion from most recent split payment",
  })
  lastPrincipalAmount: number | null;

  @ApiProperty({
    nullable: true,
    description: "Interest portion from most recent split payment",
  })
  lastInterestAmount: number | null;
}

export class SetupLoanPaymentsResponseDto {
  @ApiProperty({ description: "The created scheduled transaction ID" })
  scheduledTransactionId: string;

  @ApiProperty({ description: "The updated account" })
  accountId: string;

  @ApiProperty({ description: "Payment amount set on the account" })
  paymentAmount: number;

  @ApiProperty({ description: "Payment frequency set on the account" })
  paymentFrequency: string;

  @ApiProperty({ description: "Next due date of the scheduled transaction" })
  nextDueDate: string;
}
