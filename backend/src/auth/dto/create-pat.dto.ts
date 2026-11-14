import {
  IsString,
  IsNotEmpty,
  IsOptional,
  MaxLength,
  Matches,
  IsDateString,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsFutureDate } from "../../common/validators/is-future-date.validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { apiScopesList, apiScopesPattern } from "../scopes";

export class CreatePatDto {
  @ApiProperty({ description: "User-assigned label for the token" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @SanitizeHtml()
  name: string;

  // Pattern and message both derived from `API_SCOPES`: a scope named in the
  // schema comment or a feature plan but missing from the regex is exactly how
  // `reports` came to be documented and unissuable.
  @ApiPropertyOptional({
    description: `Comma-separated scopes: ${apiScopesList()}`,
    default: "read",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(apiScopesPattern(), {
    message: `Scopes must be comma-separated values of: ${apiScopesList()}`,
  })
  scopes?: string;

  // Omitted means the default lifetime (`DEFAULT_PAT_LIFETIME_DAYS`); a token
  // that never expires is asked for with an explicit null. `@IsOptional()`
  // lets both through, and `PatService` tells them apart.
  @ApiPropertyOptional({
    description:
      "Token expiration date (ISO 8601). Omit for the default of 90 days; send null for a token that never expires.",
    nullable: true,
  })
  @IsOptional()
  @IsDateString()
  @IsFutureDate({ message: "Expiration date must be in the future" })
  expiresAt?: string | null;
}
