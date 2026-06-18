import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  LAST_TRANSACTION_DATE_KEY,
  LAST_INVESTMENT_TRANSACTION_DATE_KEY,
  getRememberedTransactionDate,
  rememberTransactionDate,
} from './lastTransactionDate';
import { getLocalDateString } from './utils';

describe('lastTransactionDate', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionStorage.clear();
  });

  it('uses separate keys for regular and investment transactions', () => {
    expect(LAST_TRANSACTION_DATE_KEY).not.toBe(LAST_INVESTMENT_TRANSACTION_DATE_KEY);
  });

  describe('rememberTransactionDate', () => {
    it('stores the date with a timestamp under the given key', () => {
      rememberTransactionDate(LAST_TRANSACTION_DATE_KEY, '2026-03-15');
      const raw = sessionStorage.getItem(LAST_TRANSACTION_DATE_KEY);
      expect(raw).not.toBeNull();
      const { date, savedAt } = JSON.parse(raw as string);
      expect(date).toBe('2026-03-15');
      expect(typeof savedAt).toBe('number');
    });

    it('keeps each key independent', () => {
      rememberTransactionDate(LAST_TRANSACTION_DATE_KEY, '2026-01-01');
      rememberTransactionDate(LAST_INVESTMENT_TRANSACTION_DATE_KEY, '2026-12-31');
      expect(getRememberedTransactionDate(LAST_TRANSACTION_DATE_KEY)).toBe('2026-01-01');
      expect(getRememberedTransactionDate(LAST_INVESTMENT_TRANSACTION_DATE_KEY)).toBe(
        '2026-12-31',
      );
    });
  });

  describe('getRememberedTransactionDate', () => {
    it('returns today when nothing is stored', () => {
      expect(getRememberedTransactionDate(LAST_TRANSACTION_DATE_KEY)).toBe(
        getLocalDateString(),
      );
    });

    it('returns a stored date saved within the last hour', () => {
      sessionStorage.setItem(
        LAST_INVESTMENT_TRANSACTION_DATE_KEY,
        JSON.stringify({ date: '2026-02-20', savedAt: Date.now() - 30 * 60 * 1000 }),
      );
      expect(getRememberedTransactionDate(LAST_INVESTMENT_TRANSACTION_DATE_KEY)).toBe(
        '2026-02-20',
      );
    });

    it('ignores and clears a stored date older than one hour', () => {
      sessionStorage.setItem(
        LAST_INVESTMENT_TRANSACTION_DATE_KEY,
        JSON.stringify({ date: '2026-02-20', savedAt: Date.now() - 61 * 60 * 1000 }),
      );
      expect(getRememberedTransactionDate(LAST_INVESTMENT_TRANSACTION_DATE_KEY)).toBe(
        getLocalDateString(),
      );
      expect(sessionStorage.getItem(LAST_INVESTMENT_TRANSACTION_DATE_KEY)).toBeNull();
    });

    it('falls back to today and clears a legacy non-JSON value', () => {
      sessionStorage.setItem(LAST_TRANSACTION_DATE_KEY, '2026-02-20');
      expect(getRememberedTransactionDate(LAST_TRANSACTION_DATE_KEY)).toBe(
        getLocalDateString(),
      );
      expect(sessionStorage.getItem(LAST_TRANSACTION_DATE_KEY)).toBeNull();
    });

    it('round-trips a remembered date just under the one-hour boundary', () => {
      rememberTransactionDate(LAST_TRANSACTION_DATE_KEY, '2026-05-05');
      expect(getRememberedTransactionDate(LAST_TRANSACTION_DATE_KEY)).toBe('2026-05-05');
    });
  });
});
