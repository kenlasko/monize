import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, within } from "@/test/render";
import { SpendingByCategoryReport } from "./SpendingByCategoryReport";
import type { SpendingByCategoryResponse } from '@/types/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { usePreferencesStore } from '@/store/preferencesStore';

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: vi.fn(() => ({
      ...numberFormatMockDefaults(),
      formatCurrencyCompact: (n: number) => `$${n.toFixed(2)}`,
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
      defaultCurrency: "CAD",
    })),
  };
});
let mockIsValid = true;
// The selection the mocked range hook reports; a test moves it and re-renders.
const mockRange = { end: "2025-03-31" };
vi.mock("@/hooks/useDateRange", () => {
  const resolvedRange = {
    start: "2025-01-01",
    get end() { return mockRange.end; },
  };
  return {
    useDateRange: () => ({
      dateRange: "3m",
      setDateRange: vi.fn(),
      startDate: "",
      setStartDate: vi.fn(),
      endDate: "",
      setEndDate: vi.fn(),
      resolvedRange,
      get isValid() { return mockIsValid; },
    }),
  };
});

vi.mock("@/lib/chart-colours", () => ({
  CHART_COLOURS: ["#3b82f6", "#ef4444", "#22c55e", "#f97316"],
}));

vi.mock("@/components/ui/DateRangeSelector", () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock("@/components/ui/ChartViewToggle", () => ({
  ChartViewToggle: ({ onChange }: any) => (
    <div data-testid="chart-view-toggle">
      <button data-testid="toggle-bar" onClick={() => onChange("bar")}>Bar</button>
      <button data-testid="toggle-pie" onClick={() => onChange("pie")}>Pie</button>
      <button data-testid="toggle-table" onClick={() => onChange("table")}>Table</button>
    </div>
  ),
}));

vi.mock("@/components/ui/ExportDropdown", () => ({
  ExportDropdown: ({ onExportPdf, onExportCsv, disabled }: any) => (
    <div data-testid="export-dropdown">
      <button data-testid="export-pdf" onClick={onExportPdf} data-disabled={String(disabled === true)}>PDF</button>
      {onExportCsv && (
        <button data-testid="export-csv" onClick={onExportCsv} data-disabled={String(disabled === true)}>CSV</button>
      )}
    </div>
  ),
}));

const mockExportToCsv = vi.fn();
vi.mock("@/lib/csv-export", () => ({
  exportToCsv: (...args: unknown[]) => mockExportToCsv(...args),
}));

const mockExportToPdf = vi.fn();
vi.mock("@/lib/pdf-export", () => ({
  exportToPdf: (...args: any[]) => mockExportToPdf(...args),
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  PieChart: ({ children }: any) => (
    <div data-testid="pie-chart">{children}</div>
  ),
  Pie: () => null,
  Cell: () => null,
  Tooltip: () => null,
  BarChart: ({ children }: any) => (
    <div data-testid="bar-chart">{children}</div>
  ),
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
}));

const mockGetSpendingByCategory = vi.fn();

vi.mock("@/lib/built-in-reports", () => ({
  builtInReportsApi: {
    getSpendingByCategory: (...args: any[]) =>
      mockGetSpendingByCategory(...args),
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

/**
 * A report answer with nothing left out: `knownSpending` equals the total and
 * no currency was dropped, so every figure is complete.
 */
function completeReport(
  data: SpendingByCategoryResponse['data'],
  totalSpending: number,
): SpendingByCategoryResponse {
  return {
    data,
    totalSpending,
    knownSpending: totalSpending,
    currency: 'CAD',
    missingCurrencies: [],
    excludedCount: 0,
  };
}

// The account filter and the tag controls read these on mount; the report is
// the unchanged one while no key is chosen.
vi.mock("@/lib/accounts", () => ({
  accountsApi: { getAll: () => Promise.resolve([]) },
}));
vi.mock("@/lib/tags", () => ({
  tagsApi: { getAll: () => Promise.resolve([]) },
}));

describe("SpendingByCategoryReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    mockIsValid = true;
    mockRange.end = "2025-03-31";
  });

  it("shows loading state initially", async () => {
    mockGetSpendingByCategory.mockReturnValue(new Promise(() => {}));
    render(<SpendingByCategoryReport />);
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
    // Flush the fetcher's resolution so its state update is wrapped in act().
    await act(async () => {});
  });

  it("renders empty state when no data returned", async () => {
    mockGetSpendingByCategory.mockResolvedValue({
      data: [],
      totalSpending: 0,
      knownSpending: 0,
      currency: 'CAD',
      missingCurrencies: [],
      excludedCount: 0,
    });
    render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(
        screen.getByText("No expense data for this period."),
      ).toBeInTheDocument();
    });
  });

  it("renders chart and legend with sample data", async () => {
    mockGetSpendingByCategory.mockResolvedValue({
      data: [
        {
          categoryId: "cat-1",
          categoryName: "Groceries",
          total: 500,
          color: "#ff0000",
        },
        {
          categoryId: "cat-2",
          categoryName: "Utilities",
          total: 200,
          color: "",
        },
      ],
      totalSpending: 700,
      knownSpending: 700,
      currency: 'CAD',
      missingCurrencies: [],
      excludedCount: 0,
    });
    render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(screen.getByText("Groceries")).toBeInTheDocument();
    });
    expect(screen.getByText("Utilities")).toBeInTheDocument();
    expect(screen.getByText("Total Expenses")).toBeInTheDocument();
    expect(screen.getByText("$700.00")).toBeInTheDocument();
  });

  it("renders date range selector and chart view toggle", async () => {
    mockGetSpendingByCategory.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Food", total: 100, color: "" },
      ],
      totalSpending: 100,
      knownSpending: 100,
      currency: 'CAD',
      missingCurrencies: [],
      excludedCount: 0,
    });
    render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(screen.getByTestId("date-range-selector")).toBeInTheDocument();
    });
    expect(screen.getByTestId("chart-view-toggle")).toBeInTheDocument();
  });

  it("renders category with provided color and percentage", async () => {
    mockGetSpendingByCategory.mockResolvedValue({
      data: [
        {
          categoryId: "cat-1",
          categoryName: "Food",
          total: 300,
          color: "#ff0000",
        },
        { categoryId: "cat-2", categoryName: "Rent", total: 700, color: "" },
      ],
      totalSpending: 1000,
      knownSpending: 1000,
      currency: 'CAD',
      missingCurrencies: [],
      excludedCount: 0,
    });
    render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(screen.getByText("Food")).toBeInTheDocument();
    });
    expect(screen.getByText("Rent")).toBeInTheDocument();
    // Percentages in legend
    expect(screen.getByText("$300.00 (30.0%)")).toBeInTheDocument();
    expect(screen.getByText("$700.00 (70.0%)")).toBeInTheDocument();
  });

  it("keeps signed amounts and zero activity in the table, bar view and exports", async () => {
    mockGetSpendingByCategory.mockResolvedValue({
      ...completeReport([
        { categoryId: "cat-1", categoryName: "Food", total: 30, color: null },
        { categoryId: "cat-2", categoryName: "Clothes", total: -80, color: null },
        { categoryId: "cat-3", categoryName: "Travel", total: 0, color: null },
      ], -50),
      netSpending: true,
    });
    await act(async () => { render(<SpendingByCategoryReport />); });

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByTestId("pie-chart")).not.toBeInTheDocument();
    for (const amount of ["$30.00", "$-80.00", "$0.00", "$-50.00"]) {
      expect(screen.getByText(amount)).toBeInTheDocument();
    }
    expect(screen.queryAllByText(/%/)).toHaveLength(0);

    fireEvent.click(screen.getByTestId("export-csv"));
    expect(mockExportToCsv).toHaveBeenCalledWith("spending-by-category", expect.any(Array), [
      ["Food", 30, ""], ["Travel", 0, ""], ["Clothes", -80, ""],
    ]);
    fireEvent.click(screen.getByTestId("toggle-bar"));
    expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
    expect(screen.getByText("$-80.00")).toBeInTheDocument();
    expect(screen.queryAllByText(/%/)).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByTestId("export-pdf")); });
    expect(mockExportToPdf.mock.calls[0][0].chartLegend.map((line: { label: string }) => line.label))
      .toEqual(["Food - $30.00", "Clothes - $-80.00", "Travel - $0.00"]);
  });

  // The PostgreSQL regression posts the purchase and refund. Here the service
  // returns their net, and the row, headline and CSV must preserve its sign.
  it.each([
    { refund: 30, net: 70, amount: /^\$70(?:\.00)?$/, percentage: 100 },
    { refund: 100, net: 0, amount: /^\$0(?:\.00)?$/, percentage: undefined },
    { refund: 150, net: -50, amount: /^-\$50(?:\.00)?$/, percentage: undefined },
  ])("preserves the net from a 100 purchase and a $refund refund", async ({ net, amount, percentage }) => {
    const real = await vi.importActual<typeof import('@/hooks/useNumberFormat')>('@/hooks/useNumberFormat');
    mockGetSpendingByCategory.mockResolvedValue({
      ...completeReport([{ categoryId: "food", categoryName: "Groceries", total: net, percentage, color: null }], net),
      currency: "USD",
      netSpending: true,
    });
    const { preferences, updatePreferences } = usePreferencesStore.getState();
    updatePreferences({ numberFormat: "en-US", defaultCurrency: "USD" });
    try {
      await vi.mocked(useNumberFormat).withImplementation(real.useNumberFormat, async () => {
        let unmount!: () => void;
        await act(async () => { ({ unmount } = render(<SpendingByCategoryReport />)); });
        try {
          await screen.findByText("Groceries");
          if (percentage === undefined) {
            expect(screen.queryByTestId("pie-chart")).not.toBeInTheDocument();
          }
          fireEvent.click(screen.getByTestId("toggle-table"));
          const row = screen.getByRole("row", { name: /Groceries/ });
          const totalRow = screen.getByRole("row", { name: /^Total/ });
          expect(within(row).getByText(amount)).toBeInTheDocument();
          expect(within(totalRow).getByText(amount)).toBeInTheDocument();
          fireEvent.click(screen.getByTestId("export-csv"));
          expect(mockExportToCsv).toHaveBeenCalledWith("spending-by-category", expect.any(Array), [
            ["Groceries", net, percentage === undefined ? "" : "100.00%"],
          ]);
        } finally {
          unmount();
        }
      });
    } finally {
      usePreferencesStore.setState({ preferences });
    }
  });

  it("sorts signed amounts when a saved share sort has no visible column", async () => {
    const key = "reports.spending-by-category.table.sort";
    localStorage.setItem(key, JSON.stringify({field: "percentage", direction: "asc"}));
    try {
      mockGetSpendingByCategory.mockResolvedValue({
        ...completeReport([
          { categoryId: "dining", categoryName: "Dining", color: null, total: 80 },
          { categoryId: "travel", categoryName: "Travel", color: null, total: -50 },
        ], 30),
        netSpending: true,
      });
      await act(async () => { render(<SpendingByCategoryReport />); });
      const headers = screen.getAllByRole("columnheader", { name: "Amount" });
      for (const header of headers) expect(header).toHaveAttribute("aria-sort", "ascending");
      const rows = screen.getAllByRole("row").filter(row => row.querySelector("td"));
      expect(rows[0]).toHaveTextContent("Travel");
      fireEvent.click(headers[0]);
      for (const header of headers) expect(header).toHaveAttribute("aria-sort", "descending");
    } finally {
      localStorage.removeItem(key);
    }
  });

  it("keeps a fully refunded category visible when the entire period nets to zero", async () => {
    mockGetSpendingByCategory.mockResolvedValue({
      ...completeReport([{ categoryId: "food", categoryName: "Food", total: 0, color: null }], 0),
      netSpending: true,
    });
    await act(async () => { render(<SpendingByCategoryReport />); });
    expect(screen.getByRole("row", { name: /Food/ })).toHaveTextContent("$0.00");
    expect(screen.queryAllByText(/%/)).toHaveLength(0);
    expect(screen.queryByTestId("pie-chart")).not.toBeInTheDocument();
  });

  it("marks the known portion and leaves shares blank when a required rate is missing", async () => {
    mockGetSpendingByCategory.mockResolvedValue({
      ...completeReport([{ categoryId: "a", categoryName: "Food", total: 30, color: null }], 30),
      netSpending: true, totalSpending: null, missingCurrencies: ["JPY"], excludedCount: 1,
    });
    await act(async () => { render(<SpendingByCategoryReport />); });
    expect(screen.getByTestId("partial-total")).toHaveTextContent("$30.00");
    expect(screen.queryByTestId("pie-chart")).not.toBeInTheDocument();
    expect(screen.queryAllByText(/%/)).toHaveLength(0);
  });

  it("uses shares from before monetary rounding throughout a positive composition", async () => {
    // The two category amounts round to the same dollar. Their server shares differ.
    mockGetSpendingByCategory.mockResolvedValue({
      ...completeReport([
        { categoryId: "a", categoryName: "Food", total: 1, percentage: 50.2, color: null },
        { categoryId: "b", categoryName: "Travel", total: 1, percentage: 49.8, color: null },
      ], 2),
      netSpending: true,
    });
    await act(async () => { render(<SpendingByCategoryReport />); });
    expect(screen.getByTestId("pie-chart")).toBeInTheDocument();
    expect(screen.getByText(/\(50\.2%\)/)).toBeInTheDocument();
    expect(screen.getByText(/\(49\.8%\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("export-csv"));
    expect(mockExportToCsv).toHaveBeenCalledWith("spending-by-category", expect.any(Array), [
      ["Food", 1, "50.20%"], ["Travel", 1, "49.80%"],
    ]);
  });

  it("renders category without categoryId as disabled", async () => {
    mockGetSpendingByCategory.mockResolvedValue({
      data: [
        {
          categoryId: "",
          categoryName: "Uncategorized",
          total: 100,
          color: "",
        },
      ],
      totalSpending: 100,
      knownSpending: 100,
      currency: 'CAD',
      missingCurrencies: [],
      excludedCount: 0,
    });
    render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(screen.getByText("Uncategorized")).toBeInTheDocument();
    });
    // The button should be disabled
    const button = screen.getByText("Uncategorized").closest("button");
    expect(button).toBeDisabled();
  });

  it("surfaces a retryable error state when the API fails", async () => {
    mockGetSpendingByCategory.mockRejectedValue(new Error("Network error"));
    render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(
        screen.getByText(/failed to load report data/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("navigates to transactions page on category legend click", async () => {
    mockGetSpendingByCategory.mockResolvedValue({
      data: [
        {
          categoryId: "cat-1",
          categoryName: "Groceries",
          total: 500,
          color: "#ff0000",
        },
      ],
      totalSpending: 500,
      knownSpending: 500,
      currency: 'CAD',
      missingCurrencies: [],
      excludedCount: 0,
    });
    render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(screen.getByText("Groceries")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Groceries"));
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?categoryId=cat-1&startDate=2025-01-01&endDate=2025-03-31",
    );
  });

  it("does not navigate when legend button has no categoryId", async () => {
    mockGetSpendingByCategory.mockResolvedValue({
      data: [
        { categoryId: "", categoryName: "Uncategorized2", total: 50, color: "" },
      ],
      totalSpending: 50,
      knownSpending: 50,
      currency: 'CAD',
      missingCurrencies: [],
      excludedCount: 0,
    });
    render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(screen.getByText("Uncategorized2")).toBeInTheDocument();
    });
    const btn = screen.getByText("Uncategorized2").closest("button")!;
    fireEvent.click(btn);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("switches to bar chart view when toggle is clicked", async () => {
    mockGetSpendingByCategory.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Food", total: 300, color: "" },
      ],
      totalSpending: 300,
      knownSpending: 300,
      currency: 'CAD',
      missingCurrencies: [],
      excludedCount: 0,
    });
    render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(screen.getByText("Food")).toBeInTheDocument();
    });
    // Initially shows pie chart
    expect(screen.getByTestId("pie-chart")).toBeInTheDocument();
    // Switch to bar
    fireEvent.click(screen.getByTestId("toggle-bar"));
    await waitFor(() => {
      expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("pie-chart")).not.toBeInTheDocument();
  });

  it("switches back to pie chart view from bar view", async () => {
    mockGetSpendingByCategory.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Food", total: 300, color: "" },
      ],
      totalSpending: 300,
      knownSpending: 300,
      currency: 'CAD',
      missingCurrencies: [],
      excludedCount: 0,
    });
    render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(screen.getByText("Food")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("toggle-bar"));
    await waitFor(() => {
      expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("toggle-pie"));
    await waitFor(() => {
      expect(screen.getByTestId("pie-chart")).toBeInTheDocument();
    });
  });

  it("calls exportToPdf with legend items when data is present", async () => {
    mockExportToPdf.mockResolvedValue(undefined);
    mockGetSpendingByCategory.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Food", total: 300, color: "#ff0000" },
        { categoryId: "cat-2", categoryName: "Rent", total: 700, color: "" },
      ],
      totalSpending: 1000,
      knownSpending: 1000,
      currency: 'CAD',
      missingCurrencies: [],
      excludedCount: 0,
    });
    render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(screen.getByText("Food")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("export-pdf"));
    await waitFor(() => {
      expect(mockExportToPdf).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Spending by Category",
          filename: "spending-by-category",
          chartLegend: expect.arrayContaining([
            expect.objectContaining({ label: expect.stringContaining("Food") }),
          ]),
        }),
      );
    });
  });

  it("calls exportToPdf with undefined chartLegend when chart data is empty", async () => {
    mockExportToPdf.mockResolvedValue(undefined);
    mockGetSpendingByCategory.mockResolvedValue(completeReport([], 0));
    render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(
        screen.getByText("No expense data for this period."),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("export-pdf"));
    await waitFor(() => {
      expect(mockExportToPdf).toHaveBeenCalledWith(
        expect.objectContaining({
          chartLegend: undefined,
        }),
      );
    });
  });

  it("shows a zero percentage in the legend when totalExpenses is zero", async () => {
    // "0.0%", not "0%": the share is rendered at one decimal like every
    // other row in this legend. The old code took a shortcut in this branch
    // -- a literal `'0'` beside `.toFixed(1)` for the computed one -- so the
    // no-data case was the only row that disagreed with its neighbours.
    mockGetSpendingByCategory.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Food", total: 0, color: "" },
      ],
      totalSpending: 0,
      knownSpending: 0,
      currency: 'CAD',
      missingCurrencies: [],
      excludedCount: 0,
    });
    render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(screen.getByText("Food")).toBeInTheDocument();
    });
    // When totalExpenses is 0, percentage should display as '0'
    expect(screen.getByText("$0.00 (0.0%)")).toBeInTheDocument();
  });

  it("does not load data when isValid is false", async () => {
    mockIsValid = false;
    mockGetSpendingByCategory.mockResolvedValue(completeReport([], 0));
    render(<SpendingByCategoryReport />);
    // loadData is gated on isValid, so the API should not be called
    expect(mockGetSpendingByCategory).not.toHaveBeenCalled();
    // The fetcher resolves null when isValid is false; flush so that state
    // update is wrapped in act().
    await act(async () => {});
  });

  it("sorts the percentage column when totalExpenses is 0", async () => {
    mockGetSpendingByCategory.mockResolvedValue({
      data: [
        { categoryId: "c1", categoryName: "A", total: 0, color: "" },
        { categoryId: "c2", categoryName: "B", total: 0, color: "" },
      ],
      totalSpending: 0,
      knownSpending: 0,
      currency: 'CAD',
      missingCurrencies: [],
      excludedCount: 0,
    });
    const { container } = render(<SpendingByCategoryReport />);
    await waitFor(() => expect(screen.getByTestId("toggle-table")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("toggle-table"));
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    const ths = container.querySelectorAll('table thead th');
    if (ths[2]) fireEvent.click(ths[2]);
  });

  it("renders sortable table view with rows and totals row", async () => {
    mockGetSpendingByCategory.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Food", total: 300, color: "" },
        { categoryId: "cat-2", categoryName: "Rent", total: 700, color: "" },
        { categoryId: "", categoryName: "Uncategorized", total: 50, color: "" },
      ],
      totalSpending: 1050,
      knownSpending: 1050,
      currency: 'CAD',
      missingCurrencies: [],
      excludedCount: 0,
    });
    render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(screen.getByTestId("toggle-table")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("toggle-table"));
    // Each header label now appears in three places (the phone sort strip, the
    // column header row and the cell captions), so address the column header
    // row by position rather than by label.
    const columnHeader = document.querySelectorAll("table thead tr")[1];
    const [categoryHeader, amountHeader, pctHeader] = Array.from(
      columnHeader.querySelectorAll("th"),
    );
    fireEvent.click(categoryHeader); // sort by name
    fireEvent.click(categoryHeader); // toggle desc
    fireEvent.click(pctHeader);
    fireEvent.click(amountHeader);
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
    // Clicking a row navigates if it has a categoryId.
    fireEvent.click(screen.getAllByText("Food")[0].closest("tr")!);
    expect(mockPush).toHaveBeenCalled();
  });

  it("exports CSV from the table view", async () => {
    mockGetSpendingByCategory.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Food", total: 300, color: "" },
      ],
      totalSpending: 300,
      knownSpending: 300,
      currency: 'CAD',
      missingCurrencies: [],
      excludedCount: 0,
    });
    render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(screen.getByTestId("toggle-table")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("toggle-table"));
    // CSV button should appear; it just needs to fire without throwing.
    fireEvent.click(screen.getByTestId("export-csv"));
  });

  // A category row is the click target where it names a category, so it has to
  // be reachable and operable from the keyboard there as well (WCAG 2.1.1).
  // Before the fix this row was a `cursor-pointer` `<tr>` with an `onClick` and
  // no `tabIndex` and no `onKeyDown` -- the whole suite was green over a row no
  // keyboard user could use, so this case is what fails on that shape.
  it("activates a category row from the keyboard, and only where it is clickable", async () => {
    mockGetSpendingByCategory.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Food", total: 300, color: "" },
        { categoryId: "", categoryName: "Uncategorized", total: 50, color: "" },
      ],
      totalSpending: 350,
      knownSpending: 350,
      currency: 'CAD',
      missingCurrencies: [],
      excludedCount: 0,
    });
    const { container } = render(<SpendingByCategoryReport />);
    await waitFor(() => {
      expect(screen.getByTestId("toggle-table")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("toggle-table"));
    await waitFor(() => expect(container.querySelector("table")).toBeInTheDocument());

    const rows = Array.from(container.querySelectorAll("tbody tr"));
    const clickable = rows.find((r) => r.textContent?.includes("Food")) as HTMLElement;
    const inert = rows.find((r) => r.textContent?.includes("Uncategorized")) as HTMLElement;
    expect(clickable).toHaveAttribute("tabindex", "0");
    // A row whose click does nothing is not a tab stop either: a focus stop
    // that does nothing on Enter is one the reader has to escape.
    expect(inert).not.toHaveAttribute("tabindex");

    const expected =
      "/transactions?categoryId=cat-1&startDate=2025-01-01&endDate=2025-03-31";
    fireEvent.keyDown(clickable, { key: "Enter" });
    expect(mockPush).toHaveBeenCalledWith(expected);

    mockPush.mockClear();
    fireEvent.keyDown(clickable, { key: " " });
    expect(mockPush).toHaveBeenCalledWith(expected);

    // A key the row does not claim stays the browser's, and the inert row
    // answers no key at all.
    mockPush.mockClear();
    fireEvent.keyDown(clickable, { key: "a" });
    fireEvent.keyDown(inert, { key: "Enter" });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('marks the total a subtotal when the server left a row out', async () => {
    // The server withholds `totalSpending` when a row could not be converted.
    // What is shown is the part that did convert, marked -- never the smaller
    // figure presented as the whole.
    mockGetSpendingByCategory.mockResolvedValue({
      data: [{ categoryId: 'c1', categoryName: 'Food', color: null, total: 100 }],
      totalSpending: null,
      knownSpending: 100,
      currency: 'CAD',
      missingCurrencies: ['JPY'],
      excludedCount: 1,
    } satisfies SpendingByCategoryResponse);

    await act(async () => {
      render(<SpendingByCategoryReport />);
    });

    expect(await screen.findByTestId('partial-total')).toBeInTheDocument();
  });

  it('carries the partial note onto the PDF card the screen marks', async () => {
    mockExportToPdf.mockResolvedValue(undefined);
    mockGetSpendingByCategory.mockResolvedValue({
      data: [{ categoryId: 'c1', categoryName: 'Food', color: null, total: 100 }],
      totalSpending: null,
      knownSpending: 100,
      currency: 'CAD',
      missingCurrencies: ['JPY'],
      excludedCount: 1,
    } satisfies SpendingByCategoryResponse);

    await act(async () => {
      render(<SpendingByCategoryReport />);
    });
    await screen.findByText('Food');
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });

    const cards = mockExportToPdf.mock.calls[0][0].summaryCards as Array<{ note?: string }>;
    expect(cards[0].note).toEqual(expect.stringContaining('JPY'));
  });

  it('writes no note on the PDF card of a complete report', async () => {
    mockExportToPdf.mockResolvedValue(undefined);
    mockGetSpendingByCategory.mockResolvedValue(
      completeReport(
        [{ categoryId: 'c1', categoryName: 'Food', color: null, total: 100 }],
        100,
      ),
    );
    await act(async () => {
      render(<SpendingByCategoryReport />);
    });
    await screen.findByText('Food');
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-pdf'));
    });
    const cards = mockExportToPdf.mock.calls[0][0].summaryCards as Array<{ note?: string }>;
    expect(cards[0].note).toBeUndefined();
  });

  it('leaves a complete total unmarked', async () => {
    mockGetSpendingByCategory.mockResolvedValue(
      completeReport(
        [{ categoryId: 'c1', categoryName: 'Food', color: null, total: 100 }],
        100,
      ),
    );

    await act(async () => {
      render(<SpendingByCategoryReport />);
    });

    expect(screen.queryByTestId('partial-total')).toBeNull();
  });
});

describe("SpendingByCategoryReport: a reload is not the previous answer", () => {
  const answer = completeReport(
    [{ categoryId: "cat-1", categoryName: "Groceries", total: 500, color: "#ff0000" }],
    500,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsValid = true;
    mockRange.end = "2025-03-31";
  });

  async function loadThenChangeRange(next: () => unknown) {
    mockGetSpendingByCategory.mockResolvedValue(answer);
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<SpendingByCategoryReport />);
    });
    expect(screen.getByTestId("export-pdf")).toHaveAttribute("data-disabled", "false");

    mockGetSpendingByCategory.mockImplementation(next);
    mockRange.end = "2025-04-30";
    await act(async () => {
      view.rerender(<SpendingByCategoryReport />);
    });
    await waitFor(() =>
      expect(mockGetSpendingByCategory).toHaveBeenLastCalledWith(
        expect.objectContaining({ endDate: "2025-04-30" }),
      ),
    );
  }

  it("disables the export while the next request has failed", async () => {
    await loadThenChangeRange(() => Promise.reject(new Error("500")));
    expect(screen.getByTestId("export-pdf")).toHaveAttribute("data-disabled", "true");
    expect(screen.getByTestId("export-csv")).toHaveAttribute("data-disabled", "true");
  });

  it("disables the export while the next request is pending", async () => {
    await loadThenChangeRange(() => new Promise(() => {}));
    expect(screen.getByTestId("export-pdf")).toHaveAttribute("data-disabled", "true");
    expect(screen.getByTestId("export-csv")).toHaveAttribute("data-disabled", "true");
  });
});
