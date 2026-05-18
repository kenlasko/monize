import {
  IsEmail,
  IsOptional,
  IsString,
  IsBoolean,
  MaxLength,
  MinLength,
  Matches,
} from "class-validator";

export class CreateDelegateDto {
  @IsEmail()
  @MaxLength(255)
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  /**
   * Owner-chosen password for a brand-new delegate user. Mutually exclusive
   * with sendInvite. Ignored when the email already belongs to an existing
   * user (that user keeps their own credentials).
   */
  @IsOptional()
  @IsString()
  @MinLength(12)
  @MaxLength(100)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d\s])/, {
    message:
      "Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character",
  })
  password?: string;

  /**
   * When true, create the delegate without a password and email them an
   * invite link to set one (requires SMTP to be configured).
   */
  @IsOptional()
  @IsBoolean()
  sendInvite?: boolean;
}
