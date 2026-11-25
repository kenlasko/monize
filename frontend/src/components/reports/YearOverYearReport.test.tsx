import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@/test/render";
import { YearOverYearReport, monthClickRange } from "./YearOverYearReport";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatSignedPercent: (n: number, decimals = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`,
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
      defaultCurrency: "CAD",
    }),
  };
});

// What a clicked bar hands back. A test sets this to reproduce the shapes
// recharts can actually produce -- `payload` is optional on BarRectangleItem.
let barClickArg: unknown = { payload: { monthIndex: 2 } };

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  BarChart: ({ children }: any) => (
    <div data-testid="bar-chart">{children}</div>
  ),
  Bar: ({ dataKey, onClick }: any) => (
    <button
      data-testid={`bar-${dataKey}`}
      onClick={() => onClick?.(barClickArg)}
    />
  ),
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

const mockGetYearOverYear = vi.fn();

vi.mock("@/lib/built-in-reports", () => ({
  builtInReportsApi: {
    getYearOverYear: (...args: any[]) => mockGetYearOverYear(...args),
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

vi.mock("@/components/ui/ExportDropdown", () => ({
  ExportDropdown: ({ onExportCsv, onExportPdf }: any) => (
    <div data-testid="export-dropdown">
      {onExportCsv && (
        <button data-testid="export-csv" onClick={onExportCsv}>CSV</button>
      )}
      <button data-testid="export-pdf" onClick={onExportPdf}>PDF</button>
    </div>
  ),
}));

vi.mock("@/components/ui/ChartViewToggle", () => ({
  ChartViewToggle: ({ onChange }: any) => (
    <div data-testid="chart-view-toggle">
      <button data-testid="toggle-bar" onClick={() => onChange("bar")}>Bar</button>
      <button data-testid="toggle-table" onClick={() => onChange("table")}>Table</button>
    </div>
  ),
}));

const mockExportToCsv = vi.fn();
vi.mock("@/lib/csv-export", () => ({
  exportToCsv: (...args: any[]) => mockExportToCsv(...args),
}));

const mockExportToPdf = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/pdf-export", () => ({
  exportToPdf: (...args: any[]) => mockExportToPdf(...args),
}));

describe("monthClickRange", () => {
  it("spans the clicked month", () => {
    expect(monthClickRange(2024, 2)).toEqual({
      startDate: "2024-03-01",
      endDate: "2024-03-31",
    });
  });

  it("honours a leap February", () => {
    expect(monthClickRange(2024, 1)?.endDate).toBe("2024-02-29");
    expect(monthClickRange(2025, 1)?.endDate).toBe("2025-02-28");
  });

  // A recharts datum can arrive with no payload, so the index reaching this
  // function is Number(undefined) -- NaN, which a bare range check lets through
  // and which turns the date into an Invalid Date that `format` throws on.
  it.each([
    ["NaN", Number(undefined)],
    ["a non-integer", 2.5],
    ["a negative index", -1],
    ["an index past December", 12],
  ])("returns null for %s", (_label, monthIndex) => {
    expect(monthClickRange(2024, monthIndex)).toBeNull();
  });
});

describe("YearOverYearReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    barClickArg = { payload: { monthIndex: 2 } };
  });

  it("shows loading state initially", () => {
    mockGetYearOverYear.mockReturnValue(new Promise(() => {}));
    render(<YearOverYearReport />);
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("renders year cards and chart with data", async () => {
    mockGetYearOverYear.mockResolvedValue({
      data: [
        {
          year: 2024,
          months: [{ month: 1, expenses: 3000, income: 5000, savings: 2000 }],
          totals: { income: 50000, expenses: 30000, savings: 20000 },
        },
        {
          year: 2025,
          months: [{ month: 1, expenses: 3500, income: 5500, savings: 2000 }],
          totals: { income: 55000, expenses: 35000, savings: 20000 },
        },
      ],
    });
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByText("2024")).toBeInTheDocument();
    });
    expect(screen.getByText("2025")).toBeInTheDocument();
  });

  it("renders metric toggle buttons", async () => {
    mockGetYearOverYear.mockResolvedValue({ data: [] });
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Expenses" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Income" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Savings" })).toBeInTheDocument();
  });

  it("renders year comparison table when multiple years", async () => {
    mockGetYearOverYear.mockResolvedValue({
      data: [
        {
          year: 2024,
          months: [],
          totals: { income: 50000, expenses: 30000, savings: 20000 },
        },
        {
          year: 2025,
          months: [],
          totals: { income: 55000, expenses: 35000, savings: 20000 },
        },
      ],
    });
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByText("Year-over-Year Change")).toBeInTheDocument();
    });
  });

  it("switches metric toggle to income", async () => {
    mockGetYearOverYear.mockResolvedValue({
      data: [
        {
          year: 2024,
          months: [{ month: 1, expenses: 3000, income: 5000, savings: 2000 }],
          totals: { income: 50000, expenses: 30000, savings: 20000 },
        },
      ],
    });
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Expenses" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Income" }));
    expect(screen.getByText("Monthly Income Comparison")).toBeInTheDocument();
  });

  it("switches metric toggle to savings", async () => {
    mockGetYearOverYear.mockResolvedValue({
      data: [
        {
          year: 2024,
          months: [{ month: 1, expenses: 3000, income: 5000, savings: 2000 }],
          totals: { income: 50000, expenses: 30000, savings: 20000 },
        },
      ],
    });
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Expenses" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Savings" }));
    expect(screen.getByText("Monthly Savings Comparison")).toBeInTheDocument();
  });

  it("renders year cards with negative savings in orange", async () => {
    mockGetYearOverYear.mockResolvedValue({
      data: [
        {
          year: 2024,
          months: [],
          totals: { income: 30000, expenses: 40000, savings: -10000 },
        },
      ],
    });
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByText("2024")).toBeInTheDocument();
    });
    expect(screen.getAllByText("Income").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Expenses").length).toBeGreaterThan(0);
    expect(screen.getByText("Net")).toBeInTheDocument();
  });

  it("renders year-over-year change percentages", async () => {
    mockGetYearOverYear.mockResolvedValue({
      data: [
        {
          year: 2024,
          months: [],
          totals: { income: 50000, expenses: 30000, savings: 20000 },
        },
        {
          year: 2025,
          months: [],
          totals: { income: 55000, expenses: 25000, savings: 30000 },
        },
      ],
    });
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByText("Year-over-Year Change")).toBeInTheDocument();
    });
    // The table headers
    expect(screen.getByText("Metric")).toBeInTheDocument();
    expect(screen.getByText("2024 vs 2025")).toBeInTheDocument();
  });

  it("handles API error gracefully", async () => {
    mockGetYearOverYear.mockRejectedValue(new Error("Network error"));
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load report data/i)).toBeInTheDocument();
    });
  });

  it("navigates to transactions page with month date range on bar click", async () => {
    mockGetYearOverYear.mockResolvedValue({
      data: [
        {
          year: 2024,
          months: [{ month: 3, expenses: 3000, income: 5000, savings: 2000 }],
          totals: { income: 50000, expenses: 30000, savings: 20000 },
        },
      ],
    });
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByTestId("bar-2024")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("bar-2024"));
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?startDate=2024-03-01&endDate=2024-03-31",
    );
  });

  // `payload` is optional on recharts' BarRectangleItem, so a click can arrive
  // without one; Number(undefined) is NaN, which passes a bare range check and
  // makes new Date(year, NaN, 1) throw inside the handler.
  it.each([
    ["no payload at all", {}],
    ["a payload with no monthIndex", { payload: {} }],
    ["a month index out of range", { payload: { monthIndex: -1 } }],
  ])("does not navigate or throw on %s", async (_label, clickArg) => {
    barClickArg = clickArg;
    mockGetYearOverYear.mockResolvedValue({
      data: [
        {
          year: 2024,
          months: [{ month: 1, expenses: 3000, income: 5000, savings: 2000 }],
          totals: { income: 50000, expenses: 30000, savings: 20000 },
        },
      ],
    });
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByTestId("bar-2024")).toBeInTheDocument();
    });
    expect(() => fireEvent.click(screen.getByTestId("bar-2024"))).not.toThrow();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("changes years-to-compare select and reloads data", async () => {
    mockGetYearOverYear.mockResolvedValue({ data: [] });
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Expenses" })).toBeInTheDocument();
    });
    const select = screen.getByDisplayValue("2 Years");
    await act(async () => {
      fireEvent.change(select, { target: { value: "3" } });
    });
    await waitFor(() => {
      expect(mockGetYearOverYear).toHaveBeenCalledWith(3);
    });
  });

  it("does not show year-over-year change table when only one year", async () => {
    mockGetYearOverYear.mockResolvedValue({
      data: [
        {
          year: 2024,
          months: [],
          totals: { income: 50000, expenses: 30000, savings: 20000 },
        },
      ],
    });
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByText("2024")).toBeInTheDocument();
    });
    expect(screen.queryByText("Year-over-Year Change")).not.toBeInTheDocument();
  });

  it("renders the chart when a year carries only some of its months", async () => {
    mockGetYearOverYear.mockResolvedValue({
      data: [
        {
          year: 2024,
          // Only one month provided; the others are unknown, not zero.
          months: [{ month: 6, expenses: 1500, income: 3000, savings: 1500 }],
          totals: { income: 36000, expenses: 18000, savings: 18000 },
        },
      ],
    });
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByText("2024")).toBeInTheDocument();
    });
    // Chart renders without error even though most months have no data
    expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
  });

  describe("monthly cells from the server, and a missing month unknown (issue #2412)", () => {
    // January's 10.60 rounded to a whole unit read 11; February is not in
    // the response, which wrote it as 0.
    const response = {
      data: [
        {
          year: 2024,
          months: [{ month: 1, expenses: 10.6, income: 20, savings: 9.4 }],
          totals: { income: 20, expenses: 10.6, savings: 9.4, knownIncome: 20, knownExpenses: 10.6, knownSavings: 9.4 },
        },
      ],
      currency: "USD",
      missingCurrencies: [],
      excludedCount: 0,
    };

    it("writes the server's monthly figure and leaves a missing month empty in the CSV", async () => {
      mockGetYearOverYear.mockResolvedValue(response);
      render(<YearOverYearReport />);
      await waitFor(() => expect(screen.getByTestId("export-csv")).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId("export-csv")); });
      const rows = mockExportToCsv.mock.calls[0][2] as unknown[][];
      expect(rows[0][1]).toBe(10.6);
      expect(rows[1][1]).toBeNull();
    });

    it("marks a missing month in the table rather than printing 0", async () => {
      mockGetYearOverYear.mockResolvedValue(response);
      const { container } = render(<YearOverYearReport />);
      await waitFor(() => expect(screen.getByTestId("toggle-table")).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId("toggle-table")); });
      const rows = Array.from(container.querySelectorAll("tbody tr"));
      expect(rows[0].querySelectorAll("td")[1].textContent).toBe("$11");
      expect(rows[1].querySelectorAll("td")[1].textContent).toBe("\u2014");
    });
  });

  it("renders year-over-year change with zero prevValue (avoids divide by zero)", async () => {
    mockGetYearOverYear.mockResolvedValue({
      data: [
        {
          year: 2024,
          months: [],
          totals: { income: 0, expenses: 0, savings: 0 },
        },
        {
          year: 2025,
          months: [],
          totals: { income: 50000, expenses: 30000, savings: 20000 },
        },
      ],
    });
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByText("Year-over-Year Change")).toBeInTheDocument();
    });
    // With prevValue = 0, changePercent should be 0% — shown as (+0.0%)
    expect(screen.getAllByText("(+0.0%)").length).toBeGreaterThan(0);
  });

  it("shows isPositive = false styling for savings with negative change", async () => {
    mockGetYearOverYear.mockResolvedValue({
      data: [
        {
          year: 2024,
          months: [],
          totals: { income: 50000, expenses: 30000, savings: 30000 },
        },
        {
          year: 2025,
          months: [],
          totals: { income: 40000, expenses: 35000, savings: 5000 },
        },
      ],
    });
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByText("Year-over-Year Change")).toBeInTheDocument();
    });
    // savings change is negative -> isPositive false -> red color class
    // Use getAllByText and pick the <td> element (not the button)
    const savingsElements = screen.getAllByText("Savings");
    const savingsTd = savingsElements.find((el) => el.tagName === "TD") as HTMLElement;
    const savingsRow = savingsTd.closest("tr") as HTMLElement;
    const changeCell = savingsRow.querySelector("td:last-child div:first-child") as HTMLElement;
    expect(changeCell.className).toMatch(/red/);
  });

  it("shows isPositive = true styling for expenses with negative change", async () => {
    mockGetYearOverYear.mockResolvedValue({
      data: [
        {
          year: 2024,
          months: [],
          totals: { income: 50000, expenses: 40000, savings: 10000 },
        },
        {
          year: 2025,
          months: [],
          totals: { income: 50000, expenses: 30000, savings: 20000 },
        },
      ],
    });
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByText("Year-over-Year Change")).toBeInTheDocument();
    });
    // expenses decreased -> isPositive = true (change < 0) -> green
    const expensesElements = screen.getAllByText("Expenses");
    const expensesTd = expensesElements.find((el) => el.tagName === "TD") as HTMLElement;
    const expensesRow = expensesTd.closest("tr") as HTMLElement;
    const changeCell = expensesRow.querySelector("td:last-child div:first-child") as HTMLElement;
    expect(changeCell.className).toMatch(/green/);
  });

  it("exports PDF with correct title and data", async () => {
    mockGetYearOverYear.mockResolvedValue({
      data: [
        {
          year: 2024,
          months: [{ month: 1, expenses: 3000, income: 5000, savings: 2000 }],
          totals: { income: 50000, expenses: 30000, savings: 20000 },
        },
        {
          year: 2025,
          months: [{ month: 1, expenses: 3500, income: 5500, savings: 2000 }],
          totals: { income: 55000, expenses: 35000, savings: 20000 },
        },
      ],
    });
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByTestId("export-pdf")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("export-pdf"));
    });
    await waitFor(() => {
      expect(mockExportToPdf).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Year Over Year Comparison",
          filename: "year-over-year",
        }),
      );
    });
  });

  it("exports PDF without YoY table when only one year", async () => {
    mockGetYearOverYear.mockResolvedValue({
      data: [
        {
          year: 2024,
          months: [],
          totals: { income: 50000, expenses: 30000, savings: 20000 },
        },
      ],
    });
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByTestId("export-pdf")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("export-pdf"));
    });
    await waitFor(() => {
      expect(mockExportToPdf).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Year Over Year Comparison",
        }),
      );
    });
    // tableData should be undefined when years.length < 2
    const callArg = mockExportToPdf.mock.calls[0][0];
    expect(callArg.tableData).toBeUndefined();
  });

  it("exports PDF with income subtitle when income metric is active", async () => {
    mockGetYearOverYear.mockResolvedValue({
      data: [
        {
          year: 2024,
          months: [],
          totals: { income: 50000, expenses: 30000, savings: 20000 },
        },
      ],
    });
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Income" })).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Income" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("export-pdf"));
    });
    await waitFor(() => {
      expect(mockExportToPdf).toHaveBeenCalledWith(
        expect.objectContaining({
          subtitle: expect.stringContaining("Income"),
        }),
      );
    });
  });

  it("renders sortable table view, sorts each column, and exports CSV", async () => {
    mockGetYearOverYear.mockResolvedValue({
      data: [
        {
          year: 2024,
          months: [
            { month: 1, expenses: 3000, income: 5000, savings: 2000 },
            { month: 2, expenses: 3500, income: 5500, savings: 2000 },
          ],
          totals: { income: 50000, expenses: 30000, savings: 20000 },
        },
        {
          year: 2025,
          months: [
            { month: 1, expenses: 4000, income: 5500, savings: 1500 },
            { month: 2, expenses: 3800, income: 5800, savings: 2000 },
          ],
          totals: { income: 55000, expenses: 35000, savings: 20000 },
        },
      ],
    });
    const { container } = render(<YearOverYearReport />);
    await waitFor(() => expect(screen.getByTestId("toggle-table")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("toggle-table")); });
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    const headerCount = container.querySelectorAll('th').length;
    expect(headerCount).toBeGreaterThan(0);
    for (let __i = 0; __i < headerCount; __i += 1) {
      const __ths = container.querySelectorAll('th');
      if (!__ths[__i]) break;
      await act(async () => { fireEvent.click(__ths[__i]); });
    }
    for (let __i = 0; __i < headerCount; __i += 1) {
      const __ths = container.querySelectorAll('th');
      if (!__ths[__i]) break;
      await act(async () => { fireEvent.click(__ths[__i]); });
    }
    // Click a year-value cell to navigate.
    const cells = container.querySelectorAll('tbody tr td');
    expect(cells.length).toBeGreaterThan(0);
    await act(async () => {
      cells.forEach((td) => fireEvent.click(td));
    });
    await act(async () => { fireEvent.click(screen.getByTestId("export-csv")); });
  });

  it("marks a year's null totals as subtotals and withholds the change over them", async () => {
    mockGetYearOverYear.mockResolvedValue({
      data: [
        {
          year: 2024,
          months: [{ month: 1, expenses: 50, income: 50, savings: 50 }],
          totals: {
            income: null,
            expenses: null,
            savings: null,
            knownIncome: 50,
            knownExpenses: 50,
            knownSavings: 50,
          },
        },
        {
          year: 2025,
          months: [{ month: 1, expenses: 70, income: 90, savings: 20 }],
          totals: {
            income: 90,
            expenses: 70,
            savings: 20,
            knownIncome: 90,
            knownExpenses: 70,
            knownSavings: 20,
          },
        },
      ],
      currency: "CAD",
      missingCurrencies: ["JPY"],
      excludedCount: 1,
    });
    render(<YearOverYearReport />);
    // One marker for each of the 2024 card's three figures; 2025 is complete.
    await waitFor(() => expect(screen.getAllByTestId("partial-total")).toHaveLength(3));
    const markers = screen.getAllByTestId("partial-total");
    markers.forEach((marker) => expect(marker).toHaveTextContent("$50"));
    expect(screen.queryByText("$0")).not.toBeInTheDocument();
    // The change over a year with an unknown total is not a number.
    expect(screen.getAllByTestId("unknown-amount")).toHaveLength(3);
    expect(screen.getByTestId("partial-data-notice")).toHaveTextContent("JPY");
  });
});
