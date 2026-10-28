import {
  Entity,
  Check,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  JoinColumn,
} from "typeorm";
import { Exclude } from "class-transformer";
import { User } from "./user.entity";

// Persisted state of a single guided tour for a user. `version` is stamped only
// on release-* tour ids so a future release can offer them again.
export interface TourProgressEntry {
  status: "completed" | "dismissed";
  version?: string;
  updatedAt: string;
}

export type TourProgressMap = Record<string, TourProgressEntry>;

@Entity("user_preferences")
@Check(
  "ck_user_preferences_reporting_basis",
  "reporting_basis IN ('cash', 'accrual')",
)
export class UserPreference {
  @PrimaryColumn("uuid", { name: "user_id" })
  userId: string;

  @Column({ name: "default_currency", length: 3, default: "USD" })
  defaultCurrency: string;

  @Column({
    name: "reporting_basis",
    type: "varchar",
    length: 10,
    default: "cash",
  })
  reportingBasis: "cash" | "accrual";

  // Master reporting switch for the whole accrual feature (tab, Accounts/
  // Other balances, Cash/Accrual report switch). Off by default: a user who
  // has never heard of accrual accounting sees none of it until they opt in.
  @Column({ name: "accrual_enabled", default: false })
  accrualEnabled: boolean;

  @Column({ name: "date_format", default: "YYYY-MM-DD" })
  dateFormat: string;

  @Column({ name: "number_format", default: "en-US" })
  numberFormat: string;

  @Column({ default: "light" })
  theme: string;

  @Column({ name: "color_theme", length: 20, default: "default" })
  colorTheme: string;

  @Column({ default: "browser" })
  timezone: string;

  @Column({ name: "notification_email", default: true })
  notificationEmail: boolean;

  @Column({ name: "two_factor_enabled", default: false })
  twoFactorEnabled: boolean;

  @Column({ name: "getting_started_dismissed", default: false })
  gettingStartedDismissed: boolean;

  @Column({ name: "week_starts_on", type: "smallint", default: 1 })
  weekStartsOn: number;

  @Column({ name: "budget_digest_enabled", default: true })
  budgetDigestEnabled: boolean;

  @Column({
    name: "budget_digest_day",
    type: "varchar",
    length: 10,
    default: "MONDAY",
  })
  budgetDigestDay: string;

  @Column({
    name: "favourite_report_ids",
    type: "text",
    array: true,
    default: "{}",
  })
  favouriteReportIds: string[];

  // Ordered ids of the widgets shown on the dashboard. Empty means the user
  // has not customized the layout and gets the built-in default.
  @Column({
    name: "dashboard_widgets",
    type: "text",
    array: true,
    default: "{}",
  })
  dashboardWidgets: string[];

  // Per-widget settings (timeframe, account selection, chart type, etc.) keyed
  // by widget id. Empty object = every widget uses its built-in defaults.
  // Typed as Record<string, any> (matching the other jsonb columns on
  // relation-reachable entities, e.g. action-history) so TypeORM's DeepPartial
  // stays satisfiable where UserPreference is reached through the User relation.
  @Column({
    name: "dashboard_widget_config",
    type: "jsonb",
    default: {},
  })
  dashboardWidgetConfig: Record<string, any>;

  // Account-level default hidden column ids per table kind (transactions,
  // investmentHoldings, investmentRegister), merged by kind on update. A
  // browser that has saved its own choice for a kind keeps it. Empty object =
  // no columns hidden by default. Typed as
  // Record<string, any> (matching the other jsonb columns on
  // relation-reachable entities, e.g. action-history) so TypeORM's DeepPartial
  // stays satisfiable where UserPreference is reached through the User relation.
  @Column({
    name: "hidden_table_columns",
    type: "jsonb",
    default: {},
  })
  hiddenTableColumns: Record<string, any>;

  // Account-level defaults for the browser-local view settings (density,
  // hideRegisterYear, widgetsCollapsed, chartCollapsed) and accountOpenTarget;
  // `src/users/view-defaults.ts` declares the keys and values. A browser that
  // has saved its own choice keeps it. Empty object = no defaults. Typed as
  // Record<string, any> for the DeepPartial reason given on hiddenTableColumns.
  @Column({
    name: "view_defaults",
    type: "jsonb",
    default: {},
  })
  viewDefaults: Record<string, any>;

  @Column({ name: "show_created_at", default: false })
  showCreatedAt: boolean;

  @Column({ name: "time_format", length: 10, default: "24h" })
  timeFormat: string;

  @Column({
    name: "preferred_exchanges",
    type: "text",
    array: true,
    default: "{}",
  })
  preferredExchanges: string[];

  @Column({
    name: "dismissed_update_version",
    type: "varchar",
    length: 50,
    nullable: true,
  })
  dismissedUpdateVersion: string | null;

  // Version whose "What's New" release notes the user acknowledged via
  // "Don't show this again". The auto-popup is suppressed while this equals
  // the running version; a newer release makes it reappear. Server-managed
  // (written only via the What's New "seen" endpoint), so it is excluded from
  // the user-editable preferences DTO, mirroring dismissedUpdateVersion.
  @Column({
    name: "last_seen_version",
    type: "varchar",
    length: 50,
    nullable: true,
  })
  lastSeenVersion: string | null;

  // Settings kill-switch for the What's New auto-popup. When false the popup
  // never opens automatically, though the version labels can still open it
  // manually.
  @Column({ name: "show_whats_new", default: true })
  showWhatsNew: boolean;

  // Guided-tour completion state, keyed by opaque tour id. Server-managed and
  // written only via the withScopedDb atomic jsonb-merge in ToursService, so it is
  // excluded from the serialized preferences response (the global
  // ClassSerializerInterceptor honours @Exclude()) and from the editable DTO --
  // GET /updates/tours/progress is the single source of truth.
  @Exclude()
  @Column({ name: "tour_progress", type: "jsonb", default: {} })
  tourProgress: TourProgressMap;

  @Column({
    name: "default_quote_provider",
    type: "varchar",
    length: 20,
    default: "yahoo",
  })
  // Written-out literals, not the QuoteProviderName alias, for the same reason
  // as defaultMapProvider below: entity-varchar-capacity.spec.ts measures them.
  defaultQuoteProvider: "yahoo" | "msn" | "lse" | "deutsche_boerse";

  /**
   * Which map service an address link opens. "device" means decide from the
   * platform, which is what every user got before this column existed.
   *
   * The union is written out here rather than imported from MAP_PROVIDERS in
   * the DTO because `entity-varchar-capacity.spec.ts` reads this annotation to
   * check the longest allowed literal against the column width; an aliased type
   * would leave that guard with nothing to measure. The two lists are held
   * together by `update-preferences.dto.spec.ts`.
   */
  @Column({
    name: "default_map_provider",
    type: "varchar",
    length: 20,
    default: "device",
  })
  defaultMapProvider:
    "device" | "openstreetmap" | "google" | "apple" | "bing" | "waze";

  @Column({
    name: "recent_transactions_limit",
    type: "smallint",
    default: 5,
  })
  recentTransactionsLimit: number;

  // Opt-in: show the app-wide floating AI chat bubble. Default off so the
  // bubble only appears for users who enable it in AI Settings.
  @Column({ name: "ai_bubble_enabled", default: false })
  aiBubbleEnabled: boolean;

  // Strict reconciled lock. The transaction form already prompts before an edit
  // that would move a reconciled row's date or amount, which is what Money
  // does; with this on the server refuses the write outright -- an edit, a
  // delete, or a status change away from RECONCILED -- on every path. Turning
  // the flag off in Settings is the only way through, deliberately: an escape
  // hatch reachable from the same screen as the edit is not a lock.
  @Column({ name: "lock_reconciled_transactions", default: false })
  lockReconciledTransactions: boolean;

  // Opt-in: look up a new payee's website, address, email and phone through
  // the user's configured AI provider. Off by default because every lookup is
  // a call the user pays for, and the answer is written into their data.
  @Column({ name: "payee_contact_lookup_enabled", default: false })
  payeeContactLookupEnabled: boolean;

  @Column({ length: 10, default: "en" })
  language: string;

  // Set opportunistically by RequestContextInterceptor when an authenticated
  // request carries an X-Client-Timezone header. Cron jobs prefer the user's
  // explicit `timezone` setting; this is the fallback when `timezone` is the
  // "browser" sentinel so we don't compute "today" in UTC for everyone.
  @Column({
    name: "last_client_timezone",
    type: "varchar",
    length: 64,
    nullable: true,
  })
  lastClientTimezone: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;

  @OneToOne(() => User, (user) => user.preferences)
  @JoinColumn({ name: "user_id" })
  user: User;
}
