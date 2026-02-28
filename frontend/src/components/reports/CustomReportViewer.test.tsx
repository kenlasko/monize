import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@/test/render";
import { CustomReportViewer } from "./CustomReportViewer";

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

vi.mock("@/hooks/useDateFormat", () => ({
  useDateFormat: () => ({
    formatDate: (d: string) => d,
  }),
}));

vi.mock("@/components/ui/Button", () => ({
  Button: ({ children, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/Select", () => ({
  Select: ({ label, options, ...props }: any) => (
    <div>
      <label>{label}</label>
      <select {...props}>
        {options?.map((o: any) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  ),
}));

vi.mock("@/components/reports/ReportChart", () => ({
  ReportChart: () => <div data-testid="report-chart" />,
}));

vi.mock("@/components/ui/IconPicker", () => ({
  getIconComponent: () => <span data-testid="icon" />,
}));

const mockGetById = vi.fn();
const mockExecute = vi.fn();

vi.mock("@/lib/custom-reports", () => ({
  customReportsApi: {
    getById: (...args: any[]) => mockGetById(...args),
    execute: (...args: any[]) => mockExecute(...args),
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

describe("CustomReportViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
  });

  it("shows loading state initially", () => {
    mockGetById.mockReturnValue(new Promise(() => {}));
    render(<CustomReportViewer reportId="rpt-1" />);
    expect(document.querySelector(".animate-spin")).toBeTruthy();
  });

  it("renders not found when report fails to load", async () => {
    mockGetById.mockRejectedValue(new Error("Not found"));
    render(<CustomReportViewer reportId="rpt-1" />);
    await waitFor(() => {
      expect(screen.getByText("Report not found")).toBeInTheDocument();
    });
    expect(screen.getByText("Back to Reports")).toBeInTheDocument();
  });

  it("renders report header and results", async () => {
    mockGetById.mockResolvedValue({
      id: "rpt-1",
      name: "Monthly Spending",
      description: "Track monthly spending",
      icon: "chart-bar",
      backgroundColor: "#3b82f6",
      viewType: "BAR_CHART",
      timeframeType: "LAST_3_MONTHS",
      groupBy: "CATEGORY",
      isFavourite: false,
      config: {
        metric: "TOTAL_AMOUNT",
        direction: "EXPENSES_ONLY",
        includeTransfers: false,
      },
      filters: {},
    });
    mockExecute.mockResolvedValue({
      viewType: "BAR_CHART",
      groupBy: "CATEGORY",
      data: [{ label: "Groceries", value: 500, count: 20, id: "cat-1" }],
      summary: { total: 500, count: 20 },
      timeframe: {
        label: "Last 3 months",
        startDate: "2024-10-01",
        endDate: "2025-01-01",
      },
    });
    render(<CustomReportViewer reportId="rpt-1" />);
    await waitFor(() => {
      expect(screen.getByText("Monthly Spending")).toBeInTheDocument();
    });
    expect(screen.getByText("Track monthly spending")).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
  });

  it("renders timeframe selector", async () => {
    mockGetById.mockResolvedValue({
      id: "rpt-1",
      name: "Test Report",
      viewType: "TABLE",
      timeframeType: "LAST_3_MONTHS",
      groupBy: "NONE",
      config: {
        metric: "TOTAL_AMOUNT",
        direction: "EXPENSES_ONLY",
        includeTransfers: false,
      },
      filters: {},
    });
    mockExecute.mockResolvedValue({
      viewType: "TABLE",
      groupBy: "NONE",
      data: [],
      summary: { total: 0, count: 0 },
      timeframe: { label: "Last 3 months" },
    });
    render(<CustomReportViewer reportId="rpt-1" />);
    await waitFor(() => {
      expect(screen.getByText("Timeframe")).toBeInTheDocument();
    });
  });

  it("renders no data message when result has empty data", async () => {
    mockGetById.mockResolvedValue({
      id: "rpt-1",
      name: "Empty Report",
      viewType: "PIE_CHART",
      timeframeType: "LAST_3_MONTHS",
      groupBy: "CATEGORY",
      config: {
        metric: "TOTAL_AMOUNT",
        direction: "EXPENSES_ONLY",
        includeTransfers: false,
      },
      filters: {},
    });
    mockExecute.mockResolvedValue({
      viewType: "PIE_CHART",
      groupBy: "CATEGORY",
      data: [],
      summary: { total: 0, count: 0 },
      timeframe: {
        label: "Last 3 months",
        startDate: "2024-10-01",
        endDate: "2025-01-01",
      },
    });
    render(<CustomReportViewer reportId="rpt-1" />);
    await waitFor(() => {
      expect(
        screen.getByText("No data found for the selected criteria"),
      ).toBeInTheDocument();
    });
  });

  it("renders pie chart legend when data is present with pie view", async () => {
    mockGetById.mockResolvedValue({
      id: "rpt-1",
      name: "Pie Report",
      icon: "chart-pie",
      backgroundColor: "#ef4444",
      viewType: "PIE_CHART",
      timeframeType: "LAST_3_MONTHS",
      groupBy: "CATEGORY",
      config: {
        metric: "TOTAL_AMOUNT",
        direction: "EXPENSES_ONLY",
        includeTransfers: false,
      },
      filters: {},
    });
    mockExecute.mockResolvedValue({
      viewType: "PIE_CHART",
      groupBy: "CATEGORY",
      data: [
        { label: "Food", value: 500, count: 20, id: "cat-1", color: "#ff0000" },
        {
          label: "Transport",
          value: 200,
          count: 10,
          id: "cat-2",
          color: "#00ff00",
        },
      ],
      summary: { total: 700, count: 30 },
      timeframe: {
        label: "Last 3 months",
        startDate: "2024-10-01",
        endDate: "2025-01-01",
      },
    });
    render(<CustomReportViewer reportId="rpt-1" />);
    await waitFor(() => {
      expect(screen.getByText("Pie Report")).toBeInTheDocument();
    });
    // Wait for the report execution to complete and legend to render
    await waitFor(() => {
      expect(screen.getByText("Food")).toBeInTheDocument();
    });
    expect(screen.getByText("Transport")).toBeInTheDocument();
    // Summary values
    expect(screen.getByText("$700.00")).toBeInTheDocument();
    expect(screen.getByText("30 transactions")).toBeInTheDocument();
  });

  it("renders bar chart legend", async () => {
    mockGetById.mockResolvedValue({
      id: "rpt-1",
      name: "Bar Report",
      viewType: "BAR_CHART",
      timeframeType: "LAST_3_MONTHS",
      groupBy: "PAYEE",
      config: {
        metric: "TOTAL_AMOUNT",
        direction: "EXPENSES_ONLY",
        includeTransfers: false,
      },
      filters: {},
    });
    mockExecute.mockResolvedValue({
      viewType: "BAR_CHART",
      groupBy: "PAYEE",
      data: [
        { label: "Amazon", value: 300, count: 5, id: "p-1", color: "#3b82f6" },
      ],
      summary: { total: 300, count: 5 },
      timeframe: {
        label: "Last 3 months",
        startDate: "2024-10-01",
        endDate: "2025-01-01",
      },
    });
    render(<CustomReportViewer reportId="rpt-1" />);
    await waitFor(() => {
      expect(screen.getByText("Bar Report")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("Amazon")).toBeInTheDocument();
    });
  });

  it("renders report without description and icon", async () => {
    mockGetById.mockResolvedValue({
      id: "rpt-1",
      name: "Simple Report",
      viewType: "TABLE",
      timeframeType: "LAST_3_MONTHS",
      groupBy: "NONE",
      config: {
        metric: "TOTAL_AMOUNT",
        direction: "EXPENSES_ONLY",
        includeTransfers: false,
      },
      filters: {},
    });
    mockExecute.mockResolvedValue({
      viewType: "TABLE",
      groupBy: "NONE",
      data: [{ label: "Item 1", value: 100, count: 2, id: "i-1" }],
      summary: { total: 100, count: 2 },
      timeframe: { label: "Last 3 months" },
    });
    render(<CustomReportViewer reportId="rpt-1" />);
    await waitFor(() => {
      expect(screen.getByText("Simple Report")).toBeInTheDocument();
    });
  });

  it("navigates to transactions with category on legend click", async () => {
    mockGetById.mockResolvedValue({
      id: "rpt-1",
      name: "Nav Report",
      viewType: "PIE_CHART",
      timeframeType: "LAST_3_MONTHS",
      groupBy: "CATEGORY",
      config: {
        metric: "TOTAL_AMOUNT",
        direction: "EXPENSES_ONLY",
        includeTransfers: false,
      },
      filters: {},
    });
    mockExecute.mockResolvedValue({
      viewType: "PIE_CHART",
      groupBy: "CATEGORY",
      data: [
        {
          label: "Groceries",
          value: 500,
          count: 20,
          id: "cat-1",
          color: "#ff0000",
        },
      ],
      summary: { total: 500, count: 20 },
      timeframe: {
        label: "Last 3 months",
        startDate: "2024-10-01",
        endDate: "2025-01-01",
      },
    });
    render(<CustomReportViewer reportId="rpt-1" />);
    await waitFor(() => {
      expect(screen.getByText("Groceries")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Groceries"));
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?startDate=2024-10-01&endDate=2025-01-01&categoryId=cat-1",
    );
  });

  it("navigates to transactions with payee on legend click", async () => {
    mockGetById.mockResolvedValue({
      id: "rpt-1",
      name: "Payee Report",
      viewType: "BAR_CHART",
      timeframeType: "LAST_3_MONTHS",
      groupBy: "PAYEE",
      config: {
        metric: "TOTAL_AMOUNT",
        direction: "EXPENSES_ONLY",
        includeTransfers: false,
      },
      filters: {},
    });
    mockExecute.mockResolvedValue({
      viewType: "BAR_CHART",
      groupBy: "PAYEE",
      data: [
        { label: "Amazon", value: 300, count: 5, id: "p-1", color: "#3b82f6" },
      ],
      summary: { total: 300, count: 5 },
      timeframe: {
        label: "Last 3 months",
        startDate: "2024-10-01",
        endDate: "2025-01-01",
      },
    });
    render(<CustomReportViewer reportId="rpt-1" />);
    await waitFor(() => {
      expect(screen.getByText("Amazon")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Amazon"));
    expect(mockPush).toHaveBeenCalledWith(
      "/transactions?startDate=2024-10-01&endDate=2025-01-01&payeeId=p-1",
    );
  });

  it("handles execute error gracefully", async () => {
    mockGetById.mockResolvedValue({
      id: "rpt-1",
      name: "Error Report",
      viewType: "TABLE",
      timeframeType: "LAST_3_MONTHS",
      groupBy: "NONE",
      config: {
        metric: "TOTAL_AMOUNT",
        direction: "EXPENSES_ONLY",
        includeTransfers: false,
      },
      filters: {},
    });
    mockExecute.mockRejectedValue(new Error("Execute failed"));
    render(<CustomReportViewer reportId="rpt-1" />);
    await waitFor(() => {
      expect(screen.getByText("Error Report")).toBeInTheDocument();
    });
  });
});
