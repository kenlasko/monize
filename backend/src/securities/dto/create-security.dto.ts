import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, MaxLength, IsBoolean } from 'class-validator';

export class CreateSecurityDto {
  @ApiProperty({ example: 'AAPL', description: 'Stock symbol or ticker' })
  @IsString()
  @MaxLength(20)
  symbol: string;

  @ApiProperty({ example: 'Apple Inc.', description: 'Full name of the security' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({ example: 'STOCK', description: 'Type of security', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  securityType?: string;

  @ApiProperty({ example: 'NASDAQ', description: 'Stock exchange', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  exchange?: string;

  @ApiProperty({ example: 'USD', description: 'Currency code' })
  @IsString()
  @MaxLength(3)
  currencyCode: string;

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
