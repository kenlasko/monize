import {
  IsString,
  IsNumber,
  IsOptional,
  IsDateString,
  IsUUID,
  IsBoolean,
  IsEnum,
  MaxLength,
  Min,
  Max,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { CreateTransactionSplitDto } from "./create-transaction-split.dto";
import { TransactionStatus } from "../entities/transaction.entity";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

export class CreateTransactionDto {
  @ApiProperty({ description: "Account ID where the transaction occurs" })
  @IsUUID()
  accountId: string;

  @ApiProperty({ description: "Transaction date (YYYY-MM-DD format)" })
  @IsDateString()
  transactionDate: string;

  @ApiPropertyOptional({ description: "Payee ID if using existing payee" })
  @IsOptional()
  @IsUUID()
  payeeId?: string;

  @ApiPropertyOptional({
    description: "Payee name (if not using existing payee)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  payeeName?: string;

  @ApiPropertyOptional({
    description:
      "Category ID for simple transactions (not used for split transactions)",
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiProperty({
    description:
      "Transaction amount (positive for income, negative for expense)",
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(-999999999999)
  @Max(999999999999)
  amount: number;

  @ApiProperty({ description: "Currency code (e.g., CAD, USD)" })
  @IsString()
  @MaxLength(3)
  currencyCode: string;

  @ApiPropertyOptional({ description: "Exchange rate (defaults to 1.0)" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 10 })
  @Min(0.000001)
  exchangeRate?: number;

  @ApiPropertyOptional({ description: "Transaction description/notes" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @SanitizeHtml()
  description?: string;

  @ApiPropertyOptional({
    description: "Reference number (e.g., cheque number)",
  })
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
    description: "Reconciliation date (YYYY-MM-DD format)",
  })
  @IsOptional()
  @IsDateString()
  reconciledDate?: string;

  @ApiPropertyOptional({
    description: "Whether this is a split transaction",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isSplit?: boolean;

  @ApiPropertyOptional({
    description: "Parent transaction ID for split transactions",
  })
  @IsOptional()
  @IsUUID()
  parentTransactionId?: string;

  @ApiPropertyOptional({
    description:
      "Splits for split transactions. When provided, isSplit is automatically set to true.",
    type: [CreateTransactionSplitDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateTransactionSplitDto)
  splits?: CreateTransactionSplitDto[];
}
