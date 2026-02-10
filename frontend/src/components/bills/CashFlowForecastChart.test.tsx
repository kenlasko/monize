import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { CashFlowForecastChart } from './CashFlowForecastChart';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  LineChart: ({ children }: any) => <div data-testid="line-chart">{children}</div>,
  Line: () => <div data-testid="line" />,
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: () => <div data-testid="y-axis" />,
  CartesianGrid: () => <div data-testid="cartesian-grid" />,
  Tooltip: () => <div data-testid="tooltip" />,
  ReferenceLine: () => <div data-testid="reference-line" />,
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
  }),
}));

vi.mock('@/lib/forecast', () => ({
  buildForecast: () => [],
  getForecastSummary: () => ({
    startingBalance: 1000,
    endingBalance: 800,
    minBalance: 500,
    goesNegative: false,
  }),
  FORECAST_PERIOD_LABELS: {
    week: '1W',
    month: '1M',
    '90days': '90D',
    '6months': '6M',
    year: '1Y',
  },
}));

describe('CashFlowForecastChart', () => {
  it('renders loading state', () => {
    render(
      <CashFlowForecastChart scheduledTransactions={[]} accounts={[]} isLoading={true} />
    );
    expect(screen.getByText('Cash Flow Forecast')).toBeInTheDocument();
  });

  it('renders title when not loading', () => {
    render(
      <CashFlowForecastChart scheduledTransactions={[]} accounts={[]} isLoading={false} />
    );
    expect(screen.getByText('Cash Flow Forecast')).toBeInTheDocument();
  });

  it('shows empty state when no data', () => {
    render(
      <CashFlowForecastChart scheduledTransactions={[]} accounts={[]} isLoading={false} />
    );
    expect(screen.getByText('No data to display')).toBeInTheDocument();
  });

  it('shows period selector buttons', () => {
    render(
      <CashFlowForecastChart scheduledTransactions={[]} accounts={[]} isLoading={false} />
    );
    expect(screen.getByText('1W')).toBeInTheDocument();
    expect(screen.getByText('1M')).toBeInTheDocument();
    expect(screen.getByText('90D')).toBeInTheDocument();
    expect(screen.getByText('6M')).toBeInTheDocument();
    expect(screen.getByText('1Y')).toBeInTheDocument();
  });

  it('shows All Accounts option in account selector', () => {
    render(
      <CashFlowForecastChart scheduledTransactions={[]} accounts={[]} isLoading={false} />
    );
    expect(screen.getByText('All Accounts')).toBeInTheDocument();
  });
});
