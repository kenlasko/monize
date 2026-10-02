import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

/** The longest application id stored (`bank_sync_credentials.application_id`). */
export const APPLICATION_ID_MAX_LENGTH = 100;

/**
 * The longest private key pasted. A 4096-bit RSA key in PEM is about 3.3 KB;
 * this leaves room for a key with a comment header and refuses a file dump.
 */
export const PRIVATE_KEY_MAX_LENGTH = 16_384;

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

/** `PUT /bank-sync/credentials`. */
export class SaveBankSyncCredentialsDto {
  @ApiProperty({
    description: "The provider application id (for Enable Banking, a UUID).",
    maxLength: APPLICATION_ID_MAX_LENGTH,
  })
  @SanitizeHtml()
  @Transform(trimmed)
  @IsString()
  @IsNotEmpty()
  @MaxLength(APPLICATION_ID_MAX_LENGTH)
  applicationId: string;

  @ApiPropertyOptional({
    description:
      "The RSA private key in PEM format. Omit to keep the stored key; required when none is stored. Never returned.",
    maxLength: PRIVATE_KEY_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(PRIVATE_KEY_MAX_LENGTH)
  privateKey?: string;
}
