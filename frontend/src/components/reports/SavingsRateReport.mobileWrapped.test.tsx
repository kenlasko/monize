import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { SavingsRateReport } from './SavingsRateReport';
import type { Budget, SavingsRatePoint } from '@/types/budget';

/**
 * The phone layout of the Savings Rate report's "Monthly breakdown" table.
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
const mockGetSavingsRate = vi.fn();

// A router of this file's own, so "clicking a row navigates nowhere" is an
// assertion about behaviour rather than about a class. Built inside the
// factory because `vi.mock` is hoisted above the const it would close over,
// and returned as one stable object, as the shared setup's router is.
const mockPush = vi.fn();
vi.mock('next/navigation', () => {
  const router = { push: mockPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() };
  return {
    useRouter: () => router,
    usePathname: () => '/reports/savings-rate',
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    getSavingsRate: (...args: any[]) => mockGetSavingsRate(...args),
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
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn(),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  LineChart: ({ children }: any) => <div data-testid="line-chart">{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
  ReferenceLine: () => null,
  Tooltip: () => null,
}));

const makePoint = (
  month: string,
  income: number,
  expenses: number,
): SavingsRatePoint => ({
  month,
  income,
  expenses,
  savings: income - expenses,
  savingsRate: income > 0 ? ((income - expenses) / income) * 100 : 0,
});

// Worst case for a phone: seven-figure income and expenses, one month whose
// savings and rate are both negative (so the sign colouring is exercised on
// both), and one month above the 20% default target.
const POINTS: SavingsRatePoint[] = [
  makePoint('2025-01', 1234567, 900000), // ~27% -- at or above the target
  makePoint('2025-02', 101200, 1439000), // heavily negative savings and rate
  makePoint('2025-03', 1000000, 950000), // 5% -- positive but below the target
];

async function renderTable() {
  mockGetAll.mockResolvedValue([{ id: 'b-1', name: 'Default', isActive: true } as Budget]);
  mockGetSavingsRate.mockResolvedValue(POINTS);
  let container!: HTMLElement;
  await act(async () => {
    container = render(<SavingsRateReport />).container;
  });
  await waitFor(() => expect(screen.getByText('Monthly Breakdown')).toBeInTheDocument());
  return container;
}

const rowText = (row: Element | null | undefined) => row?.textContent ?? '';

const findRow = (container: HTMLElement, month: string) =>
  Array.from(container.querySelectorAll('tbody tr')).find((r) =>
    r.textContent?.includes(month),
  );

describe('SavingsRateReport (phone wrapped table)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captions every figure inside the row so a phone needs no column header', async () => {
    const container = await renderTable();

    const row = findRow(container, '2025-01');
    expect(row).toBeDefined();
    // Each caption sits immediately beside the value it names, as its own text
    // node, so a `getByText` on the value still matches the value node.
    expect(rowText(row)).toContain('Income$1234567');
    expect(rowText(row)).toContain('Expenses$900000');
    expect(rowText(row)).toContain('Savings$334567');
    expect(rowText(row)).toContain('Rate27.1%');
    // The month is the row's identity, not one of its figures, so it carries
    // no caption -- it is the first thing on the line and names itself.
    const monthCell = row?.querySelector('td');
    expect(monthCell?.textContent).toBe('2025-01');
    expect(monthCell?.querySelector('span')).toBeNull();
    // Captions reuse the table's own column keys: no new catalogue string.
    for (const caption of ['Month', 'Income', 'Expenses', 'Savings', 'Rate']) {
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

  it('wraps each row onto two lines of three tracks, derived figure under its source', async () => {
    const container = await renderTable();

    // Line 1: month | savings | income. Line 2: rate (spanning the first two
    // tracks) | expenses. DOM order is the desktop column order, so the
    // placement is read off the classes rather than off position.
    const placement = (cell: Element) => {
      const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
      const row = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
      const span = /\bcol-span-(\d)\b/.exec(cell.className)?.[1] ?? '1';
      return `c${col}/r${row}/s${span}`;
    };
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const [month, income, expenses, savings, rate] = Array.from(row.querySelectorAll('td'));
      expect(row.className).toContain('grid-cols-3');
      expect(placement(month)).toBe('c1/r1/s1');
      expect(placement(savings)).toBe('c2/r1/s1');
      expect(placement(income)).toBe('c3/r1/s1');
      expect(placement(rate)).toBe('c1/r2/s2');
      expect(placement(expenses)).toBe('c3/r2/s1');
      // Nothing is placed on a third line.
      for (const cell of [month, income, expenses, savings, rate]) {
        expect(cell.className).not.toMatch(/\brow-start-3\b/);
      }
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
    expect(row?.className).toContain('grid grid-cols-3');
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
    // except the last (Rate), which is `py-2` alone. Below `sm` the cells carry
    // no padding of their own -- the row supplies it.
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const cells = Array.from(row.querySelectorAll('td'));
      for (const cell of cells) {
        expect(cell.className).toContain('p-0');
        expect(cell.className).toContain('sm:py-2');
      }
      const [month, income, expenses, savings, rate] = cells;
      for (const cell of [month, income, expenses, savings]) {
        expect(cell.className).toContain('sm:pr-4');
      }
      expect(rate.className).not.toContain('sm:pr-4');
    }
    // The header row is the same claim: four `pr-4` cells and a bare last one.
    const headerCells = Array.from(
      container.querySelectorAll('thead tr')[1].querySelectorAll('th'),
    );
    expect(headerCells.slice(0, 4).every((th) => th.className.includes('py-2 pr-4'))).toBe(true);
    expect(headerCells[4].className).toContain('py-2 font-medium');
    expect(headerCells[4].className).not.toContain('pr-4');

    // And the two agree: "which column is last" is one decision, taken in
    // `sortColumns`, so the header cell that drops `pr-4` and the body cell
    // that drops `sm:pr-4` are the same column. Reordering the list without
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
    const expected = ['Month', 'Income', 'Expenses', 'Savings', 'Rate'];
    expect(labelsOf(phoneRow)).toEqual(expected);
    // Both rows are rendered from one list, so they cannot list different
    // fields -- assert it rather than trusting the loop.
    expect(labelsOf(columnRow)).toEqual(labelsOf(phoneRow));
  });

  it('sorts from the phone strip, not only from the column header', async () => {
    const container = await renderTable();

    const monthOrder = () =>
      Array.from(container.querySelectorAll('tbody tr')).map(
        (r) => r.querySelector('td')?.textContent,
      );
    expect(monthOrder()).toEqual(['2025-01', '2025-02', '2025-03']);

    // "Savings" in the phone strip: the fourth of the five controls in the
    // first header row. Addressed by position because the label also appears
    // in the column header row and in every caption.
    const phoneSavings = container
      .querySelectorAll('thead tr')[0]
      .querySelectorAll('th')[3];
    await act(async () => {
      fireEvent.click(phoneSavings);
    });
    // Ascending by savings puts February's -$1,337,800 first.
    expect(monthOrder()).toEqual(['2025-02', '2025-03', '2025-01']);
  });

  it('keeps both sign colourings the columns use, in the wrapped cells', async () => {
    const container = await renderTable();

    // Savings: `gainLossColor`, green up and red down.
    const positive = findRow(container, '2025-01')?.querySelector('.col-start-2.row-start-1');
    expect(positive?.className).toContain('text-green-600');
    const negative = findRow(container, '2025-02')?.querySelector('.col-start-2.row-start-1');
    expect(negative?.className).toContain('text-red-600');

    // Rate: the three-way rule against the 20% default target -- green at or
    // above it, yellow between zero and it, red below zero.
    const rateOf = (month: string) =>
      findRow(container, month)?.querySelector('.col-start-1.col-span-2.row-start-2')?.className ?? '';
    expect(rateOf('2025-01')).toContain('text-green-600'); // ~27%
    expect(rateOf('2025-03')).toContain('text-yellow-600'); // 5%
    expect(rateOf('2025-02')).toContain('text-red-600'); // negative
  });

  it('leaves the rows inert: the card is a layout, not a new affordance', async () => {
    const container = await renderTable();

    // These rows have never been clickable, and wrapping them must not make
    // them so -- a card that looks tappable and does nothing is worse than a
    // plain row, and the sibling report whose layout this copies DOES navigate
    // from its rows, which is the thing not to inherit.
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
