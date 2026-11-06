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
  IsNotEmpty,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { TransactionStatus } from "../entities/transaction.entity";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { IsCurrencyCode } from "../../common/validators/is-currency-code.validator";
import { TRANSACTION_NOTE_MAX_LENGTH } from "../../common/transaction-note";
import { EXTERNAL_ID_MAX_LENGTH } from "../transaction-external-id";
import { IsFxRate } from "../../common/validators/is-fx-rate.validator";
import { IsMoneyAmount } from "../../common/validators/is-money-amount.validator";

export class CreateTransferDto {
  @ApiProperty({
    description: "Source account ID (where money is withdrawn from)",
  })
  @IsUUID()
  fromAccountId: string;

  @ApiProperty({
    description: "Destination account ID (where money is deposited to)",
  })
  @IsUUID()
  toAccountId: string;

  @ApiProperty({ description: "Transfer date (YYYY-MM-DD format)" })
  @IsDateString()
  transactionDate: string;

  @ApiProperty({ description: "Transfer amount (must be zero or positive)" })
  @IsMoneyAmount()
  @Min(0)
  @Max(999999999999)
  amount: number;

  @ApiPropertyOptional({
    description:
      "Currency code of the source account. Optional: the server derives both currency codes from the accounts themselves. When supplied it must match the source account's currency, or the request is rejected.",
  })
  @IsOptional()
  @IsCurrencyCode()
  fromCurrencyCode?: string;

  @ApiPropertyOptional({
    description:
      "Currency code of the destination account. Optional and derived from the account, as above.",
  })
  @IsOptional()
  @IsCurrencyCode()
  toCurrencyCode?: string;

  @ApiPropertyOptional({
    description:
      "Exchange rate for converting from source to destination currency. " +
      "When omitted for a cross-currency pair, the server resolves the market " +
      "rate for the transfer date or refuses the transfer -- it never posts " +
      "at 1:1. Must be 1 (or omitted) for a same-currency pair.",
  })
  @IsOptional()
  @IsFxRate()
  @Max(1_000_000)
  exchangeRate?: number;

  @ApiPropertyOptional({
    description:
      "Destination amount (for cross-currency transfers). If provided, overrides exchangeRate calculation.",
  })
  @IsOptional()
  @IsMoneyAmount()
  @Min(0)
  @Max(999999999999)
  toAmount?: number;

  @ApiPropertyOptional({
    description: "Payee ID (optional, links transfer to a payee)",
  })
  @IsOptional()
  @IsUUID()
  payeeId?: string;

  @ApiPropertyOptional({
    description: "Payee name (optional, displayed name for the transfer)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  payeeName?: string;

  @ApiPropertyOptional({
    description:
      "Optional spending category for the transfer. The transfer still does not count as income/expense or affect net worth; it only lets the amount surface under this category in the monthly category breakdown (e.g. tracking monthly investment contributions).",
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

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
    default: TransactionStatus.UNRECONCILED,
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
      "Your own stable id for this transfer, the same on every retry. Stored on the source leg and unique per source account: a transfer that repeats a key already used in the source account returns the existing transfer instead of creating a second one, and a key held by a row that is not a transfer to the same destination account is refused with 409.",
    maxLength: EXTERNAL_ID_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(EXTERNAL_ID_MAX_LENGTH)
  externalId?: string;
}
