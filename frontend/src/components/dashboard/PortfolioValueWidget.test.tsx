import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { Account } from '@/types/account';
import { PortfolioValueWidget } from './PortfolioValueWidget';

// `data-points` carries the rows the chart was handed, so a test can see what is
// plotted and not only what the header says.
vi.mock('recharts', async () => ({
  ...(await import('@/test/recharts-mock')).rechartsMock(),
  AreaChart: ({ children, data }: { children?: React.ReactNode; data?: unknown[] }) => (
    <div data-testid="area-chart" data-points={JSON.stringify(data ?? [])}>
      {children}
    </div>
  ),
}));

const configState = { current: { range: '1y', accountIds: [] as string[] } };
vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({ config: configState.current, updateConfig: vi.fn() }),
}));
vi.mock('@/hooks/useChartDateFormat', () => ({
  useChartDateFormat: () => () => 'Jan 2026',
}));
vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
    }),
  };
});vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({ defaultCurrency: 'USD' }),
}));

const getInvestmentsDaily = vi.fn();
const getInvestmentsPeriodResult = vi.fn();
vi.mock('@/lib/net-worth', () => ({
  netWorthApi: {
    getInvestmentsDaily: (...a: unknown[]) => getInvestmentsDaily(...a),
    getInvestmentsPeriodResult: (...a: unknown[]) =>
      getInvestmentsPeriodResult(...a),
  },
}));

/**
 * A period result as the server sends it. The defaults are a window in which
 * nothing happened; each test overrides only the figures it is about.
 */
function periodResult(overrides: Record<string, unknown> = {}) {
  const base = {
    currency: 'USD',
    startDate: '2026-01-02',
    endDate: '2026-06-30',
    startValue: 10000,
    endValue: 10000,
    valueChange: 0,
    netExternalFlows: 0,
    knownFlowSubtotal: 0,
    investmentResult: 0,
    returnPercent: 0,
    returnMethod: 'simple' as const,
    complete: true,
    reasons: [] as string[],
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

const getPortfolioValuation = vi.fn();
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioValuation: (...a: unknown[]) => getPortfolioValuation(...a),
  },
}));

const triggerManualRefresh = vi.fn();
vi.mock('@/hooks/usePriceRefresh', () => ({
  usePriceRefresh: () => ({ isRefreshing: false, triggerManualRefresh }),
}));

const investmentAccount = { id: 'i1', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', name: 'Brokerage' } as Account;

/** Answer every media query as a viewport of this width. */
function viewport(width: number) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return {
      matches: max ? width <= Number(max[1]) : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  });
}

async function renderWidget() {
  await act(async () => {
    render(<PortfolioValueWidget accounts={[investmentAccount]} isLoading={false} />);
  });
}

describe('PortfolioValueWidget', () => {
  beforeEach(() => {
    getInvestmentsDaily.mockReset();
    getInvestmentsPeriodResult.mockReset();
    getInvestmentsPeriodResult.mockResolvedValue(periodResult());
    getPortfolioValuation.mockReset();
    getPortfolioValuation.mockResolvedValue({ totalPortfolioValue: 12345, holdings: [] });
    triggerManualRefresh.mockReset();
    configState.current = { range: '1y', accountIds: [] };
  });

  it('renders the area chart and the Total Portfolio Value from the summary for long ranges', async () => {
    getInvestmentsDaily.mockResolvedValue([
      { date: '2026-05-28', value: 9000 },
      { date: '2026-06-28', value: 10000 },
    ]);
    await renderWidget();
    expect(screen.getByText('Portfolio Value over Time')).toBeInTheDocument();
    expect(screen.getByText('1Y')).toBeInTheDocument();
    // A long range is the daily valuation sampled at month-ends, so the line
    // opens on the close the figure beside it is measured from.
    expect(getInvestmentsDaily).toHaveBeenCalledWith(
      expect.objectContaining({ sampling: 'monthEnd' }),
    );
    // Header shows the live summary total (same value as the Investments page),
    // not the last point of the historical series.
    expect(screen.getByText('$12345')).toBeInTheDocument();
    expect(screen.queryByText('$10000')).not.toBeInTheDocument();
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
  });

  it('uses daily data for short ranges', async () => {
    configState.current = { range: '3m', accountIds: [] };
    getInvestmentsDaily.mockResolvedValue([{ date: '2026-07-01', value: 5000 }]);
    await renderWidget();
    expect(getInvestmentsDaily).toHaveBeenCalled();
    expect(getInvestmentsDaily).not.toHaveBeenCalledWith(
      expect.objectContaining({ sampling: 'monthEnd' }),
    );
  });

  it('shows the empty state with no history', async () => {
    getInvestmentsDaily.mockResolvedValue([]);
    await renderWidget();
    expect(screen.getByText('No investment history to show yet.')).toBeInTheDocument();
  });

  it('refreshes prices when the refresh button is clicked', async () => {
    getInvestmentsDaily.mockResolvedValue([{ date: '2026-06-28', value: 10000 }]);
    await renderWidget();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Refresh current value'));
    });
    expect(triggerManualRefresh).toHaveBeenCalledTimes(1);
    // No account filter -> refresh every eligible security (undefined scope).
    expect(triggerManualRefresh).toHaveBeenCalledWith(undefined);
  });

  it('shows the investment result over the window, not the value change', async () => {
    // The issue's reproduction (#1392): two deposits of 10,000 with a price
    // that never moves. The series rose by 10,000 and the market did nothing,
    // so the headline is the server's investment result of 0 -- and the value
    // change it is NOT is named beside it rather than printed as the figure.
    getInvestmentsDaily.mockResolvedValue([
      { date: '2026-01-28', value: 10000 },
      { date: '2026-06-28', value: 20000 },
    ]);
    getInvestmentsPeriodResult.mockResolvedValue(
      periodResult({
        startValue: 10000,
        endValue: 20000,
        valueChange: 10000,
        netExternalFlows: 10000,
        knownFlowSubtotal: 10000,
        investmentResult: 0,
        returnPercent: 0,
        investedValueChange: 10000,
        investmentCapitalFlows: 10000,
      }),
    );
    await renderWidget();
    const figure = screen.getByTestId('portfolio-period-change');
    // The headline itself, before the help text that explains it: the caption
    // says investment result and the figure is the server's 0 / 0%.
    expect(figure.textContent).toMatch(/^Investment result\+\$0\(\+0\.0%\)/);
    // The deposit is not the headline, under any caption.
    expect(figure.textContent).not.toMatch(/^[^T]*\$10000/);
    expect(figure).not.toHaveTextContent('100.0%');
    expect(
      screen.getByLabelText(
        'The securities moved +$10000 in value over this window. Of that, +$10000 was paid in, net of sales, and they paid out +$0 in dividends and interest. A distribution reinvested in shares counts in both. The figure above is what the investments themselves earned, with uninvested cash left out.',
      ),
    ).toBeInTheDocument();
  });

  /**
   * The widget draws the INVESTED value: a month whose only event was a cash
   * deposit plots zero and reports 0 / 0%, where a totals series would draw the
   * reader's own money as portfolio growth (INV-PORTRESULT-002).
   */
  it('plots the invested value and reports the invested figures', async () => {
    getInvestmentsDaily.mockResolvedValue([
      { date: '2026-05-28', value: 0, securitiesValue: 0 },
      { date: '2026-06-28', value: 10000, securitiesValue: 0 },
    ]);
    getInvestmentsPeriodResult.mockResolvedValue(
      periodResult({
        valueChange: 10000,
        netExternalFlows: 10000,
        investmentResult: 0,
        returnPercent: 0,
        investmentPnl: 0,
        investmentReturnPercent: 0,
      }),
    );

    await renderWidget();

    const figure = screen.getByTestId('portfolio-period-change');
    expect(figure.textContent).toMatch(/^Investment result\+\$0\(\+0\.0%\)/);
    // The series the chart drew is the invested one, so the deposit is not on
    // it either: nothing in the widget reports 10000 as portfolio value.
    expect(getInvestmentsDaily).toHaveBeenCalledWith(
      expect.objectContaining({ sampling: 'monthEnd' }),
    );
  });

  it('renders a withheld result as unknown with the cause the server gave', async () => {
    getInvestmentsDaily.mockResolvedValue([
      { date: '2026-05-28', value: 8000 },
      { date: '2026-06-28', value: 10000 },
    ]);
    getInvestmentsPeriodResult.mockResolvedValue(
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
    await renderWidget();
    const figure = screen.getByTestId('portfolio-period-change');
    expect(figure).toContainElement(screen.getByTestId('unknown-amount'));
    // The marker names the one repair: a price to add, not a rate to refresh.
    expect(
      screen.getByLabelText(/the security has no price to value them at/),
    ).toBeInTheDocument();
    expect(figure).not.toHaveTextContent('$0');
    // The two figures behind it are withheld in the same words, never blank.
    expect(
      screen.getByLabelText(
        'The securities moved N/A in value over this window. Of that, N/A was paid in, net of sales, and they paid out N/A in dividends and interest. A distribution reinvested in shares counts in both. The figure above is what the investments themselves earned, with uninvested cash left out.',
      ),
    ).toBeInTheDocument();
  });

  it('shows no figure at all when the period request fails', async () => {
    // A failed request is not a period that did nothing: never a zero, and
    // never the previous window's figure under this window's caption.
    getInvestmentsDaily.mockResolvedValue([
      { date: '2026-05-28', value: 8000 },
      { date: '2026-06-28', value: 10000 },
    ]);
    getInvestmentsPeriodResult.mockRejectedValue(new Error('period unavailable'));
    await renderWidget();
    expect(screen.queryByTestId('portfolio-period-change')).toBeNull();
    expect(screen.queryByText(/\$2000/)).toBeNull();
    expect(screen.queryByText(/\+\$0/)).toBeNull();
  });

  it('keeps the window and the refresh on the title line, figures on the card\'s own edge', async () => {
    // A widget header is one line for what the widget IS and its controls; the
    // value and its move take a row of the card body, right-aligned on one
    // edge so they read as a figure and its change rather than two numbers --
    // and that edge is the card's, not the one where the settings gear starts.
    viewport(1280);
    getPortfolioValuation.mockResolvedValue({ totalPortfolioValue: 10000, holdings: [] });
    getInvestmentsDaily.mockResolvedValue([
      { date: '2026-05-28', value: 8000 },
      { date: '2026-06-28', value: 10000 },
    ]);
    await renderWidget();

    const change = screen.getByTestId('portfolio-period-change');
    const value = screen.getByText('$10000');
    const range = screen.getByText('1Y');
    const refresh = screen.getByLabelText('Refresh current value');
    const gear = screen.getByLabelText('Configure Portfolio Value over Time');

    // One column for the two figures, aligned on their right edges, in a row of
    // the body rather than in the header beside the gear.
    const figures = value.parentElement!;
    expect(change.parentElement).toBe(figures);
    expect(figures.className).toContain('flex-col');
    expect(figures.className).toContain('items-end');
    const figuresRow = screen.getByTestId('portfolio-figures');
    expect(figuresRow).toContainElement(figures);
    expect(figuresRow.className).toContain('justify-end');
    expect(figuresRow).not.toContainElement(gear);
    // Smaller than the value it sits under.
    expect(change.className).toContain('text-xs');
    expect(value.className).toContain('text-sm');

    // On a desktop the control that reprices the chart sits on the title's
    // line, to the LEFT of the window it acts on.
    expect(figuresRow).not.toContainElement(refresh);
    expect(refresh.compareDocumentPosition(range)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(range.compareDocumentPosition(figuresRow)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    // The gear keeps the top of the header, whatever the header-right holds.
    expect(gear.className).toContain('self-start');
  });

  it('moves the refresh control beside the value on a phone', async () => {
    // A phone title line holds the window and the gear and nothing else, so
    // the refresh control rides on the figures' row instead -- one control, in
    // one place, never a second copy hidden at the other breakpoint.
    viewport(400);
    getPortfolioValuation.mockResolvedValue({ totalPortfolioValue: 10000, holdings: [] });
    getInvestmentsDaily.mockResolvedValue([{ date: '2026-06-28', value: 10000 }]);
    await renderWidget();

    const refresh = screen.getByLabelText('Refresh current value');
    const value = screen.getByText('$10000');
    const figuresRow = screen.getByTestId('portfolio-figures');

    expect(screen.getAllByLabelText('Refresh current value')).toHaveLength(1);
    expect(figuresRow).toContainElement(refresh);
    // To the left of the figure it refreshes.
    expect(refresh.compareDocumentPosition(value)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('shows no period figure while a dated window has no series', async () => {
    // MTD names no server preset, so the client dates it -- and with nothing
    // on screen there is no first point to measure from. No request is made
    // and nothing is printed: never a change of zero.
    configState.current = { range: 'mtd', accountIds: [] };
    getInvestmentsDaily.mockResolvedValue([]);
    await renderWidget();
    expect(screen.queryByTestId('portfolio-period-change')).toBeNull();
    expect(getInvestmentsPeriodResult).not.toHaveBeenCalled();
  });

  it('asks for the MTD period against the close before the month, which its series opens on', async () => {
    configState.current = { range: 'mtd', accountIds: ['i1'] };
    getInvestmentsDaily.mockResolvedValue([
      { date: '2026-07-01', value: 9500 },
      { date: '2026-07-02', value: 9900 },
    ]);
    getInvestmentsPeriodResult.mockResolvedValue(
      periodResult({ investmentResult: 400, returnPercent: 4 }),
    );
    await renderWidget();
    // The client picks the dates; the server measures. MTD reports against
    // the previous close, so the last day of the previous month -- the day
    // the series was requested from -- goes out as the baseline, for the
    // same account scope as the series.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const monthStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    const lastOfPreviousMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    const baseline = `${lastOfPreviousMonth.getFullYear()}-${pad(lastOfPreviousMonth.getMonth() + 1)}-${pad(lastOfPreviousMonth.getDate())}`;
    expect(getInvestmentsDaily).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: baseline }),
    );
    expect(getInvestmentsPeriodResult).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: monthStart,
        baselineDate: baseline,
        accountIds: 'i1',
      }),
    );
    expect(screen.getByTestId('portfolio-period-change')).toHaveTextContent(
      '+$400(+4.0%)',
    );
  });

  it('names the window to the server rather than sending the one it drew', async () => {
    // The widget's 1Y window opens a day before the anniversary so the first
    // plotted close precedes the year. That is the line's window, not the
    // figure's: the server resolves 1Y from its own preset.
    configState.current = { range: '1y', accountIds: [] };
    getInvestmentsDaily.mockResolvedValue([{ date: '2026-06-28', value: 10000 }]);
    await renderWidget();
    expect(getInvestmentsPeriodResult).toHaveBeenCalledWith(
      expect.objectContaining({ period: '1y' }),
    );
  });

  it("opens 'all' where the server's all-time window does", async () => {
    // No start date goes out: the server opens a sampled all-time series on
    // the day before the first investment, the day the period is measured
    // from, and the figure beside it is named rather than dated.
    configState.current = { range: 'all', accountIds: [] };
    getInvestmentsDaily.mockResolvedValue([
      { date: '2021-03-03', value: 0, securitiesValue: 0 },
      { date: '2021-03-31', value: 5000, securitiesValue: 5000 },
      { date: '2026-06-15', value: 9000, securitiesValue: 9000 },
    ]);
    await renderWidget();
    expect(getInvestmentsDaily).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: undefined, sampling: 'monthEnd' }),
    );
    expect(getInvestmentsPeriodResult).toHaveBeenCalledWith(
      expect.objectContaining({ period: 'all' }),
    );
  });

  it('scopes the refresh to the shown holdings when an account filter is active', async () => {
    configState.current = { range: '1y', accountIds: ['i1'] };
    getInvestmentsDaily.mockResolvedValue([{ date: '2026-06-28', value: 10000 }]);
    getPortfolioValuation.mockResolvedValue({
      totalPortfolioValue: 5000,
      holdings: [{ securityId: 's1' }, { securityId: 's2' }, { securityId: 's1' }],
    });
    await renderWidget();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Refresh current value'));
    });
    expect(triggerManualRefresh).toHaveBeenCalledWith(['s1', 's2']);
  });

  describe('an incomplete valuation is not a total', () => {
    const summaryWith = (overrides: Record<string, unknown>) => ({
      totalPortfolioValue: 100000,
      holdings: [],
      holdingsByAccount: [],
      pricesComplete: true,
      fxComplete: true,
      valuationComplete: true,
      unpricedSecurityIds: [] as string[],
      missingRatePairs: [] as string[],
      ...overrides,
    });
    const plotted = () =>
      JSON.parse(
        screen.getByTestId('area-chart').getAttribute('data-points') ?? '[]',
      ) as Array<{ date: string; value: number | null }>;

    it('marks the headline partial when valuationComplete is false, every other field complete', async () => {
      getInvestmentsDaily.mockResolvedValue([{ date: '2026-06-28', value: 10000 }]);
      getPortfolioValuation.mockResolvedValue(
        summaryWith({ valuationComplete: false }),
      );
      await renderWidget();
      const marker = screen.getByTestId('partial-total');
      expect(marker).toHaveTextContent('$100000');
      expect(screen.getByTestId('partial-total-marker')).toBeInTheDocument();
    });

    it('marks the headline partial for an unpriced holding and a missing rate', async () => {
      getInvestmentsDaily.mockResolvedValue([{ date: '2026-06-28', value: 10000 }]);
      getPortfolioValuation.mockResolvedValue(
        summaryWith({
          valuationComplete: false,
          pricesComplete: false,
          fxComplete: false,
          unpricedSecurityIds: ['sec-1'],
          missingRatePairs: ['EUR->USD'],
        }),
      );
      await renderWidget();
      expect(screen.getByTestId('partial-total')).toHaveTextContent('$100000');
    });

    it('prints a complete valuation bare', async () => {
      getInvestmentsDaily.mockResolvedValue([{ date: '2026-06-28', value: 10000 }]);
      getPortfolioValuation.mockResolvedValue(summaryWith({}));
      await renderWidget();
      expect(screen.getByText('$100000')).toBeInTheDocument();
      expect(screen.queryByTestId('partial-total')).not.toBeInTheDocument();
    });

    it('reads an absent flag as no information, not as incomplete', async () => {
      getInvestmentsDaily.mockResolvedValue([{ date: '2026-06-28', value: 10000 }]);
      getPortfolioValuation.mockResolvedValue({
        totalPortfolioValue: 100000,
        holdings: [],
      });
      await renderWidget();
      expect(screen.queryByTestId('partial-total')).not.toBeInTheDocument();
    });

    it('plots a point the server could not price or convert as null', async () => {
      getInvestmentsDaily.mockResolvedValue([
        { date: '2026-04-28', value: 9000, securitiesValue: 9000, pricesComplete: true, fxComplete: true },
        { date: '2026-05-28', value: 100, securitiesValue: 100, pricesComplete: false },
        { date: '2026-06-28', value: 200, securitiesValue: 200, fxComplete: false },
        { date: '2026-07-28', value: 10000, securitiesValue: 10000 },
      ]);
      await renderWidget();
      expect(plotted().map((p) => p.value)).toEqual([9000, null, null, 10000]);
    });

    it('does not read the cash flag: the sparkline plots the invested value', async () => {
      getInvestmentsDaily.mockResolvedValue([
        { date: '2026-06-28', value: 500, securitiesValue: 400, cashComplete: false },
      ]);
      await renderWidget();
      expect(plotted().map((p) => p.value)).toEqual([400]);
    });
  });
});
