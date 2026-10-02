import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

/**
 * `POST /bank-sync/callback`: what the bank's redirect carried back. The state
 * is 43 characters as issued; the bound leaves room without accepting a body.
 */
export class BankSyncCallbackDto {
  @ApiProperty({
    description: "The one-time state issued when the authorization started.",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  state: string;

  @ApiPropertyOptional({
    description: "The authorization code, when the bank granted access.",
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  code?: string;

  @ApiPropertyOptional({
    description: "The error code, when the bank refused.",
  })
  @IsOptional()
  @SanitizeHtml()
  @IsString()
  @MaxLength(200)
  error?: string;

  @ApiPropertyOptional({ description: "The bank's description of the error." })
  @IsOptional()
  @SanitizeHtml()
  @IsString()
  @MaxLength(1000)
  errorDescription?: string;
}
