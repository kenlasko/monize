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
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccountType } from '../entities/account.entity';

export const PAYMENT_FREQUENCIES = [
  'WEEKLY',
  'BIWEEKLY',
  'MONTHLY',
  'QUARTERLY',
  'YEARLY',
] as const;

export type PaymentFrequency = (typeof PAYMENT_FREQUENCIES)[number];

export const MORTGAGE_PAYMENT_FREQUENCIES = [
  'MONTHLY',
  'SEMI_MONTHLY',
  'BIWEEKLY',
  'ACCELERATED_BIWEEKLY',
  'WEEKLY',
  'ACCELERATED_WEEKLY',
] as const;

export type MortgagePaymentFrequency = (typeof MORTGAGE_PAYMENT_FREQUENCIES)[number];

export class CreateAccountDto {
  @ApiProperty({
    enum: AccountType,
    example: AccountType.CHEQUING,
    description: 'Type of account',
  })
  @IsEnum(AccountType)
  accountType: AccountType;

  @ApiProperty({
    example: 'TD Chequing Account',
    description: 'Display name for the account',
  })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({
    example: 'Primary chequing account for daily expenses',
    description: 'Optional description of the account',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    example: 'CAD',
    description: 'ISO 4217 currency code (USD, CAD, EUR, etc.)',
    maxLength: 3,
  })
  @IsString()
  @MaxLength(3)
  currencyCode: string;

  @ApiPropertyOptional({
    example: '****1234',
    description: 'Account number (masked or encrypted)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  accountNumber?: string;

  @ApiPropertyOptional({
    example: 'TD Canada Trust',
    description: 'Financial institution name',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  institution?: string;

  @ApiPropertyOptional({
    example: 1000.00,
    description: 'Opening balance for the account',
    default: 0,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  openingBalance?: number;

  @ApiPropertyOptional({
    example: 5000.00,
    description: 'Credit limit (for credit cards)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @IsPositive()
  creditLimit?: number;

  @ApiPropertyOptional({
    example: 3.5,
    description: 'Interest rate percentage (for loans, mortgages, savings)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  interestRate?: number;

  @ApiPropertyOptional({
    example: true,
    description: 'Whether this account is a favourite (shown in dashboard)',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isFavourite?: boolean;

  @ApiPropertyOptional({
    example: true,
    description:
      'When true and accountType is INVESTMENT, automatically creates a linked cash + brokerage account pair',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  createInvestmentPair?: boolean;

  // Loan-specific fields
  @ApiPropertyOptional({
    example: 500.0,
    description: 'Monthly payment amount for loans',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @IsPositive()
  paymentAmount?: number;

  @ApiPropertyOptional({
    example: 'MONTHLY',
    description: 'Payment frequency for loans (WEEKLY, BIWEEKLY, MONTHLY, QUARTERLY, YEARLY)',
  })
  @IsOptional()
  @IsString()
  @IsIn(PAYMENT_FREQUENCIES)
  paymentFrequency?: PaymentFrequency;

  @ApiPropertyOptional({
    example: '2024-02-01',
    description: 'Start date for loan payments (YYYY-MM-DD)',
  })
  @IsOptional()
  @IsDateString()
  paymentStartDate?: string;

  @ApiPropertyOptional({
    description: 'Source account ID for loan payments (where payments come from)',
  })
  @IsOptional()
  @IsUUID()
  sourceAccountId?: string;

  @ApiPropertyOptional({
    description: 'Category ID for interest portion of payments (defaults to "Loan Interest")',
  })
  @IsOptional()
  @IsUUID()
  interestCategoryId?: string;

  // Asset-specific fields
  @ApiPropertyOptional({
    description: 'Category ID for tracking value changes on asset accounts',
  })
  @IsOptional()
  @IsUUID()
  assetCategoryId?: string;

  // Mortgage-specific fields
  @ApiPropertyOptional({
    example: true,
    description: 'Whether this is a Canadian mortgage (uses semi-annual compounding for fixed rates)',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isCanadianMortgage?: boolean;

  @ApiPropertyOptional({
    example: false,
    description: 'Whether this is a variable rate mortgage (uses monthly compounding)',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isVariableRate?: boolean;

  @ApiPropertyOptional({
    example: 60,
    description: 'Mortgage term length in months (e.g., 60 for 5-year term)',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  termMonths?: number;

  @ApiPropertyOptional({
    example: 300,
    description: 'Total amortization period in months (e.g., 300 for 25 years)',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  amortizationMonths?: number;

  @ApiPropertyOptional({
    example: 'MONTHLY',
    description: 'Payment frequency for mortgages (MONTHLY, SEMI_MONTHLY, BIWEEKLY, ACCELERATED_BIWEEKLY, WEEKLY, ACCELERATED_WEEKLY)',
  })
  @IsOptional()
  @IsString()
  @IsIn(MORTGAGE_PAYMENT_FREQUENCIES)
  mortgagePaymentFrequency?: MortgagePaymentFrequency;
}
