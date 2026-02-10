import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { ExpensesPieChart } from './ExpensesPieChart';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  PieChart: ({ children }: any) => <div data-testid="pie-chart">{children}</div>,
  Pie: () => null,
  Cell: () => null,
  Tooltip: () => null,
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(2)}`,
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (n: number) => n,
  }),
}));

vi.mock('@/lib/chart-colours', () => ({
  CHART_COLOURS: ['#3b82f6', '#ef4444', '#22c55e'],
}));

describe('ExpensesPieChart', () => {
  it('renders loading state', () => {
    render(<ExpensesPieChart transactions={[]} categories={[]} isLoading={true} />);
    expect(screen.getByText('Expenses by Category')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state when no expenses', () => {
    render(<ExpensesPieChart transactions={[]} categories={[]} isLoading={false} />);
    expect(screen.getByText('No expense data for this period.')).toBeInTheDocument();
  });

  it('renders chart with expense data', () => {
    const transactions = [
      {
        id: '1',
        amount: -50,
        categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        currencyCode: 'CAD',
        isTransfer: false,
        isSplit: false,
        transactionDate: '2024-01-15',
      },
    ] as any[];
    const categories = [
      { id: 'cat1', name: 'Food', color: '#ef4444' },
    ] as any[];

    render(<ExpensesPieChart transactions={transactions} categories={categories} isLoading={false} />);
    expect(screen.getByText('Expenses by Category')).toBeInTheDocument();
    expect(screen.getByText('Food')).toBeInTheDocument();
    expect(screen.getByTestId('pie-chart')).toBeInTheDocument();
  });

  it('shows total expenses', () => {
    const transactions = [
      {
        id: '1',
        amount: -100,
        categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        currencyCode: 'CAD',
        isTransfer: false,
        isSplit: false,
        transactionDate: '2024-01-15',
      },
    ] as any[];
    const categories = [
      { id: 'cat1', name: 'Food', color: '#ef4444' },
    ] as any[];

    render(<ExpensesPieChart transactions={transactions} categories={categories} isLoading={false} />);
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
  });
});
