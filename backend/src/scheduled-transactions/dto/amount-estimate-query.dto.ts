import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsUUID, ValidateIf } from "class-validator";
import { IsCalendarDate } from "../../common/validators/is-calendar-date.validator";

/**
 * The query of `GET /scheduled-transactions/amount-estimate/:accountId`: the
 * payee and category a schedule's estimate is matched on (issue #2096).
 */
export class AmountEstimateQueryDto {
  @ApiProperty({ description: "Payee UUID the payment history is matched on" })
  @IsUUID()
  payeeId: string;

  @ApiProperty({
    description: "Category UUID the payment history is matched on",
  })
  @IsUUID()
  categoryId: string;

  @ApiPropertyOptional({
    description:
      "The schedule's next due date (YYYY-MM-DD), so an overdue occurrence's month is in the answer",
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsCalendarDate()
  nextDueDate?: string;
}
