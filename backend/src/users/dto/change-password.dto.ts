import { ApiProperty } from "@nestjs/swagger";
import { IsString, MinLength, MaxLength, Matches } from "class-validator";

export class ChangePasswordDto {
  @ApiProperty({ description: "Current password" })
  @IsString()
  currentPassword: string;

  @ApiProperty({
    description:
      "New password (8+ chars with uppercase, lowercase, number, and special character)",
  })
  @IsString()
  @MinLength(8)
  @MaxLength(100)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d\s])/, {
    message:
      "Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character",
  })
  newPassword: string;
}
