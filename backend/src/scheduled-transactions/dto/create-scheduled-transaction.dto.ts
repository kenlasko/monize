import {
  IsString,
  IsNumber,
  IsUUID,
  IsOptional,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  Min,
  Max,
  MaxLength,
} from "class-validator";
import { Type } from "class-transformer";
import { CreateScheduledTransactionSplitDto } from "./create-scheduled-transaction-split.dto";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { IsCurrencyCode } from "../../common/validators/is-currency-code.validator";
import { InvestmentAction } from "../../securities/entities/investment-transaction.entity";

export enum FrequencyType {
  ONCE = "ONCE",
  DAILY = "DAILY",
  WEEKLY = "WEEKLY",
  BIWEEKLY = "BIWEEKLY",
  EVERY4WEEKS = "EVERY4WEEKS",
  SEMIMONTHLY = "SEMIMONTHLY",
  MONTHLY = "MONTHLY",
  QUARTERLY = "QUARTERLY",
  YEARLY = "YEARLY",
}

export class CreateScheduledTransactionDto {
  @IsUUID()
  accountId: string;

  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  name: string;

  @IsOptional()
  @IsUUID()
  payeeId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  payeeName?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(-999999999999)
  @Max(999999999999)
  amount: number;

  @IsCurrencyCode()
  currencyCode: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @SanitizeHtml()
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
  @IsBoolean()
  isInvestment?: boolean;

  @IsOptional()
  @IsEnum(InvestmentAction)
  investmentAction?: InvestmentAction;

  @IsOptional()
  @IsUUID()
  investmentSecurityId?: string;

  @IsOptional()
  @IsUUID()
  investmentFundingAccountId?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0)
  investmentQuantity?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  investmentPrice?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  investmentCommission?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  investmentTotalAmount?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 10 })
  @Min(0)
  investmentExchangeRate?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateScheduledTransactionSplitDto)
  splits?: CreateScheduledTransactionSplitDto[];

  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  tagIds?: string[];

  @IsOptional()
  paycheckMetadata?: any;
}
