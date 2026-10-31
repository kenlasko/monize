import { IsCurrencyCode } from "../../common/validators/is-currency-code.validator";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  ValidateIf,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { IsCalendarDate } from "../../common/validators/is-calendar-date.validator";
import { SHARED_ENTRY_TYPES, SharedEntryType } from "../shared-balances";
import { SHARED_SPLIT_MODES, SharedSplitMode } from "../shared-allocation";
import { SharedCommandDto } from "./shared-command.dto";

export class SharedShareDto {
  @IsUUID() participantId: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(32)
  @Matches(/^\d+(?:\.\d{1,4})?$/)
  value?: string;
}
export class SharedEntryDto extends SharedCommandDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  previewFingerprint?: string;
  @IsIn(SHARED_ENTRY_TYPES) type: SharedEntryType;
  @IsString() @Length(1, 120) @SanitizeHtml() title: string;
  @IsString() @Length(1, 32) @Matches(/^\d+(?:\.\d{1,4})?$/) amount: string;
  @IsCurrencyCode() currencyCode: string;
  @IsCalendarDate() date: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(750)
  @SanitizeHtml()
  note?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(60)
  @SanitizeHtml()
  categoryLabel?: string;
  @IsIn(SHARED_SPLIT_MODES) splitMode: SharedSplitMode;
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SharedShareDto)
  shares: SharedShareDto[];
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SharedShareDto)
  contributions: SharedShareDto[];
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(32)
  @Matches(/^\d+(?:\.\d{1,10})?$/)
  fxRate?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  sourceEntryId?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  fromParticipantId?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  toParticipantId?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(0)
  expectedGroupRevision?: number;
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  acknowledgeOverpayment?: boolean;
}
export class ReverseSharedEntryDto extends SharedCommandDto {
  @IsString() @Length(1, 750) @SanitizeHtml() reason: string;
}
export class SharedListDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(200)
  search?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(SHARED_ENTRY_TYPES)
  type?: SharedEntryType;
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  participantId?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsCalendarDate()
  startDate?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsCalendarDate()
  endDate?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
