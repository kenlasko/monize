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
vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
  }),
}));
vi.mock('@/hooks/useExchangeRates', () => ({
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
