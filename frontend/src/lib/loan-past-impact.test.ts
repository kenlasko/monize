import { describe, it, expect } from 'vitest';
import { computePastImpact } from './loan-past-impact';
import { deriveLoanPaymentHistory, LoanHistoryResult } from './loan-history';
import { calculateMortgagePaymentAmount, generateLoanSchedule } from './loan-schedule';
import { Account } from '@/types/account';
import { Transaction } from '@/types/transaction';

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'loan-1',
    accountType: 'LOAN',
    name: 'Car Loan',
    currencyCode: 'CAD',
    openingBalance: -10000,
    currentBalance: -8000,
    interestRate: 6,
    paymentAmount: 500,
    paymentFrequency: 'MONTHLY',
    paymentStartDate: '2025-01-15',
    originalPrincipal: 10000,
    amortizationMonths: null,
    isCanadianMortgage: false,
    isVariableRate: false,
    ...overrides,
  } as Account;
}

function makeHistory(account: Account, principals: number[]): LoanHistoryResult {
  const transactions = principals.map(
    (amount, i) =>
      ({
        id: `tx-${i}`,
        accountId: account.id,
        transactionDate: `2025-${String(i + 1).padStart(2, '0')}-15`,
        amount,
        linkedTransaction: null,
      }) as Transaction,
  );
  return deriveLoanPaymentHistory(account, transactions);
}

describe('computePastImpact', () => {
  it('returns null without a rate, frequency, or determinable payment', () => {
    const account = makeAccount();
    const history = makeHistory(account, [450]);

    expect(computePastImpact(makeAccount({ interestRate: null }), history)).toBeNull();
    expect(computePastImpact(makeAccount({ paymentFrequency: null }), history)).toBeNull();
    // A loan with no amortization period and no payment amount has no
    // contractual payment to build a schedule from.
    expect(computePastImpact(makeAccount({ paymentAmount: null }), history)).toBeNull();
  });

  it('returns null when there is no principal, start date, or history', () => {
    const bare = makeAccount({
      originalPrincipal: null,
      openingBalance: 0,
      currentBalance: 0,
      paymentStartDate: null,
    });
    const emptyHistory = deriveLoanPaymentHistory(bare, []);

    expect(computePastImpact(bare, emptyHistory)).toBeNull();
  });

  it('falls back to the opening balance for the original principal', () => {
    // A mortgage imported with only its opening balance set, not originalPrincipal
    const account = makeAccount({
      accountType: 'MORTGAGE',
      originalPrincipal: null,
      openingBalance: -300000,
      currentBalance: -280000,
      amortizationMonths: 300,
      interestRate: 5,
      paymentAmount: 1750,
    });
    const history = makeHistory(account, [1750, 1750]);

    const impact = computePastImpact(account, history);

    expect(impact).not.toBeNull();
    // Schedule anchored at the 300k opening balance
    expect(impact!.originalSchedule.rows[0].balance).toBeLessThan(300000);
    expect(impact!.originalSchedule.rows[0].balance).toBeGreaterThan(290000);
  });

  it('reconstructs the original principal from history when no opening balance is set', () => {
    // A mortgage imported from Quicken/MS Money with neither originalPrincipal
    // nor an opening balance, and an initial advance recorded as a draw. The
    // draw forces the ledger derivation path, which leaves history's
    // startingBalance at zero, so the impact must be reconstructed from the
    // payments themselves (current balance + principal already repaid).
    const account = makeAccount({
      accountType: 'MORTGAGE',
      originalPrincipal: null,
      openingBalance: 0,
      currentBalance: -283500,
      amortizationMonths: 300,
      interestRate: 5,
      paymentAmount: 1750,
      paymentStartDate: null,
    });
    const transactions = [
      // Initial advance (a draw); makes hasDraws true -> ledger path
      { id: 'adv', accountId: account.id, transactionDate: '2025-01-01', amount: -287000, linkedTransaction: null },
      { id: 'p1', accountId: account.id, transactionDate: '2025-01-15', amount: 1750, linkedTransaction: null },
      { id: 'p2', accountId: account.id, transactionDate: '2025-02-15', amount: 1750, linkedTransaction: null },
    ] as Transaction[];
    const history = deriveLoanPaymentHistory(account, transactions);
    expect(history.startingBalance).toBe(0); // ledger path with no opening balance

    const impact = computePastImpact(account, history);

    // Previously this returned null and showed the "set the original principal"
    // message; now the schedule is reconstructed from 283500 + 3500 repaid.
    expect(impact).not.toBeNull();
    expect(impact!.originalSchedule.rows[0].balance).toBeGreaterThan(285000);
    expect(impact!.originalSchedule.rows[0].balance).toBeLessThan(287000);
  });

  it('falls back to the earliest payment date when the start date is unset', () => {
    const account = makeAccount({ paymentStartDate: null });
    const history = makeHistory(account, [450, 450]); // events on 2025-01-15, 2025-02-15

    const impact = computePastImpact(account, history);

    expect(impact).not.toBeNull();
    expect(impact!.originalSchedule.rows[0].date).toBe('2025-01-15');
  });

  it('sums the principal of payments tagged as overpayments', () => {
    // Two regular payments plus two overpayments recognized by the loan's
    // overpayment memo; the extra principal paid is the sum of the two
    // overpayments, matching what the installment schedule surfaces.
    const account = makeAccount({ currentBalance: -5000, overpaymentMemo: 'extra' });
    const transactions = [
      { id: 'r1', accountId: account.id, transactionDate: '2025-01-15', amount: 500, linkedTransaction: null },
      { id: 'o1', accountId: account.id, transactionDate: '2025-02-10', amount: 1500, description: 'extra principal', linkedTransaction: null },
      { id: 'r2', accountId: account.id, transactionDate: '2025-02-15', amount: 500, linkedTransaction: null },
      { id: 'o2', accountId: account.id, transactionDate: '2025-03-10', amount: 2500, description: 'EXTRA to principal', linkedTransaction: null },
    ] as Transaction[];
    const history = deriveLoanPaymentHistory(account, transactions);

    const impact = computePastImpact(account, history, new Date(2025, 5, 20))!;

    expect(impact.extraPrincipalPaid).toBeCloseTo(1500 + 2500, 2);
  });

  it('reports zero extra principal when no payment is tagged as an overpayment', () => {
    // Plain payments with no overpayment category or memo -> nothing classified
    const account = makeAccount({ currentBalance: -5000 });
    const history = makeHistory(account, [500, 500]);
    const asOf = new Date(2025, 5, 20);

    const impact = computePastImpact(account, history, asOf)!;

    expect(impact.extraPrincipalPaid).toBe(0);
  });

  it('shows positive savings when extra principal was paid', () => {
    // A ~30-year contract (200k at 6% with 1200/mo from 2020) mostly paid
    // down by 20k/mo overpayments in its first year: the projection from the
    // remaining 40k balance ends decades before the original 2050 payoff.
    // The wide margin keeps the assertion stable regardless of the test's
    // run date (the current projection starts from "today").
    const account = makeAccount({
      originalPrincipal: 200000,
      currentBalance: -40000,
      paymentAmount: 1200,
      paymentStartDate: '2020-01-15',
    });
    const transactions = Array.from(
      { length: 8 },
      (_, i) =>
        ({
          id: `tx-${i}`,
          accountId: account.id,
          transactionDate: `2020-${String(i + 1).padStart(2, '0')}-15`,
          amount: 20000,
          linkedTransaction: null,
        }) as Transaction,
    );
    const history = deriveLoanPaymentHistory(account, transactions);

    const impact = computePastImpact(account, history);

    expect(impact).not.toBeNull();
    expect(impact!.originalSchedule.paidOff).toBe(true);
    expect(impact!.currentProjection).not.toBeNull();
    expect(impact!.monthsAlreadySaved).toBeGreaterThan(0);
    expect(impact!.interestAlreadySaved).toBeGreaterThan(0);
    expect(impact!.currentPayoffDate! < impact!.originalPayoffDate!).toBe(true);
  });

  it('shows zero savings for a loan paid exactly on contract', () => {
    // Reproduce the original schedule's own first four payments
    const original = generateLoanSchedule({
      startingBalance: 10000,
      annualRate: 6,
      paymentAmount: 500,
      frequency: 'MONTHLY',
      firstPaymentDate: new Date(2025, 0, 15),
    });
    const paidPrincipals = original.rows.slice(0, 4).map((row) => row.principal);
    const remaining = original.rows[3].balance;
    const history = makeHistory(makeAccount({ currentBalance: -remaining }), paidPrincipals);

    const impact = computePastImpact(
      makeAccount({ currentBalance: -remaining }),
      history,
    );

    expect(impact).not.toBeNull();
    // On-contract payments leave the projection within a month of the original
    expect(impact!.monthsAlreadySaved).toBeLessThanOrEqual(1);
    // No interest was recorded in history (no linked splits), so the saving
    // is capped rather than negative
    expect(impact!.interestAlreadySaved).toBeGreaterThanOrEqual(0);
  });

  it('derives the mortgage contractual payment from the amortization period', () => {
    const account = makeAccount({
      accountType: 'MORTGAGE',
      originalPrincipal: 300000,
      currentBalance: -290000,
      interestRate: 5,
      amortizationMonths: 300,
      isCanadianMortgage: true,
      paymentAmount: 2000,
    });
    const history = makeHistory(account, [10000]);

    const impact = computePastImpact(account, history);

    expect(impact).not.toBeNull();
    const expectedPayment = calculateMortgagePaymentAmount(300000, 5, 300, 'MONTHLY', true, false);
    // The original schedule amortizes with the derived payment: its first
    // row's payment matches the PMT-derived amount
    expect(impact!.originalSchedule.rows[0].payment).toBeCloseTo(expectedPayment, 0);
    expect(impact!.originalSchedule.numPayments).toBeGreaterThan(295);
    expect(impact!.originalSchedule.numPayments).toBeLessThanOrEqual(301);
  });

  it('uses the final actual payment as payoff for an already paid-off loan', () => {
    const account = makeAccount({ currentBalance: 0 });
    const history = makeHistory(account, [5000, 5000]);

    const impact = computePastImpact(account, history);

    expect(impact).not.toBeNull();
    expect(impact!.currentProjection).toBeNull();
    expect(impact!.currentPayoffDate).toBe('2025-02-15');
    expect(impact!.monthsAlreadySaved).toBeGreaterThan(0);
  });

  it('completes original schedules longer than the default projection cap', () => {
    // 25-year weekly mortgage: 1300 payments, beyond the 600 default cap
    const account = makeAccount({
      accountType: 'MORTGAGE',
      originalPrincipal: 300000,
      currentBalance: -299000,
      interestRate: 5,
      amortizationMonths: 300,
      paymentFrequency: 'WEEKLY' as Account['paymentFrequency'],
      paymentAmount: 405,
    });
    const history = makeHistory(account, [1000]);

    const impact = computePastImpact(account, history);

    expect(impact).not.toBeNull();
    expect(impact!.originalSchedule.paidOff).toBe(true);
    expect(impact!.originalSchedule.numPayments).toBeGreaterThan(600);
  });
});

describe('computePastImpact with rate history', () => {
  it('reproduces the no-history output exactly with an empty timeline', () => {
    const account = makeAccount();
    const history = makeHistory(account, [450, 450]);

    const asOf = new Date(2025, 5, 15);
    const without = computePastImpact(account, history, asOf);
    const withEmpty = computePastImpact(account, history, asOf, []);

    expect(withEmpty).toEqual(without);
  });

  it('builds the baseline from the origination rate, not the mutated scalar', () => {
    // The account's scalar rate was overwritten to 4% by a rate change; the
    // history preserves the 6% origination rate and the step.
    const account = makeAccount({ interestRate: 4 });
    const history = makeHistory(account, [450, 450]);
    const rateChanges = [
      { effectiveDate: '2025-01-15', annualRate: 6, newPaymentAmount: 500 },
      { effectiveDate: '2025-03-01', annualRate: 4, newPaymentAmount: null },
    ];

    const asOf = new Date(2025, 5, 15);
    const impact = computePastImpact(account, history, asOf, rateChanges);

    expect(impact).not.toBeNull();
    // Rows before the step accrue at 6%, after it at 4%
    expect(impact!.originalSchedule.rows[0].annualRate).toBe(6);
    expect(impact!.originalSchedule.rows[0].interest).toBeCloseTo(10000 * 0.005, 2);
    const afterStep = impact!.originalSchedule.rows[3];
    expect(afterStep.annualRate).toBe(4);
  });

  it('applies the recorded rate steps to the baseline without overpayments', () => {
    const account = makeAccount();
    const history = makeHistory(account, [450, 450]);
    const rateChanges = [
      { effectiveDate: '2025-06-01', annualRate: 12, newPaymentAmount: null },
    ];

    const asOf = new Date(2025, 5, 15);
    const withStep = computePastImpact(account, history, asOf, rateChanges)!;
    const withoutStep = computePastImpact(account, history, asOf)!;

    // A rate hike in the baseline means more contractual interest
    expect(withStep.originalSchedule.totalInterest).toBeGreaterThan(
      withoutStep.originalSchedule.totalInterest,
    );
  });

  it('applies only future-dated steps to the current projection', () => {
    const account = makeAccount();
    const history = makeHistory(account, [450, 450]);
    const asOf = new Date(2025, 5, 15);
    const rateChanges = [
      // Past step: already reflected in the scalar rate, must not double-apply
      { effectiveDate: '2025-03-01', annualRate: 6, newPaymentAmount: null },
      // Future step: the projection should bend at this date
      { effectiveDate: '2025-09-01', annualRate: 12, newPaymentAmount: null },
    ];

    const impact = computePastImpact(account, history, asOf, rateChanges)!;

    expect(impact.currentProjection).not.toBeNull();
    const rows = impact.currentProjection!.rows;
    expect(rows[0].annualRate).toBe(6);
    const septemberOn = rows.filter((row) => row.date >= '2025-09-01');
    expect(septemberOn[0].annualRate).toBe(12);
  });
});
