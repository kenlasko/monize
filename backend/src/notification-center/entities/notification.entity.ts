import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { Budget } from "../../budgets/entities/budget.entity";
import { BudgetCategory } from "../../budgets/entities/budget-category.entity";
import { User } from "../../users/entities/user.entity";

/**
 * What produced a notification. Values must fit the `alert_type` VARCHAR(30)
 * column -- a guard test in `notification-category.spec.ts` holds the bound.
 */
export enum NotificationType {
  PACE_WARNING = "PACE_WARNING",
  THRESHOLD_WARNING = "THRESHOLD_WARNING",
  THRESHOLD_CRITICAL = "THRESHOLD_CRITICAL",
  OVER_BUDGET = "OVER_BUDGET",
  FLEX_GROUP_WARNING = "FLEX_GROUP_WARNING",
  SEASONAL_SPIKE = "SEASONAL_SPIKE",
  PROJECTED_OVERSPEND = "PROJECTED_OVERSPEND",
  INCOME_SHORTFALL = "INCOME_SHORTFALL",
  POSITIVE_MILESTONE = "POSITIVE_MILESTONE",
  BILL_DUE = "BILL_DUE",
  // System-level notifications (budget_id NULL, carrying a dedupe_key).
  // Admin-facing types are fanned out one row per administrator by
  // SystemAlertService.
  BACKUP_FAILED = "BACKUP_FAILED",
  BACKUP_PARTIAL = "BACKUP_PARTIAL",
  // No longer raised: the server refuses to start without ENCRYPTION_KEY.
  // Kept so the rows already raised still read and render.
  ENCRYPTION_KEY_MISSING = "ENCRYPTION_KEY_MISSING",
  // JWT_SECRET is long enough to boot but a published placeholder or typed.
  JWT_SECRET_WEAK = "JWT_SECRET_WEAK",
  PROVIDER_OUTAGE = "PROVIDER_OUTAGE",
  PROVIDER_RECOVERED = "PROVIDER_RECOVERED",
  SMTP_FAILURE = "SMTP_FAILURE",
  // Structurally shaped like a system alert (budget_id NULL, dedupe_key) and
  // raised through SystemAlertService for the affected user -- but its SUBJECT is
  // a scheduled payment that did not post, so `notificationCategoryOf` files it
  // under PAYMENTS, not SYSTEM. That is what makes the PAYMENTS matrix row's push
  // and alert-email real controls (it is the category's dispatching producer).
  SCHEDULED_POST_FAILED = "SCHEDULED_POST_FAILED",
  // Per-account balance crossings (BALANCES category). budget_id NULL, no
  // dedupe_key: the producer's armed latch is the idempotency mechanism, and a
  // budget_id-NULL row is unconstrained by both unique indexes.
  // See `docs/specs/balance-threshold-notifications.md`.
  BALANCE_BELOW_THRESHOLD = "BALANCE_BELOW_THRESHOLD",
  BALANCE_ABOVE_THRESHOLD = "BALANCE_ABOVE_THRESHOLD",
  // A day's market-driven change in investment-account value, net of external
  // cash flows (INVESTMENTS category). One per day per user via a dedupe_key
  // carrying the date. See `docs/specs/portfolio-movement-notifications.md`.
  PORTFOLIO_MOVEMENT = "PORTFOLIO_MOVEMENT",
  SECURITY_PRICE_MOVEMENT = "SECURITY_PRICE_MOVEMENT",
  // A GEM strategy's recommendation changed between periods (STRATEGIES
  // category). `data.kind` is "risk" (RISK_ON<->RISK_OFF) or "allocation".
  // See `docs/specs/gem-signal-change-notifications.md`.
  GEM_SIGNAL_CHANGED = "GEM_SIGNAL_CHANGED",
  // Bank sync (BANK_SYNC and BANK_SYNC_ACTIVITY categories): consent reminders
  // and the daily sync's outcomes. Each carries a dedupe_key (`bsc:...`) so a
  // replica that loses the insert sends nothing. See
  // `docs/specs/bank-sync-notifications.md`.
  BANK_SYNC_CONSENT_EXPIRING = "BANK_SYNC_CONSENT_EXPIRING",
  BANK_SYNC_CONSENT_EXPIRED = "BANK_SYNC_CONSENT_EXPIRED",
  BANK_SYNC_FAILED = "BANK_SYNC_FAILED",
  BANK_SYNC_IMPORTED = "BANK_SYNC_IMPORTED",
}

/**
 * The system half of the type partition above, written once so every consumer
 * of "system vs financial" (the dismiss-matching filter, the frontend's
 * mirrored copy in the frontend's notification types) derives from one set.
 * Financial is NOT IN this set -- never a second list.
 *
 * `SCHEDULED_POST_FAILED` is deliberately NOT here: though it is shaped like a
 * system alert, it is about the user's own scheduled payment, so it reads as
 * financial in the bell's system/financial split and is categorized PAYMENTS.
 * The category test holds the fine `category` and this coarse split in agreement.
 */
export const SYSTEM_NOTIFICATION_TYPES: readonly NotificationType[] = [
  NotificationType.BACKUP_FAILED,
  NotificationType.BACKUP_PARTIAL,
  NotificationType.ENCRYPTION_KEY_MISSING,
  NotificationType.JWT_SECRET_WEAK,
  NotificationType.PROVIDER_OUTAGE,
  NotificationType.PROVIDER_RECOVERED,
  NotificationType.SMTP_FAILURE,
];

/**
 * How urgent, and how it is drawn. This is the `priority` axis discussion #1291
 * asked for: it has carried exactly that meaning since the first budget alert,
 * so there is no second column beside it. Two columns on one axis is how the
 * answers drift.
 */
export enum NotificationSeverity {
  INFO = "info",
  WARNING = "warning",
  CRITICAL = "critical",
  SUCCESS = "success",
}

/**
 * What a notification is *about*, as opposed to what produced it.
 *
 * The axis a per-category preference keys on ("tell me about budgets, not about
 * price refreshes"), which is why it exists separately from the type: there are
 * ten budget types and one preference. Kept deliberately small -- a category
 * nobody can express a preference about is a value, not a category. The
 * discussion's fuller list (Investments, Goals, Imports) arrives with the
 * producers that need it, not before.
 */
export enum NotificationCategory {
  PAYMENTS = "PAYMENTS",
  BUDGETS = "BUDGETS",
  SYSTEM = "SYSTEM",
  // Each arrives with its producer (never a dead row): balance crossings,
  // daily portfolio movement, GEM strategy signal changes.
  BALANCES = "BALANCES",
  INVESTMENTS = "INVESTMENTS",
  STRATEGIES = "STRATEGIES",
  // What needs the user's action at a bank connection (consent ending or ended,
  // a failed sync) versus what only reports (rows imported): two categories so
  // the matrix can give them different default channels
  // (`docs/specs/bank-sync-notifications.md` section 2).
  BANK_SYNC = "BANK_SYNC",
  BANK_SYNC_ACTIVITY = "BANK_SYNC_ACTIVITY",
}

/**
 * The financial category type-partitions, written once so every consumer
 * (the category function, its inverse, the frontend mirror) derives from one
 * set rather than a second hand-kept list. A type absent from all of these and
 * from {@link SYSTEM_NOTIFICATION_TYPES} and the PAYMENTS special-case falls
 * through to BUDGETS; the category spec asserts every type maps where intended.
 */
export const BALANCE_NOTIFICATION_TYPES: readonly NotificationType[] = [
  NotificationType.BALANCE_BELOW_THRESHOLD,
  NotificationType.BALANCE_ABOVE_THRESHOLD,
];
export const INVESTMENT_NOTIFICATION_TYPES: readonly NotificationType[] = [
  NotificationType.PORTFOLIO_MOVEMENT,
  NotificationType.SECURITY_PRICE_MOVEMENT,
];
export const STRATEGY_NOTIFICATION_TYPES: readonly NotificationType[] = [
  NotificationType.GEM_SIGNAL_CHANGED,
];
export const BANK_SYNC_NOTIFICATION_TYPES: readonly NotificationType[] = [
  NotificationType.BANK_SYNC_CONSENT_EXPIRING,
  NotificationType.BANK_SYNC_CONSENT_EXPIRED,
  NotificationType.BANK_SYNC_FAILED,
];
export const BANK_SYNC_ACTIVITY_NOTIFICATION_TYPES: readonly NotificationType[] =
  [NotificationType.BANK_SYNC_IMPORTED];

/**
 * The category a type belongs to, derived rather than chosen -- and derived
 * rather than stored.
 *
 * There is no `category` column. A stored copy would be a second answer to a
 * question the row already answers through `alert_type`, kept true only by every
 * producer remembering to write it: the one raw INSERT in this codebase would
 * have taken the column default and filed budget alerts under SYSTEM. As one
 * total function over the enum, a row cannot disagree with itself, and
 * re-classifying a type applies to the history a preference filters as well as
 * to the next row.
 */
export function notificationCategoryOf(
  type: NotificationType,
): NotificationCategory {
  // BILL_DUE and SCHEDULED_POST_FAILED are both about a scheduled payment, so
  // they share the PAYMENTS row. This special case runs BEFORE the system check
  // so a type can be structurally system-shaped (dedupe_key) yet financial by
  // subject; the category test proves the two classifications never diverge.
  if (
    type === NotificationType.BILL_DUE ||
    type === NotificationType.SCHEDULED_POST_FAILED
  ) {
    return NotificationCategory.PAYMENTS;
  }
  if (SYSTEM_NOTIFICATION_TYPES.includes(type)) {
    return NotificationCategory.SYSTEM;
  }
  if (BALANCE_NOTIFICATION_TYPES.includes(type)) {
    return NotificationCategory.BALANCES;
  }
  if (INVESTMENT_NOTIFICATION_TYPES.includes(type)) {
    return NotificationCategory.INVESTMENTS;
  }
  if (STRATEGY_NOTIFICATION_TYPES.includes(type)) {
    return NotificationCategory.STRATEGIES;
  }
  if (BANK_SYNC_NOTIFICATION_TYPES.includes(type)) {
    return NotificationCategory.BANK_SYNC;
  }
  if (BANK_SYNC_ACTIVITY_NOTIFICATION_TYPES.includes(type)) {
    return NotificationCategory.BANK_SYNC_ACTIVITY;
  }
  return NotificationCategory.BUDGETS;
}

/**
 * The types that belong to a category -- the inverse of
 * {@link notificationCategoryOf}, derived from it so the two cannot disagree.
 * The Phase 5 throttle needs it: a category is not stored, so "same group in the
 * last N minutes" is a filter on the `alert_type` set the category maps to.
 */
export function typesForCategory(
  category: NotificationCategory,
): NotificationType[] {
  return Object.values(NotificationType).filter(
    (type) => notificationCategoryOf(type) === category,
  );
}

/**
 * How urgent a severity is, as an orderable rank -- so the throttle can let a
 * strict escalation through (a higher severity than a recent one always fans
 * out; silence on an escalation is the dangerous direction). `success` is a
 * good-news milestone, ranked with `info`: it is never an escalation.
 */
export function severityRank(severity: NotificationSeverity): number {
  switch (severity) {
    case NotificationSeverity.CRITICAL:
      return 2;
    case NotificationSeverity.WARNING:
      return 1;
    default:
      return 0;
  }
}

/** The severities at or above a given one -- the throttle's "not an escalation" set. */
export function severitiesAtOrAbove(
  severity: NotificationSeverity,
): NotificationSeverity[] {
  const rank = severityRank(severity);
  return Object.values(NotificationSeverity).filter(
    (candidate) => severityRank(candidate) >= rank,
  );
}

const dateTransformer = {
  from: (value: string | Date): string => {
    if (!value) return value as string;
    if (typeof value === "string") return value;
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  },
  to: (value: string | Date) => value,
};

/**
 * One durable notification, whatever produced it.
 *
 * Renamed from `budget_alerts` by migration 179: the table stopped being about
 * budgets when the first BACKUP_FAILED row landed in it, and a name that lies is
 * how a second table gets created beside it. `NotificationService` is the only
 * door that writes one.
 */
@Entity("notifications")
export class Notification {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "uuid", name: "budget_id", nullable: true })
  budgetId: string | null;

  @ManyToOne(() => Budget, { nullable: true })
  @JoinColumn({ name: "budget_id" })
  budget: Budget | null;

  @Column({ type: "uuid", name: "budget_category_id", nullable: true })
  budgetCategoryId: string | null;

  @ManyToOne(() => BudgetCategory, { nullable: true })
  @JoinColumn({ name: "budget_category_id" })
  budgetCategory: BudgetCategory | null;

  /**
   * Still `alert_type` in the database: renaming a column is a rewrite of every
   * index that names it and every query that reads it, for a synonym. The
   * property is what code says.
   */
  @Column({ type: "varchar", length: 30, name: "alert_type" })
  type: NotificationType;

  @Column({ type: "varchar", length: 20 })
  severity: NotificationSeverity;

  @Column({ type: "varchar", length: 255 })
  title: string;

  @Column({ type: "text" })
  message: string;

  @Column({ type: "jsonb", default: {} })
  data: Record<string, unknown>;

  /**
   * The in-app path this points at. Always a same-origin path, never a URL --
   * the service worker resolves it against the app's own origin and discards
   * anything that leaves it, and the bell links to it the same way.
   */
  @Column({ type: "varchar", length: 255, nullable: true })
  target: string | null;

  @Column({ name: "is_read", default: false })
  isRead: boolean;

  @Column({ name: "is_email_sent", default: false })
  isEmailSent: boolean;

  @Column({
    type: "date",
    name: "period_start",
    transformer: dateTransformer,
  })
  periodStart: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @Column({ type: "timestamp", name: "dismissed_at", nullable: true })
  dismissedAt: Date | null;

  /**
   * Explicit fingerprint for system notifications (budget_id NULL), where the
   * fingerprint unique index cannot arbitrate (NULL never equals NULL). Unique
   * per (user_id, dedupe_key) via the partial index
   * `idx_notifications_dedupe`; budget-generated rows leave it NULL.
   */
  @Column({ type: "varchar", length: 120, name: "dedupe_key", nullable: true })
  dedupeKey: string | null;
}
