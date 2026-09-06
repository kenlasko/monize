import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { FlexGroupAnalysisReport } from './FlexGroupAnalysisReport';
import type { Budget, FlexGroupStatus } from '@/types/budget';

/**
 * The phone layout of the Flex Group Analysis report's category breakdown
 * table -- which is drawn ONCE PER FLEX GROUP, so every claim here is made
 * about two of them at once.
 *
 * The table is ONE tree restyled by CSS (mechanism A): below `sm` each row
 * wraps into a two-column, three-line grid and the column header row is
 * replaced by a sort strip, from `sm` up it is the ordinary table. jsdom
 * applies no media queries, so both header rows and every phone caption are in
 * the DOM here at all times -- which is exactly what lets these assertions
 * read the phone markup without emulating a viewport, and why the sort
 * controls have to be addressed by position rather than by label (each label
 * matches N phone strips, N column header rows, and a caption in every row).
 */

const mockGetAll = vi.fn();
const mockGetFlexGroupStatus = vi.fn();
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
    usePathname: () => '/reports/flex-group-analysis',
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    getFlexGroupStatus: (...args: any[]) => mockGetFlexGroupStatus(...args),
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

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
  ReferenceLine: () => null,
  Tooltip: () => null,
}));

/**
 * `percentUsed` is the SERVER's figure, not a rounded integer: per category
 * `computeCategoryActuals` in `budgets.service.ts` computes
 * `Math.round((spent / budgeted) * 10000) / 100`, and `getFlexGroupStatus`
 * (in `budget-activity-reports.service.ts`) carries it through unchanged, so
 * it has two decimals and no ceiling. The fixture derives it the same way
 * rather than hardcoding a tidy `130%`, because the width budget the phone
 * layout is measured against rests on that shape.
 */
const percentUsed = (budgeted: number, spent: number) =>
  budgeted > 0 ? Math.round((spent / budgeted) * 10000) / 100 : 0;

const makeGroup = (
  groupName: string,
  categories: { id: string; name: string; budgeted: number; spent: number }[],
): FlexGroupStatus => {
  const totalBudgeted = categories.reduce((s, c) => s + c.budgeted, 0);
  const totalSpent = categories.reduce((s, c) => s + c.spent, 0);
  return {
    groupName,
    totalBudgeted,
    totalSpent,
    remaining: totalBudgeted - totalSpent,
    percentUsed: percentUsed(totalBudgeted, totalSpent),
    categories: categories.map((c) => ({
      categoryId: c.id,
      categoryName: c.name,
      budgeted: c.budgeted,
      spent: c.spent,
      percentUsed: percentUsed(c.budgeted, c.spent),
    })),
  };
};

// Worst case for a phone, in TWO groups because the page draws one table per
// group: a 40-character category name (the UNBOUNDED identity), seven-figure
// amounts, an over-budget row (negative remaining, red) and an under-budget
// one (positive, green).
const GROUPS: FlexGroupStatus[] = [
  makeGroup('Wants', [
    {
      id: 'c1',
      name: 'Groceries, Household and Personal Care Ex',
      budgeted: 1234567,
      spent: 1456789,
    },
    { id: 'c2', name: 'Books', budgeted: 100, spent: 50 },
  ]),
  makeGroup('Needs', [{ id: 'c3', name: 'Rent', budgeted: 1000, spent: 1000 }]),
];

async function renderTables() {
  mockGetAll.mockResolvedValue([{ id: 'b-1', name: 'Default', isActive: true } as Budget]);
  mockGetFlexGroupStatus.mockResolvedValue(GROUPS);
  let container!: HTMLElement;
  await act(async () => {
    container = render(<FlexGroupAnalysisReport />).container;
  });
  await waitFor(() => expect(screen.getByText('Wants')).toBeInTheDocument());
  return container;
}

/** The N per-group tables, in page order. */
const tablesOf = (container: HTMLElement) => Array.from(container.querySelectorAll('table'));

const nameOrder = (table: Element) =>
  Array.from(table.querySelectorAll('tbody tr')).map((r) => r.querySelector('td')?.textContent);

const stripGlyph = (text: string | null | undefined) =>
  (text ?? '').replace(/[↑↓↕]/g, '').trim();

const EXPECTED_LABELS = ['Category', 'Budget', 'Spent', 'Remaining', '% Used'];

describe('FlexGroupAnalysisReport (phone wrapped category tables)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExportToPdf.mockResolvedValue(undefined);
  });

  it('gives every flex group its own table and its own phone sort strip', async () => {
    const container = await renderTables();

    // The table is inside a `.map`, so the claim is about N instances, not
    // one: each group card carries a complete table with both header rows.
    const tables = tablesOf(container);
    expect(tables).toHaveLength(GROUPS.length);
    for (const table of tables) {
      const headerRows = Array.from(table.querySelectorAll('thead tr'));
      expect(headerRows).toHaveLength(2);
      const [phoneRow, columnRow] = headerRows;
      // Exactly one of the two is displayed at any width.
      expect(phoneRow.className).toContain('sm:hidden');
      expect(columnRow.className).toContain('hidden');
      expect(columnRow.className).toContain('sm:table-row');
      // Both rows are rendered from one list, so they cannot list different
      // fields -- assert it rather than trusting the loop. Each header row
      // also carries as many controls as a data row has cells.
      const labelsOf = (row: Element) =>
        Array.from(row.querySelectorAll('th')).map((th) => stripGlyph(th.textContent));
      expect(labelsOf(phoneRow)).toEqual(EXPECTED_LABELS);
      expect(labelsOf(columnRow)).toEqual(labelsOf(phoneRow));
      const dataCells = table.querySelectorAll('tbody tr')[0].querySelectorAll('td');
      expect(phoneRow.querySelectorAll('th')).toHaveLength(dataCells.length);
      expect(columnRow.querySelectorAll('th')).toHaveLength(dataCells.length);
    }
  });

  it('sorts every group from the SECOND group’s phone strip', async () => {
    const container = await renderTables();

    const [first, second] = tablesOf(container);
    expect(nameOrder(first)).toEqual(['Groceries, Household and Personal Care Ex', 'Books']);

    // The whole report shares ONE sort state -- as it does on desktop today --
    // so tapping a control in the LAST group's strip re-sorts the FIRST
    // group's rows too. Addressed by position (the first header row of the
    // second table, first control) because the label also appears in every
    // column header row and in no fewer than N captions.
    const secondGroupCategoryChip = second
      .querySelectorAll('thead tr')[0]
      .querySelectorAll('th')[0];
    expect(stripGlyph(secondGroupCategoryChip.textContent)).toBe('Category');
    await act(async () => {
      fireEvent.click(secondGroupCategoryChip);
    });

    // Ascending by name puts Books first in the group the tap did not touch.
    expect(nameOrder(first)).toEqual(['Books', 'Groceries, Household and Personal Care Ex']);
    expect(nameOrder(second)).toEqual(['Rent']);
  });

  it('captions every figure inside the row so a phone needs no column header', async () => {
    const container = await renderTables();

    const row = Array.from(container.querySelectorAll('tbody tr')).find((r) =>
      r.textContent?.includes('Groceries'),
    );
    expect(row).toBeDefined();
    // Each caption sits immediately beside the value it names, as its own text
    // node, so a `getByText` on the value still matches the value node.
    expect(row?.textContent).toContain('Budget$1234567');
    expect(row?.textContent).toContain('Spent$1456789');
    expect(row?.textContent).toContain('Remaining$-222222');
    expect(row?.textContent).toContain('% Used118%');
    // The category is the row's identity, not one of its figures, so it
    // carries no caption -- it is the first thing on the line and names
    // itself.
    const nameCell = row?.querySelector('td');
    expect(nameCell?.textContent).toBe('Groceries, Household and Personal Care Ex');
    expect(nameCell?.querySelector('span')).toBeNull();
    // Captions reuse the table's own column keys: no new catalogue string.
    for (const caption of EXPECTED_LABELS) {
      expect(screen.getAllByText(caption).length).toBeGreaterThan(0);
    }
  });

  it('places every cell on the phone grid explicitly, and never wraps a number', async () => {
    const container = await renderTables();

    // Auto-flow placement is not deterministic once a cell is added or made
    // conditional, so each cell states its own column and line. A money value
    // stays on one line: a locale grouping thousands with a space would
    // otherwise break in the middle of a number.
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(GROUPS.reduce((n, g) => n + g.categories.length, 0));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      expect(cells).toHaveLength(5);
      for (const cell of cells) {
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
      }
      // The four figure cells never wrap and are right-aligned; only the
      // category name may wrap. Right alignment is not containment -- an
      // amount past the measured budget overflows the end edge -- but
      // truncating a figure would be worse.
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
      // The identity is UNBOUNDED and is the one cell that wraps, unclamped:
      // a clamp would cut the tail of a name no other surface shows in full.
      const nameCell = cells[0];
      expect(nameCell.className).toContain('min-w-0');
      expect(nameCell.className).toContain('break-words');
      expect(nameCell.className).toContain('sm:break-normal');
      expect(nameCell.className).not.toMatch(/\b(line-clamp-\d|truncate)\b/);
    }
  });

  it('wraps each row onto three lines of two tracks, what is left beside the name', async () => {
    const container = await renderTables();

    // Line 1: category | remaining. Line 2: budget | spent. Line 3: percent
    // used, under the spend it is a share of. DOM order is the desktop column
    // order, so the placement is read off the classes rather than off
    // position.
    const placement = (cell: Element) => {
      const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
      const row = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
      const span = /\bcol-span-(\d)\b/.exec(cell.className)?.[1] ?? '1';
      return `c${col}/r${row}/s${span}`;
    };
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const [name, budget, spent, remaining, pct] = Array.from(row.querySelectorAll('td'));
      expect(row.className).toContain('grid grid-cols-2');
      expect(placement(name)).toBe('c1/r1/s1');
      expect(placement(remaining)).toBe('c2/r1/s1');
      expect(placement(budget)).toBe('c1/r2/s1');
      expect(placement(spent)).toBe('c2/r2/s1');
      expect(placement(pct)).toBe('c2/r3/s1');
      // Nothing is placed on a fourth line, and no cell spans: every caption
      // in the catalogue fits one track at 320px, so none needs one.
      for (const cell of [name, budget, spent, remaining, pct]) {
        expect(cell.className).not.toMatch(/\brow-start-4\b/);
        expect(cell.className).not.toMatch(/\bcol-span-\d\b/);
      }
    }
  });

  it('associates every caption with the column header of the cell it sits in', async () => {
    const container = await renderTables();

    // Under mechanism A the DOM order is STILL the column order -- the grid
    // only paints -- so a swapped `<td>` would transpose two desktop columns
    // while every placement string above stayed correct. Read the association
    // rather than the placement, in EVERY group's table: the Nth cell's
    // caption must be the Nth column header's label.
    for (const table of tablesOf(container)) {
      const headerLabels = Array.from(
        table.querySelectorAll('thead tr')[1].querySelectorAll('th'),
      ).map((th) => stripGlyph(th.textContent));
      expect(headerLabels).toEqual(EXPECTED_LABELS);

      for (const row of Array.from(table.querySelectorAll('tbody tr'))) {
        const cells = Array.from(row.querySelectorAll('td'));
        cells.forEach((cell, i) => {
          const caption = cell.querySelector('span')?.textContent ?? null;
          // The category is the identity and carries none; every figure
          // carries the caption of its own column.
          expect(caption).toBe(i === 0 ? null : headerLabels[i]);
        });
      }
    }
  });

  it('keeps the row a table row from sm up and a grid below it', async () => {
    const container = await renderTables();

    for (const table of tablesOf(container)) {
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
    }
  });

  it('restores this table’s own cell padding from sm up, per cell', async () => {
    const container = await renderTables();

    // The desktop output has to be what it is today: `py-2 pr-4` on every cell
    // except the last (% Used), which is `py-2` alone. Below `sm` the cells
    // carry no padding of their own -- the row supplies it.
    for (const table of tablesOf(container)) {
      for (const row of Array.from(table.querySelectorAll('tbody tr'))) {
        const cells = Array.from(row.querySelectorAll('td'));
        for (const cell of cells) {
          expect(cell.className).toContain('p-0');
          expect(cell.className).toContain('sm:py-2');
        }
        for (const cell of cells.slice(0, 4)) {
          expect(cell.className).toContain('sm:pr-4');
        }
        expect(cells[4].className).not.toContain('sm:pr-4');
      }
      // The header row is the same claim: four `pr-4` cells and a bare last.
      const headerCells = Array.from(
        table.querySelectorAll('thead tr')[1].querySelectorAll('th'),
      );
      expect(headerCells.slice(0, 4).every((th) => th.className.includes('py-2 pr-4'))).toBe(true);
      expect(headerCells[4].className).toContain('py-2 font-medium');
      expect(headerCells[4].className).not.toContain('pr-4');

      // And the two agree: "which column is last" is one decision, taken in
      // the column record, so the header cell that drops `pr-4` and the body
      // cell that drops `sm:pr-4` are the same column. Reordering the record
      // without this derivation would move one and not the other.
      const bodyCells = Array.from(
        table.querySelectorAll('tbody tr')[0].querySelectorAll('td'),
      );
      const headerBare = headerCells.findIndex((th) => !th.className.includes('pr-4'));
      const bodyBare = bodyCells.findIndex((td) => !td.className.includes('sm:pr-4'));
      expect(headerBare).toBe(bodyBare);
      expect(headerBare).toBe(headerCells.length - 1);
      // Exactly one column drops it, on each side.
      expect(headerCells.filter((th) => !th.className.includes('pr-4'))).toHaveLength(1);
      expect(bodyCells.filter((td) => !td.className.includes('sm:pr-4'))).toHaveLength(1);
    }
  });

  it('restores the table semantics a phone restyle strips', async () => {
    const container = await renderTables();

    for (const table of tablesOf(container)) {
      expect(table.getAttribute('role')).toBe('table');
      for (const group of ['thead', 'tbody']) {
        expect(table.querySelector(group)?.getAttribute('role')).toBe('rowgroup');
      }
      for (const row of Array.from(table.querySelectorAll('tr'))) {
        expect(row.getAttribute('role')).toBe('row');
      }
      // EVERY `<td>`, including the ones whose className is a template literal.
      const cells = Array.from(table.querySelectorAll('td'));
      expect(cells.length).toBeGreaterThan(0);
      for (const cell of cells) {
        expect(cell.getAttribute('role')).toBe('cell');
      }
      // `SortableHeader` restates `columnheader` on the `<th>` it renders, so
      // both header rows already carry it.
      for (const th of Array.from(table.querySelectorAll('th'))) {
        expect(th.getAttribute('role')).toBe('columnheader');
      }
    }
  });

  it('keeps the sign colouring the columns used, in the wrapped cells', async () => {
    const container = await renderTables();

    const rowFor = (name: string) =>
      Array.from(container.querySelectorAll('tbody tr')).find((r) =>
        r.textContent?.startsWith(name),
      );
    // Over budget leaves a negative remainder (red) and a percent past 100
    // (also red); under budget is green on both.
    const over = rowFor('Groceries');
    expect(over?.querySelector('.col-start-2.row-start-1')?.className).toContain('text-red-600');
    expect(over?.querySelector('.col-start-2.row-start-3')?.className).toContain('text-red-600');
    const under = rowFor('Books');
    expect(under?.querySelector('.col-start-2.row-start-1')?.className).toContain('text-green-600');
    expect(under?.querySelector('.col-start-2.row-start-3')?.className).toContain('text-green-600');
    // Exactly on budget: nothing is left (zero is not a loss, so green) and
    // 100% is not "over" -- the amber band starts above 80 and the red one
    // above 100, which is the behaviour the columns have today.
    const exact = rowFor('Rent');
    expect(exact?.querySelector('.col-start-2.row-start-1')?.className).toContain('text-green-600');
    expect(exact?.querySelector('.col-start-2.row-start-3')?.className).toContain('text-yellow-600');
  });

  it('exports the columns the screen shows, in the screen’s order', async () => {
    const container = await renderTables();

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
    // exported headings are the group name followed by the Nth column header,
    // and each row is the group name followed by what that column's cell
    // renders on screen (its caption stripped, since the caption is a
    // phone-only element rather than part of the value).
    const columnLabels = Array.from(
      tablesOf(container)[0].querySelectorAll('thead tr')[1].querySelectorAll('th'),
    ).map((th) => stripGlyph(th.textContent));
    expect(headers).toEqual(['Group', ...columnLabels]);

    const screenRow = Array.from(container.querySelectorAll('tbody tr')).find((r) =>
      r.textContent?.startsWith('Groceries'),
    )!;
    const screenCells = Array.from(screenRow.querySelectorAll('td')).map((td) => {
      const caption = td.querySelector('span')?.textContent ?? '';
      return (td.textContent ?? '').slice(caption.length);
    });
    // Rows are exported in the order the server sent them, which is what this
    // export has always done; the claim under test is the COLUMN order.
    expect(rows[0]).toEqual(['Wants', ...screenCells]);
    expect(rows[0]).toHaveLength(columnLabels.length + 1);
  });

  it('leaves the rows inert: the card is a layout, not a new affordance', async () => {
    const container = await renderTables();

    // These rows have never been clickable, and wrapping them must not make
    // them so -- a card that looks tappable and does nothing is worse than a
    // plain row.
    //
    // Clicking is the live half of the assertion: React attaches handlers
    // synthetically and never writes an `onclick` attribute, so an added
    // `onClick` is invisible to a markup check.
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(GROUPS.reduce((n, g) => n + g.categories.length, 0));
    for (const row of rows) {
      expect(row.className).not.toContain('cursor-pointer');
      await act(async () => {
        fireEvent.click(row);
      });
    }
    expect(mockPush).not.toHaveBeenCalled();
  });
});
