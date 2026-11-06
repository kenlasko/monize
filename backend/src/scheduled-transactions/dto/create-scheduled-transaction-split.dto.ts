import {
  IsUUID,
  IsOptional,
  IsString,
  IsArray,
  IsBoolean,
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
import { TRANSACTION_NOTE_MAX_LENGTH } from "../../common/transaction-note";
import { IsMoneyAmount } from "../../common/validators/is-money-amount.validator";

export class CreateScheduledTransactionSplitDto {
  // The id of the split row this one continues from (issue #1167 F4). On an
  // update, the client echoes the existing split's id so the server can decide
  // FX-rate provenance by stable identity -- not by matching rate values, which
  // collides when two same-security splits swap rates. Absent means a new split.
  @ApiPropertyOptional({
    description:
      "Id of the source split this row continues (for FX provenance)",
  })
  @IsOptional()
  @IsUUID()
  sourceSplitId?: string;

  // The client asserts this investment line's FX rate is a deliberate value for
  // the CURRENT settlement pair (issue #1167 R8-F2): a line the user just added
  // (no `sourceSplitId`) whose rate was resolved/entered for the securities and
  // accounts on screen now. The server stamps the current pair for it, so a
  // genuinely new line's explicit rate is honoured at posting. Absent, a line
  // without `sourceSplitId` is treated as unknown (an older client, or a legacy
  // line) and its rate is re-resolved at posting rather than stamped -- so a
  // stale scalar can never be re-blessed as belonging to the current pair.
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

  @IsMoneyAmount()
  @Min(-999999999999)
  @Max(999999999999)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(TRANSACTION_NOTE_MAX_LENGTH)
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
