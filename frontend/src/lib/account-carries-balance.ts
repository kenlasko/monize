import { Account } from '@/types/account';

/**
 * Whether an account's balance still counts: the account is open, or it was
 * closed with money left in it.
 *
 * A non-zero balance does not stop a close, and what it leaves behind is still
 * the user's (an amount still owed on a closed card, cash left in a closed
 * account). The server's net worth keeps every account, so a surface that sums
 * balances keeps a closed account with a balance in scope too; a closed account
 * at zero adds nothing and stays out. The server twin is
 * `accountCarriesBalance` in `backend/src/accounts/account-carries-balance.ts`,
 * which compares the stored balance the same way.
 */
export function accountCarriesBalance(
  account: Pick<Account, 'isClosed' | 'currentBalance'>,
): boolean {
  return !account.isClosed || Number(account.currentBalance) !== 0;
}
