import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  IsArray,
  IsObject,
  Min,
  Max,
  MaxLength,
  ArrayMaxSize,
  Matches,
  IsIn,
  ValidateIf,
} from "class-validator";
import { Transform } from "class-transformer";
import { IsCurrencyCode } from "../../common/validators/is-currency-code.validator";
import { IsDashboardWidgetConfig } from "../validators/is-dashboard-widget-config.validator";
import { IsHiddenTableColumns } from "../validators/is-hidden-table-columns.validator";
import { IsViewDefaults } from "../validators/is-view-defaults.validator";
import { IsNumberLocale } from "../../common/validators/is-number-locale.validator";
import {
  QUOTE_PROVIDER_NAMES,
  QuoteProviderName,
} from "../../securities/providers/quote-provider.interface";

/**
 * Map services an address link can be sent to.
 *
 * "device" is the platform hand-off that predates this setting: Apple Maps on
 * iOS, a `geo:` URI on Android (which opens whichever map app the phone is set
 * to), OpenStreetMap everywhere else. It is a value rather than an absence so a
 * user can deliberately return to it.
 */
export const MAP_PROVIDERS = [
  "device",
  "openstreetmap",
  "google",
  "apple",
  "bing",
  "waze",
] as const;

export type MapProvider = (typeof MAP_PROVIDERS)[number];

export class UpdatePreferencesDto {
  @ApiPropertyOptional({ enum: ["cash", "accrual"], default: "accrual" })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(["cash", "accrual"])
  reportingBasis?: "cash" | "accrual";

  @ApiPropertyOptional({
    description:
      "Master visibility switch for the accrual feature (tab, Accounts/Other balances, Cash/Accrual report switch)",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  accrualEnabled?: boolean;

  @ApiPropertyOptional({
    description: "Default currency code (ISO 4217)",
    example: "USD",
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === "string" ? value.toUpperCase() : value,
  )
  @IsCurrencyCode()
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
  @IsNumberLocale()
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
      "newspaper",
      "burgundy",
      "nord",
      "forest",
      "solarized",
      "gruvbox",
      "dracula",
      "tokyonight",
      "rosepine",
      "midnight",
      "highcontrast",
      "colorblind",
    ],
  })
  @IsOptional()
  @IsString()
  @IsIn([
    "default",
    "latte",
    "msmoney",
    "newspaper",
    "burgundy",
    "nord",
    "forest",
    "solarized",
    "gruvbox",
    "dracula",
    "tokyonight",
    "rosepine",
    "midnight",
    "highcontrast",
    "colorblind",
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

  @ApiPropertyOptional({ description: "Dismiss the Getting Started guide" })
  @IsOptional()
  @IsBoolean()
  gettingStartedDismissed?: boolean;

  @ApiPropertyOptional({
    description: "Show the app-wide floating AI chat bubble",
  })
  @IsOptional()
  @IsBoolean()
  aiBubbleEnabled?: boolean;

  @ApiPropertyOptional({
    description:
      "Strict mode: refuse any alteration of a RECONCILED transaction while on",
  })
  @IsOptional()
  @IsBoolean()
  lockReconciledTransactions?: boolean;

  @ApiPropertyOptional({
    description:
      "Look up a new payee's website, address, email and phone through the configured AI provider",
  })
  @IsOptional()
  @IsBoolean()
  payeeContactLookupEnabled?: boolean;

  @ApiPropertyOptional({
    description:
      "Show the What's New release-notes popup automatically after an upgrade",
  })
  @IsOptional()
  @IsBoolean()
  showWhatsNew?: boolean;

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
    description:
      "Ordered ids of the widgets shown on the dashboard (empty = default layout)",
    example: ["favourite-accounts", "upcoming-bills"],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @Matches(/^[a-z0-9-]+$/, {
    each: true,
    message:
      "each value in dashboardWidgets must contain only lowercase letters, numbers, and hyphens",
  })
  @ArrayMaxSize(50)
  dashboardWidgets?: string[];

  @ApiPropertyOptional({
    description:
      "Per-widget dashboard settings (timeframe, account selection, chart type) keyed by widget id",
    example: {
      "spending-by-payee": { range: "3m" },
      "income-by-source": { range: "1y", chartType: "pie" },
    },
  })
  @IsOptional()
  @IsObject()
  @IsDashboardWidgetConfig()
  dashboardWidgetConfig?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      "Hidden column ids keyed by table kind (transactions, investmentHoldings, investmentRegister); an unknown kind, an unknown id or a duplicate is refused",
    example: {
      transactions: ["refNumber", "attachments"],
      investmentHoldings: [],
      investmentRegister: ["status"],
    },
  })
  // The raw body value: class-transformer silently skips a `__proto__` key
  // when it copies a plain object, which would store `{}` in place of
  // refusing the payload.
  @Transform(({ obj, key }) => obj[key])
  @IsOptional()
  @IsObject()
  @IsHiddenTableColumns()
  hiddenTableColumns?: Record<string, string[]>;

  @ApiPropertyOptional({
    description:
      "Account-level defaults for the browser-local view settings, applied only where the browser has saved nothing: density (normal, compact, dense), hideRegisterYear, widgetsCollapsed, chartCollapsed (booleans), and accountOpenTarget (register, dashboard). Merged into the stored map, so a key not sent keeps its value. An unknown key or value, or null, is refused",
    example: {
      density: "compact",
      hideRegisterYear: true,
      widgetsCollapsed: false,
      chartCollapsed: true,
      accountOpenTarget: "register",
    },
  })
  // The raw body value, for the `__proto__` reason given on hiddenTableColumns.
  @Transform(({ obj, key }) => obj[key])
  // Validated unless absent: `@IsOptional()` would let `null` through to the
  // NOT NULL column, a 500 in place of a 400.
  @ValidateIf((_o, value) => value !== undefined)
  @IsObject()
  @IsViewDefaults()
  viewDefaults?: Record<string, string | boolean>;

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
    enum: QUOTE_PROVIDER_NAMES,
  })
  @IsOptional()
  @IsIn([...QUOTE_PROVIDER_NAMES])
  defaultQuoteProvider?: QuoteProviderName;

  @ApiPropertyOptional({
    description:
      "Which map service an address link opens. 'device' decides from the platform: Apple Maps on iOS, the phone's default map app on Android, OpenStreetMap elsewhere.",
    example: "device",
    enum: MAP_PROVIDERS,
  })
  @IsOptional()
  @IsIn([...MAP_PROVIDERS])
  defaultMapProvider?: MapProvider;

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
      "UI language. 'browser' to follow the browser's configured language, an ISO 639-1 code (e.g. 'en', 'fr'), or a BCP 47 tag (e.g. 'pt-BR'). Must be 'browser' or one of the SUPPORTED_LOCALES values.",
    example: "en",
  })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  @Matches(/^(browser|[a-z]{2}(-[A-Z]{2})?)$/, {
    message:
      "language must be 'browser', an ISO 639-1 code (e.g. 'en'), or a BCP 47 tag (e.g. 'pt-BR')",
  })
  language?: string;
}
