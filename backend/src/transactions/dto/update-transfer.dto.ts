import {
  IsString,
  IsNumber,
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
  @IsNumber({ maxDecimalPlaces: 4 })
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
  @IsNumber({ maxDecimalPlaces: 10 })
  @Min(0.0001)
  @Max(1_000_000)
  exchangeRate?: number;

  @ApiPropertyOptional({ description: "Destination amount" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(999999999999)
  toAmount?: number;

  @ApiPropertyOptional({ description: "Payee ID (null to clear)" })
  @IsOptional()
  @IsUUID()
  payeeId?: string | null;

  @ApiPropertyOptional({
    description:
      "Payee name (null to clear and revert to default 'Transfer to/from <Account>')",
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
  @MaxLength(500)
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
