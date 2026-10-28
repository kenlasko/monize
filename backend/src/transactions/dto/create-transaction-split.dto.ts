import {
  IsString,
  IsNumber,
  IsOptional,
  IsUUID,
  IsArray,
  ArrayMaxSize,
  IsEnum,
  ValidateNested,
  ValidateIf,
  MaxLength,
  Min,
  Max,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { InvestmentAction } from "../../securities/entities/investment-transaction.entity";
import { SplitKind } from "../entities/split-kind.enum";
import { TRANSACTION_NOTE_MAX_LENGTH } from "../../common/transaction-note";
import { MAX_TAGS_PER_CALL } from "../../tags/tags.service";

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

  // Currency pair the supplied `exchangeRate` was resolved for (issue #1167).
  // A scheduled-post round-trip carries these so the server can tell a rate that
  // still belongs to the current settlement pair from a stale one whose currency
  // has since changed -- without them a resent scheduled scalar is re-resolved,
  // never trusted (the same rule the stored-split and override paths follow).
  @ApiPropertyOptional({
    description: "Currency the exchangeRate converts FROM (security currency)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  exchangeRateFromCurrency?: string;

  @ApiPropertyOptional({
    description:
      "Currency the exchangeRate converts TO (cash account currency)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  exchangeRateToCurrency?: string;

  @ApiPropertyOptional({ description: "Description of the action" })
  @IsOptional()
  @IsString()
  @MaxLength(TRANSACTION_NOTE_MAX_LENGTH)
  @SanitizeHtml()
  description?: string;

  @ApiPropertyOptional({
    format: "uuid",
    description:
      "The bond series (bond instrument id) of a program-linked security; inferred from the parent date when omitted for an acquisition.",
  })
  @Transform(({ value }) =>
    typeof value === "string" ? value.toLowerCase() : value,
  )
  @IsOptional()
  @ValidateIf((_o, value) => value !== null && value !== undefined)
  @IsUUID()
  bondInstrumentId?: string | null;
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
      "Amount for this split. Signed: a line may oppose the parent's sign " +
      "(a withholding under a net paycheck, a refund under a charge), and " +
      "the signed sum of all lines must equal the parent amount.",
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(-999999999999)
  @Max(999999999999)
  amount: number;

  @ApiPropertyOptional({ description: "Memo/note for this split" })
  @IsOptional()
  @IsString()
  @MaxLength(TRANSACTION_NOTE_MAX_LENGTH)
  @SanitizeHtml()
  memo?: string;

  @ApiPropertyOptional({
    description:
      "Tag IDs to assign to this split (cumulative with parent transaction tags)",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TAGS_PER_CALL)
  @IsUUID(undefined, { each: true })
  tagIds?: string[];
}
