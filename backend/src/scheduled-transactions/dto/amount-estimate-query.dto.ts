import { ApiProperty } from "@nestjs/swagger";
import { IsUUID } from "class-validator";

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
}
