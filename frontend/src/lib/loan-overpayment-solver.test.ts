import { describe, it, expect } from 'vitest';
import { LoanScheduleInput, generateLoanSchedule } from './loan-schedule';
import {
  solveRecurringForInterestSavings,
  solveRecurringForPayoffMonth,
  solveRecurringForTargetInterest,
} from './loan-overpayment-solver';

function baseInput(overrides: Partial<LoanScheduleInput> = {}): LoanScheduleInput {
  return {
    startingBalance: 100000,
    annualRate: 5,
    paymentAmount: 600,
    frequency: 'MONTHLY',
    firstPaymentDate: new Date('2025-01-15'),
    ...overrides,
  };
}

const baseline = generateLoanSchedule(baseInput());

describe('solveRecurringForTargetInterest', () => {
  it('finds a recurring extra that brings total interest at or below a reachable target', () => {
    const target = baseline.totalInterest / 2;
    const solved = solveRecurringForTargetInterest(baseInput(), target);

    expect(solved.status).toBe('ok');
    expect(solved.amount).toBeGreaterThan(0);
    expect(solved.result!.totalInterest).toBeLessThanOrEqual(target + 0.5);
    // Smallest such amount: one step less overshoots the target.
    expect(solved.result!.totalInterest).toBeGreaterThan(target - baseline.totalInterest * 0.05);
  });

  it('returns already-met (0 extra) when the loan already costs at most the target', () => {
    const solved = solveRecurringForTargetInterest(baseInput(), baseline.totalInterest + 1000);
    expect(solved.status).toBe('already-met');
    expect(solved.amount).toBe(0);
  });

  it('returns unreachable when even the maximum extra cannot get interest that low', () => {
    const solved = solveRecurringForTargetInterest(baseInput(), 1);
    expect(solved.status).toBe('unreachable');
    expect(solved.amount).toBeNull();
    expect(solved.interestSaved).toBeNull();
  });
});

describe('solveRecurringForInterestSavings', () => {
  it('finds a recurring extra that saves at least the target vs the baseline', () => {
    const target = baseline.totalInterest / 2;
    const solved = solveRecurringForInterestSavings(baseInput(), target);

    expect(solved.status).toBe('ok');
    expect(solved.amount).toBeGreaterThan(0);
    expect(solved.interestSaved).toBeGreaterThanOrEqual(target - 0.5);
    // The savings reported are the baseline-vs-result difference.
    expect(solved.interestSaved).toBeCloseTo(
      baseline.totalInterest - solved.result!.totalInterest,
      2,
    );
  });

  it('returns already-met for a zero savings target', () => {
    const solved = solveRecurringForInterestSavings(baseInput(), 0);
    expect(solved.status).toBe('already-met');
    expect(solved.amount).toBe(0);
    expect(solved.interestSaved).toBe(0);
  });

  it('returns unreachable when the savings asked for exceed the total interest', () => {
    const solved = solveRecurringForInterestSavings(baseInput(), baseline.totalInterest);
    expect(solved.status).toBe('unreachable');
    expect(solved.amount).toBeNull();
  });
});

describe('solveRecurringForPayoffMonth', () => {
  it('finds a recurring extra that pays the loan off by a reachable target month', () => {
    // Baseline pays off years out; ask to be done ~3 years after the first payment.
    const target = '2028-01';
    const solved = solveRecurringForPayoffMonth(baseInput(), target);

    expect(solved.status).toBe('ok');
    expect(solved.amount).toBeGreaterThan(0);
    expect(solved.result!.payoffDate!.slice(0, 7) <= target).toBe(true);
  });

  it('returns already-met when the loan already pays off by the target month', () => {
    const solved = solveRecurringForPayoffMonth(baseInput(), baseline.payoffDate!.slice(0, 7));
    expect(solved.status).toBe('already-met');
    expect(solved.amount).toBe(0);
  });

  it('returns unreachable for a month earlier than the soonest possible payoff', () => {
    const solved = solveRecurringForPayoffMonth(baseInput(), '2024-12');
    expect(solved.status).toBe('unreachable');
    expect(solved.amount).toBeNull();
  });
});
