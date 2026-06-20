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
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { TransactionStatus } from "../entities/transaction.entity";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { IsCurrencyCode } from "../../common/validators/is-currency-code.validator";

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
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(999999999999)
  amount: number;

  @ApiProperty({
    description: "Currency code of source account (e.g., CAD, USD)",
  })
  @IsCurrencyCode()
  fromCurrencyCode: string;

  @ApiPropertyOptional({
    description:
      "Currency code of destination account (defaults to fromCurrencyCode)",
  })
  @IsOptional()
  @IsCurrencyCode()
  toCurrencyCode?: string;

  @ApiPropertyOptional({
    description:
      "Exchange rate for converting from source to destination currency (defaults to 1.0)",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 10 })
  @Min(0)
  @Max(1_000_000)
  exchangeRate?: number;

  @ApiPropertyOptional({
    description:
      "Destination amount (for cross-currency transfers). If provided, overrides exchangeRate calculation.",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
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
}
