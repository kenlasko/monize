import { getLocalDateString } from './utils';

/**
 * Remembers the date a user last entered when creating a transaction, so the
 * next new-transaction form pre-fills the same date instead of resetting to
 * today. Useful when entering a batch of transactions dated in the past or
 * future. The value is held in sessionStorage and expires after one hour.
 *
 * Regular and investment transactions each keep their own remembered date
 * under a distinct key, so entering one kind doesn't change the default for the
 * other.
 */
export const LAST_TRANSACTION_DATE_KEY = 'monize-last-transaction-date';
export const LAST_INVESTMENT_TRANSACTION_DATE_KEY =
  'monize-last-investment-transaction-date';

// How long a remembered date stays valid before falling back to today.
const REMEMBER_DURATION_MS = 60 * 60 * 1000; // 1 hour

/**
 * Return the remembered transaction date for the given key if it was saved
 * within the last hour; otherwise today's local date. Expired or unparseable
 * entries are cleaned up as a side effect.
 */
export function getRememberedTransactionDate(key: string): string {
  if (typeof window === 'undefined') return getLocalDateString();
  const stored = sessionStorage.getItem(key);
  if (stored) {
    try {
      const { date, savedAt } = JSON.parse(stored);
      if (Date.now() - savedAt < REMEMBER_DURATION_MS) {
        return date;
      }
    } catch {
      // Legacy non-JSON value, ignore
    }
    sessionStorage.removeItem(key);
  }
  return getLocalDateString();
}

/**
 * Remember `date` under `key` so the next new-transaction form pre-fills it.
 * Call this only after successfully creating a transaction (not when editing).
 */
export function rememberTransactionDate(key: string, date: string): void {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem(key, JSON.stringify({ date, savedAt: Date.now() }));
}
