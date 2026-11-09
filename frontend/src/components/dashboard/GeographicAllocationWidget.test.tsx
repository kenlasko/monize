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
vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
    }),
  };
});// A currency listed here converts to null (no rate), so its holdings are
// dropped from the region/exchange aggregation the way the real hook does.
const unconvertible = { current: new Set<string>() };
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (n: number, currency: string) =>
      unconvertible.current.has(currency) ? null : n,
    defaultCurrency: 'USD',
  }),
}));

const getPortfolioValuation = vi.fn();
const getSecurities = vi.fn();
const getCountryWeightings = vi.fn();
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioValuation: (...a: unknown[]) => getPortfolioValuation(...a),
    getSecurities: (...a: unknown[]) => getSecurities(...a),
    getCountryWeightings: (...a: unknown[]) => getCountryWeightings(...a),
  },
}));

const holding = (
  securityId: string,
  marketValue: number | null,
  currencyCode = 'USD',
): HoldingWithMarketValue =>
  ({ securityId, marketValue, currencyCode }) as HoldingWithMarketValue;

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
    getPortfolioValuation.mockReset().mockResolvedValue({
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
    unconvertible.current = new Set();
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

  it('marks the region view as a subtotal when a holding could not be converted', async () => {
    // The GBP holding has no rate, so it is dropped from the aggregation. The
    // remaining bars are a share of the convertible subset, not of the whole
    // portfolio, so a note must say so rather than letting them read as 100%.
    unconvertible.current = new Set(['GBP']);
    getPortfolioValuation.mockResolvedValue({
      holdings: [holding('s-nyse', 700), holding('s-lse', 300, 'GBP')],
      holdingsByAccount: [],
    });
    await renderWidget();
    expect(screen.getByText('North America')).toBeInTheDocument();
    expect(screen.getByText(/partial total/i)).toBeInTheDocument();
  });

  it('leaves the region view unmarked when every holding converts', async () => {
    await renderWidget();
    expect(screen.queryByText(/partial total/i)).not.toBeInTheDocument();
  });

  it('explains the empty state as partial when every holding was dropped', async () => {
    unconvertible.current = new Set(['GBP']);
    getPortfolioValuation.mockResolvedValue({
      holdings: [holding('s-lse', 300, 'GBP')],
      holdingsByAccount: [],
    });
    await renderWidget();
    expect(screen.getByText(/partial total/i)).toBeInTheDocument();
  });

  it('does not mark the country view, whose slices come from a different source', async () => {
    // computeGeographicAllocation's exclusions describe the region/exchange
    // aggregation only; the country pie is served by getCountryWeightings, so a
    // missing region rate must not paint a partial note over it.
    unconvertible.current = new Set(['GBP']);
    configState.current = { accountIds: [], view: 'country' };
    getPortfolioValuation.mockResolvedValue({
      holdings: [holding('s-nyse', 700), holding('s-lse', 300, 'GBP')],
      holdingsByAccount: [],
    });
    await renderWidget();
    expect(screen.getByText('United States')).toBeInTheDocument();
    expect(screen.queryByText(/partial total/i)).not.toBeInTheDocument();
  });

  // Region and exchange classify a holding by where it is listed, so a globally
  // diversified fund bought on the NYSE counts as North America. The chart says
  // so rather than being left to read as economic exposure.
  const LISTING_NOTE =
    'Grouped by where each holding is listed. Switch to Country to see inside funds.';

  const oneUsHolding = () => {
    getPortfolioValuation.mockResolvedValue({ holdings: [holding('s1', 1000)] });
    getSecurities.mockResolvedValue([security('s1', 'NYSE')]);
    getCountryWeightings.mockResolvedValue({
      items: [{ country: 'United States', totalValue: 1000, percentage: 100 }],
      totalPortfolioValue: 1000,
      totalDirectValue: 1000,
      totalEtfValue: 0,
      unclassifiedValue: 0,
    });
  };

  it('says the region view groups by listing', async () => {
    oneUsHolding();
    await renderWidget();
    expect(screen.getByText(LISTING_NOTE)).toBeInTheDocument();
  });

  it('leaves the caveat off the country view, which is the look-through', async () => {
    oneUsHolding();
    configState.current = { accountIds: [], view: 'country' };
    await renderWidget();
    expect(screen.queryByText(LISTING_NOTE)).toBeNull();
  });
});
