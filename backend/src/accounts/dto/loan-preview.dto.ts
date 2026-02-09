import {
  IsNumber,
  IsString,
  IsDateString,
  IsIn,
  Min,
  Max,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { PAYMENT_FREQUENCIES, PaymentFrequency } from "./create-account.dto";

export class LoanPreviewDto {
  @ApiProperty({
    example: 25000,
    description: "Loan amount (positive number)",
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  loanAmount: number;

  @ApiProperty({
    example: 5.5,
    description: "Annual interest rate as percentage (e.g., 5.5 for 5.5%)",
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  interestRate: number;

  @ApiProperty({
    example: 500,
    description: "Payment amount per period",
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  paymentAmount: number;

  @ApiProperty({
    example: "MONTHLY",
    description: "Payment frequency",
    enum: PAYMENT_FREQUENCIES,
  })
  @IsString()
  @IsIn(PAYMENT_FREQUENCIES)
  paymentFrequency: PaymentFrequency;

  @ApiProperty({
    example: "2024-02-01",
    description: "Start date for loan payments (YYYY-MM-DD)",
  })
  @IsDateString()
  paymentStartDate: string;
}
