import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { AssetAllocationChart } from './AssetAllocationChart';

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

describe('AssetAllocationChart', () => {
  it('renders loading state', () => {
    render(<AssetAllocationChart allocation={null} isLoading={true} />);
    expect(screen.getByText('Asset Allocation')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state when no allocation', () => {
    render(<AssetAllocationChart allocation={null} isLoading={false} />);
    expect(screen.getByText('No allocation data available.')).toBeInTheDocument();
  });

  it('renders chart with allocation data', () => {
    const allocation = {
      totalValue: 50000,
      allocation: [
        { symbol: 'AAPL', name: 'Apple', type: 'security' as const, value: 30000, percentage: 60, color: '#3b82f6', currencyCode: 'CAD' },
        { symbol: 'MSFT', name: 'Microsoft', type: 'security' as const, value: 20000, percentage: 40, color: '#ef4444', currencyCode: 'CAD' },
      ],
    };

    render(<AssetAllocationChart allocation={allocation} isLoading={false} />);
    expect(screen.getByTestId('pie-chart')).toBeInTheDocument();
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('MSFT')).toBeInTheDocument();
  });

  it('shows percentages in legend', () => {
    const allocation = {
      totalValue: 10000,
      allocation: [
        { symbol: 'VTI', name: 'Vanguard Total', type: 'security' as const, value: 7500, percentage: 75, color: '#22c55e', currencyCode: 'CAD' },
      ],
    };

    render(<AssetAllocationChart allocation={allocation} isLoading={false} />);
    expect(screen.getByText('75.0%')).toBeInTheDocument();
  });

  it('shows titleSuffix in heading', () => {
    render(<AssetAllocationChart allocation={null} isLoading={false} titleSuffix="RRSP" />);
    expect(screen.getByText('Asset Allocation (RRSP)')).toBeInTheDocument();
  });

  it('shows empty state when allocation has zero items', () => {
    const emptyAllocation = { totalValue: 0, allocation: [] };
    render(<AssetAllocationChart allocation={emptyAllocation} isLoading={false} />);
    expect(screen.getByText('No allocation data available.')).toBeInTheDocument();
  });

  it('uses name as legend label when symbol is falsy', () => {
    const allocation = {
      totalValue: 10000,
      allocation: [
        { symbol: '', name: 'Cash', type: 'cash' as any, value: 10000, percentage: 100, color: '#22c55e', currencyCode: 'CAD' },
      ],
    };
    render(<AssetAllocationChart allocation={allocation} isLoading={false} />);
    expect(screen.getByText('Cash')).toBeInTheDocument();
  });

  it('uses default color #6b7280 when item.color is falsy', () => {
    const allocation = {
      totalValue: 10000,
      allocation: [
        { symbol: 'VTI', name: 'Vanguard', type: 'security' as const, value: 10000, percentage: 100, color: undefined, currencyCode: 'CAD' },
      ],
    };
    const { container } = render(<AssetAllocationChart allocation={allocation} isLoading={false} />);
    expect(container.querySelector('[style*="background-color"]')).toBeInTheDocument();
  });

  it('shows currency code badge for USD holding in CAD portfolio', () => {
    const allocation = {
      totalValue: 10000,
      allocation: [
        { symbol: 'AAPL', name: 'Apple', type: 'security' as const, value: 10000, percentage: 100, color: '#3b82f6', currencyCode: 'USD' },
      ],
    };
    render(<AssetAllocationChart allocation={allocation} isLoading={false} />);
    expect(screen.getByText('(USD)')).toBeInTheDocument();
  });

  it('does not show currency badge when singleAccountCurrency matches item currency', () => {
    const allocation = {
      totalValue: 10000,
      allocation: [
        { symbol: 'AAPL', name: 'Apple', type: 'security' as const, value: 10000, percentage: 100, color: '#3b82f6', currencyCode: 'USD' },
      ],
    };
    render(<AssetAllocationChart allocation={allocation} isLoading={false} singleAccountCurrency="USD" />);
    expect(screen.queryByText('(USD)')).not.toBeInTheDocument();
  });
});
