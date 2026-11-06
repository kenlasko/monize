import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNumber,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import {
  LOAN_FEE_BASES,
  LOAN_FEE_CALCULATIONS,
  LoanFeeBasis,
  LoanFeeCalculation,
  MAX_LOAN_FEES,
} from "../../loan-installments/loan-fees";
import { IsMoneyAmount } from "../../common/validators/is-money-amount.validator";

/**
 * One fee collected with a mortgage payment (docs/specs/mortgage-fees.md
 * section 2). `amount` is required for a FIXED fee and `rate` for a
 * percentage; the service refuses the other one being set.
 */
export class LoanFeeDto {
  @ApiProperty({
    description:
      "The category the fee's line of the payment is booked to; one of the caller's own categories, and not the mortgage's interest category",
  })
  @IsUUID()
  categoryId: string;

  @ApiProperty({
    example: "Property tax",
    description: "The fee's name, written as the memo of its line",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @SanitizeHtml()
  name: string;

  @ApiProperty({
    enum: LOAN_FEE_CALCULATIONS,
    description:
      "FIXED (an amount), PERCENT_CURRENT_BALANCE (a percentage of the debt at each payment) or PERCENT_ORIGINAL_BALANCE (a percentage of the amount originally borrowed)",
  })
  @IsIn(LOAN_FEE_CALCULATIONS)
  calculation: LoanFeeCalculation;

  @ApiProperty({
    enum: LOAN_FEE_BASES,
    description:
      "PER_PAYMENT: the value is charged on every payment. ANNUAL: the value is a yearly figure divided over the payments in a year",
  })
  @IsIn(LOAN_FEE_BASES)
  basis: LoanFeeBasis;

  @ApiPropertyOptional({
    example: 3600,
    description: "A FIXED fee's amount, in the mortgage's currency",
  })
  @ValidateIf((o: LoanFeeDto) => o.calculation === "FIXED" || o.amount != null)
  @IsMoneyAmount(4)
  @IsPositive()
  @Max(999999999999)
  amount?: number | null;

  @ApiPropertyOptional({
    example: 0.5,
    description: "A percentage fee's rate, in percent (0.5 is half a percent)",
  })
  @ValidateIf((o: LoanFeeDto) => o.calculation !== "FIXED" || o.rate != null)
  @IsNumber({ maxDecimalPlaces: 6 })
  @IsPositive()
  @Max(100)
  rate?: number | null;
}

/** `PUT /accounts/:id/loan-fees`: the mortgage's whole fee set, in display order. */
export class ReplaceLoanFeesDto {
  @ApiProperty({ type: () => [LoanFeeDto] })
  @IsArray()
  @ArrayMaxSize(MAX_LOAN_FEES)
  @ValidateNested({ each: true })
  @Type(() => LoanFeeDto)
  fees: LoanFeeDto[];
}
