import {
  IsString,
  IsNumber,
  IsOptional,
  IsUUID,
  IsArray,
  IsBoolean,
  IsEnum,
  ValidateNested,
  MaxLength,
  Min,
  Max,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { InvestmentAction } from "../../securities/entities/investment-transaction.entity";
import { SplitKind } from "../entities/split-kind.enum";

export class InvestmentSplitDto {
  @ApiProperty({ enum: InvestmentAction, description: "Investment action" })
  @IsEnum(InvestmentAction)
  action: InvestmentAction;

  @ApiPropertyOptional({ description: "Security ID for the action" })
  @IsOptional()
  @IsUUID()
  securityId?: string;

  @ApiPropertyOptional({ description: "Number of shares" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0)
  quantity?: number;

  @ApiPropertyOptional({ description: "Price per share" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  price?: number;

  @ApiPropertyOptional({ description: "Commission or fee", default: 0 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  commission?: number;

  @ApiPropertyOptional({
    description:
      "Exchange rate from security currency into the parent transaction's cash account currency. Defaults to 1 / market rate when omitted.",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 10 })
  @Min(0)
  exchangeRate?: number;

  @ApiPropertyOptional({ description: "Description of the action" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @SanitizeHtml()
  description?: string;
}

export class CreateTransactionSplitDto {
  @ApiPropertyOptional({
    enum: SplitKind,
    description:
      "Discriminator. If omitted, inferred from which of categoryId/transferAccountId/investment is set.",
  })
  @IsOptional()
  @IsEnum(SplitKind)
  splitKind?: SplitKind;

  @ApiPropertyOptional({
    description:
      "Category ID for this split (mutually exclusive with transferAccountId/investment)",
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    description:
      "Target account ID for transfer split (mutually exclusive with categoryId/investment)",
  })
  @IsOptional()
  @IsUUID()
  transferAccountId?: string;

  @ApiPropertyOptional({
    description:
      "Embedded investment action (mutually exclusive with categoryId/transferAccountId). The split's amount must equal the cash impact of this action.",
    type: InvestmentSplitDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => InvestmentSplitDto)
  investment?: InvestmentSplitDto;

  @ApiProperty({
    description:
      "Amount for this split (must be same sign as parent transaction)",
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(-999999999999)
  @Max(999999999999)
  amount: number;

  @ApiPropertyOptional({ description: "Memo/note for this split" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @SanitizeHtml()
  memo?: string;

  @ApiPropertyOptional({
    description:
      "Marks this split as the auto-generated foreign-transaction fee. At most one fee split per transaction; must be a category split.",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isFxFee?: boolean;

  @ApiPropertyOptional({
    description:
      "Tag IDs to assign to this split (cumulative with parent transaction tags)",
  })
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  tagIds?: string[];
}
