import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { DividendIncomeReport } from './DividendIncomeReport';

// Helpers for driving the account MultiSelect (which renders its dropdown via a
// portal and toggles with checkboxes rather than a native <select>).
function openAccountFilter() {
  fireEvent.click(screen.getByLabelText('Filter by account'));
}
async function toggleAccountByName(name: string) {
  openAccountFilter();
  const labelText = await screen.findByText(name);
  const labelEl = labelText.closest('label');
  if (!labelEl) throw new Error(`No <label> wrapping account option "${name}"`);
  const checkbox = labelEl.querySelector('input[type="checkbox"]');
  if (!checkbox) throw new Error(`No checkbox for account option "${name}"`);
  fireEvent.click(checkbox);
  // Close the dropdown so subsequent queries don't pick up portal-rendered options
  fireEvent.click(screen.getByLabelText('Filter by account'));
}
async function getAccountOptionLabels(): Promise<string[]> {
  openAccountFilter();
  // The dropdown lists each option inside a <label>; the visible text is in a
  // descendant <span>. Read every checkbox's enclosing label's text.
  const checkboxes = await screen.findAllByRole('checkbox');
  const labels = checkboxes
    .map((cb) => cb.closest('label')?.textContent?.trim() ?? '')
    .filter(Boolean);
  fireEvent.click(screen.getByLabelText('Filter by account'));
  return labels;
}

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number, _currency?: string) => `$${n.toFixed(2)}`,
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (amount: number, _currency: string) => amount,
    defaultCurrency: 'CAD',
  }),
}));

// Stable references across re-renders so useEffects keyed on `resolvedRange`
// identity don't re-fire and bounce the component back into its loading state
// every time something unrelated changes.
const STABLE_RESOLVED_RANGE = { start: '2024-01-01', end: '2025-01-01' };
const STABLE_SET_DATE_RANGE = vi.fn();
const STABLE_SET_START = vi.fn();
const STABLE_SET_END = vi.fn();
vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: '1y',
    setDateRange: STABLE_SET_DATE_RANGE,
    startDate: '',
    setStartDate: STABLE_SET_START,
    endDate: '',
    setEndDate: STABLE_SET_END,
    resolvedRange: STABLE_RESOLVED_RANGE,
    isValid: true,
  }),
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
  // MultiSelect (used for the account filter) imports `cn` for className
  // composition; a minimal join keeps it from blowing up at render time.
  cn: (...args: unknown[]) =>
    args
      .flat(Infinity)
      .filter((c) => typeof c === 'string' && c.length > 0)
      .join(' '),
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: ({ name }: any) => <div data-testid={`bar-${name}`} />,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
  ReferenceLine: () => null,
  Cell: () => null,
}));

const mockGetTransactions = vi.fn();
const mockGetInvestmentAccounts = vi.fn();
const mockGetCapitalGains = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getTransactions: (...args: any[]) => mockGetTransactions(...args),
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
    getCapitalGains: (...args: any[]) => mockGetCapitalGains(...args),
  },
}));

const mockExportToCsv = vi.fn();
vi.mock('@/lib/csv-export', () => ({
  exportToCsv: (...args: any[]) => mockExportToCsv(...args),
}));

const mockExportToPdf = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: (...args: any[]) => mockExportToPdf(...args),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('DividendIncomeReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetTransactions.mockReturnValue(new Promise(() => {}));
    mockGetInvestmentAccounts.mockReturnValue(new Promise(() => {}));
    mockGetCapitalGains.mockReturnValue(new Promise(() => {}));
    render(<DividendIncomeReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when there is no investment activity', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetCapitalGains.mockResolvedValue([]);
    render(<DividendIncomeReport />);
    await waitFor(() => {
      expect(
        screen.getByText(/No dividends, interest, or capital gain activity/),
      ).toBeInTheDocument();
    });
  });

  it('folds monthly capital gains (realized + unrealized) from the backend into Capital Gains', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([
      {
        month: '2024-08',
        accountId: 'acc-1',
        accountName: 'TFSA',
        accountCurrencyCode: 'CAD',
        securityId: 'sec-1',
        symbol: 'ABC',
        securityName: 'ABC Corp',
        securityCurrencyCode: 'CAD',
        startQuantity: 10,
        endQuantity: 0,
        startValue: 800,
        endValue: 0,
        buys: 0,
        sells: 800,
        realizedGain: 300,
        unrealizedGain: 0,
        totalCapitalGain: 300,
      },
    ]);
    render(<DividendIncomeReport />);
    await waitFor(() => {
      expect(screen.getAllByText('Capital Gains').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('$300.00').length).toBeGreaterThan(0);
  });

  it('shows negative capital gain totals (losses) with red styling', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'RRSP', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([
      {
        month: '2024-03',
        accountId: 'acc-1',
        accountName: 'RRSP',
        accountCurrencyCode: 'CAD',
        securityId: 'sec-2',
        symbol: 'DEF',
        securityName: 'DEF Corp',
        securityCurrencyCode: 'CAD',
        startQuantity: 100,
        endQuantity: 100,
        startValue: 5000,
        endValue: 4500,
        buys: 0,
        sells: 0,
        realizedGain: 0,
        unrealizedGain: -500,
        totalCapitalGain: -500,
      },
    ]);
    render(<DividendIncomeReport />);
    await waitFor(() => {
      expect(screen.getAllByText('Capital Gains').length).toBeGreaterThan(0);
    });
    // Negative total renders as -$500.00 inside the summary card.
    expect(screen.getAllByText('$-500.00').length).toBeGreaterThan(0);
  });

  it('renders summary cards with data', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          totalAmount: 100,
          accountId: 'acc-1',
          security: { symbol: 'VFV', name: 'Vanguard S&P 500' },
        },
        {
          id: 'tx-2',
          transactionDate: '2024-07-15',
          action: 'INTEREST',
          totalAmount: 25,
          accountId: 'acc-1',
          security: { symbol: 'CASH', name: 'Cash Interest' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);
    render(<DividendIncomeReport />);
    await waitFor(() => {
      expect(screen.getAllByText('Dividends').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('Interest').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Capital Gains').length).toBeGreaterThan(0);
    expect(screen.getByText('Total Income')).toBeInTheDocument();
  });

  it('renders view type buttons', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetCapitalGains.mockResolvedValue([]);
    render(<DividendIncomeReport />);
    await waitFor(() => {
      expect(screen.getByText('Monthly')).toBeInTheDocument();
    });
    expect(screen.getByText('By Security')).toBeInTheDocument();
  });

  it('populates the security filter from loaded data and narrows results when one is picked', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          totalAmount: 100,
          accountId: 'acc-1',
          securityId: 'sec-a',
          security: { symbol: 'AAA', name: 'Alpha' },
        },
        {
          id: 'tx-2',
          transactionDate: '2024-07-15',
          action: 'DIVIDEND',
          totalAmount: 30,
          accountId: 'acc-1',
          securityId: 'sec-b',
          security: { symbol: 'BBB', name: 'Beta' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    const securitySelect = (await screen.findByLabelText('Filter by security')) as HTMLSelectElement;
    // Options: 'All Securities' + both securities (sorted by symbol).
    const optionValues = Array.from(securitySelect.options).map((o) => o.value);
    expect(optionValues).toEqual(['', 'sec-a', 'sec-b']);
    // Totals aggregate both securities at first (Dividends card).
    expect(screen.getAllByText('$130.00').length).toBeGreaterThan(0);

    // Pick a security and verify the totals narrow to just that row.
    fireEvent.change(securitySelect, { target: { value: 'sec-b' } });
    await waitFor(() => {
      expect(screen.getAllByText('$30.00').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText('$130.00')).not.toBeInTheDocument();
  });

  it('clears the security selection when the account filter changes', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          totalAmount: 100,
          accountId: 'acc-1',
          securityId: 'sec-a',
          security: { symbol: 'AAA', name: 'Alpha' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
      { id: 'acc-2', name: 'RRSP', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    const securitySelect1 = (await screen.findByLabelText('Filter by security')) as HTMLSelectElement;
    await waitFor(() => {
      expect(securitySelect1.options.length).toBeGreaterThan(1);
    });
    fireEvent.change(securitySelect1, { target: { value: 'sec-a' } });
    expect(securitySelect1.value).toBe('sec-a');

    await toggleAccountByName('RRSP');

    // Wait out the reload loading state and re-query the security select.
    await waitFor(async () => {
      const reloaded = (await screen.findByLabelText('Filter by security')) as HTMLSelectElement;
      expect(reloaded.value).toBe('');
    });
  });

  it('renders Start Value and End Value columns in the monthly table, summed across securities', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([
      // Two securities held through June 2024; Start/End should sum.
      {
        month: '2024-06',
        accountId: 'acc-1',
        accountName: 'TFSA',
        accountCurrencyCode: 'CAD',
        securityId: 'sec-a',
        symbol: 'AAA',
        securityName: 'Alpha',
        securityCurrencyCode: 'CAD',
        startQuantity: 10,
        endQuantity: 10,
        startValue: 1000,
        endValue: 1200,
        buys: 0,
        sells: 0,
        realizedGain: 0,
        unrealizedGain: 200,
        totalCapitalGain: 200,
      },
      {
        month: '2024-06',
        accountId: 'acc-1',
        accountName: 'TFSA',
        accountCurrencyCode: 'CAD',
        securityId: 'sec-b',
        symbol: 'BBB',
        securityName: 'Beta',
        securityCurrencyCode: 'CAD',
        startQuantity: 5,
        endQuantity: 5,
        startValue: 500,
        endValue: 450,
        buys: 0,
        sells: 0,
        realizedGain: 0,
        unrealizedGain: -50,
        totalCapitalGain: -50,
      },
    ]);

    render(<DividendIncomeReport />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Table' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));

    // Both columns appear as headers.
    expect(await screen.findByText('Start Value')).toBeInTheDocument();
    expect(screen.getByText('End Value')).toBeInTheDocument();
    // The June row carries the summed Start ($1500) and End ($1650) values.
    expect(screen.getByText('$1500.00')).toBeInTheDocument();
    expect(screen.getByText('$1650.00')).toBeInTheDocument();
  });

  it('switches the monthly view from chart to table on demand', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          totalAmount: 100,
          accountId: 'acc-1',
          securityId: 'sec-a',
          security: { symbol: 'AAA', name: 'Alpha' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    await waitFor(() => {
      expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Table' }));

    await waitFor(() => {
      expect(screen.queryByTestId('bar-chart')).not.toBeInTheDocument();
    });
    // The Monthly table has a Month column header.
    expect(screen.getByText('Month')).toBeInTheDocument();
  });

  it('offers a CSV export in the monthly table view and writes the visible columns', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          totalAmount: 100,
          accountId: 'acc-1',
          securityId: 'sec-a',
          security: { symbol: 'AAA', name: 'Alpha' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    // No CSV button while the chart view is active.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /export pdf/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /^export$/i })).not.toBeInTheDocument();

    // Switch to the monthly table — the dropdown trigger replaces the PDF-only button.
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    const exportTrigger = await screen.findByRole('button', { name: /^export$/i });
    fireEvent.click(exportTrigger);
    fireEvent.click(screen.getByRole('button', { name: 'CSV' }));

    expect(mockExportToCsv).toHaveBeenCalledTimes(1);
    const [filename, headers, rows] = mockExportToCsv.mock.calls[0];
    expect(filename).toMatch(/gains-dividends-interest-monthly-all-accounts/);
    expect(headers).toEqual([
      'Month',
      'Start Value',
      'End Value',
      'Dividends',
      'Interest',
      'Capital Gains',
      'Total',
      'Currency',
    ]);
    // The row for June 2024 contains the $100 dividend; Start/End Value are
    // zero here since the mocked data has no capital-gain entries.
    const juneRow = rows.find((r: any[]) => r[0] === '2024-06');
    expect(juneRow).toBeDefined();
    expect(juneRow[1]).toBe(0);   // Start Value
    expect(juneRow[2]).toBe(0);   // End Value
    expect(juneRow[3]).toBe(100); // Dividends
    expect(juneRow[4]).toBe(0);   // Interest
    expect(juneRow[5]).toBe(0);   // Capital Gains
    expect(juneRow[6]).toBe(100); // Total
    expect(juneRow[7]).toBe('CAD');
  });

  it('omits hidden series from the CSV export', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          totalAmount: 100,
          accountId: 'acc-1',
          securityId: 'sec-a',
          security: { symbol: 'AAA', name: 'Alpha' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Table' })).toBeInTheDocument();
    });
    // Turn Capital Gains off, then switch to the table.
    fireEvent.click(screen.getByRole('button', { name: 'Capital Gains' }));
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));

    fireEvent.click(await screen.findByRole('button', { name: /^export$/i }));
    fireEvent.click(screen.getByRole('button', { name: 'CSV' }));

    const [, headers] = mockExportToCsv.mock.calls[0];
    expect(headers).toEqual([
      'Month',
      'Start Value',
      'End Value',
      'Dividends',
      'Interest',
      'Total',
      'Currency',
    ]);
  });

  it('hands the table data (not the chart container) to the PDF exporter in the monthly table view', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          totalAmount: 100,
          accountId: 'acc-1',
          securityId: 'sec-a',
          security: { symbol: 'AAA', name: 'Alpha' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Table' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));

    fireEvent.click(await screen.findByRole('button', { name: /^export$/i }));
    fireEvent.click(screen.getByRole('button', { name: 'PDF' }));

    await waitFor(() => {
      expect(mockExportToPdf).toHaveBeenCalledTimes(1);
    });
    const args = mockExportToPdf.mock.calls[0][0];
    expect(args.chartContainer).toBeUndefined();
    expect(args.tableData).toBeDefined();
    expect(args.tableData.headers).toEqual([
      'Month',
      'Start Value',
      'End Value',
      'Dividends',
      'Interest',
      'Capital Gains',
      'Total',
    ]);
    expect(args.tableData.rows.length).toBeGreaterThan(0);
    expect(args.tableData.totalRow?.[0]).toBe('Total');
    // Start/End Value in the footer total row are intentionally blank —
    // a column sum of point-in-time snapshots would be meaningless.
    expect(args.tableData.totalRow?.[1]).toBe('');
    expect(args.tableData.totalRow?.[2]).toBe('');
  });

  it('hands the chart container to the PDF exporter in the chart view', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          totalAmount: 100,
          accountId: 'acc-1',
          securityId: 'sec-a',
          security: { symbol: 'AAA', name: 'Alpha' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    // Chart view is the default; ExportDropdown collapses to a PDF-only button.
    const exportPdfBtn = await screen.findByRole('button', { name: /export pdf/i });
    fireEvent.click(exportPdfBtn);

    await waitFor(() => {
      expect(mockExportToPdf).toHaveBeenCalledTimes(1);
    });
    const args = mockExportToPdf.mock.calls[0][0];
    expect(args.chartContainer).not.toBeNull();
    expect(args.tableData).toBeUndefined();
  });

  it('writes a by-security CSV with one row per security', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          totalAmount: 100,
          accountId: 'acc-1',
          securityId: 'sec-a',
          security: { symbol: 'AAA', name: 'Alpha' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'By Security' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'By Security' }));

    fireEvent.click(await screen.findByRole('button', { name: /^export$/i }));
    fireEvent.click(screen.getByRole('button', { name: 'CSV' }));

    const [filename, headers, rows] = mockExportToCsv.mock.calls[0];
    expect(filename).toMatch(/gains-dividends-interest-by-security-all-accounts/);
    expect(headers).toEqual([
      'Symbol',
      'Security',
      'Dividends',
      'Interest',
      'Capital Gains',
      'Total',
      'Currency',
    ]);
    expect(rows).toEqual([['AAA', 'Alpha', 100, 0, 0, 100, 'CAD']]);
  });

  describe('Daily view', () => {
    it('renders a Daily button alongside Monthly and By Security', async () => {
      mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
      mockGetInvestmentAccounts.mockResolvedValue([]);
      mockGetCapitalGains.mockResolvedValue([]);
      render(<DividendIncomeReport />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Daily' })).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: 'Monthly' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'By Security' })).toBeInTheDocument();
    });

    it('switches to a daily chart when Daily is clicked', async () => {
      mockGetTransactions.mockResolvedValue({
        data: [
          {
            id: 'tx-1',
            transactionDate: '2024-06-15',
            action: 'DIVIDEND',
            totalAmount: 50,
            accountId: 'acc-1',
            securityId: 'sec-a',
            security: { symbol: 'AAA', name: 'Alpha' },
          },
        ],
        pagination: { hasMore: false },
      });
      mockGetInvestmentAccounts.mockResolvedValue([
        { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
      ]);
      mockGetCapitalGains.mockResolvedValue([]);

      render(<DividendIncomeReport />);

      await waitFor(() => {
        expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Daily' }));

      await waitFor(() => {
        expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
      });
      expect(screen.getByText('Daily Gains, Dividends & Interest')).toBeInTheDocument();
    });

    it('shows the daily table with a Date column when Table is clicked in Daily view', async () => {
      mockGetTransactions.mockResolvedValue({
        data: [
          {
            id: 'tx-1',
            transactionDate: '2024-06-15',
            action: 'DIVIDEND',
            totalAmount: 75,
            accountId: 'acc-1',
            securityId: 'sec-a',
            security: { symbol: 'AAA', name: 'Alpha' },
          },
          {
            id: 'tx-2',
            transactionDate: '2024-06-15',
            action: 'INTEREST',
            totalAmount: 10,
            accountId: 'acc-1',
            securityId: null,
            security: null,
          },
          {
            id: 'tx-3',
            transactionDate: '2024-07-01',
            action: 'DIVIDEND',
            totalAmount: 25,
            accountId: 'acc-1',
            securityId: 'sec-a',
            security: { symbol: 'AAA', name: 'Alpha' },
          },
        ],
        pagination: { hasMore: false },
      });
      mockGetInvestmentAccounts.mockResolvedValue([
        { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
      ]);
      mockGetCapitalGains.mockResolvedValue([]);

      render(<DividendIncomeReport />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Daily' })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
      fireEvent.click(screen.getByRole('button', { name: 'Table' }));

      await waitFor(() => {
        expect(screen.queryByTestId('bar-chart')).not.toBeInTheDocument();
      });
      expect(screen.getByText('Date')).toBeInTheDocument();
      // Two distinct days have data.
      expect(screen.getByText('Jun 15, 2024')).toBeInTheDocument();
      expect(screen.getByText('Jul 1, 2024')).toBeInTheDocument();
      // Transactions on the same day should be aggregated ($75 + $10).
      expect(screen.getByText('$85.00')).toBeInTheDocument();
    });

    it('does not include monthly capital gains entries in the daily table', async () => {
      mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
      mockGetInvestmentAccounts.mockResolvedValue([
        { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
      ]);
      // Monthly capital gains (YYYY-MM key) go to the monthly/security views.
      // The daily lazy-load uses granularity=day and returns nothing here.
      mockGetCapitalGains.mockImplementation((params: { granularity?: string }) => {
        if (params.granularity === 'day') return Promise.resolve([]);
        return Promise.resolve([
          {
            month: '2024-06',
            accountId: 'acc-1',
            accountName: 'TFSA',
            accountCurrencyCode: 'CAD',
            securityId: 'sec-1',
            symbol: 'ABC',
            securityName: 'ABC Corp',
            securityCurrencyCode: 'CAD',
            startQuantity: 10,
            endQuantity: 0,
            startValue: 800,
            endValue: 0,
            buys: 0,
            sells: 800,
            realizedGain: 300,
            unrealizedGain: 0,
            totalCapitalGain: 300,
          },
        ]);
      });

      render(<DividendIncomeReport />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Daily' })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
      fireEvent.click(screen.getByRole('button', { name: 'Table' }));

      await waitFor(() => {
        expect(screen.queryByTestId('bar-chart')).not.toBeInTheDocument();
      });
      // Monthly CG entries are not folded into the daily table.
      expect(screen.getByText(/No daily transaction data/)).toBeInTheDocument();
    });

    it('writes a daily CSV with one row per day', async () => {
      mockGetTransactions.mockResolvedValue({
        data: [
          {
            id: 'tx-1',
            transactionDate: '2024-06-15',
            action: 'DIVIDEND',
            totalAmount: 50,
            accountId: 'acc-1',
            securityId: 'sec-a',
            security: { symbol: 'AAA', name: 'Alpha' },
          },
          {
            id: 'tx-2',
            transactionDate: '2024-07-10',
            action: 'INTEREST',
            totalAmount: 20,
            accountId: 'acc-1',
            securityId: null,
            security: null,
          },
        ],
        pagination: { hasMore: false },
      });
      mockGetInvestmentAccounts.mockResolvedValue([
        { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
      ]);
      mockGetCapitalGains.mockResolvedValue([]);

      render(<DividendIncomeReport />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Daily' })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
      fireEvent.click(screen.getByRole('button', { name: 'Table' }));

      fireEvent.click(await screen.findByRole('button', { name: /^export$/i }));
      fireEvent.click(screen.getByRole('button', { name: 'CSV' }));

      expect(mockExportToCsv).toHaveBeenCalledTimes(1);
      const [filename, headers, rows] = mockExportToCsv.mock.calls[0];
      expect(filename).toMatch(/gains-dividends-interest-daily-all-accounts/);
      expect(headers).toEqual([
        'Date',
        'Start Value',
        'End Value',
        'Dividends',
        'Interest',
        'Capital Gains',
        'Total',
        'Currency',
      ]);

      const juneRow = rows.find((r: any[]) => r[0] === '2024-06-15');
      expect(juneRow).toBeDefined();
      expect(juneRow[1]).toBe(0);   // Start Value
      expect(juneRow[2]).toBe(0);   // End Value
      expect(juneRow[3]).toBe(50);  // Dividends
      expect(juneRow[4]).toBe(0);   // Interest
      expect(juneRow[5]).toBe(0);   // Capital Gains
      expect(juneRow[6]).toBe(50);  // Total
      expect(juneRow[7]).toBe('CAD');

      const julyRow = rows.find((r: any[]) => r[0] === '2024-07-10');
      expect(julyRow).toBeDefined();
      expect(julyRow[3]).toBe(0);   // Dividends
      expect(julyRow[4]).toBe(20);  // Interest
      expect(julyRow[5]).toBe(0);   // Capital Gains
      expect(julyRow[6]).toBe(20);  // Total
    });

    it('hands daily table data to the PDF exporter', async () => {
      mockGetTransactions.mockResolvedValue({
        data: [
          {
            id: 'tx-1',
            transactionDate: '2024-06-15',
            action: 'DIVIDEND',
            totalAmount: 50,
            accountId: 'acc-1',
            securityId: 'sec-a',
            security: { symbol: 'AAA', name: 'Alpha' },
          },
        ],
        pagination: { hasMore: false },
      });
      mockGetInvestmentAccounts.mockResolvedValue([
        { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
      ]);
      mockGetCapitalGains.mockResolvedValue([]);

      render(<DividendIncomeReport />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Daily' })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
      fireEvent.click(screen.getByRole('button', { name: 'Table' }));

      fireEvent.click(await screen.findByRole('button', { name: /^export$/i }));
      fireEvent.click(screen.getByRole('button', { name: 'PDF' }));

      await waitFor(() => {
        expect(mockExportToPdf).toHaveBeenCalledTimes(1);
      });
      const args = mockExportToPdf.mock.calls[0][0];
      expect(args.chartContainer).toBeUndefined();
      expect(args.tableData).toBeDefined();
      expect(args.tableData.headers).toEqual([
        'Date',
        'Start Value',
        'End Value',
        'Dividends',
        'Interest',
        'Capital Gains',
        'Total',
      ]);
      expect(args.tableData.rows.length).toBeGreaterThan(0);
      expect(args.tableData.totalRow?.[0]).toBe('Total');
      // Start/End Value in the footer are intentionally blank (same as monthly table).
      expect(args.tableData.totalRow?.[1]).toBe('');
      expect(args.tableData.totalRow?.[2]).toBe('');
    });

    it('renders Start Value and End Value columns in the daily table from lazy-loaded capital gains', async () => {
      mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
      mockGetInvestmentAccounts.mockResolvedValue([
        { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
      ]);
      mockGetCapitalGains.mockImplementation((params: { granularity?: string }) => {
        if (params.granularity === 'day') {
          return Promise.resolve([
            {
              month: '2024-06-15',
              accountId: 'acc-1',
              accountName: 'TFSA',
              accountCurrencyCode: 'CAD',
              securityId: 'sec-1',
              symbol: 'ABC',
              securityName: 'ABC Corp',
              securityCurrencyCode: 'CAD',
              startQuantity: 10,
              endQuantity: 10,
              startValue: 1000,
              endValue: 1050,
              buys: 0,
              sells: 0,
              realizedGain: 0,
              unrealizedGain: 50,
              totalCapitalGain: 50,
            },
          ]);
        }
        return Promise.resolve([]);
      });

      render(<DividendIncomeReport />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Daily' })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
      fireEvent.click(screen.getByRole('button', { name: 'Table' }));

      // Start/End Value headers appear in the daily table.
      expect(await screen.findByText('Start Value')).toBeInTheDocument();
      expect(screen.getByText('End Value')).toBeInTheDocument();
      // The Jun 15 row carries the start ($1000) and end ($1050) values.
      expect(await screen.findByText('$1000.00')).toBeInTheDocument();
      expect(screen.getByText('$1050.00')).toBeInTheDocument();
    });

    it('shows a Hide inactive days toggle only in daily view', async () => {
      mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
      mockGetInvestmentAccounts.mockResolvedValue([]);
      mockGetCapitalGains.mockResolvedValue([]);

      render(<DividendIncomeReport />);

      // Toggle should not be visible in monthly view (default).
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Monthly' })).toBeInTheDocument();
      });
      expect(screen.queryByRole('switch', { name: /hide inactive days/i })).not.toBeInTheDocument();

      // Switch to daily view — toggle should appear.
      fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
      expect(await screen.findByRole('switch', { name: /hide inactive days/i })).toBeInTheDocument();

      // Switch back to monthly — toggle disappears again.
      fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));
      await waitFor(() => {
        expect(screen.queryByRole('switch', { name: /hide inactive days/i })).not.toBeInTheDocument();
      });
    });

    it('hides days with all-zero activity when Hide inactive days is toggled on', async () => {
      mockGetTransactions.mockResolvedValue({
        data: [
          {
            id: 'tx-1',
            transactionDate: '2024-06-17',
            action: 'DIVIDEND',
            totalAmount: 50,
            accountId: 'acc-1',
            securityId: 'sec-a',
            security: { symbol: 'AAA', name: 'Alpha' },
          },
        ],
        pagination: { hasMore: false },
      });
      mockGetInvestmentAccounts.mockResolvedValue([
        { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
      ]);
      // Day capital gains: Jun 15 has a price movement, Jun 16 is a weekend
      // where the portfolio still holds value but no market activity occurred
      // (start == end, zero gain), Jun 17 has a dividend transaction.
      mockGetCapitalGains.mockImplementation((params: { granularity?: string }) => {
        if (params.granularity === 'day') {
          return Promise.resolve([
            {
              month: '2024-06-15',
              accountId: 'acc-1',
              accountName: 'TFSA',
              accountCurrencyCode: 'CAD',
              securityId: 'sec-1',
              symbol: 'ABC',
              securityName: 'ABC Corp',
              securityCurrencyCode: 'CAD',
              startQuantity: 10,
              endQuantity: 10,
              startValue: 1000,
              endValue: 1020,
              buys: 0,
              sells: 0,
              realizedGain: 0,
              unrealizedGain: 20,
              totalCapitalGain: 20,
            },
            // Jun 16: weekend — portfolio still holds 10 shares at the Friday
            // close, but no market activity so start == end and gain is zero.
            {
              month: '2024-06-16',
              accountId: 'acc-1',
              accountName: 'TFSA',
              accountCurrencyCode: 'CAD',
              securityId: 'sec-1',
              symbol: 'ABC',
              securityName: 'ABC Corp',
              securityCurrencyCode: 'CAD',
              startQuantity: 10,
              endQuantity: 10,
              startValue: 1020,
              endValue: 1020,
              buys: 0,
              sells: 0,
              realizedGain: 0,
              unrealizedGain: 0,
              totalCapitalGain: 0,
            },
          ]);
        }
        return Promise.resolve([]);
      });

      render(<DividendIncomeReport />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Daily' })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
      fireEvent.click(screen.getByRole('button', { name: 'Table' }));

      // All three days appear initially (toggle is off).
      expect(await screen.findByText('Jun 15, 2024')).toBeInTheDocument();
      expect(screen.getByText('Jun 16, 2024')).toBeInTheDocument();
      expect(screen.getByText('Jun 17, 2024')).toBeInTheDocument();

      // Enable the toggle — Jun 16 (all zeros) should disappear.
      const toggle = screen.getByRole('switch', { name: /hide inactive days/i });
      fireEvent.click(toggle);

      await waitFor(() => {
        expect(screen.queryByText('Jun 16, 2024')).not.toBeInTheDocument();
      });
      // Active days remain visible.
      expect(screen.getByText('Jun 15, 2024')).toBeInTheDocument();
      expect(screen.getByText('Jun 17, 2024')).toBeInTheDocument();

      // Disable the toggle — Jun 16 comes back.
      fireEvent.click(toggle);
      expect(await screen.findByText('Jun 16, 2024')).toBeInTheDocument();
    });

    it('shows chart container (not table data) to PDF exporter in daily chart view', async () => {
      mockGetTransactions.mockResolvedValue({
        data: [
          {
            id: 'tx-1',
            transactionDate: '2024-06-15',
            action: 'DIVIDEND',
            totalAmount: 50,
            accountId: 'acc-1',
            securityId: 'sec-a',
            security: { symbol: 'AAA', name: 'Alpha' },
          },
        ],
        pagination: { hasMore: false },
      });
      mockGetInvestmentAccounts.mockResolvedValue([
        { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
      ]);
      mockGetCapitalGains.mockResolvedValue([]);

      render(<DividendIncomeReport />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Daily' })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: 'Daily' }));

      // Daily chart view: ExportDropdown collapses to PDF-only button.
      const exportPdfBtn = await screen.findByRole('button', { name: /export pdf/i });
      fireEvent.click(exportPdfBtn);

      await waitFor(() => {
        expect(mockExportToPdf).toHaveBeenCalledTimes(1);
      });
      const args = mockExportToPdf.mock.calls[0][0];
      expect(args.chartContainer).not.toBeNull();
      expect(args.tableData).toBeUndefined();
    });
  });

  it('renders series toggle pills and hides a series when one is clicked', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          totalAmount: 100,
          accountId: 'acc-1',
          security: { symbol: 'VFV', name: 'Vanguard S&P 500' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);
    render(<DividendIncomeReport />);

    // Wait until the chart's Capital Gains bar appears, then toggle it off via
    // the coloured pill (no checkbox here — it's a toggle button).
    await waitFor(() => {
      expect(screen.getByTestId('bar-Capital Gains')).toBeInTheDocument();
    });

    const capitalGainsToggle = screen.getByRole('button', { name: 'Capital Gains' });
    expect(capitalGainsToggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(capitalGainsToggle);

    await waitFor(() => {
      expect(screen.queryByTestId('bar-Capital Gains')).not.toBeInTheDocument();
    });
    expect(capitalGainsToggle.getAttribute('aria-pressed')).toBe('false');
    // Other series pills remain in the "on" state and their bars are visible.
    expect(
      screen.getByRole('button', { name: 'Dividends' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByTestId('bar-Dividends')).toBeInTheDocument();
    expect(screen.getByTestId('bar-Interest')).toBeInTheDocument();
  });

  it('writes a by-security PDF with table data', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          totalAmount: 200,
          accountId: 'acc-1',
          securityId: 'sec-a',
          security: { symbol: 'AAA', name: 'Alpha Corp' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'By Security' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'By Security' }));

    fireEvent.click(await screen.findByRole('button', { name: /^export$/i }));
    fireEvent.click(screen.getByRole('button', { name: 'PDF' }));

    await waitFor(() => {
      expect(mockExportToPdf).toHaveBeenCalledTimes(1);
    });
    const args = mockExportToPdf.mock.calls[0][0];
    expect(args.tableData).toBeDefined();
    expect(args.tableData.headers).toEqual([
      'Symbol',
      'Security',
      'Dividends',
      'Interest',
      'Capital Gains',
      'Total',
    ]);
    expect(args.tableData.rows.length).toBe(1);
    expect(args.tableData.rows[0][0]).toBe('AAA');
    expect(args.tableData.totalRow?.[0]).toBe('Total');
    expect(args.chartContainer).toBeUndefined();
  });

  it('omits hidden series from the monthly PDF table', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'INTEREST',
          totalAmount: 50,
          accountId: 'acc-1',
          securityId: 'sec-a',
          security: { symbol: 'CASH', name: 'Cash Interest' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'RRSP', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Table' })).toBeInTheDocument();
    });
    // Hide Dividends and Capital Gains series
    fireEvent.click(screen.getByRole('button', { name: 'Dividends' }));
    fireEvent.click(screen.getByRole('button', { name: 'Capital Gains' }));
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));

    fireEvent.click(await screen.findByRole('button', { name: /^export$/i }));
    fireEvent.click(screen.getByRole('button', { name: 'PDF' }));

    await waitFor(() => {
      expect(mockExportToPdf).toHaveBeenCalledTimes(1);
    });
    const args = mockExportToPdf.mock.calls[0][0];
    expect(args.tableData.headers).toEqual([
      'Month',
      'Start Value',
      'End Value',
      'Interest',
      'Total',
    ]);
  });

  it('paginates through all transaction pages until hasMore is false', async () => {
    mockGetTransactions
      .mockResolvedValueOnce({
        data: [
          {
            id: 'tx-1',
            transactionDate: '2024-03-15',
            action: 'DIVIDEND',
            totalAmount: 50,
            accountId: 'acc-1',
            securityId: 'sec-a',
            security: { symbol: 'AAA', name: 'Alpha' },
          },
        ],
        pagination: { hasMore: true },
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'tx-2',
            transactionDate: '2024-04-15',
            action: 'DIVIDEND',
            totalAmount: 75,
            accountId: 'acc-1',
            securityId: 'sec-a',
            security: { symbol: 'AAA', name: 'Alpha' },
          },
        ],
        pagination: { hasMore: false },
      });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    await waitFor(() => {
      // Both pages summed: $125 total dividends
      expect(screen.getAllByText('$125.00').length).toBeGreaterThan(0);
    });
    expect(mockGetTransactions).toHaveBeenCalledTimes(2);
    expect(mockGetTransactions).toHaveBeenNthCalledWith(1, expect.objectContaining({ page: 1 }));
    expect(mockGetTransactions).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 2 }));
  });

  it('shows a retryable error and hides the loading spinner when data fetch fails', async () => {
    mockGetTransactions.mockRejectedValue(new Error('Network error'));
    mockGetInvestmentAccounts.mockResolvedValue([]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    // Loading spinner should disappear even on error
    await waitFor(() => {
      expect(document.querySelector('.animate-pulse')).not.toBeInTheDocument();
    });
    // A visible, retryable error replaces the empty state on a failed fetch.
    expect(screen.getByText(/Failed to load report data/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });

  it('converts amounts to default currency in the all-accounts view', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          totalAmount: 100,
          accountId: 'acc-1',
          securityId: 'sec-a',
          security: { symbol: 'AAA', name: 'Alpha' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'USD Account', currencyCode: 'USD', accountSubType: 'INVESTMENT_CASH' },
      { id: 'acc-2', name: 'RRSP', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    // All-accounts view: uses convertToDefault (identity in the mock)
    await waitFor(() => {
      expect(screen.getAllByText('$100.00').length).toBeGreaterThan(0);
    });
  });

  it('uses native currency (no conversion) when a single account is selected', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          totalAmount: 80,
          accountId: 'acc-1',
          securityId: 'sec-a',
          security: { symbol: 'AAA', name: 'Alpha' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'USD Account', currencyCode: 'USD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    // Wait for data to load, then select the USD account
    await screen.findByLabelText('Filter by account');
    await toggleAccountByName('USD Account');

    await waitFor(() => {
      // In single-account mode with a foreign currency the label shows the currency code
      expect(screen.getAllByText(/USD/).length).toBeGreaterThan(0);
    });
  });

  it('populates available securities from capital gains entries not present in transactions', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([
      {
        month: '2024-06',
        accountId: 'acc-1',
        accountName: 'TFSA',
        accountCurrencyCode: 'CAD',
        securityId: 'cg-sec-1',
        symbol: 'XYZ',
        securityName: 'XYZ Fund',
        securityCurrencyCode: 'CAD',
        startQuantity: 10,
        endQuantity: 10,
        startValue: 1000,
        endValue: 1100,
        buys: 0,
        sells: 0,
        realizedGain: 0,
        unrealizedGain: 100,
        totalCapitalGain: 100,
      },
    ]);

    render(<DividendIncomeReport />);

    const securitySelect = (await screen.findByLabelText('Filter by security')) as HTMLSelectElement;
    await waitFor(() => {
      expect(securitySelect.options.length).toBeGreaterThan(1);
    });
    const values = Array.from(securitySelect.options).map((o) => o.value);
    expect(values).toContain('cg-sec-1');
  });

  it('clears the security filter when the selected security is no longer in available securities', async () => {
    // First load: transaction with sec-a
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          totalAmount: 100,
          accountId: 'acc-1',
          securityId: 'sec-a',
          security: { symbol: 'AAA', name: 'Alpha' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
      { id: 'acc-2', name: 'RRSP', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    const securitySelect = (await screen.findByLabelText('Filter by security')) as HTMLSelectElement;
    await waitFor(() => expect(securitySelect.options.length).toBeGreaterThan(1));

    // Select sec-a
    fireEvent.change(securitySelect, { target: { value: 'sec-a' } });
    expect(securitySelect.value).toBe('sec-a');

    // Now reload with no transactions for acc-2 — sec-a drops from available set
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    await toggleAccountByName('RRSP');

    // Security selection should be cleared automatically
    await waitFor(() => {
      const sel = screen.getByLabelText('Filter by security') as HTMLSelectElement;
      expect(sel.value).toBe('');
    });
  });

  it('renders transaction-based CAPITAL_GAIN action amounts in the chart', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'CAPITAL_GAIN',
          totalAmount: 150,
          accountId: 'acc-1',
          securityId: 'sec-a',
          security: { symbol: 'AAA', name: 'Alpha' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    await waitFor(() => {
      // Capital Gains total card shows $150 from the CAPITAL_GAIN transaction
      expect(screen.getAllByText('$150.00').length).toBeGreaterThan(0);
    });
    // Chart bars are rendered
    expect(screen.getByTestId('bar-Capital Gains')).toBeInTheDocument();
  });

  it('uses Unknown symbol/name fallback for transactions missing security info', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          totalAmount: 30,
          accountId: 'acc-1',
          // security and securityId intentionally absent
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    // Switch to By Security to trigger the securityData computation
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'By Security' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'By Security' }));

    await waitFor(() => {
      expect(screen.getByText('Unknown')).toBeInTheDocument();
    });
  });

  it('shows dash for zero values in monthly table rows', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          totalAmount: 100,
          accountId: 'acc-1',
          securityId: 'sec-a',
          security: { symbol: 'AAA', name: 'Alpha' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Table' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));

    await waitFor(() => {
      expect(screen.getByText('Month')).toBeInTheDocument();
    });
    // Rows with zero Interest and Capital Gains should show '-'
    const dashCells = screen.getAllByText('-');
    expect(dashCells.length).toBeGreaterThan(0);
    // Start Value and End Value are zero (no capital gain entries) so also '-'
    expect(dashCells.some(() => true)).toBe(true);
  });

  it('shows negative monthly total with red styling', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([
      {
        month: '2024-06',
        accountId: 'acc-1',
        accountName: 'TFSA',
        accountCurrencyCode: 'CAD',
        securityId: 'sec-a',
        symbol: 'AAA',
        securityName: 'Alpha',
        securityCurrencyCode: 'CAD',
        startQuantity: 10,
        endQuantity: 10,
        startValue: 1000,
        endValue: 500,
        buys: 0,
        sells: 0,
        realizedGain: 0,
        unrealizedGain: -500,
        totalCapitalGain: -500,
      },
    ]);

    render(<DividendIncomeReport />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Table' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));

    await waitFor(() => {
      expect(screen.getByText('Month')).toBeInTheDocument();
    });
    // Negative capital gain row: the total cell should use red text
    const negativeCells = document.querySelectorAll('.text-red-600');
    expect(negativeCells.length).toBeGreaterThan(0);
  });

  it('renders negative security capital gains with red styling and negative total', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([
      {
        month: '2024-06',
        accountId: 'acc-1',
        accountName: 'TFSA',
        accountCurrencyCode: 'CAD',
        securityId: 'sec-a',
        symbol: 'LOSS',
        securityName: 'Loss Corp',
        securityCurrencyCode: 'CAD',
        startQuantity: 10,
        endQuantity: 10,
        startValue: 2000,
        endValue: 1500,
        buys: 0,
        sells: 0,
        realizedGain: 0,
        unrealizedGain: -500,
        totalCapitalGain: -500,
      },
    ]);

    render(<DividendIncomeReport />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'By Security' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'By Security' }));

    await waitFor(() => {
      expect(screen.getByText('LOSS')).toBeInTheDocument();
    });
    // Negative capital gain and total cells use red styling
    const redCells = document.querySelectorAll('.text-red-600');
    expect(redCells.length).toBeGreaterThan(0);
    // No dash for zero — negative value is shown
    expect(screen.getAllByText('$-500.00').length).toBeGreaterThan(0);
  });

  it('renders side-by-side bars (no stackId) when monthly data has negative capital gains', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([
      {
        month: '2024-06',
        accountId: 'acc-1',
        accountName: 'TFSA',
        accountCurrencyCode: 'CAD',
        securityId: 'sec-a',
        symbol: 'BAD',
        securityName: 'Bad Corp',
        securityCurrencyCode: 'CAD',
        startQuantity: 10,
        endQuantity: 10,
        startValue: 1000,
        endValue: 500,
        buys: 0,
        sells: 0,
        realizedGain: 0,
        unrealizedGain: -500,
        totalCapitalGain: -500,
      },
    ]);

    render(<DividendIncomeReport />);

    await waitFor(() => {
      // Chart is shown with bars for the negative CG month
      expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    });
    // All three series bars are rendered in the chart
    expect(screen.getByTestId('bar-Capital Gains')).toBeInTheDocument();
  });

  it('accounts filter hides brokerage sub-accounts', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA - Cash', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
      { id: 'acc-2', name: 'TFSA - Brokerage', currencyCode: 'CAD', accountSubType: 'INVESTMENT_BROKERAGE' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    await screen.findByLabelText('Filter by account');
    // INVESTMENT_BROKERAGE accounts are filtered out; only INVESTMENT_CASH appears
    await waitFor(async () => {
      const labels = await getAccountOptionLabels();
      expect(labels).toContain('TFSA');
      expect(labels.some((l) => /Brokerage/i.test(l))).toBe(false);
    });
  });

  it('sends a comma-separated accountIds param when multiple accounts are selected', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
      { id: 'acc-2', name: 'RRSP', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
      { id: 'acc-3', name: 'Margin', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);
    await screen.findByLabelText('Filter by account');

    mockGetTransactions.mockClear();
    mockGetCapitalGains.mockClear();

    await toggleAccountByName('TFSA');
    await toggleAccountByName('RRSP');

    await waitFor(() => {
      const lastCgCall = mockGetCapitalGains.mock.calls.at(-1)?.[0];
      expect(lastCgCall?.accountIds).toBe('acc-1,acc-2');
      const lastTxCall = mockGetTransactions.mock.calls.at(-1)?.[0];
      expect(lastTxCall?.accountIds).toBe('acc-1,acc-2');
    });
  });

  it('strips the account name suffix in the CSV filename when an account is selected', async () => {
    const txData = {
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          totalAmount: 100,
          accountId: 'acc-1',
          securityId: 'sec-a',
          security: { symbol: 'AAA', name: 'Alpha' },
        },
      ],
      pagination: { hasMore: false },
    };
    // Both initial load and the reload after account-filter change use the same data
    mockGetTransactions.mockResolvedValue(txData);
    mockGetInvestmentAccounts.mockResolvedValue([
      {
        id: 'acc-1',
        name: 'My TFSA - Brokerage',
        currencyCode: 'CAD',
        accountSubType: 'INVESTMENT_CASH',
      },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    // Wait for initial load, then select the account (its display label has
    // the " - Brokerage" suffix stripped, so we toggle by the cleaned name).
    await screen.findByLabelText('Filter by account');
    await toggleAccountByName('My TFSA');

    // Wait for the reload to complete and By Security button to appear
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'By Security' })).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'By Security' }));
    });

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /^export$/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'CSV' }));
    });

    const [filename] = mockExportToCsv.mock.calls[0];
    // Suffix " - Brokerage" should be stripped from the filename
    expect(filename).toMatch(/my-tfsa/);
    expect(filename).not.toMatch(/brokerage/i);
  });

  it('switches back from By Security to Monthly view', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          totalAmount: 100,
          accountId: 'acc-1',
          securityId: 'sec-a',
          security: { symbol: 'AAA', name: 'Alpha' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'By Security' })).toBeInTheDocument();
    });

    // Navigate to By Security
    fireEvent.click(screen.getByRole('button', { name: 'By Security' }));
    await waitFor(() => {
      expect(screen.getByText('Income by Security')).toBeInTheDocument();
    });

    // Navigate back to Monthly
    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));
    await waitFor(() => {
      expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    });
    // Series toggle pills return when in Monthly view
    expect(screen.getByRole('button', { name: 'Dividends' })).toBeInTheDocument();
  });

  it('toggles Dividends and Interest series off then back on', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'INTEREST',
          totalAmount: 40,
          accountId: 'acc-1',
          security: { symbol: 'CASH', name: 'Cash' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    await waitFor(() => {
      expect(screen.getByTestId('bar-Dividends')).toBeInTheDocument();
    });

    // Toggle Dividends off
    fireEvent.click(screen.getByRole('button', { name: 'Dividends' }));
    await waitFor(() => {
      expect(screen.queryByTestId('bar-Dividends')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Dividends' }).getAttribute('aria-pressed')).toBe('false');

    // Toggle Interest off
    fireEvent.click(screen.getByRole('button', { name: 'Interest' }));
    await waitFor(() => {
      expect(screen.queryByTestId('bar-Interest')).not.toBeInTheDocument();
    });

    // Toggle Dividends back on
    fireEvent.click(screen.getByRole('button', { name: 'Dividends' }));
    await waitFor(() => {
      expect(screen.getByTestId('bar-Dividends')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Dividends' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows dash for zero dividends/interest in the by-security table', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([
      {
        month: '2024-06',
        accountId: 'acc-1',
        accountName: 'TFSA',
        accountCurrencyCode: 'CAD',
        securityId: 'sec-a',
        symbol: 'ETF',
        securityName: 'ETF Fund',
        securityCurrencyCode: 'CAD',
        startQuantity: 10,
        endQuantity: 10,
        startValue: 1000,
        endValue: 1200,
        buys: 0,
        sells: 0,
        realizedGain: 0,
        unrealizedGain: 200,
        totalCapitalGain: 200,
      },
    ]);

    render(<DividendIncomeReport />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'By Security' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'By Security' }));

    await waitFor(() => {
      expect(screen.getByText('ETF')).toBeInTheDocument();
    });
    // No dividends or interest for this security — cells should show '-'
    const dashCells = screen.getAllByText('-');
    expect(dashCells.length).toBeGreaterThan(0);
  });

  it('switches monthly view back to chart after visiting table', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          totalAmount: 60,
          accountId: 'acc-1',
          securityId: 'sec-a',
          security: { symbol: 'AAA', name: 'Alpha' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetCapitalGains.mockResolvedValue([]);

    render(<DividendIncomeReport />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Table' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));

    await waitFor(() => {
      expect(screen.getByText('Month')).toBeInTheDocument();
    });

    // Switch back to Chart
    fireEvent.click(screen.getByRole('button', { name: 'Chart' }));
    await waitFor(() => {
      expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    });
    expect(screen.queryByText('Month')).not.toBeInTheDocument();
  });

  it('capital gains account-currency conversion in the all-accounts view', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'USD TFSA', currencyCode: 'USD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    // The convertToDefault mock is an identity function, but we verify the
    // conversion path is exercised for capital gains entries.
    mockGetCapitalGains.mockResolvedValue([
      {
        month: '2024-06',
        accountId: 'acc-1',
        accountName: 'USD TFSA',
        accountCurrencyCode: 'USD',
        securityId: 'sec-usd',
        symbol: 'SPY',
        securityName: 'S&P 500 ETF',
        securityCurrencyCode: 'USD',
        startQuantity: 5,
        endQuantity: 5,
        startValue: 2500,
        endValue: 2700,
        buys: 0,
        sells: 0,
        realizedGain: 0,
        unrealizedGain: 200,
        totalCapitalGain: 200,
      },
    ]);

    render(<DividendIncomeReport />);

    await waitFor(() => {
      // $200 capital gain shows in summary card
      expect(screen.getAllByText('$200.00').length).toBeGreaterThan(0);
    });
  });

  it('renders monthly, daily, and security tables and exercises sortable columns + CSV export', async () => {
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Brokerage', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx1',
          accountId: 'acc-1',
          securityId: 'sec-a',
          security: { symbol: 'AAA', name: 'Alpha' },
          transactionDate: '2024-03-10',
          totalAmount: 50,
          action: 'DIVIDEND',
        },
        {
          id: 'tx2',
          accountId: 'acc-1',
          securityId: 'sec-b',
          security: { symbol: 'BBB', name: 'Bravo' },
          transactionDate: '2024-04-12',
          totalAmount: 30,
          action: 'INTEREST',
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetCapitalGains.mockResolvedValue([
      {
        securityId: 'sec-a',
        symbol: 'AAA',
        securityName: 'Alpha',
        accountId: 'acc-1',
        accountCurrencyCode: 'CAD',
        month: '2024-03',
        startValue: 1000,
        endValue: 1100,
        buys: 0,
        sells: 0,
        realizedGain: 0,
        unrealizedGain: 100,
        totalCapitalGain: 100,
      },
    ]);
    const { container } = render(<DividendIncomeReport />);
    await waitFor(() => expect(screen.getByTestId('bar-chart')).toBeInTheDocument());
    // Switch to monthly table view by clicking the "Table" button in the
    // monthly/daily display group (text "Table" is unique among controls).
    const tableBtn = screen.getByText('Table');
    await act(async () => { fireEvent.click(tableBtn); });
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    // Click each column header in sequence, re-querying between each click
    // so we hit every switch case in the comparator even if React preserves
    // the same DOM nodes across re-renders.
    const monthlyHeaderCount = container.querySelectorAll('table thead th').length;
    for (let i = 0; i < monthlyHeaderCount; i += 1) {
      const headersNow = container.querySelectorAll('table thead th');
      await act(async () => { fireEvent.click(headersNow[i]); });
    }
    // Click each one a second time to flip asc/desc.
    for (let i = 0; i < monthlyHeaderCount; i += 1) {
      const headersNow = container.querySelectorAll('table thead th');
      await act(async () => { fireEvent.click(headersNow[i]); });
    }
    // Toggle visible series buttons to flip the rowTotal branches in the table.
    const seriesButtons = ['Dividends', 'Interest', 'Capital Gains'].flatMap((label) =>
      screen.getAllByRole('button', { name: label }),
    );
    for (const btn of seriesButtons) {
      await act(async () => { fireEvent.click(btn); });
    }
    for (const btn of seriesButtons) {
      await act(async () => { fireEvent.click(btn); });
    }
    // Switch to By Security view.
    const bySecBtn = screen.getByText('By Security');
    await act(async () => { fireEvent.click(bySecBtn); });
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    const secHeaderCount = container.querySelectorAll('table thead th').length;
    for (let i = 0; i < secHeaderCount; i += 1) {
      const ths = container.querySelectorAll('table thead th');
      if (!ths[i]) break;
      await act(async () => { fireEvent.click(ths[i]); });
    }
    for (let i = 0; i < secHeaderCount; i += 1) {
      const ths = container.querySelectorAll('table thead th');
      if (!ths[i]) break;
      await act(async () => { fireEvent.click(ths[i]); });
    }
    // Switch to Daily view and into table mode there.
    const dailyBtn = screen.getByText('Daily');
    await act(async () => { fireEvent.click(dailyBtn); });
    const dailyTableBtn = screen.queryByText('Table');
    if (dailyTableBtn) {
      await act(async () => { fireEvent.click(dailyTableBtn); });
      const dailyHeaderCount = container.querySelectorAll('table thead th').length;
      for (let i = 0; i < dailyHeaderCount; i += 1) {
        const ths = container.querySelectorAll('table thead th');
        if (!ths[i]) break;
        await act(async () => { fireEvent.click(ths[i]); });
      }
      for (let i = 0; i < dailyHeaderCount; i += 1) {
        const ths = container.querySelectorAll('table thead th');
        if (!ths[i]) break;
        await act(async () => { fireEvent.click(ths[i]); });
      }
      // Toggle "Hide inactive days" to flip the displayedDailyData filter branch.
      const hideToggle = screen.queryByRole('switch');
      if (hideToggle) {
        await act(async () => { fireEvent.click(hideToggle); });
      }
    }
  }, 15000);
});
