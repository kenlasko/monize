import { IsCurrencyCode } from "../../common/validators/is-currency-code.validator";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  ValidateIf,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { SharedCommandDto } from "./shared-command.dto";
import { SharedShareDto } from "./shared-entry.dto";

export class SharedSplitTemplateDto {
  @IsIn(["EQUAL", "PERCENT", "WEIGHT"]) mode: "EQUAL" | "PERCENT" | "WEIGHT";
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SharedShareDto)
  shares: SharedShareDto[];
}

export class SharedParticipantInput {
  @IsString()
  @Length(1, 80)
  @SanitizeHtml()
  name: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  personId?: string;
}
export class CreateSharedGroupDto {
  @IsUUID("4") operationId: string;
  @IsString() @Length(1, 120) @SanitizeHtml() name: string;
  @IsString() @Length(1, 80) @SanitizeHtml() myName: string;
  @IsCurrencyCode() currencyCode: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(750)
  @SanitizeHtml()
  description?: string;
  @IsArray()
  @ArrayMaxSize(49)
  @ValidateNested({ each: true })
  @Type(() => SharedParticipantInput)
  participants: SharedParticipantInput[];
}
export class UpdateSharedGroupDto extends SharedCommandDto {
  // Null explicitly clears the future-expense default.
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @ValidateNested()
  @Type(() => SharedSplitTemplateDto)
  splitTemplate?: SharedSplitTemplateDto | null;
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 120)
  @SanitizeHtml()
  name?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(750)
  @SanitizeHtml()
  description?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsCurrencyCode()
  currencyCode?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  archived?: boolean;
}
export class ChangeSharedParticipantDto extends SharedCommandDto {
  @IsString() @Length(1, 80) @SanitizeHtml() name: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  personId?: string;
}
export class SharedInvitationDto extends SharedCommandDto {
  @IsUUID() participantId: string;
  @IsIn(["EDITOR", "VIEWER"]) role: "EDITOR" | "VIEWER";
  @ValidateIf(
    (_object, value) => value !== undefined && value !== null && value !== "",
  )
  @IsEmail()
  @MaxLength(254)
  email?: string;
}
export class ClaimSharedInvitationDto {
  @IsString() @Length(43, 43) @Matches(/^[a-zA-Z0-9_-]+$/) token: string;
}
export class ChangeSharedMembershipDto extends SharedCommandDto {
  @IsIn(["EDITOR", "VIEWER", "REVOKE", "REQUEST_OWNER", "TRANSFER_OWNER"])
  action: "EDITOR" | "VIEWER" | "REVOKE" | "REQUEST_OWNER" | "TRANSFER_OWNER";
}
export class SharedMuteDto {
  @IsBoolean() muted: boolean;
}
export class SharedPersonDto {
  @IsString() @Length(1, 80) @SanitizeHtml() name: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  payeeId?: string;
}
export class LinkSharedPersonDto {
  @IsUUID() personId: string;
  @IsUUID() participantId: string;
}
