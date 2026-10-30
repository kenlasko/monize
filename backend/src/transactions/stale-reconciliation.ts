import { TransactionStatus } from "./entities/transaction.entity";

/**
 * What makes an unreconciled transaction *overdue*.
 *
 * A scheduled bill is overdue when its due date has passed. A transaction has
 * no due date, so "overdue" has to be defined against the reconciliation the
 * user actually performs -- and only for the accounts they reconcile at all.
 * An account nobody has ever reconciled has no stale rows, however old: the
 * user has not opted into reconciliation there, and telling them a two-year-old
 * coffee is outstanding would make the reminder worthless everywhere else.
 *
 * For an account with at least one RECONCILED row there are two ways a
 * non-reconciled, non-void register row is overdue, and they are reported as
 * distinct reasons because they call for different actions:
 *
 * - `missed` -- the row is dated on or before the account's most recent
 *   reconciled date (`RECONCILED_THROUGH_SQL`). The statement covering it has
 *   already been reconciled and this row was left out of it, so the reconciled
 *   balance and the bank's disagree by its amount. This is the exact analogue
 *   of an overdue bill and needs no threshold to state.
 * - `overdue` -- the row is newer than that, but older than
 *   `STALE_UNRECONCILED_DAYS`. Nothing is provably wrong yet; the user has
 *   simply not reconciled the period it belongs to. This is the case that
 *   catches an account whose reconciliation has quietly stopped, which `missed`
 *   alone never can -- every row after the last reconciled date looks like it
 *   belongs to the statement still to come.
 *
 * The two are disjoint by construction: `missed` is decided first, so a row is
 * counted once and the counts sum to the total.
 */

/**
 * How long a register row may sit unreconciled, past the account's last
 * reconciled date, before it is called overdue.
 *
 * One monthly statement cycle plus a fortnight of slack: a statement dated the
 * 1st is typically reconciled within a week or two of arriving, so 45 days is
 * comfortably past "the user is getting to it" without waiting for a second
 * cycle to go by. It is a judgement, not a derivation, which is why it lives
 * here as one exported constant rather than as a literal in a query -- the
 * frontend highlight and the reminder count have to agree about it, and the
 * response carries the number so the client never restates it.
 */
export const STALE_UNRECONCILED_DAYS = 45;

/**
 * The date one RECONCILED row says the account is reconciled through: its own
 * transaction date, but never later than the statement it was reconciled on.
 *
 * The reconcile screen lists rows dated after the statement date, so a row
 * dated the 20th can be reconciled on a statement dated the 15th. Its own date
 * would claim the 16th to the 20th were covered and call every outstanding row
 * in that span `missed`; the statement date is what was actually covered. A row
 * with no `reconciled_date` (imported reconciled) falls back to its own date,
 * and one marked RECONCILED from the register (stamped with that day) is
 * dated by its transaction date as before.
 *
 * The MAX of this per account is the `lastReconciledDate` the classifier takes.
 * Columns are unqualified: the callers select from `transactions` unaliased.
 */
export const RECONCILED_THROUGH_SQL =
  "LEAST(transaction_date, COALESCE(reconciled_date, transaction_date))";

/** Why one account's rows are being reported. */
export type StaleUnreconciledReason = "missed" | "overdue";

/** One account with outstanding rows, as reported to the client. */
export interface StaleUnreconciledAccount {
  accountId: string;
  accountName: string;
  currencyCode: string;
  /** Rows counted, `missedCount + overdueCount`. */
  count: number;
  /** Oldest outstanding row's date, YYYY-MM-DD. */
  oldestDate: string;
  /** The account's most recent reconciled date, YYYY-MM-DD. Never null here. */
  lastReconciledDate: string;
  missedCount: number;
  overdueCount: number;
}

export interface StaleUnreconciledSummary {
  /** The window the `overdue` half was computed with, so the client can say it. */
  staleAfterDays: number;
  /** The date rows had to precede to count as `overdue`, YYYY-MM-DD. */
  overdueBefore: string;
  accounts: StaleUnreconciledAccount[];
  /** Total outstanding rows across every account. */
  totalCount: number;
}

/**
 * The date an `overdue` row must fall before: `today` minus the window.
 *
 * Takes today as a YYYY-MM-DD string rather than reading the clock, so the
 * caller decides whose "today" it is and the function is a pure date
 * calculation the tests can pin. Built in UTC deliberately -- both inputs and
 * the output are calendar dates with no time of day, and constructing them in
 * local time would move the boundary by a day either side of midnight.
 */
export function staleCutoffDate(
  todayYmd: string,
  staleAfterDays: number = STALE_UNRECONCILED_DAYS,
): string {
  const [year, month, day] = todayYmd.split("-").map(Number);
  const cutoff = new Date(Date.UTC(year, month - 1, day));
  cutoff.setUTCDate(cutoff.getUTCDate() - staleAfterDays);
  return cutoff.toISOString().slice(0, 10);
}

/**
 * Statuses that can be outstanding at all: a RECONCILED row is done and a VOID
 * row records something that did not happen. Mirrors the `status <> ...` pair
 * in the query, and its twin in `frontend/src/lib/stale-reconciliation.ts`.
 */
function isOutstanding(status: string | null): boolean {
  return (
    status !== TransactionStatus.RECONCILED && status !== TransactionStatus.VOID
  );
}

/**
 * Classify one row, given its account's last reconciled date and the cutoff.
 *
 * `lastReconciledDate` null means the account has never been reconciled, so
 * nothing in it is overdue: reconciliation is opt-in per account.
 *
 * Returns null when the row is not stale. `missed` wins over `overdue` so the
 * two counts stay disjoint; a row can satisfy both predicates and must be
 * counted once.
 */
export function classifyStaleRow(
  status: string | null,
  transactionDate: string,
  lastReconciledDate: string | null,
  overdueBefore: string,
): StaleUnreconciledReason | null {
  if (!isOutstanding(status)) return null;
  if (!lastReconciledDate) return null;
  if (transactionDate <= lastReconciledDate) return "missed";
  if (transactionDate < overdueBefore) return "overdue";
  return null;
}
