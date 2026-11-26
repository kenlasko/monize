import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@/test/render";
import { IncomeBySourceReport } from "./IncomeBySourceReport";

const { exportToCsv } = vi.hoisted(() => ({ exportToCsv: vi.fn() }));
vi.mock("@/lib/csv-export", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/csv-export")>(),
  exportToCsv,
}));

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrencyCompact: (n: number) => `$${n.toFixed(2)}`,
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
      defaultCurrency: "CAD",
    }),
};
});
let mockIsValid = true;
// The selection the mocked range hook reports; a test moves it and re-renders.
const mockRange = { end: "2025-01-01" };
vi.mock("@/hooks/useDateRange", () => {
  const resolvedRange = {
    start: "2024-01-01",
    get end() { return mockRange.end; },
  };
  return {
    useDateRange: () => ({
      dateRange: "1y",
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
  CHART_COLOURS_INCOME: ["#22c55e", "#3b82f6", "#8b5cf6"],
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

const mockGetIncomeBySource = vi.fn();

vi.mock("@/lib/built-in-reports", () => ({
  builtInReportsApi: {
    getIncomeBySource: (...args: any[]) => mockGetIncomeBySource(...args),
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

// The account filter and the tag controls read these on mount; the report is
// the unchanged one while no key is chosen.
vi.mock("@/lib/accounts", () => ({
  accountsApi: { getAll: () => Promise.resolve([]) },
}));
vi.mock("@/lib/tags", () => ({
  tagsApi: { getAll: () => Promise.resolve([]) },
}));

describe("IncomeBySourceReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    mockIsValid = true;
    mockRange.end = "2025-01-01";
  });

  it("shows loading state initially", async () => {
    mockGetIncomeBySource.mockReturnValue(new Promise(() => {}));
    render(<IncomeBySourceReport />);
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
    // Flush the fetcher's resolution so its state update is wrapped in act().
    await act(async () => {});
  });

  it("shows the net credit in the table without a percentage", async () => {
    mockGetIncomeBySource.mockResolvedValue({ data: [{ categoryId: "salary", categoryName: "Salary", color: "", total: -50, percentage: null }], totalIncome: -50 });
    await act(async () => { render(<IncomeBySourceReport />); });
    const row = screen.getByText("Salary").closest("tr");
    expect(row).toHaveTextContent("$-50.00");
    expect(row?.lastElementChild).toHaveTextContent(/^% of Total—$/);
    fireEvent.click(screen.getByTestId("export-csv"));
    expect(exportToCsv).toHaveBeenCalledWith("income-by-source", expect.any(Array), [["Salary", -50, ""]]);
  });

  it("renders empty state when no data returned", async () => {
    mockGetIncomeBySource.mockResolvedValue({
      data: [],
      totalIncome: 0,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(
        screen.getByText("No income data for this period."),
      ).toBeInTheDocument();
    });
  });

  it("renders chart and legend with sample data", async () => {
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Salary", total: 5000, color: "" },
        {
          categoryId: "cat-2",
          categoryName: "Freelance",
          total: 1000,
          color: "",
        },
      ],
      totalIncome: 6000,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByText("Salary")).toBeInTheDocument();
    });
    expect(screen.getByText("Freelance")).toBeInTheDocument();
    expect(screen.getByText("Total Income")).toBeInTheDocument();
    expect(screen.getByText("$6000.00")).toBeInTheDocument();
  });

  it("renders controls", async () => {
    mockGetIncomeBySource.mockResolvedValue({ data: [], totalIncome: 0 });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByTestId("date-range-selector")).toBeInTheDocument();
    });
    expect(screen.getByTestId("chart-view-toggle")).toBeInTheDocument();
  });

  it("renders categories with provided colors", async () => {
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        {
          categoryId: "cat-1",
          categoryName: "Salary",
          total: 5000,
          color: "#00ff00",
        },
        { categoryId: "", categoryName: "Other", total: 500, color: "" },
      ],
      totalIncome: 5500,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByText("Salary")).toBeInTheDocument();
    });
    expect(screen.getByText("Other")).toBeInTheDocument();
    // The Other button should be disabled (no categoryId)
    const otherButton = screen.getByText("Other").closest("button");
    expect(otherButton).toBeDisabled();
  });

  it("shows percentages in legend", async () => {
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Salary", total: 8000, color: "" },
        {
          categoryId: "cat-2",
          categoryName: "Freelance",
          total: 2000,
          color: "",
        },
      ],
      totalIncome: 10000,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByText("$8000.00 (80.0%)")).toBeInTheDocument();
    });
    expect(screen.getByText("$2000.00 (20.0%)")).toBeInTheDocument();
  });

  it("reads each share from the server, divided from the unrounded figures (issue #2414)", async () => {
    // Two receipts of 1.00 EUR at 1.2474 in two categories: each reads 1.25
    // over 2.49, and 1.25 / 2.49 is 50.2%. The server's share is 50.
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Salary", total: 1.25, percentage: 50, color: "" },
        { categoryId: "cat-2", categoryName: "Bonus", total: 1.25, percentage: 50, color: "" },
      ],
      totalIncome: 2.49,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getAllByText("$1.25 (50.0%)")).toHaveLength(2);
    });
    expect(screen.queryByText(/50\.2%/)).not.toBeInTheDocument();
  });

  it("surfaces a retryable error state when the API fails", async () => {
    mockGetIncomeBySource.mockRejectedValue(new Error("Network error"));
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(
        screen.getByText(/failed to load report data/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("navigates to transactions page on category legend click", async () => {
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Salary", total: 5000, color: "" },
      ],
      totalIncome: 5000,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByText("Salary")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Salary"));
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?categoryId=cat-1&startDate=2024-01-01&endDate=2025-01-01",
    );
  });

  it("does not navigate when legend button has no categoryId", async () => {
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        { categoryId: "", categoryName: "Unknown", total: 500, color: "" },
      ],
      totalIncome: 500,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByText("Unknown")).toBeInTheDocument();
    });
    // Button is disabled so click should not call router.push
    const btn = screen.getByText("Unknown").closest("button")!;
    fireEvent.click(btn);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("switches to bar chart view when toggle is clicked", async () => {
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Salary", total: 5000, color: "" },
      ],
      totalIncome: 5000,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByText("Salary")).toBeInTheDocument();
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
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Salary", total: 5000, color: "" },
      ],
      totalIncome: 5000,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByText("Salary")).toBeInTheDocument();
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
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Salary", total: 8000, color: "#00ff00" },
        { categoryId: "cat-2", categoryName: "Freelance", total: 2000, color: "" },
      ],
      totalIncome: 10000,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByText("Salary")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("export-pdf"));
    await waitFor(() => {
      expect(mockExportToPdf).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Income by Source",
          filename: "income-by-source",
          chartLegend: expect.arrayContaining([
            expect.objectContaining({ label: expect.stringContaining("Salary") }),
          ]),
        }),
      );
    });
  });

  it("calls exportToPdf with undefined chartLegend when chart data is empty", async () => {
    mockExportToPdf.mockResolvedValue(undefined);
    // Data becomes empty after load
    mockGetIncomeBySource.mockResolvedValue({ data: [], totalIncome: 0 });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(
        screen.getByText("No income data for this period."),
      ).toBeInTheDocument();
    });
    // ExportDropdown is still rendered in controls even with empty data
    fireEvent.click(screen.getByTestId("export-pdf"));
    await waitFor(() => {
      expect(mockExportToPdf).toHaveBeenCalledWith(
        expect.objectContaining({
          chartLegend: undefined,
        }),
      );
    });
  });

  it("shows a zero percentage in the legend when totalIncome is zero", async () => {
    // "0.0%", not "0%": the share is rendered at one decimal like every
    // other row in this legend. The old code took a shortcut in this branch
    // -- a literal `'0'` beside `.toFixed(1)` for the computed one -- so the
    // no-data case was the only row that disagreed with its neighbours.
    // Simulate items but totalIncome = 0 (edge case data mismatch)
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Salary", total: 0, color: "" },
      ],
      totalIncome: 0,
    });
    render(<IncomeBySourceReport />);
    await waitFor(() => {
      expect(screen.getByText("Salary")).toBeInTheDocument();
    });
    // When totalIncome is 0, percentage should display as '0'
    expect(screen.getByText("$0.00 (0.0%)")).toBeInTheDocument();
  });

  it("does not load data when isValid is false", async () => {
    mockIsValid = false;
    mockGetIncomeBySource.mockResolvedValue({ data: [], totalIncome: 0 });
    render(<IncomeBySourceReport />);
    // loadData is gated on isValid, so the API should not be called
    expect(mockGetIncomeBySource).not.toHaveBeenCalled();
    // The fetcher resolves null when isValid is false; flush so that state
    // update is wrapped in act().
    await act(async () => {});
  });

  it("sorts table when totalIncome is zero (percentage sort branch)", async () => {
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        { categoryId: "c1", categoryName: "Z", total: 0, color: "" },
        { categoryId: "c2", categoryName: "A", total: 0, color: "" },
      ],
      totalIncome: 0,
    });
    const { container } = render(<IncomeBySourceReport />);
    await waitFor(() => expect(screen.getByTestId("toggle-table")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("toggle-table"));
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    const ths = container.querySelectorAll('table thead th');
    // Click '% of Total' header to exercise the totalIncome === 0 percentage branch.
    if (ths[2]) fireEvent.click(ths[2]);
    if (ths[0]) fireEvent.click(ths[0]);
  });

  it("renders sortable table view, sorts each column, exports CSV", async () => {
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        { categoryId: "c1", categoryName: "Salary", total: 5000, color: "" },
        { categoryId: "c2", categoryName: "Dividends", total: 200, color: "" },
        { categoryId: "", categoryName: "Other", total: 50, color: "" },
      ],
      totalIncome: 5250,
    });
    const { container } = render(<IncomeBySourceReport />);
    await waitFor(() => expect(screen.getByTestId("toggle-table")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("toggle-table"));
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    const headerCount = container.querySelectorAll('th').length;
    expect(headerCount).toBeGreaterThan(0);
    for (let i = 0; i < headerCount; i += 1) {
      const ths = container.querySelectorAll('th');
      if (!ths[i]) break;
      fireEvent.click(ths[i]);
    }
    for (let i = 0; i < headerCount; i += 1) {
      const ths = container.querySelectorAll('th');
      if (!ths[i]) break;
      fireEvent.click(ths[i]);
    }
    // Click row to navigate (one row has categoryId="").
    const rows = container.querySelectorAll('tbody tr');
    rows.forEach((tr) => fireEvent.click(tr));
    fireEvent.click(screen.getByTestId("export-csv"));
  });

  // A source row is the click target where it names a category, so it has to be
  // reachable and operable from the keyboard there as well (WCAG 2.1.1).
  // Before the fix this row was a `cursor-pointer` `<tr>` with an `onClick` and
  // no `tabIndex` and no `onKeyDown` -- the whole suite was green over a row no
  // keyboard user could use, so this case is what fails on that shape.
  it("activates a source row from the keyboard, and only where it is clickable", async () => {
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        { categoryId: "cat-1", categoryName: "Salary", total: 5000, color: "" },
        { categoryId: "", categoryName: "Other", total: 50, color: "" },
      ],
      totalIncome: 5050,
    });
    const { container } = render(<IncomeBySourceReport />);
    await waitFor(() => expect(screen.getByTestId("toggle-table")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("toggle-table"));
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());

    const rows = Array.from(container.querySelectorAll('tbody tr'));
    const clickable = rows.find((r) => r.textContent?.includes("Salary")) as HTMLElement;
    const inert = rows.find((r) => r.textContent?.includes("Other")) as HTMLElement;
    expect(clickable).toHaveAttribute('tabindex', '0');
    // A row whose click does nothing is not a tab stop either: a focus stop
    // that does nothing on Enter is one the reader has to escape.
    expect(inert).not.toHaveAttribute('tabindex');

    const expected =
      "/transactions?categoryId=cat-1&startDate=2024-01-01&endDate=2025-01-01";
    fireEvent.keyDown(clickable, { key: 'Enter' });
    expect(mockPush).toHaveBeenCalledWith(expected);

    mockPush.mockClear();
    fireEvent.keyDown(clickable, { key: ' ' });
    expect(mockPush).toHaveBeenCalledWith(expected);

    // A key the row does not claim stays the browser's, and the inert row
    // answers no key at all.
    mockPush.mockClear();
    fireEvent.keyDown(clickable, { key: 'a' });
    fireEvent.keyDown(inert, { key: 'Enter' });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("marks the total a subtotal and shows no 0.00 when an income row was left out", async () => {
    mockGetIncomeBySource.mockResolvedValue({
      data: [{ categoryId: "cat-1", categoryName: "Salary", total: 50, color: "" }],
      totalIncome: null,
      knownIncome: 50,
      currency: "CAD",
      missingCurrencies: ["JPY"],
      excludedCount: 1,
    });
    render(<IncomeBySourceReport />);
    expect(await screen.findByTestId("partial-total")).toBeInTheDocument();
    expect(screen.getByTestId("partial-total")).toHaveTextContent("$50.00");
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("toggle-table"));
    expect(await screen.findByTestId("partial-total")).toHaveTextContent("$50.00");
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });
});

describe("IncomeBySourceReport: a reload is not the previous answer", () => {
  const answer = { data: [{ categoryId: "cat-1", categoryName: "Salary", total: 5000, color: "#00ff00" }], totalIncome: 5000 };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRange.end = "2025-01-01";
  });

  async function loadThenChangeRange(next: () => unknown) {
    mockGetIncomeBySource.mockResolvedValue(answer);
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<IncomeBySourceReport />);
    });
    expect(screen.getByTestId("export-pdf")).toHaveAttribute("data-disabled", "false");

    mockGetIncomeBySource.mockImplementation(next);
    mockRange.end = "2025-02-28";
    await act(async () => {
      view.rerender(<IncomeBySourceReport />);
    });
    await waitFor(() =>
      expect(mockGetIncomeBySource).toHaveBeenLastCalledWith(
        expect.objectContaining({ endDate: "2025-02-28" }),
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
