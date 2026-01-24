import {
  IsString,
  IsNumber,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTransactionSplitDto {
  @ApiPropertyOptional({ description: 'Category ID for this split' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiProperty({ description: 'Amount for this split (must be same sign as parent transaction)' })
  @IsNumber({ maxDecimalPlaces: 4 })
  amount: number;

  @ApiPropertyOptional({ description: 'Memo/note for this split' })
  @IsOptional()
  @IsString()
  memo?: string;
}
