import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  deriveCurrentInstallment,
  deriveLoanPaymentHistory,
  fetchAllAccountTransactions,
} from './loan-history';
import { transactionsApi } from '@/lib/transactions';
import { Account } from '@/types/account';
import { Transaction, TransactionSplit } from '@/types/transaction';

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: vi.fn(),
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
    isCanadianMortgage: false,
    isVariableRate: false,
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

  it('derives interest analytically when a payment records no interest split', () => {
    // A plain transfer with no linked interest split used to read interest = 0
    // (rata = 100% principal). It now derives interest from the running
    // balance: 10000 * (6% / 12) = 50.
    const account = makeAccount();
    const result = deriveLoanPaymentHistory(account, [
      makeTransaction({ transactionDate: '2026-01-15', amount: 450 }),
    ]);
    expect(result.events[0].type).toBe('REGULAR');
    expect(result.events[0].interest).toBeCloseTo(50, 2);
    expect(result.events[0].principal).toBe(450);
    expect(result.events[0].balance).toBe(10000 - 450);
  });

  it('prefers a recorded interest split over the analytic estimate', () => {
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

  it('does not derive analytic interest for revolving credit', () => {
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

describe('deriveCurrentInstallment', () => {
  const history = (
    events: Array<{
      principal: number;
      interest: number;
      type: 'REGULAR' | 'OVERPAYMENT';
      interestRecorded?: boolean;
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
      // Regular installments here stand for real recorded installments unless a
      // case overrides it (e.g. analytic interest from a separate booking).
      interestRecorded: e.interestRecorded ?? e.type === 'REGULAR',
    })),
    startingBalance: 0,
    currentBalance: 0,
    cumulativePrincipal: 0,
    cumulativeInterest: 0,
  });

  it('uses the last regular installment when it is lower than contractual', () => {
    const result = deriveCurrentInstallment(
      history([
        { principal: 800, interest: 200, type: 'REGULAR' },
        { principal: 765, interest: 153, type: 'REGULAR' },
      ]),
      1279,
    );
    expect(result).toBe(918);
  });

  it('uses the last regular installment even when it exceeds the stored payment', () => {
    // The stored contractual payment can be stale or principal-only, so the most
    // recent real installment (principal + interest) is preferred.
    const result = deriveCurrentInstallment(
      history([{ principal: 765, interest: 700, type: 'REGULAR' }]),
      1279,
    );
    expect(result).toBe(1465);
  });

  it('skips overpayment rows when finding the last regular installment', () => {
    const result = deriveCurrentInstallment(
      history([
        { principal: 765, interest: 153, type: 'REGULAR' },
        { principal: 5000, interest: 0, type: 'OVERPAYMENT' },
      ]),
      1279,
    );
    expect(result).toBe(918);
  });

  it('falls back to the contractual payment with no regular history', () => {
    expect(deriveCurrentInstallment(history([]), 1279)).toBe(1279);
  });

  it('uses principal + interest for separately-booked interest', () => {
    // Interest booked as a separate transaction leaves regular rows with interest
    // derived from the rate timeline; principal + interest is then the real
    // installment and always covers the period interest (the principal portion is
    // positive), so it is used directly rather than the possibly principal-only
    // stored payment.
    const result = deriveCurrentInstallment(
      history([
        { principal: 300, interest: 300, type: 'REGULAR', interestRecorded: false },
        { principal: 300, interest: 300, type: 'REGULAR', interestRecorded: false },
      ]),
      1279,
    );
    expect(result).toBe(600);
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

describe('deriveLoanPaymentHistory interest from the rate timeline', () => {
  it('derives uncapped interest from the effective per-date rate for separately-booked interest', () => {
    // A principal-only loan-side payment (interest booked as a separate
    // transaction), so there is no recorded interest split.
    const account = makeAccount({
      accountType: 'MORTGAGE',
      openingBalance: -200000,
      currentBalance: -199715,
      interestRate: 5.5,
    });
    const transactions = [
      makeTransaction({ transactionDate: '2022-05-05', amount: 285 }),
    ];
    const rateChanges = [{ effectiveDate: '2022-04-05', annualRate: 5.5 }];

    const { events } = deriveLoanPaymentHistory(account, transactions, rateChanges);
    const monthly = 200000 * (5.5 / 100 / 12);

    // Interest tracks balance x rate/12 (~916), NOT capped at the 285 principal.
    expect(events[0].interest).toBeCloseTo(monthly, 0);
    expect(events[0].interest).toBeGreaterThan(events[0].principal);
    expect(events[0].interestRecorded).toBe(false);
  });

  it('reprices each month from the timeline for a variable-rate loan', () => {
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

    const { events } = deriveLoanPaymentHistory(account, transactions, rateChanges);
    // First payment at 1.95%, second (later) at 5.5% -> higher interest.
    expect(events[0].interest).toBeCloseTo(200000 * (1.95 / 100 / 12), 0);
    expect(events[1].interest).toBeGreaterThan(events[0].interest);
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

    // Regular row: exactly the expense (849.93), not analytic, not + the 259.13 transfer.
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
});
