import { Account, AccountType } from '@/types/account';

export interface AccountSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** What ordering a picker's entries needs to know about each one. */
export interface PickerOrderFields {
  isFavourite: boolean;
  /** The user's own arrangement of their favourites; 0 until they arrange one. */
  favouriteSortOrder: number;
  /**
   * The name the picker DISPLAYS, which is not always the stored one -- the
   * account switcher shows a linked brokerage/cash pair under one name with the
   * " - Brokerage" suffix stripped, and sorting that list on the stored name
   * would read as unsorted.
   */
  name: string;
}

/**
 * The order every account picker offers its entries in: the user's favourites
 * first, in the order they arranged them, then everything else alphabetically.
 *
 * **Alphabetically within the favourites too, where the arrangement does not
 * separate them.** `favourite_sort_order` defaults to 0, so a user who has
 * starred three accounts without ever dragging them into an order has three
 * ties -- and a stable sort leaves those in whatever order the API answered in,
 * which is arbitrary and differs between surfaces. The drag-to-arrange list
 * writes real indices, so the tiebreak never fires once anybody has used it.
 *
 * The two halves are returned separately rather than concatenated, because
 * every caller needs the boundary as well as the order -- a `<select>` draws a
 * separator rule across it, a switcher menu puts a section heading above each
 * side. Handing back one flat list would have each of them re-deriving where
 * favourites stop, which is the copy that drifts.
 *
 * Sorting happens on copies: `Array.prototype.sort` reorders in place, and the
 * array reaching here is usually one a caller memoized for other consumers too.
 */
export function orderForPicker<T>(
  items: readonly T[],
  read: (item: T) => PickerOrderFields,
): { favourites: T[]; rest: T[] } {
  // Read once per item rather than twice per comparison: `read` is a caller's
  // own function and a comparator calls it O(n log n) times.
  const decorated = items.map((item) => ({ item, fields: read(item) }));
  const byName = (
    a: { fields: PickerOrderFields },
    b: { fields: PickerOrderFields },
  ) => a.fields.name.localeCompare(b.fields.name);

  return {
    favourites: decorated
      .filter((entry) => entry.fields.isFavourite)
      .sort(
        (a, b) =>
          a.fields.favouriteSortOrder - b.fields.favouriteSortOrder ||
          byName(a, b),
      )
      .map((entry) => entry.item),
    rest: decorated
      .filter((entry) => !entry.fields.isFavourite)
      .sort(byName)
      .map((entry) => entry.item),
  };
}

/** {@link orderForPicker} over plain accounts, which name themselves. */
export function orderAccountsForPicker(accounts: readonly Account[]): {
  favourites: Account[];
  rest: Account[];
} {
  return orderForPicker(accounts, (account) => ({
    isFavourite: account.isFavourite,
    favouriteSortOrder: account.favouriteSortOrder,
    name: account.name,
  }));
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
  const { favourites, rest } = orderAccountsForPicker(accounts.filter(filter));

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
    CRYPTO: 'Crypto Wallet',
    OTHER: 'Other',
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

/**
 * The main account name, with any " - Brokerage"/" - Cash" suffix stripped.
 *
 * Investment pair names are generated server-side with a localized suffix, so
 * callers should pass the user's translated "Brokerage"/"Cash" words via
 * `localizedSuffixes` to strip them too. The English words are always stripped
 * as well so accounts created before localization (or in English) still match.
 */
export const getMainAccountName = (
  name: string,
  localizedSuffixes: string[] = [],
): string => {
  const suffixes = [...new Set(['Brokerage', 'Cash', ...localizedSuffixes])]
    .filter(Boolean)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return name.replace(new RegExp(` - (${suffixes.join('|')})$`), '');
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
