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
    expect(screen.getByText('Total')).toBeInTheDocument();
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
});
