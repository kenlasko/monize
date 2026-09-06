import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { BillPaymentHistoryReport } from './BillPaymentHistoryReport';

/**
 * The phone layout of the "Payment history by bill" table.
 *
 * The table is ONE tree restyled by CSS (mechanism A): below `sm` the rows wrap
 * into a two-column, three-line grid and the column header row is replaced by a
 * strip of sort chips, from `sm` up it is the ordinary table. jsdom applies no
 * media queries, so both header rows and every phone caption are in the DOM
 * here at all times -- which is what lets these assertions read the phone
 * markup without emulating a viewport, and why a sort control is addressed by
 * position rather than by label (each label matches the phone strip, the column
 * header row, and a caption).
 */

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/reports',
}));

vi.mock('@/components/ui/ExportDropdown', () => ({
  ExportDropdown: () => <div data-testid="export-dropdown" />,
}));

vi.mock('@/lib/csv-export', () => ({
  exportToCsv: vi.fn(),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
  useNumberFormat: () => ({
    ...numberFormatMockDefaults(),
    formatCurrencyCompact: (n: number) => `$${n}`,
    formatCurrency: (n: number) => `$${n}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
    defaultCurrency: 'CAD',
  }),
  };
});

const STABLE_RANGE = { start: '2024-01-01', end: '2025-01-01' };
vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: '1y',
    setDateRange: vi.fn(),
    resolvedRange: STABLE_RANGE,
    isValid: true,
  }),
}));

// Spread the real module: `CellLabel` reads `cn` from here, and a bare factory
// blanks every other export of the module for the whole graph under test.
vi.mock('@/lib/utils', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

const mockGetBillPaymentHistory = vi.fn();
vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getBillPaymentHistory: (...args: any[]) => mockGetBillPaymentHistory(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

/**
 * Two bills, chosen so the default sort (total, descending) and an ascending
 * sort by average disagree -- otherwise a tap on the phone strip could re-sort
 * and leave the rows in the order they were already in.
 *
 * The second carries the two absences the cells have to render: no payee (the
 * identity's fallback line) and no last payment (the `-`).
 */
const RESPONSE = {
  billPayments: [
    {
      scheduledTransactionId: 'st-water',
      scheduledTransactionName: 'Water Utility',
      payeeName: 'City Water Department',
      paymentCount: 3,
      averagePayment: 50,
      totalPaid: 300,
      lastPaymentDate: '2024-06-15',
    },
    {
      scheduledTransactionId: 'st-zebra',
      scheduledTransactionName: 'Zebra Insurance',
      payeeName: null,
      paymentCount: 12,
      averagePayment: 150,
      totalPaid: 600,
      lastPaymentDate: null,
    },
  ],
  monthlyTotals: [{ label: 'Jan 2025', total: 300 }],
  summary: { totalPaid: 900, monthlyAverage: 75, uniqueBills: 2, totalPayments: 15 },
};

/** The column order, which is also the `<td>` order in every row. */
const EXPECTED_LABELS = ['Bill', 'Payments', 'Average', 'Total Paid', 'Last Payment'];

const stripGlyph = (text: string | null | undefined) =>
  (text ?? '').replace(/[↑↓↕]/g, '').trim();

const rowText = (row: Element | null | undefined) => row?.textContent ?? '';

async function renderByBill() {
  mockGetBillPaymentHistory.mockResolvedValue(RESPONSE);
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<BillPaymentHistoryReport />));
  });
  await waitFor(() => expect(screen.getByText('By Bill')).toBeInTheDocument());
  await act(async () => {
    fireEvent.click(screen.getByText('By Bill'));
  });
  await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
  return container;
}

const billRow = (container: HTMLElement, name: string) =>
  Array.from(container.querySelectorAll('tbody tr')).find((r) =>
    r.textContent?.includes(name),
  );

describe('BillPaymentHistoryReport (phone wrapped rows)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
  });

  it('builds both header rows from one list of all five sort fields', async () => {
    const container = await renderByBill();

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
    // As many controls in each header row as a data row has cells.
    const cellCount = container.querySelectorAll('tbody tr')[0].querySelectorAll('td').length;
    expect(phoneRow.querySelectorAll('th')).toHaveLength(cellCount);
    expect(columnRow.querySelectorAll('th')).toHaveLength(cellCount);
  });

  it('sorts from the phone strip, which the column header row cannot do on a phone', async () => {
    const container = await renderByBill();

    const order = () =>
      Array.from(container.querySelectorAll('tbody tr')).map(
        (r) => r.querySelector('td')?.textContent?.replace(/(No payee|City Water Department)$/, ''),
      );
    // The stored default is total paid, descending.
    expect(order()).toEqual(['Zebra Insurance', 'Water Utility']);

    // "Average" is the third of the five controls in the phone strip.
    // Addressed by position: the label also names the column header and a
    // caption in every row.
    const phoneAverage = container
      .querySelectorAll('thead tr')[0]
      .querySelectorAll('th')[2];
    await act(async () => {
      fireEvent.click(phoneAverage);
    });
    // Ascending by average puts the $50 bill first.
    expect(order()).toEqual(['Water Utility', 'Zebra Insurance']);
  });

  it('captions every value inside the row so a phone needs no column header', async () => {
    const container = await renderByBill();

    const row = billRow(container, 'Water Utility');
    expect(row).toBeDefined();
    // Each caption sits immediately beside the value it names, as its own text
    // node, so a `getByText` on the value still matches the value node.
    expect(rowText(row)).toContain('Payments3');
    expect(rowText(row)).toContain('Average$50');
    expect(rowText(row)).toContain('Total Paid$300');
    expect(rowText(row)).toContain('Last PaymentJun 15, 2024');
    // The value really is its own node, not part of the caption's.
    expect(screen.getByText('Jun 15, 2024')).toBeInTheDocument();
  });

  it('renders the no-payee fallback and the missing date inside the wrapped row', async () => {
    const container = await renderByBill();

    const row = billRow(container, 'Zebra Insurance');
    const cells = Array.from(row!.querySelectorAll('td'));
    // The bill name and the payee line are one identity cell, not two columns,
    // and the fallback is the payee line of that cell.
    expect(cells[0].textContent).toBe('Zebra InsuranceNo payee');
    // The identity carries no caption: it is the row itself, not a figure.
    expect(cells[0].querySelector('span.sm\\:hidden')).toBeNull();
    // A bill never paid still shows its Last Payment cell, captioned.
    expect(cells[4].textContent).toBe('Last Payment-');
  });

  it('associates every caption with the column header of the cell it sits in', async () => {
    const container = await renderByBill();

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
        expect(caption).toBe(i === 0 ? null : headerLabels[i]);
      });
    }
  });

  it('places every cell on the phone grid explicitly, and never wraps a figure', async () => {
    const container = await renderByBill();

    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const cells = Array.from(row.querySelectorAll('td'));
      expect(cells).toHaveLength(5);
      for (const cell of cells) {
        // Auto-flow placement is not deterministic once a cell is added or
        // made conditional, so each cell states its own column and line.
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
        // Nothing spans, and nothing falls onto a fourth line.
        expect(cell.className).not.toMatch(/\bcol-span-\d\b/);
        expect(cell.className).not.toMatch(/\brow-start-[4-9]\b/);
      }
      // The four value cells never wrap -- a locale grouping thousands with a
      // space would otherwise break in the middle of a number, and a date is
      // one label -- and each is right-aligned below `sm`. The identity is the
      // one cell that MUST wrap, so it carries neither.
      const [identity, ...values] = cells;
      expect(identity.className).not.toContain('whitespace-nowrap');
      expect(identity.className).not.toContain('text-right');
      for (const cell of values) {
        expect(cell.className).toContain('whitespace-nowrap');
        expect(cell.className).toContain('text-right');
      }
    }
  });

  it('wraps each row onto three lines: bill and total, average and count, then last payment', async () => {
    const container = await renderByBill();

    const placement = (cell: Element) => {
      const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
      const row = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
      return `c${col}/r${row}`;
    };
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      expect(row.className).toContain('grid grid-cols-2');
      const [bill, count, average, total, last] = Array.from(row.querySelectorAll('td'));
      expect(placement(bill)).toBe('c1/r1');
      expect(placement(total)).toBe('c2/r1');
      // Average takes the LEFT track: its longest catalogue caption is the one
      // with no break opportunity, so it degrades into the column gap rather
      // than reopening the wrapper's sideways scroll.
      expect(placement(average)).toBe('c1/r2');
      expect(placement(count)).toBe('c2/r2');
      expect(placement(last)).toBe('c2/r3');
    }
  });

  it('lets the unbounded identity wrap instead of setting the table minimum', async () => {
    const container = await renderByBill();

    // Both identity lines are unbounded in the payload, so the cell may be
    // narrower than its own content (`min-w-0`) inside a `minmax(0,1fr)` track,
    // and a word too long for that track breaks. From `sm` up today's wrapping
    // comes back.
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      const identity = row.querySelector('td')!;
      expect(identity.className).toContain('min-w-0');
      expect(identity.className).toContain('break-words');
      expect(identity.className).toContain('sm:break-normal');
      // Not clamped: a clamp would cut the tail of a name no other surface
      // shows in full.
      expect(identity.className).not.toMatch(/line-clamp-\d/);
    }
  });

  it('keeps the row a table row from sm up and a grid below it', async () => {
    const container = await renderByBill();

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
    const container = await renderByBill();

    // The desktop output has to be what it is today: every cell `px-4 py-3`,
    // the count centred, the header cells untouched. Below `sm` the cells carry
    // no padding of their own -- the row supplies it.
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      expect(row.className).toContain('px-4 py-3');
      const cells = Array.from(row.querySelectorAll('td'));
      for (const cell of cells) {
        expect(cell.className).toContain('p-0');
        expect(cell.className).toContain('sm:px-4');
        expect(cell.className).toContain('sm:py-3');
      }
      // Payments is the one column this table centres on desktop.
      expect(cells[1].className).toContain('sm:text-center');
      // Total Paid keeps its emphasis.
      expect(cells[3].className).toContain('font-medium');
    }
    for (const th of Array.from(
      container.querySelectorAll('thead tr')[1].querySelectorAll('th'),
    )) {
      expect(th.className).toContain('px-4 py-3');
    }
  });

  it('restores the table semantics a phone restyle strips', async () => {
    const container = await renderByBill();

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

  it('keeps the whole row clickable from the card layout', async () => {
    const container = await renderByBill();

    const row = billRow(container, 'Water Utility')!;
    expect(row.className).toContain('cursor-pointer');
    // The row hover is the pair this table already draws; the card is a layout,
    // not a second affordance.
    expect(row.className).toContain('hover:bg-gray-50');
    await act(async () => {
      fireEvent.click(row);
    });
    expect(mockPush).toHaveBeenCalledWith('/bills');

    // A click landing on a captioned value cell is still a click on the row.
    mockPush.mockClear();
    await act(async () => {
      fireEvent.click(row.querySelectorAll('td')[3]);
    });
    expect(mockPush).toHaveBeenCalledWith('/bills');
  });
});
