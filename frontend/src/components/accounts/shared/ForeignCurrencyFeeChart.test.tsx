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

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: mockFormatCurrency,
      formatCurrencyAxis: mockFormatCurrencyAxis,
    }),
  };
});
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

  // Converted from several currencies, three fees of 2.50496 read 2.50 a month
  // and the chart added those into a quarter and a total of 7.50 where the fees
  // come to 7.51; with the server's figures it prints those (issue #2413).
  describe("with the server's totals", () => {
    const months = [
      { month: '2026-01', total: 2.5, count: 1 },
      { month: '2026-02', total: 2.5, count: 1 },
      { month: '2026-03', total: 2.5, count: 1 },
    ];
    const totals = (gap = { missingCurrencies: [] as string[], excludedCount: 0 }) => {
      const complete = gap.missingCurrencies.length === 0;
      const column = (key: string, periodStart: string, known: number, count: number) => ({
        key,
        periodStart,
        total: complete ? known : null,
        knownTotal: known,
        count,
      });
      const average = (known: number) => ({ periodAverage: complete ? known : null, knownPeriodAverage: known });
      return {
        currency: 'CAD',
        total: complete ? 7.51 : null,
        knownTotal: 7.51,
        count: 3,
        byGranularity: {
          month: { buckets: months.map((m) => column(m.month, `${m.month}-01`, m.total, m.count)), ...average(2.5) },
          quarter: { buckets: [column('2026-Q1', '2026-01-01', 7.51, 3)], ...average(7.51) },
          year: { buckets: [column('2026', '2026-01-01', 7.51, 3)], ...average(7.51) },
        },
        ...gap,
      };
    };

    it('prints the total and a quarter as the server read them', () => {
      render(
        <ForeignCurrencyFeeChart data={months} isLoading={false} currencyCode="CAD" totals={totals()} />,
      );
      expect(screen.getByText('Total Fees').parentElement).toHaveTextContent('CAD 7.51');
      expect(screen.getByText('Monthly Avg').parentElement).toHaveTextContent('CAD 2.50');

      fireEvent.click(screen.getByRole('button', { name: 'Quarter' }));
      expect(capturedProps.barChart.data.map((d: { total: number }) => d.total)).toEqual([7.51]);
      expect(screen.getByText('Quarterly Avg').parentElement).toHaveTextContent('CAD 7.51');
    });

    it('marks the total partial when a fee had no rate', () => {
      render(
        <ForeignCurrencyFeeChart
          data={months}
          isLoading={false}
          currencyCode="CAD"
          totals={totals({ missingCurrencies: ['USD'], excludedCount: 1 })}
        />,
      );
      expect(screen.getByText('Total Fees').parentElement!.querySelector('[data-testid="partial-total"]')).not.toBeNull();
      // The average is over the same subtotal, so it carries the marker too.
      expect(screen.getByText('Monthly Avg').parentElement!.querySelector('[data-testid="partial-total"]')).not.toBeNull();
      expect(screen.getByText('Monthly Avg').parentElement).toHaveTextContent('CAD 2.50');
    });
  });

  it('colours fee bars from the expense token and refund months from income', () => {
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

    // Still red and green, but via the palette: the literals these replaced
    // stayed the default theme's shades on all twenty-odd colour themes.
    expect(capturedProps.cells.map((c) => c.fill)).toEqual([
      'var(--chart-expense)',
      'var(--chart-income)',
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

  it('hides the in-card title when hideTitle is set but keeps the chart', () => {
    render(
      <ForeignCurrencyFeeChart
        data={[{ month: '2025-01', total: 10, count: 1 }]}
        isLoading={false}
        currencyCode="CAD"
        hideTitle
      />,
    );

    expect(screen.queryByText('Fees Over Time')).not.toBeInTheDocument();
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    // The resolution selector and download button remain.
    expect(screen.getByRole('button', { name: 'Month' })).toBeInTheDocument();
  });

  it('renders leftControls opposite the resolution selector', () => {
    render(
      <ForeignCurrencyFeeChart
        data={[{ month: '2025-01', total: 10, count: 1 }]}
        isLoading={false}
        currencyCode="CAD"
        hideTitle
        leftControls={<div data-testid="left-controls">filter</div>}
      />,
    );

    expect(screen.getByTestId('left-controls')).toBeInTheDocument();
    // The resolution selector is still present on the same header.
    expect(screen.getByRole('button', { name: 'Month' })).toBeInTheDocument();
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
