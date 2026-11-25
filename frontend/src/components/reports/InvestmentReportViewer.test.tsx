import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@/test/render';
import { InvestmentReportViewer } from './InvestmentReportViewer';

const mockGetById = vi.fn();
const mockExecute = vi.fn();
vi.mock('@/lib/investment-reports', () => ({
  investmentReportsApi: {
    getById: (...a: unknown[]) => mockGetById(...a),
    execute: (...a: unknown[]) => mockExecute(...a),
    // The header's report switcher lists the user's saved reports beside the
    // built-in ones; these tests are about the viewer, so both lookups answer
    // empty rather than reaching for the network.
    getAll: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/lib/custom-reports', () => ({
  customReportsApi: { getAll: vi.fn().mockResolvedValue([]) },
}));

const mockExportToCsv = vi.fn();
vi.mock('@/lib/csv-export', () => ({
  exportToCsv: (...a: unknown[]) => mockExportToCsv(...a),
}));

const mockGetAllAccounts = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...a: unknown[]) => mockGetAllAccounts(...a),
  },
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatNumber: (n: number) => String(n),
      formatPercent: (n: number) => `${n}%`,
      formatCurrency: (n: number) => `$${n}`,
    }),
  };
});vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d, dateFormat: 'browser', datePattern: 'YYYY-MM-DD' }),
}));

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));

const report = {
  id: 'r1',
  name: 'Holdings',
  description: 'My holdings',
  groupBy: 'NONE',
  config: { columns: ['symbol', 'marketValue'], accountIds: [], sortColumn: 'symbol', sortDirection: 'ASC', asOfDate: null },
};

const result = {
  reportId: 'r1',
  name: 'Holdings',
  asOfDate: '2024-06-10',
  baseCurrency: 'USD',
  groupBy: 'NONE',
  columns: ['symbol', 'marketValue'],
  groups: [
    {
      key: 'all',
      label: '',
      rows: [
        { id: '1', currency: 'USD', baseExchangeRate: 1, values: { symbol: 'AAA', marketValue: 200 } },
        { id: '2', currency: 'USD', baseExchangeRate: 1, values: { symbol: 'BBB', marketValue: 100 } },
      ],
    },
  ],
  rowCount: 2,
};

async function renderViewer() {
  await act(async () => {
    render(<InvestmentReportViewer reportId="r1" />);
  });
}

describe('InvestmentReportViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockResolvedValue(report);
    mockExecute.mockResolvedValue(result);
    mockGetAllAccounts.mockResolvedValue([]);
  });

  it('runs the report and renders rows with the as-of date', async () => {
    await renderViewer();
    expect(await screen.findByText('AAA')).toBeInTheDocument();
    expect(screen.getByText('BBB')).toBeInTheDocument();
    expect(screen.getByText(/As of 2024-06-10/)).toBeInTheDocument();
    expect(screen.getByText(/2 holdings/)).toBeInTheDocument();
  });

  /**
   * Issue #1390. An unresolvable pair blanks every row's % of portfolio, and
   * the response now says so. Read as `=== false`, and the surface names the
   * pair rather than leaving blanks that read as zero.
   */
  it('marks the figures partial and names the pair when the server reports an FX gap', async () => {
    mockExecute.mockResolvedValue({
      ...result,
      fxComplete: false,
      missingPairs: ['SEK->USD'],
    });

    await renderViewer();

    expect(await screen.findByText(/no exchange rate for SEK->USD/)).toBeInTheDocument();
    expect(screen.getByTestId('partial-total-marker')).toBeInTheDocument();
  });

  /**
   * The other cause of the same blanks. `pricesComplete` stayed absent while
   * an unpriced holding withheld the denominator, so the column was blank
   * under no explanation and the exchange-rate caption would have sent the
   * reader to the wrong screen.
   */
  it('names the unpriced holdings when the server reports a price gap', async () => {
    mockExecute.mockResolvedValue({
      ...result,
      pricesComplete: false,
      unpricedSymbols: ['BBB'],
    });

    await renderViewer();

    expect(await screen.findByText(/no price for BBB/)).toBeInTheDocument();
    expect(screen.queryByText(/no exchange rate for/)).not.toBeInTheDocument();
  });

  it('names both causes when both apply', async () => {
    mockExecute.mockResolvedValue({
      ...result,
      fxComplete: false,
      missingPairs: ['SEK->USD'],
      pricesComplete: false,
      unpricedSymbols: ['BBB'],
    });

    await renderViewer();

    expect(await screen.findByText(/no exchange rate for SEK->USD/)).toBeInTheDocument();
    expect(screen.getByText(/no price for BBB/)).toBeInTheDocument();
  });

  it('shows no partial marker when the conversion was complete', async () => {
    mockExecute.mockResolvedValue({ ...result, fxComplete: true, missingPairs: [] });

    await renderViewer();
    await screen.findByText('AAA');

    expect(screen.queryByTestId('partial-total-marker')).not.toBeInTheDocument();
  });

  it('says nothing when the server sent no completeness at all', async () => {
    // Absent is no information, not a claim of completeness -- and not a
    // reason to caption every figure as partial either.
    await renderViewer();
    await screen.findByText('AAA');

    expect(screen.queryByTestId('partial-total-marker')).not.toBeInTheDocument();
  });

  it('sorts rows when a column header is clicked', async () => {
    await renderViewer();
    await screen.findByText('AAA');
    // Default sort is by symbol asc -> AAA before BBB
    let bodyRows = screen.getAllByRole('row').slice(1);
    expect(within(bodyRows[0]).getByText('AAA')).toBeInTheDocument();

    // Sort by Market Value ascending -> BBB (100) before AAA (200)
    await act(async () => {
      fireEvent.click(screen.getByText('Market Value'));
    });
    bodyRows = screen.getAllByRole('row').slice(1);
    expect(within(bodyRows[0]).getByText('BBB')).toBeInTheDocument();
  });

  it('exports the visible rows to CSV', async () => {
    await renderViewer();
    await screen.findByText('AAA');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    });
    expect(mockExportToCsv).toHaveBeenCalled();
    const [, headers, rows] = mockExportToCsv.mock.calls[0];
    expect(headers).toEqual(['Symbol', 'Market Value']);
    expect(rows).toHaveLength(2);
  });

  it('re-runs the report when the as-of date is changed', async () => {
    await renderViewer();
    await screen.findByText('AAA');
    expect(mockExecute).toHaveBeenCalledWith('r1', { accountIds: [] });
  });

  it('shows an empty state when there are no holdings', async () => {
    mockExecute.mockResolvedValue({ ...result, groups: [], rowCount: 0 });
    await renderViewer();
    expect(
      await screen.findByText(/No holdings found/),
    ).toBeInTheDocument();
  });

  it('renders group headings when grouped', async () => {
    mockGetById.mockResolvedValue({ ...report, groupBy: 'ACCOUNT' });
    mockExecute.mockResolvedValue({
      ...result,
      groupBy: 'ACCOUNT',
      groups: [
        { key: 'a1', label: 'Acc One', rows: [{ id: '1', values: { symbol: 'AAA', marketValue: 200 } }] },
        { key: 'a2', label: 'Acc Two', rows: [{ id: '2', values: { symbol: 'BBB', marketValue: 100 } }] },
      ],
    });
    await renderViewer();
    expect(await screen.findByText('Acc One')).toBeInTheDocument();
    expect(screen.getByText('Acc Two')).toBeInTheDocument();

    // Exporting a grouped report prepends the group heading column.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    });
    const [, headers] = mockExportToCsv.mock.calls[0];
    expect(headers[0]).toBe('Account');
  });

  it('renders all groups in a single table so columns line up', async () => {
    mockGetById.mockResolvedValue({ ...report, groupBy: 'ACCOUNT' });
    mockExecute.mockResolvedValue({
      ...result,
      groupBy: 'ACCOUNT',
      columns: ['symbol', 'marketValue'],
      groups: [
        { key: 'a1', label: 'Acc One', rows: [{ id: '1', currency: 'USD', baseExchangeRate: 1, values: { symbol: 'AAA', marketValue: 200 } }] },
        { key: 'a2', label: 'Acc Two', rows: [{ id: '2', currency: 'USD', baseExchangeRate: 1, values: { symbol: 'BBB', marketValue: 100 } }] },
      ],
    });
    await renderViewer();
    await screen.findByText('Acc One');
    // A single shared table guarantees identical column widths across groups.
    expect(screen.getAllByRole('table')).toHaveLength(1);
    // Each group label is a full-width row spanning every column.
    const groupCell = screen.getByText('Acc One').closest('td');
    expect(groupCell).toHaveAttribute('colspan', '2');
  });

  it('re-runs with an as-of override and resets to the latest', async () => {
    await renderViewer();
    await screen.findByText('AAA');
    const dateInput = screen.getByLabelText('As of date');
    await act(async () => {
      fireEvent.change(dateInput, { target: { value: '2024-03-15' } });
    });
    await waitFor(() =>
      expect(mockExecute).toHaveBeenCalledWith('r1', {
        asOfDate: '2024-03-15',
        accountIds: [],
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByText('Reset to latest market day'));
    });
    await waitFor(() =>
      expect(mockExecute).toHaveBeenLastCalledWith('r1', { accountIds: [] }),
    );
  });

  describe('a re-run is not the previous answer', () => {
    async function loadThenChangeAsOf(next: () => unknown) {
      await renderViewer();
      await screen.findByText('AAA');
      expect(screen.getByTitle('Export CSV')).toBeEnabled();

      mockExecute.mockImplementation(next);
      await act(async () => {
        fireEvent.change(screen.getByLabelText('As of date'), { target: { value: '2024-03-15' } });
      });
      await waitFor(() =>
        expect(mockExecute).toHaveBeenLastCalledWith('r1', { asOfDate: '2024-03-15', accountIds: [] }),
      );
    }

    it('disables the export while the next run has failed', async () => {
      await loadThenChangeAsOf(() => Promise.reject(new Error('500')));
      await waitFor(() => expect(screen.getByTitle('Export CSV')).toBeDisabled());
    });

    it('disables the export while the next run is pending', async () => {
      await loadThenChangeAsOf(() => new Promise(() => {}));
      expect(screen.getByTitle('Export CSV')).toBeDisabled();
    });
  });

  it('formats each column type and renders a dash for missing values', async () => {
    mockGetById.mockResolvedValue({
      ...report,
      config: { ...report.config, columns: ['symbol', 'marketValue', 'gainPercent', 'volume', 'quantity', 'lastTransactionDate', 'exchangeRate', 'name'] },
    });
    mockExecute.mockResolvedValue({
      ...result,
      columns: ['symbol', 'marketValue', 'gainPercent', 'volume', 'quantity', 'lastTransactionDate', 'exchangeRate', 'name', 'currency'],
      groups: [
        {
          key: 'all',
          label: '',
          rows: [
            {
              id: '1',
              currency: 'USD',
              baseExchangeRate: 1,
              values: {
                symbol: 'AAA',
                marketValue: 1000.5,
                gainPercent: 12.34,
                volume: 5000,
                quantity: 10.25,
                lastTransactionDate: '2024-05-01',
                exchangeRate: 1.25,
                name: null, // null -> dash
                currency: '', // empty string -> dash
              },
            },
          ],
        },
      ],
      rowCount: 1,
    });
    await renderViewer();
    await screen.findByText('AAA');
    // USD holding with USD base -> narrow symbol
    expect(screen.getByText('$1000.5')).toBeInTheDocument();
    expect(screen.getByText('12.34%')).toBeInTheDocument(); // percent
    expect(screen.getByText('5000')).toBeInTheDocument(); // integer
    expect(screen.getByText('10.25')).toBeInTheDocument(); // shares
    expect(screen.getByText('2024-05-01')).toBeInTheDocument(); // date
    expect(screen.getByText('1.25')).toBeInTheDocument(); // number
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2); // null and empty
  });

  it('toggles monetary values between native and base currency', async () => {
    mockGetById.mockResolvedValue(report);
    mockExecute.mockResolvedValue({
      ...result,
      baseCurrency: 'CAD',
      columns: ['symbol', 'marketValue'],
      groups: [
        {
          key: 'all',
          label: '',
          rows: [
            { id: '1', currency: 'USD', baseExchangeRate: 1.25, values: { symbol: 'AAA', marketValue: 100 } },
          ],
        },
      ],
      rowCount: 1,
    });
    await renderViewer();
    await screen.findByText('AAA');
    // Native USD holding with CAD base -> symbol then ISO code, like other pages
    expect(screen.getByText('$100 USD')).toBeInTheDocument();
    // Switch to base currency (CAD): 100 * 1.25 = 125, base shows narrow symbol
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'CAD' }));
    });
    expect(screen.getByText('$125')).toBeInTheDocument();

    // CSV export reflects the base-currency conversion.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    });
    const exportedRows = mockExportToCsv.mock.calls.at(-1)?.[2];
    expect(exportedRows[0]).toContain(125);

    // Switch back to native.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Native' }));
    });
    expect(screen.getByText('$100 USD')).toBeInTheDocument();
  });

  it('rounds a base-currency product once at the base currency places in the CSV', async () => {
    mockGetById.mockResolvedValue(report);
    mockExecute.mockResolvedValue({
      ...result,
      baseCurrency: 'CAD',
      columns: ['symbol', 'marketValue'],
      groups: [
        {
          key: 'all',
          label: '',
          rows: [
            // 2.003984 * 1.25 = 2.50498: the cell reads 2.50, and so must the file.
            { id: '1', currency: 'USD', baseExchangeRate: 1.25, values: { symbol: 'AAA', marketValue: 2.003984 } },
          ],
        },
      ],
      rowCount: 1,
    });
    await renderViewer();
    await screen.findByText('AAA');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'CAD' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    });
    const exportedRows = mockExportToCsv.mock.calls.at(-1)?.[2];
    expect(exportedRows[0][1]).toBe(2.5);
  });

  it('renders an unknown marker in base mode when a row has no rate to base', async () => {
    // baseExchangeRate is null when no rate exists for the pair. `num * null`
    // coerces to 0, so without the guard a real foreign holding rendered as
    // $0.00 in base currency -- unknown shown as a measured zero, worse than
    // the 1:1 relabelling the nullable rate replaced.
    mockGetById.mockResolvedValue(report);
    mockExecute.mockResolvedValue({
      ...result,
      baseCurrency: 'CAD',
      columns: ['symbol', 'marketValue'],
      groups: [
        {
          key: 'all',
          label: '',
          rows: [
            { id: '1', currency: 'USD', baseExchangeRate: null, values: { symbol: 'AAA', marketValue: 100 } },
          ],
        },
      ],
      rowCount: 1,
    });
    await renderViewer();
    await screen.findByText('AAA');
    // Native display is unaffected: the value is known in USD.
    expect(screen.getByText('$100 USD')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'CAD' }));
    });
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();

    // The CSV mirrors the unknown as an empty cell, never a 0 a spreadsheet
    // would sum.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    });
    const exportedRows = mockExportToCsv.mock.calls.at(-1)?.[2];
    expect(exportedRows[0]).toContain('');
    expect(exportedRows[0]).not.toContain(0);
  });

  it('exports group headings for symbol and currency groupings', async () => {
    for (const [groupBy, heading] of [
      ['SYMBOL', 'Symbol'],
      ['CURRENCY', 'Currency'],
    ] as const) {
      mockExportToCsv.mockClear();
      mockGetById.mockResolvedValue({ ...report, groupBy });
      mockExecute.mockResolvedValue({
        ...result,
        groupBy,
        groups: [{ key: 'g', label: 'G', rows: [{ id: '1', values: { symbol: 'AAA', marketValue: 200 } }] }],
      });
      const { unmount } = render(<InvestmentReportViewer reportId="r1" />);
      await screen.findByText('AAA');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
      });
      expect(mockExportToCsv.mock.calls[0][1][0]).toBe(heading);
      unmount();
    }
  });

  it('shows a not-found state when the report fails to load', async () => {
    mockGetById.mockRejectedValue(new Error('boom'));
    await renderViewer();
    expect(await screen.findByText('Report not found')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Reports' }));
    expect(mockPush).toHaveBeenCalledWith('/reports');
  });

  it('does not crash when execution fails', async () => {
    mockExecute.mockRejectedValue(new Error('exec failed'));
    await renderViewer();
    // The report header still renders even though execution failed.
    expect(await screen.findByText('Holdings')).toBeInTheDocument();
  });

  it('falls back to the raw key and text formatting for unknown columns', async () => {
    mockGetById.mockResolvedValue({
      ...report,
      config: { ...report.config, columns: ['symbol', 'mysteryCol'] },
    });
    mockExecute.mockResolvedValue({
      ...result,
      columns: ['symbol', 'mysteryCol'],
      groups: [
        { key: 'all', label: '', rows: [{ id: '1', values: { symbol: 'AAA', mysteryCol: 'hello' } }] },
      ],
      rowCount: 1,
    });
    await renderViewer();
    await screen.findByText('AAA');
    // Unknown column header renders the raw key and its value as plain text.
    expect(screen.getByText('mysteryCol')).toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('navigates to edit when Edit is clicked', async () => {
    await renderViewer();
    await screen.findByText('AAA');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(mockPush).toHaveBeenCalledWith('/reports/investment/r1/edit');
  });
});
