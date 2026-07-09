import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
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
    configState.current = { range: '1y', accountIds: [] };
  });

  it('renders the area chart and latest value using monthly data for long ranges', async () => {
    getInvestmentsMonthly.mockResolvedValue([
      { month: '2026-05', value: 9000 },
      { month: '2026-06', value: 10000 },
    ]);
    await renderWidget();
    expect(screen.getByText('Portfolio Value over Time')).toBeInTheDocument();
    expect(screen.getByText('1Y')).toBeInTheDocument();
    expect(getInvestmentsMonthly).toHaveBeenCalled();
    expect(getInvestmentsDaily).not.toHaveBeenCalled();
    expect(screen.getByText('$10000')).toBeInTheDocument();
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
});
