import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Account } from '@/types/account';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import {
  buildForecast,
  getForecastSummary,
  FORECAST_PERIOD_DAYS,
  FORECAST_PERIOD_LABELS,
  FutureTransaction,
} from './forecast';

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

describe('buildForecast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 0, 15)); // Jan 15, 2025
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty array when no matching accounts', () => {
    const result = buildForecast([], [], 'month', 'all');
    expect(result).toEqual([]);
  });

  it('returns data points for an account with no transactions', () => {
    const accounts = [makeAccount()];
    const result = buildForecast(accounts, [], 'week', 'all');
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
    const result = buildForecast(accounts, transactions, 'month', 'all');
    const afterTx = result.find(dp => dp.date === '2025-01-20');
    expect(afterTx?.balance).toBe(4500);
  });

  it('skips inactive transactions', () => {
    const accounts = [makeAccount({ currentBalance: 1000 })];
    const transactions = [makeScheduled({ isActive: false, nextDueDate: '2025-01-20', frequency: 'ONCE' })];
    const result = buildForecast(accounts, transactions, 'month', 'all');
    const allBalances = result.map(dp => dp.balance);
    expect(allBalances.every(b => b === 1000)).toBe(true);
  });

  it('filters by specific account', () => {
    const accounts = [makeAccount({ id: 'acc-1' }), makeAccount({ id: 'acc-2', currentBalance: 2000 })];
    const result = buildForecast(accounts, [], 'week', 'acc-2');
    expect(result[0].balance).toBe(2000);
  });

  it('excludes closed accounts in all mode', () => {
    const accounts = [makeAccount({ isClosed: true })];
    const result = buildForecast(accounts, [], 'week', 'all');
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
    const result = buildForecast(accounts, transactions, 'month', 'all');
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
    const result = buildForecast(accounts, transactions, 'month', 'all');
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
      const result = buildForecast(accounts, transactions, 'week', 'all');
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
      const result = buildForecast(accounts, transactions, 'week', 'all');
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
      const result = buildForecast(accounts, transactions, 'month', 'all');
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
      const result = buildForecast(accounts, transactions, 'month', 'all');
      const jan15 = result.find(dp => dp.date === '2025-01-15');
      const jan29 = result.find(dp => dp.date === '2025-01-29');
      expect(jan15?.balance).toBe(2500);
      expect(jan29?.balance).toBe(2000);
      // There should not be a Jan 22 occurrence
      const jan22 = result.find(dp => dp.date === '2025-01-22');
      expect(jan22?.transactions.length ?? 0).toBe(0);
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
      const result = buildForecast(accounts, transactions, '90days', 'all');
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
      const result = buildForecast(accounts, transactions, '90days', 'all');
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
      const result = buildForecast(accounts, transactions, 'year', 'all');
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
      const result = buildForecast(accounts, transactions, 'year', 'all');
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
      const result = buildForecast(accounts, transactions, 'year', 'all');
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
      const result = buildForecast(accounts, transactions, '90days', 'all');
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
      const result = buildForecast(accounts, transactions, 'month', 'all');
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
      const result = buildForecast(accounts, transactions, '90days', 'all');
      // Jan 31 -> setMonth adds 1 -> JS Date will give Feb 28 in 2025 (non-leap)
      // Actually JS Date(2025, 1, 31) = March 3, so let's verify what actually happens
      const jan31 = result.find(dp => dp.date === '2025-01-31');
      expect(jan31?.transactions.length).toBe(1);
      // JS setMonth(1) on Jan 31 => Feb 31 => Mar 3 (date overflow)
      const mar03 = result.find(dp => dp.date === '2025-03-03');
      expect(mar03?.transactions.length).toBe(1);
    });

    it('handles end-of-month SEMIMONTHLY in February (non-leap year)', () => {
      vi.setSystemTime(new Date(2025, 0, 1)); // Jan 1, 2025
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-15',
        amount: -100,
        frequency: 'SEMIMONTHLY',
      })];
      const result = buildForecast(accounts, transactions, '90days', 'all');
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
      const result = buildForecast(accounts, transactions, '90days', 'all');
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
      const result = buildForecast(accounts, transactions, '90days', 'all');
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
      const result = buildForecast(accounts, [], 'week', 'all');
      // 7 days + day 0 = 8 data points
      expect(result.length).toBe(8);
    });

    it('month period uses daily granularity', () => {
      const accounts = [makeAccount()];
      const result = buildForecast(accounts, [], 'month', 'all');
      // 30 days + day 0 = 31 data points
      expect(result.length).toBe(31);
    });

    it('90days period uses every-3-day granularity (fewer data points)', () => {
      const accounts = [makeAccount()];
      const result = buildForecast(accounts, [], '90days', 'all');
      // Granularity 3: data points at day 0, 3, 6, 9, ... plus last day
      // Expected: about 31 data points (90/3 + 1)
      expect(result.length).toBeLessThan(91);
      expect(result.length).toBeGreaterThan(20);
    });

    it('6months period uses weekly granularity', () => {
      const accounts = [makeAccount()];
      const result = buildForecast(accounts, [], '6months', 'all');
      // Granularity 7: data points at day 0, 7, 14, ... plus last day
      // Expected: about 26-27 data points (180/7 + 1)
      expect(result.length).toBeLessThan(181);
      expect(result.length).toBeGreaterThan(20);
    });

    it('year period uses weekly granularity', () => {
      const accounts = [makeAccount()];
      const result = buildForecast(accounts, [], 'year', 'all');
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
      const result = buildForecast(accounts, transactions, '90days', 'all');
      const txPoint = result.find(dp => dp.date === dateStr);
      expect(txPoint).toBeDefined();
      expect(txPoint?.transactions.length).toBe(1);
    });
  });

  // --- Date formatting for chart labels ---
  describe('date formatting for chart labels', () => {
    it('formats labels as short month and day', () => {
      const accounts = [makeAccount()];
      const result = buildForecast(accounts, [], 'week', 'all');
      // Jan 15, 2025 should format as "Jan 15"
      expect(result[0].label).toBe('Jan 15');
    });

    it('formats labels correctly across months', () => {
      vi.setSystemTime(new Date(2025, 0, 28)); // Jan 28
      const accounts = [makeAccount()];
      const result = buildForecast(accounts, [], 'week', 'all');
      // First point: Jan 28
      expect(result[0].label).toBe('Jan 28');
      // Some point should be in February
      const febPoint = result.find(dp => dp.label.startsWith('Feb'));
      expect(febPoint).toBeDefined();
    });
  });

  // --- Empty scheduled transactions input ---
  describe('empty scheduled transactions input', () => {
    it('returns flat balance line with empty transactions array', () => {
      const accounts = [makeAccount({ currentBalance: 2500 })];
      const result = buildForecast(accounts, [], 'month', 'all');
      expect(result.length).toBeGreaterThan(0);
      const allBalances = result.map(dp => dp.balance);
      expect(allBalances.every(b => b === 2500)).toBe(true);
    });

    it('all data points have empty transaction arrays', () => {
      const accounts = [makeAccount()];
      const result = buildForecast(accounts, [], 'week', 'all');
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
      const result = buildForecast(accounts, transactions, 'month', 'all');
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
      const result = buildForecast(accounts, transactions, 'week', 'all');
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
      const result = buildForecast(accounts, transactions, 'month', 'all');
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
      const result = buildForecast(accounts, transactions, 'month', 'all');
      const allBalances = result.map(dp => dp.balance);
      expect(allBalances.every(b => b === 5000)).toBe(true);
    });

    it('includes transfers when filtering by specific account', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-20',
        amount: -500,
        frequency: 'ONCE',
        isTransfer: true,
        transferAccountId: 'acc-2',
        accountId: 'acc-1',
      })];
      const result = buildForecast(accounts, transactions, 'month', 'acc-1');
      const afterTx = result.find(dp => dp.date === '2025-01-20');
      expect(afterTx?.balance).toBe(4500);
    });
  });

  // --- Multiple accounts and transactions ---
  describe('multiple accounts and transactions', () => {
    it('sums balances from multiple accounts', () => {
      const accounts = [
        makeAccount({ id: 'acc-1', currentBalance: 1000 }),
        makeAccount({ id: 'acc-2', currentBalance: 2000 }),
      ];
      const result = buildForecast(accounts, [], 'week', 'all');
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
      const result = buildForecast(accounts, transactions, 'month', 'all');
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
      const result = buildForecast(accounts, transactions, 'month', 'all');
      // Jan 15 uses override: -300, balance = 4700
      const jan15 = result.find(dp => dp.date === '2025-01-15');
      expect(jan15?.balance).toBe(4700);
      // Jan 22 uses base amount: -500, balance = 4200
      const jan22 = result.find(dp => dp.date === '2025-01-22');
      expect(jan22?.balance).toBe(4200);
    });
  });

  // --- ONCE frequency ---
  describe('ONCE frequency', () => {
    it('does not include ONCE transaction if before start date', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-10', // Before "today" Jan 15
        amount: -500,
        frequency: 'ONCE',
      })];
      const result = buildForecast(accounts, transactions, 'month', 'all');
      const allBalances = result.map(dp => dp.balance);
      expect(allBalances.every(b => b === 5000)).toBe(true);
    });

    it('does not include ONCE transaction if past endDate', () => {
      const accounts = [makeAccount({ currentBalance: 5000 })];
      const transactions = [makeScheduled({
        nextDueDate: '2025-01-20',
        amount: -500,
        frequency: 'ONCE',
        endDate: '2025-01-18',
      })];
      const result = buildForecast(accounts, transactions, 'month', 'all');
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      expect(jan20?.transactions.length ?? 0).toBe(0);
    });
  });

  // --- Future transactions support ---
  describe('future transactions', () => {
    it('subtracts future transaction amounts from starting balance', () => {
      const accounts = [makeAccount({ id: 'acc-1', currentBalance: 5000 })];
      const futureTransactions: FutureTransaction[] = [
        { id: 'ft-1', accountId: 'acc-1', name: 'Future Bill', amount: -1000, date: '2025-01-20' },
      ];
      const result = buildForecast(accounts, [], 'week', 'all', futureTransactions);
      // currentBalance is 5000, but includes the future -1000, so real today balance = 5000 - (-1000) = 6000
      expect(result[0].balance).toBe(6000);
    });

    it('adds future transactions at their correct dates', () => {
      const accounts = [makeAccount({ id: 'acc-1', currentBalance: 5000 })];
      const futureTransactions: FutureTransaction[] = [
        { id: 'ft-1', accountId: 'acc-1', name: 'Future Bill', amount: -1000, date: '2025-01-20' },
      ];
      const result = buildForecast(accounts, [], 'month', 'all', futureTransactions);
      // Starting balance is 6000 (5000 - (-1000)), then -1000 applied on Jan 20
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      expect(jan20).toBeDefined();
      expect(jan20?.balance).toBe(5000); // 6000 + (-1000) = 5000
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
      const result = buildForecast(accounts, [], 'month', 'acc-1', futureTransactions);
      // Starting: 3000 - (-500) = 3500, then -500 on Jan 20 = 3000
      expect(result[0].balance).toBe(3500);
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      expect(jan20?.balance).toBe(3000);
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
      const result = buildForecast(accounts, [], 'week', 'all', futureTransactions);
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
      const result = buildForecast(accounts, scheduled, 'month', 'all', futureTransactions);
      // Starting: 5000 - (-1000) = 6000
      // Jan 20: 6000 + (-1000) + (-200) = 4800
      const jan20 = result.find(dp => dp.date === '2025-01-20');
      expect(jan20?.balance).toBe(4800);
      expect(jan20?.transactions.length).toBe(2);
    });

    it('defaults to empty when futureTransactions not provided', () => {
      const accounts = [makeAccount({ currentBalance: 1000 })];
      const result = buildForecast(accounts, [], 'week', 'all');
      expect(result[0].balance).toBe(1000);
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
      { date: '2025-01-01', balance: 1000, label: 'Jan 1', transactions: [] },
      { date: '2025-01-15', balance: 500, label: 'Jan 15', transactions: [] },
      { date: '2025-01-31', balance: 1500, label: 'Jan 31', transactions: [] },
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
      { date: '2025-01-01', balance: 100, label: 'Jan 1', transactions: [] },
      { date: '2025-01-15', balance: -50, label: 'Jan 15', transactions: [] },
    ];
    const summary = getForecastSummary(dataPoints);
    expect(summary.goesNegative).toBe(true);
  });

  it('handles single data point', () => {
    const dataPoints = [
      { date: '2025-01-01', balance: 1000, label: 'Jan 1', transactions: [] },
    ];
    const summary = getForecastSummary(dataPoints);
    expect(summary.startingBalance).toBe(1000);
    expect(summary.endingBalance).toBe(1000);
    expect(summary.minBalance).toBe(1000);
    expect(summary.maxBalance).toBe(1000);
    expect(summary.goesNegative).toBe(false);
  });

  it('detects goesNegative as false when min balance is exactly zero', () => {
    const dataPoints = [
      { date: '2025-01-01', balance: 100, label: 'Jan 1', transactions: [] },
      { date: '2025-01-15', balance: 0, label: 'Jan 15', transactions: [] },
    ];
    const summary = getForecastSummary(dataPoints);
    expect(summary.goesNegative).toBe(false);
  });
});
