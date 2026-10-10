import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";

/** How many occurrences the projection answers when the client does not say. */
export const LOAN_OCCURRENCES_DEFAULT_COUNT = 12;

/**
 * The most occurrences one projection prices
 * (`docs/specs/scheduled-loan-installment-pricing.md` section 8.5): the
 * walk is bounded by it, and the ledger is read in one statement for every
 * date whatever the count, so the bound is on the payload, not the cost.
 */
export const LOAN_OCCURRENCES_MAX_COUNT = 60;

/** The query of `GET /scheduled-transactions/:id/loan-occurrences`. */
export class LoanOccurrencesQueryDto {
  @ApiPropertyOptional({
    example: LOAN_OCCURRENCES_DEFAULT_COUNT,
    default: LOAN_OCCURRENCES_DEFAULT_COUNT,
    description: `How many of the next occurrences to price, 1 to ${LOAN_OCCURRENCES_MAX_COUNT}`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LOAN_OCCURRENCES_MAX_COUNT)
  count?: number;
}
