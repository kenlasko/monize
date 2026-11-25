import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@/test/render';
import { PortfolioValueReport } from './PortfolioValueReport';
import { renderChartFlagDot } from '@/components/investments/portfolio-chart-utils';
import { chartColors } from '@/lib/chart-colors';
import { usePreferencesStore } from '@/store/preferencesStore';
import { financialTodayYmd } from '@/lib/financial-today';

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatSignedPercent: (n: number, decimals = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`,
      formatCurrencyCompact: (n: number, _currency?: string) => `$${n.toFixed(0)}`,
      formatCurrency: (n: number, _currency?: string) => `$${n.toFixed(2)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
      formatCurrencyFlag: (n: number, _currency?: string) => `$${n}`,
      defaultCurrency: 'CAD',
    }),
  };
});
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (amount: number, _currency: string) => amount,
    defaultCurrency: 'CAD',
  }),
}));

const STABLE_RESOLVED_RANGE = { start: '2024-01-01', end: '2026-01-01' };

let mockDateRangeValue = '2y';
const mockSetDateRange = vi.fn();
// The custom window's dates. A case on the custom range sets both; the
// resolved range then follows them, as `resolveRangePreset` does for 'custom'.
let mockCustomStart = '';
let mockCustomEnd = '';
const mockSetStartDate = vi.fn();
const mockSetEndDate = vi.fn();

vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => {
    const isCustom = mockDateRangeValue === 'custom';
    return {
      dateRange: mockDateRangeValue,
      setDateRange: mockSetDateRange,
      startDate: mockCustomStart,
      setStartDate: mockSetStartDate,
      endDate: mockCustomEnd,
      setEndDate: mockSetEndDate,
      resolvedRange: isCustom ? mockCustomResolvedRange() : STABLE_RESOLVED_RANGE,
      isValid: !isCustom || (mockCustomStart !== '' && mockCustomEnd !== ''),
    };
  },
}));

// Memoized per date pair so the report's load effect sees a stable window.
let mockCustomRangeCache: { start: string; end: string } | null = null;
function mockCustomResolvedRange() {
  if (
    !mockCustomRangeCache ||
    mockCustomRangeCache.start !== mockCustomStart ||
    mockCustomRangeCache.end !== mockCustomEnd
  ) {
    mockCustomRangeCache = { start: mockCustomStart, end: mockCustomEnd };
  }
  return mockCustomRangeCache;
}

let mockSeriesMode = 'total';
// The payload a test hands the stacked chart's tooltip element; null renders none.
let mockTooltipPayload: unknown[] | null = null;
// Stateful stand-in for the real hook: seed `mockStoredValues` to simulate a
// previous visit, and read it back to assert what the report persisted.
const mockStoredValues = new Map<string, unknown>();
vi.mock('@/hooks/useLocalStorage', async () => {
  const { useState, useCallback } = await vi.importActual<typeof import('react')>('react');
  return {
    useLocalStorage: (key: string, defaultValue: unknown) => {
      const [value, setValue] = useState(() =>
        mockStoredValues.has(key) ? mockStoredValues.get(key) : defaultValue,
      );
      const persist = useCallback(
        (next: unknown) => {
          setValue((prev: unknown) => {
            const resolved =
              typeof next === 'function' ? (next as (p: unknown) => unknown)(prev) : next;
            mockStoredValues.set(key, resolved);
            return resolved;
          });
        },
        [key],
      );
      if (key === 'monize-reports-portfolio-value-series-mode') {
        return [mockSeriesMode, vi.fn()];
      }
      return [value, persist];
    },
  };
});

vi.mock('@/lib/utils', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
  cn: (...inputs: any[]) => inputs.filter(Boolean).join(' '),
}));

const mockDateRangeSelectorProps = vi.fn();
vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: (props: any) => {
    mockDateRangeSelectorProps(props);
    return <div data-testid="date-range-selector" />;
  },
}));

vi.mock('@/components/ui/ExportDropdown', () => ({
  ExportDropdown: ({ onExportCsv, onExportPdf }: any) => (
    <div data-testid="export-dropdown">
      {onExportCsv && (
        <button data-testid="export-csv" onClick={onExportCsv}>CSV</button>
      )}
      <button data-testid="export-pdf" onClick={onExportPdf}>Export PDF</button>
    </div>
  ),
}));

vi.mock('recharts', async () => {
  const { cloneElement, isValidElement } = await import('react');
  return {
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  // `data-points` carries the rows the chart was actually handed, so a test can
  // see what is plotted rather than only what the KPI cards say (#1389).
  AreaChart: ({ children, data }: any) => (
    <div data-testid="area-chart" data-points={JSON.stringify(data ?? [])}>
      {children}
    </div>
  ),
  Legend: () => null,
  // Invoke the dot render-prop so the high/low bubble wiring (and its dismiss
  // control) is exercised. Indices 0..2 cover both extremes of the 3-point
  // series the dismiss test renders.
  Area: ({ dot, connectNulls }: any) =>
    typeof dot === 'function' ? (
      <>
        <span data-testid="area-connect-nulls">{String(connectNulls)}</span>
        {dot({ cx: 10, cy: 20, index: 0 })}
        {dot({ cx: 30, cy: 40, index: 1 })}
        {dot({ cx: 50, cy: 60, index: 2 })}
      </>
    ) : null,
  XAxis: ({ tickFormatter }: any) => (
    <div>
      {tickFormatter ? tickFormatter('Jan 2024') : ''}
      {tickFormatter ? tickFormatter('Jan 1, 2024') : ''}
    </div>
  ),
  YAxis: ({ tickFormatter }: any) => <div>{tickFormatter ? tickFormatter(1000) : ''}</div>,
  CartesianGrid: () => null,
  Tooltip: ({ content }: any) => {
    if (typeof content === 'function') {
      return (
        <div>
          {content({ active: true, payload: [{ value: 100, payload: { name: 'Jan' } }] })}
          {content({ active: false, payload: [] })}
          {content({ active: true, payload: null })}
        </div>
      );
    }
    if (mockTooltipPayload && isValidElement(content)) {
      return cloneElement(content as any, {
        active: true,
        payload: mockTooltipPayload,
      });
    }
    return null;
  },
  };
});

vi.mock('@/components/investments/portfolio-chart-utils', async (importActual) => ({
  ...(await importActual<typeof import('@/components/investments/portfolio-chart-utils')>()),
  INTRADAY_RANGES: new Set(['1d', '1w', 'mtd', '1m']),
  buildIntradayCacheKey: vi.fn(() => 'test-cache-key'),
  readIntradayCache: vi.fn(() => null),
  writeIntradayCache: vi.fn(),
  computeTightYAxisDomain: vi.fn((values: number[]) => {
    if (!values.length) return [0, 1];
    return [Math.min(...values), Math.max(...values)];
  }),
  renderChartFlagDot: vi.fn(() => null),
  ChartFlagShadowFilter: () => null,
}));

const mockGetInvestmentsSampled = vi.fn();
const mockGetInvestmentsDaily = vi.fn();
const mockGetInvestmentsBreakdown = vi.fn();
const mockGetPeriodResult = vi.fn();
const mockGetPortfolioSummary = vi.fn();
const mockGetInvestmentAccounts = vi.fn();
const mockGetIntradayValue = vi.fn();
const mockGetIntradayBreakdown = vi.fn();
const mockGetSecurities = vi.fn().mockResolvedValue([]);

vi.mock('@/lib/net-worth', () => ({
  netWorthApi: {
    // A long range asks the daily endpoint for its month-end sample; routed
    // to its own mock so a case states which series it is about.
    getInvestmentsDaily: (...args: any[]) =>
      args[0]?.sampling === 'monthEnd'
        ? mockGetInvestmentsSampled(...args)
        : mockGetInvestmentsDaily(...args),
    getInvestmentsBreakdown: (...args: any[]) => mockGetInvestmentsBreakdown(...args),
    getInvestmentsPeriodResult: (...args: any[]) => mockGetPeriodResult(...args),
  },
}));

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
    getIntradayValue: (...args: any[]) => mockGetIntradayValue(...args),
    getIntradayBreakdown: (...args: any[]) => mockGetIntradayBreakdown(...args),
    getSecurities: (...args: any[]) => mockGetSecurities(...args),
  },
}));

// The writer itself is the app's one CSV door and is tested there; what this
// suite asserts is the sections the report hands it.
const mockExportCsvSections = vi.fn();
vi.mock('@/lib/csv-export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/csv-export')>()),
  exportCsvSections: (...args: unknown[]) => mockExportCsvSections(...args),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const emptyPortfolio = {
  holdings: [],
  holdingsByAccount: [],
  allocation: [],
  totalPortfolioValue: 0,
  totalCostBasis: 0,
  totalGainLoss: 0,
  totalGainLossPercent: 0,
};

/**
 * The server's period result, complete unless a case says otherwise. Every
 * figure the KPI cards print comes from here: the report does no arithmetic
 * over the plotted series any more (#1392).
 */
const periodResult = (overrides: Record<string, unknown> = {}) => {
  const base = {
  currency: 'CAD',
  startDate: '2024-01-01',
  startPriceDate: '2024-01-01',
  endDate: '2026-01-01',
  startValue: 50000,
  endValue: 55000,
  valueChange: 5000,
  netExternalFlows: 0,
  knownFlowSubtotal: 0,
  investmentResult: 5000,
  returnPercent: 10,
  returnMethod: 'simple' as const,
  complete: true,
  reasons: [] as string[],
  missingRatePairs: [] as string[],
  unpricedSecurityIds: [] as string[],
  unknownCashAccountIds: [] as string[],
  ...overrides,
  };
  // Both measures, as the server sends them. Unless a case states otherwise the
  // invested figures mirror the account-level ones, so a case that cares which
  // the surface reads says so out loud (INV-PORTRESULT-002).
  const mirrored = {
    investedValueStart: base.startValue,
    investedValueEnd: base.endValue,
    investedValueChange:
      'investedValueChange' in overrides
        ? overrides.investedValueChange
        : base.valueChange,
    investmentCapitalFlows:
      'investmentCapitalFlows' in overrides ? overrides.investmentCapitalFlows : 0,
    investmentIncome:
      'investmentIncome' in overrides ? overrides.investmentIncome : 0,
    investmentPnl:
      'investmentPnl' in overrides ? overrides.investmentPnl : base.investmentResult,
    investmentReturnPercent:
      'investmentReturnPercent' in overrides
        ? overrides.investmentReturnPercent
        : base.returnPercent,
    investmentReturnMethod: 'twr' as const,
    investedComplete: base.complete,
    investedReasons:
      'investedReasons' in overrides ? overrides.investedReasons : base.reasons,
  };
  return { ...base, ...mirrored };
};

describe('PortfolioValueReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSecurities.mockResolvedValue([]);
    // A null store is the pre-load state, where the hook takes the default.
    usePreferencesStore.setState({ preferences: null });
    mockDateRangeValue = '2y';
    mockCustomStart = '';
    mockCustomEnd = '';
    mockSeriesMode = 'total';
    mockStoredValues.clear();
    mockGetPeriodResult.mockResolvedValue(periodResult());
  });

  it('shows loading state initially', () => {
    mockGetInvestmentsSampled.mockReturnValue(new Promise(() => {}));
    mockGetPeriodResult.mockReturnValue(new Promise(() => {}));
    mockGetPortfolioSummary.mockReturnValue(new Promise(() => {}));
    mockGetInvestmentAccounts.mockReturnValue(new Promise(() => {}));
    render(<PortfolioValueReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no monthly data', async () => {
    mockGetInvestmentsSampled.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText(/No investment data for this period/)).toBeInTheDocument();
    });
  });

  it('renders summary cards with portfolio data', async () => {
    mockGetInvestmentsSampled.mockResolvedValue([
      { date: '2024-06-01', value: 50000 },
      { date: '2024-07-01', value: 52000 },
      { date: '2024-08-01', value: 55000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [
        {
          accountId: 'acc-1',
          accountName: 'TFSA',
          totalMarketValue: 50000,
          cashBalance: 5000,
          totalGainLoss: 3000,
          totalGainLossPercent: 6.0,
        },
      ],
      allocation: [],
      totalPortfolioValue: 55000,
      totalCostBasis: 50000,
      totalGainLoss: 5000,
      totalGainLossPercent: 10.0,
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Highest Value')).toBeInTheDocument();
    });
    expect(screen.getByText('Lowest Value')).toBeInTheDocument();
    expect(screen.getByText('Value Change')).toBeInTheDocument();
    expect(screen.getByText('Net Invested')).toBeInTheDocument();
    expect(screen.getByText('Investment Result')).toBeInTheDocument();
  });

  /**
   * The default 2Y window is drawn from the daily valuation sampled at
   * month-ends, so its first point IS the close the figures are measured from
   * and its last is today: the Value Change beside it is the line's own last
   * point less its first, not a month-end snapshot's.
   */
  it('opens the long-range line on the close the figures are measured from', async () => {
    let requestedStart = '';
    mockGetInvestmentsSampled.mockImplementation(
      async (params: { startDate: string; endDate: string }) => {
        requestedStart = params.startDate;
        return [
          { date: params.startDate, value: 50000, securitiesValue: 50000 },
          { date: '2025-01-31', value: 51000, securitiesValue: 51000 },
          { date: params.endDate, value: 53000, securitiesValue: 53000 },
        ];
      },
    );
    mockGetPeriodResult.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return periodResult({
        startDate: requestedStart,
        startPriceDate: '2024-09-27',
        investedValueChange: 3000,
      });
    });
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);

    await waitFor(() =>
      expect(mockGetInvestmentsSampled).toHaveBeenCalledWith(
        expect.objectContaining({ sampling: 'monthEnd' }),
      ),
    );
    // The monthly snapshots are not what a long range draws any more.
    expect(mockGetInvestmentsDaily).not.toHaveBeenCalled();
    await waitFor(() => {
      const points = JSON.parse(
        screen.getByTestId('area-chart').getAttribute('data-points')!,
      ) as Array<{ name: string; iso: string; Value: number }>;
      // Named by the session its close came from, as the caption is.
      expect(points[0].name).toBe('Sep 27, 2024');
      expect(points[0].iso).toBe(requestedStart);
      expect(points[1].name).toBe('Jan 2025');
      expect(points[points.length - 1].Value - points[0].Value).toBe(3000);
    });
    await waitFor(() =>
      expect(
        screen.getByText('Value Change').parentElement!.parentElement!.textContent,
      ).toContain('3000'),
    );
  });

  it('lets the user dismiss a high or low value bubble without persisting it', async () => {
    mockGetInvestmentsSampled.mockResolvedValue([
      { date: '2024-06-01', value: 50000 },
      { date: '2024-07-01', value: 52000 },
      { date: '2024-08-01', value: 55000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);

    const flagMock = vi.mocked(renderChartFlagDot);
    await waitFor(() => {
      expect(flagMock.mock.calls.some(([o]: any) => o.color === chartColors.income)).toBe(true);
    });

    // Both bubbles are wired with a dismiss control and the localized label.
    const highCall = flagMock.mock.calls.find(([o]: any) => o.color === chartColors.income)!;
    expect(typeof highCall[0].onDismiss).toBe('function');
    expect(highCall[0].dismissLabel).toBe('Hide this value');
    expect(flagMock.mock.calls.some(([o]: any) => o.color === chartColors.expense)).toBe(true);

    // Dismissing the high bubble hides it on the next render; the low remains.
    flagMock.mockClear();
    await act(async () => {
      highCall[0].onDismiss!();
    });
    expect(flagMock.mock.calls.some(([o]: any) => o.color === chartColors.income)).toBe(false);
    expect(flagMock.mock.calls.some(([o]: any) => o.color === chartColors.expense)).toBe(true);
  });

  it('renders the area chart', async () => {
    mockGetInvestmentsSampled.mockResolvedValue([
      { date: '2024-06-01', value: 50000 },
      { date: '2024-07-01', value: 55000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      ...emptyPortfolio,
      totalPortfolioValue: 55000,
      totalGainLoss: 5000,
      totalGainLossPercent: 10,
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Portfolio Value Over Time')).toBeInTheDocument();
    });
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  it('renders portfolio breakdown table when account data available', async () => {
    mockGetInvestmentsSampled.mockResolvedValue([
      { date: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [
        {
          accountId: 'acc-1',
          accountName: 'TFSA',
          totalMarketValue: 45000,
          cashBalance: 5000,
          totalGainLoss: 3000,
          totalGainLossPercent: 6.67,
        },
      ],
      allocation: [],
      totalPortfolioValue: 50000,
      totalCostBasis: 47000,
      totalGainLoss: 3000,
      totalGainLossPercent: 6.38,
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Portfolio Breakdown')).toBeInTheDocument();
    });
    // 'TFSA' appears in the breakdown table (the account picker shows the
    // "All Accounts" placeholder until opened).
    expect(screen.getAllByText('TFSA').length).toBeGreaterThanOrEqual(1);
  });

  it('passes date filter ranges including 1w, mtd, 1m, 3m, ytd to DateRangeSelector', async () => {
    mockGetInvestmentsSampled.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(mockDateRangeSelectorProps).toHaveBeenCalled();
    });
    const lastCall = mockDateRangeSelectorProps.mock.calls[mockDateRangeSelectorProps.mock.calls.length - 1][0];
    // Same list, in the same order, as the Investments page chart offers.
    expect(lastCall.ranges).toEqual(['1d', '1w', 'mtd', '1m', '3m', 'ytd', '1y', '2y', '5y', 'all']);
  });

  it('keeps the view switches beside the actions and the toolbar pinned to its first line', async () => {
    mockDateRangeValue = 'custom';
    mockCustomStart = '2025-01-01';
    mockCustomEnd = '2026-01-01';
    mockGetInvestmentsDaily.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    await act(async () => {
      render(<PortfolioValueReport />);
    });

    // One trailing group: the Total/By security and Table/Chart switches sit
    // against Refresh/Export at the right edge, not beside the range buttons.
    const totalSwitch = screen.getByRole('button', { name: 'Total' });
    const trailing = totalSwitch.parentElement!.parentElement!;
    expect(trailing.className).toContain('sm:ml-auto');
    expect(trailing).toContainElement(screen.getByTestId('export-pdf'));

    // Both rows align on the first line's text. Centred, they slid down to the
    // middle of the custom range's date fields when those opened below.
    const toolbar = trailing.parentElement!;
    const leading = toolbar.firstElementChild as HTMLElement;
    expect(leading).toContainElement(screen.getByTestId('date-range-selector'));
    for (const row of [toolbar, leading]) {
      expect(row.className).toContain('items-baseline');
      expect(row.className).not.toContain('items-center');
    }
  });

  it('draws YTD from the previous year-end close and names the window to the server', async () => {
    mockDateRangeValue = 'ytd';
    mockGetInvestmentsDaily.mockResolvedValue([
      { date: '2025-12-31', value: 50000 },
      { date: '2026-01-02', value: 50500 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    await act(async () => {
      render(<PortfolioValueReport />);
    });

    // The chart opens on 31 December, whose value is the last session's
    // close, rather than on the year's first trading day.
    expect(mockGetInvestmentsDaily).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: `${new Date().getFullYear() - 1}-12-31` }),
    );
    // The figures are the server's `ytd` preset, which opens on the same day.
    await waitFor(() =>
      expect(mockGetPeriodResult).toHaveBeenCalledWith(
        expect.objectContaining({ period: 'ytd' }),
      ),
    );
  });

  it('dates the opening point by the session the caption names', async () => {
    // 1Y is measured from the same day a year earlier. When that is a Sunday
    // its value is Friday's close, and the series is requested from the
    // Sunday: the first point is shown as the Friday under the chart's own
    // caption, so the two cannot disagree about where the year opens.
    mockDateRangeValue = '1y';
    mockGetInvestmentsDaily.mockResolvedValue([
      { date: '2025-09-28', value: 50000 },
      { date: '2025-09-29', value: 50500 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPeriodResult.mockResolvedValue(
      periodResult({ startDate: '2025-09-28', startPriceDate: '2025-09-26' }),
    );
    await act(async () => {
      render(<PortfolioValueReport />);
    });

    await waitFor(() =>
      expect(screen.getByTestId('report-measured-from-close')).toHaveTextContent(
        'Since the close of trading on Sep 26, 2025',
      ),
    );
    const names = () =>
      JSON.parse(
        screen.getByTestId('area-chart').getAttribute('data-points') ?? '[]',
      ).map((p: { name: string }) => p.name);
    await waitFor(() => expect(names()).toEqual(['Sep 26, 2025', 'Sep 29, 2025']));
  });

  describe('custom range', () => {
    const lastSelectorProps = () =>
      mockDateRangeSelectorProps.mock.calls[mockDateRangeSelectorProps.mock.calls.length - 1][0];

    const renderLoaded = async (daily: Array<{ date: string; value: number }> = []) => {
      mockGetInvestmentsSampled.mockResolvedValue([]);
      mockGetInvestmentsDaily.mockResolvedValue(daily);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      await act(async () => {
        render(<PortfolioValueReport />);
      });
    };

    it('offers a custom range after All Time, with its dates wired through', async () => {
      mockDateRangeValue = 'custom';
      mockCustomStart = '2025-01-15';
      mockCustomEnd = '2025-06-30';
      await renderLoaded();
      const props = lastSelectorProps();
      expect(props.showCustom).toBe(true);
      expect(props.customStartDate).toBe('2025-01-15');
      expect(props.customEndDate).toBe('2025-06-30');
      expect(props.onCustomStartDateChange).toBe(mockSetStartDate);
      expect(props.onCustomEndDateChange).toBe(mockSetEndDate);
    });

    it('opens the To date on today and does not remember the custom choice', async () => {
      await renderLoaded();
      act(() => {
        lastSelectorProps().onChange('custom');
      });
      expect(mockSetDateRange).toHaveBeenCalledWith('custom');
      expect(mockSetEndDate).toHaveBeenCalledWith(financialTodayYmd(undefined));
      expect(mockSetStartDate).not.toHaveBeenCalled();
      expect(mockStoredValues.has('monize-reports-portfolio-value-range')).toBe(false);
    });

    it('keeps a To date the reader already chose', async () => {
      mockCustomEnd = '2025-03-31';
      await renderLoaded();
      act(() => {
        lastSelectorProps().onChange('custom');
      });
      expect(mockSetEndDate).not.toHaveBeenCalled();
    });

    it('still remembers a preset', async () => {
      await renderLoaded();
      act(() => {
        lastSelectorProps().onChange('1y');
      });
      expect(mockStoredValues.get('monize-reports-portfolio-value-range')).toBe('1y');
    });

    it('draws a window of up to a year from daily closes over exactly its dates', async () => {
      mockDateRangeValue = 'custom';
      mockCustomStart = '2025-01-01';
      mockCustomEnd = '2026-01-01';
      await renderLoaded([
        { date: '2025-01-01', value: 50000 },
        { date: '2026-01-01', value: 55000 },
      ]);
      expect(mockGetInvestmentsDaily).toHaveBeenCalledWith(
        expect.objectContaining({ startDate: '2025-01-01', endDate: '2026-01-01' }),
      );
      expect(mockGetInvestmentsSampled).not.toHaveBeenCalled();
      // A custom window is dated, not named: the server has no preset for it.
      await waitFor(() =>
        expect(mockGetPeriodResult).toHaveBeenCalledWith(
          expect.objectContaining({ startDate: '2025-01-01', endDate: '2026-01-01' }),
        ),
      );
    });

    it('draws a window longer than a year from monthly values', async () => {
      mockDateRangeValue = 'custom';
      // 367 days: one past the longest window drawn daily.
      mockCustomStart = '2024-12-30';
      mockCustomEnd = '2026-01-01';
      await renderLoaded();
      expect(mockGetInvestmentsSampled).toHaveBeenCalledWith(
        expect.objectContaining({ startDate: '2024-12-30', endDate: '2026-01-01' }),
      );
      expect(mockGetInvestmentsDaily).not.toHaveBeenCalled();
    });

    it('loads nothing while the From date is missing or after the To date', async () => {
      mockDateRangeValue = 'custom';
      mockCustomEnd = '2026-01-01';
      await renderLoaded();
      mockCustomStart = '2026-02-01';
      await renderLoaded();
      expect(mockGetInvestmentsDaily).not.toHaveBeenCalled();
      expect(mockGetInvestmentsSampled).not.toHaveBeenCalled();
      expect(mockGetPeriodResult).not.toHaveBeenCalled();
    });
  });

  it('handles loadData error gracefully', async () => {
    mockGetInvestmentsSampled.mockRejectedValue(new Error('boom'));
    mockGetPortfolioSummary.mockRejectedValue(new Error('boom'));
    mockGetInvestmentAccounts.mockRejectedValue(new Error('boom'));
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText(/No investment data/)).toBeInTheDocument();
    });
  });

  it('exports pdf with breakdown', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetInvestmentsSampled.mockResolvedValue([
      { date: '2024-06-01', value: 50000 },
      { date: '2024-07-01', value: 55000 },
      { date: '2024-08-01', value: 52000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [
        { accountId: 'acc-1', accountName: 'TFSA', totalMarketValue: 45000, cashBalance: 5000, totalGainLoss: 3000, totalGainLossPercent: 6.67 },
        { accountId: 'acc-2', accountName: 'RRSP', totalMarketValue: 3000, cashBalance: 0, totalGainLoss: -500, totalGainLossPercent: -10 },
      ],
      allocation: [],
      totalPortfolioValue: 53000,
      totalCostBasis: 50000,
      totalGainLoss: 3000,
      totalGainLossPercent: 6,
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'USD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Portfolio Breakdown')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
    expect(exportToPdf).toHaveBeenCalled();
  });

  it('exports pdf with no portfolio breakdown rows', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetInvestmentsSampled.mockResolvedValue([
      { date: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByTestId('export-pdf')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
    expect(exportToPdf).toHaveBeenCalledWith(
      expect.objectContaining({ additionalTables: undefined }),
    );
  });

  it('changes selected account', async () => {
    mockGetInvestmentsSampled.mockResolvedValue([
      { date: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      ...emptyPortfolio, totalPortfolioValue: 50000,
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA - Cash', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });
    await act(async () => { fireEvent.click(trigger); });
    await act(async () => {
      fireEvent.click(screen.getByText('TFSA'));
    });
  });

  it('persists the account selection so it survives leaving the report', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockGetInvestmentsSampled.mockResolvedValue([{ date: '2024-06-01', value: 50000 }]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA - Cash', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });
    await act(async () => { fireEvent.click(trigger); });
    await act(async () => { fireEvent.click(screen.getByText('TFSA')); });
    // The picker debounces before notifying the report.
    await act(async () => { vi.advanceTimersByTime(350); });

    await waitFor(() => {
      expect(mockStoredValues.get('monize-reports-portfolio-value-accounts')).toEqual(['acc-1']);
    });
    vi.useRealTimers();
  });

  it('restores the persisted account selection on mount', async () => {
    mockStoredValues.set('monize-reports-portfolio-value-accounts', ['acc-2']);
    mockGetInvestmentsSampled.mockResolvedValue([{ date: '2024-06-01', value: 50000 }]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
      { id: 'acc-2', name: 'RRSP', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);

    await waitFor(() => {
      expect(mockGetInvestmentsSampled).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: 'acc-2' }),
      );
    });
    expect(mockGetPortfolioSummary).toHaveBeenCalledWith(['acc-2']);
    // The stored selection is left alone when the account still exists.
    expect(mockStoredValues.get('monize-reports-portfolio-value-accounts')).toEqual(['acc-2']);
  });

  it('drops persisted account IDs that no longer exist', async () => {
    mockStoredValues.set('monize-reports-portfolio-value-accounts', ['acc-1', 'gone']);
    mockGetInvestmentsSampled.mockResolvedValue([{ date: '2024-06-01', value: 50000 }]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);

    await waitFor(() => {
      expect(mockStoredValues.get('monize-reports-portfolio-value-accounts')).toEqual(['acc-1']);
    });
    await waitFor(() => {
      expect(mockGetInvestmentsSampled).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: 'acc-1' }),
      );
    });
  });

  it('renders with negative period change', async () => {
    mockGetInvestmentsSampled.mockResolvedValue([
      { date: '2024-06-01', value: 60000 },
      { date: '2024-07-01', value: 55000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      ...emptyPortfolio,
      totalPortfolioValue: 55000,
      totalCostBasis: 60000,
      totalGainLoss: -5000,
      totalGainLossPercent: -8.33,
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPeriodResult.mockResolvedValue(
      periodResult({
        valueChange: -5000,
        investmentResult: -5000,
        returnPercent: -8.33,
      }),
    );
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Value Change')).toBeInTheDocument();
    });
    // The percentage belongs to the result, never to the value change.
    expect(screen.getByText('-8.3%')).toBeInTheDocument();
  });

  it('handles many monthly data points (>36) for axis ticks', async () => {
    const data = Array.from({ length: 50 }, (_, i) => ({
      date: `2020-${String((i % 12) + 1).padStart(2, '0')}-01`,
      value: 50000 + i * 100,
    }));
    mockGetInvestmentsSampled.mockResolvedValue(data);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Portfolio Value Over Time')).toBeInTheDocument();
    });
  });

  it('renders account selector dropdown', async () => {
    mockGetInvestmentsSampled.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('All Accounts')).toBeInTheDocument();
    });
  });

  it('filters INVESTMENT_BROKERAGE accounts from the dropdown', async () => {
    mockGetInvestmentsSampled.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-cash', name: 'TFSA - Cash', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
      { id: 'acc-brok', name: 'TFSA - Brokerage', currencyCode: 'CAD', accountSubType: 'INVESTMENT_BROKERAGE' },
    ]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('All Accounts')).toBeInTheDocument();
    });
    // Cash account (with suffix stripped) should appear; brokerage account should not
    expect(screen.queryByText('TFSA - Brokerage')).not.toBeInTheDocument();
  });

  it('strips account name suffixes in the dropdown', async () => {
    mockGetInvestmentsSampled.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA - Cash', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });
    fireEvent.click(trigger);
    // The " - Cash" suffix should be stripped in the option label
    expect(screen.getByText('TFSA')).toBeInTheDocument();
  });

  it('shows breakdown negative gain/loss in red colour class', async () => {
    mockGetInvestmentsSampled.mockResolvedValue([
      { date: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [
        { accountId: 'acc-1', accountName: 'RRSP', totalMarketValue: 40000, cashBalance: 0, totalGainLoss: -5000, totalGainLossPercent: -11.1 },
      ],
      allocation: [],
      totalPortfolioValue: 40000,
      totalCostBasis: 45000,
      totalGainLoss: -5000,
      totalGainLossPercent: -11.1,
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Portfolio Breakdown')).toBeInTheDocument();
    });
    // Negative gain/loss cell should have red text class
    const gainLossCell = screen.getByText('$-5000.00');
    expect(gainLossCell).toHaveClass('text-red-600');
  });

  it('shows breakdown positive gain/loss formatted with + prefix', async () => {
    mockGetInvestmentsSampled.mockResolvedValue([
      { date: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [
        { accountId: 'acc-1', accountName: 'TFSA', totalMarketValue: 48000, cashBalance: 2000, totalGainLoss: 5000, totalGainLossPercent: 11.6 },
      ],
      allocation: [],
      totalPortfolioValue: 50000,
      totalCostBasis: 45000,
      totalGainLoss: 5000,
      totalGainLossPercent: 11.6,
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('+$5000.00')).toBeInTheDocument();
    });
  });

  it('shows foreign currency label in summary cards when account currency differs from default', async () => {
    mockGetInvestmentsSampled.mockResolvedValue([
      { date: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    // Account with USD currency while default is CAD
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-usd', name: 'USD Account - Cash', currencyCode: 'USD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });
    await act(async () => { fireEvent.click(trigger); });
    await act(async () => {
      fireEvent.click(screen.getByText('USD Account'));
    });
    await waitFor(() => {
      // When foreign currency is active, values are formatted with the currency code suffix
      expect(screen.getAllByText('$50000 USD').length).toBeGreaterThan(0);
    });
  });

  /**
   * The period result belongs to the request that produced it (#1392 follow-up).
   * Switching from a populated 3M to a 1D window leaves the new window's
   * request in flight, and the cards must not go on printing the 3M figures
   * under the 1D caption while it is.
   */
  it('drops the previous range figures while the new range is still being asked', async () => {
    const kpi = (label: string) =>
      screen.getByText(label).parentElement!.parentElement!.textContent;
    mockDateRangeValue = '3m';
    mockGetInvestmentsDaily.mockResolvedValue([
      { date: '2024-06-01', value: 50000 },
      { date: '2024-06-02', value: 51000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    const { rerender } = render(<PortfolioValueReport />);
    await waitFor(() => expect(kpi('Value Change')).toContain('+$5000'));

    mockDateRangeValue = '1d';
    mockGetIntradayValue.mockResolvedValue({
      points: [],
      interval: '5m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: [],
      fallbackToDaily: true,
    });
    // The 1D window's own request hangs: the answer on screen belongs to the
    // quarter, and a quarter's figures under a day's caption is the defect.
    mockGetPeriodResult.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      rerender(<PortfolioValueReport />);
    });

    await waitFor(() =>
      expect(screen.getByText(/Intraday view unavailable/i)).toBeInTheDocument(),
    );
    expect(kpi('Value Change')).not.toContain('5000');
    expect(screen.getAllByTestId('unknown-amount').length).toBeGreaterThan(0);
  });

  it('exports the period summary with raw amounts and their currency', async () => {
    mockDateRangeValue = '3m';
    mockGetInvestmentsDaily.mockResolvedValue([
      { date: '2024-06-01', value: 50000, complete: true },
      { date: '2024-06-02', value: 51000, complete: true },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => expect(screen.getByTestId('export-csv')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId('export-csv'));
    });

    const [, sections] = mockExportCsvSections.mock.calls[0];
    expect(sections[0].headers).toEqual(['Figure', 'Amount', 'Currency']);
    // Raw numbers, so a spreadsheet adds the column up, and the unit beside
    // each one, so a foreign-currency export cannot be read as the reader's.
    expect(sections[0].rows).toEqual([
      ['Highest Value', 51000, 'CAD'],
      ['Lowest Value', 50000, 'CAD'],
      ['Value Change', 5000, 'CAD'],
      ['Net Invested', 0, 'CAD'],
      ['Dividends and Interest', 0, 'CAD'],
      ['Investment Result', 5000, 'CAD'],
      ['Investment Return', 10, '%'],
    ]);
  });

  it('handles daily range (3m) using getInvestmentsDaily', async () => {
    // 3m is in DAILY_RANGES but not in INTRADAY_RANGES, so it uses the daily endpoint
    mockDateRangeValue = '3m';
    mockGetInvestmentsDaily.mockResolvedValue([
      { date: '2024-06-01', value: 50000 },
      { date: '2024-06-02', value: 51000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Portfolio Value Over Time')).toBeInTheDocument();
    });
    expect(mockGetInvestmentsDaily).toHaveBeenCalled();
  });

  describe('a day the server could not finish', () => {
    const kpi = (label: string) =>
      screen.getByText(label).parentElement!.textContent;

    it('withholds the high, the low and the change when a day is incomplete', async () => {
      // A position held on 06-01 had no accepted close, so the INVESTED value
      // of that point is a subtotal: it cannot be ranked against whole days,
      // and it is one of the two endpoints the change is measured between.
      mockDateRangeValue = '3m';
      mockGetInvestmentsDaily.mockResolvedValue([
        {
          date: '2024-06-01',
          value: 50000,
          securitiesValue: 50000,
          fxComplete: true,
          pricesComplete: false,
          unpricedSecurityIds: ['sec-1'],
          cashComplete: true,
          unknownCashAccountIds: [],
        },
        {
          date: '2024-06-02',
          value: 51000,
          securitiesValue: 51000,
          fxComplete: true,
          pricesComplete: true,
          cashComplete: true,
          unknownCashAccountIds: [],
        },
      ]);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByText('Lowest Value')).toBeInTheDocument();
      });

      await waitFor(() => expect(kpi('Lowest Value')).toContain('N/A'));
      expect(kpi('Lowest Value')).not.toContain('$50000');
      expect(kpi('Highest Value')).toContain('N/A');
    });

    /**
     * A cash account with no balance for a day is a real gap, and it used to
     * blank this chart's point. It no longer can: the chart plots the INVESTED
     * value and no cash is in it (INV-PORTRESULT-002), so the point is a whole
     * day's answer. The gap is still reported in the incomplete-data details,
     * because the reader who has one wants to know.
     */
    it('keeps a day whose only gap is a cash balance', async () => {
      mockDateRangeValue = '3m';
      mockGetInvestmentsDaily.mockResolvedValue([
        {
          date: '2024-06-01',
          value: 50000,
          securitiesValue: 48000,
          fxComplete: true,
          pricesComplete: true,
          cashComplete: false,
          unknownCashAccountIds: ['cash-1'],
        },
        {
          date: '2024-06-02',
          value: 51000,
          securitiesValue: 49000,
          fxComplete: true,
          pricesComplete: true,
          cashComplete: true,
          unknownCashAccountIds: [],
        },
      ]);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByText('Lowest Value')).toBeInTheDocument();
      });

      // The invested value, not the value with the cash in it.
      await waitFor(() => expect(kpi('Lowest Value')).toContain('$48000'));
      expect(kpi('Highest Value')).toContain('$49000');
      expect(kpi('Lowest Value')).not.toContain('N/A');
    });

    /**
     * The report draws the INVESTED value, so a cash deposit with nothing
     * bought does not move the chart or its KPIs, and the result and return
     * are the invested part's (INV-PORTRESULT-002).
     */
    it('plots the invested value and reports the invested figures', async () => {
      mockDateRangeValue = '3m';
      mockGetInvestmentsDaily.mockResolvedValue([
        { date: '2024-06-01', value: 10000, securitiesValue: 0 },
        { date: '2024-06-02', value: 60000, securitiesValue: 0 },
      ]);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      mockGetPeriodResult.mockResolvedValue(
        periodResult({
          valueChange: 50000,
          netExternalFlows: 50000,
          investmentResult: 0,
          returnPercent: 0,
          investedValueChange: 0,
          investmentPnl: 0,
          investmentReturnPercent: 0,
        }),
      );
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByText('Lowest Value')).toBeInTheDocument();
      });

      await waitFor(() => expect(kpi('Highest Value')).toContain('$0'));
      expect(kpi('Highest Value')).not.toContain('$60000');
      // The value change is the plotted line's own: the securities did not
      // move, so neither does it. The account's 50,000 (a cash deposit) is a
      // different figure and is not the one printed beside this chart.
      await waitFor(() => expect(kpi('Value Change')).toContain('$0'));
      expect(kpi('Value Change')).not.toContain('$50000');
      expect(kpi('Investment Result')).toContain('$0');
    });

    /**
     * The money figures are the server's, so what withholds them is the
     * server's answer and not the chart's: a period whose boundary day was a
     * subtotal comes back with every figure null and the cause named, and each
     * card draws the unknown marker rather than a number.
     */
    it('draws the unknown marker on each money card the server withheld', async () => {
      mockDateRangeValue = '3m';
      mockGetInvestmentsDaily.mockResolvedValue([
        { date: '2024-06-01', value: 50000 },
        { date: '2024-06-02', value: 51000 },
      ]);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      mockGetPeriodResult.mockResolvedValue(
        periodResult({
          valueChange: null,
          netExternalFlows: null,
          investmentResult: null,
          returnPercent: null,
          investmentCapitalFlows: null,
          investmentIncome: null,
          complete: false,
          reasons: ['incompletePrices'],
          unpricedSecurityIds: ['sec-1'],
        }),
      );
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByText('Value Change')).toBeInTheDocument();
      });

      await waitFor(() =>
        expect(screen.getAllByTestId('unknown-amount')).toHaveLength(3),
      );
      expect(kpi('Value Change')).not.toContain('$');
      expect(kpi('Net Invested')).not.toContain('$');
      expect(screen.getByTestId('period-income')).toHaveTextContent(
        'Dividends and interest N/A',
      );
      expect(kpi('Investment Result')).toContain('N/A');
    });

    /**
     * The rule survives to the pixel (`docs/time-series-contract.md` rule 3).
     * The server's `value` on an incomplete day is the subtotal of what it
     * could price and convert, so plotting it draws a measured-looking line --
     * a whole holding period of unpriced securities read as a flat line near
     * zero, which is what was reported against #1389. The point is a gap.
     */
    it('plots no point for a day the server could not finish', async () => {
      mockDateRangeValue = '3m';
      mockGetInvestmentsDaily.mockResolvedValue([
        {
          date: '2024-06-01',
          // The subtotal: the account held a security nothing could price.
          value: 0,
          fxComplete: true,
          pricesComplete: false,
          unpricedSecurityIds: ['sec-a'],
          cashComplete: true,
          unknownCashAccountIds: [],
        },
        {
          date: '2024-06-02',
          value: 51000,
          fxComplete: true,
          pricesComplete: true,
          unpricedSecurityIds: [],
          cashComplete: true,
          unknownCashAccountIds: [],
        },
      ]);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByTestId('area-chart')).toBeInTheDocument();
      });

      await waitFor(() => {
        const plotted = JSON.parse(
          screen.getByTestId('area-chart').getAttribute('data-points')!,
        ) as Array<{ Value: number | null }>;
        expect(plotted.map((p) => p.Value)).toEqual([null, 51000]);
      });
      // ...and the gap is a gap, not a segment drawn across it.
      expect(screen.getByTestId('area-connect-nulls').textContent).toBe('false');
    });

    it('names the security and the dates behind a withheld figure', async () => {
      // "Some days are incomplete" is a dead end; the security, the pair and
      // the account with their dates are the repair (#1389).
      mockDateRangeValue = '3m';
      mockGetSecurities.mockResolvedValue([
        { id: 'sec-a', symbol: 'AGGG', name: 'Global Aggregate Bond' },
      ]);
      mockGetInvestmentsDaily.mockResolvedValue([
        {
          date: '2024-06-01',
          value: 0,
          fxComplete: true,
          missingRatePairs: [],
          pricesComplete: false,
          unpricedSecurityIds: ['sec-a'],
          cashComplete: true,
          unknownCashAccountIds: [],
        },
        {
          date: '2024-06-02',
          value: 0,
          fxComplete: true,
          missingRatePairs: [],
          pricesComplete: false,
          unpricedSecurityIds: ['sec-a'],
          cashComplete: true,
          unknownCashAccountIds: [],
        },
      ]);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);

      await waitFor(() => {
        expect(screen.getByTestId('incomplete-data-details')).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByTestId('incomplete-data-details')).toHaveTextContent(
          'AGGG',
        );
      });
      // Both days are one run, and the panel links to where it is repaired.
      expect(screen.getByRole('link', { name: 'AGGG' })).toHaveAttribute(
        'href',
        '/securities/sec-a?tab=prices',
      );
      expect(
        screen.getByTestId('incomplete-data-details').textContent,
      ).not.toContain('sec-a:');
    });

    it('prints the figures when every day is complete', async () => {
      mockDateRangeValue = '3m';
      mockGetInvestmentsDaily.mockResolvedValue([
        {
          date: '2024-06-01',
          value: 50000,
          fxComplete: true,
          pricesComplete: true,
          cashComplete: true,
          unknownCashAccountIds: [],
        },
        {
          date: '2024-06-02',
          value: 51000,
          fxComplete: true,
          pricesComplete: true,
          cashComplete: true,
          unknownCashAccountIds: [],
        },
      ]);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByText('Lowest Value')).toBeInTheDocument();
      });

      await waitFor(() => expect(kpi('Lowest Value')).toContain('$50000'));
      expect(kpi('Highest Value')).toContain('$51000');
      expect(kpi('Value Change')).not.toContain('N/A');
    });

    it('says nothing about completeness a response never claimed', async () => {
      // An older backend mid-deploy sends no flags at all. Absent is no
      // information, so the figures are printed as before.
      mockDateRangeValue = '3m';
      mockGetInvestmentsDaily.mockResolvedValue([
        { date: '2024-06-01', value: 50000 },
        { date: '2024-06-02', value: 51000 },
      ]);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByText('Lowest Value')).toBeInTheDocument();
      });

      await waitFor(() => expect(kpi('Lowest Value')).toContain('$50000'));
    });
  });

  it('shows intraday unavailable state for 1d range with fallbackToDaily', async () => {
    mockDateRangeValue = '1d';
    mockGetIntradayValue.mockResolvedValue({
      points: [],
      interval: '5m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: ['MSFT'],
      fallbackToDaily: true,
    });
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText(/Intraday view unavailable/i)).toBeInTheDocument();
    });
    // Should show skipped symbols
    expect(screen.getByText(/MSFT/)).toBeInTheDocument();
  });

  it('shows intraday unavailable with no skipped symbols listed', async () => {
    mockDateRangeValue = '1d';
    mockGetIntradayValue.mockResolvedValue({
      points: [],
      interval: '5m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: [],
      fallbackToDaily: true,
    });
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText(/Intraday view unavailable/i)).toBeInTheDocument();
    });
  });

  it('shows intraday fallback warning icon for 1w range with fallbackToDaily', async () => {
    mockDateRangeValue = '1w';
    mockGetIntradayValue.mockResolvedValue({
      points: [],
      interval: '1d',
      currency: 'CAD',
      range: '1w',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: ['VFV'],
      fallbackToDaily: true,
    });
    mockGetInvestmentsDaily.mockResolvedValue([
      { date: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByTestId('report-intraday-fallback-warning')).toBeInTheDocument();
    });
  });

  it('renders intraday chart points for 1d range without fallback', async () => {
    mockDateRangeValue = '1d';
    mockGetIntradayValue.mockResolvedValue({
      points: [
        { timestamp: '2024-06-01T10:00:00Z', value: 50000 },
        { timestamp: '2024-06-01T11:00:00Z', value: 51000 },
      ],
      interval: '5m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: [],
      fallbackToDaily: false,
    });
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByTestId('area-chart')).toBeInTheDocument();
    });
  });

  it('does not repeat the measured-from dates beside the value change on an intraday range', async () => {
    mockDateRangeValue = '1d';
    mockGetIntradayValue.mockResolvedValue({
      points: [
        { timestamp: '2024-06-01T10:00:00Z', value: 50000 },
        { timestamp: '2024-06-01T11:00:00Z', value: 51000 },
      ],
      interval: '5m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: [],
      fallbackToDaily: false,
    });
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPeriodResult.mockResolvedValue(
      periodResult({ startDate: '2026-01-14', endDate: '2026-01-15' }),
    );
    render(<PortfolioValueReport />);

    // The chart's own caption already names the close the figures are
    // measured from, so the card carries no second, dated marker.
    await waitFor(() => expect(mockGetPeriodResult).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByText(/Since the close of trading on/)).toBeInTheDocument(),
    );
    expect(
      screen.queryByLabelText(/measured between the stored closing values/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/Jan 14, 2026.*Jan 15, 2026/i),
    ).not.toBeInTheDocument();
  });

  // #1516: those movements withhold only the ACCOUNT result. The invested
  // figure this card shows does not read where a trade's cash settled, so the
  // card no longer carries a notice for them.
  it('carries no uncountable-movement notice when only the account result is withheld', async () => {
    mockGetInvestmentsSampled.mockResolvedValue([
      { date: '2024-01-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPeriodResult.mockResolvedValue(
      periodResult({
        investmentResult: null,
        returnPercent: null,
        complete: false,
        reasons: ['externallySettledTrade'],
      }),
    );
    render(<PortfolioValueReport />);

    await waitFor(() => expect(mockGetPeriodResult).toHaveBeenCalled());
    expect(
      screen.queryByLabelText(/cannot be counted here/i),
    ).not.toBeInTheDocument();
  });

  describe('mtd range', () => {
    /** An intraday response carrying `points`, otherwise unremarkable. */
    const intraday = (
      points: Array<{ timestamp: string; value: number; sessionClose?: true }>,
    ) => ({
      points,
      interval: '15m',
      currency: 'CAD',
      range: '1m',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: [],
      fallbackToDaily: false,
    });

    it('asks the backend for the mtd series on its own window', async () => {
      mockDateRangeValue = 'mtd';
      mockGetIntradayValue.mockResolvedValue(
        intraday([{ timestamp: '2024-01-02T14:30:00Z', value: 50000 }]),
      );
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(mockGetIntradayValue).toHaveBeenCalled();
      });
      // The server trims the month and opens it on the close it is measured
      // from; a rolling 1m series cut on the client does not always reach
      // that close (issue #1461).
      expect(mockGetIntradayValue).toHaveBeenCalledWith(
        expect.objectContaining({ range: 'mtd' }),
      );
    });

    it('plots the mtd series as served, opening on the previous session\'s closing point', async () => {
      mockDateRangeValue = 'mtd';
      mockGetIntradayValue.mockResolvedValue(
        intraday([
          // The server's closing point for the last session before the
          // window: the close the month is measured from.
          { timestamp: '2023-12-29T20:00:00Z', value: 40000, sessionClose: true },
          { timestamp: '2024-01-02T14:30:00Z', value: 50000 },
          { timestamp: '2024-01-10T14:30:00Z', value: 52000 },
        ]),
      );
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByText('Lowest Value')).toBeInTheDocument();
      });

      await waitFor(() =>
        expect(
          screen.getByText('Lowest Value').parentElement!.textContent,
        ).toContain('$40000'),
      );
      expect(
        screen.getByText('Highest Value').parentElement!.textContent,
      ).toContain('$52000');
    });

    it('asks for the period result against the close before the month started', async () => {
      mockDateRangeValue = 'mtd';
      mockGetIntradayValue.mockResolvedValue(
        intraday([
          { timestamp: '2024-01-02T14:30:00Z', value: 50000 },
          { timestamp: '2024-01-10T14:30:00Z', value: 52000 },
        ]),
      );
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      mockGetPeriodResult.mockResolvedValue(
        periodResult({ valueChange: 3000, investmentResult: 3000 }),
      );
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByText('Value Change')).toBeInTheDocument();
      });

      // The baseline is the close before the month -- the last day of the
      // previous month, where the series was requested from -- and the server
      // measures from it: the client picks the dates and nothing else. Never
      // the day before the first bar on screen: the point the chart opens on
      // IS that close, and a day before it measured from the wrong session.
      await waitFor(() =>
        expect(mockGetPeriodResult).toHaveBeenCalledWith(
          expect.objectContaining({
            startDate: '2024-01-01',
            baselineDate: '2023-12-31',
          }),
        ),
      );
      await waitFor(() =>
        expect(
          screen.getByText('Value Change').parentElement!.textContent,
        ).toContain('+$3000'),
      );
      // Not the change between the two points plotted, which is what the
      // client used to work out for itself.
      expect(
        screen.getByText('Value Change').parentElement!.textContent,
      ).not.toContain('+$2000');
    });

    it('asks the per-security breakdown for the mtd series too', async () => {
      mockDateRangeValue = 'mtd';
      mockSeriesMode = 'securities';
      mockGetIntradayBreakdown.mockResolvedValue({
        series: [{ key: 'sec-1', type: 'security', symbol: 'VFV', name: 'VFV' }],
        points: [
          { timestamp: '2023-12-28T14:30:00Z', total: 40000, values: { 'sec-1': 40000 } },
          { timestamp: '2024-01-02T14:30:00Z', total: 50000, values: { 'sec-1': 50000 } },
        ],
        interval: '15m',
        currency: 'CAD',
        range: '1m',
        fetchedAt: new Date().toISOString(),
        skippedSymbols: [],
        failedSymbols: [],
        fallbackToDaily: false,
      });
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(mockGetIntradayBreakdown).toHaveBeenCalled();
      });
      expect(mockGetIntradayBreakdown).toHaveBeenCalledWith(
        expect.objectContaining({ range: 'mtd' }),
      );
      // The same window as the total view, shaped by the server for both.
      await waitFor(() =>
        expect(
          screen.getByText('Highest Value').parentElement!.textContent,
        ).toContain('$50000'),
      );
    });
  });

  /**
   * Which SESSION the figures are measured from, named under the chart's
   * title rather than behind a marker on one card.
   *
   * `startDate` is a calendar boundary and the value series prices every
   * calendar day from the latest close at or before it, so a window opening on
   * a Sunday is measured from Friday's close. The date the reader is shown is
   * the session, never the boundary beside it.
   */
  describe('the session the figures are measured from', () => {
    it('names it under the chart title, for every range', async () => {
      mockGetInvestmentsSampled.mockResolvedValue([
        { date: '2024-06-01', value: 50000 },
        { date: '2024-07-01', value: 55000 },
      ]);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      mockGetPeriodResult.mockResolvedValue(
        periodResult({ startDate: '2026-09-20', startPriceDate: '2026-09-18' }),
      );
      render(<PortfolioValueReport />);

      await waitFor(() =>
        expect(
          screen.getByTestId('report-measured-from-close'),
        ).toHaveTextContent('Since the close of trading on Sep 18, 2026'),
      );
      // The Sunday boundary is not what the reader is told.
      expect(
        screen.getByTestId('report-measured-from-close'),
      ).not.toHaveTextContent('Sep 20');
      expect(
        screen.queryByText(/Measured from the previous trading day/),
      ).toBeNull();
    });

    it('says nothing when the server could not name a session', async () => {
      mockGetInvestmentsSampled.mockResolvedValue([
        { date: '2024-06-01', value: 50000 },
      ]);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      mockGetPeriodResult.mockResolvedValue(
        periodResult({ startPriceDate: null }),
      );
      render(<PortfolioValueReport />);

      await waitFor(() =>
        expect(screen.getByText('Value Change')).toBeInTheDocument(),
      );
      expect(screen.queryByTestId('report-measured-from-close')).toBeNull();
    });
  });

  describe('the window the figures are measured over', () => {
    /** Text of the summary card carrying `label`. */
    const card = (label: string) => screen.getByText(label).parentElement!.textContent;

    const intradayWeek = () => ({
      points: [
        { timestamp: '2024-06-03T13:30:00Z', value: 50000 },
        { timestamp: '2024-06-07T20:00:00Z', value: 51000 },
      ],
      interval: '15m',
      currency: 'CAD',
      range: '1w',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: [],
      fallbackToDaily: false,
    });

    it('names the week to the server rather than dating it', async () => {
      mockDateRangeValue = '1w';
      mockGetIntradayValue.mockResolvedValue(intradayWeek());
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      mockGetPeriodResult.mockResolvedValue(
        periodResult({
          startDate: '2024-06-02',
          valueChange: 2000,
          investmentResult: 2000,
          returnPercent: 4.08,
        }),
      );
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByText('Value Change')).toBeInTheDocument();
      });

      // The week is NAMED, not dated: the server resolves it from the same
      // arithmetic the performance card's 1W row uses.
      await waitFor(() =>
        expect(mockGetPeriodResult).toHaveBeenCalledWith(
          expect.objectContaining({ period: '1w' }),
        ),
      );
      await waitFor(() => expect(card('Value Change')).toContain('+$2000'));
      // Not the move between the two points plotted, which is the figure the
      // report used to derive for itself.
      expect(card('Value Change')).not.toContain('+$1000');
      expect(card('Investment Result')).toContain('+4.1%');
    });

    it('reports every figure as unknown when the server cannot answer', async () => {
      mockDateRangeValue = '1w';
      mockGetIntradayValue.mockResolvedValue(intradayWeek());
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      mockGetPeriodResult.mockRejectedValue(new Error('period result unavailable'));
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByText('Value Change')).toBeInTheDocument();
      });

      // A failed request is not a change of zero, and not the first point's
      // change wearing the prior close's label.
      await waitFor(() => expect(card('Investment Result')).toContain('N/A'));
      expect(card('Value Change')).not.toContain('$1000');
      expect(screen.getAllByTestId('unknown-amount').length).toBeGreaterThan(0);
    });

    it('names a long range too, rather than sending the window it drew', async () => {
      mockGetInvestmentsSampled.mockResolvedValue([
        { date: '2024-06-01', value: 50000 },
        { date: '2024-07-01', value: 55000 },
      ]);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => {
        expect(screen.getByText('Value Change')).toBeInTheDocument();
      });

      await waitFor(() => expect(card('Value Change')).toContain('+$5000'));
      // 2Y draws from the day before the anniversary; the figure is measured
      // over the two years the button names.
      expect(mockGetPeriodResult).toHaveBeenCalledWith(
        expect.objectContaining({ period: '2y' }),
      );
    });
  });

  it('handles intraday fetch error gracefully', async () => {
    mockDateRangeValue = '1d';
    mockGetIntradayValue.mockRejectedValue(new Error('network error'));
    // Component falls back to daily on intraday error; mock it empty so chart stays empty
    mockGetInvestmentsDaily.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText(/No investment data|Intraday view unavailable/i)).toBeInTheDocument();
    });
  });

  it('shows background loading indicator when data is being refreshed', async () => {
    // First load resolves; second (triggered by account change) stays pending
    mockGetInvestmentsSampled
      .mockResolvedValueOnce([{ date: '2024-06-01', value: 50000 }])
      .mockReturnValueOnce(new Promise(() => {}));
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Portfolio Value Over Time')).toBeInTheDocument();
    });
    // Trigger a reload by changing the account — new fetch hangs, but old points are shown
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Filter by account' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('TFSA'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('report-chart-loading-indicator')).toBeInTheDocument();
    });
  });

  it('renders many daily data points (>36) axis tick logic', async () => {
    mockDateRangeValue = '3m';
    const data = Array.from({ length: 50 }, (_, i) => ({
      date: `2024-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      value: 50000 + i * 100,
    }));
    mockGetInvestmentsDaily.mockResolvedValue(data);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('Portfolio Value Over Time')).toBeInTheDocument();
    });
    expect(mockGetInvestmentsDaily).toHaveBeenCalled();
  });

  it('prints the zero return the server sent over a single chart point', async () => {
    mockGetInvestmentsSampled.mockResolvedValue([
      { date: '2024-06-01', value: 50000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetPeriodResult.mockResolvedValue(
      periodResult({ valueChange: 0, investmentResult: 0, returnPercent: 0 }),
    );
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText('+0.0%')).toBeInTheDocument();
    });
  });

  it('exports pdf using foreign-currency fmtFull when account has foreign currency', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetInvestmentsSampled.mockResolvedValue([
      { date: '2024-06-01', value: 40000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [
        { accountId: 'acc-usd', accountName: 'USD Account', totalMarketValue: 40000, cashBalance: 0, totalGainLoss: 1000, totalGainLossPercent: 2.5 },
      ],
      allocation: [],
      totalPortfolioValue: 40000,
      totalCostBasis: 39000,
      totalGainLoss: 1000,
      totalGainLossPercent: 2.5,
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-usd', name: 'USD Account - Brokerage', currencyCode: 'USD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<PortfolioValueReport />);
    // Select the USD account first to activate foreign currency path
    const trigger = await screen.findByRole('button', { name: 'Filter by account' });
    await act(async () => { fireEvent.click(trigger); });
    // The account name also appears in the breakdown table, so target the
    // option's checkbox inside the dropdown rather than matching by text.
    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox'));
    });
    await waitFor(() => expect(screen.getByTestId('export-pdf')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
    expect(exportToPdf).toHaveBeenCalled();
  });

  it('switches to table view, exercises sort, and exports CSV', async () => {
    mockGetInvestmentsSampled.mockResolvedValue([
      { date: '2024-01-01', value: 50000 },
      { date: '2024-02-01', value: 52000 },
      { date: '2024-03-01', value: 51000 },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      ...emptyPortfolio,
      holdingsByAccount: [
        {
          accountId: 'a1',
          accountName: 'Account A',
          totalMarketValue: 25000,
          cashBalance: 1000,
          totalGainLoss: 500,
        },
        {
          accountId: 'a2',
          accountName: 'Account B',
          totalMarketValue: 25000,
          cashBalance: 500,
          totalGainLoss: -200,
        },
      ],
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    const { container } = render(<PortfolioValueReport />);
    // Wait for the chart to render so the toggle is mounted.
    await waitFor(() => expect(screen.getByTitle('Table')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTitle('Table')); });
    // The chart card now renders a table; click each header to exercise sort.
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    const tables = container.querySelectorAll('table');
    expect(tables.length).toBeGreaterThan(0);
    // Exercise sort headers on every rendered table (chart-table + breakdown table).
    const tableCount = tables.length;
    for (let t = 0; t < tableCount; t += 1) {
      const headerCount = container.querySelectorAll('table')[t].querySelectorAll('th').length;
      for (let __i = 0; __i < headerCount; __i += 1) {
        const __ths = container.querySelectorAll('table')[t].querySelectorAll('th');
        if (!__ths[__i]) break;
        await act(async () => { fireEvent.click(__ths[__i]); });
      }
      for (let __i = 0; __i < headerCount; __i += 1) {
        const __ths = container.querySelectorAll('table')[t].querySelectorAll('th');
        if (!__ths[__i]) break;
        await act(async () => { fireEvent.click(__ths[__i]); });
      }
    }
    // Trigger CSV export.
    await act(async () => { fireEvent.click(screen.getByTestId('export-csv')); });
  });

  const breakdownFixture = {
    granularity: 'monthEnd' as const,
    currency: 'CAD',
    series: [
      { key: 'sec-1', type: 'security' as const, symbol: 'AAPL', name: 'Apple Inc.' },
      { key: 'other', type: 'other' as const, symbol: null, name: '' },
      { key: 'cash', type: 'cash' as const, symbol: null, name: '' },
    ],
    points: [
      { date: '2024-06-01', total: 1500, values: { 'sec-1': 800, other: 200, cash: 500 } },
      { date: '2024-07-01', total: 1700, values: { 'sec-1': 900, other: 300, cash: 500 } },
    ],
  };

  it('loads the per-security breakdown and renders the stacked chart when By security is active', async () => {
    mockSeriesMode = 'securities';
    mockGetInvestmentsBreakdown.mockResolvedValue(breakdownFixture);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByTestId('area-chart')).toBeInTheDocument();
    });
    expect(mockGetInvestmentsBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ granularity: 'monthEnd' }),
    );
    // The total-only endpoints are not used while By security is active.
    expect(mockGetInvestmentsSampled).not.toHaveBeenCalled();
  });

  it('uses daily granularity for the breakdown on shorter ranges', async () => {
    mockSeriesMode = 'securities';
    mockDateRangeValue = '3m';
    mockGetInvestmentsBreakdown.mockResolvedValue({ ...breakdownFixture, granularity: 'daily' });
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(mockGetInvestmentsBreakdown).toHaveBeenCalledWith(
        expect.objectContaining({ granularity: 'daily' }),
      );
    });
  });

  it('renders the per-security table with a column per band and exports CSV', async () => {
    mockSeriesMode = 'securities';
    mockGetInvestmentsBreakdown.mockResolvedValue(breakdownFixture);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => expect(screen.getByTitle('Table')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTitle('Table')); });
    // Security band (symbol), rolled-up "Other securities" and "Cash" bands
    // each get a column header.
    await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());
    expect(screen.getByText('Other securities')).toBeInTheDocument();
    expect(screen.getByText('Cash')).toBeInTheDocument();
    // A per-band cell value is formatted with the currency formatter.
    expect(screen.getAllByText('$800.00').length).toBeGreaterThanOrEqual(1);
    await act(async () => { fireEvent.click(screen.getByTestId('export-csv')); });
  });

  const intradayBreakdownFixture = {
    series: [
      { key: 'sec-1', type: 'security' as const, symbol: 'AAPL', name: 'Apple Inc.' },
      { key: 'cash', type: 'cash' as const, symbol: null, name: '' },
    ],
    points: [
      { timestamp: '2024-06-01T13:30:00.000Z', total: 1500, values: { 'sec-1': 1000, cash: 500 } },
      { timestamp: '2024-06-01T13:31:00.000Z', total: 1600, values: { 'sec-1': 1100, cash: 500 } },
    ],
    interval: '1m' as const,
    currency: 'CAD',
    range: '1d' as const,
    fetchedAt: new Date().toISOString(),
    skippedSymbols: [],
    failedSymbols: [],
    fallbackToDaily: false,
  };

  it('renders the intraday per-security breakdown for the 1d range', async () => {
    mockSeriesMode = 'securities';
    mockDateRangeValue = '1d';
    mockGetIntradayBreakdown.mockResolvedValue(intradayBreakdownFixture);
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByTestId('area-chart')).toBeInTheDocument();
    });
    expect(mockGetIntradayBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ range: '1d' }),
    );
    // The daily/monthly breakdown endpoint is not used for an intraday range.
    expect(mockGetInvestmentsBreakdown).not.toHaveBeenCalled();
    // The By security toggle is now available on every range, including 1d.
    expect(screen.getByRole('button', { name: 'By security' })).not.toBeDisabled();
  });

  it('shows the intraday-unavailable note when the 1d breakdown falls back', async () => {
    mockSeriesMode = 'securities';
    mockDateRangeValue = '1d';
    mockGetIntradayBreakdown.mockResolvedValue({
      ...intradayBreakdownFixture,
      series: [],
      points: [],
      skippedSymbols: ['MSFT'],
      fallbackToDaily: true,
    });
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByText(/Intraday view unavailable/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/MSFT/)).toBeInTheDocument();
  });

  it('falls back to the daily breakdown with a warning for the 1w range', async () => {
    mockSeriesMode = 'securities';
    mockDateRangeValue = '1w';
    mockGetIntradayBreakdown.mockResolvedValue({
      ...intradayBreakdownFixture,
      series: [],
      points: [],
      range: '1w',
      interval: '5m',
      skippedSymbols: ['VFV'],
      fallbackToDaily: true,
    });
    mockGetInvestmentsBreakdown.mockResolvedValue({ ...breakdownFixture, granularity: 'daily' });
    mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<PortfolioValueReport />);
    await waitFor(() => {
      expect(screen.getByTestId('report-intraday-fallback-warning')).toBeInTheDocument();
    });
    // 1W fell back to the daily-snapshot breakdown.
    expect(mockGetInvestmentsBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ granularity: 'daily' }),
    );
  });

  // One valuation scope across the whole report: the INVESTED value (securities,
  // no cash). The "By security" breakdown response folds cash into each point's
  // `total`, so reading it made that view draw securities+cash while the "Total"
  // view drew securities alone -- the same window peaked at two different
  // numbers depending only on which toggle was pressed (audit of #1397).
  describe('one valuation scope (point 8)', () => {
    const kpi = (label: string) =>
      screen.getByText(label).parentElement!.textContent;

    // 800 + 200 securities, 500 cash: invested 1000/1200, cash-inclusive
    // 1500/1700. Reused by the sum-view case below with the same numbers.
    const scopedBreakdown = {
      granularity: 'monthEnd' as const,
      currency: 'CAD',
      series: [
        { key: 'sec-1', type: 'security' as const, symbol: 'AAPL', name: 'Apple Inc.' },
        { key: 'other', type: 'other' as const, symbol: null, name: '' },
        { key: 'cash', type: 'cash' as const, symbol: null, name: '' },
      ],
      points: [
        { date: '2024-06-01', total: 1500, values: { 'sec-1': 800, other: 200, cash: 500 } },
        { date: '2024-07-01', total: 1700, values: { 'sec-1': 900, other: 300, cash: 500 } },
      ],
    };

    it('takes the breakdown high/low from the invested value, not the cash-inclusive total', async () => {
      mockSeriesMode = 'securities';
      mockGetInvestmentsBreakdown.mockResolvedValue(scopedBreakdown);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);

      await waitFor(() => expect(kpi('Highest Value')).toContain('$1200'));
      expect(kpi('Lowest Value')).toContain('$1000');
      // The old behaviour read `total` (cash folded in), which would have
      // peaked at 1700 and bottomed at 1500 -- a scope change, not a market
      // difference.
      expect(kpi('Highest Value')).not.toContain('$1700');
      expect(kpi('Lowest Value')).not.toContain('$1500');
    });

    it('the sum view lands on the same invested high/low for the same numbers', async () => {
      // Same underlying figures reaching the report through the sum endpoint:
      // `value` folds cash in, `securitiesValue` is the invested part.
      mockSeriesMode = 'total';
      mockGetInvestmentsSampled.mockResolvedValue([
        { date: '2024-06-01', value: 1500, securitiesValue: 1000 },
        { date: '2024-07-01', value: 1700, securitiesValue: 1200 },
      ]);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);

      await waitFor(() => expect(kpi('Highest Value')).toContain('$1200'));
      expect(kpi('Lowest Value')).toContain('$1000');
      // Both views agree: switching the toggle cannot move the high or the low.
      expect(kpi('Highest Value')).not.toContain('$1700');
    });

    it('exports the invested value as each breakdown row total, never invested+cash', async () => {
      mockSeriesMode = 'securities';
      mockGetInvestmentsBreakdown.mockResolvedValue(scopedBreakdown);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => expect(screen.getByTestId('area-chart')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('export-csv')); });

      const sections = mockExportCsvSections.mock.calls.at(-1)![1];
      // The series section is the last one; its rows are [date, ...bands, total].
      const seriesRows = sections.at(-1).rows as unknown[][];
      const totals = seriesRows.map((r) => r[r.length - 1]);
      // The invested value, not the cash-inclusive 1500/1700.
      expect(totals).toEqual(expect.arrayContaining([1000, 1200]));
      expect(totals).not.toContain(1500);
      expect(totals).not.toContain(1700);
    });

    it('renders a month missing a price as a subtotal, withholding the high', async () => {
      // A month whose backend point carries pricesComplete:false is a subtotal
      // of the invested value: it cannot be ranked against whole months.
      mockSeriesMode = 'securities';
      mockGetInvestmentsBreakdown.mockResolvedValue({
        ...scopedBreakdown,
        fxComplete: true,
        points: [
          {
            date: '2024-06-01',
            total: 1500,
            values: { 'sec-1': 800, other: 200, cash: 500 },
            pricesComplete: false,
            unpricedSecurityIds: ['sec-1'],
            cashComplete: true,
            unknownCashAccountIds: [],
            missingRatePairs: [],
          },
          {
            date: '2024-07-01',
            total: 1700,
            values: { 'sec-1': 900, other: 300, cash: 500 },
            pricesComplete: true,
            unpricedSecurityIds: [],
            cashComplete: true,
            unknownCashAccountIds: [],
            missingRatePairs: [],
          },
        ],
      });
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);

      await waitFor(() => expect(kpi('Highest Value')).toContain('N/A'));
      expect(kpi('Lowest Value')).toContain('N/A');
      // Not the invested high of the whole month -- one incomplete point leaves
      // both extremes unknown.
      expect(kpi('Highest Value')).not.toContain('$1200');
    });
  });

  describe('the by-security breakdown reads what the server knows (issue #2414)', () => {
    // A month the server could not price: AAPL's band is absent, so it is
    // unknown there, not a zero; the other bands it did send are figures.
    const unpricedMonth = {
      granularity: 'monthEnd' as const,
      currency: 'CAD',
      series: [
        { key: 'sec-1', type: 'security' as const, symbol: 'AAPL', name: 'Apple Inc.' },
        { key: 'other', type: 'other' as const, symbol: null, name: '' },
        { key: 'cash', type: 'cash' as const, symbol: null, name: '' },
      ],
      points: [
        {
          date: '2024-06-01',
          total: 700,
          values: { other: 200, cash: 500 },
          pricesComplete: false,
          unpricedSecurityIds: ['sec-1'],
          missingRatePairs: [],
        },
        {
          date: '2024-07-01',
          total: 1700,
          values: { 'sec-1': 900, other: 300, cash: 500 },
          pricesComplete: true,
          unpricedSecurityIds: [],
          missingRatePairs: [],
        },
      ],
    };

    afterEach(() => {
      mockTooltipPayload = null;
    });

    it('writes an unknown band and its total as N/A in the CSV, never as 0', async () => {
      mockSeriesMode = 'securities';
      mockGetInvestmentsBreakdown.mockResolvedValue(unpricedMonth);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => expect(screen.getByTestId('area-chart')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('export-csv')); });

      const sections = mockExportCsvSections.mock.calls.at(-1)![1];
      const rows = sections.at(-1).rows as unknown[][];
      const june = rows.find((r) => r.includes(200))!;
      // [date, AAPL, other, cash, total]
      expect(june.slice(1)).toEqual(['N/A', 200, 500, 'N/A']);
      const july = rows.find((r) => r.includes(900))!;
      expect(july.slice(1)).toEqual([900, 300, 500, 1200]);
    });

    it('marks an unknown band unknown in the table rather than printing $0.00', async () => {
      mockSeriesMode = 'securities';
      mockGetInvestmentsBreakdown.mockResolvedValue(unpricedMonth);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => expect(screen.getByTitle('Table')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTitle('Table')); });
      await waitFor(() => expect(screen.getByText('AAPL')).toBeInTheDocument());
      const juneRow = screen.getByText('$200.00').closest('tr')!;
      expect(within(juneRow).getAllByTestId('unknown-amount')).toHaveLength(2);
      expect(within(juneRow).queryByText('$0.00')).not.toBeInTheDocument();
    });

    it("totals the tooltip with the point's own figure, unknown where the server has none", async () => {
      mockSeriesMode = 'securities';
      mockGetInvestmentsBreakdown.mockResolvedValue(unpricedMonth);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      // The incomplete month draws no band, so the bands it hands the tooltip are null.
      mockTooltipPayload = [
        { name: 'AAPL', value: null, payload: { name: 'Jun 2024', total: null } },
        { name: 'Cash', value: null, payload: { name: 'Jun 2024', total: null } },
      ];
      const { container } = render(<PortfolioValueReport />);
      await waitFor(() => expect(screen.getByTestId('area-chart')).toBeInTheDocument());
      const tooltip = container.querySelector('.max-h-72') as HTMLElement;
      expect(within(tooltip).getByTestId('unknown-amount')).toBeInTheDocument();
      expect(tooltip.textContent).not.toContain('$0.00');
    });

    it("prints the point's own total in the tooltip, not the bands added up again", async () => {
      mockSeriesMode = 'securities';
      mockGetInvestmentsBreakdown.mockResolvedValue(unpricedMonth);
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      mockTooltipPayload = [
        { name: 'AAPL', value: 900, payload: { name: 'Jul 2024', total: 1700 } },
        { name: 'Cash', value: 500, payload: { name: 'Jul 2024', total: 1700 } },
      ];
      const { container } = render(<PortfolioValueReport />);
      await waitFor(() => expect(screen.getByTestId('area-chart')).toBeInTheDocument());
      const tooltip = container.querySelector('.max-h-72') as HTMLElement;
      expect(tooltip.textContent).toContain('$1700.00');
      expect(tooltip.textContent).not.toContain('$1400.00');
    });
  });

  describe('a per-account breakdown row the server could not value', () => {
    const accountRow = (overrides: Record<string, unknown> = {}) => ({
      accountId: 'acc-1',
      accountName: 'Partial Brokerage',
      totalMarketValue: 50000,
      cashBalance: 5000,
      totalGainLoss: 3000,
      totalGainLossPercent: 6.0,
      unpricedHoldingsCount: 0,
      ...overrides,
    });
    const arrange = (rows: Array<Record<string, unknown>>) => {
      mockGetInvestmentsSampled.mockResolvedValue([
        { date: '2024-06-01', value: 50000 },
        { date: '2024-07-01', value: 55000 },
      ]);
      mockGetPortfolioSummary.mockResolvedValue({
        ...emptyPortfolio,
        holdingsByAccount: rows,
      });
      mockGetInvestmentAccounts.mockResolvedValue([]);
    };
    const rowFor = (name: string) =>
      screen.getByText(name).closest('tr') as HTMLElement;

    it('marks holdings, total and gain partial when valuationComplete is false (A26-M38)', async () => {
      arrange([
        accountRow({
          valuationComplete: false,
          fxComplete: false,
          missingRatePairs: ['USD->CAD'],
        }),
      ]);
      render(<PortfolioValueReport />);
      await screen.findByText('Partial Brokerage');
      const row = rowFor('Partial Brokerage');
      // Holdings and total are subtotals, so both carry the marker ...
      // ... cash is a ledger balance and does not.
      expect(row).toHaveTextContent('$5000.00');
      // The server's gain is over the holdings that have a value, so it is a
      // figure, marked partial like its neighbours -- no longer withheld.
      expect(row.querySelectorAll('[data-testid="partial-total"]')).toHaveLength(3);
      const gain = within(row).getByText('+$3000.00');
      expect(gain.closest('[data-testid="partial-total"]')).not.toBeNull();
      expect(row.querySelector('[data-testid="unknown-amount"]')).toBeNull();
    });

    it('reads an unpriced holding the same way when no flag is sent', async () => {
      arrange([accountRow({ unpricedHoldingsCount: 1 })]);
      render(<PortfolioValueReport />);
      await screen.findByText('Partial Brokerage');
      const row = rowFor('Partial Brokerage');
      expect(row.querySelectorAll('[data-testid="partial-total"]')).toHaveLength(3);
      expect(
        within(row).getByText('+$3000.00').closest('[data-testid="partial-total"]'),
      ).not.toBeNull();
    });

    it('leaves a complete account and an account with no flags as they were', async () => {
      arrange([
        accountRow({ valuationComplete: true }),
        accountRow({ accountId: 'acc-2', accountName: 'Old Backend', unpricedHoldingsCount: undefined }),
      ]);
      render(<PortfolioValueReport />);
      await screen.findByText('Partial Brokerage');
      for (const name of ['Partial Brokerage', 'Old Backend']) {
        const row = rowFor(name);
        expect(row.querySelector('[data-testid="partial-total"]'), name).toBeNull();
        expect(row, name).toHaveTextContent('+$3000.00');
      }
    });

    it('writes no bare subtotal or bare gain into the exported breakdown table', async () => {
      const { exportToPdf } = await import('@/lib/pdf-export');
      (exportToPdf as any).mockClear();
      arrange([
        accountRow({ valuationComplete: false, missingRatePairs: ['USD->CAD'] }),
        accountRow({ accountId: 'acc-2', accountName: 'Whole Account', valuationComplete: true }),
      ]);
      render(<PortfolioValueReport />);
      await screen.findByText('Partial Brokerage');
      await act(async () => {
        fireEvent.click(screen.getByTestId('export-pdf'));
      });
      const call = (exportToPdf as any).mock.calls[0][0];
      const rows = call.additionalTables[0].rows as string[][];
      const partial = rows.find((r) => r[0] === 'Partial Brokerage')!;
      const whole = rows.find((r) => r[0] === 'Whole Account')!;
      expect(partial[1]).toMatch(/partial/i);
      expect(partial[3]).toMatch(/partial/i);
      // The gain is over the priced holdings only: printed, and suffixed.
      expect(partial[4]).toContain('+$3000.00');
      expect(partial[4]).toMatch(/partial/i);
      expect(whole[1]).not.toMatch(/partial/i);
      expect(whole[4]).toBe('+$3000.00');
    });
  });

  describe('an intraday point the server could not finish', () => {
    const plotted = () =>
      JSON.parse(
        screen.getByTestId('area-chart').getAttribute('data-points') ?? '[]',
      ) as Array<{ iso: string; Value: number | null }>;
    const kpi = (label: string) =>
      screen.getByText(label).parentElement!.textContent;

    it('plots it as null and withholds the extremes', async () => {
      mockDateRangeValue = '1w';
      mockGetIntradayValue.mockResolvedValue({
        points: [
          { timestamp: '2024-01-02T14:30:00Z', value: 9400, securitiesValue: 9400, fxComplete: true, pricesComplete: true, cashComplete: true },
          { timestamp: '2024-01-03T14:30:00Z', value: 120, securitiesValue: 120, fxComplete: false, pricesComplete: true, cashComplete: true },
          { timestamp: '2024-01-04T14:30:00Z', value: 9600, securitiesValue: 9600, fxComplete: true, pricesComplete: true, cashComplete: true },
        ],
        interval: '15m',
        currency: 'CAD',
        range: '1w',
        fetchedAt: new Date().toISOString(),
        skippedSymbols: [],
        failedSymbols: [],
        fallbackToDaily: false,
        fxComplete: false,
        pricesComplete: true,
        valuationComplete: false,
        missingRatePairs: ['EUR->CAD'],
        unpricedSecurityIds: [],
      });
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => expect(plotted()).toHaveLength(3));
      expect(plotted().map((p) => p.Value)).toEqual([9400, null, 9600]);
      expect(kpi('Highest Value')).not.toContain('$9600');
      expect(kpi('Lowest Value')).not.toContain('$120');
    });

    it('withholds the extremes of the by-security intraday breakdown', async () => {
      mockDateRangeValue = '1w';
      mockSeriesMode = 'securities';
      mockGetIntradayBreakdown.mockResolvedValue({
        series: [{ key: 'sec-1', type: 'security', symbol: 'VFV', name: 'VFV' }],
        points: [
          { timestamp: '2024-01-02T14:30:00Z', total: 40000, values: { 'sec-1': 40000 }, fxComplete: true, pricesComplete: true, cashComplete: true },
          { timestamp: '2024-01-03T14:30:00Z', total: 10, values: { 'sec-1': 10 }, fxComplete: true, pricesComplete: false, cashComplete: true },
          { timestamp: '2024-01-04T14:30:00Z', total: 50000, values: { 'sec-1': 50000 }, fxComplete: true, pricesComplete: true, cashComplete: true },
        ],
        interval: '15m',
        currency: 'CAD',
        range: '1w',
        fetchedAt: new Date().toISOString(),
        skippedSymbols: [],
        failedSymbols: [],
        fallbackToDaily: false,
        fxComplete: true,
        pricesComplete: false,
        valuationComplete: false,
        missingRatePairs: [],
        unpricedSecurityIds: ['sec-1'],
      });
      mockGetPortfolioSummary.mockResolvedValue(emptyPortfolio);
      mockGetInvestmentAccounts.mockResolvedValue([]);
      render(<PortfolioValueReport />);
      await waitFor(() => expect(mockGetIntradayBreakdown).toHaveBeenCalled());
      await waitFor(() => expect(kpi('Highest Value')).toContain('N/A'));
      expect(kpi('Lowest Value')).toContain('N/A');
    });
  });
});
