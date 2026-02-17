import {
  IsString,
  IsOptional,
  IsNumber,
  IsPositive,
  IsBoolean,
  IsEnum,
  MaxLength,
  Min,
  Max,
  IsUUID,
  IsDateString,
  IsIn,
} from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { AccountType } from "../entities/account.entity";
import { PAYMENT_FREQUENCIES, PaymentFrequency } from "./create-account.dto";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

export class UpdateAccountDto {
  @ApiPropertyOptional({
    example: "Updated Account Name",
    description: "Display name for the account",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  name?: string;

  @ApiPropertyOptional({
    enum: AccountType,
    example: AccountType.CHEQUING,
    description: "Type of account",
  })
  @IsOptional()
  @IsEnum(AccountType)
  accountType?: AccountType;

  @ApiPropertyOptional({
    example: "CAD",
    description: "ISO 4217 currency code (USD, CAD, EUR, etc.)",
    maxLength: 3,
  })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currencyCode?: string;

  @ApiPropertyOptional({
    example: 1000.0,
    description: "Opening balance for the account",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  openingBalance?: number;

  @ApiPropertyOptional({
    example: "Updated account description",
    description: "Optional description of the account",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @SanitizeHtml()
  description?: string;

  @ApiPropertyOptional({
    example: "****5678",
    description: "Account number (masked or encrypted)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  accountNumber?: string;

  @ApiPropertyOptional({
    example: "BMO Bank of Montreal",
    description: "Financial institution name",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  institution?: string;

  @ApiPropertyOptional({
    example: 10000.0,
    description: "Credit limit (for credit cards)",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @IsPositive()
  creditLimit?: number;

  @ApiPropertyOptional({
    example: 4.25,
    description: "Interest rate percentage (for loans, mortgages, savings)",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  interestRate?: number;

  @ApiPropertyOptional({
    example: true,
    description: "Whether this account is a favourite (shown in dashboard)",
  })
  @IsOptional()
  @IsBoolean()
  isFavourite?: boolean;

  // Loan-specific fields
  @ApiPropertyOptional({
    example: 500.0,
    description: "Monthly payment amount for loans",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @IsPositive()
  paymentAmount?: number;

  @ApiPropertyOptional({
    example: "MONTHLY",
    description:
      "Payment frequency for loans (WEEKLY, BIWEEKLY, MONTHLY, QUARTERLY, YEARLY)",
  })
  @IsOptional()
  @IsString()
  @IsIn(PAYMENT_FREQUENCIES)
  paymentFrequency?: PaymentFrequency;

  @ApiPropertyOptional({
    example: "2024-02-01",
    description: "Start date for loan payments (YYYY-MM-DD)",
  })
  @IsOptional()
  @IsDateString()
  paymentStartDate?: string;

  @ApiPropertyOptional({
    description:
      "Source account ID for loan payments (where payments come from)",
  })
  @IsOptional()
  @IsUUID()
  sourceAccountId?: string;

  @ApiPropertyOptional({
    description: "Category ID for principal portion of payments",
  })
  @IsOptional()
  @IsUUID()
  principalCategoryId?: string;

  @ApiPropertyOptional({
    description: "Category ID for interest portion of payments",
  })
  @IsOptional()
  @IsUUID()
  interestCategoryId?: string;

  // Asset-specific fields
  @ApiPropertyOptional({
    description: "Category ID for tracking value changes on asset accounts",
  })
  @IsOptional()
  @IsUUID()
  assetCategoryId?: string;

  @ApiPropertyOptional({
    example: "2020-06-15",
    description: "Date the asset was acquired (YYYY-MM-DD)",
  })
  @IsOptional()
  @IsDateString()
  dateAcquired?: string;

  // Mortgage-specific fields
  @ApiPropertyOptional({
    example: true,
    description: "Whether this is a Canadian mortgage",
  })
  @IsOptional()
  @IsBoolean()
  isCanadianMortgage?: boolean;

  @ApiPropertyOptional({
    example: false,
    description: "Whether this is a variable rate mortgage",
  })
  @IsOptional()
  @IsBoolean()
  isVariableRate?: boolean;

  @ApiPropertyOptional({
    example: 60,
    description: "Mortgage term length in months. 0 means no term.",
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  termMonths?: number;

  @ApiPropertyOptional({
    example: 300,
    description: "Total amortization period in months",
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  amortizationMonths?: number;
}
