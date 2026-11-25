import { describe, it, expect } from 'vitest';
import { netWorthWindowChange } from './net-worth-change';

const month = (date: string, netWorth: number, extra: Record<string, unknown> = {}) => ({
  month: date,
  assets: netWorth,
  liabilities: 0,
  netWorth,
  ...extra,
});

describe('netWorthWindowChange', () => {
  it('is null for an empty series', () => {
    expect(netWorthWindowChange([], 4)).toBeNull();
  });

  it("reads the server's change from the first month over the difference of the readings", () => {
    // 100.40 and 100.90 are half a unit apart as readings; the change itself reads 0.49.
    const change = netWorthWindowChange(
      [month('2024-01-01', 100.4), month('2024-02-01', 100.9, { netWorthChangeFromStart: 0.49 })],
      4,
    );
    expect(change).toEqual({ known: true, amount: 0.49, percent: (0.49 / 100.4) * 100 });
  });

  it('takes the difference of the two readings from an older backend, rounded to shed float error', () => {
    const change = netWorthWindowChange([month('2024-01-01', 0.1), month('2024-02-01', 0.3)], 4);
    expect(change?.amount).toBe(0.2);
  });

  it('is unknown when either end month is a subtotal', () => {
    expect(
      netWorthWindowChange([month('2024-01-01', 1, { fxComplete: false }), month('2024-02-01', 2)], 4)?.known,
    ).toBe(false);
    expect(
      netWorthWindowChange([month('2024-01-01', 1), month('2024-02-01', 2, { fxComplete: false })], 4)?.known,
    ).toBe(false);
  });

  it('has a percentage of 0 over a first month of exactly zero', () => {
    expect(netWorthWindowChange([month('2024-01-01', 0), month('2024-02-01', 5)], 4)?.percent).toBe(0);
  });
});
