import {
  IsDefined,
  IsEnum,
  IsOptional,
  IsUUID,
  Matches,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { CreateTransactionSplitDto } from "./create-transaction-split.dto";

export class AddTransactionSplitDto extends CreateTransactionSplitDto {
  @ApiPropertyOptional({
    description: "Fingerprint from the incremental split preview",
  })
  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/)
  accrualImpactFingerprint?: string;
}
export class RemoveTransactionSplitDto {
  @ApiPropertyOptional({
    description: "Fingerprint from the incremental split preview",
  })
  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/)
  accrualImpactFingerprint?: string;
}
export class IncrementalSplitPreviewDto {
  @ApiProperty({ enum: ["add", "remove"] })
  @IsEnum(["add", "remove"])
  operation: "add" | "remove";

  @ApiPropertyOptional({ type: CreateTransactionSplitDto })
  @ValidateIf((value) => value.operation === "add")
  @IsDefined()
  @ValidateNested()
  @Type(() => CreateTransactionSplitDto)
  split?: CreateTransactionSplitDto;

  @ApiPropertyOptional({ format: "uuid" })
  @ValidateIf((value) => value.operation === "remove")
  @IsDefined()
  @IsUUID()
  splitId?: string;
}
