import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Account } from '@/types/account';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import {
  buildForecast,
  getForecastSummary,
  FORECAST_PERIOD_DAYS,
  FORECAST_PERIOD_LABELS,
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
});
