import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsOptional,
  IsUUID,
  IsString,
  IsBoolean,
  IsArray,
  IsEnum,
  Min,
  Max,
  ValidateIf,
  ValidateNested,
  IsDateString,
  MaxLength,
} from "class-validator";
import { Type } from "class-transformer";
import { IsCalendarDate } from "../../common/validators/is-calendar-date.validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { InvestmentSplitDto } from "../../transactions/dto/create-transaction-split.dto";
import { SplitKind } from "../../transactions/entities/split-kind.enum";
import { TRANSACTION_NOTE_MAX_LENGTH } from "../../common/transaction-note";
import { IsMoneyAmount } from "../../common/validators/is-money-amount.validator";
import { IsFxRate } from "../../common/validators/is-fx-rate.validator";
import { IsShareQuantity } from "../../common/validators/is-share-quantity.validator";

class InlineSplitDto {
  // Id of the scheduled/override split this inline row came from (issue #1167
  // F2/F4). The manual Post dialog echoes it so the server can tell a user-edited
  // rate (honour it) from an unchanged echoed one (reuse-if-current, else
  // re-resolve) by stable identity rather than by matching rate values.
  @ApiPropertyOptional({
    description: "Id of the source split this inline row came from",
  })
  @IsOptional()
  @IsUUID()
  sourceSplitId?: string;

  // The client asserts this inline investment line's FX rate is for the CURRENT
  // settlement pair (issue #1167 R8-F2) -- a line the user just added in the Post
  // dialog. Carried for parity with the create/override DTOs; the inline post path
  // already re-validates every rate against the current pair via
  // resolveEffectiveSplitCash, so an absent flag stays safe (re-resolve).
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

  @ApiPropertyOptional({ description: "Amount for this split" })
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

export class PostScheduledTransactionDto {
  // Required at the HTTP boundary (no `@IsOptional`), typed `?:` only because
  // in-process callers (the auto-post cron, the AI action and the email receipt)
  // build this DTO without it and pin through `post()`'s `expectedDueDate`
  // option instead.
  @ApiProperty({
    description:
      "The occurrence the client is posting, YYYY-MM-DD: the override's date when an override moved it, else the due date. Refused with 409 once it is no longer the due occurrence.",
    example: "2026-09-01",
  })
  @IsCalendarDate()
  expectedOccurrenceDate?: string;

  @ApiPropertyOptional({
    description:
      "Id of the override the client saw on that occurrence, or null when it saw none. Refused with 409 when an override was created, replaced or removed since.",
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsUUID()
  expectedOverrideId?: string | null;

  @ApiPropertyOptional({
    description: "Transaction date (defaults to next due date)",
  })
  @IsOptional()
  @IsDateString()
  transactionDate?: string;

  @ApiPropertyOptional({ description: "Override amount for this posting only" })
  @IsOptional()
  @IsMoneyAmount()
  @Min(-999999999999)
  @Max(999999999999)
  amount?: number;

  @ApiPropertyOptional({
    description:
      "Override foreign amount for this posting only, in the schedule's entry currency. Ignored unless the schedule carries a foreign currency; the account-currency amount is derived from it at the rate for the posting date.",
  })
  @IsOptional()
  @IsMoneyAmount()
  @Min(-999999999999)
  @Max(999999999999)
  originalAmount?: number;

  @ApiPropertyOptional({
    description:
      "Override exchange rate for this posting only (account-currency units per 1 unit of the entry currency). Defaults to the stored rate for the posting date.",
  })
  @IsOptional()
  @IsFxRate()
  exchangeRate?: number;

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
  @MaxLength(TRANSACTION_NOTE_MAX_LENGTH)
  @SanitizeHtml()
  description?: string | null;

  @ApiPropertyOptional({
    description: "Reference number (e.g., cheque number)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  referenceNumber?: string;

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

  @ApiPropertyOptional({
    description: "Override quantity for this posting only (investment kind)",
  })
  @IsOptional()
  @IsShareQuantity()
  @Min(0)
  @Max(999999999999)
  investmentQuantity?: number;

  @ApiPropertyOptional({
    description: "Override price for this posting only (investment kind)",
  })
  @IsOptional()
  @IsMoneyAmount(10)
  @Min(0)
  @Max(999999999999)
  investmentPrice?: number;

  @ApiPropertyOptional({
    description:
      "Override total amount for this posting only (investment kind, amount-only actions)",
  })
  @IsOptional()
  @IsMoneyAmount(4)
  @Min(-999999999999)
  @Max(999999999999)
  investmentTotalAmount?: number;
}
