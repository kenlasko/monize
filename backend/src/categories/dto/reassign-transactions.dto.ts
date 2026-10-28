import { IsOptional, IsUUID, Matches } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";

export class ReassignTransactionsDto {
  @ApiPropertyOptional({
    description: "Fingerprint from the category reassignment preview",
  })
  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/)
  accrualImpactFingerprint?: string;

  @ApiPropertyOptional({
    description:
      "Target category ID to reassign transactions to, or null to uncategorize",
  })
  @IsOptional()
  @IsUUID()
  toCategoryId?: string | null;
}
