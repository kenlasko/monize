import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  IsArray,
  Min,
  Max,
  MaxLength,
  ArrayMaxSize,
  Matches,
  IsIn,
} from "class-validator";

export class UpdatePreferencesDto {
  @ApiPropertyOptional({
    description: "Default currency code (ISO 4217)",
    example: "USD",
  })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  defaultCurrency?: string;

  @ApiPropertyOptional({
    description: "Date format (browser = use browser locale)",
    example: "browser",
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  dateFormat?: string;

  @ApiPropertyOptional({
    description: "Number format locale (browser = use browser locale)",
    example: "browser",
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  numberFormat?: string;

  @ApiPropertyOptional({ description: "Theme preference", example: "light" })
  @IsOptional()
  @IsString()
  @IsIn(["light", "dark", "system"])
  theme?: string;

  @ApiPropertyOptional({
    description: "Timezone (browser = use browser timezone)",
    example: "browser",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  timezone?: string;

  @ApiPropertyOptional({ description: "Receive email notifications" })
  @IsOptional()
  @IsBoolean()
  notificationEmail?: boolean;

  @ApiPropertyOptional({ description: "Receive browser notifications" })
  @IsOptional()
  @IsBoolean()
  notificationBrowser?: boolean;

  @ApiPropertyOptional({ description: "Dismiss the Getting Started guide" })
  @IsOptional()
  @IsBoolean()
  gettingStartedDismissed?: boolean;

  @ApiPropertyOptional({
    description: "Day the week starts on (0=Sunday, 1=Monday, ..., 6=Saturday)",
    example: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  weekStartsOn?: number;

  @ApiPropertyOptional({
    description: "Enable weekly budget digest emails",
  })
  @IsOptional()
  @IsBoolean()
  budgetDigestEnabled?: boolean;

  @ApiPropertyOptional({
    description: "Day of week for budget digest email",
    example: "MONDAY",
  })
  @IsOptional()
  @IsString()
  @IsIn(["MONDAY", "FRIDAY"])
  budgetDigestDay?: string;

  @ApiPropertyOptional({
    description: "IDs of favourite built-in reports",
    example: ["spending-by-category", "net-worth"],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @Matches(/^[a-z0-9-]+$/, {
    each: true,
    message:
      "each value in favouriteReportIds must contain only lowercase letters, numbers, and hyphens",
  })
  @ArrayMaxSize(100)
  favouriteReportIds?: string[];

  @ApiPropertyOptional({
    description: "Show the Created At field in transaction forms",
  })
  @IsOptional()
  @IsBoolean()
  showCreatedAt?: boolean;
}
