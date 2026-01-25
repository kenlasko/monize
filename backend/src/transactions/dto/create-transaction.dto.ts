import {
  IsString,
  IsNumber,
  IsOptional,
  IsDateString,
  IsUUID,
  IsBoolean,
  MaxLength,
  Min,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CreateTransactionSplitDto } from './create-transaction-split.dto';

export class CreateTransactionDto {
  @ApiProperty({ description: 'Account ID where the transaction occurs' })
  @IsUUID()
  accountId: string;

  @ApiProperty({ description: 'Transaction date (YYYY-MM-DD format)' })
  @IsDateString()
  transactionDate: string;

  @ApiPropertyOptional({ description: 'Payee ID if using existing payee' })
  @IsOptional()
  @IsUUID()
  payeeId?: string;

  @ApiPropertyOptional({ description: 'Payee name (if not using existing payee)' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  payeeName?: string;

  @ApiPropertyOptional({ description: 'Category ID for simple transactions (not used for split transactions)' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiProperty({ description: 'Transaction amount (positive for income, negative for expense)' })
  @IsNumber({ maxDecimalPlaces: 4 })
  amount: number;

  @ApiProperty({ description: 'Currency code (e.g., CAD, USD)' })
  @IsString()
  @MaxLength(3)
  currencyCode: string;

  @ApiPropertyOptional({ description: 'Exchange rate (defaults to 1.0)' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 10 })
  @Min(0)
  exchangeRate?: number;

  @ApiPropertyOptional({ description: 'Transaction description/notes' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Reference number (e.g., cheque number)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  referenceNumber?: string;

  @ApiPropertyOptional({ description: 'Whether transaction is cleared', default: false })
  @IsOptional()
  @IsBoolean()
  isCleared?: boolean;

  @ApiPropertyOptional({ description: 'Whether transaction is reconciled', default: false })
  @IsOptional()
  @IsBoolean()
  isReconciled?: boolean;

  @ApiPropertyOptional({ description: 'Reconciliation date (YYYY-MM-DD format)' })
  @IsOptional()
  @IsDateString()
  reconciledDate?: string;

  @ApiPropertyOptional({ description: 'Whether this is a split transaction', default: false })
  @IsOptional()
  @IsBoolean()
  isSplit?: boolean;

  @ApiPropertyOptional({ description: 'Parent transaction ID for split transactions' })
  @IsOptional()
  @IsUUID()
  parentTransactionId?: string;

  @ApiPropertyOptional({
    description: 'Splits for split transactions. When provided, isSplit is automatically set to true.',
    type: [CreateTransactionSplitDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateTransactionSplitDto)
  splits?: CreateTransactionSplitDto[];
}
