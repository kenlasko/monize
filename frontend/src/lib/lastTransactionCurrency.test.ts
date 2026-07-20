import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  LAST_TRANSACTION_CURRENCY_KEY,
  getRememberedTransactionCurrency,
  rememberTransactionCurrency,
} from './lastTransactionCurrency';

describe('lastTransactionCurrency', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionStorage.clear();
  });

  describe('rememberTransactionCurrency', () => {
    it('stores the currency code with a timestamp', () => {
      rememberTransactionCurrency('EUR');
      const raw = sessionStorage.getItem(LAST_TRANSACTION_CURRENCY_KEY);
      expect(raw).not.toBeNull();
      const { value, savedAt } = JSON.parse(raw as string);
      expect(value).toBe('EUR');
      expect(typeof savedAt).toBe('number');
    });

    it('clears the stored value when passed an empty string', () => {
      rememberTransactionCurrency('EUR');
      rememberTransactionCurrency('');
      expect(sessionStorage.getItem(LAST_TRANSACTION_CURRENCY_KEY)).toBeNull();
    });
  });

  describe('getRememberedTransactionCurrency', () => {
    it('returns an empty string when nothing is stored', () => {
      expect(getRememberedTransactionCurrency()).toBe('');
    });

    it('returns the remembered code within the expiry window', () => {
      rememberTransactionCurrency('GBP');
      expect(getRememberedTransactionCurrency()).toBe('GBP');
    });

    it('expires after one hour and cleans up the entry', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-20T10:00:00Z'));
      rememberTransactionCurrency('JPY');
      expect(getRememberedTransactionCurrency()).toBe('JPY');

      // Advance just past the 1-hour window.
      vi.setSystemTime(new Date('2026-07-20T11:00:01Z'));
      expect(getRememberedTransactionCurrency()).toBe('');
      expect(sessionStorage.getItem(LAST_TRANSACTION_CURRENCY_KEY)).toBeNull();
    });

    it('ignores an unparseable stored value', () => {
      sessionStorage.setItem(LAST_TRANSACTION_CURRENCY_KEY, 'not-json');
      expect(getRememberedTransactionCurrency()).toBe('');
    });
  });
});
