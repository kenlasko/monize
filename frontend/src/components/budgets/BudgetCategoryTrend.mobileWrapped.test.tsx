import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { BudgetCategoryTrend } from './BudgetCategoryTrend';
import type { CategoryTrendSeries } from '@/types/budget';

/**
 * The phone layout of the Category Trends card's per-category averages table.
 *
 * The table is ONE tree restyled by CSS (mechanism A): below `sm` the rows wrap
 * into a two-column, two-line grid and the column header row is hidden, from
 * `sm` up it is the ordinary table. jsdom applies no media queries, so the
 * header row and every phone caption are in the DOM here at all times, which is
 * what lets these assertions read the phone markup without emulating a
 * viewport.
 *
 * This header holds no controls -- the four `<th>`s are plain labels and the
 * table sorts at no width -- so there is deliberately NO phone sort strip to
 * assert; "the header is hidden and nothing replaces it" is the claim, and one
 * of the tests below makes it.
 */

const mockPush = vi.fn();
vi.mock('next/navigation', () => {
  const router = { push: mockPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() };
  return {
    useRouter: () => router,
    usePathname: () => '/reports/budget-vs-actual',
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock('recharts', () => ({
  LineChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="line-chart">{children}</div>
  ),
  Line: ({ name }: { name: string }) => <div data-testid={`line-${name}`} />,
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: () => <div data-testid="y-axis" />,
  CartesianGrid: () => <div data-testid="grid" />,
  Tooltip: () => <div data-testid="tooltip" />,
  Legend: () => <div data-testid="legend" />,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
}));

// The compact formatter this card is handed on the report page: no decimals.
const formatCurrency = (amount: number) => `$${Math.round(amount)}`;

// Worst case for a phone: a 40-character category name (the identity is
// UNBOUNDED), a name whose longest word cannot fit the 122px track at 320px,
// seven-figure averages, and both signs of variance.
const LONG_NAME = 'Groceries, Household and Personal Care Ex';
const UNBREAKABLE_NAME = 'Развлечения и путешествия';

const DATA: CategoryTrendSeries[] = [
  {
    categoryId: 'cat-1',
    categoryName: LONG_NAME,
    data: [{ month: 'Jan 2026', budgeted: 1234567, actual: 1439000, variance: 204433, percentUsed: 117 }],
  },
  {
    categoryId: 'cat-2',
    categoryName: UNBREAKABLE_NAME,
    data: [{ month: 'Jan 2026', budgeted: 123456, actual: 98765, variance: -24691, percentUsed: 80 }],
  },
  {
    // A series with no points: both averages are a known zero, not unknown.
    categoryId: 'cat-3',
    categoryName: 'Dining',
    data: [],
  },
];

const renderTable = () =>
  render(<BudgetCategoryTrend data={DATA} formatCurrency={formatCurrency} />).container;

const rowFor = (container: HTMLElement, name: string) =>
  Array.from(container.querySelectorAll('tbody tr')).find((r) =>
    r.textContent?.includes(name),
  );

describe('BudgetCategoryTrend (phone wrapped averages table)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captions every figure inside the row so a phone needs no column header', async () => {
    const container = renderTable();

    const row = rowFor(container, LONG_NAME);
    expect(row).toBeDefined();
    // Each caption sits immediately beside the value it names, as its own
    // element, so a `getByText` on the value still matches the value node.
    expect(row?.textContent).toContain('Avg Budget$1234567');
    expect(row?.textContent).toContain('Avg Actual$1439000');
    expect(row?.textContent).toContain('Avg Variance+$204433');
    // The category name is the row's identity, not one of its figures, so it
    // carries no caption.
    const nameCell = row?.querySelector('td');
    expect(nameCell?.textContent).toBe(LONG_NAME);
    expect(nameCell?.querySelector('span')).toBeNull();
    // Captions reuse this table's own header keys: no new catalogue string.
    for (const caption of ['Avg Budget', 'Avg Actual', 'Avg Variance']) {
      expect(screen.getAllByText(caption).length).toBeGreaterThan(0);
    }
  });

  it('places every cell on the phone grid explicitly, and never wraps a number', async () => {
    const container = renderTable();

    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const cells = Array.from(row.querySelectorAll('td'));
      expect(cells).toHaveLength(4);
      for (const cell of cells) {
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
      }
      // The three figure cells never wrap and are right-aligned; only the
      // category name may wrap.
      const money = cells.filter((c) => c.className.includes('whitespace-nowrap'));
      expect(money).toHaveLength(3);
      for (const cell of money) {
        expect(cell.className).toContain('text-right');
        // `white-space` is inherited, so the caption inside a nowrap cell has
        // to take the ban back, or an unbreakable caption overflows its track.
        const caption = cell.querySelector('span');
        expect(caption?.className).toContain('whitespace-normal');
        expect(caption?.className).toContain('sm:hidden');
      }
    }
  });

  it('wraps each row onto two lines of two tracks, the variance beside the name', async () => {
    const container = renderTable();

    // Line 1: category | avg variance. Line 2: avg budget | avg actual. DOM
    // order is the desktop column order, so the placement is read off the
    // classes rather than off position.
    const placement = (cell: Element) => {
      const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
      const row = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
      return `c${col}/r${row}`;
    };
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const [name, budget, actual, variance] = Array.from(row.querySelectorAll('td'));
      expect(row.className).toContain('grid-cols-2');
      expect(placement(name)).toBe('c1/r1');
      expect(placement(variance)).toBe('c2/r1');
      expect(placement(budget)).toBe('c1/r2');
      expect(placement(actual)).toBe('c2/r2');
      // Nothing is placed on a third line, and nothing spans.
      for (const cell of [name, budget, actual, variance]) {
        expect(cell.className).not.toMatch(/\brow-start-3\b/);
        expect(cell.className).not.toMatch(/\bcol-span-\d\b/);
      }
    }
  });

  it('associates every caption with the column header of the cell it sits in', async () => {
    const container = renderTable();

    // Under mechanism A the DOM order is STILL the column order -- the grid
    // only paints -- so a swapped `<td>` would transpose two desktop columns
    // while every placement string above stayed correct.
    const headerLabels = Array.from(
      container.querySelectorAll('thead th'),
    ).map((th) => th.textContent);
    expect(headerLabels).toEqual(['Category', 'Avg Budget', 'Avg Actual', 'Avg Variance']);

    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const cells = Array.from(row.querySelectorAll('td'));
      cells.forEach((cell, i) => {
        const caption = cell.querySelector('span')?.textContent ?? null;
        expect(caption).toBe(i === 0 ? null : headerLabels[i]);
      });
    }
  });

  it('lets the unbounded category name wrap rather than clamping or truncating it', async () => {
    const container = renderTable();

    // A category name has no ceiling and no other surface shows it in full, so
    // it is neither truncated nor clamped: `min-w-0` is what stops it setting
    // the table's minimum width (the cell may be narrower than its content),
    // and `break-words` breaks a word too long for the track. Both are
    // phone-only -- from `sm` up the column is wide enough for today's wrap.
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const nameCell = row.querySelector('td')!;
      expect(nameCell.className).toContain('min-w-0');
      expect(nameCell.className).toContain('break-words');
      expect(nameCell.className).toContain('sm:break-normal');
      expect(nameCell.className).not.toContain('truncate');
      expect(nameCell.className).not.toMatch(/\bline-clamp-/);
    }
    // Every name is rendered whole, in both rows that have a hard one.
    expect(rowFor(container, LONG_NAME)?.querySelector('td')?.textContent).toBe(LONG_NAME);
    expect(rowFor(container, UNBREAKABLE_NAME)?.querySelector('td')?.textContent).toBe(
      UNBREAKABLE_NAME,
    );
  });

  it('keeps the row a table row from sm up and a grid below it', async () => {
    const container = renderTable();

    const table = container.querySelector('table');
    expect(table?.className).toContain('block');
    expect(table?.className).toContain('sm:table');
    expect(container.querySelector('thead')?.className).toContain('sm:table-header-group');
    expect(container.querySelector('tbody')?.className).toContain('sm:table-row-group');
    const row = container.querySelector('tbody tr');
    expect(row?.className).toContain('grid grid-cols-2');
    expect(row?.className).toContain('sm:table-row');
    // The row keeps the hairline rule it draws today, on both layouts.
    expect(row?.className).toContain('border-b border-gray-100');
    expect(row?.className).toContain('dark:border-gray-700/50');
    expect(table?.parentElement?.className).toContain('overflow-x-auto');
  });

  it('hides the header row on phones and offers no control in its place', async () => {
    const container = renderTable();

    // Nothing in this header is interactive, so hiding the whole row is
    // correct: a phone sort strip here would be an affordance that does
    // nothing. There is exactly one header row, it is hidden below `sm`, and
    // no header cell is clickable at any width.
    const headerRows = Array.from(container.querySelectorAll('thead tr'));
    expect(headerRows).toHaveLength(1);
    expect(headerRows[0].className).toContain('hidden');
    expect(headerRows[0].className).toContain('sm:table-row');
    for (const th of Array.from(container.querySelectorAll('th'))) {
      expect(th.className).not.toContain('cursor-pointer');
      expect(th.querySelector('button')).toBeNull();
    }
  });

  it('restores this table’s own cell padding from sm up, per cell', async () => {
    const container = renderTable();

    // The desktop output has to be what it is today: `py-2 pr-4` on every cell
    // except the last (Avg Variance), which is `py-2` alone. Below `sm` the
    // cells carry no padding of their own -- the row supplies it.
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const cells = Array.from(row.querySelectorAll('td'));
      for (const cell of cells) {
        expect(cell.className).toContain('p-0');
        expect(cell.className).toContain('sm:py-2');
      }
      const [name, budget, actual, variance] = cells;
      for (const cell of [name, budget, actual]) {
        expect(cell.className).toContain('sm:pr-4');
      }
      expect(variance.className).not.toContain('sm:pr-4');
    }
    // The header row is the same claim: three `pr-4` cells and a bare last one.
    const headerCells = Array.from(container.querySelectorAll('thead th'));
    expect(headerCells.slice(0, 3).every((th) => th.className.includes('py-2 pr-4'))).toBe(true);
    expect(headerCells[3].className).toContain('py-2 font-medium');
    expect(headerCells[3].className).not.toContain('pr-4');

    // And the two agree about which column is last.
    const bodyCells = Array.from(
      container.querySelectorAll('tbody tr')[0].querySelectorAll('td'),
    );
    const headerBare = headerCells.findIndex((th) => !th.className.includes('pr-4'));
    const bodyBare = bodyCells.findIndex((td) => !td.className.includes('sm:pr-4'));
    expect(headerBare).toBe(bodyBare);
    expect(headerBare).toBe(headerCells.length - 1);
    expect(headerCells.filter((th) => !th.className.includes('pr-4'))).toHaveLength(1);
    expect(bodyCells.filter((td) => !td.className.includes('sm:pr-4'))).toHaveLength(1);
  });

  it('restores the table semantics a phone restyle strips', async () => {
    const container = renderTable();

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
    // These `<th>`s are written here, not by `SortableHeader`, so they state
    // the role themselves.
    for (const th of Array.from(container.querySelectorAll('th'))) {
      expect(th.getAttribute('role')).toBe('columnheader');
    }
  });

  it('keeps the sign colouring and the + prefix the column used, in the wrapped cell', async () => {
    const container = renderTable();

    const varianceOf = (name: string) =>
      rowFor(container, name)?.querySelector('.col-start-2.row-start-1');
    expect(varianceOf(LONG_NAME)?.className).toContain('text-red-600');
    expect(varianceOf(LONG_NAME)?.textContent).toContain('+$204433');
    expect(varianceOf(UNBREAKABLE_NAME)?.className).toContain('text-green-600');
    expect(varianceOf(UNBREAKABLE_NAME)?.textContent).toContain('$-24691');
    // A series with no points averages to a known ZERO, not to an unknown, and
    // zero is not "over budget": green, no prefix.
    expect(varianceOf('Dining')?.className).toContain('text-green-600');
    expect(varianceOf('Dining')?.textContent).toBe('Avg Variance$0');
  });

  it('carries a row for every series, whatever the chart toggles are set to', async () => {
    const container = renderTable();

    // The toggles above the chart select which LINES are drawn; the table has
    // always listed every series, and wrapping the rows must not make it
    // follow the toggle. Turning one off leaves its row -- and its figures --
    // exactly where they were.
    expect(container.querySelectorAll('tbody tr')).toHaveLength(DATA.length);
    await act(async () => {
      fireEvent.click(screen.getByTestId('category-toggle-cat-1'));
    });
    expect(container.querySelectorAll('tbody tr')).toHaveLength(DATA.length);
    expect(rowFor(container, LONG_NAME)?.textContent).toContain('Avg Actual$1439000');
  });

  it('leaves the rows inert: the card is a layout, not a new affordance', async () => {
    const container = renderTable();

    // These rows have never been clickable, and wrapping them must not make
    // them so. Clicking is the live half of the assertion: React attaches
    // handlers synthetically and never writes an `onclick` attribute.
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(DATA.length);
    for (const row of rows) {
      expect(row.className).not.toContain('cursor-pointer');
      await act(async () => {
        fireEvent.click(row);
      });
    }
    expect(mockPush).not.toHaveBeenCalled();
  });
});
