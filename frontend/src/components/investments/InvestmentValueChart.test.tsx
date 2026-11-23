import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { render, screen, waitFor, fireEvent, within } from '@/test/render';
import {
  InvestmentValueChart,
  INVESTMENT_CHART_REFRESH_EVENT,
} from './InvestmentValueChart';
import { netWorthApi } from '@/lib/net-worth';
import { investmentsApi } from '@/lib/investments';
import { useAuthStore } from '@/store/authStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import type { PortfolioPeriodResult } from '@/types/net-worth';

const dateRangeState = { dateRange: '1y', resolvedRange: { start: '2023-01-01', end: '2024-01-01' } };

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  // `data-points` carries the rows the chart was handed, so a test can see
  // what is plotted rather than only what the cards say.
  AreaChart: ({ children, margin, data }: any) => (
    <div
      data-testid="area-chart"
      data-margin={JSON.stringify(margin)}
      data-points={JSON.stringify(data ?? [])}
    >
      {children}
    </div>
  ),
  // Invoke the dot render-prop so the high/low value bubbles (and their dismiss
  // controls) are exercised; indices 0..2 cover both extremes of the test
  // series. Existing tests are unaffected -- the bubble labels use the compact
  // flag formatter (no decimals), distinct from the ".00" summary figures.
  Area: ({ dot }: any) =>
    typeof dot === 'function' ? (
      <div data-testid="line-dots">
        {dot({ cx: 10, cy: 20, index: 0 })}
        {dot({ cx: 30, cy: 40, index: 1 })}
        {dot({ cx: 50, cy: 60, index: 2 })}
      </div>
    ) : null,
  XAxis: () => null,
  YAxis: ({ width }: any) => <div data-testid="y-axis" data-width={width ?? ''} />,
  CartesianGrid: () => null,
  Tooltip: () => null,
  ReferenceDot: () => null,
}));

/** Toggle the useIsMobile media query for a single test. */
function setViewport(isMobile: boolean) {
  vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
    matches: query.includes('max-width') ? isMobile : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as MediaQueryList);
}

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatSignedPercent: (n: number, decimals = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`,
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
      formatCurrencyFlag: (n: number, _currency?: string) => `$${n}`,
    }),
  };
});
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
    convertToDefault: (amount: number) => amount,
    getRate: () => null,
  }),
}));

vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: dateRangeState.dateRange,
    setDateRange: vi.fn(),
    resolvedRange: dateRangeState.resolvedRange,
    isValid: true,
  }),
}));

vi.mock('@/lib/net-worth', () => ({
  netWorthApi: {
    getInvestmentsDaily: vi.fn().mockResolvedValue([
      { date: '2023-06-01', value: 10000 },
      { date: '2024-01-01', value: 15000 },
    ]),
    getInvestmentsMonthly: vi.fn().mockResolvedValue([]),
    getInvestmentsPeriodResult: vi.fn(),
  },
}));

/**
 * A period result as the server sends it: what the portfolio did over the
 * window, with the reader's own deposits reported separately. Nothing on the
 * client derives any of it from the plotted series (INV-PORTRESULT-001), so
 * every figure a card prints comes from here.
 */
function periodResult(
  overrides: Partial<PortfolioPeriodResult> = {},
): PortfolioPeriodResult {
  const base = {
    currency: 'CAD',
    startDate: '2023-06-01',
    startPriceDate: '2023-06-01',
    endDate: '2024-01-01',
    startValue: 10000,
    endValue: 15000,
    valueChange: 5000,
    netExternalFlows: 0,
    knownFlowSubtotal: 0,
    investmentResult: 5000,
    returnPercent: 50,
    returnMethod: 'simple' as const,
    complete: true,
    reasons: [],
    missingRatePairs: [],
    unpricedSecurityIds: [],
    unknownCashAccountIds: [],
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
}

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getIntradayValue: vi.fn().mockResolvedValue({
      points: [],
      interval: '1m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: false,
    }),
    getSecurities: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: (_key: string, initial: any) => [initial, vi.fn()],
}));

vi.mock('@/lib/utils', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const mockDateRangeSelectorProps = vi.fn();
vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: (props: any) => {
    mockDateRangeSelectorProps(props);
    return <div data-testid="date-range-selector" />;
  },
}));

describe('InvestmentValueChart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The chart caches its intraday response in sessionStorage; a leaked entry
    // hydrates the next test synchronously on mount and changes what it
    // exercises (frontend/CLAUDE.md, test isolation is every storage).
    try {
      window.sessionStorage.clear();
    } catch {
      // jsdom without sessionStorage: nothing to clear.
    }
    // The intraday cache key carries the signed-in identity (INV-SHARE-003).
    useAuthStore.setState({ user: { id: 'user-1' } as never, actingAsUserId: null });
    // A null store is the pre-load state, where the hook takes the default.
    usePreferencesStore.setState({ preferences: null });
    dateRangeState.dateRange = '1y';
    dateRangeState.resolvedRange = { start: '2023-01-01', end: '2024-01-01' };
    // 1y is a daily range, so mock getInvestmentsDaily
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
      { date: '2023-06-01', value: 10000 },
      { date: '2024-01-01', value: 15000 },
    ]);
    vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockResolvedValue(
      periodResult(),
    );
  });

  it('renders loading state initially', async () => {
    render(<InvestmentValueChart />);
    await waitFor(() => {
      expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
    });
  });

  it('renders title after data loads', async () => {
    render(<InvestmentValueChart />);
    const title = await screen.findByText('Portfolio Value Over Time');
    expect(title).toBeInTheDocument();
  });

  describe('the session the figures are measured from', () => {
    it('names it under the title, for every range', async () => {
      // Under the heading rather than behind a marker: it is a fact about
      // every window this chart draws, not a caveat about three of them.
      vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockResolvedValue(
        periodResult({ startDate: '2026-09-20', startPriceDate: '2026-09-18' }),
      );
      render(<InvestmentValueChart />);
      await screen.findByText('Portfolio Value Over Time');

      await waitFor(() =>
        expect(screen.getByTestId('measured-from-close')).toHaveTextContent(
          'Since the close of trading on Sep 18, 2026',
        ),
      );
    });

    it('dates the session, never the calendar day beside it', async () => {
      // A Monday 1D window opens on Sunday and carries Friday's close. The
      // boundary's own date names a day the market was shut.
      vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockResolvedValue(
        periodResult({ startDate: '2026-09-20', startPriceDate: '2026-09-18' }),
      );
      render(<InvestmentValueChart />);
      await screen.findByText('Portfolio Value Over Time');

      await waitFor(() =>
        expect(screen.getByTestId('measured-from-close')).toBeInTheDocument(),
      );
      expect(screen.getByTestId('measured-from-close')).not.toHaveTextContent(
        'Sep 20',
      );
      // And no marker to hover: the line replaced it.
      expect(screen.queryByText(/Measured from the previous trading day/)).toBeNull();
    });

    it('dates the opening point by that session, not by the boundary it was requested on', async () => {
      // 1Y on Monday 28 September 2026 is measured from Sunday the 28th a
      // year earlier, whose value is Friday the 26th's close. The series is
      // requested from the Sunday; its first point is shown as the Friday the
      // caption names, so the two cannot disagree about where the year opens.
      vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
        { date: '2025-09-28', value: 10000 },
        { date: '2025-09-29', value: 10100 },
        { date: '2026-09-28', value: 15000 },
      ]);
      vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockResolvedValue(
        periodResult({ startDate: '2025-09-28', startPriceDate: '2025-09-26' }),
      );
      render(<InvestmentValueChart />);
      await screen.findByText('Portfolio Value Over Time');

      await waitFor(() =>
        expect(screen.getByTestId('measured-from-close')).toHaveTextContent(
          'Since the close of trading on Sep 26, 2025',
        ),
      );
      const names = () =>
        JSON.parse(
          screen.getByTestId('area-chart').getAttribute('data-points') ?? '[]',
        ).map((p: { name: string }) => p.name);
      await waitFor(() =>
        expect(names()).toEqual(['Sep 26, 2025', 'Sep 29, 2025', 'Sep 28, 2026']),
      );
    });

    it('says nothing when the server could not name a session', async () => {
      vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockResolvedValue(
        periodResult({ startPriceDate: null }),
      );
      render(<InvestmentValueChart />);
      await screen.findByText('Portfolio Value Over Time');

      expect(screen.queryByTestId('measured-from-close')).toBeNull();
    });
  });

  it('links to the full Portfolio Value report', async () => {
    render(<InvestmentValueChart />);
    const link = await screen.findByRole('link', { name: /View report/i });
    expect(link).toHaveAttribute('href', '/reports/portfolio-value');
  });

  it('renders summary cards after data loads', async () => {
    render(<InvestmentValueChart />);
    const highest = await screen.findByText('Highest Value');
    expect(highest).toBeInTheDocument();
    expect(screen.getByText('Lowest Value')).toBeInTheDocument();
    expect(screen.getByText('Investment Result')).toBeInTheDocument();
    expect(screen.getByText('Return')).toBeInTheDocument();
  });

  it('renders the chart component after data loads', async () => {
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  it('temporarily hides a value bubble when its dismiss control is clicked', async () => {
    const { container } = render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    const labels = () =>
      Array.from(
        container.querySelectorAll('[data-testid="line-dots"] text'),
      ).map((node) => node.textContent);
    // highest=15000 (index 1), lowest=10000 (index 0) -> a bubble each.
    await waitFor(() => {
      expect(labels()).toEqual(expect.arrayContaining(['$10000', '$15000']));
    });

    const closeControls = container.querySelectorAll('.chart-flag-dismiss');
    expect(closeControls).toHaveLength(2);
    // The second control belongs to the high bubble (dot index 1).
    await act(async () => {
      fireEvent.click(closeControls[1]);
    });

    expect(labels()).toContain('$10000');
    expect(labels()).not.toContain('$15000');
  });

  it('uses generous chart margins on desktop', async () => {
    setViewport(false);
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    const margin = JSON.parse(
      screen.getByTestId('area-chart').getAttribute('data-margin') || '{}',
    );
    expect(margin).toEqual({ top: 30, right: 30, left: 0, bottom: 30 });
    // Default YAxis width (no explicit override) on desktop.
    expect(screen.getByTestId('y-axis').getAttribute('data-width')).toBe('');
  });

  it('reclaims wasted space with tighter margins on mobile', async () => {
    setViewport(true);
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    const margin = JSON.parse(
      screen.getByTestId('area-chart').getAttribute('data-margin') || '{}',
    );
    expect(margin).toEqual({ top: 16, right: 8, left: 0, bottom: 8 });
    // Narrower YAxis gutter on mobile.
    expect(screen.getByTestId('y-axis').getAttribute('data-width')).toBe('44');
  });

  it('displays computed summary values', async () => {
    const card = (label: string) =>
      screen.getByText(label).parentElement!.parentElement!.textContent;
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    // highest=15000, lowest=10000 are the series' own extremes; the value
    // change, the result and its percent are the server's, and what separates
    // the result from the change is named on the secondary lines.
    expect(screen.getByText('$15000.00')).toBeInTheDocument();
    expect(screen.getByText('$10000.00')).toBeInTheDocument();
    // The period figures are second-stage: the request cannot be made until
    // the series is on screen, so wait for it rather than for the title.
    await waitFor(() =>
      expect(card('Investment Result')).toContain('+$5000.00'),
    );
    expect(screen.getByText('+50.0%')).toBeInTheDocument();
    // Its own card, between Lowest Value and Investment Result, and no longer
    // repeated beneath the result.
    expect(screen.getByTestId('period-value-change')).toHaveTextContent('+$5000.00');
    expect(card('Investment Result')).not.toContain('Value change');
    const cards = card('Lowest Value')!;
    expect(cards.indexOf('Lowest Value')).toBeLessThan(cards.indexOf('Value Change'));
    expect(cards.indexOf('Value Change')).toBeLessThan(
      cards.indexOf('Investment Result'),
    );
    expect(screen.getByTestId('period-net-invested')).toHaveTextContent(
      'Net invested +$0.00',
    );
    expect(screen.getByTestId('period-income')).toHaveTextContent(
      'Dividends and interest +$0.00',
    );
  });

  /**
   * The value change is the line's own: the securities' last close less their
   * first. The account's change, which holds a late cash deposit, is a
   * different figure and is not the one printed under this chart.
   */
  it("reads the value change off the securities line, not the account's", async () => {
    vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockResolvedValue(
      periodResult({
        startValue: 10_000,
        endValue: 60_800,
        valueChange: 50_800,
        netExternalFlows: 50_000,
        investmentResult: 800,
        investedValueChange: 800,
        investmentCapitalFlows: 0,
        investmentIncome: 0,
        investmentPnl: 800,
        investmentReturnPercent: 10,
      }),
    );
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');

    await waitFor(() =>
      expect(screen.getByTestId('period-value-change')).toHaveTextContent(
        '+$800.00',
      ),
    );
    expect(screen.getByTestId('period-value-change')).not.toHaveTextContent(
      '50800',
    );
  });

  /**
   * The chart draws the INVESTED value, so a cash deposit with nothing bought
   * plots zero rather than the deposit, and the result and return beside it are
   * the invested part's: a `totalValue` series would draw the reader's own
   * money as portfolio growth (INV-PORTRESULT-002).
   */
  it('plots the invested value and reads the invested figures', async () => {
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
      { date: '2023-06-01', value: 10000, securitiesValue: 0 },
      { date: '2024-01-01', value: 10000, securitiesValue: 0 },
    ] as never);
    vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockResolvedValue(
      periodResult({
        startValue: 10000,
        endValue: 10000,
        valueChange: 0,
        investmentResult: 0,
        returnPercent: 0,
        investmentPnl: 0,
        investmentReturnPercent: 0,
      }),
    );

    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');

    // Both extremes are the invested value: a cash-only scope holds zero.
    await waitFor(() =>
      expect(screen.getAllByText('$0.00').length).toBeGreaterThan(0),
    );
    expect(screen.queryByText('$10000.00')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('+0.0%')).toBeInTheDocument());
  });

  it('prefers the invested figures over the account-level ones', async () => {
    vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockResolvedValue(
      periodResult({
        investmentResult: 5000,
        returnPercent: 50,
        investmentPnl: 4000,
        investmentReturnPercent: 40,
      }),
    );

    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');

    await waitFor(() =>
      expect(screen.getByText('+$4000.00')).toBeInTheDocument(),
    );
    expect(screen.getByText('+40.0%')).toBeInTheDocument();
    expect(screen.queryByText('+50.0%')).not.toBeInTheDocument();
  });

  it('shows no data message when API returns empty', async () => {
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([]);
    render(<InvestmentValueChart />);
    const msg = await screen.findByText('No investment data for this period.');
    expect(msg).toBeInTheDocument();
  });

  it('handles API failure gracefully', async () => {
    vi.mocked(netWorthApi.getInvestmentsDaily).mockRejectedValue(new Error('Network error'));
    render(<InvestmentValueChart />);
    const msg = await screen.findByText('No investment data for this period.');
    expect(msg).toBeInTheDocument();
  });

  it('passes accountIds to API when provided', async () => {
    render(<InvestmentValueChart accountIds={['acc-1', 'acc-2']} />);
    await screen.findByText('Portfolio Value Over Time');
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith(
        expect.objectContaining({
          accountIds: 'acc-1,acc-2',
        })
      )
    );
  });

  it('does not pass accountIds when empty array', async () => {
    render(<InvestmentValueChart accountIds={[]} />);
    await screen.findByText('Portfolio Value Over Time');
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith(
        expect.objectContaining({
          accountIds: undefined,
        })
      )
    );
  });

  it('passes date filter ranges including mtd between 1w and 1m to DateRangeSelector', async () => {
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    const lastCall = mockDateRangeSelectorProps.mock.calls[mockDateRangeSelectorProps.mock.calls.length - 1][0];
    expect(lastCall.ranges).toEqual(['1d', '1w', 'mtd', '1m', '3m', 'ytd', '1y', '2y', '5y', 'all']);
  });

  it('uses intraday API for mtd range, served on its own window', async () => {
    dateRangeState.dateRange = 'mtd';
    dateRangeState.resolvedRange = { start: '2024-01-01', end: '2024-01-15' };
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [
        { timestamp: '2024-01-01T14:30:00.000Z', value: 9500 },
        { timestamp: '2024-01-10T14:30:00.000Z', value: 9700 },
      ],
      interval: '15m',
      currency: 'CAD',
      range: '1m',
      fetchedAt: '2024-01-15T15:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: false,
    });
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    await waitFor(() =>
      expect(investmentsApi.getIntradayValue).toHaveBeenCalledWith(
        expect.objectContaining({ range: 'mtd' }),
      )
    );
    // MTD reports against the previous close, so the last day of the previous
    // month goes out as the period's baseline. Nothing is valued twice: the
    // daily endpoint is not reached at all.
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith(
        expect.objectContaining({ baselineDate: '2023-12-31' }),
      )
    );
    expect(netWorthApi.getInvestmentsDaily).not.toHaveBeenCalled();
  });

  it('plots the mtd series as the server shaped it, opening close included', async () => {
    dateRangeState.dateRange = 'mtd';
    dateRangeState.resolvedRange = { start: '2024-01-01', end: '2024-01-15' };
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [
        // The server opens the month on the previous session's closing
        // point, which the month is measured from (issue #1461).
        { timestamp: '2023-12-29T21:00:00.000Z', value: 8000, sessionClose: true },
        { timestamp: '2024-01-02T14:30:00.000Z', value: 9000 },
        { timestamp: '2024-01-10T14:30:00.000Z', value: 10000 },
      ],
      interval: '15m',
      currency: 'CAD',
      range: 'mtd',
      fetchedAt: '2024-01-15T15:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: false,
    });
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(screen.getByText('$10000.00')).toBeInTheDocument();
    // The opening close is on the chart: nothing here trims it away.
    expect(screen.getByText('$8000.00')).toBeInTheDocument();
  });

  // Range-boundary regression (issue #UI-03, part 3): the first plotted point
  // must use the same historical valuation rules as the rest of the series. A
  // prior-close value is a baseline for the Change stat, never a chart point, so
  // it must not leak into the plotted series and corrupt highest/lowest/change.
  describe('range boundary: no artificial first-point spike', () => {
    it('3M plots the daily series verbatim, measured from its first point', async () => {
      dateRangeState.dateRange = '3m';
      dateRangeState.resolvedRange = { start: '2024-06-09', end: '2024-09-09' };
      // A first point that is neither the highest nor the lowest: a prepended
      // live/current value would show up as a new extreme.
      vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
        { date: '2024-06-09', value: 10000 },
        { date: '2024-08-01', value: 12000 },
        { date: '2024-09-09', value: 11000 },
      ]);
      render(<InvestmentValueChart />);
      await screen.findByText('Portfolio Value Over Time');
      // Highest/lowest are exactly the series' own extremes -- no extra point.
      expect(screen.getByText('$12000.00')).toBeInTheDocument();
      expect(screen.getByText('$10000.00')).toBeInTheDocument();
      // The window this chart DRAWS opens a day before the quarter so the
      // first plotted close precedes it. The period is NAMED, so the figures
      // are measured over the quarter the button says and agree with the
      // performance card beside them.
      await waitFor(() =>
        expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith({
          period: '3m',
          accountIds: undefined,
          displayCurrency: undefined,
        }),
      );
      // Only the chart's own daily request -- the period is the server's.
      await waitFor(() =>
        expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledTimes(1),
      );
    });

    it('1W plots the intraday series and names its period to the server', async () => {
      dateRangeState.dateRange = '1w';
      dateRangeState.resolvedRange = { start: '2024-09-02', end: '2024-09-09' };
      vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
        points: [
          { timestamp: '2024-09-02T13:30:00.000Z', value: 20000 },
          { timestamp: '2024-09-05T20:00:00.000Z', value: 21000 },
        ],
        interval: '15m',
        currency: 'CAD',
        range: '1w',
        fetchedAt: '2024-09-09T15:00:00.000Z',
        skippedSymbols: [],
        failedSymbols: [],
        fallbackToDaily: false,
      });
      vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockResolvedValue(
        periodResult({ investmentResult: 2000, returnPercent: 10.5 }),
      );
      render(<InvestmentValueChart />);
      await screen.findByText('Portfolio Value Over Time');
      // Highest/lowest are the intraday extremes only.
      expect(screen.getByText('$21000.00')).toBeInTheDocument();
      expect(screen.getByText('$20000.00')).toBeInTheDocument();
      // The result is the server's, measured from the prior close. The request
      // is second-stage (it cannot fire until the first point is known), so
      // wait for it rather than the static title.
      await waitFor(() =>
        expect(screen.getByText('+$2000.00')).toBeInTheDocument(),
      );
      await waitFor(() =>
        expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith(
          expect.objectContaining({ period: '1w' }),
        ),
      );
      // The daily endpoint is never reached: the chart draws intraday points
      // and the period comes from its own endpoint.
      expect(netWorthApi.getInvestmentsDaily).not.toHaveBeenCalled();
    });
  });

  it('shows a negative result and its percent correctly', async () => {
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
      { date: '2023-06-01', value: 20000 },
      { date: '2024-01-01', value: 15000 },
    ]);
    vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockResolvedValue(
      periodResult({
        valueChange: -5000,
        investmentResult: -5000,
        returnPercent: -25,
      }),
    );
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(screen.getByText('$15000.00')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText('-25.0%')).toBeInTheDocument(),
    );
  });

  it('uses daily API for 1y range (DAILY_RANGES)', async () => {
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalled()
    );
    expect(netWorthApi.getInvestmentsMonthly).not.toHaveBeenCalled();
  });

  it('uses daily API for 2y range (DAILY_RANGES)', async () => {
    dateRangeState.dateRange = '2y';
    dateRangeState.resolvedRange = { start: '2022-01-01', end: '2024-01-01' };
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalled()
    );
    expect(netWorthApi.getInvestmentsMonthly).not.toHaveBeenCalled();
  });

  it('uses intraday API for 1d range', async () => {
    dateRangeState.dateRange = '1d';
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [
        { timestamp: '2024-01-02T14:30:00.000Z', value: 9500 },
        { timestamp: '2024-01-02T14:31:00.000Z', value: 9600 },
      ],
      interval: '1m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: false,
    });
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    await waitFor(() =>
      expect(investmentsApi.getIntradayValue).toHaveBeenCalledWith(
        expect.objectContaining({ range: '1d' }),
      )
    );
    // As above: the period is NAMED, so the server measures the day rather
    // than the week `resolveRangePreset('1d')` widened the drawn window to,
    // and the daily endpoint is not reached for it.
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith(
        expect.objectContaining({ period: '1d' }),
      )
    );
    expect(netWorthApi.getInvestmentsDaily).not.toHaveBeenCalled();
  });

  describe('the period result the cards print', () => {
    /** Text of the summary card carrying `label`. */
    const card = (label: string) =>
      screen.getByText(label).parentElement!.parentElement!.textContent;

    const intraday = (points: Array<{ timestamp: string; value: number }>) => ({
      points,
      interval: '15m' as const,
      currency: 'CAD',
      range: '1d' as const,
      fetchedAt: '2024-01-15T15:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: false,
    });

    /**
     * The issue's reproduction (#1392): two deposits of 10,000 with a price
     * that never moves. The series doubles and the market did nothing, so the
     * headline is the server's result of 0 / 0% -- and the +10,000 the reader
     * put in is on the secondary line, never under the result's caption.
     */
    it('prints the investment result, with the value change beside it', async () => {
      dateRangeState.dateRange = '1y';
      vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
        { date: '2026-01-02', value: 10000 },
        { date: '2026-06-01', value: 20000 },
      ]);
      vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockResolvedValue(
        periodResult({
          startValue: 10000,
          endValue: 20000,
          valueChange: 10000,
          netExternalFlows: 10000,
          knownFlowSubtotal: 10000,
          investmentResult: 0,
          returnPercent: 0,
          // The deposit was invested at once: the line rose by what was paid
          // into it, which is capital, not a result.
          investedValueChange: 10000,
          investmentCapitalFlows: 10000,
        }),
      );
      render(<InvestmentValueChart />);
      await screen.findByText('Portfolio Value Over Time');

      await waitFor(() =>
        expect(card('Investment Result')).toContain('+$0.00'),
      );
      expect(card('Return')).toContain('+0.0%');
      // The deposit is reported as what it is, and never as performance.
      expect(screen.getByTestId('period-value-change')).toHaveTextContent(
        '+$10000.00',
      );
      expect(screen.getByTestId('period-net-invested')).toHaveTextContent(
        'Net invested +$10000.00',
      );
      expect(card('Return')).not.toContain('100.0%');
    });

    it('asks for the 1w period against the close before the week shown', async () => {
      dateRangeState.dateRange = '1w';
      dateRangeState.resolvedRange = { start: '2024-01-08', end: '2024-01-15' };
      vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue(
        intraday([
          { timestamp: '2024-01-08T14:30:00.000Z', value: 10000 },
          { timestamp: '2024-01-15T14:30:00.000Z', value: 11000 },
        ]),
      );
      vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockResolvedValue(
        periodResult({ investmentResult: 2000, returnPercent: 22.2 }),
      );
      render(<InvestmentValueChart />);
      await screen.findByText('Portfolio Value Over Time');

      await waitFor(() =>
        expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith(
          expect.objectContaining({ period: '1w' }),
        ),
      );
      // Never the drawn window's dates: the server resolves the week.
      expect(netWorthApi.getInvestmentsPeriodResult).not.toHaveBeenCalledWith(
        expect.objectContaining({ startDate: '2024-01-08' }),
      );
      await waitFor(() =>
        expect(card('Investment Result')).toContain('+$2000.00'),
      );
      // Not the change from the first point plotted, which is what this
      // measured before and would still read as plausible.
      expect(card('Investment Result')).not.toContain('+$1000.00');
      expect(card('Return')).toContain('+22.2%');
    });

    it('asks for the mtd period against the close before the month started', async () => {
      dateRangeState.dateRange = 'mtd';
      dateRangeState.resolvedRange = { start: '2024-02-01', end: '2024-02-15' };
      vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue(
        intraday([
          { timestamp: '2024-02-01T14:30:00.000Z', value: 10000 },
          { timestamp: '2024-02-15T14:30:00.000Z', value: 10500 },
        ]),
      );
      render(<InvestmentValueChart />);
      await screen.findByText('Portfolio Value Over Time');

      await waitFor(() =>
        expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith(
          expect.objectContaining({ baselineDate: '2024-01-31' }),
        ),
      );
    });

    it('asks for the 1d period against the previous session, not the open', async () => {
      dateRangeState.dateRange = '1d';
      dateRangeState.resolvedRange = { start: '2024-01-08', end: '2024-01-15' };
      vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue(
        intraday([
          { timestamp: '2024-01-15T14:30:00.000Z', value: 10000 },
          { timestamp: '2024-01-15T20:00:00.000Z', value: 10200 },
        ]),
      );
      vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockResolvedValue(
        periodResult({
          valueChange: -200,
          investmentResult: -200,
          returnPercent: -1.9,
        }),
      );
      render(<InvestmentValueChart />);
      await screen.findByText('Portfolio Value Over Time');

      // Up 200 since the open, down 200 against the previous close: the two
      // answers have opposite signs, so only one of them can be on screen.
      // And never a week: `resolveRangePreset('1d')` hands the chart a
      // seven-day window to DRAW, which is not the period to measure.
      await waitFor(() =>
        expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith({
          period: '1d',
          accountIds: undefined,
          displayCurrency: undefined,
        }),
      );
      expect(netWorthApi.getInvestmentsPeriodResult).not.toHaveBeenCalledWith(
        expect.objectContaining({ startDate: '2024-01-08' }),
      );
      await waitFor(() =>
        expect(card('Investment Result')).toContain('-200.00'),
      );
      expect(card('Investment Result')).not.toContain('+$200.00');
      expect(card('Return')).toContain('-1.9%');
    });

    it('leaves every figure unknown when the period request fails', async () => {
      dateRangeState.dateRange = '1w';
      dateRangeState.resolvedRange = { start: '2024-01-08', end: '2024-01-15' };
      vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue(
        intraday([
          { timestamp: '2024-01-08T14:30:00.000Z', value: 10000 },
          { timestamp: '2024-01-15T14:30:00.000Z', value: 11000 },
        ]),
      );
      vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockRejectedValue(
        new Error('period unavailable'),
      );
      render(<InvestmentValueChart />);
      await screen.findByText('Portfolio Value Over Time');

      // A failed request is not a period that did nothing, and not the
      // series' own move wearing the result's caption.
      await waitFor(() =>
        expect(screen.getAllByTestId('unknown-amount').length).toBe(3),
      );
      expect(card('Investment Result')).not.toContain('$1000.00');
      expect(card('Investment Result')).not.toContain('$0.00');
      expect(screen.getByTestId('period-value-change')).not.toHaveTextContent('$');
    });

    it('marks a withheld result with the cause the server gave', async () => {
      vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockResolvedValue(
        periodResult({
          valueChange: null,
          netExternalFlows: null,
          investmentResult: null,
          returnPercent: null,
          complete: false,
          reasons: ['incompletePrices'],
          unpricedSecurityIds: ['sec-1'],
        }),
      );
      render(<InvestmentValueChart />);
      await screen.findByText('Portfolio Value Over Time');

      await waitFor(() =>
        expect(screen.getAllByTestId('unknown-amount').length).toBe(3),
      );
      // An unpriced holding is a price to add, not a rate to refresh.
      expect(
        screen.getAllByLabelText(/the security has no price to value them at/)
          .length,
      ).toBeGreaterThan(0);
      expect(card('Investment Result')).not.toContain('+$5000.00');
    });

    it('names a long range rather than sending the window it drew', async () => {
      // 1Y draws from the day BEFORE the anniversary so the first plotted
      // close precedes the year. That is the line's window, not the figure's.
      render(<InvestmentValueChart />);
      await screen.findByText('Portfolio Value Over Time');
      await waitFor(() =>
        expect(card('Investment Result')).toContain('+$5000.00'),
      );
      await waitFor(() =>
        expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith({
          period: '1y',
          accountIds: undefined,
          displayCurrency: undefined,
        }),
      );
      // One call, for the chart itself.
      await waitFor(() =>
        expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledTimes(1),
      );
      await waitFor(() =>
        expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith(
          expect.objectContaining({ endDate: '2024-01-01' }),
        ),
      );
    });

    /**
     * The series is requested from the day the server measures 1Y from: the
     * same day a year earlier (`presetEarliestDate`), not the month-aligned
     * start `useDateRange` resolved and not the day before the anniversary,
     * which is where the chart used to open while the figures under it were
     * measured from a day later (issue #1461). The clock is pinned because
     * otherwise this is a test about the day it ran.
     */
    it('opens 1Y on the anniversary the figures are measured from, not on useDateRange start', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 7, 12));
      try {
        render(<InvestmentValueChart />);
        // Not `vi.waitFor`: it polls outside act, so the state the response
        // sets commits outside it and the assertions below read a tree React
        // has not finished with. Draining the fake clock inside `act` settles
        // the request and its render together. RTL's own `waitFor` is not the
        // way out either -- it cannot drive Vitest's fake timers.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        // Bare, not `waitFor`: the fake clock is still installed here and RTL's
        // `waitFor` cannot drive it, so it would hang until the test times out.
        // The act-wrapped drain above is this assertion's barrier.
        expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
      await waitFor(() =>
        expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith(
          expect.objectContaining({ startDate: '2025-08-12' }),
        )
      );
    });
  });

  it('shows the unavailable note on 1d when providers are mixed', async () => {
    dateRangeState.dateRange = '1d';
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [],
      interval: '1m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: ['VFV.TO'],
      failedSymbols: [],
      fallbackToDaily: true,
    });
    render(<InvestmentValueChart />);
    expect(
      await screen.findByText(/Intraday view unavailable/i),
    ).toBeInTheDocument();
  });

  it('falls back to the daily endpoint on 1w when fallbackToDaily=true', async () => {
    dateRangeState.dateRange = '1w';
    dateRangeState.resolvedRange = { start: '2023-12-25', end: '2024-01-01' };
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [],
      interval: '5m',
      currency: 'CAD',
      range: '1w',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: ['VFV.TO'],
      failedSymbols: [],
      fallbackToDaily: true,
    });
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    await waitFor(() => {
      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalled();
    });
  });

  it('shows a background-load indicator when refetching with data already on screen', async () => {
    let resolveDaily: (value: any) => void = () => {};
    vi.mocked(netWorthApi.getInvestmentsDaily).mockImplementationOnce(() =>
      Promise.resolve([
        { date: '2023-06-01', value: 10000 },
        { date: '2024-01-01', value: 15000 },
      ]),
    );
    const { rerender } = render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');

    // Trigger a second load that hangs so we can observe the indicator.
    vi.mocked(netWorthApi.getInvestmentsDaily).mockImplementationOnce(
      () => new Promise((resolve) => { resolveDaily = resolve; }),
    );
    dateRangeState.dateRange = '3m';
    dateRangeState.resolvedRange = { start: '2023-10-01', end: '2024-01-01' };
    rerender(<InvestmentValueChart />);

    const indicator = await screen.findByTestId('chart-loading-indicator');
    expect(indicator).toBeInTheDocument();

    resolveDaily([{ date: '2023-12-01', value: 12000 }]);
    await waitFor(() => {
      expect(screen.queryByTestId('chart-loading-indicator')).toBeNull();
    });
  });

  it('silently falls back to daily on 1w when the intraday request rejects', async () => {
    dateRangeState.dateRange = '1w';
    dateRangeState.resolvedRange = { start: '2023-12-25', end: '2024-01-01' };
    vi.mocked(investmentsApi.getIntradayValue).mockRejectedValue(
      new Error('Network error'),
    );
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
      { date: '2023-12-25', value: 8000 },
      { date: '2024-01-01', value: 9000 },
    ]);
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    await waitFor(() => {
      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('intraday-error-banner')).toBeNull();
    expect(screen.getByText('$9000.00')).toBeInTheDocument();
  });

  it('silently falls back to daily on 1d when the intraday request rejects', async () => {
    dateRangeState.dateRange = '1d';
    dateRangeState.resolvedRange = { start: '2024-01-01', end: '2024-01-02' };
    vi.mocked(investmentsApi.getIntradayValue).mockRejectedValue(
      new Error('500 Internal Server Error'),
    );
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
      { date: '2024-01-01', value: 7777 },
    ]);
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    await waitFor(() => {
      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('intraday-error-banner')).toBeNull();
  });

  it('shows a warning icon next to the title when 1w falls back to daily', async () => {
    dateRangeState.dateRange = '1w';
    dateRangeState.resolvedRange = { start: '2023-12-25', end: '2024-01-01' };
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [],
      interval: '5m',
      currency: 'CAD',
      range: '1w',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: ['VFV.TO'],
      failedSymbols: [],
      fallbackToDaily: true,
    });
    render(<InvestmentValueChart />);
    const warning = await screen.findByTestId('intraday-fallback-warning');
    expect(warning).toBeInTheDocument();
    const help = within(warning).getByRole('button').getAttribute('aria-label');
    expect(help).toContain('VFV.TO');
    expect(help).toContain('MSN Money');
    expect(warning.querySelector('[title]')).toBeNull();
  });

  it('does not show the warning icon when intraday data is fully available', async () => {
    dateRangeState.dateRange = '1w';
    dateRangeState.resolvedRange = { start: '2023-12-25', end: '2024-01-01' };
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [{ timestamp: '2024-01-02T14:30:00.000Z', value: 9500 }],
      interval: '5m',
      currency: 'CAD',
      range: '1w',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: false,
    });
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(screen.queryByTestId('intraday-fallback-warning')).toBeNull();
  });

  it('clears intraday cache and re-fetches when refresh event fires on 1d', async () => {
    dateRangeState.dateRange = '1d';
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [{ timestamp: '2024-01-02T14:30:00.000Z', value: 9500 }],
      interval: '1m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: false,
    });
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    const initialCalls = vi.mocked(investmentsApi.getIntradayValue).mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event(INVESTMENT_CHART_REFRESH_EVENT));
    });
    await waitFor(() => {
      expect(
        vi.mocked(investmentsApi.getIntradayValue).mock.calls.length,
      ).toBeGreaterThan(initialCalls);
    });
  });

  // Issue #1190. The chart fetches on mount and on a range or currency change,
  // so a write elsewhere on the page -- a cash deposit, a trade -- moved today's
  // point with nothing to tell the chart. `refreshKey` is that signal.
  describe('refreshKey', () => {
    it('re-fetches a daily range when the key is bumped', async () => {
      const { rerender } = render(<InvestmentValueChart refreshKey={0} />);
      await screen.findByText('Portfolio Value Over Time');
      const before = vi.mocked(netWorthApi.getInvestmentsDaily).mock.calls.length;

      await act(async () => {
        rerender(<InvestmentValueChart refreshKey={1} />);
      });

      await waitFor(() => {
        expect(
          vi.mocked(netWorthApi.getInvestmentsDaily).mock.calls.length,
        ).toBeGreaterThan(before);
      });
    });

    // The automatic price refresh bumps the key every 15 minutes while a market
    // is open: a dimmed chart and an "Updating" label each time would be the
    // one visible trace of a refresh that is meant to be invisible.
    it('re-fetches without marking the drawn chart as loading', async () => {
      const { rerender } = render(<InvestmentValueChart refreshKey={0} />);
      await screen.findByText('Portfolio Value Over Time');
      let answer: (rows: unknown) => void = () => {};
      vi.mocked(netWorthApi.getInvestmentsDaily).mockImplementationOnce(
        () => new Promise((resolve) => { answer = resolve; }) as any,
      );

      await act(async () => {
        rerender(<InvestmentValueChart refreshKey={1} />);
      });

      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('chart-loading-indicator')).toBeNull();
      expect(document.querySelector('.opacity-60')).toBeNull();

      await act(async () => {
        answer([
          { date: '2023-06-01', value: 10000 },
          { date: '2024-01-01', value: 16000 },
        ]);
      });
      expect(screen.queryByTestId('chart-loading-indicator')).toBeNull();
    });

    // The intraday series is served from sessionStorage, so a re-fetch that
    // trusted the cache would hand back the pre-write points.
    it('drops the intraday cache and re-fetches when the key is bumped', async () => {
      dateRangeState.dateRange = '1d';
      vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
        points: [{ timestamp: '2024-01-02T15:00:00.000Z', value: 9000 }],
        interval: '1m',
        currency: 'CAD',
        range: '1d',
        fetchedAt: '2024-01-02T15:00:00.000Z',
        skippedSymbols: [],
        failedSymbols: [],
        fallbackToDaily: false,
      });

      const { rerender } = render(<InvestmentValueChart refreshKey={0} />);
      await screen.findByText('Portfolio Value Over Time');
      await waitFor(() =>
        expect(window.sessionStorage.getItem('monize-intraday|u:user-1|a:self|1d||CAD')).toBeTruthy(),
      );
      const before = vi.mocked(investmentsApi.getIntradayValue).mock.calls.length;

      await act(async () => {
        rerender(<InvestmentValueChart refreshKey={1} />);
      });

      await waitFor(() => {
        expect(
          vi.mocked(investmentsApi.getIntradayValue).mock.calls.length,
        ).toBeGreaterThan(before);
      });
    });

    // Mounting under a key that is already non-zero is not a write: the initial
    // fetch belongs to the load effect, and firing here as well would double
    // every request the chart makes on an account switch.
    it('does not fetch twice when mounted under a non-zero key', async () => {
      render(<InvestmentValueChart refreshKey={4} />);
      await screen.findByText('Portfolio Value Over Time');

      await waitFor(() =>
        expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledTimes(1),
      );
    });

    // A range change already re-fetches through the load effect. Were the
    // write-refresh effect to depend on the loader it would fetch again for the
    // same change.
    it('does not fetch twice when only the range changes', async () => {
      const { rerender } = render(<InvestmentValueChart refreshKey={2} />);
      await screen.findByText('Portfolio Value Over Time');
      dateRangeState.dateRange = '3m';
      dateRangeState.resolvedRange = { start: '2023-10-01', end: '2024-01-01' };

      await act(async () => {
        rerender(<InvestmentValueChart refreshKey={2} titleSuffix="RRSP" />);
      });

      await waitFor(() =>
        expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledTimes(2),
      );
    });
  });

  it('samples the daily series at month-ends for 5y (not in DAILY_RANGES)', async () => {
    dateRangeState.dateRange = '5y';
    dateRangeState.resolvedRange = { start: '2019-01-01', end: '2024-01-01' };
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
      { date: '2019-01-01', value: 1000 },
      { date: '2019-01-31', value: 1500 },
      { date: '2024-01-01', value: 2000 },
    ]);
    vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockResolvedValue(
      periodResult({ startDate: '2019-01-01', startPriceDate: '2018-12-31' }),
    );
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith(
        expect.objectContaining({ sampling: 'monthEnd' }),
      ),
    );
    expect(netWorthApi.getInvestmentsMonthly).not.toHaveBeenCalled();
    // The line opens on the close the figures are measured from, named by the
    // session it came from; the month-end between is named by its month and
    // the last point by its own day.
    await waitFor(() => {
      const points = JSON.parse(
        screen.getByTestId('area-chart').getAttribute('data-points')!,
      ) as Array<{ name: string; iso: string }>;
      expect(points.map((p) => p.name)).toEqual([
        'Dec 31, 2018',
        'Jan 2019',
        'Jan 1, 2024',
      ]);
    });
  });

  it('renders titleSuffix when provided', async () => {
    render(<InvestmentValueChart titleSuffix="My Account" />);
    const title = await screen.findByText('Portfolio Value Over Time (My Account)');
    expect(title).toBeInTheDocument();
  });

  it('does not append suffix text when titleSuffix is omitted', async () => {
    render(<InvestmentValueChart />);
    const title = await screen.findByText('Portfolio Value Over Time');
    expect(title.textContent).not.toContain('(');
  });

  it('passes displayCurrency to API when it differs from defaultCurrency', async () => {
    render(<InvestmentValueChart displayCurrency="USD" />);
    await screen.findByText('Portfolio Value Over Time');
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith(
        expect.objectContaining({ displayCurrency: 'USD' }),
      )
    );
  });

  it('does not pass displayCurrency to API when it matches defaultCurrency', async () => {
    render(<InvestmentValueChart displayCurrency="CAD" />);
    await screen.findByText('Portfolio Value Over Time');
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith(
        expect.objectContaining({ displayCurrency: undefined }),
      )
    );
  });

  it('formats values with foreign currency label when displayCurrency differs', async () => {
    render(<InvestmentValueChart displayCurrency="USD" />);
    await screen.findByText('Portfolio Value Over Time');
    // fmtFull includes the currency code when foreignCurrency is set
    expect(screen.getByText('$15000.00 USD')).toBeInTheDocument();
  });

  it('reports no percentage when the period started at nothing', async () => {
    // A move away from nothing has no percentage: 0% would say the portfolio
    // held its ground. The server decides that (reason `zeroStart`) and still
    // reports the money, which is a known zero rather than an unknown.
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
      { date: '2023-06-01', value: 0 },
      { date: '2024-01-01', value: 0 },
    ]);
    vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockResolvedValue(
      periodResult({
        startValue: 0,
        endValue: 0,
        valueChange: 0,
        investmentResult: 0,
        returnPercent: null,
        complete: true,
        reasons: ['zeroStart'],
      }),
    );
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    await waitFor(() =>
      expect(screen.getByTestId('unknown-amount')).toBeInTheDocument(),
    );
    expect(screen.queryByText('+0.0%')).toBeNull();
    // The value change and the result are both known zeros, not unknowns.
    expect(screen.getAllByText('+$0.00')).toHaveLength(2);
  });

  it('shows empty chart message with skipped symbols in intradayUnavailable state', async () => {
    dateRangeState.dateRange = '1d';
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [],
      interval: '1m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: ['AAPL', 'MSFT'],
      failedSymbols: [],
      fallbackToDaily: true,
    });
    render(<InvestmentValueChart />);
    const msg = await screen.findByText(/Intraday view unavailable/i);
    expect(msg).toBeInTheDocument();
    // skipped symbols list should appear in the description
    expect(screen.getByText(/AAPL, MSFT/)).toBeInTheDocument();
  });

  it('shows empty chart message without symbol list when skippedSymbols is empty', async () => {
    dateRangeState.dateRange = '1d';
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [],
      interval: '1m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: true,
    });
    render(<InvestmentValueChart />);
    const msg = await screen.findByText(/Intraday view unavailable/i);
    expect(msg).toBeInTheDocument();
    // No ": <symbols>" suffix on the description.
    expect(
      screen.getByText(/One or more holdings use a quote provider/),
    ).not.toHaveTextContent(':');
  });

  it('shows warning icon with empty skippedSymbols in fallback notice', async () => {
    dateRangeState.dateRange = '1w';
    dateRangeState.resolvedRange = { start: '2023-12-25', end: '2024-01-01' };
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [],
      interval: '5m',
      currency: 'CAD',
      range: '1w',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: true,
    });
    render(<InvestmentValueChart />);
    const warning = await screen.findByTestId('intraday-fallback-warning');
    expect(warning).toBeInTheDocument();
    const help = within(warning).getByRole('button').getAttribute('aria-label');
    expect(help).toContain('one or more holdings');
    // No ticker symbols should appear in the help when skippedSymbols is empty
    expect(help).not.toMatch(/[A-Z]{2,5}\.[A-Z]{2}/); // e.g. VFV.TO
  });

  it('does not re-fetch on refresh event when range is not intraday', async () => {
    // 1y is a daily range; refresh event should be ignored
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    const callCount = vi.mocked(netWorthApi.getInvestmentsDaily).mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event(INVESTMENT_CHART_REFRESH_EVENT));
    });
    // No extra calls triggered
    expect(vi.mocked(netWorthApi.getInvestmentsDaily).mock.calls.length).toBe(callCount);
  });

  it('hydrates chart from intraday cache on 1d before network resolves', async () => {
    dateRangeState.dateRange = '1d';
    const cachedPayload = {
      fetchedAt: Date.now(),
      points: [{ timestamp: '2024-01-02T14:00:00.000Z', value: 8000 }],
      interval: '1m' as const,
      currency: 'CAD',
      fallbackToDaily: false,
      skippedSymbols: [],
      failedSymbols: [],
    };
    // Seed the session-storage cache manually
    window.sessionStorage.setItem(
      `monize-intraday|u:user-1|a:self|1d||CAD`,
      JSON.stringify(cachedPayload),
    );

    // Delay the network response so cache hydration can be observed
    let resolveIntraday!: (v: any) => void;
    vi.mocked(investmentsApi.getIntradayValue).mockImplementationOnce(
      () => new Promise((res) => { resolveIntraday = res; }),
    );

    render(<InvestmentValueChart />);
    // The chart should appear (not stuck on loading skeleton) because of cache
    await screen.findByText('Portfolio Value Over Time');

    // Clean up: resolve the pending network call inside act to avoid state-update warnings
    await act(async () => {
      resolveIntraday({
        points: [{ timestamp: '2024-01-02T14:00:00.000Z', value: 8000 }],
        interval: '1m',
        currency: 'CAD',
        range: '1d',
        fetchedAt: '2024-01-02T15:00:00.000Z',
        skippedSymbols: [],
        failedSymbols: [],
        fallbackToDaily: false,
      });
    });
    window.sessionStorage.clear();
  });

  it('handles intraday API error gracefully and shows empty chart', async () => {
    dateRangeState.dateRange = '1d';
    vi.mocked(investmentsApi.getIntradayValue).mockRejectedValue(new Error('Network error'));
    // On intraday error the component falls back to daily; mock daily empty so chart stays empty
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([]);
    render(<InvestmentValueChart />);
    const msg = await screen.findByText('No investment data for this period.');
    expect(msg).toBeInTheDocument();
  });

  it('samples the daily series at month-ends for all range', async () => {
    dateRangeState.dateRange = 'all';
    dateRangeState.resolvedRange = { start: '2010-01-01', end: '2024-01-01' };
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
      { date: '2010-01-01', value: 500 },
      { date: '2024-01-01', value: 3000 },
    ]);
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith(
        expect.objectContaining({ sampling: 'monthEnd' }),
      ),
    );
    expect(netWorthApi.getInvestmentsMonthly).not.toHaveBeenCalled();
  });

  it('passes displayCurrency to intraday API when it differs from defaultCurrency', async () => {
    dateRangeState.dateRange = '1d';
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [{ timestamp: '2024-01-02T14:30:00.000Z', value: 9500 }],
      interval: '1m',
      currency: 'USD',
      range: '1d',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: false,
    });
    render(<InvestmentValueChart displayCurrency="USD" />);
    await screen.findByText('Portfolio Value Over Time');
    await waitFor(() =>
      expect(investmentsApi.getIntradayValue).toHaveBeenCalledWith(
        expect.objectContaining({ displayCurrency: 'USD' }),
      )
    );
  });

  it('uses daily format labels for intraday 1d range', async () => {
    dateRangeState.dateRange = '1d';
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [
        { timestamp: '2024-01-02T14:30:00.000Z', value: 9500 },
        { timestamp: '2024-01-02T15:30:00.000Z', value: 9600 },
      ],
      interval: '1m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: '2024-01-02T16:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: false,
    });
    render(<InvestmentValueChart />);
    // The title renders once data loads; chart renders without crashing
    await screen.findByText('Portfolio Value Over Time');
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  it('uses week format labels for intraday 1w range', async () => {
    dateRangeState.dateRange = '1w';
    dateRangeState.resolvedRange = { start: '2023-12-26', end: '2024-01-02' };
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [
        { timestamp: '2023-12-26T09:30:00.000Z', value: 9400 },
        { timestamp: '2023-12-27T09:30:00.000Z', value: 9500 },
      ],
      interval: '5m',
      currency: 'CAD',
      range: '1w',
      fetchedAt: '2024-01-02T16:00:00.000Z',
      skippedSymbols: [],
      failedSymbols: [],
      fallbackToDaily: false,
    });
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  describe('a point the server could not finish is not a measured value', () => {
    const plotted = () =>
      JSON.parse(
        screen.getByTestId('area-chart').getAttribute('data-points') ?? '[]',
      ) as Array<{ iso: string; Value: number | null }>;

    it('does not rank a pricesComplete:false point as the Lowest Value', async () => {
      vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
        { date: '2023-06-01', value: 10000, securitiesValue: 10000, pricesComplete: true },
        { date: '2023-09-01', value: 100, securitiesValue: 100, pricesComplete: false, unpricedSecurityIds: ['sec-1'] },
        { date: '2024-01-01', value: 15000, securitiesValue: 15000, pricesComplete: true },
      ]);
      render(<InvestmentValueChart />);
      await screen.findByText('Lowest Value');
      await waitFor(() => expect(plotted()).toHaveLength(3));
      expect(screen.queryByText('$100.00')).not.toBeInTheDocument();
      // The subtotal can sit anywhere in the ordering, so neither extreme is
      // named: a high ranked over the other points could be the missing day.
      expect(screen.queryByText('$15000.00')).not.toBeInTheDocument();
      expect(screen.queryByText('$10000.00')).not.toBeInTheDocument();
      expect(plotted().map((p) => p.Value)).toEqual([10000, null, 15000]);
    });

    it('plots an fxComplete:false daily point as null', async () => {
      vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
        { date: '2023-06-01', value: 10000, securitiesValue: 10000 },
        { date: '2023-09-01', value: 50, securitiesValue: 50, fxComplete: false, missingRatePairs: ['EUR->CAD'] },
      ]);
      render(<InvestmentValueChart />);
      await screen.findByText('Lowest Value');
      await waitFor(() => expect(plotted()).toHaveLength(2));
      expect(plotted().map((p) => p.Value)).toEqual([10000, null]);
    });

    it('ranks the extremes as before when every point is complete', async () => {
      vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
        { date: '2023-06-01', value: 10000, securitiesValue: 10000, pricesComplete: true, fxComplete: true },
        { date: '2024-01-01', value: 15000, securitiesValue: 15000, pricesComplete: true, fxComplete: true },
      ]);
      render(<InvestmentValueChart />);
      await screen.findByText('Lowest Value');
      expect(screen.getByText('$15000.00')).toBeInTheDocument();
      expect(screen.getByText('$10000.00')).toBeInTheDocument();
    });

    it('does not read the cash flag: the chart plots the invested value', async () => {
      vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
        { date: '2023-06-01', value: 10000, securitiesValue: 9000, cashComplete: false },
        { date: '2024-01-01', value: 15000, securitiesValue: 14000 },
      ]);
      render(<InvestmentValueChart />);
      await screen.findByText('Lowest Value');
      await waitFor(() => expect(plotted()).toHaveLength(2));
      expect(plotted().map((p) => p.Value)).toEqual([9000, 14000]);
    });

    it('plots an intraday point with fxComplete:false as null and withholds the extremes', async () => {
      dateRangeState.dateRange = '1w';
      dateRangeState.resolvedRange = { start: '2023-12-26', end: '2024-01-02' };
      vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
        points: [
          { timestamp: '2023-12-26T09:30:00.000Z', value: 9400, securitiesValue: 9400, fxComplete: true, pricesComplete: true, cashComplete: true },
          { timestamp: '2023-12-27T09:30:00.000Z', value: 120, securitiesValue: 120, fxComplete: false, pricesComplete: true, cashComplete: true },
          { timestamp: '2023-12-28T09:30:00.000Z', value: 9600, securitiesValue: 9600, fxComplete: true, pricesComplete: true, cashComplete: true },
        ],
        interval: '5m',
        currency: 'CAD',
        range: '1w',
        fetchedAt: '2024-01-02T16:00:00.000Z',
        skippedSymbols: [],
        failedSymbols: [],
        fallbackToDaily: false,
        fxComplete: false,
        pricesComplete: true,
        valuationComplete: false,
        missingRatePairs: ['EUR->CAD'],
        unpricedSecurityIds: [],
      });
      render(<InvestmentValueChart />);
      await screen.findByText('Portfolio Value Over Time');
      await waitFor(() => expect(plotted()).toHaveLength(3));
      expect(plotted().map((p) => p.Value)).toEqual([9400, null, 9600]);
      expect(screen.queryByText('$120.00')).not.toBeInTheDocument();
      expect(screen.queryByText('$9600.00')).not.toBeInTheDocument();
    });

    it('names the security behind a withheld daily point', async () => {
      vi.mocked(investmentsApi.getSecurities).mockResolvedValue([
        { id: 'sec-1', symbol: 'AGGG', name: 'Aggregate' },
      ] as never);
      vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
        { date: '2023-06-01', value: 10000, securitiesValue: 10000 },
        { date: '2023-09-01', value: 100, securitiesValue: 100, pricesComplete: false, unpricedSecurityIds: ['sec-1'] },
      ]);
      render(<InvestmentValueChart />);
      expect(await screen.findByTestId('incomplete-data-details')).toBeInTheDocument();
      expect(await screen.findByText('AGGG')).toBeInTheDocument();
    });
  });
});
