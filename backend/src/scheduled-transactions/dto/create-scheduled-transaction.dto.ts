import {
  IsString,
  IsNumber,
  IsUUID,
  IsOptional,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsArray,
  ValidateNested,
  Min,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CreateScheduledTransactionSplitDto } from './create-scheduled-transaction-split.dto';

export enum FrequencyType {
  ONCE = 'ONCE',
  DAILY = 'DAILY',
  WEEKLY = 'WEEKLY',
  BIWEEKLY = 'BIWEEKLY',
  SEMIMONTHLY = 'SEMIMONTHLY',
  MONTHLY = 'MONTHLY',
  QUARTERLY = 'QUARTERLY',
  YEARLY = 'YEARLY',
}

export class CreateScheduledTransactionDto {
  @IsUUID()
  accountId: string;

  @IsString()
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsUUID()
  payeeId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  payeeName?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsNumber()
  amount: number;

  @IsString()
  @MaxLength(3)
  currencyCode: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(FrequencyType)
  frequency: FrequencyType;

  @IsDateString()
  nextDueDate: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  occurrencesRemaining?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  autoPost?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  reminderDaysBefore?: number;

  @IsOptional()
  @IsBoolean()
  isTransfer?: boolean;

  @IsOptional()
  @IsUUID()
  transferAccountId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateScheduledTransactionSplitDto)
  splits?: CreateScheduledTransactionSplitDto[];
}
