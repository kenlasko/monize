import { IsString, IsNotEmpty, MaxLength, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ParseFinancialDataDto {
  @ApiProperty({
    description: 'Raw pasted financial data (CSV, spreadsheet text, bank statement, etc.)',
    example: 'Date,Action,Transaction,...',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500000)
  rawText: string;

  @ApiPropertyOptional({
    description: 'Optional hint about the data source (e.g. "401k brokerage CSV")',
    example: '401k brokerage CSV',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  hint?: string;
}

export interface ParsedAiTransaction {
  date: string; // YYYY-MM-DD
  payee: string;
  amount: number;
  type: 'income' | 'expense' | 'transfer' | 'buy' | 'sell' | 'dividend' | 'reinvest' | 'fee';
  account?: string;
  sourceAccount?: string | null;
  memo?: string | null;
  security?: string | null;
  shares?: number | null;
  price?: number | null;
  currency?: string | null;
}

export interface ParsedAiAccount {
  name: string;
  type: string; // e.g. INVESTMENT, CHEQUING, SAVINGS
}

export interface ParsedFinancialDataResponse {
  transactions: ParsedAiTransaction[];
  accounts: ParsedAiAccount[];
  securities: string[];
  confidence: 'high' | 'medium' | 'low';
  notes: string;
  rawJson?: string;
}
