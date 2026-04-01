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
