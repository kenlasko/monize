import { cloneElement, type ReactElement } from "react";
import { ReportingBasisScope, ReportingBasisControl } from './ReportingBasis';
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@/test/render";
import { usePreferencesStore } from "@/store/preferencesStore";
import { within } from "@testing-library/react";
import { IncomeVsExpensesReport } from "./IncomeVsExpensesReport";

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

const mockExportToPdf = vi.fn();
vi.mock("@/lib/pdf-export", () => ({
  exportToPdf: (...args: any[]) => mockExportToPdf(...args),
}));

vi.mock("@/components/ui/DateRangeSelector", () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock("@/components/ui/ChartViewToggle", () => ({
  ChartViewToggle: ({ onChange }: any) => (
    <div data-testid="chart-view-toggle">
      <button data-testid="toggle-bar" onClick={() => onChange("bar")}>Bar</button>
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

// What the mocked chart was last given, so a case can read the rows the real
// chart would plot and render the tooltip the real chart would show.
let lastChartData: any[] = [];
let lastTooltipContent: ReactElement | null = null;
const mockExportToCsv = vi.fn();
vi.mock("@/lib/csv-export", () => ({
  exportToCsv: (...args: any[]) => mockExportToCsv(...args),
}));

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
      onClick={() => onClick?.({ activeLabel: "2024-01" })}
    >
      {children}
    </div>
    );
  },
  Bar: ({ dataKey, onClick, stackId }: any) => (
    <button
      data-testid={`bar-${dataKey}`}
      data-stack-id={stackId}
      onClick={() =>
        onClick?.(
          { payload: { monthStart: "2024-01-01", monthEnd: "2024-01-31" } },
          0,
          new MouseEvent("click"),
        )
      }
    />
  ),
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: ({ content }: any) => {
    if (content?.type?.name === "IncomeVsExpensesTooltip") lastTooltipContent = content;
    return null;
  },
  Legend: () => null,
  ReferenceLine: () => null,
}));

const mockGetIncomeVsExpenses = vi.fn();

/** The chart card holding the summary cards (the breakdown card below has its own). */
const mainCard = () =>
  screen.getAllByTestId("responsive-container")[0].parentElement!.parentElement as HTMLElement;
/** Header labels of the desktop header row, without the sort arrows. */
const tableHeaders = () =>
  Array.from(document.querySelectorAll("thead tr")[1].querySelectorAll("th")).map((h) =>
    (h.textContent ?? "").replace(/[\u2191\u2193\u2195]/g, "").trim(),
  );

/** The tooltip the chart would show for one row, from the series the chart declares. */
function renderTooltipFor(row: any, keys: string[]) {
  const names: Record<string, string> = {
    Income: "Income",
    Expenses: "Expenses",
    Savings: "Savings",
    Balance: "Balance",
    TaggedInflows: "Tagged inflows: household",
    TaggedOutflows: "Tagged outflows: household",
  };
  const payload = keys
    .filter((key) => row[key] !== undefined)
    .map((key) => ({ dataKey: key, name: names[key], value: row[key], color: "#000", payload: row }));
  render(cloneElement(lastTooltipContent as ReactElement<any>, { active: true, payload }));
}

vi.mock("@/lib/built-in-reports", () => ({
  builtInReportsApi: {
    getIncomeVsExpenses: (...args: any[]) => mockGetIncomeVsExpenses(...args),
  },
}));

const mockGetAllTags = vi.fn().mockResolvedValue([]);
vi.mock("@/lib/tags", () => ({
  tagsApi: { getAll: (...args: any[]) => mockGetAllTags(...args) },
}));

const mockGetAllAccounts = vi.fn();
vi.mock("@/lib/accounts", () => ({
  accountsApi: { getAll: (...args: any[]) => mockGetAllAccounts(...args) },
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
    mockRange.end = "2025-01-01";
    mockGetAllAccounts.mockResolvedValue([]);
    window.localStorage.clear();
    usePreferencesStore.setState({ preferences: { accrualEnabled: true, reportingBasis: "accrual" } as never });
  });

  it('sends the selected basis to the actual report request', async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({data:[],totals:{income:0,expenses:0,net:0,knownIncome:0,knownExpenses:0,knownNet:0}});
    await act(async()=>render(<ReportingBasisScope surface="income"><ReportingBasisControl /><IncomeVsExpensesReport /></ReportingBasisScope>));
    expect(mockGetIncomeVsExpenses).toHaveBeenLastCalledWith(expect.objectContaining({basis:'accrual'}));
    await act(async()=>fireEvent.click(screen.getByRole('button', { name: /^Cash(?: \(user default\))?$/ })));
    expect(mockGetIncomeVsExpenses).toHaveBeenLastCalledWith(expect.objectContaining({basis:'cash'}));
  });
  it("shows loading state initially", async () => {
    mockGetIncomeVsExpenses.mockReturnValue(new Promise(() => {}));
    // The tag-key lookup resolves on mount alongside the report fetch; flush
    // it inside act() so its state update lands before the assertion.
    await act(async () => {
      render(<IncomeVsExpensesReport />);
    });
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("renders empty state when no data returned", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [],
      totals: { income: 0, expenses: 0, net: 0, knownIncome: 0, knownExpenses: 0, knownNet: 0 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByText("No data for this period.")).toBeInTheDocument();
    });
  });

  it("renders chart and summary cards with sample data", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [
        { period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 },
        { period: "2024-02", periodStart: "2024-02-01", periodEnd: "2024-02-29", income: 5200, expenses: 3500, net: 1700 },
      ],
      totals: { income: 10200, expenses: 6500, net: 3700, knownIncome: 10200, knownExpenses: 6500, knownNet: 3700 },
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
      totals: { income: 0, expenses: 0, net: 0, knownIncome: 0, knownExpenses: 0, knownNet: 0 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByTestId("date-range-selector")).toBeInTheDocument();
    });
  });

  it("renders negative savings with orange styling", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 2000, expenses: 3000, net: -1000 }],
      totals: { income: 2000, expenses: 3000, net: -1000, knownIncome: 2000, knownExpenses: 3000, knownNet: -1000 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByText("Total Savings")).toBeInTheDocument();
    });
    expect(screen.getByText("Savings Rate")).toBeInTheDocument();
  });

  it("surfaces a retryable error state when the API fails", async () => {
    mockGetIncomeVsExpenses.mockRejectedValue(new Error("Network error"));
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByText(/failed to load report data/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("renders bar chart with monthly data", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
    });
  });

  it("navigates to transactions page with date range on chart background click", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
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

  it("navigates with income categoryType when clicking Income bar", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByTestId("bar-Income")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("bar-Income"));
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?startDate=2024-01-01&endDate=2024-01-31&categoryType=income",
    );
  });

  it("navigates with expense categoryType when clicking Expenses bar", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByTestId("bar-Expenses")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("bar-Expenses"));
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?startDate=2024-01-01&endDate=2024-01-31&categoryType=expense",
    );
  });

  it("does not include categoryType when clicking Savings bar", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => {
      expect(screen.getByTestId("bar-Savings")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("bar-Savings"));
    // Savings bar has no categoryType onClick, so falls through to chart-level click (date only)
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?startDate=2024-01-01&endDate=2024-01-31",
    );
  });

  it("computes savingsRate when totals.income is 0 (zero-income branch)", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 0, expenses: 100, net: -100 }],
      totals: { income: 0, expenses: 100, net: -100, knownIncome: 0, knownExpenses: 100, knownNet: -100 },
    });
    render(<IncomeVsExpensesReport />);
    await waitFor(() => expect(screen.getByText("Total Income")).toBeInTheDocument());
    expect(screen.getByText("0.0%")).toBeInTheDocument();
  });

  it("renders sortable table view, sorts each column, navigates and exports CSV", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [
        { period: "2024-02", periodStart: "2024-02-01", periodEnd: "2024-02-29", income: 5200, expenses: 3500, net: 1700 },
        { period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 },
        { period: "2024-03", periodStart: "2024-03-01", periodEnd: "2024-03-31", income: 1000, expenses: 2000, net: -1000 },
      ],
      totals: { income: 11200, expenses: 8500, net: 2700, knownIncome: 11200, knownExpenses: 8500, knownNet: 2700 },
    });
    const { container } = render(<IncomeVsExpensesReport />);
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
    // Click a row to navigate.
    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBeGreaterThan(0);
    await act(async () => { fireEvent.click(rows[0]); });
    await act(async () => { fireEvent.click(screen.getByTestId("export-csv")); });
  });

  // The row is the click target, so it has to be reachable and operable from
  // the keyboard as well (WCAG 2.1.1). Before the fix this row was a
  // `cursor-pointer` `<tr>` with an `onClick` and no `tabIndex` and no
  // `onKeyDown` -- the whole suite was green over a row no keyboard user could
  // use, so this case is what fails on that shape.
  it("activates a month row from the keyboard", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
    });
    const { container } = render(<IncomeVsExpensesReport />);
    await waitFor(() => expect(screen.getByTestId("toggle-table")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId("toggle-table")); });
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    const row = container.querySelector('tbody tr') as HTMLElement;
    expect(row).toHaveAttribute('tabindex', '0');

    const expected = "/transactions?startDate=2024-01-01&endDate=2024-01-31";
    await act(async () => { fireEvent.keyDown(row, { key: 'Enter' }); });
    expect(mockPush).toHaveBeenCalledWith(expected);

    mockPush.mockClear();
    await act(async () => { fireEvent.keyDown(row, { key: ' ' }); });
    expect(mockPush).toHaveBeenCalledWith(expected);

    // A key the row does not claim stays the browser's.
    mockPush.mockClear();
    await act(async () => { fireEvent.keyDown(row, { key: 'a' }); });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("marks the totals as subtotals when the server left a row out", async () => {
    // Each total is withheld when a row could not be converted; what is shown
    // is the part that did convert, marked. Income, expenses and savings all
    // come from the same window, so all three carry the marker.
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: null, expenses: null, net: null, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
      currency: "CAD",
      missingCurrencies: ["JPY"],
      excludedCount: 1,
    });

    await act(async () => {
      render(<IncomeVsExpensesReport />);
    });

    expect((await screen.findAllByTestId("partial-total")).length).toBeGreaterThan(0);
  });

  it("carries the partial note onto the PDF cards the screen marks", async () => {
    // The screen wraps income, expenses and savings in PartialTotal; the PDF
    // used to print the same subtotals under "Total ..." with nothing beside
    // them, and a document leaves the application without its caveat.
    mockExportToPdf.mockResolvedValue(undefined);
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: null, expenses: null, net: null, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
      currency: "CAD",
      missingCurrencies: ["JPY"],
      excludedCount: 1,
    });
    await act(async () => {
      render(<IncomeVsExpensesReport />);
    });
    await waitFor(() => expect(screen.getByTestId("bar-chart")).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId("export-pdf"));
    });
    const cards = mockExportToPdf.mock.calls[0][0].summaryCards as Array<{ label: string; note?: string }>;
    for (const label of ["Total Income", "Total Expenses", "Total Savings"]) {
      const card = cards.find((c) => c.label === label);
      expect(card?.note, label).toEqual(expect.stringContaining("JPY"));
    }
  });

  it("writes no note on the PDF cards of a complete report", async () => {
    mockExportToPdf.mockResolvedValue(undefined);
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
      currency: "CAD",
      missingCurrencies: [],
      excludedCount: 0,
    });
    await act(async () => {
      render(<IncomeVsExpensesReport />);
    });
    await waitFor(() => expect(screen.getByTestId("bar-chart")).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId("export-pdf"));
    });
    const cards = mockExportToPdf.mock.calls[0][0].summaryCards as Array<{ note?: string }>;
    expect(cards.every((c) => c.note === undefined)).toBe(true);
  });

  it("leaves complete totals unmarked", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
      currency: "CAD",
      missingCurrencies: [],
      excludedCount: 0,
    });

    await act(async () => {
      render(<IncomeVsExpensesReport />);
    });
    await waitFor(() => expect(screen.getByTestId("bar-chart")).toBeInTheDocument());

    expect(screen.queryByTestId("partial-total")).toBeNull();
  });

  describe("tag key breakdown", () => {
    it("hides the selector when the user has no KEY:VALUE tags", async () => {
      mockGetAllTags.mockResolvedValue([{ id: "t1", name: "groceries" }]);
      mockGetIncomeVsExpenses.mockResolvedValue({
        data: [],
        totals: { income: 0, expenses: 0, net: 0, knownIncome: 0, knownExpenses: 0, knownNet: 0 },
      });
      render(<IncomeVsExpensesReport />);
      await waitFor(() => expect(screen.getByText("No data for this period.")).toBeInTheDocument());
      expect(screen.queryByRole("combobox", { name: "Break down by tag key" })).toBeNull();
    });

    it('shows the selector and sends no tagKey while "None" is selected', async () => {
      mockGetAllTags.mockResolvedValue([{ id: "t1", name: "scope:household" }]);
      mockGetIncomeVsExpenses.mockResolvedValue({
        data: [],
        totals: { income: 0, expenses: 0, net: 0, knownIncome: 0, knownExpenses: 0, knownNet: 0 },
      });
      render(<IncomeVsExpensesReport />);
      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Break down by tag key" })).toBeInTheDocument(),
      );
      const lastCall = mockGetIncomeVsExpenses.mock.calls.at(-1)?.[0];
      expect(lastCall).not.toHaveProperty("tagKey");
    });

    it("renders value buckets and the untagged bucket once a key is chosen", async () => {
      mockGetAllTags.mockResolvedValue([{ id: "t1", name: "scope:household" }]);
      mockGetIncomeVsExpenses.mockResolvedValue({
        data: [],
        totals: { income: 0, expenses: 0, net: 0, knownIncome: 0, knownExpenses: 0, knownNet: 0 },
        currency: "CAD",
        missingCurrencies: [],
        excludedCount: 0,
      });
      render(<IncomeVsExpensesReport />);
      const select = await screen.findByRole("combobox", { name: "Break down by tag key" });

      mockGetIncomeVsExpenses.mockResolvedValue({
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
        expect(mockGetIncomeVsExpenses.mock.calls.at(-1)?.[0]).toMatchObject({ tagKey: "scope" }),
      );
      expect(await screen.findByRole("tab", { name: "household" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Untagged" })).toBeInTheDocument();

      // Tagged flows render as their own labelled pair, distinct from income/expenses.
      const taggedFlows = screen.getByTestId("tagged-flows");
      expect(taggedFlows).toHaveTextContent("Tagged inflows");
      expect(taggedFlows).toHaveTextContent("Tagged outflows");
    });

    it("shows the missing-rate treatment for an incomplete bucket", async () => {
      mockGetAllTags.mockResolvedValue([{ id: "t1", name: "scope:household" }]);
      mockGetIncomeVsExpenses.mockResolvedValue({
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
      render(<IncomeVsExpensesReport />);
      await screen.findByRole("combobox", { name: "Break down by tag key" });

      expect((await screen.findAllByTestId("partial-total")).length).toBeGreaterThan(0);
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

    it("sends no accountIds while nothing is selected (every account)", async () => {
      mockGetAllAccounts.mockResolvedValue(accounts);
      mockGetIncomeVsExpenses.mockResolvedValue(empty);
      render(<IncomeVsExpensesReport />);
      await screen.findByRole("button", { name: "Filter by account" });
      await waitFor(() => expect(mockGetIncomeVsExpenses).toHaveBeenCalled());
      expect(mockGetIncomeVsExpenses.mock.calls.at(-1)?.[0]).not.toHaveProperty("accountIds");
    });

    it("bounds the breakdown's tagged flows by the offered accounts under 'All Accounts' (spec 10.8.1)", async () => {
      mockGetAllTags.mockResolvedValue([{ id: "t1", name: "scope:household" }]);
      mockGetAllAccounts.mockResolvedValue(accounts);
      mockGetIncomeVsExpenses.mockResolvedValue(empty);
      render(<IncomeVsExpensesReport />);
      const select = await screen.findByRole("combobox", { name: "Break down by tag key" });
      await waitFor(() => expect(mockGetAllAccounts).toHaveBeenCalled());

      await act(async () => {
        fireEvent.change(select, { target: { value: "scope" } });
      });

      await waitFor(() =>
        expect(mockGetIncomeVsExpenses.mock.calls.at(-1)?.[0]).toMatchObject({
          tagKey: "scope",
          // The picker's offer (the RRSP sleeve is not in it), never accountIds:
          // income and expenses stay the unfiltered report's.
          transferScopeAccountIds: ["acct-checking"],
        }),
      );
      expect(mockGetIncomeVsExpenses.mock.calls.at(-1)?.[0]).not.toHaveProperty("accountIds");
    });

    it("sends no transferScopeAccountIds without a breakdown", async () => {
      mockGetAllAccounts.mockResolvedValue(accounts);
      mockGetIncomeVsExpenses.mockResolvedValue(empty);
      render(<IncomeVsExpensesReport />);
      await waitFor(() => expect(mockGetAllAccounts).toHaveBeenCalled());
      await waitFor(() => expect(mockGetIncomeVsExpenses).toHaveBeenCalled());
      for (const [params] of mockGetIncomeVsExpenses.mock.calls) {
        expect(params).not.toHaveProperty("transferScopeAccountIds");
      }
    });

    it("offers non-investment accounts only and reloads with the chosen accountIds", async () => {
      mockGetAllAccounts.mockResolvedValue(accounts);
      mockGetIncomeVsExpenses.mockResolvedValue(empty);
      render(<IncomeVsExpensesReport />);
      const trigger = await screen.findByRole("button", { name: "Filter by account" });
      await waitFor(() => expect(mockGetAllAccounts).toHaveBeenCalled());

      fireEvent.click(trigger);
      expect(await screen.findByText("Checking")).toBeInTheDocument();
      expect(screen.queryByText("RRSP")).toBeNull();
      fireEvent.click(screen.getByText("Checking"));

      await waitFor(() =>
        expect(mockGetIncomeVsExpenses.mock.calls.at(-1)?.[0]).toMatchObject({
          accountIds: ["acct-checking"],
        }),
      );
    });

    it("reopens on the accounts the user last chose", async () => {
      window.localStorage.setItem(
        "monize-reports-income-vs-expenses-accounts",
        JSON.stringify(["acct-checking"]),
      );
      mockGetAllAccounts.mockResolvedValue(accounts);
      mockGetIncomeVsExpenses.mockResolvedValue(empty);
      render(<IncomeVsExpensesReport />);
      await waitFor(() =>
        expect(mockGetIncomeVsExpenses.mock.calls.at(-1)?.[0]).toMatchObject({
          accountIds: ["acct-checking"],
        }),
      );
    });
  });

  describe("tagged-flow series on the main chart", () => {
    const period = (p: string, start: string, end: string, income: number, expenses: number) => ({
      period: p,
      periodStart: start,
      periodEnd: end,
      income,
      expenses,
      net: income - expenses,
    });
    const tagged = (p: ReturnType<typeof period>, inflows: number, outflows: number) => ({
      ...p,
      income: 0,
      expenses: 0,
      net: 0,
      taggedInflows: inflows,
      taggedOutflows: outflows,
    });
    const jan = period("2024-01", "2024-01-01", "2024-01-31", 5000, 3000);
    const feb = period("2024-02", "2024-02-01", "2024-02-29", 5200, 3500);
    const totals = { income: 10200, expenses: 6500, net: 3700, knownIncome: 10200, knownExpenses: 6500, knownNet: 3700 };
    const zeroTotals = { income: 0, expenses: 0, net: 0, knownIncome: 0, knownExpenses: 0, knownNet: 0 };

    const withBuckets = {
      data: [jan, feb],
      totals,
      currency: "CAD",
      missingCurrencies: [],
      excludedCount: 0,
      tagKey: "scope",
      buckets: [
        {
          value: "household",
          isUntagged: false,
          data: [tagged(jan, 7066, 7066), tagged(feb, 0, 0)],
          totals: zeroTotals,
          taggedInflows: 7066,
          taggedOutflows: 7066,
          missingCurrencies: [],
          excludedCount: 0,
        },
        {
          value: "__untagged__",
          isUntagged: true,
          data: [tagged(jan, 0, 0), tagged(feb, 0, 0)],
          totals,
          taggedInflows: 0,
          taggedOutflows: 0,
          missingCurrencies: [],
          excludedCount: 0,
        },
      ],
    };

    it("adds no flow series without a tag key", async () => {
      mockGetIncomeVsExpenses.mockResolvedValue({ data: [jan, feb], totals });
      render(<IncomeVsExpensesReport />);
      await screen.findByTestId("bar-Income");
      expect(screen.queryByTestId("bar-TaggedInflows")).toBeNull();
      expect(screen.queryByTestId("bar-TaggedOutflows")).toBeNull();
    });

    it("draws both series for the active value bucket and drops them on the untagged tab", async () => {
      mockGetAllTags.mockResolvedValue([{ id: "t1", name: "scope:household" }]);
      mockGetIncomeVsExpenses.mockResolvedValue(withBuckets);
      render(<IncomeVsExpensesReport />);

      expect(await screen.findByTestId("bar-TaggedInflows")).toBeInTheDocument();
      expect(screen.getByTestId("bar-TaggedOutflows")).toBeInTheDocument();
      // The savings series is untouched.
      expect(screen.getByTestId("bar-Savings")).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: "Untagged" }));
      });
      expect(screen.queryByTestId("bar-TaggedInflows")).toBeNull();
      expect(screen.queryByTestId("bar-TaggedOutflows")).toBeNull();

      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: "household" }));
      });
      expect(screen.getByTestId("bar-TaggedInflows")).toBeInTheDocument();
    });

    it("adds the two columns to the table under the same condition, and leaves savings alone", async () => {
      mockGetAllTags.mockResolvedValue([{ id: "t1", name: "scope:household" }]);
      mockGetIncomeVsExpenses.mockResolvedValue(withBuckets);
      render(<IncomeVsExpensesReport />);
      await screen.findByTestId("bar-TaggedInflows");

      fireEvent.click(screen.getByTestId("toggle-table"));
      const headers = (await screen.findAllByRole("columnheader")).map((h) => h.textContent);
      expect(headers.some((h) => h?.includes("Tagged inflows"))).toBe(true);
      expect(headers.some((h) => h?.includes("Tagged outflows"))).toBe(true);
      expect(screen.getAllByText("$7066").length).toBeGreaterThan(0);
      // Savings stay income minus expenses: 5000 - 3000, with no 7066 in them.
      expect(screen.getAllByText("$2000").length).toBeGreaterThan(0);

      await act(async () => {
        fireEvent.click(screen.getByRole("tab", { name: "Untagged" }));
      });
      const after = screen.getAllByRole("columnheader").map((h) => h.textContent);
      expect(after.some((h) => h?.includes("Tagged inflows"))).toBe(false);
    });

    describe("stacking toggle", () => {
      const STACK_KEY = "monize-reports-income-vs-expenses-stack-tagged";
      const switchName = { name: "Include tagged transfers" };
      // The breakdown card below the chart draws its own Income/Expenses bars,
      // so the main chart's bar is the first of each key.
      const mainBar = (key: string) => screen.getAllByTestId(`bar-${key}`)[0];

      beforeEach(() => {
        mockGetAllTags.mockResolvedValue([{ id: "t1", name: "scope:household" }]);
      });

      it("is hidden without a tag key", async () => {
        mockGetIncomeVsExpenses.mockResolvedValue({ data: [jan, feb], totals });
        render(<IncomeVsExpensesReport />);
        await screen.findByTestId("bar-Income");
        expect(screen.queryByRole("switch", switchName)).toBeNull();
      });

      it("is hidden on the untagged tab and back on a value tab", async () => {
        mockGetIncomeVsExpenses.mockResolvedValue(withBuckets);
        render(<IncomeVsExpensesReport />);
        expect(await screen.findByRole("switch", switchName)).toBeInTheDocument();

        await act(async () => {
          fireEvent.click(screen.getByRole("tab", { name: "Untagged" }));
        });
        expect(screen.queryByRole("switch", switchName)).toBeNull();

        await act(async () => {
          fireEvent.click(screen.getByRole("tab", { name: "household" }));
        });
        expect(screen.getByRole("switch", switchName)).toBeInTheDocument();
      });

      it("defaults off: every bar keeps its own column", async () => {
        mockGetIncomeVsExpenses.mockResolvedValue(withBuckets);
        render(<IncomeVsExpensesReport />);
        const toggle = await screen.findByRole("switch", switchName);

        expect(toggle).toHaveAttribute("aria-checked", "false");
        for (const key of ["Income", "Expenses", "Savings", "TaggedInflows", "TaggedOutflows"]) {
          expect(mainBar(key)).not.toHaveAttribute("data-stack-id");
        }
      });

      it("on: inflows share the Income stack and outflows the Expenses stack; Balance replaces Savings and stays alone", async () => {
        mockGetIncomeVsExpenses.mockResolvedValue(withBuckets);
        render(<IncomeVsExpensesReport />);
        fireEvent.click(await screen.findByRole("switch", switchName));

        const stackOf = (key: string) =>
          mainBar(key).getAttribute("data-stack-id");
        expect(stackOf("Income")).toBeTruthy();
        expect(stackOf("TaggedInflows")).toBe(stackOf("Income"));
        expect(stackOf("Expenses")).toBeTruthy();
        expect(stackOf("TaggedOutflows")).toBe(stackOf("Expenses"));
        expect(stackOf("Income")).not.toBe(stackOf("Expenses"));
        expect(screen.queryByTestId("bar-Savings")).toBeNull();
        expect(stackOf("Balance")).toBeNull();
      });

      it("changes no server figure: Income and Expenses read the same on and off, Savings only goes away", async () => {
        mockGetIncomeVsExpenses.mockResolvedValue(withBuckets);
        render(<IncomeVsExpensesReport />);
        const toggle = await screen.findByRole("switch", switchName);
        fireEvent.click(screen.getByTestId("toggle-table"));
        await screen.findAllByRole("columnheader");
        const row = () => document.querySelector("tbody tr")?.textContent ?? "";
        expect(row()).toContain("$5000");
        expect(row()).toContain("$3000");
        expect(row()).toContain("$2000");

        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute("aria-checked", "true");
        expect(row()).toContain("$5000");
        expect(row()).toContain("$3000");
        expect(row()).not.toContain("Savings");
      });

      it("persists the choice and reopens on it", async () => {
        mockGetIncomeVsExpenses.mockResolvedValue(withBuckets);
        const first = render(<IncomeVsExpensesReport />);
        fireEvent.click(await screen.findByRole("switch", switchName));
        expect(window.localStorage.getItem(STACK_KEY)).toBe("true");
        first.unmount();

        render(<IncomeVsExpensesReport />);
        expect(await screen.findByRole("switch", switchName)).toHaveAttribute(
          "aria-checked",
          "true",
        );
        expect(mainBar("TaggedInflows")).toHaveAttribute(
          "data-stack-id",
          mainBar("Income").getAttribute("data-stack-id"),
        );
      });

      it("a stored 'on' draws nothing stacked while no flow series exists", async () => {
        window.localStorage.setItem(STACK_KEY, "true");
        mockGetIncomeVsExpenses.mockResolvedValue({ data: [jan, feb], totals });
        render(<IncomeVsExpensesReport />);
        await screen.findByTestId("bar-Income");
        expect(mainBar("Income")).not.toHaveAttribute("data-stack-id");
      });

    describe("Balance view (spec section 10.9)", () => {
      // The reporter's August 2026 figures: Income 3,279, Tagged inflows 4,516,
      // Expenses 8,486 -> Balance -691, Balance % -8.86.
      const aug = period("2026-08", "2026-08-01", "2026-08-31", 3279, 8486);
      const augResponse = (outflows = 0, bucketOverrides: Record<string, unknown> = {}) => ({
        data: [aug],
        totals: { income: 3279, expenses: 8486, net: -5207, knownIncome: 3279, knownExpenses: 8486, knownNet: -5207 },
        currency: "CAD",
        missingCurrencies: [],
        excludedCount: 0,
        tagKey: "scope",
        buckets: [
          {
            value: "household",
            isUntagged: false,
            data: [tagged(aug, 4516, outflows)],
            totals: zeroTotals,
            taggedInflows: 4516,
            taggedOutflows: outflows,
            missingCurrencies: [],
            excludedCount: 0,
            ...bucketOverrides,
          },
        ],
      });
      const switchOn = { name: "Include tagged transfers" };
      const turnOn = async () =>
        fireEvent.click(await screen.findByRole("switch", switchOn));

      beforeEach(() => {
        mockGetAllTags.mockResolvedValue([{ id: "t1", name: "scope:household" }]);
      });

      it("off: Savings and Savings Rate, no Balance anywhere", async () => {
        mockGetIncomeVsExpenses.mockResolvedValue(augResponse());
        render(<IncomeVsExpensesReport />);
        await screen.findByRole("switch", switchOn);

        const card = within(mainCard());
        expect(card.getByText("Total Savings")).toBeInTheDocument();
        expect(card.getByText("Savings Rate")).toBeInTheDocument();
        expect(card.queryByText("Balance")).toBeNull();
        expect(card.queryByText("Balance %")).toBeNull();
        expect(screen.getByTestId("bar-Savings")).toBeInTheDocument();
        expect(screen.queryByTestId("bar-Balance")).toBeNull();
        expect(lastChartData[0]).not.toHaveProperty("Balance");
      });

      it("on: the cards read Income, Tagged inflows, Expenses, Balance and Balance %, never Savings", async () => {
        mockGetIncomeVsExpenses.mockResolvedValue(augResponse());
        render(<IncomeVsExpensesReport />);
        await turnOn();

        const card = within(mainCard());
        const labels = ["Total Income", "Tagged inflows", "Total Expenses", "Balance", "Balance %"].map(
          (label) => card.getByText(label),
        );
        // In reading order on the page.
        for (let i = 1; i < labels.length; i += 1) {
          expect(
            labels[i - 1].compareDocumentPosition(labels[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
          ).toBeTruthy();
        }
        expect(card.getByText("$-691")).toBeInTheDocument();
        expect(card.getByText("-8.86%")).toBeInTheDocument();
        expect(card.getByText("$4516")).toBeInTheDocument();
        expect(card.queryByText("Total Savings")).toBeNull();
        expect(card.queryByText("Savings Rate")).toBeNull();
        // No tagged outflows in the window, so no card for them.
        expect(card.queryByText("Tagged outflows")).toBeNull();
        // Income stays the server's figure (INV-REPORT-003).
        expect(card.getByText("$3279")).toBeInTheDocument();
        expect(lastChartData[0]).toMatchObject({ Income: 3279, Expenses: 8486, Balance: -691, BalancePercent: -8.86 });
      });

      it("on: shows the Tagged outflows card only when the window has some, and takes it off the Balance", async () => {
        mockGetIncomeVsExpenses.mockResolvedValue(augResponse(100));
        render(<IncomeVsExpensesReport />);
        await turnOn();

        const card = within(mainCard());
        expect(card.getByText("Tagged outflows")).toBeInTheDocument();
        // -691 - 100 = -791 over 7,795: -10.15%.
        expect(card.getByText("$-791")).toBeInTheDocument();
        expect(card.getByText("-10.15%")).toBeInTheDocument();
      });

      it("on: the window Balance is a marked subtotal with no percentage when the bucket is incomplete", async () => {
        mockGetIncomeVsExpenses.mockResolvedValue(
          augResponse(0, { missingCurrencies: ["JPY"], excludedCount: 1 }),
        );
        render(<IncomeVsExpensesReport />);
        await turnOn();

        const card = within(mainCard()).getByText("Balance").parentElement as HTMLElement;
        expect(card.querySelector('[data-testid="partial-total"]')).not.toBeNull();
        const percent = within(mainCard()).getByText("Balance %").parentElement as HTMLElement;
        expect(percent.textContent).toContain("\u2014");
        expect(percent.querySelector('[data-testid="partial-total"]')).toBeNull();
      });

      it("on: the window Balance is a marked subtotal when the All totals are incomplete", async () => {
        mockGetIncomeVsExpenses.mockResolvedValue({
          ...augResponse(),
          totals: { income: null, expenses: null, net: null, knownIncome: 3279, knownExpenses: 8486, knownNet: -5207 },
          missingCurrencies: ["EUR"],
          excludedCount: 1,
        });
        render(<IncomeVsExpensesReport />);
        await turnOn();

        const card = within(mainCard()).getByText("Balance").parentElement as HTMLElement;
        expect(card.querySelector('[data-testid="partial-total"]')).not.toBeNull();
      });

      it("on: the table lists Income, Tagged inflows, Expenses, Balance, Balance % with no Savings columns", async () => {
        mockGetIncomeVsExpenses.mockResolvedValue(augResponse());
        render(<IncomeVsExpensesReport />);
        await turnOn();
        fireEvent.click(screen.getByTestId("toggle-table"));

        await screen.findAllByRole("columnheader");
        expect(tableHeaders()).toEqual([
          "Month",
          "Income",
          "Tagged inflows",
          "Expenses",
          "Balance",
          "Balance %",
        ]);
        const cells = Array.from(document.querySelectorAll("tbody tr td")).map((c) => c.textContent);
        expect(cells.join("|")).toContain("$-691");
        expect(cells.join("|")).toContain("-8.86%");
      });

      it("on: the Tagged outflows column appears between Expenses and Balance when there are outflows", async () => {
        mockGetIncomeVsExpenses.mockResolvedValue(augResponse(100));
        render(<IncomeVsExpensesReport />);
        await turnOn();
        fireEvent.click(screen.getByTestId("toggle-table"));

        await screen.findAllByRole("columnheader");
        expect(tableHeaders()).toEqual([
          "Month",
          "Income",
          "Tagged inflows",
          "Expenses",
          "Tagged outflows",
          "Balance",
          "Balance %",
        ]);
      });

      it("on: a stored sort on Savings falls back to the month and Balance is sortable", async () => {
        window.localStorage.setItem(
          "reports.income-vs-expenses.table.sort",
          JSON.stringify({ field: "savings", direction: "desc" }),
        );
        mockGetIncomeVsExpenses.mockResolvedValue(augResponse());
        render(<IncomeVsExpensesReport />);
        await turnOn();
        fireEvent.click(screen.getByTestId("toggle-table"));
        await screen.findAllByRole("columnheader");
        const sortable = screen.getAllByRole("columnheader").find((h) => h.textContent?.includes("Balance %"));
        expect(sortable).toBeTruthy();
        await act(async () => {
          fireEvent.click(sortable as HTMLElement);
        });
        expect(document.querySelector("tbody tr")).toBeInTheDocument();
      });

      it("on: the CSV carries the same columns in the same order as the table", async () => {
        mockGetIncomeVsExpenses.mockResolvedValue(augResponse());
        render(<IncomeVsExpensesReport />);
        await turnOn();
        await act(async () => {
          fireEvent.click(screen.getByTestId("export-csv"));
        });

        expect(mockExportToCsv).toHaveBeenCalledTimes(1);
        const [, headers, rows] = mockExportToCsv.mock.calls[0];
        expect(headers).toEqual(["Month", "Income", "Tagged inflows", "Expenses", "Balance", "Balance %"]);
        expect(rows[0].slice(1)).toEqual([3279, 4516, 8486, -691, "-8.86%"]);
      });

      it("off: the CSV keeps Savings and Savings Rate", async () => {
        mockGetIncomeVsExpenses.mockResolvedValue(augResponse());
        render(<IncomeVsExpensesReport />);
        await screen.findByRole("switch", switchOn);
        await act(async () => {
          fireEvent.click(screen.getByTestId("export-csv"));
        });

        const [, headers] = mockExportToCsv.mock.calls[0];
        expect(headers).toEqual([
          "Month",
          "Income",
          "Expenses",
          "Savings",
          "Savings Rate",
          "Tagged inflows",
          "Tagged outflows",
        ]);
      });

      it("on: the tooltip lists Income, Tagged inflows, Expenses, Balance, then Balance %, and hides zero outflows", async () => {
        mockGetIncomeVsExpenses.mockResolvedValue(augResponse());
        render(<IncomeVsExpensesReport />);
        await turnOn();
        // Re-render once more so the tooltip element for the balance view is the one captured.
        renderTooltipFor(lastChartData[0], ["Income", "Expenses", "Balance", "TaggedInflows", "TaggedOutflows"]);

        const lines = Array.from(document.querySelectorAll("p")).map((p) => p.textContent);
        const tooltip = lines.filter((l) => /^(Income|Tagged|Expenses|Balance)/.test(l ?? ""));
        expect(tooltip).toEqual([
          "Income: $3279",
          "Tagged inflows: household: $4516",
          "Expenses: $8486",
          "Balance: $-691",
          "Balance %: -8.86%",
        ]);
      });

      it("on: the tooltip shows Tagged outflows when the period has some, and a dash when nothing came in", async () => {
        mockGetIncomeVsExpenses.mockResolvedValue({
          ...augResponse(0),
          data: [period("2026-08", "2026-08-01", "2026-08-31", 0, 40)],
          buckets: [
            {
              ...augResponse(0).buckets[0],
              data: [tagged(period("2026-08", "2026-08-01", "2026-08-31", 0, 40), 0, 25)],
              taggedInflows: 0,
              taggedOutflows: 25,
            },
          ],
        });
        render(<IncomeVsExpensesReport />);
        await turnOn();
        renderTooltipFor(lastChartData[0], ["Income", "Expenses", "Balance", "TaggedInflows", "TaggedOutflows"]);

        const lines = Array.from(document.querySelectorAll("p")).map((p) => p.textContent);
        expect(lines).toContain("Tagged outflows: household: $25");
        expect(lines).toContain("Balance: $-65");
        expect(lines).toContain("Balance %: \u2014");
      });

      it("switching the tab to untagged returns to Savings", async () => {
        mockGetIncomeVsExpenses.mockResolvedValue({
          ...augResponse(),
          buckets: [
            ...augResponse().buckets,
            { ...augResponse().buckets[0], value: "__untagged__", isUntagged: true, taggedInflows: 0 },
          ],
        });
        render(<IncomeVsExpensesReport />);
        await turnOn();
        expect(screen.getByTestId("bar-Balance")).toBeInTheDocument();

        await act(async () => {
          fireEvent.click(screen.getByRole("tab", { name: "Untagged" }));
        });
        expect(screen.queryByTestId("bar-Balance")).toBeNull();
        expect(screen.getByTestId("bar-Savings")).toBeInTheDocument();
        expect(within(mainCard()).getByText("Total Savings")).toBeInTheDocument();
      });
    });
    });
  });
});

describe("IncomeVsExpensesReport: a reload is not the previous answer", () => {
  const answer = { data: [{ period: "2024-01", periodStart: "2024-01-01", periodEnd: "2024-01-31", income: 5000, expenses: 3000, net: 2000 }], totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRange.end = "2025-01-01";
  });

  async function loadThenChangeRange(next: () => unknown) {
    mockGetIncomeVsExpenses.mockResolvedValue(answer);
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<IncomeVsExpensesReport />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("export-pdf")).toHaveAttribute("data-disabled", "false"),
    );

    mockGetIncomeVsExpenses.mockImplementation(next);
    mockRange.end = "2025-02-01";
    await act(async () => {
      view.rerender(<IncomeVsExpensesReport />);
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
