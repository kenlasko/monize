import { accountSelectOption, type AccountSelectOption } from '@/lib/account-utils';
import type { Account } from '@/types/account';
import type { SecurityHistoryAccount } from '@/types/investment';

/**
 * A security-history account as an account-picker option. The history names
 * an account by id and name only, so the mark comes from the full account row
 * when the page has loaded it; until then the option is a plain row.
 */
export function historyAccountOption(
  account: SecurityHistoryAccount,
  label: string,
  details: readonly Account[],
): AccountSelectOption {
  const full = details.find((candidate) => candidate.id === account.accountId);
  return full ? accountSelectOption(full, label) : { value: account.accountId, label };
}
