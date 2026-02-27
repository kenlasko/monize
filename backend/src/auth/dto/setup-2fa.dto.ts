import { IsString, Length, Matches } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class Setup2faDto {
  @ApiProperty({ description: "6-digit TOTP code from authenticator app" })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: "Code must be exactly 6 digits" })
  code: string;
}
