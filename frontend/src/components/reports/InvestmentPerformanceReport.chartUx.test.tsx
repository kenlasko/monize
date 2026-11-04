import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { format, startOfMonth, subDays } from 'date-fns';
import { InvestmentPerformanceReport } from './InvestmentPerformanceReport';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number, _currency?: string) => `$${n.toFixed(2)}`,
      formatSignedPercent: (n: number, decimals = 2) =>
        `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`,
    }),
  };
});

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({ defaultCurrency: 'CAD' }),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PieChart: ({ children }: { children: React.ReactNode }) => <div data-testid="pie-chart">{children}</div>,
  Pie: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Cell: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

const mockGetPortfolioSummary = vi.fn();
const mockGetInvestmentAccounts = vi.fn();
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...args: unknown[]) => mockGetPortfolioSummary(...args),
    getInvestmentAccounts: (...args: unknown[]) => mockGetInvestmentAccounts(...args),
  },
}));

// The comparison chart owns its own fetch, colours and PDF export. The stub
// captures the props it received and forwards an imperative export handle
// through `exportRef`, so the report's delegation to it is observable.
const mockChartProps = vi.fn();
const mockChartExportPdf = vi.fn().mockResolvedValue(undefined);
vi.mock('@/components/reports/SecurityComparisonChart', () => ({
  SecurityComparisonChart: (props: {
    securityIds?: string[];
    subtitle?: string;
    startDate?: string;
    endDate?: string;
    exportRef?: { current: { exportPdf: () => Promise<void> } | null };
  }) => {
    mockChartProps(props);
    if (props.exportRef) {
      props.exportRef.current = { exportPdf: mockChartExportPdf };
    }
    return (
      <div
        data-testid="performance-chart"
        data-security-ids={(props.securityIds ?? []).join(',')}
        data-subtitle={props.subtitle}
        data-start={props.startDate}
        data-end={props.endDate}
      />
    );
  },
}));

// Captures the props the range selector was given so the localized `all` label
// (which happens to read the same as `formatLabel`'s English) is observable.
const mockRangeSelectorProps = vi.fn();
vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: (props: { labels?: Record<string, string> }) => {
    mockRangeSelectorProps(props);
    return <div data-testid="range-selector" />;
  },
}));

// A single deterministic export button that fires the report's handler.
vi.mock('@/components/ui/ExportDropdown', () => ({
  ExportDropdown: ({ onExportPdf }: { onExportPdf: () => void }) => (
    <button type="button" onClick={onExportPdf}>
      Export
    </button>
  ),
}));

const mockExportToPdf = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: (...args: unknown[]) => mockExportToPdf(...args),
}));

// The window's figures: the portfolio's (the cards) and its split by security
// (the rows), each answered once per request.
const mockPeriodResult = vi.fn();
const mockSecurityPeriodResults = vi.fn();
vi.mock('@/lib/net-worth', () => ({
  netWorthApi: {
    getInvestmentsPeriodResult: (...args: unknown[]) => mockPeriodResult(...args),
    getInvestmentsSecurityPeriodResults: (...args: unknown[]) =>
      mockSecurityPeriodResults(...args),
  },
}));

const PERIOD = {
  currency: 'CAD',
  startDate: '2025-11-04',
  startPriceDate: '2025-11-04',
  endDate: '2026-11-04',
  investmentPnl: 250,
  investmentReturnPercent: 12.5,
  investedReasons: [],
};

function securityPeriod(securityId: string, pnl: number | null) {
  return {
    securityId,
    symbol: securityId.toUpperCase(),
    name: `Name ${securityId}`,
    securityCurrency: 'CAD',
    startQuantity: 10,
    endQuantity: 10,
    startClose: 8,
    endClose: 10,
    priceChangePercent: 25,
    priceChangeReason: null,
    investmentPnl: pnl,
    investmentReturnPercent: pnl === null ? null : 20,
    investedReasons: pnl === null ? ['incompletePrices'] : [],
  };
}

interface HoldingSeed {
  securityId: string;
  marketValue: number | null;
  accountId?: string;
}

function holding(seed: HoldingSeed) {
  const mv = seed.marketValue;
  return {
    id: `h-${seed.securityId}-${seed.accountId ?? 'a'}`,
    securityId: seed.securityId,
    accountId: seed.accountId ?? 'acc-1',
    symbol: seed.securityId.toUpperCase(),
    name: `Name ${seed.securityId}`,
    quantity: 10,
    averageCost: 5,
    currentPrice: mv === null ? null : mv / 10,
    marketValue: mv,
    costBasis: 50,
    costBasisAccountCurrency: 50,
    gainLoss: mv === null ? null : mv - 50,
    gainLossPercent: mv === null ? null : 10,
    currencyCode: 'CAD',
  };
}

function portfolioOf(holdings: ReturnType<typeof holding>[]) {
  return {
    holdings,
    holdingsByAccount: [],
    allocation: [
      { name: 'Equities', value: 15000, percentage: 80, color: '#3b82f6' },
      { name: 'Bonds', value: 1400, percentage: 20, symbol: 'XBND' },
    ],
    totalPortfolioValue: 16400,
    totalCostBasis: 15250,
    totalGainLoss: 1150,
    totalGainLossPercent: 7.54,
  };
}

describe('InvestmentPerformanceReport chart UX', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockPeriodResult.mockResolvedValue(PERIOD);
    mockSecurityPeriodResults.mockResolvedValue({
      currency: 'CAD',
      startDate: PERIOD.startDate,
      endDate: PERIOD.endDate,
      reasons: [],
      unattributedPnl: 0,
      securities: [securityPeriod('sec-a', 250)],
    });
  });

  it('caps the chart at the 20 largest holdings by market value and shows a note', async () => {
    // 25 distinct securities, market value = its index (1..25). The 20 largest
    // are indexes 6..25; the five smallest (1..5) are dropped.
    const seeds: HoldingSeed[] = Array.from({ length: 25 }, (_, i) => ({
      securityId: `sec-${String(i + 1).padStart(2, '0')}`,
      marketValue: i + 1,
    }));
    mockGetPortfolioSummary.mockResolvedValue(portfolioOf(seeds.map(holding)));

    render(<InvestmentPerformanceReport />);
    const chart = await screen.findByTestId('performance-chart');

    const ids = (chart.getAttribute('data-security-ids') ?? '').split(',');
    expect(ids).toHaveLength(20);
    // Exactly the 20 largest by market value, and only those.
    const expected = new Set(
      Array.from({ length: 20 }, (_, i) => `sec-${String(i + 6).padStart(2, '0')}`),
    );
    expect(new Set(ids)).toEqual(expected);
    // The five smallest are excluded.
    for (const dropped of ['sec-01', 'sec-02', 'sec-03', 'sec-04', 'sec-05']) {
      expect(ids).not.toContain(dropped);
    }

    // The "showing top 20" note renders.
    expect(
      screen.getByText(/largest holdings by market value/i),
    ).toBeInTheDocument();
  });

  it('plots every security and shows no note when 20 or fewer are held', async () => {
    const seeds: HoldingSeed[] = Array.from({ length: 20 }, (_, i) => ({
      securityId: `sec-${String(i + 1).padStart(2, '0')}`,
      marketValue: i + 1,
    }));
    mockGetPortfolioSummary.mockResolvedValue(portfolioOf(seeds.map(holding)));

    render(<InvestmentPerformanceReport />);
    const chart = await screen.findByTestId('performance-chart');

    const ids = (chart.getAttribute('data-security-ids') ?? '').split(',');
    expect(ids).toHaveLength(20);
    expect(
      screen.queryByText(/largest holdings by market value/i),
    ).not.toBeInTheDocument();
  });

  it('is stable and independent of a security held across two accounts', async () => {
    // sec-a held in two accounts is one line, not two.
    const holdings = [
      holding({ securityId: 'sec-a', marketValue: 100, accountId: 'acc-1' }),
      holding({ securityId: 'sec-a', marketValue: 100, accountId: 'acc-2' }),
      holding({ securityId: 'sec-b', marketValue: 50 }),
    ];
    mockGetPortfolioSummary.mockResolvedValue(portfolioOf(holdings));

    render(<InvestmentPerformanceReport />);
    const chart = await screen.findByTestId('performance-chart');
    expect(chart.getAttribute('data-security-ids')).toBe('sec-a,sec-b');
  });

  it('passes a portfolio-appropriate subtitle to the chart', async () => {
    mockGetPortfolioSummary.mockResolvedValue(
      portfolioOf([holding({ securityId: 'sec-a', marketValue: 100 })]),
    );
    render(<InvestmentPerformanceReport />);
    const chart = await screen.findByTestId('performance-chart');
    const subtitle = chart.getAttribute('data-subtitle') ?? '';
    expect(subtitle).toMatch(/these accounts hold/i);
    // Not the comparison report's copy about selected instruments / dashes.
    expect(subtitle).not.toMatch(/selected instrument/i);
    expect(subtitle).not.toMatch(/dashed/i);
  });

  it('delegates the Performance-view PDF export to the chart handle', async () => {
    mockGetPortfolioSummary.mockResolvedValue(
      portfolioOf([holding({ securityId: 'sec-a', marketValue: 100 })]),
    );
    render(<InvestmentPerformanceReport />);
    await screen.findByTestId('performance-chart');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /export/i }));
    });

    // The chart handle draws the correct % return chart and series legend; the
    // report's own holdings-value export path is not used here.
    expect(mockChartExportPdf).toHaveBeenCalledTimes(1);
    expect(mockExportToPdf).not.toHaveBeenCalled();
  });

  it('uses the report export with the allocation legend for the Allocation view', async () => {
    mockGetPortfolioSummary.mockResolvedValue(
      portfolioOf([holding({ securityId: 'sec-a', marketValue: 100 })]),
    );
    render(<InvestmentPerformanceReport />);
    await screen.findByTestId('performance-chart');

    await act(async () => {
      fireEvent.click(screen.getByText('Allocation'));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /export/i }));
    });

    expect(mockChartExportPdf).not.toHaveBeenCalled();
    expect(mockExportToPdf).toHaveBeenCalledTimes(1);
    const call = mockExportToPdf.mock.calls[0][0];
    // The donut legend comes from allocationData, not the holdings-value legend.
    expect(call.chartLegend).toEqual([
      { color: '#3b82f6', label: 'Equities - $15000.00' },
      { color: expect.any(String), label: 'Bonds - $1400.00' },
    ]);
  });

  it('gives the range selector a localized label for the all-time range', async () => {
    mockGetPortfolioSummary.mockResolvedValue(
      portfolioOf([holding({ securityId: 'sec-a', marketValue: 100 })]),
    );
    render(<InvestmentPerformanceReport />);
    await screen.findByTestId('range-selector');

    await waitFor(() => expect(mockRangeSelectorProps).toHaveBeenCalled());
    const props = mockRangeSelectorProps.mock.calls.at(-1)![0];
    expect(props.labels).toBeDefined();
    expect(props.labels.all).toBe('All Time');
  });

  it("offers the Investments page's ten ranges, in both views", async () => {
    mockGetPortfolioSummary.mockResolvedValue(
      portfolioOf([holding({ securityId: 'sec-a', marketValue: 100 })]),
    );
    render(<InvestmentPerformanceReport />);
    await screen.findByTestId('range-selector');
    const ranges = () => mockRangeSelectorProps.mock.calls.at(-1)![0].ranges;
    expect(ranges()).toEqual(['1d', '1w', 'mtd', '1m', '3m', 'ytd', '1y', '2y', '5y', 'all']);

    // The window governs the cards above both views, so it stays on screen.
    await act(async () => {
      fireEvent.click(screen.getByText('Allocation'));
    });
    expect(screen.getByTestId('range-selector')).toBeInTheDocument();
  });

  it.each([
    // The Investments page's 1M is thirty days back, not a calendar month.
    ['1m', () => format(subDays(new Date(), 30), 'yyyy-MM-dd')],
    // 1D is the day's move: the chart is drawn from the prior close.
    ['1d', () => format(subDays(new Date(), 1), 'yyyy-MM-dd')],
  ])('opens the %s chart on the day its figures are measured from', async (range, expected) => {
    window.localStorage.setItem(
      'reports.investment-performance.range',
      JSON.stringify({ dateRange: range, startDate: '', endDate: '' }),
    );
    mockGetPortfolioSummary.mockResolvedValue(
      portfolioOf([holding({ securityId: 'sec-a', marketValue: 100 })]),
    );
    render(<InvestmentPerformanceReport />);
    const chart = await screen.findByTestId('performance-chart');
    expect(chart.getAttribute('data-start')).toBe(expected());
    expect(chart.getAttribute('data-end')).toBe(format(new Date(), 'yyyy-MM-dd'));
    // Both figures name the range as the Investments page does.
    await waitFor(() =>
      expect(mockSecurityPeriodResults).toHaveBeenCalledWith(
        expect.objectContaining({ period: range }),
      ),
    );
    expect(mockPeriodResult).toHaveBeenCalledWith(expect.objectContaining({ period: range }));
  });

  it('names a month-to-date window by its dates, measured from the prior month-end', async () => {
    window.localStorage.setItem(
      'reports.investment-performance.range',
      JSON.stringify({ dateRange: 'mtd', startDate: '', endDate: '' }),
    );
    mockGetPortfolioSummary.mockResolvedValue(
      portfolioOf([holding({ securityId: 'sec-a', marketValue: 100 })]),
    );
    render(<InvestmentPerformanceReport />);
    const firstOfMonth = format(startOfMonth(new Date()), 'yyyy-MM-dd');
    const monthEnd = format(subDays(startOfMonth(new Date()), 1), 'yyyy-MM-dd');
    await waitFor(() =>
      expect(mockSecurityPeriodResults).toHaveBeenCalledWith(
        expect.objectContaining({ startDate: firstOfMonth, baselineDate: monthEnd }),
      ),
    );
    expect(mockPeriodResult).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: firstOfMonth, baselineDate: monthEnd }),
    );
  });

  it('exports the period figures and the % Change column from the Allocation view', async () => {
    mockGetPortfolioSummary.mockResolvedValue(
      portfolioOf([holding({ securityId: 'sec-a', marketValue: 100 })]),
    );
    render(<InvestmentPerformanceReport />);
    await waitFor(() => expect(screen.getByTestId('period-gain-card')).toHaveTextContent('+$250.00'));
    await screen.findByText('+25.00%');

    await act(async () => {
      fireEvent.click(screen.getByText('Allocation'));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /export/i }));
    });

    const call = mockExportToPdf.mock.calls[0][0];
    expect(call.summaryCards.map((card: { label: string; value: string }) => [card.label, card.value])).toEqual([
      ['Total Value', '$16400.00'],
      ['Cost Basis', '$15250.00'],
      ['Gain/Loss', '+$250.00'],
      ['Return', '+12.50%'],
    ]);
    expect(call.tableData.headers.at(-1)).toBe('% Change');
    expect(call.tableData.rows[0].slice(-3)).toEqual(['+$250.00', '+20.00%', '+25.00%']);
  });
});
