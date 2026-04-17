import { Account, AccountType } from '@/types/account';

export interface AccountSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * Build account dropdown options with favourite accounts listed first
 * (sorted by user-defined order), a visual separator, then remaining
 * accounts sorted alphabetically.
 */
export function buildAccountDropdownOptions(
  accounts: Account[],
  filter: (account: Account) => boolean,
  labelFn: (account: Account) => string = (a) =>
    `${a.name} (${a.currencyCode})${a.isClosed ? ' (Closed)' : ''}`,
): AccountSelectOption[] {
  const filtered = accounts.filter(filter);

  const favourites = filtered
    .filter((a) => a.isFavourite)
    .sort((a, b) => a.favouriteSortOrder - b.favouriteSortOrder);

  const rest = filtered
    .filter((a) => !a.isFavourite)
    .sort((a, b) => a.name.localeCompare(b.name));

  const options: AccountSelectOption[] = [];

  for (const account of favourites) {
    options.push({ value: account.id, label: labelFn(account) });
  }

  if (favourites.length > 0 && rest.length > 0) {
    options.push({
      value: '__separator__',
      label: '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
      disabled: true,
    });
  }

  for (const account of rest) {
    options.push({ value: account.id, label: labelFn(account) });
  }

  return options;
}

/** Format an account type enum to a human-readable label. */
export const formatAccountType = (type: AccountType): string => {
  const labels: Record<AccountType, string> = {
    CHEQUING: 'Chequing',
    SAVINGS: 'Savings',
    CREDIT_CARD: 'Credit Card',
    INVESTMENT: 'Investment',
    LOAN: 'Loan',
    MORTGAGE: 'Mortgage',
    CASH: 'Cash',
    LINE_OF_CREDIT: 'Line of Credit',
    ASSET: 'Asset',
    OTHER: 'Other',
  };
  return labels[type] || type;
};

/** Check if an account is an investment brokerage sub-type. */
export const isInvestmentBrokerageAccount = (account: Account): boolean => {
  return account.accountSubType === 'INVESTMENT_BROKERAGE';
};

/**
 * Build a human-readable label describing which accounts are currently in
 * a filter, for use in section headers.
 *
 * - No selection (or empty): "All Accounts"
 * - Selection covers more than half of the available accounts: "All but X, Y"
 *   (names are the accounts that are NOT selected)
 * - Otherwise: "X, Y" (names are the accounts that ARE selected)
 */
export function buildAccountFilterLabel(
  selectedIds: string[],
  availableAccounts: { id: string; name: string }[],
  getDisplayName: (account: { id: string; name: string }) => string = (a) => a.name,
): string {
  if (availableAccounts.length === 0 || selectedIds.length === 0) {
    return 'All Accounts';
  }

  const selectedSet = new Set(selectedIds);
  const selected = availableAccounts.filter((a) => selectedSet.has(a.id));

  if (selected.length === 0) {
    return 'All Accounts';
  }

  if (selected.length === availableAccounts.length) {
    return 'All Accounts';
  }

  if (selected.length > availableAccounts.length / 2) {
    const unselected = availableAccounts.filter((a) => !selectedSet.has(a.id));
    return `All but ${unselected.map(getDisplayName).join(', ')}`;
  }

  return selected.map(getDisplayName).join(', ');
}
