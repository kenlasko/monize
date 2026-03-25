import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { BalanceHistoryChart } from './BalanceHistoryChart';

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

const mockFormatCurrency = vi.fn((n: number, _code?: string) => `$${n.toFixed(2)}`);
const mockFormatCurrencyAxis = vi.fn((n: number, _code?: string) => `$${n}`);

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: mockFormatCurrency,
    formatCurrencyAxis: mockFormatCurrencyAxis,
  }),
}));

describe('BalanceHistoryChart', () => {
  it('renders loading state with title and pulse skeleton', () => {
    render(
      <BalanceHistoryChart data={[]} isLoading={true} />
    );
    expect(screen.getByText('Balance History')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('shows empty state when no data returned', () => {
    render(
      <BalanceHistoryChart data={[]} isLoading={false} />
    );
    expect(screen.getByText('No balance data available')).toBeInTheDocument();
  });

  it('renders chart with data and summary footer', () => {
    render(
      <BalanceHistoryChart
        data={[
          { date: '2025-01-01', balance: 1000 },
          { date: '2025-01-02', balance: 750 },
          { date: '2025-01-03', balance: 900 },
        ]}
        isLoading={false}
      />
    );

    expect(screen.getByTestId('line-chart')).toBeInTheDocument();
    expect(screen.getByText('Starting')).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.getByText('Min Balance')).toBeInTheDocument();
    expect(screen.getByText('$1000.00')).toBeInTheDocument();
    expect(screen.getByText('$900.00')).toBeInTheDocument();
    expect(screen.getByText('$750.00')).toBeInTheDocument();
  });

  it('shows "Lowest" label and warning when balance goes negative', () => {
    render(
      <BalanceHistoryChart
        data={[
          { date: '2025-01-01', balance: 100 },
          { date: '2025-01-02', balance: -50 },
        ]}
        isLoading={false}
      />
    );

    expect(screen.getByText('Lowest')).toBeInTheDocument();
    expect(screen.getByText('!')).toBeInTheDocument();
  });

  it('shows Ending balance when future transactions exist', () => {
    render(
      <BalanceHistoryChart
        data={[
          { date: '2026-01-01', balance: 1000 },
          { date: '2026-03-19', balance: 800 },
          { date: '2026-04-15', balance: 650 },
          { date: '2026-05-01', balance: 500 },
        ]}
        isLoading={false}
      />
    );

    expect(screen.getByText('Starting')).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.getByText('Ending')).toBeInTheDocument();
    expect(screen.getByText('Min Balance')).toBeInTheDocument();
  });

  it('does not show Ending balance when no future transactions', () => {
    render(
      <BalanceHistoryChart
        data={[
          { date: '2025-01-01', balance: 1000 },
          { date: '2025-06-01', balance: 750 },
          { date: '2025-12-31', balance: 900 },
        ]}
        isLoading={false}
      />
    );

    expect(screen.getByText('Starting')).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.queryByText('Ending')).not.toBeInTheDocument();
  });

  it('shows Current as today balance and Ending as last future data point', () => {
    // All values must be unique to avoid getByText collisions
    // Data: start=2000, dip=1500, current(today)=1800, ending=1900
    // Min balance = 1500
    render(
      <BalanceHistoryChart
        data={[
          { date: '2026-03-01', balance: 2000 },
          { date: '2026-03-10', balance: 1500 },
          { date: '2026-03-15', balance: 1800 },
          { date: '2026-04-01', balance: 1900 },
        ]}
        isLoading={false}
      />
    );

    expect(screen.getByText('Ending')).toBeInTheDocument();
    // Starting = 2000, Current = 1800 (today or before), Ending = 1900, Min = 1500
    expect(screen.getByText('$2000.00')).toBeInTheDocument();
    expect(screen.getByText('$1800.00')).toBeInTheDocument();
    expect(screen.getByText('$1900.00')).toBeInTheDocument();
    expect(screen.getByText('$1500.00')).toBeInTheDocument();
  });

  it('passes currencyCode to formatting functions', () => {
    mockFormatCurrency.mockClear();

    render(
      <BalanceHistoryChart
        data={[
          { date: '2025-01-01', balance: 500 },
          { date: '2025-01-02', balance: 600 },
        ]}
        isLoading={false}
        currencyCode="EUR"
      />
    );

    // Summary footer calls formatCurrency with currencyCode
    const eurCalls = mockFormatCurrency.mock.calls.filter(
      ([, code]) => code === 'EUR',
    );
    expect(eurCalls.length).toBeGreaterThan(0);
  });
});
