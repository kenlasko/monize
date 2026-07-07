import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { Account } from '@/types/account';
import { HoldingWithMarketValue, Security } from '@/types/investment';
import { GeographicAllocationWidget } from './GeographicAllocationWidget';

vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock());

const configState = { current: { accountIds: [] as string[], view: 'region' as 'region' | 'exchange' | 'country' } };
vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({ config: configState.current, updateConfig: vi.fn() }),
}));
vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
  }),
}));
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({ convertToDefault: (n: number) => n }),
}));

const getPortfolioSummary = vi.fn();
const getSecurities = vi.fn();
const getCountryWeightings = vi.fn();
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...a: unknown[]) => getPortfolioSummary(...a),
    getSecurities: (...a: unknown[]) => getSecurities(...a),
    getCountryWeightings: (...a: unknown[]) => getCountryWeightings(...a),
  },
}));

const holding = (securityId: string, marketValue: number): HoldingWithMarketValue =>
  ({ securityId, marketValue, currencyCode: 'USD' }) as HoldingWithMarketValue;

const security = (id: string, exchange: string): Security =>
  ({ id, exchange }) as Security;

const investmentAccount = { id: 'i1', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', name: 'Brokerage' } as Account;

async function renderWidget() {
  await act(async () => {
    render(<GeographicAllocationWidget accounts={[investmentAccount]} isLoading={false} />);
  });
}

describe('GeographicAllocationWidget', () => {
  beforeEach(() => {
    getPortfolioSummary.mockReset().mockResolvedValue({
      holdings: [holding('s-nyse', 700), holding('s-lse', 300)],
      holdingsByAccount: [],
    });
    getSecurities.mockReset().mockResolvedValue([
      security('s-nyse', 'NYSE'),
      security('s-lse', 'LSE'),
    ]);
    getCountryWeightings.mockReset().mockResolvedValue({
      items: [{ country: 'United States', directValue: 700, etfValue: 0, totalValue: 700, percentage: 70 }],
      totalPortfolioValue: 1000,
      totalDirectValue: 700,
      totalEtfValue: 0,
      unclassifiedValue: 0,
    });
    configState.current = { accountIds: [], view: 'region' };
  });

  it('renders the region pie with a North America slice', async () => {
    await renderWidget();
    expect(screen.getByText('Geographic Allocation')).toBeInTheDocument();
    expect(screen.getByText('North America')).toBeInTheDocument();
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
  });

  it('renders the exchange bar view', async () => {
    configState.current = { accountIds: [], view: 'exchange' };
    await renderWidget();
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
  });

  it('renders the country view from the country weightings endpoint', async () => {
    configState.current = { accountIds: [], view: 'country' };
    await renderWidget();
    expect(screen.getByText('United States')).toBeInTheDocument();
  });
});
