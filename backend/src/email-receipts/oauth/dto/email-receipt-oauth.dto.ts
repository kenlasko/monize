import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsString, MaxLength, MinLength } from "class-validator";
import { SanitizeHtml } from "../../../common/decorators/sanitize-html.decorator";
import {
  EMAIL_RECEIPT_OAUTH_PROVIDERS,
  EmailReceiptOAuthProvider,
} from "../../entities/email-receipt-mailbox.entity";
import { IsNoControlCharacters } from "../../mailbox/no-control-characters.validator";

/** The longest `code` or `state` accepted; providers' are a few hundred characters. */
export const OAUTH_PARAMETER_MAX_LENGTH = 4096;

export class StartEmailReceiptOAuthDto {
  @ApiProperty({ enum: EMAIL_RECEIPT_OAUTH_PROVIDERS })
  @SanitizeHtml()
  @IsIn(EMAIL_RECEIPT_OAUTH_PROVIDERS)
  provider: EmailReceiptOAuthProvider;
}

/**
 * What the frontend callback page read from the provider's redirect. Both are
 * opaque: the state is checked by the server against what it sealed at `start`,
 * and the code is handed to the provider's token endpoint and nothing else.
 */
export class CompleteEmailReceiptOAuthDto {
  @ApiProperty({ maxLength: OAUTH_PARAMETER_MAX_LENGTH })
  @SanitizeHtml()
  @IsString()
  @MinLength(1)
  @MaxLength(OAUTH_PARAMETER_MAX_LENGTH)
  @IsNoControlCharacters()
  code: string;

  @ApiProperty({ maxLength: OAUTH_PARAMETER_MAX_LENGTH })
  @SanitizeHtml()
  @IsString()
  @MinLength(1)
  @MaxLength(OAUTH_PARAMETER_MAX_LENGTH)
  @IsNoControlCharacters()
  state: string;
}
