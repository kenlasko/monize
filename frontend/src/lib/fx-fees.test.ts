import { describe, it, expect, afterEach } from 'vitest';
import { foreignTransactionFee } from './fx-fees';
import { clearCurrencyDecimals, registerCurrencyDecimals } from './currency-decimals';
import type { Transaction, TransactionSplit } from '@/types/transaction';

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    userId: 'user-1',
    accountId: 'acc-1',
    account: null,
    transactionDate: '2025-01-15',
    payeeId: null,
    payeeName: null,
    payee: null,
    categoryId: null,
    category: null,
    amount: -100,
    currencyCode: 'CAD',
    exchangeRate: 1,
    originalAmount: null,
    originalCurrencyCode: null,
    description: null,
    referenceNumber: null,
    status: 'UNRECONCILED' as Transaction['status'],
    isCleared: false,
    isReconciled: false,
    isVoid: false,
    reconciledDate: null,
    isSplit: false,
    parentTransactionId: null,
    isTransfer: false,
    linkedTransactionId: null,
    createdAt: '2025-01-15T00:00:00Z',
    updatedAt: '2025-01-15T00:00:00Z',
    ...overrides,
  };
}

describe('foreignTransactionFee', () => {
  it('returns 0 for a domestic transaction', () => {
    expect(foreignTransactionFee(tx())).toBe(0);
  });

  it('recovers the fee folded into amount for an ordinary foreign entry', () => {
    // base = round(-100 x 1.38) = -138; amount = -141.45 => fee 3.45.
    const result = foreignTransactionFee(
      tx({
        originalAmount: -100,
        originalCurrencyCode: 'EUR',
        exchangeRate: 1.38,
        amount: -141.45,
      }),
    );
    expect(result).toBeCloseTo(3.45, 4);
  });

  it('returns 0 when a foreign entry has no fee (amount equals the base)', () => {
    const result = foreignTransactionFee(
      tx({
        originalAmount: -100,
        originalCurrencyCode: 'EUR',
        exchangeRate: 1.38,
        amount: -138,
      }),
    );
    expect(result).toBe(0);
  });

  it('handles a foreign income entry (fee is still a positive cost)', () => {
    // base = round(200 x 1.10) = 220; amount = 214.5 => fee 5.5.
    const result = foreignTransactionFee(
      tx({
        originalAmount: 200,
        originalCurrencyCode: 'USD',
        exchangeRate: 1.1,
        amount: 214.5,
      }),
    );
    expect(result).toBeCloseTo(5.5, 4);
  });

  it('recovers the folded-in fee for a split transaction (amount includes the fee)', () => {
    // base = round(-100 x 1.38) = -138; amount -141.45 = base + fee, splits sum
    // to that fee-inclusive total. fee = 3.45, regardless of the split lines.
    const result = foreignTransactionFee(
      tx({
        originalAmount: -100,
        originalCurrencyCode: 'EUR',
        exchangeRate: 1.38,
        amount: -141.45,
        isSplit: true,
        splits: [
          { id: 's1', amount: -100 } as TransactionSplit,
          { id: 's2', amount: -41.45 } as TransactionSplit,
        ],
      }),
    );
    expect(result).toBeCloseTo(3.45, 4);
  });

  it('returns 0 for a split foreign transaction recorded without a fee', () => {
    const result = foreignTransactionFee(
      tx({
        originalAmount: -100,
        originalCurrencyCode: 'EUR',
        exchangeRate: 1.38,
        amount: -138,
        isSplit: true,
        splits: [{ id: 's1', amount: -138 } as TransactionSplit],
      }),
    );
    expect(result).toBe(0);
  });

  describe('on a coin account', () => {
    afterEach(() => clearCurrencyDecimals());

    // A BTC account paying 510 USD at 0.0000098: base = -0.00499800 BTC,
    // booked -0.00502500 with a 2,700-satoshi fee.
    const coin = tx({
      currencyCode: 'BTC',
      originalAmount: -510,
      originalCurrencyCode: 'USD',
      exchangeRate: 0.0000098,
      amount: -0.005025,
    });

    it('takes the fee at the coin\'s registered eight places, not cents or four', () => {
      registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8, symbol: '₿' }]);
      // At cents the base read -0.01 and the fee came out negative; at four
      // the base read -0.0050 and the fee 0.0000.
      expect(foreignTransactionFee(coin)).toBe(0.000027);
    });

    it('takes the fee at the column scale while the registry does not hold the coin', () => {
      // `entryDecimalPlaces` enters an unregistered non-ISO code at
      // MONEY_SCALE, not cents, so the fee is still the 0.000027 BTC charged.
      expect(foreignTransactionFee(coin)).toBe(0.000027);
    });

    it('rounds at the registered places when the registry holds the coin at two', () => {
      registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 2, symbol: '₿' }]);
      // Base -0.00 at cents, booked -0.005025: the four-place difference.
      expect(foreignTransactionFee(coin)).toBe(0.005);
    });
  });
});
