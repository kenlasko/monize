import { Type } from "class-transformer";
import {
  IsString,
  IsUUID,
  Matches,
  ValidateIf,
  ValidateNested,
  IsDefined,
} from "class-validator";
import { SharedCommandDto } from "./shared-command.dto";
import { SharedEntryDto } from "./shared-entry.dto";
import { BookSharedEntryDto } from "./shared-finance.dto";

export class SaveSharedEntryFinanceDto extends SharedCommandDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  entryId?: string;
  @IsDefined()
  @ValidateNested()
  @Type(() => SharedEntryDto)
  entry: SharedEntryDto;
  @IsDefined()
  @ValidateNested()
  @Type(() => BookSharedEntryDto)
  finance: BookSharedEntryDto;
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  previewFingerprint?: string;
}
