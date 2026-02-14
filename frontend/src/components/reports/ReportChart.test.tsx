import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { ReportChart } from './ReportChart';
import { ReportViewType, GroupByType, TableColumn } from '@/types/custom-report';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatNumber: (n: number, decimals: number) => n.toFixed(decimals),
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    formatDate: (d: string) => d,
  }),
}));

vi.mock('@/lib/chart-colours', () => ({
  CHART_COLOURS: ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b'],
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  PieChart: ({ children }: any) => <div data-testid="pie-chart">{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  LineChart: ({ children }: any) => <div data-testid="line-chart">{children}</div>,
  Pie: () => null,
  Bar: () => null,
  Line: () => null,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

const sampleData = [
  { label: 'Groceries', value: 500, count: 20, id: 'cat-1' },
  { label: 'Transport', value: 200, count: 10, id: 'cat-2' },
  { label: 'Entertainment', value: 100, count: 5, id: 'cat-3' },
];

describe('ReportChart', () => {
  it('renders pie chart view', () => {
    render(
      <ReportChart
        viewType={ReportViewType.PIE_CHART}
        data={sampleData}
        groupBy={GroupByType.CATEGORY}
      />
    );
    expect(screen.getByTestId('pie-chart')).toBeInTheDocument();
  });

  it('renders bar chart view', () => {
    render(
      <ReportChart
        viewType={ReportViewType.BAR_CHART}
        data={sampleData}
        groupBy={GroupByType.CATEGORY}
      />
    );
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
  });

  it('renders line chart view', () => {
    render(
      <ReportChart
        viewType={ReportViewType.LINE_CHART}
        data={sampleData}
        groupBy={GroupByType.MONTH}
      />
    );
    expect(screen.getByTestId('line-chart')).toBeInTheDocument();
  });

  it('renders table view with data', () => {
    render(
      <ReportChart
        viewType={ReportViewType.TABLE}
        data={sampleData}
        groupBy={GroupByType.CATEGORY}
      />
    );
    expect(screen.getByText('Category')).toBeInTheDocument();
    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText('Transport')).toBeInTheDocument();
    expect(screen.getByText('Entertainment')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
  });

  it('renders table with custom columns', () => {
    render(
      <ReportChart
        viewType={ReportViewType.TABLE}
        data={sampleData}
        groupBy={GroupByType.PAYEE}
        tableColumns={[TableColumn.LABEL, TableColumn.VALUE]}
      />
    );
    expect(screen.getByText('Payee')).toBeInTheDocument();
    expect(screen.getByText('Amount')).toBeInTheDocument();
  });

  it('renders table with NONE groupBy showing Item header', () => {
    render(
      <ReportChart
        viewType={ReportViewType.TABLE}
        data={sampleData}
        groupBy={GroupByType.NONE}
      />
    );
    expect(screen.getByText('Item')).toBeInTheDocument();
  });

  it('renders table with MONTH groupBy showing Period header', () => {
    render(
      <ReportChart
        viewType={ReportViewType.TABLE}
        data={sampleData}
        groupBy={GroupByType.MONTH}
      />
    );
    expect(screen.getByText('Period')).toBeInTheDocument();
  });

  it('renders table with all column types', () => {
    const dataWithExtras = [
      {
        label: 'Test',
        value: 500,
        count: 20,
        id: 'cat-1',
        date: '2025-01-15',
        payee: 'Store A',
        description: 'Groceries shopping',
        memo: 'Weekly groceries',
        category: 'Food',
        account: 'Chequing',
      },
    ];
    render(
      <ReportChart
        viewType={ReportViewType.TABLE}
        data={dataWithExtras}
        groupBy={GroupByType.NONE}
        tableColumns={[
          TableColumn.DATE,
          TableColumn.LABEL,
          TableColumn.PAYEE,
          TableColumn.DESCRIPTION,
          TableColumn.MEMO,
          TableColumn.CATEGORY,
          TableColumn.ACCOUNT,
          TableColumn.VALUE,
          TableColumn.PERCENTAGE,
          TableColumn.COUNT,
        ]}
      />
    );
    expect(screen.getByText('Date')).toBeInTheDocument();
    expect(screen.getByText('Payee')).toBeInTheDocument();
    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(screen.getByText('Memo')).toBeInTheDocument();
    expect(screen.getByText('Account')).toBeInTheDocument();
    expect(screen.getByText('%')).toBeInTheDocument();
    expect(screen.getByText('Count')).toBeInTheDocument();
    expect(screen.getByText('Store A')).toBeInTheDocument();
    expect(screen.getByText('Weekly groceries')).toBeInTheDocument();
  });

  it('renders dash for missing optional fields', () => {
    const dataWithMissing = [
      { label: 'Test', value: 100, count: 0, id: 'cat-1' },
    ];
    render(
      <ReportChart
        viewType={ReportViewType.TABLE}
        data={dataWithMissing}
        groupBy={GroupByType.NONE}
        tableColumns={[
          TableColumn.DATE,
          TableColumn.LABEL,
          TableColumn.PAYEE,
          TableColumn.DESCRIPTION,
          TableColumn.MEMO,
          TableColumn.CATEGORY,
          TableColumn.ACCOUNT,
          TableColumn.VALUE,
          TableColumn.COUNT,
        ]}
      />
    );
    // Multiple dashes for missing values
    const dashes = screen.getAllByText('-');
    expect(dashes.length).toBeGreaterThanOrEqual(5);
  });

  it('renders table footer with Total in DATE column when both DATE and LABEL', () => {
    const data = [{ label: 'Test', value: 100, count: 5, id: 'cat-1', date: '2025-01-01' }];
    render(
      <ReportChart
        viewType={ReportViewType.TABLE}
        data={data}
        groupBy={GroupByType.CATEGORY}
        tableColumns={[TableColumn.DATE, TableColumn.LABEL, TableColumn.VALUE, TableColumn.PERCENTAGE, TableColumn.COUNT]}
      />
    );
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('handles table row click with onDataPointClick', async () => {
    const onClick = vi.fn();
    render(
      <ReportChart
        viewType={ReportViewType.TABLE}
        data={sampleData}
        groupBy={GroupByType.CATEGORY}
        onDataPointClick={onClick}
      />
    );
    fireEvent.click(screen.getByText('Groceries'));
    expect(onClick).toHaveBeenCalledWith('cat-1');
  });

  it('renders line chart with time-based groupBy', () => {
    render(
      <ReportChart
        viewType={ReportViewType.LINE_CHART}
        data={sampleData}
        groupBy={GroupByType.WEEK}
      />
    );
    expect(screen.getByTestId('line-chart')).toBeInTheDocument();
  });

  it('renders line chart with DAY groupBy', () => {
    render(
      <ReportChart
        viewType={ReportViewType.LINE_CHART}
        data={sampleData}
        groupBy={GroupByType.DAY}
      />
    );
    expect(screen.getByTestId('line-chart')).toBeInTheDocument();
  });

  it('renders default/fallback as table view for unknown viewType', () => {
    render(
      <ReportChart
        viewType={'UNKNOWN' as ReportViewType}
        data={sampleData}
        groupBy={GroupByType.CATEGORY}
      />
    );
    expect(screen.getByText('Category')).toBeInTheDocument();
  });

  it('assigns colours from CHART_COLOURS when data has no color', () => {
    const dataNoColor = [
      { label: 'A', value: 100, count: 1 },
      { label: 'B', value: 200, count: 2 },
    ];
    render(
      <ReportChart
        viewType={ReportViewType.TABLE}
        data={dataNoColor}
        groupBy={GroupByType.CATEGORY}
      />
    );
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
  });

  it('shows percentage with item.percentage when provided', () => {
    const dataWithPercentage = [
      { label: 'A', value: 100, count: 1, percentage: 42.5 },
    ];
    render(
      <ReportChart
        viewType={ReportViewType.TABLE}
        data={dataWithPercentage}
        groupBy={GroupByType.CATEGORY}
        tableColumns={[TableColumn.LABEL, TableColumn.VALUE, TableColumn.PERCENTAGE]}
      />
    );
    expect(screen.getByText('42.5%')).toBeInTheDocument();
  });

  it('renders totalCount as dash when zero', () => {
    const data = [{ label: 'A', value: 100 }];
    render(
      <ReportChart
        viewType={ReportViewType.TABLE}
        data={data}
        groupBy={GroupByType.CATEGORY}
        tableColumns={[TableColumn.LABEL, TableColumn.VALUE, TableColumn.COUNT]}
      />
    );
    const dashes = screen.getAllByText('-');
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });
});
