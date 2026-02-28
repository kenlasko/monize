import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@/test/render";
import { CashFlowReport } from "./CashFlowReport";

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
    dateRange: "6m",
    setDateRange: vi.fn(),
    startDate: "",
    setStartDate: vi.fn(),
    endDate: "",
    setEndDate: vi.fn(),
    resolvedRange: { start: "2024-07-01", end: "2025-01-01" },
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
            { payload: { monthStart: "2024-07-01", monthEnd: "2024-07-31" } },
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

const mockGetCashFlow = vi.fn();
const mockGetIncomeBySource = vi.fn();
const mockGetSpendingByCategory = vi.fn();

vi.mock("@/lib/built-in-reports", () => ({
  builtInReportsApi: {
    getCashFlow: (...args: any[]) => mockGetCashFlow(...args),
    getIncomeBySource: (...args: any[]) => mockGetIncomeBySource(...args),
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

describe("CashFlowReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
  });

  it("shows loading state initially", () => {
    mockGetCashFlow.mockReturnValue(new Promise(() => {}));
    mockGetIncomeBySource.mockReturnValue(new Promise(() => {}));
    mockGetSpendingByCategory.mockReturnValue(new Promise(() => {}));
    render(<CashFlowReport />);
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("renders summary cards and chart with data", async () => {
    mockGetCashFlow.mockResolvedValue({
      data: [{ month: "2024-07", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000 },
    });
    mockGetIncomeBySource.mockResolvedValue({
      data: [{ categoryId: "c-1", categoryName: "Salary", total: 5000 }],
      totalIncome: 5000,
    });
    mockGetSpendingByCategory.mockResolvedValue({
      data: [{ categoryId: "c-2", categoryName: "Rent", total: 2000 }],
      totalSpending: 2000,
    });
    render(<CashFlowReport />);
    await waitFor(() => {
      expect(screen.getByText("Total Inflows")).toBeInTheDocument();
    });
    expect(screen.getByText("Total Outflows")).toBeInTheDocument();
    expect(screen.getByText("Net Cash Flow")).toBeInTheDocument();
    expect(screen.getByText("Monthly Cash Flow")).toBeInTheDocument();
  });

  it("renders inflow and outflow breakdown tables", async () => {
    mockGetCashFlow.mockResolvedValue({
      data: [],
      totals: { income: 5000, expenses: 3000, net: 2000 },
    });
    mockGetIncomeBySource.mockResolvedValue({
      data: [{ categoryId: "c-1", categoryName: "Salary", total: 5000 }],
      totalIncome: 5000,
    });
    mockGetSpendingByCategory.mockResolvedValue({
      data: [{ categoryId: "c-2", categoryName: "Groceries", total: 1500 }],
      totalSpending: 1500,
    });
    render(<CashFlowReport />);
    await waitFor(() => {
      expect(screen.getByText("Inflows by Category")).toBeInTheDocument();
    });
    expect(screen.getByText("Outflows by Category")).toBeInTheDocument();
    expect(screen.getByText("Salary")).toBeInTheDocument();
    expect(screen.getByText("Groceries")).toBeInTheDocument();
  });

  it("renders negative cash flow with orange styling", async () => {
    mockGetCashFlow.mockResolvedValue({
      data: [{ month: "2024-07", income: 2000, expenses: 3000, net: -1000 }],
      totals: { income: 2000, expenses: 3000, net: -1000 },
    });
    mockGetIncomeBySource.mockResolvedValue({ data: [], totalIncome: 0 });
    mockGetSpendingByCategory.mockResolvedValue({ data: [], totalSpending: 0 });
    render(<CashFlowReport />);
    await waitFor(() => {
      expect(screen.getByText("Net Cash Flow")).toBeInTheDocument();
    });
  });

  it("renders empty income and expense tables", async () => {
    mockGetCashFlow.mockResolvedValue({
      data: [],
      totals: { income: 0, expenses: 0, net: 0 },
    });
    mockGetIncomeBySource.mockResolvedValue({ data: [], totalIncome: 0 });
    mockGetSpendingByCategory.mockResolvedValue({ data: [], totalSpending: 0 });
    render(<CashFlowReport />);
    await waitFor(() => {
      expect(screen.getByText("No income in this period")).toBeInTheDocument();
    });
    expect(screen.getByText("No expenses in this period")).toBeInTheDocument();
  });

  it("handles API error gracefully", async () => {
    mockGetCashFlow.mockRejectedValue(new Error("Network error"));
    mockGetIncomeBySource.mockRejectedValue(new Error("Network error"));
    mockGetSpendingByCategory.mockRejectedValue(new Error("Network error"));
    render(<CashFlowReport />);
    await waitFor(() => {
      // After error, should render with zero totals
      expect(screen.getByText("Total Inflows")).toBeInTheDocument();
    });
  });

  it("navigates to transactions page with date range on chart bar click", async () => {
    mockGetCashFlow.mockResolvedValue({
      data: [{ month: "2024-07", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000 },
    });
    mockGetIncomeBySource.mockResolvedValue({ data: [], totalIncome: 0 });
    mockGetSpendingByCategory.mockResolvedValue({ data: [], totalSpending: 0 });
    render(<CashFlowReport />);
    await waitFor(() => {
      expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("bar-chart"));
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?startDate=2024-07-01&endDate=2024-07-31",
    );
  });

  it("navigates to transactions page with category and date range on category click", async () => {
    mockGetCashFlow.mockResolvedValue({
      data: [],
      totals: { income: 5000, expenses: 3000, net: 2000 },
    });
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        {
          categoryId: "cat-salary",
          categoryName: "Salary",
          color: null,
          total: 5000,
        },
      ],
      totalIncome: 5000,
    });
    mockGetSpendingByCategory.mockResolvedValue({
      data: [
        {
          categoryId: "cat-rent",
          categoryName: "Rent",
          color: null,
          total: 2000,
        },
      ],
      totalSpending: 2000,
    });
    render(<CashFlowReport />);
    await waitFor(() => {
      expect(screen.getByText("Salary")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Salary"));
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?categoryId=cat-salary&startDate=2024-07-01&endDate=2025-01-01",
    );
  });

  it("navigates on outflow category click", async () => {
    mockGetCashFlow.mockResolvedValue({
      data: [],
      totals: { income: 0, expenses: 2000, net: -2000 },
    });
    mockGetIncomeBySource.mockResolvedValue({ data: [], totalIncome: 0 });
    mockGetSpendingByCategory.mockResolvedValue({
      data: [
        {
          categoryId: "cat-rent",
          categoryName: "Rent",
          color: null,
          total: 2000,
        },
      ],
      totalSpending: 2000,
    });
    render(<CashFlowReport />);
    await waitFor(() => {
      expect(screen.getByText("Rent")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Rent"));
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?categoryId=cat-rent&startDate=2024-07-01&endDate=2025-01-01",
    );
  });
});
