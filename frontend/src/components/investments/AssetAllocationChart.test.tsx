import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { AssetAllocationChart } from './AssetAllocationChart';
import { investmentsApi } from '@/lib/investments';

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getAllocationByTag: vi.fn(),
    getCountryWeightings: vi.fn(),
    getAssetClassWeightings: vi.fn(),
    getPortfolioTagSummary: vi.fn(),
    getAllocationByTagKey: vi.fn(),
  },
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  PieChart: ({ children }: any) => <div data-testid="pie-chart">{children}</div>,
  Pie: () => null,
  Cell: () => null,
  Tooltip: () => null,
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
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

const emptyTag = { allocation: [], totalValue: 0 };
const emptyCountry = {
  items: [],
  totalPortfolioValue: 0,
  totalDirectValue: 0,
  totalEtfValue: 0,
  unclassifiedValue: 0,
};
const emptyAssetClass = emptyCountry;

// The chart fetches the tag summary and the country / asset-class look-throughs
// eagerly on mount to decide which selectors to offer, so every render kicks off
// async effects. The by-tag ALLOCATION is not among them -- it costs a portfolio
// valuation on the server and is fetched only when the tag view is selected.
async function renderChart(props: Parameters<typeof AssetAllocationChart>[0]) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<AssetAllocationChart {...props} />);
  });
  await act(async () => {}); // flush the eager tag/country fetches
  return result!;
}

describe('AssetAllocationChart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (investmentsApi.getAllocationByTag as any).mockResolvedValue(emptyTag);
    (investmentsApi.getCountryWeightings as any).mockResolvedValue(emptyCountry);
    (investmentsApi.getAssetClassWeightings as any).mockResolvedValue(emptyAssetClass);
    (investmentsApi.getPortfolioTagSummary as any).mockResolvedValue({
      keys: [],
      hasTaggedHoldings: false,
    });
    (investmentsApi.getAllocationByTagKey as any).mockResolvedValue(emptyTag);
  });

  it('renders loading state', async () => {
    await renderChart({ allocation: null, isLoading: true });
    expect(screen.getByText('Asset Allocation')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state when no allocation', async () => {
    await renderChart({ allocation: null, isLoading: false });
    expect(screen.getByText('No allocation data available.')).toBeInTheDocument();
  });

  it('renders chart with allocation data', async () => {
    const allocation = {
      totalValue: 50000,
      allocation: [
        { symbol: 'AAPL', name: 'Apple', type: 'security' as const, value: 30000, percentage: 60, color: '#3b82f6', currencyCode: 'CAD' },
        { symbol: 'MSFT', name: 'Microsoft', type: 'security' as const, value: 20000, percentage: 40, color: '#ef4444', currencyCode: 'CAD' },
      ],
    };

    await renderChart({ allocation, isLoading: false });
    expect(screen.getByTestId('pie-chart')).toBeInTheDocument();
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('MSFT')).toBeInTheDocument();
  });

  it('marks percentages as known-value-only when valuation is incomplete (RR5-005)', async () => {
    const allocation = {
      totalValue: 10000,
      allocation: [
        { symbol: 'VTI', name: 'Vanguard Total', type: 'security' as const, value: 10000, percentage: 100, color: '#22c55e', currencyCode: 'CAD' },
      ],
    };

    await renderChart({ allocation, isLoading: false, valuationComplete: false });

    // The user is told the 100% is a share of what could be valued, not the whole.
    expect(
      screen.getByText(/Percentages cover known value only/),
    ).toBeInTheDocument();
  });

  it('labels the allocation partial from its own flags and names what is missing (audit #2365 l)', async () => {
    const allocation = {
      totalValue: null,
      knownSubtotal: 10000,
      valuationComplete: false,
      pricesComplete: false,
      fxComplete: false,
      unpricedSecurityIds: ['sec-vfv'],
      missingRatePairs: ['EUR->CAD'],
      allocation: [
        { symbol: 'VTI', name: 'Vanguard Total', type: 'security' as const, value: 10000, percentage: 100, color: '#22c55e', currencyCode: 'CAD' },
      ],
    };
    const holdingsByAccount = [
      { holdings: [{ securityId: 'sec-vfv', symbol: 'VFV.TO' }] },
    ] as any;

    await renderChart({ allocation, isLoading: false, holdingsByAccount });

    expect(screen.getByText(/Percentages cover known value only/)).toBeInTheDocument();
    expect(screen.getByText(/Not valued: VFV\.TO, EUR->CAD\./)).toBeInTheDocument();
  });

  it('labels the by-tag view partial from the by-tag response (audit #2365 l)', async () => {
    (investmentsApi.getPortfolioTagSummary as any).mockResolvedValue({
      keys: [],
      hasTaggedHoldings: true,
    });
    (investmentsApi.getAllocationByTag as any).mockResolvedValue({
      totalValue: null,
      knownSubtotal: 10000,
      valuationComplete: false,
      unpricedSecurityIds: ['sec-x'],
      missingRatePairs: [],
      allocation: [
        { symbol: null, name: 'Growth', type: 'tag' as const, value: 10000, percentage: 100, color: '#22c55e', currencyCode: 'CAD' },
      ],
    });
    // The parent's own flag is clean; only the tag response says partial.
    const allocation = { totalValue: 10000, allocation: [] };

    await renderChart({ allocation, isLoading: false, valuationComplete: true, accountIds: [] });
    await act(async () => {
      fireEvent.click(await screen.findByText('By tag'));
    });

    expect(screen.getByText(/Percentages cover known value only/)).toBeInTheDocument();
    expect(screen.getByText(/Not valued: sec-x\./)).toBeInTheDocument();
  });

  it('says nothing when the valuation is complete', async () => {
    const allocation = {
      totalValue: 10000,
      allocation: [
        { symbol: 'VTI', name: 'Vanguard Total', type: 'security' as const, value: 10000, percentage: 100, color: '#22c55e', currencyCode: 'CAD' },
      ],
    };

    await renderChart({ allocation, isLoading: false, valuationComplete: true });

    expect(
      screen.queryByText(/Percentages cover known value only/),
    ).not.toBeInTheDocument();
  });

  it('warns from the account-currency aggregate in the single foreign-account view (review #1133)', async () => {
    // The tooltip's values there are percentage * foreignTotal, an
    // account-currency aggregate over holdingsByAccount -- a different
    // conversion from the top-level default-currency flag, which can be clean
    // while the account's own valuation is not (RR5-001 again).
    const allocation = {
      totalValue: 100,
      allocation: [
        { symbol: 'EUSTX', name: 'Euro Stoxx', type: 'security' as const, value: 100, percentage: 100, color: '#22c55e', currencyCode: 'EUR' },
      ],
    };

    await renderChart({
      allocation,
      isLoading: false,
      valuationComplete: true,
      singleAccountCurrency: 'JPY',
      holdingsByAccount: [
        {
          accountId: 'a1',
          accountName: 'Tokyo Brokerage',
          currencyCode: 'JPY',
          cashAccountId: null,
          cashBalance: 0,
          holdings: [],
          totalCostBasis: 0,
          totalMarketValue: 0,
          unpricedHoldingsCount: 0,
          totalGainLoss: 0,
          totalGainLossPercent: 0,
          netInvested: 0,
          fxComplete: false,
          missingRatePairs: ['EUR->JPY'],
          pricesComplete: true,
          unpricedSecurityIds: [],
          valuationComplete: false,
        },
      ],
    });

    expect(
      screen.getByText(/Percentages cover known value only/),
    ).toBeInTheDocument();
  });

  it('keeps the warning when the tag view falls back to the security view (review #1133)', async () => {
    // The no-tags fallback renders the security view while the STORED groupBy
    // still says 'tag'; gating the warning on the stored value dropped it over
    // exactly the numbers it was written for.
    const tagAllocation = {
      totalValue: 10000,
      allocation: [
        { symbol: null, name: 'AI', type: 'tag' as any, value: 10000, percentage: 100, color: '#abcdef', currencyCode: 'CAD' },
      ],
    };
    const untaggedOnly = {
      totalValue: 10000,
      allocation: [
        { symbol: null, name: 'Untagged', type: 'untagged' as any, value: 10000, percentage: 100, color: '#9ca3af', currencyCode: 'CAD' },
      ],
    };
    (investmentsApi.getAllocationByTag as any).mockImplementation(
      async (ids?: string[]) => (ids ? untaggedOnly : tagAllocation),
    );
    (investmentsApi.getPortfolioTagSummary as any).mockImplementation(
      async (ids?: string[]) => ({
        keys: [],
        hasTaggedHoldings: !ids,
      }),
    );
    const allocation = {
      totalValue: 10000,
      allocation: [
        { symbol: 'VTI', name: 'Vanguard Total', type: 'security' as const, value: 10000, percentage: 100, color: '#22c55e', currencyCode: 'CAD' },
      ],
    };

    const { rerender } = await renderChart({
      allocation,
      isLoading: false,
      valuationComplete: false,
      accountIds: [],
    });
    await act(async () => {
      fireEvent.click(await screen.findByText('By tag'));
    });
    // The tag view is active; the warning is about the security view only.
    expect(
      screen.queryByText(/Percentages cover known value only/),
    ).not.toBeInTheDocument();

    // Account filter changes to accounts with no tags: the chart falls back to
    // the security view while groupBy still says 'tag'.
    await act(async () => {
      rerender(
        <AssetAllocationChart
          allocation={allocation}
          isLoading={false}
          valuationComplete={false}
          accountIds={['acct-untagged']}
        />,
      );
    });
    await act(async () => {});

    expect(screen.getByText('VTI')).toBeInTheDocument();
    expect(
      screen.getByText(/Percentages cover known value only/),
    ).toBeInTheDocument();
  });

  it('shows percentages in legend', async () => {
    const allocation = {
      totalValue: 10000,
      allocation: [
        { symbol: 'VTI', name: 'Vanguard Total', type: 'security' as const, value: 7500, percentage: 75, color: '#22c55e', currencyCode: 'CAD' },
      ],
    };

    await renderChart({ allocation, isLoading: false });
    expect(screen.getByText('75.0%')).toBeInTheDocument();
  });

  it('shows titleSuffix in heading', async () => {
    await renderChart({ allocation: null, isLoading: false, titleSuffix: 'RRSP' });
    expect(screen.getByText('Asset Allocation (RRSP)')).toBeInTheDocument();
  });

  it('shows empty state when allocation has zero items', async () => {
    const emptyAllocation = { totalValue: 0, allocation: [] };
    await renderChart({ allocation: emptyAllocation, isLoading: false });
    expect(screen.getByText('No allocation data available.')).toBeInTheDocument();
  });

  it('uses name as legend label when symbol is falsy', async () => {
    const allocation = {
      totalValue: 10000,
      allocation: [
        { symbol: '', name: 'Cash', type: 'cash' as any, value: 10000, percentage: 100, color: '#22c55e', currencyCode: 'CAD' },
      ],
    };
    await renderChart({ allocation, isLoading: false });
    expect(screen.getByText('Cash')).toBeInTheDocument();
  });

  it('uses default color #6b7280 when item.color is falsy', async () => {
    const allocation = {
      totalValue: 10000,
      allocation: [
        { symbol: 'VTI', name: 'Vanguard', type: 'security' as const, value: 10000, percentage: 100, color: undefined, currencyCode: 'CAD' },
      ],
    };
    const { container } = await renderChart({ allocation, isLoading: false });
    expect(container.querySelector('[style*="background-color"]')).toBeInTheDocument();
  });

  it('shows currency code badge for USD holding in CAD portfolio', async () => {
    const allocation = {
      totalValue: 10000,
      allocation: [
        { symbol: 'AAPL', name: 'Apple', type: 'security' as const, value: 10000, percentage: 100, color: '#3b82f6', currencyCode: 'USD' },
      ],
    };
    await renderChart({ allocation, isLoading: false });
    expect(screen.getByText('(USD)')).toBeInTheDocument();
  });

  it('does not show currency badge when singleAccountCurrency matches item currency', async () => {
    const allocation = {
      totalValue: 10000,
      allocation: [
        { symbol: 'AAPL', name: 'Apple', type: 'security' as const, value: 10000, percentage: 100, color: '#3b82f6', currencyCode: 'USD' },
      ],
    };
    await renderChart({ allocation, isLoading: false, singleAccountCurrency: 'USD' });
    expect(screen.queryByText('(USD)')).not.toBeInTheDocument();
  });

  const securityAllocation = {
    totalValue: 10000,
    allocation: [
      { symbol: 'AAPL', name: 'Apple', type: 'security' as const, value: 10000, percentage: 100, color: '#3b82f6', currencyCode: 'CAD' },
    ],
  };

  describe('by-tag grouping', () => {
    const tagAllocation = {
      totalValue: 10000,
      allocation: [
        { symbol: null, name: 'AI', type: 'tag', value: 8000, percentage: 80, color: '#abcdef', currencyCode: 'CAD' },
        { symbol: null, name: 'Untagged', type: 'untagged', value: 2000, percentage: 20, color: '#9ca3af', currencyCode: 'CAD' },
      ],
    };

    it('offers and renders the by-tag allocation when tags are in use', async () => {
      (investmentsApi.getAllocationByTag as any).mockResolvedValue(tagAllocation);
      (investmentsApi.getPortfolioTagSummary as any).mockResolvedValue({
        keys: [],
        hasTaggedHoldings: true,
      });

      await renderChart({ allocation: securityAllocation, isLoading: false, accountIds: [] });

      // The valuation-backed allocation is not paid for until the view is
      // selected; only the cheap tag summary has been asked for.
      expect(investmentsApi.getAllocationByTag).not.toHaveBeenCalled();
      expect(investmentsApi.getPortfolioTagSummary).toHaveBeenCalledWith(undefined);
      const tagButton = await screen.findByText('By tag');

      await act(async () => {
        fireEvent.click(tagButton);
      });

      expect(investmentsApi.getAllocationByTag).toHaveBeenCalledWith(undefined);
      expect(await screen.findByText('AI')).toBeInTheDocument();
      expect(screen.getByText('Untagged')).toBeInTheDocument();
    });

    it('fetches the by-tag allocation once, on the first selection', async () => {
      (investmentsApi.getAllocationByTag as any).mockResolvedValue(tagAllocation);
      (investmentsApi.getPortfolioTagSummary as any).mockResolvedValue({
        keys: [],
        hasTaggedHoldings: true,
      });

      await renderChart({ allocation: securityAllocation, isLoading: false, accountIds: [] });

      await act(async () => {
        fireEvent.click(await screen.findByText('By tag'));
      });
      await act(async () => {
        fireEvent.click(screen.getByText('By security'));
      });
      await act(async () => {
        fireEvent.click(screen.getByText('By tag'));
      });

      expect(investmentsApi.getAllocationByTag).toHaveBeenCalledTimes(1);
    });

    it('hides the by-tag selector when no holdings are tagged', async () => {
      (investmentsApi.getPortfolioTagSummary as any).mockResolvedValue({
        keys: [],
        hasTaggedHoldings: false,
      });

      await renderChart({ allocation: securityAllocation, isLoading: false, accountIds: [] });

      expect(investmentsApi.getAllocationByTag).not.toHaveBeenCalled();
      expect(screen.queryByText('By tag')).not.toBeInTheDocument();
      // With no other groupings available, the toggle is absent entirely.
      expect(screen.queryByText('By security')).not.toBeInTheDocument();
    });

    it('does not fetch tags or show the selector when enableTagGrouping is false', async () => {
      await renderChart({ allocation: securityAllocation, isLoading: false, enableTagGrouping: false });
      expect(investmentsApi.getAllocationByTag).not.toHaveBeenCalled();
      expect(investmentsApi.getPortfolioTagSummary).not.toHaveBeenCalled();
      expect(screen.queryByText('By tag')).not.toBeInTheDocument();
    });
  });

  describe('by-country grouping', () => {
    const countryResult = {
      totalPortfolioValue: 10000,
      totalDirectValue: 6000,
      totalEtfValue: 3000,
      unclassifiedValue: 1000,
      items: [
        { country: 'United States', directValue: 5000, etfValue: 1000, totalValue: 6000, percentage: 60 },
        { country: 'Canada', directValue: 1000, etfValue: 2000, totalValue: 3000, percentage: 30 },
      ],
    };

    it('offers and renders the by-country allocation when country data exists', async () => {
      (investmentsApi.getCountryWeightings as any).mockResolvedValue(countryResult);

      await renderChart({ allocation: securityAllocation, isLoading: false, accountIds: [] });

      expect(investmentsApi.getCountryWeightings).toHaveBeenCalledWith(undefined);
      const countryButton = await screen.findByText('By country');

      await act(async () => {
        fireEvent.click(countryButton);
      });

      expect(await screen.findByText('United States')).toBeInTheDocument();
      expect(screen.getByText('Canada')).toBeInTheDocument();
    });

    it('hides the by-country selector when there is no country data', async () => {
      await renderChart({ allocation: securityAllocation, isLoading: false, accountIds: [] });
      expect(screen.queryByText('By country')).not.toBeInTheDocument();
    });

    it('keeps only the top 10 countries and groups the rest as Other Countries', async () => {
      const items = Array.from({ length: 12 }, (_, i) => {
        const totalValue = 120 - i * 10; // 120, 110, ... 10
        return {
          country: `C${i + 1}`,
          directValue: totalValue,
          etfValue: 0,
          totalValue,
          percentage: (totalValue / 800) * 100,
        };
      });
      (investmentsApi.getCountryWeightings as any).mockResolvedValue({
        totalPortfolioValue: 800,
        totalDirectValue: 780,
        totalEtfValue: 0,
        unclassifiedValue: 20,
        items,
      });

      await renderChart({ allocation: securityAllocation, isLoading: false, accountIds: [] });
      await act(async () => {
        fireEvent.click(await screen.findByText('By country'));
      });

      // Top 10 shown individually.
      expect(await screen.findByText('C1')).toBeInTheDocument();
      expect(screen.getByText('C10')).toBeInTheDocument();
      // Ranks 11+ collapse into the catch-all bucket.
      expect(screen.queryByText('C11')).not.toBeInTheDocument();
      expect(screen.queryByText('C12')).not.toBeInTheDocument();
      expect(screen.getByText('Other Countries')).toBeInTheDocument();
    });
  });

  describe('by-asset-class grouping', () => {
    const assetClassResult = {
      totalPortfolioValue: 10000,
      totalDirectValue: 4000,
      totalEtfValue: 5500,
      unclassifiedValue: 500,
      items: [
        { assetClass: 'Equities', assetClassKey: 'equity', directValue: 4000, etfValue: 2000, totalValue: 6000, percentage: 60 },
        { assetClass: 'Fixed Income', assetClassKey: 'fixedIncome', directValue: 0, etfValue: 3000, totalValue: 3000, percentage: 30 },
        { assetClass: 'Real Estate', assetClassKey: null, directValue: 0, etfValue: 500, totalValue: 500, percentage: 5 },
      ],
    };

    it('offers and renders the by-asset-class allocation when data exists', async () => {
      (investmentsApi.getAssetClassWeightings as any).mockResolvedValue(assetClassResult);

      await renderChart({ allocation: securityAllocation, isLoading: false, accountIds: [] });

      expect(investmentsApi.getAssetClassWeightings).toHaveBeenCalledWith(undefined);
      const button = await screen.findByText('By asset class');

      await act(async () => {
        fireEvent.click(button);
      });

      // Canonical classes are named from the translation catalog; a class the
      // user typed is shown as typed.
      expect(await screen.findByText('Equities')).toBeInTheDocument();
      expect(screen.getByText('Fixed Income')).toBeInTheDocument();
      expect(screen.getByText('Real Estate')).toBeInTheDocument();
      // The unclassified remainder becomes the catch-all slice.
      expect(screen.getByText('Other Asset Classes')).toBeInTheDocument();
    });

    it('hides the by-asset-class selector when there is no asset-class data', async () => {
      await renderChart({ allocation: securityAllocation, isLoading: false, accountIds: [] });
      expect(screen.queryByText('By asset class')).not.toBeInTheDocument();
    });

    it('passes the selected accounts to the asset-class fetch', async () => {
      (investmentsApi.getAssetClassWeightings as any).mockResolvedValue(assetClassResult);

      await renderChart({
        allocation: securityAllocation,
        isLoading: false,
        accountIds: ['acct-1'],
      });

      expect(investmentsApi.getAssetClassWeightings).toHaveBeenCalledWith(['acct-1']);
    });
  });

  it('shows all four selectors when tag, country and asset-class data are present', async () => {
    (investmentsApi.getAssetClassWeightings as any).mockResolvedValue({
      totalPortfolioValue: 10000,
      totalDirectValue: 10000,
      totalEtfValue: 0,
      unclassifiedValue: 0,
      items: [{ assetClass: 'Equities', assetClassKey: 'equity', directValue: 10000, etfValue: 0, totalValue: 10000, percentage: 100 }],
    });
    (investmentsApi.getPortfolioTagSummary as any).mockResolvedValue({
      keys: [],
      hasTaggedHoldings: true,
    });
    (investmentsApi.getCountryWeightings as any).mockResolvedValue({
      totalPortfolioValue: 10000,
      totalDirectValue: 10000,
      totalEtfValue: 0,
      unclassifiedValue: 0,
      items: [{ country: 'United States', directValue: 10000, etfValue: 0, totalValue: 10000, percentage: 100 }],
    });

    await renderChart({ allocation: securityAllocation, isLoading: false, accountIds: [] });

    expect(await screen.findByText('By tag')).toBeInTheDocument();
    expect(screen.getByText('By country')).toBeInTheDocument();
    expect(screen.getByText('By asset class')).toBeInTheDocument();
    expect(screen.getByText('By security')).toBeInTheDocument();
  });
});
