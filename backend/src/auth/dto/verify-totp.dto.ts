import {
  IsString,
  Length,
  Matches,
  IsBoolean,
  IsOptional,
  MaxLength,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class VerifyTotpDto {
  @ApiProperty({ description: "Temporary token from login response" })
  @IsString()
  @MaxLength(2048)
  tempToken: string;

  @ApiProperty({ description: "6-digit TOTP code from authenticator app" })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: "Code must be exactly 6 digits" })
  code: string;

  @ApiProperty({
    description: "Remember this device and skip 2FA for 30 days",
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  rememberDevice?: boolean;
}
