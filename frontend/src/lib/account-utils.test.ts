import { describe, it, expect, vi } from 'vitest';
import {
  buildAccountDropdownOptions,
  orderAccountsForPicker,
  orderForPicker,
  buildAccountFilterLabel,
  formatAccountType,
  isInvestmentBrokerageAccount,
  isInvestmentCashHalf,
  getMainAccountName,
  maskAccountNumber,
} from './account-utils';
import { Account } from '@/types/account';

function makeAccount(overrides: Partial<Account> & { id: string; name: string }): Account {
  return {
    userId: 'u1', accountType: 'CHEQUING', accountSubType: null,
    linkedAccountId: null, description: null, currencyCode: 'CAD',
    accountNumber: null, institution: null, institutionId: null, openingBalance: 0, currentBalance: 0,
    creditLimit: null, interestRate: null, isClosed: false, closedDate: null,
    isFavourite: false, favouriteSortOrder: 0, excludeFromNetWorth: false,
    statementDueDay: null, statementSettlementDay: null,
    paymentAmount: null, paymentFrequency: null, paymentStartDate: null,
    sourceAccountId: null, principalCategoryId: null, interestCategoryId: null, overpaymentCategoryId: null, overpaymentMemo: null, overpaymentPayeeId: null, fxFeePercent: null,
    scheduledTransactionId: null, assetCategoryId: null, dateAcquired: null, linkedLoanAccountId: null,
    mortgageType: 'ANNUITY',
    termMonths: null,
    termEndDate: null, amortizationMonths: null, originalPrincipal: null,
    createdAt: '', updatedAt: '',
    ...overrides,
  };
}

describe('orderAccountsForPicker', () => {
  const accounts = [
    makeAccount({ id: 'z', name: 'Zebra' }),
    makeAccount({ id: 'f2', name: 'Beta', isFavourite: true, favouriteSortOrder: 2 }),
    makeAccount({ id: 'a', name: 'Alpha' }),
    makeAccount({ id: 'f1', name: 'Yankee', isFavourite: true, favouriteSortOrder: 1 }),
  ];

  it('puts the starred accounts in the order the user arranged them', () => {
    // `favouriteSortOrder`, never the name: the user dragged them into that
    // order and every picker honours it.
    expect(orderAccountsForPicker(accounts).favourites.map((a) => a.name)).toEqual([
      'Yankee',
      'Beta',
    ]);
  });

  it('sorts everything else by name', () => {
    expect(orderAccountsForPicker(accounts).rest.map((a) => a.name)).toEqual([
      'Alpha',
      'Zebra',
    ]);
  });

  it('leaves the array it was handed alone', () => {
    // `Array.prototype.sort` reorders in place, and callers pass a list they
    // memoized for other consumers too.
    const input = [...accounts];
    orderAccountsForPicker(input);
    expect(input.map((a) => a.id)).toEqual(['z', 'f2', 'a', 'f1']);
  });

  it('falls back to alphabetical where the arrangement does not separate them', () => {
    // `favourite_sort_order` defaults to 0, so a user who starred three
    // accounts without ever dragging them into an order has three ties -- and a
    // stable sort leaves those in whatever order the API answered in, which
    // differs between surfaces reading the same list.
    const tied = [
      makeAccount({ id: 't1', name: 'Zephyr', isFavourite: true, favouriteSortOrder: 0 }),
      makeAccount({ id: 't2', name: 'Anchor', isFavourite: true, favouriteSortOrder: 0 }),
      makeAccount({ id: 't3', name: 'Mid', isFavourite: true, favouriteSortOrder: 0 }),
    ];
    expect(orderAccountsForPicker(tied).favourites.map((a) => a.name)).toEqual([
      'Anchor',
      'Mid',
      'Zephyr',
    ]);
  });

  it('keeps the arrangement ahead of the alphabet where it says something', () => {
    const arranged = [
      makeAccount({ id: 'a1', name: 'Anchor', isFavourite: true, favouriteSortOrder: 2 }),
      makeAccount({ id: 'a2', name: 'Zephyr', isFavourite: true, favouriteSortOrder: 1 }),
    ];
    expect(orderAccountsForPicker(arranged).favourites.map((a) => a.name)).toEqual([
      'Zephyr',
      'Anchor',
    ]);
  });

  it('returns two empty halves for no accounts', () => {
    expect(orderAccountsForPicker([])).toEqual({ favourites: [], rest: [] });
  });
});

describe('orderForPicker', () => {
  it('orders by the name the caller says the picker displays', () => {
    // The account switcher shows a linked pair under a stripped name, so the
    // stored name is not what a reader is scanning down.
    const entries = [
      { stored: 'Zephyr TFSA - Brokerage', shown: 'Anchor', fav: false },
      { stored: 'Anchor Loan', shown: 'Zephyr', fav: false },
    ];
    const ordered = orderForPicker(entries, (entry) => ({
      isFavourite: entry.fav,
      favouriteSortOrder: 0,
      name: entry.shown,
    }));
    expect(ordered.rest.map((entry) => entry.shown)).toEqual(['Anchor', 'Zephyr']);
  });

  it('reads each item once, however long the list', () => {
    // A comparator that called `read` would call it O(n log n) times, and it is
    // a caller's own function.
    const items = Array.from({ length: 20 }, (_, index) => ({ name: `Item ${index}` }));
    const read = vi.fn((item: { name: string }) => ({
      isFavourite: false,
      favouriteSortOrder: 0,
      name: item.name,
    }));
    orderForPicker(items, read);
    expect(read).toHaveBeenCalledTimes(items.length);
  });
});

describe('buildAccountDropdownOptions', () => {
  const accounts: Account[] = [
    makeAccount({ id: '1', name: 'Zebra Account', currencyCode: 'USD' }),
    makeAccount({ id: '2', name: 'Alpha Account', currencyCode: 'CAD' }),
    makeAccount({ id: '3', name: 'Middle Account', currencyCode: 'EUR' }),
  ];

  it('sorts non-favourite accounts alphabetically', () => {
    const options = buildAccountDropdownOptions(accounts, () => true);

    expect(options).toEqual([
      { value: '2', label: 'Alpha Account (CAD)' },
      { value: '3', label: 'Middle Account (EUR)' },
      { value: '1', label: 'Zebra Account (USD)' },
    ]);
  });

  it('places favourite accounts first sorted by favouriteSortOrder', () => {
    const withFavourites: Account[] = [
      makeAccount({ id: '1', name: 'Zebra Account', isFavourite: true, favouriteSortOrder: 2 }),
      makeAccount({ id: '2', name: 'Alpha Account', isFavourite: true, favouriteSortOrder: 0 }),
      makeAccount({ id: '3', name: 'Middle Account' }),
      makeAccount({ id: '4', name: 'Beta Account', isFavourite: true, favouriteSortOrder: 1 }),
    ];

    const options = buildAccountDropdownOptions(withFavourites, () => true);

    expect(options[0]).toEqual({ value: '2', label: 'Alpha Account (CAD)' });
    expect(options[1]).toEqual({ value: '4', label: 'Beta Account (CAD)' });
    expect(options[2]).toEqual({ value: '1', label: 'Zebra Account (CAD)' });
    // separator
    expect(options[3]).toEqual({
      value: '__separator__',
      label: expect.any(String),
      disabled: true,
    });
    // non-favourite
    expect(options[4]).toEqual({ value: '3', label: 'Middle Account (CAD)' });
  });

  it('inserts a disabled separator between favourites and non-favourites', () => {
    const withFavourites: Account[] = [
      makeAccount({ id: '1', name: 'Fav', isFavourite: true, favouriteSortOrder: 0 }),
      makeAccount({ id: '2', name: 'Normal' }),
    ];

    const options = buildAccountDropdownOptions(withFavourites, () => true);

    expect(options).toHaveLength(3);
    expect(options[1].value).toBe('__separator__');
    expect(options[1].disabled).toBe(true);
  });

  it('omits separator when all accounts are favourites', () => {
    const allFavourites: Account[] = [
      makeAccount({ id: '1', name: 'First', isFavourite: true, favouriteSortOrder: 1 }),
      makeAccount({ id: '2', name: 'Second', isFavourite: true, favouriteSortOrder: 0 }),
    ];

    const options = buildAccountDropdownOptions(allFavourites, () => true);

    expect(options).toHaveLength(2);
    expect(options.find(o => o.value === '__separator__')).toBeUndefined();
    expect(options[0].value).toBe('2');
    expect(options[1].value).toBe('1');
  });

  it('omits separator when no accounts are favourites', () => {
    const options = buildAccountDropdownOptions(accounts, () => true);

    expect(options).toHaveLength(3);
    expect(options.find(o => o.value === '__separator__')).toBeUndefined();
  });

  it('applies the filter predicate', () => {
    const mixed: Account[] = [
      makeAccount({ id: '1', name: 'Open', isClosed: false }),
      makeAccount({ id: '2', name: 'Closed', isClosed: true }),
      makeAccount({ id: '3', name: 'Also Open', isClosed: false }),
    ];

    const options = buildAccountDropdownOptions(mixed, (a) => !a.isClosed);

    expect(options).toHaveLength(2);
    expect(options.map(o => o.value)).toEqual(['3', '1']);
  });

  it('applies filter to both favourites and non-favourites', () => {
    const mixed: Account[] = [
      makeAccount({ id: '1', name: 'Open Fav', isFavourite: true, favouriteSortOrder: 0, isClosed: false }),
      makeAccount({ id: '2', name: 'Closed Fav', isFavourite: true, favouriteSortOrder: 1, isClosed: true }),
      makeAccount({ id: '3', name: 'Open Normal', isClosed: false }),
      makeAccount({ id: '4', name: 'Closed Normal', isClosed: true }),
    ];

    const options = buildAccountDropdownOptions(mixed, (a) => !a.isClosed);

    expect(options).toHaveLength(3); // 1 fav + separator + 1 normal
    expect(options[0].value).toBe('1');
    expect(options[1].value).toBe('__separator__');
    expect(options[2].value).toBe('3');
  });

  it('uses the default label function with currency and closed indicator', () => {
    const closedAccount = makeAccount({
      id: '1', name: 'Old Account', currencyCode: 'GBP', isClosed: true,
    });

    const options = buildAccountDropdownOptions([closedAccount], () => true);

    expect(options[0].label).toBe('Old Account (GBP) (Closed)');
  });

  it('uses a custom label function when provided', () => {
    const options = buildAccountDropdownOptions(
      accounts,
      () => true,
      (a) => `${a.name} -- ${a.currencyCode}`,
    );

    expect(options[0].label).toBe('Alpha Account -- CAD');
  });

  it('returns an empty array when all accounts are filtered out', () => {
    const options = buildAccountDropdownOptions(accounts, () => false);

    expect(options).toEqual([]);
  });

  it('returns an empty array for empty accounts list', () => {
    const options = buildAccountDropdownOptions([], () => true);

    expect(options).toEqual([]);
  });

  it('sorts non-favourite accounts alphabetically independent of favourite ordering', () => {
    const mixed: Account[] = [
      makeAccount({ id: '1', name: 'Charlie', isFavourite: true, favouriteSortOrder: 0 }),
      makeAccount({ id: '2', name: 'Zulu' }),
      makeAccount({ id: '3', name: 'Bravo' }),
      makeAccount({ id: '4', name: 'Alpha' }),
    ];

    const options = buildAccountDropdownOptions(mixed, () => true);

    // Favourite first
    expect(options[0].value).toBe('1');
    // Separator
    expect(options[1].value).toBe('__separator__');
    // Rest alphabetically
    expect(options[2].label).toContain('Alpha');
    expect(options[3].label).toContain('Bravo');
    expect(options[4].label).toContain('Zulu');
  });
});

describe('formatAccountType', () => {
  it('returns human-readable label for known types', () => {
    expect(formatAccountType('CREDIT_CARD')).toBe('Credit Card');
    expect(formatAccountType('LINE_OF_CREDIT')).toBe('Line of Credit');
    expect(formatAccountType('CHEQUING')).toBe('Chequing');
  });

  it('returns the raw type string for unknown types', () => {
    expect(formatAccountType('UNKNOWN' as any)).toBe('UNKNOWN');
  });
});

describe('isInvestmentBrokerageAccount', () => {
  it('returns true for INVESTMENT_BROKERAGE subtype', () => {
    const account = makeAccount({ id: '1', name: 'Brokerage', accountSubType: 'INVESTMENT_BROKERAGE' });
    expect(isInvestmentBrokerageAccount(account)).toBe(true);
  });

  it('returns false for other subtypes', () => {
    const account = makeAccount({ id: '1', name: 'Cash', accountSubType: 'INVESTMENT_CASH' });
    expect(isInvestmentBrokerageAccount(account)).toBe(false);
  });

  it('returns false for null subtype', () => {
    const account = makeAccount({ id: '1', name: 'Regular' });
    expect(isInvestmentBrokerageAccount(account)).toBe(false);
  });
});

describe('buildAccountFilterLabel', () => {
  const accounts = [
    { id: '1', name: 'Alpha' },
    { id: '2', name: 'Beta' },
    { id: '3', name: 'Gamma' },
    { id: '4', name: 'Delta' },
  ];

  it('returns "All Accounts" when no selection is applied', () => {
    expect(buildAccountFilterLabel([], accounts)).toBe('All Accounts');
  });

  it('returns "All Accounts" when every account is selected', () => {
    expect(
      buildAccountFilterLabel(['1', '2', '3', '4'], accounts),
    ).toBe('All Accounts');
  });

  it('returns "All Accounts" when the available account list is empty', () => {
    expect(buildAccountFilterLabel(['1'], [])).toBe('All Accounts');
  });

  it('lists selected names when half or fewer are selected', () => {
    expect(buildAccountFilterLabel(['1', '2'], accounts)).toBe('Alpha, Beta');
  });

  it('lists a single selected name', () => {
    expect(buildAccountFilterLabel(['3'], accounts)).toBe('Gamma');
  });

  it('inverts to "All but ..." when more than half are selected', () => {
    expect(
      buildAccountFilterLabel(['1', '2', '3'], accounts),
    ).toBe('All but Delta');
  });

  it('inverts to "All but ..." with multiple unselected names', () => {
    const five = [...accounts, { id: '5', name: 'Epsilon' }];
    // 3 of 5 is more than half (3 > 2.5), so invert.
    expect(buildAccountFilterLabel(['1', '2', '3'], five)).toBe(
      'All but Delta, Epsilon',
    );
  });

  it('uses the display-name override when provided', () => {
    const brokerages = [
      { id: '1', name: 'TFSA - Brokerage' },
      { id: '2', name: 'RRSP - Brokerage' },
    ];
    const result = buildAccountFilterLabel(['1'], brokerages, (a) =>
      a.name.replace(' - Brokerage', ''),
    );
    expect(result).toBe('TFSA');
  });

  it('ignores selections for accounts not in the available list', () => {
    expect(buildAccountFilterLabel(['99'], accounts)).toBe('All Accounts');
  });
});

describe('isInvestmentCashHalf', () => {
  it('returns true for the cash half of a linked pair', () => {
    const cash = makeAccount({
      id: 'c1', name: 'TFSA - Cash',
      accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_CASH',
      linkedAccountId: 'b1',
    });
    expect(isInvestmentCashHalf(cash)).toBe(true);
  });

  it('returns false for the brokerage half', () => {
    const brokerage = makeAccount({
      id: 'b1', name: 'TFSA - Brokerage',
      accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE',
      linkedAccountId: 'c1',
    });
    expect(isInvestmentCashHalf(brokerage)).toBe(false);
  });

  it('returns false for a cash account with no linked partner', () => {
    const cash = makeAccount({
      id: 'c2', name: 'Standalone',
      accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_CASH',
      linkedAccountId: null,
    });
    expect(isInvestmentCashHalf(cash)).toBe(false);
  });

  it('returns false for a plain account', () => {
    expect(isInvestmentCashHalf(makeAccount({ id: 'p', name: 'Chequing' }))).toBe(
      false,
    );
  });
});

describe('getMainAccountName', () => {
  it('strips a trailing " - Brokerage" suffix', () => {
    expect(getMainAccountName('TFSA - Brokerage')).toBe('TFSA');
  });

  it('strips a trailing " - Cash" suffix', () => {
    expect(getMainAccountName('TFSA - Cash')).toBe('TFSA');
  });

  it('leaves a plain account name untouched', () => {
    expect(getMainAccountName('Chequing')).toBe('Chequing');
  });

  it('only strips the suffix at the end of the name', () => {
    expect(getMainAccountName('Cash - Reserve')).toBe('Cash - Reserve');
  });

  it('strips a localized suffix when supplied', () => {
    expect(getMainAccountName('TFSA - Bargeld', ['Maklerkonto', 'Bargeld'])).toBe(
      'TFSA',
    );
  });

  it('still strips the English suffix even when localized words are supplied', () => {
    expect(getMainAccountName('TFSA - Cash', ['Maklerkonto', 'Bargeld'])).toBe(
      'TFSA',
    );
  });

  it('escapes regex metacharacters in localized suffixes', () => {
    expect(getMainAccountName('TFSA - (Cash)', ['(Cash)'])).toBe('TFSA');
  });
});

describe('maskAccountNumber', () => {
  it('keeps the first and last four digits of a credit-card number', () => {
    expect(maskAccountNumber('4111111111111234', true)).toBe('4111••••••••1234');
  });

  it('keeps only the last four digits of a non-credit-card number', () => {
    expect(maskAccountNumber('12345678', false)).toBe('••••5678');
  });

  it('preserves separators while masking the digits between the windows', () => {
    expect(maskAccountNumber('4111 1111 1111 1234', true)).toBe('4111 •••• •••• 1234');
    expect(maskAccountNumber('1234-5678-9012', false)).toBe('••••-••••-9012');
  });

  it('masks every digit when the number is too short to reveal a window', () => {
    // Non-credit-card: revealing the last four would expose all four.
    expect(maskAccountNumber('1234', false)).toBe('••••');
    // Credit-card: revealing first and last four would expose all eight.
    expect(maskAccountNumber('12345678', true)).toBe('••••••••');
  });

  it('ignores surrounding whitespace', () => {
    expect(maskAccountNumber('  987654321  ', false)).toBe('•••••4321');
  });

  it('returns an empty string for an empty value', () => {
    expect(maskAccountNumber('', false)).toBe('');
  });
});
