import { safeNotificationTarget } from '@/lib/notification-target';
import type { ShellNotificationRow } from '@/lib/shell';
import type { Notification, NotificationCategory } from '@/types/notification';

/**
 * The pure half of the native-notification bridge's page side
 * (`docs/frontend/shell-contract.md`, "Native notifications"): who the shell is
 * told is signed in, which rows it is handed, and how often the page asks.
 * `useShellNotificationBridge` does the asking.
 */

/** How often the page reads the notification centre while all is well. */
export const SHELL_POLL_INTERVAL_MS = 60_000;
/** The longest wait after repeated failures (the backend restarting, say). */
export const SHELL_POLL_MAX_DELAY_MS = 15 * 60_000;

/** Doubles per consecutive failure, from the interval up to the ceiling. */
export function nextShellPollDelay(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return SHELL_POLL_INTERVAL_MS;
  const exponent = Math.min(consecutiveFailures, 10);
  return Math.min(SHELL_POLL_MAX_DELAY_MS, SHELL_POLL_INTERVAL_MS * 2 ** exponent);
}

export interface BridgeAuthState {
  hasHydrated: boolean;
  isAuthenticated: boolean;
  userId: string | null;
  actingAsUserId: string | null;
}

/**
 * Whose notifications the shell shows: the signed-in user's id; `null` for
 * nobody, which makes the shell close every notification it raised; or
 * `undefined` while the page does not know yet (the store is hydrating after
 * a reload), when it says nothing rather than briefly "nobody".
 *
 * Acting for another account is `null`: the shell interrupts a person about
 * their own money, and the delegated view's bell is the place for the other's.
 */
export function bridgeIdentity(auth: BridgeAuthState): string | null | undefined {
  if (!auth.hasHydrated) return undefined;
  if (!auth.isAuthenticated) return null;
  if (auth.actingAsUserId !== null) return null;
  return auth.userId ?? undefined;
}

/**
 * The catalog key under `notifications.native` for each category: the same
 * generic copy Web Push sends (`push.notification.<category>` on the server),
 * because a notification can show on a locked screen and a row's own text
 * carries amounts and names. A `Record` over the union, so a new category fails
 * the type-check until it has copy.
 */
export const NATIVE_COPY_KEY: Readonly<Record<NotificationCategory, string>> = {
  PAYMENTS: 'payments',
  BUDGETS: 'budgets',
  SYSTEM: 'system',
  BALANCES: 'balances',
  INVESTMENTS: 'investments',
  STRATEGIES: 'strategies',
  BANK_SYNC: 'bank_sync',
  BANK_SYNC_ACTIVITY: 'bank_sync_activity',
  EMAIL_RECEIPTS: 'email_receipts',
  BONDS: 'bonds',
  AI_REVIEW: 'ai_review',
  WARRANTIES: 'warranties',
  SHARED_EXPENSES: 'shared_expenses',
};

/** For a row with no category (an older server) or one this page does not know. */
export const NATIVE_COPY_FALLBACK_KEY = 'fallback';

export function nativeCopyKey(category: NotificationCategory | undefined): string {
  return category !== undefined && Object.hasOwn(NATIVE_COPY_KEY, category)
    ? NATIVE_COPY_KEY[category]
    : NATIVE_COPY_FALLBACK_KEY;
}

/**
 * The rows the shell is handed: every unread row the bell shows (the list
 * endpoint already leaves dismissed rows out), with the generic copy for its
 * category and a target the page itself vouches for.
 *
 * Not filtered by the matrix's Push column: that switch governs Web Push, and
 * in the desktop window, which has no push device, it is not a live control,
 * so honouring it would obey a setting the reader cannot change there.
 */
export function shellNotificationRows(
  notifications: readonly Notification[],
  copy: (key: string) => { title: string; body: string },
): ShellNotificationRow[] {
  return notifications
    .filter((notification) => !notification.isRead)
    .map((notification) => ({
      id: notification.id,
      createdAt: notification.createdAt,
      ...copy(nativeCopyKey(notification.category)),
      target: safeNotificationTarget(notification.target),
    }));
}
