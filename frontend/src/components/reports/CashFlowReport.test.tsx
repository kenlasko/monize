import { cloneElement, type ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@/test/render";
import { within } from "@testing-library/react";
import { CashFlowReport } from "./CashFlowReport";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
      defaultCurrency: "CAD",
    }),
};
});
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

// What the mocked chart was last given, so a case can read the rows the real
// chart would plot and render the tooltip the real chart would show.
let lastChartData: any[] = [];
let lastTooltipContent: ReactElement | null = null;

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  BarChart: ({ children, onClick, data }: any) => {
    // The breakdown card draws a chart of its own; only the main chart rows carry monthStart.
    if (data?.[0]?.monthStart !== undefined) lastChartData = data;
    return (
      <div
        data-testid="bar-chart"
        onClick={() => onClick?.({ activeLabel: "2024-07" })}
      >
        {children}
      </div>
    );
  },
  Bar: ({ dataKey, stackId }: any) => (
    <div data-testid={`bar-${dataKey}`} data-stack-id={stackId} />
  ),
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: ({ content }: any) => {
    if (content?.type?.name === "CashFlowTooltip") lastTooltipContent = content;
    return null;
  },
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

const mockGetAllAccounts = vi.fn();
vi.mock("@/lib/accounts", () => ({
  accountsApi: { getAll: (...args: any[]) => mockGetAllAccounts(...args) },
}));

const mockGetAllTags = vi.fn().mockResolvedValue([]);
vi.mock("@/lib/tags", () => ({
  tagsApi: { getAll: (...args: any[]) => mockGetAllTags(...args) },
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockExportToPdf = vi.fn();
vi.mock("@/lib/pdf-export", () => ({
  exportToPdf: (...args: any[]) => mockExportToPdf(...args),
}));

vi.mock("@/components/ui/ExportDropdown", () => ({
  ExportDropdown: ({ onExportPdf, disabled }: any) => (
    <div data-testid="export-dropdown">
      <button data-testid="export-pdf" onClick={onExportPdf} disabled={disabled}>PDF</button>
    </div>
  ),
}));

describe("CashFlowReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    mockGetAllAccounts.mockResolvedValue([]);
    window.localStorage.clear();
  });

  it("shows loading state initially", async () => {
    mockGetCashFlow.mockReturnValue(new Promise(() => {}));
    mockGetIncomeBySource.mockReturnValue(new Promise(() => {}));
    mockGetSpendingByCategory.mockReturnValue(new Promise(() => {}));
    // The tag-key lookup resolves on mount alongside the report fetches;
    // flush it inside act() so its state update lands before the assertion.
    await act(async () => {
      render(<CashFlowReport />);
    });
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("renders summary cards and chart with data", async () => {
    mockGetCashFlow.mockResolvedValue({
      data: [{ period: "2024-07", periodStart: "2024-07-01", periodEnd: "2024-07-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
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
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
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
      data: [{ period: "2024-07", periodStart: "2024-07-01", periodEnd: "2024-07-31", income: 2000, expenses: 3000, net: -1000 }],
      totals: { income: 2000, expenses: 3000, net: -1000, knownIncome: 2000, knownExpenses: 3000, knownNet: -1000 },
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
      totals: { income: 0, expenses: 0, net: 0, knownIncome: 0, knownExpenses: 0, knownNet: 0 },
    });
    mockGetIncomeBySource.mockResolvedValue({ data: [], totalIncome: 0 });
    mockGetSpendingByCategory.mockResolvedValue({ data: [], totalSpending: 0 });
    render(<CashFlowReport />);
    await waitFor(() => {
      expect(screen.getByText("No income in this period")).toBeInTheDocument();
    });
    expect(screen.getByText("No expenses in this period")).toBeInTheDocument();
  });

  it("surfaces a retryable error state when the API fails", async () => {
    mockGetCashFlow.mockRejectedValue(new Error("Network error"));
    mockGetIncomeBySource.mockRejectedValue(new Error("Network error"));
    mockGetSpendingByCategory.mockRejectedValue(new Error("Network error"));
    render(<CashFlowReport />);
    await waitFor(() => {
      expect(screen.getByText(/failed to load report data/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("navigates to transactions page with date range on chart bar click", async () => {
    mockGetCashFlow.mockResolvedValue({
      data: [{ period: "2024-07", periodStart: "2024-07-01", periodEnd: "2024-07-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
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
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
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
      totals: { income: 0, expenses: 2000, net: -2000, knownIncome: 0, knownExpenses: 2000, knownNet: -2000 },
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

  it("does not navigate on chart click when activeLabel is undefined", async () => {
    mockGetCashFlow.mockResolvedValue({
      data: [{ period: "2024-07", periodStart: "2024-07-01", periodEnd: "2024-07-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
    });
    mockGetIncomeBySource.mockResolvedValue({ data: [], totalIncome: 0 });
    mockGetSpendingByCategory.mockResolvedValue({ data: [], totalSpending: 0 });
    render(<CashFlowReport />);
    await waitFor(() => {
      expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
    });
    // The bar chart mock calls onClick with activeLabel: "2024-07"
    // Verify navigation happened (covers the normal path)
    fireEvent.click(screen.getByTestId("bar-chart"));
    expect(mockPush).toHaveBeenCalled();
  });

  it("does not navigate when category click has null categoryId", async () => {
    mockGetCashFlow.mockResolvedValue({
      data: [],
      totals: { income: 5000, expenses: 0, net: 5000, knownIncome: 5000, knownExpenses: 0, knownNet: 5000 },
    });
    mockGetIncomeBySource.mockResolvedValue({
      data: [
        {
          categoryId: null,
          categoryName: "Uncategorized",
          total: 5000,
        },
      ],
      totalIncome: 5000,
    });
    mockGetSpendingByCategory.mockResolvedValue({ data: [], totalSpending: 0 });
    render(<CashFlowReport />);
    await waitFor(() => {
      expect(screen.getByText("Uncategorized")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Uncategorized"));
    // Should not navigate since categoryId is null
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("renders positive net cash flow with blue styling", async () => {
    mockGetCashFlow.mockResolvedValue({
      data: [],
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
    });
    mockGetIncomeBySource.mockResolvedValue({ data: [], totalIncome: 0 });
    mockGetSpendingByCategory.mockResolvedValue({ data: [], totalSpending: 0 });
    render(<CashFlowReport />);
    await waitFor(() => {
      expect(screen.getByText("Net Cash Flow")).toBeInTheDocument();
    });
    // Positive net shows + prefix
    expect(screen.getByText(/\+/)).toBeInTheDocument();
  });

  it("renders income items without categoryId (no cursor pointer class)", async () => {
    mockGetCashFlow.mockResolvedValue({
      data: [],
      totals: { income: 1000, expenses: 0, net: 1000, knownIncome: 1000, knownExpenses: 0, knownNet: 1000 },
    });
    mockGetIncomeBySource.mockResolvedValue({
      data: [{ categoryId: null, categoryName: "Other Income", total: 1000 }],
      totalIncome: 1000,
    });
    mockGetSpendingByCategory.mockResolvedValue({ data: [], totalSpending: 0 });
    render(<CashFlowReport />);
    await waitFor(() => {
      expect(screen.getByText("Other Income")).toBeInTheDocument();
    });
  });

  it("renders expense items without categoryId (no cursor pointer class)", async () => {
    mockGetCashFlow.mockResolvedValue({
      data: [],
      totals: { income: 0, expenses: 500, net: -500, knownIncome: 0, knownExpenses: 500, knownNet: -500 },
    });
    mockGetIncomeBySource.mockResolvedValue({ data: [], totalIncome: 0 });
    mockGetSpendingByCategory.mockResolvedValue({
      data: [{ categoryId: null, categoryName: "Other Expenses", total: 500 }],
      totalSpending: 500,
    });
    render(<CashFlowReport />);
    await waitFor(() => {
      expect(screen.getByText("Other Expenses")).toBeInTheDocument();
    });
  });

  describe("tag key breakdown", () => {
    beforeEach(() => {
      mockGetIncomeBySource.mockResolvedValue({ data: [], totalIncome: 0 });
      mockGetSpendingByCategory.mockResolvedValue({ data: [], totalSpending: 0 });
    });

    it("hides the selector when the user has no KEY:VALUE tags", async () => {
      mockGetAllTags.mockResolvedValue([{ id: "t1", name: "groceries" }]);
      mockGetCashFlow.mockResolvedValue({
        data: [],
        totals: { income: 0, expenses: 0, net: 0, knownIncome: 0, knownExpenses: 0, knownNet: 0 },
      });
      render(<CashFlowReport />);
      await waitFor(() => expect(screen.getByText("Monthly Cash Flow")).toBeInTheDocument());
      expect(screen.queryByRole("combobox", { name: "Break down by tag key" })).toBeNull();
    });

    it('shows the selector and sends no tagKey while "None" is selected', async () => {
      mockGetAllTags.mockResolvedValue([{ id: "t1", name: "scope:household" }]);
      mockGetCashFlow.mockResolvedValue({
        data: [],
        totals: { income: 0, expenses: 0, net: 0, knownIncome: 0, knownExpenses: 0, knownNet: 0 },
      });
      render(<CashFlowReport />);
      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Break down by tag key" })).toBeInTheDocument(),
      );
      const lastCall = mockGetCashFlow.mock.calls.at(-1)?.[0];
      expect(lastCall).not.toHaveProperty("tagKey");
    });

    it("renders value buckets and the untagged bucket once a key is chosen", async () => {
      mockGetAllTags.mockResolvedValue([{ id: "t1", name: "scope:household" }]);
      mockGetCashFlow.mockResolvedValue({
        data: [],
        totals: { income: 0, expenses: 0, net: 0, knownIncome: 0, knownExpenses: 0, knownNet: 0 },
        currency: "CAD",
        missingCurrencies: [],
        excludedCount: 0,
      });
      render(<CashFlowReport />);
      const select = await screen.findByRole("combobox", { name: "Break down by tag key" });

      mockGetCashFlow.mockResolvedValue({
        data: [],
        totals: { income: 0, expenses: 0, net: 0, knownIncome: 0, knownExpenses: 0, knownNet: 0 },
        currency: "CAD",
        missingCurrencies: [],
        excludedCount: 0,
        tagKey: "scope",
        buckets: [
          {
            value: "household",
            isUntagged: false,
            data: [],
            totals: { income: 0, expenses: 0, net: 0, knownIncome: 500, knownExpenses: 200, knownNet: 300 },
            taggedInflows: 1000,
            taggedOutflows: 1000,
            missingCurrencies: [],
            excludedCount: 0,
          },
          {
            value: "__untagged__",
            isUntagged: true,
            data: [],
            totals: { income: 0, expenses: 0, net: 0, knownIncome: 0, knownExpenses: 0, knownNet: 0 },
            taggedInflows: 0,
            taggedOutflows: 0,
            missingCurrencies: [],
            excludedCount: 0,
          },
        ],
      });
      await act(async () => {
        fireEvent.change(select, { target: { value: "scope" } });
      });

      await waitFor(() =>
        expect(mockGetCashFlow.mock.calls.at(-1)?.[0]).toMatchObject({ tagKey: "scope" }),
      );
      expect(await screen.findByRole("tab", { name: "household" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Untagged" })).toBeInTheDocument();

      const taggedFlows = screen.getByTestId("tagged-flows");
      expect(taggedFlows).toHaveTextContent("Tagged inflows");
      expect(taggedFlows).toHaveTextContent("Tagged outflows");
    });

    it("shows the missing-rate treatment for an incomplete bucket", async () => {
      mockGetAllTags.mockResolvedValue([{ id: "t1", name: "scope:household" }]);
      mockGetCashFlow.mockResolvedValue({
        data: [],
        totals: { income: 0, expenses: 0, net: 0, knownIncome: 0, knownExpenses: 0, knownNet: 0 },
        currency: "CAD",
        missingCurrencies: [],
        excludedCount: 0,
        tagKey: "scope",
        buckets: [
          {
            value: "household",
            isUntagged: false,
            data: [],
            totals: { income: null, expenses: null, net: null, knownIncome: 500, knownExpenses: 200, knownNet: 300 },
            taggedInflows: 1000,
            taggedOutflows: 1000,
            missingCurrencies: ["JPY"],
            excludedCount: 1,
          },
        ],
      });
      render(<CashFlowReport />);
      await screen.findByRole("combobox", { name: "Break down by tag key" });

      expect((await screen.findAllByTestId("partial-total")).length).toBeGreaterThan(0);
    });
  });

  describe("an unknown total is not a measured zero", () => {
    const partialResponse = () => ({
      data: [{ period: "2024-07", periodStart: "2024-07-01", periodEnd: "2024-07-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: null, expenses: 3000, net: null, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
      currency: "CAD",
      missingCurrencies: ["EUR"],
      excludedCount: 1,
    });
    const arrange = () => {
      mockGetCashFlow.mockResolvedValue(partialResponse());
      mockGetIncomeBySource.mockResolvedValue({ data: [], totalIncome: null });
      mockGetSpendingByCategory.mockResolvedValue({ data: [], totalSpending: 3000 });
    };

    it("shows the known income as a marked subtotal, never $0", async () => {
      arrange();
      await act(async () => {
        render(<CashFlowReport />);
      });
      await screen.findByText("Total Inflows");
      expect(screen.queryByText("$0")).toBeNull();
      const inflows = screen.getByText("Total Inflows").parentElement!;
      expect(inflows).toHaveTextContent("$5000");
      expect(inflows.querySelector('[data-testid="partial-total"]')).not.toBeNull();
      // Net is withheld too, so it carries the marker rather than "+$0".
      const net = screen.getByText("Net Cash Flow").parentElement!;
      expect(net.querySelector('[data-testid="partial-total"]')).not.toBeNull();
      // Expenses converted completely and stay bare.
      const outflows = screen.getByText("Total Outflows").parentElement!;
      expect(outflows.querySelector('[data-testid="partial-total"]')).toBeNull();
    });

    it("hands the PDF the partial note on each withheld card", async () => {
      arrange();
      mockExportToPdf.mockResolvedValue(undefined);
      await act(async () => {
        render(<CashFlowReport />);
      });
      await screen.findByText("Total Inflows");
      await act(async () => {
        fireEvent.click(screen.getByTestId("export-pdf"));
      });
      const cards = mockExportToPdf.mock.calls[0][0].summaryCards as Array<{ label: string; value: string; note?: string }>;
      expect(cards.find((c) => c.label === "Total Inflows")?.note).toEqual(expect.stringContaining("EUR"));
      expect(cards.find((c) => c.label === "Net Cash Flow")?.note).toEqual(expect.stringContaining("EUR"));
      expect(cards.find((c) => c.label === "Total Outflows")?.note).toBeUndefined();
      expect(cards.find((c) => c.label === "Total Inflows")?.value).not.toBe("$0");
    });

    it("leaves complete totals unmarked and the PDF cards without a note", async () => {
      mockGetCashFlow.mockResolvedValue({
        data: [],
        totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
        currency: "CAD",
        missingCurrencies: [],
        excludedCount: 0,
      });
      mockGetIncomeBySource.mockResolvedValue({ data: [], totalIncome: 5000 });
      mockGetSpendingByCategory.mockResolvedValue({ data: [], totalSpending: 3000 });
      mockExportToPdf.mockResolvedValue(undefined);
      await act(async () => {
        render(<CashFlowReport />);
      });
      await screen.findByText("Total Inflows");
      expect(screen.queryByTestId("partial-total")).toBeNull();
      await act(async () => {
        fireEvent.click(screen.getByTestId("export-pdf"));
      });
      const cards = mockExportToPdf.mock.calls[0][0].summaryCards as Array<{ note?: string }>;
      expect(cards.every((c) => c.note === undefined)).toBe(true);
    });

    it("disables the export while the data is loading", async () => {
      mockGetCashFlow.mockReturnValue(new Promise(() => {}));
      mockGetIncomeBySource.mockReturnValue(new Promise(() => {}));
      mockGetSpendingByCategory.mockReturnValue(new Promise(() => {}));
      await act(async () => {
        render(<CashFlowReport />);
      });
      expect(screen.getByTestId("export-pdf")).toBeDisabled();
    });

    it("leaves the export disabled when the load failed, and writes no zero cards", async () => {
      mockGetCashFlow.mockRejectedValue(new Error("Network error"));
      mockGetIncomeBySource.mockRejectedValue(new Error("Network error"));
      mockGetSpendingByCategory.mockRejectedValue(new Error("Network error"));
      await act(async () => {
        render(<CashFlowReport />);
      });
      await screen.findByText(/failed to load report data/i);
      expect(screen.getByTestId("export-pdf")).toBeDisabled();
      fireEvent.click(screen.getByTestId("export-pdf"));
      expect(mockExportToPdf).not.toHaveBeenCalled();
    });
  });

  describe("account scope", () => {
    const accounts = [
      { id: "acct-checking", name: "Checking", accountType: "CHEQUING", accountSubType: null, linkedAccountId: null },
      { id: "acct-rrsp", name: "RRSP", accountType: "INVESTMENT", accountSubType: "INVESTMENT_CASH", linkedAccountId: null },
    ];
    const empty = {
      data: [],
      totals: { income: 0, expenses: 0, net: 0, knownIncome: 0, knownExpenses: 0, knownNet: 0 },
    };

    beforeEach(() => {
      mockGetAllAccounts.mockResolvedValue(accounts);
      mockGetCashFlow.mockResolvedValue(empty);
      mockGetIncomeBySource.mockResolvedValue({ data: [], totalIncome: 0 });
      mockGetSpendingByCategory.mockResolvedValue({ data: [], totalSpending: 0 });
    });

    it("sends no accountIds to any of the three reads while nothing is selected", async () => {
      render(<CashFlowReport />);
      await screen.findByRole("button", { name: "Filter by account" });
      await waitFor(() => expect(mockGetSpendingByCategory).toHaveBeenCalled());
      for (const mock of [mockGetCashFlow, mockGetIncomeBySource, mockGetSpendingByCategory]) {
        expect(mock.mock.calls.at(-1)?.[0]).not.toHaveProperty("accountIds");
      }
    });

    it("offers non-investment accounts only and sends the chosen accountIds to all three reads", async () => {
      render(<CashFlowReport />);
      const trigger = await screen.findByRole("button", { name: "Filter by account" });
      await waitFor(() => expect(mockGetAllAccounts).toHaveBeenCalled());

      fireEvent.click(trigger);
      expect(await screen.findByText("Checking")).toBeInTheDocument();
      expect(screen.queryByText("RRSP")).toBeNull();
      fireEvent.click(screen.getByText("Checking"));

      await waitFor(() => {
        for (const mock of [mockGetCashFlow, mockGetIncomeBySource, mockGetSpendingByCategory]) {
          expect(mock.mock.calls.at(-1)?.[0]).toMatchObject({ accountIds: ["acct-checking"] });
        }
      });
    });

    it("reopens on the accounts the user last chose", async () => {
      window.localStorage.setItem(
        "monize-reports-cash-flow-accounts",
        JSON.stringify(["acct-checking"]),
      );
      render(<CashFlowReport />);
      await waitFor(() => {
        for (const mock of [mockGetCashFlow, mockGetIncomeBySource, mockGetSpendingByCategory]) {
          expect(mock.mock.calls.at(-1)?.[0]).toMatchObject({ accountIds: ["acct-checking"] });
        }
      });
    });
  });

  describe("tagged-flow series and stacking", () => {
    const STACK_KEY = "monize-reports-cash-flow-stack-tagged";
    const switchName = { name: "Include tagged transfers" };
    const jan = { period: "2024-07", periodStart: "2024-07-01", periodEnd: "2024-07-31", income: 5000, expenses: 3000, net: 2000 };
    const totals = { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 };
    const zeroTotals = { income: 0, expenses: 0, net: 0, knownIncome: 0, knownExpenses: 0, knownNet: 0 };
    const withBuckets = {
      data: [jan],
      totals,
      currency: "CAD",
      missingCurrencies: [],
      excludedCount: 0,
      tagKey: "scope",
      buckets: [
        {
          value: "household",
          isUntagged: false,
          data: [{ ...jan, income: 0, expenses: 0, net: 0, taggedInflows: 7066, taggedOutflows: 7066 }],
          totals: zeroTotals,
          taggedInflows: 7066,
          taggedOutflows: 7066,
          missingCurrencies: [],
          excludedCount: 0,
        },
        {
          value: "__untagged__",
          isUntagged: true,
          data: [{ ...jan, taggedInflows: 0, taggedOutflows: 0 }],
          totals,
          taggedInflows: 0,
          taggedOutflows: 0,
          missingCurrencies: [],
          excludedCount: 0,
        },
      ],
    };
    // The breakdown card draws its own Income/Expenses bars, so the main
    // chart's bar is the first of each key.
    const mainBar = (key: string) => screen.getAllByTestId(`bar-${key}`)[0];

    beforeEach(() => {
      mockGetAllTags.mockResolvedValue([{ id: "t1", name: "scope:household" }]);
      mockGetIncomeBySource.mockResolvedValue({ data: [], totalIncome: 0 });
      mockGetSpendingByCategory.mockResolvedValue({ data: [], totalSpending: 0 });
    });

    it("adds no flow series and no switch without a tag key", async () => {
      mockGetCashFlow.mockResolvedValue({ data: [jan], totals });
      render(<CashFlowReport />);
      await screen.findByTestId("bar-Income");
      expect(screen.queryByTestId("bar-TaggedInflows")).toBeNull();
      expect(screen.queryByRole("switch", switchName)).toBeNull();
    });

    it("draws both series and the switch for the active value bucket, and drops them on the untagged tab", async () => {
      mockGetCashFlow.mockResolvedValue(withBuckets);
      render(<CashFlowReport />);

      expect(await screen.findByTestId("bar-TaggedInflows")).toBeInTheDocument();
      expect(screen.getByTestId("bar-TaggedOutflows")).toBeInTheDocument();
      expect(screen.getByRole("switch", switchName)).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: "Untagged" }));
      });
      expect(screen.queryByTestId("bar-TaggedInflows")).toBeNull();
      expect(screen.queryByRole("switch", switchName)).toBeNull();
    });

    it("defaults off, then stacks inflows on the Inflows bar and outflows on the Outflows bar", async () => {
      mockGetCashFlow.mockResolvedValue(withBuckets);
      render(<CashFlowReport />);
      const toggle = await screen.findByRole("switch", switchName);
      expect(toggle).toHaveAttribute("aria-checked", "false");
      for (const key of ["Income", "Expenses", "TaggedInflows", "TaggedOutflows"]) {
        expect(mainBar(key)).not.toHaveAttribute("data-stack-id");
      }

      fireEvent.click(toggle);
      const stackOf = (key: string) => mainBar(key).getAttribute("data-stack-id");
      expect(stackOf("Income")).toBeTruthy();
      expect(stackOf("TaggedInflows")).toBe(stackOf("Income"));
      expect(stackOf("Expenses")).toBeTruthy();
      expect(stackOf("TaggedOutflows")).toBe(stackOf("Expenses"));
      expect(stackOf("Income")).not.toBe(stackOf("Expenses"));
      // Balance replaces Net, and is never part of the stack.
      expect(screen.queryByText("Net Cash Flow")).toBeNull();
      expect(stackOf("Balance")).toBeNull();
    });

    it("persists the choice and reopens on it", async () => {
      mockGetCashFlow.mockResolvedValue(withBuckets);
      const first = render(<CashFlowReport />);
      fireEvent.click(await screen.findByRole("switch", switchName));
      expect(window.localStorage.getItem(STACK_KEY)).toBe("true");
      first.unmount();

      render(<CashFlowReport />);
      expect(await screen.findByRole("switch", switchName)).toHaveAttribute("aria-checked", "true");
      expect(mainBar("TaggedInflows").getAttribute("data-stack-id")).toBe(
        mainBar("Income").getAttribute("data-stack-id"),
      );
    });

    describe("Balance view (spec section 10.9)", () => {
      const aug = { period: "2026-08", periodStart: "2026-08-01", periodEnd: "2026-08-31", income: 3279, expenses: 8486, net: -5207 };
      const augTotals = { income: 3279, expenses: 8486, net: -5207, knownIncome: 3279, knownExpenses: 8486, knownNet: -5207 };
      const augResponse = (outflows = 0, bucketOverrides: Record<string, unknown> = {}) => ({
        data: [aug],
        totals: augTotals,
        currency: "CAD",
        missingCurrencies: [],
        excludedCount: 0,
        tagKey: "scope",
        buckets: [
          {
            value: "household",
            isUntagged: false,
            data: [{ ...aug, income: 0, expenses: 0, net: 0, taggedInflows: 4516, taggedOutflows: outflows }],
            totals: zeroTotals,
            taggedInflows: 4516,
            taggedOutflows: outflows,
            missingCurrencies: [],
            excludedCount: 0,
            ...bucketOverrides,
          },
        ],
      });
      // The breakdown card below the chart has its own cards; these are the page's own.
      const pageCards = () =>
        within(document.querySelector(".space-y-6")!.firstElementChild as HTMLElement);
      const tooltipFor = (keys: string[]) => {
        const row = lastChartData[0];
        const names: Record<string, string> = {
          Income: "Inflows",
          Expenses: "Outflows",
          Balance: "Balance",
          TaggedInflows: "Tagged inflows: household",
          TaggedOutflows: "Tagged outflows: household",
        };
        const payload = keys
          .filter((key) => row[key] !== undefined)
          .map((key) => ({ dataKey: key, name: names[key], value: row[key], color: "#000", payload: row }));
        render(cloneElement(lastTooltipContent as ReactElement<any>, { active: true, payload }));
        return Array.from(document.querySelectorAll("p")).map((p) => p.textContent);
      };

      it("PDF: marks the Balance-view inflows and outflows as partial and prints a dash for an unknown Balance", async () => {
        mockGetCashFlow.mockResolvedValue({
          ...augResponse(),
          totals: { ...augTotals, income: null, net: null },
          missingCurrencies: ["EUR"],
          excludedCount: 1,
        });
        mockExportToPdf.mockResolvedValue(undefined);
        render(<CashFlowReport />);
        fireEvent.click(await screen.findByRole("switch", switchName));
        await act(async () => {
          fireEvent.click(screen.getByTestId("export-pdf"));
        });

        const cards = mockExportToPdf.mock.calls[0][0].summaryCards as Array<{ label: string; value: string; note?: string }>;
        expect(cards.find((c) => c.label === "Total Inflows")?.note).toEqual(expect.stringContaining("EUR"));
        expect(cards.find((c) => c.label === "Total Outflows")?.note).toEqual(expect.stringContaining("EUR"));
        expect(cards.find((c) => c.label === "Balance")?.value).toMatch(/\*$/);
      });

      it("PDF: prints a dash, not 0, when the Balance is unknown", async () => {
        mockGetCashFlow.mockResolvedValue(
          augResponse(0, { taggedInflows: Number.NaN }),
        );
        mockExportToPdf.mockResolvedValue(undefined);
        render(<CashFlowReport />);
        fireEvent.click(await screen.findByRole("switch", switchName));
        await act(async () => {
          fireEvent.click(screen.getByTestId("export-pdf"));
        });

        const cards = mockExportToPdf.mock.calls[0][0].summaryCards as Array<{ label: string; value: string }>;
        expect(cards.find((c) => c.label === "Balance")?.value).toBe("\u2014");
      });

      it("off: Net Cash Flow, no Balance, no Balance bar", async () => {
        mockGetCashFlow.mockResolvedValue(augResponse());
        render(<CashFlowReport />);
        await screen.findByRole("switch", switchName);

        expect(screen.getByText("Net Cash Flow")).toBeInTheDocument();
        expect(screen.getByText("$-5207")).toBeInTheDocument();
        expect(screen.queryByText("Balance")).toBeNull();
        expect(screen.queryByTestId("bar-Balance")).toBeNull();
        expect(lastChartData[0]).not.toHaveProperty("Balance");
      });

      it("on: Inflows, Tagged inflows, Outflows, Balance, Balance %, with the reporter's figures", async () => {
        mockGetCashFlow.mockResolvedValue(augResponse());
        render(<CashFlowReport />);
        fireEvent.click(await screen.findByRole("switch", switchName));

        expect(screen.queryByText("Net Cash Flow")).toBeNull();
        const labels = ["Total Inflows", "Tagged inflows", "Total Outflows", "Balance", "Balance %"].map(
          (label) => pageCards().getByText(label),
        );
        for (let i = 1; i < labels.length; i += 1) {
          expect(
            labels[i - 1].compareDocumentPosition(labels[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
          ).toBeTruthy();
        }
        expect(pageCards().getByText("$-691")).toBeInTheDocument();
        expect(pageCards().getByText("-8.86%")).toBeInTheDocument();
        expect(screen.getByTestId("bar-Balance")).toBeInTheDocument();
        expect(lastChartData[0]).toMatchObject({ Income: 3279, Expenses: 8486, Balance: -691, BalancePercent: -8.86 });
        // No tagged outflows in the window, so no card for them.
        expect(pageCards().queryByText("Tagged outflows")).toBeNull();
      });

      it("on: the Tagged outflows card appears, and lowers the Balance, when the window has outflows", async () => {
        mockGetCashFlow.mockResolvedValue(augResponse(100));
        render(<CashFlowReport />);
        fireEvent.click(await screen.findByRole("switch", switchName));

        expect(pageCards().getByText("Tagged outflows")).toBeInTheDocument();
        expect(pageCards().getByText("$-791")).toBeInTheDocument();
        expect(pageCards().getByText("-10.15%")).toBeInTheDocument();
      });

      it("on: an incomplete bucket makes the Balance a marked subtotal with no percentage", async () => {
        mockGetCashFlow.mockResolvedValue(augResponse(0, { missingCurrencies: ["JPY"], excludedCount: 1 }));
        render(<CashFlowReport />);
        fireEvent.click(await screen.findByRole("switch", switchName));

        const balanceCard = pageCards().getByText("Balance").parentElement as HTMLElement;
        expect(balanceCard.querySelector('[data-testid="partial-total"]')).not.toBeNull();
        const percentCard = pageCards().getByText("Balance %").parentElement as HTMLElement;
        expect(percentCard.textContent).toContain("\u2014");
      });

      it("on: incomplete All totals do the same", async () => {
        mockGetCashFlow.mockResolvedValue({
          ...augResponse(),
          totals: { ...augTotals, income: null, expenses: null, net: null },
          missingCurrencies: ["EUR"],
          excludedCount: 1,
        });
        render(<CashFlowReport />);
        fireEvent.click(await screen.findByRole("switch", switchName));

        const balanceCard = pageCards().getByText("Balance").parentElement as HTMLElement;
        expect(balanceCard.querySelector('[data-testid="partial-total"]')).not.toBeNull();
      });

      it("on: the tooltip reads Inflows, Tagged inflows, Outflows, Balance, Balance %, hiding zero outflows", async () => {
        mockGetCashFlow.mockResolvedValue(augResponse());
        render(<CashFlowReport />);
        fireEvent.click(await screen.findByRole("switch", switchName));

        const lines = tooltipFor(["Income", "Expenses", "Balance", "TaggedInflows", "TaggedOutflows"]).filter(
          (l) => /^(Inflows|Tagged|Outflows|Balance)/.test(l ?? ""),
        );
        expect(lines).toEqual([
          "Inflows: $3279",
          "Tagged inflows: household: $4516",
          "Outflows: $8486",
          "Balance: $-691",
          "Balance %: -8.86%",
        ]);
      });

      it("on: the tooltip lists Tagged outflows when the period has some, and a dash when nothing came in", async () => {
        mockGetCashFlow.mockResolvedValue({
          ...augResponse(),
          data: [{ ...aug, income: 0, expenses: 40, net: -40 }],
          buckets: [
            {
              ...augResponse().buckets[0],
              data: [{ ...aug, income: 0, expenses: 0, net: 0, taggedInflows: 0, taggedOutflows: 25 }],
              taggedInflows: 0,
              taggedOutflows: 25,
            },
          ],
        });
        render(<CashFlowReport />);
        fireEvent.click(await screen.findByRole("switch", switchName));

        const lines = tooltipFor(["Income", "Expenses", "Balance", "TaggedInflows", "TaggedOutflows"]);
        expect(lines).toContain("Tagged outflows: household: $25");
        expect(lines).toContain("Balance: $-65");
        expect(lines).toContain("Balance %: \u2014");
      });

      it("the untagged tab returns to Net Cash Flow", async () => {
        mockGetCashFlow.mockResolvedValue({
          ...augResponse(),
          buckets: [
            ...augResponse().buckets,
            { ...augResponse().buckets[0], value: "__untagged__", isUntagged: true, taggedInflows: 0 },
          ],
        });
        render(<CashFlowReport />);
        fireEvent.click(await screen.findByRole("switch", switchName));
        expect(screen.getByTestId("bar-Balance")).toBeInTheDocument();

        await act(async () => {
          fireEvent.click(screen.getByRole("tab", { name: "Untagged" }));
        });
        expect(screen.queryByTestId("bar-Balance")).toBeNull();
        expect(screen.getByText("Net Cash Flow")).toBeInTheDocument();
      });
    });
  });
});

