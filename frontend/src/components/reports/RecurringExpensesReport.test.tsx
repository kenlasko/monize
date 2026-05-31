import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@/test/render";
import { RecurringExpensesReport } from "./RecurringExpensesReport";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/hooks/useNumberFormat", () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(2)}`,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    defaultCurrency: "CAD",
  }),
}));

vi.mock("@/lib/chart-colours", () => ({
  CHART_COLOURS: ["#3b82f6", "#ef4444", "#22c55e"],
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
}));

const mockGetRecurringExpenses = vi.fn();

vi.mock("@/lib/built-in-reports", () => ({
  builtInReportsApi: {
    getRecurringExpenses: (...args: any[]) => mockGetRecurringExpenses(...args),
  },
}));

const mockExportToCsv = vi.fn();
vi.mock("@/lib/csv-export", () => ({
  exportToCsv: (...args: any[]) => mockExportToCsv(...args),
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

describe("RecurringExpensesReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
  });

  it("shows loading state initially", () => {
    mockGetRecurringExpenses.mockReturnValue(new Promise(() => {}));
    render(<RecurringExpensesReport />);
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("renders empty state when no recurring expenses", async () => {
    mockGetRecurringExpenses.mockResolvedValue({
      data: [],
      summary: { uniquePayees: 0, totalRecurring: 0, monthlyEstimate: 0 },
    });
    render(<RecurringExpensesReport />);
    await waitFor(() => {
      expect(
        screen.getByText(/No recurring expenses found/),
      ).toBeInTheDocument();
    });
  });

  it("renders summary and table with data", async () => {
    mockGetRecurringExpenses.mockResolvedValue({
      data: [
        {
          payeeId: "p-1",
          payeeName: "Netflix",
          categoryName: "Entertainment",
          frequency: "Monthly",
          occurrences: 6,
          averageAmount: 15.99,
          totalAmount: 95.94,
          lastTransactionDate: "2025-01-15",
        },
      ],
      summary: {
        uniquePayees: 1,
        totalRecurring: 95.94,
        monthlyEstimate: 15.99,
      },
    });
    render(<RecurringExpensesReport />);
    await waitFor(() => {
      expect(screen.getByText("Netflix")).toBeInTheDocument();
    });
    expect(screen.getByText("Recurring Expenses")).toBeInTheDocument();
    expect(screen.getByText("6-Month Total")).toBeInTheDocument();
    expect(screen.getByText("Monthly Estimate")).toBeInTheDocument();
  });

  it("surfaces a retryable error state when the API fails", async () => {
    mockGetRecurringExpenses.mockRejectedValue(new Error("API error"));
    render(<RecurringExpensesReport />);
    await waitFor(() => {
      expect(
        screen.getByText(/failed to load report data/i),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
  });

  it("renders chart section with data", async () => {
    mockGetRecurringExpenses.mockResolvedValue({
      data: [
        {
          payeeId: "p-1",
          payeeName: "Netflix",
          categoryName: "Entertainment",
          frequency: "Monthly",
          occurrences: 6,
          averageAmount: 15.99,
          totalAmount: 95.94,
          lastTransactionDate: "2025-01-15",
        },
        {
          payeeId: "p-2",
          payeeName: "Gym",
          categoryName: "Health",
          frequency: "Monthly",
          occurrences: 6,
          averageAmount: 50.0,
          totalAmount: 300.0,
          lastTransactionDate: "2025-01-10",
        },
      ],
      summary: {
        uniquePayees: 2,
        totalRecurring: 395.94,
        monthlyEstimate: 65.99,
      },
    });
    render(<RecurringExpensesReport />);
    await waitFor(() => {
      expect(screen.getByText("Top 10 Recurring Expenses")).toBeInTheDocument();
    });
    expect(screen.getByText("All Recurring Expenses")).toBeInTheDocument();
    expect(screen.getByText("Netflix")).toBeInTheDocument();
    expect(screen.getByText("Gym")).toBeInTheDocument();
  });

  it("renders table with frequency badges for different types", async () => {
    mockGetRecurringExpenses.mockResolvedValue({
      data: [
        {
          payeeId: "p-1",
          payeeName: "Weekly Sub",
          categoryName: "Subscriptions",
          frequency: "Weekly",
          occurrences: 24,
          averageAmount: 5.0,
          totalAmount: 120.0,
          lastTransactionDate: "2025-01-15",
        },
        {
          payeeId: "p-2",
          payeeName: "Bi-weekly Pay",
          categoryName: "Services",
          frequency: "Bi-weekly",
          occurrences: 12,
          averageAmount: 30.0,
          totalAmount: 360.0,
          lastTransactionDate: "2025-01-12",
        },
        {
          payeeId: null,
          payeeName: "Quarterly Bill",
          categoryName: "Utilities",
          frequency: "Quarterly",
          occurrences: 3,
          averageAmount: 100.0,
          totalAmount: 300.0,
          lastTransactionDate: "2025-01-01",
        },
      ],
      summary: { uniquePayees: 3, totalRecurring: 780, monthlyEstimate: 130 },
    });
    render(<RecurringExpensesReport />);
    await waitFor(() => {
      expect(screen.getByText("Weekly")).toBeInTheDocument();
    });
    expect(screen.getByText("Bi-weekly")).toBeInTheDocument();
    expect(screen.getByText("Quarterly")).toBeInTheDocument();
  });

  it("renders minimum occurrences selector", async () => {
    mockGetRecurringExpenses.mockResolvedValue({
      data: [],
      summary: { uniquePayees: 0, totalRecurring: 0, monthlyEstimate: 0 },
    });
    render(<RecurringExpensesReport />);
    await waitFor(() => {
      expect(screen.getByText("Minimum occurrences:")).toBeInTheDocument();
    });
    expect(screen.getByText("(in last 6 months)")).toBeInTheDocument();
  });

  it("navigates to transactions page on table row click", async () => {
    mockGetRecurringExpenses.mockResolvedValue({
      data: [
        {
          payeeId: "p-1",
          payeeName: "Netflix",
          categoryName: "Entertainment",
          frequency: "Monthly",
          occurrences: 6,
          averageAmount: 15.99,
          totalAmount: 95.94,
          lastTransactionDate: "2025-01-15",
        },
      ],
      summary: {
        uniquePayees: 1,
        totalRecurring: 95.94,
        monthlyEstimate: 15.99,
      },
    });
    render(<RecurringExpensesReport />);
    await waitFor(() => {
      expect(screen.getByText("Netflix")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Netflix"));
    expect(mockPush).toHaveBeenCalledWith("/transactions?payeeId=p-1");
  });

  it("does not navigate when payeeId is null", async () => {
    mockGetRecurringExpenses.mockResolvedValue({
      data: [
        {
          payeeId: null,
          payeeName: "Unknown Store",
          categoryName: "Shopping",
          frequency: "Monthly",
          occurrences: 4,
          averageAmount: 50,
          totalAmount: 200,
          lastTransactionDate: "2025-01-10",
        },
      ],
      summary: { uniquePayees: 1, totalRecurring: 200, monthlyEstimate: 50 },
    });
    render(<RecurringExpensesReport />);
    await waitFor(() => expect(screen.getByText("Unknown Store")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Unknown Store"));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("exports CSV when export button clicked", async () => {
    mockGetRecurringExpenses.mockResolvedValue({
      data: [
        {
          payeeId: "p-1",
          payeeName: "Netflix",
          categoryName: "Entertainment",
          frequency: "Monthly",
          occurrences: 6,
          averageAmount: 15.99,
          totalAmount: 95.94,
          lastTransactionDate: "2025-01-15",
        },
      ],
      summary: { uniquePayees: 1, totalRecurring: 95.94, monthlyEstimate: 15.99 },
    });
    render(<RecurringExpensesReport />);
    await waitFor(() => expect(screen.getByTestId("export-csv")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("export-csv"));
    expect(mockExportToCsv).toHaveBeenCalledWith(
      "recurring-expenses",
      expect.any(Array),
      expect.any(Array),
    );
  });

  it("changes min occurrences when selector changes", async () => {
    mockGetRecurringExpenses.mockResolvedValue({
      data: [],
      summary: { uniquePayees: 0, totalRecurring: 0, monthlyEstimate: 0 },
    });
    render(<RecurringExpensesReport />);
    await waitFor(() => expect(screen.getByText("Minimum occurrences:")).toBeInTheDocument());
    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "5" } });
    await waitFor(() => expect(mockGetRecurringExpenses).toHaveBeenCalledWith(5));
  });

  it("exercises every sortable column on the recurring expenses table", async () => {
    mockGetRecurringExpenses.mockResolvedValue({
      data: [
        {
          payeeId: "p1",
          payeeName: "Netflix",
          categoryName: "Entertainment",
          frequency: "Monthly",
          occurrences: 6,
          averageAmount: 15,
          totalAmount: 90,
          lastTransactionDate: "2024-06-15",
        },
        {
          payeeId: "p2",
          payeeName: "Spotify",
          categoryName: "Entertainment",
          frequency: "Monthly",
          occurrences: 6,
          averageAmount: 10,
          totalAmount: 60,
          lastTransactionDate: "2024-06-10",
        },
      ],
      summary: { uniquePayees: 2, totalRecurring: 150, monthlyEstimate: 25 },
    });
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<RecurringExpensesReport />));
    });
    await waitFor(() => expect(container.querySelector("table")).toBeInTheDocument());
    const headerCount = container.querySelectorAll("table thead th").length;
    expect(headerCount).toBeGreaterThan(0);
    for (let __i = 0; __i < headerCount; __i += 1) {
      const __ths = container.querySelectorAll("table thead th");
      if (!__ths[__i]) break;
      await act(async () => { fireEvent.click(__ths[__i]); });
    }
    for (let __i = 0; __i < headerCount; __i += 1) {
      const __ths = container.querySelectorAll("table thead th");
      if (!__ths[__i]) break;
      await act(async () => { fireEvent.click(__ths[__i]); });
    }
  });
});
