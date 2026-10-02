/**
 * Helpers for the link dialog's use of the server's start-date default
 * (`GET /bank-sync/accounts/:id/link-defaults`). The default itself is the
 * server's: nothing here recomputes it.
 */

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whole calendar days from `from` to `to` (both `YYYY-MM-DD`), or null when either is not a date. */
export function daysBetweenYmd(from: string, to: string): number | null {
  const a = YMD.exec(from);
  const b = YMD.exec(to);
  if (!a || !b) return null;
  // Read from the digits through UTC, so no timezone or DST shift moves a day.
  const start = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const end = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  return Math.round((end - start) / 86_400_000);
}

/**
 * Whether importing from `chosen` may duplicate transactions the account
 * already holds: the date is on or before the account's newest transaction.
 * An empty date is the server's default, which starts after it; an account with
 * no transactions, or a lookup that failed (`undefined`), has nothing to warn
 * about, and the dialog says so separately.
 */
export function mayDuplicate(chosen: string, newestTransactionDate: string | null | undefined): boolean {
  if (!newestTransactionDate || chosen === '') return false;
  return chosen <= newestTransactionDate;
}
