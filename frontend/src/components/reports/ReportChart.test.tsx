import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
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
});
