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
  ValidateIf,
} from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  AccountType,
  INTEREST_BOOKING_MODES,
  InterestBookingMode,
} from "../entities/account.entity";
import { PAYMENT_FREQUENCIES, PaymentFrequency } from "./create-account.dto";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { IsCurrencyCode } from "../../common/validators/is-currency-code.validator";

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
  @IsCurrencyCode()
  currencyCode?: string;

  @ApiPropertyOptional({
    example: 1000.0,
    description: "Opening balance for the account",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(-999999999999)
  @Max(999999999999)
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
    description: "Legacy free-text financial institution name (deprecated)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  institution?: string;

  @ApiPropertyOptional({
    description:
      "ID of the financial institution this account belongs to. Pass null to clear.",
  })
  @IsOptional()
  @ValidateIf((o) => o.institutionId !== null)
  @IsUUID()
  institutionId?: string | null;

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

  @ApiPropertyOptional({
    description: "Sort order for favourite accounts display",
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  favouriteSortOrder?: number;

  @ApiPropertyOptional({
    example: false,
    description: "Whether to exclude this account from net worth calculations",
  })
  @IsOptional()
  @IsBoolean()
  excludeFromNetWorth?: boolean;

  // Credit card statement fields
  @ApiPropertyOptional({
    example: 15,
    description: "Day of the month when the credit card payment is due (1-31)",
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(31)
  statementDueDay?: number;

  @ApiPropertyOptional({
    example: 25,
    description:
      "Day of the month that is the last day of the billing cycle (1-31)",
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(31)
  statementSettlementDay?: number;

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
    description:
      "Category ID for the interest portion of payments. Pass null to clear.",
  })
  @IsOptional()
  @ValidateIf((o) => o.interestCategoryId !== null)
  @IsUUID()
  interestCategoryId?: string | null;

  @ApiPropertyOptional({
    description:
      "How interest is recorded, for rate detection: AUTO, SPLIT, or SEPARATE.",
    enum: INTEREST_BOOKING_MODES,
  })
  @IsOptional()
  @IsIn(INTEREST_BOOKING_MODES)
  interestBookingMode?: InterestBookingMode;

  @ApiPropertyOptional({
    description:
      "Category ID used to tag standalone overpayments (extra principal). Pass null to clear.",
  })
  @IsOptional()
  @ValidateIf((o) => o.overpaymentCategoryId !== null)
  @IsUUID()
  overpaymentCategoryId?: string | null;

  @ApiPropertyOptional({
    description:
      "Memo text that marks a payment as a standalone overpayment (case-insensitive substring match). Pass null or empty to clear.",
  })
  @IsOptional()
  @ValidateIf((o) => o.overpaymentMemo !== null)
  @IsString()
  @MaxLength(255)
  @SanitizeHtml()
  overpaymentMemo?: string | null;

  @ApiPropertyOptional({
    description:
      "Payee ID whose payments count as standalone overpayments (extra principal). Pass null to clear.",
  })
  @IsOptional()
  @ValidateIf((o) => o.overpaymentPayeeId !== null)
  @IsUUID()
  overpaymentPayeeId?: string | null;

  // Foreign-transaction fee fields
  @ApiPropertyOptional({
    example: 2.5,
    description:
      "Foreign-currency conversion fee as a percentage (0-100). Requires fxFeeCategoryId when set. Pass null to clear.",
  })
  @IsOptional()
  @ValidateIf((o) => o.fxFeePercent !== null)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  fxFeePercent?: number | null;

  @ApiPropertyOptional({
    description:
      "Category ID for the auto-booked foreign-transaction fee split. Required when fxFeePercent is set. Pass null to clear.",
  })
  @IsOptional()
  @ValidateIf((o) => o.fxFeeCategoryId !== null)
  @IsUUID()
  fxFeeCategoryId?: string | null;

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

  @ApiPropertyOptional({
    description:
      "Linked loan/mortgage account ID for the asset equity view (null to unlink)",
  })
  @IsOptional()
  @ValidateIf((o) => o.linkedLoanAccountId !== null)
  @IsUUID()
  linkedLoanAccountId?: string | null;

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
