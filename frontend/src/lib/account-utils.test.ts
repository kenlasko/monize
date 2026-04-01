import { describe, it, expect } from 'vitest';
import { buildAccountDropdownOptions, formatAccountType, isInvestmentBrokerageAccount } from './account-utils';
import { Account } from '@/types/account';

function makeAccount(overrides: Partial<Account> & { id: string; name: string }): Account {
  return {
    userId: 'u1', accountType: 'CHEQUING', accountSubType: null,
    linkedAccountId: null, description: null, currencyCode: 'CAD',
    accountNumber: null, institution: null, openingBalance: 0, currentBalance: 0,
    creditLimit: null, interestRate: null, isClosed: false, closedDate: null,
    isFavourite: false, favouriteSortOrder: 0, excludeFromNetWorth: false,
    statementDueDay: null, statementSettlementDay: null,
    paymentAmount: null, paymentFrequency: null, paymentStartDate: null,
    sourceAccountId: null, principalCategoryId: null, interestCategoryId: null,
    scheduledTransactionId: null, assetCategoryId: null, dateAcquired: null,
    isCanadianMortgage: false, isVariableRate: false, termMonths: null,
    termEndDate: null, amortizationMonths: null, originalPrincipal: null,
    createdAt: '', updatedAt: '',
    ...overrides,
  };
}

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
