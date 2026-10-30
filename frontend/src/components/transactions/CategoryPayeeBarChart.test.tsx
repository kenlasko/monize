import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { render, screen } from '@/test/render';
import { CategoryPayeeBarChart } from './CategoryPayeeBarChart';

// Capture props passed to the recharts primitives we care about so individual
// tests can assert on axis / label styling (angle, interval, etc.).
const capturedProps: {
  xAxis: any;
  yAxis: any;
  labelList: any;
  barChart: any;
  cartesianGrid: any;
  cells: any[];
} = {
  xAxis: null,
  yAxis: null,
  labelList: null,
  barChart: null,
  cartesianGrid: null,
  cells: [],
};

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children, ...rest }: any) => {
    capturedProps.barChart = rest;
    return <div data-testid="bar-chart">{children}</div>;
  },
  Bar: ({ children }: any) => <div data-testid="bar">{children}</div>,
  XAxis: (props: any) => {
    capturedProps.xAxis = props;
    return <div data-testid="x-axis" />;
  },
  YAxis: (props: any) => {
    capturedProps.yAxis = props;
    return <div data-testid="y-axis" />;
  },
  CartesianGrid: (props: any) => {
    capturedProps.cartesianGrid = props;
    return <div data-testid="cartesian-grid" />;
  },
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

// Raw source of the component under test, so a guard can scan it for colour
// literals the way `src/test/ui-conventions.test.ts` scans the tree.
const chartSource = Object.values(
  import.meta.glob('./CategoryPayeeBarChart.tsx', {
    query: '?raw',
    eager: true,
    import: 'default',
  }) as Record<string, string>,
)[0];

// The download button hands the summary rows to `captureSvgAsImage` as its
// third argument; capture the call to assert what the exported PNG contains.
const mockCapture = vi.fn(async (..._args: unknown[]) => ({
  dataUrl: 'data:image/png;base64,x',
}));
vi.mock('@/lib/pdf-export-charts', () => ({
  captureSvgAsImage: (...args: unknown[]) => mockCapture(...args),
}));

// Control the mobile breakpoint deterministically from tests.
const mockIsMobile = vi.fn(() => false);
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile(),
}));

// Use vi.fn() so individual tests can override the implementation to simulate
// different currencies (e.g. USD with 2dp vs JPY with 0dp vs BHD with 3dp).
const mockFormatCurrency = vi.fn((n: number) => `$${n.toFixed(2)}`);
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
describe('CategoryPayeeBarChart', () => {
  beforeEach(() => {
    // Reset to default USD-like 2-decimal behaviour before each test
    mockFormatCurrency.mockImplementation((n: number) => `$${n.toFixed(2)}`);
    mockFormatCurrency.mockClear();
    mockIsMobile.mockReturnValue(false);
    capturedProps.xAxis = null;
    capturedProps.yAxis = null;
    capturedProps.labelList = null;
    capturedProps.barChart = null;
    capturedProps.cartesianGrid = null;
    capturedProps.cells = [];
    mockCapture.mockClear();
  });

  const buildMonths = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      month: `${2020 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`,
      total: -100,
      count: 1,
    }));

  it('renders loading state with title and pulse skeleton', () => {
    render(<CategoryPayeeBarChart data={[]} isLoading={true} />);
    expect(screen.getByText('Monthly Totals')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('offers the fold button in every state, only where the page asks for it', () => {
    const onCollapse = vi.fn();
    const data = buildMonths(3);
    const { rerender } = render(<CategoryPayeeBarChart data={data} isLoading={false} />);
    expect(screen.queryByRole('button', { name: 'Hide chart' })).not.toBeInTheDocument();

    for (const props of [
      { data: [], isLoading: true },
      { data: [], isLoading: false },
      { data, isLoading: false },
    ]) {
      rerender(<CategoryPayeeBarChart {...props} onCollapse={onCollapse} />);
      fireEvent.click(screen.getByRole('button', { name: 'Hide chart' }));
    }
    expect(onCollapse).toHaveBeenCalledTimes(3);
  });

  it('shows empty state when no data', () => {
    render(<CategoryPayeeBarChart data={[]} isLoading={false} />);
    expect(screen.getByText('No transaction data available')).toBeInTheDocument();
  });

  it('renders bar chart with data and summary footer', () => {
    render(
      <CategoryPayeeBarChart
        data={[
          { month: '2025-01', total: -500, count: 10 },
          { month: '2025-02', total: -300, count: 8 },
          { month: '2025-03', total: -400, count: 12 },
        ]}
        isLoading={false}
      />
    );

    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    expect(screen.getByText('Monthly Avg')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('Transactions')).toBeInTheDocument();
  });

  describe('theme colours', () => {
    const renderMixedMonths = () =>
      render(
        <CategoryPayeeBarChart
          data={[
            { month: '2025-01', total: -500, count: 10 },
            { month: '2025-02', total: 300, count: 8 },
          ]}
          isLoading={false}
        />
      );

    it('fills bars from the income and expense tokens, not fixed hex', () => {
      renderMixedMonths();
      // This chart is about the in/out split, so red and green are the
      // subject here -- but they come from the palette, not a literal.
      expect(capturedProps.cells.map((c) => c.fill)).toEqual([
        'var(--chart-expense)',
        'var(--chart-income)',
      ]);
    });

    it('draws the grid, axes and bar labels from the theme tokens', () => {
      renderMixedMonths();
      expect(capturedProps.cartesianGrid.stroke).toBe('var(--chart-grid)');
      expect(capturedProps.xAxis.axisLine.stroke).toBe('var(--chart-grid)');
      expect(capturedProps.xAxis.tick.fill).toBe('var(--chart-axis)');
      expect(capturedProps.yAxis.tick.fill).toBe('var(--chart-axis)');
      expect(capturedProps.labelList.style.fill).toBe('var(--chart-axis)');
    });

    it('leaves no hardcoded hex anywhere in the chart source', () => {
      // A guard rather than a fixture assertion: the original mistake was six
      // separate literals, and the next one will be somewhere else in the file.
      // The grid token carries its own dark override, so the `dark:stroke-*`
      // class that used to compensate must not come back either.
      expect(chartSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(chartSource).not.toMatch(/dark:stroke-/);
    });
  });

  it('exports the summary figures below the chart, not the bars alone', async () => {
    render(
      <CategoryPayeeBarChart
        data={[
          { month: '2025-01', total: -500, count: 10 },
          { month: '2025-02', total: -300, count: 8 },
        ]}
        isLoading={false}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Download/i }));
    });

    // Same three figures the on-screen footer shows, in the same order.
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture.mock.calls[0][2]).toEqual([
      { label: 'Monthly Avg', value: '$-400.00' },
      { label: 'Total', value: '$-800.00' },
      { label: 'Transactions', value: '18' },
    ]);
  });

  it('renders a download button titled after the chart when data is present', () => {
    render(
      <CategoryPayeeBarChart
        data={[{ month: '2025-01', total: -500, count: 10 }]}
        isLoading={false}
      />
    );

    expect(
      screen.getByRole('button', { name: /download monthly totals as png/i }),
    ).toBeInTheDocument();
  });

  it('hides the download button in loading and empty states', () => {
    const { rerender } = render(
      <CategoryPayeeBarChart data={[]} isLoading={true} />,
    );
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();

    rerender(<CategoryPayeeBarChart data={[]} isLoading={false} />);
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();
  });

  it('appends the filter label to the download button filename when provided', () => {
    render(
      <CategoryPayeeBarChart
        data={[{ month: '2025-01', total: -500, count: 10 }]}
        isLoading={false}
        filterLabel="Groceries, Walmart"
      />
    );

    expect(
      screen.getByRole('button', { name: /download monthly totals - groceries, walmart as png/i }),
    ).toBeInTheDocument();
  });

  it('shows correct summary values', () => {
    render(
      <CategoryPayeeBarChart
        data={[
          { month: '2025-01', total: -600, count: 10 },
          { month: '2025-02', total: -400, count: 5 },
        ]}
        isLoading={false}
      />
    );

    // Monthly avg = -1000 / 2 = -500 => $-500.00
    expect(screen.getByText('$-500.00')).toBeInTheDocument();
    // Total = -1000 => $-1000.00
    expect(screen.getByText('$-1000.00')).toBeInTheDocument();
    // Transaction count = 15
    expect(screen.getByText('15')).toBeInTheDocument();
  });

  it('marks the figures partial when a month has no exchange rate', () => {
    render(
      <CategoryPayeeBarChart
        data={[
          { month: '2025-01', total: -600, count: 10 },
          { month: '2025-02', total: null, knownSubtotal: -400, count: 5 },
        ]}
        isLoading={false}
      />
    );

    // The converted part still counts; the footer says it is not the whole.
    expect(screen.getByText('$-1000.00 *')).toBeInTheDocument();
    expect(
      screen.getByText(/Some amounts have no exchange rate/),
    ).toBeInTheDocument();
  });

  it('shows correct summary for positive totals', () => {
    render(
      <CategoryPayeeBarChart
        data={[
          { month: '2025-01', total: 1000, count: 5 },
          { month: '2025-02', total: 2000, count: 10 },
        ]}
        isLoading={false}
      />
    );

    // Total = 3000 => $3000.00
    expect(screen.getByText('$3000.00')).toBeInTheDocument();
    // Transaction count = 15
    expect(screen.getByText('15')).toBeInTheDocument();
  });

  it('passes Monthly Avg and Total through formatCurrency', () => {
    render(
      <CategoryPayeeBarChart
        data={[
          { month: '2025-01', total: 400, count: 2 },
          { month: '2025-02', total: 600, count: 3 },
        ]}
        isLoading={false}
      />
    );

    // formatCurrency must be called with the monthly avg (500) and the total (1000)
    const calledWith = mockFormatCurrency.mock.calls.map(([n]) => n);
    expect(calledWith).toContain(500);
    expect(calledWith).toContain(1000);
  });

  it('shows 0 decimal places when formatCurrency returns 0dp (e.g. JPY)', () => {
    // Simulate a 0-decimal currency like JPY
    mockFormatCurrency.mockImplementation((n: number) => `¥${Math.round(n).toLocaleString('en-US')}`);

    render(
      <CategoryPayeeBarChart
        data={[
          { month: '2025-01', total: 60000, count: 3 },
          { month: '2025-02', total: 40000, count: 2 },
        ]}
        isLoading={false}
      />
    );

    // Monthly avg = 50,000 (no decimals)
    expect(screen.getByText('¥50,000')).toBeInTheDocument();
    // Total = 100,000 (no decimals)
    expect(screen.getByText('¥100,000')).toBeInTheDocument();
  });

  it('shows 3 decimal places when formatCurrency returns 3dp (e.g. BHD)', () => {
    // Simulate a 3-decimal currency like BHD
    mockFormatCurrency.mockImplementation((n: number) => `BD${n.toFixed(3)}`);

    render(
      <CategoryPayeeBarChart
        data={[
          { month: '2025-01', total: 100, count: 1 },
          { month: '2025-02', total: 200, count: 1 },
        ]}
        isLoading={false}
      />
    );

    // Monthly avg = 150 => BD150.000
    expect(screen.getByText('BD150.000')).toBeInTheDocument();
    // Total = 300 => BD300.000
    expect(screen.getByText('BD300.000')).toBeInTheDocument();
  });

  describe('label crowding behaviour', () => {
    // Auto granularity rolls long spans up to quarters/years, so force the
    // 'month' bucket size to reproduce the many-thin-bars crowding case.
    const forceMonth = () =>
      fireEvent.click(screen.getByRole('button', { name: 'Month' }));

    it('always lets the X-axis skip ticks when crowded (preserveStartEnd)', () => {
      render(<CategoryPayeeBarChart data={buildMonths(48)} isLoading={false} />);
      expect(capturedProps.xAxis.interval).toBe('preserveStartEnd');
    });

    it('also lets the X-axis skip ticks when not crowded', () => {
      render(<CategoryPayeeBarChart data={buildMonths(6)} isLoading={false} />);
      expect(capturedProps.xAxis.interval).toBe('preserveStartEnd');
    });

    it('keeps desktop bar-top labels horizontal when uncrowded', () => {
      render(<CategoryPayeeBarChart data={buildMonths(6)} isLoading={false} />);
      expect(capturedProps.labelList.angle).toBe(0);
      expect(capturedProps.labelList.textAnchor).toBe('middle');
      expect(capturedProps.labelList.offset).toBe(5);
    });

    it('keeps desktop bar-top labels horizontal at exactly the density threshold', () => {
      render(<CategoryPayeeBarChart data={buildMonths(20)} isLoading={false} />);
      expect(capturedProps.barChart.data).toHaveLength(20);
      expect(capturedProps.labelList.angle).toBe(0);
    });

    it('rotates desktop bar-top labels vertical once the bars get dense and anchors them to sit above the bar', () => {
      // 21 monthly bars crosses the desktop density threshold.
      render(<CategoryPayeeBarChart data={buildMonths(21)} isLoading={false} />);
      expect(capturedProps.barChart.data).toHaveLength(21);
      expect(capturedProps.labelList.angle).toBe(-90);
      // textAnchor='start' (with angle -90) makes rotated text extend upward
      // from the anchor, so values never overlap the bar they label.
      expect(capturedProps.labelList.textAnchor).toBe('start');
      expect(capturedProps.labelList.offset).toBe(6);
      // dominantBaseline is nested inside the style object
      expect(capturedProps.labelList.style).toMatchObject({
        dominantBaseline: 'central',
      });
    });

    it('leaves mobile bar-top labels vertical regardless of column count', () => {
      mockIsMobile.mockReturnValue(true);
      render(<CategoryPayeeBarChart data={buildMonths(3)} isLoading={false} />);
      expect(capturedProps.labelList.angle).toBe(-90);
      expect(capturedProps.labelList.textAnchor).toBe('start');
      expect(capturedProps.labelList.offset).toBe(8);
      expect(capturedProps.labelList.style).toMatchObject({
        dominantBaseline: 'central',
      });
    });

    it('reserves extra top margin when bar-top labels are vertical', () => {
      render(<CategoryPayeeBarChart data={buildMonths(48)} isLoading={false} />);
      forceMonth();
      expect(capturedProps.barChart.margin.top).toBe(28);
    });

    it('uses a comfortable top margin when labels are horizontal', () => {
      render(<CategoryPayeeBarChart data={buildMonths(6)} isLoading={false} />);
      expect(capturedProps.barChart.margin.top).toBe(20);
    });

    it('still renders bar-top labels at the maximum labeled bar count', () => {
      render(<CategoryPayeeBarChart data={buildMonths(60)} isLoading={false} />);
      capturedProps.labelList = null;
      forceMonth();
      expect(capturedProps.barChart.data).toHaveLength(60);
      expect(capturedProps.labelList).not.toBeNull();
    });

    it('drops bar-top labels entirely once there are more than 60 bars', () => {
      render(<CategoryPayeeBarChart data={buildMonths(61)} isLoading={false} />);
      // Clear the capture from the initial (auto, quarterly) render so we only
      // observe whether the forced-monthly render emits a LabelList.
      capturedProps.labelList = null;
      forceMonth();
      expect(capturedProps.barChart.data).toHaveLength(61);
      expect(capturedProps.labelList).toBeNull();
    });
  });

  describe('adaptive granularity', () => {
    it('auto-selects monthly buckets for a short span (Monthly Avg)', () => {
      render(<CategoryPayeeBarChart data={buildMonths(3)} isLoading={false} />);
      expect(screen.getByText('Monthly Avg')).toBeInTheDocument();
      expect(capturedProps.barChart.data).toHaveLength(3);
    });

    it('auto-selects quarterly buckets for a medium span (Quarterly Avg)', () => {
      // 2020-01 .. 2023-01 = 37 monthly points -> 13 quarter buckets.
      render(<CategoryPayeeBarChart data={buildMonths(37)} isLoading={false} />);
      expect(screen.getByText('Quarterly Avg')).toBeInTheDocument();
      expect(capturedProps.barChart.data).toHaveLength(13);
    });

    it('auto-selects yearly buckets for a long, sparse span (Yearly Avg)', () => {
      render(
        <CategoryPayeeBarChart
          data={[
            { month: '2015-03', total: -1200, count: 1 },
            { month: '2024-07', total: -1200, count: 1 },
          ]}
          isLoading={false}
        />,
      );
      expect(screen.getByText('Yearly Avg')).toBeInTheDocument();
      // 2015..2024 inclusive = 10 year buckets.
      expect(capturedProps.barChart.data).toHaveLength(10);
      expect(capturedProps.barChart.data[0].periodStart).toBe('2015-01-01');
    });
  });

  describe('gap-fill and elapsed-period average', () => {
    it('fills calendar gaps with zero-value bars at their true position', () => {
      render(
        <CategoryPayeeBarChart
          data={[
            { month: '2020-01', total: -100, count: 1 },
            { month: '2020-12', total: -100, count: 1 },
          ]}
          isLoading={false}
        />,
      );
      // Jan..Dec = 12 bars even though only 2 months had transactions.
      expect(capturedProps.barChart.data).toHaveLength(12);
      const interior = capturedProps.barChart.data[5];
      expect(interior.total).toBe(0);
      expect(interior.count).toBe(0);
    });

    it('averages over elapsed periods, not just active ones', () => {
      render(
        <CategoryPayeeBarChart
          data={[
            { month: '2020-01', total: -100, count: 1 },
            { month: '2020-04', total: -300, count: 1 },
          ]}
          isLoading={false}
        />,
      );
      // 4 elapsed months (Jan..Apr): avg = -400 / 4 = -100 (not -400/2 = -200).
      expect(screen.getByText('$-100.00')).toBeInTheDocument();
      expect(capturedProps.barChart.data).toHaveLength(4);
    });
  });

  describe('drill-down', () => {
    it('drills into the clicked bucket range', () => {
      const onMonthClick = vi.fn();
      render(
        <CategoryPayeeBarChart
          data={buildMonths(37)}
          isLoading={false}
          onMonthClick={onMonthClick}
        />,
      );
      // Auto = quarter; the first bucket is 2020-Q1 (Jan 1 - Mar 31).
      capturedProps.barChart.onClick({ activeLabel: '2020-01-01' });
      expect(onMonthClick).toHaveBeenCalledWith('2020-01-01', '2020-03-31');
    });
  });

  describe('layout and axis', () => {
    it('positions bars by period start with no negative left margin', () => {
      render(<CategoryPayeeBarChart data={buildMonths(3)} isLoading={false} />);
      expect(capturedProps.xAxis.dataKey).toBe('periodStart');
      expect(capturedProps.barChart.margin.left).toBe(0);
    });
  });

  describe('granularity toggle', () => {
    it('re-buckets when the user overrides the auto granularity', () => {
      render(<CategoryPayeeBarChart data={buildMonths(48)} isLoading={false} />);
      // 2020-01..2023-12 auto-rolls into 16 quarters.
      expect(capturedProps.barChart.data).toHaveLength(16);
      fireEvent.click(screen.getByRole('button', { name: 'Month' }));
      expect(capturedProps.barChart.data).toHaveLength(48);
      fireEvent.click(screen.getByRole('button', { name: 'Year' }));
      expect(capturedProps.barChart.data).toHaveLength(4);
    });
  });

  // Recharts withholds a bar's LabelList until the entry animation finishes, so
  // an unrelated re-render from a parent blanks every value label and fades it
  // back -- it reads as the chart reloading data it never reloaded. Memo is what
  // stops a parent's unrelated state change from reaching the chart at all.
  describe('memoization', () => {
    it('is a memo component, so equal props skip the render', () => {
      const asMemo = CategoryPayeeBarChart as unknown as { $$typeof?: symbol };
      expect(asMemo.$$typeof).toBe(Symbol.for('react.memo'));
    });
  });
});
