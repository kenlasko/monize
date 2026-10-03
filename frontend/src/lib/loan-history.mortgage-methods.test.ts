import { describe, it, expect } from 'vitest';
import {
  buildLoanProjectionInput,
  deriveLoanPaymentHistory,
  diagnoseLoanProjection,
  resolveCurrentLoanTerms,
} from './loan-history';
import { compareSchedules, generateLoanSchedule } from '@/lib/loan-schedule';
import { computePastImpact } from '@/lib/loan-past-impact';
import { solveRecurringForPayoffMonth } from '@/lib/loan-overpayment-solver';
import type { Account } from '@/types/account';
import type { LoanRateChange } from '@/types/loan-rate-change';

/**
 * The projection input and the current terms of a LINEAR or INTEREST_ONLY
 * mortgage (docs/specs/mortgage-types.md, sections 5.4 and 5.6), on the worked
 * example of section 7: EUR 300,000 over 360 monthly payments from 2024-01-01
 * at 2.00%, a step to 4.00% on 2027-01-01, and the debt as posted through the
 * 2025-07-01 installment, after the 20,000 repayment.
 *
 * `payment_amount` is null on every fixture account, as the server stores it
 * for these methods (spec decision 11), so a reader that still uses it fails.
 */

const TODAY = '2025-06-15';
const ANCHOR = { nextDueDate: '2025-07-01', debt: 265000.0006 };

function mortgage(overrides: Partial<Account> = {}): Account {
  return {
    id: 'mortgage-1',
    accountType: 'MORTGAGE',
    name: 'Hypotheek',
    currencyCode: 'EUR',
    openingBalance: -300000,
    currentBalance: -265000.0006,
    interestRate: 2,
    paymentAmount: null,
    paymentFrequency: 'MONTHLY',
    paymentStartDate: '2024-01-01',
    amortizationMonths: 360,
    originalPrincipal: 300000,
    mortgageType: 'LINEAR',
    prepaymentMode: null,
    ...overrides,
  } as Account;
}

const RATE_STEP: LoanRateChange[] = [
  {
    id: 'rc-1',
    accountId: 'mortgage-1',
    effectiveDate: '2027-01-01',
    annualRate: 4,
    newPaymentAmount: null,
    source: 'manual',
    note: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
];

function project(account: Account, rateChanges: LoanRateChange[] = RATE_STEP) {
  const history = deriveLoanPaymentHistory(account, [], rateChanges);
  return buildLoanProjectionInput(account, history, rateChanges, ANCHOR, TODAY);
}

describe('buildLoanProjectionInput: LINEAR and INTEREST_ONLY', () => {
  it('needs no stored payment, and passes the method terms counted from row 1', () => {
    const input = project(mortgage());
    expect(input).not.toBeNull();
    expect(input?.mortgageType).toBe('LINEAR');
    expect(input?.methodTerms).toEqual({
      prepaymentMode: 'SHORTEN_TERM',
      constantPrincipal: 833.3333,
      scheduledPayments: 360,
      // 2025-07-01 is payment 19: 342 left, itself included.
      remainingAtFirstRow: 342,
      termEndDate: '2053-12-01',
    });
  });

  it("prices row 1 as the anchor's bill (INV-LOAN-006 parity, spec table 7.1)", () => {
    const input = project(mortgage())!;
    const first = generateLoanSchedule(input).rows[0];
    expect(first).toMatchObject({
      date: '2025-07-01',
      principal: 833.33,
      interest: 441.67,
      payment: 1275,
    });
    // `paymentAmount` is that first installment, for the simulator's budget
    // floor and the goal-seek's bound; the engine does not read it.
    expect(input.paymentAmount).toBe(1275);
  });

  it('with the second repayment simulated, follows table 7.1 to 2050-06-01', () => {
    // The simulator's lump sum lands after the 2025-12-01 row, so it counts for
    // the 2026-01-01 installment, as the ledger repayment does in the spec.
    const schedule = generateLoanSchedule({
      ...project(mortgage())!,
      overpayments: { lumpSums: [{ date: '2025-12-01', amount: 15000 }] },
    });
    expect(schedule.rows.find((r) => r.date === '2026-01-01')).toMatchObject({
      principal: 833.33,
      interest: 408.33,
      payment: 1241.67,
    });
    expect(schedule.rows.find((r) => r.date === '2027-01-01')).toMatchObject({
      principal: 833.33,
      interest: 783.33,
    });
    expect(schedule.payoffDate).toBe('2050-06-01');
  });

  it('prices a LOWER_INSTALLMENT mortgage over the payments left (spec table 7.3)', () => {
    const first = generateLoanSchedule(
      project(mortgage({ prepaymentMode: 'LOWER_INSTALLMENT' }))!,
    ).rows[0];
    expect(first).toMatchObject({ principal: 774.85, interest: 441.67, payment: 1216.52 });
  });

  it('starts an unanchored projection on the next due date of its own calendar', () => {
    // Without a scheduled payment there is no bill to anchor on; one period
    // past today (2025-07-15) would date every row, and the bullet, off the
    // calendar the mortgage is paid on.
    const account = mortgage({ mortgageType: 'INTEREST_ONLY' });
    const input = buildLoanProjectionInput(
      account,
      deriveLoanPaymentHistory(account, []),
      [],
      null,
      TODAY,
    )!;
    expect(input.firstPaymentDate).toEqual(new Date(2025, 6, 1));
    expect(input.methodTerms?.remainingAtFirstRow).toBe(342);
    expect(generateLoanSchedule(input).payoffDate).toBe('2053-12-01');
  });

  it('projects an INTEREST_ONLY mortgage to its bullet on the term end', () => {
    const schedule = generateLoanSchedule(
      project(mortgage({ mortgageType: 'INTEREST_ONLY', currentBalance: -280000 }), [])!,
    );
    expect(schedule.rows[0]).toMatchObject({ principal: 0, interest: 441.67 });
    expect(schedule.payoffDate).toBe('2053-12-01');
    expect(schedule.rows[schedule.rows.length - 1].principal).toBe(265000);
  });
});

describe('diagnoseLoanProjection: the terms a method needs (spec section 8)', () => {
  const reasonFor = (account: Account) =>
    diagnoseLoanProjection(
      account,
      deriveLoanPaymentHistory(account, []),
      [],
      ANCHOR,
      TODAY,
    );

  it.each([
    ['no-amortization', { amortizationMonths: null }],
    ['no-payment-start', { paymentStartDate: null }],
    ['no-principal', { originalPrincipal: null, openingBalance: 0 }],
  ] as const)('reports %s, and builds no input', (reason, overrides) => {
    const account = mortgage(overrides);
    expect(reasonFor(account)).toBe(reason);
    expect(project(account, [])).toBeNull();
  });

  it('needs no principal for INTEREST_ONLY or a LOWER_INSTALLMENT LINEAR', () => {
    expect(
      reasonFor(mortgage({ mortgageType: 'INTEREST_ONLY', originalPrincipal: null, openingBalance: 0 })),
    ).toBeNull();
    expect(
      reasonFor(
        mortgage({ prepaymentMode: 'LOWER_INSTALLMENT', originalPrincipal: null, openingBalance: 0 }),
      ),
    ).toBeNull();
  });

  it('still reports a missing rate first', () => {
    expect(reasonFor(mortgage({ interestRate: null, amortizationMonths: null }))).toBe('no-rate');
  });
});

describe('resolveCurrentLoanTerms: LINEAR and INTEREST_ONLY', () => {
  const termsFor = (account: Account, rateChanges: LoanRateChange[] = []) =>
    resolveCurrentLoanTerms(
      account,
      deriveLoanPaymentHistory(account, [], rateChanges),
      rateChanges,
      ANCHOR,
      TODAY,
    );

  it('is the next installment, with its date, never account.paymentAmount', () => {
    expect(termsFor(mortgage({ paymentAmount: 9999 }))).toEqual({
      annualRate: 2,
      payment: 1275,
      paymentDate: '2025-07-01',
      finalPayment: null,
    });
  });

  it('adds the bullet and its date for INTEREST_ONLY', () => {
    expect(termsFor(mortgage({ mortgageType: 'INTEREST_ONLY', currentBalance: -280000 }))).toEqual({
      annualRate: 2,
      payment: 441.67,
      paymentDate: '2025-07-01',
      finalPayment: { amount: 265441.67, date: '2053-12-01' },
    });
  });

  it('keeps the rate but knows no installment when the projection is withheld', () => {
    expect(termsFor(mortgage({ amortizationMonths: null }))).toEqual({
      annualRate: 2,
      payment: null,
      paymentDate: null,
      finalPayment: null,
    });
  });

  it('leaves an annuity undated', () => {
    const terms = termsFor(mortgage({ mortgageType: 'ANNUITY', paymentAmount: 1108.86 }));
    expect(terms.payment).toBe(1108.86);
    expect(terms.paymentDate).toBeNull();
    expect(terms.finalPayment).toBeNull();
  });
});

describe('computePastImpact: the contractual schedule is the method\'s', () => {
  it('runs a LINEAR mortgage\'s own schedule from P at the first payment date', () => {
    const account = mortgage();
    // The rate history as the server keeps it: the first recorded change
    // inserts the origination rate as an `initial` row.
    const history: LoanRateChange[] = [
      { ...RATE_STEP[0], id: 'rc-0', effectiveDate: '2024-01-01', annualRate: 2, source: 'initial' },
      ...RATE_STEP,
    ];
    const impact = computePastImpact(
      account,
      deriveLoanPaymentHistory(account, [], history),
      null,
      history,
    );
    expect(impact).not.toBeNull();
    const original = impact!.originalSchedule;
    // Payment N on the term end, the constant principal on every row, the
    // rate step moving only the interest.
    expect(original.rows[0]).toMatchObject({ date: '2024-01-01', principal: 833.33, interest: 500 });
    expect(original.numPayments).toBe(360);
    expect(original.payoffDate).toBe('2053-12-01');
    expect(original.rows.find((r) => r.date === '2027-01-01')?.principal).toBe(833.33);
  });

  it('runs an INTEREST_ONLY mortgage to its bullet', () => {
    const account = mortgage({ mortgageType: 'INTEREST_ONLY' });
    const original = computePastImpact(account, deriveLoanPaymentHistory(account, []))!
      .originalSchedule;
    expect(original.rows[0]).toMatchObject({ principal: 0, interest: 500 });
    expect(original.rows[original.rows.length - 1]).toMatchObject({
      date: '2053-12-01',
      principal: 300000,
      payment: 300500,
    });
  });

  it('has no contractual baseline without the calendar it needs', () => {
    const account = mortgage({ paymentStartDate: null });
    expect(computePastImpact(account, deriveLoanPaymentHistory(account, []))).toBeNull();
  });
});

describe('compareSchedules on a schedule without a level installment', () => {
  it('reports no installment drop, only time and interest', () => {
    const input = project(mortgage({ prepaymentMode: 'LOWER_INSTALLMENT' }), [])!;
    const baseline = generateLoanSchedule(input);
    const scenario = generateLoanSchedule({
      ...input,
      overpayments: { lumpSums: [{ date: '2025-07-01', amount: 20000 }] },
    });
    expect(scenario.levelInstallment).toBe(false);
    const comparison = compareSchedules(baseline, scenario);
    expect(comparison.installmentReduction).toBeNull();
    // LOWER_INSTALLMENT holds the term end: no time saved, real interest saved.
    expect(comparison.paymentsSaved).toBe(0);
    expect(comparison.interestSaved).toBeGreaterThan(0);
  });
});

describe('the goal-seek on a LINEAR mortgage', () => {
  it('bounds its search by the first projected installment and reaches a payoff month', () => {
    const input = project(mortgage(), [])!;
    const solved = solveRecurringForPayoffMonth(input, '2040-06', 'SHORTEN_TERM');
    expect(solved.status).toBe('ok');
    expect(solved.result?.paidOff).toBe(true);
    expect(solved.result!.payoffDate! <= '2040-06-31').toBe(true);
  });
});
