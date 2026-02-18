import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
  ValidateIf,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { TransactionStatus } from "../entities/transaction.entity";

export class BulkUpdateFilterDto {
  @ApiPropertyOptional({ description: "Filter by account IDs" })
  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  accountIds?: string[];

  @ApiPropertyOptional({ description: "Start date (YYYY-MM-DD)" })
  @IsOptional()
  @IsString()
  startDate?: string;

  @ApiPropertyOptional({ description: "End date (YYYY-MM-DD)" })
  @IsOptional()
  @IsString()
  endDate?: string;

  @ApiPropertyOptional({ description: "Filter by category IDs" })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  categoryIds?: string[];

  @ApiPropertyOptional({ description: "Filter by payee IDs" })
  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  payeeIds?: string[];

  @ApiPropertyOptional({ description: "Search text" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

export class BulkUpdateDto {
  @ApiProperty({
    description:
      'Selection mode: "ids" for explicit IDs, "filter" for filter-based',
    enum: ["ids", "filter"],
  })
  @IsEnum(["ids", "filter"])
  mode: "ids" | "filter";

  @ApiPropertyOptional({
    description: 'Transaction IDs (required when mode is "ids")',
    type: [String],
  })
  @ValidateIf((o) => o.mode === "ids")
  @IsArray()
  @IsUUID("4", { each: true })
  transactionIds?: string[];

  @ApiPropertyOptional({
    description: 'Filters (used when mode is "filter")',
  })
  @ValidateIf((o) => o.mode === "filter")
  @IsOptional()
  @ValidateNested()
  @Type(() => BulkUpdateFilterDto)
  filters?: BulkUpdateFilterDto;

  @ApiPropertyOptional({ description: "Set payee ID (null to clear)" })
  @IsOptional()
  @IsUUID("4")
  payeeId?: string | null;

  @ApiPropertyOptional({ description: "Set payee name (null to clear)" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  payeeName?: string | null;

  @ApiPropertyOptional({ description: "Set category ID (null to clear)" })
  @IsOptional()
  @IsUUID("4")
  categoryId?: string | null;

  @ApiPropertyOptional({ description: "Set description (null to clear)" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional({
    description: "Set status",
    enum: TransactionStatus,
  })
  @IsOptional()
  @IsEnum(TransactionStatus)
  status?: TransactionStatus;
}
