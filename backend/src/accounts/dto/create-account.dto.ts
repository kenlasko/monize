import {
  IsString,
  IsEnum,
  IsOptional,
  IsNumber,
  IsPositive,
  IsBoolean,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccountType } from '../entities/account.entity';

export class CreateAccountDto {
  @ApiProperty({
    enum: AccountType,
    example: AccountType.CHEQUING,
    description: 'Type of account',
  })
  @IsEnum(AccountType)
  accountType: AccountType;

  @ApiProperty({
    example: 'TD Chequing Account',
    description: 'Display name for the account',
  })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({
    example: 'Primary chequing account for daily expenses',
    description: 'Optional description of the account',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    example: 'CAD',
    description: 'ISO 4217 currency code (USD, CAD, EUR, etc.)',
    maxLength: 3,
  })
  @IsString()
  @MaxLength(3)
  currencyCode: string;

  @ApiPropertyOptional({
    example: '****1234',
    description: 'Account number (masked or encrypted)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  accountNumber?: string;

  @ApiPropertyOptional({
    example: 'TD Canada Trust',
    description: 'Financial institution name',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  institution?: string;

  @ApiPropertyOptional({
    example: 1000.00,
    description: 'Opening balance for the account',
    default: 0,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  openingBalance?: number;

  @ApiPropertyOptional({
    example: 5000.00,
    description: 'Credit limit (for credit cards)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @IsPositive()
  creditLimit?: number;

  @ApiPropertyOptional({
    example: 3.5,
    description: 'Interest rate percentage (for loans, mortgages, savings)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  interestRate?: number;

  @ApiPropertyOptional({
    example: true,
    description: 'Whether this account is a favourite (shown in dashboard)',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isFavourite?: boolean;
}
