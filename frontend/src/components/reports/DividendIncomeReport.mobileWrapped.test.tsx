import { act, fireEvent, render, screen, waitFor } from '@/test/render';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DividendIncomeReport } from './DividendIncomeReport';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (value: number) => `MONEY<${value}>`,
      formatCurrencyAxis: (value: number) => `AXIS<${value}>`,
    }),
  };
});

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convert: (amount: number) => amount,
    convertToDefault: (amount: number) => amount,
    defaultCurrency: 'CAD',
  }),
}));

const STABLE_RESOLVED_RANGE = { start: '2024-01-01', end: '2025-01-01' };
vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: '1y',
    setDateRange: vi.fn(),
    startDate: '',
    setStartDate: vi.fn(),
    endDate: '',
    setEndDate: vi.fn(),
    resolvedRange: STABLE_RESOLVED_RANGE,
    isValid: true,
  }),
}));

vi.mock('@/lib/utils', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock('@/components/ui/ExportDropdown', () => ({
  ExportDropdown: () => <div data-testid="export-dropdown" />,
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
  Legend: () => null,
  ReferenceLine: () => null,
  Cell: () => null,
}));

const mockGetTransactions = vi.fn();
const mockGetInvestmentAccounts = vi.fn();
const mockGetCapitalGains = vi.fn();

// The server's per-row conversion figures, defaulted to a CAD reader of CAD
// rows where a fixture states none (issue #2106).
vi.mock('@/lib/investments', async () => {
  const { withRowFactors, withCapitalGainReporting } = await import('@/test/investment-fx-fixtures');
  return {
    investmentsApi: {
      getTransactions: async (...args: unknown[]) => withRowFactors(await mockGetTransactions(...args)),
      getInvestmentAccounts: (...args: unknown[]) => mockGetInvestmentAccounts(...args),
      getCapitalGains: async (...args: unknown[]) =>
        withCapitalGainReporting(await mockGetCapitalGains(...args)),
    },
  };
});

const LONG_NAME = 'A deliberately long security name that must wrap without a clamp';

const TXNS = [
  {
    id: 'tx-div',
    action: 'DIVIDEND',
    securityId: 'sec-1',
    security: { symbol: 'LONG', name: LONG_NAME },
    accountId: 'acc-1',
    totalAmount: 120,
    amountCurrencyCode: 'CAD',
    transactionDate: '2024-06-15',
  },
  {
    id: 'tx-int',
    action: 'INTEREST',
    securityId: 'sec-1',
    security: { symbol: 'LONG', name: LONG_NAME },
    accountId: 'acc-1',
    totalAmount: 30,
    amountCurrencyCode: 'CAD',
    transactionDate: '2024-07-20',
  },
];

const CAPITAL_GAINS = [
  {
    month: '2024-08',
    accountId: 'acc-1',
    accountName: 'TFSA',
    accountCurrencyCode: 'CAD',
    securityId: 'sec-1',
    symbol: 'LONG',
    securityName: LONG_NAME,
    securityCurrencyCode: 'CAD',
    startQuantity: 10,
    endQuantity: 0,
    startValue: 800,
    endValue: 0,
    buys: 0,
    sells: 800,
    realizedGain: 90,
    unrealizedGain: 0,
    totalCapitalGain: 90,
  },
];

function placement(cell: Element): string {
  const column = [...cell.classList].find((name) => name.startsWith('col-start-'));
  const row = [...cell.classList].find((name) => name.startsWith('row-start-'));
  return `${column}/${row}`;
}

async function renderBySecurityTable() {
  mockGetTransactions.mockResolvedValue({ data: TXNS, pagination: { hasMore: false } });
  mockGetInvestmentAccounts.mockResolvedValue([]);
  mockGetCapitalGains.mockResolvedValue(CAPITAL_GAINS);
  const view = render(<DividendIncomeReport />);
  const bySecurityButton = await screen.findByRole('button', { name: 'By Security' });
  await act(async () => {
    fireEvent.click(bySecurityButton);
  });
  await waitFor(() => expect(view.container.querySelector('table')).toBeTruthy());
  return { ...view, securityTable: view.container.querySelector('table') as HTMLTableElement };
}

describe('DividendIncomeReport mobile wrapped tables', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('wraps the income-by-security row into three explicit phone lines', async () => {
    const { securityTable } = await renderBySecurityTable();

    expect(securityTable).toHaveAttribute('role', 'table');
    expect(securityTable.className).toContain('block');
    expect(securityTable.className).toContain('sm:table');
    expect(securityTable.querySelector('thead')).toHaveAttribute('role', 'rowgroup');
    expect(securityTable.querySelector('tbody')).toHaveAttribute('role', 'rowgroup');

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

    // The identity cell names itself (no caption); every figure carries one,
    // reusing the column's existing header key.
    expect(cells[0].querySelector('span')).toBeNull();
    expect(cells.slice(1).map((cell) => cell.querySelector('span')?.textContent)).toEqual([
      'Dividends',
      'Interest',
      'Capital Gains',
      'Total',
    ]);

    // Identity wraps unclamped; nothing is truncated.
    expect(cells[0].textContent).toContain('A deliberately long security name');
    expect(cells[0].querySelector('.break-words')).toBeInTheDocument();

    // Every figure is on the preference-aware formatter.
    expect(cells[1]).toHaveTextContent('MONEY<120>');
    expect(cells[2]).toHaveTextContent('MONEY<30>');
    expect(cells[3]).toHaveTextContent('MONEY<90>');
    expect(cells[4]).toHaveTextContent('MONEY<240>');
  });

  it('keeps every sort control in accessible phone strips and restores the desktop table', async () => {
    const { securityTable } = await renderBySecurityTable();

    const headerRows = securityTable.querySelectorAll('thead tr');
    expect(headerRows).toHaveLength(2);
    expect(headerRows[0].className).toContain('sm:hidden');
    expect(headerRows[1].className).toContain('hidden');
    expect(headerRows[1].className).toContain('sm:table-row');
    expect(headerRows[0].querySelectorAll('th')).toHaveLength(5);
    expect(headerRows[1].querySelectorAll('th')).toHaveLength(5);
    expect(securityTable.querySelector('thead')?.className).toContain('sm:table-header-group');
    expect(securityTable.querySelector('tbody')?.className).toContain('sm:table-row-group');
    for (const cell of securityTable.querySelectorAll('tbody td')) {
      expect(cell.className).toContain('sm:table-cell');
    }

    // The persisted default sort (total, descending) is reflected in the phone
    // strip so a dropped chip would strand it.
    const activeSort = securityTable.querySelector(
      'thead tr.sm\\:hidden th[aria-sort="descending"]',
    );
    expect(activeSort).toHaveTextContent('Total');
  });
});
