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
    // A repayment period is required in the UI; ~21 months amortizes the
    // default 10k at 6% near the default 500 payment.
    amortizationMonths: 21,
    isCanadianMortgage: false,
    isVariableRate: false,
    ...overrides,
  } as Account;
}

function makeHistory(
  account: Account,
  principals: number[],
  dates?: string[],
): LoanHistoryResult {
  const transactions = principals.map(
    (amount, i) =>
      ({
        id: `tx-${i}`,
        accountId: account.id,
        transactionDate: dates?.[i] ?? `2025-${String(i + 1).padStart(2, '0')}-15`,
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
    // The repayment period is required; without a configured amortization or
    // term there is no contractual baseline to build.
    expect(
      computePastImpact(makeAccount({ amortizationMonths: null, termMonths: null }), history),
    ).toBeNull();
  });

  it('ignores principal-only payment steps in the rate history so the schedule completes', () => {
    // An old detect run left a rate row that also set a principal-only payment
    // (285). Applied mid-schedule it cannot cover interest and would stall the
    // contractual schedule -- the payoff must still be reached by keeping the
    // contractual installment.
    const account = makeAccount({
      originalPrincipal: 200000,
      currentBalance: -180000,
      paymentAmount: 1200,
      amortizationMonths: 360,
      paymentStartDate: '2020-01-15',
    });
    const history = makeHistory(makeAccount(), [1200, 1200, 1200]);
    const rateChanges = [{ effectiveDate: '2020-06-01', annualRate: 6, newPaymentAmount: 285 }];

    const impact = computePastImpact(account, history, null, rateChanges);

    expect(impact).not.toBeNull();
    expect(impact!.originalSchedule.payoffDate).not.toBeNull();
    expect(impact!.originalPayoffDate).not.toBeNull();
  });

  it('bounds the contractual schedule by the configured repayment term', () => {
    // 23y8m = 284 months in `termMonths` (no amortizationMonths). Even with a
    // too-small stored payment, the schedule must not run past the term.
    const account = makeAccount({
      originalPrincipal: 200000,
      currentBalance: -100000,
      interestRate: 6,
      paymentAmount: 1050,
      amortizationMonths: null,
      termMonths: 284,
      paymentStartDate: '2020-01-15',
    });
    const history = makeHistory(account, [1050, 1050]);

    const impact = computePastImpact(account, history)!;

    expect(impact.originalSchedule.paidOff).toBe(true);
    // Amortizes over ~284 payments, never longer.
    expect(impact.originalSchedule.numPayments).toBeLessThanOrEqual(285);
    expect(impact.originalSchedule.numPayments).toBeGreaterThan(270);
  });

  it('re-levels the contractual payment on a rate rise so the schedule holds its term', () => {
    // Variable rate starting at 2% and rising to 6% mid-way (the recorded rate
    // history). The initial payment, sized at 2%, cannot cover 6% interest --
    // re-levelling must keep the schedule amortizing to the term, not stall.
    const account = makeAccount({
      accountType: 'MORTGAGE',
      originalPrincipal: 200000,
      currentBalance: -150000,
      interestRate: 6,
      amortizationMonths: 284,
      paymentStartDate: '2020-01-15',
    });
    const history = makeHistory(account, [1000, 1000]);
    const rateChanges = [
      { effectiveDate: '2020-01-01', annualRate: 2 },
      { effectiveDate: '2022-01-01', annualRate: 6, newPaymentAmount: 300 },
    ];

    const impact = computePastImpact(account, history, null, rateChanges)!;

    expect(impact.originalSchedule.paidOff).toBe(true);
    expect(impact.originalSchedule.payoffDate).not.toBeNull();
    expect(impact.originalSchedule.numPayments).toBeLessThanOrEqual(285);
    expect(impact.originalSchedule.numPayments).toBeGreaterThan(270);
  });

  it('follows the recorded installment so a fast-paid loan is not stretched to its amortization term', () => {
    // A 25-year (300-month) mortgage whose real regular payment -- recorded on
    // the initial rate row (interest booked as a split leg, so the payment is
    // the full installment) -- is far larger than the 300-month minimum, paying
    // it off in ~5 years. The contractual "if I never overpaid" schedule must
    // follow that recorded installment and pay off early, not draw the
    // theoretical minimum-payment curve stretching to 300 months.
    const account = makeAccount({
      accountType: 'MORTGAGE',
      originalPrincipal: 180000,
      currentBalance: -120000,
      interestRate: 1.75,
      paymentAmount: 3200,
      amortizationMonths: 300,
      paymentStartDate: '2022-04-25',
    });
    const history = makeHistory(account, [3200, 3200, 3200]);
    const rateChanges = [
      { effectiveDate: '2022-04-25', annualRate: 1.75, newPaymentAmount: 3200 },
    ];

    const impact = computePastImpact(account, history, null, rateChanges)!;

    expect(impact.originalSchedule.paidOff).toBe(true);
    // ~59 monthly payments at 1.75% -- an order of magnitude below the 300-month
    // amortization term the old PMT-over-term curve would have drawn.
    expect(impact.originalSchedule.numPayments).toBeLessThan(80);
    expect(impact.originalSchedule.numPayments).toBeGreaterThan(45);
  });

  it('starts at the initial rate row payment when paymentStartDate precedes that row', () => {
    // Real dataset shape: paymentStartDate is the origination date (2022-04-25),
    // but rate detection dates the initial row at the FIRST INSTALLMENT
    // (2022-05-13). The starting payment must fall back to that row's recorded
    // installment -- otherwise the schedule silently drops to the PMT-over-term
    // minimum payment and stretches a ~4-year payoff to the full 25-year
    // amortization. Variable-rate Canadian mortgage, accelerated bi-weekly,
    // with the recorded rate/payment steps.
    const account = makeAccount({
      accountType: 'MORTGAGE',
      originalPrincipal: 300000,
      currentBalance: 0,
      interestRate: 3.5,
      paymentAmount: 0,
      paymentFrequency: 'ACCELERATED_BIWEEKLY',
      amortizationMonths: 300,
      termMonths: 60,
      paymentStartDate: '2022-04-25',
      isCanadianMortgage: true,
      isVariableRate: true,
    });
    // The schedule now starts at the earliest actual payment, so the recorded
    // transactions sit on the real installment dates (2022-05-13 onward), not a
    // synthetic 2025 stub -- otherwise the baseline would start years late.
    const history = makeHistory(
      account,
      [3200, 3200, 3200],
      ['2022-05-13', '2022-06-24', '2022-08-05'],
    );
    const rateChanges = [
      { effectiveDate: '2022-05-13', annualRate: 1.75, newPaymentAmount: 3200 },
      { effectiveDate: '2022-06-24', annualRate: 2.25, newPaymentAmount: 3233.04 },
      { effectiveDate: '2022-08-05', annualRate: 3.25, newPaymentAmount: 3303.43 },
      { effectiveDate: '2022-09-30', annualRate: 4.0, newPaymentAmount: 3127.05 },
      { effectiveDate: '2022-11-11', annualRate: 4.5, newPaymentAmount: 3264.52 },
      { effectiveDate: '2022-12-23', annualRate: 5.0, newPaymentAmount: 3300.06 },
      { effectiveDate: '2023-02-17', annualRate: 5.25, newPaymentAmount: 3319.16 },
      { effectiveDate: '2023-06-23', annualRate: 5.5, newPaymentAmount: 3332.64 },
      { effectiveDate: '2023-08-04', annualRate: 5.75, newPaymentAmount: 4050.54 },
      { effectiveDate: '2024-06-21', annualRate: 5.5, newPaymentAmount: null },
      { effectiveDate: '2024-08-16', annualRate: 5.25, newPaymentAmount: null },
      { effectiveDate: '2024-09-27', annualRate: 5.0, newPaymentAmount: null },
      { effectiveDate: '2024-11-08', annualRate: 4.5, newPaymentAmount: 4228.27 },
      { effectiveDate: '2025-01-03', annualRate: 4.0, newPaymentAmount: null },
      { effectiveDate: '2025-02-14', annualRate: 3.75, newPaymentAmount: null },
      { effectiveDate: '2025-03-28', annualRate: 3.5, newPaymentAmount: null },
    ];

    const impact = computePastImpact(account, history, null, rateChanges)!;

    expect(impact.originalSchedule.paidOff).toBe(true);
    // ~100 bi-weekly payments (payoff early 2026) -- an order of magnitude below
    // the 650-period amortization the PMT fallback would stretch to (2047).
    expect(impact.originalSchedule.numPayments).toBeLessThan(130);
    expect(impact.originalSchedule.payoffDate! < '2027-01-01').toBe(true);
    expect(impact.originalSchedule.payoffDate! > '2025-01-01').toBe(true);
  });

  it('runs a fresh accelerated bi-weekly contractual schedule to its early payoff (issue #909)', () => {
    // No recorded installment yet (fresh mortgage) -> the PMT fallback path. The
    // accelerated payment (monthly / 2) is larger than the amortizing bi-weekly
    // installment, so the contractual loan must pay off before its nominal
    // 25-year term and NOT be re-levelled down to fill it.
    const account = makeAccount({
      accountType: 'MORTGAGE',
      originalPrincipal: 300000,
      currentBalance: -300000,
      interestRate: 4,
      paymentAmount: 0,
      paymentFrequency: 'ACCELERATED_BIWEEKLY',
      amortizationMonths: 300,
      termMonths: 60,
      paymentStartDate: '2025-01-15',
      isCanadianMortgage: true,
      isVariableRate: false,
    });
    const history = makeHistory(account, []);

    const impact = computePastImpact(account, history)!;

    // Reference: the same fixed accelerated payment run to payoff, i.e. what the
    // current-projection curve draws. The contractual curve must match it.
    const accelPayment = calculateMortgagePaymentAmount(
      300000,
      4,
      300,
      'ACCELERATED_BIWEEKLY',
      true,
      false,
    );
    const reference = generateLoanSchedule({
      startingBalance: 300000,
      annualRate: 4,
      paymentAmount: accelPayment,
      frequency: 'ACCELERATED_BIWEEKLY',
      isCanadian: true,
      isVariableRate: false,
      firstPaymentDate: new Date('2025-01-15'),
    });

    expect(impact.originalSchedule.paidOff).toBe(true);
    // Pays off well before the 650-period (25y) nominal amortization, matching
    // the accelerated schedule rather than a re-levelled full-term one.
    expect(impact.originalSchedule.numPayments).toBeLessThan(650);
    expect(impact.originalSchedule.numPayments).toBe(reference.numPayments);
  });

  it('falls back to the term when interest is booked separately (no recorded installment)', () => {
    // The same mortgage, but interest booked separately leaves the rate rows'
    // payment null (see rate-change inference). With no recorded installment the
    // contractual schedule uses the PMT over the configured term, exactly as
    // before -- so loans that relied on that path are unaffected by the
    // recorded-installment path above.
    const account = makeAccount({
      accountType: 'MORTGAGE',
      originalPrincipal: 180000,
      currentBalance: -120000,
      interestRate: 1.75,
      amortizationMonths: 300,
      paymentStartDate: '2022-04-25',
    });
    const history = makeHistory(account, [3200, 3200, 3200]);
    const rateChanges = [
      { effectiveDate: '2022-04-25', annualRate: 1.75, newPaymentAmount: null },
    ];

    const impact = computePastImpact(account, history, null, rateChanges)!;

    expect(impact.originalSchedule.paidOff).toBe(true);
    // Amortizes over ~300 months, not the ~59 the recorded installment gives.
    expect(impact.originalSchedule.numPayments).toBeGreaterThan(250);
  });

  it('builds the contractual schedule from the term even without a stored payment', () => {
    // The contractual payment comes from the original principal, rate, and
    // repayment period, so no stored paymentAmount is needed.
    const account = makeAccount({ paymentAmount: null });
    const history = makeHistory(makeAccount(), [450, 450, 450]);

    const impact = computePastImpact(account, history);

    expect(impact).not.toBeNull();
    expect(impact!.originalSchedule.totalInterest).toBeGreaterThan(0);
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

    const impact = computePastImpact(account, history)!;

    expect(impact.extraPrincipalPaid).toBeCloseTo(1500 + 2500, 2);
  });

  it('reports zero extra principal when no payment is tagged as an overpayment', () => {
    // Plain payments with no overpayment category or memo -> nothing classified
    const account = makeAccount({ currentBalance: -5000 });
    const history = makeHistory(account, [500, 500]);

    const impact = computePastImpact(account, history)!;

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
      amortizationMonths: 360,
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
    // The forward projection from today's remaining 40k -- the loan detail
    // page's baseline, passed in the way the app now does.
    const currentProjection = generateLoanSchedule({
      startingBalance: 40000,
      annualRate: 6,
      paymentAmount: 1200,
      frequency: 'MONTHLY',
      firstPaymentDate: new Date(2025, 0, 15),
    });

    const impact = computePastImpact(account, history, currentProjection);

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

    const without = computePastImpact(account, history);
    const withEmpty = computePastImpact(account, history, null, []);

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

    const impact = computePastImpact(account, history, null, rateChanges);

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

    const withStep = computePastImpact(account, history, null, rateChanges)!;
    const withoutStep = computePastImpact(account, history)!;

    // A rate hike in the baseline means more contractual interest
    expect(withStep.originalSchedule.totalInterest).toBeGreaterThan(
      withoutStep.originalSchedule.totalInterest,
    );
  });
});
