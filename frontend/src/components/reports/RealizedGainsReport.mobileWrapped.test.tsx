import { act, fireEvent, render, screen, waitFor } from '@/test/render';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RealizedGainsReport } from './RealizedGainsReport';

const mockGetRealizedGains = vi.fn();
const mockGetInvestmentAccounts = vi.fn();

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (value: number) => `MONEY<${value}>`,
      formatCurrencyAxis: (value: number) => `AXIS<${value}>`,
      formatNumber: (value: number) => `COUNT<${value}>`,
      formatPercent: (value: number) => `PERCENT<${value}>`,
      formatShareQuantity: (value: number) => `SHARES<${value}>`,
    }),
  };
});

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    formatDate: (value: string) => `DATE<${value}>`,
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: '1y',
    setDateRange: vi.fn(),
    resolvedRange: { start: '2025-01-01', end: '2026-01-01' },
    isValid: true,
  }),
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock('@/components/ui/ExportDropdown', () => ({
  ExportDropdown: () => <div data-testid="export-dropdown" />,
}));

vi.mock('@/components/reports/ReportAccountMultiSelect', () => ({
  ReportAccountMultiSelect: () => <div data-testid="account-filter" />,
}));

vi.mock('@/components/reports/RefreshPricesButton', () => ({
  RefreshPricesButton: () => <button type="button">Refresh</button>,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getRealizedGains: (...args: unknown[]) => mockGetRealizedGains(...args),
    getInvestmentAccounts: (...args: unknown[]) => mockGetInvestmentAccounts(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const ENTRIES = [
  {
    transactionId: 'sell-1',
    transactionDate: '2025-06-15',
    accountId: 'acc-1',
    accountName: 'Brokerage',
    accountCurrencyCode: 'CAD',
    securityId: 'sec-1',
    symbol: 'LONG',
    securityName: 'A deliberately long security name that must wrap without a clamp',
    securityCurrencyCode: 'CAD',
    quantity: 12.3456789,
    price: 100.5,
    commission: 0,
    proceeds: 1240,
    costBasis: 1000,
    realizedGain: 240,
    inReportingCurrency: { currency: 'CAD', proceeds: 1240, costBasis: 1000, realizedGain: 240 },
  },
  {
    transactionId: 'sell-2',
    transactionDate: '2025-07-20',
    accountId: 'acc-1',
    accountName: 'Brokerage',
    accountCurrencyCode: 'CAD',
    securityId: 'sec-1',
    symbol: 'LONG',
    securityName: 'A deliberately long security name that must wrap without a clamp',
    securityCurrencyCode: 'CAD',
    quantity: 2,
    price: 80,
    commission: 0,
    proceeds: 160,
    costBasis: 200,
    realizedGain: -40,
    inReportingCurrency: { currency: 'CAD', proceeds: 160, costBasis: 200, realizedGain: -40 },
  },
];

function placement(cell: Element): string {
  const column = [...cell.classList].find((name) => name.startsWith('col-start-'));
  const row = [...cell.classList].find((name) => name.startsWith('row-start-'));
  return `${column}/${row}`;
}

async function renderTables() {
  mockGetRealizedGains.mockResolvedValue(ENTRIES);
  mockGetInvestmentAccounts.mockResolvedValue([]);
  const view = render(<RealizedGainsReport />);
  const tableButton = await screen.findByTitle('Table');
  await act(async () => {
    fireEvent.click(tableButton);
  });
  await waitFor(() => expect(view.container.querySelectorAll('table')).toHaveLength(2));
  return {
    ...view,
    securityTable: view.container.querySelectorAll('table')[0],
    sellsTable: view.container.querySelectorAll('table')[1],
  };
}

describe('RealizedGainsReport mobile wrapped tables', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('wraps the security summary and its total into three explicit phone lines', async () => {
    const { securityTable } = await renderTables();

    expect(securityTable).toHaveAttribute('role', 'table');
    expect(securityTable.className).toContain('block');
    expect(securityTable.className).toContain('sm:table');
    expect(securityTable.querySelector('thead')).toHaveAttribute('role', 'rowgroup');
    expect(securityTable.querySelector('tbody')).toHaveAttribute('role', 'rowgroup');
    expect(securityTable.querySelector('tfoot')).toHaveAttribute('role', 'rowgroup');

    const row = securityTable.querySelector('tbody tr');
    expect(row).toHaveAttribute('role', 'row');
    expect(row?.className).toContain('grid-cols-2');
    expect(row?.className).toContain('sm:table-row');
    const cells = Array.from(row?.querySelectorAll('td') ?? []);
    expect(cells).toHaveLength(5);
    expect(cells.map(placement)).toEqual([
      'col-start-1/row-start-1',
      'col-start-2/row-start-1',
      'col-start-1/row-start-2',
      'col-start-2/row-start-2',
      'col-start-1/row-start-3',
    ]);
    expect(cells[4].className).toContain('col-span-2');
    expect(cells.every((cell) => cell.getAttribute('role') === 'cell')).toBe(true);
    expect(cells[0].querySelector('span')).toBeNull();
    expect(cells.slice(1).map((cell) => cell.querySelector('span')?.textContent)).toEqual([
      'Trades',
      'Proceeds',
      'Cost Basis',
      'Gain/Loss',
    ]);
    expect(cells[0].textContent).toContain('A deliberately long security name');
    expect(cells[0].querySelector('.break-words')).toBeInTheDocument();
    expect(cells[1]).toHaveTextContent('COUNT<2>');

    const totalCells = Array.from(securityTable.querySelectorAll('tfoot td'));
    expect(totalCells.map(placement)).toEqual(cells.map(placement));
    expect(totalCells[1]).toHaveTextContent('COUNT<2>');
    expect(totalCells[4].className).toContain('col-span-2');
  });

  it('wraps every sell transaction and uses preference-aware date and number formatters', async () => {
    const { sellsTable } = await renderTables();
    const row = sellsTable.querySelector('tbody tr');
    expect(row).toHaveAttribute('role', 'row');
    expect(row?.className).toContain('grid-cols-2');
    expect(row?.className).toContain('sm:table-row');
    const cells = Array.from(row?.querySelectorAll('td') ?? []);
    expect(cells).toHaveLength(5);
    expect(cells.map(placement)).toEqual([
      'col-start-1/row-start-1',
      'col-start-2/row-start-1',
      'col-start-1/row-start-2',
      'col-start-2/row-start-2',
      'col-start-1/row-start-3',
    ]);
    expect(cells[4].className).toContain('col-span-2');
    expect(cells.every((cell) => cell.getAttribute('role') === 'cell')).toBe(true);
    expect(cells.map((cell) => cell.querySelector('span')?.textContent ?? null)).toEqual([
      'Date',
      null,
      'Shares',
      'Price',
      'Proceeds',
    ]);
    expect(cells[0]).toHaveTextContent('DATE<2025-07-20>');
    expect(cells[2]).toHaveTextContent('SHARES<2>');
    expect(cells[3]).toHaveTextContent('MONEY<80>');
    expect(cells[4]).toHaveTextContent('MONEY<160>');
  });

  it('keeps all sort controls in accessible phone strips and restores the desktop table', async () => {
    const { securityTable, sellsTable } = await renderTables();

    for (const table of [securityTable, sellsTable]) {
      const headerRows = table.querySelectorAll('thead tr');
      expect(headerRows).toHaveLength(2);
      expect(headerRows[0].className).toContain('sm:hidden');
      expect(headerRows[1].className).toContain('hidden');
      expect(headerRows[1].className).toContain('sm:table-row');
      expect(headerRows[0].querySelectorAll('th')).toHaveLength(5);
      expect(headerRows[1].querySelectorAll('th')).toHaveLength(5);
      expect(table.querySelector('thead')?.className).toContain('sm:table-header-group');
      expect(table.querySelector('tbody')?.className).toContain('sm:table-row-group');
      for (const cell of table.querySelectorAll('tbody td')) {
        expect(cell.className).toContain('sm:table-cell');
      }
    }

    const activeSecuritySort = securityTable.querySelector(
      'thead tr.sm\\:hidden th[aria-sort="descending"]',
    );
    const activeSellSort = sellsTable.querySelector(
      'thead tr.sm\\:hidden th[aria-sort="descending"]',
    );
    expect(activeSecuritySort).toHaveTextContent('Gain/Loss');
    expect(activeSellSort).toHaveTextContent('Date');
  });
});
