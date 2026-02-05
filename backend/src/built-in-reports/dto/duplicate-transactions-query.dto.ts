import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsDateString, IsIn } from 'class-validator';

export class DuplicateTransactionsQueryDto {
  @ApiProperty({
    required: false,
    description: 'Start date for the report (YYYY-MM-DD)',
    example: '2024-01-01',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiProperty({
    required: true,
    description: 'End date for the report (YYYY-MM-DD)',
    example: '2024-12-31',
  })
  @IsDateString()
  endDate: string;

  @ApiProperty({
    required: false,
    description: 'Detection sensitivity level',
    example: 'medium',
    enum: ['high', 'medium', 'low'],
    default: 'medium',
  })
  @IsOptional()
  @IsIn(['high', 'medium', 'low'])
  sensitivity?: 'high' | 'medium' | 'low';
}
