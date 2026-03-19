import { PartialType } from "@nestjs/swagger";
import {
  IsOptional,
  IsArray,
  IsDateString,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { CreateTransactionDto } from "./create-transaction.dto";
import { CreateTransactionSplitDto } from "./create-transaction-split.dto";

export class UpdateTransactionDto extends PartialType(CreateTransactionDto) {
  @ApiPropertyOptional({
    description: "Splits for split transactions",
    type: [CreateTransactionSplitDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateTransactionSplitDto)
  splits?: CreateTransactionSplitDto[];

  @ApiPropertyOptional({
    description:
      "Override the created-at timestamp (ISO 8601). Requires showCreatedAt preference enabled.",
  })
  @IsOptional()
  @IsDateString()
  createdAt?: string;
}
