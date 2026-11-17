import { describe, it, expect } from 'vitest';
import {
  buildLogicalAccounts,
  toLogicalAccountPortfolio,
  holdingsValuationIncomplete,
  formatAccountOptionLabel,
  cashBalanceOf,
  securitiesValueOf,
  LogicalAccountPortfolio,
} from './logical-accounts';
import { countLogicalAccounts } from './account-utils';
import { Account, AccountSubType, AccountType } from '@/types/account';

const strip = (name: string) => name.replace(/ - (Brokerage|Cash)$/, '');

function account(
  id: string,
  over: Partial<Account> & { name?: string } = {},
): Account {
  return {
    id,
    name: id,
    accountType: 'CHEQUING' as AccountType,
    accountSubType: null as AccountSubType,
    linkedAccountId: null,
    currencyCode: 'CAD',
    currentBalance: 0,
    openingBalance: 0,
    isClosed: false,
    ...over,
  } as Account;
}

/** A linked brokerage/cash pair, brokerage first. */
function pair(base: string, over: { cash?: Partial<Account> } = {}) {
  const brokerageId = `${base}-brok`;
  const cashId = `${base}-cash`;
  return [
    account(brokerageId, {
      name: `${base} - Brokerage`,
      accountType: 'INVESTMENT',
      accountSubType: 'INVESTMENT_BROKERAGE',
      linkedAccountId: cashId,
    }),
    account(cashId, {
      name: `${base} - Cash`,
      accountType: 'INVESTMENT',
      accountSubType: 'INVESTMENT_CASH',
      linkedAccountId: brokerageId,
      ...over.cash,
    }),
  ];
}

const portfolio = (
  marketValues: Record<string, number>,
  unpriced: Record<string, number> = {},
  incomplete: string[] = [],
): LogicalAccountPortfolio => ({
  marketValues: new Map(Object.entries(marketValues)),
  unpricedCounts: new Map(Object.entries(unpriced)),
  incompleteAccountIds: new Set(incomplete),
});

describe('buildLogicalAccounts', () => {
  describe('the fold', () => {
    it('folds a pair into one entry keyed on the brokerage half', () => {
      const [brokerage, cash] = pair('TFSA');

      const result = buildLogicalAccounts([brokerage, cash], strip);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('TFSA-brok');
      expect(result[0].primary.id).toBe('TFSA-brok');
      expect(result[0].cash?.id).toBe('TFSA-cash');
      expect(result[0].memberIds).toEqual(['TFSA-brok', 'TFSA-cash']);
      expect(result[0].displayName).toBe('TFSA');
      expect(result[0].cashRegisterId).toBe('TFSA-cash');
      expect(result[0].holdingsAccountId).toBe('TFSA-brok');
    });

    it('folds a pair listed cash-half first', () => {
      const [brokerage, cash] = pair('TFSA');

      const result = buildLogicalAccounts([cash, brokerage], strip);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('TFSA-brok');
      expect(result[0].cash?.id).toBe('TFSA-cash');
    });

    it('keeps the input order, and leaves non-investment accounts alone', () => {
      const chequing = account('chq', { name: 'Chequing' });
      const [brokerage, cash] = pair('TFSA');
      const savings = account('sav', { name: 'Savings' });

      const result = buildLogicalAccounts(
        [chequing, brokerage, cash, savings],
        strip,
      );

      expect(result.map((r) => r.id)).toEqual(['chq', 'TFSA-brok', 'sav']);
      expect(result[0].isInvestment).toBe(false);
      expect(result[0].cashRegisterId).toBe('chq');
      expect(result[0].holdingsAccountId).toBeNull();
    });

    it('leaves a cash half standing alone when its partner is not in the list', () => {
      // A filtered list must still represent everything passed to it -- dropping
      // the cash half here would hide the account entirely.
      const [, cash] = pair('TFSA');

      const result = buildLogicalAccounts([cash], strip);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('TFSA-cash');
      expect(result[0].cash).toBeNull();
      expect(result[0].displayName).toBe('TFSA');
    });
  });

  describe('the shapes without a pair', () => {
    it('treats a standalone investment account as its own cash and holdings ledger', () => {
      const standalone = account('solo', {
        name: 'Self-directed',
        accountType: 'INVESTMENT',
      });

      const [result] = buildLogicalAccounts([standalone], strip);

      expect(result.cash).toBeNull();
      expect(result.memberIds).toEqual(['solo']);
      expect(result.cashRegisterId).toBe('solo');
      expect(result.holdingsAccountId).toBe('solo');
    });

    // A row marked INVESTMENT_BROKERAGE holds securities whatever else it
    // claims; only a standalone account, with no sub-type to go on, needs its
    // type read.
    it('identifies a brokerage by its sub-type alone', () => {
      const brokerage = account('brok', {
        accountType: 'CHEQUING',
        accountSubType: 'INVESTMENT_BROKERAGE',
      });

      const [result] = buildLogicalAccounts([brokerage], strip);

      expect(result.holdingsAccountId).toBe('brok');
    });

    it('gives an orphan brokerage holdings but no cash ledger to post to', () => {
      const orphan = account('orphan-brok', {
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_BROKERAGE',
        linkedAccountId: null,
      });

      const [result] = buildLogicalAccounts([orphan], strip);

      expect(result.holdingsAccountId).toBe('orphan-brok');
      expect(result.cashRegisterId).toBeNull();
    });

    it('treats an orphan cash half as an ordinary account with its suffix stripped', () => {
      const orphan = account('orphan-cash', {
        name: 'RRSP - Cash',
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_CASH',
        linkedAccountId: null,
      });

      const [result] = buildLogicalAccounts([orphan], strip);

      expect(result.displayName).toBe('RRSP');
      expect(result.cashRegisterId).toBe('orphan-cash');
      expect(result.holdingsAccountId).toBeNull();
    });
  });

  describe('combinedValue', () => {
    // valuationComplete covers a missing exchange rate with every price present,
    // which unpricedHoldingsCount (a count of prices) cannot see.
    it('is unknown when valuationComplete is false, though every holding is priced', () => {
      const [brokerage, cash] = pair('TFSA', {
        cash: { currentBalance: 3500 },
      });

      const [result] = buildLogicalAccounts(
        [brokerage, cash],
        strip,
        portfolio({ 'TFSA-brok': 9000 }, { 'TFSA-brok': 0 }, ['TFSA-brok']),
      );

      expect(result.combinedValue).toBeNull();
    });

    it('stays known for a complete account beside an incomplete one', () => {
      const [b1, c1] = pair('A', { cash: { currentBalance: 10 } });
      const [b2, c2] = pair('B', { cash: { currentBalance: 20 } });

      const [a, b] = buildLogicalAccounts(
        [b1, c1, b2, c2],
        strip,
        portfolio({ 'A-brok': 100, 'B-brok': 200 }, {}, ['B-brok']),
      );

      expect(a.combinedValue).toBe(110);
      expect(b.combinedValue).toBeNull();
    });

    it('adds market value to the cash half balance for a pair', () => {
      const [brokerage, cash] = pair('TFSA', {
        cash: { currentBalance: 3500 },
      });

      const [result] = buildLogicalAccounts(
        [brokerage, cash],
        strip,
        portfolio({ 'TFSA-brok': 12000 }),
      );

      expect(result.combinedValue).toBe(15500);
    });

    it('includes the cash half future-dated transactions, as the account rows do', () => {
      const [brokerage, cash] = pair('TFSA', {
        cash: { currentBalance: 3500, futureTransactionsSum: 100 },
      });

      const [result] = buildLogicalAccounts(
        [brokerage, cash],
        strip,
        portfolio({ 'TFSA-brok': 12000 }),
      );

      expect(result.combinedValue).toBe(15600);
    });

    // The defect this whole field exists to prevent: showing the cash the app
    // does know as though it were the account's worth.
    it('is unknown, not the cash subtotal, when a holding has no price', () => {
      const [brokerage, cash] = pair('TFSA', {
        cash: { currentBalance: 3500 },
      });

      const [result] = buildLogicalAccounts(
        [brokerage, cash],
        strip,
        portfolio({ 'TFSA-brok': 9000 }, { 'TFSA-brok': 2 }),
      );

      expect(result.combinedValue).toBeNull();
    });

    it('is unknown when the portfolio has not loaded at all', () => {
      const [brokerage, cash] = pair('TFSA', {
        cash: { currentBalance: 3500 },
      });

      const [result] = buildLogicalAccounts([brokerage, cash], strip);

      expect(result.combinedValue).toBeNull();
    });

    it('is unknown when the portfolio loaded without reporting this account', () => {
      const [brokerage, cash] = pair('TFSA', {
        cash: { currentBalance: 3500 },
      });

      const [result] = buildLogicalAccounts(
        [brokerage, cash],
        strip,
        portfolio({ 'other-brok': 5 }),
      );

      expect(result.combinedValue).toBeNull();
    });

    // "Nothing to price" is a settled answer; only "could not price" is unknown.
    it('is the cash balance for an account holding nothing', () => {
      const [brokerage, cash] = pair('TFSA', {
        cash: { currentBalance: 3500 },
      });

      const [result] = buildLogicalAccounts(
        [brokerage, cash],
        strip,
        portfolio({ 'TFSA-brok': 0 }, { 'TFSA-brok': 0 }),
      );

      expect(result.combinedValue).toBe(3500);
    });

    // The portfolio summary covers open accounts only, so a closed one is
    // absent by design. Reading that absence as unknown would put an em-dash
    // on every closed investment account.
    it('is the cash balance for a closed account the portfolio does not cover', () => {
      const [brokerage, cash] = pair('TFSA', {
        cash: { currentBalance: 0, isClosed: true },
      });

      const [result] = buildLogicalAccounts(
        [{ ...brokerage, isClosed: true }, cash],
        strip,
        portfolio({ 'other-brok': 5 }),
      );

      expect(result.combinedValue).toBe(0);
    });

    it('adds a standalone account own balance to its market value', () => {
      const standalone = account('solo', {
        accountType: 'INVESTMENT',
        currentBalance: 250,
      });

      const [result] = buildLogicalAccounts(
        [standalone],
        strip,
        portfolio({ solo: 1000 }),
      );

      expect(result.combinedValue).toBe(1250);
    });

    it('values an orphan brokerage on its holdings alone', () => {
      const orphan = account('orphan-brok', {
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_BROKERAGE',
        currentBalance: 0,
      });

      const [result] = buildLogicalAccounts(
        [orphan],
        strip,
        portfolio({ 'orphan-brok': 800 }),
      );

      expect(result.combinedValue).toBe(800);
    });

    it('uses the account own balance for a non-investment account, portfolio or not', () => {
      const chequing = account('chq', {
        currentBalance: 40,
        futureTransactionsSum: 2,
      });

      const [result] = buildLogicalAccounts([chequing], strip);

      expect(result.combinedValue).toBe(42);
    });
  });

  // The fold and the long-standing counter must not drift: both answer "how
  // many accounts does the user have", and a surface reading one beside a
  // surface reading the other is how a list of 4 comes to say it has 3.
  describe('parity with countLogicalAccounts', () => {
    const [tfsaBrok, tfsaCash] = pair('TFSA');
    const [rrspBrok, rrspCash] = pair('RRSP');
    const cases: [string, Account[]][] = [
      ['empty', []],
      ['one pair', [tfsaBrok, tfsaCash]],
      ['pair listed cash first', [tfsaCash, tfsaBrok]],
      ['two pairs', [tfsaBrok, tfsaCash, rrspBrok, rrspCash]],
      ['a lone cash half', [tfsaCash]],
      ['a lone brokerage half', [tfsaBrok]],
      [
        'a pair beside ordinary accounts',
        [account('chq'), tfsaBrok, tfsaCash, account('sav')],
      ],
      [
        'a standalone investment account',
        [account('solo', { accountType: 'INVESTMENT' })],
      ],
    ];

    it.each(cases)('agrees on %s', (_label, accounts) => {
      expect(buildLogicalAccounts(accounts, strip)).toHaveLength(
        countLogicalAccounts(accounts),
      );
    });
  });
});

describe('toLogicalAccountPortfolio', () => {
  it('returns undefined for a missing summary, so values read as unknown', () => {
    expect(toLogicalAccountPortfolio(null)).toBeUndefined();
    expect(toLogicalAccountPortfolio(undefined)).toBeUndefined();
  });

  it('indexes market values and unpriced counts by account', () => {
    const result = toLogicalAccountPortfolio([
      { accountId: 'a', totalMarketValue: 10, unpricedHoldingsCount: 0 },
      { accountId: 'b', totalMarketValue: 20, unpricedHoldingsCount: 3 },
    ]);

    expect(result?.marketValues.get('b')).toBe(20);
    expect(result?.unpricedCounts.get('b')).toBe(3);
    expect(result?.unpricedCounts.get('a')).toBe(0);
  });
});

describe('toLogicalAccountPortfolio completeness', () => {
  it('records an account whose valuationComplete is false, with every price present', () => {
    const result = toLogicalAccountPortfolio([
      { accountId: 'a', totalMarketValue: 10, unpricedHoldingsCount: 0, valuationComplete: true },
      { accountId: 'b', totalMarketValue: 20, unpricedHoldingsCount: 0, valuationComplete: false },
      { accountId: 'c', totalMarketValue: 30, unpricedHoldingsCount: 0 },
    ]);

    expect(result?.incompleteAccountIds?.has('b')).toBe(true);
    // Absent is no information, not incomplete.
    expect(result?.incompleteAccountIds?.has('c')).toBe(false);
    expect(result?.incompleteAccountIds?.has('a')).toBe(false);
  });

  it('records an account with an unpriced holding even where the flag is absent', () => {
    const result = toLogicalAccountPortfolio([
      { accountId: 'a', totalMarketValue: 10, unpricedHoldingsCount: 2 },
    ]);
    expect(result?.incompleteAccountIds?.has('a')).toBe(true);
  });
});

describe('cashBalanceOf and securitiesValueOf', () => {
  it('splits a pair into the cash half and the securities', () => {
    const [entity] = buildLogicalAccounts(
      pair('tfsa', { cash: { currentBalance: 250 } }),
      strip,
      portfolio({ 'tfsa-brok': 9000 }),
    );
    expect(entity.combinedValue).toBe(9250);
    expect(cashBalanceOf(entity)).toBe(250);
    expect(securitiesValueOf(entity)).toBe(9000);
  });

  it('reads no securities in a pair that holds only cash', () => {
    const [entity] = buildLogicalAccounts(
      pair('tfsa', { cash: { currentBalance: 250 } }),
      strip,
      portfolio({ 'tfsa-brok': 0 }),
    );
    expect(securitiesValueOf(entity)).toBe(0);
    expect(cashBalanceOf(entity)).toBe(250);
  });

  it('reads unknown securities as null, not as the cash alone', () => {
    const [entity] = buildLogicalAccounts(
      pair('tfsa', { cash: { currentBalance: 250 } }),
      strip,
      portfolio({ 'tfsa-brok': 9000 }, { 'tfsa-brok': 1 }),
    );
    expect(securitiesValueOf(entity)).toBeNull();
  });

  it('counts positions by quantity when the caller supplies them', () => {
    const [entity] = buildLogicalAccounts(pair('tfsa'), strip, {
      ...portfolio({ 'tfsa-brok': 0 }),
      positionCounts: new Map([['tfsa-brok', 2]]),
    });
    expect(securitiesValueOf(entity)).toBe(0);
    expect(entity.positionCount).toBe(2);
  });

  it('leaves positionCount out when no counts were supplied', () => {
    const [entity] = buildLogicalAccounts(pair('tfsa'), strip, portfolio({ 'tfsa-brok': 0 }));
    expect(entity.positionCount).toBeUndefined();
  });

  it('gives a non-investment account its own balance and no securities', () => {
    const [entity] = buildLogicalAccounts([account('chq', { currentBalance: -42.1 })], strip);
    expect(cashBalanceOf(entity)).toBe(-42.1);
    expect(securitiesValueOf(entity)).toBe(0);
  });
});

describe('holdingsValuationIncomplete', () => {
  it('is true for an unpriced count, an incomplete id, and neither otherwise', () => {
    const counts = new Map([['p', 1], ['q', 0]]);
    const ids = new Set(['q']);
    expect(holdingsValuationIncomplete('p', counts, ids)).toBe(true);
    expect(holdingsValuationIncomplete('q', counts, ids)).toBe(true);
    expect(holdingsValuationIncomplete('r', counts, ids)).toBe(false);
    expect(holdingsValuationIncomplete('r', undefined, undefined)).toBe(false);
  });
});

describe('formatAccountOptionLabel', () => {
  it('strips a pair suffix so the option reads as the account the user knows', () => {
    const [, cash] = pair('TFSA');

    expect(formatAccountOptionLabel(cash, strip)).toBe('TFSA (CAD)');
  });

  it('marks a closed account with the caller supplied label', () => {
    const closed = account('chq', { name: 'Chequing', isClosed: true });

    expect(formatAccountOptionLabel(closed, strip, 'Fermé')).toBe(
      'Chequing (CAD) (Fermé)',
    );
  });
});
