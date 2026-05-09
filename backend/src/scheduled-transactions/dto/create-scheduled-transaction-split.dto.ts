import {
  IsNumber,
  IsUUID,
  IsOptional,
  IsString,
  IsArray,
  IsEnum,
  ValidateNested,
  ValidateIf,
  MaxLength,
  Min,
  Max,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { InvestmentSplitDto } from "../../transactions/dto/create-transaction-split.dto";
import { SplitKind } from "../../transactions/entities/split-kind.enum";

export class CreateScheduledTransactionSplitDto {
  @ApiPropertyOptional({ enum: SplitKind })
  @IsOptional()
  @IsEnum(SplitKind)
  splitKind?: SplitKind;

  @ApiPropertyOptional({
    description:
      "Category ID for expense/income splits (mutually exclusive with transferAccountId / investment)",
  })
  @IsOptional()
  @IsUUID()
  @ValidateIf((o) => !o.transferAccountId && !o.investment)
  categoryId?: string;

  @ApiPropertyOptional({
    description:
      "Target account ID for transfer splits (mutually exclusive with categoryId / investment)",
  })
  @IsOptional()
  @IsUUID()
  @ValidateIf((o) => !o.categoryId && !o.investment)
  transferAccountId?: string;

  @ApiPropertyOptional({
    description:
      "Embedded investment payload (mutually exclusive with categoryId / transferAccountId). When set, the split is persisted with kind='investment' and posted as an embedded BUY/SELL/etc.",
    type: InvestmentSplitDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => InvestmentSplitDto)
  investment?: InvestmentSplitDto;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(-999999999999)
  @Max(999999999999)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @SanitizeHtml()
  memo?: string;

  @ApiPropertyOptional({
    description:
      "Tag IDs to assign to this split (applied when posting the transaction)",
  })
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  tagIds?: string[];
}
