import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@/test/render';
import { IncomeExpensesBarChart } from './IncomeExpensesBarChart';
import type { IncomeVsExpensesResponse } from '@/types/built-in-reports';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// The bars are the Income vs Expenses report's answer. Which rows count and
// which side of the line they fall on -- VOID, transfers, investment linkage,
// a category's isIncome, the sign fallback for an uncategorized amount -- is
// the report's to decide and is tested against a real database in
// `report-investment-cash.integration.spec.ts`. This suite covers what the
// widget does with the answer.
const mockGetIncomeVsExpenses = vi.fn();
vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getIncomeVsExpenses: (...args: any[]) => mockGetIncomeVsExpenses(...args),
  },
}));

const { widgetConfig, mockUpdateConfig } = vi.hoisted(() => ({
  widgetConfig: { current: { range: '1m', accountIds: [] as string[] } },
  mockUpdateConfig: vi.fn(),
}));
vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({
    config: widgetConfig.current,
    updateConfig: mockUpdateConfig,
  }),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children, data }: any) => (
    <div data-testid="bar-chart" data-names={(data ?? []).map((d: any) => d.name).join('|')}>
      {children}
    </div>
  ),
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
  useDateFormat: () => ({ dateFormat: 'browser', datePattern: 'YYYY-MM-DD', formatDate: (d: any) => typeof d === 'string' ? d : d.toISOString().slice(0, 10) }),
}));

vi.mock('@/hooks/useChartDateFormat', () => ({
  useChartDateFormat: () => (d: any) => typeof d === 'string' ? d : d.toISOString().slice(0, 7),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
    }),
  };
});

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: vi.fn((selector: any) => selector({ preferences: { weekStartsOn: 1 } })),
}));

const period = (
  periodStart: string,
  periodEnd: string,
  income: number,
  expenses: number,
  key?: string,
) => ({
  period: key ?? periodStart,
  periodStart,
  periodEnd,
  income,
  expenses,
  net: income - expenses,
});

/** A report answer with nothing left out, so every total is a total. */
const report = (
  data: IncomeVsExpensesResponse['data'],
  over: Partial<IncomeVsExpensesResponse> = {},
): IncomeVsExpensesResponse => {
  const knownIncome = data.reduce((sum, d) => sum + d.income, 0);
  const knownExpenses = data.reduce((sum, d) => sum + d.expenses, 0);
  const knownNet = knownIncome - knownExpenses;
  return {
    data,
    totals: {
      income: knownIncome,
      expenses: knownExpenses,
      net: knownNet,
      knownIncome,
      knownExpenses,
      knownNet,
    },
    currency: 'CAD',
    missingCurrencies: [],
    excludedCount: 0,
    ...over,
  };
};

async function renderChart(
  response: IncomeVsExpensesResponse,
  isLoading = false,
) {
  mockGetIncomeVsExpenses.mockResolvedValue(response);
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<IncomeExpensesBarChart accounts={[]} isLoading={isLoading} />);
  });
  return result!;
}

describe('IncomeExpensesBarChart', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockGetIncomeVsExpenses.mockReset();
    mockUpdateConfig.mockClear();
    widgetConfig.current = { range: '1m', accountIds: [] };
  });

  it('renders loading state with title and pulse animation', async () => {
    await renderChart(report([]), true);
    expect(screen.getByText('Income vs Expenses')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
    expect(screen.queryByTestId('bar-chart')).not.toBeInTheDocument();
  });

  it('says the report failed to load instead of showing zero totals', async () => {
    mockGetIncomeVsExpenses.mockRejectedValue(new Error('500'));
    await act(async () => {
      render(<IncomeExpensesBarChart accounts={[]} isLoading={false} />);
    });
    expect(screen.getByText(/Couldn't load your income and expenses/)).toBeInTheDocument();
    expect(screen.queryByText('Net')).not.toBeInTheDocument();
  });

  it('renders chart title and timeframe label when not loading', async () => {
    await renderChart(report([]));
    await waitFor(() => expect(screen.getByTestId('bar-chart')).toBeInTheDocument());
    expect(screen.getByText('Income vs Expenses')).toBeInTheDocument();
    expect(screen.getByText('1M')).toBeInTheDocument();
  });

  it('shows the report totals in the footer', async () => {
    await renderChart(
      report([period('2026-02-16', '2026-02-22', 1000, 400)]),
    );
    await waitFor(() => expect(screen.getByTestId('bar-chart')).toBeInTheDocument());

    expect(screen.getByText('Income')).toBeInTheDocument();
    expect(screen.getByText('$1000')).toBeInTheDocument();
    expect(screen.getByText('$400')).toBeInTheDocument();
    // Net is the server's own subtraction, not two rounded bars re-subtracted.
    expect(screen.getByText('$600')).toBeInTheDocument();
  });

  // --- what the widget asks the report for -------------------------------

  it('asks for weekly buckets on the recent-weeks range, with the user week start', async () => {
    await renderChart(report([]));
    expect(mockGetIncomeVsExpenses).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'week', weekStartsOn: 1 }),
    );
  });

  it('asks for monthly buckets on a longer range', async () => {
    widgetConfig.current = { range: '1y', accountIds: [] };
    await renderChart(report([]));
    expect(mockGetIncomeVsExpenses).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'month' }),
    );
  });

  it('passes the configured accounts, and none for an empty selection', async () => {
    widgetConfig.current = { range: '1m', accountIds: ['acct-1'] };
    await renderChart(report([]));
    expect(mockGetIncomeVsExpenses).toHaveBeenCalledWith(
      expect.objectContaining({ accountIds: ['acct-1'] }),
    );

    mockGetIncomeVsExpenses.mockClear();
    widgetConfig.current = { range: '1m', accountIds: [] };
    await renderChart(report([]));
    expect(mockGetIncomeVsExpenses).toHaveBeenCalledWith(
      expect.objectContaining({ accountIds: undefined }),
    );
  });

  // --- how it labels and draws what came back ----------------------------

  it('names a weekly bar by the day it opens and a monthly bar by its month', async () => {
    const { unmount } = await renderChart(
      report([period('2026-02-16', '2026-02-22', 10, 5)]),
    );
    expect(screen.getByTestId('bar-chart')).toHaveAttribute(
      'data-names',
      '2026-02-16',
    );
    unmount();

    widgetConfig.current = { range: '1y', accountIds: [] };
    await renderChart(
      report([period('2026-02-01', '2026-02-28', 10, 5, '2026-02')]),
    );
    expect(screen.getByTestId('bar-chart')).toHaveAttribute(
      'data-names',
      '2026-02',
    );
  });

  it('draws the empty buckets the report returned rather than closing the gap', async () => {
    // A week nothing happened in earned and spent zero: a bar of height zero.
    await renderChart(
      report([
        period('2026-02-02', '2026-02-08', 500, 100),
        period('2026-02-09', '2026-02-15', 0, 0),
        period('2026-02-16', '2026-02-22', 300, 50),
      ]),
    );
    expect(screen.getByTestId('bar-chart')).toHaveAttribute(
      'data-names',
      '2026-02-02|2026-02-09|2026-02-16',
    );
  });

  // --- partial totals ----------------------------------------------------

  it('marks the totals as subtotals when the report excluded a row', async () => {
    await renderChart(
      report([period('2026-02-16', '2026-02-22', 1000, 400)], {
        totals: {
          income: null,
          expenses: null,
          net: null,
          knownIncome: 1000,
          knownExpenses: 400,
          knownNet: 600,
        },
        missingCurrencies: ['JPY'],
        excludedCount: 1,
      }),
    );

    expect(screen.getByText('$1000')).toBeInTheDocument();
    // Income, expenses and net each carry the marker.
    expect(screen.getAllByTestId('partial-total')).toHaveLength(3);
  });

  it('leaves complete totals unmarked', async () => {
    await renderChart(
      report([period('2026-02-16', '2026-02-22', 1000, 400)]),
    );
    expect(screen.queryByTestId('partial-total')).toBeNull();
  });

  // --- drill-down --------------------------------------------------------

  it('navigates to transactions page with income filter on Income bar click', async () => {
    await renderChart(report([]));
    await waitFor(() => expect(screen.getByTestId('bar-Income')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('bar-Income'));
    expect(mockPush).toHaveBeenCalledWith('/transactions?startDate=2026-02-17&endDate=2026-02-23&categoryType=income');
  });

  it('navigates to transactions page with expense filter on Expenses bar click', async () => {
    await renderChart(report([]));
    await waitFor(() => expect(screen.getByTestId('bar-Expenses')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('bar-Expenses'));
    expect(mockPush).toHaveBeenCalledWith('/transactions?startDate=2026-02-17&endDate=2026-02-23&categoryType=expense');
  });
});
