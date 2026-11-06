import {
  IsString,
  IsNumber,
  IsInt,
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
import { MAX_REMINDER_DAYS_BEFORE } from "../reminder-window";
import { TRANSACTION_NOTE_MAX_LENGTH } from "../../common/transaction-note";
import { IsMoneyAmount } from "../../common/validators/is-money-amount.validator";
import { IsFxRate } from "../../common/validators/is-fx-rate.validator";
import { IsShareQuantity } from "../../common/validators/is-share-quantity.validator";

export enum FrequencyType {
  ONCE = "ONCE",
  DAILY = "DAILY",
  WEEKLY = "WEEKLY",
  BIWEEKLY = "BIWEEKLY",
  EVERY4WEEKS = "EVERY4WEEKS",
  SEMIMONTHLY = "SEMIMONTHLY",
  MONTHLY = "MONTHLY",
  EVERY2MONTHS = "EVERY2MONTHS",
  QUARTERLY = "QUARTERLY",
  EVERY4MONTHS = "EVERY4MONTHS",
  SEMIANNUAL = "SEMIANNUAL",
  YEARLY = "YEARLY",
  EVERY2YEARS = "EVERY2YEARS",
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

  @IsMoneyAmount()
  @Min(-999999999999)
  @Max(999999999999)
  amount: number;

  @IsCurrencyCode()
  currencyCode: string;

  /**
   * Foreign-currency entry. `originalAmount` is the fixed amount the biller
   * charges in `originalCurrencyCode`; `amount` stays the account-currency
   * estimate derived from it at `exchangeRate`. Same contract as
   * CreateTransactionDto -- the two are validated by one shared helper.
   */
  @IsOptional()
  @IsFxRate()
  exchangeRate?: number;

  @IsOptional()
  @IsMoneyAmount()
  @Min(-999999999999)
  @Max(999999999999)
  originalAmount?: number | null;

  @IsOptional()
  @IsCurrencyCode()
  originalCurrencyCode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(TRANSACTION_NOTE_MAX_LENGTH)
  @SanitizeHtml()
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  referenceNumber?: string | null;

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

  /**
   * How many days before an occurrence the reminder email goes out.
   *
   * Bounded, and an integer. Unbounded, a value past `Date`'s range made
   * `addDaysYMD` produce the literal string "NaN-NaN-NaN", which the
   * string-comparing occurrence expander read as an unlimited window: every one
   * of that user's manual bills came back due today, every day, each walked to
   * the 2000-step guard inside a cron shared by every tenant. A year is more
   * than any reminder needs, and `@IsInt` keeps a fractional value out of an
   * INTEGER column.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_REMINDER_DAYS_BEFORE)
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
  @IsShareQuantity()
  @Min(0)
  investmentQuantity?: number;

  @IsOptional()
  @IsMoneyAmount(10)
  @Min(0)
  investmentPrice?: number;

  @IsOptional()
  @IsMoneyAmount(4)
  @Min(0)
  investmentCommission?: number;

  @IsOptional()
  @IsMoneyAmount(4)
  investmentTotalAmount?: number;

  @IsOptional()
  @IsFxRate()
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
}
