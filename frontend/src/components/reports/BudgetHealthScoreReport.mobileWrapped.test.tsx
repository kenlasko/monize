import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { BudgetHealthScoreReport } from './BudgetHealthScoreReport';
import type { Budget, HealthScoreResult } from '@/types/budget';

/**
 * The phone layout of the Budget Health Score report's category impact table.
 *
 * The table is ONE tree restyled by CSS (mechanism A): below `sm` the rows wrap
 * into a two-column, two-line grid and the column header row is replaced by a
 * sort strip; from `sm` up it is the ordinary table. jsdom applies no media
 * queries, so both header rows and every phone caption are in the DOM here at
 * all times -- which is exactly what lets these assertions read the phone
 * markup without emulating a viewport, and why the sort controls have to be
 * addressed by position rather than by label (each label matches the phone
 * strip, the column header row, and -- for the two figures -- a caption).
 */

const mockGetAll = vi.fn();
const mockGetHealthScore = vi.fn();
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
    usePathname: () => '/reports/budget-health-score',
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    getHealthScore: (...args: any[]) => mockGetHealthScore(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: (...args: any[]) => mockExportToPdf(...args),
}));

vi.mock('@/components/budgets/BudgetHealthGauge', () => ({
  BudgetHealthGauge: ({ score }: { score: number }) => (
    <div data-testid="health-gauge">score={score}</div>
  ),
}));

// The worst case for a phone: a 40-character category name (the UNBOUNDED
// identity), the widest group pill in the catalogue (Uncategorized), and the
// two figures in the shapes the API really produces rather than the tidy
// integers an English fixture invites. `percentUsed` is
// `Math.round((spent / budgeted) * 10000) / 100` (two decimals, no ceiling --
// a category budgeted 10 with 12,345.678 spent is 123456.78%) and `impact` is
// `roundToDecimals(impact, 2)` bounded by its own caps to [-15, +3], so
// `-14.85` is its widest form. The percentages include 100 exactly, which is
// NOT over budget and takes the neutral colour, and 80, the boundary at which
// the under-budget bonus starts.
const LONG_NAME = 'Groceries, Household and Personal Care Ex';

const SCORE: HealthScoreResult = {
  score: 75,
  label: 'Fair',
  breakdown: {
    baseScore: 100,
    overBudgetDeductions: 20,
    underBudgetBonus: 5,
    trendBonus: 0,
    essentialWeightPenalty: 10,
  },
  categoryScores: [
    { categoryId: 'c1', categoryName: LONG_NAME, percentUsed: 123456.78, impact: -14.85, categoryGroup: 'NEED' },
    { categoryId: 'c2', categoryName: 'Misc', percentUsed: 100, impact: 0, categoryGroup: null },
    { categoryId: 'c3', categoryName: 'Savings', percentUsed: 80, impact: 2.75, categoryGroup: 'SAVING' },
  ],
};

async function renderTable() {
  mockGetAll.mockResolvedValue([{ id: 'b-1', name: 'Default', isActive: true } as Budget]);
  // A fresh object per render, so no test can carry state into the next one.
  // (`handleExportPdf` used to sort the response's `categoryScores` in place,
  // which is exactly the leak this guards against; it sorts a copy now.)
  mockGetHealthScore.mockResolvedValue({
    ...SCORE,
    categoryScores: SCORE.categoryScores.map((c) => ({ ...c })),
  });
  let container!: HTMLElement;
  await act(async () => {
    container = render(<BudgetHealthScoreReport />).container;
  });
  await waitFor(() => expect(screen.getByTestId('health-gauge')).toBeInTheDocument());
  return container;
}

const rowText = (row: Element | null | undefined) => row?.textContent ?? '';

const findRow = (container: HTMLElement, name: string) =>
  Array.from(container.querySelectorAll('tbody tr')).find((r) =>
    r.textContent?.includes(name),
  );

// The caption is `CellLabel`, whose own type class identifies it: the group
// cell holds a `<span>` too (the pill), so "the first span" is not the caption.
const captionOf = (cell: Element) =>
  Array.from(cell.querySelectorAll('span')).find((s) =>
    s.className.includes('text-[10px]'),
  ) ?? null;

const headerLabels = (container: HTMLElement, rowIndex: number) =>
  Array.from(container.querySelectorAll('thead tr')[rowIndex].querySelectorAll('th')).map(
    (th) => th.textContent?.replace(/[↑↓↕]/g, '').trim(),
  );

describe('BudgetHealthScoreReport (phone wrapped category impact table)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The sort is persisted per table, so a click in one test would otherwise
    // decide the starting order of the next.
    localStorage.clear();
    mockExportToPdf.mockResolvedValue(undefined);
  });

  it('captions every figure inside the row so a phone needs no column header', async () => {
    const container = await renderTable();

    const row = findRow(container, LONG_NAME);
    expect(row).toBeDefined();
    // Each caption sits immediately beside the value it names, as its own text
    // node, so a `getByText` on the value still matches the value node.
    expect(rowText(row)).toContain('% Used123,456.78%');
    expect(rowText(row)).toContain('Score Impact-14.85');
    // The category name is the row's identity, not one of its figures, so it
    // carries no caption -- it is the first thing on the line and names itself.
    const nameCell = row?.querySelector('td');
    expect(nameCell?.textContent).toBe(LONG_NAME);
    expect(captionOf(nameCell!)).toBeNull();
    // Captions reuse the table's own column keys: no new catalogue string.
    for (const caption of ['Category', 'Group', '% Used', 'Score Impact']) {
      expect(screen.getAllByText(caption).length).toBeGreaterThan(0);
    }
  });

  it('leaves the self-describing group pill uncaptioned and contained on a phone', async () => {
    const container = await renderTable();

    const row = findRow(container, LONG_NAME)!;
    const groupCell = Array.from(row.querySelectorAll('td'))[1];
    // A coloured group chip names itself, so it takes no caption -- captioning
    // it would repeat the word the pill already says.
    expect(captionOf(groupCell)).toBeNull();
    const pill = groupCell.querySelector('span')!;
    expect(pill.textContent).toBe('Need');
    // Its track may be 122px at 320px, narrower than the widest group label in
    // the catalogue, so on phones the pill is an inline BLOCK capped at the
    // track: the label wraps inside one rounded rectangle instead of splitting
    // into two ragged inline fragments. Both classes are phone-only, so the
    // pill resolves exactly as it does today from `sm` up.
    expect(pill.className).toContain('max-sm:inline-block');
    expect(pill.className).toContain('max-sm:max-w-full');
    // The cell it sits in may shrink below its own content, which is what
    // keeps a wide label from setting the table's minimum width.
    expect(groupCell.className).toContain('min-w-0');
  });

  it('places every cell on the phone grid explicitly, and never wraps a figure', async () => {
    const container = await renderTable();

    // Auto-flow placement is not deterministic once a cell is added or made
    // conditional, so each cell states its own column and line.
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const cells = Array.from(row.querySelectorAll('td'));
      expect(cells).toHaveLength(4);
      for (const cell of cells) {
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
      }
      // The two figure cells never wrap and are right-aligned; right alignment
      // is not containment -- a value past its track overflows the end edge --
      // but truncating a figure would be worse.
      const figures = cells.filter((c) => c.className.includes('whitespace-nowrap'));
      expect(figures).toHaveLength(2);
      for (const cell of figures) {
        expect(cell.className).toContain('text-right');
        expect(cell.className).toContain('text-xs');
        expect(cell.className).toContain('sm:text-sm');
        // `white-space` is inherited, so the caption inside a nowrap cell has
        // to take the ban back: a caption with no break opportunity would
        // otherwise overflow its track, which is the sideways scroll this
        // layout exists to remove. A figure must not break; a caption may.
        const caption = captionOf(cell);
        expect(caption?.className).toContain('whitespace-normal');
        expect(caption?.className).toContain('sm:hidden');
      }
    }
  });

  it('wraps the unbounded category name instead of clamping or truncating it', async () => {
    const container = await renderTable();

    const nameCell = findRow(container, LONG_NAME)!.querySelector('td')!;
    // A clamp would CUT the tail of a name no other surface shows in full. The
    // name sits in a `minmax(0,1fr)` track with an explicit zero minimum and
    // breaks a word too long for it; `sm:break-normal` hands today's wrapping
    // back from `sm` up.
    expect(nameCell.className).toContain('min-w-0');
    expect(nameCell.className).toContain('break-words');
    expect(nameCell.className).toContain('sm:break-normal');
    expect(nameCell.className).not.toMatch(/\bline-clamp-/);
    expect(nameCell.className).not.toContain('truncate');
    expect(nameCell.textContent).toBe(LONG_NAME);
  });

  it('wraps each row onto two lines of two tracks, the impact beside the name', async () => {
    const container = await renderTable();

    // Line 1: category | score impact. Line 2: group pill | percent used. DOM
    // order is the desktop column order, so the placement is read off the
    // classes rather than off position.
    const placement = (cell: Element) => {
      const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
      const row = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
      const span = /\bcol-span-(\d)\b/.exec(cell.className)?.[1] ?? '1';
      return `c${col}/r${row}/s${span}`;
    };
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const [name, group, pct, impact] = Array.from(row.querySelectorAll('td'));
      expect(row.className).toContain('grid grid-cols-2');
      expect(placement(name)).toBe('c1/r1/s1');
      expect(placement(impact)).toBe('c2/r1/s1');
      expect(placement(group)).toBe('c1/r2/s1');
      expect(placement(pct)).toBe('c2/r2/s1');
      // Nothing is placed on a third line.
      for (const cell of [name, group, pct, impact]) {
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
    const labels = headerLabels(container, 1);
    expect(labels).toEqual(['Category', 'Group', '% Used', 'Score Impact']);

    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const cells = Array.from(row.querySelectorAll('td'));
      cells.forEach((cell, i) => {
        const caption = captionOf(cell)?.textContent ?? null;
        // The name is the identity and the group is a self-describing pill, so
        // neither carries one; each figure carries its own column's caption.
        expect(caption).toBe(i < 2 ? null : labels[i]);
      });
    }
  });

  it('keeps the row a table row from sm up and a grid below it', async () => {
    const container = await renderTable();

    const table = container.querySelector('.overflow-x-auto table');
    expect(table?.className).toContain('block');
    expect(table?.className).toContain('sm:table');
    expect(table?.querySelector('thead')?.className).toContain('sm:table-header-group');
    expect(table?.querySelector('tbody')?.className).toContain('sm:table-row-group');
    const row = container.querySelector('tbody tr');
    expect(row?.className).toContain('grid grid-cols-2');
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
    // except the last (Score Impact), which is `py-2` alone. Below `sm` the
    // cells carry no padding of their own -- the row supplies it.
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const cells = Array.from(row.querySelectorAll('td'));
      for (const cell of cells) {
        expect(cell.className).toContain('p-0');
        expect(cell.className).toContain('sm:py-2');
      }
      const [name, group, pct, impact] = cells;
      for (const cell of [name, group, pct]) {
        expect(cell.className).toContain('sm:pr-4');
      }
      expect(impact.className).not.toContain('sm:pr-4');
    }
    // The header row is the same claim: three `pr-4` cells and a bare last one.
    const headerCells = Array.from(
      container.querySelectorAll('thead tr')[1].querySelectorAll('th'),
    );
    expect(headerCells.slice(0, 3).every((th) => th.className.includes('py-2 pr-4'))).toBe(true);
    expect(headerCells[3].className).toContain('py-2 font-medium');
    expect(headerCells[3].className).not.toContain('pr-4');
    // The two text columns keep today's explicit left alignment; the two
    // figure columns do not carry it.
    expect(headerCells[0].className).toContain('text-left');
    expect(headerCells[1].className).toContain('text-left');
    expect(headerCells[2].className).not.toContain('text-left');

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

    const table = container.querySelector('.overflow-x-auto table')!;
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
  });

  it('offers the same four sort controls on phones as in the column header', async () => {
    const container = await renderTable();

    const headerRows = Array.from(container.querySelectorAll('thead tr'));
    expect(headerRows).toHaveLength(2);
    const [phoneRow, columnRow] = headerRows;
    // Exactly one of the two is displayed at any width.
    expect(phoneRow.className).toContain('sm:hidden');
    expect(columnRow.className).toContain('hidden');
    expect(columnRow.className).toContain('sm:table-row');

    // The sort indicator glyph rides inside each control, so compare the
    // labels with it stripped. Both rows are rendered from one list, so they
    // cannot list different fields -- assert it rather than trusting the loop.
    const expected = ['Category', 'Group', '% Used', 'Score Impact'];
    expect(headerLabels(container, 0)).toEqual(expected);
    expect(headerLabels(container, 1)).toEqual(headerLabels(container, 0));
    // Each header row also carries as many controls as a data row has cells.
    const dataCells = container.querySelectorAll('tbody tr')[0].querySelectorAll('td');
    expect(phoneRow.querySelectorAll('th')).toHaveLength(dataCells.length);
    expect(columnRow.querySelectorAll('th')).toHaveLength(dataCells.length);
  });

  it('sorts from the phone strip, not only from the column header', async () => {
    const container = await renderTable();

    const nameOrder = () =>
      Array.from(container.querySelectorAll('tbody tr')).map(
        (r) => r.querySelector('td')?.textContent,
      );
    // The stored default is impact ascending.
    expect(nameOrder()).toEqual([LONG_NAME, 'Misc', 'Savings']);

    // "Category" in the phone strip: the first of the four controls in the
    // first header row. Addressed by position because the label also appears
    // in the column header row.
    const phoneCategory = container
      .querySelectorAll('thead tr')[0]
      .querySelectorAll('th')[0];
    await act(async () => {
      fireEvent.click(phoneCategory);
    });
    expect(nameOrder()).toEqual([LONG_NAME, 'Misc', 'Savings'].sort((a, b) => a.localeCompare(b)));

    // And the strip toggles direction on a second tap, as the column header
    // does -- both call the same handler.
    await act(async () => {
      fireEvent.click(phoneCategory);
    });
    expect(nameOrder()).toEqual(
      [LONG_NAME, 'Misc', 'Savings'].sort((a, b) => b.localeCompare(a)),
    );
  });

  it('keeps the sign colouring and the + prefix the columns use, in the wrapped cells', async () => {
    const container = await renderTable();

    const cellsOf = (name: string) =>
      Array.from(findRow(container, name)!.querySelectorAll('td'));
    const [, , overPct, overImpact] = cellsOf(LONG_NAME);
    const [, , evenPct, evenImpact] = cellsOf('Misc');
    const [, , underPct, underImpact] = cellsOf('Savings');

    // Over budget is red; exactly 100% is NOT over budget and stays neutral.
    expect(overPct.className).toContain('text-red-600');
    expect(overPct.textContent).toContain('123,456.78%');
    expect(evenPct.className).toContain('text-gray-600');
    expect(underPct.className).toContain('text-gray-600');

    // A positive impact is green and prefixed; a negative one is red and is
    // not; zero is neither, and takes no prefix.
    expect(underImpact.className).toContain('text-green-600');
    expect(underImpact.textContent).toContain('+2.75');
    expect(overImpact.className).toContain('text-red-600');
    expect(overImpact.textContent).toContain('-14.85');
    expect(evenImpact.className).toContain('text-gray-500');
    expect(evenImpact.textContent).not.toContain('+');
  });

  it('exports the columns the screen shows, in the screen’s order', async () => {
    const container = await renderTable();

    const exportBtn = await screen.findByTitle('Export PDF');
    await act(async () => {
      fireEvent.click(exportBtn);
    });
    await waitFor(() => expect(mockExportToPdf).toHaveBeenCalled());
    const { headers, rows } = mockExportToPdf.mock.calls[0][0].additionalTables[0];

    // The PDF's headings and its row cells both come from the ordered column
    // record the table renders from, so the export cannot keep the screen's
    // old column order under new headings -- the drift a hand-listed export
    // makes invisible. Assert the association rather than the literals: the
    // Nth exported heading is the Nth column header, and the Nth cell of a row
    // is what that column's cell renders on screen (its caption stripped,
    // since the caption is a phone-only element rather than part of the
    // value).
    const labels = headerLabels(container, 1);
    expect(headers).toEqual(labels);

    // Each column's cell text is ONE function on the record, rendered by the
    // `<td>` and by the export alike, so this compares the two call sites --
    // every row and every column, since a divergence in a single column would
    // hide behind a first-row-only check.
    const screenRows = Array.from(container.querySelectorAll('tbody tr')).map((row) =>
      Array.from(row.querySelectorAll('td')).map((td) => {
        const caption = captionOf(td)?.textContent ?? '';
        return (td.textContent ?? '').slice(caption.length);
      }),
    );
    // This export orders its rows by impact ascending, which is also the
    // stored default sort, so the exported rows are the rows on screen.
    expect(rows).toEqual(screenRows);
    expect(rows[0]).toHaveLength(labels.length);
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
    expect(rows).toHaveLength(SCORE.categoryScores.length);
    for (const row of rows) {
      expect(row.className).not.toContain('cursor-pointer');
      await act(async () => {
        fireEvent.click(row);
      });
    }
    expect(mockPush).not.toHaveBeenCalled();
  });
});
