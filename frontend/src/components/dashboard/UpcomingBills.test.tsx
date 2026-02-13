import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { UpcomingBills } from './UpcomingBills';

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number, _c?: string) => `$${n.toFixed(2)}`,
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (n: number) => n,
  }),
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

describe('UpcomingBills', () => {
  it('renders loading state', () => {
    render(<UpcomingBills scheduledTransactions={[]} isLoading={true} />);
    expect(screen.getByText('Upcoming Bills & Deposits')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state', () => {
    render(<UpcomingBills scheduledTransactions={[]} isLoading={false} />);
    expect(screen.getByText('No bills, deposits, or transfers due in the next 7 days.')).toBeInTheDocument();
  });

  it('renders upcoming bills within 7 days', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

    const transactions = [
      {
        id: '1',
        name: 'Netflix',
        amount: -15.99,
        currencyCode: 'CAD',
        nextDueDate: dateStr,
        isActive: true,
        autoPost: false,
      },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} />);
    expect(screen.getByText('Netflix')).toBeInTheDocument();
    expect(screen.getByText('Tomorrow')).toBeInTheDocument();
    expect(screen.getByText('View all bills & deposits')).toBeInTheDocument();
  });

  it('shows total due amount', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

    const transactions = [
      { id: '1', name: 'Netflix', amount: -15.99, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      { id: '2', name: 'Spotify', amount: -9.99, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} />);
    expect(screen.getByText('Total due')).toBeInTheDocument();
  });
});
