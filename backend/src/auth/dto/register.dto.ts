import {
  IsEmail,
  IsString,
  MinLength,
  MaxLength,
  IsOptional,
  Matches,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

export class RegisterDto {
  @ApiProperty({ example: "user@example.com" })
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiProperty({
    example: "SecurePassword123!",
    description:
      "Must be 12+ chars with uppercase, lowercase, number, and special character",
  })
  @IsString()
  @MinLength(12)
  @MaxLength(100)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d\s])/, {
    message:
      "Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character",
  })
  password: string;

  @ApiProperty({ example: "John", required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  firstName?: string;

  @ApiProperty({ example: "Doe", required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  lastName?: string;

  @ApiProperty({
    required: false,
    description:
      "Temporary password issued by an account owner when the email " +
      "already belongs to a delegate. Supplying it lets the registrant " +
      "claim and upgrade the existing delegate row into a full account, " +
      "preserving its id so all account_delegates links continue to work.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  currentPassword?: string;
}
