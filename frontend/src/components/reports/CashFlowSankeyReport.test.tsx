import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@/test/render';
import { CashFlowSankeyReport, SANKEY_STORAGE_KEYS } from './CashFlowSankeyReport';
import { SankeyNodeShape, sankeyNodeHref, sankeyTooltipItem } from './CashFlowSankeyDiagram';
import type {
  CashFlowSankeyNode,
  CashFlowSankeyResponse,
} from '@/types/built-in-reports';
import type { SankeyDrawNode } from './sankey-layout';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return { useNumberFormat: () => ({ ...numberFormatMockDefaults() }) };
});

const mockDateRangeOptions = vi.fn();
vi.mock('@/hooks/useDateRange', () => {
  const resolvedRange = { start: '2026-09-01', end: '2026-09-30' };
  return {
    useDateRange: (options: unknown) => (mockDateRangeOptions(options), {
      dateRange: 'mtd',
      setDateRange: vi.fn(),
      startDate: '',
      setStartDate: vi.fn(),
      endDate: '',
      setEndDate: vi.fn(),
      resolvedRange,
      isValid: true,
    }),
  };
});

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => `date(${d})` }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({ defaultCurrency: 'CAD' }),
}));

let mockIsMobile = false;
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile,
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: ({ fillRowHeight }: { fillRowHeight?: boolean }) => (
    <div data-testid="date-range-selector" data-fill-row-height={String(fillRowHeight === true)} />
  ),
}));

vi.mock('@/components/reports/ReportAccountMultiSelect', () => ({
  ReportAccountMultiSelect: ({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) => (
    <div data-testid="scope-value" data-value={value.join(',')}>
      <button data-testid="scope-picker" onClick={() => onChange(['acc-savings'])}>
        Accounts
      </button>
      <button data-testid="scope-clear" onClick={() => onChange([])}>
        Clear
      </button>
    </div>
  ),
}));

vi.mock('@/components/ui/ExportDropdown', () => ({
  ExportDropdown: ({
    onExportPdf,
    onExportCsv,
    disabled,
  }: {
    onExportPdf?: () => void;
    onExportCsv?: () => void;
    disabled?: boolean;
  }) => (
    <div data-testid="export-dropdown">
      <button data-testid="export-pdf" onClick={onExportPdf} disabled={disabled}>PDF</button>
      <button data-testid="export-csv" onClick={onExportCsv} disabled={disabled}>CSV</button>
    </div>
  ),
}));

// The Sankey stub serializes what it was handed; the tooltip renderer is run
// over one node and one link so its formatting is read through the hook.
vi.mock('recharts', async () => {
  const { rechartsMock } = await import('@/test/recharts-mock');
  const base = rechartsMock();
  const { createContext, useContext } = await import('react');
  const FirstNode = createContext<unknown>(null);
  function NodeTooltip({ content }: { content: (props: unknown) => React.ReactNode }) {
    const payload = useContext(FirstNode);
    return content(asRecharts({ active: true, payload: [{ payload }] }));
  }
  // The entry shape recharts 3 builds for a Sankey (combineTooltipPayload over
  // sankeyPayloadSearcher): the hovered item's data is one level deeper than
  // in the other charts, under `payload.payload`.
  const asRecharts = (props: { active: boolean; payload: Array<{ payload: unknown }> }) => ({
    ...props,
    payload: props.payload.map((entry) => ({
      name: 'entry',
      value: 0,
      payload: { payload: entry.payload, name: 'entry', value: 0 },
    })),
  });
  return {
    ...base,
    // The base stub, plus the margin the diagram was laid out with.
    Sankey: ({ margin, ...props }: { margin?: object } & Parameters<typeof base.Sankey>[0]) => (
      <div data-testid="sankey-margin" data-margin={JSON.stringify(margin ?? null)}>
        <FirstNode.Provider value={props.data?.nodes[0]}>{base.Sankey(props)}</FirstNode.Provider>
      </div>
    ),
    Tooltip: ({ content }: { content?: (props: unknown) => React.ReactNode }) =>
      typeof content === 'function' ? (
        <div data-testid="tooltip">
          <NodeTooltip content={content} />
          {content(asRecharts({
            active: true,
            payload: [
              {
                payload: {
                  name: 'Other',
                  id: 'other:destination',
                  kind: 'other',
                  column: 'destination',
                  color: null,
                  node: null,
                  members: ['Dining', 'Gifts'],
                  value: 12.5,
                  unknown: true,
                },
              },
            ],
          }))}
          {content(asRecharts({
            active: true,
            payload: [
              {
                payload: {
                  source: { name: 'Salary', kind: 'income', node: null },
                  target: { name: 'Income', kind: 'hub', node: null },
                  value: 5000,
                  incomplete: false,
                },
              },
            ],
          }))}
          {content(asRecharts({
            active: true,
            payload: [
              {
                payload: {
                  source: { name: 'Income', kind: 'hub', node: null },
                  target: { name: 'Unspent', kind: 'residual', node: null },
                  value: 0.2,
                  incomplete: true,
                  placeholder: true,
                },
              },
            ],
          }))}
          {content(asRecharts({ active: false, payload: [] }))}
        </div>
      ) : null,
  };
});

const mockGetSankey = vi.fn();
vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getCashFlowSankey: (...args: unknown[]) => mockGetSankey(...args),
  },
}));

vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: () => Promise.resolve([]) },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: () =>
      Promise.resolve([
        { id: 'cat-groceries', color: null, effectiveColor: '#00aa00' },
      ]),
  },
}));

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

const mockExportCsvSections = vi.fn();
vi.mock('@/lib/csv-export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/csv-export')>()),
  exportCsvSections: (...args: unknown[]) => mockExportCsvSections(...args),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

function node(
  id: string,
  label: string,
  total: number | null,
  overrides: Partial<CashFlowSankeyNode> = {},
): CashFlowSankeyNode {
  const kind = (id === 'hub' ? 'hub' : id.split(':')[0]) as CashFlowSankeyNode['kind'];
  return {
    id,
    kind,
    label,
    categoryId: null,
    parentCategoryId: null,
    accountId: null,
    color: null,
    total,
    knownTotal: total ?? 0,
    ...overrides,
  };
}

/** The design's numerical example (section 8), complete. */
function example(): CashFlowSankeyResponse {
  const nodes = [
    node('income:cat-salary', 'Salary', 5000, { categoryId: 'cat-salary' }),
    node('hub', 'Income', 5000),
    node('expense:cat-interest', 'Interest', 700, { categoryId: 'cat-interest' }),
    node('expense:cat-groceries', 'Groceries', 600, { categoryId: 'cat-groceries' }),
    node('expense:cat-dining', 'Dining', 67.5, { categoryId: 'cat-dining' }),
    node('uncategorized:expense', 'Uncategorized expenses', 45),
    node('class:savings', 'Savings & investments', 1000),
    node('class:debt', 'Debt payments', 900),
    node('residual:unspent', 'Unspent', 1687.5),
  ];
  return {
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    currency: 'CAD',
    scopeAccountIds: ['acc-chq', 'acc-usd'],
    nodes,
    links: nodes
      .filter((n) => n.kind !== 'hub')
      .map((n) =>
        n.kind === 'income'
          ? { source: n.id, target: 'hub', amount: n.total, knownAmount: n.knownTotal }
          : { source: 'hub', target: n.id, amount: n.total, knownAmount: n.knownTotal },
      ),
    totals: { income: 5000, inflows: 0, expenses: 1412.5, outflows: 1900, unspent: 1687.5, deficit: 0 },
    knownTotals: { income: 5000, inflows: 0, expenses: 1412.5, outflows: 1900 },
    missingCurrencies: [],
    excludedCount: 0,
  };
}

/** The same example with no USD->CAD rate: Dining, expenses and the residual unknown. */
function withoutRate(): CashFlowSankeyResponse {
  const complete = example();
  const unknown = new Set(['expense:cat-dining', 'residual:unspent', 'hub']);
  return {
    ...complete,
    nodes: complete.nodes.map((n) => (unknown.has(n.id) ? { ...n, total: null, knownTotal: 0 } : n)),
    links: complete.links.map((l) =>
      l.target !== 'hub' && unknown.has(l.target) ? { ...l, amount: null, knownAmount: 0 } : l,
    ),
    totals: { ...complete.totals, expenses: null, unspent: null, deficit: null },
    knownTotals: { ...complete.knownTotals, expenses: 1345 },
    missingCurrencies: ['USD'],
    excludedCount: 1,
  };
}

async function renderReport(response: CashFlowSankeyResponse = example()) {
  mockGetSankey.mockResolvedValue(response);
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<CashFlowSankeyReport />));
  });
  return container;
}

const sankeyMargin = () =>
  JSON.parse(screen.getByTestId('sankey-margin').getAttribute('data-margin') ?? 'null') as Record<string, number> | null;

const sankeyNodes = () => JSON.parse(screen.getByTestId('sankey').getAttribute('data-nodes') ?? '[]') as string[];

describe('CashFlowSankeyReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMobile = false;
    window.localStorage.clear();
  });

  it('shows a skeleton while the first answer is on its way', async () => {
    mockGetSankey.mockReturnValue(new Promise(() => {}));
    await act(async () => {
      render(<CashFlowSankeyReport />);
    });
    expect(screen.queryByTestId('sankey')).not.toBeInTheDocument();
    expect(screen.queryByText('No income, spending or transfers in this period')).not.toBeInTheDocument();
  });

  it('asks for the current month at depth 1 over the default scope', async () => {
    await renderReport();
    expect(mockGetSankey).toHaveBeenCalledWith({
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      accountIds: [],
      depth: 1,
    });
  });

  it('draws the diagram with the server labels and its totals in the accessible name', async () => {
    await renderReport();

    expect(sankeyNodes()).toEqual(
      expect.arrayContaining(['Salary', 'Income', 'Groceries', 'Savings & investments', 'Debt payments', 'Unspent']),
    );
    const img = screen.getByRole('img');
    expect(img.getAttribute('aria-label')).toBe(
      'Cash flow diagram. Income $5,000.00, transfers in $0.00, expenses $1,412.50, transfers out $1,900.00, Unspent $1,687.50.',
    );
  });

  it('prints the summary cards from the response totals, not from the drawing', async () => {
    await renderReport();

    expect(screen.getByTestId('sankey-card-income')).toHaveTextContent('$5,000.00');
    expect(screen.getByTestId('sankey-card-expenses')).toHaveTextContent('$1,412.50');
    expect(screen.getByTestId('sankey-card-outflows')).toHaveTextContent('$1,900.00');
    expect(screen.getByTestId('sankey-card-residual')).toHaveTextContent('Unspent');
    expect(screen.getByTestId('sankey-card-residual')).toHaveTextContent('$1,687.50');
  });

  it('captions a deficit as drawn from balances', async () => {
    const response = example();
    await renderReport({
      ...response,
      totals: { ...response.totals, unspent: 0, deficit: 600 },
    });
    expect(screen.getByTestId('sankey-card-residual')).toHaveTextContent('Drawn from balances');
    expect(screen.getByTestId('sankey-card-residual')).toHaveTextContent('$600.00');
  });

  it('shows an empty state with the range when nothing moved', async () => {
    await renderReport({ ...example(), nodes: [], links: [] });

    expect(screen.getByText('No income, spending or transfers in this period')).toBeInTheDocument();
    expect(screen.getByText('date(2026-09-01) to date(2026-09-30)')).toBeInTheDocument();
    expect(screen.queryByTestId('sankey')).not.toBeInTheDocument();
  });

  it('defaults a phone to the table, and lets the reader switch', async () => {
    mockIsMobile = true;
    await renderReport();

    expect(screen.queryByTestId('sankey')).not.toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTitle('Flow Diagram'));
    });
    expect(screen.getByTestId('sankey')).toBeInTheDocument();
  });

  it('gives the labels wide gutters on a desktop', async () => {
    await renderReport();
    expect(sankeyMargin()).toMatchObject({ left: 160, right: 160 });
  });

  it('narrows the label gutters on a phone so the diagram keeps room to draw', async () => {
    mockIsMobile = true;
    await renderReport();
    await act(async () => {
      fireEvent.click(screen.getByTitle('Flow Diagram'));
    });
    expect(sankeyMargin()).toMatchObject({ left: 96, right: 96 });
  });

  it('lists every node in the table, merged or not (SANKEY-005)', async () => {
    const response = example();
    const extra = Array.from({ length: 12 }, (_, i) =>
      node(`expense:cat-x${i}`, `Extra ${i}`, 1, { categoryId: `cat-x${i}` }),
    );
    await renderReport({
      ...response,
      nodes: [...response.nodes, ...extra],
      links: [...response.links, ...extra.map((n) => ({ source: 'hub', target: n.id, amount: 1, knownAmount: 1 }))],
    });

    // The drawing merged the smallest categories into Other...
    // (ten categories keep their own node: the three real ones and seven extras).
    expect(sankeyNodes()).toContain('Other');
    expect(sankeyNodes().filter((name) => name.startsWith('Extra'))).toHaveLength(7);

    await act(async () => {
      fireEvent.click(screen.getByTitle('Table'));
    });
    // ...the table did not.
    for (let i = 0; i < 12; i += 1) {
      expect(screen.getByText(`Extra ${i}`)).toBeInTheDocument();
    }
    expect(screen.getAllByRole('row').length).toBe(response.nodes.length - 1 + 12 + 1);
  });

  it('drills from a category row into Transactions filtered to it, the scope and the range', async () => {
    mockIsMobile = true;
    await renderReport();

    await act(async () => {
      fireEvent.click(screen.getByTestId('sankey-row-expense:cat-groceries'));
    });

    expect(mockPush).toHaveBeenCalledWith(
      '/transactions?categoryId=cat-groceries&accountIds=acc-chq%2Cacc-usd&startDate=2026-09-01&endDate=2026-09-30',
    );
  });

  it('drills from the legend, and offers no link for the residual', async () => {
    await renderReport();

    await act(async () => {
      fireEvent.click(screen.getByText('Debt payments'));
    });
    expect(mockPush).toHaveBeenCalledWith(
      '/transactions?categoryId=transfer&accountIds=acc-chq%2Cacc-usd&startDate=2026-09-01&endDate=2026-09-30',
    );

    const unspent = screen.getByText('Unspent', { selector: 'button *, button' });
    expect(unspent.closest('button')).toBeDisabled();
  });

  it('asks for subcategories when the depth toggles', async () => {
    await renderReport();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Subcategories' }));
    });

    await waitFor(() =>
      expect(mockGetSankey).toHaveBeenLastCalledWith(expect.objectContaining({ depth: 2 })),
    );
    expect(screen.getByRole('button', { name: 'Subcategories' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the default scope the server resolved, not an empty "all accounts"', async () => {
    await renderReport();

    // The request asked for the default; the picker shows what that was.
    expect(mockGetSankey).toHaveBeenCalledWith(expect.objectContaining({ accountIds: [] }));
    expect(screen.getByTestId('scope-value')).toHaveAttribute('data-value', 'acc-chq,acc-usd');
  });

  it('goes back to the default scope when every account is cleared', async () => {
    await renderReport();
    await act(async () => {
      fireEvent.click(screen.getByTestId('scope-picker'));
    });
    await waitFor(() => expect(screen.getByTestId('scope-value')).toHaveAttribute('data-value', 'acc-savings'));

    await act(async () => {
      fireEvent.click(screen.getByTestId('scope-clear'));
    });

    await waitFor(() =>
      expect(mockGetSankey).toHaveBeenLastCalledWith(expect.objectContaining({ accountIds: [] })),
    );
    expect(screen.getByTestId('scope-value')).toHaveAttribute('data-value', 'acc-chq,acc-usd');
  });

  it('prints table amounts at full precision, matching the cards', async () => {
    mockIsMobile = true;
    await renderReport();

    expect(screen.getByTestId('sankey-row-residual:unspent')).toHaveTextContent('$1,687.50');
    expect(screen.getByTestId('sankey-row-expense:cat-dining')).toHaveTextContent('$67.50');
  });

  it('asks for the scope the reader picks', async () => {
    await renderReport();

    await act(async () => {
      fireEvent.click(screen.getByTestId('scope-picker'));
    });

    await waitFor(() =>
      expect(mockGetSankey).toHaveBeenLastCalledWith(expect.objectContaining({ accountIds: ['acc-savings'] })),
    );
  });

  it('marks partial totals and names the missing pair and the count (SANKEY-004)', async () => {
    await renderReport(withoutRate());

    const expenses = screen.getByTestId('sankey-card-expenses');
    expect(expenses).toHaveTextContent('$1,345.00');
    expect(within(expenses).getByTestId('partial-total-marker')).toBeInTheDocument();
    expect(screen.getByTestId('sankey-card-income')).toHaveTextContent('$5,000.00');
    expect(within(screen.getByTestId('sankey-card-income')).queryByTestId('partial-total-marker')).not.toBeInTheDocument();
    expect(screen.getByTestId('sankey-card-residual')).toHaveTextContent('Unknown');

    const banner = screen.getByTestId('incomplete-data-details');
    expect(banner).toHaveTextContent('USD->CAD');
    expect(screen.getByTestId('sankey-excluded-count')).toHaveTextContent(
      '1 amount could not be converted and is left out of the figures above.',
    );
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('expenses Unknown');
  });

  it('notes the estimated amounts the transfer flows include, and the figures stay', async () => {
    await renderReport({ ...example(), provisionalCount: 1 });

    expect(screen.getByTestId('provisional-data-notice')).toHaveTextContent(
      '1 amount in these figures is an estimate',
    );
    expect(screen.getByTestId('sankey-card-income')).toHaveTextContent('$5,000.00');
  });

  it('notes nothing at a provisional count of 0 or without one', async () => {
    await renderReport({ ...example(), provisionalCount: 0 });
    expect(screen.queryByTestId('provisional-data-notice')).not.toBeInTheDocument();
  });

  it('shows the partial and the provisional notes together', async () => {
    await renderReport({ ...withoutRate(), provisionalCount: 1 });
    expect(screen.getByTestId('incomplete-data-details')).toBeInTheDocument();
    expect(screen.getByTestId('provisional-data-notice')).toBeInTheDocument();
  });

  it('formats the tooltip through the number hook and lists what Other holds', async () => {
    await renderReport();

    const tooltip = screen.getByTestId('tooltip');
    expect(tooltip).toHaveTextContent('Amount: $12.50');
    expect(tooltip).toHaveTextContent('Dining');
    expect(tooltip).toHaveTextContent('Gifts');
    expect(tooltip).toHaveTextContent('Only the part that could be converted is drawn.');
    expect(tooltip).toHaveTextContent('Salary to Income');
    expect(tooltip).toHaveTextContent('Amount: $5,000.00');
    // A link nothing of which converted is drawn as a sliver, never priced.
    expect(tooltip).toHaveTextContent('Income to Unspent');
    expect(tooltip).toHaveTextContent('Amount: Unknown');
    expect(tooltip).not.toHaveTextContent('$0.20');
  });

  it('exports the PDF through the shared helper, with the cards and the full table', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    await renderReport();

    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });

    expect(exportToPdf).toHaveBeenCalledTimes(1);
    const options = vi.mocked(exportToPdf).mock.calls[0][0];
    expect(options.title).toBe('Cash Flow Sankey');
    expect(options.subtitle).toBe('date(2026-09-01) to date(2026-09-30)');
    expect(options.filename).toBe('cash-flow-sankey');
    expect(options.chartContainer).toBeInstanceOf(HTMLElement);
    expect(options.summaryCards?.map((card) => [card.label, card.value])).toEqual([
      ['Income', '$5,000.00'],
      ['Transfers in', '$0.00'],
      ['Expenses', '$1,412.50'],
      ['Transfers out', '$1,900.00'],
      ['Unspent', '$1,687.50'],
    ]);
    // Every node but the hub, from the response rather than the drawing.
    expect(options.tableData?.rows).toHaveLength(example().nodes.length - 1);
    expect(options.tableData?.rows[0]).toEqual(['Salary', 'Money in', '$5,000.00']);
  });

  it.each([50, 0])('shows an expense refund netting to %i in the table and exports', async (net) => {
    const id = net ? 'income:groceries' : 'expense:groceries';
    const label = net ? 'Groceries (expense refund)' : 'Groceries';
    const direction = net ? 'Money in' : 'Money out';
    const response: CashFlowSankeyResponse = {
      ...example(),
      nodes: [
        node(id, 'Groceries', net, { categoryId: 'groceries', expenseRefund: net > 0 }),
        node('hub', 'Income', net),
        ...(net ? [node('residual:unspent', 'Unspent', net)] : []),
      ],
      links: net ? [
        { source: id, target: 'hub', amount: net, knownAmount: net },
        { source: 'hub', target: 'residual:unspent', amount: net, knownAmount: net },
      ] : [],
      totals: { income: net, inflows: 0, expenses: 0, outflows: 0, unspent: net, deficit: 0 },
      knownTotals: { income: net, inflows: 0, expenses: 0, outflows: 0 },
    };
    await renderReport(response);
    if (net) {
      expect(screen.getByTestId('tooltip')).toHaveTextContent(label);
      expect(screen.getByTestId('tooltip')).toHaveTextContent('Amount: $50.00');
    } else {
      expect(screen.queryByTestId('sankey')?.dataset.nodes ?? '[]').not.toContain('Groceries');
    }
    fireEvent.click(screen.getByTitle('Table'));
    const row = screen.getByTestId(`sankey-row-${id}`);
    expect(row).toHaveTextContent(label);
    expect(row).toHaveTextContent(`$${net}.00`);
    fireEvent.click(screen.getByTestId('export-csv'));
    expect(mockExportCsvSections.mock.calls[0][1][0].rows).toContainEqual([label, direction, net, net]);
    const { exportToPdf } = await import('@/lib/pdf-export');
    await act(async () => { fireEvent.click(screen.getByTestId('export-pdf')); });
    expect(vi.mocked(exportToPdf).mock.calls[0][0].tableData?.rows)
      .toContainEqual([label, direction, `$${net}.00`]);
  });

  it('marks a partial figure in the PDF cards rather than printing it as a total', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    await renderReport(withoutRate());

    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });

    const cards = vi.mocked(exportToPdf).mock.calls[0][0].summaryCards ?? [];
    expect(cards.find((card) => card.label === 'Expenses')?.value).toBe('$1,345.00*');
    expect(cards.find((card) => card.label === 'Unspent')?.value).toBe('Unknown');
  });

  it('exports the CSV as two sections, the flows and the links, unknowns left blank', async () => {
    await renderReport(withoutRate());

    await act(async () => {
      fireEvent.click(screen.getByTestId('export-csv'));
    });

    expect(mockExportCsvSections).toHaveBeenCalledTimes(1);
    const [filename, sections] = mockExportCsvSections.mock.calls[0] as [
      string,
      Array<{ title: string; headers: string[]; rows: unknown[][] }>,
    ];
    expect(filename).toBe('cash-flow-sankey');
    expect(sections.map((section) => section.title)).toEqual(['Flows', 'Links']);
    expect(sections[0].headers).toEqual(['Flow', 'Direction', 'Amount', 'Converted amount']);
    expect(sections[0].rows).toContainEqual(['Groceries', 'Money out', 600, 600]);
    expect(sections[0].rows).toContainEqual(['Dining', 'Money out', null, 0]);
    expect(sections[1].headers).toEqual(['From', 'To', 'Amount', 'Converted amount']);
    expect(sections[1].rows).toContainEqual(['Salary', 'Income', 5000, 5000]);
    expect(sections[1].rows).toContainEqual(['Income', 'Dining', null, 0]);
  });

  it('offers no export for an empty period', async () => {
    await renderReport({ ...example(), nodes: [], links: [] });
    expect(screen.getByTestId('export-pdf').closest('button')).toBeDisabled();
  });

  it('gives every toolbar control the row height the account picker sets', async () => {
    await renderReport();

    const presets = screen.getByTestId('date-range-selector');
    expect(presets).toHaveAttribute('data-fill-row-height', 'true');
    const row = presets.parentElement!;
    expect(row.className).toContain('items-stretch');
    // Nothing in the row opts out of the stretch.
    expect(row.querySelectorAll('.self-center')).toHaveLength(0);
    expect(screen.getByRole('group', { name: 'Detail' }).className).not.toContain('self-center');
  });

  it('prints the help text about the default scope and card payments', async () => {
    await renderReport();
    expect(screen.getByText(/Leave a savings account out of the account filter/)).toBeInTheDocument();
    expect(screen.getByText(/A credit card payment is never a debt payment/)).toBeInTheDocument();
  });

  it('says beside the nodes, in both views, that a category can read a cent off Spending by Category or Income by Source (issue #2410)', async () => {
    await renderReport();
    const note = /can therefore differ by one cent, or the smallest unit of your currency, from the same category in Spending by Category or Income by Source/;
    expect(screen.getByTestId('sankey-rounding-note')).toHaveTextContent(note);

    await act(async () => {
      fireEvent.click(screen.getByTitle('Table'));
    });
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByTestId('sankey-rounding-note')).toHaveTextContent(note);
  });

  it('says nothing about rounding over an empty period', async () => {
    await renderReport({ ...example(), nodes: [], links: [] });
    expect(screen.queryByTestId('sankey-rounding-note')).not.toBeInTheDocument();
  });
});

describe('the report remembers how it was left', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMobile = false;
    window.localStorage.clear();
  });

  it('keeps the depth, the view and the scope for the next visit', async () => {
    await renderReport();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Subcategories' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle('Table'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('scope-picker'));
    });

    expect(JSON.parse(window.localStorage.getItem(SANKEY_STORAGE_KEYS.depth)!)).toBe(2);
    expect(JSON.parse(window.localStorage.getItem(SANKEY_STORAGE_KEYS.view)!)).toBe('table');
    expect(JSON.parse(window.localStorage.getItem(SANKEY_STORAGE_KEYS.accounts)!)).toEqual(['acc-savings']);
    // The range persists through useDateRange's own storage.
    expect(mockDateRangeOptions).toHaveBeenCalledWith({
      defaultRange: 'mtd',
      storageKey: SANKEY_STORAGE_KEYS.range,
    });
  });

  it('opens on the stored depth, view and scope', async () => {
    window.localStorage.setItem(SANKEY_STORAGE_KEYS.depth, '2');
    window.localStorage.setItem(SANKEY_STORAGE_KEYS.view, '"table"');
    window.localStorage.setItem(SANKEY_STORAGE_KEYS.accounts, '["acc-savings"]');

    await renderReport();

    expect(mockGetSankey).toHaveBeenCalledWith(
      expect.objectContaining({ depth: 2, accountIds: ['acc-savings'] }),
    );
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByTestId('sankey')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subcategories' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('ignores a stored value of the wrong shape', async () => {
    window.localStorage.setItem(SANKEY_STORAGE_KEYS.depth, '7');
    window.localStorage.setItem(SANKEY_STORAGE_KEYS.view, '"pie"');
    window.localStorage.setItem(SANKEY_STORAGE_KEYS.accounts, '{"id":1}');

    await renderReport();

    expect(mockGetSankey).toHaveBeenCalledWith(expect.objectContaining({ depth: 1, accountIds: [] }));
    expect(screen.getByTestId('sankey')).toBeInTheDocument();
  });
});

describe('sankeyTooltipItem', () => {
  const node = { name: 'Groceries', id: 'expense:g', members: [], value: 5 };
  const link = { source: { name: 'Income' }, target: { name: 'Groceries' }, value: 5, incomplete: true };

  it('reads the item from the entry recharts 3 builds for a Sankey', () => {
    expect(sankeyTooltipItem({ name: 'x', value: 5, payload: { payload: node, name: 'x', value: 5 } })).toEqual({
      type: 'node',
      node,
    });
    expect(sankeyTooltipItem({ payload: { payload: link, name: 'x', value: 5 } })).toMatchObject({
      type: 'link',
      value: 5,
      incomplete: true,
      netRefund: false,
      placeholder: false,
    });
  });

  it('answers no tooltip, never a crash, for anything else', () => {
    expect(sankeyTooltipItem(undefined)).toBeNull();
    expect(sankeyTooltipItem({ payload: { payload: { name: 'no members' } } })).toBeNull();
    expect(sankeyTooltipItem({ payload: { name: 'x', value: 1 } })).toBeNull();
  });
});

describe('sankeyNodeHref', () => {
  const response = example();
  const range = 'startDate=2026-09-01&endDate=2026-09-30';
  const scope = 'accountIds=acc-chq%2Cacc-usd';

  it('links a category to itself', () => {
    expect(sankeyNodeHref(response.nodes[3], response)).toBe(
      `/transactions?categoryId=cat-groceries&${scope}&${range}`,
    );
  });

  it('links uncategorized rows to the uncategorized pseudo-id', () => {
    expect(sankeyNodeHref(node('uncategorized:expense', 'U', 1), response)).toBe(
      `/transactions?categoryId=uncategorized&${scope}&${range}`,
    );
  });

  it('links a class or an inflow to the scope transfers', () => {
    for (const id of ['class:savings', 'inflow:borrowed']) {
      expect(sankeyNodeHref(node(id, id, 1), response)).toBe(`/transactions?categoryId=transfer&${scope}&${range}`);
    }
  });

  it('links a counterpart account to its own transfers', () => {
    expect(sankeyNodeHref(node('account:acc-sav', 'Savings', 1, { accountId: 'acc-sav' }), response)).toBe(
      `/transactions?categoryId=transfer&accountIds=acc-sav&${range}`,
    );
    expect(sankeyNodeHref(node('account:unlinked', '(unlinked account)', 1), response)).toBeNull();
  });

  it('links a subcategory to itself, and gives "(no subcategory)" no link', () => {
    expect(
      sankeyNodeHref(node('child:cat-rest', 'Restaurants', 5, { categoryId: 'cat-rest', parentCategoryId: 'cat-food' }), response),
    ).toBe(`/transactions?categoryId=cat-rest&${scope}&${range}`);
    // The parent's own rows: the filter would list every descendant too.
    expect(
      sankeyNodeHref(node('child:cat-food', '(no subcategory)', 5, { categoryId: 'cat-food', parentCategoryId: 'cat-food' }), response),
    ).toBeNull();
  });

  it('gives the hub and the residual no link: they are arithmetic, not rows', () => {
    expect(sankeyNodeHref(node('hub', 'Income', 1), response)).toBeNull();
    expect(sankeyNodeHref(node('residual:unspent', 'Unspent', 1), response)).toBeNull();
  });
});

describe('SankeyNodeShape', () => {
  const drawn = (overrides: Partial<SankeyDrawNode> = {}): SankeyDrawNode => ({
    name: 'Groceries',
    id: 'expense:cat-groceries',
    kind: 'expense',
    column: 'destination',
    color: null,
    node: null,
    members: [],
    value: 600,
    unknown: false,
    ...overrides,
  });

  it('opens a selectable node on click, as a pointer target inside the image', () => {
    const onSelect = vi.fn();
    render(
      <svg>
        <SankeyNodeShape
          x={10}
          y={10}
          width={12}
          height={40}
          payload={drawn()}
          colorFor={() => 'var(--chart-expense)'}
          onSelect={onSelect}
          canSelect={() => true}
          unknownLabel="Unknown"
        />
      </svg>,
    );

    const shape = screen.getByTestId('sankey-node-expense:cat-groceries');
    fireEvent.click(shape.querySelector('text')!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(shape).toHaveAttribute('data-drillable', 'true');
    // Not a tab stop: inside role="img" nothing would name it.
    expect(shape.getAttribute('tabindex')).toBeNull();
    expect(shape.getAttribute('role')).toBeNull();
  });

  it('draws an unknown residual hollow and says it is unknown', () => {
    const residual = drawn({
      id: 'residual:unspent',
      name: 'Unspent',
      kind: 'residual',
      unknown: true,
      node: {
        id: 'residual:unspent',
        kind: 'residual',
        label: 'Unspent',
        categoryId: null,
        parentCategoryId: null,
        accountId: null,
        color: null,
        total: null,
        knownTotal: 0,
      },
    });
    render(
      <svg>
        <SankeyNodeShape
          payload={residual}
          colorFor={() => 'var(--chart-neutral)'}
          onSelect={vi.fn()}
          canSelect={() => false}
          unknownLabel="Unknown"
        />
      </svg>,
    );

    const shape = screen.getByTestId('sankey-node-residual:unspent');
    expect(shape).toHaveTextContent('Unspent (Unknown)');
    expect(shape.querySelector('rect')?.getAttribute('stroke-dasharray')).toBe('3 2');
    expect(shape.getAttribute('role')).toBeNull();
  });

  it('draws the hub without a label', () => {
    render(
      <svg>
        <SankeyNodeShape
          x={100}
          y={10}
          width={12}
          height={200}
          payload={drawn({ id: 'hub', name: 'Income', kind: 'hub', column: 'hub' })}
          colorFor={() => 'var(--chart-primary)'}
          onSelect={vi.fn()}
          canSelect={() => false}
          unknownLabel="Unknown"
          maxLabelWidth={88}
        />
      </svg>,
    );

    const shape = screen.getByTestId('sankey-node-hub');
    expect(shape.querySelector('rect')).not.toBeNull();
    expect(shape.querySelector('text')).toBeNull();
    expect(shape).not.toHaveTextContent('Income');
  });

  it('cuts a label longer than its gutter, and leaves a short one whole', () => {
    const long = 'Home maintenance and improvements';
    render(
      <svg>
        <SankeyNodeShape
          payload={drawn({ id: 'expense:long', name: long })}
          colorFor={() => 'var(--chart-expense)'}
          onSelect={vi.fn()}
          canSelect={() => false}
          unknownLabel="Unknown"
          fontSize={11}
          maxLabelWidth={88}
        />
        <SankeyNodeShape
          payload={drawn({ id: 'expense:short', name: 'Rent' })}
          colorFor={() => 'var(--chart-expense)'}
          onSelect={vi.fn()}
          canSelect={() => false}
          unknownLabel="Unknown"
          fontSize={11}
          maxLabelWidth={88}
        />
      </svg>,
    );

    const cut = screen.getByTestId('sankey-node-expense:long').querySelector('text')!.textContent!;
    expect(cut.endsWith('\u2026')).toBe(true);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    expect(screen.getByTestId('sankey-node-expense:short')).toHaveTextContent('Rent');
  });
});


describe('CashFlowSankeyReport: a reload is not the previous answer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMobile = false;
    window.localStorage.clear();
  });

  const CARDS = ['income', 'inflows', 'expenses', 'outflows', 'residual'];

  async function changeDepth() {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Subcategories' }));
    });
  }

  it('shows no card and offers no export while the next request has failed', async () => {
    await renderReport();
    expect(screen.getByTestId('export-pdf')).toBeEnabled();

    mockGetSankey.mockRejectedValue(new Error('500'));
    await changeDepth();
    await waitFor(() => expect(mockGetSankey).toHaveBeenLastCalledWith(expect.objectContaining({ depth: 2 })));

    for (const key of CARDS) expect(screen.queryByTestId(`sankey-card-${key}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId('sankey')).not.toBeInTheDocument();
    expect(screen.getByTestId('export-pdf')).toBeDisabled();
    expect(screen.getByTestId('export-csv')).toBeDisabled();
  });

  it('shows no card and offers no export while the next request is pending', async () => {
    await renderReport();

    mockGetSankey.mockReturnValue(new Promise(() => {}));
    await changeDepth();
    await waitFor(() => expect(mockGetSankey).toHaveBeenLastCalledWith(expect.objectContaining({ depth: 2 })));

    for (const key of CARDS) expect(screen.queryByTestId(`sankey-card-${key}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId('sankey')).not.toBeInTheDocument();
    expect(screen.getByTestId('export-pdf')).toBeDisabled();
    expect(screen.getByTestId('export-csv')).toBeDisabled();
  });
});
