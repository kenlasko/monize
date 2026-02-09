import { IsString, Length, IsBoolean, IsOptional } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class VerifyTotpDto {
  @ApiProperty({ description: "Temporary token from login response" })
  @IsString()
  tempToken: string;

  @ApiProperty({ description: "6-digit TOTP code from authenticator app" })
  @IsString()
  @Length(6, 6)
  code: string;

  @ApiProperty({
    description: "Remember this device and skip 2FA for 30 days",
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  rememberDevice?: boolean;
}
