import { describe, expect, it } from 'vitest';
import { toOverrideSplits } from './splitSerialization';
import { toSplitRows, type SplitRow } from '@/components/transactions/SplitEditor';

describe('toOverrideSplits', () => {
  it("sends a transfer line's category, and none for an investment line (INV-CATEGORY-002)", () => {
    const out = toOverrideSplits([
      { id: '1', splitType: 'transfer', transferAccountId: 'acc-2', categoryId: 'cat-save', amount: -30, memo: '' },
      { id: '2', splitType: 'category', categoryId: 'cat-food', amount: -20, memo: '' },
      {
        id: '3',
        splitType: 'investment',
        categoryId: 'stale',
        amount: -10,
        memo: '',
        investment: { action: 'BUY', securityId: 'sec-1', quantity: 1, price: 10, commission: 0, exchangeRate: 1 },
      },
    ] as SplitRow[]);
    expect(out.map((line) => line.categoryId)).toEqual(['cat-save', 'cat-food', null]);
  });

  it('preserves splitKind and the investment payload for investment-kind rows', () => {
    const rows: SplitRow[] = [
      {
        id: '1',
        splitType: 'category',
        categoryId: 'cat-income',
        amount: 1000,
        memo: '',
      },
      {
        id: '2',
        splitType: 'category',
        categoryId: 'cat-tax',
        amount: -250,
        memo: '',
      },
      {
        id: '3',
        splitType: 'investment',
        amount: -750,
        memo: '',
        investment: {
          action: 'BUY',
          securityId: 'sec-1',
          quantity: 75,
          price: 10,
          commission: 0,
          exchangeRate: 1,
        },
      },
    ];
    const out = toOverrideSplits(rows);
    expect(out).toHaveLength(3);
    expect(out[2]).toMatchObject({
      splitKind: 'investment',
      categoryId: null,
      transferAccountId: null,
      amount: -750,
      investment: {
        action: 'BUY',
        securityId: 'sec-1',
        quantity: 75,
        price: 10,
      },
    });
  });

  it("clears a category line's transferAccountId, and keeps a transfer line's category", () => {
    const rows: SplitRow[] = [
      {
        id: '1',
        splitType: 'transfer',
        transferAccountId: 'acc-2',
        // A transfer line carries a category of any type (INV-CATEGORY-002).
        categoryId: 'cat-kept',
        amount: -50,
        memo: '',
      },
      {
        id: '2',
        splitType: 'category',
        categoryId: 'cat-1',
        // transferAccountId stale; should be cleared on output
        transferAccountId: 'acc-stale',
        amount: -50,
        memo: '',
      },
    ];
    const out = toOverrideSplits(rows);
    expect(out[0]).toMatchObject({
      splitKind: 'transfer',
      transferAccountId: 'acc-2',
      categoryId: 'cat-kept',
    });
    expect(out[1]).toMatchObject({
      splitKind: 'category',
      categoryId: 'cat-1',
      transferAccountId: null,
    });
  });

  // Issue #1167 F5-1: the Post dialog reads scheduled/override splits with
  // `toSplitRows` and resends them with `toOverrideSplits`. The FX provenance
  // (from/to) must survive that round-trip so the server can tell a still-valid
  // rate from a stale one, instead of trusting the scalar blindly.
  it('round-trips FX provenance from a scheduled split through the post payload', () => {
    const rows = toSplitRows([
      {
        id: 's1',
        kind: 'investment',
        amount: -1500,
        investmentAction: 'BUY',
        investmentSecurityId: 'sec-usd',
        investmentQuantity: 10,
        investmentPrice: 100,
        investmentCommission: 0,
        investmentExchangeRate: 1.5,
        investmentExchangeRateFromCurrency: 'EUR',
        investmentExchangeRateToCurrency: 'CAD',
      },
    ]);
    const out = toOverrideSplits(rows);
    expect(out[0].investment).toMatchObject({
      action: 'BUY',
      securityId: 'sec-usd',
      exchangeRate: 1.5,
      exchangeRateFromCurrency: 'EUR',
      exchangeRateToCurrency: 'CAD',
    });
  });

  it('round-trips FX provenance from an override split through the post payload', () => {
    const rows = toSplitRows([
      {
        splitKind: 'investment',
        amount: -1500,
        investment: {
          action: 'BUY',
          securityId: 'sec-usd',
          quantity: 10,
          price: 100,
          commission: 0,
          exchangeRate: 1.5,
          exchangeRateFromCurrency: 'EUR',
          exchangeRateToCurrency: 'CAD',
        },
      },
    ]);
    const out = toOverrideSplits(rows);
    expect(out[0].investment).toMatchObject({
      exchangeRateFromCurrency: 'EUR',
      exchangeRateToCurrency: 'CAD',
    });
  });

  // Issue #1167 F4: the source split's id round-trips as sourceSplitId so the
  // server correlates FX provenance by identity, not by matching rate values.
  // The id is a real server UUID (R8-F1): a non-UUID synthetic key is withheld.
  it('round-trips the source split id as sourceSplitId', () => {
    const sourceId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const rows = toSplitRows([
      {
        id: sourceId,
        kind: 'investment',
        amount: -750,
        investmentAction: 'BUY',
        investmentSecurityId: 'sec-1',
        investmentExchangeRate: 1.5,
        investmentExchangeRateFromCurrency: 'EUR',
        investmentExchangeRateToCurrency: 'CAD',
      },
    ]);
    const out = toOverrideSplits(rows);
    expect(out[0].sourceSplitId).toBe(sourceId);
    // A continuing line (has source identity) is not marked as a new line.
    expect(out[0].rateExplicit).toBeUndefined();
  });

  // Issue #1167 R9-F2: a continuing line whose rate the user actually edited is
  // marked rateExplicit, so the server stamps the current pair even if the
  // re-entered value equals the stale stored one (the same-value re-entry edge).
  it('marks rateExplicit for a continuing line whose rate the user edited', () => {
    const rows: SplitRow[] = [
      {
        id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        sourceSplitId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        splitType: 'investment',
        exchangeRateEdited: true,
        amount: -750,
        memo: '',
        investment: {
          action: 'BUY',
          securityId: 'sec-1',
          exchangeRate: 1.5,
        } as never,
      },
    ];
    const out = toOverrideSplits(rows);
    expect(out[0].sourceSplitId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(out[0].rateExplicit).toBe(true);
  });

  it('leaves sourceSplitId undefined for a newly added row', () => {
    const rows: SplitRow[] = [
      {
        id: 'temp-123',
        splitType: 'category',
        categoryId: 'cat-1',
        amount: -10,
        memo: '',
        // A freshly-added row carries no source id.
        sourceSplitId: undefined,
      },
    ];
    const out = toOverrideSplits(rows);
    expect(out[0].sourceSplitId).toBeUndefined();
  });

  it('omits investment payload on non-investment rows', () => {
    const rows: SplitRow[] = [
      {
        id: '1',
        splitType: 'category',
        categoryId: 'cat-1',
        amount: -10,
        memo: '',
        // Stale investment payload - should be dropped on output
        investment: {
          action: 'BUY',
          securityId: 'sec-x',
          quantity: 1,
          price: 1,
        } as any,
      },
    ];
    const out = toOverrideSplits(rows);
    expect(out[0].investment).toBeUndefined();
  });
});
