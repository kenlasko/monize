import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@/test/render";
import { MonthlySpendingTrendReport } from "./MonthlySpendingTrendReport";

vi.mock("@/lib/pdf-export", () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

const mockExportToCsv = vi.fn();
vi.mock("@/lib/csv-export", () => ({
  exportToCsv: (...args: unknown[]) => mockExportToCsv(...args),
}));

/** The window's totals as the server sends them beside the months. */
function totalsOf(income: number, expenses: number, net = income - expenses) {
  return { income, expenses, net, knownIncome: income, knownExpenses: expenses, knownNet: net };
}

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
// The selection the mocked range hook reports; a test moves it and re-renders.
const mockRange = { end: "2025-01-01" };
const STABLE_RANGE = {
  start: "2024-01-01",
  get end() { return mockRange.end; },
};
vi.mock("@/hooks/useDateRange", () => ({
  useDateRange: () => ({
    dateRange: "1y",
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

vi.mock("@/components/ui/ChartViewToggle", () => ({
  ChartViewToggle: ({ onChange }: any) => (
    <div data-testid="chart-view-toggle">
      <button data-testid="toggle-line" onClick={() => onChange("line")}>Line</button>
      <button data-testid="toggle-table" onClick={() => onChange("table")}>Table</button>
    </div>
  ),
}));

vi.mock("@/components/ui/ExportDropdown", () => ({
  ExportDropdown: ({ onExportPdf, onExportCsv, disabled }: any) => (
    <div data-testid="export-dropdown">
      <button data-testid="export-pdf" onClick={onExportPdf} data-disabled={String(disabled === true)}>PDF</button>
      {onExportCsv && (
        <button data-testid="export-csv" onClick={onExportCsv}>CSV</button>
      )}
    </div>
  ),
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  LineChart: ({ children, onClick }: any) => (
    <div
      data-testid="line-chart"
      onClick={() => onClick?.({ activeLabel: "2024-01" })}
    >
      {children}
    </div>
  ),
  Line: ({ dataKey }: any) => <div data-testid={`line-dot-${dataKey}`} />,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
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

describe("MonthlySpendingTrendReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    mockRange.end = "2025-01-01";
  });

  it("shows loading state initially", () => {
    mockGetIncomeVsExpenses.mockReturnValue(new Promise(() => {}));
    render(<MonthlySpendingTrendReport />);
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("renders empty state when no data returned", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [],
      totals: totalsOf(0, 0),
    });
    render(<MonthlySpendingTrendReport />);
    await waitFor(() => {
      expect(screen.getByText("No data for this period.")).toBeInTheDocument();
    });
  });

  it("renders chart and summary with sample data", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [
        { period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 },
        { period: "2024-02", periodStart: "2024-02-01", periodEnd: "2024-02-29", income: 5200, expenses: 3500, net: 1700 },
      ],
      totals: totalsOf(10200, 6500),
    });
    render(<MonthlySpendingTrendReport />);
    await waitFor(() => {
      expect(screen.getByText("Total Income")).toBeInTheDocument();
    });
    expect(screen.getByText("Total Expenses")).toBeInTheDocument();
    expect(screen.getByText("Avg Monthly Income")).toBeInTheDocument();
    expect(screen.getByText("Avg Monthly Expenses")).toBeInTheDocument();
  });

  it("tells the reader when rows without a rate were left out of the totals", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: totalsOf(5000, 3000),
      currency: "USD",
      missingCurrencies: ["JPY"],
      excludedCount: 2,
    });
    render(<MonthlySpendingTrendReport />);
    expect(await screen.findByText(/JPY/)).toBeInTheDocument();
  });

  it("renders date range selector", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({ data: [], totals: totalsOf(0, 0) });
    render(<MonthlySpendingTrendReport />);
    await waitFor(() => {
      expect(screen.getByTestId("date-range-selector")).toBeInTheDocument();
    });
  });

  it("renders line chart when data present", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: totalsOf(5000, 3000),
    });
    render(<MonthlySpendingTrendReport />);
    await waitFor(() => {
      expect(screen.getByTestId("line-chart")).toBeInTheDocument();
    });
  });

  it("surfaces a retryable error state when the API fails", async () => {
    mockGetIncomeVsExpenses.mockRejectedValue(new Error("Network error"));
    render(<MonthlySpendingTrendReport />);
    await waitFor(() => {
      expect(screen.getByText(/failed to load report data/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("navigates to transactions page with date range on chart click", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: totalsOf(5000, 3000),
    });
    render(<MonthlySpendingTrendReport />);
    await waitFor(() => {
      expect(screen.getByTestId("line-chart")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("line-chart"));
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?startDate=2024-01-01&endDate=2024-01-31",
    );
  });

  it("renders sortable table view, sorts each column, navigates and exports CSV", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [
        { period: "2024-02", periodStart: "2024-02-01", periodEnd: "2024-02-29", income: 5200, expenses: 3500, net: 1700 },
        { period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 },
        { period: "2024-03", periodStart: "2024-03-01", periodEnd: "2024-03-31", income: 1000, expenses: 2000, net: -1000 },
      ],
      totals: totalsOf(11200, 8500),
    });
    const { container } = render(<MonthlySpendingTrendReport />);
    await waitFor(() => expect(screen.getByTestId("toggle-table")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("toggle-table")); });
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
    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBeGreaterThan(0);
    await act(async () => { fireEvent.click(rows[0]); });
    await act(async () => { fireEvent.click(screen.getByTestId("export-csv")); });
  });
});

describe("MonthlySpendingTrendReport: totals and the CSV read the server's figures (issue #2412)", () => {
  // Two months of 10.60 income and 0.60 expenses: each rounds up to a whole
  // unit, so the months' whole units add to 22 and 2 where the server's
  // totals are 21.20 and 1.20, and its net 20.00.
  const months = [
    { period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 10.6, expenses: 0.6, net: 10 },
    { period: "2024-02", periodStart: "2024-02-01", periodEnd: "2024-02-29", income: 10.6, expenses: 0.6, net: 10 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockRange.end = "2025-01-01";
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: months,
      totals: totalsOf(21.2, 1.2, 20),
      currency: "USD",
      missingCurrencies: [],
      excludedCount: 0,
    });
  });

  it("prints the server's totals in the cards, not the sum of whole-unit months", async () => {
    render(<MonthlySpendingTrendReport />);
    const income = await screen.findByText("Total Income");
    expect(income.nextElementSibling).toHaveTextContent("$21");
    expect(screen.getByText("Total Expenses").nextElementSibling).toHaveTextContent("$1");
  });

  it("prints the server's totals and net in the table footer", async () => {
    const { container } = render(<MonthlySpendingTrendReport />);
    await waitFor(() => expect(screen.getByTestId("toggle-table")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("toggle-table")); });
    const footer = container.querySelectorAll("tfoot td");
    expect([...footer].map((td) => td.textContent)).toEqual(["Total", "$21", "$1", "$20"]);
  });

  it("marks the totals as subtotals, on the screen and in the PDF, when the server left a row out", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: months,
      totals: { income: null, expenses: null, net: null, knownIncome: 21.2, knownExpenses: 1.2, knownNet: 20 },
      currency: "USD",
      missingCurrencies: ["JPY"],
      excludedCount: 1,
    });
    const { exportToPdf } = await import("@/lib/pdf-export");
    render(<MonthlySpendingTrendReport />);
    const income = await screen.findByText("Total Income");
    expect(income.nextElementSibling?.querySelector('[data-testid="partial-total"]')).not.toBeNull();
    await act(async () => { fireEvent.click(screen.getByTestId("export-pdf")); });
    const cards = (exportToPdf as ReturnType<typeof vi.fn>).mock.calls[0][0].summaryCards as Array<{ note?: string }>;
    expect(cards.every((card) => card.note?.includes("JPY"))).toBe(true);
  });

  it("writes each month's server figure to the CSV, not its whole units", async () => {
    render(<MonthlySpendingTrendReport />);
    await waitFor(() => expect(screen.getByTestId("export-csv")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("export-csv")); });
    const rows = mockExportToCsv.mock.calls[0][2] as unknown[][];
    expect(rows.map((r) => r.slice(1))).toEqual([
      [10.6, 0.6, 10],
      [10.6, 0.6, 10],
    ]);
  });
});

describe("MonthlySpendingTrendReport: a reload is not the previous answer", () => {
  const answer = {
    data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
    totals: totalsOf(5000, 3000),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRange.end = "2025-01-01";
  });

  async function loadThenChangeRange(next: () => unknown) {
    mockGetIncomeVsExpenses.mockResolvedValue(answer);
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<MonthlySpendingTrendReport />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("export-pdf")).toHaveAttribute("data-disabled", "false"),
    );

    mockGetIncomeVsExpenses.mockImplementation(next);
    mockRange.end = "2025-02-01";
    await act(async () => {
      view.rerender(<MonthlySpendingTrendReport />);
    });
    await waitFor(() =>
      expect(mockGetIncomeVsExpenses).toHaveBeenLastCalledWith(
        expect.objectContaining({ endDate: "2025-02-01" }),
      ),
    );
  }

  it("disables the export while the next request has failed", async () => {
    await loadThenChangeRange(() => Promise.reject(new Error("500")));
    expect(screen.getByTestId("export-pdf")).toHaveAttribute("data-disabled", "true");
  });

  it("disables the export while the next request is pending", async () => {
    await loadThenChangeRange(() => new Promise(() => {}));
    expect(screen.getByTestId("export-pdf")).toHaveAttribute("data-disabled", "true");
  });
});
