import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsOptional, IsUUID, ValidateIf } from "class-validator";
import { FrequencyType } from "./create-scheduled-transaction.dto";
import { IsCalendarDate } from "../../common/validators/is-calendar-date.validator";

/**
 * The query of `GET /scheduled-transactions/amount-estimate/:accountId`: the
 * payee and category a schedule's estimate is matched on (issue #2096), or
 * for a transfer the account it transfers to (issue #2164).
 */
export class AmountEstimateQueryDto {
  @ApiPropertyOptional({
    description:
      "Payee UUID the payment history is matched on; required unless transferAccountId is sent",
  })
  @ValidateIf((o) => !o.transferAccountId)
  @IsUUID()
  payeeId?: string;

  @ApiPropertyOptional({
    description:
      "Category UUID the payment history is matched on; required unless transferAccountId is sent",
  })
  @ValidateIf((o) => !o.transferAccountId)
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    description:
      "For a transfer: the destination account UUID the transfer history is matched on and whose balance raises the estimate",
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsUUID()
  transferAccountId?: string;

  @ApiPropertyOptional({
    description:
      "For a transfer: the schedule's frequency, which decides whether a credit card's statement cycle applies",
    enum: FrequencyType,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsEnum(FrequencyType)
  frequency?: FrequencyType;

  @ApiPropertyOptional({
    description:
      "The schedule's next due date (YYYY-MM-DD), so an overdue occurrence's month is in the answer",
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsCalendarDate()
  nextDueDate?: string;
}
