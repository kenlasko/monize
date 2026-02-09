import {
  IsNumber,
  IsPositive,
  IsOptional,
  IsDateString,
  Min,
  Max,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class UpdateMortgageRateDto {
  @ApiProperty({
    example: 5.25,
    description:
      "New annual interest rate as percentage (e.g., 5.25 for 5.25%)",
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  newRate: number;

  @ApiPropertyOptional({
    example: 2500.0,
    description:
      "Optional new payment amount. If omitted, payment will be recalculated based on current balance and remaining amortization.",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  newPaymentAmount?: number;

  @ApiProperty({
    example: "2024-06-01",
    description: "Date when the new rate takes effect (YYYY-MM-DD)",
  })
  @IsDateString()
  effectiveDate: string;
}

export class UpdateMortgageRateResponseDto {
  @ApiProperty({
    example: 5.25,
    description: "The new interest rate",
  })
  newRate: number;

  @ApiProperty({
    example: 2450.23,
    description: "The new payment amount (calculated or manually specified)",
  })
  paymentAmount: number;

  @ApiProperty({
    example: 618.9,
    description: "Principal portion of next payment",
  })
  principalPayment: number;

  @ApiProperty({
    example: 1831.33,
    description: "Interest portion of next payment",
  })
  interestPayment: number;

  @ApiProperty({
    example: "2024-06-01",
    description: "Effective date of the rate change",
  })
  effectiveDate: string;
}
