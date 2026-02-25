import {
  IsString,
  IsNumber,
  IsOptional,
  IsDateString,
  IsUUID,
  IsEnum,
  MaxLength,
  Min,
  Max,
} from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { TransactionStatus } from "../entities/transaction.entity";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

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

  @ApiPropertyOptional({ description: "Transfer amount (must be positive)" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(999999999999)
  amount?: number;

  @ApiPropertyOptional({ description: "Currency code of source account" })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  fromCurrencyCode?: string;

  @ApiPropertyOptional({ description: "Currency code of destination account" })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  toCurrencyCode?: string;

  @ApiPropertyOptional({ description: "Exchange rate" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 10 })
  @Min(0)
  exchangeRate?: number;

  @ApiPropertyOptional({ description: "Destination amount" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(999999999999)
  toAmount?: number;

  @ApiPropertyOptional({ description: "Payee ID" })
  @IsOptional()
  @IsUUID()
  payeeId?: string;

  @ApiPropertyOptional({ description: "Payee name" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  payeeName?: string;

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
}
