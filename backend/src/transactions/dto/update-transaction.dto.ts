import { OmitType, PartialType } from "@nestjs/swagger";
import {
  IsOptional,
  Matches,
  ArrayMaxSize,
  IsArray,
  IsDateString,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { CreateTransactionDto } from "./create-transaction.dto";
import { UpdateTransactionSplitDto } from "./update-transaction-split.dto";

// `externalId` is set once, by the create that the key makes idempotent; an
// edit that could change it would let a retry of that create miss its row.
export class UpdateTransactionDto extends PartialType(
  OmitType(CreateTransactionDto, ["externalId"] as const),
) {
  @ApiPropertyOptional({
    description: "Splits for split transactions",
    type: [UpdateTransactionSplitDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => UpdateTransactionSplitDto)
  splits?: UpdateTransactionSplitDto[];

  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/)
  accrualImpactFingerprint?: string;

  @ApiPropertyOptional({
    description:
      "Override the created-at timestamp (ISO 8601). Requires showCreatedAt preference enabled.",
  })
  @IsOptional()
  @IsDateString()
  createdAt?: string;
}
