import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { format } from 'date-fns';
import { RecurringExpensesReport } from './RecurringExpensesReport';

/**
 * The phone layout of the "All Recurring Expenses" table.
 *
 * The table is ONE tree restyled by CSS (mechanism A): below `sm` the rows wrap
 * into a two-column, four-line grid and the column header row is replaced by a
 * strip of sort chips, from `sm` up it is the ordinary table. jsdom applies no
 * media queries, so both header rows and every phone caption are in the DOM
 * here at all times -- which is what lets these assertions read the phone
 * markup without emulating a viewport, and why a sort control is addressed by
 * position rather than by label (each label matches the phone strip, the column
 * header row, and -- for the four captioned columns -- a caption in every row).
 */

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
  useNumberFormat: () => ({
    ...numberFormatMockDefaults(),
    formatCurrencyCompact: (n: number) => `$${n}`,
    formatCurrency: (n: number) => `$${n}`,
    defaultCurrency: 'CAD',
  }),
  };
});

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  PieChart: ({ children }: any) => <div data-testid="pie-chart">{children}</div>,
  Pie: () => null,
  Cell: () => null,
  Tooltip: () => null,
}));

const mockGetRecurringExpenses = vi.fn();
vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getRecurringExpenses: (...args: any[]) => mockGetRecurringExpenses(...args),
  },
}));

const mockExportToCsv = vi.fn();
vi.mock('@/lib/csv-export', () => ({
  exportToCsv: (...args: any[]) => mockExportToCsv(...args),
}));

vi.mock('@/components/ui/ExportDropdown', () => ({
  ExportDropdown: ({ onExportCsv }: any) => (
    <button data-testid="export-csv" onClick={onExportCsv}>
      CSV
    </button>
  ),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

/**
 * Two payees, chosen so the stored default sort (6-Mo Total, descending) and an
 * ascending sort by Count disagree -- otherwise a tap on the phone strip could
 * re-sort and leave the rows in the order they were already in.
 *
 * Their figures are the SERVER's, not invented: `averageAmount` is
 * `totalAmount / occurrences` and the frequency label is derived from the
 * occurrence count (>= 24 Weekly, >= 12 Bi-weekly, >= 5 Monthly, >= 3
 * Occasional, else Irregular) in
 * `backend/src/built-in-reports/tax-recurring-reports.service.ts`, which also
 * substitutes the literal `Uncategorized` for a row with no category.
 *
 * The second carries the absence the row has to render without navigating: no
 * payee id, which the recurring query produces for a transaction whose payee is
 * a free-text name rather than a payee record.
 */
const RESPONSE = {
  data: [
    {
      payeeId: 'p-water',
      payeeName: 'Water Utility',
      categoryName: 'Utilities',
      frequency: 'Monthly',
      occurrences: 6,
      averageAmount: 50,
      totalAmount: 300,
      lastTransactionDate: '2024-06-15',
    },
    {
      payeeId: null,
      payeeName: 'Zebra Market',
      categoryName: 'Uncategorized',
      frequency: 'Weekly',
      occurrences: 26,
      averageAmount: 25,
      totalAmount: 650,
      lastTransactionDate: '2024-02-10',
    },
  ],
  summary: { uniquePayees: 2, totalRecurring: 950, monthlyEstimate: 158 },
};

/** The column order, which is also the `<td>` order in every row. */
const EXPECTED_LABELS = [
  'Payee',
  'Category',
  'Frequency',
  'Count',
  'Avg Amount',
  '6-Mo Total',
  'Last Paid',
];

/**
 * The Last Paid cell as the component renders it. Derived rather than
 * hardcoded: the component parses the server's `YYYY-MM-DD` with
 * `new Date(...)`, which reads it as UTC midnight, so a literal `Jun 15` would
 * fail for a developer west of Greenwich. That off-by-one is pre-existing and
 * deliberately unchanged here -- this expectation follows the component so the
 * test asserts the LAYOUT (the caption beside the value) rather than the parse.
 */
const lastPaid = (iso: string) => format(new Date(iso), 'MMM d');

const stripGlyph = (text: string | null | undefined) => (text ?? '').replace(/[↑↓↕]/g, '').trim();

const rowText = (row: Element | null | undefined) => row?.textContent ?? '';

async function renderTable() {
  mockGetRecurringExpenses.mockResolvedValue(RESPONSE);
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<RecurringExpensesReport />));
  });
  await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
  return container;
}

const expenseRow = (container: HTMLElement, name: string) =>
  Array.from(container.querySelectorAll('tbody tr')).find((r) => r.textContent?.includes(name));

/** The payee cell of every body row, in render order. */
const order = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('tbody tr')).map((r) => r.querySelector('td')?.textContent);

describe('RecurringExpensesReport (phone wrapped rows)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    // The sort is persisted, so a tap in one test would otherwise decide the
    // starting order of the next.
    localStorage.clear();
  });

  it('builds both header rows from one record of all seven sort fields', async () => {
    const container = await renderTable();

    const headerRows = Array.from(container.querySelectorAll('thead tr'));
    expect(headerRows).toHaveLength(2);
    const [phoneRow, columnRow] = headerRows;
    // Exactly one of the two is displayed at any width.
    expect(phoneRow.className).toContain('sm:hidden');
    expect(columnRow.className).toContain('hidden');
    expect(columnRow.className).toContain('sm:table-row');

    const labelsOf = (row: Element) =>
      Array.from(row.querySelectorAll('th')).map((th) => stripGlyph(th.textContent));
    expect(labelsOf(phoneRow)).toEqual(EXPECTED_LABELS);
    // Both rows are rendered from one record, so they cannot list different
    // fields -- assert it rather than trusting the loop.
    expect(labelsOf(columnRow)).toEqual(labelsOf(phoneRow));
    // As many controls in each header row as a data row has cells: a field
    // added to the union with no control anywhere would strand a stored sort.
    const cellCount = container.querySelectorAll('tbody tr')[0].querySelectorAll('td').length;
    expect(cellCount).toBe(7);
    expect(phoneRow.querySelectorAll('th')).toHaveLength(cellCount);
    expect(columnRow.querySelectorAll('th')).toHaveLength(cellCount);
  });

  it('sorts from the phone strip, which the column header row cannot do on a phone', async () => {
    const container = await renderTable();

    // The stored default is 6-Mo Total, descending.
    expect(order(container)).toEqual(['Zebra Market', 'Water Utility']);

    // "Count" is the fourth of the seven controls in the phone strip.
    // Addressed by position: the label also names the column header and the
    // caption of a cell in every row.
    const phoneCount = container.querySelectorAll('thead tr')[0].querySelectorAll('th')[3];
    await act(async () => {
      fireEvent.click(phoneCount);
    });
    // Ascending by occurrence count puts the six-payment row first.
    expect(order(container)).toEqual(['Water Utility', 'Zebra Market']);
  });

  it('captions every bare number and date, and leaves the self-describing words alone', async () => {
    const container = await renderTable();

    const row = expenseRow(container, 'Water Utility');
    expect(row).toBeDefined();
    // Each caption sits immediately beside the value it names, as its own text
    // node, so a `getByText` on the value still matches the value node.
    expect(rowText(row)).toContain('Count6');
    expect(rowText(row)).toContain('Avg Amount$50');
    expect(rowText(row)).toContain('6-Mo Total$300');
    expect(rowText(row)).toContain(`Last Paid${lastPaid('2024-06-15')}`);
    // The value really is its own node, not part of the caption's.
    expect(screen.getByText('$300')).toBeInTheDocument();

    // The payee, the category and the frequency pill carry NO caption: a name,
    // a category and a self-naming pill describe themselves, and the header key
    // they would reuse is the one the sort chip above already shows.
    const cells = Array.from(row!.querySelectorAll('td'));
    for (const i of [0, 1, 2]) {
      expect(cells[i].querySelector('span.sm\\:hidden')).toBeNull();
    }
    expect(cells[0].textContent).toBe('Water Utility');
    expect(cells[1].textContent).toBe('Utilities');
  });

  it('associates every caption with the column header of the cell it sits in', async () => {
    const container = await renderTable();

    // Under mechanism A the DOM order is STILL the column order -- the grid
    // only paints -- so a swapped `<td>` would transpose two desktop columns
    // while every placement string below stayed correct. Read the association
    // rather than the placement: the Nth cell's caption is the Nth column
    // header's label.
    const headerLabels = Array.from(
      container.querySelectorAll('thead tr')[1].querySelectorAll('th'),
    ).map((th) => stripGlyph(th.textContent));
    expect(headerLabels).toEqual(EXPECTED_LABELS);

    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const cells = Array.from(row.querySelectorAll('td'));
      cells.forEach((cell, i) => {
        const caption = cell.querySelector('span.sm\\:hidden')?.textContent ?? null;
        expect(caption).toBe(i <= 2 ? null : headerLabels[i]);
      });
    }
  });

  it('places every cell on the phone grid explicitly, and never wraps a figure', async () => {
    const container = await renderTable();

    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const cells = Array.from(row.querySelectorAll('td'));
      expect(cells).toHaveLength(7);
      for (const cell of cells) {
        // Auto-flow placement is not deterministic once a cell is added or
        // made conditional, so each cell states its own column and line.
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
        // Nothing spans, and nothing falls onto a fifth line.
        expect(cell.className).not.toMatch(/\bcol-span-\d\b/);
        expect(cell.className).not.toMatch(/\brow-start-[5-9]\b/);
      }
      // The four value cells never wrap -- a locale grouping thousands with a
      // space would otherwise break in the middle of a number, and a date is
      // one label -- and each is right-aligned below `sm`. The three word cells
      // MUST be free to wrap, so they carry neither.
      const [payee, category, frequency, ...values] = cells;
      for (const word of [payee, category, frequency]) {
        expect(word.className).not.toContain('whitespace-nowrap');
        expect(word.className).not.toContain('text-right');
      }
      for (const cell of values) {
        expect(cell.className).toContain('whitespace-nowrap');
        expect(cell.className).toContain('text-right');
      }
    }
  });

  it('wraps each row onto four lines, cost on the right and identity on the left', async () => {
    const container = await renderTable();

    const placement = (cell: Element) => {
      const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
      const row = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
      return `c${col}/r${row}`;
    };
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      expect(row.className).toContain('grid grid-cols-2');
      const [payee, category, frequency, count, average, total, last] = Array.from(
        row.querySelectorAll('td'),
      );
      expect(placement(payee)).toBe('c1/r1');
      expect(placement(total)).toBe('c2/r1');
      // The two unbounded text columns are separate cells, so the category
      // cannot share the payee's line: it takes its own, in the same track.
      expect(placement(category)).toBe('c1/r2');
      expect(placement(average)).toBe('c2/r2');
      expect(placement(frequency)).toBe('c1/r3');
      expect(placement(last)).toBe('c2/r3');
      // Count takes the LEFT track: its caption is the only one of the four
      // that is a single unbreakable word in the long locales, so it degrades
      // into the column gap rather than reopening the wrapper's sideways
      // scroll -- and it lands under the frequency the server derives from it.
      expect(placement(count)).toBe('c1/r4');
    }
  });

  it('lets both unbounded text columns wrap instead of setting the table minimum', async () => {
    const container = await renderTable();

    // The payee and the category are both unbounded in the payload, so each
    // cell may be narrower than its own content (`min-w-0`) inside a
    // `minmax(0,1fr)` track, and a word too long for that track breaks. From
    // `sm` up today's wrapping comes back.
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const [payee, category] = Array.from(row.querySelectorAll('td'));
      for (const cell of [payee, category]) {
        expect(cell.className).toContain('min-w-0');
        expect(cell.className).toContain('break-words');
        expect(cell.className).toContain('sm:break-normal');
        // Not clamped: a clamp would cut the tail of a name or a category no
        // other surface shows in full.
        expect(cell.className).not.toMatch(/line-clamp-\d/);
      }
    }
  });

  it('keeps the frequency pill one uncaptioned fragment inside its own track', async () => {
    const container = await renderTable();

    const pills = Array.from(container.querySelectorAll('tbody tr td:nth-child(3) span'));
    expect(pills.map((p) => p.textContent)).toEqual(['Weekly', 'Monthly']);
    for (const pill of pills) {
      // Phone-only: an inline pill whose label outgrows its track paints two
      // ragged background fragments (measured in Chromium); an inline-block
      // bounded by its own track paints one. The `sm`+ markup is untouched.
      expect(pill.className).toContain('max-sm:inline-block');
      expect(pill.className).toContain('max-sm:max-w-full');
      // The pill keeps the colour it is keyed on today.
      expect(pill.className).toContain(
        pill.textContent === 'Weekly' ? 'bg-purple-100' : 'bg-green-100',
      );
    }
  });

  it('keeps the row a table row from sm up and a grid below it', async () => {
    const container = await renderTable();

    const table = container.querySelector('table')!;
    expect(table.className).toContain('block');
    expect(table.className).toContain('sm:table');
    expect(container.querySelector('thead')?.className).toContain('sm:table-header-group');
    expect(container.querySelector('tbody')?.className).toContain('sm:table-row-group');
    const row = container.querySelector('tbody tr');
    expect(row?.className).toContain('grid grid-cols-2');
    expect(row?.className).toContain('sm:table-row');
    // The wrapper still scrolls horizontally, which is what the table needs
    // from `sm` up on a narrow desktop window.
    expect(table.parentElement?.className).toContain('overflow-x-auto');
  });

  it('restores this table’s own cell padding and alignment from sm up', async () => {
    const container = await renderTable();

    // The desktop output has to be what it is today: every cell `px-4 py-3`,
    // the frequency and count centred, the total emphasised and red. Below `sm`
    // the cells carry no padding of their own -- the row supplies it.
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      expect(row.className).toContain('px-4 py-3');
      const cells = Array.from(row.querySelectorAll('td'));
      for (const cell of cells) {
        expect(cell.className).toContain('p-0');
        expect(cell.className).toContain('sm:px-4');
        expect(cell.className).toContain('sm:py-3');
      }
      expect(cells[2].className).toContain('sm:text-center');
      expect(cells[3].className).toContain('sm:text-center');
      expect(cells[5].className).toContain('font-medium');
      expect(cells[5].className).toContain('text-red-600');
    }
    for (const th of Array.from(container.querySelectorAll('thead tr')[1].querySelectorAll('th'))) {
      expect(th.className).toContain('px-4 py-3');
    }
  });

  it('restores the table semantics a phone restyle strips', async () => {
    const container = await renderTable();

    const table = container.querySelector('table')!;
    expect(table.getAttribute('role')).toBe('table');
    for (const group of ['thead', 'tbody']) {
      expect(container.querySelector(group)?.getAttribute('role')).toBe('rowgroup');
    }
    for (const row of Array.from(table.querySelectorAll('tr'))) {
      expect(row.getAttribute('role')).toBe('row');
    }
    // EVERY `<td>`, including the ones whose className is a template literal.
    for (const cell of Array.from(table.querySelectorAll('td'))) {
      expect(cell.getAttribute('role')).toBe('cell');
    }
    // `SortableHeader` restates `columnheader` on the `<th>` it renders, so
    // both header rows already carry it.
    for (const th of Array.from(table.querySelectorAll('th'))) {
      expect(th.getAttribute('role')).toBe('columnheader');
    }
  });

  it('navigates from the wrapped row only when the payee has an id', async () => {
    const container = await renderTable();

    const withId = expenseRow(container, 'Water Utility')!;
    expect(withId.className).toContain('cursor-pointer');
    // The row hover is the pair this table already draws; the card is a layout,
    // not a second affordance.
    expect(withId.className).toContain('hover:bg-gray-50');
    await act(async () => {
      fireEvent.click(withId);
    });
    expect(mockPush).toHaveBeenCalledWith('/transactions?payeeId=p-water');

    // A click landing on a captioned value cell is still a click on the row.
    mockPush.mockClear();
    await act(async () => {
      fireEvent.click(withId.querySelectorAll('td')[5]);
    });
    expect(mockPush).toHaveBeenCalledWith('/transactions?payeeId=p-water');

    // A row with no payee id is not a pointer and does not navigate -- the
    // handler is attached either way, so this is a behaviour claim, not a
    // claim about the attribute.
    mockPush.mockClear();
    const withoutId = expenseRow(container, 'Zebra Market')!;
    expect(withoutId.className).not.toContain('cursor-pointer');
    await act(async () => {
      fireEvent.click(withoutId);
    });
    await act(async () => {
      fireEvent.click(withoutId.querySelectorAll('td')[3]);
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('builds the export from the same record the two header rows come from', async () => {
    const container = await renderTable();
    expect(container.querySelector('table')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('export-csv'));
    });
    expect(mockExportToCsv).toHaveBeenCalledTimes(1);
    const [name, headers, rows] = mockExportToCsv.mock.calls[0];
    expect(name).toBe('recurring-expenses');
    // The export's column ORDER is the record's, so a column can no longer be
    // added to the table without appearing in the export (the strings stay the
    // catalogue's own `csvCol*` keys, which happen to match the headers).
    expect(headers).toEqual(EXPECTED_LABELS);
    // The export is the SERVER's order, not the table's sort.
    expect(rows[0]).toEqual([
      'Water Utility',
      'Utilities',
      'Monthly',
      6,
      50,
      300,
      format(new Date('2024-06-15'), 'yyyy-MM-dd'),
    ]);
    expect(rows[1][0]).toBe('Zebra Market');
  });
});
