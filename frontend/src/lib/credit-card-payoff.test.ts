import { describe, it, expect } from 'vitest';
import { computePayoffScenario } from './credit-card-payoff';

describe('computePayoffScenario', () => {
  const anchor = new Date(2026, 0, 15); // 2026-01-15

  it('returns a cleared scenario for a zero balance', () => {
    const s = computePayoffScenario(0, 19.99, 100, anchor);
    expect(s.payoffMonths).toBe(0);
    expect(s.totalInterest).toBe(0);
    expect(s.neverPaysOff).toBe(false);
    expect(s.payoffDate).toBe('2026-01-15');
  });

  it('pays off a 0% balance in ceil(balance / payment) months', () => {
    const s = computePayoffScenario(1000, 0, 100, anchor);
    expect(s.payoffMonths).toBe(10);
    expect(s.totalInterest).toBe(0);
    expect(s.payoffDate).toBe('2026-11-15');
  });

  it('accrues interest on a carried balance and still pays off', () => {
    const s = computePayoffScenario(1000, 12, 100, anchor);
    // 1% monthly interest; ~11 months, a little interest accrued.
    expect(s.neverPaysOff).toBe(false);
    expect(s.payoffMonths).toBe(11);
    expect(s.totalInterest).toBeGreaterThan(0);
    expect(s.totalInterest).toBeLessThan(100);
  });

  it('flags a balance that never pays off (payment below interest)', () => {
    // 1000 at 24% APR accrues 20/month; a 15/month payment never reduces it.
    const s = computePayoffScenario(1000, 24, 15, anchor);
    expect(s.neverPaysOff).toBe(true);
    expect(s.payoffMonths).toBeNull();
    expect(s.payoffDate).toBeNull();
  });

  it('treats a zero payment as never paying off', () => {
    const s = computePayoffScenario(500, 0, 0, anchor);
    expect(s.neverPaysOff).toBe(true);
  });

  it('treats a null APR as 0%', () => {
    const s = computePayoffScenario(300, null, 100, anchor);
    expect(s.payoffMonths).toBe(3);
    expect(s.totalInterest).toBe(0);
  });
});
