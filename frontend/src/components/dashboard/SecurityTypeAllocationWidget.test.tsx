import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { Account } from '@/types/account';
import { HoldingWithMarketValue } from '@/types/investment';
import { SecurityTypeAllocationWidget } from './SecurityTypeAllocationWidget';

vi.mock('recharts', async () => {
  const base = (await import('@/test/recharts-mock')).rechartsMock();
  return {
    ...base,
    // The slices the chart is handed, so a test can read their figures.
    Pie: ({ data, children }: { data: unknown[]; children?: React.ReactNode }) => (
      <div data-testid="pie-data" data-slices={JSON.stringify(data)}>
        {children}
      </div>
    ),
  };
});

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

const getPortfolioValuation = vi.fn();
const getAssetClassWeightings = vi.fn();
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioValuation: (...a: unknown[]) => getPortfolioValuation(...a),
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
    getPortfolioValuation.mockReset();
    getAssetClassWeightings.mockReset();
    widgetCfg.config = { accountIds: [], view: 'type' };
    rateless.currencies = [];
  });

  it('says which holdings the type view left out, as the asset class view does', async () => {
    rateless.currencies = ['EUR'];
    getPortfolioValuation.mockResolvedValue({
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
    getPortfolioValuation.mockResolvedValue({
      holdings: [holding('s1', 'STOCK', 700)],
      holdingsByAccount: [],
    });
    await renderWidget();
    expect(screen.queryByTestId('weighting-partial-note')).not.toBeInTheDocument();
  });

  it('groups holdings by security type', async () => {
    getPortfolioValuation.mockResolvedValue({
      holdings: [holding('s1', 'STOCK', 700), holding('s2', 'ETF', 300)],
      holdingsByAccount: [],
    });
    await renderWidget();
    expect(screen.getByText('Security Type Allocation')).toBeInTheDocument();
    expect(screen.getByText('Stocks')).toBeInTheDocument();
    expect(screen.getByText('ETFs')).toBeInTheDocument();
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
  });

  it('totals each type once from the exact sum of its holdings (issue #2414)', async () => {
    // 1.0007 + 1.0143 is 2.0149999999999997 in doubles; the exact sum is 2.015,
    // which reads 2.02, as the Security Type Allocation report reads it.
    getPortfolioValuation.mockResolvedValue({
      holdings: [holding('s1', 'STOCK', 1.0007), holding('s2', 'STOCK', 1.0143)],
      holdingsByAccount: [],
    });
    await renderWidget();
    const slices = JSON.parse(screen.getByTestId('pie-data').dataset.slices!);
    expect(slices[0]).toMatchObject({ type: 'STOCK', totalValue: 2.02, percentage: 100 });
  });

  it('asks for the valuation again when the dashboard refreshed prices, keeping the chart meanwhile', async () => {
    getPortfolioValuation.mockResolvedValue({
      holdings: [holding('s1', 'STOCK', 700), holding('s2', 'ETF', 300)],
      holdingsByAccount: [],
    });
    const widget = (refreshKey: number) => (
      <SecurityTypeAllocationWidget accounts={[investmentAccount]} isLoading={false} refreshKey={refreshKey} />
    );
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(widget(0));
    });

    let answer: (value: unknown) => void = () => {};
    getPortfolioValuation.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await act(async () => {
      view.rerender(widget(1));
    });
    expect(getPortfolioValuation).toHaveBeenCalledTimes(2);
    // The same question asked again: the chart drawn stays until it answers.
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
    expect(screen.getByText('ETFs')).toBeInTheDocument();

    await act(async () => {
      answer({ holdings: [holding('s1', 'STOCK', 700)], holdingsByAccount: [] });
    });
    expect(screen.queryByText('ETFs')).not.toBeInTheDocument();
  });

  it('asks for the look-through breakdown again when the dashboard refreshed prices', async () => {
    widgetCfg.config = { accountIds: [], view: 'assetClass' };
    getPortfolioValuation.mockResolvedValue({ holdings: [], holdingsByAccount: [] });
    getAssetClassWeightings.mockResolvedValue({
      items: [
        { assetClass: 'Equity', assetClassKey: 'equity', directValue: 700, etfValue: 0, totalValue: 700, percentage: 100 },
      ],
      totalPortfolioValue: 700,
      totalDirectValue: 700,
      totalEtfValue: 0,
      unclassifiedValue: 0,
    });
    const widget = (refreshKey: number) => (
      <SecurityTypeAllocationWidget accounts={[investmentAccount]} isLoading={false} refreshKey={refreshKey} />
    );
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(widget(0));
    });
    getAssetClassWeightings.mockReturnValue(new Promise(() => {}));
    await act(async () => {
      view.rerender(widget(1));
    });
    expect(getAssetClassWeightings).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Equities')).toBeInTheDocument();
  });

  it('shows the empty state with no holdings', async () => {
    getPortfolioValuation.mockResolvedValue({ holdings: [], holdingsByAccount: [] });
    await renderWidget();
    expect(screen.getByText('No holdings to show.')).toBeInTheDocument();
  });

  it('leaves the look-through request unmade while the type view is showing', async () => {
    getPortfolioValuation.mockResolvedValue({ holdings: [holding('s1', 'STOCK', 700)], holdingsByAccount: [] });
    await renderWidget();
    expect(getAssetClassWeightings).not.toHaveBeenCalled();
  });

  it('shows the look-through asset classes in the asset class view', async () => {
    widgetCfg.config = { accountIds: [], view: 'assetClass' };
    getPortfolioValuation.mockResolvedValue({ holdings: [], holdingsByAccount: [] });
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
    getPortfolioValuation.mockResolvedValue({ holdings: [], holdingsByAccount: [] });
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
