import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useLoanProjection } from './useLoanProjection';
import type { Account } from '@/types/account';
import type { Transaction } from '@/types/transaction';

const getAllPages = vi.fn();
const getAll = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: (...args: unknown[]) => getAll(...args),
    getAllPages: (...args: unknown[]) => getAllPages(...args),
  },
}));

const getRateChanges = vi.fn();
// `importOriginal` rather than a bare factory: the hook derives
// `AMORTIZING_DEBT_TYPES` from this module's `RATE_CHANGE_ACCOUNT_TYPES`, and a
// factory listing only the api object replaces the real export with
// `undefined` -- which is the derivation this file is meant to be exercising.
vi.mock('@/lib/loan-rate-changes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/loan-rate-changes')>()),
  loanRateChangesApi: {
    getAll: (...args: unknown[]) => getRateChanges(...args),
  },
}));

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'mtg-1',
    accountType: 'MORTGAGE',
    name: 'Home Mortgage',
    currencyCode: 'CAD',
    openingBalance: -300000,
    currentBalance: -250000,
    interestRate: 5,
    paymentAmount: 1800,
    paymentFrequency: 'MONTHLY',
    mortgageType: 'ANNUITY',
    interestCategoryId: null,
    sourceAccountId: null,
    ...overrides,
  } as Account;
}

/** A repayment posted against the loan account (positive on a debt account). */
function payment(id: string, date: string, amount: number): Transaction {
  return { id, transactionDate: date, amount } as Transaction;
}

function pageOf(data: Transaction[]) {
  return { data, pagination: { hasMore: false } };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAll.mockResolvedValue(pageOf([]));
  getAllPages.mockResolvedValue([]);
  getRateChanges.mockResolvedValue([]);
});

describe('useLoanProjection', () => {
  it('is idle and fetches nothing for an account type that does not amortize', () => {
    const { result } = renderHook(() =>
      useLoanProjection(makeAccount({ accountType: 'CHEQUING' })),
    );
    expect(result.current.status).toBe('idle');
    expect(result.current.currentPayment).toBeNull();
    expect(result.current.payoffDate).toBeNull();
    expect(result.current.remainingInterest).toBeNull();
    expect(getAll).not.toHaveBeenCalled();
    expect(getRateChanges).not.toHaveBeenCalled();
  });

  it('starts as loading with every figure unknown', async () => {
    const { result } = renderHook(() => useLoanProjection(makeAccount()));
    expect(result.current.status).toBe('loading');
    expect(result.current.currentPayment).toBeNull();
    expect(result.current.payoffDate).toBeNull();
    expect(result.current.remainingInterest).toBeNull();
    // Drain the in-flight load so its state update lands inside the test.
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('derives the payment, payoff date and remaining interest from the history', async () => {
    getAll.mockResolvedValue(
      pageOf([
        payment('t1', '2026-05-15', 1800),
        payment('t2', '2026-06-15', 1800),
        payment('t3', '2026-07-15', 1800),
      ]),
    );
    const { result } = renderHook(() => useLoanProjection(makeAccount()));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.currentPayment).toBeGreaterThan(0);
    expect(result.current.payoffDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.current.remainingInterest).toBeGreaterThan(0);
    expect(result.current.isSettled).toBe(false);
  });

  // A failed history load is not an empty history: projecting from no payments
  // at all would put a plausible payoff date on screen with nothing behind it.
  it('reports a failed load as unknown rather than as an empty history', async () => {
    getAll.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useLoanProjection(makeAccount()));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.currentPayment).toBeNull();
    expect(result.current.payoffDate).toBeNull();
    expect(result.current.remainingInterest).toBeNull();
  });

  it('reports a failed rate-history load as unknown too', async () => {
    getRateChanges.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useLoanProjection(makeAccount()));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.remainingInterest).toBeNull();
  });

  it('reports a settled mortgage as paid off with no interest remaining', async () => {
    const { result } = renderHook(() =>
      useLoanProjection(makeAccount({ currentBalance: 0 })),
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.isSettled).toBe(true);
    expect(result.current.remainingInterest).toBe(0);
    expect(result.current.payoffDate).toBeNull();
  });

  // The payload is stamped with the account it answers for, so the previously
  // selected loan's figures never stand in for the newly selected one.
  it('does not show the previous account answer under a newly selected account', async () => {
    getAll.mockResolvedValue(pageOf([payment('t1', '2026-06-15', 1800)]));
    const { result, rerender } = renderHook(
      ({ account }: { account: Account }) => useLoanProjection(account),
      { initialProps: { account: makeAccount() } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    // Never resolve the second account's history: its figures must be unknown,
    // not the first account's.
    getAll.mockReturnValue(new Promise(() => {}));
    rerender({ account: makeAccount({ id: 'mtg-2', currentBalance: -99000 }) });

    expect(result.current.status).toBe('loading');
    expect(result.current.payoffDate).toBeNull();
    expect(result.current.remainingInterest).toBeNull();
  });

  it('recovers when a refresh succeeds after a transient interest failure', async () => {
    // The whole reason fetchLoanInterestTransactions rejects rather than
    // returning [] is so a caller can retry. A failure identity that outlives
    // the successful retry defeats that: one timeout would leave Current
    // Payment, Est. Payoff and Est. Remaining Interest unavailable for the rest
    // of the page's life, through every later reload.
    const loan = makeAccount({
      interestCategoryId: 'cat-int',
      sourceAccountId: 'src-1',
      currentBalance: -250000,
    });
    getAll.mockResolvedValue(pageOf([payment('t1', '2026-06-15', 600)]));
    getAllPages.mockRejectedValueOnce(new Error('timeout'));

    const { result, rerender } = renderHook(
      ({ refreshKey }: { refreshKey: number }) =>
        useLoanProjection(loan, refreshKey),
      { initialProps: { refreshKey: 0 } },
    );
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.currentPayment).toBeNull();

    // The separately booked $400 interest beside the $600 principal makes the
    // real installment $1,000 -- knowable, and known, once this read lands.
    getAllPages.mockResolvedValue([
      {
        id: 'i1',
        transactionDate: '2026-06-15',
        amount: -400,
        categoryId: 'cat-int',
        isTransfer: false,
      } as unknown as Transaction,
    ]);
    rerender({ refreshKey: 1 });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.currentPayment).toBe(1000);
  });

  it('keeps a failure recorded for another account while this one succeeds', async () => {
    // The clear is keyed on the account that succeeded, so recovering one loan
    // must not silently mark a different, still-broken loan as fine.
    getAll.mockRejectedValueOnce(new Error('network'));
    const { result, rerender } = renderHook(
      ({ account }: { account: Account }) => useLoanProjection(account),
      { initialProps: { account: makeAccount({ id: 'mtg-broken' }) } },
    );
    await waitFor(() => expect(result.current.status).toBe('error'));

    getAll.mockResolvedValue(pageOf([payment('t1', '2026-06-15', 1800)]));
    rerender({ account: makeAccount({ id: 'mtg-fine' }) });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    // Back to the loan whose load failed: still an error, because nothing has
    // answered its request since.
    getAll.mockReturnValue(new Promise(() => {}));
    rerender({ account: makeAccount({ id: 'mtg-broken' }) });
    expect(result.current.status).toBe('error');
  });

  it('reports the rate in effect, not the account scalar the payoff ignores', async () => {
    // The card, the sidebar and the PDF all used to print account.interestRate
    // while the payoff was projected from the timeline. A user troubleshooting an
    // unavailable payoff was shown "5%" -- terms under which the loan amortizes
    // comfortably -- by the very screen refusing to project it at the real 12%.
    getAll.mockResolvedValue(pageOf([payment('t1', '2026-06-15', 600)]));
    getRateChanges.mockResolvedValue([
      {
        id: 'r1',
        effectiveDate: '2026-01-01',
        annualRate: 12,
        newPaymentAmount: 900,
        source: 'manual',
      },
    ]);

    const { result } = renderHook(() =>
      useLoanProjection(makeAccount({ currentBalance: -100000, interestRate: 5 })),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.currentAnnualRate).toBe(12);
    expect(result.current.currentPayment).toBe(900);
    // 100000 at 12% costs 1000 a month, so 900 does not amortize and there is no
    // payoff -- which is exactly why the displayed rate must be the 12%.
    expect(result.current.payoffDate).toBeNull();
    expect(result.current.remainingInterest).toBeNull();
  });

  it('leaves the rate unknown while loading and on failure', async () => {
    // A consumer keeps its own fallback for those states rather than being
    // handed a number that is not yet, or never was, resolved.
    getAll.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useLoanProjection(makeAccount()));
    expect(result.current.currentAnnualRate).toBeNull();
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.currentAnnualRate).toBeNull();
  });

  it('refetches when the refresh key is bumped', async () => {
    const { result, rerender } = renderHook(
      ({ refreshKey }: { refreshKey: number }) =>
        useLoanProjection(makeAccount(), refreshKey),
      { initialProps: { refreshKey: 0 } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(getAll).toHaveBeenCalledTimes(1);

    rerender({ refreshKey: 1 });
    await waitFor(() => expect(getAll).toHaveBeenCalledTimes(2));
  });
});
