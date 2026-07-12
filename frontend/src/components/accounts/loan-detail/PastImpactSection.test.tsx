import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { PastImpactSection } from './PastImpactSection';
import { computePastImpact } from '@/lib/loan-past-impact';
import { deriveLoanPaymentHistory } from '@/lib/loan-history';
import { Account } from '@/types/account';
import { Transaction } from '@/types/transaction';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
  }),
}));

vi.mock('@/hooks/useChartDateFormat', () => ({
  useChartDateFormat: () => (date: string) => date.slice(0, 7),
}));

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'loan-1',
    accountType: 'LOAN',
    name: 'Car Loan',
    currencyCode: 'CAD',
    openingBalance: -10000,
    currentBalance: -6000,
    interestRate: 6,
    paymentAmount: 500,
    paymentFrequency: 'MONTHLY',
    paymentStartDate: '2025-01-15',
    originalPrincipal: 10000,
    isCanadianMortgage: false,
    isVariableRate: false,
    ...overrides,
  } as Account;
}

function makeHistory(account: Account) {
  const transactions = [1000, 1000, 1000, 1000].map(
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

describe('PastImpactSection', () => {
  it('shows extra principal paid plus months and interest saved', () => {
    const account = makeAccount();
    const impact = computePastImpact(account, makeHistory(account));
    render(<PastImpactSection account={account} impact={impact} />);

    expect(screen.getByText('Impact of Overpayments Made')).toBeInTheDocument();
    expect(screen.getByText('Extra Principal Paid')).toBeInTheDocument();
    expect(
      screen.getByText('Total extra principal paid on top of your scheduled payments'),
    ).toBeInTheDocument();
    expect(screen.getByText('Time Already Saved')).toBeInTheDocument();
    expect(screen.getByText(/\d+ months?/)).toBeInTheDocument();
    expect(screen.getByText('Interest Already Saved')).toBeInTheDocument();
    expect(screen.getByText(/Originally .+, now .+/)).toBeInTheDocument();
  });

  it('still renders when only the opening balance is set (no originalPrincipal)', () => {
    const account = makeAccount({ originalPrincipal: null });
    const impact = computePastImpact(account, makeHistory(account));
    render(<PastImpactSection account={account} impact={impact} />);

    // Falls back to the opening balance; the section renders rather than hinting
    expect(screen.getByText('Extra Principal Paid')).toBeInTheDocument();
    expect(
      screen.queryByText(/needs an interest rate, a payment frequency/),
    ).not.toBeInTheDocument();
  });

  it('shows a data hint when the impact cannot be computed', () => {
    render(<PastImpactSection account={makeAccount()} impact={null} />);

    expect(
      screen.getByText(/needs an interest rate, a payment frequency/),
    ).toBeInTheDocument();
  });
});
