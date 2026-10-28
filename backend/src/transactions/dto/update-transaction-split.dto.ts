import { IsOptional, IsUUID } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { CreateTransactionSplitDto } from "./create-transaction-split.dto";

export class UpdateTransactionSplitDto extends CreateTransactionSplitDto {
  @ApiPropertyOptional({
    description:
      "Existing category split ID to retain when replacing this line.",
  })
  @IsOptional()
  @IsUUID()
  id?: string;
}
