import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsOptional, IsEmail, MaxLength } from "class-validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

export class UpdateProfileDto {
  @ApiPropertyOptional({ description: "First name" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  firstName?: string;

  @ApiPropertyOptional({ description: "Last name" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  lastName?: string;

  @ApiPropertyOptional({ description: "Email address" })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    description: "Current password (required when changing email)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  currentPassword?: string;
}
