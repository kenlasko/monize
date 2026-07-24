import {
  Entity,
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
export class UserPreference {
  @PrimaryColumn("uuid", { name: "user_id" })
  userId: string;

  @Column({ name: "default_currency", length: 3, default: "USD" })
  defaultCurrency: string;

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

  @Column({ name: "notification_browser", default: true })
  notificationBrowser: boolean;

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
  // written only via the tenantTx atomic jsonb-merge in ToursService, so it is
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
  defaultQuoteProvider: "yahoo" | "msn";

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
