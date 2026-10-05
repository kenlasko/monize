import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildLoanProjectionInput,
  deriveLoanPaymentHistory,
  diagnoseLoanProjection,
  observedInstallment,
  resolveCurrentLoanTerms,
  fetchAllAccountTransactions,
  fetchLoanInterestTransactions,
} from './loan-history';
import { transactionsApi } from '@/lib/transactions';
import { generateLoanSchedule, getPeriodicRate, isoDay } from '@/lib/loan-schedule';
import { financialTodayYmd } from '@/lib/financial-today';
import { Account } from '@/types/account';
import { Transaction, TransactionSplit } from '@/types/transaction';

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: vi.fn(),
    getAllPages: vi.fn(),
  },
}));

const LOAN_ID = 'loan-1';

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: LOAN_ID,
    accountType: 'LOAN',
    name: 'Car Loan',
    openingBalance: -10000,
    currentBalance: -8000,
    interestRate: 6,
    paymentAmount: 500,
    paymentFrequency: 'MONTHLY',
    mortgageType: 'ANNUITY',
    ...overrides,
  } as Account;
}

function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: `tx-${Math.abs(overrides.amount ?? 0)}-${overrides.transactionDate}`,
    accountId: LOAN_ID,
    transactionDate: '2026-01-15',
    amount: 450,
    linkedTransaction: null,
    ...overrides,
  } as Transaction;
}

function withInterestSplit(
  transaction: Transaction,
  linkedId: string,
  interestAmount: number,
): Transaction {
  return {
    ...transaction,
    linkedTransaction: {
      id: linkedId,
      splits: [
        { transferAccountId: LOAN_ID, amount: -transaction.amount } as TransactionSplit,
        { transferAccountId: null, categoryId: 'cat-interest', amount: -interestAmount } as TransactionSplit,
      ],
    } as Transaction,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('deriveLoanPaymentHistory', () => {
  it('builds a row per repayment in date order, anchored to the opening balance', () => {
    const account = makeAccount();
    const transactions = [
      makeTransaction({ transactionDate: '2026-02-15', amount: 460 }),
      makeTransaction({ transactionDate: '2026-01-15', amount: 450 }),
    ];

    const result = deriveLoanPaymentHistory(account, transactions);

    expect(result.events).toHaveLength(2);
    expect(result.events[0].date).toBe('2026-01-15');
    expect(result.events[1].date).toBe('2026-02-15');
    expect(result.startingBalance).toBe(10000);
    expect(result.events[0].balance).toBe(10000 - 450);
    expect(result.events[1].balance).toBe(10000 - 450 - 460);
    expect(result.cumulativePrincipal).toBe(910);
    expect(result.currentBalance).toBe(8000);
  });

  it('counts draws in the running balance but emits no row for them', () => {
    // A draw between two repayments raises the debt magnitude, so the second
    // repayment's balance reflects it (10000 - 450 - 100(draw) - 460).
    const account = makeAccount();
    const transactions = [
      makeTransaction({ transactionDate: '2026-02-15', amount: 460 }),
      makeTransaction({ transactionDate: '2026-01-15', amount: 450 }),
      makeTransaction({ transactionDate: '2026-01-20', amount: -100 }), // draw
    ];

    const result = deriveLoanPaymentHistory(account, transactions);

    expect(result.events).toHaveLength(2);
    expect(result.events[0].balance).toBe(10000 - 450);
    expect(result.events[1].balance).toBe(10000 - 450 + 100 - 460);
    expect(result.cumulativePrincipal).toBe(910);
  });

  it('does not inflate a revolving line of credit opened at zero', () => {
    // A LOC that cycled near zero: draws and repayments net out. The old
    // positive-only reconstruction summed every repayment (2100) on top of the
    // balance; anchoring to the true opening of 0 keeps it honest.
    const loc = makeAccount({
      accountType: 'LINE_OF_CREDIT',
      openingBalance: 0,
      currentBalance: -200,
    });
    const transactions = [
      makeTransaction({ id: 'd1', transactionDate: '2026-01-01', amount: -1000 }), // draw
      makeTransaction({ id: 'p1', transactionDate: '2026-02-01', amount: 1000 }), // repay
      makeTransaction({ id: 'd2', transactionDate: '2026-03-01', amount: -1200 }), // draw
      makeTransaction({ id: 'p2', transactionDate: '2026-04-01', amount: 1000 }), // repay
    ];

    const result = deriveLoanPaymentHistory(loc, transactions);

    expect(result.startingBalance).toBe(0);
    // Repayment rows only; balances track real utilization
    expect(result.events).toHaveLength(2);
    expect(result.events[0].balance).toBe(0); // 0 - 1000 + 1000
    expect(result.events[1].balance).toBe(200); // ... - 1200 + 1000 => -200 magnitude
    expect(result.currentBalance).toBe(200);
  });

  it('reads interest from the linked transaction split that is not the loan transfer', () => {
    const account = makeAccount();
    const tx = withInterestSplit(
      makeTransaction({ transactionDate: '2026-01-15', amount: 450 }),
      'parent-1',
      50,
    );

    const result = deriveLoanPaymentHistory(account, [tx]);

    expect(result.events[0].interest).toBe(50);
    expect(result.events[0].principal).toBe(450);
    expect(result.cumulativeInterest).toBe(50);
  });

  it('counts a shared parent transaction interest split only once', () => {
    const account = makeAccount();
    // Regular + extra principal transfers from the same source payment
    const regular = withInterestSplit(
      makeTransaction({ id: 'tx-a', transactionDate: '2026-01-15', amount: 450 }),
      'parent-1',
      50,
    );
    const extra = withInterestSplit(
      makeTransaction({ id: 'tx-b', transactionDate: '2026-01-15', amount: 200 }),
      'parent-1',
      50,
    );

    const result = deriveLoanPaymentHistory(account, [regular, extra]);

    expect(result.events).toHaveLength(2);
    expect(result.cumulativeInterest).toBe(50);
    expect(result.cumulativePrincipal).toBe(650);
  });

  it('derives the starting balance from principal paid when openingBalance is unset', () => {
    const account = makeAccount({ openingBalance: 0, currentBalance: -8000 });
    const transactions = [
      makeTransaction({ transactionDate: '2026-01-15', amount: 450 }),
      makeTransaction({ transactionDate: '2026-02-15', amount: 550 }),
    ];

    const result = deriveLoanPaymentHistory(account, transactions);

    expect(result.startingBalance).toBe(8000 + 1000);
  });

  it('floors the running balance at zero', () => {
    const account = makeAccount({ openingBalance: -100, currentBalance: 0 });
    const result = deriveLoanPaymentHistory(account, [
      makeTransaction({ transactionDate: '2026-01-15', amount: 450 }),
    ]);
    expect(result.events[0].balance).toBe(0);
  });

  it('returns an empty history for no transactions', () => {
    const result = deriveLoanPaymentHistory(makeAccount(), []);
    expect(result.events).toHaveLength(0);
    expect(result.cumulativePrincipal).toBe(0);
    expect(result.cumulativeInterest).toBe(0);
  });

  it('records no interest for a payment with no recorded interest (issue #1255)', () => {
    // A plain principal-only transfer: no interest split, no paired separate
    // expense, no overpayment marker. It used to be given an analytic estimate
    // of 10000 * (6% / 12) = 50, so the row read Payment 500 / Principal 450 /
    // Interest 50 for a $450 payment the borrower actually made -- inflating
    // every cumulative interest figure derived from it. A historical row states
    // the ledger, so the interest is a measured zero.
    const account = makeAccount();
    const result = deriveLoanPaymentHistory(account, [
      makeTransaction({ transactionDate: '2026-01-15', amount: 450 }),
    ]);
    expect(result.events[0].type).toBe('REGULAR');
    expect(result.events[0].interest).toBe(0);
    expect(result.events[0].principal).toBe(450);
    expect(result.events[0].balance).toBe(10000 - 450);
    expect(result.cumulativeInterest).toBe(0);
  });

  it('does not estimate interest for a mortgage on the rate timeline either', () => {
    // The rate timeline was the other door into the estimate: a principal-only
    // payment on a mortgage with recorded rate changes derived ~916 of interest
    // from 200000 x 5.5% / 12 and reported it as interest paid.
    const account = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -200000,
      currentBalance: -199715,
      interestRate: 5.5,
    });
    const { events, cumulativeInterest } = deriveLoanPaymentHistory(
      account,
      [makeTransaction({ transactionDate: '2022-05-05', amount: 285 })],
      [{ effectiveDate: '2022-04-05', annualRate: 5.5 }],
    );
    expect(events[0].interest).toBe(0);
    expect(events[0].principal).toBe(285);
    expect(cumulativeInterest).toBe(0);
  });

  it('prefers a recorded interest split over reporting zero', () => {
    const account = makeAccount();
    const tx = withInterestSplit(
      makeTransaction({ transactionDate: '2026-01-15', amount: 450 }),
      'parent-1',
      42,
    );
    const result = deriveLoanPaymentHistory(account, [tx]);
    expect(result.events[0].type).toBe('REGULAR');
    expect(result.events[0].interest).toBe(42);
  });

  it('classifies overpayment-category payments as 100% principal and flags them', () => {
    const account = makeAccount({ overpaymentCategoryId: 'cat-over' });
    const result = deriveLoanPaymentHistory(account, [
      makeTransaction({
        transactionDate: '2026-01-15',
        amount: 450,
        categoryId: 'cat-over',
      }),
    ]);
    expect(result.events[0].type).toBe('OVERPAYMENT');
    expect(result.events[0].interest).toBe(0);
    expect(result.events[0].principal).toBe(450);
    expect(result.cumulativeInterest).toBe(0);
  });

  it('recognizes an overpayment tagged on the linked source transaction', () => {
    const account = makeAccount({ overpaymentCategoryId: 'cat-over' });
    const tx = {
      ...makeTransaction({ transactionDate: '2026-01-15', amount: 300 }),
      linkedTransaction: {
        id: 'p1',
        categoryId: 'cat-over',
        splits: [],
      } as unknown as Transaction,
    };
    const result = deriveLoanPaymentHistory(account, [tx]);
    expect(result.events[0].type).toBe('OVERPAYMENT');
    expect(result.events[0].interest).toBe(0);
  });

  it('classifies payments whose memo matches the overpayment memo, case-insensitively', () => {
    const account = makeAccount({ overpaymentMemo: 'Extra principal' });
    const result = deriveLoanPaymentHistory(account, [
      makeTransaction({
        transactionDate: '2026-01-15',
        amount: 450,
        description: 'JAN extra PRINCIPAL payment',
      }),
    ]);
    expect(result.events[0].type).toBe('OVERPAYMENT');
    expect(result.events[0].interest).toBe(0);
    expect(result.events[0].principal).toBe(450);
  });

  it('recognizes an overpayment memo on the linked source transaction and its splits', () => {
    const account = makeAccount({ overpaymentMemo: 'overpay' });
    const tx = {
      ...makeTransaction({ transactionDate: '2026-01-15', amount: 300 }),
      linkedTransaction: {
        id: 'p1',
        description: null,
        splits: [{ memo: 'monthly OVERPAY', amount: -300 } as TransactionSplit],
      } as unknown as Transaction,
    };
    const result = deriveLoanPaymentHistory(account, [tx]);
    expect(result.events[0].type).toBe('OVERPAYMENT');
    expect(result.events[0].interest).toBe(0);
  });

  it('treats a payment as regular when its memo does not contain the overpayment memo', () => {
    const account = makeAccount({ overpaymentMemo: 'extra principal' });
    const result = deriveLoanPaymentHistory(account, [
      makeTransaction({
        transactionDate: '2026-01-15',
        amount: 450,
        description: 'Regular monthly payment',
      }),
    ]);
    expect(result.events[0].type).toBe('REGULAR');
  });

  it('flags overpayments by memo even without an overpayment category set', () => {
    const account = makeAccount({
      overpaymentCategoryId: null,
      overpaymentMemo: 'lump sum',
      overpaymentPayeeId: null,
    });
    const result = deriveLoanPaymentHistory(account, [
      makeTransaction({
        transactionDate: '2026-01-15',
        amount: 1000,
        description: 'Annual LUMP SUM',
      }),
    ]);
    expect(result.events[0].type).toBe('OVERPAYMENT');
  });

  it('flags only the extra-principal split of a split payment, not the regular sibling', () => {
    // A single source payment splits into a regular principal transfer, its
    // interest, and a separate extra-principal transfer tagged for overpayment.
    // Both transfers post to the loan and share one parent; only the extra one
    // is an overpayment.
    const account = makeAccount({ overpaymentMemo: 'extra principal' });
    const parent = {
      id: 'p1',
      description: 'Mortgage payment',
      splits: [
        {
          transferAccountId: LOAN_ID,
          amount: -800,
          memo: 'Principal',
          linkedTransactionId: 'loan-reg',
        },
        { transferAccountId: null, categoryId: 'cat-interest', amount: -200, memo: 'Interest' },
        {
          transferAccountId: LOAN_ID,
          amount: -150,
          memo: 'Extra principal',
          linkedTransactionId: 'loan-extra',
        },
      ] as unknown as TransactionSplit[],
    } as unknown as Transaction;
    const regular = {
      ...makeTransaction({ transactionDate: '2026-01-15', amount: 800 }),
      id: 'loan-reg',
      linkedTransaction: parent,
    };
    const extra = {
      ...makeTransaction({ transactionDate: '2026-01-15', amount: 150 }),
      id: 'loan-extra',
      linkedTransaction: parent,
    };

    const result = deriveLoanPaymentHistory(account, [regular, extra]);

    const regularEvent = result.events.find((e) => e.principal === 800);
    const extraEvent = result.events.find((e) => e.principal === 150);
    expect(regularEvent?.type).toBe('REGULAR');
    expect(regularEvent?.interest).toBe(200);
    expect(extraEvent?.type).toBe('OVERPAYMENT');
    expect(extraEvent?.interest).toBe(0);
  });

  it('correlates split-payment overpayments by amount when the per-split link is absent', () => {
    // Same shape but without linkedTransactionId on the splits (legacy data):
    // the regular and extra transfers are still told apart by their amounts.
    const account = makeAccount({ overpaymentMemo: 'extra' });
    const parent = {
      id: 'p1',
      description: 'Mortgage payment',
      splits: [
        { transferAccountId: LOAN_ID, amount: -800, memo: 'Principal' },
        { transferAccountId: LOAN_ID, amount: -150, memo: 'Extra' },
      ] as unknown as TransactionSplit[],
    } as unknown as Transaction;
    const regular = {
      ...makeTransaction({ transactionDate: '2026-01-15', amount: 800 }),
      id: 'loan-reg',
      linkedTransaction: parent,
    };
    const extra = {
      ...makeTransaction({ transactionDate: '2026-01-15', amount: 150 }),
      id: 'loan-extra',
      linkedTransaction: parent,
    };

    const result = deriveLoanPaymentHistory(account, [regular, extra]);

    expect(result.events.find((e) => e.principal === 800)?.type).toBe('REGULAR');
    expect(result.events.find((e) => e.principal === 150)?.type).toBe('OVERPAYMENT');
  });

  // Every shape the estimate used to reach a row through. It read the account
  // type, the mortgage type, the payment frequency and the rate timeline, so a
  // single-fixture test only closes one door; the interest of a principal-only
  // payment is zero for all of them.
  const PRINCIPAL_ONLY_SHAPES: Array<{ label: string; account: Partial<Account> }> = [
    { label: 'loan', account: { accountType: 'LOAN' } },
    { label: 'mortgage', account: { accountType: 'MORTGAGE' } },
    { label: 'line of credit', account: { accountType: 'LINE_OF_CREDIT' } },
    {
      label: 'Canadian fixed mortgage',
      account: { accountType: 'MORTGAGE', mortgageType: 'CANADIAN_FIXED' },
    },
    {
      label: 'annuity mortgage',
      account: { accountType: 'MORTGAGE', mortgageType: 'ANNUITY' },
    },
    {
      label: 'biweekly loan',
      account: { accountType: 'LOAN', paymentFrequency: 'BIWEEKLY' },
    },
    {
      label: 'loan with no configured rate',
      account: { accountType: 'LOAN', interestRate: null as unknown as number },
    },
  ];

  for (const { label, account: overrides } of PRINCIPAL_ONLY_SHAPES) {
    for (const withTimeline of [false, true]) {
      it(`reports zero interest for a principal-only payment on a ${label}${
        withTimeline ? ' with a rate timeline' : ''
      }`, () => {
        const account = makeAccount(overrides);
        const result = deriveLoanPaymentHistory(
          account,
          [makeTransaction({ transactionDate: '2026-01-15', amount: 450 })],
          withTimeline ? [{ effectiveDate: '2025-12-15', annualRate: 6 }] : [],
        );
        expect(result.events[0].interest).toBe(0);
        expect(result.cumulativeInterest).toBe(0);
      });
    }
  }

  it('records no interest for a revolving-credit payment', () => {
    const loc = makeAccount({
      accountType: 'LINE_OF_CREDIT',
      openingBalance: -1000,
      currentBalance: -500,
    });
    const result = deriveLoanPaymentHistory(loc, [
      makeTransaction({ transactionDate: '2026-01-15', amount: 200 }),
    ]);
    expect(result.events[0].interest).toBe(0);
  });
});

describe('observedInstallment', () => {
  const history = (
    events: Array<{
      principal: number;
      interest: number;
      type: 'REGULAR' | 'OVERPAYMENT';
      annualRate?: number | null;
    }>,
  ) => ({
    events: events.map((e, i) => ({
      date: `2026-0${i + 1}-15`,
      principal: e.principal,
      interest: e.interest,
      balance: 0,
      cumulativePrincipal: 0,
      cumulativeInterest: 0,
      type: e.type,
      annualRate: e.annualRate,
    })),
    startingBalance: 0,
    currentBalance: 0,
    cumulativePrincipal: 0,
    cumulativeInterest: 0,
  });

  it('takes the last regular installment, principal + interest', () => {
    const result = observedInstallment(
      history([
        { principal: 800, interest: 200, type: 'REGULAR' },
        { principal: 765, interest: 153, type: 'REGULAR' },
      ]),
    );
    expect(result).toMatchObject({ amount: 918, complete: true });
  });

  it('reports what was observed, whatever the stored payment says', () => {
    // The stored contractual payment can be stale or principal-only; ranking the
    // two is resolveSeedPayment's job, not this function's.
    const result = observedInstallment(
      history([{ principal: 765, interest: 700, type: 'REGULAR' }]),
    );
    expect(result).toMatchObject({ amount: 1465, complete: true });
  });

  it('skips overpayment rows when finding the last regular installment', () => {
    const result = observedInstallment(
      history([
        { principal: 765, interest: 153, type: 'REGULAR' },
        { principal: 5000, interest: 0, type: 'OVERPAYMENT' },
      ]),
    );
    expect(result).toMatchObject({ amount: 918, complete: true });
  });

  it('reports nothing observed with no regular history', () => {
    // Null is what sends resolveSeedPayment to the stored contractual payment.
    expect(observedInstallment(history([]))).toBeNull();
  });

  it('dates the figure at the last REGULAR row, not the last row', () => {
    // The date is what resolveSeedPayment compares against a stated payment's
    // row to decide which statement is newer, so it has to belong to the
    // installment the amount came from -- a trailing overpayment must not move
    // it forward.
    expect(
      observedInstallment(
        history([
          { principal: 765, interest: 153, type: 'REGULAR' },
          { principal: 5000, interest: 0, type: 'OVERPAYMENT' },
        ]),
      ),
    ).toMatchObject({ amount: 918, date: '2026-01-15' });
    expect(
      observedInstallment(
        history([
          { principal: 800, interest: 200, type: 'REGULAR' },
          { principal: 765, interest: 153, type: 'REGULAR' },
        ]),
      ),
    ).toMatchObject({ date: '2026-02-15' });
  });

  it('marks a principal-only row incomplete rather than smaller', () => {
    // The distinction the contractual fallback keys off: principal + 0 is a
    // partial installment, not a lower one.
    expect(
      observedInstallment(history([{ principal: 450, interest: 0, type: 'REGULAR' }])),
    ).toMatchObject({ amount: 450, complete: false });
  });

  it('marks a principal-only row COMPLETE at a known 0% rate', () => {
    // A measured zero, not a missing figure: at 0% the interest for this row is
    // known and known to be zero, so principal + 0 IS the whole installment.
    // Treating it as incomplete discarded a fully stated installment and left an
    // interest-free loan with no payoff at all when no contractual payment was
    // stored -- "null is not the safe answer either", from the other side.
    expect(
      observedInstallment(
        history([{ principal: 450, interest: 0, type: 'REGULAR', annualRate: 0 }]),
      ),
    ).toMatchObject({ amount: 450, complete: true });
  });

  it('keeps a principal-only row incomplete at a known NON-zero rate', () => {
    expect(
      observedInstallment(
        history([{ principal: 450, interest: 0, type: 'REGULAR', annualRate: 5 }]),
      ),
    ).toMatchObject({ amount: 450, complete: false });
  });

  it('keeps a principal-only row incomplete when the rate is unknown', () => {
    // No rate on record for this row, so the interest could be anything.
    // Strictly `=== 0`, never falsy.
    expect(
      observedInstallment(
        history([{ principal: 450, interest: 0, type: 'REGULAR', annualRate: null }]),
      ),
    ).toMatchObject({ amount: 450, complete: false });
  });

  it('uses principal + interest for separately-booked interest', () => {
    // Interest booked as a separate transaction is paired to the payment's date
    // from the ledger -- the rate timeline describes the rate, it never
    // manufactures historical interest. Principal + that recorded interest is
    // the real installment, so it is used directly rather than the possibly
    // principal-only stored payment. (Whether it covers the period's interest is
    // buildLoanProjectionInput's decision, not this function's -- a row whose
    // interest the ledger never recorded contributes principal + 0.)
    const result = observedInstallment(
      history([
        { principal: 300, interest: 300, type: 'REGULAR' },
        { principal: 300, interest: 300, type: 'REGULAR' },
      ]),
    );
    expect(result).toMatchObject({ amount: 600, complete: true });
  });
});

describe('buildLoanProjectionInput seed payment', () => {
  // 199715 x 5.5% / 12 = 915.36: what one period costs, so any seed at or below
  // it can never amortize.
  const PERIOD_INTEREST = 199715 * (5.5 / 100 / 12);
  const account = (overrides: Partial<Account> = {}) =>
    makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -200000,
      currentBalance: -199715,
      interestRate: 5.5,
      paymentAmount: 1200,
      paymentFrequency: 'MONTHLY',
      ...overrides,
    });
  const principalOnlyHistory = (acct: Account) =>
    deriveLoanPaymentHistory(acct, [
      makeTransaction({ transactionDate: '2022-05-05', amount: 285 }),
    ]);

  it('falls back to the contractual payment when history alone cannot amortize', () => {
    // The loan books its interest outside the app, so history yields 285 + 0 --
    // well under the 915.36 one period costs. Before #1255 an estimate topped
    // that up into something installment-shaped; the honest seed is the stored
    // contractual payment, which is a real fact about the loan.
    const acct = account();
    const input = buildLoanProjectionInput(acct, principalOnlyHistory(acct));
    expect(input).not.toBeNull();
    expect(input!.paymentAmount).toBe(1200);
    expect(input!.paymentAmount).toBeGreaterThan(PERIOD_INTEREST);
    expect(generateLoanSchedule(input!).rows.length).toBeGreaterThan(0);
  });

  it('does not seed a principal-only figure just because it exceeds the interest', () => {
    // Issue #1255's own numbers: 20,000 at 5.5% costs 91.67 a month, and the
    // last row is a 285 principal-only transfer. 285 clears 91.67, so listing
    // the observation first seeded 285 -- a fraction of the real 1,200
    // installment -- and the documented contractual fallback only ever fired
    // when the principal-only number happened to be the smaller one.
    const acct = makeAccount({
      openingBalance: -20000,
      currentBalance: -20000,
      interestRate: 5.5,
      paymentAmount: 1200,
      paymentFrequency: 'MONTHLY',
    });
    const history = deriveLoanPaymentHistory(acct, [
      makeTransaction({ transactionDate: '2024-01-05', amount: 285 }),
    ]);
    const input = buildLoanProjectionInput(acct, history);
    expect(input!.paymentAmount).toBe(1200);
    expect(resolveCurrentLoanTerms(acct, history).payment).toBe(1200);
  });

  it('reports no installment when nothing complete is known', () => {
    // Principal-only history and no contractual payment: the installment is
    // unknown, so there is no projection and no Current Payment -- rather than a
    // payoff computed from a fraction of the real payment.
    const acct = makeAccount({
      openingBalance: -20000,
      currentBalance: -20000,
      interestRate: 5.5,
      paymentAmount: null as unknown as number,
      paymentFrequency: 'MONTHLY',
    });
    const history = deriveLoanPaymentHistory(acct, [
      makeTransaction({ transactionDate: '2024-01-05', amount: 285 }),
    ]);
    expect(resolveCurrentLoanTerms(acct, history).payment).toBeNull();
    expect(buildLoanProjectionInput(acct, history)).toBeNull();
  });

  it('prefers the derived installment over the contractual one when it amortizes', () => {
    // Interest recorded on the payment: the derived figure is the borrower's
    // real installment and wins even though the contractual one also amortizes.
    const acct = account();
    const history = deriveLoanPaymentHistory(acct, [
      withInterestSplit(
        makeTransaction({ transactionDate: '2022-05-05', amount: 285 }),
        'parent-1',
        915.36,
      ),
    ]);
    const input = buildLoanProjectionInput(acct, history);
    expect(input!.paymentAmount).toBeCloseTo(1200.36, 2);
  });

  it('prefers a recorded payment change over both', () => {
    const acct = account();
    const input = buildLoanProjectionInput(acct, principalOnlyHistory(acct), [
      { effectiveDate: '2022-04-05', annualRate: 5.5, newPaymentAmount: 1310 },
    ]);
    expect(input!.paymentAmount).toBe(1310);
  });

  it('keeps a timeline payment that no longer covers the interest, rather than substituting the account scalar', () => {
    // 100000 at 12% costs 1000 a month. The timeline says 900 is being paid --
    // a rate rise the installment has not caught up with -- while the
    // user-owned account scalar still holds a stale 1500. The backend keeps
    // those two independent (`resolveCurrentTimeline` never writes the scalar),
    // and it never infers a principal-only payment onto a timeline row
    // (`persistSegments` writes newPaymentAmount: null when interest is booked
    // separately), so 900 is a full installment and the authoritative one.
    // Seeding 1500 would report a payoff computed from a payment nobody makes.
    const acct = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -100000,
      currentBalance: -100000,
      interestRate: 12,
      paymentAmount: 1500,
      paymentFrequency: 'MONTHLY',
    });
    const history = deriveLoanPaymentHistory(acct, [
      makeTransaction({ transactionDate: '2024-01-05', amount: 600 }),
    ]);
    const input = buildLoanProjectionInput(acct, history, [
      { effectiveDate: '2024-01-05', annualRate: 12, newPaymentAmount: 900 },
    ]);

    expect(input!.paymentAmount).toBe(900);
    // 900 against 1000 of interest: the loan does not amortize, so there is no
    // payoff to show -- not a payoff derived from the stale 1500.
    const schedule = generateLoanSchedule(input!);
    expect(schedule.rows).toHaveLength(0);
    expect(schedule.paidOff).toBe(false);
  });

  it('projects nothing when no candidate covers a period of interest', () => {
    // A genuinely underfunded loan and a loan whose installment is simply
    // unknown look the same from here, and both must refuse: an unknown payoff
    // is not a payoff computed from the largest number to hand.
    const acct = account({ paymentAmount: 300 });
    const input = buildLoanProjectionInput(acct, principalOnlyHistory(acct));
    expect(input).not.toBeNull();
    expect(input!.paymentAmount).toBeLessThan(PERIOD_INTEREST);
    const schedule = generateLoanSchedule(input!);
    expect(schedule.rows).toHaveLength(0);
    expect(schedule.paidOff).toBe(false);
  });
});

describe('buildLoanProjectionInput scheduled-installment anchor (issue #1253)', () => {
  // These cases are about an anchor's position relative to TODAY -- an overdue
  // one is refused -- so the clock is pinned rather than read. Without this the
  // suite passes until the fixture dates drift into the past and then fails
  // with nothing changed.
  //
  // Pinning the instant is not enough: an instant is a different calendar day
  // in different zones, so a case that turned on 2026-07-01 read as 2026-07-02
  // at UTC+14 and the block failed on a developer machine east of the
  // dateline. The day each case is judged against is therefore STATED, which is
  // also what every production surface does -- `useFinancialToday()` resolves
  // it from the user's preference and passes it in.
  const TODAY = '2026-07-01';
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const account = (overrides: Partial<Account> = {}) =>
    makeAccount({
      accountType: 'LOAN',
      openingBalance: -210000,
      currentBalance: -200000,
      interestRate: 6,
      paymentAmount: 1500,
      paymentFrequency: 'MONTHLY',
      ...overrides,
    });
  const history = (acct: Account) =>
    deriveLoanPaymentHistory(acct, [
      withInterestSplit(
        makeTransaction({ transactionDate: '2026-07-15', amount: 500 }),
        'parent-1',
        1000,
      ),
    ]);

  it('anchors the projection on the ledger debt through the next due date', () => {
    // `account.currentBalance` runs through today, so a 1,500 principal-only
    // payment posted for a date before the next installment leaves it at
    // 200,000 while the bill's own recalculation prices 198,500. The server
    // anchor carries the bill's balance boundary, so the first projected row
    // and the next scheduled bill calculate the same 992.50 of interest.
    const acct = account();
    const input = buildLoanProjectionInput(
      acct,
      history(acct),
      [],
      { nextDueDate: '2026-08-15', debt: 198500 },
      TODAY,
    );
    expect(input).not.toBeNull();
    expect(input!.startingBalance).toBe(198500);
    // The first projected row is the next scheduled installment, on its date.
    expect(input!.firstPaymentDate.getFullYear()).toBe(2026);
    expect(input!.firstPaymentDate.getMonth()).toBe(7);
    expect(input!.firstPaymentDate.getDate()).toBe(15);
    const schedule = generateLoanSchedule(input!);
    expect(schedule.rows[0].interest).toBeCloseTo(992.5, 2);
  });

  it('keeps the today-anchored fallback when the anchor has no scheduled payment', () => {
    // {null, null} is the API's answer for a loan with no active scheduled
    // payment: there is no bill to be in parity with, so the projection keeps
    // projecting from today's balance one period ahead.
    const acct = account();
    const anchored = buildLoanProjectionInput(
      acct,
      history(acct),
      [],
      { nextDueDate: null, debt: null },
      TODAY,
    );
    const unanchored = buildLoanProjectionInput(
      acct,
      history(acct),
      [],
      null,
      TODAY,
    );
    expect(anchored).not.toBeNull();
    expect(anchored!.startingBalance).toBe(unanchored!.startingBalance);
    // Compare the DAY, not the timestamp, and with `isoDay` -- which is what
    // `generateLoanSchedule` dates its rows with, so it is the day these two
    // have to agree on. (Both are now derived from `TODAY` rather than read
    // from the clock, so the millisecond skew this comparison originally
    // guarded against is gone; the day is still the right unit.)
    expect(isoDay(anchored!.firstPaymentDate)).toBe(
      isoDay(unanchored!.firstPaymentDate),
    );
  });

  it('refuses an overdue anchor rather than projecting through later real activity', () => {
    // Today is 2026-07-01 (pinned). The schedule is overdue: its next due date
    // is 2026-06-01 and the debt through THAT date is 100,000. Since then the
    // borrower made a real 20,000 principal payment, so they stand at 80,000.
    //
    // Seeding the projection at 100,000 would price every future installment
    // against a balance that never saw the repayment -- and the generated rows
    // would be dated before the real 2026-06-15 row they are appended after.
    const acct = account({ currentBalance: -80000, openingBalance: -100000 });
    const hist = deriveLoanPaymentHistory(acct, [
      makeTransaction({ transactionDate: '2026-06-15', amount: 20000 }),
    ]);

    const overdue = buildLoanProjectionInput(
      acct,
      hist,
      [],
      { nextDueDate: '2026-06-01', debt: 100000 },
      TODAY,
    );
    const unanchored = buildLoanProjectionInput(acct, hist, [], null, TODAY);

    expect(overdue).not.toBeNull();
    // It projects from where the borrower actually stands, not from the
    // pre-repayment balance the overdue boundary measured.
    expect(overdue!.startingBalance).toBe(80000);
    expect(overdue!.startingBalance).toBe(unanchored!.startingBalance);
    expect(overdue!.firstPaymentDate.getTime()).toBe(
      unanchored!.firstPaymentDate.getTime(),
    );
  });

  it('still anchors a due-today installment', () => {
    // The boundary is refused only when it is BEHIND today; an installment due
    // today is the next bill and anchors normally.
    const acct = account();
    const input = buildLoanProjectionInput(
      acct,
      history(acct),
      [],
      { nextDueDate: '2026-07-01', debt: 198500 },
      TODAY,
    );

    expect(input!.startingBalance).toBe(198500);
  });

  it('refuses an anchor already overdue in the user calendar while UTC lags', () => {
    // 00:30 on 30 August in Warsaw (UTC+2). UTC still reads 2026-08-29, so a
    // guard written against `new Date().toISOString()` sees the 2026-08-29
    // installment as due TODAY and anchors on it -- for the two hours after
    // local midnight, and for fourteen at UTC+14.
    //
    // The bill does not: the backend prices it against `todayYMD()`, which
    // resolves the request timezone, so it is overdue there. The projection
    // must agree, or it seeds from a boundary that predates the 20,000 the
    // borrower paid this morning and prices every future installment against a
    // debt the ledger no longer holds.
    vi.setSystemTime(new Date('2026-08-29T22:30:00Z'));
    const todayYmd = financialTodayYmd('Europe/Warsaw');
    expect(todayYmd).toBe('2026-08-30');

    const acct = account({ currentBalance: -80000, openingBalance: -100000 });
    const hist = deriveLoanPaymentHistory(acct, [
      makeTransaction({ transactionDate: '2026-08-30', amount: 20000 }),
    ]);

    const overdue = buildLoanProjectionInput(
      acct,
      hist,
      [],
      { nextDueDate: '2026-08-29', debt: 100000 },
      todayYmd,
    );

    expect(overdue).not.toBeNull();
    expect(overdue!.startingBalance).toBe(80000);
    // 80,000 x 0.005, not the 100,000 x 0.005 the stale anchor would price.
    expect(
      generateLoanSchedule(overdue!).rows[0].interest,
    ).toBeCloseTo(400, 2);
  });

  it('still anchors a due-today installment while UTC has already moved on', () => {
    // The mirror image: 22:30 on 29 August in New York (UTC-4), where UTC
    // already reads 2026-08-30. A UTC comparison refuses an installment that is
    // due TODAY for this borrower, dropping the report back to the today-
    // anchored balance and losing the parity with the bill that the anchor
    // exists for -- every evening, for four hours.
    vi.setSystemTime(new Date('2026-08-30T02:30:00Z'));
    const todayYmd = financialTodayYmd('America/New_York');
    expect(todayYmd).toBe('2026-08-29');

    const acct = account();
    const input = buildLoanProjectionInput(
      acct,
      history(acct),
      [],
      { nextDueDate: '2026-08-29', debt: 198500 },
      todayYmd,
    );

    expect(input).not.toBeNull();
    expect(input!.startingBalance).toBe(198500);
    expect(isoDay(input!.firstPaymentDate)).toBe('2026-08-29');
  });

  it('judges the anchor against the passed day, not the browser day', () => {
    // A user whose Monize timezone differs from their browser's gets the
    // configured one -- `useFinancialToday` resolves the preference and the
    // browser is only its fallback, exactly as the backend resolves it. Pinning
    // the clock proves the argument is what decides: the same instant and the
    // same anchor come out both ways.
    vi.setSystemTime(new Date('2026-08-29T12:00:00Z'));
    const acct = account();
    const anchor = { nextDueDate: '2026-08-29', debt: 198500 };

    expect(
      buildLoanProjectionInput(acct, history(acct), [], anchor, '2026-08-29')!
        .startingBalance,
    ).toBe(198500);
    expect(
      buildLoanProjectionInput(acct, history(acct), [], anchor, '2026-08-30')!
        .startingBalance,
    ).toBe(200000);
  });

  it('refuses the projection when the debt through the due date is already retired', () => {
    // A future-dated final payment has posted: today's balance still shows
    // debt, but the installment boundary owes nothing -- projecting rows from
    // the stale 200,000 would invent installments the bill will never charge.
    const acct = account();
    const input = buildLoanProjectionInput(
      acct,
      history(acct),
      [],
      { nextDueDate: '2026-08-15', debt: 0 },
      TODAY,
    );
    expect(input).toBeNull();
  });
});

describe('buildLoanProjectionInput mortgage type', () => {
  // The projection is priced by the account's type, read through
  // `mortgageTypeOf`.
  const project = (overrides: Partial<Account>) => {
    const acct = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -100000,
      currentBalance: -100000,
      interestRate: 5,
      paymentAmount: 1500,
      ...overrides,
    });
    const history = deriveLoanPaymentHistory(acct, [
      makeTransaction({ transactionDate: '2024-01-05', amount: 600 }),
    ]);
    return buildLoanProjectionInput(acct, history, [])!;
  };

  it('carries the stored type', () => {
    expect(project({ mortgageType: 'CANADIAN_FIXED' }).mortgageType).toBe('CANADIAN_FIXED');
    expect(project({ mortgageType: 'ANNUITY' }).mortgageType).toBe('ANNUITY');
    expect(project({ accountType: 'LOAN', mortgageType: 'ANNUITY' }).mortgageType).toBe(
      'ANNUITY',
    );
  });
});

describe('buildLoanProjectionInput rate authority', () => {
  // Recording a rate change never writes account.interestRate -- the backend
  // keeps it user-owned and says so -- so a loan whose rate rose through the
  // rate-history UI has a stale scalar and a current timeline. The projection
  // must take both its rate and its payment from the timeline.
  const divergent = (overrides: Partial<Account> = {}) =>
    makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -100000,
      currentBalance: -100000,
      interestRate: 5, // stale scalar
      paymentAmount: 1500, // stale scalar
      paymentFrequency: 'MONTHLY',
      ...overrides,
    });

  it('projects at the timeline rate, not the stale account scalar', () => {
    const acct = divergent();
    const history = deriveLoanPaymentHistory(acct, [
      makeTransaction({ transactionDate: '2024-01-05', amount: 600 }),
    ]);
    const input = buildLoanProjectionInput(acct, history, [
      { effectiveDate: '2024-01-05', annualRate: 12, newPaymentAmount: 900 },
    ]);

    expect(input!.annualRate).toBe(12);
    expect(input!.paymentAmount).toBe(900);
    // At the real 12%, 100000 costs 1000 a month and 900 does not amortize, so
    // there is no payoff. At the stale 5% it costs 416.67 and the same 900 looks
    // comfortably amortizing -- a ~150-month payoff and ~34.5k of projected
    // interest for a loan that is going backwards.
    const schedule = generateLoanSchedule(input!);
    expect(schedule.rows).toHaveLength(0);
    expect(schedule.paidOff).toBe(false);
  });

  it('takes the timeline rate even when the timeline records no payment', () => {
    // A rate change entered without a new payment: the rate is still the
    // timeline's, and the payment falls back down the documented order.
    const acct = divergent();
    const history = deriveLoanPaymentHistory(acct, [
      makeTransaction({ transactionDate: '2024-01-05', amount: 600 }),
    ]);
    const input = buildLoanProjectionInput(acct, history, [
      { effectiveDate: '2024-01-05', annualRate: 12 },
    ]);

    expect(input!.annualRate).toBe(12);
    expect(input!.paymentAmount).toBe(1500); // contractual, the only amortizing candidate
  });

  it('does not treat an initial row\'s payment as authoritative', () => {
    // insertInitialRowIfFirst writes newPaymentAmount as a verbatim copy of
    // account.paymentAmount, so an 'initial' row is rank 3 wearing rank 1's
    // clothes. Seeding it unconditionally pinned the projection to a snapshot of
    // the very field the user would edit to fix it: a principal-only 300 copied
    // into the row, and correcting the account to 1500 changed nothing.
    const acct = divergent({ paymentAmount: 1500 });
    const history = deriveLoanPaymentHistory(acct, [
      makeTransaction({ transactionDate: '2024-01-05', amount: 300 }),
    ]);
    const input = buildLoanProjectionInput(acct, history, [
      {
        effectiveDate: '2024-01-04',
        annualRate: 5,
        newPaymentAmount: 300,
        source: 'initial',
      },
    ]);
    // 100000 at 5% costs 416.67, which the 300 snapshot cannot cover, so the
    // corrected contractual 1500 is used instead of pinning to the stale copy.
    expect(input!.paymentAmount).toBe(1500);
  });

  it('uses an initial row\'s payment when it is a real observed installment', () => {
    // The other writer of `initial`: detection records the modal observed
    // payment. Discarding it because of the source threw away a real
    // observation, so it is ranked and tested -- and here it amortizes, so it
    // wins over the contractual figure.
    const acct = divergent({ paymentAmount: 1500 });
    const history = deriveLoanPaymentHistory(acct, [
      makeTransaction({ transactionDate: '2024-01-05', amount: 300 }),
    ]);
    const input = buildLoanProjectionInput(acct, history, [
      {
        effectiveDate: '2024-01-04',
        annualRate: 5,
        newPaymentAmount: 1150,
        source: 'initial',
      },
    ]);
    expect(input!.paymentAmount).toBe(1150);
  });

  it('keeps a manual row\'s payment authoritative even when it cannot amortize', () => {
    const acct = divergent({ paymentAmount: 1500 });
    const history = deriveLoanPaymentHistory(acct, [
      makeTransaction({ transactionDate: '2024-01-05', amount: 450 }),
    ]);
    const input = buildLoanProjectionInput(acct, history, [
      {
        effectiveDate: '2024-01-05',
        annualRate: 12,
        newPaymentAmount: 900,
        source: 'manual',
      },
    ]);
    expect(input!.paymentAmount).toBe(900);
    expect(generateLoanSchedule(input!).rows).toHaveLength(0);
  });

  it('tests the guard against the rate row 1 will actually run at', () => {
    // firstPaymentDate is one period ahead and generateLoanSchedule applies every
    // step dated on or before a row's date to that row, so a step recorded for
    // next week lands on row 1. Guarding at today's rate would pass a candidate
    // the very next line then refuses, and the projection would silently vanish
    // instead of using a payment that does amortize.
    const acct = divergent({ paymentAmount: 1500, interestRate: 5 });
    const history = deriveLoanPaymentHistory(acct, [
      makeTransaction({ transactionDate: '2024-01-05', amount: 600 }),
    ]);
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    const input = buildLoanProjectionInput(acct, history, [
      { effectiveDate: nextWeek.toISOString().slice(0, 10), annualRate: 12 },
    ]);

    // Row 1 runs at 12% (1000 of interest), so the 600 derived from history is
    // rejected and the 1500 contractual is seeded -- and the schedule amortizes.
    expect(input!.paymentAmount).toBe(1500);
    expect(generateLoanSchedule(input!).rows.length).toBeGreaterThan(0);
  });

  it('keeps a complete observed installment even when it no longer amortizes', () => {
    // 250000 at 5% costs 1041.67. The last payment recorded 600 principal and
    // 400 interest, so 1000 is a COMPLETE statement of what is being paid -- a
    // real state (a rate rise the installment has not caught up with). Falling
    // back to the contractual 1800 would report a payoff from a payment nobody
    // makes; the fallback is only for an INCOMPLETE `principal + 0`.
    const acct = divergent({ currentBalance: -250000, paymentAmount: 1800 });
    const history = deriveLoanPaymentHistory(acct, [
      withInterestSplit(
        makeTransaction({ transactionDate: '2024-01-05', amount: 600 }),
        'parent-1',
        400,
      ),
    ]);
    expect(resolveCurrentLoanTerms(acct, history).payment).toBe(1000);
    const input = buildLoanProjectionInput(acct, history);
    expect(input!.paymentAmount).toBe(1000);
    expect(generateLoanSchedule(input!).rows).toHaveLength(0);
  });

  it('shows the same installment the projection is seeded with', () => {
    // The card and the schedule used to resolve separately: "Current Payment
    // $450" beside a payoff computed from the contractual $950.
    const acct = divergent({ currentBalance: -100000, paymentAmount: 1500 });
    const history = deriveLoanPaymentHistory(acct, [
      makeTransaction({ transactionDate: '2024-01-05', amount: 450 }),
    ]);
    expect(resolveCurrentLoanTerms(acct, history).payment).toBe(
      buildLoanProjectionInput(acct, history)!.paymentAmount,
    );
  });

  it('projects a loan configured only through its rate history', () => {
    // canProject used to gate on account.interestRate / paymentAmount -- the
    // very scalars this function demotes -- so a loan whose terms live only in
    // loan_rate_changes was refused while the cards, reading the same
    // resolution, displayed its real rate and payment beside "Est. Payoff N/A".
    const acct = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -100000,
      currentBalance: -100000,
      interestRate: null as unknown as number,
      paymentAmount: null as unknown as number,
      paymentFrequency: 'MONTHLY',
    });
    const history = deriveLoanPaymentHistory(acct, [
      makeTransaction({ transactionDate: '2024-01-05', amount: 600 }),
    ]);
    const rows = [
      {
        effectiveDate: '2024-01-01',
        annualRate: 6,
        newPaymentAmount: 1200,
        source: 'manual' as const,
      },
    ];

    const terms = resolveCurrentLoanTerms(acct, history, rows);
    const input = buildLoanProjectionInput(acct, history, rows);
    expect(terms.annualRate).toBe(6);
    expect(terms.payment).toBe(1200);
    // The cards and the projection now agree, and the payoff exists.
    expect(input).not.toBeNull();
    expect(input!.annualRate).toBe(6);
    expect(input!.paymentAmount).toBe(1200);
    expect(generateLoanSchedule(input!).paidOff).toBe(true);
  });

  it('still refuses a loan with no terms anywhere', () => {
    const acct = makeAccount({
      currentBalance: -10000,
      interestRate: null as unknown as number,
      paymentAmount: null as unknown as number,
    });
    const history = deriveLoanPaymentHistory(acct, []);
    expect(buildLoanProjectionInput(acct, history)).toBeNull();
  });

  it('projects an interest-free loan from its observed installment alone', () => {
    // 0% with no stored paymentAmount: the ledger states BOTH terms exactly --
    // the rate is recorded as 0 and the installment is `principal + 0`, which at
    // 0% is the whole payment rather than a fraction of it. Treating that as an
    // incomplete observation refused the payoff of the one loan whose figures
    // are fully known, which is the "null is not the safe answer either" half of
    // the missing-data rule.
    const acct = makeAccount({
      interestRate: 0,
      paymentAmount: null as unknown as number,
      openingBalance: -1200,
      currentBalance: -900,
    });
    const history = deriveLoanPaymentHistory(acct, [
      makeTransaction({ transactionDate: '2026-01-15', amount: 150 }),
      makeTransaction({ transactionDate: '2026-02-15', amount: 150 }),
    ]);
    expect(history.events[1].interest).toBe(0);

    const terms = resolveCurrentLoanTerms(acct, history);
    expect(terms.annualRate).toBe(0);
    expect(terms.payment).toBe(150);

    const input = buildLoanProjectionInput(acct, history);
    expect(input).not.toBeNull();
    expect(input!.annualRate).toBe(0);
    expect(input!.paymentAmount).toBe(150);
    // 900 remaining at 150 a month with no interest: six payments, paid off.
    const schedule = generateLoanSchedule(input!);
    expect(schedule.paidOff).toBe(true);
    expect(schedule.rows).toHaveLength(6);
    expect(schedule.totalInterest).toBe(0);
  });

  it('still refuses a 6% loan whose only observation is principal-only', () => {
    // Negative control for the case above: the 0% exemption must not leak into a
    // loan that charges interest, where `principal + 0` really is a fraction of
    // the installment.
    const acct = makeAccount({
      interestRate: 6,
      paymentAmount: null as unknown as number,
      openingBalance: -1200,
      currentBalance: -900,
    });
    const history = deriveLoanPaymentHistory(acct, [
      makeTransaction({ transactionDate: '2026-01-15', amount: 150 }),
      makeTransaction({ transactionDate: '2026-02-15', amount: 150 }),
    ]);
    expect(buildLoanProjectionInput(acct, history)).toBeNull();
    expect(resolveCurrentLoanTerms(acct, history).payment).toBeNull();
  });

  it('reports an absent rate as unknown, not as 0%', () => {
    // Number(null) is 0, and 0 is a rate: the summary card, the detail view and
    // the PDF all print `${rate}%`, so a loan with no rate anywhere rendered a
    // measured "0%" where it had always said "Not set".
    const acct = makeAccount({ interestRate: null as unknown as number });
    const history = deriveLoanPaymentHistory(acct, [
      makeTransaction({ transactionDate: '2024-01-05', amount: 300 }),
    ]);
    expect(resolveCurrentLoanTerms(acct, history).annualRate).toBeNull();
    // A recorded rate still answers for such a loan.
    expect(
      resolveCurrentLoanTerms(acct, history, [
        { effectiveDate: '2024-01-01', annualRate: 7 },
      ]).annualRate,
    ).toBe(7);
  });

  it('falls back to the account scalar when no timeline row applies', () => {
    // Negative control: with no timeline, startingAnnualRate IS the scalar, so
    // this change is inert for every loan without a rate history.
    const acct = divergent();
    const history = deriveLoanPaymentHistory(acct, [
      makeTransaction({ transactionDate: '2024-01-05', amount: 600 }),
    ]);
    expect(buildLoanProjectionInput(acct, history)!.annualRate).toBe(5);
    // A future-dated row does not describe today either -- neither its rate nor
    // its payment. It is a step, and applying it as the current state as well
    // would apply the same change twice.
    const future = buildLoanProjectionInput(acct, history, [
      { effectiveDate: '2099-01-01', annualRate: 12, newPaymentAmount: 2000 },
    ]);
    expect(future!.annualRate).toBe(5);
    // The point is that the 2000 named by the future row is not adopted as
    // today's. The 600 from history is principal-only (incomplete), so it is not
    // a candidate either and the contractual 1500 is used.
    expect(future!.paymentAmount).not.toBe(2000);
    expect(future!.paymentAmount).toBe(1500);
    expect(future!.rateChanges).toHaveLength(1); // still bends the projection ahead
  });
});

describe('readRecordedInterest provenance', () => {
  const LOAN_LINE = { transferAccountId: LOAN_ID, amount: -1000 } as TransactionSplit;
  const ESCROW_LINE = {
    transferAccountId: null,
    categoryId: 'cat-escrow',
    amount: -500,
  } as unknown as TransactionSplit;
  const INTEREST_LINE = {
    transferAccountId: null,
    categoryId: 'cat-interest',
    amount: -300,
  } as unknown as TransactionSplit;

  /** A mortgage payment split into principal, escrow and interest. */
  const splitPayment = (splits: TransactionSplit[]): Transaction =>
    ({
      ...makeTransaction({ transactionDate: '2026-01-15', amount: 1000 }),
      linkedTransaction: { id: 'parent-1', splits } as Transaction,
    }) as Transaction;

  const withInterestCategory = makeAccount({ interestCategoryId: 'cat-interest' });

  it('reads the configured interest category, whatever order the lines are in', () => {
    // The defect: `the first split that is not the principal transfer` made the
    // ESCROW line interest whenever it happened to come first, reporting $500 of
    // property tax as $500 of interest paid on a payment whose interest was $300.
    const escrowFirst = deriveLoanPaymentHistory(withInterestCategory, [
      splitPayment([LOAN_LINE, ESCROW_LINE, INTEREST_LINE]),
    ]);
    const interestFirst = deriveLoanPaymentHistory(withInterestCategory, [
      splitPayment([LOAN_LINE, INTEREST_LINE, ESCROW_LINE]),
    ]);

    expect(escrowFirst.events[0].interest).toBe(300);
    expect(interestFirst.events[0].interest).toBe(300);
    // Order changes nothing -- that is the whole property.
    expect(escrowFirst.events[0].interest).toBe(interestFirst.events[0].interest);
  });

  it('sums interest split across two lines of the configured category', () => {
    const history = deriveLoanPaymentHistory(withInterestCategory, [
      splitPayment([
        LOAN_LINE,
        INTEREST_LINE,
        { transferAccountId: null, categoryId: 'cat-interest', amount: -20 } as unknown as TransactionSplit,
      ]),
    ]);
    expect(history.events[0].interest).toBe(320);
  });

  it('does not zero a single recorded line just because the configured category differs', () => {
    // Setting or changing a loan's interest category must not rewrite its
    // history. Splits recorded before that setting existed, or filed under a
    // since-changed category, still hold the real interest -- returning "no
    // interest" for them wiped Interest Paid, every cumulative total and the
    // exports the moment the field was filled in.
    const withOtherCategory = makeAccount({ interestCategoryId: 'cat-different' });
    const history = deriveLoanPaymentHistory(withOtherCategory, [
      splitPayment([LOAN_LINE, INTEREST_LINE]),
    ]);
    expect(history.events[0].interest).toBe(300);
    expect(history.cumulativeInterest).toBe(300);
  });

  it('lets a paired separate expense outrank the split\'s unmatched line', () => {
    // The split's single line might be escrow; a separate expense booked against
    // the date is the stronger signal for a loan that books interest outside the
    // split, so it wins over the fallback.
    const withOtherCategory = makeAccount({ interestCategoryId: 'cat-different' });
    const history = deriveLoanPaymentHistory(
      withOtherCategory,
      [splitPayment([LOAN_LINE, ESCROW_LINE])],
      [],
      [
        {
          transactionDate: '2026-01-15',
          amount: -275,
          isTransfer: false,
        } as Transaction,
      ],
    );
    expect(history.events[0].interest).toBe(275);
  });

  it('prefers the configured category over a paired expense', () => {
    // The other direction: an exact provenance match is not overridden.
    const history = deriveLoanPaymentHistory(
      withInterestCategory,
      [splitPayment([LOAN_LINE, INTEREST_LINE])],
      [],
      [
        {
          transactionDate: '2026-01-15',
          amount: -999,
          isTransfer: false,
        } as Transaction,
      ],
    );
    expect(history.events[0].interest).toBe(300);
  });

  it('refuses to guess between two category lines with no configured category', () => {
    // No interestCategoryId, escrow and interest indistinguishable: reporting
    // either would be picking a number because it was listed first.
    const history = deriveLoanPaymentHistory(makeAccount(), [
      splitPayment([LOAN_LINE, ESCROW_LINE, INTEREST_LINE]),
    ]);
    expect(history.events[0].interest).toBe(0);
  });

  it('still reads a single category line with no configured category', () => {
    // The canonical shape ScheduledTransactionLoanService builds, and what every
    // loan without a configured interest category has always relied on.
    const history = deriveLoanPaymentHistory(makeAccount(), [
      splitPayment([LOAN_LINE, INTEREST_LINE]),
    ]);
    expect(history.events[0].interest).toBe(300);
  });

  it('lets a paired separate expense answer when the split carries no interest line', () => {
    // Configured category, but this parent is principal + escrow only and the
    // interest is booked as its own expense. Reporting 0 here would drop it.
    const history = deriveLoanPaymentHistory(
      withInterestCategory,
      [splitPayment([LOAN_LINE, ESCROW_LINE])],
      [],
      [
        {
          transactionDate: '2026-01-15',
          amount: -300,
          isTransfer: false,
        } as Transaction,
      ],
    );
    expect(history.events[0].interest).toBe(300);
  });

  it('ignores an uncategorized line when a categorized interest line is present', () => {
    // "A categorized line" has to mean the same thing here as in the backend's
    // ScheduledTransactionLoanService, which recalculates these templates:
    // categoryId && !transferAccountId. The two differed by that one clause, so
    // [principal, categorized interest, uncategorized fee] was one candidate to
    // the writer and two to this reader -- ambiguous, and reported as no
    // interest at all while the recorded 300 sat in the split.
    const history = deriveLoanPaymentHistory(makeAccount(), [
      splitPayment([
        LOAN_LINE,
        INTEREST_LINE,
        { transferAccountId: null, amount: -25, memo: 'Fee' } as unknown as TransactionSplit,
      ]),
    ]);
    expect(history.events[0].interest).toBe(300);
  });

  it('rounds a multi-line interest sum to cents like every sibling path', () => {
    // takeSeparateInterest and the orphan rows both round; an unrounded sum let
    // float drift into event.interest and the cumulative accumulator.
    const history = deriveLoanPaymentHistory(withInterestCategory, [
      splitPayment([
        LOAN_LINE,
        { transferAccountId: null, categoryId: 'cat-interest', amount: -0.1 } as unknown as TransactionSplit,
        { transferAccountId: null, categoryId: 'cat-interest', amount: -0.2 } as unknown as TransactionSplit,
      ]),
    ]);
    expect(history.events[0].interest).toBe(0.3);
  });

  it('lets a paired separate expense answer for a transfer-only split parent', () => {
    // Regular principal + extra principal, both transfers to the loan, with the
    // interest booked as its own expense that day. Answering a hard 0 here made
    // the caller treat the parent as final and drop the real expense.
    const history = deriveLoanPaymentHistory(
      makeAccount(),
      [
        splitPayment([
          LOAN_LINE,
          { transferAccountId: LOAN_ID, amount: -200 } as TransactionSplit,
        ]),
      ],
      [],
      [
        {
          transactionDate: '2026-01-15',
          amount: -300,
          isTransfer: false,
        } as Transaction,
      ],
    );
    expect(history.events[0].interest).toBe(300);
  });

  it('records no interest for a transfer-only split parent with nothing paired', () => {
    const history = deriveLoanPaymentHistory(withInterestCategory, [
      splitPayment([
        LOAN_LINE,
        { transferAccountId: LOAN_ID, amount: -200 } as TransactionSplit,
      ]),
    ]);
    expect(history.events[0].interest).toBe(0);
  });

  it('never treats a transfer to a third account as interest', () => {
    // The old predicate was `transferAccountId !== loanAccountId`, so a leg
    // moving money to some other account of the user's read as interest.
    const history = deriveLoanPaymentHistory(makeAccount(), [
      splitPayment([
        LOAN_LINE,
        { transferAccountId: 'savings-1', amount: -250 } as TransactionSplit,
      ]),
    ]);
    expect(history.events[0].interest).toBe(0);
  });
});

describe('fetchAllAccountTransactions', () => {
  it('paginates until hasMore is false', async () => {
    const pageOne = Array.from({ length: 200 }, (_, i) => ({ id: `tx-${i}` }));
    const pageTwo = [{ id: 'tx-200' }];
    vi.mocked(transactionsApi.getAll)
      .mockResolvedValueOnce({
        data: pageOne,
        pagination: { hasMore: true },
      } as Awaited<ReturnType<typeof transactionsApi.getAll>>)
      .mockResolvedValueOnce({
        data: pageTwo,
        pagination: { hasMore: false },
      } as Awaited<ReturnType<typeof transactionsApi.getAll>>);

    const result = await fetchAllAccountTransactions(LOAN_ID);

    expect(result).toHaveLength(201);
    expect(transactionsApi.getAll).toHaveBeenCalledTimes(2);
    expect(transactionsApi.getAll).toHaveBeenNthCalledWith(1, {
      accountId: LOAN_ID,
      limit: 200,
      page: 1,
    });
    expect(transactionsApi.getAll).toHaveBeenNthCalledWith(2, {
      accountId: LOAN_ID,
      limit: 200,
      page: 2,
    });
  });
});

describe('fetchLoanInterestTransactions', () => {
  const account = makeAccount({
    interestCategoryId: 'cat-interest',
    sourceAccountId: 'src-1',
  });

  it('keeps only standalone interest expenses, dropping split-leg matches', async () => {
    // The category filter also matches interest booked as a split leg of a
    // payment (the backend matches splits.categoryId). A split parent carries a
    // null top-level category; those must be dropped so sequential loans sharing
    // one interest category and funding account do not pull each other's
    // split-leg interest onto this loan.
    vi.mocked(transactionsApi.getAllPages).mockResolvedValue([
      // Genuine standalone interest expense -- kept.
      { id: 'i-1', categoryId: 'cat-interest', isTransfer: false } as Transaction,
      // Split parent (another loan's payment) matched via a split leg -- dropped.
      { id: 'p-1', categoryId: null, isTransfer: false } as unknown as Transaction,
      // A transfer that happens to share the category -- dropped.
      { id: 't-1', categoryId: 'cat-interest', isTransfer: true } as Transaction,
    ]);

    const result = await fetchLoanInterestTransactions(account);

    expect(result.map((t) => t.id)).toEqual(['i-1']);
    expect(transactionsApi.getAllPages).toHaveBeenCalledWith({
      categoryIds: ['cat-interest'],
      accountIds: ['src-1'],
    });
  });

  it('returns [] when the loan has no interest category or source account', async () => {
    expect(await fetchLoanInterestTransactions(makeAccount())).toEqual([]);
    expect(transactionsApi.getAllPages).not.toHaveBeenCalled();
  });

  it('returns [] when the query runs and this loan has no interest expenses', async () => {
    // The positive control for the rejection below: a genuinely empty result
    // must stay an empty result, or the fix would just trade one wrong answer
    // for another.
    vi.mocked(transactionsApi.getAllPages).mockResolvedValue([]);
    expect(await fetchLoanInterestTransactions(account)).toEqual([]);
  });

  it('rejects on a failed lookup rather than reporting an empty ledger', async () => {
    // `catch { return [] }` made a transient 500 or timeout indistinguishable
    // from the case above. `[]` is a claim: `deriveLoanPaymentHistory` reads it
    // as "these payments booked no interest", so a swallowed timeout renders a
    // schedule of $0.00 interest that a user cannot tell from a real one.
    //
    // Every caller already has the error state it should have reached --
    // `useLoanProjection` reports the projection unknown, the account page has
    // its own retryable error, both loan reports run on `useReportData` -- and
    // the helper was starving all of them.
    vi.mocked(transactionsApi.getAllPages).mockRejectedValue(new Error('timeout'));

    await expect(fetchLoanInterestTransactions(account)).rejects.toThrow('timeout');
  });
});

describe('deriveLoanPaymentHistory with a rate timeline but no recorded interest', () => {
  it('reports no interest on either row of a repriced variable-rate loan (issue #1255)', () => {
    // The rate timeline used to feed an estimate per row (~325 then ~916 here),
    // so a variable-rate loan whose payments are plain principal-only transfers
    // accumulated interest nobody was charged. The timeline still drives the
    // Rate column; it no longer invents an amount.
    const account = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -200000,
      currentBalance: -199430,
      interestRate: 5.5,
    });
    const transactions = [
      makeTransaction({ transactionDate: '2021-08-05', amount: 285 }),
      makeTransaction({ transactionDate: '2022-05-05', amount: 285 }),
    ];
    const rateChanges = [
      { effectiveDate: '2021-07-05', annualRate: 1.95 },
      { effectiveDate: '2022-04-05', annualRate: 5.5 },
    ];

    const { events, cumulativeInterest } = deriveLoanPaymentHistory(
      account,
      transactions,
      rateChanges,
    );
    expect(events.map((e) => e.interest)).toEqual([0, 0]);
    expect(cumulativeInterest).toBe(0);
    // The rate each row was charged at is still known -- from the timeline.
    expect(events[0].annualRate).toBeCloseTo(1.95, 4);
    expect(events[1].annualRate).toBeCloseTo(5.5, 4);
  });
});

describe('deriveLoanPaymentHistory reconstructed rate (no rate history)', () => {
  it('keeps a Canadian fixed mortgage on its configured rate for a principal-only row', () => {
    // No rate history and no recorded interest, so there is nothing to
    // reconstruct from -- but a fixed loan's configured rate was in effect on
    // that date regardless of what the payment settled, so the Rate column must
    // keep showing it. Dropping it to null alongside the interest is the
    // regression the #1255 fix must not cause.
    const account = makeAccount({
      accountType: 'MORTGAGE',
      mortgageType: 'CANADIAN_FIXED',
      openingBalance: -200000,
      currentBalance: -199715,
      interestRate: 5.5,
    });
    const { events } = deriveLoanPaymentHistory(account, [
      makeTransaction({ transactionDate: '2022-05-05', amount: 285 }),
    ]);
    expect(events[0].interest).toBe(0);
    expect(events[0].annualRate).toBeCloseTo(5.5, 4);
  });

  it('keeps a non-Canadian fixed loan on its configured rate for a principal-only row', () => {
    const account = makeAccount({
      accountType: 'MORTGAGE',
      mortgageType: 'ANNUITY',
      openingBalance: -200000,
      currentBalance: -199000,
      interestRate: 6,
    });
    const { events } = deriveLoanPaymentHistory(account, [
      makeTransaction({ transactionDate: '2024-01-05', amount: 1000 }),
    ]);
    expect(events[0].interest).toBe(0);
    expect(events[0].annualRate).toBeCloseTo(6, 4);
  });

  it('shows 0% -- not "--" -- for a fixed interest-free loan', () => {
    // `Number(null)` is 0, so a `configuredRate > 0` gate cannot tell an
    // interest-free loan from one with no rate configured, and hid the rate of
    // the loan whose rate is the most certain of all: 0% is recorded, every row
    // books no interest, and every row's rate is known.
    const account = makeAccount({
      interestRate: 0,
      openingBalance: -10000,
      currentBalance: -9550,
    });
    const { events } = deriveLoanPaymentHistory(account, [
      makeTransaction({ transactionDate: '2026-01-15', amount: 450 }),
    ]);
    expect(events[0].interest).toBe(0);
    expect(events[0].annualRate).toBe(0);
  });

  it('still shows no rate when none is configured at all', () => {
    // The other side of the same distinction: absent is not 0%.
    const account = makeAccount({
      interestRate: null as unknown as number,
    });
    const { events } = deriveLoanPaymentHistory(account, [
      makeTransaction({ transactionDate: '2026-01-15', amount: 450 }),
    ]);
    expect(events[0].annualRate).toBeNull();
  });

  it('shows no rate on an overpayment row of a fixed-rate loan', () => {
    // An overpayment is not a scheduled installment, so it carries no rate --
    // the configured-rate fallback is for regular rows only.
    const account = makeAccount({
      overpaymentCategoryId: 'cat-over',
      interestRate: 6,
    });
    const { events } = deriveLoanPaymentHistory(account, [
      makeTransaction({
        transactionDate: '2026-01-15',
        amount: 500,
        categoryId: 'cat-over',
      }),
    ]);
    expect(events[0].type).toBe('OVERPAYMENT');
    expect(events[0].annualRate).toBeNull();
  });

  it('uses semi-annual annualization for a Canadian fixed mortgage that recorded interest', () => {
    // With interest actually recorded, the rate is reconstructed from it rather
    // than read off the account. The periodic annualization inverts the
    // semi-annual compounding and recovers the nominal 5.5% exactly, where a
    // day-count annualization (x365/days) would read ~5.44%.
    const account = makeAccount({
      accountType: 'MORTGAGE',
      mortgageType: 'CANADIAN_FIXED',
      openingBalance: -200000,
      currentBalance: -199715,
      interestRate: 5.5,
    });
    const recordedInterest = 200000 * getPeriodicRate(5.5, 12, 'CANADIAN_FIXED');
    const { events } = deriveLoanPaymentHistory(account, [
      withInterestSplit(
        makeTransaction({ transactionDate: '2022-05-05', amount: 285 }),
        'parent-1',
        recordedInterest,
      ),
    ]);
    expect(events[0].interest).toBeCloseTo(recordedInterest, 2);
    expect(events[0].annualRate).toBeCloseTo(5.5, 1);
  });

  it('uses day-count annualization for a non-Canadian loan that recorded interest', () => {
    // Same shape, not Canadian: the day-count annualization over the nominal
    // first period recovers 6% from balance x rate/12 of recorded interest.
    const account = makeAccount({
      accountType: 'MORTGAGE',
      mortgageType: 'ANNUITY',
      openingBalance: -200000,
      currentBalance: -199000,
      interestRate: 6,
    });
    const recordedInterest = 200000 * (6 / 100 / 12);
    const { events } = deriveLoanPaymentHistory(account, [
      withInterestSplit(
        makeTransaction({ transactionDate: '2024-01-05', amount: 1000 }),
        'parent-1',
        recordedInterest,
      ),
    ]);
    expect(events[0].interest).toBeCloseTo(recordedInterest, 2);
    expect(events[0].annualRate).toBeCloseTo(6, 1);
  });

  it('annualizes an ANNUITY mortgage by day count, not by the periods per year', () => {
    // docs/specs/mortgage-types.md table 4.1: ANNUITY's annualization trait is
    // DAY_COUNT. The two differ on any period that is not exactly 365/12 days,
    // so the second, 31-day period tells them apart.
    const account = makeAccount({
      accountType: 'MORTGAGE',
      mortgageType: 'ANNUITY',
      openingBalance: -200000,
      currentBalance: -198000,
      interestRate: 6,
    });
    const { events } = deriveLoanPaymentHistory(account, [
      withInterestSplit(
        makeTransaction({ id: 'tx-1', transactionDate: '2024-01-05', amount: 1500 }),
        'parent-1',
        1000,
      ),
      withInterestSplit(
        makeTransaction({ id: 'tx-2', transactionDate: '2024-02-05', amount: 1500 }),
        'parent-2',
        997.5,
      ),
    ]);
    const second = events[1];
    const periodicRate = second.interest / (second.balance + second.principal);
    expect(second.annualRate).toBeCloseTo(periodicRate * (365 / 31) * 100, 6);
    expect(second.annualRate).not.toBeCloseTo(periodicRate * 12 * 100, 2);
  });

  it('annualizes the same interest by the stored type', () => {
    // CANADIAN_FIXED inverts the semi-annual compounding and recovers 5.5%
    // exactly.
    const recordedInterest = 200000 * getPeriodicRate(5.5, 12, 'CANADIAN_FIXED');
    const history = (overrides: Partial<Account>) =>
      deriveLoanPaymentHistory(
        makeAccount({
          accountType: 'MORTGAGE',
          openingBalance: -200000,
          currentBalance: -199715,
          interestRate: 5.5,
          ...overrides,
        }),
        [
          withInterestSplit(
            makeTransaction({ transactionDate: '2022-05-05', amount: 285 }),
            'parent-1',
            recordedInterest,
          ),
        ],
      ).events[0].annualRate;

    expect(
      history({ mortgageType: 'CANADIAN_FIXED' }),
    ).toBeCloseTo(5.5, 3);
    // ANNUITY annualizes by day count, reading the same interest as about
    // 5.44%.
    expect(history({ mortgageType: 'ANNUITY' })).toBeCloseTo(5.44, 2);
  });
});

describe('deriveLoanPaymentHistory rate column with a recorded rate history', () => {
  it('shows the discrete timeline rate on regular rows, not the observed reconstruction', () => {
    // With a recorded rate history the schedule's rate column must show the
    // exact rate in effect on each date -- the clean, discrete history -- not
    // the per-installment figure reconstructed from the interest charged, which
    // jitters with the day count and reads as "averaged by month".
    const account = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -200000,
      currentBalance: -199100,
      interestRate: 3.25,
    });
    // Payments on irregular days: the observed (interest/balance/days) rate
    // would not land on the clean 1.75 / 2.25 / 3.25 steps.
    const transactions = [
      makeTransaction({ transactionDate: '2022-05-13', amount: 300 }),
      makeTransaction({ transactionDate: '2022-06-24', amount: 300 }),
      makeTransaction({ transactionDate: '2022-08-05', amount: 300 }),
    ];
    const rateChanges = [
      { effectiveDate: '2022-05-13', annualRate: 1.75 },
      { effectiveDate: '2022-06-24', annualRate: 2.25 },
      { effectiveDate: '2022-08-05', annualRate: 3.25 },
    ];

    const { events } = deriveLoanPaymentHistory(account, transactions, rateChanges);

    expect(events[0].annualRate).toBe(1.75);
    expect(events[1].annualRate).toBe(2.25);
    expect(events[2].annualRate).toBe(3.25);
  });

  it('shows no rate on an overpayment row even with a recorded rate history', () => {
    const account = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -200000,
      currentBalance: -196700,
      interestRate: 5.5,
      overpaymentCategoryId: 'cat-over',
    });
    const transactions = [
      makeTransaction({ transactionDate: '2024-01-05', amount: 300 }),
      makeTransaction({ transactionDate: '2024-01-20', amount: 3000, categoryId: 'cat-over' }),
    ];
    const rateChanges = [{ effectiveDate: '2024-01-01', annualRate: 5.5 }];

    const { events } = deriveLoanPaymentHistory(account, transactions, rateChanges);

    const overpayment = events.find((e) => e.type === 'OVERPAYMENT');
    const regular = events.find((e) => e.type === 'REGULAR');
    expect(overpayment?.annualRate).toBeNull();
    expect(regular?.annualRate).toBe(5.5);
  });
});

describe('deriveLoanPaymentHistory with paired separate interest expenses', () => {
  it('uses the actual interest expense per row and shows overpayment interest', () => {
    const account = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -200000,
      currentBalance: -197206.78,
      interestRate: 5.5,
      overpaymentMemo: 'nadplata',
    });
    // Loan-account rows: a regular principal transfer, then an overpayment.
    const transactions = [
      makeTransaction({ transactionDate: '2024-06-05', amount: 259.13 }),
      makeTransaction({
        transactionDate: '2024-07-15',
        amount: 2534.09,
        description: 'nadplata',
      }),
    ];
    // Separate interest expenses on the source account (never on the loan).
    const interestTransactions = [
      { transactionDate: '2024-06-05', amount: -849.93, isTransfer: false } as Transaction,
      { transactionDate: '2024-07-15', amount: -535.91, isTransfer: false } as Transaction,
      // A principal transfer that shares the interest category -> excluded, so
      // it is not folded into the regular row's interest.
      { transactionDate: '2024-06-05', amount: -259.13, isTransfer: true } as Transaction,
    ];

    const { events } = deriveLoanPaymentHistory(
      account,
      transactions,
      [],
      interestTransactions,
    );

    // Regular row: exactly the expense (849.93), not + the 259.13 transfer.
    expect(events[0].type).toBe('REGULAR');
    expect(events[0].interest).toBeCloseTo(849.93, 2);
    // Overpayment row: the real interest charged alongside it (not 0).
    expect(events[1].type).toBe('OVERPAYMENT');
    expect(events[1].interest).toBeCloseTo(535.91, 2);
    // Principal walk unchanged: the overpayment reduces the balance by 2534.09.
    expect(events[1].principal).toBeCloseTo(2534.09, 2);
  });

  it('adds interest-only rows for grace-period interest with no principal', () => {
    const account = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -200000,
      currentBalance: -199740.87,
      interestRate: 5.5,
      // Origination (grace start), before the first principal payment.
      paymentStartDate: '2019-08-01',
    });
    // One principal payment; interest-only grace expenses long before it.
    const transactions = [
      makeTransaction({ transactionDate: '2021-07-05', amount: 259.13 }),
    ];
    const interestTransactions = [
      { transactionDate: '2019-08-05', amount: -388.14, isTransfer: false } as Transaction,
      { transactionDate: '2019-09-05', amount: -286.49, isTransfer: false } as Transaction,
      { transactionDate: '2021-07-05', amount: -335.92, isTransfer: false } as Transaction,
    ];

    const { events, cumulativeInterest } = deriveLoanPaymentHistory(
      account,
      transactions,
      [],
      interestTransactions,
    );

    // Two interest-only grace rows (principal 0, balance = opening) + the payment.
    expect(events).toHaveLength(3);
    expect(events[0].date).toContain('2019-08');
    expect(events[0].principal).toBe(0);
    expect(events[0].interest).toBeCloseTo(388.14, 2);
    expect(events[0].balance).toBeCloseTo(200000, 2);
    // The principal payment keeps its principal and its own (paired) interest.
    expect(events[2].principal).toBeCloseTo(259.13, 2);
    expect(events[2].interest).toBeCloseTo(335.92, 2);
    // Grace interest is counted in the running total.
    expect(cumulativeInterest).toBeCloseTo(388.14 + 286.49 + 335.92, 2);
  });

  it('keeps a zero-amount interest row (a payment holiday), like a -0.01 one', () => {
    // A suspended installment ("wakacje kredytowe") posts a 0 against the
    // interest category. It is a real recorded event, so it must show in the
    // schedule -- dropping exactly 0 while keeping a -0.01 rounding of the same
    // row is the bug this asserts against (an interest expense far from any
    // payment becomes its own interest-only row).
    const account = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -200000,
      currentBalance: -199000,
      interestRate: 5.5,
    });
    const transactions = [
      makeTransaction({ transactionDate: '2022-01-05', amount: 500 }),
    ];

    const withZero = deriveLoanPaymentHistory(account, transactions, [], [
      { transactionDate: '2020-01-05', amount: 0, isTransfer: false } as Transaction,
    ]);
    const withTinyNegative = deriveLoanPaymentHistory(account, transactions, [], [
      { transactionDate: '2020-01-05', amount: -0.01, isTransfer: false } as Transaction,
    ]);

    // The zero row is kept (an interest-only row), so the schedule has the same
    // number of rows either way.
    expect(withZero.events).toHaveLength(withTinyNegative.events.length);
    const zeroRow = withZero.events.find((e) => e.date.includes('2020-01'));
    expect(zeroRow).toBeDefined();
    expect(zeroRow!.principal).toBe(0);
    expect(zeroRow!.interest).toBe(0);
  });

  it('consumes a date\'s booked interest once across two payments sharing it', () => {
    // Real case (2023-09-05): two principal payments land on the same day -- an
    // overpayment (973.11, whose interest is booked separately) and the regular
    // installment (1097.78, booked with zero interest). The day's two booked
    // interest expenses (596.89 + 28.28 = 625.17) are the whole month's
    // interest. The overpayment consumes the paired interest and the
    // principal-only installment is left at 0, so the month's interest is the
    // booked figure rather than double-counted (previously ~+860 over).
    const account = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -206718.35,
      currentBalance: -142332.03,
      interestRate: 5.5,
    });
    const transactions = [
      makeTransaction({
        id: 'over',
        transactionDate: '2023-09-05',
        amount: 973.11,
        description: 'Nadpłata 2023-09-05 (kapitał z 1 570; odsetki osobno)',
      }),
      makeTransaction({
        id: 'reg',
        transactionDate: '2023-09-05',
        amount: 1097.78,
        description: 'Kapitał raty 2023-09 (KAPITAL: 1097.78 ODSETKI: 0.00)',
      }),
    ];
    const interestTransactions = [
      { transactionDate: '2023-09-05', amount: -596.89, isTransfer: false, description: 'Odsetki z nadpłaty 2023-09-05' } as Transaction,
      { transactionDate: '2023-09-05', amount: -28.28, isTransfer: false } as Transaction,
    ];

    const { events } = deriveLoanPaymentHistory(account, transactions, [], interestTransactions);
    const sept = events.filter((e) => e.date.startsWith('2023-09'));
    const septInterest = sept.reduce((s, e) => s + e.interest, 0);

    // Whole-month interest equals the booked expenses, with nothing added.
    expect(septInterest).toBeCloseTo(625.17, 2);
    // The principal-only installment row carries zero interest.
    const regRow = sept.find((e) => Math.abs(e.principal - 1097.78) < 0.01);
    expect(regRow).toBeDefined();
    expect(regRow!.interest).toBe(0);
  });

  it('includes interest booked before the configured start date (interest-only grace period)', () => {
    // Real dataset shape: the interest-only grace period starts 2019-08, but
    // paymentStartDate was set later (2020-04, e.g. guessed at setup). Interest
    // is scoped by category, not date, so the pre-start grace interest still
    // shows and counts instead of being truncated at the configured start.
    const account = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -206718.35,
      currentBalance: -142332.03,
      interestRate: 5.5,
      paymentStartDate: '2020-04-05',
    });
    const transactions = [makeTransaction({ transactionDate: '2021-07-05', amount: 469.58 })];
    const interestTransactions = [
      { transactionDate: '2019-08-05', amount: -388.14, isTransfer: false } as Transaction,
      { transactionDate: '2019-09-05', amount: -286.49, isTransfer: false } as Transaction,
      { transactionDate: '2021-07-05', amount: -335.92, isTransfer: false } as Transaction,
    ];

    const { events } = deriveLoanPaymentHistory(account, transactions, [], interestTransactions);

    // Grace interest from 2019-08 appears, ahead of the 2020-04 start date.
    expect(events[0].date).toContain('2019-08');
    expect(events.some((e) => e.date.startsWith('2019-09'))).toBe(true);
    expect(events[0].interest).toBeCloseTo(388.14, 2);
  });

  it('includes all category interest regardless of date; refinances need distinct categories', () => {
    // Interest is scoped by the configured interest category and source account,
    // not by date, so an active loan shows every payment in that category. The
    // flip side, called out for reviewers: sequential refinanced mortgages that
    // reuse ONE interest category can no longer be separated by date -- give
    // each refinance its own interest category to keep them apart.
    const account = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -300000,
      currentBalance: -299000,
      interestRate: 5,
      paymentStartDate: '2022-08-01',
    });
    const transactions = [
      makeTransaction({ transactionDate: '2022-08-05', amount: 500 }),
      makeTransaction({ transactionDate: '2022-09-05', amount: 500 }),
    ];
    const interestTransactions = [
      { transactionDate: '2012-06-05', amount: -900, isTransfer: false } as Transaction,
      { transactionDate: '2020-06-05', amount: -800, isTransfer: false } as Transaction,
      { transactionDate: '2022-08-05', amount: -1250, isTransfer: false } as Transaction,
      { transactionDate: '2022-09-05', amount: -1245, isTransfer: false } as Transaction,
    ];

    const { events } = deriveLoanPaymentHistory(account, transactions, [], interestTransactions);

    // All category interest is now included, including the earlier dates.
    expect(events.some((e) => e.date.startsWith('2012'))).toBe(true);
    expect(events.some((e) => e.date.startsWith('2020'))).toBe(true);
    expect(events.some((e) => e.date.startsWith('2022'))).toBe(true);
    // ...and this loan's own interest is still attributed to the right date,
    // so a pairing regression can't slip through the date-presence checks.
    const aug = events.find((e) => e.date.startsWith('2022-08'));
    expect(aug?.interest).toBeCloseTo(1250, 0);
  });

  it('excludes interest booked after the final payment once the loan is paid off', () => {
    // A paid-off loan should not absorb interest later booked in the same
    // category (e.g. a subsequent loan). Active loans keep accruing to today.
    const account = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -100000,
      currentBalance: 0,
      interestRate: 5,
    });
    const transactions = [makeTransaction({ transactionDate: '2023-01-05', amount: 100000 })];
    const interestTransactions = [
      { transactionDate: '2023-01-05', amount: -400, isTransfer: false } as Transaction,
      { transactionDate: '2024-06-05', amount: -300, isTransfer: false } as Transaction,
    ];

    const { events } = deriveLoanPaymentHistory(account, transactions, [], interestTransactions);

    expect(events.some((e) => e.date.startsWith('2024'))).toBe(false);
  });

  it('derives the observed rate from the actual days between payments', () => {
    // A 5.5% loan: the second payment falls 31 days after the first, and its
    // interest is exactly 31 days of 5.5% on the balance then owed. The rate
    // must come out at ~5.5%, not the 5.6% an assumed 1/12 month would give.
    const account = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -200000,
      currentBalance: -199400,
      interestRate: 5.5,
    });
    const balanceBeforeSecond = 200000 - 300;
    const secondInterest = (balanceBeforeSecond * 0.055 * 31) / 365;
    const transactions = [
      makeTransaction({ transactionDate: '2024-01-05', amount: 300 }),
      makeTransaction({ transactionDate: '2024-02-05', amount: 300 }),
    ];
    const interestTransactions = [
      { transactionDate: '2024-01-05', amount: -900, isTransfer: false } as Transaction,
      { transactionDate: '2024-02-05', amount: -secondInterest, isTransfer: false } as Transaction,
    ];

    const { events } = deriveLoanPaymentHistory(account, transactions, [], interestTransactions);

    expect(events[1].interest).toBeCloseTo(secondInterest, 2);
    expect(events[1].annualRate).toBeCloseTo(5.5, 1);
  });

  it('caps the accrual span at one interval after a payment-holiday gap', () => {
    // A four-month gap (payment holiday) precedes an installment whose interest
    // is only one month's worth. Dividing that interest across the whole gap
    // would report ~1.5%; capping the span at one interval recovers the ~6%.
    const account = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -200000,
      currentBalance: -199500,
      interestRate: 6,
    });
    const balanceBeforeSecond = 200000 - 250;
    const oneMonthInterest = (balanceBeforeSecond * 0.06) / 12;
    const transactions = [
      makeTransaction({ transactionDate: '2022-10-05', amount: 250 }),
      makeTransaction({ transactionDate: '2023-02-05', amount: 250 }),
    ];
    const interestTransactions = [
      { transactionDate: '2022-10-05', amount: -1000, isTransfer: false } as Transaction,
      { transactionDate: '2023-02-05', amount: -oneMonthInterest, isTransfer: false } as Transaction,
    ];

    const { events } = deriveLoanPaymentHistory(account, transactions, [], interestTransactions);

    expect(events[1].annualRate).toBeCloseTo(6, 1);
  });

  it('does not let a zero-interest overpayment inflate the next rate', () => {
    // A pure-principal overpayment (no interest) six days before a regular
    // installment must not reset the accrual clock: the installment's interest
    // still covers the whole month, so measuring from the overpayment would
    // report an absurd rate (~25%). The gap is taken from the last interest.
    const account = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -200000,
      currentBalance: -196468,
      interestRate: 5.5,
      overpaymentCategoryId: 'cat-over',
    });
    const transactions = [
      makeTransaction({ transactionDate: '2025-10-06', amount: 281 }),
      makeTransaction({ transactionDate: '2025-10-30', amount: 3000, categoryId: 'cat-over' }),
      makeTransaction({ transactionDate: '2025-11-05', amount: 251 }),
    ];
    const interestTransactions = [
      { transactionDate: '2025-10-06', amount: -786, isTransfer: false } as Transaction,
      { transactionDate: '2025-11-05', amount: -796.93, isTransfer: false } as Transaction,
    ];

    const { events } = deriveLoanPaymentHistory(account, transactions, [], interestTransactions);

    // The overpayment carries no interest, so it has no rate.
    expect(events[1].type).toBe('OVERPAYMENT');
    expect(events[1].annualRate).toBeNull();
    // The following installment's rate is sane (~5%), not the ~25% a 6-day gap
    // would produce.
    expect(events[2].annualRate).toBeGreaterThan(3);
    expect(events[2].annualRate).toBeLessThan(8);
  });

  it('shows no rate on an overpayment even when it carries interest', () => {
    const account = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -200000,
      currentBalance: -194500,
      interestRate: 6,
      overpaymentCategoryId: 'cat-over',
    });
    const balanceBeforeSecondRegular = 200000 - 250 - 5000;
    const secondInterest = (balanceBeforeSecondRegular * 0.06 * 16) / 365;
    const transactions = [
      makeTransaction({ transactionDate: '2024-01-05', amount: 250 }),
      makeTransaction({ transactionDate: '2024-01-20', amount: 5000, categoryId: 'cat-over' }),
      makeTransaction({ transactionDate: '2024-02-05', amount: 250 }),
    ];
    const interestTransactions = [
      { transactionDate: '2024-01-05', amount: -1000, isTransfer: false } as Transaction,
      { transactionDate: '2024-01-20', amount: -400, isTransfer: false } as Transaction,
      { transactionDate: '2024-02-05', amount: -secondInterest, isTransfer: false } as Transaction,
    ];

    const { events } = deriveLoanPaymentHistory(account, transactions, [], interestTransactions);

    // The overpayment has interest but shows no rate...
    expect(events[1].type).toBe('OVERPAYMENT');
    expect(events[1].interest).toBeGreaterThan(0);
    expect(events[1].annualRate).toBeNull();
    // ...yet it settled interest, so the next installment measures from it (16
    // days) and reads ~6%, not a full month.
    expect(events[2].annualRate).toBeCloseTo(6, 0);
  });

  it('falls back to the timeline rate when the installment carries only a partial-period stub', () => {
    // Real case: aggressive overpayments settle most of a period's interest with
    // themselves, leaving the regular installment a tiny stub (146 on ~198k).
    // Annualizing that stub reports an absurd ~0.9%; since it is far below a full
    // period's expected accrual, the row must instead show the contractual 5.5%.
    const account = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -200000,
      currentBalance: -197350,
      interestRate: 5.5,
      overpaymentCategoryId: 'cat-over',
    });
    const rateChanges = [{ effectiveDate: '2022-04-05', annualRate: 5.5 }];
    const transactions = [
      makeTransaction({ transactionDate: '2022-08-05', amount: 1650, categoryId: 'cat-over' }),
      makeTransaction({ transactionDate: '2022-10-05', amount: 1000 }),
    ];
    const interestTransactions = [
      { transactionDate: '2022-08-05', amount: -415, isTransfer: false } as Transaction,
      { transactionDate: '2022-10-05', amount: -146, isTransfer: false } as Transaction,
    ];

    const withTimeline = deriveLoanPaymentHistory(
      account,
      transactions,
      rateChanges,
      interestTransactions,
    );
    // The regular installment shows the contractual rate, not the ~0.9% stub.
    expect(withTimeline.events[1].type).toBe('REGULAR');
    expect(withTimeline.events[1].interest).toBeCloseTo(146, 2);
    expect(withTimeline.events[1].annualRate).toBeCloseTo(5.5, 1);

    // Without any timeline rate (no rate changes and no account rate) there is
    // no better figure than the plain observed rate, so the stub's low rate is
    // kept.
    const rateless = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -200000,
      currentBalance: -197350,
      interestRate: 0,
      overpaymentCategoryId: 'cat-over',
    });
    const noTimeline = deriveLoanPaymentHistory(rateless, transactions, [], interestTransactions);
    expect(noTimeline.events[1].annualRate).toBeLessThan(2);
  });

  it('rates a regular installment that shares its date with an interest-bearing overpayment', () => {
    // An overpayment and the regular installment fall on the same day. The
    // overpayment settles interest first, so the installment has a zero-day gap
    // to the previous interest event -- but it still covers a full period, so
    // its rate must not be dropped. The overpayment itself still shows none.
    const account = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -200000,
      currentBalance: -194500,
      interestRate: 5.5,
      overpaymentCategoryId: 'cat-over',
    });
    const transactions = [
      withInterestSplit(makeTransaction({ transactionDate: '2024-01-05', amount: 250 }), 'p-1', 900),
      makeTransaction({ transactionDate: '2024-02-05', amount: 5000, categoryId: 'cat-over' }),
      withInterestSplit(makeTransaction({ transactionDate: '2024-02-05', amount: 250 }), 'p-3', 860),
    ];
    // A separate interest expense on the overpayment's date, so the overpayment
    // carries interest and settles the accrual clock on 2024-02-05.
    const interestTransactions = [
      { transactionDate: '2024-02-05', amount: -625, isTransfer: false } as Transaction,
    ];

    const { events } = deriveLoanPaymentHistory(account, transactions, [], interestTransactions);

    const overpayment = events.find((event) => event.type === 'OVERPAYMENT');
    const sameDayRegular = events.find(
      (event) => event.type === 'REGULAR' && event.date === '2024-02-05',
    );
    expect(overpayment?.annualRate).toBeNull();
    expect(sameDayRegular?.annualRate).not.toBeNull();
    expect(sameDayRegular!.annualRate!).toBeGreaterThan(3);
    expect(sameDayRegular!.annualRate!).toBeLessThan(8);
  });
});

describe('diagnoseLoanProjection', () => {
  const TODAY = '2026-06-01';

  // The reason and buildLoanProjectionInput share one evaluation, so a reason
  // of null must mean the input builds, and any reason must mean it does not.
  function reasonAndInputAgree(account: Account, rateChanges = []) {
    const history = deriveLoanPaymentHistory(account, []);
    const reason = diagnoseLoanProjection(account, history, rateChanges, null, TODAY);
    const input = buildLoanProjectionInput(account, history, rateChanges, null, TODAY);
    return { reason, input };
  }

  it('is null and the input builds for a rate + payment + frequency loan', () => {
    const { reason, input } = reasonAndInputAgree(makeAccount());
    expect(reason).toBeNull();
    expect(input).not.toBeNull();
  });

  it("reports 'paid-off' when nothing is outstanding", () => {
    const { reason, input } = reasonAndInputAgree(
      makeAccount({ currentBalance: 0 }),
    );
    expect(reason).toBe('paid-off');
    expect(input).toBeNull();
  });

  it("reports 'no-frequency' when the payment frequency is unset", () => {
    const { reason, input } = reasonAndInputAgree(
      makeAccount({ paymentFrequency: null as unknown as Account['paymentFrequency'] }),
    );
    expect(reason).toBe('no-frequency');
    expect(input).toBeNull();
  });

  it("reports 'no-rate' when no rate is recorded anywhere", () => {
    const { reason, input } = reasonAndInputAgree(
      makeAccount({ interestRate: null as unknown as number }),
    );
    expect(reason).toBe('no-rate');
    expect(input).toBeNull();
  });

  it("reports 'no-payment' when the installment cannot be resolved", () => {
    // Rate is set, but there is no observed regular installment (no rows on the
    // loan account) and no stored contractual payment -- the shape of a loan
    // whose installments were booked as expenses on the source account.
    const { reason, input } = reasonAndInputAgree(
      makeAccount({ paymentAmount: undefined as unknown as number }),
    );
    expect(reason).toBe('no-payment');
    expect(input).toBeNull();
  });
});

describe('resolveSeedPayment recency: a later real payment supersedes a stated one', () => {
  const TODAY = '2026-09-01';
  // A regular installment actually paid on 2026-08-05:
  // 104.74 principal + 775.07 interest = 879.81, interest recorded (complete).
  const paid = withInterestSplit(
    makeTransaction({ id: 'reg', transactionDate: '2026-08-05', amount: 104.74 }),
    'parent-reg',
    775.07,
  );
  const account = makeAccount({
    accountType: 'MORTGAGE',
    currentBalance: -135662.61,
    interestRate: 5.5,
  });

  it('uses the observed installment when it is dated after the stated payment row', () => {
    // The user's case: 1,200.99 stated in a 2022 rate-change row, while the
    // lender re-amortized after each overpayment and the 2026 payment is 879.81.
    // The stated figure showed as "the installment" on every surface and seeded
    // a projection of payments nobody was making.
    const rows = [
      { effectiveDate: '2022-04-05', annualRate: 5.5, newPaymentAmount: 1200.99, source: 'manual' as const },
    ];
    const history = deriveLoanPaymentHistory(account, [paid], rows);
    const terms = resolveCurrentLoanTerms(account, history, rows, null, TODAY);
    expect(terms.payment).toBeCloseTo(879.81, 2);
  });

  it('keeps the stated payment when its row is dated after the last real payment', () => {
    // A rate rise recorded with a new contractual installment that has not been
    // paid yet must not be overridden by the older observation.
    const rows = [
      { effectiveDate: '2026-08-20', annualRate: 5.5, newPaymentAmount: 1300, source: 'manual' as const },
    ];
    const history = deriveLoanPaymentHistory(account, [paid], rows);
    const terms = resolveCurrentLoanTerms(account, history, rows, null, TODAY);
    expect(terms.payment).toBe(1300);
  });
});
