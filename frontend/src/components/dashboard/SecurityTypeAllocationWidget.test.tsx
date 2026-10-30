import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { Account } from '@/types/account';
import { HoldingWithMarketValue } from '@/types/investment';
import { SecurityTypeAllocationWidget } from './SecurityTypeAllocationWidget';

vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock());

// Stable config reference across renders (mirrors the real memoized hook), so
// useReportData's [config.accountIds] dependency does not change every render.
const { widgetCfg } = vi.hoisted(() => ({
  widgetCfg: {
    config: { accountIds: [] as string[], view: 'type' as 'type' | 'assetClass' },
    updateConfig: () => {},
  },
}));
vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => widgetCfg,
}));
vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({ ...numberFormatMockDefaults(), formatCurrency: (n: number) => `$${n}` }),
  };
});const { rateless } = vi.hoisted(() => ({ rateless: { currencies: [] as string[] } }));
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'USD',
    convertToDefault: (n: number, cur: string) => (rateless.currencies.includes(cur) ? null : n),
  }),
}));

const getPortfolioSummary = vi.fn();
const getAssetClassWeightings = vi.fn();
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...a: unknown[]) => getPortfolioSummary(...a),
    getAssetClassWeightings: (...a: unknown[]) => getAssetClassWeightings(...a),
  },
}));

const holding = (securityId: string, securityType: string, marketValue: number): HoldingWithMarketValue =>
  ({
    securityId,
    securityType,
    marketValue,
    currencyCode: 'USD',
    quantity: 10,
    costBasis: marketValue,
    costBasisAccountCurrency: marketValue,
    averageCost: marketValue / 10,
    gainLoss: 0,
    gainLossPercent: 0,
  }) as HoldingWithMarketValue;

const investmentAccount = { id: 'i1', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', name: 'Brokerage' } as Account;

async function renderWidget() {
  await act(async () => {
    render(<SecurityTypeAllocationWidget accounts={[investmentAccount]} isLoading={false} />);
  });
}

describe('SecurityTypeAllocationWidget', () => {
  beforeEach(() => {
    getPortfolioSummary.mockReset();
    getAssetClassWeightings.mockReset();
    widgetCfg.config = { accountIds: [], view: 'type' };
    rateless.currencies = [];
  });

  it('says which holdings the type view left out, as the asset class view does', async () => {
    rateless.currencies = ['EUR'];
    getPortfolioSummary.mockResolvedValue({
      holdings: [
        holding('s1', 'STOCK', 700),
        { ...holding('s2', 'ETF', 300), symbol: 'NOPRICE', marketValue: null },
        { ...holding('s3', 'ETF', 300), symbol: 'EURO', currencyCode: 'EUR' },
      ],
      holdingsByAccount: [],
    });
    await renderWidget();
    const note = screen.getByTestId('weighting-partial-note');
    expect(note).toHaveTextContent('NOPRICE');
    expect(note).toHaveTextContent('EUR->USD');
  });

  it('shows no partial note when every holding is placed', async () => {
    getPortfolioSummary.mockResolvedValue({
      holdings: [holding('s1', 'STOCK', 700)],
      holdingsByAccount: [],
    });
    await renderWidget();
    expect(screen.queryByTestId('weighting-partial-note')).not.toBeInTheDocument();
  });

  it('groups holdings by security type', async () => {
    getPortfolioSummary.mockResolvedValue({
      holdings: [holding('s1', 'STOCK', 700), holding('s2', 'ETF', 300)],
      holdingsByAccount: [],
    });
    await renderWidget();
    expect(screen.getByText('Security Type Allocation')).toBeInTheDocument();
    expect(screen.getByText('Stocks')).toBeInTheDocument();
    expect(screen.getByText('ETFs')).toBeInTheDocument();
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
  });

  it('shows the empty state with no holdings', async () => {
    getPortfolioSummary.mockResolvedValue({ holdings: [], holdingsByAccount: [] });
    await renderWidget();
    expect(screen.getByText('No holdings to show.')).toBeInTheDocument();
  });

  it('leaves the look-through request unmade while the type view is showing', async () => {
    getPortfolioSummary.mockResolvedValue({ holdings: [holding('s1', 'STOCK', 700)], holdingsByAccount: [] });
    await renderWidget();
    expect(getAssetClassWeightings).not.toHaveBeenCalled();
  });

  it('shows the look-through asset classes in the asset class view', async () => {
    widgetCfg.config = { accountIds: [], view: 'assetClass' };
    getPortfolioSummary.mockResolvedValue({ holdings: [], holdingsByAccount: [] });
    getAssetClassWeightings.mockResolvedValue({
      items: [
        { assetClass: 'Equity', assetClassKey: 'equity', directValue: 600, etfValue: 100, totalValue: 700, percentage: 70 },
        { assetClass: 'Fixed Income', assetClassKey: 'fixedIncome', directValue: 0, etfValue: 200, totalValue: 200, percentage: 20 },
      ],
      totalPortfolioValue: 1000,
      totalDirectValue: 600,
      totalEtfValue: 300,
      unclassifiedValue: 100,
    });
    await renderWidget();
    // A fund's holdings are placed by what is inside it, not filed whole under
    // ETF, and the value the backend could not classify is its own slice.
    // A canonical class is named by its translation key, not the server's text.
    expect(screen.getByText('Equities')).toBeInTheDocument();
    expect(screen.queryByText('Equity')).not.toBeInTheDocument();
    expect(screen.getByText('Fixed Income')).toBeInTheDocument();
    expect(screen.getByText('Other')).toBeInTheDocument();
    expect(screen.queryByText('Stocks')).not.toBeInTheDocument();
  });

  it('says so when the look-through breakdown has nothing to place', async () => {
    widgetCfg.config = { accountIds: [], view: 'assetClass' };
    getPortfolioSummary.mockResolvedValue({ holdings: [], holdingsByAccount: [] });
    getAssetClassWeightings.mockResolvedValue({
      items: [],
      totalPortfolioValue: 0,
      totalDirectValue: 0,
      totalEtfValue: 0,
      unclassifiedValue: 0,
    });
    await renderWidget();
    expect(
      screen.getByText('No asset class breakdown available yet.'),
    ).toBeInTheDocument();
  });
});
