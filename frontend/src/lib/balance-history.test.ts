import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { averageDailyBalance, computeBalanceSummary } from './balance-history';

describe('computeBalanceSummary', () => {
  beforeEach(() => {
    // Lock "today" so tests are not date-dependent.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-10T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for an empty series', () => {
    expect(computeBalanceSummary([])).toBeNull();
  });

  it('summarises a fully past series with current = last point', () => {
    const summary = computeBalanceSummary([
      { date: '2026-01-01', balance: 1000 },
      { date: '2026-01-02', balance: 750 },
      { date: '2026-01-03', balance: 900 },
    ]);
    expect(summary).toEqual({
      startBalance: 1000,
      currentBalance: 900,
      endBalance: 900,
      hasFutureData: false,
      minBalance: 750,
      goesNegative: false,
    });
  });

  it('anchors current at the last point on or before today when the series extends into the future', () => {
    const summary = computeBalanceSummary([
      { date: '2026-03-01', balance: 2000 },
      { date: '2026-03-10', balance: 1500 },
      { date: '2026-04-01', balance: 1800 },
      { date: '2026-04-15', balance: 1900 },
    ]);
    expect(summary?.currentBalance).toBe(1800);
    expect(summary?.endBalance).toBe(1900);
    expect(summary?.hasFutureData).toBe(true);
  });

  it('does not flag future data when post-today points only carry the balance forward', () => {
    const summary = computeBalanceSummary([
      { date: '2026-01-01', balance: 1000 },
      { date: '2026-03-01', balance: 1500 },
      { date: '2026-06-01', balance: 1500 },
      { date: '2026-12-31', balance: 1500 },
    ]);
    expect(summary?.currentBalance).toBe(1500);
    expect(summary?.hasFutureData).toBe(false);
  });

  it('falls back to the starting balance when all points are in the future', () => {
    const summary = computeBalanceSummary([
      { date: '2026-05-01', balance: 300 },
      { date: '2026-06-01', balance: 400 },
    ]);
    expect(summary?.currentBalance).toBe(300);
    expect(summary?.hasFutureData).toBe(true);
  });

  it('flags a series that dips negative', () => {
    const summary = computeBalanceSummary([
      { date: '2026-01-01', balance: 100 },
      { date: '2026-01-02', balance: -50 },
    ]);
    expect(summary?.minBalance).toBe(-50);
    expect(summary?.goesNegative).toBe(true);
  });

  it('rounds balances to a two-place currency\'s cents to match the plotted chart points', () => {
    const summary = computeBalanceSummary(
      [
        { date: '2026-01-01', balance: 1000.005 },
        { date: '2026-01-02', balance: 899.996 },
      ],
      2,
    );
    expect(summary?.startBalance).toBe(1000.01);
    expect(summary?.currentBalance).toBe(900);
  });

  it('keeps a four-place currency\'s balance at its four places', () => {
    // A 0.0070 BTC wallet read "0.01" when every series rounded to cents.
    const summary = computeBalanceSummary(
      [
        { date: '2026-01-01', balance: 0.0125 },
        { date: '2026-01-02', balance: 0.007 },
      ],
      4,
    );
    expect(summary?.startBalance).toBe(0.0125);
    expect(summary?.currentBalance).toBe(0.007);
    expect(summary?.minBalance).toBe(0.007);
  });

  it('keeps an eight-place coin\'s balance at its eight places', () => {
    const summary = computeBalanceSummary(
      [
        { date: '2026-01-01', balance: 0.01249993 },
        { date: '2026-01-02', balance: 0.00747493 },
        { date: '2026-01-03', balance: 0.00002500 },
      ],
      8,
    );
    expect(summary?.startBalance).toBe(0.01249993);
    expect(summary?.currentBalance).toBe(0.000025);
    expect(summary?.minBalance).toBe(0.000025);
  });

  it('rounds to the stored money precision when no currency places are given', () => {
    const summary = computeBalanceSummary([
      { date: '2026-01-01', balance: 0.00704 },
      { date: '2026-01-02', balance: 0.0070 },
    ]);
    expect(summary?.startBalance).toBe(0.007);
    expect(summary?.currentBalance).toBe(0.007);
    expect(summary?.hasFutureData).toBe(false);
  });

  it('keeps each value as given for a null precision', () => {
    const summary = computeBalanceSummary(
      [
        { date: '2026-01-01', balance: 0.000342 },
        { date: '2026-01-02', balance: 0.000411 },
      ],
      null,
    );
    expect(summary?.startBalance).toBe(0.000342);
    expect(summary?.currentBalance).toBe(0.000411);
  });
});

describe('averageDailyBalance', () => {
  it('averages a four-place currency at its four places', () => {
    // (0.0125 + 0.0070) / 2 = 0.00975, half away from zero to 0.0098. The
    // cents-rounded mean was 0.01, and a smaller one read "BTC 0.0000".
    expect(
      averageDailyBalance(
        [
          { date: '2026-01-01', balance: 0.0125 },
          { date: '2026-01-02', balance: 0.007 },
        ],
        4,
      ),
    ).toBe(0.0098);
    expect(averageDailyBalance([{ date: '2026-01-01', balance: 0.007 }], 4)).toBe(0.007);
  });

  it('averages an eight-place coin at its eight places, summed at eight', () => {
    // At four places 0.00002500 summed as zero and the mean read 0.00000000.
    expect(
      averageDailyBalance(
        [
          { date: '2026-01-01', balance: 0.000025 },
          { date: '2026-01-02', balance: 0.000025 },
          { date: '2026-01-03', balance: 0.00000001 },
        ],
        8,
      ),
    ).toBe(0.00001667);
    expect(
      averageDailyBalance(
        [
          { date: '2026-01-01', balance: 20999999.99999999 },
          { date: '2026-01-02', balance: 20999999.99999999 },
        ],
        8,
      ),
    ).toBe(20999999.99999999);
  });

  it('averages a two-place currency at its cents', () => {
    expect(
      averageDailyBalance(
        [
          { date: '2026-01-01', balance: 100.1 },
          { date: '2026-01-02', balance: 100.2 },
          { date: '2026-01-03', balance: 100.2 },
        ],
        2,
      ),
    ).toBe(100.17);
  });

  it('sums without float drift', () => {
    // 0.1 + 0.2 accumulated as floats is 0.30000000000000004.
    const points = [0.1, 0.2, 0.3].map((balance, i) => ({ date: `2026-01-0${i + 1}`, balance }));
    expect(averageDailyBalance(points)).toBe(0.2);
  });

  it('is null for an empty series or one with an unknown day', () => {
    expect(averageDailyBalance([])).toBeNull();
    expect(
      averageDailyBalance([
        { date: '2026-01-01', balance: 10 },
        { date: '2026-01-02', balance: null },
      ]),
    ).toBeNull();
  });
});
