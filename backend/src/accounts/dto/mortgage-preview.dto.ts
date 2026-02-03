import {
  IsNumber,
  IsPositive,
  IsBoolean,
  IsDateString,
  IsIn,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
  MORTGAGE_PAYMENT_FREQUENCIES,
  MortgagePaymentFrequency,
} from './create-account.dto';

export class MortgagePreviewDto {
  @ApiProperty({
    example: 400000,
    description: 'Mortgage principal amount',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  mortgageAmount: number;

  @ApiProperty({
    example: 5.5,
    description: 'Annual interest rate as percentage (e.g., 5.5 for 5.5%)',
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  interestRate: number;

  @ApiProperty({
    example: 300,
    description: 'Total amortization period in months (e.g., 300 for 25 years)',
  })
  @IsNumber()
  @IsPositive()
  amortizationMonths: number;

  @ApiProperty({
    example: 'MONTHLY',
    description: 'Payment frequency',
    enum: MORTGAGE_PAYMENT_FREQUENCIES,
  })
  @IsIn(MORTGAGE_PAYMENT_FREQUENCIES)
  paymentFrequency: MortgagePaymentFrequency;

  @ApiProperty({
    example: '2024-02-01',
    description: 'First payment date (YYYY-MM-DD)',
  })
  @IsDateString()
  paymentStartDate: string;

  @ApiProperty({
    example: true,
    description: 'Whether this is a Canadian mortgage (semi-annual compounding for fixed rates)',
  })
  @IsBoolean()
  isCanadian: boolean;

  @ApiProperty({
    example: false,
    description: 'Whether this is a variable rate mortgage (monthly compounding)',
  })
  @IsBoolean()
  isVariableRate: boolean;
}

export class MortgagePreviewResponseDto {
  @ApiProperty({
    example: 2450.23,
    description: 'Calculated payment amount per period',
  })
  paymentAmount: number;

  @ApiProperty({
    example: 618.9,
    description: 'Principal portion of first payment',
  })
  principalPayment: number;

  @ApiProperty({
    example: 1831.33,
    description: 'Interest portion of first payment',
  })
  interestPayment: number;

  @ApiProperty({
    example: 300,
    description: 'Total number of payments',
  })
  totalPayments: number;

  @ApiProperty({
    example: '2049-02-01',
    description: 'Estimated payoff date',
  })
  endDate: string;

  @ApiProperty({
    example: 335069.0,
    description: 'Total interest over life of mortgage',
  })
  totalInterest: number;

  @ApiProperty({
    example: 5.58,
    description: 'Effective annual rate after compounding',
  })
  effectiveAnnualRate: number;
}
