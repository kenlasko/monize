import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { CurrencyExposureReport } from './CurrencyExposureReport';

/**
 * The phone layout of the Currency Exposure data table.
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
  usePathname: () => '/reports/currency-exposure',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ reportId: 'currency-exposure' }),
}));

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

// The 2dp `formatCurrency` this table's cells really use -- it is what makes a
// six-figure amount too wide for three money cells on one line. The compact
// formatter beside it serves the summary cards only.
vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
  useNumberFormat: () => ({
    ...numberFormatMockDefaults(),
    formatCurrencyCompact: (n: number, c?: string) => `${c ?? 'CAD'} ${n.toFixed(0)}`,
    formatCurrency: (n: number, c?: string) => `${c ?? 'CAD'} ${n.toFixed(2)}`,
  }),
  };
});

// Three rate states, because the rate cell renders three different things:
// the home currency's fixed unity string, a resolved rate at six decimals, and
// the '-' marker where no rate could be resolved.
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
    convertToDefault: (amount: number) => amount,
    getRate: (currency: string) =>
      currency === 'CAD' ? 1 : currency === 'JPY' ? null : 1.365,
  }),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  PieChart: ({ children }: any) => <div data-testid="pie-chart">{children}</div>,
  Pie: () => null,
  Cell: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

const mockGetPortfolioSummary = vi.fn();
const mockGetInvestmentAccounts = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const holding = (id: string, currencyCode: string, marketValue: number) => ({
  id,
  accountId: 'acc-1',
  securityId: `s-${id}`,
  symbol: id,
  name: id,
  securityType: 'STOCK',
  currencyCode,
  quantity: 1,
  averageCost: 1,
  costBasis: 1,
  currentPrice: 1,
  marketValue,
  gainLoss: 0,
  gainLossPercent: 0,
});

// Worst case for a phone: six-figure 2dp amounts, a currency whose rate could
// not be resolved, and a currency carrying more than one holding so the count
// column is not always "1".
const HOLDINGS = [
  holding('h-usd', 'USD', 987654.32),
  holding('h-cad-1', 'CAD', 123456.78),
  holding('h-cad-2', 'CAD', 1000),
  holding('h-jpy', 'JPY', 98765.43),
];

async function renderReport() {
  mockGetPortfolioSummary.mockResolvedValue({ holdings: HOLDINGS });
  mockGetInvestmentAccounts.mockResolvedValue([]);
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<CurrencyExposureReport />));
  });
  await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
  return container;
}

const rowText = (row: Element | null | undefined) => row?.textContent ?? '';

const findRow = (container: Element, currency: string) =>
  Array.from(container.querySelectorAll('tbody tr')).find((r) =>
    r.querySelector('td')?.textContent?.includes(currency),
  );

/** `c<column>/r<line>` for a cell, read off its explicit grid placement. */
const placement = (cell: Element) => {
  const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
  const line = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
  return `c${col}/r${line}`;
};

describe('CurrencyExposureReport (phone wrapped table)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    window.localStorage.clear();
  });

  it('captions every figure inside the row so a phone needs no column header', async () => {
    const container = await renderReport();

    const row = findRow(container, 'USD');
    expect(row).toBeDefined();
    for (const caption of ['Native Value', 'Rate to CAD', 'CAD Value', '% of Portfolio', 'Holdings']) {
      expect(rowText(row)).toContain(caption);
    }
    // Each caption sits immediately beside the value it names, as its own text
    // node, so a `getByText` on the value still matches the value node. The two
    // interpolated captions carry the SAME ICU argument the column header does
    // -- "Rate to CAD", never the raw placeholder.
    expect(rowText(row)).toContain('Native ValueUSD 987654.32');
    expect(rowText(row)).toContain('Rate to CAD1.365000');
    expect(rowText(row)).toContain('CAD ValueCAD 987654.32');
    expect(rowText(row)).toContain('Holdings1');
  });

  it('keeps the rate marker exactly: unity for the home currency, "-" for no rate', async () => {
    const container = await renderReport();

    // The home currency converts 1:1 BY DEFINITION, and that is a known rate.
    expect(rowText(findRow(container, 'CAD'))).toContain('Rate to CAD1.000000');
    // A rate that could not be resolved is unknown, and the marker for it is
    // never a measured 1 -- the two states have to stay distinguishable.
    const jpy = findRow(container, 'JPY');
    expect(rowText(jpy)).toContain('Rate to CAD-');
    expect(rowText(jpy)).not.toContain('1.000000');
    // A rate is not money: it is displayed at `FX_RATE_DISPLAY_DECIMALS` (six),
    // never at money's four, and the cell that holds it never wraps or clips.
    const usdRate = Array.from(findRow(container, 'USD')!.querySelectorAll('td'))[2];
    expect(usdRate.textContent).toBe('Rate to CAD1.365000');
    expect(usdRate.className).toContain('whitespace-nowrap');
  });

  it('places every cell on the phone grid explicitly, and never wraps a figure', async () => {
    const container = await renderReport();

    // Auto-flow placement is not deterministic once a cell is added or made
    // conditional, so each cell states its own column and line. A money value
    // stays on one line: a locale grouping thousands with a space would
    // otherwise break in the middle of a number, and the 6dp rate must never
    // break at all.
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      expect(cells).toHaveLength(6);
      for (const cell of cells) {
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
      }
      // The five figure cells (everything but the currency) never wrap, and
      // each is right-aligned. Right alignment is not containment -- a figure
      // past the measured budget overflows the END edge -- but truncating a
      // money value or a rate would be worse.
      const figures = cells.filter((c) => c.className.includes('whitespace-nowrap'));
      expect(figures).toHaveLength(5);
      for (const cell of figures) {
        expect(cell.className).toContain('text-right');
      }
    }
  });

  it('wraps each row onto two lines: currency, native and converted value; then rate, share and count', async () => {
    const container = await renderReport();

    // The maintainer's call from the phone review: the native and the
    // converted value on one line, the other three on the next. The identity
    // is bounded (a dot and a three-letter code), so it takes a fixed 4rem
    // track and the two money tracks split the rest; the rate sits under the
    // currency it prices, left-aligned there so it lines up under the code.
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const [currency, native, rate, converted, pct, count] = Array.from(
        row.querySelectorAll('td'),
      );
      expect(row.className).toContain('grid-cols-[4rem_minmax(0,1fr)_minmax(0,1fr)]');
      expect(placement(currency)).toBe('c1/r1');
      expect(placement(native)).toBe('c2/r1');
      expect(placement(converted)).toBe('c3/r1');
      expect(placement(rate)).toBe('c1/r2');
      expect(placement(pct)).toBe('c2/r2');
      expect(placement(count)).toBe('c3/r2');
      expect(rate.className).toContain('max-sm:text-left');
      // Nothing is placed on a third line.
      for (const cell of [currency, native, rate, converted, pct, count]) {
        expect(cell.className).not.toMatch(/\brow-start-3\b/);
      }
    }
  });

  it('gives the totals row the data row placement, and lets its two empty cells claim no grid slot', async () => {
    const container = await renderReport();

    const footRow = container.querySelector('tfoot tr')!;
    expect(footRow.className).toContain('grid-cols-[4rem_minmax(0,1fr)_minmax(0,1fr)]');
    const [total, blankNative, blankRate, converted, pct, count] = Array.from(
      footRow.querySelectorAll('td'),
    );
    expect(total.textContent).toBe('Total');
    expect(placement(total)).toBe('c1/r1');
    expect(placement(converted)).toBe('c3/r1');
    expect(placement(pct)).toBe('c2/r2');
    expect(placement(count)).toBe('c3/r2');

    // The native value and the rate have no total. Their cells are `hidden`
    // below `sm` so they occupy no grid track -- placed, they would take a
    // track from the figures beside them; from `sm` up they are the same empty
    // table cells the footer has today.
    for (const blank of [blankNative, blankRate]) {
      expect(blank.textContent).toBe('');
      expect(blank.className).toBe('hidden sm:table-cell');
      expect(blank.className).not.toMatch(/\bcol-start-\d\b/);
      expect(blank.className).not.toMatch(/\brow-start-\d\b/);
    }

    // The totals are the largest figures on the table and carry their captions
    // like any other cell, so a phone reader is not left with three bare
    // numbers under no heading.
    for (const cell of [converted, pct, count]) {
      expect(cell.className).toContain('font-bold');
      expect(cell.className).toContain('whitespace-nowrap');
    }
    expect(footRow.textContent).toContain('CAD Value');
    expect(footRow.textContent).toContain('% of Portfolio');
    expect(footRow.textContent).toContain('Holdings');
  });

  it('keeps each total announced against its own column, though two footer cells leave the DOM', async () => {
    const container = await renderReport();

    // `display: none` takes a cell out of the accessibility tree, so below `sm`
    // the footer exposes four cells where the header exposes six columnheaders
    // -- and a reader placing a cell by its position would announce the grand
    // total under "Native Value" and the holdings total under "CAD Value".
    // Every footer cell therefore states its own column, which is exactly the
    // case `aria-colindex` exists for.
    const headerLabels = Array.from(
      container.querySelectorAll('thead tr:first-child th'),
    ).map((th) => th.textContent?.replace(/[↑↓↕]/g, '').trim());
    expect(headerLabels).toHaveLength(6);

    const footCells = Array.from(container.querySelectorAll('tfoot td'));
    expect(footCells.map((c) => c.getAttribute('aria-colindex'))).toEqual([
      '1', '2', '3', '4', '5', '6',
    ]);

    // And the index each total claims names the column whose caption it
    // carries -- the association, not merely the presence of the attribute.
    const columnOf = (cell: Element) =>
      headerLabels[Number(cell.getAttribute('aria-colindex')) - 1];
    const [, , , converted, pct, count] = footCells;
    expect(columnOf(converted)).toBe('CAD Value');
    expect(columnOf(pct)).toBe('% of Portfolio');
    expect(columnOf(count)).toBe('Holdings');
    // 987654.32 + 123456.78 + 1000 + 98765.43, the sum of the three rows.
    expect(converted.textContent).toContain('CAD 1210876.53');
  });

  it('keeps the bounded identity exactly as it is: a colour dot beside the code', async () => {
    const container = await renderReport();

    const identity = findRow(container, 'USD')!.querySelector('td')!;
    // A three-letter ISO code with a 12px dot is BOUNDED -- about 60px at its
    // widest -- so it needs none of the machinery an unbounded name does: no
    // clamp, no truncation, no `title` fallback. The inner markup is exactly
    // today's, and the measured track is 122px at 320px, 157px at 390px.
    const inner = identity.querySelector('div')!;
    expect(inner.className).toBe('flex items-center gap-2');
    expect(identity.className).not.toContain('line-clamp');
    expect(identity.className).not.toContain('truncate');
    expect(identity.textContent).toBe('USD');
    expect(inner.querySelector('div')!.className).toContain('rounded-full');
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
    expect(row?.className).toContain('grid grid-cols-[4rem_minmax(0,1fr)_minmax(0,1fr)]');
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
    // EVERY `<td>`, the footer's two blanks included -- a cell whose className
    // is a template literal, and a self-closing empty one, are exactly where
    // this gets forgotten.
    const cells = Array.from(container.querySelectorAll('table td'));
    expect(cells.length).toBe(24);
    for (const cell of cells) {
      expect(cell.getAttribute('role')).toBe('cell');
    }
    // `SortableHeader` restates `columnheader` on the `<th>` it renders, so
    // both header rows already carry it.
    for (const th of Array.from(container.querySelectorAll('table th'))) {
      expect(th.getAttribute('role')).toBe('columnheader');
    }
  });

  it('offers the same six sort controls on phones as in the column header', async () => {
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
      'Currency',
      'Native Value',
      'Rate to CAD',
      'CAD Value',
      '% of Portfolio',
      'Holdings',
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

    const codeOrder = () =>
      Array.from(container.querySelectorAll('tbody tr')).map(
        (r) => r.querySelector('td')?.textContent,
      );
    // The stored default is the converted value, descending.
    expect(codeOrder()).toEqual(['USD', 'CAD', 'JPY']);

    // "Currency" in the PHONE strip -- the header row that survives below `sm`,
    // identified by the class that hides it from `sm` up rather than by its
    // position, so this cannot silently fall through to the column header row.
    // Within it the control is the first of six, addressed by position because
    // the label also appears in the column header row and in every caption.
    const phoneStrip = Array.from(container.querySelectorAll('thead tr')).find((r) =>
      r.className.includes('sm:hidden'),
    );
    expect(phoneStrip).toBeDefined();
    await act(async () => {
      fireEvent.click(phoneStrip!.querySelectorAll('th')[0]);
    });
    expect(codeOrder()).toEqual(['CAD', 'JPY', 'USD']);

    // A second tap reverses it, which is the escape from any sort a phone can
    // reach.
    await act(async () => {
      fireEvent.click(phoneStrip!.querySelectorAll('th')[0]);
    });
    expect(codeOrder()).toEqual(['USD', 'JPY', 'CAD']);

    // A column the phone strip offers that the row places on a later line is
    // still sortable from there: the third control is the rate.
    await act(async () => {
      fireEvent.click(phoneStrip!.querySelectorAll('th')[2]);
    });
    expect(codeOrder()[0]).toBe('CAD');
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

  it('exports the columns the table renders, in the table\'s own order', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    const container = await renderReport();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /export pdf/i }));
    });
    await waitFor(() => expect(exportToPdf).toHaveBeenCalledTimes(1));
    const { headers, rows } = (exportToPdf as any).mock.calls[0][0].tableData;

    // One ordered record feeds the phone sort strip, the column header row,
    // the cells and the export -- so the export's headings, its row values and
    // the table's own cells all have to line up column for column. Reordering
    // the record must move all of them, and this fails if only some move.
    const strip = Array.from(container.querySelectorAll('thead tr:first-child th'));
    expect(headers).toEqual(strip.map((th) => th.textContent?.replace(/[↑↓↕]/g, '').trim()));

    // The first exported row against the first rendered row, cell by cell,
    // with each cell's phone caption stripped off -- what is left is the value.
    const firstRow = container.querySelector('tbody tr')!;
    const rendered = Array.from(firstRow.querySelectorAll('td')).map((td) => {
      const caption = td.querySelector('span');
      const text = td.textContent ?? '';
      return caption ? text.slice((caption.textContent ?? '').length) : text;
    });
    expect(rows[0]).toEqual(rendered);
  });

  it('leaves the surfaces outside the table alone', async () => {
    await renderReport();

    // The account picker, the summary cards and the pie chart are not part of
    // the conversion; a phone still gets all of them.
    expect(screen.getByText('Total Portfolio')).toBeInTheDocument();
    expect(screen.getByText('Currencies')).toBeInTheDocument();
    expect(screen.getByText('Foreign Exposure')).toBeInTheDocument();
    expect(screen.getByTestId('pie-chart')).toBeInTheDocument();
  });
});
