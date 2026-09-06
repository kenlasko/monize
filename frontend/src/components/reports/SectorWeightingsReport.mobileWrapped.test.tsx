import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { SectorWeightingsReport } from './SectorWeightingsReport';

/**
 * The phone layout of the Sector Weightings data table.
 *
 * The table is ONE tree restyled by CSS (mechanism A): below `sm` the rows wrap
 * into a two-column, three-line grid and the column header row is hidden, from
 * `sm` up it is the ordinary table. jsdom applies no media queries, so both
 * header rows and every phone caption are in the DOM here at all times -- which
 * is exactly what lets these assertions read the phone markup without emulating
 * a viewport, and why the sort controls have to be addressed by position rather
 * than by label (each label matches the phone strip, the column header row, and
 * a caption).
 *
 * The table has THREE row shapes -- a sector row, the optional unclassified row
 * and the totals footer -- and the claim these tests exist to hold is that all
 * three place their cells identically, so a reader finds the ETF figure in the
 * same corner of every card.
 */

const mockPush = vi.fn();
// One router for the run, as `src/test/setup.ts` builds it: `useRouter()`
// returns the same object every render in the real hook, so a factory handing
// back a fresh one changes the identity of every `useCallback([router])` and an
// effect that also sets state loops. Built lazily inside the factory because
// `vi.mock` is hoisted above the `const` it closes over.
let router: { push: typeof mockPush; replace: () => void; back: () => void; prefetch: () => void };
vi.mock('next/navigation', () => ({
  useRouter: () => {
    router ??= { push: mockPush, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() };
    return router;
  },
  usePathname: () => '/reports/sector-weightings',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ reportId: 'sector-weightings' }),
}));

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

// The 2dp `formatCurrency` this table's cells really use -- it is what makes a
// six-figure amount too wide for three money cells on one line. The compact
// formatter beside it serves the summary cards and the chart axis only.
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

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({ defaultCurrency: 'CAD' }),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

const mockGetSectorWeightings = vi.fn();
const mockGetInvestmentAccounts = vi.fn();
const mockGetSecurities = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSectorWeightings: (...args: any[]) => mockGetSectorWeightings(...args),
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
    getSecurities: (...args: any[]) => mockGetSecurities(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

// Worst case for a phone: an unbounded sector name (the 46-character Russian
// GICS name for Consumer Discretionary, beside the 42-character one it shares
// its first 23 characters with), six- and seven-figure 2dp amounts, and an
// unclassified bucket so all three row shapes are on screen at once.
const LONG_SECTOR = 'Потребительские товары длительного пользования';
const SIBLING_SECTOR = 'Потребительские товары повседневного спроса';

const WEIGHTINGS = {
  items: [
    { sector: LONG_SECTOR, directValue: 123456.78, etfValue: 98765.43, totalValue: 222222.21, percentage: 6.25 },
    { sector: SIBLING_SECTOR, directValue: 1234567.89, etfValue: 987654.32, totalValue: 2222222.21, percentage: 62.5 },
    { sector: 'Energy', directValue: 0, etfValue: 12345.67, totalValue: 12345.67, percentage: 0.35 },
  ],
  totalPortfolioValue: 2913579.1,
  totalDirectValue: 1358024.67,
  totalEtfValue: 1098765.42,
  unclassifiedValue: 456789.01,
};

async function renderReport(data: unknown = WEIGHTINGS) {
  mockGetSectorWeightings.mockResolvedValue(data);
  mockGetInvestmentAccounts.mockResolvedValue([]);
  mockGetSecurities.mockResolvedValue([]);
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<SectorWeightingsReport />));
  });
  await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
  return container;
}

const rowText = (row: Element | null | undefined) => row?.textContent ?? '';

const findRow = (container: Element, label: string) =>
  Array.from(container.querySelectorAll('tbody tr')).find((r) =>
    r.querySelector('td')?.textContent?.includes(label),
  );

/** `c<column>/r<line>` for a cell, read off its explicit grid placement. */
const placement = (cell: Element) => {
  const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
  const line = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
  return `c${col}/r${line}`;
};

/** The five cells of a row, in DOM (column) order. */
const cellsOf = (row: Element) => Array.from(row.querySelectorAll('td'));

/** Every cell's placement, keyed by its DOM position. */
const placements = (row: Element) => cellsOf(row).map(placement);

describe('SectorWeightingsReport (phone wrapped table)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    window.localStorage.clear();
  });

  it('captions every figure inside the row so a phone needs no column header', async () => {
    const container = await renderReport();

    const row = findRow(container, 'Energy');
    expect(row).toBeDefined();
    for (const caption of ['Direct Value', 'ETF Value', 'Total Value', '% of Portfolio']) {
      expect(rowText(row)).toContain(caption);
    }
    // Each caption sits immediately beside the value it names, as its own text
    // node, so a `getByText` on the value still matches the value node -- which
    // is what keeps the pre-existing suite green untouched.
    expect(rowText(row)).toContain('Direct ValueCAD 0.00');
    expect(rowText(row)).toContain('ETF ValueCAD 12345.67');
    expect(rowText(row)).toContain('Total ValueCAD 12345.67');
    expect(rowText(row)).toContain('% of Portfolio0.4%');
    // The caption is `CellLabel` from the shared table module, phone-only.
    for (const caption of Array.from(row!.querySelectorAll('span.sm\\:hidden'))) {
      expect(caption.className).toContain('text-[10px]');
      // It wraps by itself, so an unbreakable pseudo-locale caption cannot be
      // un-wrapped by the `whitespace-nowrap` on the money cell around it.
      expect(caption.className).toContain('whitespace-normal');
    }
  });

  it('keeps the unclassified row markers exactly: an em dash, captioned like a value', async () => {
    const container = await renderReport();

    const unclassified = findRow(container, 'Unclassified')!;
    expect(unclassified).toBeDefined();
    // The direct and ETF cells hold the em dash the desktop row holds -- the
    // marker for "this row has no such figure". It is never a formatted zero,
    // and on a phone it is captioned like any other value, because a bare dash
    // under no heading says nothing once the column header is gone.
    const [, direct, etf, total, pct] = cellsOf(unclassified);
    expect(direct.textContent).toBe('Direct Value—');
    expect(etf.textContent).toBe('ETF Value—');
    expect(direct.textContent).not.toContain('0.00');
    expect(etf.textContent).not.toContain('0.00');
    // Its own two figures are real and formatted.
    expect(total.textContent).toBe('Total ValueCAD 456789.01');
    expect(pct.textContent).toBe('% of Portfolio15.7%');
    // The italic label and the row tint are unchanged.
    expect(unclassified.className).toContain('bg-gray-50/50');
    expect(cellsOf(unclassified)[0].className).toContain('italic');
  });

  it('places every cell on the phone grid explicitly, and never wraps a figure', async () => {
    const container = await renderReport();

    // Auto-flow placement is not deterministic once a cell is added or made
    // conditional (the unclassified row is exactly that), so each cell states
    // its own column and line. A money value stays on one line: a locale
    // grouping thousands with a space would otherwise break in the middle of a
    // number.
    const rows = [
      ...Array.from(container.querySelectorAll('tbody tr')),
      container.querySelector('tfoot tr')!,
    ];
    expect(rows).toHaveLength(5); // three sectors, unclassified, totals
    for (const row of rows) {
      const cells = cellsOf(row);
      expect(cells).toHaveLength(5);
      for (const cell of cells) {
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
      }
      // The four figure cells (everything but the sector) never wrap, and each
      // is right-aligned. Right alignment is not containment -- a figure past
      // the measured budget overflows the END edge -- but truncating a money
      // value would be worse.
      const figures = cells.filter((c) => c.className.includes('whitespace-nowrap'));
      expect(figures).toHaveLength(4);
      for (const cell of figures) {
        expect(cell.className).toContain('text-right');
      }
    }
  });

  it('wraps each row onto two lines: sector and total, then direct, ETF and the share together', async () => {
    const container = await renderReport();

    // The maintainer's call from the phone review: the direct value, the ETF
    // value and the share on one line. A six-track grid gives line 1's two
    // cells three tracks each and line 2's three cells two each, so every
    // cell still states its own column and line, and nothing reaches a third
    // line.
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const [sector, direct, etf, total, pct] = cellsOf(row);
      expect(row.className).toContain('grid-cols-6');
      expect(placement(sector)).toBe('c1/r1');
      expect(placement(total)).toBe('c4/r1');
      expect(placement(direct)).toBe('c1/r2');
      expect(placement(etf)).toBe('c3/r2');
      expect(placement(pct)).toBe('c5/r2');
      for (const cell of [sector, total]) {
        expect(cell.className).toMatch(/\bcol-span-3\b/);
      }
      for (const cell of [direct, etf, pct]) {
        expect(cell.className).toMatch(/\bcol-span-2\b/);
      }
      // Nothing is placed on a third line.
      for (const cell of cellsOf(row)) {
        expect(cell.className).not.toMatch(/\brow-start-3\b/);
      }
    }
  });

  it('gives all three row shapes one placement, and drops no cell below sm', async () => {
    const container = await renderReport();

    // The claim: a sector row, the unclassified row and the totals footer are
    // laid out identically, so the ETF figure is in the same corner of every
    // card. Compared as whole placement lists rather than cell by cell, so a
    // single cell moved in one shape fails here.
    const sectorRow = container.querySelector('tbody tr')!;
    const unclassified = findRow(container, 'Unclassified')!;
    const footRow = container.querySelector('tfoot tr')!;
    const expected = ['c1/r1', 'c1/r2', 'c3/r2', 'c4/r1', 'c5/r2'];
    expect(placements(sectorRow)).toEqual(expected);
    expect(placements(unclassified)).toEqual(expected);
    expect(placements(footRow)).toEqual(expected);
    for (const row of [sectorRow, unclassified, footRow]) {
      expect(row.className).toContain('grid grid-cols-6');
      expect(row.className).toContain('sm:table-row');
    }

    // Every column here has a total, so unlike the sibling reports NO footer
    // cell leaves the DOM below `sm`. That is what makes an `aria-colindex`
    // unnecessary: the five cells sit in the five columns' own order at every
    // width, so a reader placing a cell by position lands on the right column.
    for (const row of [sectorRow, unclassified, footRow]) {
      for (const cell of cellsOf(row)) {
        expect(cell.className).not.toMatch(/\bhidden\b/);
        expect(cell.getAttribute('aria-colindex')).toBeNull();
      }
    }

    // All three identity cells contain their label in the SAME clamped span,
    // not just the same track. The containment argument for that track is the
    // clamp's own `overflow: hidden` (a flex item with no `min-w-0` otherwise
    // contributes its longest unbroken word to the row's minimum width), so a
    // label left outside the span is one long token away from reopening the
    // sideways scroll -- with nothing to show it until a locale grows one.
    for (const row of [sectorRow, unclassified, footRow]) {
      const label = cellsOf(row)[0].querySelector('span');
      expect(label?.className).toContain('line-clamp-3');
      expect(label?.className).toContain('break-words');
      expect(cellsOf(row)[0].className).toContain('min-w-0');
    }

    // The totals are the largest figures on the table and carry their captions
    // like any other cell, so a phone reader is not left with four bare
    // numbers under no heading.
    const [totalLabel, ...footFigures] = cellsOf(footRow);
    expect(totalLabel.textContent).toBe('Total');
    for (const cell of footFigures) {
      expect(cell.className).toContain('font-bold');
      expect(cell.className).toContain('whitespace-nowrap');
    }
    expect(footRow.textContent).toContain('Direct ValueCAD 1358024.67');
    expect(footRow.textContent).toContain('ETF ValueCAD 1098765.42');
    expect(footRow.textContent).toContain('Total ValueCAD 2913579.10');
    expect(footRow.textContent).toContain('% of Portfolio100%');
  });

  it('clamps the unbounded sector name instead of truncating it, and keeps the dot', async () => {
    const container = await renderReport();

    const identity = findRow(container, LONG_SECTOR)!.querySelector('td')!;
    // A sector name is UNBOUNDED, so the cell is a `minmax(0,1fr)` track with
    // `min-w-0` -- the only shape that lets it shrink without the text setting
    // the table's minimum width.
    expect(identity.className).toContain('min-w-0');
    const name = identity.querySelector('span')!;
    // The tier cell WRAPS the name today, so the card clamps rather than
    // truncates: `truncate` would cut a name the desktop table shows in full.
    expect(name.className).toContain('line-clamp-3');
    expect(name.className).toContain('sm:line-clamp-none');
    expect(name.className).not.toContain('truncate');
    // A single word longer than the 102px name box would otherwise overflow
    // the clamp's `overflow: hidden` and be cut mid-glyph with no ellipsis --
    // invisible clipping that every width measurement reports as fine. The
    // longest word here is 15 characters, and phone-only breaking is what
    // makes the cut visible; from `sm` up the box is 208px and it is off.
    expect(name.className).toContain('break-words');
    expect(name.className).toContain('sm:break-normal');
    expect(Math.max(...LONG_SECTOR.split(' ').map((w) => w.length))).toBeGreaterThan(13);
    expect(name.getAttribute('title')).toBe(LONG_SECTOR);
    expect(name.textContent).toBe(LONG_SECTOR);
    // Three lines, not two: measured at the 102px name box a two-line clamp
    // shows 22 characters, and these two sectors share their first 23 -- both
    // would read as the same account. The whole point of the clamp count is
    // that these two stay different on screen.
    expect(LONG_SECTOR.slice(0, 22)).toBe(SIBLING_SECTOR.slice(0, 22));
    // The colour dot's inner markup is exactly today's.
    const inner = identity.querySelector('div')!;
    expect(inner.className).toBe('flex items-center gap-2');
    expect(inner.querySelector('div')!.className).toContain('rounded-full');
  });

  it('keeps a sector\'s dot colour keyed to its place in the unsorted data', async () => {
    const container = await renderReport();

    const dotOf = (label: string) =>
      findRow(container, label)!.querySelector('td div div')!.getAttribute('style');
    // The index is the row's position in `data.items`, not in the sorted list,
    // so a sector's swatch is the same whichever way the table is sorted. It
    // is not a key to the chart, which colours by series rather than by sector
    // (see the cell's own comment) -- the claim here is stability alone.
    const before = [LONG_SECTOR, SIBLING_SECTOR, 'Energy'].map(dotOf);
    expect(before[0]).toContain('--chart-1');
    expect(before[1]).toContain('--chart-2');
    expect(before[2]).toContain('--chart-3');

    const phoneStrip = Array.from(container.querySelectorAll('thead tr')).find((r) =>
      r.className.includes('sm:hidden'),
    )!;
    await act(async () => {
      fireEvent.click(phoneStrip.querySelectorAll('th')[0]);
    });
    expect([LONG_SECTOR, SIBLING_SECTOR, 'Energy'].map(dotOf)).toEqual(before);
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
    // Every figure cell hands its padding and its type size back from `sm` up,
    // so the desktop cell is the one it is today.
    const figure = cellsOf(row!)[1];
    expect(figure.className).toContain('sm:px-4');
    expect(figure.className).toContain('sm:py-3');
    expect(figure.className).toContain('sm:text-sm');
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
    // EVERY `<td>`, the unclassified row's and the footer's included -- a cell
    // whose className is a template literal is exactly where this gets
    // forgotten.
    const cells = Array.from(container.querySelectorAll('table td'));
    expect(cells.length).toBe(25); // 5 rows x 5 columns
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
      'Sector',
      'Direct Value',
      'ETF Value',
      'Total Value',
      '% of Portfolio',
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

    const sectorOrder = () =>
      Array.from(container.querySelectorAll('tbody tr'))
        .map((r) => r.querySelector('td')?.textContent)
        // The unclassified row is not a sector and never sorts with them.
        .filter((label) => label !== 'Unclassified');
    // The stored default is the total, descending.
    expect(sectorOrder()).toEqual([SIBLING_SECTOR, LONG_SECTOR, 'Energy']);

    // "Sector" in the PHONE strip -- the header row that survives below `sm`,
    // identified by the class that hides it from `sm` up rather than by its
    // position, so this cannot silently fall through to the column header row.
    // Within it the control is the first of five, addressed by position because
    // the label also appears in the column header row.
    const phoneStrip = Array.from(container.querySelectorAll('thead tr')).find((r) =>
      r.className.includes('sm:hidden'),
    );
    expect(phoneStrip).toBeDefined();
    await act(async () => {
      fireEvent.click(phoneStrip!.querySelectorAll('th')[0]);
    });
    expect(sectorOrder()).toEqual(['Energy', LONG_SECTOR, SIBLING_SECTOR]);

    // A second tap reverses it, which is the escape from any sort a phone can
    // reach.
    await act(async () => {
      fireEvent.click(phoneStrip!.querySelectorAll('th')[0]);
    });
    expect(sectorOrder()).toEqual([SIBLING_SECTOR, LONG_SECTOR, 'Energy']);

    // A column the row places on a later line is still sortable from there:
    // the second control is the direct value.
    await act(async () => {
      fireEvent.click(phoneStrip!.querySelectorAll('th')[1]);
    });
    expect(sectorOrder()[0]).toBe('Energy');
  });

  it('leaves the unclassified row pinned below the sectors whatever the sort', async () => {
    const container = await renderReport();

    const lastBodyLabel = () => {
      const rows = Array.from(container.querySelectorAll('tbody tr'));
      return rows[rows.length - 1].querySelector('td')?.textContent;
    };
    expect(lastBodyLabel()).toBe('Unclassified');
    const phoneStrip = Array.from(container.querySelectorAll('thead tr')).find((r) =>
      r.className.includes('sm:hidden'),
    )!;
    for (const index of [0, 3, 4]) {
      await act(async () => {
        fireEvent.click(phoneStrip.querySelectorAll('th')[index]);
      });
      expect(lastBodyLabel()).toBe('Unclassified');
    }
  });

  it('omits the unclassified row entirely when there is nothing unclassified', async () => {
    const container = await renderReport({ ...WEIGHTINGS, unclassifiedValue: 0 });

    expect(findRow(container, 'Unclassified')).toBeUndefined();
    // Four rows of five cells, and the placements of the remaining shapes are
    // unchanged -- a conditional row is exactly what auto-flow placement would
    // have re-flowed.
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(container.querySelectorAll('table td')).toHaveLength(20);
    const expected = ['c1/r1', 'c1/r2', 'c3/r2', 'c4/r1', 'c5/r2'];
    expect(placements(container.querySelector('tbody tr')!)).toEqual(expected);
    expect(placements(container.querySelector('tfoot tr')!)).toEqual(expected);
  });

  it('leaves the rows non-clickable, as they are today', async () => {
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
    expect(container.querySelectorAll('tbody tr')).toHaveLength(4);
  });

  it('leaves the surfaces outside the table alone', async () => {
    await renderReport();

    // The filters, the summary cards and the bar chart are not part of the
    // conversion; a phone still gets all of them.
    expect(screen.getByText('Total Portfolio')).toBeInTheDocument();
    expect(screen.getByText('Direct Exposure')).toBeInTheDocument();
    expect(screen.getByText('ETF Exposure')).toBeInTheDocument();
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
  });
});
