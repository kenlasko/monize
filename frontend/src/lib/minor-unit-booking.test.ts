import { describe, it, expect, afterEach } from 'vitest';
import { clearCurrencyDecimals, registerCurrencyDecimals } from './currency-decimals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { bookSplitRowsAtMinorUnit, bookSplitsAtMinorUnit, minorUnitAbsorbIndex } from './minor-unit-booking';

interface BookingCase {
  name: string;
  amounts: number[];
  parentAmount: number;
  decimals: number;
  absorbIndex: number;
  expected: { amounts: number[]; parentAmount: number };
}

interface AbsorbCase {
  name: string;
  lines: { amount: number; transferAccountId: string | null; memo: string | null }[];
  accountTypes: Record<string, string>;
  expected: number;
}

// The parity fixture `backend/src/common/currency-minor-unit.util.spec.ts`
// runs against the server's copies. The server recognises an unchanged Post
// dialog by booking the stored template itself, so a drift between the two
// would silently stop re-pricing loan payments from the ledger.
const cases = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', 'backend', 'src', 'common', 'minor-unit-booking-cases.json'),
    'utf8',
  ),
) as { booking: BookingCase[]; absorbIndex: AbsorbCase[] };

describe('bookSplitsAtMinorUnit (minor-unit-booking-cases.json)', () => {
  it.each(cases.booking.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(bookSplitsAtMinorUnit(c.amounts, c.parentAmount, c.decimals, c.absorbIndex)).toEqual(c.expected);
  });
});

describe('minorUnitAbsorbIndex (minor-unit-booking-cases.json)', () => {
  it.each(cases.absorbIndex.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(minorUnitAbsorbIndex(c.lines, new Map(Object.entries(c.accountTypes)))).toBe(c.expected);
  });
});

describe('bookSplitRowsAtMinorUnit', () => {
  const mortgage = { accountType: 'MORTGAGE' };
  const rows = [
    { id: 'r1', splitType: 'category', categoryId: 'interest', amount: -306.0625 },
    { id: 'r2', splitType: 'transfer', transferAccountId: 'm1', amount: -864.5833, memo: 'Principal' },
  ];
  const template = [
    { transferAccountId: null, transferAccount: null },
    { transferAccountId: 'm1', transferAccount: mortgage },
  ];

  it('books the rows in the currency unit, the cent on the loan principal', () => {
    expect(bookSplitRowsAtMinorUnit(rows, -1170.6458, 'EUR', template)).toEqual({
      rows: [
        { ...rows[0], amount: -306.06 },
        { ...rows[1], amount: -864.59 },
      ],
      parentAmount: -1170.65,
    });
  });

  it('only rounds rows that never summed to the parent, leaving the gap to the user', () => {
    expect(bookSplitRowsAtMinorUnit(rows, -1500, 'EUR', template)).toEqual({
      rows: [
        { ...rows[0], amount: -306.06 },
        { ...rows[1], amount: -864.58 },
      ],
      parentAmount: -1500,
    });
  });

  it('books nothing for an investment line or an empty set', () => {
    expect(
      bookSplitRowsAtMinorUnit([{ splitType: 'investment', amount: -100.0001 }], -100.0001, 'EUR', null),
    ).toBeNull();
    expect(bookSplitRowsAtMinorUnit([], -10, 'EUR', null)).toBeNull();
  });

  describe('a coin', () => {
    afterEach(() => {
      clearCurrencyDecimals();
    });
    const coinRows = [
      { id: 'r1', splitType: 'transfer', transferAccountId: 'chq', amount: -0.005 },
      { id: 'r2', splitType: 'category', categoryId: 'fees', amount: -0.000025 },
    ];

    it('books a registered eight-place coin at its satoshis, nothing moved', () => {
      registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
      expect(bookSplitRowsAtMinorUnit(coinRows, -0.005025, 'BTC', null)).toEqual({
        rows: coinRows,
        parentAmount: -0.005025,
      });
    });

    it('balances at eight places: a one-satoshi gap is not read as balanced', () => {
      registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
      expect(bookSplitRowsAtMinorUnit(coinRows, -0.00502501, 'BTC', null)).toEqual({
        rows: coinRows,
        parentAmount: -0.00502501,
      });
      expect(bookSplitsAtMinorUnit([-0.005, -0.000025], -0.00502501, 8, 0)).toEqual({
        amounts: [-0.005, -0.000025],
        parentAmount: -0.00502501,
      });
    });

    it('books a coin the registry does not hold yet at the column scale, not Intl\'s two', () => {
      expect(bookSplitRowsAtMinorUnit(coinRows, -0.005025, 'BTC', null)).toEqual({
        rows: coinRows,
        parentAmount: -0.005025,
      });
    });
  });
});
