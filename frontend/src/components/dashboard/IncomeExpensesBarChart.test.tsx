import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@/test/render';
import { IncomeExpensesBarChart } from './IncomeExpensesBarChart';

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

const mockUpdateConfig = vi.fn();
vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({
    config: { range: '1m', accountIds: [] },
    updateConfig: mockUpdateConfig,
  }),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: ({ dataKey, onClick }: any) => (
    <button data-testid={`bar-${dataKey}`} onClick={() => onClick?.({ payload: { startDate: '2026-02-17', endDate: '2026-02-23' } })} />
  ),
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: any) => typeof d === 'string' ? d : d.toISOString().slice(0, 10) }),
}));

vi.mock('@/hooks/useChartDateFormat', () => ({
  useChartDateFormat: () => (d: any) => typeof d === 'string' ? d : d.toISOString().slice(0, 7),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (n: number) => n,
  }),
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: vi.fn((selector: any) => selector({ preferences: { weekStartsOn: 1 } })),
}));

const todayStr = () => {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
};

async function renderChart(transactions: any[], isLoading = false) {
  mockGetAllPages.mockResolvedValue(transactions);
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<IncomeExpensesBarChart accounts={[]} isLoading={isLoading} />);
  });
  return result!;
}

describe('IncomeExpensesBarChart', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockGetAllPages.mockReset();
  });

  it('renders loading state with title and pulse animation', async () => {
    await renderChart([], true);
    expect(screen.getByText('Income vs Expenses')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
    expect(screen.queryByTestId('bar-chart')).not.toBeInTheDocument();
  });

  it('renders chart title and timeframe label when not loading', async () => {
    await renderChart([]);
    await waitFor(() => expect(screen.getByTestId('bar-chart')).toBeInTheDocument());
    expect(screen.getByText('Income vs Expenses')).toBeInTheDocument();
    expect(screen.getByText('1M')).toBeInTheDocument();
  });

  it('shows income, expenses, and net totals in footer', async () => {
    await renderChart([]);
    await waitFor(() => expect(screen.getByTestId('bar-chart')).toBeInTheDocument());
    expect(screen.getByText('Income')).toBeInTheDocument();
    expect(screen.getByText('Expenses')).toBeInTheDocument();
    expect(screen.getByText('Net')).toBeInTheDocument();
  });

  it('calculates income and expenses from transactions', async () => {
    const dateStr = todayStr();
    const transactions = [
      { id: '1', amount: 500, currencyCode: 'CAD', isTransfer: false, transactionDate: dateStr },
      { id: '2', amount: -200, currencyCode: 'CAD', isTransfer: false, transactionDate: dateStr },
    ];
    await renderChart(transactions);
    await waitFor(() => expect(screen.getByText('$500')).toBeInTheDocument());
    expect(screen.getByText('$200')).toBeInTheDocument();
    expect(screen.getByText('$300')).toBeInTheDocument();
  });

  it('skips transfer transactions', async () => {
    const transactions = [
      { id: '1', amount: -100, currencyCode: 'CAD', isTransfer: true, transactionDate: todayStr() },
    ];
    await renderChart(transactions);
    await waitFor(() => expect(screen.getByTestId('bar-chart')).toBeInTheDocument());
    expect(screen.getAllByText('$0').length).toBe(3);
  });

  it('skips investment account transactions', async () => {
    const dateStr = todayStr();
    const transactions = [
      { id: '1', amount: -500, currencyCode: 'CAD', isTransfer: false, transactionDate: dateStr, account: { accountType: 'INVESTMENT' } },
      { id: '2', amount: 1000, currencyCode: 'CAD', isTransfer: false, transactionDate: dateStr, account: { accountType: 'INVESTMENT' } },
    ];
    await renderChart(transactions);
    await waitFor(() => expect(screen.getByTestId('bar-chart')).toBeInTheDocument());
    expect(screen.getAllByText('$0').length).toBe(3);
  });

  it('includes non-investment account transactions', async () => {
    const dateStr = todayStr();
    const transactions = [
      { id: '1', amount: -300, currencyCode: 'CAD', isTransfer: false, transactionDate: dateStr, account: { accountType: 'CHECKING' } },
      { id: '2', amount: -200, currencyCode: 'CAD', isTransfer: false, transactionDate: dateStr, account: { accountType: 'INVESTMENT' } },
    ];
    await renderChart(transactions);
    await waitFor(() => expect(screen.getByText('$300')).toBeInTheDocument());
  });

  it('applies green color class for positive net', async () => {
    const transactions = [
      { id: '1', amount: 1000, currencyCode: 'CAD', isTransfer: false, transactionDate: todayStr() },
    ];
    await renderChart(transactions);
    await waitFor(() => expect(screen.getAllByText('$1000').length).toBe(2));
    screen.getAllByText('$1000').forEach((el) => {
      expect(el.className).toContain('text-green');
    });
  });

  it('classifies by category isIncome instead of amount sign', async () => {
    const dateStr = todayStr();
    const transactions = [
      { id: '1', amount: 5000, currencyCode: 'CAD', isTransfer: false, transactionDate: dateStr, category: { isIncome: true } },
      { id: '2', amount: -500, currencyCode: 'CAD', isTransfer: false, transactionDate: dateStr, category: { isIncome: false } },
    ];
    await renderChart(transactions);
    await waitFor(() => expect(screen.getByText('$5000')).toBeInTheDocument());
    expect(screen.getByText('$500')).toBeInTheDocument();
    expect(screen.getByText('$4500')).toBeInTheDocument();
  });

  it('counts expense refunds as reducing expenses', async () => {
    const dateStr = todayStr();
    const transactions = [
      { id: '1', amount: -500, currencyCode: 'CAD', isTransfer: false, transactionDate: dateStr, category: { isIncome: false } },
      { id: '2', amount: 400, currencyCode: 'CAD', isTransfer: false, transactionDate: dateStr, category: { isIncome: false } },
    ];
    await renderChart(transactions);
    await waitFor(() => expect(screen.getByText('$100')).toBeInTheDocument());
  });

  it('classifies split transactions by split category', async () => {
    const transactions = [
      {
        id: '1', amount: 1000, currencyCode: 'CAD', isTransfer: false, transactionDate: todayStr(), category: null,
        splits: [
          { id: 's1', amount: 700, category: { isIncome: true }, transferAccountId: null },
          { id: 's2', amount: 300, category: { isIncome: false }, transferAccountId: null },
        ],
      },
    ];
    await renderChart(transactions);
    await waitFor(() => expect(screen.getByText('$700')).toBeInTheDocument());
  });

  it('skips transfer splits in split transactions', async () => {
    const transactions = [
      {
        id: '1', amount: 1000, currencyCode: 'CAD', isTransfer: false, transactionDate: todayStr(), category: null,
        splits: [
          { id: 's1', amount: 600, category: { isIncome: true }, transferAccountId: null },
          { id: 's2', amount: 400, category: { isIncome: true }, transferAccountId: 'acc-123' },
        ],
      },
    ];
    await renderChart(transactions);
    await waitFor(() => expect(screen.getAllByText('$600').length).toBe(2));
    expect(screen.getByText('$0')).toBeInTheDocument();
  });

  it('falls back to sign-based for uncategorized transactions', async () => {
    const dateStr = todayStr();
    const transactions = [
      { id: '1', amount: 300, currencyCode: 'CAD', isTransfer: false, transactionDate: dateStr, category: null },
      { id: '2', amount: -100, currencyCode: 'CAD', isTransfer: false, transactionDate: dateStr, category: null },
    ];
    await renderChart(transactions);
    await waitFor(() => expect(screen.getByText('$300')).toBeInTheDocument());
    expect(screen.getByText('$100')).toBeInTheDocument();
    expect(screen.getByText('$200')).toBeInTheDocument();
  });

  it('navigates to transactions page with income filter on Income bar click', async () => {
    await renderChart([]);
    await waitFor(() => expect(screen.getByTestId('bar-Income')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('bar-Income'));
    expect(mockPush).toHaveBeenCalledWith('/transactions?startDate=2026-02-17&endDate=2026-02-23&categoryType=income');
  });

  it('navigates to transactions page with expense filter on Expenses bar click', async () => {
    await renderChart([]);
    await waitFor(() => expect(screen.getByTestId('bar-Expenses')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('bar-Expenses'));
    expect(mockPush).toHaveBeenCalledWith('/transactions?startDate=2026-02-17&endDate=2026-02-23&categoryType=expense');
  });
});
