import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsOptional,
  Matches,
  ValidateNested,
} from "class-validator";
import { UpdateTransactionDto } from "../../transactions/dto/update-transaction.dto";
import { AccrualPreviewDto } from "./accrual-command.dto";

export class AccrualEditorSettingDto extends AccrualPreviewDto {
  @IsOptional() @IsBoolean() remove?: boolean;
}
export class AccrualEditorPreviewDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => UpdateTransactionDto)
  patch: UpdateTransactionDto;
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AccrualEditorSettingDto)
  settings: AccrualEditorSettingDto[];
}
export class AccrualEditorCommitDto extends AccrualEditorPreviewDto {
  @Matches(/^[a-f0-9]{64}$/) fingerprint: string;
}
