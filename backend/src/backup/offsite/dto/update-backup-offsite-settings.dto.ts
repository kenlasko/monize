import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  ValidateIf,
} from "class-validator";
import { BackupOffsiteS3Mode } from "../entities/backup-offsite-settings.entity";

/**
 * The three S3 destination modes, as one list the validator and the entity's
 * union type are both held to.
 *
 * `satisfies` is what makes it one list rather than two: a mode added to the
 * entity's type and not here (or the reverse) fails to compile, so the DTO can
 * never accept a mode the service cannot act on.
 */
export const BACKUP_OFFSITE_S3_MODES = [
  "off",
  "deployment",
  "own",
] as const satisfies readonly BackupOffsiteS3Mode[];

/**
 * An S3 bucket name, as AWS defines it: 3-63 characters, lower-case letters,
 * digits, dots and hyphens, starting and ending alphanumeric.
 *
 * Checked here rather than left to the destination because a rejected bucket
 * name is a typo the user can fix while they are looking at the form, and a
 * stored one only surfaces as a failed copy hours later, in a log they do not
 * read.
 */
const S3_BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * A key prefix: no leading slash (S3 keys are not paths and a leading slash
 * makes an empty first segment), and no `..` anywhere, so a prefix cannot be
 * written to climb out of the area an operator gave the user.
 */
const S3_KEY_PREFIX = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._\-/]*$/;

/**
 * A user's off-machine backup destinations (`docs/specs/backup-off-machine.md`
 * section 9). Every field is optional: the form saves one section at a time and
 * a field nobody touched must not clear the column behind it.
 *
 * The two credential fields are **write-only**. They are accepted here and
 * stored as AES-256-GCM ciphertext; nothing ever returns them, and
 * `BackupOffsiteSettingsView` reports only whether each one is set. Clearing
 * them is its own flag rather than an empty string, because a form that resends
 * every field would otherwise wipe a stored secret on every save.
 */
export class UpdateBackupOffsiteSettingsDto {
  @ApiPropertyOptional({
    description:
      "Which S3 destination automatic backups are copied to: none, the deployment's bucket, or your own.",
    enum: BACKUP_OFFSITE_S3_MODES,
    example: "deployment",
  })
  @IsOptional()
  @IsString()
  @IsIn([...BACKUP_OFFSITE_S3_MODES])
  s3Mode?: BackupOffsiteS3Mode;

  @ApiPropertyOptional({
    description: "Bucket your backups are copied to (own destination only)",
    example: "my-monize-offsite",
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null && value !== "")
  @IsString()
  @MaxLength(255)
  @Matches(S3_BUCKET_NAME, {
    message:
      "s3Bucket must be a valid S3 bucket name: 3-63 lower-case letters, digits, dots or hyphens",
  })
  s3Bucket?: string | null;

  @ApiPropertyOptional({
    description: "Region of your bucket; many S3-compatible services ignore it",
    example: "us-east-1",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  s3Region?: string | null;

  @ApiPropertyOptional({
    description: "Key prefix so backups can share a bucket with other data",
    example: "backups/",
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null && value !== "")
  @IsString()
  @MaxLength(512)
  @Matches(S3_KEY_PREFIX, {
    message:
      "s3Prefix must not start with '/' or contain '..', and may hold only letters, digits, '.', '_', '-' and '/'",
  })
  s3Prefix?: string | null;

  @ApiPropertyOptional({
    description:
      "Custom endpoint for an S3-compatible service (MinIO, R2, B2). Leave unset for AWS.",
    example: "https://s3.example.com",
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null && value !== "")
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ["http", "https"], require_protocol: true })
  s3Endpoint?: string | null;

  @ApiPropertyOptional({
    description: "Path-style addressing, required by MinIO and some others",
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  s3ForcePathStyle?: boolean;

  @ApiPropertyOptional({
    description:
      "Access key id for your own bucket. Stored encrypted and never returned.",
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null && value !== "")
  @IsString()
  @MaxLength(512)
  s3AccessKeyId?: string | null;

  @ApiPropertyOptional({
    description:
      "Secret access key for your own bucket. Stored encrypted and never returned.",
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null && value !== "")
  @IsString()
  @MaxLength(512)
  s3SecretAccessKey?: string | null;

  @ApiPropertyOptional({
    description:
      "Forget the stored access key id and secret access key. Applied before any credential supplied in the same request.",
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  clearS3Credentials?: boolean;

  @ApiPropertyOptional({
    description: "Email a copy of each completed automatic backup",
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;

  @ApiPropertyOptional({
    description: "Address the emailed copy is sent to",
    example: "me@example.com",
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null && value !== "")
  @IsString()
  @MaxLength(320)
  @IsEmail()
  emailTo?: string | null;
}

/**
 * What the settings API returns.
 *
 * Deliberately not the entity: the row carries two columns of ciphertext, and a
 * response shape that could ever hold them is a response shape that one day
 * does. Each credential appears here as a boolean -- set or not -- which is the
 * whole of what a form needs in order to show "configured" beside a field the
 * user can overwrite but never read back (spec section 9).
 *
 * `deploymentS3Available` and `encryptionConfigured` are facts about the
 * deployment rather than the row, and they are here because every refusal the
 * update can raise depends on one of them: a surface that knows them up front
 * can say "this deployment has no off-site bucket" before the user fills the
 * form in, rather than after they press save.
 */
export interface BackupOffsiteSettingsView {
  s3Mode: BackupOffsiteS3Mode;
  s3Bucket: string | null;
  s3Region: string | null;
  s3Prefix: string | null;
  s3Endpoint: string | null;
  s3ForcePathStyle: boolean;
  /** Whether an access key id is stored. Never its value. */
  s3AccessKeyIdSet: boolean;
  /** Whether a secret access key is stored. Never its value. */
  s3SecretAccessKeySet: boolean;
  emailEnabled: boolean;
  emailTo: string | null;
  /** Whether this deployment has a bucket of its own to offer (BACKUP_S3_BUCKET). */
  deploymentS3Available: boolean;
  /** Whether this deployment can store a credential at all (ENCRYPTION_KEY). */
  encryptionConfigured: boolean;
}
