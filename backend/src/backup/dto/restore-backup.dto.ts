import { IsString, IsOptional, IsObject, MaxLength } from "class-validator";

export class RestoreBackupDto {
  @IsString()
  @MaxLength(128)
  @IsOptional()
  password?: string;

  @IsString()
  @MaxLength(2048)
  @IsOptional()
  oidcIdToken?: string;

  @IsObject()
  data: Record<string, unknown>;
}
