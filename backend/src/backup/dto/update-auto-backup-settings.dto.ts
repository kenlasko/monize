import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  IsIn,
  Min,
  Max,
  MaxLength,
  Matches,
} from "class-validator";

export const AUTO_BACKUP_FREQUENCIES = [
  "daily",
  "every12hours",
  "every6hours",
  "weekly",
] as const;

export type AutoBackupFrequency = (typeof AUTO_BACKUP_FREQUENCIES)[number];

export class UpdateAutoBackupSettingsDto {
  @ApiPropertyOptional({ description: "Enable or disable automatic backups" })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description:
      "Absolute path to the backup folder inside the container. Must be mapped as a Docker volume.",
    example: "/backups",
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  @Matches(/^\//, {
    message: "folderPath must be an absolute path starting with /",
  })
  folderPath?: string;

  @ApiPropertyOptional({
    description: "Backup frequency",
    enum: AUTO_BACKUP_FREQUENCIES,
    example: "daily",
  })
  @IsOptional()
  @IsString()
  @IsIn([...AUTO_BACKUP_FREQUENCIES])
  frequency?: AutoBackupFrequency;

  @ApiPropertyOptional({
    description:
      "Time of day (HH:MM, local to the configured timezone) to run automatic backups. For sub-daily frequencies, this is the first run time.",
    example: "02:00",
  })
  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: "backupTime must be in HH:MM format (24-hour)",
  })
  backupTime?: string;

  @ApiPropertyOptional({
    description:
      "IANA timezone identifier for interpreting backup time. Use 'UTC' or a timezone like 'America/New_York'.",
    example: "America/New_York",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  timezone?: string;

  @ApiPropertyOptional({
    description: "Number of daily backups to retain",
    example: 7,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  retentionDaily?: number;

  @ApiPropertyOptional({
    description: "Number of weekly backups to retain",
    example: 4,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(52)
  retentionWeekly?: number;

  @ApiPropertyOptional({
    description: "Number of monthly backups to retain",
    example: 6,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  retentionMonthly?: number;
}

export class ValidateFolderDto {
  @ApiPropertyOptional({
    description: "Absolute path to validate",
    example: "/backups",
  })
  @IsString()
  @MaxLength(1024)
  folderPath: string;
}
