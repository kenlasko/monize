import {
  IsString,
  IsEnum,
  IsOptional,
  IsNumber,
  IsPositive,
  IsBoolean,
  MaxLength,
  Min,
  Max,
  IsUUID,
  IsDateString,
  IsIn,
  ValidateNested,
  IsArray,
  ArrayMaxSize,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  AccountType,
  INTEREST_BOOKING_MODES,
  InterestBookingMode,
} from "../entities/account.entity";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { IsCurrencyCode } from "../../common/validators/is-currency-code.validator";
import {
  MORTGAGE_TYPES,
  MortgageType,
  PREPAYMENT_MODES,
  PrepaymentMode,
} from "../mortgage-type.util";
import { PaymentMatchingDto } from "./payment-matching.dto";
import { LoanFeeDto } from "../../loan-fees/dto/loan-fee.dto";
import { MAX_LOAN_FEES } from "../../loan-installments/loan-fees";

/**
 * Payment frequencies a loan account can carry.
 *
 * `SEMIMONTHLY` is here because `LoanPaymentSetupService` legitimately writes it
 * to `accounts.payment_frequency` (it is what `SetupLoanPaymentsDto` accepts and
 * the setup dialog offers). Omitting it meant an account the app itself created
 * could not be saved again: `UpdateAccountDto` and `LoanPreviewDto` share this
 * list, so editing that loan, or asking for its amortization preview, answered
 * 400. Spelled without the underscore to match the recurrence enum, as
 * `PaymentFrequency` in loan-amortization.util.ts is -- and
 * `loan-payment-frequency.guard.spec.ts` holds the two lists equal.
 */
import {
  MORTGAGE_PAYMENT_FREQUENCIES,
  MortgagePaymentFrequency,
  PAYMENT_FREQUENCIES,
  PaymentFrequency,
} from "../payment-frequency.util";
import { IsMoneyAmount } from "../../common/validators/is-money-amount.validator";

/**
 * Re-exported, because every caller has always taken these from the DTO. The
 * lists themselves live in `payment-frequency.util.ts` beside the tables keyed
 * by them, so a new cadence is a COMPILE error in every Record that has to
 * handle it -- they were declared twice, here as `as const` arrays and there as
 * hand-written unions, with only a runtime spec holding the two together.
 */
export {
  MORTGAGE_PAYMENT_FREQUENCIES,
  PAYMENT_FREQUENCIES,
  MortgagePaymentFrequency,
  PaymentFrequency,
};

export class CreateAccountDto {
  @ApiProperty({
    enum: AccountType,
    example: AccountType.CHEQUING,
    description: "Type of account",
  })
  @IsEnum(AccountType)
  accountType: AccountType;

  @ApiProperty({
    example: "TD Chequing Account",
    description: "Display name for the account",
  })
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  name: string;

  @ApiPropertyOptional({
    example: "Primary chequing account for daily expenses",
    description: "Optional description of the account",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @SanitizeHtml()
  description?: string;

  @ApiProperty({
    example: "CAD",
    description: "ISO 4217 currency code (USD, CAD, EUR, etc.)",
    maxLength: 3,
  })
  @IsCurrencyCode()
  currencyCode: string;

  @ApiPropertyOptional({
    example: "****1234",
    description: "Account number (masked or encrypted)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  accountNumber?: string;

  @ApiPropertyOptional({
    example: "TD Canada Trust",
    description: "Legacy free-text financial institution name (deprecated)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  institution?: string;

  @ApiPropertyOptional({
    description: "ID of the financial institution this account belongs to",
  })
  @IsOptional()
  @IsUUID()
  institutionId?: string;

  @ApiPropertyOptional({
    example: 1000.0,
    description: "Opening balance for the account",
    default: 0,
  })
  @IsOptional()
  @IsMoneyAmount()
  @Min(-999999999999)
  @Max(999999999999)
  openingBalance?: number;

  @ApiPropertyOptional({
    example: 5000.0,
    description: "Credit limit (for credit cards)",
  })
  @IsOptional()
  @IsMoneyAmount(4)
  @IsPositive()
  creditLimit?: number;

  @ApiPropertyOptional({
    example: 3.5,
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
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isFavourite?: boolean;

  @ApiPropertyOptional({
    example: false,
    description: "Whether to exclude this account from net worth calculations",
    default: false,
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
      "Day of the month that is the last day of the billing cycle (1-31). Transactions posted on or before this day appear on the current statement.",
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(31)
  statementSettlementDay?: number;

  @ApiPropertyOptional({
    example: true,
    description:
      "When true and accountType is INVESTMENT, automatically creates a linked cash + brokerage account pair",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  createInvestmentPair?: boolean;

  // Loan-specific fields
  @ApiPropertyOptional({
    example: 500.0,
    description: "Monthly payment amount for loans",
  })
  @IsOptional()
  @IsMoneyAmount(4)
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
    description:
      "Category ID for the interest portion of payments; required for a LOAN or MORTGAGE",
  })
  @IsOptional()
  @IsUUID()
  interestCategoryId?: string;

  @ApiPropertyOptional({
    description:
      "How interest is recorded, for rate detection: AUTO (default), SPLIT (categorized split leg of the payment), or SEPARATE (standalone expense in the interest category)",
    enum: INTEREST_BOOKING_MODES,
  })
  @IsOptional()
  @IsIn(INTEREST_BOOKING_MODES)
  interestBookingMode?: InterestBookingMode;

  @ApiPropertyOptional({
    description:
      "Category ID used to tag standalone overpayments (extra principal) so the loan schedule can flag them",
  })
  @IsOptional()
  @IsUUID()
  overpaymentCategoryId?: string;

  @ApiPropertyOptional({
    description:
      "Memo text that marks a payment as a standalone overpayment (case-insensitive substring match); usable with or without the overpayment category",
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @SanitizeHtml()
  overpaymentMemo?: string;

  @ApiPropertyOptional({
    description:
      "Payee ID whose payments count as standalone overpayments (extra principal); usable with or without the overpayment category / memo",
  })
  @IsOptional()
  @IsUUID()
  overpaymentPayeeId?: string;

  // Foreign-transaction fee
  @ApiPropertyOptional({
    example: 2.5,
    description:
      "Foreign-currency conversion fee as a percentage (0-100), folded into the converted amount on foreign-entered transactions.",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  fxFeePercent?: number;

  // Asset-specific fields
  @ApiPropertyOptional({
    description: "Category ID for tracking value changes on asset accounts",
  })
  @IsOptional()
  @IsUUID()
  assetCategoryId?: string;

  @ApiPropertyOptional({
    example: "2020-06-15",
    description:
      "Date the asset was acquired (YYYY-MM-DD). Used to exclude from net worth before this date.",
  })
  @IsOptional()
  @IsDateString()
  dateAcquired?: string;

  // Mortgage-specific fields
  @ApiPropertyOptional({
    example: "CANADIAN_FIXED",
    description:
      "Mortgage type: ANNUITY (nominal rate divided by the payments per year), CANADIAN_FIXED (semi-annual compounding), LINEAR (constant principal) or INTEREST_ONLY (no principal until the final payment). LINEAR and INTEREST_ONLY require amortizationMonths, paymentStartDate and a non-accelerated payment frequency, and store no paymentAmount. ANNUITY when absent.",
    enum: MORTGAGE_TYPES,
  })
  @IsOptional()
  @IsIn(MORTGAGE_TYPES)
  mortgageType?: MortgageType;

  @ApiPropertyOptional({
    example: "SHORTEN_TERM",
    description:
      "LINEAR mortgages only: what an extra repayment does to the constant principal. SHORTEN_TERM (the default when absent) keeps it and ends the loan earlier; LOWER_INSTALLMENT re-derives it as the remaining debt over the remaining payments. Stored as null for every other type.",
    enum: PREPAYMENT_MODES,
  })
  @IsOptional()
  @IsIn(PREPAYMENT_MODES)
  prepaymentMode?: PrepaymentMode | null;

  @ApiPropertyOptional({
    example: 60,
    description:
      "Mortgage term length in months (e.g., 60 for 5-year term). 0 means no term.",
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  termMonths?: number;

  @ApiPropertyOptional({
    example: 300,
    description: "Total amortization period in months (e.g., 300 for 25 years)",
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  amortizationMonths?: number;

  @ApiPropertyOptional({
    example: "MONTHLY",
    description:
      "Payment frequency for mortgages (MONTHLY, SEMI_MONTHLY, BIWEEKLY, ACCELERATED_BIWEEKLY, WEEKLY, ACCELERATED_WEEKLY)",
  })
  @IsOptional()
  @IsString()
  @IsIn(MORTGAGE_PAYMENT_FREQUENCIES)
  mortgagePaymentFrequency?: MortgagePaymentFrequency;

  @ApiPropertyOptional({
    example: 300000,
    description:
      "Loans and mortgages: the amount originally borrowed, kept apart from the opening balance (the debt where this ledger starts). A LINEAR mortgage's constant principal is this over the scheduled payment count; when absent the mortgage paths store the opening balance",
  })
  @IsOptional()
  @IsMoneyAmount(4)
  @IsPositive()
  @Max(999999999999)
  originalPrincipal?: number;

  @ApiPropertyOptional({
    type: () => PaymentMatchingDto,
    description:
      "Mortgages and loans created with their scheduled payment: create the rule that settles the bank debits of the payment against each installment (docs/specs/loan-installment-settlement.md decision 5) and turn the bill's auto-post off. A rule the server cannot create is reported as paymentMatchingError on the saved account, which stays",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PaymentMatchingDto)
  paymentMatching?: PaymentMatchingDto;

  @ApiPropertyOptional({
    type: () => [LoanFeeDto],
    description:
      "Mortgages only: fees collected with each payment (insurance, taxes, other), each written as its own line of the scheduled payment and priced per installment (docs/specs/mortgage-fees.md). Not accepted together with paymentMatching",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LOAN_FEES)
  @ValidateNested({ each: true })
  @Type(() => LoanFeeDto)
  loanFees?: LoanFeeDto[];
}
