import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Matches,
  Min,
  ValidateNested,
  ValidateIf,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { TransactionStatus } from "../entities/transaction.entity";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { TRANSACTION_NOTE_MAX_LENGTH } from "../../common/transaction-note";

export class BulkUpdateFilterDto {
  @ApiPropertyOptional({ description: "Filter by account IDs" })
  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  accountIds?: string[];

  @ApiPropertyOptional({ description: "Start date (YYYY-MM-DD)" })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: "End date (YYYY-MM-DD)" })
  @IsOptional()
  @IsDateString()
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

  @ApiPropertyOptional({ description: "Minimum amount (inclusive)" })
  @IsOptional()
  @IsNumber()
  @Min(-999999999999)
  @Max(999999999999)
  amountFrom?: number;

  @ApiPropertyOptional({ description: "Maximum amount (inclusive)" })
  @IsOptional()
  @IsNumber()
  @Min(-999999999999)
  @Max(999999999999)
  amountTo?: number;

  @ApiPropertyOptional({ description: "Filter by tag IDs" })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID("4", { each: true })
  tagIds?: string[];
}

export class BulkUpdateDto {
  @ApiPropertyOptional({
    description: "Fingerprint from the accrual bulk preview",
  })
  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/)
  accrualImpactFingerprint?: string;

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

  @ApiPropertyOptional({
    description:
      'Transaction IDs to exclude (used when mode is "filter" to deselect specific items)',
    type: [String],
  })
  @ValidateIf((o) => o.mode === "filter")
  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  excludedIds?: string[];

  @ApiPropertyOptional({ description: "Set payee ID (null to clear)" })
  @IsOptional()
  @IsUUID("4")
  payeeId?: string | null;

  @ApiPropertyOptional({ description: "Set payee name (null to clear)" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  payeeName?: string | null;

  @ApiPropertyOptional({ description: "Set category ID (null to clear)" })
  @IsOptional()
  @IsUUID("4")
  categoryId?: string | null;

  @ApiPropertyOptional({ description: "Set description (null to clear)" })
  @IsOptional()
  @IsString()
  @MaxLength(TRANSACTION_NOTE_MAX_LENGTH)
  @SanitizeHtml()
  description?: string | null;

  @ApiPropertyOptional({
    description: "Set status",
    enum: TransactionStatus,
  })
  @IsOptional()
  @IsEnum(TransactionStatus)
  status?: TransactionStatus;

  @ApiPropertyOptional({
    description: "Set tag IDs (empty array to clear all tags)",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  tagIds?: string[];

  @ApiPropertyOptional({
    description:
      "Category filter active in the UI when the bulk update was issued. " +
      "Restricts split-line recategorization to lines currently in these " +
      "categories (descendant-expanded), regardless of selection mode; does " +
      "not affect which transactions are selected. May include the " +
      '"uncategorized"/"transfer" pseudo-ids, which are ignored.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  categoryFilterIds?: string[];
}

export class BulkDeleteDto {
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

  @ApiPropertyOptional({
    description:
      'Transaction IDs to exclude (used when mode is "filter" to deselect specific items)',
    type: [String],
  })
  @ValidateIf((o) => o.mode === "filter")
  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  excludedIds?: string[];
}
