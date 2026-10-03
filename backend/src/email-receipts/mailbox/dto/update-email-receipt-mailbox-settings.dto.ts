import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from "class-validator";
import { SanitizeHtml } from "../../../common/decorators/sanitize-html.decorator";
import {
  EMAIL_RECEIPT_AI_MODES,
  EmailReceiptAiMode,
} from "../../entities/email-receipt-mailbox.entity";
import { IsNoControlCharacters } from "../no-control-characters.validator";

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

/** A blank optional text field is "not sent": a form resends every field. */
const notBlank = (_object: unknown, value: unknown) =>
  value !== null && value !== undefined && value !== "";

/**
 * The settings of a mailbox that do not depend on how it logs in, changed
 * without touching its credentials: the folder, the poll switch, the AI mode
 * and auto-apply. Every field is optional (at least one is required, which the
 * service refuses with a 400), so it serves a password mailbox and an OAuth2
 * one alike. The folder is held to the rules of the full save.
 */
export class UpdateEmailReceiptMailboxSettingsDto {
  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @ValidateIf(notBlank)
  @SanitizeHtml()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @IsNoControlCharacters()
  folder?: string;

  @ApiPropertyOptional({ description: "Whether the mailbox is polled." })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ enum: EMAIL_RECEIPT_AI_MODES })
  @IsOptional()
  @IsIn(EMAIL_RECEIPT_AI_MODES)
  aiMode?: EmailReceiptAiMode;

  @ApiPropertyOptional({
    description:
      "Apply a proposal without asking when an approved parser read the email completely and the match is certain.",
  })
  @IsOptional()
  @IsBoolean()
  autoApply?: boolean;
}
