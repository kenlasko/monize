import { IsNumber, IsUUID, IsOptional, IsString } from 'class-validator';

export class CreateScheduledTransactionSplitDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsNumber()
  amount: number;

  @IsOptional()
  @IsString()
  memo?: string;
}
