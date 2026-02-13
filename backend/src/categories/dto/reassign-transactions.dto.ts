import { IsOptional, IsUUID } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";

export class ReassignTransactionsDto {
  @ApiPropertyOptional({
    description:
      "Target category ID to reassign transactions to, or null to uncategorize",
  })
  @IsOptional()
  @IsUUID()
  toCategoryId?: string | null;
}
