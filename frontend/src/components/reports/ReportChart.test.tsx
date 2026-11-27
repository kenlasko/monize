import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, renderInLocale, screen, fireEvent, act } from '@/test/render';
import frCommon from '@/i18n/messages/fr/common.json';
import frReports from '@/i18n/messages/fr/reports.json';
import { ReportChart } from './ReportChart';
import { ReportViewType, GroupByType, TableColumn, MetricType } from '@/types/custom-report';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatNumber: (n: number, decimals: number) => n.toFixed(decimals),
      defaultCurrency: 'CAD',
    }),
  };
});
vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ dateFormat: 'browser', datePattern: 'YYYY-MM-DD',
    formatDate: (d: string) => d,
  }),
}));

vi.mock('@/lib/chart-colours', () => ({
  CHART_COLOURS: ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b'],
  CHART_COLOURS_ASSETS: ['positive'],
  CHART_COLOURS_LIABILITIES: ['negative'],
}));

// The rows a test hands the mocked tooltip; null hands it the fixed three below.
const tooltipItems = vi.hoisted(() => ({ current: null as any[] | null }));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  PieChart: ({ children }: any) => <div data-testid="pie-chart">{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  LineChart: ({ children }: any) => <div data-testid="line-chart">{children}</div>,
  Pie: ({ onClick, data, dataKey }: any) => (
    <div data-testid="pie" data-colours={data.map((row: { color: string }) => row.color).join(',')} data-sizes={data.map((row: Record<string, number>) => row[dataKey]).join(',')}>
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
      if (tooltipItems.current) {
        return (
          <div data-testid="tooltip">
            {tooltipItems.current.map((item) => (
              <C key={item.label} {...content.props} active={true} payload={[{ payload: item }]} />
            ))}
          </div>
        );
      }
      return (
        <div data-testid="tooltip">
          <C {...content.props} active={true} payload={[{ payload: { label: 'Groceries', value: 500, count: 20, color: '#000' } }]} />
          <C {...content.props} active={true} payload={[{ payload: { label: 'Single', value: 100, count: 1, color: '#000' } }]} />
          <C {...content.props} active={true} payload={[{ payload: { label: 'NoCount', value: 0, color: '#000' } }]} />
          <C {...content.props} active={false} payload={[]} />
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
  afterEach(() => {
    tooltipItems.current = null;
  });

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

  // docs/specs/transfer-categories.md section 10: a measure row a rate is
  // missing from is labelled partial, and a withheld net names its known part.
  it('labels a partial transfer measure row and a withheld net', () => {
    render(
      <ReportChart
        viewType={ReportViewType.TABLE}
        data={[
          { id: 'a', label: 'Savings contributions', value: 700 },
          { id: 'b', label: 'Investment contributions', value: null, knownValue: -917.9, incomplete: true },
        ]}
        groupBy={GroupByType.CATEGORY}
        tableColumns={[TableColumn.LABEL, TableColumn.VALUE]}
      />
    );
    const row = screen.getByText('Investment contributions').closest('tr')!;
    expect(row).toHaveTextContent('(partial: a rate is missing)');
    expect(row).toHaveTextContent(/Unknown \(.*917\.90 known\)/);
    const complete = screen.getByText('Savings contributions').closest('tr')!;
    expect(complete).not.toHaveTextContent('partial');
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
        category: 'Food: Fast Food',
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
    // Category column shows 'Parent: Child' format for subcategories
    expect(screen.getByText('Food: Fast Food')).toBeInTheDocument();
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
    const data = [{ label: 'Test', value: 100, count: 5, id: 'cat-1', date: '2025-01-01', percentage: 100 }];
    render(
      <ReportChart
        viewType={ReportViewType.TABLE}
        data={data}
        groupBy={GroupByType.CATEGORY}
        tableColumns={[TableColumn.DATE, TableColumn.LABEL, TableColumn.VALUE, TableColumn.PERCENTAGE, TableColumn.COUNT]}
      />
    );
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(document.querySelector('tfoot')).toHaveTextContent('100.0%');
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
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
    const pdfBtn = screen.queryByText(/PDF/i);
    if (pdfBtn) {
      await act(async () => { fireEvent.click(pdfBtn); });
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

  it('exports the pdf with formatted cells, a cent-exact total and a partial marker', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    render(
      <ReportChart
        viewType={ReportViewType.TABLE}
        data={[
          { label: 'A', value: 0.1, count: 1, id: 'a', percentage: 50 },
          { label: 'B', value: 0.2, count: 2, id: 'b', percentage: 50 },
        ]}
        groupBy={GroupByType.CATEGORY}
        tableColumns={[TableColumn.LABEL, TableColumn.VALUE, TableColumn.PERCENTAGE, TableColumn.COUNT]}
        totalRowValue={0.3}
        partialTotal={{ value: 0.3, missingCurrencies: ['JPY'], excludedCount: 1 }}
      />
    );
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
    await act(async () => { fireEvent.click(screen.getByText(/PDF/i)); });

    const { tableData } = (exportToPdf as any).mock.calls[0][0];
    expect(tableData.rows[0]).toEqual(['A', '$0.10', '50.0%', '1']);
    // 0.1 + 0.2 is 0.30000000000000004 as a float.
    expect(tableData.totalRow[1]).toBe('$0.30 (partial)');
  });

  it('exports csv with the metric-aware Total row, marked when partial', async () => {
    const { exportToCsv } = await import('@/lib/csv-export');
    (exportToCsv as any).mockClear();
    render(
      <ReportChart
        viewType={ReportViewType.TABLE}
        data={[
          { label: 'A', value: 10, count: 1, id: 'a', percentage: 10 },
          { label: 'B', value: 30, count: 3, id: 'b', percentage: 90 },
        ]}
        groupBy={GroupByType.CATEGORY}
        tableColumns={[TableColumn.LABEL, TableColumn.VALUE, TableColumn.PERCENTAGE, TableColumn.COUNT]}
        metric={MetricType.AVERAGE}
        totalRowValue={17.5}
        partialTotal={{ value: 17.5, missingCurrencies: [], excludedCount: 1 }}
      />
    );
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
    await act(async () => { fireEvent.click(screen.getByText(/CSV/i)); });

    const rows = (exportToCsv as any).mock.calls[0][2];
    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual(['Total', '17.5 (partial)', 100, 4]);
  });

  it('prints the count metric as a number and the server headline in the total row', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    render(
      <ReportChart
        viewType={ReportViewType.TABLE}
        data={[{ label: 'A', value: 3, count: 3, id: 'a' }]}
        groupBy={GroupByType.CATEGORY}
        tableColumns={[TableColumn.LABEL, TableColumn.VALUE]}
        metric={MetricType.COUNT}
        totalRowValue={7}
      />
    );
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
    await act(async () => { fireEvent.click(screen.getByText(/PDF/i)); });

    const { tableData } = (exportToPdf as any).mock.calls[0][0];
    expect(tableData.rows[0][1]).toBe('3');
    expect(tableData.totalRow[1]).toBe('7');
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
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
    const pdfBtn = screen.queryByText(/PDF/i);
    if (pdfBtn) {
      await act(async () => { fireEvent.click(pdfBtn); });
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
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
    const pdfBtn = screen.queryByText(/PDF/i);
    if (pdfBtn) {
      await act(async () => { fireEvent.click(pdfBtn); });
    }
  });

  it('renders the count as unknown when no row supplies one', () => {
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

  it.each([
    { rows: [{ label: 'Known zero', value: 0, count: 0 }], cell: '0', total: '0', exported: 0 },
    { rows: [{ label: 'No count', value: 0 }], cell: '-', total: '-', exported: '' },
  ])('preserves the difference between a zero count and an absent count for $cell', async ({ rows, cell, total, exported }) => {
    const { exportToCsv } = await import('@/lib/csv-export');
    const { exportToPdf } = await import('@/lib/pdf-export');
    const { container } = render(<ReportChart viewType={ReportViewType.TABLE} data={rows}
      groupBy={GroupByType.TAG} tableColumns={[TableColumn.LABEL, TableColumn.COUNT]} />);
    expect(screen.getByRole('columnheader', { name: 'Tag' })).toBeInTheDocument();
    expect(container.querySelector('tbody tr td:last-child')).toHaveTextContent(cell);
    expect(container.querySelector('tfoot tr td:last-child')).toHaveTextContent(total);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
    await act(async () => { fireEvent.click(screen.getByText(/CSV/i)); });
    const csv = vi.mocked(exportToCsv).mock.lastCall;
    expect(csv?.[1]).toEqual(['Tag', 'Count']);
    expect(csv?.[2].map(row => row[1])).toEqual([exported, exported]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
    await act(async () => { fireEvent.click(screen.getByText(/PDF/i)); });
    const pdf = vi.mocked(exportToPdf).mock.lastCall?.[0].tableData;
    expect(pdf?.headers).toEqual(['Tag', 'Count']);
    expect(pdf?.rows[0][1]).toBe(String(exported));
    expect(pdf?.totalRow?.[1]).toBe(String(exported));
  });

  it('labels the group, amount and count in the selected language', () => {
    renderInLocale(<ReportChart viewType={ReportViewType.TABLE} groupBy={GroupByType.TAG}
        data={[{ label: 'Travel', value: -50, count: 1 }]}
        tableColumns={[TableColumn.LABEL, TableColumn.VALUE, TableColumn.COUNT]} />,
      { locale: 'fr', messages: { reports: frReports, common: frCommon } });
    for (const name of ['Étiquette', 'Montant', 'Nombre']) {
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
    }
  });

  // Discussion #1978: a both-direction list keeps its signs, so a share of the
  // net total means nothing and the Total row names what it sums.
  describe('signed rows', () => {
    const signedData = [
      { label: 'Salary', value: 1000, count: 1, id: 'tx-1' },
      { label: 'Rent', value: -300, count: 1, id: 'tx-2' },
    ];
    const columns = [TableColumn.LABEL, TableColumn.VALUE, TableColumn.PERCENTAGE, TableColumn.COUNT];

    it('prints signed amounts, no shares and the named total in the table', () => {
      render(
        <ReportChart
          viewType={ReportViewType.TABLE}
          data={signedData}
          groupBy={GroupByType.NONE}
          tableColumns={columns}
          totalRowValue={700}
          totalLabel="Net amount"
          signed
        />
      );
      expect(screen.getByText('$-300.00')).toBeInTheDocument();
      expect(screen.getByText('$700.00')).toBeInTheDocument();
      expect(screen.getByText('Net amount')).toBeInTheDocument();
      expect(screen.queryByText('Total')).not.toBeInTheDocument();
      expect(screen.queryByText('100%')).not.toBeInTheDocument();
      expect(screen.getAllByText('-')).toHaveLength(2);
    });

    it('exports csv with blank shares and the named Total row', async () => {
      const { exportToCsv } = await import('@/lib/csv-export');
      (exportToCsv as any).mockClear();
      render(
        <ReportChart
          viewType={ReportViewType.TABLE}
          data={signedData}
          groupBy={GroupByType.NONE}
          tableColumns={columns}
          totalRowValue={700}
          totalLabel="Net amount"
          signed
        />
      );
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
      await act(async () => { fireEvent.click(screen.getByText(/CSV/i)); });

      const rows = (exportToCsv as any).mock.calls[0][2];
      expect(rows).toEqual([
        ['Salary', 1000, '', 1],
        ['Rent', -300, '', 1],
        ['Net amount', 700, '', 2],
      ]);
    });

    it('exports pdf with blank shares and the named Total row', async () => {
      const { exportToPdf } = await import('@/lib/pdf-export');
      (exportToPdf as any).mockClear();
      render(
        <ReportChart
          viewType={ReportViewType.TABLE}
          data={signedData}
          groupBy={GroupByType.NONE}
          tableColumns={columns}
          totalRowValue={700}
          totalLabel="Net amount"
          signed
        />
      );
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
      await act(async () => { fireEvent.click(screen.getByText(/PDF/i)); });

      const { tableData } = (exportToPdf as any).mock.calls[0][0];
      expect(tableData.rows[1]).toEqual(['Rent', '$-300.00', '', '1']);
      expect(tableData.totalRow).toEqual(['Net amount', '$700.00', '', '2']);
    });

    it('sizes signed pie slices by magnitude and shows the signed amount on hover', () => {
      tooltipItems.current = signedData;
      render(<ReportChart viewType={ReportViewType.PIE_CHART} data={signedData} groupBy={GroupByType.CATEGORY} signed />);

      expect(screen.getByTestId('pie')).toHaveAttribute('data-sizes', '1000,300');
      expect(screen.getByTestId('pie')).toHaveAttribute('data-colours', 'positive,negative');
      expect(screen.getByTestId('tooltip')).toHaveTextContent('$-300.00');
    });

    it.each([
      { metric: MetricType.TOTAL_AMOUNT, travel: -20, headline: -20, count: 2, label: 'Net amount' },
      { metric: MetricType.NONE, travel: -20, headline: -20, count: 2, label: 'Net amount' },
      { metric: MetricType.AVERAGE, travel: -10, headline: -23.33, count: 3, label: 'Average Amount' },
    ])('keeps the signed $metric value and count for overlapping tags in the table, CSV and PDF', async ({ metric, travel, headline, count, label }) => {
      const { exportToCsv } = await import('@/lib/csv-export');
      const { exportToPdf } = await import('@/lib/pdf-export');
      // A -50 expense has both tags. Its +30 refund has only the Travel tag.
      const data = [
        { label: 'Travel', value: travel, count: 2 },
        { label: 'Summer', value: -50, count: 1 },
      ];
      const { container } = render(
        <ReportChart
          viewType={ReportViewType.TABLE}
          data={data}
          groupBy={GroupByType.TAG}
          metric={metric}
          tableColumns={columns}
          totalRowValue={headline}
          totalRowCount={metric === MetricType.AVERAGE ? undefined : count}
          totalLabel={label}
          signed
        />
      );

      expect(Array.from(container.querySelectorAll('tfoot td'), cell => cell.textContent)).toEqual([
        label, `$${headline.toFixed(2)}`, '', String(count),
      ]);

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
      await act(async () => { fireEvent.click(screen.getByText(/CSV/i)); });
      expect(vi.mocked(exportToCsv).mock.lastCall?.[2]).toEqual([
        ['Travel', travel, '', 2],
        ['Summer', -50, '', 1],
        [label, headline, '', count],
      ]);

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
      await act(async () => { fireEvent.click(screen.getByText(/PDF/i)); });
      expect(vi.mocked(exportToPdf).mock.lastCall?.[0].tableData?.totalRow).toEqual([
        label, `$${headline.toFixed(2)}`, '', String(count),
      ]);
    });

    it('leaves the share out of the chart tooltip', () => {
      render(
        <ReportChart viewType={ReportViewType.BAR_CHART} data={signedData} groupBy={GroupByType.NONE} signed />
      );
      expect(screen.getByText('$500.00')).toBeInTheDocument();
      expect(screen.queryByText(/%\)/)).not.toBeInTheDocument();
    });
  });

  describe('account-currency amount column', () => {
    const rows = [
      { label: 'Hotel', value: 135, count: 1, id: 'tx-1', accountAmount: 100, accountCurrency: 'USD' },
      { label: 'Groceries', value: 40, count: 1, id: 'tx-2', accountAmount: 40, accountCurrency: 'CAD' },
      { label: 'No amount', value: 5, count: 1, id: 'tx-3' },
    ];
    const columns = [TableColumn.LABEL, TableColumn.VALUE, TableColumn.ACCOUNT_AMOUNT];

    it('prints each row in its account currency, naming every currency once, the reader\'s too, and totals nothing', () => {
      const { container } = render(
        <ReportChart viewType={ReportViewType.TABLE} data={rows} groupBy={GroupByType.NONE} tableColumns={columns} totalRowValue={180} />
      );

      expect(screen.getByRole('columnheader', { name: 'Amount (account currency)' })).toBeInTheDocument();
      const bodyRows = container.querySelectorAll('tbody tr');
      expect(bodyRows[0].lastElementChild?.textContent).toBe('100.00 USD');
      expect(bodyRows[1].lastElementChild?.textContent).toBe('40.00 CAD');
      expect(bodyRows[2].lastElementChild?.textContent).toBe('-');
      // Amounts in several currencies have no sum: the footer cell is empty.
      expect(container.querySelector('tfoot tr')?.lastElementChild?.textContent).toBe('');
    });

    it('names a currency once whose symbol is its code, at the currency\'s own places (issue #2342)', () => {
      const { container } = render(
        <ReportChart
          viewType={ReportViewType.TABLE}
          data={[
            { label: 'Zurich', value: 150, count: 1, id: 'tx-1', accountAmount: 100, accountCurrency: 'CHF' },
            { label: 'Tokyo', value: 90, count: 1, id: 'tx-2', accountAmount: 10000, accountCurrency: 'JPY' },
          ]}
          groupBy={GroupByType.NONE}
          tableColumns={columns}
        />
      );

      const bodyRows = container.querySelectorAll('tbody tr');
      expect(bodyRows[0].lastElementChild?.textContent).toBe('100.00 CHF');
      expect(bodyRows[1].lastElementChild?.textContent).toBe('10000 JPY');
    });

    it('exports csv with the raw amount and its currency in a column of its own', async () => {
      const { exportToCsv } = await import('@/lib/csv-export');
      (exportToCsv as any).mockClear();
      render(
        <ReportChart viewType={ReportViewType.TABLE} data={rows} groupBy={GroupByType.NONE} tableColumns={columns} totalRowValue={180} />
      );
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
      await act(async () => { fireEvent.click(screen.getByText(/CSV/i)); });

      const [, headers, csvRows] = (exportToCsv as any).mock.calls[0];
      expect(headers).toEqual(['Item', 'Amount', 'Amount (account currency)', 'Account currency']);
      expect(csvRows[0]).toEqual(['Hotel', 135, 100, 'USD']);
      expect(csvRows[2]).toEqual(['No amount', 5, '', '']);
      expect(csvRows[3]).toEqual(['Total', 180, '', '']);
    });

    it('exports pdf with the formatted account-currency amount and no total under it', async () => {
      const { exportToPdf } = await import('@/lib/pdf-export');
      (exportToPdf as any).mockClear();
      render(
        <ReportChart viewType={ReportViewType.TABLE} data={rows} groupBy={GroupByType.NONE} tableColumns={columns} totalRowValue={180} />
      );
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
      await act(async () => { fireEvent.click(screen.getByText(/PDF/i)); });

      const { tableData } = (exportToPdf as any).mock.calls[0][0];
      expect(tableData.headers).toEqual(['Item', 'Amount', 'Amount (account currency)']);
      expect(tableData.rows[0]).toEqual(['Hotel', '$135.00', '100.00 USD']);
      expect(tableData.rows[1]).toEqual(['Groceries', '$40.00', '40.00 CAD']);
      expect(tableData.totalRow).toEqual(['Total', '$180.00', '']);
    });
  });
  describe('a listed row with no rate (issue #2342)', () => {
    const rows = [
      { label: 'Hotel', value: null, count: 1, id: 'tx-1', accountAmount: 100, accountCurrency: 'USD' },
      { label: 'Groceries', value: 50, count: 1, id: 'tx-2', accountAmount: 50, accountCurrency: 'CAD', percentage: 100 },
    ];
    const columns = [TableColumn.LABEL, TableColumn.VALUE, TableColumn.ACCOUNT_AMOUNT, TableColumn.PERCENTAGE];

    it('stays in the table under its own amount, a dash for its converted amount and share', () => {
      const { container } = render(
        <ReportChart viewType={ReportViewType.TABLE} data={rows} groupBy={GroupByType.NONE} tableColumns={columns} totalRowValue={50} />
      );

      const cells = Array.from(container.querySelectorAll('tbody tr')[0].querySelectorAll('td')).map((td) => td.textContent);
      expect(cells).toEqual(['Hotel', '-', '100.00 USD', '-']);
      // The share and the total are of what converted.
      const known = Array.from(container.querySelectorAll('tbody tr')[1].querySelectorAll('td')).map((td) => td.textContent);
      expect(known).toEqual(['Groceries', '$50.00', '50.00 CAD', '100.0%']);
      expect(container.querySelector('tfoot tr')?.children[1].textContent).toBe('$50.00');
    });

    it('exports csv with a blank converted cell, never a zero', async () => {
      const { exportToCsv } = await import('@/lib/csv-export');
      (exportToCsv as any).mockClear();
      render(
        <ReportChart viewType={ReportViewType.TABLE} data={rows} groupBy={GroupByType.NONE} tableColumns={columns} totalRowValue={50} />
      );
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
      await act(async () => { fireEvent.click(screen.getByText(/CSV/i)); });

      const [, , csvRows] = (exportToCsv as any).mock.calls[0];
      expect(csvRows[0]).toEqual(['Hotel', '', 100, 'USD', '']);
      expect(csvRows[2]).toEqual(['Total', 50, '', '', 100]);
    });

    it('exports pdf with a dash for the converted amount', async () => {
      const { exportToPdf } = await import('@/lib/pdf-export');
      (exportToPdf as any).mockClear();
      render(
        <ReportChart viewType={ReportViewType.TABLE} data={rows} groupBy={GroupByType.NONE} tableColumns={columns} totalRowValue={50} />
      );
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
      await act(async () => { fireEvent.click(screen.getByText(/PDF/i)); });

      const { tableData } = (exportToPdf as any).mock.calls[0][0];
      expect(tableData.rows[0]).toEqual(['Hotel', '-', '100.00 USD', '']);
      expect(tableData.totalRow[1]).toBe('$50.00');
    });

    it('is not drawn on a chart, which has no value to plot for it', () => {
      const onClick = vi.fn();
      render(
        <ReportChart viewType={ReportViewType.PIE_CHART} data={rows} groupBy={GroupByType.NONE} onDataPointClick={onClick} />
      );
      // The mocked Pie clicks its first slice: the first row that converted.
      fireEvent.click(screen.getByTestId('pie-click-with-id'));
      expect(onClick).toHaveBeenCalledWith('tx-2');
    });
  });
  describe('tag column', () => {
    const rows = [
      { label: 'Hotel', value: 135, count: 1, id: 'tx-1', tags: 'Vacation' },
      { label: 'Dinner', value: 40, count: 1, id: 'tx-2', tags: 'Vacation, Dining' },
      { label: 'No tags', value: 5, count: 1, id: 'tx-3' },
    ];
    const columns = [TableColumn.LABEL, TableColumn.VALUE, TableColumn.TAG];

    it('prints the row\'s own tags, joined, and nothing for an untagged row', () => {
      const { container } = render(
        <ReportChart viewType={ReportViewType.TABLE} data={rows} groupBy={GroupByType.NONE} tableColumns={columns} totalRowValue={180} />
      );

      expect(screen.getByRole('columnheader', { name: 'Tag' })).toBeInTheDocument();
      const bodyRows = container.querySelectorAll('tbody tr');
      expect(bodyRows[0].lastElementChild?.textContent).toBe('Vacation');
      expect(bodyRows[1].lastElementChild?.textContent).toBe('Vacation, Dining');
      expect(bodyRows[2].lastElementChild?.textContent).toBe('-');
    });

    it('exports csv and pdf with the joined tags', async () => {
      const { exportToCsv } = await import('@/lib/csv-export');
      (exportToCsv as any).mockClear();
      render(
        <ReportChart viewType={ReportViewType.TABLE} data={rows} groupBy={GroupByType.NONE} tableColumns={columns} totalRowValue={180} />
      );
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
      await act(async () => { fireEvent.click(screen.getByText(/CSV/i)); });

      const [, headers, csvRows] = (exportToCsv as any).mock.calls[0];
      expect(headers).toEqual(['Item', 'Amount', 'Tag']);
      expect(csvRows[0]).toEqual(['Hotel', 135, 'Vacation']);
      expect(csvRows[2]).toEqual(['No tags', 5, '']);
    });
  });
  describe('original-currency amount column', () => {
    const rows = [
      { label: 'Hotel', value: 150, count: 1, id: 'tx-1', originalAmount: 100, originalCurrency: 'EUR' },
      { label: 'Gift', value: 40, count: 1, id: 'tx-2', originalAmount: 40, originalCurrency: 'CAD' },
      { label: 'Groceries', value: 20, count: 1, id: 'tx-3' },
    ];
    const columns = [TableColumn.LABEL, TableColumn.VALUE, TableColumn.ORIGINAL_AMOUNT];

    it('prints what a row was entered as, naming every currency once, blank elsewhere, and totals nothing', () => {
      const { container } = render(
        <ReportChart viewType={ReportViewType.TABLE} data={rows} groupBy={GroupByType.NONE} tableColumns={columns} totalRowValue={210} />
      );

      expect(screen.getByRole('columnheader', { name: 'Amount (original currency)' })).toBeInTheDocument();
      const bodyRows = container.querySelectorAll('tbody tr');
      expect(bodyRows[0].lastElementChild?.textContent).toBe('100.00 EUR');
      expect(bodyRows[1].lastElementChild?.textContent).toBe('40.00 CAD');
      expect(bodyRows[2].lastElementChild?.textContent).toBe('-');
      // Amounts in several currencies have no sum: the footer cell is empty.
      expect(container.querySelector('tfoot tr')?.lastElementChild?.textContent).toBe('');
    });

    it('exports csv with the raw original amount and its currency in a column of its own', async () => {
      const { exportToCsv } = await import('@/lib/csv-export');
      (exportToCsv as any).mockClear();
      render(
        <ReportChart viewType={ReportViewType.TABLE} data={rows} groupBy={GroupByType.NONE} tableColumns={columns} totalRowValue={210} />
      );
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
      await act(async () => { fireEvent.click(screen.getByText(/CSV/i)); });

      const [, headers, csvRows] = (exportToCsv as any).mock.calls[0];
      expect(headers).toEqual(['Item', 'Amount', 'Amount (original currency)', 'Original currency']);
      expect(csvRows[0]).toEqual(['Hotel', 150, 100, 'EUR']);
      expect(csvRows[2]).toEqual(['Groceries', 20, '', '']);
      expect(csvRows[3]).toEqual(['Total', 210, '', '']);
    });

    it('exports pdf with the formatted original amount and no total under it', async () => {
      const { exportToPdf } = await import('@/lib/pdf-export');
      (exportToPdf as any).mockClear();
      render(
        <ReportChart viewType={ReportViewType.TABLE} data={rows} groupBy={GroupByType.NONE} tableColumns={columns} totalRowValue={210} />
      );
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
      await act(async () => { fireEvent.click(screen.getByText(/PDF/i)); });

      const { tableData } = (exportToPdf as any).mock.calls[0][0];
      expect(tableData.headers).toEqual(['Item', 'Amount', 'Amount (original currency)']);
      expect(tableData.rows[0]).toEqual(['Hotel', '$150.00', '100.00 EUR']);
      expect(tableData.rows[2]).toEqual(['Groceries', '$20.00', '']);
      expect(tableData.totalRow).toEqual(['Total', '$210.00', '']);
    });
  });
  // Every total and share the chart prints is the server's: the share
  // denominator was the sum of the rounded rows, and under an average metric
  // the sum of the groups' means (issue #2413).
  describe('a share and a total the server settled', () => {
    it('reads each row\'s share off the server under an average metric, never a share of the summed means', () => {
      // One expense of 10 and three of 30: means 10 and 30, shares of the
      // whole 10% and 90%. Over the summed means they read 25% and 75%.
      const data = [
        { label: 'A', value: 10, count: 1, id: 'a', percentage: 10 },
        { label: 'B', value: 30, count: 3, id: 'b', percentage: 90 },
      ];
      tooltipItems.current = data;
      render(
        <ReportChart
          viewType={ReportViewType.BAR_CHART}
          data={data}
          groupBy={GroupByType.CATEGORY}
          metric={MetricType.AVERAGE}
          totalRowValue={25}
        />,
      );
      const tooltip = screen.getByTestId('tooltip');
      expect(tooltip).toHaveTextContent('$10.00 (10.0%)');
      expect(tooltip).toHaveTextContent('$30.00 (90.0%)');
      expect(tooltip).not.toHaveTextContent('25.0%');
    });

    it('gives a row without a server share none under an average metric', () => {
      const data = [{ label: 'A', value: 10, count: 1, id: 'a' }];
      tooltipItems.current = data;
      render(
        <ReportChart
          viewType={ReportViewType.PIE_CHART}
          data={data}
          groupBy={GroupByType.CATEGORY}
          metric={MetricType.AVERAGE}
          totalRowValue={10}
        />,
      );
      expect(screen.getByTestId('tooltip')).not.toHaveTextContent('%');
    });

    // Two listed rows of 1.2474 each read 1.25 on their own, and the server's
    // headline, their sum read once, is 2.49. The server divides each share
    // from the unrounded amounts (50%); one divided here from the two readings
    // would read 50.2% and the rows would add to 100.4% (issue #2413).
    it('prints a listed row\'s share as the server sent it, never one divided from rounded figures', async () => {
      const data = [
        { label: 'Lunch', value: 1.25, count: 1, id: 'tx-1', percentage: 50 },
        { label: 'Coffee', value: 1.25, count: 1, id: 'tx-2', percentage: 50 },
      ];
      tooltipItems.current = data;
      const columns = [TableColumn.LABEL, TableColumn.VALUE, TableColumn.PERCENTAGE];
      const { container, unmount } = render(
        <ReportChart viewType={ReportViewType.TABLE} data={data} groupBy={GroupByType.NONE} tableColumns={columns} totalRowValue={2.49} />,
      );
      const cells = Array.from(container.querySelectorAll('tbody tr')[0].querySelectorAll('td')).map((td) => td.textContent);
      expect(cells).toEqual(['Lunch', '$1.25', '50.0%']);
      expect(container.querySelector('tfoot tr')?.children[1].textContent).toBe('$2.49');

      const { exportToCsv } = await import('@/lib/csv-export');
      (exportToCsv as any).mockClear();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
      await act(async () => { fireEvent.click(screen.getByText(/CSV/i)); });
      const csvRows = (exportToCsv as any).mock.calls[0][2];
      expect(csvRows[0]).toEqual(['Lunch', 1.25, 50]);
      expect(csvRows[2]).toEqual(['Total', 2.49, 100]);
      unmount();

      render(
        <ReportChart viewType={ReportViewType.PIE_CHART} data={data} groupBy={GroupByType.NONE} totalRowValue={2.49} />,
      );
      expect(screen.getByTestId('tooltip')).toHaveTextContent('$1.25 (50.0%)');
    });

    // A row without a server share is no share of anything here, and the Total
    // row claims no 100% over rows that show none.
    it('gives a row without a server share none, and the Total row no 100%', async () => {
      const data = [
        { label: 'Lunch', value: 1.25, count: 1, id: 'tx-1' },
        { label: 'Coffee', value: 1.25, count: 1, id: 'tx-2' },
      ];
      const columns = [TableColumn.LABEL, TableColumn.VALUE, TableColumn.PERCENTAGE];
      const { container } = render(
        <ReportChart viewType={ReportViewType.TABLE} data={data} groupBy={GroupByType.NONE} tableColumns={columns} totalRowValue={2.49} />,
      );
      const cells = Array.from(container.querySelectorAll('tbody tr')[0].querySelectorAll('td')).map((td) => td.textContent);
      expect(cells).toEqual(['Lunch', '$1.25', '-']);
      expect(container.querySelector('tfoot tr')?.children[2].textContent).toBe('');

      const { exportToCsv } = await import('@/lib/csv-export');
      (exportToCsv as any).mockClear();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
      await act(async () => { fireEvent.click(screen.getByText(/CSV/i)); });
      const csvRows = (exportToCsv as any).mock.calls[0][2];
      expect(csvRows[2]).toEqual(['Total', 2.49, '']);
    });

    it('leaves the Total row blank without a headline, never the rows added up', async () => {
      const data = [
        { label: 'Lunch', value: 1.25, count: 1, id: 'tx-1' },
        { label: 'Coffee', value: 1.25, count: 1, id: 'tx-2' },
      ];
      const columns = [TableColumn.LABEL, TableColumn.VALUE];
      const { container } = render(
        <ReportChart viewType={ReportViewType.TABLE} data={data} groupBy={GroupByType.NONE} tableColumns={columns} />,
      );
      expect(container.querySelector('tfoot tr')?.children[1].textContent).toBe('');

      const { exportToCsv } = await import('@/lib/csv-export');
      (exportToCsv as any).mockClear();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /export/i })); });
      await act(async () => { fireEvent.click(screen.getByText(/CSV/i)); });
      const csvRows = (exportToCsv as any).mock.calls[0][2];
      expect(csvRows[2]).toEqual(['Total', '']);
    });
  });
});
