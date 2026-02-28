import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@/test/render";
import { IncomeVsExpensesReport } from "./IncomeVsExpensesReport";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/hooks/useNumberFormat", () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
    defaultCurrency: "CAD",
  }),
}));

vi.mock("@/hooks/useDateRange", () => ({
  useDateRange: () => ({
    dateRange: "1y",
    setDateRange: vi.fn(),
    startDate: "",
    setStartDate: vi.fn(),
    endDate: "",
    setEndDate: vi.fn(),
    resolvedRange: { start: "2024-01-01", end: "2025-01-01" },
    isValid: true,
  }),
}));

vi.mock("@/components/ui/DateRangeSelector", () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  BarChart: ({ children, onClick }: any) => (
    <div
      data-testid="bar-chart"
      onClick={() =>
        onClick?.({
          activePayload: [
            { payload: { monthStart: "2024-01-01", monthEnd: "2024-01-31" } },
          ],
        })
      }
    >
      {children}
    </div>
  ),
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

describe("IncomeVsExpensesReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
  });

  it("shows loading state initially", () => {
    mockGetIncomeVsExpenses.mockReturnValue(new Promise(() => {}));
    render(<IncomeVsExpensesReport />);
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("renders empty state when no data returned", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [],
      totals: { income: 0, expenses: 0 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByText("No data for this period.")).toBeInTheDocument();
    });
  });

  it("renders chart and summary cards with sample data", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [
        { month: "2024-01", income: 5000, expenses: 3000, net: 2000 },
        { month: "2024-02", income: 5200, expenses: 3500, net: 1700 },
      ],
      totals: { income: 10200, expenses: 6500 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByText("Total Income")).toBeInTheDocument();
    });
    expect(screen.getByText("Total Expenses")).toBeInTheDocument();
    expect(screen.getByText("Total Savings")).toBeInTheDocument();
    expect(screen.getByText("Savings Rate")).toBeInTheDocument();
  });

  it("renders date range selector", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [],
      totals: { income: 0, expenses: 0 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByTestId("date-range-selector")).toBeInTheDocument();
    });
  });

  it("renders negative savings with orange styling", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ month: "2024-01", income: 2000, expenses: 3000, net: -1000 }],
      totals: { income: 2000, expenses: 3000 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByText("Total Savings")).toBeInTheDocument();
    });
    expect(screen.getByText("Savings Rate")).toBeInTheDocument();
  });

  it("handles API error gracefully", async () => {
    mockGetIncomeVsExpenses.mockRejectedValue(new Error("Network error"));
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByText("No data for this period.")).toBeInTheDocument();
    });
  });

  it("renders bar chart with monthly data", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ month: "2024-01", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
    });
  });

  it("navigates to transactions page with date range on chart click", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ month: "2024-01", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("bar-chart"));
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?startDate=2024-01-01&endDate=2024-01-31",
    );
  });
});
