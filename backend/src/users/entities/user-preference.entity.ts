import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  JoinColumn,
} from "typeorm";
import { User } from "./user.entity";

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
  @Column({
    name: "dashboard_widget_config",
    type: "jsonb",
    default: {},
  })
  dashboardWidgetConfig: Record<string, unknown>;

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
