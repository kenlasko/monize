import { describe, it, expect } from 'vitest';
import { isLoanBillCandidate, loanOccurrenceLines } from './loan-occurrence';
import type { LoanOccurrence, ScheduledTransaction } from '@/types/scheduled-transaction';

const occurrence = (over: Partial<LoanOccurrence> = {}): LoanOccurrence => ({
  originalDate: '2023-05-03',
  dueDate: '2023-05-03',
  overrideId: null,
  amount: 560,
  principal: 186.9,
  interest: 373.1,
  extraPrincipal: 0,
  annualRate: 4.5,
  debtBefore: 99494.13,
  complete: true,
  missing: null,
  ...over,
});

const interest = { id: 'i', categoryId: 'cat-interest', transferAccountId: null, memo: 'Interest', amount: -416.67 };
const principal = { id: 'p', categoryId: null, transferAccountId: 'loan-1', memo: 'Principal', amount: -167.92 };
const extra = { id: 'e', categoryId: null, transferAccountId: 'loan-1', memo: 'Extra principal', amount: 0 };

describe('isLoanBillCandidate', () => {
  const base = { isInvestment: false, transferAccount: null, splits: [] } as unknown as ScheduledTransaction;

  it('names a schedule with a split line into a loan-like account', () => {
    expect(
      isLoanBillCandidate({
        ...base,
        splits: [{ transferAccount: { accountType: 'MORTGAGE' } }],
      } as unknown as ScheduledTransaction),
    ).toBe(true);
  });

  it('names a transfer into a loan-like account', () => {
    expect(
      isLoanBillCandidate({ ...base, transferAccount: { accountType: 'LOAN' } } as unknown as ScheduledTransaction),
    ).toBe(true);
  });

  it('does not name an ordinary bill or an investment schedule', () => {
    expect(isLoanBillCandidate(base)).toBe(false);
    expect(
      isLoanBillCandidate({
        ...base,
        isInvestment: true,
        transferAccount: { accountType: 'MORTGAGE' },
      } as unknown as ScheduledTransaction),
    ).toBe(false);
    expect(
      isLoanBillCandidate({
        ...base,
        splits: [{ transferAccount: { accountType: 'CHEQUING' } }],
      } as unknown as ScheduledTransaction),
    ).toBe(false);
  });
});

describe('loanOccurrenceLines', () => {
  it("carries the occurrence's principal and interest on the template's lines, signed as the template", () => {
    const lines = loanOccurrenceLines([interest, principal], occurrence(), 'loan-1', -1);
    expect(lines?.map((l) => [l.id, l.amount])).toEqual([
      ['i', -373.1],
      ['p', -186.9],
    ]);
  });

  it('puts the extra principal on the line whose memo names it', () => {
    const lines = loanOccurrenceLines(
      [principal, extra, interest],
      occurrence({ amount: 660, extraPrincipal: 100 }),
      'loan-1',
      -1,
    );
    expect(lines?.map((l) => l.amount)).toEqual([-186.9, -100, -373.1]);
  });

  it('is null when a figure is unknown, never the template lines', () => {
    expect(
      loanOccurrenceLines([interest, principal], occurrence({ principal: null, complete: false }), 'loan-1', -1),
    ).toBeNull();
  });

  it('is null when the occurrence has extra principal and the template no line for it', () => {
    expect(
      loanOccurrenceLines([interest, principal], occurrence({ extraPrincipal: 50 }), 'loan-1', -1),
    ).toBeNull();
  });

  it('is null when the lines are not the loan shape or the loan is unknown', () => {
    const tax = { ...interest, id: 't', categoryId: 'cat-tax' };
    expect(loanOccurrenceLines([interest, principal, tax], occurrence(), 'loan-1', -1)).toBeNull();
    expect(loanOccurrenceLines([interest, principal], occurrence(), null, -1)).toBeNull();
  });

  it('writes a known zero as zero, as on a settled debt', () => {
    const lines = loanOccurrenceLines(
      [interest, principal],
      occurrence({ amount: 0, principal: 0, interest: 0 }),
      'loan-1',
      -1,
    );
    expect(lines?.map((l) => Math.abs(l.amount))).toEqual([0, 0]);
  });
});
