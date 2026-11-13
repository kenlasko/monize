import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { BudgetTrendChart } from './BudgetTrendChart';

// A chart's month markers go through the chart month formatter, which
// localizes the month NAME; the date-format preference (`useDateFormat`) would
// give a numeric `01/2026` tick, which is a table column's answer.
vi.mock('@/hooks/useChartMonthFormat', () => ({
  useChartMonthFormat: () => (monthKey: string) => `chartMonth:${monthKey}`,
}));

// The data point the mocked tooltip is hovering, for the partial-month case.
const mockTooltip = vi.hoisted(() => ({ point: undefined as unknown }));

// Mock recharts to avoid rendering actual SVGs in tests
vi.mock('recharts', () => ({
  LineChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="line-chart">{children}</div>
  ),
  Line: ({ name }: { name: string }) => <div data-testid={`line-${name}`} />,
  XAxis: ({ dataKey, tickFormatter }: any) => (
    <div data-testid="x-axis">{dataKey}:{tickFormatter('2025-09')}</div>
  ),
  YAxis: () => <div data-testid="y-axis" />,
  CartesianGrid: () => <div data-testid="grid" />,
  Tooltip: ({ content }: any) => {
    // Render the tooltip content with active payload to cover CustomTooltip branches
    const payload = [
      { value: 5000, dataKey: 'budgeted', color: 'var(--chart-primary)' },
      {
        value: 4800,
        dataKey: 'actual',
        color: 'var(--chart-income)',
        payload: mockTooltip.point,
      },
    ];
    if (content) {
      const ContentComponent = content.type;
      return (
        <div data-testid="tooltip">
          <ContentComponent
            active={true}
            payload={payload}
            label="2025-09"
            formatCurrency={content.props?.formatCurrency}
            formatChartMonth={content.props?.formatChartMonth}
            budgetedLabel={content.props?.budgetedLabel}
            actualLabel={content.props?.actualLabel}
          />
        </div>
      );
    }
    return <div data-testid="tooltip" />;
  },
  Legend: () => <div data-testid="legend" />,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
}));

const mockFormat = (amount: number) => `$${amount.toFixed(2)}`;

const mockData = [
  { monthKey: '2025-09', budgeted: 5000, actual: 4800, variance: -200, percentUsed: 96 },
  { monthKey: '2025-10', budgeted: 5000, actual: 5200, variance: 200, percentUsed: 104 },
  { monthKey: '2025-11', budgeted: 5200, actual: 5100, variance: -100, percentUsed: 98.08 },
  { monthKey: '2025-12', budgeted: 5200, actual: 6000, variance: 800, percentUsed: 115.38 },
  { monthKey: '2026-01', budgeted: 5200, actual: 4900, variance: -300, percentUsed: 94.23 },
  { monthKey: '2026-02', budgeted: 5200, actual: 3100, variance: -2100, percentUsed: 59.62 },
];

describe('BudgetTrendChart', () => {
  it('renders heading', () => {
    render(<BudgetTrendChart data={mockData} formatCurrency={mockFormat} />);

    expect(screen.getByText('Budget vs Actual Trend')).toBeInTheDocument();
  });

  it('renders chart with data', () => {
    render(<BudgetTrendChart data={mockData} formatCurrency={mockFormat} />);

    expect(screen.getByTestId('line-chart')).toBeInTheDocument();
    expect(screen.getByTestId('line-Budgeted')).toBeInTheDocument();
    expect(screen.getByTestId('line-Actual')).toBeInTheDocument();
    expect(screen.getByTestId('x-axis')).toHaveTextContent('monthKey:chartMonth:2025-09');
  });

  it('shows empty state when no data', () => {
    render(<BudgetTrendChart data={[]} formatCurrency={mockFormat} />);

    expect(
      screen.getByText('Not enough data to display trends yet.'),
    ).toBeInTheDocument();
  });

  it('renders responsive container', () => {
    render(<BudgetTrendChart data={mockData} formatCurrency={mockFormat} />);

    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
  });

  it('renders tooltip with budgeted and actual values when active', () => {
    render(<BudgetTrendChart data={mockData} formatCurrency={mockFormat} />);

    // Tooltip mock renders content component with active=true and payload
    expect(screen.getByTestId('tooltip')).toBeInTheDocument();
    // The tooltip should localize the structural key and format the values.
    expect(screen.getByText('chartMonth:2025-09')).toBeInTheDocument();
    expect(screen.getByText(/Budgeted.*\$5000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Actual.*\$4800\.00/)).toBeInTheDocument();
  });

  it('marks a partial month and names the missing rate (issue #2155)', () => {
    const partial = {
      ...mockData[0],
      valuationComplete: false,
      missingRatePairs: ['JPY->CAD'],
    };
    mockTooltip.point = partial;
    try {
      render(
        <BudgetTrendChart data={[partial, mockData[1]]} formatCurrency={mockFormat} />,
      );
    } finally {
      mockTooltip.point = undefined;
    }

    expect(screen.getByText(/Actual.*\$4800\.00/)).toHaveTextContent('(partial)');
    expect(screen.getByTestId('budget-trend-partial-note')).toHaveTextContent(
      'No exchange rate for JPY->CAD: add one on the Currencies page.',
    );
  });

  it('adds no partial note while every month is whole', () => {
    render(<BudgetTrendChart data={mockData} formatCurrency={mockFormat} />);

    expect(screen.queryByTestId('budget-trend-partial-note')).toBeNull();
    expect(screen.getByText(/Actual.*\$4800\.00/)).not.toHaveTextContent('(partial)');
  });

  it('renders with single data point', () => {
    render(
      <BudgetTrendChart
        data={[{ monthKey: '2026-01', budgeted: 1000, actual: 900, variance: -100, percentUsed: 90 }]}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByTestId('line-chart')).toBeInTheDocument();
  });

  it('shows heading in both data and empty states', () => {
    const { unmount } = render(<BudgetTrendChart data={mockData} formatCurrency={mockFormat} />);
    expect(screen.getByText('Budget vs Actual Trend')).toBeInTheDocument();
    unmount();

    render(<BudgetTrendChart data={[]} formatCurrency={mockFormat} />);
    expect(screen.getByText('Budget vs Actual Trend')).toBeInTheDocument();
  });
});
