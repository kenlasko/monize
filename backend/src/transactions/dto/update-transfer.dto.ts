import {
  IsString,
  IsOptional,
  IsDateString,
  IsUUID,
  IsEnum,
  IsArray,
  MaxLength,
  Min,
  Max,
} from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { TransactionStatus } from "../entities/transaction.entity";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { IsCurrencyCode } from "../../common/validators/is-currency-code.validator";
import { TRANSACTION_NOTE_MAX_LENGTH } from "../../common/transaction-note";
import { IsFxRate } from "../../common/validators/is-fx-rate.validator";
import { IsMoneyAmount } from "../../common/validators/is-money-amount.validator";

export class UpdateTransferDto {
  @ApiPropertyOptional({ description: "Source account ID" })
  @IsOptional()
  @IsUUID()
  fromAccountId?: string;

  @ApiPropertyOptional({ description: "Destination account ID" })
  @IsOptional()
  @IsUUID()
  toAccountId?: string;

  @ApiPropertyOptional({ description: "Transfer date (YYYY-MM-DD format)" })
  @IsOptional()
  @IsDateString()
  transactionDate?: string;

  @ApiPropertyOptional({
    description: "Transfer amount (must be zero or positive)",
  })
  @IsOptional()
  @IsMoneyAmount()
  @Min(0)
  @Max(999999999999)
  amount?: number;

  @ApiPropertyOptional({ description: "Currency code of source account" })
  @IsOptional()
  @IsCurrencyCode()
  fromCurrencyCode?: string;

  @ApiPropertyOptional({ description: "Currency code of destination account" })
  @IsOptional()
  @IsCurrencyCode()
  toCurrencyCode?: string;

  @ApiPropertyOptional({ description: "Exchange rate" })
  @IsOptional()
  // Positive and representable at the rate column's ten places (1e-10): a
  // CAD->BTC rate is 0.0000073529.
  @IsFxRate()
  @Max(1_000_000)
  exchangeRate?: number;

  @ApiPropertyOptional({ description: "Destination amount" })
  @IsOptional()
  @IsMoneyAmount()
  @Min(0)
  @Max(999999999999)
  toAmount?: number;

  @ApiPropertyOptional({ description: "Payee ID (null to clear)" })
  @IsOptional()
  @IsUUID()
  payeeId?: string | null;

  @ApiPropertyOptional({
    description:
      "Payee name (null to clear; a blank transfer payee displays as 'Transfer to/from <Account>' resolved from the current account name)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  payeeName?: string | null;

  @ApiPropertyOptional({
    description:
      "Optional spending category for the transfer (null to clear). Does not make the transfer count as income/expense; only surfaces it under this category in the monthly category breakdown.",
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional({ description: "Transfer description/notes" })
  @IsOptional()
  @IsString()
  @MaxLength(TRANSACTION_NOTE_MAX_LENGTH)
  @SanitizeHtml()
  description?: string;

  @ApiPropertyOptional({ description: "Reference number" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  referenceNumber?: string;

  @ApiPropertyOptional({
    description: "Transaction status",
    enum: TransactionStatus,
  })
  @IsOptional()
  @IsEnum(TransactionStatus)
  status?: TransactionStatus;

  @ApiPropertyOptional({
    description: "Tag IDs to apply to both transfer transactions",
  })
  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  tagIds?: string[];

  @ApiPropertyOptional({
    description:
      "Override the created-at timestamp (ISO 8601). Requires showCreatedAt preference enabled.",
  })
  @IsOptional()
  @IsDateString()
  createdAt?: string;
}
