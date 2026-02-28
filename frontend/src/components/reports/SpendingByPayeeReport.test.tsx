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

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  BarChart: ({ children }: any) => (
    <div data-testid="bar-chart">{children}</div>
  ),
  Bar: ({ onClick }: any) => (
    <button data-testid="bar-payee" onClick={() => onClick?.({ id: "p-1" })} />
  ),
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

const mockGetSpendingByPayee = vi.fn();

vi.mock("@/lib/built-in-reports", () => ({
  builtInReportsApi: {
    getSpendingByPayee: (...args: any[]) => mockGetSpendingByPayee(...args),
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

describe("SpendingByPayeeReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
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
});
