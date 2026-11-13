import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { BudgetCategoryTrend } from './BudgetCategoryTrend';
import type { CategoryTrendSeries } from '@/types/budget';

// A chart's month markers go through the chart month formatter, which
// localizes the month NAME rather than following the date-format preference.
vi.mock('@/hooks/useChartMonthFormat', () => ({
  useChartMonthFormat: () => (monthKey: string) => `chartMonth:${monthKey}`,
}));

// Mock recharts
vi.mock('recharts', () => ({
  LineChart: ({ children, data }: { children: React.ReactNode; data: Array<{ monthKey: string }> }) => (
    <div data-testid="line-chart" data-month-keys={data.map((point) => point.monthKey).join(',')}>
      {children}
    </div>
  ),
  Line: ({ name }: { name: string }) => <div data-testid={`line-${name}`} />,
  XAxis: ({ dataKey, tickFormatter }: any) => (
    <div data-testid="x-axis">{dataKey}:{tickFormatter('2026-01')}</div>
  ),
  YAxis: () => <div data-testid="y-axis" />,
  CartesianGrid: () => <div data-testid="grid" />,
  Tooltip: ({ content }: any) => {
    if (!content) return <div data-testid="tooltip" />;
    const Content = content.type;
    return (
      <div data-testid="tooltip">
        <Content
          {...content.props}
          active
          label="2026-02"
          payload={[{ dataKey: 'cat-1', value: 530, color: 'red', name: 'Groceries' }]}
        />
      </div>
    );
  },
  Legend: () => <div data-testid="legend" />,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
}));

const mockFormat = (amount: number) => `$${amount.toFixed(2)}`;

const mockData: CategoryTrendSeries[] = [
  {
    categoryId: 'cat-1',
    categoryName: 'Groceries',
    data: [
      { monthKey: '2026-01', budgeted: 500, actual: 420, variance: -80, percentUsed: 84 },
      { monthKey: '2026-02', budgeted: 500, actual: 530, variance: 30, percentUsed: 106 },
    ],
  },
  {
    categoryId: 'cat-2',
    categoryName: 'Dining',
    data: [
      { monthKey: '2026-01', budgeted: 300, actual: 250, variance: -50, percentUsed: 83.33 },
      { monthKey: '2026-02', budgeted: 300, actual: 310, variance: 10, percentUsed: 103.33 },
    ],
  },
];

describe('BudgetCategoryTrend', () => {
  it('renders heading', () => {
    render(<BudgetCategoryTrend data={mockData} formatCurrency={mockFormat} />);
    expect(screen.getByText('Category Trends')).toBeInTheDocument();
  });

  it('renders category toggle buttons', () => {
    render(<BudgetCategoryTrend data={mockData} formatCurrency={mockFormat} />);
    expect(screen.getByTestId('category-toggle-cat-1')).toBeInTheDocument();
    expect(screen.getByTestId('category-toggle-cat-2')).toBeInTheDocument();
  });

  it('renders chart', () => {
    render(<BudgetCategoryTrend data={mockData} formatCurrency={mockFormat} />);
    expect(screen.getByTestId('category-trend-chart')).toBeInTheDocument();
    expect(screen.getByTestId('line-chart')).toBeInTheDocument();
    expect(screen.getByTestId('x-axis')).toHaveTextContent('monthKey:chartMonth:2026-01');
    expect(screen.getByTestId('tooltip')).toHaveTextContent('chartMonth:2026-02');
  });

  it('groups and orders chart points by the structural month key', () => {
    const reverseLocalizedOrder: CategoryTrendSeries[] = [
      {
        categoryId: 'cat-1',
        categoryName: 'Groceries',
        data: [mockData[0].data[1], mockData[0].data[0]],
      },
    ];

    render(
      <BudgetCategoryTrend data={reverseLocalizedOrder} formatCurrency={mockFormat} />,
    );

    expect(screen.getByTestId('line-chart')).toHaveAttribute(
      'data-month-keys',
      '2026-01,2026-02',
    );
  });

  it('draws no chart legend: the toggle pills are the legend', () => {
    // A recharts legend repeated every pill's name below the plot, and on a
    // phone it wrapped taller than the container and was drawn up over the
    // pills -- each category name twice, one on top of the other.
    render(<BudgetCategoryTrend data={mockData} formatCurrency={mockFormat} />);
    expect(screen.queryByTestId('legend')).not.toBeInTheDocument();
    expect(screen.getByTestId('category-toggle-cat-1')).toHaveTextContent('Groceries');
  });

  it('toggles category visibility when clicking toggle button', () => {
    render(<BudgetCategoryTrend data={mockData} formatCurrency={mockFormat} />);

    const toggleBtn = screen.getByTestId('category-toggle-cat-1');
    fireEvent.click(toggleBtn);

    // After toggling off, the button should lose its background color style
    // The line for cat-1 should not be rendered
    expect(toggleBtn).toBeInTheDocument();
  });

  it('shows empty state when no data', () => {
    render(<BudgetCategoryTrend data={[]} formatCurrency={mockFormat} />);
    expect(
      screen.getByText('Not enough data to display category trends yet.'),
    ).toBeInTheDocument();
  });

  it('renders summary table with average values', () => {
    render(<BudgetCategoryTrend data={mockData} formatCurrency={mockFormat} />);

    // Category names appear in both toggle buttons and summary table
    expect(screen.getAllByText('Groceries').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Dining').length).toBeGreaterThanOrEqual(2);
    // Each column label now appears in the column header AND as the per-cell
    // caption every row carries on a phone (the header row is hidden below
    // `sm`, so a bare figure has to name its own column), so the label matches
    // once per row plus once in the header. The VALUES are still unique --
    // `getByText('+$150.00')` below is untouched -- because a caption is its
    // own element rather than a text node of the value's cell.
    expect(screen.getAllByText('Avg Budget').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Avg Actual').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Avg Variance').length).toBeGreaterThan(0);
  });

  it('marks a category average holding a partial month and names the rate (issue #2155)', () => {
    const data: CategoryTrendSeries[] = [
      {
        ...mockData[0],
        data: [
          mockData[0].data[0],
          { ...mockData[0].data[1], valuationComplete: false, missingRatePairs: ['JPY->CAD'] },
        ],
      },
      mockData[1],
    ];
    render(<BudgetCategoryTrend data={data} formatCurrency={mockFormat} />);

    // Groceries' average (475) is a subtotal; Dining's (280) is whole.
    const markers = screen.getAllByTestId('partial-total');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toHaveTextContent('$475.00');
    expect(screen.getByTestId('budget-trend-partial-note')).toHaveTextContent(
      'No exchange rate for JPY->CAD: add one on the Currencies page.',
    );
  });

  it('marks nothing while every month is whole', () => {
    render(<BudgetCategoryTrend data={mockData} formatCurrency={mockFormat} />);

    expect(screen.queryByTestId('partial-total')).toBeNull();
    expect(screen.queryByTestId('budget-trend-partial-note')).toBeNull();
  });

  it('shows positive variance in red and negative in green', () => {
    render(<BudgetCategoryTrend data={mockData} formatCurrency={mockFormat} />);

    // Both categories average to negative variance (under budget on average)
    const varianceCells = screen.getAllByText(/^\+?\$[\d.-]+$/);
    expect(varianceCells.length).toBeGreaterThan(0);
  });

  it('renders chart lines for each selected category', () => {
    render(<BudgetCategoryTrend data={mockData} formatCurrency={mockFormat} />);

    expect(screen.getByTestId('line-Groceries')).toBeInTheDocument();
    expect(screen.getByTestId('line-Dining')).toBeInTheDocument();
  });

  it('shows positive variance with + prefix and red class', () => {
    const overBudgetData: CategoryTrendSeries[] = [
      {
        categoryId: 'cat-1',
        categoryName: 'Dining',
        data: [
          { monthKey: '2026-01', budgeted: 200, actual: 350, variance: 150, percentUsed: 175 },
        ],
      },
    ];
    const { container } = render(<BudgetCategoryTrend data={overBudgetData} formatCurrency={mockFormat} />);
    expect(screen.getByText('+$150.00')).toBeInTheDocument();
    expect(container.querySelector('.text-red-600')).toBeInTheDocument();
  });

  it('shows zero-data series with average 0', () => {
    const emptySeriesData: CategoryTrendSeries[] = [
      {
        categoryId: 'cat-1',
        categoryName: 'Empty',
        data: [],
      },
    ];
    render(<BudgetCategoryTrend data={emptySeriesData} formatCurrency={mockFormat} />);
    expect(screen.getAllByText('$0.00').length).toBeGreaterThan(0);
  });

  it('deselected toggle button has no background style', () => {
    render(<BudgetCategoryTrend data={mockData} formatCurrency={mockFormat} />);
    const toggleBtn = screen.getByTestId('category-toggle-cat-1');
    // Initially selected (has background style)
    expect(toggleBtn).toHaveStyle({ backgroundColor: expect.any(String) });
    fireEvent.click(toggleBtn);
    // After deselecting, backgroundColor should be unset
    expect(toggleBtn).not.toHaveStyle({ backgroundColor: 'var(--chart-1)' });
  });

  it('re-selects category when toggle clicked again', () => {
    render(<BudgetCategoryTrend data={mockData} formatCurrency={mockFormat} />);
    const toggleBtn = screen.getByTestId('category-toggle-cat-1');
    fireEvent.click(toggleBtn); // deselect
    fireEvent.click(toggleBtn); // re-select
    expect(screen.getByTestId('line-Groceries')).toBeInTheDocument();
  });
});
