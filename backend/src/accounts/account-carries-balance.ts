import type { Account } from "./entities/account.entity";

/**
 * Whether an account's balance still counts: the account is open, or it was
 * closed with money left in it.
 *
 * A non-zero balance does not stop a close, and the balance it leaves behind
 * is still the user's (an amount still owed on a closed card, cash left in a
 * closed account). Net worth already keeps every account through its monthly
 * snapshots, so a surface that sums or converts balances keeps a closed
 * account with a balance in scope too. A closed account at zero adds nothing,
 * so it stays out. `close()` refuses a future-dated row, so `current_balance`
 * is final once an account is closed (A26-M12).
 *
 * The frontend twin is `accountCarriesBalance` in
 * `frontend/src/lib/account-carries-balance.ts`.
 */
export function accountCarriesBalance(
  account: Pick<Account, "isClosed" | "currentBalance">,
): boolean {
  return !account.isClosed || Number(account.currentBalance) !== 0;
}

/**
 * The SQL spelling of `accountCarriesBalance`, over the `accounts` row named
 * by `alias` (no alias for an unqualified `FROM accounts`).
 */
export function accountCarriesBalanceSql(alias?: string): string {
  const col = (name: string) => (alias ? `${alias}.${name}` : name);
  return `(${col("is_closed")} = false OR ${col("current_balance")} <> 0)`;
}
