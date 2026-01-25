import {
  IsString,
  IsNumber,
  IsOptional,
  IsDateString,
  IsUUID,
  IsBoolean,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTransferDto {
  @ApiProperty({ description: 'Source account ID (where money is withdrawn from)' })
  @IsUUID()
  fromAccountId: string;

  @ApiProperty({ description: 'Destination account ID (where money is deposited to)' })
  @IsUUID()
  toAccountId: string;

  @ApiProperty({ description: 'Transfer date (YYYY-MM-DD format)' })
  @IsDateString()
  transactionDate: string;

  @ApiProperty({ description: 'Transfer amount (must be positive)' })
  @IsNumber({ maxDecimalPlaces: 4 })
  amount: number;

  @ApiProperty({ description: 'Currency code of source account (e.g., CAD, USD)' })
  @IsString()
  @MaxLength(3)
  fromCurrencyCode: string;

  @ApiPropertyOptional({ description: 'Currency code of destination account (defaults to fromCurrencyCode)' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  toCurrencyCode?: string;

  @ApiPropertyOptional({ description: 'Exchange rate for converting from source to destination currency (defaults to 1.0)' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 10 })
  exchangeRate?: number;

  @ApiPropertyOptional({ description: 'Transfer description/notes' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Reference number' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  referenceNumber?: string;

  @ApiPropertyOptional({ description: 'Whether both transactions are cleared', default: false })
  @IsOptional()
  @IsBoolean()
  isCleared?: boolean;
}
