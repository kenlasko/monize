import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsNumber,
  IsOptional,
  IsUUID,
  IsBoolean,
  IsArray,
  IsEnum,
  ValidateNested,
  IsDateString,
  MaxLength,
} from "class-validator";
import { Type } from "class-transformer";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { InvestmentSplitDto } from "../../transactions/dto/create-transaction-split.dto";
import { SplitKind } from "../../transactions/entities/split-kind.enum";

export class OverrideSplitDto {
  @ApiPropertyOptional({ enum: SplitKind })
  @IsOptional()
  @IsEnum(SplitKind)
  splitKind?: SplitKind;

  @ApiPropertyOptional({ description: "Category ID for this split" })
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional({ description: "Transfer account ID for this split" })
  @IsOptional()
  @IsUUID()
  transferAccountId?: string | null;

  @ApiPropertyOptional({
    description: "Embedded investment payload",
    type: InvestmentSplitDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => InvestmentSplitDto)
  investment?: InvestmentSplitDto;

  @ApiProperty({ description: "Amount for this split" })
  @IsNumber()
  amount: number;

  @ApiPropertyOptional({ description: "Memo for this split" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @SanitizeHtml()
  memo?: string | null;
}

export class CreateScheduledTransactionOverrideDto {
  @ApiProperty({
    description:
      "The original calculated occurrence date being overridden (YYYY-MM-DD)",
  })
  @IsDateString()
  originalDate: string;

  @ApiProperty({
    description:
      "The actual date for this occurrence (YYYY-MM-DD), may be same as originalDate or different if date was changed",
  })
  @IsDateString()
  overrideDate: string;

  @ApiPropertyOptional({ description: "Overridden amount" })
  @IsOptional()
  @IsNumber()
  amount?: number | null;

  @ApiPropertyOptional({ description: "Overridden category ID" })
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional({ description: "Overridden description" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @SanitizeHtml()
  description?: string | null;

  @ApiPropertyOptional({
    description: "Whether to use splits for this override",
  })
  @IsOptional()
  @IsBoolean()
  isSplit?: boolean | null;

  @ApiPropertyOptional({
    description: "Split overrides",
    type: [OverrideSplitDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OverrideSplitDto)
  splits?: OverrideSplitDto[] | null;

  @ApiPropertyOptional({ description: "Per-occurrence investment quantity" })
  @IsOptional()
  @IsNumber()
  investmentQuantity?: number | null;

  @ApiPropertyOptional({ description: "Per-occurrence investment price" })
  @IsOptional()
  @IsNumber()
  investmentPrice?: number | null;

  @ApiPropertyOptional({
    description:
      "Per-occurrence investment total amount (for DIVIDEND/INTEREST/CAPITAL_GAIN)",
  })
  @IsOptional()
  @IsNumber()
  investmentTotalAmount?: number | null;
}

export class UpdateScheduledTransactionOverrideDto {
  @ApiPropertyOptional({ description: "Overridden amount" })
  @IsOptional()
  @IsNumber()
  amount?: number | null;

  @ApiPropertyOptional({ description: "Overridden category ID" })
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional({ description: "Overridden description" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @SanitizeHtml()
  description?: string | null;

  @ApiPropertyOptional({
    description: "Whether to use splits for this override",
  })
  @IsOptional()
  @IsBoolean()
  isSplit?: boolean | null;

  @ApiPropertyOptional({
    description: "Split overrides",
    type: [OverrideSplitDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OverrideSplitDto)
  splits?: OverrideSplitDto[] | null;

  @ApiPropertyOptional({ description: "Per-occurrence investment quantity" })
  @IsOptional()
  @IsNumber()
  investmentQuantity?: number | null;

  @ApiPropertyOptional({ description: "Per-occurrence investment price" })
  @IsOptional()
  @IsNumber()
  investmentPrice?: number | null;

  @ApiPropertyOptional({
    description:
      "Per-occurrence investment total amount (for DIVIDEND/INTEREST/CAPITAL_GAIN)",
  })
  @IsOptional()
  @IsNumber()
  investmentTotalAmount?: number | null;
}

export class ScheduledTransactionOverrideResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  scheduledTransactionId: string;

  @ApiProperty()
  originalDate: string;

  @ApiProperty()
  overrideDate: string;

  @ApiPropertyOptional()
  amount: number | null;

  @ApiPropertyOptional()
  categoryId: string | null;

  @ApiPropertyOptional()
  description: string | null;

  @ApiPropertyOptional()
  isSplit: boolean | null;

  @ApiPropertyOptional()
  splits: OverrideSplitDto[] | null;

  @ApiPropertyOptional()
  investmentQuantity: number | null;

  @ApiPropertyOptional()
  investmentPrice: number | null;

  @ApiPropertyOptional()
  investmentTotalAmount: number | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
