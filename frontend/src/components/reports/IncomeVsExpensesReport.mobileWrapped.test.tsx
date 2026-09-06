import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@/test/render";
import { IncomeVsExpensesReport } from "./IncomeVsExpensesReport";

/**
 * The phone layout of the Income vs Expenses table view.
 *
 * The table is ONE tree restyled by CSS (mechanism A): below `sm` the rows wrap
 * into a three-column, two-line grid and the column header row is hidden, from
 * `sm` up it is the ordinary table. jsdom applies no media queries, so both header rows and
 * every phone caption are in the DOM here at all times -- which is exactly what
 * lets these assertions read the phone markup without emulating a viewport, and
 * why the sort controls have to be addressed by position rather than by label
 * (each label matches the phone strip, the column header row, and a caption).
 */

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
  useNumberFormat: () => ({
    ...numberFormatMockDefaults(),
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
    defaultCurrency: "CAD",
  }),
  };
});

const STABLE_RANGE = { start: "2024-01-01", end: "2025-01-01" };
vi.mock("@/hooks/useDateRange", () => ({
  useDateRange: () => ({
    dateRange: "1y",
    setDateRange: vi.fn(),
    startDate: "",
    setStartDate: vi.fn(),
    endDate: "",
    setEndDate: vi.fn(),
    resolvedRange: STABLE_RANGE,
    isValid: true,
  }),
}));

vi.mock("@/components/ui/DateRangeSelector", () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock("@/components/ui/ChartViewToggle", () => ({
  ChartViewToggle: ({ onChange }: any) => (
    <div data-testid="chart-view-toggle">
      <button data-testid="toggle-table" onClick={() => onChange("table")}>Table</button>
    </div>
  ),
}));

vi.mock("@/components/ui/ExportDropdown", () => ({
  ExportDropdown: () => <div data-testid="export-dropdown" />,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
  ReferenceLine: () => null,
}));

const mockGetIncomeVsExpenses = vi.fn();

vi.mock("@/lib/built-in-reports", () => ({
  builtInReportsApi: {
    getIncomeVsExpenses: (...args: any[]) => mockGetIncomeVsExpenses(...args),
  },
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Worst case for a phone: six-figure income and expenses, and a month whose
// savings (and rate) are negative, so the sign colouring is exercised too.
const RESPONSE = {
  data: [
    { month: "2024-01", income: 125400, expenses: 98750, net: 26650 },
    { month: "2024-02", income: 101200, expenses: 143900, net: -42700 },
  ],
  totals: { income: 226600, expenses: 242650 },
};

async function renderTableView() {
  mockGetIncomeVsExpenses.mockResolvedValue(RESPONSE);
  const { container } = render(<IncomeVsExpensesReport />);
  await waitFor(() =>
    expect(screen.getByTestId("toggle-table")).toBeInTheDocument(),
  );
  await act(async () => {
    fireEvent.click(screen.getByTestId("toggle-table"));
  });
  await waitFor(() => expect(container.querySelector("table")).toBeInTheDocument());
  return container;
}

const rowText = (row: Element | null | undefined) => row?.textContent ?? "";

describe("IncomeVsExpensesReport (phone wrapped table)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
  });

  it("captions every amount inside the row so a phone needs no column header", async () => {
    const container = await renderTableView();

    const row = Array.from(container.querySelectorAll("tbody tr")).find((r) =>
      r.textContent?.includes("Jan 2024"),
    );
    expect(row).toBeDefined();
    // Each value names its own column, beside the value itself.
    for (const caption of ["Income", "Expenses", "Savings", "Savings Rate"]) {
      expect(rowText(row)).toContain(caption);
    }
    // Each caption sits immediately beside the value it names, as its own
    // text node, so a `getByText` on the value still matches the value node.
    expect(rowText(row)).toContain("Income$125400");
    expect(rowText(row)).toContain("Expenses$98750");
    expect(rowText(row)).toContain("Savings$26650");
    expect(rowText(row)).toContain("Savings Rate21%");
  });

  it("captions the totals row too, and keeps its negative savings signed", async () => {
    const container = await renderTableView();

    const footRow = container.querySelector("tfoot tr");
    for (const caption of ["Total", "Income", "Expenses", "Savings", "Savings Rate"]) {
      expect(rowText(footRow)).toContain(caption);
    }
    // Expenses exceed income across the range: a negative total and rate.
    expect(rowText(footRow)).toContain("Savings$-16050");
    expect(rowText(footRow)).toContain("-7.1%");
    const savingsCell = footRow?.querySelector(".row-start-1.col-start-2");
    expect(savingsCell?.className).toContain("text-orange-600");
  });

  it("places every cell on the phone grid explicitly, and never wraps a number", async () => {
    const container = await renderTableView();

    // Auto-flow placement is not deterministic once a cell is added or made
    // conditional, so each cell states its own column and line. A money value
    // stays on one line: a locale grouping thousands with a space would
    // otherwise break in the middle of a number.
    for (const row of [
      ...Array.from(container.querySelectorAll("tbody tr")),
      ...Array.from(container.querySelectorAll("tfoot tr")),
    ]) {
      const cells = Array.from(row.querySelectorAll("td"));
      expect(cells.length).toBe(5);
      for (const cell of cells) {
        expect(cell.className).toMatch(/\bcol-start-\d\b/);
        expect(cell.className).toMatch(/\brow-start-\d\b/);
      }
      // The four money cells (everything but the month/label) never wrap, and
      // each is right-aligned -- which is what keeps an over-long amount
      // overflowing toward the start edge (not scrollable) rather than
      // reopening the sideways scroll this layout exists to close.
      const money = cells.filter((c) => c.className.includes("whitespace-nowrap"));
      expect(money).toHaveLength(4);
      for (const cell of money) {
        expect(cell.className).toContain("text-right");
      }
    }
  });

  it("wraps each row onto two lines: month, savings and income, then rate and expenses", async () => {
    const container = await renderTableView();

    // The card is two lines tall, not three: every cell sits on line 1 or 2,
    // and each derived figure sits under the one it derives from -- the rate
    // under savings (spanning the first two tracks so its caption, the
    // longest in the table, has room), the expenses under income. DOM order
    // is the desktop column order, so the placement is read off the classes.
    const placement = (cell: Element) => {
      const col = /\bcol-start-(\d)\b/.exec(cell.className)?.[1];
      const row = /\brow-start-(\d)\b/.exec(cell.className)?.[1];
      const span = /\bcol-span-(\d)\b/.exec(cell.className)?.[1] ?? "1";
      return `c${col}/r${row}/s${span}`;
    };
    for (const row of [
      ...Array.from(container.querySelectorAll("tbody tr")),
      ...Array.from(container.querySelectorAll("tfoot tr")),
    ]) {
      const [month, income, expenses, savings, rate] = Array.from(row.querySelectorAll("td"));
      expect(row.className).toContain("grid-cols-3");
      expect(placement(month)).toBe("c1/r1/s1");
      expect(placement(savings)).toBe("c2/r1/s1");
      expect(placement(income)).toBe("c3/r1/s1");
      expect(placement(rate)).toBe("c1/r2/s2");
      expect(placement(expenses)).toBe("c3/r2/s1");
      // Nothing is placed on a third line.
      for (const cell of [month, income, expenses, savings, rate]) {
        expect(cell.className).not.toMatch(/\brow-start-3\b/);
      }
    }
  });

  it("keeps the row a table row from sm up and a grid below it", async () => {
    const container = await renderTableView();

    const table = container.querySelector("table");
    expect(table?.className).toContain("block");
    expect(table?.className).toContain("sm:table");
    expect(container.querySelector("tbody")?.className).toContain("sm:table-row-group");
    expect(container.querySelector("tfoot")?.className).toContain("sm:table-footer-group");
    const row = container.querySelector("tbody tr");
    expect(row?.className).toContain("grid grid-cols-3");
    expect(row?.className).toContain("sm:table-row");
    // The wrapper still scrolls horizontally, which is what the table needs
    // from `sm` up on a narrow desktop window.
    expect(table?.parentElement?.className).toContain("overflow-x-auto");
  });

  it("offers the same five sort controls on phones as in the column header", async () => {
    const container = await renderTableView();

    const headerRows = Array.from(container.querySelectorAll("thead tr"));
    expect(headerRows).toHaveLength(2);
    const [phoneRow, columnRow] = headerRows;
    // Exactly one of the two is displayed at any width.
    expect(phoneRow.className).toContain("sm:hidden");
    expect(columnRow.className).toContain("hidden");
    expect(columnRow.className).toContain("sm:table-row");

    // The sort indicator glyph rides inside each control, so compare the
    // labels with it stripped.
    const labelsOf = (row: Element) =>
      Array.from(row.querySelectorAll("th")).map((th) =>
        th.textContent?.replace(/[\u2191\u2193\u2195]/g, "").trim(),
      );
    const expected = ["Month", "Income", "Expenses", "Savings", "Savings Rate"];
    expect(labelsOf(phoneRow)).toEqual(expected);
    // Both rows are rendered from one list, so they cannot list different
    // fields -- assert it rather than trusting the loop.
    expect(labelsOf(columnRow)).toEqual(labelsOf(phoneRow));
  });

  it("sorts from the phone strip, not only from the column header", async () => {
    const container = await renderTableView();

    const monthOrder = () =>
      Array.from(container.querySelectorAll("tbody tr")).map(
        (r) => r.querySelector("td")?.textContent,
      );
    expect(monthOrder()).toEqual(["Jan 2024", "Feb 2024"]);

    // "Savings" in the phone strip: the fourth of the five controls in the
    // first header row (Month, Income, Expenses, Savings, Savings Rate).
    // Addressed by position because the label also appears in the column
    // header row and in every row's caption.
    const phoneSavings = container.querySelectorAll("thead tr")[0].querySelectorAll("th")[3];
    await act(async () => {
      fireEvent.click(phoneSavings);
    });
    // Ascending by savings puts February's -$42,700 first.
    expect(monthOrder()).toEqual(["Feb 2024", "Jan 2024"]);
  });
});
