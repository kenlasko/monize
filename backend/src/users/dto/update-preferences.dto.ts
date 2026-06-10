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
    description:
      "Colour theme (palette), separate from the light/dark mode preference",
    example: "default",
    enum: [
      "default",
      "latte",
      "msmoney",
      "nord",
      "forest",
      "solarized",
      "highcontrast",
    ],
  })
  @IsOptional()
  @IsString()
  @IsIn([
    "default",
    "latte",
    "msmoney",
    "nord",
    "forest",
    "solarized",
    "highcontrast",
  ])
  colorTheme?: string;

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

  @ApiPropertyOptional({
    description: "Time display format (24h or 12h)",
    example: "24h",
  })
  @IsOptional()
  @IsString()
  @IsIn(["24h", "12h"])
  timeFormat?: string;

  @ApiPropertyOptional({
    description:
      "Preferred exchanges for security lookups, in priority order (max 3)",
    example: ["TSX", "NYSE"],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(20, { each: true })
  @ArrayMaxSize(3)
  preferredExchanges?: string[];

  @ApiPropertyOptional({
    description:
      "Default provider for stock quotes. Per-security overrides fall back to this value.",
    example: "yahoo",
    enum: ["yahoo", "msn"],
  })
  @IsOptional()
  @IsIn(["yahoo", "msn"])
  defaultQuoteProvider?: "yahoo" | "msn";

  @ApiPropertyOptional({
    description:
      "Number of entries shown in the recent-transactions quick-fill popover (1-20).",
    example: 5,
    minimum: 1,
    maximum: 20,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  recentTransactionsLimit?: number;

  @ApiPropertyOptional({
    description:
      "UI language. ISO 639-1 code (e.g. 'en', 'fr') or BCP 47 tag (e.g. 'pt-BR'). Must be one of the SUPPORTED_LOCALES values.",
    example: "en",
  })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  @Matches(/^[a-z]{2}(-[A-Z]{2})?$/, {
    message:
      "language must be an ISO 639-1 code (e.g. 'en') or BCP 47 tag (e.g. 'pt-BR')",
  })
  language?: string;
}
