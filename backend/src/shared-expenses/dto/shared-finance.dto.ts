import {
  ValidateIf,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from "class-validator";
import { IntersectionType } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { SharedCommandDto } from "./shared-command.dto";

export class EnableSharedFinanceDto extends SharedCommandDto {
  @IsString() @Length(1, 120) @SanitizeHtml() accountName: string;
}

export class SharedBankSplitDto {
  @IsUUID() splitId: string;
  @IsString()
  @MaxLength(32)
  @Matches(/^\d+(?:\.\d{1,4})?$/)
  amount: string;
}

export class SharedBankPaymentDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SharedBankSplitDto)
  sourceSplits?: SharedBankSplitDto[];
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(32)
  @Matches(/^\d+(?:\.\d{1,4})?$/)
  contributionAmount?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  bankTransactionId?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  bankAccountId?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(32)
  @Matches(/^\d+(?:\.\d{1,4})?$/)
  bankAmount?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(32)
  @Matches(/^\d+(?:\.\d{1,4})?$/)
  sharedBankAmount?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(32)
  @Matches(/^\d+(?:\.\d{1,10})?$/)
  bankRate?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  fxCategoryId?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  privateCategoryId?: string;
}

export class BookSharedEntryDto extends IntersectionType(
  SharedCommandDto,
  SharedBankPaymentDto,
) {
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => SharedBankPaymentDto)
  payments?: SharedBankPaymentDto[];
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  categoryId?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  payeeId?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  previewFingerprint?: string;
}
