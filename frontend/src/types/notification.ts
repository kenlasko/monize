/**
 * The notification centre's read model, mirroring the backend's
 * `notification-center/entities/notification.entity.ts`.
 *
 * Held equal by `notification.contract.test.ts`, which reads that entity and
 * compares the field names and the system-type set member for member. Nothing
 * compiles the two layers against each other, and the field names are exactly
 * where this drifted once already: the backend property is `type`, mapped to the
 * `alert_type` column, and a mirror still declaring `alertType` reads
 * `undefined` for every row while type-checking cleanly.
 */

/** What produced a notification. */
export type NotificationType =
  | 'PACE_WARNING'
  | 'THRESHOLD_WARNING'
  | 'THRESHOLD_CRITICAL'
  | 'OVER_BUDGET'
  | 'FLEX_GROUP_WARNING'
  | 'SEASONAL_SPIKE'
  | 'PROJECTED_OVERSPEND'
  | 'INCOME_SHORTFALL'
  | 'POSITIVE_MILESTONE'
  | 'BILL_DUE'
  // System-level, admin-facing notifications (budgetId null). SCHEDULED_POST_FAILED
  // is shaped like these but classified PAYMENTS (it is about a scheduled payment).
  | 'BACKUP_FAILED'
  | 'BACKUP_PARTIAL'
  | 'ENCRYPTION_KEY_MISSING'
  | 'JWT_SECRET_WEAK'
  | 'PROVIDER_OUTAGE'
  | 'PROVIDER_RECOVERED'
  | 'SMTP_FAILURE'
  | 'SCHEDULED_POST_FAILED'
  // Balance crossings (BALANCES), daily portfolio movement (INVESTMENTS), and
  // GEM recommendation changes (STRATEGIES). Each is financial, not system.
  | 'BALANCE_BELOW_THRESHOLD'
  | 'BALANCE_ABOVE_THRESHOLD'
  | 'PORTFOLIO_MOVEMENT'
  | 'SECURITY_PRICE_MOVEMENT'
  | 'GEM_SIGNAL_CHANGED'
  // Bank sync: consent reminders and the daily sync's outcomes. All financial.
  | 'BANK_SYNC_CONSENT_EXPIRING'
  | 'BANK_SYNC_CONSENT_EXPIRED'
  | 'BANK_SYNC_FAILED'
  | 'BANK_SYNC_IMPORTED';

/** How urgent, and how it is drawn. */
export type NotificationSeverity = 'info' | 'warning' | 'critical' | 'success';

/**
 * The system half of the type partition -- the backend's
 * `SYSTEM_NOTIFICATION_TYPES` mirrored by hand and held equal by
 * `notification.contract.test.ts`. Financial is everything NOT in this set, so
 * the classification is one list on each side, never two.
 */
export const SYSTEM_NOTIFICATION_TYPES: readonly NotificationType[] = [
  'BACKUP_FAILED',
  'BACKUP_PARTIAL',
  'ENCRYPTION_KEY_MISSING',
  'JWT_SECRET_WEAK',
  'PROVIDER_OUTAGE',
  'PROVIDER_RECOVERED',
  'SMTP_FAILURE',
];

/**
 * The coarse split the list UI offers: everything the system told me, versus
 * everything about my money. Deliberately not the server's `category`, which is
 * the finer axis a per-category preference will key on.
 */
export type NotificationFilterCategory = 'system' | 'financial';

/**
 * What a notification is *about*, as opposed to what produced it. Derived from
 * the type on the server -- there is no column -- and sent with every row.
 */
export type NotificationCategory =
  | 'PAYMENTS'
  | 'BUDGETS'
  | 'SYSTEM'
  | 'BALANCES'
  | 'INVESTMENTS'
  | 'STRATEGIES'
  | 'BANK_SYNC'
  | 'BANK_SYNC_ACTIVITY';

export interface Notification {
  id: string;
  userId: string;
  /** Null for bill reminders and every system notification. */
  budgetId: string | null;
  budgetCategoryId: string | null;
  type: NotificationType;
  severity: NotificationSeverity;
  /** Derived from `type` on the server; absent on a response from before it. */
  category?: NotificationCategory;
  /**
   * Stored English fallback. The UI composes its own copy from `type` and
   * `data` in the reader's language; this is for a reader with no client.
   */
  title: string;
  message: string;
  data: Record<string, unknown>;
  /**
   * The in-app path this points at, or null. Always same-origin and always a
   * path -- never a URL, so it is safe to route to directly.
   */
  target?: string | null;
  isRead: boolean;
  isEmailSent: boolean;
  periodStart: string;
  createdAt: string;
  /** Cross-replica fingerprint on system notifications; null on the rest. */
  dedupeKey?: string | null;
}
