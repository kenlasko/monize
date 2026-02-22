import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { ExpensesPieChart } from './ExpensesPieChart';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  PieChart: ({ children }: any) => <div data-testid="pie-chart">{children}</div>,
  Pie: ({ data, onClick }: any) => (
    <div data-testid="pie" style={{ display: 'none' }}>
      {data?.map((d: any, i: number) => (
        <button key={i} data-testid={`pie-slice-${d.name}`} onClick={() => onClick?.(d)} />
      ))}
    </div>
  ),
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
  CHART_COLOURS: ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6'],
}));

describe('ExpensesPieChart', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('renders loading state with title and pulse animation', () => {
    render(<ExpensesPieChart transactions={[]} categories={[]} isLoading={true} />);
    expect(screen.getByText('Expenses by Category')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
    expect(screen.queryByTestId('pie-chart')).not.toBeInTheDocument();
  });

  it('renders empty state when no expenses', () => {
    render(<ExpensesPieChart transactions={[]} categories={[]} isLoading={false} />);
    expect(screen.getByText('Expenses by Category')).toBeInTheDocument();
    expect(screen.getByText('No expense data for this period.')).toBeInTheDocument();
    expect(screen.queryByTestId('pie-chart')).not.toBeInTheDocument();
  });

  it('renders chart with expense data and category legend', () => {
    const transactions = [
      {
        id: '1', amount: -50, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
      {
        id: '2', amount: -30, categoryId: 'cat2',
        category: { id: 'cat2', name: 'Transport', color: '#3b82f6' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-16',
      },
    ] as any[];
    const categories = [
      { id: 'cat1', name: 'Food', color: '#ef4444' },
      { id: 'cat2', name: 'Transport', color: '#3b82f6' },
    ] as any[];

    render(<ExpensesPieChart transactions={transactions} categories={categories} isLoading={false} />);
    expect(screen.getByText('Expenses by Category')).toBeInTheDocument();
    expect(screen.getByText('Past 30 days')).toBeInTheDocument();
    expect(screen.getByTestId('pie-chart')).toBeInTheDocument();
    // Category names appear in the legend grid
    const legendButtons = screen.getAllByRole('button');
    const foodLegend = legendButtons.find(b => b.textContent?.includes('Food'));
    const transportLegend = legendButtons.find(b => b.textContent?.includes('Transport'));
    expect(foodLegend).toBeTruthy();
    expect(transportLegend).toBeTruthy();
  });

  it('shows total expenses amount', () => {
    const transactions = [
      {
        id: '1', amount: -100, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
    ] as any[];
    const categories = [{ id: 'cat1', name: 'Food', color: '#ef4444' }] as any[];

    render(<ExpensesPieChart transactions={transactions} categories={categories} isLoading={false} />);
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
  });

  it('skips transfer transactions', () => {
    const transactions = [
      {
        id: '1', amount: -50, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        currencyCode: 'CAD', isTransfer: true, isSplit: false, transactionDate: '2024-01-15',
      },
    ] as any[];
    const categories = [{ id: 'cat1', name: 'Food', color: '#ef4444' }] as any[];

    render(<ExpensesPieChart transactions={transactions} categories={categories} isLoading={false} />);
    expect(screen.getByText('No expense data for this period.')).toBeInTheDocument();
  });

  it('skips positive amounts (income)', () => {
    const transactions = [
      {
        id: '1', amount: 100, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Salary', color: '#22c55e' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
    ] as any[];
    const categories = [{ id: 'cat1', name: 'Salary', color: '#22c55e' }] as any[];

    render(<ExpensesPieChart transactions={transactions} categories={categories} isLoading={false} />);
    expect(screen.getByText('No expense data for this period.')).toBeInTheDocument();
  });

  it('skips investment account transactions', () => {
    const transactions = [
      {
        id: '1', amount: -50, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        account: { accountType: 'INVESTMENT' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
    ] as any[];
    const categories = [{ id: 'cat1', name: 'Food', color: '#ef4444' }] as any[];

    render(<ExpensesPieChart transactions={transactions} categories={categories} isLoading={false} />);
    expect(screen.getByText('No expense data for this period.')).toBeInTheDocument();
  });

  it('groups uncategorized expenses', () => {
    const transactions = [
      {
        id: '1', amount: -75, categoryId: null, category: null,
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
    ] as any[];

    render(<ExpensesPieChart transactions={transactions} categories={[]} isLoading={false} />);
    const legendButtons = screen.getAllByRole('button');
    expect(legendButtons.some(b => b.textContent?.includes('Uncategorized'))).toBe(true);
  });

  it('handles split transactions', () => {
    const transactions = [
      {
        id: '1', amount: -100, categoryId: null, category: null,
        currencyCode: 'CAD', isTransfer: false, isSplit: true,
        splits: [
          { amount: -60, categoryId: 'cat1', category: { id: 'cat1', name: 'Food', color: '#ef4444' } },
          { amount: -40, categoryId: 'cat2', category: { id: 'cat2', name: 'Drinks', color: '#3b82f6' } },
        ],
        transactionDate: '2024-01-15',
      },
    ] as any[];
    const categories = [
      { id: 'cat1', name: 'Food', color: '#ef4444' },
      { id: 'cat2', name: 'Drinks', color: '#3b82f6' },
    ] as any[];

    render(<ExpensesPieChart transactions={transactions} categories={categories} isLoading={false} />);
    const legendButtons = screen.getAllByRole('button');
    expect(legendButtons.some(b => b.textContent?.includes('Food'))).toBe(true);
    expect(legendButtons.some(b => b.textContent?.includes('Drinks'))).toBe(true);
  });

  it('navigates to category transactions on pie click', () => {
    const transactions = [
      {
        id: '1', amount: -50, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
    ] as any[];
    const categories = [{ id: 'cat1', name: 'Food', color: '#ef4444' }] as any[];

    render(<ExpensesPieChart transactions={transactions} categories={categories} isLoading={false} />);
    fireEvent.click(screen.getByTestId('pie-slice-Food'));
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('/transactions?categoryIds=cat1&startDate='));
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('&endDate='));
  });

  it('navigates on legend button click', () => {
    const transactions = [
      {
        id: '1', amount: -50, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
    ] as any[];
    const categories = [{ id: 'cat1', name: 'Food', color: '#ef4444' }] as any[];

    render(<ExpensesPieChart transactions={transactions} categories={categories} isLoading={false} />);
    // The legend buttons in the grid below the chart
    const legendButtons = screen.getAllByRole('button');
    const foodButton = legendButtons.find(b => b.textContent?.includes('Food'));
    if (foodButton) fireEvent.click(foodButton);
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('/transactions?categoryIds=cat1&startDate='));
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('&endDate='));
  });

  it('aggregates multiple transactions in the same category', () => {
    const transactions = [
      {
        id: '1', amount: -50, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
      {
        id: '2', amount: -25, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-16',
      },
    ] as any[];
    const categories = [{ id: 'cat1', name: 'Food', color: '#ef4444' }] as any[];

    render(<ExpensesPieChart transactions={transactions} categories={categories} isLoading={false} />);
    expect(screen.getByText('$75.00')).toBeInTheDocument();
  });

  it('assigns chart colours to categories without a colour', () => {
    const transactions = [
      {
        id: '1', amount: -50, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: null },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
    ] as any[];
    const categories = [{ id: 'cat1', name: 'Food', color: null }] as any[];

    render(<ExpensesPieChart transactions={transactions} categories={categories} isLoading={false} />);
    // Should still render the chart without errors
    expect(screen.getByTestId('pie-chart')).toBeInTheDocument();
    const legendButtons = screen.getAllByRole('button');
    expect(legendButtons.some(b => b.textContent?.includes('Food'))).toBe(true);
  });

  it('handles split transaction with uncategorized split (no transferAccountId)', () => {
    const transactions = [
      {
        id: '1', amount: -100, categoryId: null, category: null,
        currencyCode: 'CAD', isTransfer: false, isSplit: true,
        splits: [
          { amount: -60, categoryId: 'cat1', category: { id: 'cat1', name: 'Food', color: '#ef4444' } },
          { amount: -40, categoryId: null, category: null, transferAccountId: undefined },
        ],
        transactionDate: '2024-01-15',
      },
    ] as any[];
    const categories = [{ id: 'cat1', name: 'Food', color: '#ef4444' }] as any[];

    render(<ExpensesPieChart transactions={transactions} categories={categories} isLoading={false} />);
    const legendButtons = screen.getAllByRole('button');
    expect(legendButtons.some(b => b.textContent?.includes('Food'))).toBe(true);
    expect(legendButtons.some(b => b.textContent?.includes('Uncategorized'))).toBe(true);
  });
});
