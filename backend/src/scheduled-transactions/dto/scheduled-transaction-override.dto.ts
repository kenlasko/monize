import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  IsUUID,
  IsBoolean,
  IsArray,
  IsEnum,
  ValidateNested,
  IsDateString,
  MaxLength,
  Min,
  Max,
} from "class-validator";
import { Type } from "class-transformer";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { InvestmentSplitDto } from "../../transactions/dto/create-transaction-split.dto";
import { SplitKind } from "../../transactions/entities/split-kind.enum";
import { TRANSACTION_NOTE_MAX_LENGTH } from "../../common/transaction-note";
import { IsMoneyAmount } from "../../common/validators/is-money-amount.validator";
import { IsShareQuantity } from "../../common/validators/is-share-quantity.validator";

export class OverrideSplitDto {
  // Stable id of the override split this row continues (issue #1167 F4). Echoed
  // by the client on update so FX-rate provenance is decided by identity, not by
  // matching rate values; persisted so future edits keep the same identity.
  @ApiPropertyOptional({
    description: "Id of the source override split this row continues",
  })
  @IsOptional()
  @IsUUID()
  sourceSplitId?: string;

  // The client asserts this new override investment line's FX rate is for the
  // CURRENT settlement pair (issue #1167 R8-F2). Set for a line the user just
  // added (no `sourceSplitId`); the server stamps the current pair so the
  // explicit rate is honoured at posting. Absent, a line with no `sourceSplitId`
  // is unknown (older client or legacy JSON) and re-resolved -- never stamped.
  @ApiPropertyOptional({
    description:
      "The FX rate on this new line is for the current settlement pair",
  })
  @IsOptional()
  @IsBoolean()
  rateExplicit?: boolean;

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
  @IsMoneyAmount()
  @Min(-999999999999)
  @Max(999999999999)
  amount: number;

  @ApiPropertyOptional({ description: "Memo for this split" })
  @IsOptional()
  @IsString()
  @MaxLength(TRANSACTION_NOTE_MAX_LENGTH)
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
  @IsMoneyAmount()
  @Min(-999999999999)
  @Max(999999999999)
  amount?: number | null;

  @ApiPropertyOptional({ description: "Overridden category ID" })
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional({ description: "Overridden description" })
  @IsOptional()
  @IsString()
  @MaxLength(TRANSACTION_NOTE_MAX_LENGTH)
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
  @IsShareQuantity()
  @Min(0)
  @Max(999999999999)
  investmentQuantity?: number | null;

  @ApiPropertyOptional({ description: "Per-occurrence investment price" })
  @IsOptional()
  @IsMoneyAmount(10)
  @Min(0)
  @Max(999999999999)
  investmentPrice?: number | null;

  @ApiPropertyOptional({
    description:
      "Per-occurrence investment total amount (for DIVIDEND/INTEREST/CAPITAL_GAIN)",
  })
  @IsOptional()
  @IsMoneyAmount(4)
  @Min(-999999999999)
  @Max(999999999999)
  investmentTotalAmount?: number | null;
}

export class UpdateScheduledTransactionOverrideDto {
  // Moving an occurrence's date is an update of the existing override, not a
  // delete-then-recreate (issue #1167 R10-F3): recreating loses the override's
  // split identities, so a validly pinned FX rate could no longer be correlated
  // and was silently re-resolved. `originalDate` (which scheduled occurrence this
  // overrides) is the row's identity and does not change; only `overrideDate`
  // (the actual date) moves.
  @ApiPropertyOptional({
    description: "New actual date for this occurrence (YYYY-MM-DD)",
  })
  @IsOptional()
  @IsDateString()
  overrideDate?: string;

  @ApiPropertyOptional({ description: "Overridden amount" })
  @IsOptional()
  @IsMoneyAmount()
  @Min(-999999999999)
  @Max(999999999999)
  amount?: number | null;

  @ApiPropertyOptional({ description: "Overridden category ID" })
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional({ description: "Overridden description" })
  @IsOptional()
  @IsString()
  @MaxLength(TRANSACTION_NOTE_MAX_LENGTH)
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
  @IsShareQuantity()
  @Min(0)
  @Max(999999999999)
  investmentQuantity?: number | null;

  @ApiPropertyOptional({ description: "Per-occurrence investment price" })
  @IsOptional()
  @IsMoneyAmount(10)
  @Min(0)
  @Max(999999999999)
  investmentPrice?: number | null;

  @ApiPropertyOptional({
    description:
      "Per-occurrence investment total amount (for DIVIDEND/INTEREST/CAPITAL_GAIN)",
  })
  @IsOptional()
  @IsMoneyAmount(4)
  @Min(-999999999999)
  @Max(999999999999)
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
