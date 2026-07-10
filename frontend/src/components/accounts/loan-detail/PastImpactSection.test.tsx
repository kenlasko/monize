import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { PastImpactSection } from './PastImpactSection';
import { deriveLoanPaymentHistory } from '@/lib/loan-history';
import { Account } from '@/types/account';
import { Transaction } from '@/types/transaction';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  AreaChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="area-chart">{children}</div>
  ),
  Area: ({ name }: { name?: string }) => <div data-testid="area">{name}</div>,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
    formatCurrencyCompact: (amount: number) => `$${amount.toFixed(0)}`,
    formatCurrencyAxis: (amount: number) => `$${amount}`,
  }),
}));

vi.mock('@/hooks/useChartDateFormat', () => ({
  useChartDateFormat: () => (date: string) => date.slice(0, 7),
}));

vi.mock('./OverpaymentCategoryControl', () => ({
  OverpaymentCategoryControl: () => <div data-testid="overpayment-category-control" />,
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
  it('shows extra principal paid plus months and interest saved and the series', () => {
    const account = makeAccount();
    render(
      <PastImpactSection
        account={account}
        history={makeHistory(account)}
        overpaymentCategoryId={null}
        onOverpaymentCategoryChange={() => {}}
      />,
    );

    expect(screen.getByText('Impact of Overpayments Made')).toBeInTheDocument();
    expect(screen.getByText('Extra Principal Paid')).toBeInTheDocument();
    expect(screen.getByText('How far ahead of the original schedule you are')).toBeInTheDocument();
    expect(screen.getByText('Time Already Saved')).toBeInTheDocument();
    expect(screen.getByText(/\d+ months?/)).toBeInTheDocument();
    expect(screen.getByText('Interest Already Saved')).toBeInTheDocument();
    expect(screen.getByText(/Originally .+, now .+/)).toBeInTheDocument();
    expect(screen.getByText('Original Schedule')).toBeInTheDocument();
    expect(screen.getByText('Actual Balance')).toBeInTheDocument();
    expect(screen.getByText('Current Projection')).toBeInTheDocument();
  });

  it('still renders when only the opening balance is set (no originalPrincipal)', () => {
    const account = makeAccount({ originalPrincipal: null });
    render(
      <PastImpactSection
        account={account}
        history={makeHistory(account)}
        overpaymentCategoryId={null}
        onOverpaymentCategoryChange={() => {}}
      />,
    );

    // Falls back to the opening balance; the section renders rather than hinting
    expect(screen.getByText('Extra Principal Paid')).toBeInTheDocument();
    expect(
      screen.queryByText(/needs an interest rate, a payment frequency/),
    ).not.toBeInTheDocument();
  });

  it('shows a data hint when the original schedule cannot be reconstructed', () => {
    const account = makeAccount({ interestRate: null });
    render(
      <PastImpactSection
        account={account}
        history={makeHistory(account)}
        overpaymentCategoryId={null}
        onOverpaymentCategoryChange={() => {}}
      />,
    );

    expect(
      screen.getByText(/needs an interest rate, a payment frequency/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('area-chart')).not.toBeInTheDocument();
  });
});
