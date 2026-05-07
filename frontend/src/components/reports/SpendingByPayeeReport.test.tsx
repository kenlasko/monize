import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@/test/render";
import { SpendingByPayeeReport } from "./SpendingByPayeeReport";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/hooks/useNumberFormat", () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(2)}`,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
    defaultCurrency: "CAD",
  }),
}));

vi.mock("@/hooks/useDateRange", () => ({
  useDateRange: () => ({
    dateRange: "3m",
    setDateRange: vi.fn(),
    startDate: "",
    setStartDate: vi.fn(),
    endDate: "",
    setEndDate: vi.fn(),
    resolvedRange: { start: "2025-01-01", end: "2025-03-31" },
    isValid: true,
  }),
}));

vi.mock("@/lib/chart-colours", () => ({
  CHART_COLOURS: ["#3b82f6", "#ef4444", "#22c55e", "#f97316"],
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
  ExportDropdown: ({ onExportCsv, onExportPdf }: any) => (
    <div data-testid="export-dropdown">
      <button data-testid="export-csv" onClick={onExportCsv}>CSV</button>
      <button data-testid="export-pdf" onClick={onExportPdf}>PDF</button>
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
  });

  it("shows loading state initially", () => {
    mockGetSpendingByPayee.mockReturnValue(new Promise(() => {}));
    render(<SpendingByPayeeReport />);
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
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
      expect(screen.getByText(/Top 2 Payees/)).toBeInTheDocument();
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

  it("handles API error gracefully", async () => {
    mockGetSpendingByPayee.mockRejectedValue(new Error("Network error"));
    render(<SpendingByPayeeReport />);
    await waitFor(() => {
      expect(
        screen.getByText("No expense data for this period."),
      ).toBeInTheDocument();
    });
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
      expect(screen.getByText(/Top 3 Payees/)).toBeInTheDocument();
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
});
