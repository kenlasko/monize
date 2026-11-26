import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { CashFlowSankeyWidget } from './CashFlowSankeyWidget';
import type { CashFlowSankeyNode, CashFlowSankeyResponse } from '@/types/built-in-reports';
import type { CashFlowSankeyConfig } from './widget-config';

vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock());

const mockUpdateConfig = vi.fn();
const configState: { current: CashFlowSankeyConfig } = {
  current: { range: 'mtd', accountIds: [], depth: 1, view: 'sankey' },
};
vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({ config: configState.current, updateConfig: mockUpdateConfig }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return { useNumberFormat: () => ({ ...numberFormatMockDefaults() }) };
});

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockGetSankey = vi.fn();
vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: { getCashFlowSankey: (...a: unknown[]) => mockGetSankey(...a) },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: { getAll: () => Promise.resolve([]) },
}));

// The shared report picker, which orders favourites first
// (ReportAccountMultiSelect.test.tsx); this records what the widget hands it.
const mockPickerAccounts = vi.fn();
vi.mock('@/components/reports/ReportAccountMultiSelect', () => ({
  ReportAccountMultiSelect: ({
    accounts,
    value,
    onChange,
  }: {
    accounts: unknown[];
    value: string[];
    onChange: (ids: string[]) => void;
  }) => (
    <button
      data-testid="scope-picker"
      data-value={value.join(',')}
      data-count={(mockPickerAccounts(accounts), accounts.length)}
      onClick={() => onChange(['acc-savings'])}
    >
      Accounts
    </button>
  ),
}));

function node(id: string, label: string, total: number | null, extra: Partial<CashFlowSankeyNode> = {}): CashFlowSankeyNode {
  return {
    id,
    kind: (id === 'hub' ? 'hub' : id.split(':')[0]) as CashFlowSankeyNode['kind'],
    label,
    categoryId: null,
    parentCategoryId: null,
    accountId: null,
    color: null,
    total,
    knownTotal: total ?? 0,
    ...extra,
  };
}

const RESPONSE: CashFlowSankeyResponse = {
  startDate: '2026-09-01',
  endDate: '2026-09-30',
  currency: 'CAD',
  scopeAccountIds: ['acc-chq', 'acc-sav'],
  nodes: [
    node('income:cat-salary', 'Salary', 5000, { categoryId: 'cat-salary' }),
    node('hub', 'Income', 5000),
    node('expense:cat-groceries', 'Groceries', 600, { categoryId: 'cat-groceries' }),
    node('class:debt', 'Debt payments', 900),
    node('residual:unspent', 'Unspent', 3500),
  ],
  links: [
    { source: 'income:cat-salary', target: 'hub', amount: 5000, knownAmount: 5000 },
    { source: 'hub', target: 'expense:cat-groceries', amount: 600, knownAmount: 600 },
    { source: 'hub', target: 'class:debt', amount: 900, knownAmount: 900 },
    { source: 'hub', target: 'residual:unspent', amount: 3500, knownAmount: 3500 },
  ],
  totals: { income: 5000, inflows: 0, expenses: 600, outflows: 900, unspent: 3500, deficit: 0 },
  knownTotals: { income: 5000, inflows: 0, expenses: 600, outflows: 900 },
  missingCurrencies: [],
  excludedCount: 0,
};

const ACCOUNTS = [
  { id: 'acc-chq', name: 'Chequing', isFavourite: true, favouriteSortOrder: 1 },
  { id: 'acc-sav', name: 'Savings', isFavourite: false, favouriteSortOrder: 0 },
] as never[];

async function renderWidget() {
  await act(async () => {
    render(<CashFlowSankeyWidget accounts={ACCOUNTS} isLoading={false} />);
  });
}

async function openSettings() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Configure Cash Flow Sankey' }));
  });
}

describe('CashFlowSankeyWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSankey.mockResolvedValue(RESPONSE);
    configState.current = { range: 'mtd', accountIds: [], depth: 1, view: 'sankey' };
  });

  it('asks the report endpoint for its configured window, scope and depth', async () => {
    configState.current = { range: 'mtd', accountIds: ['acc-chq'], depth: 2, view: 'sankey' };
    await renderWidget();

    expect(mockGetSankey).toHaveBeenCalledWith(
      expect.objectContaining({ accountIds: ['acc-chq'], depth: 2 }),
    );
    expect(screen.getByText('MTD')).toBeInTheDocument();
  });

  it('draws the report diagram, with the totals in its accessible name and the residual below', async () => {
    await renderWidget();

    expect(screen.getByText('Cash Flow Sankey')).toBeInTheDocument();
    const names = JSON.parse(screen.getByTestId('sankey').getAttribute('data-nodes') ?? '[]');
    expect(names).toEqual(expect.arrayContaining(['Salary', 'Groceries', 'Debt payments', 'Unspent']));
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('Income $5,000');
    expect(screen.getByText('$3,500')).toBeInTheDocument();
  });

  it('lists every node, unmerged, in the table view', async () => {
    configState.current = { range: 'mtd', accountIds: [], depth: 1, view: 'table' };
    await renderWidget();

    const table = screen.getByTestId('cash-flow-sankey-widget-table');
    expect(table.querySelectorAll('li')).toHaveLength(RESPONSE.nodes.length - 1);
    expect(table).toHaveTextContent('Groceries');
    expect(table).toHaveTextContent('$600');
    expect(screen.queryByTestId('sankey')).not.toBeInTheDocument();
  });

  it('marks a partial figure and says how much was left out', async () => {
    configState.current = { range: 'mtd', accountIds: [], depth: 1, view: 'table' };
    mockGetSankey.mockResolvedValue({
      ...RESPONSE,
      nodes: RESPONSE.nodes.map((n) =>
        n.id === 'expense:cat-groceries' ? { ...n, total: null, knownTotal: 550 } : n.id === 'residual:unspent' ? { ...n, total: null, knownTotal: 0 } : n,
      ),
      totals: { ...RESPONSE.totals, expenses: null, unspent: null, deficit: null },
      missingCurrencies: ['USD'],
      excludedCount: 2,
    });
    await renderWidget();

    expect(screen.getByTestId('partial-total-marker')).toBeInTheDocument();
    expect(screen.getByTestId('cash-flow-sankey-widget-incomplete')).toHaveTextContent(
      '2 amounts could not be converted',
    );
  });

  it('notes the estimated amounts the diagram includes', async () => {
    mockGetSankey.mockResolvedValue({ ...RESPONSE, provisionalCount: 2 });
    await renderWidget();
    expect(screen.getByTestId('provisional-data-notice')).toHaveTextContent(
      '2 amounts in these figures are estimates',
    );
  });

  it('notes nothing without a provisional count', async () => {
    await renderWidget();
    expect(screen.queryByTestId('provisional-data-notice')).not.toBeInTheDocument();
  });

  it('shows an empty state when nothing moved', async () => {
    mockGetSankey.mockResolvedValue({ ...RESPONSE, nodes: [], links: [] });
    await renderWidget();
    expect(screen.getByText('No income, spending or transfers in this period.')).toBeInTheDocument();
  });

  it('offers the report settings and saves each to the widget config', async () => {
    await renderWidget();
    await openSettings();

    // An empty scope is the server's default; the picker shows what it was.
    expect(screen.getByTestId('scope-picker')).toHaveAttribute('data-value', 'acc-chq,acc-sav');
    // The dashboard's accounts, favourite flags and all, go to the shared
    // picker, which is what lists the favourites first.
    expect(mockPickerAccounts).toHaveBeenLastCalledWith(ACCOUNTS);
    await act(async () => {
      fireEvent.click(screen.getByTestId('scope-picker'));
    });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ accountIds: ['acc-savings'] });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Subcategories' }));
    });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ depth: 2 });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    });
    expect(mockUpdateConfig).toHaveBeenCalledWith({ view: 'table' });
  });

  it('reads a stale stored setting as the default', async () => {
    configState.current = { range: 'mtd', accountIds: [], depth: 7 as never, view: 'pie' as never };
    await renderWidget();

    expect(mockGetSankey).toHaveBeenCalledWith(expect.objectContaining({ depth: 1 }));
    expect(screen.getByTestId('sankey')).toBeInTheDocument();
  });
});
