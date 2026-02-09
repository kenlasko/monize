import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsOptional,
  IsNumber,
  IsUUID,
  IsString,
  IsBoolean,
  IsArray,
  ValidateNested,
  IsDateString,
} from "class-validator";
import { Type } from "class-transformer";

class InlineSplitDto {
  @ApiPropertyOptional({ description: "Category ID for this split" })
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional({ description: "Transfer account ID for this split" })
  @IsOptional()
  @IsUUID()
  transferAccountId?: string | null;

  @ApiPropertyOptional({ description: "Amount for this split" })
  @IsNumber()
  amount: number;

  @ApiPropertyOptional({ description: "Memo for this split" })
  @IsOptional()
  @IsString()
  memo?: string | null;
}

export class PostScheduledTransactionDto {
  @ApiPropertyOptional({
    description: "Transaction date (defaults to next due date)",
  })
  @IsOptional()
  @IsDateString()
  transactionDate?: string;

  @ApiPropertyOptional({ description: "Override amount for this posting only" })
  @IsOptional()
  @IsNumber()
  amount?: number;

  @ApiPropertyOptional({
    description: "Override category ID for this posting only",
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional({
    description: "Override description for this posting only",
  })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({ description: "Use splits for this posting" })
  @IsOptional()
  @IsBoolean()
  isSplit?: boolean;

  @ApiPropertyOptional({
    description: "Override splits for this posting only",
    type: [InlineSplitDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InlineSplitDto)
  splits?: InlineSplitDto[];
}
