import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@/test/render';
import { ExpensesPieChart } from './ExpensesPieChart';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockGetAllPages = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAllPages: (...args: any[]) => mockGetAllPages(...args),
  },
}));

// Fixed config so the widget renders deterministically; WidgetCard reads the
// same hook for its identity overrides (none here).
const mockUpdateConfig = vi.fn();
vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({
    config: { range: '1m', accountIds: [] },
    updateConfig: mockUpdateConfig,
  }),
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

async function renderChart(transactions: any[], categories: any[] = [], isLoading = false) {
  mockGetAllPages.mockResolvedValue(transactions);
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <ExpensesPieChart accounts={[]} categories={categories} isLoading={isLoading} />,
    );
  });
  return result!;
}

describe('ExpensesPieChart', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockGetAllPages.mockReset();
  });

  it('renders loading state with title and pulse animation', async () => {
    await renderChart([], [], true);
    expect(screen.getByText('Expenses by Category')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
    expect(screen.queryByTestId('pie-chart')).not.toBeInTheDocument();
  });

  it('renders the selected timeframe label', async () => {
    await renderChart([]);
    expect(screen.getByText('1M')).toBeInTheDocument();
  });

  it('renders empty state when no expenses', async () => {
    await renderChart([]);
    await waitFor(() => {
      expect(screen.getByText('No expense data for this period.')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('pie-chart')).not.toBeInTheDocument();
  });

  it('renders chart with expense data and category legend', async () => {
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
    ];
    const categories = [
      { id: 'cat1', name: 'Food', color: '#ef4444' },
      { id: 'cat2', name: 'Transport', color: '#3b82f6' },
    ];

    await renderChart(transactions, categories);
    await waitFor(() => expect(screen.getByTestId('pie-chart')).toBeInTheDocument());
    const legendButtons = screen.getAllByRole('button');
    expect(legendButtons.some((b) => b.textContent?.includes('Food'))).toBe(true);
    expect(legendButtons.some((b) => b.textContent?.includes('Transport'))).toBe(true);
  });

  it('shows total expenses amount', async () => {
    const transactions = [
      {
        id: '1', amount: -100, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
    ];
    await renderChart(transactions, [{ id: 'cat1', name: 'Food', color: '#ef4444' }]);
    await waitFor(() => expect(screen.getByText('Total')).toBeInTheDocument());
    expect(screen.getByText('$100.00')).toBeInTheDocument();
  });

  it('skips transfer transactions', async () => {
    const transactions = [
      {
        id: '1', amount: -50, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        currencyCode: 'CAD', isTransfer: true, isSplit: false, transactionDate: '2024-01-15',
      },
    ];
    await renderChart(transactions, [{ id: 'cat1', name: 'Food', color: '#ef4444' }]);
    await waitFor(() => expect(screen.getByText('No expense data for this period.')).toBeInTheDocument());
  });

  it('skips positive amounts (income)', async () => {
    const transactions = [
      {
        id: '1', amount: 100, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Salary', color: '#22c55e' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
    ];
    await renderChart(transactions, [{ id: 'cat1', name: 'Salary', color: '#22c55e' }]);
    await waitFor(() => expect(screen.getByText('No expense data for this period.')).toBeInTheDocument());
  });

  it('skips investment account transactions', async () => {
    const transactions = [
      {
        id: '1', amount: -50, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        account: { accountType: 'INVESTMENT' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
    ];
    await renderChart(transactions, [{ id: 'cat1', name: 'Food', color: '#ef4444' }]);
    await waitFor(() => expect(screen.getByText('No expense data for this period.')).toBeInTheDocument());
  });

  it('groups uncategorized expenses', async () => {
    const transactions = [
      {
        id: '1', amount: -75, categoryId: null, category: null,
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
    ];
    await renderChart(transactions);
    await waitFor(() => {
      const legendButtons = screen.getAllByRole('button');
      expect(legendButtons.some((b) => b.textContent?.includes('Uncategorized'))).toBe(true);
    });
  });

  it('handles split transactions', async () => {
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
    ];
    const categories = [
      { id: 'cat1', name: 'Food', color: '#ef4444' },
      { id: 'cat2', name: 'Drinks', color: '#3b82f6' },
    ];
    await renderChart(transactions, categories);
    await waitFor(() => {
      const legendButtons = screen.getAllByRole('button');
      expect(legendButtons.some((b) => b.textContent?.includes('Food'))).toBe(true);
      expect(legendButtons.some((b) => b.textContent?.includes('Drinks'))).toBe(true);
    });
  });

  it('navigates to category transactions on pie click', async () => {
    const transactions = [
      {
        id: '1', amount: -50, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: '#ef4444' },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
    ];
    await renderChart(transactions, [{ id: 'cat1', name: 'Food', color: '#ef4444' }]);
    await waitFor(() => expect(screen.getByTestId('pie-slice-Food')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('pie-slice-Food'));
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('/transactions?categoryIds=cat1&startDate='));
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('endDate='));
  });

  it('aggregates multiple transactions in the same category', async () => {
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
    ];
    await renderChart(transactions, [{ id: 'cat1', name: 'Food', color: '#ef4444' }]);
    await waitFor(() => expect(screen.getByText('$75.00')).toBeInTheDocument());
  });

  it('assigns chart colours to categories without a colour', async () => {
    const transactions = [
      {
        id: '1', amount: -50, categoryId: 'cat1',
        category: { id: 'cat1', name: 'Food', color: null },
        currencyCode: 'CAD', isTransfer: false, isSplit: false, transactionDate: '2024-01-15',
      },
    ];
    await renderChart(transactions, [{ id: 'cat1', name: 'Food', color: null }]);
    await waitFor(() => expect(screen.getByTestId('pie-chart')).toBeInTheDocument());
    const legendButtons = screen.getAllByRole('button');
    expect(legendButtons.some((b) => b.textContent?.includes('Food'))).toBe(true);
  });

  it('handles split transaction with uncategorized split (no transferAccountId)', async () => {
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
    ];
    await renderChart(transactions, [{ id: 'cat1', name: 'Food', color: '#ef4444' }]);
    await waitFor(() => {
      const legendButtons = screen.getAllByRole('button');
      expect(legendButtons.some((b) => b.textContent?.includes('Food'))).toBe(true);
      expect(legendButtons.some((b) => b.textContent?.includes('Uncategorized'))).toBe(true);
    });
  });
});
