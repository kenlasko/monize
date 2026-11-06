import {
  IsString,
  IsOptional,
  IsNumber,
  IsDateString,
  IsBoolean,
  IsPositive,
  MaxLength,
  Min,
  Max,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { IsMoneyAmount } from "../../common/validators/is-money-amount.validator";

export class CreateLoanRateChangeDto {
  @ApiProperty({
    example: "2024-06-01",
    description: "Date the new rate takes effect (YYYY-MM-DD)",
  })
  @IsDateString()
  effectiveDate: string;

  @ApiProperty({
    example: 4.9,
    description: "New annual interest rate as a percentage (e.g. 4.9)",
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  annualRate: number;

  @ApiPropertyOptional({
    example: 2500.0,
    description:
      "New regular payment from this date. Omit to keep the payment unchanged. Refused for LINEAR and INTEREST_ONLY mortgages, whose installment is priced from the debt and rate on each due date.",
  })
  @IsOptional()
  @IsMoneyAmount(2)
  @IsPositive()
  newPaymentAmount?: number | null;

  @ApiPropertyOptional({
    description:
      "Recalculate the payment to hold the remaining amortization constant (mortgages only). Mutually exclusive with newPaymentAmount.",
  })
  @IsOptional()
  @IsBoolean()
  recalculatePayment?: boolean;

  @ApiPropertyOptional({ description: "Optional note about the change" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @SanitizeHtml()
  note?: string | null;
}
