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
  Pie: ({ onClick, data }: any) => (
    <div data-testid="pie">
      <button data-testid="pie-click-with-id" onClick={() => onClick && onClick(data[0])}>click-id</button>
      <button data-testid="pie-click-no-id" onClick={() => onClick && onClick({ value: 1 })}>click-no-id</button>
    </div>
  ),
  Bar: ({ onClick, children }: any) => (
    <div data-testid="bar">
      {children}
      <button data-testid="bar-click-with-id" onClick={() => onClick && onClick({ id: 'cat-1', value: 100 })}>bar-id</button>
      <button data-testid="bar-click-no-id" onClick={() => onClick && onClick({ value: 100 })}>bar-no-id</button>
    </div>
  ),
  Line: () => null,
  Cell: () => null,
  XAxis: ({ tickFormatter }: any) => <div>{tickFormatter ? tickFormatter(100) : ''}</div>,
  YAxis: ({ tickFormatter }: any) => <div>{tickFormatter ? tickFormatter(1000) : ''}</div>,
  CartesianGrid: () => null,
  Tooltip: ({ content }: any) => {
    if (content && content.type) {
      const C = content.type;
      return (
        <div data-testid="tooltip">
          <C active={true} payload={[{ payload: { label: 'Groceries', value: 500, count: 20, color: '#000' } }]} />
          <C active={true} payload={[{ payload: { label: 'Single', value: 100, count: 1, color: '#000' } }]} />
          <C active={true} payload={[{ payload: { label: 'NoCount', value: 0, color: '#000' } }]} />
          <C active={false} payload={[]} />
        </div>
      );
    }
    return null;
  },
}));

vi.mock('@/lib/csv-export', () => ({
  exportToCsv: vi.fn(),
}));

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
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

  it('handles pie chart click with and without id', () => {
    const onClick = vi.fn();
    render(
      <ReportChart
        viewType={ReportViewType.PIE_CHART}
        data={sampleData}
        groupBy={GroupByType.CATEGORY}
        onDataPointClick={onClick}
      />
    );
    fireEvent.click(screen.getByTestId('pie-click-with-id'));
    fireEvent.click(screen.getByTestId('pie-click-no-id'));
    expect(onClick).toHaveBeenCalledWith('cat-1');
  });

  it('handles bar chart click with and without id', () => {
    const onClick = vi.fn();
    render(
      <ReportChart
        viewType={ReportViewType.BAR_CHART}
        data={sampleData}
        groupBy={GroupByType.CATEGORY}
        onDataPointClick={onClick}
      />
    );
    fireEvent.click(screen.getByTestId('bar-click-with-id'));
    fireEvent.click(screen.getByTestId('bar-click-no-id'));
    expect(onClick).toHaveBeenCalledWith('cat-1');
  });

  it('exports csv', async () => {
    const { exportToCsv } = await import('@/lib/csv-export');
    render(
      <ReportChart
        viewType={ReportViewType.TABLE}
        data={sampleData}
        groupBy={GroupByType.CATEGORY}
        exportFilename="my-report"
        reportTitle="My Report"
        reportSubtitle="Subtitle"
      />
    );
    const exportBtn = screen.getByRole('button', { name: /export/i });
    fireEvent.click(exportBtn);
    const csvBtn = screen.queryByText(/CSV/i);
    if (csvBtn) {
      fireEvent.click(csvBtn);
    }
    expect(exportToCsv).toHaveBeenCalled();
  });

  it('exports pdf with various views', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    render(
      <ReportChart
        viewType={ReportViewType.PIE_CHART}
        data={sampleData}
        groupBy={GroupByType.CATEGORY}
        exportFilename="my-report"
        reportTitle="My Report"
        reportSubtitle="Subtitle"
      />
    );
    const exportBtn = screen.getByRole('button', { name: /export/i });
    fireEvent.click(exportBtn);
    const pdfBtn = screen.queryByText(/PDF/i);
    if (pdfBtn) {
      fireEvent.click(pdfBtn);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(exportToPdf).toHaveBeenCalled();
  });

  it('exports csv with all columns and date label', async () => {
    const { exportToCsv } = await import('@/lib/csv-export');
    (exportToCsv as any).mockClear();
    const data = [
      {
        label: 'X', value: 100, count: 5, id: 'a',
        date: '2024-01-01', payee: 'P', description: 'D', memo: 'M',
        category: 'C', account: 'A', percentage: 50,
      },
    ];
    render(
      <ReportChart
        viewType={ReportViewType.TABLE}
        data={data}
        groupBy={GroupByType.CATEGORY}
        tableColumns={[
          TableColumn.DATE, TableColumn.LABEL, TableColumn.PAYEE,
          TableColumn.DESCRIPTION, TableColumn.MEMO, TableColumn.CATEGORY,
          TableColumn.ACCOUNT, TableColumn.VALUE, TableColumn.PERCENTAGE,
          TableColumn.COUNT, TableColumn.TAG,
        ]}
      />
    );
    const exportBtn = screen.getByRole('button', { name: /export/i });
    fireEvent.click(exportBtn);
    const csvBtn = screen.queryByText(/CSV/i);
    if (csvBtn) {
      fireEvent.click(csvBtn);
    }
    expect(exportToCsv).toHaveBeenCalled();
  });

  it('exports pdf with DATE-only label fallback in totalRow', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    render(
      <ReportChart
        viewType={ReportViewType.PIE_CHART}
        data={[{ label: '2024', value: 100, count: 5, date: '2024-01-01' }]}
        groupBy={GroupByType.MONTH}
        tableColumns={[TableColumn.DATE, TableColumn.VALUE, TableColumn.PERCENTAGE, TableColumn.COUNT]}
      />
    );
    const exportBtn = screen.getByRole('button', { name: /export/i });
    fireEvent.click(exportBtn);
    const pdfBtn = screen.queryByText(/PDF/i);
    if (pdfBtn) {
      fireEvent.click(pdfBtn);
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it('exports pdf for table view (no chart container)', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    render(
      <ReportChart
        viewType={ReportViewType.TABLE}
        data={sampleData}
        groupBy={GroupByType.CATEGORY}
        tableColumns={[TableColumn.DATE, TableColumn.VALUE, TableColumn.PERCENTAGE, TableColumn.COUNT]}
      />
    );
    const exportBtn = screen.getByRole('button', { name: /export/i });
    fireEvent.click(exportBtn);
    const pdfBtn = screen.queryByText(/PDF/i);
    if (pdfBtn) {
      fireEvent.click(pdfBtn);
      await new Promise((r) => setTimeout(r, 50));
    }
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
