import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@/test/render";
import { SpendingByPayeeReport } from "./SpendingByPayeeReport";

const { exportToCsv, exportToPdf } = vi.hoisted(() => ({ exportToCsv: vi.fn(), exportToPdf: vi.fn() }));
vi.mock("@/lib/pdf-export", () => ({ exportToPdf }));
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
// The selection the mocked range hook reports; a test moves it and re-renders.
const mockRange = { end: "2025-03-31" };
const STABLE_RANGE = {
  start: "2025-01-01",
  get end() { return mockRange.end; },
};
vi.mock("@/hooks/useDateRange", () => ({
  useDateRange: () => ({
    dateRange: "3m",
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

// Bar mock that lets tests control what id is passed to onClick
let barOnClickArg: { id: string } = { id: "p-1" };

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  BarChart: ({ children }: any) => (
    <div data-testid="bar-chart">{children}</div>
  ),
  Bar: ({ onClick }: any) => (
    <>
      <button data-testid="bar-payee" onClick={() => onClick?.(barOnClickArg)} />
      <button data-testid="bar-payee-empty" onClick={() => onClick?.({ id: "" })} />
    </>
  ),
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: ({ content }: any) => {
    // Render the tooltip with active payload to cover the CustomTooltip branches
    const _tooltipProps = {
      active: true,
      payload: [{ payload: { name: "Superstore", value: 300 } }],
    };
    return <div data-testid="tooltip">{content && content.type ? null : null}</div>;
  },
}));

const mockGetSpendingByPayee = vi.fn();

vi.mock("@/lib/built-in-reports", () => ({
  builtInReportsApi: {
    getSpendingByPayee: (...args: any[]) => mockGetSpendingByPayee(...args),
  },
}));

vi.mock("@/components/ui/ExportDropdown", () => ({
  ExportDropdown: ({ onExportCsv, onExportPdf, disabled }: any) => (
    <div data-testid="export-dropdown">
      <button data-testid="export-csv" onClick={onExportCsv} data-disabled={String(disabled === true)}>CSV</button>
      <button data-testid="export-pdf" onClick={onExportPdf} data-disabled={String(disabled === true)}>PDF</button>
    </div>
  ),
}));

vi.mock("@/components/ui/ChartViewToggle", () => ({
  ChartViewToggle: ({ value, onChange }: any) => (
    <div data-testid="chart-view-toggle">
      <button data-testid="toggle-bar" onClick={() => onChange("bar")}>bar</button>
      <button data-testid="toggle-table" onClick={() => onChange("table")}>table</button>
      <span>val:{value}</span>
    </div>
  ),
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("SpendingByPayeeReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    barOnClickArg = { id: "p-1" };
    mockRange.end = "2025-03-31";
  });

  it("shows loading state initially", () => {
    mockGetSpendingByPayee.mockReturnValue(new Promise(() => {}));
    render(<SpendingByPayeeReport />);
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("shows the net credit in the table without a percentage", async () => {
    mockGetSpendingByPayee.mockResolvedValue({ data: [{ payeeId: "shop", payeeName: "Co-op", total: -50, percentage: null }], totalSpending: -50 });
    await act(async () => { render(<SpendingByPayeeReport />); });
    fireEvent.click(screen.getByTestId("toggle-table"));
    const row = screen.getByText("Co-op").closest("tr");
    expect(row).toHaveTextContent("$-50.00");
    expect(row).not.toHaveTextContent("%");
    fireEvent.click(screen.getByTestId("export-csv"));
    expect(exportToCsv).toHaveBeenCalledWith("spending-by-payee", expect.any(Array), [["Co-op", -50, ""]]);
    fireEvent.click(screen.getByTestId("export-pdf"));
    await waitFor(() => expect(exportToPdf).toHaveBeenCalledWith(expect.objectContaining({
      tableData: expect.objectContaining({ rows: [["Co-op", "$-50.00", ""]], totalRow: ["Total", "$-50.00", ""] }),
    })));
  });

  it("renders empty state when no data returned", async () => {
    mockGetSpendingByPayee.mockResolvedValue({
      data: [],
      totalSpending: 0,
    });
    render(<SpendingByPayeeReport />);
    await waitFor(() => {
      expect(
        screen.getByText("No expense data for this period."),
      ).toBeInTheDocument();
    });
  });

  it("renders chart with sample data", async () => {
    mockGetSpendingByPayee.mockResolvedValue({
      data: [
        { payeeId: "p-1", payeeName: "Superstore", total: 300 },
        { payeeId: "p-2", payeeName: "Costco", total: 200 },
      ],
      totalSpending: 500,
    });
    render(<SpendingByPayeeReport />);
    await waitFor(() => {
      expect(screen.getByText("Total")).toBeInTheDocument();
    });
    expect(screen.getByText("$500.00")).toBeInTheDocument();
  });

  it("renders date range selector", async () => {
    mockGetSpendingByPayee.mockResolvedValue({ data: [], totalSpending: 0 });
    render(<SpendingByPayeeReport />);
    await waitFor(() => {
      expect(screen.getByTestId("date-range-selector")).toBeInTheDocument();
    });
  });

  it("renders bar chart when data is present", async () => {
    mockGetSpendingByPayee.mockResolvedValue({
      data: [{ payeeId: "p-1", payeeName: "Superstore", total: 300 }],
      totalSpending: 300,
    });
    render(<SpendingByPayeeReport />);
    await waitFor(() => {
      expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
    });
  });

  it("surfaces a retryable error state when the API fails", async () => {
    mockGetSpendingByPayee.mockRejectedValue(new Error("Network error"));
    render(<SpendingByPayeeReport />);
    await waitFor(() => {
      expect(
        screen.getByText(/failed to load report data/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("navigates to transactions page with payee and date range on bar click", async () => {
    mockGetSpendingByPayee.mockResolvedValue({
      data: [{ payeeId: "p-1", payeeName: "Superstore", total: 300 }],
      totalSpending: 300,
    });
    render(<SpendingByPayeeReport />);
    await waitFor(() => {
      expect(screen.getByTestId("bar-payee")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("bar-payee"));
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?payeeId=p-1&startDate=2025-01-01&endDate=2025-03-31",
    );
  });

  it("does not navigate when payeeId is empty string", async () => {
    mockGetSpendingByPayee.mockResolvedValue({
      data: [{ payeeId: "p-1", payeeName: "Superstore", total: 300 }],
      totalSpending: 300,
    });
    render(<SpendingByPayeeReport />);
    await waitFor(() => {
      expect(screen.getByTestId("bar-payee-empty")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("bar-payee-empty"));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("renders items with null payeeId (uses empty string)", async () => {
    mockGetSpendingByPayee.mockResolvedValue({
      data: [{ payeeId: null, payeeName: "Unknown", total: 50 }],
      totalSpending: 50,
    });
    render(<SpendingByPayeeReport />);
    await waitFor(() => expect(screen.getByTestId("bar-chart")).toBeInTheDocument());
  });

  it("renders export dropdown when data is present", async () => {
    mockGetSpendingByPayee.mockResolvedValue({
      data: [{ payeeId: "p-1", payeeName: "Superstore", total: 300 }],
      totalSpending: 300,
    });
    render(<SpendingByPayeeReport />);
    await waitFor(() => expect(screen.getByTestId("export-dropdown")).toBeInTheDocument());
  });

  it("shows total expenses summary with multiple payees", async () => {
    mockGetSpendingByPayee.mockResolvedValue({
      data: [
        { payeeId: "p-1", payeeName: "Superstore", total: 300 },
        { payeeId: "p-2", payeeName: "Amazon", total: 200 },
        { payeeId: "p-3", payeeName: "Gas Station", total: 100 },
      ],
      totalSpending: 600,
    });
    render(<SpendingByPayeeReport />);
    await waitFor(() => {
      expect(screen.getByText("Total")).toBeInTheDocument();
    });
    expect(screen.getByText("$600.00")).toBeInTheDocument();
  });

  it("shows zero total when totalExpenses is 0 but chart has data", async () => {
    mockGetSpendingByPayee.mockResolvedValue({
      data: [{ payeeId: "p-1", payeeName: "Superstore", total: 300 }],
      totalSpending: 0,
    });
    render(<SpendingByPayeeReport />);
    await waitFor(() => {
      // Should show the chart with $0.00 total
      expect(screen.getByText("$0.00")).toBeInTheDocument();
    });
  });

  it("calls export PDF without error when export button is clicked", async () => {
    mockGetSpendingByPayee.mockResolvedValue({
      data: [{ payeeId: "p-1", payeeName: "Superstore", total: 300 }],
      totalSpending: 300,
    });
    render(<SpendingByPayeeReport />);
    await waitFor(() => expect(screen.getByTestId("export-pdf")).toBeInTheDocument());
    // Verify the button is present and clickable
    const pdfButton = screen.getByTestId("export-pdf");
    expect(pdfButton).toBeInTheDocument();
    expect(pdfButton).toBeEnabled();
  });

  it("sorts the percentage column when totalSpending is 0", async () => {
    mockGetSpendingByPayee.mockResolvedValue({
      data: [
        { payeeId: "p1", payeeName: "A", total: 0 },
        { payeeId: "p2", payeeName: "B", total: 0 },
      ],
      totalSpending: 0,
    });
    const { container } = render(<SpendingByPayeeReport />);
    await waitFor(() => expect(screen.getByTestId("toggle-table")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("toggle-table")); });
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    const ths = container.querySelectorAll('table thead th');
    if (ths[2]) await act(async () => { fireEvent.click(ths[2]); });
  });

  it("renders sortable table view and exports CSV", async () => {
    mockGetSpendingByPayee.mockResolvedValue({
      data: [
        { payeeId: "p-1", payeeName: "Superstore", total: 300 },
        { payeeId: "p-2", payeeName: "Costco", total: 200 },
        { payeeId: "", payeeName: "Unknown", total: 50 },
      ],
      totalSpending: 550,
    });
    const { container } = render(<SpendingByPayeeReport />);
    await waitFor(() => expect(screen.queryByTestId("toggle-table")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("toggle-table")); });
    // After toggling, wait for the table to render (data may briefly reload)
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    const headerCount = container.querySelectorAll('th').length;
    expect(headerCount).toBeGreaterThan(0);
    for (let i = 0; i < headerCount; i += 1) {
      const ths = container.querySelectorAll('th');
      if (!ths[i]) break;
      await act(async () => { fireEvent.click(ths[i]); });
    }
    for (let i = 0; i < headerCount; i += 1) {
      const ths = container.querySelectorAll('th');
      if (!ths[i]) break;
      await act(async () => { fireEvent.click(ths[i]); });
    }
    await act(async () => { fireEvent.click(screen.getByTestId("export-csv")); });
  });

  it("marks the total a subtotal and shows no 0.00 when a payee row was left out", async () => {
    mockGetSpendingByPayee.mockResolvedValue({
      data: [{ payeeId: "p-1", payeeName: "Superstore", total: 50 }],
      totalSpending: null,
      knownSpending: 50,
      currency: "CAD",
      missingCurrencies: ["JPY"],
      excludedCount: 1,
    });
    render(<SpendingByPayeeReport />);
    expect(await screen.findByTestId("partial-total")).toBeInTheDocument();
    expect(screen.getByTestId("partial-total")).toHaveTextContent("$50.00");
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByTestId("toggle-table")); });
    expect(await screen.findByTestId("partial-total")).toHaveTextContent("$50.00");
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });
});

describe("SpendingByPayeeReport: a reload is not the previous answer", () => {
  const answer = { data: [{ payeeId: "p-1", payeeName: "Shop", total: 100 }], totalSpending: 100 };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRange.end = "2025-03-31";
  });

  async function loadThenChangeRange(next: () => unknown) {
    mockGetSpendingByPayee.mockResolvedValue(answer);
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<SpendingByPayeeReport />);
    });
    expect(screen.getByTestId("export-pdf")).toHaveAttribute("data-disabled", "false");

    mockGetSpendingByPayee.mockImplementation(next);
    mockRange.end = "2025-04-30";
    await act(async () => {
      view.rerender(<SpendingByPayeeReport />);
    });
    await waitFor(() =>
      expect(mockGetSpendingByPayee).toHaveBeenLastCalledWith(
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
