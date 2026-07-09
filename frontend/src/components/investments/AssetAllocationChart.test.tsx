import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { AssetAllocationChart } from './AssetAllocationChart';
import { investmentsApi } from '@/lib/investments';

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getAllocationByTag: vi.fn(),
    getCountryWeightings: vi.fn(),
    getPortfolioTagKeys: vi.fn(),
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

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
  }),
}));

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

// The chart fetches the by-tag and by-country allocations eagerly on mount to
// decide which selectors to offer, so every render kicks off async effects.
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
    (investmentsApi.getPortfolioTagKeys as any).mockResolvedValue([]);
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

      await renderChart({ allocation: securityAllocation, isLoading: false, accountIds: [] });

      expect(investmentsApi.getAllocationByTag).toHaveBeenCalledWith(undefined);
      const tagButton = await screen.findByText('By tag');

      await act(async () => {
        fireEvent.click(tagButton);
      });

      expect(await screen.findByText('AI')).toBeInTheDocument();
      expect(screen.getByText('Untagged')).toBeInTheDocument();
    });

    it('hides the by-tag selector when no holdings are tagged', async () => {
      (investmentsApi.getAllocationByTag as any).mockResolvedValue({
        totalValue: 10000,
        allocation: [
          { symbol: null, name: 'Untagged', type: 'untagged', value: 10000, percentage: 100, color: '#9ca3af', currencyCode: 'CAD' },
        ],
      });

      await renderChart({ allocation: securityAllocation, isLoading: false, accountIds: [] });

      expect(screen.queryByText('By tag')).not.toBeInTheDocument();
      // With no other groupings available, the toggle is absent entirely.
      expect(screen.queryByText('By security')).not.toBeInTheDocument();
    });

    it('does not fetch tags or show the selector when enableTagGrouping is false', async () => {
      await renderChart({ allocation: securityAllocation, isLoading: false, enableTagGrouping: false });
      expect(investmentsApi.getAllocationByTag).not.toHaveBeenCalled();
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

  it('shows all three selectors when tags and country data are both present', async () => {
    (investmentsApi.getAllocationByTag as any).mockResolvedValue({
      totalValue: 10000,
      allocation: [
        { symbol: null, name: 'AI', type: 'tag', value: 8000, percentage: 80, color: '#abcdef', currencyCode: 'CAD' },
      ],
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
    expect(screen.getByText('By security')).toBeInTheDocument();
  });
});
