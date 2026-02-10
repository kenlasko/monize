import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { InvestmentTransactionList } from './InvestmentTransactionList';

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    numberFormat: 'en-US',
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
  }),
}));

describe('InvestmentTransactionList', () => {
  it('renders loading state', () => {
    render(<InvestmentTransactionList transactions={[]} isLoading={true} />);
    expect(screen.getByText('Recent Transactions')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state', () => {
    render(<InvestmentTransactionList transactions={[]} isLoading={false} />);
    expect(screen.getByText('No investment transactions yet.')).toBeInTheDocument();
  });

  it('renders transactions table', () => {
    const transactions = [
      {
        id: 't1', action: 'BUY', transactionDate: '2024-01-15',
        security: { symbol: 'AAPL', name: 'Apple', currencyCode: 'CAD' },
        quantity: 10, price: 150, totalAmount: 1500,
      },
    ] as any[];

    render(<InvestmentTransactionList transactions={transactions} isLoading={false} />);
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('Buy')).toBeInTheDocument();
  });

  it('shows New Transaction button when callback provided', () => {
    const transactions = [
      { id: 't1', action: 'BUY', transactionDate: '2024-01-15', security: { symbol: 'X', name: 'X', currencyCode: 'CAD' }, quantity: 1, price: 1, totalAmount: 1 },
    ] as any[];

    render(<InvestmentTransactionList transactions={transactions} isLoading={false} onNewTransaction={vi.fn()} />);
    expect(screen.getByText('+ New Transaction')).toBeInTheDocument();
  });
});
