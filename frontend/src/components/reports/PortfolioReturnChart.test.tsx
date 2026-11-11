import { createRef } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@/test/render';
import { PortfolioReturnChart } from './PortfolioReturnChart';
import type { SecurityComparisonChartHandle } from './SecurityComparisonChart';
import type { UseTwrSeriesValue } from '@/hooks/useTwrSeries';
import type {
  AccountTwrSeries,
  PortfolioTwrSeries,
  PortfolioTwrSeriesByAccount,
} from '@/types/net-worth';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="line-chart">{children}</div>
  ),
  Line: ({
    name,
    strokeWidth,
    connectNulls,
  }: {
    name?: string;
    strokeWidth?: number;
    connectNulls?: boolean;
  }) => (
    <div
      data-testid="line"
      data-name={name}
      data-width={strokeWidth}
      data-connect-nulls={String(connectNulls)}
    />
  ),
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => <div data-testid="legend" />,
  ReferenceLine: () => <div data-testid="zero-line" />,
}));

const mockUseTwrSeries = vi.fn<(options: Record<string, unknown>) => UseTwrSeriesValue>();
vi.mock('@/hooks/useTwrSeries', () => ({
  useTwrSeries: (options: Record<string, unknown>) => mockUseTwrSeries(options),
}));

const mockExportToPdf = vi.fn();
vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: (...args: unknown[]) => mockExportToPdf(...args),
}));

vi.mock('@/hooks/useChartDateFormat', () => ({
  useChartDateFormat: () => (d: Date) => d.toISOString().slice(0, 10),
}));
vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatSignedPercent: (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`,
    }),
  };
});
vi.mock('@/lib/utils', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

const RANGES = { prices: [], rates: [], cash: [] } as unknown as PortfolioTwrSeries['incompleteRanges'];

const portfolioSeries = (overrides: Partial<PortfolioTwrSeries> = {}): PortfolioTwrSeries => ({
  currency: 'CAD',
  startDate: '2026-09-15',
  endDate: '2026-09-17',
  points: [
    { date: '2026-09-15', returnPercent: 0 },
    { date: '2026-09-16', returnPercent: 4 },
  ],
  complete: true,
  reasons: [],
  incompleteRanges: RANGES,
  ...overrides,
});

const accountSeries = (accountId: string, overrides: Partial<AccountTwrSeries> = {}): AccountTwrSeries => ({
  accountId,
  points: [
    { date: '2026-09-15', returnPercent: 0 },
    { date: '2026-09-16', returnPercent: 2 },
  ],
  complete: true,
  reasons: [],
  incompleteRanges: RANGES,
  ...overrides,
});

const byAccount = (accounts: AccountTwrSeries[]): PortfolioTwrSeriesByAccount => ({
  currency: 'CAD',
  startDate: '2026-09-15',
  endDate: '2026-09-16',
  accounts,
});

const NAMES: Record<string, string> = { a1: 'Brokerage A', a2: 'Brokerage B' };

function renderChart(props: Partial<React.ComponentProps<typeof PortfolioReturnChart>> = {}) {
  return render(
    <PortfolioReturnChart
      groupBy="portfolio"
      range="1y"
      startDate="2026-09-14"
      periodStartDate="2026-09-15"
      endDate="2026-09-17"
      accountIdList={['a1', 'a2']}
      accountName={(id) => NAMES[id] ?? id}
      {...props}
    />,
  );
}

describe('PortfolioReturnChart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseTwrSeries.mockReturnValue({
      status: 'ready',
      groupBy: 'portfolio',
      series: portfolioSeries(),
    });
  });

  it('draws the portfolio as one heavy line with a zero origin, and no legend', () => {
    renderChart();
    expect(screen.getByRole('heading', { name: 'Return over time' })).toBeInTheDocument();
    const lines = screen.getAllByTestId('line');
    expect(lines).toHaveLength(1);
    expect(lines[0].getAttribute('data-name')).toBe('Portfolio');
    expect(lines[0].getAttribute('data-width')).toBe('3');
    // A gap stays a gap: the line is never bridged.
    expect(lines[0].getAttribute('data-connect-nulls')).toBe('false');
    expect(screen.getByTestId('zero-line')).toBeInTheDocument();
    expect(screen.queryByTestId('legend')).not.toBeInTheDocument();
  });

  it('says the deposits do not move the line', () => {
    renderChart();
    expect(screen.getByText(/Deposits and withdrawals do not move the line\./)).toBeInTheDocument();
  });

  it('asks the hook for the window the report names, in the portfolio grouping', () => {
    renderChart({ accountIds: 'a1', displayCurrency: 'USD', reloadKey: 3 });
    expect(mockUseTwrSeries).toHaveBeenCalledWith(
      expect.objectContaining({
        groupBy: 'portfolio',
        range: '1y',
        startDate: '2026-09-14',
        periodStartDate: '2026-09-15',
        endDate: '2026-09-17',
        accountIds: 'a1',
        displayCurrency: 'USD',
        reloadKey: 3,
      }),
    );
  });

  it('asks for the listed accounts, one line each, in the account grouping', () => {
    mockUseTwrSeries.mockReturnValue({
      status: 'ready',
      groupBy: 'account',
      series: byAccount([accountSeries('a1'), accountSeries('a2')]),
    });
    renderChart({ groupBy: 'account', accountIds: 'ignored-in-this-grouping' });
    expect(mockUseTwrSeries).toHaveBeenCalledWith(
      expect.objectContaining({ groupBy: 'account', accountIds: 'a1,a2' }),
    );
    expect(screen.getAllByTestId('line').map((l) => l.getAttribute('data-name'))).toEqual([
      'Brokerage A',
      'Brokerage B',
    ]);
    expect(screen.getAllByTestId('line')[0].getAttribute('data-width')).toBe('2');
    expect(screen.getByTestId('legend')).toBeInTheDocument();
    expect(screen.getByText(/Deposits and withdrawals do not move the lines\./)).toBeInTheDocument();
  });

  it('shows a skeleton while the request is in flight', () => {
    mockUseTwrSeries.mockReturnValue({ status: 'loading', series: null });
    renderChart();
    expect(screen.queryByTestId('line-chart')).not.toBeInTheDocument();
    expect(screen.queryByText('There is no history to chart for this period.')).not.toBeInTheDocument();
  });

  it('says a failed request failed, instead of drawing an empty chart', () => {
    mockUseTwrSeries.mockReturnValue({ status: 'error', series: null });
    renderChart();
    expect(screen.getByText('The return over time could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByTestId('line-chart')).not.toBeInTheDocument();
  });

  it('names a withheld portfolio with its cause rather than drawing a flat line', () => {
    mockUseTwrSeries.mockReturnValue({
      status: 'ready',
      groupBy: 'portfolio',
      series: portfolioSeries({ points: [], complete: false, reasons: ['incompletePrices'] }),
    });
    renderChart();
    expect(screen.queryByTestId('line-chart')).not.toBeInTheDocument();
    // The "Not drawn" list gives the reason; it is not also "no history".
    expect(
      screen.queryByText('There is no history to chart for this period.'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Not drawn')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Portfolio: a price is missing for part of this period, so the return cannot be worked out.',
      ),
    ).toBeInTheDocument();
  });

  it('names the accounts it could not draw and still draws the rest', () => {
    mockUseTwrSeries.mockReturnValue({
      status: 'ready',
      groupBy: 'account',
      series: byAccount([
        accountSeries('a1'),
        accountSeries('a2', { points: [], complete: false, reasons: ['missingRatePairs'] }),
      ]),
    });
    renderChart({ groupBy: 'account' });
    expect(screen.getAllByTestId('line')).toHaveLength(1);
    expect(
      screen.getByText(
        'Brokerage B: an exchange rate is missing for part of this period, so the return cannot be worked out.',
      ),
    ).toBeInTheDocument();
  });

  describe('export', () => {
    it('is exportable only once the series is the current answer', () => {
      const onExportableChange = vi.fn();
      mockUseTwrSeries.mockReturnValue({ status: 'loading', series: null });
      const { unmount } = renderChart({ onExportableChange });
      expect(onExportableChange).toHaveBeenLastCalledWith(false);
      mockUseTwrSeries.mockReturnValue({
        status: 'ready',
        groupBy: 'portfolio',
        series: portfolioSeries(),
      });
      renderChart({ onExportableChange });
      expect(onExportableChange).toHaveBeenLastCalledWith(true);
      unmount();
    });

    it('is not exportable when every series was withheld', () => {
      const onExportableChange = vi.fn();
      mockUseTwrSeries.mockReturnValue({
        status: 'ready',
        groupBy: 'portfolio',
        series: portfolioSeries({ points: [], complete: false, reasons: ['incompletePrices'] }),
      });
      renderChart({ onExportableChange });
      expect(onExportableChange).toHaveBeenLastCalledWith(false);
    });

    it('hands the PDF the title, the subtitle and the legend of the lines it drew', async () => {
      const ref = createRef<SecurityComparisonChartHandle>();
      renderChart({ exportRef: ref });
      await act(async () => {
        await ref.current?.exportPdf();
      });
      expect(mockExportToPdf).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Return over time',
          filename: 'portfolio-return',
          chartLegend: [expect.objectContaining({ label: 'Portfolio' })],
        }),
      );
    });

    it('exports nothing while the series is loading', async () => {
      mockUseTwrSeries.mockReturnValue({ status: 'loading', series: null });
      const ref = createRef<SecurityComparisonChartHandle>();
      renderChart({ exportRef: ref });
      await act(async () => {
        await ref.current?.exportPdf();
      });
      expect(mockExportToPdf).not.toHaveBeenCalled();
    });
  });
});
