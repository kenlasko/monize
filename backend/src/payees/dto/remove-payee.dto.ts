import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, Matches } from "class-validator";
export class RemovePayeeDto {
  @ApiPropertyOptional({
    description: "Fingerprint from the payee removal preview",
  })
  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/)
  accrualImpactFingerprint?: string;
}
