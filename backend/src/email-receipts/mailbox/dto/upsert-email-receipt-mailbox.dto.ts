import {
  ApiProperty,
  ApiPropertyOptional,
  PartialType,
  PickType,
} from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from "class-validator";
import { SanitizeHtml } from "../../../common/decorators/sanitize-html.decorator";
import { IsSendableApiKey } from "../../../payees/lookup/google-places/google-places-key";
import {
  EMAIL_RECEIPT_AI_MODES,
  EMAIL_RECEIPT_MAILBOX_SECURITIES,
  EmailReceiptAiMode,
  EmailReceiptMailboxSecurity,
} from "../../entities/email-receipt-mailbox.entity";
import { IsNoControlCharacters } from "../no-control-characters.validator";

/** A host name or an IP literal, nothing that could carry a scheme, a path or credentials. */
export const MAILBOX_HOST_PATTERN =
  /^(?:\[?[0-9a-f:.]*:[0-9a-f:.]*\]?|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/;

/**
 * Trim and lower-case a host. It runs AFTER `SanitizeHtml`, which reads the
 * original value and so would discard an earlier transform; this one takes the
 * sanitised `value` it is given.
 */
const trimAndLowerCase = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim().toLowerCase() : value;

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

/** A blank optional text field is "not sent": the form resends every field. */
const notBlank = (_object: unknown, value: unknown) =>
  value !== null && value !== undefined && value !== "";

/**
 * The mailbox a user reads their order confirmations from (design section 3).
 *
 * `password` is write-only: absent or blank keeps the stored one, a value
 * replaces it, and it is never returned. A host the policy refuses (a private
 * address for a non-admin) is refused by the service, which can see the owner.
 * The booleans and the mode are required: a PUT states the whole configuration.
 */
export class UpsertEmailReceiptMailboxDto {
  @ApiProperty({ example: "imap.example.com", maxLength: 255 })
  @SanitizeHtml()
  @Transform(trimAndLowerCase)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Matches(MAILBOX_HOST_PATTERN, {
    message: "host must be a host name or an IP address",
  })
  host: string;

  @ApiProperty({ example: 993, minimum: 1, maximum: 65535 })
  @IsInt()
  @Min(1)
  @Max(65535)
  port: number;

  @ApiProperty({
    enum: EMAIL_RECEIPT_MAILBOX_SECURITIES,
    description:
      "tls is implicit TLS (port 993); starttls upgrades a plain connection (port 143) and is required. There is no plaintext mode.",
  })
  @IsIn(EMAIL_RECEIPT_MAILBOX_SECURITIES)
  security: EmailReceiptMailboxSecurity;

  @ApiProperty({ maxLength: 320 })
  @SanitizeHtml()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(320)
  @IsNoControlCharacters()
  username: string;

  @ApiPropertyOptional({
    description:
      "The mailbox password. Omit (or leave blank) to keep the stored one; send a value to replace it. Required when the mailbox is first created and when the host or user name changes. Never returned.",
    maxLength: 1000,
  })
  @IsOptional()
  @ValidateIf(notBlank)
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @IsSendableApiKey()
  password?: string;

  @ApiPropertyOptional({ default: "INBOX", maxLength: 255 })
  @IsOptional()
  @ValidateIf(notBlank)
  @SanitizeHtml()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @IsNoControlCharacters()
  folder?: string;

  @ApiProperty({ description: "Whether the mailbox is polled." })
  @IsBoolean()
  enabled: boolean;

  @ApiProperty({ enum: EMAIL_RECEIPT_AI_MODES })
  @IsIn(EMAIL_RECEIPT_AI_MODES)
  aiMode: EmailReceiptAiMode;

  @ApiProperty({
    description:
      "Apply a proposal without asking when an approved parser read the email completely and the match is certain.",
  })
  @IsBoolean()
  autoApply: boolean;
}

/**
 * A draft to test without saving it: any field left out is read from the stored
 * mailbox, so the settings screen can test what is on the form against the
 * password it cannot read back.
 */
export class TestEmailReceiptMailboxDto extends PartialType(
  PickType(UpsertEmailReceiptMailboxDto, [
    "host",
    "port",
    "security",
    "username",
    "password",
    "folder",
  ] as const),
) {}
