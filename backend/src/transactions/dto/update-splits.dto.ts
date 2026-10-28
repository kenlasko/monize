import {
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  IsOptional,
  Matches,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty } from "@nestjs/swagger";
import { UpdateTransactionSplitDto } from "./update-transaction-split.dto";

export class UpdateSplitsDto {
  @ApiProperty({
    description: "Replacement splits for the transaction",
    type: [UpdateTransactionSplitDto],
  })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => UpdateTransactionSplitDto)
  splits: UpdateTransactionSplitDto[];

  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/)
  accrualImpactFingerprint?: string;
}
