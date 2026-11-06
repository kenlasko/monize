import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Account } from '@/types/account';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import {
  buildForecast,
  buildMultiAccountForecast,
  countOverdueOccurrences,
  getForecastSummary,
  OVERDUE_CARRY_DAYS,
  getProjectedBalanceAtDate,
  FORECAST_PERIOD_DAYS,
  FORECAST_PERIOD_LABELS,
  FutureTransaction,
  projectPayrollOccurrence,
} from './forecast';
import { clearCurrencyDecimals, registerCurrencyDecimals } from './currency-decimals';

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (dateStr: string) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d);
  },
}));

const makeAccount = (overrides: Partial<Account> = {}) => ({
  id: 'acc-1',
  name: 'Checking',
  currentBalance: 1000,
  isClosed: false,
  ...overrides,
}) as Account;

const makeScheduled = (overrides: Partial<ScheduledTransaction> = {}) => ({
  id: 'st-1',
  name: 'Rent',
  amount: -1500,
  frequency: 'MONTHLY',
  nextDueDate: '2025-02-01',
  isActive: true,
  isTransfer: false,
  transferAccountId: null,
  isSplit: false,
  splits: [],
  endDate: null,
  occurrencesRemaining: null,
  nextOverride: null,
  accountId: 'acc-1',
  ...overrides,
}) as ScheduledTransaction;

describe('FORECAST_PERIOD_DAYS', () => {
  it('has correct day counts', () => {
    expect(FORECAST_PERIOD_DAYS.week).toBe(7);
    expect(FORECAST_PERIOD_DAYS.month).toBe(30);
    expect(FORECAST_PERIOD_DAYS['90days']).toBe(90);
    expect(FORECAST_PERIOD_DAYS['6months']).toBe(180);
    expect(FORECAST_PERIOD_DAYS.year).toBe(365);
  });
});

describe('FORECAST_PERIOD_LABELS', () => {
  it('has correct labels', () => {
    expect(FORECAST_PERIOD_LABELS.week).toBe('7D');
    expect(FORECAST_PERIOD_LABELS.year).toBe('1Y');
  });

  it('has labels for all periods', () => {
    expect(FORECAST_PERIOD_LABELS.month).toBe('30D');
    expect(FORECAST_PERIOD_LABELS['90days']).toBe('90D');
    expect(FORECAST_PERIOD_LABELS['6months']).toBe('6M');
  });
});

/**
 * `buildForecast` now returns `{ points, missingCurrencies }`: a projected
 * balance is cumulative, so one unconvertible leg invalidates every day after
 * it and the whole series is withheld rather than drifting. These tests are
 * about the series, so they unwrap it; the envelope has its own describe below.
 */
const forecastPoints = (
  ...args: Parameters<typeof buildForecast>
): ReturnType<typeof buildForecast>['points'] => buildForecast(...args).points;

describe('buildForecast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 0, 15)); // Jan 15, 2025
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty array when no matching accounts', () => {
    const result = forecastPoints([], [], 'month', 'all');
    expect(result).toEqual([]);
  });

  it('returns data points for an account with no transactions', () => {
    const accounts = [makeAccount()];
    const result = forecastPoints(accounts, [], 'week', 'all');
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].balance).toBe(1000);
  });

  it('applies scheduled transaction amounts to balance', () => {
    const accounts = [makeAccount({ currentBalance: 5000 })];
    const transactions = [makeScheduled({
      nextDueDate: '2025-01-20',
      amount: -500,
      frequency: 'ONCE',
    })];
    const result = forecastPoints(accounts, transactions, 'month', 'all');
    const afterTx = result.find(dp => dp.date === '2025-01-20');
    expect(afterTx?.balance).toBe(4500);
  });

  it('skips inactive transactions', () => {
    const accounts = [makeAccount({ currentBalance: 1000 })];
    const transactions = [makeScheduled({ isActive: false, nextDueDate: '2025-01-20', frequency: 'ONCE' })];
    const result = forecastPoints(accounts, transactions, 'month', 'all');
    const allBalances = result.map(dp => dp.balance);
    expect(allBalances.every(b => b === 1000)).toBe(true);
  });

  it('filters by specific account', () => {
    const accounts = [makeAccount({ id: 'acc-1' }), makeAccount({ id: 'acc-2', currentBalance: 2000 })];
    const result = forecastPoints(accounts, [], 'week', 'acc-2');
    expect(result[0].balance).toBe(2000);
  });

  it('excludes closed accounts in all mode', () => {
    const accounts = [makeAccount({ isClosed: true })];
    const result = forecastPoints(accounts, [], 'week', 'all');
    expect(result).toEqual([]);
  });

  it('excludes transfers in all-account mode', () => {
    const accounts = [makeAccount({ currentBalance: 5000 })];
    const transactions = [makeScheduled({
      isTransfer: true,
      transferAccountId: 'acc-2',
      nextDueDate: '2025-01-20',
      frequency: 'ONCE',
    })];
    const result = forecastPoints(accounts, transactions, 'month', 'all');
    const allBalances = result.map(dp => dp.balance);
    expect(allBalances.every(b => b === 5000)).toBe(true);
  });

  it('uses override amount for next due date', () => {
    const accounts = [makeAccount({ currentBalance: 5000 })];
    const transactions = [makeScheduled({
      nextDueDate: '2025-01-20',
      amount: -500,
      frequency: 'ONCE',
      nextOverride: { amount: -700 } as any,
    })];
    const result = forecastPoints(accounts, transactions, 'month', 'all');
    const afterTx = result.find(dp => dp.date === '2025-01-20');
    expect(afterTx?.balance).toBe(4300);
  });

  // --- DAILY frequency ---
  describe('DAILY frequency', () => {
    it('generates correct daily sequence', () => {
      const accounts = [makeAccount({ currentBalance: 1000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -100,
        frequency: 'DAILY',
      })];
      const result = forecastPoints(accounts, transactions, 'week', 'all');
      // Day 0: Jan 15 => -100, balance 900
      // Day 1: Jan 16 => -100, balance 800
      // ...through Jan 22 (7 days)
      const jan15 = result.find(dp => dp.date === '2025-01-15');
      const jan16 = result.find(dp => dp.date === '2025-01-16');
      const jan17 = result.find(dp => dp.date === '2025-01-17');
      expect(jan15?.balance).toBe(900);
      expect(jan16?.balance).toBe(800);
      expect(jan17?.balance).toBe(700);
    });

    it('generates daily transactions for the entire week period', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -10,
        frequency: 'DAILY',
      })];
      const result = forecastPoints(accounts, transactions, 'week', 'all');
      // 8 days of transactions (day 0 through day 7 inclusive)
      const txPoints = result.filter(dp => dp.transactions.length > 0);
      expect(txPoints.length).toBe(8);
    });
  });

  // --- WEEKLY frequency ---
  describe('WEEKLY frequency', () => {
    it('generates occurrences every 7 days', () => {
      const accounts = [makeAccount({ currentBalance: 2000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -200,
        frequency: 'WEEKLY',
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'all');
      const jan15 = result.find(dp => dp.date === '2025-01-15');
      const jan22 = result.find(dp => dp.date === '2025-01-22');
      const jan29 = result.find(dp => dp.date === '2025-01-29');
      const feb05 = result.find(dp => dp.date === '2025-02-05');
      expect(jan15?.balance).toBe(1800);
      expect(jan22?.balance).toBe(1600);
      expect(jan29?.balance).toBe(1400);
      expect(feb05?.balance).toBe(1200);
    });
  });

  // --- BIWEEKLY frequency ---
  describe('BIWEEKLY frequency', () => {
    it('generates occurrences every 14 days', () => {
      const accounts = [makeAccount({ currentBalance: 3000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -500,
        frequency: 'BIWEEKLY',
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'all');
      const jan15 = result.find(dp => dp.date === '2025-01-15');
      const jan29 = result.find(dp => dp.date === '2025-01-29');
      expect(jan15?.balance).toBe(2500);
      expect(jan29?.balance).toBe(2000);
      // There should not be a Jan 22 occurrence
      const jan22 = result.find(dp => dp.date === '2025-01-22');
      expect(jan22?.transactions.length ?? 0).toBe(0);
    });
  });

  // --- EVERY4WEEKS frequency ---
  describe('EVERY4WEEKS frequency', () => {
    it('generates occurrences every 28 days', () => {
      const accounts = [makeAccount({ currentBalance: 3000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -500,
        frequency: 'EVERY4WEEKS',
      })];
      const result = forecastPoints(accounts, transactions, '90days', 'all');
      const jan15 = result.find(dp => dp.date === '2025-01-15');
      const feb12 = result.find(dp => dp.date === '2025-02-12');
      const mar12 = result.find(dp => dp.date === '2025-03-12');
      expect(jan15?.transactions.length).toBe(1);
      expect(jan15?.balance).toBe(2500);
      expect(feb12?.transactions.length).toBe(1);
      expect(feb12?.balance).toBe(2000);
      expect(mar12?.transactions.length).toBe(1);
      expect(mar12?.balance).toBe(1500);
      // No occurrence at 14 days (not biweekly)
      const jan29 = result.find(dp => dp.date === '2025-01-29');
      expect(jan29?.transactions.length ?? 0).toBe(0);
    });
  });

  // --- SEMIMONTHLY frequency ---
  describe('SEMIMONTHLY frequency', () => {
    it('generates dates on 15th and end of month', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -1000,
        frequency: 'SEMIMONTHLY',
      })];
      // 90 days period to see multiple occurrences
      const result = forecastPoints(accounts, transactions, '90days', 'all');
      // Jan 15 -> end of Jan (Jan 31) -> Feb 15 -> end of Feb (Feb 28) -> Mar 15 -> end of Mar (Mar 31)
      const jan15 = result.find(dp => dp.date === '2025-01-15');
      const jan31 = result.find(dp => dp.date === '2025-01-31');
      const feb15 = result.find(dp => dp.date === '2025-02-15');
      const feb28 = result.find(dp => dp.date === '2025-02-28');
      const mar15 = result.find(dp => dp.date === '2025-03-15');
      const mar31 = result.find(dp => dp.date === '2025-03-31');
      expect(jan15?.transactions.length).toBe(1);
      expect(jan31?.transactions.length).toBe(1);
      expect(feb15?.transactions.length).toBe(1);
      expect(feb28?.transactions.length).toBe(1);
      expect(mar15?.transactions.length).toBe(1);
      expect(mar31?.transactions.length).toBe(1);
    });

    it('handles start date after the 15th (goes to end of month first)', () => {
      const accounts = [makeAccount({ currentBalance: 3000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-20',
        amount: -500,
        frequency: 'SEMIMONTHLY',
      })];
      const result = forecastPoints(accounts, transactions, '90days', 'all');
      // Jan 20 (<=15 is false, so next goes to 15th of next month)
      // Actually: Jan 20 > 15, so next = Feb 15 -> end of Feb (Feb 28) -> Mar 15 -> end of Mar
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      const feb15 = result.find(dp => dp.date === '2025-02-15');
      const feb28 = result.find(dp => dp.date === '2025-02-28');
      expect(jan20?.transactions.length).toBe(1);
      expect(feb15?.transactions.length).toBe(1);
      expect(feb28?.transactions.length).toBe(1);
    });
  });

  // --- QUARTERLY frequency ---
  describe('QUARTERLY frequency', () => {
    it('generates occurrences every 3 months', () => {
      const accounts = [makeAccount({ currentBalance: 10000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -2000,
        frequency: 'QUARTERLY',
      })];
      const result = forecastPoints(accounts, transactions, 'year', 'all');
      // Jan 15, Apr 15, Jul 15, Oct 15
      const jan15 = result.find(dp => dp.date === '2025-01-15');
      const apr15 = result.find(dp => dp.date === '2025-04-15');
      const jul15 = result.find(dp => dp.date === '2025-07-15');
      const oct15 = result.find(dp => dp.date === '2025-10-15');
      expect(jan15?.transactions.length).toBe(1);
      expect(apr15?.transactions.length).toBe(1);
      expect(jul15?.transactions.length).toBe(1);
      expect(oct15?.transactions.length).toBe(1);
      expect(oct15?.balance).toBe(2000); // 10000 - 4*2000
    });
  });

  // --- YEARLY frequency ---
  describe('YEARLY frequency', () => {
    it('generates occurrences once per year within the forecast period', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -1000,
        frequency: 'YEARLY',
      })];
      const result = forecastPoints(accounts, transactions, 'year', 'all');
      // Jan 15, 2025 is day 0, Jan 15, 2026 is exactly 365 days later (included as endDate is <=)
      const txPoints = result.filter(dp => dp.transactions.length > 0);
      expect(txPoints.length).toBe(2);
      expect(txPoints[0].date).toBe('2025-01-15');
      expect(txPoints[0].balance).toBe(4000);
      expect(txPoints[1].date).toBe('2026-01-15');
      expect(txPoints[1].balance).toBe(3000);
    });

    it('generates only one occurrence when next is beyond forecast period', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-16', // One day after "today", so next would be Jan 16, 2026 = day 366 = beyond 365
        amount: -1000,
        frequency: 'YEARLY',
      })];
      const result = forecastPoints(accounts, transactions, 'year', 'all');
      const txPoints = result.filter(dp => dp.transactions.length > 0);
      expect(txPoints.length).toBe(1);
      expect(txPoints[0].date).toBe('2025-01-16');
      expect(txPoints[0].balance).toBe(4000);
    });
  });

  // --- Year boundary crossing ---
  describe('date generation crossing year boundary', () => {
    it('handles Dec to Jan transition for MONTHLY', () => {
      vi.setSystemTime(new Date(2025, 10, 15)); // Nov 15, 2025
      const accounts = [makeAccount({ currentBalance: 3000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-12-01',
        amount: -500,
        frequency: 'MONTHLY',
      })];
      const result = forecastPoints(accounts, transactions, '90days', 'all');
      const dec01 = result.find(dp => dp.date === '2025-12-01');
      const jan01 = result.find(dp => dp.date === '2026-01-01');
      const feb01 = result.find(dp => dp.date === '2026-02-01');
      expect(dec01?.transactions.length).toBe(1);
      expect(jan01?.transactions.length).toBe(1);
      expect(feb01?.transactions.length).toBe(1);
    });

    it('handles Dec to Jan transition for WEEKLY', () => {
      vi.setSystemTime(new Date(2025, 11, 25)); // Dec 25, 2025
      const accounts = [makeAccount({ currentBalance: 2000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-12-25',
        amount: -100,
        frequency: 'WEEKLY',
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'all');
      const dec25 = result.find(dp => dp.date === '2025-12-25');
      const jan01 = result.find(dp => dp.date === '2026-01-01');
      const jan08 = result.find(dp => dp.date === '2026-01-08');
      expect(dec25?.transactions.length).toBe(1);
      expect(jan01?.transactions.length).toBe(1);
      expect(jan08?.transactions.length).toBe(1);
    });
  });

  // --- Month boundary edge cases ---
  describe('month boundary edge cases', () => {
    it('handles Jan 31 -> Feb 28 for MONTHLY (non-leap year)', () => {
      vi.setSystemTime(new Date(2025, 0, 1)); // Jan 1, 2025
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-31',
        amount: -100,
        frequency: 'MONTHLY',
      })];
      const result = forecastPoints(accounts, transactions, '90days', 'all');
      const jan31 = result.find(dp => dp.date === '2025-01-31');
      expect(jan31?.transactions.length).toBe(1);
      // Clamped to the last day of the shorter month, matching the backend's
      // calculateNextDueDate (the authority for the stored next_due_date).
      // A bare setMonth(1) on Jan 31 overflows to Mar 3, which this used to
      // assert -- the forecast then showed a date the server would never post.
      const feb28 = result.find(dp => dp.date === '2025-02-28');
      expect(feb28?.transactions.length).toBe(1);
      expect(result.find(dp => dp.date === '2025-03-03')?.transactions.length ?? 0).toBe(0);
    });

    it('handles end-of-month SEMIMONTHLY in February (non-leap year)', () => {
      vi.setSystemTime(new Date(2025, 0, 1)); // Jan 1, 2025
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -100,
        frequency: 'SEMIMONTHLY',
      })];
      const result = forecastPoints(accounts, transactions, '90days', 'all');
      // SEMIMONTHLY: Jan 15 -> Jan 31 (end of Jan) -> Feb 15 -> Feb 28 (end of Feb)
      const jan31 = result.find(dp => dp.date === '2025-01-31');
      const feb28 = result.find(dp => dp.date === '2025-02-28');
      expect(jan31?.transactions.length).toBe(1);
      expect(feb28?.transactions.length).toBe(1);
    });
  });

  // --- Leap year handling ---
  describe('leap year handling', () => {
    it('SEMIMONTHLY generates Feb 29 end-of-month in leap year', () => {
      vi.setSystemTime(new Date(2024, 0, 1)); // Jan 1, 2024 (leap year)
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2024-01-15',
        amount: -100,
        frequency: 'SEMIMONTHLY',
      })];
      const result = forecastPoints(accounts, transactions, '90days', 'all');
      // SEMIMONTHLY: Jan 15 -> Jan 31 -> Feb 15 -> Feb 29 (leap year!)
      const feb29 = result.find(dp => dp.date === '2024-02-29');
      expect(feb29?.transactions.length).toBe(1);
    });

    it('MONTHLY from Jan 29 wraps correctly in leap year', () => {
      vi.setSystemTime(new Date(2024, 0, 1)); // Jan 1, 2024 (leap year)
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2024-01-29',
        amount: -100,
        frequency: 'MONTHLY',
      })];
      const result = forecastPoints(accounts, transactions, '90days', 'all');
      const jan29 = result.find(dp => dp.date === '2024-01-29');
      const feb29 = result.find(dp => dp.date === '2024-02-29');
      expect(jan29?.transactions.length).toBe(1);
      expect(feb29?.transactions.length).toBe(1);
    });
  });

  // --- Granularity-based data point filtering ---
  describe('granularity-based data point filtering', () => {
    it('week period uses daily granularity (every data point)', () => {
      const accounts = [makeAccount()];
      const result = forecastPoints(accounts, [], 'week', 'all');
      // 7 days + day 0 = 8 data points
      expect(result.length).toBe(8);
    });

    it('month period uses daily granularity', () => {
      const accounts = [makeAccount()];
      const result = forecastPoints(accounts, [], 'month', 'all');
      // 30 days + day 0 = 31 data points
      expect(result.length).toBe(31);
    });

    it('90days period uses every-3-day granularity (fewer data points)', () => {
      const accounts = [makeAccount()];
      const result = forecastPoints(accounts, [], '90days', 'all');
      // Granularity 3: data points at day 0, 3, 6, 9, ... plus last day
      // Expected: about 31 data points (90/3 + 1)
      expect(result.length).toBeLessThan(91);
      expect(result.length).toBeGreaterThan(20);
    });

    it('6months period uses weekly granularity', () => {
      const accounts = [makeAccount()];
      const result = forecastPoints(accounts, [], '6months', 'all');
      // Granularity 7: data points at day 0, 7, 14, ... plus last day
      // Expected: about 26-27 data points (180/7 + 1)
      expect(result.length).toBeLessThan(181);
      expect(result.length).toBeGreaterThan(20);
    });

    it('year period uses weekly granularity', () => {
      const accounts = [makeAccount()];
      const result = forecastPoints(accounts, [], 'year', 'all');
      // Granularity 7: data points at day 0, 7, 14, ... plus last day
      // Expected: about 53 data points (365/7 + 1)
      expect(result.length).toBeLessThan(366);
      expect(result.length).toBeGreaterThan(40);
    });

    it('always includes data points with transactions regardless of granularity', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      // Put a transaction on day 2 (which is between granularity points for 90days/3-day)
      const futureDate = new Date(2025, 0, 17); // Jan 17 = day 2
      const dateStr = `${futureDate.getFullYear()}-${String(futureDate.getMonth() + 1).padStart(2, '0')}-${String(futureDate.getDate()).padStart(2, '0')}`;
      const transactions = [makeScheduled({
        nextDueDate: dateStr,
        amount: -500,
        frequency: 'ONCE',
      })];
      const result = forecastPoints(accounts, transactions, '90days', 'all');
      const txPoint = result.find(dp => dp.date === dateStr);
      expect(txPoint).toBeDefined();
      expect(txPoint?.transactions.length).toBe(1);
    });
  });

  // --- Empty scheduled transactions input ---
  describe('empty scheduled transactions input', () => {
    it('returns flat balance line with empty transactions array', () => {
      const accounts = [makeAccount({ currentBalance: 2500 })];
      const result = forecastPoints(accounts, [], 'month', 'all');
      expect(result.length).toBeGreaterThan(0);
      const allBalances = result.map(dp => dp.balance);
      expect(allBalances.every(b => b === 2500)).toBe(true);
    });

    it('all data points have empty transaction arrays', () => {
      const accounts = [makeAccount()];
      const result = forecastPoints(accounts, [], 'week', 'all');
      for (const dp of result) {
        expect(dp.transactions).toEqual([]);
      }
    });
  });

  // --- End date boundary ---
  describe('end date boundary', () => {
    it('stops generating occurrences past transaction endDate', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -100,
        frequency: 'WEEKLY',
        endDate: '2025-01-29',
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'all');
      // Should have occurrences on Jan 15, Jan 22, Jan 29
      // Jan 29 is on the endDate, so it should be included
      // Feb 5 should NOT have an occurrence
      const jan15 = result.find(dp => dp.date === '2025-01-15');
      const jan22 = result.find(dp => dp.date === '2025-01-22');
      const jan29 = result.find(dp => dp.date === '2025-01-29');
      const feb05 = result.find(dp => dp.date === '2025-02-05');
      expect(jan15?.transactions.length).toBe(1);
      expect(jan22?.transactions.length).toBe(1);
      expect(jan29?.transactions.length).toBe(1);
      expect(feb05?.transactions.length ?? 0).toBe(0);
    });

    it('does not include transactions past forecast period endDate', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -100,
        frequency: 'DAILY',
      })];
      // Week period = 7 days from Jan 15 = Jan 22
      const result = forecastPoints(accounts, transactions, 'week', 'all');
      const lastPoint = result[result.length - 1];
      const lastDate = new Date(2025, 0, 22); // Jan 22
      const expectedDateKey = `${lastDate.getFullYear()}-${String(lastDate.getMonth() + 1).padStart(2, '0')}-${String(lastDate.getDate()).padStart(2, '0')}`;
      expect(lastPoint.date).toBe(expectedDateKey);
    });

    it('respects occurrencesRemaining limit', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -100,
        frequency: 'WEEKLY',
        occurrencesRemaining: 2,
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'all');
      // Only 2 occurrences: Jan 15 and Jan 22
      const txPoints = result.filter(dp => dp.transactions.length > 0);
      expect(txPoints.length).toBe(2);
      expect(txPoints[0].date).toBe('2025-01-15');
      expect(txPoints[1].date).toBe('2025-01-22');
    });
  });

  // --- Split-based transfer detection ---
  describe('transfer detection', () => {
    it('excludes split-based transfers in all-account mode', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-20',
        amount: -500,
        frequency: 'ONCE',
        isTransfer: false,
        isSplit: true,
        splits: [{ transferAccountId: 'acc-2' } as any],
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'all');
      const allBalances = result.map(dp => dp.balance);
      expect(allBalances.every(b => b === 5000)).toBe(true);
    });

    it('includes transfers when filtering by source account', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-20',
        amount: -500,
        frequency: 'ONCE',
        isTransfer: true,
        transferAccountId: 'acc-2',
        accountId: 'acc-1',
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'acc-1');
      const afterTx = result.find(dp => dp.date === '2025-01-20');
      expect(afterTx?.balance).toBe(4500);
    });

    it('includes transfers when filtering by destination account', () => {
      const accounts = [makeAccount({ id: 'acc-2', currentBalance: 1000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-20',
        amount: -500,
        frequency: 'ONCE',
        isTransfer: true,
        transferAccountId: 'acc-2',
        accountId: 'acc-1',
      })];
      // Viewing VISA (acc-2): the $500 transfer should show as +500
      const result = forecastPoints(accounts, transactions, 'month', 'acc-2');
      const afterTx = result.find(dp => dp.date === '2025-01-20');
      expect(afterTx?.balance).toBe(1500); // 1000 + 500
    });

    it('includes recurring transfers for destination account', () => {
      const accounts = [makeAccount({ id: 'acc-2', currentBalance: 1000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -200,
        frequency: 'WEEKLY',
        isTransfer: true,
        transferAccountId: 'acc-2',
        accountId: 'acc-1',
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'acc-2');
      // Each weekly occurrence should add 200 to the destination account
      const jan15 = result.find(dp => dp.date === '2025-01-15');
      expect(jan15?.balance).toBe(1200); // 1000 + 200
      const jan22 = result.find(dp => dp.date === '2025-01-22');
      expect(jan22?.balance).toBe(1400); // 1200 + 200
    });

    it('does not double-count transfers between the same account', () => {
      // Edge case: accountId and transferAccountId are the same
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-20',
        amount: -500,
        frequency: 'ONCE',
        isTransfer: true,
        transferAccountId: 'acc-1',
        accountId: 'acc-1',
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'acc-1');
      const afterTx = result.find(dp => dp.date === '2025-01-20');
      // Should only count once (as source), not also negate as inbound
      expect(afterTx?.balance).toBe(4500);
    });
  });

  // --- Multiple accounts and transactions ---
  describe('scheduled investment transactions', () => {
    it('applies a scheduled BUY to the investment cash funding account', () => {
      const cashAccount = makeAccount({ id: 'cash-1', currentBalance: 10000 });
      const transactions = [makeScheduled({
        id: 'inv-1',
        name: 'Buy AAPL',
        accountId: 'brokerage-1',
        amount: -2500, // signed cash impact (BUY)
        frequency: 'ONCE',
        nextDueDate: '2025-01-20',
        isInvestment: true,
        investmentFundingAccountId: 'cash-1',
        investmentForecastExchangeRate: 1,
      } as any)];
      const result = forecastPoints([cashAccount], transactions, 'month', 'cash-1');
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      expect(jan20?.transactions.length).toBe(1);
      expect(jan20?.transactions[0].amount).toBe(-2500);
      expect(jan20?.balance).toBe(7500);
    });

    it('applies a scheduled SELL as a positive cash inflow on the funding account', () => {
      const cashAccount = makeAccount({ id: 'cash-1', currentBalance: 10000 });
      const transactions = [makeScheduled({
        id: 'inv-1',
        name: 'Sell AAPL',
        accountId: 'brokerage-1',
        amount: 1500, // signed cash impact (SELL)
        frequency: 'ONCE',
        nextDueDate: '2025-01-20',
        isInvestment: true,
        investmentFundingAccountId: 'cash-1',
        investmentForecastExchangeRate: 1,
      } as any)];
      const result = forecastPoints([cashAccount], transactions, 'month', 'cash-1');
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      expect(jan20?.balance).toBe(11500);
    });

    it('converts the cash impact via the server-resolved forecast rate', () => {
      const cashAccount = makeAccount({ id: 'cash-1', currentBalance: 10000 });
      const transactions = [makeScheduled({
        id: 'inv-1',
        name: 'Buy ABC.TO',
        accountId: 'brokerage-1',
        amount: -1000, // security currency
        frequency: 'ONCE',
        nextDueDate: '2025-01-20',
        isInvestment: true,
        investmentFundingAccountId: 'cash-1',
        investmentForecastExchangeRate: 1.35,
      } as any)];
      const result = forecastPoints([cashAccount], transactions, 'month', 'cash-1');
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      // -1000 * 1.35 = -1350
      expect(jan20?.balance).toBe(8650);
    });

    it('does not affect a non-funding account when selected', () => {
      const otherCash = makeAccount({ id: 'cash-other', currentBalance: 4000 });
      const transactions = [makeScheduled({
        id: 'inv-1',
        accountId: 'brokerage-1',
        amount: -2500,
        frequency: 'ONCE',
        nextDueDate: '2025-01-20',
        isInvestment: true,
        investmentFundingAccountId: 'cash-1',
        investmentForecastExchangeRate: 1,
      } as any)];
      const result = forecastPoints([otherCash], transactions, 'month', 'cash-other');
      const allBalances = result.map(dp => dp.balance);
      expect(allBalances.every(b => b === 4000)).toBe(true);
    });

    it('falls back to the brokerage linked cash account when fundingAccountId is null', () => {
      const cashAccount = makeAccount({ id: 'cash-1', currentBalance: 10000 });
      const brokerage = makeAccount({
        id: 'brokerage-1',
        currentBalance: 0,
        linkedAccountId: 'cash-1',
        accountSubType: 'INVESTMENT_BROKERAGE',
      } as any);
      const transactions = [makeScheduled({
        id: 'inv-1',
        name: 'Buy AAPL',
        accountId: 'brokerage-1',
        amount: -2500,
        frequency: 'ONCE',
        nextDueDate: '2025-01-20',
        isInvestment: true,
        investmentFundingAccountId: null,
        investmentForecastExchangeRate: 1,
      } as any)];
      const result = forecastPoints([cashAccount, brokerage], transactions, 'month', 'cash-1');
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      expect(jan20?.balance).toBe(7500);
    });

    it('expands recurring scheduled investments on the funding account', () => {
      const cashAccount = makeAccount({ id: 'cash-1', currentBalance: 10000 });
      const transactions = [makeScheduled({
        id: 'inv-1',
        accountId: 'brokerage-1',
        amount: -500,
        frequency: 'MONTHLY',
        nextDueDate: '2025-01-20',
        isInvestment: true,
        investmentFundingAccountId: 'cash-1',
        investmentForecastExchangeRate: 1,
      } as any)];
      const result = forecastPoints([cashAccount], transactions, '90days', 'cash-1');
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      const feb20 = result.find(dp => dp.date === '2025-02-20');
      const mar20 = result.find(dp => dp.date === '2025-03-20');
      expect(jan20?.balance).toBe(9500);
      expect(feb20?.balance).toBe(9000);
      expect(mar20?.balance).toBe(8500);
    });

    // Issue #1167: the forecast uses the server-resolved forecast rate, never the
    // persisted (possibly stale) investmentExchangeRate.
    it('uses the current forecast rate, not a stale persisted rate', () => {
      const cashAccount = makeAccount({ id: 'cash-1', currentBalance: 10000 });
      const transactions = [makeScheduled({
        id: 'inv-1',
        name: 'Buy USD security',
        accountId: 'brokerage-1',
        amount: -1000, // 10 shares * 100, security currency
        frequency: 'ONCE',
        nextDueDate: '2025-01-20',
        isInvestment: true,
        investmentFundingAccountId: 'cash-1',
        // Stale persisted rate (EUR->CAD 1.50) the security has since outgrown.
        investmentExchangeRate: 1.5,
        // The server resolved the CURRENT pair (USD->CAD) to 1.35.
        investmentForecastExchangeRate: 1.35,
      } as any)];
      const result = forecastPoints([cashAccount], transactions, 'month', 'cash-1');
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      // 1000 * 1.35 = 1350 posted (10000 - 1350), never 1500 from the stale rate.
      expect(jan20?.transactions[0].amount).toBe(-1350);
      expect(jan20?.balance).toBe(8650);
    });

    it('withholds the forecast when the current forecast rate is unknown', () => {
      const cashAccount = makeAccount({ id: 'cash-1', currentBalance: 10000 });
      const transactions = [makeScheduled({
        id: 'inv-1',
        name: 'Buy unpriceable security',
        accountId: 'brokerage-1',
        amount: -1000,
        frequency: 'ONCE',
        nextDueDate: '2025-01-20',
        isInvestment: true,
        investmentFundingAccountId: 'cash-1',
        investmentExchangeRate: 1.5, // stale scalar must not be used as a fallback
        investmentForecastExchangeRate: null, // current rate unavailable
        investmentSecurity: { currencyCode: 'USD' },
      } as any)];
      const result = buildForecast([cashAccount], transactions, 'month', 'cash-1');
      // Unknown -> the whole projection is withheld (no stale 1.50, no 1:1).
      expect(result.points).toEqual([]);
      expect(result.missingCurrencies).toContain('USD');
    });

    // Issue #1167 F-rev3.2: an embedded split-investment schedule (isSplit with
    // an investment split line) projects the server's effective total, not the
    // stale stored `amount`.
    it('projects the effective total for a split-investment schedule, not the stale amount', () => {
      const cashAccount = makeAccount({ id: 'cash-1', currentBalance: 10000 });
      const transactions = [makeScheduled({
        id: 'split-inv-1',
        name: 'Buy USD security (split)',
        accountId: 'cash-1',
        // Stale stored parent amount, computed at the old rate (1.50).
        amount: -1500,
        frequency: 'ONCE',
        nextDueDate: '2025-01-20',
        isSplit: true,
        splits: [
          {
            id: 's1',
            kind: 'investment',
            amount: -1500,
            investmentAction: 'BUY',
            investmentSecurityId: 'sec-usd',
          },
        ],
        // Server re-summed the base splits at the current rate (1.35) -> -1350.
        investmentForecastAmount: -1350,
      } as any)];
      const result = forecastPoints([cashAccount], transactions, 'month', 'cash-1');
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      expect(jan20?.transactions[0].amount).toBe(-1350);
      // 10000 - 1350, never the stale 1500.
      expect(jan20?.balance).toBe(8650);
    });

    it('withholds the forecast for a split-investment schedule whose effective total is unknown', () => {
      const cashAccount = makeAccount({ id: 'cash-1', currentBalance: 10000 });
      const transactions = [makeScheduled({
        id: 'split-inv-1',
        name: 'Buy unpriceable security (split)',
        accountId: 'cash-1',
        amount: -1500, // stale scalar must not be used as a fallback
        frequency: 'ONCE',
        nextDueDate: '2025-01-20',
        isSplit: true,
        splits: [
          {
            id: 's1',
            kind: 'investment',
            amount: -1500,
            investmentAction: 'BUY',
            investmentSecurityId: 'sec-usd',
          },
        ],
        // Current rate for at least one investment line is unknown.
        investmentForecastAmount: null,
      } as any)];
      const result = buildForecast([cashAccount], transactions, 'month', 'cash-1');
      expect(result.points).toEqual([]);
      expect(result.missingCurrencies.length).toBeGreaterThan(0);
    });

    it('withholds a split-investment schedule when the effective total is ABSENT (old backend, issue #1167 review MEDIUM-1)', () => {
      // Rolling deploy: a backend predating investmentForecastAmount omits it for
      // a split-investment schedule. The client cannot re-derive a split's
      // current-FX total from data it holds, so an absent value is unknown -- it
      // must NOT fall through to the stale stored parent `amount` (-1500, computed
      // at the old 1.50 rate). Withhold rather than project a stale figure.
      const cashAccount = makeAccount({ id: 'cash-1', currentBalance: 10000 });
      const transactions = [makeScheduled({
        id: 'split-inv-1',
        name: 'Buy USD security (split)',
        accountId: 'cash-1',
        amount: -1500, // stale scalar must not be used as a fallback
        frequency: 'ONCE',
        nextDueDate: '2025-01-20',
        isSplit: true,
        splits: [
          {
            id: 's1',
            kind: 'investment',
            amount: -1500,
            investmentAction: 'BUY',
            investmentSecurityId: 'sec-usd',
          },
        ],
        // investmentForecastAmount intentionally omitted (old backend).
      } as any)];
      const result = buildForecast([cashAccount], transactions, 'month', 'cash-1');
      expect(result.points).toEqual([]);
      expect(result.missingCurrencies.length).toBeGreaterThan(0);
    });

    it('leaves an ordinary (non-investment) split schedule on its stored amount', () => {
      const cashAccount = makeAccount({ id: 'cash-1', currentBalance: 10000 });
      const transactions = [makeScheduled({
        id: 'split-plain-1',
        name: 'Grocery split',
        accountId: 'cash-1',
        amount: -100,
        frequency: 'ONCE',
        nextDueDate: '2025-01-20',
        isSplit: true,
        splits: [
          { id: 's1', kind: 'category', amount: -60 },
          { id: 's2', kind: 'category', amount: -40 },
        ],
        // A plain split schedule carries no effective investment total.
        investmentForecastAmount: null,
      } as any)];
      const result = forecastPoints([cashAccount], transactions, 'month', 'cash-1');
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      expect(jan20?.transactions[0].amount).toBe(-100);
      expect(jan20?.balance).toBe(9900);
    });

    // Issue #1167 F5-2: a per-occurrence override with investment splits projects
    // the server's effective total, not the override's stale stored amount.
    it('projects an override investment split at its effective total, not the stale override amount', () => {
      const cashAccount = makeAccount({ id: 'cash-1', currentBalance: 10000 });
      const transactions = [makeScheduled({
        id: 'split-inv-ovr',
        name: 'DCA buy',
        accountId: 'cash-1',
        amount: -1350,
        frequency: 'ONCE',
        nextDueDate: '2025-01-20',
        isSplit: true,
        splits: [
          { id: 's1', kind: 'investment', amount: -1350, investmentAction: 'BUY', investmentSecurityId: 'sec-usd' },
        ],
        investmentForecastAmount: -1350,
        nextOverride: {
          overrideDate: '2025-01-20',
          amount: -1500, // stale snapshot at the old rate
          isSplit: true,
          splits: [
            { splitKind: 'investment', amount: -1500, investment: { action: 'BUY', securityId: 'sec-usd' } },
          ],
          // Server re-summed the override's splits at the current rate.
          investmentForecastAmount: -1350,
        },
      } as any)];
      const result = forecastPoints([cashAccount], transactions, 'month', 'cash-1');
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      expect(jan20?.transactions[0].amount).toBe(-1350);
      expect(jan20?.balance).toBe(8650);
    });

    it('projects an override that introduces an investment split over a plain base occurrence', () => {
      const cashAccount = makeAccount({ id: 'cash-1', currentBalance: 10000 });
      const transactions = [makeScheduled({
        id: 'plain-base-inv-ovr',
        name: 'Utility bill',
        accountId: 'cash-1',
        amount: -100, // plain base occurrence
        frequency: 'ONCE',
        nextDueDate: '2025-01-20',
        isSplit: false,
        // Base carries no investment splits.
        investmentForecastAmount: null,
        nextOverride: {
          overrideDate: '2025-01-20',
          amount: -1500,
          isSplit: true,
          splits: [
            { splitKind: 'investment', amount: -1500, investment: { action: 'BUY', securityId: 'sec-usd' } },
          ],
          investmentForecastAmount: -1350,
        },
      } as any)];
      const result = forecastPoints([cashAccount], transactions, 'month', 'cash-1');
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      // The override's effective total wins over both the base -100 and the
      // stale override -1500.
      expect(jan20?.transactions[0].amount).toBe(-1350);
      expect(jan20?.balance).toBe(8650);
    });

    it('withholds the forecast when an override investment split rate is unknown', () => {
      const cashAccount = makeAccount({ id: 'cash-1', currentBalance: 10000 });
      const transactions = [makeScheduled({
        id: 'split-inv-ovr-unknown',
        name: 'DCA buy',
        accountId: 'cash-1',
        amount: -1350,
        frequency: 'ONCE',
        nextDueDate: '2025-01-20',
        isSplit: true,
        splits: [
          { id: 's1', kind: 'investment', amount: -1350, investmentAction: 'BUY', investmentSecurityId: 'sec-usd' },
        ],
        investmentForecastAmount: -1350, // base is known...
        nextOverride: {
          overrideDate: '2025-01-20',
          amount: -1500,
          isSplit: true,
          splits: [
            { splitKind: 'investment', amount: -1500, investment: { action: 'BUY', securityId: 'sec-usd' } },
          ],
          investmentForecastAmount: null, // ...but this occurrence's rate is not
        },
      } as any)];
      const result = buildForecast([cashAccount], transactions, 'month', 'cash-1');
      expect(result.points).toEqual([]);
      expect(result.missingCurrencies.length).toBeGreaterThan(0);
    });

    // Issue #1167 Round 6 F3: a top-level investment override (quantity/price/total,
    // not embedded splits) projects its server-resolved effective amount.
    it('projects a top-level investment override quantity change, not the base amount', () => {
      const cashAccount = makeAccount({ id: 'cash-1', currentBalance: 10000 });
      const transactions = [makeScheduled({
        id: 'inv-topovr',
        name: 'DCA buy',
        accountId: 'cash-1',
        amount: -1000, // security-currency base cash impact (10 x 100)
        frequency: 'ONCE',
        nextDueDate: '2025-01-20',
        isInvestment: true,
        investmentFundingAccountId: 'cash-1',
        investmentForecastExchangeRate: 1.35,
        // Override doubled the quantity; the server resolved the effective cash.
        nextOverride: {
          overrideDate: '2025-01-20',
          amount: null, // top-level investment overrides store qty/price/total
          investmentQuantity: 20,
          investmentForecastAmount: -2700, // 20 x 100 x 1.35
        },
      } as any)];
      const result = forecastPoints([cashAccount], transactions, 'month', 'cash-1');
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      // -2700 (override) posted, never the base -1350.
      expect(jan20?.transactions[0].amount).toBe(-2700);
      expect(jan20?.balance).toBe(7300);
    });

    it('withholds when a top-level investment override has an unknown effective amount', () => {
      const cashAccount = makeAccount({ id: 'cash-1', currentBalance: 10000 });
      const transactions = [makeScheduled({
        id: 'inv-topovr-unknown',
        name: 'DCA buy',
        accountId: 'cash-1',
        amount: -1000,
        frequency: 'ONCE',
        nextDueDate: '2025-01-20',
        isInvestment: true,
        investmentFundingAccountId: 'cash-1',
        investmentForecastExchangeRate: 1.35,
        nextOverride: {
          overrideDate: '2025-01-20',
          amount: null,
          investmentQuantity: 20,
          investmentForecastAmount: null, // current rate unknown for this occurrence
        },
      } as any)];
      const result = buildForecast([cashAccount], transactions, 'month', 'cash-1');
      expect(result.points).toEqual([]);
      expect(result.missingCurrencies.length).toBeGreaterThan(0);
    });
  });

  describe('multiple accounts and transactions', () => {
    it('sums balances from multiple accounts', () => {
      const accounts = [
        makeAccount({ id: 'acc-1', currentBalance: 1000 }),
        makeAccount({ id: 'acc-2', currentBalance: 2000 }),
      ];
      const result = forecastPoints(accounts, [], 'week', 'all');
      expect(result[0].balance).toBe(3000);
    });

    it('handles multiple transactions on the same day', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [
        makeScheduled({
          id: 'st-1',
          name: 'Rent',
          nextDueDate: '2025-01-20',
          amount: -1000,
          frequency: 'ONCE',
        }),
        makeScheduled({
          id: 'st-2',
          name: 'Salary',
          nextDueDate: '2025-01-20',
          amount: 3000,
          frequency: 'ONCE',
        }),
      ];
      const result = forecastPoints(accounts, transactions, 'month', 'all');
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      expect(jan20?.balance).toBe(7000); // 5000 - 1000 + 3000
      expect(jan20?.transactions.length).toBe(2);
    });
  });

  // --- Override only applies to next due date ---
  describe('override applies only to next due date', () => {
    it('uses base amount for subsequent occurrences after override', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -500,
        frequency: 'WEEKLY',
        nextOverride: { amount: -300 } as any,
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'all');
      // Jan 15 uses override: -300, balance = 4700
      const jan15 = result.find(dp => dp.date === '2025-01-15');
      expect(jan15?.balance).toBe(4700);
      // Jan 22 uses base amount: -500, balance = 4200
      const jan22 = result.find(dp => dp.date === '2025-01-22');
      expect(jan22?.balance).toBe(4200);
    });
  });

  // --- Override date shifting ---
  describe('override date shifting', () => {
    it('moves next occurrence to override date on chart', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -500,
        frequency: 'MONTHLY',
        futureOverrides: [{
          originalDate: '2025-01-15',
          overrideDate: '2025-01-20',
          amount: null,
        }] as any,
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'all');
      // Should NOT appear on Jan 15
      const jan15 = result.find(dp => dp.date === '2025-01-15');
      expect(jan15?.transactions.length ?? 0).toBe(0);
      // Should appear on Jan 20 with base amount
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      expect(jan20?.transactions.length).toBe(1);
      expect(jan20?.balance).toBe(4500);
    });

    it('moves ONCE occurrence to override date', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -500,
        frequency: 'ONCE',
        futureOverrides: [{
          originalDate: '2025-01-15',
          overrideDate: '2025-01-25',
          amount: null,
        }] as any,
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'all');
      const jan15 = result.find(dp => dp.date === '2025-01-15');
      expect(jan15?.transactions.length ?? 0).toBe(0);
      const jan25 = result.find(dp => dp.date === '2025-01-25');
      expect(jan25?.transactions.length).toBe(1);
      expect(jan25?.balance).toBe(4500);
    });

    it('applies both override date and amount', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -500,
        frequency: 'MONTHLY',
        futureOverrides: [{
          originalDate: '2025-01-15',
          overrideDate: '2025-01-20',
          amount: -800,
        }] as any,
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'all');
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      expect(jan20?.transactions.length).toBe(1);
      expect(jan20?.balance).toBe(4200); // 5000 - 800
    });

    it('does not shift subsequent occurrences (only the overridden one)', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -500,
        frequency: 'MONTHLY',
        futureOverrides: [{
          originalDate: '2025-01-15',
          overrideDate: '2025-01-20',
          amount: null,
        }] as any,
      })];
      const result = forecastPoints(accounts, transactions, '90days', 'all');
      // Feb 15 should still appear at its normal date
      const feb15 = result.find(dp => dp.date === '2025-02-15');
      expect(feb15?.transactions.length).toBe(1);
    });
  });

  // --- futureOverrides for multiple occurrences ---
  describe('futureOverrides for multiple occurrences', () => {
    it('applies overrides to multiple future occurrences', () => {
      const accounts = [makeAccount({ currentBalance: 10000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -500,
        frequency: 'MONTHLY',
        futureOverrides: [
          { originalDate: '2025-01-15', overrideDate: '2025-01-15', amount: -300 },
          { originalDate: '2025-02-15', overrideDate: '2025-02-15', amount: -700 },
          { originalDate: '2025-03-15', overrideDate: '2025-03-20', amount: -100 },
        ] as any,
      })];
      const result = forecastPoints(accounts, transactions, '90days', 'all');
      // Jan 15: override amount -300, balance = 9700
      const jan15 = result.find(dp => dp.date === '2025-01-15');
      expect(jan15?.balance).toBe(9700);
      // Feb 15: override amount -700, balance = 9000
      const feb15 = result.find(dp => dp.date === '2025-02-15');
      expect(feb15?.balance).toBe(9000);
      // Mar 15: moved to Mar 20, so no transaction on Mar 15
      const mar15 = result.find(dp => dp.date === '2025-03-15');
      expect(mar15?.transactions.length ?? 0).toBe(0);
      // Mar 20: override amount -100, balance = 8900
      const mar20 = result.find(dp => dp.date === '2025-03-20');
      expect(mar20?.transactions.length).toBe(1);
      expect(mar20?.balance).toBe(8900);
    });

    it('uses base amount for occurrences without overrides', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -500,
        frequency: 'MONTHLY',
        futureOverrides: [
          { originalDate: '2025-01-15', overrideDate: '2025-01-15', amount: -200 },
        ] as any,
      })];
      const result = forecastPoints(accounts, transactions, '90days', 'all');
      // Jan 15: override amount -200
      const jan15 = result.find(dp => dp.date === '2025-01-15');
      expect(jan15?.balance).toBe(4800);
      // Feb 15: base amount -500 (no override)
      const feb15 = result.find(dp => dp.date === '2025-02-15');
      expect(feb15?.balance).toBe(4300);
    });

    it('falls back to nextOverride when futureOverrides is empty', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -500,
        frequency: 'ONCE',
        futureOverrides: [],
        nextOverride: {
          originalDate: '2025-01-15',
          overrideDate: '2025-01-20',
          amount: -300,
        } as any,
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'all');
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      expect(jan20?.transactions.length).toBe(1);
      expect(jan20?.balance).toBe(4700);
    });
  });

  // --- ONCE frequency ---
  describe('ONCE frequency', () => {
    // Discussion #1784: a ONCE occurrence still unposted after its date is
    // owed, so it lands on the first forecast day instead of vanishing.
    it('carries an overdue ONCE transaction onto today', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-10', // Before "today" Jan 15
        amount: -500,
        frequency: 'ONCE',
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'all');
      expect(result[0].date).toBe('2025-01-15');
      expect(result[0].balance).toBe(4500);
      expect(result[0].transactions).toEqual([
        expect.objectContaining({ amount: -500, overdueOriginalDate: '2025-01-10' }),
      ]);
      expect(result.every(dp => dp.balance === 4500)).toBe(true);
    });

    it('does not include ONCE transaction if past endDate', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-20',
        amount: -500,
        frequency: 'ONCE',
        endDate: '2025-01-18',
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'all');
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      expect(jan20?.transactions.length ?? 0).toBe(0);
    });
  });

  // --- Overdue occurrences (discussion #1784) ---
  describe('overdue occurrences', () => {
    const on = (points: ReturnType<typeof forecastPoints>, date: string) =>
      points.find(dp => dp.date === date);
    const overdueOf = (points: ReturnType<typeof forecastPoints>) =>
      points.flatMap(dp => dp.transactions).filter(tx => tx.overdueOriginalDate !== undefined);

    it('applies each overdue occurrence once, on today, tagged with its slot', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-01',
        amount: -100,
        frequency: 'WEEKLY',
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'all');
      // Jan 1 and Jan 8 are overdue; Jan 15 is due today and is not.
      expect(result[0].date).toBe('2025-01-15');
      expect(result[0].balance).toBe(4700);
      expect(result[0].transactions.map(tx => tx.overdueOriginalDate)).toEqual([
        '2025-01-01', '2025-01-08', undefined,
      ]);
      expect(countOverdueOccurrences(result[0].transactions)).toBe(2);
      expect(overdueOf(result)).toHaveLength(2);
      expect(on(result, '2025-01-22')?.balance).toBe(4600);
    });

    it('applies an overdue slot an override moved into the window on its new date, unmarked', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-10',
        amount: -500,
        frequency: 'MONTHLY',
        futureOverrides: [{
          originalDate: '2025-01-10',
          overrideDate: '2025-01-20',
          amount: null,
        }] as any,
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'all');
      expect(result[0].transactions).toEqual([]);
      expect(result[0].balance).toBe(5000);
      const jan20 = on(result, '2025-01-20');
      expect(jan20?.transactions).toHaveLength(1);
      expect(jan20?.transactions[0].overdueOriginalDate).toBeUndefined();
      expect(jan20?.balance).toBe(4500);
      expect(overdueOf(result)).toEqual([]);
      // The next slot is unaffected, and nothing was counted twice.
      expect(on(result, '2025-02-10')?.balance).toBe(4000);
    });

    it('counts an occurrence an override moved into the past as overdue', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-20',
        amount: -500,
        frequency: 'MONTHLY',
        futureOverrides: [{
          originalDate: '2025-01-20',
          overrideDate: '2025-01-12',
          amount: -650,
        }] as any,
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'all');
      expect(result[0].balance).toBe(4350);
      expect(result[0].transactions).toEqual([
        expect.objectContaining({ amount: -650, overdueOriginalDate: '2025-01-20' }),
      ]);
      expect(on(result, '2025-01-20')?.transactions.length ?? 0).toBe(0);
    });

    it('carries nothing once the overdue slot was skipped or posted', () => {
      // Posting and skipping both advance next_due_date past the slot.
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-02-10',
        amount: -500,
        frequency: 'MONTHLY',
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'all');
      expect(result[0].balance).toBe(5000);
      expect(overdueOf(result)).toEqual([]);
    });

    it('carries nothing for an inactive schedule', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-01',
        amount: -100,
        frequency: 'WEEKLY',
        isActive: false,
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'all');
      expect(result.every(dp => dp.balance === 5000)).toBe(true);
    });

    it('stops at the schedule endDate, overdue slots included', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-01',
        amount: -100,
        frequency: 'WEEKLY',
        endDate: '2025-01-05',
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'all');
      expect(countOverdueOccurrences(result[0].transactions)).toBe(1);
      expect(result.every(dp => dp.balance === 4900)).toBe(true);
    });

    it('spends occurrencesRemaining on the overdue slots first', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-01',
        amount: -100,
        frequency: 'WEEKLY',
        occurrencesRemaining: 3,
      })];
      const result = forecastPoints(accounts, transactions, 'month', 'all');
      // Jan 1 and Jan 8 overdue, Jan 15 on time: three, and none after.
      expect(result[0].transactions).toHaveLength(3);
      expect(countOverdueOccurrences(result[0].transactions)).toBe(2);
      expect(on(result, '2025-01-22')?.transactions.length ?? 0).toBe(0);
      expect(result[result.length - 1].balance).toBe(4700);
    });

    it('credits an overdue transfer to its destination and debits its source', () => {
      const transfer = makeScheduled({
        nextDueDate: '2025-01-10',
        amount: -500,
        frequency: 'ONCE',
        isTransfer: true,
        accountId: 'acc-1',
        transferAccountId: 'acc-2',
      });
      const accounts = [
        makeAccount({ id: 'acc-1', currentBalance: 1000 }),
        makeAccount({ id: 'acc-2', currentBalance: 1000 }),
      ];
      const source = forecastPoints(accounts, [transfer], 'month', 'acc-1');
      expect(source[0].balance).toBe(500);
      expect(countOverdueOccurrences(source[0].transactions)).toBe(1);
      const destination = forecastPoints(accounts, [transfer], 'month', 'acc-2');
      expect(destination[0].balance).toBe(1500);
      expect(countOverdueOccurrences(destination[0].transactions)).toBe(1);
    });

    it('withholds the series when an overdue occurrence cannot be priced', () => {
      const cashAccount = makeAccount({ id: 'cash-1', currentBalance: 10000 });
      const transactions = [makeScheduled({
        id: 'split-inv-1',
        accountId: 'cash-1',
        amount: -1500,
        frequency: 'ONCE',
        nextDueDate: '2025-01-10',
        isSplit: true,
        splits: [{
          id: 's1',
          kind: 'investment',
          amount: -1500,
          investmentAction: 'BUY',
          investmentSecurityId: 'sec-usd',
        }],
        investmentForecastAmount: null,
      } as any)];
      const result = buildForecast([cashAccount], transactions, 'month', 'cash-1');
      expect(result.points).toEqual([]);
      expect(result.missingCurrencies.length).toBeGreaterThan(0);
    });

    it(`carries only the last ${OVERDUE_CARRY_DAYS} days of a forgotten schedule`, () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2024-11-01',
        amount: -1,
        frequency: 'DAILY',
      })];
      const result = forecastPoints(accounts, transactions, 'week', 'all');
      // Dec 15 to Jan 14 are carried, and Jan 15 is due on time.
      expect(countOverdueOccurrences(result[0].transactions)).toBe(OVERDUE_CARRY_DAYS);
      expect(result[0].balance).toBe(5000 - OVERDUE_CARRY_DAYS - 1);
    });

    it('carries an occurrence exactly at the edge of the window', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const edge = makeScheduled({ nextDueDate: '2024-12-15', amount: -100, frequency: 'ONCE' });
      const beyond = makeScheduled({ id: 'st-2', nextDueDate: '2024-12-14', amount: -100, frequency: 'ONCE' });
      const result = forecastPoints(accounts, [edge, beyond], 'week', 'all');
      expect(countOverdueOccurrences(result[0].transactions)).toBe(1);
      expect(result[0].balance).toBe(4900);
    });

    it('bounds the catch-up walk at 2000 steps, as the server does', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2015-01-01',
        amount: -1,
        frequency: 'DAILY',
      })];
      const result = forecastPoints(accounts, transactions, 'week', 'all');
      // The walk stops in mid-2020, long before the carry window opens.
      expect(countOverdueOccurrences(result[0].transactions)).toBe(0);
      expect(result[0].balance).toBe(5000);
    });
  });

  // --- Future transactions support ---
  describe('future transactions', () => {
    it('uses currentBalance directly as starting balance (future transactions excluded by backend)', () => {
      const accounts = [makeAccount({ id: 'acc-1', currentBalance: 5000 })];
      const futureTransactions: FutureTransaction[] = [
        { id: 'ft-1', accountId: 'acc-1', name: 'Future Bill', amount: -1000, date: '2025-01-20' },
      ];
      const result = forecastPoints(accounts, [], 'week', 'all', futureTransactions);
      // currentBalance excludes future transactions, so starting balance is 5000
      expect(result[0].balance).toBe(5000);
    });

    it('adds future transactions at their correct dates', () => {
      const accounts = [makeAccount({ id: 'acc-1', currentBalance: 5000 })];
      const futureTransactions: FutureTransaction[] = [
        { id: 'ft-1', accountId: 'acc-1', name: 'Future Bill', amount: -1000, date: '2025-01-20' },
      ];
      const result = forecastPoints(accounts, [], 'month', 'all', futureTransactions);
      // Starting balance is 5000, then -1000 applied on Jan 20
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      expect(jan20).toBeDefined();
      expect(jan20?.balance).toBe(4000); // 5000 + (-1000) = 4000
      expect(jan20?.transactions.length).toBe(1);
      expect(jan20?.transactions[0].name).toBe('Future Bill');
    });

    it('filters future transactions by selected account', () => {
      const accounts = [
        makeAccount({ id: 'acc-1', currentBalance: 3000 }),
        makeAccount({ id: 'acc-2', currentBalance: 2000 }),
      ];
      const futureTransactions: FutureTransaction[] = [
        { id: 'ft-1', accountId: 'acc-1', name: 'Acc1 Future', amount: -500, date: '2025-01-20' },
        { id: 'ft-2', accountId: 'acc-2', name: 'Acc2 Future', amount: -300, date: '2025-01-20' },
      ];
      // Filter to acc-1 only
      const result = forecastPoints(accounts, [], 'month', 'acc-1', futureTransactions);
      // Starting: 3000 (currentBalance), then -500 on Jan 20 = 2500
      expect(result[0].balance).toBe(3000);
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      expect(jan20?.balance).toBe(2500);
      // acc-2's future transaction should not appear
      expect(jan20?.transactions.length).toBe(1);
      expect(jan20?.transactions[0].name).toBe('Acc1 Future');
    });

    it('ignores future transactions dated today or earlier', () => {
      const accounts = [makeAccount({ id: 'acc-1', currentBalance: 5000 })];
      const futureTransactions: FutureTransaction[] = [
        { id: 'ft-1', accountId: 'acc-1', name: 'Today Tx', amount: -500, date: '2025-01-15' }, // today
        { id: 'ft-2', accountId: 'acc-1', name: 'Past Tx', amount: -300, date: '2025-01-10' }, // past
      ];
      // Neither should be subtracted (filter is ft.date > todayKey)
      const result = forecastPoints(accounts, [], 'week', 'all', futureTransactions);
      expect(result[0].balance).toBe(5000);
    });

    it('works alongside scheduled transactions', () => {
      const accounts = [makeAccount({ id: 'acc-1', currentBalance: 5000 })];
      const scheduled = [makeScheduled({
        nextDueDate: '2025-01-20',
        amount: -200,
        frequency: 'ONCE',
      })];
      const futureTransactions: FutureTransaction[] = [
        { id: 'ft-1', accountId: 'acc-1', name: 'Future Bill', amount: -1000, date: '2025-01-20' },
      ];
      const result = forecastPoints(accounts, scheduled, 'month', 'all', futureTransactions);
      // Starting: 5000
      // Jan 20: 5000 + (-1000) + (-200) = 3800
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      expect(jan20?.balance).toBe(3800);
      expect(jan20?.transactions.length).toBe(2);
    });

    it('defaults to empty when futureTransactions not provided', () => {
      const accounts = [makeAccount({ currentBalance: 1000 })];
      const result = forecastPoints(accounts, [], 'week', 'all');
      expect(result[0].balance).toBe(1000);
    });
  });

  // --- Currency conversion via convertAmount ---
  describe('convertAmount parameter', () => {
    it('converts starting balances when convertAmount is provided', () => {
      const accounts = [
        makeAccount({ id: 'acc-1', currentBalance: 1000, currencyCode: 'USD' }),
        makeAccount({ id: 'acc-2', currentBalance: 500, currencyCode: 'EUR' }),
      ];
      // USD*1.35, EUR*1.50 -> 1350 + 750 = 2100
      const convertAmount = (amount: number, currency: string) => {
        if (currency === 'USD') return amount * 1.35;
        if (currency === 'EUR') return amount * 1.50;
        return amount;
      };
      const result = forecastPoints(accounts, [], 'week', 'all', [], convertAmount);
      expect(result[0].balance).toBe(2100);
    });

    it('converts transaction amounts through convertAmount', () => {
      const accounts = [
        makeAccount({ id: 'acc-1', currentBalance: 1000, currencyCode: 'USD' }),
      ];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-20',
        amount: -500,
        frequency: 'ONCE',
        accountId: 'acc-1',
      })];
      // USD*2 -> starting 2000, tx -1000 -> 1000
      const convertAmount = (amount: number, currency: string) => {
        if (currency === 'USD') return amount * 2;
        return amount;
      };
      const result = forecastPoints(accounts, transactions, 'month', 'all', [], convertAmount);
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      expect(jan20?.balance).toBe(1000);
    });

    it('does not convert when convertAmount is undefined', () => {
      const accounts = [
        makeAccount({ id: 'acc-1', currentBalance: 1000, currencyCode: 'USD' }),
        makeAccount({ id: 'acc-2', currentBalance: 500, currencyCode: 'EUR' }),
      ];
      const result = forecastPoints(accounts, [], 'week', 'all', [], undefined);
      // Raw sum without conversion
      expect(result[0].balance).toBe(1500);
    });

    it('converts future transaction amounts through convertAmount', () => {
      const accounts = [
        makeAccount({ id: 'acc-1', currentBalance: 1000, currencyCode: 'USD' }),
      ];
      const futureTransactions: FutureTransaction[] = [
        { id: 'ft-1', accountId: 'acc-1', name: 'Future Bill', amount: -200, date: '2025-01-20' },
      ];
      // USD*1.5 -> starting 1500, tx -300 -> 1200
      const convertAmount = (amount: number, currency: string) => {
        if (currency === 'USD') return amount * 1.5;
        return amount;
      };
      const result = forecastPoints(accounts, [], 'month', 'all', futureTransactions, convertAmount);
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      expect(jan20?.balance).toBe(1200);
    });

    it('converts inbound transfer amounts using destination account currency', () => {
      const accounts = [
        makeAccount({ id: 'acc-2', currentBalance: 500, currencyCode: 'EUR' }),
      ];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-20',
        amount: -100,
        frequency: 'ONCE',
        isTransfer: true,
        transferAccountId: 'acc-2',
        accountId: 'acc-1',
      })];
      // EUR*2 -> starting 1000, inbound transfer +100 converted -> +200 -> 1200
      const convertAmount = (amount: number, currency: string) => {
        if (currency === 'EUR') return amount * 2;
        return amount;
      };
      const result = forecastPoints(accounts, transactions, 'month', 'acc-2', [], convertAmount);
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      expect(jan20?.balance).toBe(1200);
    });
  });

});

describe('getForecastSummary', () => {
  it('returns zeros for empty data', () => {
    const summary = getForecastSummary([]);
    expect(summary.startingBalance).toBe(0);
    expect(summary.endingBalance).toBe(0);
    expect(summary.goesNegative).toBe(false);
  });

  it('calculates min/max/starting/ending balances', () => {
    const dataPoints = [
      { date: '2025-01-01', balance: 1000, transactions: [] },
      { date: '2025-01-15', balance: 500, transactions: [] },
      { date: '2025-01-31', balance: 1500, transactions: [] },
    ];
    const summary = getForecastSummary(dataPoints);
    expect(summary.startingBalance).toBe(1000);
    expect(summary.endingBalance).toBe(1500);
    expect(summary.minBalance).toBe(500);
    expect(summary.maxBalance).toBe(1500);
    expect(summary.goesNegative).toBe(false);
  });

  it('detects negative balances', () => {
    const dataPoints = [
      { date: '2025-01-01', balance: 100, transactions: [] },
      { date: '2025-01-15', balance: -50, transactions: [] },
    ];
    const summary = getForecastSummary(dataPoints);
    expect(summary.goesNegative).toBe(true);
  });

  it('handles single data point', () => {
    const dataPoints = [
      { date: '2025-01-01', balance: 1000, transactions: [] },
    ];
    const summary = getForecastSummary(dataPoints);
    expect(summary.startingBalance).toBe(1000);
    expect(summary.endingBalance).toBe(1000);
    expect(summary.minBalance).toBe(1000);
    expect(summary.maxBalance).toBe(1000);
    expect(summary.goesNegative).toBe(false);
  });

  it('starts from the balance before the overdue occurrences carried onto the first day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 0, 15));
    try {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({ nextDueDate: '2025-01-10', amount: -500, frequency: 'ONCE' })];
      const points = buildForecast(accounts, transactions, 'month', 'all').points;
      expect(points[0].balance).toBe(4500);
      expect(getForecastSummary(points).startingBalance).toBe(5000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('detects goesNegative as false when min balance is exactly zero', () => {
    const dataPoints = [
      { date: '2025-01-01', balance: 100, transactions: [] },
      { date: '2025-01-15', balance: 0, transactions: [] },
    ];
    const summary = getForecastSummary(dataPoints);
    expect(summary.goesNegative).toBe(false);
  });
});

describe('getProjectedBalanceAtDate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 0, 15)); // Jan 15, 2025
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns current balance when no transactions affect the account', () => {
    const account = makeAccount({ currentBalance: 5000 });
    const result = getProjectedBalanceAtDate(account, '2025-01-20', [], []);
    expect(result).toBe(5000);
  });

  // The posting dialog's 'balance before' reads this; discussion #1784 left
  // it as it was, so an overdue occurrence is not carried into it.
  it('does not carry overdue occurrences', () => {
    const account = makeAccount({ currentBalance: 5000 });
    const scheduled = [makeScheduled({
      nextDueDate: '2025-01-10',
      amount: -500,
      frequency: 'ONCE',
    })];
    expect(getProjectedBalanceAtDate(account, '2025-01-25', scheduled, [])).toBe(5000);
  });

  it('includes scheduled transaction occurrences up to target date', () => {
    const account = makeAccount({ currentBalance: 5000 });
    const scheduled = [makeScheduled({
      nextDueDate: '2025-01-20',
      amount: -500,
      frequency: 'ONCE',
    })];
    const result = getProjectedBalanceAtDate(account, '2025-01-25', scheduled, []);
    expect(result).toBe(4500);
  });

  it('excludes scheduled transactions for other accounts', () => {
    const account = makeAccount({ id: 'acc-1', currentBalance: 5000 });
    const scheduled = [makeScheduled({
      accountId: 'acc-2',
      nextDueDate: '2025-01-20',
      amount: -500,
      frequency: 'ONCE',
    })];
    const result = getProjectedBalanceAtDate(account, '2025-01-25', scheduled, []);
    expect(result).toBe(5000);
  });

  it('excludes the specified scheduled transaction id', () => {
    const account = makeAccount({ currentBalance: 5000 });
    const scheduled = [
      makeScheduled({ id: 'st-1', nextDueDate: '2025-01-20', amount: -500, frequency: 'ONCE' }),
      makeScheduled({ id: 'st-2', nextDueDate: '2025-01-20', amount: -200, frequency: 'ONCE' }),
    ];
    const result = getProjectedBalanceAtDate(account, '2025-01-25', scheduled, [], 'st-1');
    // Only st-2 is applied
    expect(result).toBe(4800);
  });

  it('includes future posted transactions up to target date', () => {
    const account = makeAccount({ id: 'acc-1', currentBalance: 5000 });
    const futureTransactions: FutureTransaction[] = [
      { id: 'ft-1', accountId: 'acc-1', name: 'Future Bill', amount: -1000, date: '2025-01-20' },
    ];
    const result = getProjectedBalanceAtDate(account, '2025-01-25', [], futureTransactions);
    expect(result).toBe(4000);
  });

  it('includes inbound transfers for destination account', () => {
    const account = makeAccount({ id: 'acc-2', currentBalance: 1000 });
    const scheduled = [makeScheduled({
      id: 'st-1',
      accountId: 'acc-1',
      nextDueDate: '2025-01-20',
      amount: -500,
      frequency: 'ONCE',
      isTransfer: true,
      transferAccountId: 'acc-2',
    })];
    const result = getProjectedBalanceAtDate(account, '2025-01-25', scheduled, []);
    // Inbound transfer: negate the -500 to get +500
    expect(result).toBe(1500);
  });

  it('handles multiple recurring occurrences within range', () => {
    const account = makeAccount({ currentBalance: 5000 });
    const scheduled = [makeScheduled({
      nextDueDate: '2025-01-15',
      amount: -200,
      frequency: 'WEEKLY',
    })];
    // Jan 15, Jan 22, Jan 29 = 3 occurrences
    const result = getProjectedBalanceAtDate(account, '2025-01-29', scheduled, []);
    expect(result).toBe(4400); // 5000 - 3*200
  });

  it('applies scheduled investment BUYs to the funding cash account', () => {
    const cashAccount = makeAccount({ id: 'cash-1', currentBalance: 10000 });
    const scheduled = [makeScheduled({
      id: 'inv-1',
      accountId: 'brokerage-1',
      amount: -1500,
      frequency: 'ONCE',
      nextDueDate: '2025-01-20',
      isInvestment: true,
      investmentFundingAccountId: 'cash-1',
      investmentForecastExchangeRate: 1,
    } as any)];
    const result = getProjectedBalanceAtDate(cashAccount, '2025-01-25', scheduled, []);
    expect(result).toBe(8500);
  });

  it('returns null when an investment occurrence has unknown current FX (issue #1167 review)', () => {
    // An explicit null forecast rate means the current settlement pair could not
    // be resolved. The projected balance the user approves a posting against must
    // not fold in the stale/raw amount (or 0) -- it is unknowable from here on,
    // exactly as buildForecast withholds the whole series.
    const cashAccount = makeAccount({ id: 'cash-1', currentBalance: 10000 });
    const scheduled = [makeScheduled({
      id: 'inv-1',
      accountId: 'brokerage-1',
      amount: -1500,
      frequency: 'ONCE',
      nextDueDate: '2025-01-20',
      isInvestment: true,
      investmentFundingAccountId: 'cash-1',
      investmentForecastExchangeRate: null,
    } as any)];
    const result = getProjectedBalanceAtDate(cashAccount, '2025-01-25', scheduled, []);
    expect(result).toBeNull();
  });

  it('does not withhold when the forecast-rate field is ABSENT and the derived pair is same-currency (rolling deploy)', () => {
    // A backend predating the forecast-rate field (#1167) sends no
    // investmentForecastExchangeRate. Treating absent as unknown would blank the
    // projection during a rolling deploy; instead the client derives the current
    // settlement pair from the accounts it holds -- here a CAD security settling
    // into a CAD cash account -- and a same-currency pair is always rate 1, so
    // the projection is NOT withheld and needs no persisted scalar.
    const brokerage = makeAccount({ id: 'brokerage-1', currencyCode: 'CAD' });
    const cashAccount = makeAccount({
      id: 'cash-1',
      currencyCode: 'CAD',
      currentBalance: 10000,
    });
    const scheduled = [makeScheduled({
      id: 'inv-1',
      accountId: 'brokerage-1',
      amount: -1500,
      frequency: 'ONCE',
      nextDueDate: '2025-01-20',
      isInvestment: true,
      investmentSecurity: { currencyCode: 'CAD' },
      investmentFundingAccountId: 'cash-1',
      // A persisted scalar is present but must be ignored: same-currency is 1.
      investmentExchangeRate: 1,
      // investmentForecastExchangeRate intentionally omitted (old backend).
    } as any)];
    const result = getProjectedBalanceAtDate(
      cashAccount,
      '2025-01-25',
      scheduled,
      [],
      undefined,
      [brokerage, cashAccount],
    );
    expect(result).toBe(8500);
  });

  it('withholds (does not trust an UNPROVENANCED persisted scalar) when the forecast field is ABSENT on a cross-currency pair (issue #1167 review MEDIUM-1)', () => {
    // Rolling deploy: an old backend omits investmentForecastExchangeRate. The
    // security is USD and the cash account CAD, so the derived pair is
    // cross-currency. A persisted investmentExchangeRate of 1.30 is present and
    // positive, but it carries NO recorded currency-pair provenance -- it may be
    // a rate for a pair the security or account has since moved off of. An
    // unprovenanced scalar is unknown, not current, so projecting the USD->CAD
    // BUY of -1,000 at 1.30 (a plausible -1,300) would fabricate a figure. The
    // occurrence is withheld instead.
    const brokerage = makeAccount({ id: 'brokerage-1', currencyCode: 'USD' });
    const cashAccount = makeAccount({
      id: 'cash-1',
      currencyCode: 'CAD',
      currentBalance: 10000,
    });
    const scheduled = [makeScheduled({
      id: 'inv-1',
      accountId: 'brokerage-1',
      amount: -1000,
      frequency: 'ONCE',
      nextDueDate: '2025-01-20',
      isInvestment: true,
      investmentSecurity: { currencyCode: 'USD' },
      investmentFundingAccountId: 'cash-1',
      investmentExchangeRate: 1.3,
      // No investmentExchangeRate{From,To}Currency provenance recorded.
      // investmentForecastExchangeRate intentionally omitted (old backend).
    } as any)];
    const result = getProjectedBalanceAtDate(
      cashAccount,
      '2025-01-25',
      scheduled,
      [],
      undefined,
      [brokerage, cashAccount],
    );
    expect(result).toBeNull();
  });

  it('reuses a PROVENANCE-MATCHED persisted scalar when the forecast field is ABSENT (issue #1167 review MEDIUM-1)', () => {
    // Same rolling-deploy cross-currency pair (USD security -> CAD cash), but now
    // the persisted investmentExchangeRate of 1.35 carries provenance proving it
    // was resolved for exactly this USD->CAD pair. That is the one case an absent
    // forecast field may fall back to the scalar: it is the rate the old backend
    // would itself post at, so forecast/post parity holds. The -1,000 USD BUY
    // projects at 1.35 -> -1,350 CAD, leaving 10,000 - 1,350 = 8,650.
    const brokerage = makeAccount({ id: 'brokerage-1', currencyCode: 'USD' });
    const cashAccount = makeAccount({
      id: 'cash-1',
      currencyCode: 'CAD',
      currentBalance: 10000,
    });
    const scheduled = [makeScheduled({
      id: 'inv-1',
      accountId: 'brokerage-1',
      amount: -1000,
      frequency: 'ONCE',
      nextDueDate: '2025-01-20',
      isInvestment: true,
      investmentSecurity: { currencyCode: 'USD' },
      investmentFundingAccountId: 'cash-1',
      investmentExchangeRate: 1.35,
      investmentExchangeRateFromCurrency: 'USD',
      investmentExchangeRateToCurrency: 'CAD',
      // investmentForecastExchangeRate intentionally omitted (old backend).
    } as any)];
    const result = getProjectedBalanceAtDate(
      cashAccount,
      '2025-01-25',
      scheduled,
      [],
      undefined,
      [brokerage, cashAccount],
    );
    expect(result).toBe(8650);
  });

  it('withholds when the forecast field is ABSENT and the persisted scalar is null (issue #1167 review MEDIUM-1)', () => {
    // A cross-currency pair (USD security -> CAD cash) whose old backend persisted
    // investmentExchangeRate: null (the parent-investment form does not submit a
    // rate). There is no scalar to fall back to and same-currency does not apply,
    // so the occurrence is unknown and the projected balance is withheld -- never
    // invented at 1:1.
    const brokerage = makeAccount({ id: 'brokerage-1', currencyCode: 'USD' });
    const cashAccount = makeAccount({
      id: 'cash-1',
      currencyCode: 'CAD',
      currentBalance: 10000,
    });
    const scheduled = [makeScheduled({
      id: 'inv-1',
      accountId: 'brokerage-1',
      amount: -1000,
      frequency: 'ONCE',
      nextDueDate: '2025-01-20',
      isInvestment: true,
      investmentSecurity: { currencyCode: 'USD' },
      investmentFundingAccountId: 'cash-1',
      investmentExchangeRate: null,
      // investmentForecastExchangeRate intentionally omitted (old backend).
    } as any)];
    const result = getProjectedBalanceAtDate(
      cashAccount,
      '2025-01-25',
      scheduled,
      [],
      undefined,
      [brokerage, cashAccount],
    );
    expect(result).toBeNull();
  });
});

describe('buildForecast — a missing rate withholds the series', () => {
  const cadAccount = {
    id: 'acc-cad',
    name: 'Chequing',
    currencyCode: 'CAD',
    currentBalance: 1000,
    isClosed: false,
    accountType: 'CHECKING',
  } as never;
  const eurAccount = {
    id: 'acc-eur',
    name: 'Euro savings',
    currencyCode: 'EUR',
    currentBalance: 500,
    isClosed: false,
    accountType: 'SAVINGS',
  } as never;

  /** Knows CAD only, so a EUR account cannot be converted. */
  const convertCadOnly = (amount: number, currency: string) =>
    currency === 'CAD' ? amount : null;

  it('projects normally when every account converts', () => {
    const result = buildForecast(
      [cadAccount],
      [],
      'week',
      'all',
      [],
      convertCadOnly,
    );
    expect(result.missingCurrencies).toEqual([]);
    expect(result.points.length).toBeGreaterThan(0);
    expect(result.points[0].balance).toBe(1000);
  });

  // The alternative was a line starting at 1,000 instead of 1,000 + converted
  // 500, drawn as an ordinary projection. Every day after the first is wrong,
  // and nothing on the chart said so.
  it('withholds the series and names the currency when one account cannot convert', () => {
    const result = buildForecast(
      [cadAccount, eurAccount],
      [],
      'week',
      'all',
      [],
      convertCadOnly,
    );
    expect(result.missingCurrencies).toEqual(['EUR']);
    expect(result.points).toEqual([]);
  });

  it('needs no rates at all when no conversion was asked for', () => {
    const result = buildForecast([cadAccount, eurAccount], [], 'week', 'all');
    expect(result.missingCurrencies).toEqual([]);
    expect(result.points.length).toBeGreaterThan(0);
  });

  it('reports no series and no missing currencies for no accounts', () => {
    const result = buildForecast([], [], 'week', 'all', [], convertCadOnly);
    expect(result).toEqual({ points: [], missingCurrencies: [] });
  });
});

describe('buildMultiAccountForecast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 0, 15)); // Jan 15, 2025
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const chequing = makeAccount({ id: 'acc-1', name: 'Chequing', currentBalance: 1000 });
  const savings = makeAccount({ id: 'acc-2', name: 'Savings', currentBalance: 500 });
  const on = (
    result: ReturnType<typeof buildMultiAccountForecast>,
    date: string,
  ) => result.points.find(p => p.date === date);

  it('returns one series per selected account, in the order it was given', () => {
    const result = buildMultiAccountForecast(
      [chequing, savings], [], 'month', ['acc-2', 'acc-1'],
    );
    expect(result.series).toEqual([
      { accountId: 'acc-2', name: 'Savings' },
      { accountId: 'acc-1', name: 'Chequing' },
    ]);
  });

  it('starts each line at its own balance and the total at their sum', () => {
    const result = buildMultiAccountForecast(
      [chequing, savings], [], 'month', ['acc-1', 'acc-2'],
    );
    const first = result.points[0];
    expect(first.balances).toEqual({ 'acc-1': 1000, 'acc-2': 500 });
    expect(first.balance).toBe(1500);
  });

  /**
   * The total is summed from the same rounded per-account figures the lines are
   * drawn from. Rounding the raw sum instead would put 3000.25 under two lines
   * reading 1000.13 and 2000.13.
   */
  it('totals the rounded per-account figures, not the raw sum', () => {
    const result = buildMultiAccountForecast(
      [
        makeAccount({ id: 'acc-1', name: 'A', currentBalance: 1000.125 }),
        makeAccount({ id: 'acc-2', name: 'B', currentBalance: 2000.125 }),
      ],
      [], 'month', ['acc-1', 'acc-2'],
    );
    const first = result.points[0];
    expect(first.balances).toEqual({ 'acc-1': 1000.13, 'acc-2': 2000.13 });
    expect(first.balance).toBe(3000.26);
  });

  it('moves only the account a scheduled transaction belongs to', () => {
    const transactions = [makeScheduled({
      id: 'st-1', accountId: 'acc-1', amount: -200,
      frequency: 'ONCE', nextDueDate: '2025-01-20',
    })];
    const result = buildMultiAccountForecast(
      [chequing, savings], transactions, 'month', ['acc-1', 'acc-2'],
    );
    const jan20 = on(result, '2025-01-20');
    expect(jan20?.balances).toEqual({ 'acc-1': 800, 'acc-2': 500 });
    expect(jan20?.balance).toBe(1300);
  });

  it('tags each transaction with the account it moved', () => {
    const transactions = [makeScheduled({
      id: 'st-1', name: 'Rent', accountId: 'acc-1', amount: -200,
      frequency: 'ONCE', nextDueDate: '2025-01-20',
    })];
    const result = buildMultiAccountForecast(
      [chequing, savings], transactions, 'month', ['acc-1', 'acc-2'],
    );
    expect(on(result, '2025-01-20')?.transactions).toEqual([
      { name: 'Rent', amount: -200, scheduledTransactionId: 'st-1', accountId: 'acc-1' },
    ]);
  });

  /**
   * A transfer between two selected accounts is money moving inside the set, so
   * both lines move and the total does not -- which is what a total of those
   * accounts means.
   */
  it('moves both lines and leaves the total alone for a transfer inside the selection', () => {
    const transactions = [makeScheduled({
      id: 'st-1', accountId: 'acc-1', amount: -300,
      isTransfer: true, transferAccountId: 'acc-2',
      frequency: 'ONCE', nextDueDate: '2025-01-20',
    })];
    const result = buildMultiAccountForecast(
      [chequing, savings], transactions, 'month', ['acc-1', 'acc-2'],
    );
    const jan20 = on(result, '2025-01-20');
    expect(jan20?.balances).toEqual({ 'acc-1': 700, 'acc-2': 800 });
    expect(jan20?.balance).toBe(1500);
  });

  // Discussion #1784: an overdue transfer inside the selection lands on today
  // on both lines, and the tooltip counts it once.
  it('carries an overdue transfer onto today on both lines and counts it once', () => {
    const transactions = [makeScheduled({
      id: 'st-1', accountId: 'acc-1', amount: -300,
      isTransfer: true, transferAccountId: 'acc-2',
      frequency: 'ONCE', nextDueDate: '2025-01-10',
    }), makeScheduled({
      id: 'st-2', accountId: 'acc-2', amount: -50,
      frequency: 'ONCE', nextDueDate: '2025-01-12',
    })];
    const result = buildMultiAccountForecast(
      [chequing, savings], transactions, 'month', ['acc-1', 'acc-2'],
    );
    const first = result.points[0];
    expect(first.date).toBe('2025-01-15');
    expect(first.balances).toEqual({ 'acc-1': 700, 'acc-2': 750 });
    expect(first.balance).toBe(1450);
    expect(first.transactions).toHaveLength(3);
    expect(countOverdueOccurrences(first.transactions)).toBe(2);
  });

  it('takes a transfer out to an unselected account off the total', () => {
    const outside = makeAccount({ id: 'acc-3', name: 'Outside', currentBalance: 0 });
    const transactions = [makeScheduled({
      id: 'st-1', accountId: 'acc-1', amount: -300,
      isTransfer: true, transferAccountId: 'acc-3',
      frequency: 'ONCE', nextDueDate: '2025-01-20',
    })];
    const result = buildMultiAccountForecast(
      [chequing, savings, outside], transactions, 'month', ['acc-1', 'acc-2'],
    );
    const jan20 = on(result, '2025-01-20');
    expect(jan20?.balances).toEqual({ 'acc-1': 700, 'acc-2': 500 });
    expect(jan20?.balance).toBe(1200);
  });

  it('layers future-dated posted transactions onto their own account', () => {
    const future: FutureTransaction[] = [
      { id: 'ft-1', accountId: 'acc-2', name: 'Bonus', amount: 250, date: '2025-01-20' },
    ];
    const result = buildMultiAccountForecast(
      [chequing, savings], [], 'month', ['acc-1', 'acc-2'], future,
    );
    const jan20 = on(result, '2025-01-20');
    expect(jan20?.balances).toEqual({ 'acc-1': 1000, 'acc-2': 750 });
    expect(jan20?.balance).toBe(1750);
  });

  it('converts each account through its own currency', () => {
    const accounts = [
      makeAccount({ id: 'acc-1', name: 'CAD', currentBalance: 1000, currencyCode: 'CAD' }),
      makeAccount({ id: 'acc-2', name: 'EUR', currentBalance: 500, currencyCode: 'EUR' }),
    ];
    const convert = (amount: number, currency: string) =>
      currency === 'EUR' ? amount * 2 : amount;
    const result = buildMultiAccountForecast(
      accounts, [], 'month', ['acc-1', 'acc-2'], [], convert,
    );
    expect(result.points[0].balances).toEqual({ 'acc-1': 1000, 'acc-2': 1000 });
    expect(result.points[0].balance).toBe(2000);
  });

  // A projected balance is cumulative: one missing rate makes every later day
  // wrong, so no line is drawn at all rather than a plausible short one.
  it('withholds every line and names the currency when one cannot convert', () => {
    const accounts = [
      makeAccount({ id: 'acc-1', name: 'CAD', currentBalance: 1000, currencyCode: 'CAD' }),
      makeAccount({ id: 'acc-2', name: 'EUR', currentBalance: 500, currencyCode: 'EUR' }),
    ];
    const convert = (amount: number, currency: string) =>
      currency === 'EUR' ? null : amount;
    const result = buildMultiAccountForecast(
      accounts, [], 'month', ['acc-1', 'acc-2'], [], convert,
    );
    expect(result).toEqual({ points: [], series: [], missingCurrencies: ['EUR'] });
  });

  it('ignores ids with no account behind them', () => {
    const result = buildMultiAccountForecast(
      [chequing, savings], [], 'month', ['acc-1', 'gone'],
    );
    expect(result.series).toEqual([{ accountId: 'acc-1', name: 'Chequing' }]);
    expect(result.points[0].balances).toEqual({ 'acc-1': 1000 });
  });

  it('returns nothing when no selected id matches an account', () => {
    const result = buildMultiAccountForecast([chequing], [], 'month', ['gone']);
    expect(result).toEqual({ points: [], series: [], missingCurrencies: [] });
  });

  it('does not count a repeated id twice', () => {
    const result = buildMultiAccountForecast(
      [chequing, savings], [], 'month', ['acc-1', 'acc-1'],
    );
    expect(result.series).toEqual([{ accountId: 'acc-1', name: 'Chequing' }]);
    expect(result.points[0].balance).toBe(1000);
  });

  it('remaps a scheduled investment onto its funding cash account', () => {
    const brokerage = makeAccount({ id: 'acc-3', name: 'Brokerage', currentBalance: 0 });
    const transactions = [makeScheduled({
      id: 'st-1', accountId: 'acc-3', amount: -400,
      isInvestment: true, investmentFundingAccountId: 'acc-1',
      investmentForecastExchangeRate: 1,
      frequency: 'ONCE', nextDueDate: '2025-01-20',
    } as Partial<ScheduledTransaction>)];
    const result = buildMultiAccountForecast(
      [chequing, savings, brokerage], transactions, 'month', ['acc-1', 'acc-2'],
    );
    const jan20 = on(result, '2025-01-20');
    expect(jan20?.balances).toEqual({ 'acc-1': 600, 'acc-2': 500 });
  });
});

describe('forecast money arithmetic (integer 1/10000 units, one rounding for display)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 0, 15));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const tenTenths = (accountId: string): FutureTransaction[] =>
    Array.from({ length: 10 }, (_, i) => ({
      id: `ft-${accountId}-${i}`,
      accountId,
      name: 'Tenth',
      amount: 0.1,
      date: '2025-01-16',
    }));

  describe('buildForecast', () => {
    it('rounds a 1.0050 starting balance half away from zero to 1.01', () => {
      const points = buildForecast([makeAccount({ currentBalance: 1.005 })], [], 'week', 'acc-1').points;
      expect(points[0].balance).toBe(1.01);
    });

    it('rounds a -2500.0050 balance to -2500.01', () => {
      const points = buildForecast([makeAccount({ currentBalance: -2500.005 })], [], 'week', 'acc-1').points;
      expect(points[0].balance).toBe(-2500.01);
    });

    it('sums ten 0.1 transactions on 0 to exactly 1', () => {
      const points = buildForecast(
        [makeAccount({ currentBalance: 0 })], [], 'week', 'acc-1', tenTenths('acc-1'),
      ).points;
      expect(points.find(p => p.date === '2025-01-16')?.balance).toBe(1);
    });

    it('rounds a converted amount to the storage precision', () => {
      const scheduled = makeScheduled({ nextDueDate: '2025-01-20', amount: -10, frequency: 'ONCE' });
      const result = buildForecast(
        [makeAccount({ currentBalance: 0, currencyCode: 'EUR' })], [scheduled], 'week', 'acc-1', [],
        (amount) => amount * (1 / 3),
      );
      const tx = result.points.find(p => p.date === '2025-01-20')?.transactions[0];
      expect(tx?.amount).toBe(-3.3333);
    });
  });

  describe('getProjectedBalanceAtDate', () => {
    it('rounds 1.0050 to 1.01 and -2500.0050 to -2500.01', () => {
      expect(getProjectedBalanceAtDate(makeAccount({ currentBalance: 1.005 }), '2025-01-20', [], [])).toBe(1.01);
      expect(getProjectedBalanceAtDate(makeAccount({ currentBalance: -2500.005 }), '2025-01-20', [], [])).toBe(-2500.01);
    });

    it('sums ten 0.1 future transactions on 0 to exactly 1', () => {
      expect(
        getProjectedBalanceAtDate(makeAccount({ currentBalance: 0 }), '2025-01-20', [], tenTenths('acc-1')),
      ).toBe(1);
    });
  });

  describe('buildMultiAccountForecast', () => {
    it('rounds each line half away from zero and totals the rounded lines', () => {
      const result = buildMultiAccountForecast(
        [
          makeAccount({ id: 'acc-1', name: 'A', currentBalance: 1.005 }),
          makeAccount({ id: 'acc-2', name: 'B', currentBalance: -2500.005 }),
        ],
        [], 'week', ['acc-1', 'acc-2'],
      );
      expect(result.points[0].balances).toEqual({ 'acc-1': 1.01, 'acc-2': -2500.01 });
      expect(result.points[0].balance).toBe(-2499);
    });

    it('sums ten 0.1 transactions on 0 to exactly 1', () => {
      const result = buildMultiAccountForecast(
        [makeAccount({ currentBalance: 0 })], [], 'week', ['acc-1'], tenTenths('acc-1'),
      );
      const point = result.points.find(p => p.date === '2025-01-16');
      expect(point?.balances).toEqual({ 'acc-1': 1 });
      expect(point?.balance).toBe(1);
    });
  });

  describe('getForecastSummary', () => {
    it('rounds the starting balance half away from zero', () => {
      const summary = getForecastSummary([{ date: '2025-01-15', balance: 1.01, transactions: [] }]);
      expect(summary.startingBalance).toBe(1.01);
    });
  });
});

describe('forecast of a coin wallet (balances at the coin\'s places, not cents)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 0, 15));
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8, symbol: '₿' }]);
  });

  afterEach(() => {
    vi.useRealTimers();
    clearCurrencyDecimals();
  });

  const wallet = (overrides: Partial<Account> = {}) =>
    makeAccount({ id: 'w-1', name: 'Wallet', currencyCode: 'BTC', currentBalance: 0.01249993, ...overrides });
  // A 2,500-satoshi network fee.
  const spend = (accountId: string): FutureTransaction[] => [
    { id: `ft-${accountId}`, accountId, name: 'Fee', amount: -0.000025, date: '2025-01-16' },
  ];

  it('projects the balance a posting is checked against at eight places', () => {
    expect(getProjectedBalanceAtDate(wallet(), '2025-01-20', [], spend('w-1'))).toBe(0.01247493);
    // A fiat account is unchanged: cents.
    expect(
      getProjectedBalanceAtDate(makeAccount({ currencyCode: 'CAD', currentBalance: 1.005 }), '2025-01-20', [], []),
    ).toBe(1.01);
  });

  it('keeps eight places exact above 2^53 units', () => {
    const big = wallet({ currentBalance: 20999999.99999999 });
    const credit: FutureTransaction[] = [
      { id: 'ft-1', accountId: 'w-1', name: 'Dust', amount: 0.00000001, date: '2025-01-16' },
    ];
    expect(getProjectedBalanceAtDate(big, '2025-01-20', [], credit)).toBe(21000000);
  });

  it('draws a single wallet\'s line and summary at eight places', () => {
    const points = buildForecast([wallet()], [], 'week', 'w-1', spend('w-1')).points;
    expect(points[0].balance).toBe(0.01249993);
    expect(points.find(p => p.date === '2025-01-16')?.balance).toBe(0.01247493);
    expect(getForecastSummary(points, 'BTC').startingBalance).toBe(0.01249993);
  });

  it('draws two wallets and their total at eight places', () => {
    const result = buildMultiAccountForecast(
      [wallet(), wallet({ id: 'w-2', name: 'Cold', currentBalance: 0.00747493 })],
      [], 'week', ['w-1', 'w-2'], spend('w-2'),
    );
    expect(result.points[0].balances).toEqual({ 'w-1': 0.01249993, 'w-2': 0.00747493 });
    expect(result.points[0].balance).toBe(0.01997486);
    const after = result.points.find(p => p.date === '2025-01-16');
    expect(after?.balances).toEqual({ 'w-1': 0.01249993, 'w-2': 0.00744993 });
    expect(after?.balance).toBe(0.01994986);
  });

  it('rounds a converted line at cents: it is in the reader\'s fiat currency', () => {
    const result = buildMultiAccountForecast(
      [wallet(), makeAccount({ id: 'acc-1', currencyCode: 'CAD', currentBalance: 10 })],
      [], 'week', ['w-1', 'acc-1'], [],
      (amount, code) => (code === 'BTC' ? amount * 123456.789 : amount),
    );
    // 0.01249993 x 123456.789 = 1543.2012 at the fiat four, 1543.20 on the line.
    expect(result.points[0].balances).toEqual({ 'w-1': 1543.2, 'acc-1': 10 });
    expect(result.points[0].balance).toBe(1553.2);
  });
});

/**
 * Payroll deduction rules (docs/specs/payroll-deductions.md decision 7,
 * INV-PAYROLL-003): the walk spends the server's `remaining` occurrence by
 * occurrence, adds the uncollected part back to the paycheque, and refills
 * the room on the reset date. The spec's section 7 example, on a biweekly
 * paycheque of 2,436 net whose EI line is 64.
 */
describe('buildForecast with payroll deductions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 10)); // Apr 10, 2026
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const eiRule = (remaining: number) => ({
    ruleId: 'rule-ei',
    categoryId: 'cat-ei',
    categoryName: 'EI',
    yearlyMaximum: 1077.48,
    expectedPerPaycheque: 64,
    expectedSource: 'line' as const,
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    nextResetOn: '2027-01-01',
    resetDate: '2026-01-01',
    paidToDate: 1077.48 - remaining,
    remaining,
    foreignCurrencyRows: 0,
    currencyCode: 'USD',
  });

  const paycheque = (overrides: Partial<ScheduledTransaction> = {}) =>
    makeScheduled({
      id: 'st-pay',
      name: 'Paycheque',
      amount: 2436,
      frequency: 'BIWEEKLY',
      nextDueDate: '2026-04-24',
      ...overrides,
    });

  /** The paycheque's amount on each occurrence the window holds, by date. */
  const paycheques = (points: ReturnType<typeof forecastPoints>) =>
    points
      .flatMap(p => p.transactions.map(tx => [p.date, tx.amount] as const))
      .filter(([, amount]) => amount !== 0 || true);

  it('reduces the paycheque by nothing while the room covers the deduction', () => {
    const points = forecastPoints([makeAccount()], [paycheque({ payrollDeductions: [eiRule(1000)] })], 'month', 'all');
    expect(paycheques(points)).toEqual([['2026-04-24', 2436], ['2026-05-08', 2436]]);
  });

  it('adds the uncollected part back once the room runs out (spec section 7)', () => {
    const points = forecastPoints([makeAccount()], [paycheque({ payrollDeductions: [eiRule(53.48)] })], 'month', 'all');
    expect(paycheques(points)).toEqual([
      ['2026-04-24', 2446.52],
      ['2026-05-08', 2500],
    ]);
  });

  it('refills the room on the reset date', () => {
    vi.setSystemTime(new Date(2026, 11, 10)); // Dec 10, 2026
    const points = forecastPoints(
      [makeAccount()],
      [paycheque({ nextDueDate: '2026-12-18', payrollDeductions: [eiRule(0)] })],
      'month',
      'all',
    );
    expect(paycheques(points)).toEqual([
      ['2026-12-18', 2500],
      ['2027-01-01', 2436],
    ]);
  });

  it('projects an overridden amount as stated and still spends the room', () => {
    const points = forecastPoints(
      [makeAccount()],
      [
        paycheque({
          payrollDeductions: [eiRule(53.48)],
          futureOverrides: [
            { originalDate: '2026-04-24', overrideDate: '2026-04-24', amount: 3000 } as never,
          ],
        }),
      ],
      'month',
      'all',
    );
    expect(paycheques(points)).toEqual([
      ['2026-04-24', 3000],
      ['2026-05-08', 2500],
    ]);
  });

  it('leaves a bill alone when the rule has no expected figure or the field is absent', () => {
    const unknown = { ...eiRule(53.48), expectedPerPaycheque: null, expectedSource: null };
    const withUnknown = forecastPoints([makeAccount()], [paycheque({ payrollDeductions: [unknown] })], 'month', 'all');
    expect(paycheques(withUnknown)).toEqual([['2026-04-24', 2436], ['2026-05-08', 2436]]);
    const older = forecastPoints([makeAccount()], [paycheque()], 'month', 'all');
    expect(paycheques(older)).toEqual([['2026-04-24', 2436], ['2026-05-08', 2436]]);
  });

  it('pools the room of two paycheques on one category and spends it in date order', () => {
    // A mid-month and a month-end paycheque both deduct 64 of EI; 100 is left.
    const midMonth = paycheque({ id: 'st-mid', name: 'Mid-month', frequency: 'MONTHLY', nextDueDate: '2026-04-15', payrollDeductions: [eiRule(100)] });
    const monthEnd = paycheque({
      id: 'st-end',
      name: 'Month-end',
      amount: 2200,
      frequency: 'MONTHLY',
      nextDueDate: '2026-04-30',
      payrollDeductions: [{ ...eiRule(100), ruleId: 'rule-ei-end' }],
    });
    // Given month-end first: the walk still spends 15 April before 30 April.
    const points = forecastPoints([makeAccount()], [monthEnd, midMonth], '90days', 'all');
    expect(paycheques(points)).toEqual([
      ['2026-04-15', 2436], // 64 collected, 36 left
      ['2026-04-30', 2228], // 36 collected, 28 added back
      ['2026-05-15', 2500], // nothing left: the whole 64 added back
      ['2026-05-30', 2264],
      ['2026-06-15', 2500],
      ['2026-06-30', 2264],
    ]);
  });

  it('lets a paycheque on another account draw down the room the shown account relies on', () => {
    const shown = makeAccount();
    const other = makeAccount({ id: 'acc-2', name: 'Joint' });
    const midMonth = paycheque({ id: 'st-mid', frequency: 'MONTHLY', nextDueDate: '2026-04-15', accountId: 'acc-2', payrollDeductions: [eiRule(100)] });
    const monthEnd = paycheque({ id: 'st-end', frequency: 'MONTHLY', nextDueDate: '2026-04-30', payrollDeductions: [eiRule(100)] });
    const points = forecastPoints([shown, other], [midMonth, monthEnd], 'month', 'acc-1');
    expect(paycheques(points)).toEqual([['2026-04-30', 2464]]);
    // The lower ceiling binds when the two rules disagree.
    const tighter = paycheque({ id: 'st-end', frequency: 'MONTHLY', nextDueDate: '2026-04-30', payrollDeductions: [{ ...eiRule(100), yearlyMaximum: 1000, remaining: 20 }] });
    const bound = forecastPoints([shown, other], [midMonth, tighter], 'month', 'acc-1');
    expect(paycheques(bound)).toEqual([['2026-04-30', 2500]]);
  });

  it('keeps a bill whose line was zeroed at this year\'s maximum where it is, then drops it from the first paycheque after the reset', () => {
    vi.setSystemTime(new Date(2026, 11, 10)); // Dec 10, 2026
    // The template already pays 2500 with no EI deducted; the user entered the
    // usual 64 and the room is spent. Nothing is added back this year, and
    // the new year deducts 64 from what the paycheque is now.
    const entered = { ...eiRule(0), expectedSource: 'entered' as const };
    const points = forecastPoints(
      [makeAccount()],
      [paycheque({ amount: 2500, nextDueDate: '2026-12-18', payrollDeductions: [entered] })],
      'month',
      'all',
    );
    expect(paycheques(points)).toEqual([
      ['2026-12-18', 2500],
      ['2027-01-01', 2436],
    ]);
  });

  it('leaves an overdue paycheque from a closed period alone and does not spend the new room on it', () => {
    vi.setSystemTime(new Date(2027, 0, 5)); // Jan 5, 2027: the room has refilled
    const fresh = { ...eiRule(1077.48), periodStart: '2027-01-01', periodEnd: '2027-12-31', nextResetOn: '2028-01-01' };
    const points = forecastPoints(
      [makeAccount()],
      [paycheque({ nextDueDate: '2026-12-25', payrollDeductions: [fresh] })],
      'month',
      'all',
    );
    // 25 December carried onto today as it is: the ledger for December is
    // already written; 8 January and 22 January each deduct from the new room.
    expect(paycheques(points)).toEqual([
      ['2027-01-05', 2436],
      ['2027-01-08', 2436],
      ['2027-01-22', 2436],
    ]);
  });

  it('refills on the anchor\'s anniversary, so a leap-day anchor returns to the 29th', () => {
    vi.setSystemTime(new Date(2028, 1, 20)); // Feb 20, 2028, a leap year
    const leap = {
      ...eiRule(0),
      resetDate: '2024-02-29',
      periodStart: '2027-02-28',
      periodEnd: '2028-02-28',
      nextResetOn: '2028-02-29',
    };
    const points = forecastPoints(
      [makeAccount()],
      [paycheque({ frequency: 'WEEKLY', nextDueDate: '2028-02-22', payrollDeductions: [leap] })],
      'month',
      'all',
    );
    expect(paycheques(points).slice(0, 3)).toEqual([
      ['2028-02-22', 2500], // room spent: the 64 is added back
      ['2028-02-29', 2436], // refilled on the 29th itself
      ['2028-03-07', 2436],
    ]);
  });

  it('answers what one occurrence deducts per category, after every earlier occurrence has spent', () => {
    const cpp = { ...eiRule(500), ruleId: 'rule-cpp', categoryId: 'cat-cpp', categoryName: 'CPP', expectedPerPaycheque: 200 };
    const bill = paycheque({ payrollDeductions: [eiRule(100), cpp] });
    // 24 April: EI 64 of 100, CPP 200 of 500. 8 May: EI the 36 left, CPP 200.
    expect(projectPayrollOccurrence([bill], 'st-pay', '2026-04-24')).toEqual({ 'cat-ei': 64, 'cat-cpp': 200 });
    expect(projectPayrollOccurrence([bill], 'st-pay', '2026-05-08')).toEqual({ 'cat-ei': 36, 'cat-cpp': 200 });
    expect(projectPayrollOccurrence([bill], 'st-pay', '2026-05-09')).toBeNull();
    expect(projectPayrollOccurrence([paycheque()], 'st-pay', '2026-04-24')).toBeNull();
  });

  it('shares one walk between the single and the per-account forecasts', () => {
    const multi = buildMultiAccountForecast(
      [makeAccount()],
      [paycheque({ payrollDeductions: [eiRule(53.48)] })],
      'month',
      ['acc-1'],
    );
    expect(
      multi.points.flatMap(p => p.transactions.map(tx => [p.date, tx.amount])),
    ).toEqual([
      ['2026-04-24', 2446.52],
      ['2026-05-08', 2500],
    ]);
  });
});
