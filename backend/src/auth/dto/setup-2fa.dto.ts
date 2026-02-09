import { IsString, Length } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class Setup2faDto {
  @ApiProperty({ description: "6-digit TOTP code from authenticator app" })
  @IsString()
  @Length(6, 6)
  code: string;
}
