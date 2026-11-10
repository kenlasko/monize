import { describe, expect, it } from 'vitest';
import { nextPeriodWindowOpen, payrollPeriodOf } from './payroll-period';

describe('payrollPeriodOf (spec truth table B)', () => {
  it.each([
    ['2026-10-26', '2026-01-01', '2026-12-31', '2027-01-01'],
    ['2027-01-01', '2027-01-01', '2027-12-31', '2028-01-01'],
    ['2025-12-31', '2025-01-01', '2025-12-31', '2026-01-01'],
  ])('answers the period containing %s', (asOf, periodStart, periodEnd, nextResetOn) => {
    expect(payrollPeriodOf('2026-01-01', asOf)).toEqual({ periodStart, periodEnd, nextResetOn });
  });

  it('clamps a leap-day anchor in a common year', () => {
    expect(payrollPeriodOf('2024-02-29', '2025-06-01')).toEqual({
      periodStart: '2025-02-28',
      periodEnd: '2026-02-27',
      nextResetOn: '2026-02-28',
    });
  });

  it('answers for an anchor later than today, as a new rule defaults to next 1 January', () => {
    expect(payrollPeriodOf('2027-01-01', '2026-11-10').periodStart).toBe('2026-01-01');
  });
});

describe('nextPeriodWindowOpen (spec truth table C)', () => {
  it.each([
    ['2026-10-31', false],
    ['2026-11-01', true],
    ['2026-12-31', true],
    ['2027-01-01', false],
  ])('on %s is %s', (today, open) => {
    expect(nextPeriodWindowOpen('2027-01-01', today)).toBe(open);
  });
});
