import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { CreditUtilizationReport } from './CreditUtilizationReport';

/**
 * The phone layout of the Credit Utilization data table.
 *
 * The table is ONE tree restyled by CSS (mechanism A): below `sm` the rows wrap
 * into a two-column, three-line grid and the column header row is hidden, from
 * `sm` up it is the ordinary table. jsdom applies no media queries, so both
 * header rows and every phone caption are in the DOM here at all times -- which
 * is exactly what lets these assertions read the phone markup without emulating
 * a viewport, and why the sort controls have to be addressed by position rather
 * than by label (each label matches the phone strip, the column header row, and
 * a caption).
 */

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/reports/credit-utilization',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ reportId: 'credit-utilization' }),
}));

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

// The 2dp formatter this report really uses -- it is what makes a six-figure
// amount too wide for three money cells on one line.
vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
  useNumberFormat: () => ({
    ...numberFormatMockDefaults(),
    formatCurrency: (n: number, c?: string) => `${c ?? 'CAD'} ${n.toFixed(2)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
  }),
  };
});

// CHF has no rate, so its row's money figures come back `null` and must render
// the unknown marker rather than a measured zero.
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
    convert: (amount: number, from: string, to?: string) => {
      const target = to ?? 'CAD';
      if (from === target) return amount;
      if (from === 'CHF') return null;
      return amount;
    },
  }),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: ({ children }: any) => <div>{children}</div>,
  PieChart: ({ children }: any) => <div data-testid="pie-chart">{children}</div>,
  Pie: ({ children }: any) => <div>{children}</div>,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  ReferenceLine: () => null,
  Tooltip: () => null,
}));

const mockGetAll = vi.fn();

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

// Worst case for a phone: a 40-character account name, six-figure limits, a
// fully drawn card (100.0%), and a card in a currency with no rate so one row
// carries the unknown marker in place of all three of its money figures.
const ACCOUNT_NAME_40 = 'Scotiabank Momentum Visa Infinite Card!!';

const ACCOUNTS = [
  {
    id: 'a-1',
    name: ACCOUNT_NAME_40,
    accountType: 'LINE_OF_CREDIT',
    accountSubType: null,
    currencyCode: 'CAD',
    currentBalance: -123456.78,
    creditLimit: 123456.78,
    isClosed: false,
  },
  {
    id: 'a-2',
    name: 'Everyday Card',
    accountType: 'CREDIT_CARD',
    accountSubType: null,
    currencyCode: 'CAD',
    currentBalance: -500,
    creditLimit: 5000,
    isClosed: false,
  },
  {
    id: 'a-3',
    name: 'Swiss Card',
    accountType: 'CREDIT_CARD',
    accountSubType: null,
    currencyCode: 'CHF',
    currentBalance: -1000,
    creditLimit: 4000,
    isClosed: false,
  },
];

async function renderReport() {
  mockGetAll.mockResolvedValue(ACCOUNTS);
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<CreditUtilizationReport />));
  });
  await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
  return container;
}

const rowText = (row: Element | null | undefined) => row?.textContent ?? '';

const findRow = (container: Element, name: string) =>
  Array.from(container.querySelectorAll('tbody tr')).find((r) =>
    r.textContent?.includes(name),
  );

/** `c<column>/r<line>` for a cell, read off its explicit grid placement. */
const placement = (cell: Element) => {
  const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
  const line = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
  return `c${col}/r${line}`;
};

describe('CreditUtilizationReport (phone wrapped table)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    window.localStorage.clear();
  });

  it('captions every figure inside the row so a phone needs no column header', async () => {
    const container = await renderReport();

    const row = findRow(container, 'Everyday Card');
    expect(row).toBeDefined();
    for (const caption of ['Credit Limit', 'Used', 'Available', 'Utilization']) {
      expect(rowText(row)).toContain(caption);
    }
    // Each caption sits immediately beside the value it names, as its own text
    // node, so a `getByText` on the value still matches the value node.
    expect(rowText(row)).toContain('Credit LimitCAD 5000.00');
    expect(rowText(row)).toContain('UsedCAD 500.00');
    expect(rowText(row)).toContain('AvailableCAD 4500.00');
    expect(rowText(row)).toContain('Utilization10.0%');
  });

  it('renders the unknown marker, never a zero, for a figure with no rate', async () => {
    const container = await renderReport();

    const row = findRow(container, 'Swiss Card');
    expect(row).toBeDefined();
    // All three money figures are unknown; the percentage is a ratio within one
    // currency, so it needs no rate and stays a real number.
    expect(rowText(row)).toContain('Credit LimitNo rate');
    expect(rowText(row)).toContain('UsedNo rate');
    expect(rowText(row)).toContain('AvailableNo rate');
    expect(rowText(row)).toContain('Utilization25.0%');
    expect(rowText(row)).not.toContain('CAD 0.00');
  });

  it('places every cell on the phone grid explicitly, and never wraps a figure', async () => {
    const container = await renderReport();

    // Auto-flow placement is not deterministic once a cell is added or made
    // conditional, so each cell states its own column and line. A money value
    // stays on one line: a locale grouping thousands with a space would
    // otherwise break in the middle of a number.
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      expect(cells).toHaveLength(5);
      for (const cell of cells) {
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
      }
      // The four figure cells (everything but the account) never wrap, and each
      // is right-aligned. Right alignment is not containment -- a figure past
      // the measured budget overflows the END edge -- but truncating one would
      // be worse.
      const figures = cells.filter((c) => c.className.includes('whitespace-nowrap'));
      expect(figures).toHaveLength(4);
      for (const cell of figures) {
        expect(cell.className).toContain('text-right');
      }
    }
  });

  it('wraps each row onto two lines: account and utilization, then limit, used and available together', async () => {
    const container = await renderReport();

    // The maintainer's call from the phone review: the three amounts on one
    // line. A six-track grid gives line 1's two cells three tracks each and
    // line 2's three cells two each, so every cell still states its own
    // column and line, and nothing reaches a third line.
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const [account, limit, used, available, utilization] = Array.from(
        row.querySelectorAll('td'),
      );
      expect(row.className).toContain('grid-cols-6');
      expect(placement(account)).toBe('c1/r1');
      expect(placement(utilization)).toBe('c4/r1');
      expect(placement(limit)).toBe('c1/r2');
      expect(placement(used)).toBe('c3/r2');
      expect(placement(available)).toBe('c5/r2');
      for (const cell of [account, utilization]) {
        expect(cell.className).toMatch(/\bcol-span-3\b/);
      }
      for (const cell of [limit, used, available]) {
        expect(cell.className).toMatch(/\bcol-span-2\b/);
      }
      // Nothing is placed on a third line.
      for (const cell of [account, limit, used, available, utilization]) {
        expect(cell.className).not.toMatch(/\brow-start-3\b/);
      }
    }
  });

  it('gives the totals row the data row placement, in bold', async () => {
    const container = await renderReport();

    const footRow = container.querySelector('tfoot tr')!;
    expect(footRow.className).toContain('grid-cols-6');
    const [total, limit, used, available, utilization] = Array.from(
      footRow.querySelectorAll('td'),
    );
    expect(total.textContent).toBe('Total');
    expect(placement(total)).toBe('c1/r1');
    expect(placement(utilization)).toBe('c4/r1');
    expect(placement(limit)).toBe('c1/r2');
    expect(placement(used)).toBe('c3/r2');
    expect(placement(available)).toBe('c5/r2');
    // The totals are the largest figures on the table and carry their captions
    // like any other cell, so a phone reader is not left with four bare numbers.
    for (const cell of [limit, used, available, utilization]) {
      expect(cell.className).toContain('font-bold');
      expect(cell.className).toContain('whitespace-nowrap');
    }
    expect(footRow.textContent).toContain('Credit Limit');
    expect(footRow.textContent).toContain('Utilization');
  });

  it('keeps the account name shrinkable and readable in full', async () => {
    const container = await renderReport();

    const row = findRow(container, ACCOUNT_NAME_40)!;
    const identity = row.querySelector('td')!;
    // A track that may be zero is what lets an unbounded name shrink; a flex
    // item's `min-w-0` would still contribute its full text width to the row's
    // minimum. Measured rendered width: 122px at 320px, 157px at 390px.
    expect(identity.className).toContain('min-w-0');
    const name = identity.querySelector('span')!;
    // The tier cell wraps this name today, so the card clamps rather than
    // truncates, and hands the wrap back from `sm` up. Three lines, not two:
    // at the measured 122px track a two-line clamp shows about 25 characters,
    // which renders two accounts differing only after "Scotiabank Momentum
    // Visa " as the same row -- and `title` is a hover affordance a touch
    // screen does not have.
    expect(name.className).toContain('line-clamp-3');
    expect(name.className).toContain('sm:line-clamp-none');
    expect(name.getAttribute('title')).toBe(ACCOUNT_NAME_40);
    // The account-type sub-line stays inside the same identity cell.
    expect(identity.textContent).toContain('Line of Credit');
  });

  it('keeps the row a table row from sm up and a grid below it', async () => {
    const container = await renderReport();

    const table = container.querySelector('table');
    expect(table?.className).toContain('block');
    expect(table?.className).toContain('sm:table');
    expect(container.querySelector('thead')?.className).toContain('sm:table-header-group');
    expect(container.querySelector('tbody')?.className).toContain('sm:table-row-group');
    expect(container.querySelector('tfoot')?.className).toContain('sm:table-footer-group');
    const row = container.querySelector('tbody tr');
    expect(row?.className).toContain('grid grid-cols-6');
    expect(row?.className).toContain('sm:table-row');
    // The wrapper still scrolls horizontally, which is what the table needs
    // from `sm` up on a narrow desktop window.
    expect(table?.parentElement?.className).toContain('overflow-x-auto');
  });

  it('restores the table semantics a phone restyle strips', async () => {
    const container = await renderReport();

    const table = container.querySelector('table');
    expect(table?.getAttribute('role')).toBe('table');
    for (const group of ['thead', 'tbody', 'tfoot']) {
      expect(container.querySelector(group)?.getAttribute('role')).toBe('rowgroup');
    }
    for (const row of Array.from(container.querySelectorAll('table tr'))) {
      expect(row.getAttribute('role')).toBe('row');
    }
    // EVERY `<td>`, the footer's included -- a cell whose className is a
    // template literal is exactly where this gets forgotten.
    const cells = Array.from(container.querySelectorAll('table td'));
    expect(cells.length).toBe(20);
    for (const cell of cells) {
      expect(cell.getAttribute('role')).toBe('cell');
    }
    // `SortableHeader` restates `columnheader` on the `<th>` it renders, so
    // both header rows already carry it.
    for (const th of Array.from(container.querySelectorAll('table th'))) {
      expect(th.getAttribute('role')).toBe('columnheader');
    }
  });

  it('offers the same five sort controls on phones as in the column header', async () => {
    const container = await renderReport();

    const headerRows = Array.from(container.querySelectorAll('thead tr'));
    expect(headerRows).toHaveLength(2);
    const [phoneRow, columnRow] = headerRows;
    // Exactly one of the two is displayed at any width.
    expect(phoneRow.className).toContain('sm:hidden');
    expect(columnRow.className).toContain('hidden');
    expect(columnRow.className).toContain('sm:table-row');

    // The sort indicator glyph rides inside each control, so compare the labels
    // with it stripped.
    const labelsOf = (row: Element) =>
      Array.from(row.querySelectorAll('th')).map((th) =>
        th.textContent?.replace(/[↑↓↕]/g, '').trim(),
      );
    expect(labelsOf(phoneRow)).toEqual([
      'Account',
      'Credit Limit',
      'Used',
      'Available',
      'Utilization',
    ]);
    // Both rows are rendered from one list, so they cannot list different
    // fields -- assert it rather than trusting the loop.
    expect(labelsOf(columnRow)).toEqual(labelsOf(phoneRow));
    // And no column is stranded without a control: a column the rows render is
    // a cell, so every header row carries exactly as many controls as a data
    // row has cells. A field added to the sort union but left out of the header
    // list would fail here rather than reaching a phone with no way to sort or
    // unsort by it.
    const cellsPerRow =
      container.querySelectorAll('tbody tr td').length /
      container.querySelectorAll('tbody tr').length;
    expect(phoneRow.querySelectorAll('th')).toHaveLength(cellsPerRow);
    expect(columnRow.querySelectorAll('th')).toHaveLength(cellsPerRow);
  });

  it('sorts from the phone strip, not only from the column header', async () => {
    const container = await renderReport();

    const nameOrder = () =>
      Array.from(container.querySelectorAll('tbody tr')).map(
        (r) => r.querySelector('td')?.textContent,
      );
    // The stored default is utilization, descending: 100% then 25% then 10%.
    expect(nameOrder()?.[0]).toContain(ACCOUNT_NAME_40);

    // "Account" in the PHONE strip -- the header row that survives below `sm`,
    // identified by the class that hides it from `sm` up rather than by its
    // position, so this cannot silently fall through to the column header row.
    // Within it the control is the first of five, addressed by position because
    // the label also appears in the column header row and in every caption.
    const phoneStrip = Array.from(container.querySelectorAll('thead tr')).find((r) =>
      r.className.includes('sm:hidden'),
    );
    expect(phoneStrip).toBeDefined();
    await act(async () => {
      fireEvent.click(phoneStrip!.querySelectorAll('th')[0]);
    });
    // Ascending by name puts Everyday Card first, then the 40-character
    // Scotiabank card, then Swiss Card.
    expect(nameOrder()[0]).toContain('Everyday Card');
    expect(nameOrder()[1]).toContain('Scotiabank');
    expect(nameOrder()[2]).toContain('Swiss Card');

    // A second tap reverses it, which is the escape from any sort a phone can
    // reach.
    await act(async () => {
      fireEvent.click(phoneStrip!.querySelectorAll('th')[0]);
    });
    expect(nameOrder()[0]).toContain('Swiss Card');
  });

  it('leaves the row non-clickable, as it is today', async () => {
    const container = await renderReport();

    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // A pointer cue would promise an action the row does not have.
      expect(row.className).not.toContain('cursor-pointer');
      await act(async () => {
        fireEvent.click(row);
      });
    }
    // The behaviour claim, not the attribute: clicking navigates nowhere.
    expect(mockPush).not.toHaveBeenCalled();
    // And the rows are still there -- the click changed nothing.
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
  });

  it('leaves the surfaces outside the table alone', async () => {
    await renderReport();

    // The account picker, the summary cards and the charts are not part of the
    // conversion; a phone still gets all of them.
    expect(screen.getByText('Total Credit Limit')).toBeInTheDocument();
    expect(screen.getByText('Overall Utilization')).toBeInTheDocument();
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    expect(screen.getByTestId('pie-chart')).toBeInTheDocument();
    // One card has no rate, so the money totals are marked partial rather than
    // printing a subtotal as the whole.
    expect(screen.getByText(/could not be included/i)).toBeInTheDocument();
  });
});
