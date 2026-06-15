import { IsString, MaxLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class VerifyEmailDto {
  @ApiProperty()
  @IsString()
  @MaxLength(256)
  token: string;
}
