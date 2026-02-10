import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { ScheduledTransactionList } from './ScheduledTransactionList';

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number, _c?: string) => `$${n.toFixed(2)}`,
  }),
}));

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    post: vi.fn().mockResolvedValue({}),
    skip: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

describe('ScheduledTransactionList', () => {
  it('renders empty state', () => {
    render(<ScheduledTransactionList transactions={[]} />);
    expect(screen.getByText('No scheduled transactions')).toBeInTheDocument();
  });

  it('renders transactions table', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().split('T')[0];

    const transactions = [
      {
        id: 's1', name: 'Netflix', amount: -15.99, currencyCode: 'CAD',
        frequency: 'MONTHLY', nextDueDate: dateStr, isActive: true,
        autoPost: false, isTransfer: false, isSplit: false,
        account: { name: 'Checking' },
      },
    ] as any[];

    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByText('Netflix')).toBeInTheDocument();
  });

  it('shows inactive transactions with reduced opacity', () => {
    const transactions = [
      {
        id: 's1', name: 'Cancelled Sub', amount: -10, currencyCode: 'CAD',
        frequency: 'MONTHLY', nextDueDate: '2025-01-01', isActive: false,
        autoPost: false, isTransfer: false, isSplit: false,
        account: { name: 'Checking' },
      },
    ] as any[];

    const { container } = render(<ScheduledTransactionList transactions={transactions} />);
    expect(container.querySelector('.opacity-50')).toBeInTheDocument();
  });

  it('renders table headers', () => {
    const transactions = [
      { id: 's1', name: 'Test', amount: -10, currencyCode: 'CAD', frequency: 'MONTHLY', nextDueDate: '2025-01-01', isActive: true, autoPost: false, isTransfer: false, isSplit: false, account: { name: 'X' } },
    ] as any[];

    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByText('Name / Payee')).toBeInTheDocument();
    expect(screen.getByText('Amount')).toBeInTheDocument();
  });
});
