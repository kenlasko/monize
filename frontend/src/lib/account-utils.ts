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
export const formatAccountType = (type: AccountType, t?: (key: string) => string): string => {
  if (t) return t(`accountTypes.${type}`);
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
    HSA: 'HSA',
    FSA: 'FSA',
    DCFSA: 'DCFSA',
    '401K': '401(k)',
    '403B': '403(b)',
    TRADITIONAL_IRA: 'Traditional IRA',
    ROTH_IRA: 'Roth IRA',
    '529_PLAN': '529 Plan',
    HELOC: 'HELOC',
    PROPERTY: 'Property',
    VEHICLE: 'Vehicle',
    LIABILITY: 'Other Liability',
  };
  return labels[type] || type;
};

/** Character used to mask the hidden portion of an account number. */
const ACCOUNT_MASK_CHAR = '•'; // bullet (•)

/**
 * Mask an account number for display so only an identifying window stays
 * visible. Credit cards keep their first four and last four digits (the
 * standard PAN-truncation pattern, e.g. "4111 •••• •••• 1234"); every other
 * account type keeps only the last four. Separators such as spaces and dashes
 * are preserved for readability and are not counted toward the revealed
 * window. When the number is too short to reveal that window without exposing
 * all of it, every digit is masked.
 */
export function maskAccountNumber(value: string, isCreditCard: boolean): string {
  const chars = [...value.trim()];
  const isSignificant = (c: string) => /[a-z0-9]/i.test(c);
  const length = chars.filter(isSignificant).length;

  const lead = isCreditCard ? 4 : 0;
  const tail = 4;
  // Only reveal the lead/tail windows when at least one significant character
  // stays masked; otherwise the whole number would be exposed.
  const revealWindows = length > lead + tail;

  return chars
    .map((char, index) => {
      if (!isSignificant(char)) return char;
      // Position of this character among the significant (alphanumeric) ones.
      const order = chars.slice(0, index).filter(isSignificant).length;
      const visible = revealWindows && (order < lead || order >= length - tail);
      return visible ? char : ACCOUNT_MASK_CHAR;
    })
    .join('');
}

/** Check if an account is an investment brokerage sub-type. */
export const isInvestmentBrokerageAccount = (account: Account): boolean => {
  return account.accountSubType === 'INVESTMENT_BROKERAGE';
};

/**
 * Whether the account is the cash half of a linked investment pair. The cash
 * half is a sub-account of its brokerage partner, so callers that present a
 * pair as a single entity drop it in favour of the brokerage (main) account.
 */
export const isInvestmentCashHalf = (account: Account): boolean => {
  return (
    account.accountSubType === 'INVESTMENT_CASH' &&
    account.linkedAccountId !== null
  );
};

/** The main account name, with any " - Brokerage"/" - Cash" suffix stripped. */
export const getMainAccountName = (name: string): string => {
  return name.replace(/ - (Brokerage|Cash)$/, '');
};

/**
 * Count accounts treating a linked brokerage/cash investment pair as one
 * logical account. Both halves of the pair must appear in the input list
 * for the dedup to apply.
 */
export function countLogicalAccounts(accounts: Account[]): number {
  const ids = new Set(accounts.map((a) => a.id));
  const counted = new Set<string>();
  let count = 0;
  for (const account of accounts) {
    if (counted.has(account.id)) continue;
    counted.add(account.id);
    if (account.linkedAccountId && ids.has(account.linkedAccountId)) {
      counted.add(account.linkedAccountId);
    }
    count += 1;
  }
  return count;
}

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
  t?: (key: string, values?: Record<string, string>) => string,
): string {
  const allAccounts = () => (t ? t('accountFilter.allAccounts') : 'All Accounts');
  if (availableAccounts.length === 0 || selectedIds.length === 0) {
    return allAccounts();
  }

  const selectedSet = new Set(selectedIds);
  const selected = availableAccounts.filter((a) => selectedSet.has(a.id));

  if (selected.length === 0) {
    return allAccounts();
  }

  if (selected.length === availableAccounts.length) {
    return allAccounts();
  }

  if (selected.length > availableAccounts.length / 2) {
    const unselected = availableAccounts.filter((a) => !selectedSet.has(a.id));
    const names = unselected.map(getDisplayName).join(', ');
    return t ? t('accountFilter.allBut', { names }) : `All but ${names}`;
  }

  return selected.map(getDisplayName).join(', ');
}
