import { act, fireEvent, render, waitFor } from '@/test/render';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvestmentPerformanceReport } from './InvestmentPerformanceReport';

const mockGetPortfolioSummary = vi.fn();
const mockGetInvestmentAccounts = vi.fn();

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (value: number, currency = 'CAD') => `${currency}<${value}>`,
      formatPercent: (value: number) => `PLAIN<${value}>`,
      formatShareQuantity: (value: number) => `SHARES<${value}>`,
      formatSignedPercent: (value: number) => `SIGNED<${value}>`,
    }),
  };
});

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({ defaultCurrency: 'CAD' }),
}));

vi.mock('@/hooks/usePersistedAccountFilter', () => {
  const filterState = [[], vi.fn(), vi.fn()] as const;
  return { usePersistedAccountFilter: () => filterState };
});

vi.mock('@/hooks/useMainAccountName', () => ({
  useMainAccountName: () => (name: string) => name,
}));

vi.mock('@/components/reports/ReportAccountMultiSelect', () => ({
  ReportAccountMultiSelect: () => <div data-testid="account-filter" />,
}));

vi.mock('@/components/reports/RefreshPricesButton', () => ({
  RefreshPricesButton: () => <button type="button">Refresh</button>,
}));

vi.mock('@/components/ui/ExportDropdown', () => ({
  ExportDropdown: () => <div data-testid="export-dropdown" />,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PieChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pie: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Cell: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...args: unknown[]) => mockGetPortfolioSummary(...args),
    getInvestmentAccounts: (...args: unknown[]) => mockGetInvestmentAccounts(...args),
  },
}));

// The window's figures: one row for the held security, nothing withheld.
vi.mock('@/lib/net-worth', () => ({
  netWorthApi: {
    getInvestmentsPeriodResult: vi.fn(async () => ({
      currency: 'CAD',
      startDate: '2025-11-04',
      startPriceDate: '2025-11-04',
      endDate: '2026-11-04',
      investmentPnl: 50,
      investmentReturnPercent: 5,
      investedReasons: [],
    })),
    getInvestmentsSecurityPeriodResults: vi.fn(async () => ({
      currency: 'CAD',
      startDate: '2025-11-04',
      endDate: '2026-11-04',
      reasons: [],
      unattributedPnl: 0,
      securities: [
        {
          securityId: 'security-1',
          symbol: 'LONG',
          name: 'A deliberately long holding name that wraps without a clamp',
          securityCurrency: 'CAD',
          startQuantity: 14.3456789,
          endQuantity: 14.3456789,
          startClose: 95,
          endClose: 100,
          priceChangePercent: 5.26,
          priceChangeReason: null,
          investmentPnl: 50,
          investmentReturnPercent: 5,
          investedReasons: [],
        },
      ],
    })),
  },
}));

// The Performance view's historical chart owns its own fetch and recharts tree;
// stub it so this suite stays about the wrapped holdings table.
vi.mock('@/components/reports/SecurityComparisonChart', () => ({
  SecurityComparisonChart: () => <div data-testid="performance-chart" />,
}));

const PORTFOLIO = {
  holdings: [
    {
      id: 'holding-1',
      securityId: 'security-1',
      accountId: 'account-1',
      symbol: 'LONG',
      name: 'A deliberately long holding name that wraps without a clamp',
      quantity: 12.3456789,
      averageCost: 80,
      currentPrice: 100,
      marketValue: 1234.56,
      costBasis: 987.65,
      costBasisAccountCurrency: 987.65,
      gainLoss: 246.91,
      gainLossPercent: 25,
      currencyCode: 'CAD',
    },
    {
      id: 'holding-2',
      securityId: 'security-1',
      accountId: 'account-2',
      symbol: 'LONG',
      name: 'A deliberately long holding name that wraps without a clamp',
      quantity: 2,
      averageCost: 90,
      currentPrice: 100,
      marketValue: 200,
      costBasis: 180,
      costBasisAccountCurrency: 180,
      gainLoss: 20,
      gainLossPercent: 11.11,
      currencyCode: 'CAD',
    },
  ],
  holdingsByAccount: [],
  allocation: [],
  totalPortfolioValue: 1434.56,
  totalCostBasis: 1167.65,
  totalGainLoss: 266.91,
  totalGainLossPercent: 22.86,
};

const EXPECTED_PLACEMENT = [
  'col-start-1/row-start-1',
  'col-start-1/row-start-2',
  'col-start-2/row-start-2',
  'col-start-1/row-start-3',
  'col-start-2/row-start-1',
  'col-start-2/row-start-3',
  'col-start-1/row-start-4',
  'col-start-2/row-start-4',
];

function placement(cell: Element): string {
  const column = [...cell.classList].find((name) => name.startsWith('col-start-'));
  const row = [...cell.classList].find((name) => name.startsWith('row-start-'));
  return `${column}/${row}`;
}

async function renderReport() {
  mockGetPortfolioSummary.mockResolvedValue(PORTFOLIO);
  mockGetInvestmentAccounts.mockResolvedValue([
    { id: 'account-1', name: 'First account', currencyCode: 'CAD' },
    { id: 'account-2', name: 'Second account', currencyCode: 'CAD' },
  ]);
  const view = render(<InvestmentPerformanceReport />);
  const table = await waitFor(() => {
    const result = view.container.querySelector('table');
    expect(result).toBeInTheDocument();
    return result!;
  });
  return { ...view, table };
}

describe('InvestmentPerformanceReport mobile wrapped table', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('wraps every aggregated holding into four explicit phone lines', async () => {
    const { table } = await renderReport();

    expect(table).toHaveAttribute('role', 'table');
    expect(table.className).toContain('block');
    expect(table.className).toContain('sm:table');
    expect(table.querySelector('thead')).toHaveAttribute('role', 'rowgroup');
    expect(table.querySelector('tbody')).toHaveAttribute('role', 'rowgroup');
    expect(table.querySelector('thead')?.className).toContain('sm:table-header-group');
    expect(table.querySelector('tbody')?.className).toContain('sm:table-row-group');

    const row = table.querySelector('tbody tr');
    expect(row).toHaveAttribute('role', 'row');
    expect(row?.className).toContain('grid-cols-2');
    expect(row?.className).toContain('sm:table-row');
    const cells = Array.from(row?.querySelectorAll('td') ?? []);
    expect(cells.map(placement)).toEqual(EXPECTED_PLACEMENT);
    expect(cells.every((cell) => cell.getAttribute('role') === 'cell')).toBe(true);
    expect(cells[0].querySelector('span.sm\\:hidden')).toBeNull();
    expect(cells.slice(1).map((cell) => cell.querySelector('span')?.textContent)).toEqual([
      'Shares',
      'Avg Cost',
      'Current Price',
      'Market Value',
      'Gain/Loss',
      'Return',
      '% Change',
    ]);
    expect(cells[0].querySelector('.break-words')).toHaveTextContent(
      'A deliberately long holding name that wraps without a clamp',
    );
    expect(cells[1]).toHaveTextContent('SHARES<14.3456789>');
    for (const cell of cells) expect(cell.className).toContain('sm:table-cell');
  });

  it.each(['Enter', ' '])('expands a holding with %s and wraps each account row', async (key) => {
    const { table } = await renderReport();
    const holdingRow = table.querySelector('tbody tr')!;
    expect(holdingRow).toHaveAttribute('tabindex', '0');
    expect(holdingRow).toHaveAttribute('aria-expanded', 'false');
    expect(holdingRow.className).toContain('focus-visible:outline-2');
    expect(holdingRow.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    await act(async () => {
      fireEvent.keyDown(holdingRow, { key });
    });

    expect(table.querySelector('tbody tr')).toHaveAttribute('aria-expanded', 'true');
    const rows = table.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(3);
    const childCells = Array.from(rows[1].querySelectorAll('td'));
    expect(rows[1]).toHaveAttribute('role', 'row');
    expect(rows[1].className).toContain('grid-cols-2');
    expect(rows[1].className).toContain('sm:table-row');
    expect(childCells.map(placement)).toEqual(EXPECTED_PLACEMENT);
    expect(childCells.every((cell) => cell.getAttribute('role') === 'cell')).toBe(true);
    expect(childCells.map((cell) => cell.querySelector('span')?.textContent ?? null)).toEqual([
      null,
      'Shares',
      'Avg Cost',
      'Current Price',
      'Market Value',
      // The period is measured per security: an account row has no figure
      // for it, rather than an all-time one under a period caption.
      null,
      null,
      null,
    ]);
    expect(childCells[0]).toHaveTextContent('First account');
    expect(childCells[1]).toHaveTextContent('SHARES<12.3456789>');
  });

  it('keeps all eight accessible sort controls on phone and desktop', async () => {
    const { table } = await renderReport();
    const headerRows = table.querySelectorAll('thead tr');
    expect(headerRows).toHaveLength(2);
    expect(headerRows[0].className).toContain('sm:hidden');
    expect(headerRows[1].className).toContain('hidden');
    expect(headerRows[1].className).toContain('sm:table-row');
    expect(headerRows[0].querySelectorAll('th')).toHaveLength(8);
    expect(headerRows[1].querySelectorAll('th')).toHaveLength(8);
    const activePhoneSort = headerRows[0].querySelector('th[aria-sort="descending"]');
    expect(activePhoneSort).toHaveTextContent('Market Value');

    const names = Array.from(headerRows[0].querySelectorAll('th')).map((header) =>
      header.textContent?.replace(/[↕↑↓]/g, '').trim(),
    );
    expect(names).toEqual([
      'Security',
      'Shares',
      'Avg Cost',
      'Current Price',
      'Market Value',
      'Gain/Loss',
      'Return',
      '% Change',
    ]);
  });
});
