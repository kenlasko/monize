import type { Transaction } from '@/types/transaction';

/**
 * Whether a row's amount is the importer's estimate for the other account's
 * leg of a cross-currency transfer (`amount_is_provisional`). Read as
 * `=== true`: a payload without the field (an older server, a test fixture,
 * a write endpoint that returns a partial row) carries no information and is
 * drawn as an ordinary, confirmed amount.
 */
export function isProvisionalAmount(
  transaction: Pick<Transaction, 'amountIsProvisional'> | null | undefined,
): boolean {
  return transaction?.amountIsProvisional === true;
}

/**
 * How many provisional amounts a figure includes (`provisionalCount` on an
 * account, the accounts summary or a net worth month), read as a number. An
 * absent or unreadable field is no information and reads as `0`, so it draws
 * no mark; the figure itself is shown either way.
 */
export function provisionalCountOf(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/**
 * The provisional amounts inside a sum of account balances: the sum of each
 * account's own count. An account without the field adds nothing.
 */
export function sumProvisionalCounts(
  accounts: readonly { provisionalCount?: number | string | null }[],
): number {
  return accounts.reduce((sum, account) => sum + provisionalCountOf(account.provisionalCount), 0);
}
