import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { BudgetVsActualReport } from './BudgetVsActualReport';
import type { Budget, BudgetTrendPoint, CategoryTrendSeries } from '@/types/budget';

/**
 * The phone layout of the Budget vs Actual report's summary table (the
 * `overview` view mode).
 *
 * The table is ONE tree restyled by CSS (mechanism A): below `sm` the rows wrap
 * into a three-column, two-line grid and the column header row is replaced by a
 * sort strip, from `sm` up it is the ordinary table. jsdom applies no media
 * queries, so both header rows and every phone caption are in the DOM here at
 * all times -- which is exactly what lets these assertions read the phone
 * markup without emulating a viewport, and why the sort controls have to be
 * addressed by position rather than by label (each label matches the phone
 * strip, the column header row, and a caption).
 */

const mockGetAll = vi.fn();
const mockGetTrend = vi.fn();
const mockGetCategoryTrend = vi.fn();

// A router of this file's own, so "clicking a row navigates nowhere" is an
// assertion about behaviour rather than about a class. Built inside the
// factory because `vi.mock` is hoisted above the const it would close over,
// and returned as one stable object, as the shared setup's router is.
const mockPush = vi.fn();
vi.mock('next/navigation', () => {
  const router = { push: mockPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() };
  return {
    useRouter: () => router,
    usePathname: () => '/reports/budget-vs-actual',
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    getTrend: (...args: any[]) => mockGetTrend(...args),
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

const mockExportToPdf = vi.fn();
vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: (...args: any[]) => mockExportToPdf(...args),
}));

vi.mock('@/components/budgets/BudgetCategoryTrend', () => ({
  BudgetCategoryTrend: ({ data }: { data: CategoryTrendSeries[] }) => (
    <div data-testid="cat-trend">categories={data.length}</div>
  ),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  LineChart: ({ children }: any) => <div data-testid="line-chart">{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
  Tooltip: () => null,
}));

const makePoint = (month: string, budgeted: number, actual: number): BudgetTrendPoint => ({
  month,
  budgeted,
  actual,
  variance: actual - budgeted,
  percentUsed: budgeted > 0 ? Math.round((actual / budgeted) * 100) : 0,
});

// Worst case for a phone: seven-figure budgeted and actual figures, one month
// over budget (a positive variance, red, and the `+` prefix) and one under
// (negative, green), plus a month at exactly 100%.
//
// The month labels are the shape the API really sends -- a three-letter
// English month and a four-digit year, from `formatPeriodMonth` in
// `backend/src/budgets/budget-trend-reports.service.ts`, not an ISO
// `YYYY-MM`. That matters here rather than being pedantry: the phone layout
// gives the month an `auto` grid track precisely because that label is bounded
// and short, so a fixture in another format would not exercise the assumption
// the whole track budget rests on.
//
// The three are chosen so their chronological and alphabetical orders agree.
// `compareValues` sorts this column as a STRING, which for these labels is
// alphabetical by English month name -- a real, pre-existing defect (a
// 12-month trend sorts Apr, Aug, Dec, Feb, ...) that this layout change
// neither introduces nor fixes; the fixture simply does not lean on it.
const POINTS: BudgetTrendPoint[] = [
  makePoint('Jan 2025', 1234567, 1439000), // over budget
  makePoint('Jun 2025', 123456, 98765), // under budget
  makePoint('Nov 2025', 200000, 200000), // exactly on budget: 100%, variance 0
];

async function renderTable() {
  mockGetAll.mockResolvedValue([{ id: 'b-1', name: 'Default', isActive: true } as Budget]);
  mockGetTrend.mockResolvedValue(POINTS);
  mockGetCategoryTrend.mockResolvedValue([]);
  let container!: HTMLElement;
  await act(async () => {
    container = render(<BudgetVsActualReport />).container;
  });
  await waitFor(() => expect(screen.getByTestId('bar-chart')).toBeInTheDocument());
  return container;
}

const rowText = (row: Element | null | undefined) => row?.textContent ?? '';

const findRow = (container: HTMLElement, month: string) =>
  Array.from(container.querySelectorAll('tbody tr')).find((r) =>
    r.textContent?.includes(month),
  );

describe('BudgetVsActualReport (phone wrapped summary table)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captions every figure inside the row so a phone needs no column header', async () => {
    const container = await renderTable();

    const row = findRow(container, 'Jan 2025');
    expect(row).toBeDefined();
    // Each caption sits immediately beside the value it names, as its own text
    // node, so a `getByText` on the value still matches the value node.
    expect(rowText(row)).toContain('Budgeted$1234567');
    expect(rowText(row)).toContain('Actual$1439000');
    expect(rowText(row)).toContain('Variance+$204433');
    expect(rowText(row)).toContain('% Used117%');
    // The month is the row's identity, not one of its figures, so it carries
    // no caption -- it is the first thing on the line and names itself.
    const monthCell = row?.querySelector('td');
    expect(monthCell?.textContent).toBe('Jan 2025');
    expect(monthCell?.querySelector('span')).toBeNull();
    // Captions reuse the table's own column keys: no new catalogue string.
    for (const caption of ['Month', 'Budgeted', 'Actual', 'Variance', '% Used']) {
      expect(screen.getAllByText(caption).length).toBeGreaterThan(0);
    }
  });

  it('places every cell on the phone grid explicitly, and never wraps a number', async () => {
    const container = await renderTable();

    // Auto-flow placement is not deterministic once a cell is added or made
    // conditional, so each cell states its own column and line. A money value
    // stays on one line: a locale grouping thousands with a space would
    // otherwise break in the middle of a number.
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const cells = Array.from(row.querySelectorAll('td'));
      expect(cells).toHaveLength(5);
      for (const cell of cells) {
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
      }
      // The four figure cells never wrap and are right-aligned; only the month
      // may wrap. Right alignment is not containment -- an amount past the
      // measured budget overflows the end edge -- but truncating a figure
      // would be worse.
      const money = cells.filter((c) => c.className.includes('whitespace-nowrap'));
      expect(money).toHaveLength(4);
      for (const cell of money) {
        expect(cell.className).toContain('text-right');
        // `white-space` is inherited, so the caption inside a nowrap cell has
        // to take the ban back: a caption with no space in it would otherwise
        // be unbreakable and overflow its track, which is the sideways scroll
        // this layout exists to remove. A number must not break; a caption may.
        const caption = cell.querySelector('span');
        expect(caption?.className).toContain('whitespace-normal');
        expect(caption?.className).toContain('sm:hidden');
      }
    }
  });

  it('wraps each row onto two lines of three tracks, the variance beside the month', async () => {
    const container = await renderTable();

    // Line 1: month | variance | actual. Line 2: budgeted (spanning the first
    // two tracks, because its caption is the one in the catalogue that neither
    // fits nor breaks in a third-width track) | percent used. DOM order is the
    // desktop column order, so the placement is read off the classes rather
    // than off position.
    const placement = (cell: Element) => {
      const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
      const row = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
      const span = /\bcol-span-(\d)\b/.exec(cell.className)?.[1] ?? '1';
      return `c${col}/r${row}/s${span}`;
    };
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const [month, budgeted, actual, variance, pct] = Array.from(row.querySelectorAll('td'));
      expect(row.className).toContain('grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]');
      expect(placement(month)).toBe('c1/r1/s1');
      expect(placement(variance)).toBe('c2/r1/s1');
      expect(placement(actual)).toBe('c3/r1/s1');
      expect(placement(budgeted)).toBe('c1/r2/s2');
      expect(placement(pct)).toBe('c3/r2/s1');
      // Nothing is placed on a third line.
      for (const cell of [month, budgeted, actual, variance, pct]) {
        expect(cell.className).not.toMatch(/\brow-start-3\b/);
      }
    }
  });

  it('associates every caption with the column header of the cell it sits in', async () => {
    const container = await renderTable();

    // Under mechanism A the DOM order is STILL the column order -- the grid
    // only paints -- so a swapped `<td>` would transpose two desktop columns
    // while every placement string above stayed correct. Read the association
    // rather than the placement: the Nth cell's caption must be the Nth
    // column header's label.
    const headerLabels = Array.from(
      container.querySelectorAll('thead tr')[1].querySelectorAll('th'),
    ).map((th) => th.textContent?.replace(/[↑↓↕]/g, '').trim());
    expect(headerLabels).toEqual(['Month', 'Budgeted', 'Actual', 'Variance', '% Used']);

    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const cells = Array.from(row.querySelectorAll('td'));
      cells.forEach((cell, i) => {
        const caption = cell.querySelector('span')?.textContent ?? null;
        // The month is the identity and carries none; every figure carries the
        // caption of its own column.
        expect(caption).toBe(i === 0 ? null : headerLabels[i]);
      });
    }
  });

  it('keeps the row a table row from sm up and a grid below it', async () => {
    const container = await renderTable();

    const table = container.querySelector('table');
    expect(table?.className).toContain('block');
    expect(table?.className).toContain('sm:table');
    expect(container.querySelector('thead')?.className).toContain('sm:table-header-group');
    expect(container.querySelector('tbody')?.className).toContain('sm:table-row-group');
    const row = container.querySelector('tbody tr');
    expect(row?.className).toContain('grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]');
    expect(row?.className).toContain('sm:table-row');
    // The row keeps the hairline rule it draws today, on both layouts.
    expect(row?.className).toContain('border-b border-gray-100');
    expect(row?.className).toContain('dark:border-gray-700/50');
    // The wrapper still scrolls horizontally, which is what the table needs
    // from `sm` up on a narrow desktop window.
    expect(table?.parentElement?.className).toContain('overflow-x-auto');
  });

  it('restores this table’s own cell padding from sm up, per cell', async () => {
    const container = await renderTable();

    // The desktop output has to be what it is today: `py-2 pr-4` on every cell
    // except the last (% Used), which is `py-2` alone. Below `sm` the cells
    // carry no padding of their own -- the row supplies it.
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const cells = Array.from(row.querySelectorAll('td'));
      for (const cell of cells) {
        expect(cell.className).toContain('p-0');
        expect(cell.className).toContain('sm:py-2');
      }
      const [month, budgeted, actual, variance, pct] = cells;
      for (const cell of [month, budgeted, actual, variance]) {
        expect(cell.className).toContain('sm:pr-4');
      }
      expect(pct.className).not.toContain('sm:pr-4');
    }
    // The header row is the same claim: four `pr-4` cells and a bare last one.
    const headerCells = Array.from(
      container.querySelectorAll('thead tr')[1].querySelectorAll('th'),
    );
    expect(headerCells.slice(0, 4).every((th) => th.className.includes('py-2 pr-4'))).toBe(true);
    expect(headerCells[4].className).toContain('py-2 font-medium');
    expect(headerCells[4].className).not.toContain('pr-4');

    // And the two agree: "which column is last" is one decision, taken in the
    // column record, so the header cell that drops `pr-4` and the body cell
    // that drops `sm:pr-4` are the same column. Reordering the record without
    // this derivation would move one and not the other.
    const bodyCells = Array.from(
      container.querySelectorAll('tbody tr')[0].querySelectorAll('td'),
    );
    const headerBare = headerCells.findIndex((th) => !th.className.includes('pr-4'));
    const bodyBare = bodyCells.findIndex((td) => !td.className.includes('sm:pr-4'));
    expect(headerBare).toBe(bodyBare);
    expect(headerBare).toBe(headerCells.length - 1);
    // Exactly one column drops it, on each side.
    expect(headerCells.filter((th) => !th.className.includes('pr-4'))).toHaveLength(1);
    expect(bodyCells.filter((td) => !td.className.includes('sm:pr-4'))).toHaveLength(1);
  });

  it('restores the table semantics a phone restyle strips', async () => {
    const container = await renderTable();

    const table = container.querySelector('table');
    expect(table?.getAttribute('role')).toBe('table');
    for (const group of ['thead', 'tbody']) {
      expect(container.querySelector(group)?.getAttribute('role')).toBe('rowgroup');
    }
    for (const row of Array.from(container.querySelectorAll('tr'))) {
      expect(row.getAttribute('role')).toBe('row');
    }
    // EVERY `<td>`, including the ones whose className is a template literal.
    const cells = Array.from(container.querySelectorAll('td'));
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.getAttribute('role')).toBe('cell');
    }
    // `SortableHeader` restates `columnheader` on the `<th>` it renders, so
    // both header rows already carry it.
    for (const th of Array.from(container.querySelectorAll('th'))) {
      expect(th.getAttribute('role')).toBe('columnheader');
    }
  });

  it('offers the same five sort controls on phones as in the column header', async () => {
    const container = await renderTable();

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
    const expected = ['Month', 'Budgeted', 'Actual', 'Variance', '% Used'];
    expect(labelsOf(phoneRow)).toEqual(expected);
    // Both rows are rendered from one list, so they cannot list different
    // fields -- assert it rather than trusting the loop. Each header row also
    // carries as many controls as a data row has cells.
    expect(labelsOf(columnRow)).toEqual(labelsOf(phoneRow));
    const dataCells = container.querySelectorAll('tbody tr')[0].querySelectorAll('td');
    expect(phoneRow.querySelectorAll('th')).toHaveLength(dataCells.length);
    expect(columnRow.querySelectorAll('th')).toHaveLength(dataCells.length);
  });

  it('sorts from the phone strip, not only from the column header', async () => {
    const container = await renderTable();

    const monthOrder = () =>
      Array.from(container.querySelectorAll('tbody tr')).map(
        (r) => r.querySelector('td')?.textContent,
      );
    expect(monthOrder()).toEqual(['Jan 2025', 'Jun 2025', 'Nov 2025']);

    // "Variance" in the phone strip: the fourth of the five controls in the
    // first header row. Addressed by position because the label also appears
    // in the column header row and in every caption.
    const phoneVariance = container
      .querySelectorAll('thead tr')[0]
      .querySelectorAll('th')[3];
    await act(async () => {
      fireEvent.click(phoneVariance);
    });
    // Ascending by variance puts June's -24,691 first, then November's 0.
    expect(monthOrder()).toEqual(['Jun 2025', 'Nov 2025', 'Jan 2025']);
  });

  it('keeps the sign colouring and the + prefix the column used, in the wrapped cell', async () => {
    const container = await renderTable();

    const varianceOf = (month: string) =>
      findRow(container, month)?.querySelector('.col-start-2.row-start-1');
    // Over budget is red and prefixed; under budget is green and is not.
    expect(varianceOf('Jan 2025')?.className).toContain('text-red-600');
    expect(varianceOf('Jan 2025')?.textContent).toContain('+$204433');
    expect(varianceOf('Jun 2025')?.className).toContain('text-green-600');
    expect(varianceOf('Jun 2025')?.textContent).toContain('$-24691');
    // Exactly on budget is not "over": zero takes the green branch and no
    // prefix, which is the behaviour the column has today.
    expect(varianceOf('Nov 2025')?.className).toContain('text-green-600');
    expect(varianceOf('Nov 2025')?.textContent).not.toContain('+');
  });

  it('exports the columns the screen shows, in the screen’s order', async () => {
    mockExportToPdf.mockResolvedValue(undefined);
    const container = await renderTable();

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
    // Nth exported heading is the Nth column header, and the Nth cell of a row
    // is what that column's cell renders on screen (its caption stripped,
    // since the caption is a phone-only element rather than part of the value).
    const columnLabels = Array.from(
      container.querySelectorAll('thead tr')[1].querySelectorAll('th'),
    ).map((th) => th.textContent?.replace(/[↑↓↕]/g, '').trim());
    expect(headers).toEqual(columnLabels);

    const screenRow = findRow(container, 'Jan 2025')!;
    const screenCells = Array.from(screenRow.querySelectorAll('td')).map((td) => {
      const caption = td.querySelector('span')?.textContent ?? '';
      return (td.textContent ?? '').slice(caption.length);
    });
    // Rows are exported in the order the server sent them, which is what this
    // export has always done; the claim under test is the COLUMN order.
    expect(rows[0]).toEqual(screenCells);
    expect(rows[0]).toHaveLength(columnLabels.length);
  });

  it('leaves the rows inert: the card is a layout, not a new affordance', async () => {
    const container = await renderTable();

    // These rows have never been clickable, and wrapping them must not make
    // them so -- a card that looks tappable and does nothing is worse than a
    // plain row.
    //
    // Clicking is the live half of the assertion: React attaches handlers
    // synthetically and never writes an `onclick` attribute, so an added
    // `onClick` is invisible to a markup check.
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(POINTS.length);
    for (const row of rows) {
      expect(row.className).not.toContain('cursor-pointer');
      await act(async () => {
        fireEvent.click(row);
      });
    }
    expect(mockPush).not.toHaveBeenCalled();
  });
});
