import { describe, it, expect } from 'vitest';
import { convertRowAmount } from './investment-row-currency';

// A USD dividend in a CAD account that settled at its own 1.35, read by a
// EUR reader; the server's factors were worked out on the row's own date.
const row = (over: Partial<Parameters<typeof convertRowAmount>[0]> = {}) => ({
  amountCurrencyCode: 'USD',
  security: null,
  exchangeRate: 1.35,
  reportingCurrencyCode: 'EUR',
  reportingRate: 0.945,
  accountRate: 1.35,
  ...over,
});

describe('convertRowAmount', () => {
  it('leaves an amount already in the target currency alone', () => {
    expect(convertRowAmount(row(), 100, 'CAD', 'USD')).toBe(100);
  });

  it("converts into the account's currency at the server's factor", () => {
    expect(convertRowAmount(row(), 100, 'CAD', 'CAD')).toBe(135);
  });

  it("converts into the reporting currency at the server's per-date factor, not today's rate (issue #2106)", () => {
    expect(convertRowAmount(row(), 100, 'CAD', 'EUR')).toBeCloseTo(94.5, 6);
  });

  it('is unknown where the server found no rate, never the amount itself', () => {
    expect(convertRowAmount(row({ reportingRate: null }), 100, 'CAD', 'EUR')).toBeNull();
    expect(convertRowAmount(row({ accountRate: null }), 100, 'CAD', 'CAD')).toBeNull();
  });

  it('is unknown for a target the server stated no factor for', () => {
    expect(convertRowAmount(row(), 100, 'CAD', 'JPY')).toBeNull();
  });

  it("uses the row's own settlement rate into its account for a backend that predates the factors", () => {
    const legacy = row({ reportingCurrencyCode: undefined, reportingRate: undefined, accountRate: undefined });
    expect(convertRowAmount(legacy, 100, 'CAD', 'CAD')).toBe(135);
    expect(convertRowAmount({ ...legacy, exchangeRate: 0 }, 100, 'CAD', 'CAD')).toBeNull();
    expect(convertRowAmount(legacy, 100, 'CAD', 'EUR')).toBeNull();
  });

  it('falls back to the security currency for a backend that predates the stamp', () => {
    expect(
      convertRowAmount(
        row({ amountCurrencyCode: undefined, security: { currencyCode: 'CAD' } as never }),
        100,
        'CAD',
        'CAD',
      ),
    ).toBe(100);
  });

  it('is unknown when the row names no currency', () => {
    expect(
      convertRowAmount(row({ amountCurrencyCode: null, security: null }), 100, 'CAD', 'CAD'),
    ).toBeNull();
  });
});
