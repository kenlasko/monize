import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { Account } from '@/types/account';
import { PortfolioValueWidget } from './PortfolioValueWidget';

vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock());

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

const getInvestmentsMonthly = vi.fn();
const getInvestmentsDaily = vi.fn();
vi.mock('@/lib/net-worth', () => ({
  netWorthApi: {
    getInvestmentsMonthly: (...a: unknown[]) => getInvestmentsMonthly(...a),
    getInvestmentsDaily: (...a: unknown[]) => getInvestmentsDaily(...a),
  },
}));

const getPortfolioSummary = vi.fn();
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...a: unknown[]) => getPortfolioSummary(...a),
  },
}));

const triggerManualRefresh = vi.fn();
vi.mock('@/hooks/usePriceRefresh', () => ({
  usePriceRefresh: () => ({ isRefreshing: false, triggerManualRefresh }),
}));

const investmentAccount = { id: 'i1', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', name: 'Brokerage' } as Account;

async function renderWidget() {
  await act(async () => {
    render(<PortfolioValueWidget accounts={[investmentAccount]} isLoading={false} />);
  });
}

describe('PortfolioValueWidget', () => {
  beforeEach(() => {
    getInvestmentsMonthly.mockReset();
    getInvestmentsDaily.mockReset();
    getPortfolioSummary.mockReset();
    getPortfolioSummary.mockResolvedValue({ totalPortfolioValue: 12345, holdings: [] });
    triggerManualRefresh.mockReset();
    configState.current = { range: '1y', accountIds: [] };
  });

  it('renders the area chart and the Total Portfolio Value from the summary for long ranges', async () => {
    getInvestmentsMonthly.mockResolvedValue([
      { month: '2026-05', value: 9000 },
      { month: '2026-06', value: 10000 },
    ]);
    await renderWidget();
    expect(screen.getByText('Portfolio Value over Time')).toBeInTheDocument();
    expect(screen.getByText('1Y')).toBeInTheDocument();
    expect(getInvestmentsMonthly).toHaveBeenCalled();
    expect(getInvestmentsDaily).not.toHaveBeenCalled();
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
    expect(getInvestmentsMonthly).not.toHaveBeenCalled();
  });

  it('shows the empty state with no history', async () => {
    getInvestmentsMonthly.mockResolvedValue([]);
    await renderWidget();
    expect(screen.getByText('No investment history to show yet.')).toBeInTheDocument();
  });

  it('refreshes prices when the refresh button is clicked', async () => {
    getInvestmentsMonthly.mockResolvedValue([{ month: '2026-06', value: 10000 }]);
    await renderWidget();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Refresh current value'));
    });
    expect(triggerManualRefresh).toHaveBeenCalledTimes(1);
    // No account filter -> refresh every eligible security (undefined scope).
    expect(triggerManualRefresh).toHaveBeenCalledWith(undefined);
  });

  it('shows the move over the window in money and percent', async () => {
    getInvestmentsMonthly.mockResolvedValue([
      { month: '2026-05', value: 8000 },
      { month: '2026-06', value: 10000 },
    ]);
    await renderWidget();
    // 1Y measures from the first point drawn, so 8000 -> 10000 is +2000 (+25%).
    expect(screen.getByTestId('portfolio-period-change')).toHaveTextContent(
      '+$2000(+25.0%)',
    );
  });

  it('keeps the window, the refresh and the gear on the title line, figures below', async () => {
    // A widget header is one line for what the widget IS and its controls; the
    // value and its move take the line under them, right-aligned on one edge so
    // they read as a figure and its change rather than two numbers.
    getPortfolioSummary.mockResolvedValue({ totalPortfolioValue: 10000, holdings: [] });
    getInvestmentsMonthly.mockResolvedValue([
      { month: '2026-05', value: 8000 },
      { month: '2026-06', value: 10000 },
    ]);
    await renderWidget();

    const change = screen.getByTestId('portfolio-period-change');
    const value = screen.getByText('$10000');
    const range = screen.getByText('1Y');
    const refresh = screen.getByLabelText('Refresh current value');
    const gear = screen.getByLabelText('Configure Portfolio Value over Time');

    // One column for the two figures, aligned on their right edges, and it takes
    // a line of its own whatever the card's width.
    const figures = value.parentElement!;
    expect(change.parentElement).toBe(figures);
    expect(figures.className).toContain('flex-col');
    expect(figures.className).toContain('items-end');
    expect(figures.className).toContain('w-full');
    // Smaller than the value it sits under.
    expect(change.className).toContain('text-xs');
    expect(value.className).toContain('text-sm');

    // The window and the refresh control are above that column, in the order
    // they are read: the window, then the button that acts on it.
    expect(range.parentElement).not.toBe(figures);
    expect(refresh.parentElement).not.toBe(figures);
    expect(range.compareDocumentPosition(refresh)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(refresh.compareDocumentPosition(figures)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    // The gear holds the first line with them rather than centring across both.
    expect(gear.className).toContain('self-start');
  });

  it('shows no period change while the series is empty', async () => {
    // An unknown baseline is not a flat market: nothing is printed rather than
    // a change of zero.
    getInvestmentsMonthly.mockResolvedValue([]);
    await renderWidget();
    expect(screen.queryByTestId('portfolio-period-change')).toBeNull();
  });

  it('measures the MTD change from the close before the window', async () => {
    configState.current = { range: 'mtd', accountIds: [] };
    getInvestmentsDaily.mockImplementation((params: { endDate?: string }) =>
      // The baseline lookup asks for the days before the window; the chart's own
      // request carries the window itself.
      Promise.resolve(
        params.endDate === '2026-06-30'
          ? [{ date: '2026-06-30', value: 9000 }]
          : [
              { date: '2026-07-01', value: 9500 },
              { date: '2026-07-02', value: 9900 },
            ],
      ),
    );
    await renderWidget();
    // 9900 against the 30 June close of 9000, not against the 1 July point.
    expect(screen.getByTestId('portfolio-period-change')).toHaveTextContent(
      '+$900(+10.0%)',
    );
  });

  it('scopes the refresh to the shown holdings when an account filter is active', async () => {
    configState.current = { range: '1y', accountIds: ['i1'] };
    getInvestmentsMonthly.mockResolvedValue([{ month: '2026-06', value: 10000 }]);
    getPortfolioSummary.mockResolvedValue({
      totalPortfolioValue: 5000,
      holdings: [{ securityId: 's1' }, { securityId: 's2' }, { securityId: 's1' }],
    });
    await renderWidget();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Refresh current value'));
    });
    expect(triggerManualRefresh).toHaveBeenCalledWith(['s1', 's2']);
  });
});
