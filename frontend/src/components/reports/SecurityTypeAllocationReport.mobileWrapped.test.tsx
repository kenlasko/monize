import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { SecurityTypeAllocationReport } from './SecurityTypeAllocationReport';

/**
 * The phone layout of the Security Type Allocation data table.
 *
 * The table is ONE tree restyled by CSS (mechanism A): below `sm` the rows wrap
 * into a two-column grid and the column header row is hidden, from `sm` up it
 * is the ordinary table. jsdom applies no media queries, so both header rows
 * and every phone caption are in the DOM here at all times -- which is exactly
 * what lets these assertions read the phone markup without emulating a
 * viewport, and why the sort controls have to be addressed by position rather
 * than by label (each label matches the phone strip, the column header row and
 * a caption).
 *
 * The table has THREE row shapes, and the second of them is what makes this
 * table different from the report tables converted before it: an asset TYPE
 * row, the CHILD holding rows it EXPANDS into, and the totals footer. The type
 * row and the footer share one placement; the child row has its own, because
 * its identity is unbounded where a type label is not.
 */

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

// The 2dp `formatCurrency` this table's cells really use -- it is what makes a
// six-figure amount too wide for four money cells on one line. The compact
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

// `JPY` is the currency with no rate: `convertToDefault` answers null for it,
// which is how the allocation's exclusion rule is exercised below.
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
    convertToDefault: (amount: number, code: string) => (code === 'JPY' ? null : amount),
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

// Worst case for a phone: an unbounded holding identity (a 37-character
// security name whose `(N accounts)` marker follows it inline), six- and
// seven-figure 2dp amounts, and a three-digit share count.
const LONG_NAME = 'Vanguard Total Stock Market Index Idx';

function holding(over: Record<string, unknown>) {
  return {
    accountId: 'acc-1',
    securityId: 's-1',
    symbol: 'VTI',
    name: LONG_NAME,
    securityType: 'ETF',
    currencyCode: 'CAD',
    quantity: 1234.5678,
    averageCost: 100,
    costBasis: 100000,
    costBasisAccountCurrency: 100000,
    currentPrice: 180,
    marketValue: 123456.78,
    gainLoss: 0,
    gainLossPercent: 0,
    ...over,
  };
}

// Two raw lots of VTI in different accounts aggregate into one row carrying the
// `(2 accounts)` marker; AAPL is a plain single-account holding.
const HOLDINGS = [
  holding({}),
  holding({ accountId: 'acc-2', marketValue: 1111111.11, quantity: 10 }),
  holding({
    securityId: 's-2',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    securityType: 'STOCK',
    marketValue: 222222.21,
    quantity: 25,
  }),
];

async function renderReport(holdings: unknown[] = HOLDINGS) {
  mockGetPortfolioSummary.mockResolvedValue({ holdings });
  mockGetInvestmentAccounts.mockResolvedValue([]);
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<SecurityTypeAllocationReport />));
  });
  await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
  return container;
}

const rowText = (row: Element | null | undefined) => row?.textContent ?? '';

const typeRows = (container: Element) =>
  Array.from(container.querySelectorAll('tbody tr')).filter((r) =>
    r.className.includes('cursor-pointer'),
  );

const childRows = (container: Element) =>
  Array.from(container.querySelectorAll('tbody tr')).filter(
    (r) => !r.className.includes('cursor-pointer'),
  );

const findTypeRow = (container: Element, label: string) =>
  typeRows(container).find((r) => r.querySelector('td')?.textContent?.includes(label));

/** `c<column>/r<line>` for a cell, read off its explicit grid placement. */
const placement = (cell: Element) => {
  const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
  const line = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
  const span = /\bcol-span-(\d)\b/.exec(cell.className)?.[1];
  return `c${col}${span ? `+${span}` : ''}/r${line}`;
};

const cellsOf = (row: Element) => Array.from(row.querySelectorAll('td'));
const placements = (row: Element) => cellsOf(row).map(placement);

const phoneStripOf = (container: Element) =>
  Array.from(container.querySelectorAll('thead tr')).find((r) =>
    r.className.includes('sm:hidden'),
  )!;

describe('SecurityTypeAllocationReport (phone wrapped table)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('captions every figure inside a type row so a phone needs no column header', async () => {
    const container = await renderReport();

    const row = findTypeRow(container, 'ETFs');
    expect(row).toBeDefined();
    for (const caption of ['Total Value', '% of Portfolio', 'Holdings']) {
      expect(rowText(row)).toContain(caption);
    }
    // Each caption sits immediately beside the value it names, as its own text
    // node, so a `getByText` on the value still matches the value node -- which
    // is what keeps the pre-existing suite green untouched.
    expect(rowText(row)).toContain('Total ValueCAD 1234567.89');
    expect(rowText(row)).toContain('Holdings1');
    // The caption is `CellLabel` from the shared table module, phone-only, and
    // it wraps by itself so an unbreakable pseudo-locale caption cannot be
    // un-wrapped by the `whitespace-nowrap` on the money cell around it.
    for (const caption of Array.from(row!.querySelectorAll('span.sm\\:hidden'))) {
      expect(caption.className).toContain('text-[10px]');
      expect(caption.className).toContain('whitespace-normal');
    }
  });

  it('places every type-row and footer cell on the phone grid, and never wraps a figure', async () => {
    const container = await renderReport();

    const rows = [...typeRows(container), container.querySelector('tfoot tr')!];
    for (const row of rows) {
      const cells = cellsOf(row);
      expect(cells).toHaveLength(4);
      for (const cell of cells) {
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
      }
      // The three figure cells never wrap, and each is right-aligned. Right
      // alignment is not containment -- a figure past the measured budget
      // overflows the END edge -- but truncating money would be worse.
      const figures = cells.filter((c) => c.className.includes('whitespace-nowrap'));
      expect(figures).toHaveLength(3);
      for (const cell of figures) {
        expect(cell.className).toContain('text-right');
      }
    }
  });

  it('gives the type row and the totals footer one placement, on two lines', async () => {
    const container = await renderReport();

    // Compared as whole placement lists rather than cell by cell, so a single
    // cell moved in one shape fails here.
    const expected = ['c1/r1', 'c2/r1', 'c1/r2', 'c2/r2'];
    for (const row of typeRows(container)) {
      expect(placements(row)).toEqual(expected);
      expect(row.className).toContain('grid grid-cols-2');
      expect(row.className).toContain('sm:table-row');
      // Nothing is placed on a third line.
      for (const cell of cellsOf(row)) {
        expect(cell.className).not.toMatch(/\brow-start-3\b/);
      }
    }
    const footRow = container.querySelector('tfoot tr')!;
    expect(placements(footRow)).toEqual(expected);
    expect(footRow.className).toContain('grid grid-cols-2');
    // No footer cell leaves the DOM below `sm`, which is what makes an
    // `aria-colindex` unnecessary: the four cells sit in the four columns' own
    // order at every width.
    for (const cell of cellsOf(footRow)) {
      expect(cell.className).not.toMatch(/\bhidden\b/);
      expect(cell.getAttribute('aria-colindex')).toBeNull();
    }
    expect(footRow.textContent).toContain('Total ValueCAD 1456790.10');
    expect(footRow.textContent).toContain('% of Portfolio100%');
    expect(footRow.textContent).toContain('Holdings2');
  });

  it('expands and collapses a type by clicking the whole row', async () => {
    const container = await renderReport();

    // The behaviour claim, not the attribute: the row itself is the target, so
    // a click anywhere on the card opens it.
    expect(childRows(container)).toHaveLength(0);
    const etfs = findTypeRow(container, 'ETFs')!;
    await act(async () => { fireEvent.click(etfs); });
    expect(childRows(container)).toHaveLength(1);
    expect(container.textContent).toContain(`VTI - ${LONG_NAME}`);

    // A second click on the same row closes it again.
    await act(async () => { fireEvent.click(findTypeRow(container, 'ETFs')!); });
    expect(childRows(container)).toHaveLength(0);
    expect(container.textContent).not.toContain(`VTI - ${LONG_NAME}`);
  });

  it('states no expansion the keyboard cannot reach', async () => {
    const container = await renderReport();

    // The row is the expand control and `role="row"` would take an
    // `aria-expanded`, but a `<tr>` is not focusable and this one carries a
    // bare `onClick` with no key handler: announcing the state would promise a
    // control a keyboard user cannot operate. Focusability and the state are
    // one repair, and it is a behaviour change rather than a layout one --
    // this pins the pair so the attribute cannot arrive without the handling.
    const etfs = findTypeRow(container, 'ETFs')!;
    const stated = etfs.getAttribute('aria-expanded') !== null;
    const operable =
      etfs.hasAttribute('tabindex') || etfs.getAttribute('role') === 'button';
    expect(stated).toBe(operable);
  });

  it('flips the chevron rotation class with the expansion', async () => {
    const container = await renderReport();

    const chevron = () => findTypeRow(container, 'ETFs')!.querySelector('svg')!;
    expect(chevron().getAttribute('class')).not.toContain('rotate-180');
    // The glyph must stay beside the label on a phone rather than being
    // squeezed out of the flex line by a long type name.
    expect(chevron().getAttribute('class')).toContain('flex-shrink-0');

    await act(async () => { fireEvent.click(findTypeRow(container, 'ETFs')!); });
    expect(chevron().getAttribute('class')).toContain('rotate-180');

    await act(async () => { fireEvent.click(findTypeRow(container, 'ETFs')!); });
    expect(chevron().getAttribute('class')).not.toContain('rotate-180');
  });

  it('gives a child holding row its own placement, with the identity spanning both tracks', async () => {
    const container = await renderReport();
    await act(async () => { fireEvent.click(findTypeRow(container, 'ETFs')!); });

    const child = childRows(container)[0];
    expect(child).toBeDefined();
    // The identity takes the whole of line 1 because it is UNBOUNDED, and the
    // three figures fall to lines 2 and 3 -- each in the same COLUMN its
    // type-row counterpart uses, so the two shapes read alike down the card.
    // The cells are in COLUMN order in the DOM (identity, value, share,
    // quantity) -- which is what puts them in the right columns from `sm` up,
    // since a `<td>`'s position IS its column there -- and only the placement
    // paints the share to the value's left. A child row whose DOM followed the
    // painted order would silently swap Total Value and % of Portfolio on
    // every desktop.
    expect(placements(child)).toEqual(['c1+2/r1', 'c2/r2', 'c1/r2', 'c2/r3']);
    // The same claim as an ASSOCIATION rather than a placement string: each
    // captioned child cell carries the caption of the column its DOM position
    // puts it in from `sm` up. Reordering the cells to match the painted order
    // fails here even if every placement string is still right.
    const columnHeader = Array.from(container.querySelectorAll('thead tr'))[1];
    const headerLabels = Array.from(columnHeader.querySelectorAll('th')).map((th) =>
      th.textContent?.replace(/[↑↓↕]/g, '').trim(),
    );
    const childCaptions = cellsOf(child).map(
      (td) => td.querySelector('span.sm\\:hidden')?.textContent ?? null,
    );
    expect(childCaptions).toEqual([
      null,
      headerLabels[1],
      headerLabels[2],
      headerLabels[3],
    ]);
    expect(child.className).toContain('grid grid-cols-2');
    expect(child.className).toContain('sm:table-row');
    // A child row is NOT clickable; only the type row above it is.
    expect(child.className).not.toContain('cursor-pointer');
    // The desktop indent survives exactly, and the phone gets its own.
    const identity = cellsOf(child)[0];
    expect(identity.className).toContain('pl-8');
    expect(identity.className).toContain('sm:pl-10');
    expect(identity.className).toContain('min-w-0');
    // No clamp here: a clamp ate the `(N accounts)` marker in every locale, and
    // this cell is a grid item rather than a flex item, so `break-words` alone
    // contains an unbreakable token.
    expect(identity.className).toContain('break-words');
    expect(identity.className).toContain('sm:break-normal');
    expect(identity.className).not.toContain('line-clamp');
    // The aggregated row's account marker is on screen, inline after the name.
    expect(identity.textContent).toContain(`VTI - ${LONG_NAME}`);
    expect(identity.textContent).toContain('(2 accounts)');
  });

  it('captions every value on a child holding row, the share count included', async () => {
    const container = await renderReport();
    await act(async () => { fireEvent.click(findTypeRow(container, 'ETFs')!); });

    const [identity, value, share, quantity] = cellsOf(childRows(container)[0]);
    expect(identity.querySelector('span.sm\\:hidden')).toBeNull();
    expect(share.textContent).toBe('% of Portfolio84.7%');
    expect(value.textContent).toBe('Total ValueCAD 1234567.89');
    // The share count is captioned too, and the reason is placement rather
    // than kind: it sits at `col-start-2 row-start-3`, directly under this
    // row's money figure in the same track, size and alignment, so bare it
    // reads as a second amount. The caption names the COLUMN, exactly as the
    // desktop header above it does.
    expect(quantity.textContent).toBe('Holdings1244.5678');
    expect(quantity.querySelector('span.sm\\:hidden')).not.toBeNull();
    for (const cell of [share, value, quantity]) {
      expect(cell.className).toContain('whitespace-nowrap');
      expect(cell.className).toContain('text-right');
      // A child cell hands its own `py-2` back from `sm` up, not the type
      // row's `py-3`.
      expect(cell.className).toContain('sm:py-2');
    }
  });

  it('keeps the unknown share marker exactly, captioned like a value', async () => {
    // Every holding is priced at zero, so the portfolio total is zero and each
    // holding's share is UNKNOWN rather than 0.0% -- a share of nothing is not
    // a measured zero. The marker is captioned because a bare dash under no
    // heading says nothing on a phone with no column header.
    const container = await renderReport([holding({ marketValue: 0, quantity: 3 })]);
    await act(async () => { fireEvent.click(findTypeRow(container, 'ETFs')!); });

    const [, value, share] = cellsOf(childRows(container)[0]);
    expect(share.textContent).toBe('% of Portfolio-');
    expect(share.textContent).not.toContain('0.0%');
    // A real zero still renders as a number: only the share is unknown here.
    expect(value.textContent).toBe('Total ValueCAD 0.00');
  });

  it('leaves an unconvertible holding out of the allocation entirely', async () => {
    // Documented, and the reason the child value cell's "Unavailable" branch
    // cannot be reached from data: `allocationData` drops a holding whose
    // market value has no rate to the display currency BEFORE it can become a
    // child row, and reports it through the summary card's `PartialTotal`
    // instead. Pre-existing; a layout mode does not change which rows exist.
    const container = await renderReport([
      holding({}),
      holding({ securityId: 's-9', symbol: 'JPX', name: 'Tokyo Fund', currencyCode: 'JPY' }),
    ]);
    await act(async () => { fireEvent.click(findTypeRow(container, 'ETFs')!); });

    expect(childRows(container)).toHaveLength(1);
    expect(container.textContent).not.toContain('JPX');
    expect(container.textContent).not.toContain('Unavailable');
  });

  it('restores the table semantics a phone restyle strips', async () => {
    const container = await renderReport();
    await act(async () => { fireEvent.click(findTypeRow(container, 'ETFs')!); });

    const table = container.querySelector('table');
    expect(table?.getAttribute('role')).toBe('table');
    for (const group of ['thead', 'tbody', 'tfoot']) {
      expect(container.querySelector(group)?.getAttribute('role')).toBe('rowgroup');
    }
    for (const row of Array.from(container.querySelectorAll('table tr'))) {
      expect(row.getAttribute('role')).toBe('row');
    }
    // EVERY `<td>`, the child rows' and the footer's included -- a cell whose
    // className is a template literal is exactly where this gets forgotten.
    const cells = Array.from(container.querySelectorAll('table td'));
    expect(cells.length).toBe(16); // two type rows + one child + footer, 4 cells each
    for (const cell of cells) {
      expect(cell.getAttribute('role')).toBe('cell');
    }
    // `SortableHeader` restates `columnheader` on the `<th>` it renders, so
    // both header rows already carry it.
    for (const th of Array.from(container.querySelectorAll('table th'))) {
      expect(th.getAttribute('role')).toBe('columnheader');
    }
  });

  it('offers the same four sort controls on phones as in the column header', async () => {
    const container = await renderReport();

    const headerRows = Array.from(container.querySelectorAll('thead tr'));
    expect(headerRows).toHaveLength(2);
    const [phoneRow, columnRow] = headerRows;
    // Exactly one of the two is displayed at any width.
    expect(phoneRow.className).toContain('sm:hidden');
    expect(columnRow.className).toContain('hidden');
    expect(columnRow.className).toContain('sm:table-row');

    // The sort indicator glyph rides inside each control, so compare the
    // labels with it stripped.
    const labelsOf = (row: Element) =>
      Array.from(row.querySelectorAll('th')).map((th) =>
        th.textContent?.replace(/[↑↓↕]/g, '').trim(),
      );
    expect(labelsOf(phoneRow)).toEqual([
      'Asset Type',
      'Total Value',
      '% of Portfolio',
      'Holdings',
    ]);
    // Both rows are rendered from one record, so they cannot list different
    // fields -- assert it rather than trusting the loop.
    expect(labelsOf(columnRow)).toEqual(labelsOf(phoneRow));
    // And no column is stranded without a control: a column the rows render is
    // a cell, so every header row carries exactly as many controls as a TYPE
    // row has cells. A field added to the sort union but left out of the
    // header list would fail here rather than reaching a phone with no way to
    // sort or unsort by it.
    const cellsPerTypeRow = cellsOf(typeRows(container)[0]).length;
    expect(phoneRow.querySelectorAll('th')).toHaveLength(cellsPerTypeRow);
    expect(columnRow.querySelectorAll('th')).toHaveLength(cellsPerTypeRow);
  });

  it('sorts from the phone strip, not only from the column header', async () => {
    const container = await renderReport();

    const order = () =>
      typeRows(container).map((r) => r.querySelector('td')?.textContent?.trim());
    // The stored default is the total, descending.
    expect(order()).toEqual(['ETFs', 'Stocks']);

    // "Asset Type" in the PHONE strip -- identified by the class that hides it
    // from `sm` up rather than by its position, so this cannot silently fall
    // through to the column header row. Within it the control is the first of
    // four, addressed by position because the label also appears in the column
    // header row and in a caption.
    const strip = phoneStripOf(container);
    await act(async () => { fireEvent.click(strip.querySelectorAll('th')[0]); });
    expect(order()).toEqual(['ETFs', 'Stocks']);
    await act(async () => { fireEvent.click(strip.querySelectorAll('th')[0]); });
    expect(order()).toEqual(['Stocks', 'ETFs']);

    // A column the card places on line 2 is still sortable from the strip: the
    // third control is the share, and ascending puts the smaller one first.
    await act(async () => { fireEvent.click(strip.querySelectorAll('th')[2]); });
    expect(order()).toEqual(['Stocks', 'ETFs']);
  });

  it('clamps the type label instead of truncating it, and keeps the dot', async () => {
    const container = await renderReport();

    const identity = findTypeRow(container, 'ETFs')!.querySelector('td')!;
    // The label sits in a `minmax(0,1fr)` track with `min-w-0` -- the only
    // shape that lets it shrink without its text setting the table's minimum
    // width.
    expect(identity.className).toContain('min-w-0');
    const name = identity.querySelector('span')!;
    // The tier cell WRAPS the label today, so the card clamps rather than
    // truncates: `truncate` would cut a label the desktop table shows in full.
    expect(name.className).toContain('line-clamp-3');
    expect(name.className).toContain('sm:line-clamp-none');
    expect(name.className).not.toContain('truncate');
    // An unknown security type falls through to its raw enum name, one
    // unbreakable token that does not fit the measured 78px name box; without
    // `break-words` the clamp's `overflow: hidden` cuts it mid-glyph with no
    // ellipsis, which every width measurement reports as fine.
    expect(name.className).toContain('break-words');
    expect(name.className).toContain('sm:break-normal');
    expect(name.getAttribute('title')).toBe('ETFs');
    // The colour dot's inner markup is exactly today's.
    const inner = identity.querySelector('div')!;
    expect(inner.className).toBe('flex items-center gap-2');
    expect(inner.querySelector('div')!.className).toContain('rounded-full');
  });

  it('keeps the row a table row from sm up and a grid below it', async () => {
    const container = await renderReport();
    await act(async () => { fireEvent.click(findTypeRow(container, 'ETFs')!); });

    const table = container.querySelector('table');
    expect(table?.className).toContain('block');
    expect(table?.className).toContain('sm:table');
    expect(container.querySelector('thead')?.className).toContain('sm:table-header-group');
    expect(container.querySelector('tbody')?.className).toContain('sm:table-row-group');
    expect(container.querySelector('tfoot')?.className).toContain('sm:table-footer-group');
    // Every figure cell hands its padding and its type size back from `sm` up,
    // so the desktop cell is the one it is today.
    const figure = cellsOf(typeRows(container)[0])[1];
    expect(figure.className).toContain('sm:px-4');
    expect(figure.className).toContain('sm:py-3');
    expect(figure.className).toContain('sm:text-sm');
    // The wrapper still scrolls horizontally, which is what the table needs
    // from `sm` up on a narrow desktop window.
    expect(table?.parentElement?.className).toContain('overflow-x-auto');
  });

  it('leaves the surfaces outside the table alone', async () => {
    await renderReport();

    // The filter, the summary cards and the pie chart are not part of the
    // conversion; a phone still gets all of them.
    expect(screen.getByText('Total Portfolio')).toBeInTheDocument();
    expect(screen.getByText('Asset Types')).toBeInTheDocument();
    expect(screen.getByText('Largest Type')).toBeInTheDocument();
    expect(screen.getByTestId('pie-chart')).toBeInTheDocument();
  });
});
