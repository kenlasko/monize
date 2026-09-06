import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { CategoryPerformanceReport } from './CategoryPerformanceReport';
import type { Budget, CategoryTrendSeries } from '@/types/budget';

/**
 * The phone layout of the Category Performance report's table -- EIGHT
 * columns, the widest this layout has carried.
 *
 * The table is ONE tree restyled by CSS (mechanism A): below `sm` each row
 * wraps into a two-column, FOUR-line grid and the column header row is
 * replaced by a sort strip; from `sm` up it is the ordinary table. jsdom
 * applies no media queries, so both header rows and every phone caption are in
 * the DOM here at all times -- which is exactly what lets these assertions
 * read the phone markup without emulating a viewport, and why the sort
 * controls have to be addressed by position rather than by label (each label
 * matches the phone strip, the column header row, and a caption in every row).
 */

const mockGetAll = vi.fn();
const mockGetCategoryTrend = vi.fn();
const mockExportToPdf = vi.fn();

// A router of this file's own, so "clicking a row navigates nowhere" is an
// assertion about behaviour rather than about a class. Built inside the
// factory because `vi.mock` is hoisted above the const it would close over,
// and returned as one stable object, as the shared setup's router is.
const mockPush = vi.fn();
vi.mock('next/navigation', () => {
  const router = { push: mockPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() };
  return {
    useRouter: () => router,
    usePathname: () => '/reports/category-performance',
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    getCategoryTrend: (...args: any[]) => mockGetCategoryTrend(...args),
  },
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
  useNumberFormat: () => ({
    ...numberFormatMockDefaults(),
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyCompact: (n: number) => `$${Math.round(n)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
    defaultCurrency: 'USD',
  }),
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: (...args: any[]) => mockExportToPdf(...args),
}));

/**
 * The endpoint (`budgetsApi.getCategoryTrend`, served by
 * `BudgetTrendReportsService.getCategoryTrend`) sends one point per month per
 * category with the raw `budgeted` / `actual` decimals; every figure the table
 * shows is derived HERE, in the component:
 *
 *   avgBudgeted / avgActual  the mean over the returned months, through
 *                            `formatCurrencyCompact` (no decimals).
 *   avgPercent               `Math.round(avgActual / avgBudgeted * 1000) / 10`
 *                            -- ONE decimal and NO ceiling.
 *   totalVariance            the SUM of (actual - budgeted) over the months,
 *                            so it runs an order of magnitude above the
 *                            averages beside it.
 *   overCount / monthCount   months whose actual exceeded its budget.
 *   trend                    a catalogue WORD (not a glyph): the last three
 *                            months' mean percentage against the earlier
 *                            months', +/-10% wide, and the literal `--` for a
 *                            series with fewer than two points.
 *
 * The fixture therefore states the monthly points and the expectations below
 * are the derived figures, computed by hand rather than re-derived here (a
 * test that re-runs the component's own arithmetic asserts nothing).
 */
const makeSeries = (
  id: string,
  name: string,
  budgeted: number[],
  actual: number[],
): CategoryTrendSeries => ({
  categoryId: id,
  categoryName: name,
  data: budgeted.map((b, i) => ({
    month: `2025-${String(i + 1).padStart(2, '0')}`,
    budgeted: b,
    actual: actual[i],
    variance: actual[i] - b,
    percentUsed: b > 0 ? (actual[i] / b) * 100 : 0,
  })) as any,
});

const six = (n: number) => [n, n, n, n, n, n];

// Worst case for a phone: a 40-character category name (the UNBOUNDED
// identity), seven-figure averages and a six-figure variance with its sign,
// a long unbreakable Russian word, every trend variant including the `--`
// literal, and all three status pills.
const SERIES: CategoryTrendSeries[] = [
  // avgBudgeted 1234567, avgActual 1400000, 113.4% (over -> red, Over Budget),
  // variance +992598, 3/6 months over, trend Up (+54.5%).
  makeSeries(
    'c-over',
    'Groceries, Household and Personal Care Ex',
    six(1234567),
    [1000000, 1100000, 1200000, 1600000, 1700000, 1800000],
  ),
  // 90% (On Track -> amber), variance -60, 0/6 over, trend Down (-10.5%).
  makeSeries('c-on', 'Развлечения и путешествия', six(100), [95, 95, 95, 90, 85, 80]),
  // 50% (Under Budget -> green), variance -300, 0/6 over, trend Flat.
  makeSeries('c-under', 'Dining', six(100), [50, 50, 50, 50, 50, 50]),
  // A single-point series: fewer than two points, so the trend is the `--`
  // literal. 110% -> red, Over Budget, variance +10, 1/1 over.
  makeSeries('c-solo', 'Solo', [100], [110]),
];

async function renderReport() {
  mockGetAll.mockResolvedValue([{ id: 'b-1', name: 'Default', isActive: true } as Budget]);
  mockGetCategoryTrend.mockResolvedValue(SERIES);
  let container!: HTMLElement;
  await act(async () => {
    container = render(<CategoryPerformanceReport />).container;
  });
  await waitFor(() => expect(screen.getByText('Dining')).toBeInTheDocument());
  return container;
}

const tableOf = (container: HTMLElement) => container.querySelector('table')!;

const nameOrder = (table: Element) =>
  Array.from(table.querySelectorAll('tbody tr')).map((r) => r.querySelector('td')?.textContent);

const stripGlyph = (text: string | null | undefined) =>
  (text ?? '').replace(/[↑↓↕]/g, '').trim();

const EXPECTED_LABELS = [
  'Category',
  'Avg Budget',
  'Avg Actual',
  '% Used',
  'Total Variance',
  'Over/Total',
  'Trend',
  'Status',
];

/** Row 1 of the DOM (the identity), by the name it starts with. */
const rowFor = (container: HTMLElement, name: string) =>
  Array.from(container.querySelectorAll('tbody tr')).find((r) =>
    r.textContent?.startsWith(name),
  )!;

describe('CategoryPerformanceReport (phone wrapped rows)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExportToPdf.mockResolvedValue(undefined);
  });

  it('builds both header rows from one list of all eight sort fields', async () => {
    const container = await renderReport();
    const table = tableOf(container);

    const headerRows = Array.from(table.querySelectorAll('thead tr'));
    expect(headerRows).toHaveLength(2);
    const [phoneRow, columnRow] = headerRows;
    // Exactly one of the two is displayed at any width.
    expect(phoneRow.className).toContain('sm:hidden');
    expect(columnRow.className).toContain('hidden');
    expect(columnRow.className).toContain('sm:table-row');
    // Both rows are rendered from one record, so they cannot list different
    // fields -- assert it rather than trusting the loop. Every one of the
    // eight persisted sort fields has a TAPPABLE control in BOTH headers, so
    // no stored sort can leave a phone with nothing to change it by. (Reaching
    // one by keyboard is `SortableHeader`'s own pre-existing gap, shared by
    // every report table and out of scope here.)
    const labelsOf = (row: Element) =>
      Array.from(row.querySelectorAll('th')).map((th) => stripGlyph(th.textContent));
    expect(labelsOf(phoneRow)).toEqual(EXPECTED_LABELS);
    expect(labelsOf(columnRow)).toEqual(labelsOf(phoneRow));
    // Each header row carries as many controls as a data row has cells.
    const dataCells = table.querySelectorAll('tbody tr')[0].querySelectorAll('td');
    expect(dataCells).toHaveLength(EXPECTED_LABELS.length);
    expect(phoneRow.querySelectorAll('th')).toHaveLength(dataCells.length);
    expect(columnRow.querySelectorAll('th')).toHaveLength(dataCells.length);
  });

  it('sorts from the phone strip, which the column header row cannot do on a phone', async () => {
    const container = await renderReport();
    const table = tableOf(container);

    // Default sort is avgPercent desc: 113.4, 110, 90, 50.
    expect(nameOrder(table)).toEqual([
      'Groceries, Household and Personal Care Ex',
      'Solo',
      'Развлечения и путешествия',
      'Dining',
    ]);

    // Addressed by position (the phone strip is the FIRST header row) because
    // the label also names a control in the column header row and a caption in
    // every data row.
    const categoryChip = table.querySelectorAll('thead tr')[0].querySelectorAll('th')[0];
    expect(stripGlyph(categoryChip.textContent)).toBe('Category');
    await act(async () => {
      fireEvent.click(categoryChip);
    });

    // Switching field resets the direction to ascending, so the rows come back
    // in `localeCompare` order of the category name.
    expect(nameOrder(table)).toEqual([
      'Dining',
      'Groceries, Household and Personal Care Ex',
      'Solo',
      'Развлечения и путешествия',
    ]);
  });

  it('captions every figure inside the row so a phone needs no column header', async () => {
    const container = await renderReport();

    const row = rowFor(container, 'Groceries');
    // Each caption sits immediately beside the value it names, as its own text
    // node, so a `getByText` on the value still matches the value node.
    expect(row.textContent).toContain('Avg Budget$1234567');
    expect(row.textContent).toContain('Avg Actual$1400000');
    expect(row.textContent).toContain('% Used113.4%');
    expect(row.textContent).toContain('Total Variance+$992598');
    expect(row.textContent).toContain('Over/Total3/6');
    expect(row.textContent).toContain('TrendUp');

    // The category is the row's identity, not one of its figures, so it
    // carries no caption -- it is the first thing on the line and names
    // itself. The status pill names itself too.
    const cells = Array.from(row.querySelectorAll('td'));
    expect(cells[0].textContent).toBe('Groceries, Household and Personal Care Ex');
    expect(cells[0].querySelector('span')).toBeNull();
    const statusCell = cells[7];
    expect(statusCell.textContent).toBe('Over Budget');
    expect(statusCell.querySelectorAll('span')).toHaveLength(1);
    expect(statusCell.querySelector('span')?.className).not.toContain('sm:hidden');

    // Captions reuse the table's own column keys: no new catalogue string.
    for (const caption of EXPECTED_LABELS) {
      expect(screen.getAllByText(caption).length).toBeGreaterThan(0);
    }
  });

  it('places every cell on the phone grid explicitly, and never wraps a number', async () => {
    const container = await renderReport();

    // Auto-flow placement is not deterministic once a cell is added or made
    // conditional, so each cell states its own column and line. A money value
    // stays on one line: a locale grouping thousands with a space would
    // otherwise break in the middle of a number.
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(SERIES.length);
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      expect(cells).toHaveLength(8);
      for (const cell of cells) {
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
      }
      // The five cells that hold a NUMBER never wrap and are right-aligned.
      // Right alignment is not containment -- an amount past the measured
      // budget overflows the end edge -- but truncating a figure would be
      // worse. The ban is exactly as wide as its reason (a space-grouped
      // thousands separator must not split a number), so the three cells that
      // hold no number are NOT in the set: the category name, the status pill,
      // and the trend, whose value is a translated word (`Bez zmian`,
      // `A descer`) that may wrap here exactly as it does today.
      const figures = cells.filter((c) => c.className.includes('whitespace-nowrap'));
      expect(figures).toHaveLength(5);
      const trendCell = cells[6];
      expect(trendCell.className).not.toContain('whitespace-nowrap');
      expect(trendCell.className).toContain('text-right');
      expect(trendCell.className).toContain('text-xs');
      for (const cell of figures) {
        expect(cell.className).toContain('text-right');
        expect(cell.className).toContain('text-xs');
        expect(cell.className).toContain('sm:text-sm');
        // `white-space` is inherited, so the caption inside a nowrap cell has
        // to take the ban back: a caption with no break opportunity would
        // otherwise overflow its track, which is the sideways scroll this
        // layout exists to remove. A number must not break; a caption may.
        const caption = cell.querySelector('span');
        expect(caption?.className).toContain('whitespace-normal');
        expect(caption?.className).toContain('sm:hidden');
      }
      // The identity is UNBOUNDED (the server sends `Parent: Child`) and is
      // the one cell that wraps, unclamped: a clamp would cut the tail of a
      // name no other surface shows in full.
      const nameCell = cells[0];
      expect(nameCell.className).toContain('min-w-0');
      expect(nameCell.className).toContain('break-words');
      expect(nameCell.className).toContain('sm:break-normal');
      expect(nameCell.className).not.toMatch(/\b(line-clamp-\d|truncate)\b/);
    }
  });

  it('wraps each row onto four lines of two tracks, the variance beside the name', async () => {
    const container = await renderReport();

    // Line 1: category | total variance. Line 2: avg budget | avg actual.
    // Line 3: over/total | % used. Line 4: status pill | trend. DOM order is
    // the desktop column order, so the placement is read off the classes
    // rather than off position.
    const placement = (cell: Element) => {
      const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
      const row = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
      const span = /\bcol-span-(\d)\b/.exec(cell.className)?.[1] ?? '1';
      return `c${col}/r${row}/s${span}`;
    };
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const [name, budget, actual, pct, variance, over, trend, status] = Array.from(
        row.querySelectorAll('td'),
      );
      expect(row.className).toContain('grid grid-cols-2');
      expect(placement(name)).toBe('c1/r1/s1');
      expect(placement(variance)).toBe('c2/r1/s1');
      expect(placement(budget)).toBe('c1/r2/s1');
      expect(placement(actual)).toBe('c2/r2/s1');
      expect(placement(over)).toBe('c1/r3/s1');
      expect(placement(pct)).toBe('c2/r3/s1');
      expect(placement(status)).toBe('c1/r4/s1');
      expect(placement(trend)).toBe('c2/r4/s1');
      // Eight cells over two tracks is four lines exactly: nothing is placed
      // on a fifth, and no cell spans -- every caption in the catalogue fits
      // one 122px track at 320px, so none needs a spanning track.
      for (const cell of [name, budget, actual, pct, variance, over, trend, status]) {
        expect(cell.className).not.toMatch(/\brow-start-5\b/);
        expect(cell.className).not.toMatch(/\bcol-span-\d\b/);
      }
    }
  });

  it('associates every caption with the column header of the cell it sits in', async () => {
    const container = await renderReport();
    const table = tableOf(container);

    // Under mechanism A the DOM order is STILL the column order -- the grid
    // only paints -- so a swapped `<td>` would transpose two desktop columns
    // while every placement string above stayed correct. Read the association
    // rather than the placement: the Nth cell's caption must be the Nth
    // column header's label.
    const headerLabels = Array.from(
      table.querySelectorAll('thead tr')[1].querySelectorAll('th'),
    ).map((th) => stripGlyph(th.textContent));
    expect(headerLabels).toEqual(EXPECTED_LABELS);

    for (const row of Array.from(table.querySelectorAll('tbody tr'))) {
      const cells = Array.from(row.querySelectorAll('td'));
      cells.forEach((cell, i) => {
        // The identity (0) and the self-describing status pill (7) carry no
        // caption; every figure carries the caption of its own column. The
        // pill's own span is not a caption, so it is addressed by class.
        const caption = cell.querySelector('span.sm\\:hidden')?.textContent ?? null;
        expect(caption).toBe(i === 0 || i === 7 ? null : headerLabels[i]);
      });
    }
  });

  it('keeps the row a table row from sm up and a grid below it', async () => {
    const container = await renderReport();
    const table = tableOf(container);

    expect(table.className).toContain('block');
    expect(table.className).toContain('sm:table');
    expect(table.querySelector('thead')?.className).toContain('sm:table-header-group');
    expect(table.querySelector('tbody')?.className).toContain('sm:table-row-group');
    const row = table.querySelector('tbody tr');
    expect(row?.className).toContain('grid grid-cols-2');
    expect(row?.className).toContain('sm:table-row');
    // The row keeps the hairline rule it draws today, on both layouts.
    expect(row?.className).toContain('border-b border-gray-100');
    expect(row?.className).toContain('dark:border-gray-700/50');
    // The wrapper still scrolls horizontally, which is what the table needs
    // from `sm` up on a narrow desktop window.
    expect(table.parentElement?.className).toContain('overflow-x-auto');
  });

  it('restores this table’s own cell padding from sm up, header and body apart', async () => {
    const container = await renderReport();
    const table = tableOf(container);

    // The desktop output has to be what it is today, INCLUDING the asymmetry
    // between the two: header cells are `py-2`, body cells `py-2.5`, and the
    // last column (Status) drops its right padding on both. Below `sm` the
    // cells carry no padding of their own -- the row supplies it.
    for (const row of Array.from(table.querySelectorAll('tbody tr'))) {
      const cells = Array.from(row.querySelectorAll('td'));
      for (const cell of cells) {
        expect(cell.className).toContain('p-0');
        expect(cell.className).toContain('sm:py-2.5');
        expect(cell.className).not.toContain('sm:py-2 ');
      }
      for (const cell of cells.slice(0, 7)) {
        expect(cell.className).toContain('sm:pr-4');
      }
      expect(cells[7].className).not.toContain('sm:pr-4');
    }
    const headerCells = Array.from(
      table.querySelectorAll('thead tr')[1].querySelectorAll('th'),
    );
    expect(headerCells.slice(0, 7).every((th) => th.className.includes('py-2 pr-4'))).toBe(true);
    expect(headerCells[7].className).toContain('py-2 font-medium');
    expect(headerCells[7].className).not.toContain('pr-4');

    // And the two agree: "which column is last" is one decision, taken in the
    // column record, so the header cell that drops `pr-4` and the body cell
    // that drops `sm:pr-4` are the same column. Reordering the record without
    // this derivation would move one and not the other.
    const bodyCells = Array.from(table.querySelectorAll('tbody tr')[0].querySelectorAll('td'));
    const headerBare = headerCells.findIndex((th) => !th.className.includes('pr-4'));
    const bodyBare = bodyCells.findIndex((td) => !td.className.includes('sm:pr-4'));
    expect(headerBare).toBe(bodyBare);
    expect(headerBare).toBe(headerCells.length - 1);
    expect(headerCells.filter((th) => !th.className.includes('pr-4'))).toHaveLength(1);
    expect(bodyCells.filter((td) => !td.className.includes('sm:pr-4'))).toHaveLength(1);
  });

  it('restores the three centred columns’ alignment from sm up', async () => {
    const container = await renderReport();
    const table = tableOf(container);

    // Over/Total, Trend and Status are centred columns today. On a phone they
    // are right-aligned like every other value in their track (the pill takes
    // the left edge of its own track), and `sm:text-center` hands the desktop
    // alignment back -- one column at a time, so no other column moves.
    const centred = [5, 6, 7];
    for (const row of Array.from(table.querySelectorAll('tbody tr'))) {
      const cells = Array.from(row.querySelectorAll('td'));
      cells.forEach((cell, i) => {
        expect(cell.className.includes('sm:text-center')).toBe(centred.includes(i));
      });
    }
    // The column header row states the same three, through `SortableHeader`'s
    // own `align` prop.
    const headerCells = Array.from(
      table.querySelectorAll('thead tr')[1].querySelectorAll('th'),
    );
    headerCells.forEach((th, i) => {
      const justify = th.querySelector('div')?.className ?? '';
      if (centred.includes(i)) expect(justify).toContain('justify-center');
      else if (i > 0) expect(justify).toContain('justify-end');
    });
  });

  it('keeps the status pill one rectangle on a phone', async () => {
    const container = await renderReport();

    // An inline pill whose label is wider than its track splits into two
    // ragged background fragments -- visible only in a screenshot. The
    // phone-only pair below makes it an inline BLOCK capped at the track, so
    // a long label (`Au-dessus du budget`, `Melebihi Anggaran`) wraps inside
    // ONE rounded rectangle. From `sm` up the markup resolves as it does
    // today.
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const pill = Array.from(row.querySelectorAll('td'))[7].querySelector('span')!;
      expect(pill.className).toContain('max-sm:inline-block');
      expect(pill.className).toContain('max-sm:max-w-full');
      expect(pill.className).toContain('rounded');
    }
  });

  it('keeps the colouring the columns used, in the wrapped cells', async () => {
    const container = await renderReport();
    const cellAt = (name: string, selector: string) =>
      rowFor(container, name).querySelector(selector)!;

    // % used: over 100 red, over 80 amber, otherwise green -- the bands the
    // column has today, unchanged.
    expect(cellAt('Groceries', '.col-start-2.row-start-3').className).toContain('text-red-600');
    expect(cellAt('Развлечения', '.col-start-2.row-start-3').className).toContain('text-yellow-600');
    expect(cellAt('Dining', '.col-start-2.row-start-3').className).toContain('text-green-600');
    // Variance reads the opposite way round to a gain: spending MORE than the
    // budget is a positive variance and is red.
    expect(cellAt('Groceries', '.col-start-2.row-start-1').className).toContain('text-red-600');
    expect(cellAt('Dining', '.col-start-2.row-start-1').className).toContain('text-green-600');
    // The trend keeps its own three colours, including the grey of the `--`
    // a single-point series produces.
    expect(cellAt('Groceries', '.col-start-2.row-start-4').className).toContain('text-red-600');
    expect(cellAt('Развлечения', '.col-start-2.row-start-4').className).toContain('text-green-600');
    expect(cellAt('Dining', '.col-start-2.row-start-4').className).toContain('text-gray-500');
    const solo = rowFor(container, 'Solo');
    expect(solo.querySelector('.col-start-2.row-start-4')?.className).toContain('text-gray-400');
    expect(solo.querySelector('.col-start-2.row-start-4')?.textContent).toContain('--');
    // And the pill keeps its three.
    const pillClass = (name: string) =>
      rowFor(container, name).querySelector('.col-start-1.row-start-4 span')!.className;
    expect(pillClass('Groceries')).toContain('bg-red-100');
    expect(pillClass('Развлечения')).toContain('bg-yellow-100');
    expect(pillClass('Dining')).toContain('bg-green-100');
  });

  it('restores the table semantics a phone restyle strips', async () => {
    const container = await renderReport();
    const table = tableOf(container);

    expect(table.getAttribute('role')).toBe('table');
    for (const group of ['thead', 'tbody']) {
      expect(table.querySelector(group)?.getAttribute('role')).toBe('rowgroup');
    }
    for (const row of Array.from(table.querySelectorAll('tr'))) {
      expect(row.getAttribute('role')).toBe('row');
    }
    // EVERY `<td>`, including the ones whose className is a template literal.
    const cells = Array.from(table.querySelectorAll('td'));
    expect(cells.length).toBe(SERIES.length * 8);
    for (const cell of cells) {
      expect(cell.getAttribute('role')).toBe('cell');
    }
    // `SortableHeader` restates `columnheader` on the `<th>` it renders, so
    // both header rows already carry it.
    for (const th of Array.from(table.querySelectorAll('th'))) {
      expect(th.getAttribute('role')).toBe('columnheader');
    }
  });

  it('exports the columns the screen shows, in the screen’s order', async () => {
    const container = await renderReport();

    const exportBtn = await screen.findByTitle('Export PDF');
    await act(async () => {
      fireEvent.click(exportBtn);
    });
    await waitFor(() => expect(mockExportToPdf).toHaveBeenCalled());
    const { headers, rows } = mockExportToPdf.mock.calls[0][0].tableData;

    // The PDF's headings and its row cells both come from the ordered column
    // record the table renders from, so the export cannot keep the screen's
    // old column order under new headings -- the drift a hand-listed export
    // makes invisible. Assert the association rather than the literals: the
    // exported headings are the column headers, and each row is what that
    // column's cell renders on screen (its caption stripped, since the caption
    // is a phone-only element rather than part of the value).
    const columnLabels = Array.from(
      tableOf(container).querySelectorAll('thead tr')[1].querySelectorAll('th'),
    ).map((th) => stripGlyph(th.textContent));
    expect(headers).toEqual(columnLabels);

    const screenRow = rowFor(container, 'Groceries');
    const screenCells = Array.from(screenRow.querySelectorAll('td')).map((td) => {
      const caption = td.querySelector('span.sm\\:hidden')?.textContent ?? '';
      return (td.textContent ?? '').slice(caption.length);
    });
    expect(rows[0]).toEqual(screenCells);
    expect(rows[0]).toHaveLength(columnLabels.length);
  });

  it('leaves the rows inert: the card is a layout, not a new affordance', async () => {
    const container = await renderReport();

    // These rows have never been clickable, and wrapping them must not make
    // them so -- a card that looks tappable and does nothing is worse than a
    // plain row.
    //
    // Clicking is the live half of the assertion: React attaches handlers
    // synthetically and never writes an `onclick` attribute, so an added
    // `onClick` is invisible to a markup check.
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(SERIES.length);
    for (const row of rows) {
      expect(row.className).not.toContain('cursor-pointer');
      await act(async () => {
        fireEvent.click(row);
      });
    }
    expect(mockPush).not.toHaveBeenCalled();
  });
});
