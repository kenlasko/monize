import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@/test/render";
import { UncategorizedTransactionsReport } from "./UncategorizedTransactionsReport";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/hooks/useNumberFormat", () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    defaultCurrency: "CAD",
  }),
}));

const stableResolvedRange = { start: "2025-01-01", end: "2025-03-31" };

vi.mock("@/hooks/useDateRange", () => ({
  useDateRange: () => ({
    dateRange: "3m",
    setDateRange: vi.fn(),
    resolvedRange: stableResolvedRange,
    isValid: true,
  }),
}));

vi.mock("@/lib/utils", () => ({
  parseLocalDate: (d: string) => new Date(d + "T00:00:00"),
}));

vi.mock("@/components/ui/DateRangeSelector", () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

const mockGetUncategorizedTransactions = vi.fn();

vi.mock("@/lib/built-in-reports", () => ({
  builtInReportsApi: {
    getUncategorizedTransactions: (...args: any[]) =>
      mockGetUncategorizedTransactions(...args),
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

describe("UncategorizedTransactionsReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
  });

  it("shows loading state initially", () => {
    mockGetUncategorizedTransactions.mockReturnValue(new Promise(() => {}));
    render(<UncategorizedTransactionsReport />);
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("renders all-categorized message when no uncategorized transactions", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [],
      summary: {
        totalCount: 0,
        expenseCount: 0,
        expenseTotal: 0,
        incomeCount: 0,
        incomeTotal: 0,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(
        screen.getByText(/All transactions are categorized/),
      ).toBeInTheDocument();
    });
  });

  it("renders transaction table with data", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-1",
          transactionDate: "2025-02-15",
          payeeName: "Unknown Store",
          description: "Card payment",
          accountName: "Chequing",
          amount: -50.0,
        },
      ],
      summary: {
        totalCount: 1,
        expenseCount: 1,
        expenseTotal: 50,
        incomeCount: 0,
        incomeTotal: 0,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText("Unknown Store")).toBeInTheDocument();
    });
    expect(screen.getByText("Total Uncategorized")).toBeInTheDocument();
  });

  it("renders summary cards", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [],
      summary: {
        totalCount: 5,
        expenseCount: 3,
        expenseTotal: 150,
        incomeCount: 2,
        incomeTotal: 500,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText("Total Uncategorized")).toBeInTheDocument();
    });
    expect(screen.getByText("Uncategorized Expenses")).toBeInTheDocument();
    expect(screen.getByText("Uncategorized Income")).toBeInTheDocument();
  });

  it("filters transactions by expense type", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-1",
          transactionDate: "2025-02-15",
          payeeName: "Store A",
          description: "",
          accountName: "Chequing",
          amount: -50,
        },
        {
          id: "tx-2",
          transactionDate: "2025-02-16",
          payeeName: "Employer",
          description: "",
          accountName: "Chequing",
          amount: 200,
        },
      ],
      summary: {
        totalCount: 2,
        expenseCount: 1,
        expenseTotal: 50,
        incomeCount: 1,
        incomeTotal: 200,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText("Store A")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Expenses"));
    expect(screen.getByText("Store A")).toBeInTheDocument();
    expect(screen.queryByText("Employer")).not.toBeInTheDocument();
  });

  it("filters transactions by income type", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-1",
          transactionDate: "2025-02-15",
          payeeName: "Store A",
          description: "",
          accountName: "Chequing",
          amount: -50,
        },
        {
          id: "tx-2",
          transactionDate: "2025-02-16",
          payeeName: "Employer",
          description: "",
          accountName: "Chequing",
          amount: 200,
        },
      ],
      summary: {
        totalCount: 2,
        expenseCount: 1,
        expenseTotal: 50,
        incomeCount: 1,
        incomeTotal: 200,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText("Store A")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Income"));
    expect(screen.queryByText("Store A")).not.toBeInTheDocument();
    expect(screen.getByText("Employer")).toBeInTheDocument();
  });

  it("sorts transactions by clicking column headers", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-1",
          transactionDate: "2025-02-15",
          payeeName: "Alpha",
          description: "",
          accountName: "Chequing",
          amount: -50,
        },
        {
          id: "tx-2",
          transactionDate: "2025-02-16",
          payeeName: "Beta",
          description: "",
          accountName: "Savings",
          amount: -100,
        },
      ],
      summary: {
        totalCount: 2,
        expenseCount: 2,
        expenseTotal: 150,
        incomeCount: 0,
        incomeTotal: 0,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText("Alpha")).toBeInTheDocument();
    });
    const payeeHeader = screen.getByText("Payee / Description");
    fireEvent.click(payeeHeader);
    fireEvent.click(payeeHeader);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("sorts by amount column", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-1",
          transactionDate: "2025-02-15",
          payeeName: "Store A",
          description: "",
          accountName: "Chequing",
          amount: -50,
        },
        {
          id: "tx-2",
          transactionDate: "2025-02-16",
          payeeName: "Store B",
          description: "",
          accountName: "Chequing",
          amount: -100,
        },
      ],
      summary: {
        totalCount: 2,
        expenseCount: 2,
        expenseTotal: 150,
        incomeCount: 0,
        incomeTotal: 0,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText("Store A")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Amount"));
    expect(screen.getByText("Store B")).toBeInTheDocument();
  });

  it("navigates to transactions with search on row click", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-1",
          transactionDate: "2025-02-15",
          payeeName: "Store A",
          description: "desc",
          accountName: "Chequing",
          amount: -50,
        },
      ],
      summary: {
        totalCount: 1,
        expenseCount: 1,
        expenseTotal: 50,
        incomeCount: 0,
        incomeTotal: 0,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText("Store A")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Store A"));
    expect(mockPush).toHaveBeenCalledWith("/transactions?search=Store%20A");
  });

  it("renders transaction without payeeName", async () => {
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions: [
        {
          id: "tx-1",
          transactionDate: "2025-02-15",
          payeeName: null,
          description: null,
          accountName: null,
          amount: 25,
        },
      ],
      summary: {
        totalCount: 1,
        expenseCount: 0,
        expenseTotal: 0,
        incomeCount: 1,
        incomeTotal: 25,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      const unknowns = screen.getAllByText("Unknown");
      expect(unknowns.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows truncation message when more than 100 transactions", async () => {
    const transactions = Array.from({ length: 105 }, (_, i) => ({
      id: `tx-${i}`,
      transactionDate: "2025-02-15",
      payeeName: `Payee ${i}`,
      description: "",
      accountName: "Chequing",
      amount: -10,
    }));
    mockGetUncategorizedTransactions.mockResolvedValue({
      transactions,
      summary: {
        totalCount: 105,
        expenseCount: 105,
        expenseTotal: 1050,
        incomeCount: 0,
        incomeTotal: 0,
      },
    });
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(
        screen.getByText(/Showing first 100 of 105 transactions/),
      ).toBeInTheDocument();
    });
  });

  it("handles API error gracefully", async () => {
    mockGetUncategorizedTransactions.mockRejectedValue(
      new Error("Network error"),
    );
    render(<UncategorizedTransactionsReport />);
    await waitFor(() => {
      expect(screen.getByText("Total Uncategorized")).toBeInTheDocument();
    });
  });
});
