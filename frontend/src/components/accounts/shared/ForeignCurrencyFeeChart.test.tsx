import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { render, screen } from '@/test/render';
import { ForeignCurrencyFeeChart } from './ForeignCurrencyFeeChart';

// Capture props passed to the recharts primitives so tests can assert on the
// bucketed data and bar-top label styling (matching CategoryPayeeBarChart's
// test approach).
const capturedProps: { barChart: any; labelList: any; cells: any[] } = {
  barChart: null,
  labelList: null,
  cells: [],
};

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children, ...rest }: any) => {
    capturedProps.barChart = rest;
    return <div data-testid="bar-chart">{children}</div>;
  },
  Bar: ({ children }: any) => <div data-testid="bar">{children}</div>,
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: () => <div data-testid="y-axis" />,
  CartesianGrid: () => <div data-testid="cartesian-grid" />,
  Tooltip: () => <div data-testid="tooltip" />,
  LabelList: (props: any) => {
    capturedProps.labelList = props;
    return <div data-testid="label-list" />;
  },
  Cell: (props: any) => {
    capturedProps.cells.push(props);
    return <div data-testid="cell" />;
  },
}));

const mockIsMobile = vi.fn(() => false);
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile(),
}));

const mockFormatCurrency = vi.fn(
  (n: number, currency?: string) => `${currency ?? '$'} ${n.toFixed(2)}`,
);
const mockFormatCurrencyAxis = vi.fn((n: number) => `$${n}`);

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: mockFormatCurrency,
    formatCurrencyAxis: mockFormatCurrencyAxis,
  }),
}));

describe('ForeignCurrencyFeeChart', () => {
  beforeEach(() => {
    mockFormatCurrency.mockClear();
    mockIsMobile.mockReturnValue(false);
    capturedProps.barChart = null;
    capturedProps.labelList = null;
    capturedProps.cells = [];
  });

  it('renders loading state with title and pulse skeleton', () => {
    render(
      <ForeignCurrencyFeeChart data={[]} isLoading={true} currencyCode="CAD" />,
    );
    expect(screen.getByText('Fees Over Time')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('shows empty state when no data', () => {
    render(
      <ForeignCurrencyFeeChart data={[]} isLoading={false} currencyCode="CAD" />,
    );
    expect(
      screen.getByText('No foreign currency transactions yet'),
    ).toBeInTheDocument();
  });

  it('renders bars with a summary footer formatted in the account currency', () => {
    render(
      <ForeignCurrencyFeeChart
        data={[
          { month: '2025-01', total: 12.5, count: 3 },
          { month: '2025-02', total: 7.5, count: 2 },
        ]}
        isLoading={false}
        currencyCode="CAD"
      />,
    );

    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    expect(screen.getByText('Monthly Avg')).toBeInTheDocument();
    expect(screen.getByText('Total Fees')).toBeInTheDocument();
    expect(screen.getByText('Transactions')).toBeInTheDocument();
    // Total = 20, avg = 10, both in the account currency.
    expect(screen.getByText('CAD 20.00')).toBeInTheDocument();
    expect(screen.getByText('CAD 10.00')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('colours fee bars red (a cost) and refund months green', () => {
    render(
      <ForeignCurrencyFeeChart
        data={[
          { month: '2025-01', total: 12.5, count: 3 },
          { month: '2025-02', total: -2, count: 1 },
        ]}
        isLoading={false}
        currencyCode="CAD"
      />,
    );

    expect(capturedProps.cells.map((c) => c.fill)).toEqual([
      '#ef4444',
      '#22c55e',
    ]);
  });

  it('gap-fills empty months at their true position', () => {
    render(
      <ForeignCurrencyFeeChart
        data={[
          { month: '2025-01', total: 10, count: 1 },
          { month: '2025-06', total: 5, count: 1 },
        ]}
        isLoading={false}
        currencyCode="CAD"
      />,
    );

    expect(capturedProps.barChart.data).toHaveLength(6);
    expect(capturedProps.barChart.data[2].total).toBe(0);
  });

  it('defaults to Auto resolution and re-buckets on user override', () => {
    const months = Array.from({ length: 48 }, (_, i) => ({
      month: `${2020 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`,
      total: 5,
      count: 1,
    }));
    render(
      <ForeignCurrencyFeeChart data={months} isLoading={false} currencyCode="CAD" />,
    );

    // Auto pressed by default; 48 months auto-roll into 16 quarters.
    expect(
      screen.getByRole('button', { name: /auto/i }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Quarterly Avg')).toBeInTheDocument();
    expect(capturedProps.barChart.data).toHaveLength(16);

    fireEvent.click(screen.getByRole('button', { name: 'Month' }));
    expect(capturedProps.barChart.data).toHaveLength(48);
    fireEvent.click(screen.getByRole('button', { name: 'Year' }));
    expect(capturedProps.barChart.data).toHaveLength(4);
  });

  it('rotates bar-top labels vertical once the bars get dense', () => {
    const months = Array.from({ length: 21 }, (_, i) => ({
      month: `2024-${String((i % 12) + 1).padStart(2, '0')}`,
      total: 5,
      count: 1,
    })).map((m, i) => ({
      ...m,
      month: `${2023 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`,
    }));
    render(
      <ForeignCurrencyFeeChart data={months} isLoading={false} currencyCode="CAD" />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Month' }));

    expect(capturedProps.barChart.data.length).toBeGreaterThan(20);
    expect(capturedProps.labelList.angle).toBe(-90);
    expect(capturedProps.labelList.textAnchor).toBe('start');
  });

  it('renders a download button named after the chart and account', () => {
    render(
      <ForeignCurrencyFeeChart
        data={[{ month: '2025-01', total: 10, count: 1 }]}
        isLoading={false}
        currencyCode="CAD"
        accountName="Travel Card"
      />,
    );

    expect(
      screen.getByRole('button', { name: /download fees over time - travel card as png/i }),
    ).toBeInTheDocument();
  });
});
