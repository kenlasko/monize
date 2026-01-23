import {
  IsString,
  IsOptional,
  IsNumber,
  IsPositive,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateAccountDto {
  @ApiPropertyOptional({
    example: 'Updated Account Name',
    description: 'Display name for the account',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    example: 'Updated account description',
    description: 'Optional description of the account',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    example: '****5678',
    description: 'Account number (masked or encrypted)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  accountNumber?: string;

  @ApiPropertyOptional({
    example: 'BMO Bank of Montreal',
    description: 'Financial institution name',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  institution?: string;

  @ApiPropertyOptional({
    example: 10000.00,
    description: 'Credit limit (for credit cards)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @IsPositive()
  creditLimit?: number;

  @ApiPropertyOptional({
    example: 4.25,
    description: 'Interest rate percentage (for loans, mortgages, savings)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  interestRate?: number;
}
