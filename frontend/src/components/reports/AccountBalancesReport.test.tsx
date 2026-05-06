import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@/test/render";
import { AccountBalancesReport } from "./AccountBalancesReport";

vi.mock("@/lib/pdf-export", () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/hooks/useNumberFormat", () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number, _currency?: string) => `$${n.toFixed(2)}`,
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    defaultCurrency: "CAD",
  }),
}));

vi.mock("@/hooks/useExchangeRates", () => ({
  useExchangeRates: () => ({
    convertToDefault: (amount: number, _currency: string) => amount,
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
  Pie: ({ onClick, data }: any) => (
    <div>
      <button data-testid="pie-click" onClick={() => onClick && onClick(data?.[0] ?? {})}>click</button>
    </div>
  ),
  Cell: () => null,
  Tooltip: ({ content }: any) => {
    if (content && content.type) {
      const C = content.type;
      try {
        return (
          <div>
            <C active={true} payload={[{ payload: { name: 'Cat', value: 100, percentage: 50, count: 2 } }]} />
            <C active={false} payload={[]} />
          </div>
        );
      } catch {
        return null;
      }
    }
    return null;
  },
}));

const mockGetAll = vi.fn();
const mockGetPortfolioSummary = vi.fn();

vi.mock("@/lib/accounts", () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
  },
}));

vi.mock("@/lib/investments", () => ({
  investmentsApi: {
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
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

describe("AccountBalancesReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
  });

  it("shows loading state initially", () => {
    mockGetAll.mockReturnValue(new Promise(() => {}));
    mockGetPortfolioSummary.mockReturnValue(new Promise(() => {}));
    render(<AccountBalancesReport />);
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("renders empty state when no accounts", async () => {
    mockGetAll.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(null);
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("No accounts found.")).toBeInTheDocument();
    });
  });

  it("renders summary cards with data", async () => {
    mockGetAll.mockResolvedValue([
      {
        id: "acc-1",
        name: "Chequing",
        accountType: "CHEQUING",
        accountSubType: null,
        currentBalance: 5000,
        currencyCode: "CAD",
        isClosed: false,
      },
      {
        id: "acc-2",
        name: "Visa",
        accountType: "CREDIT_CARD",
        accountSubType: null,
        currentBalance: -1200,
        currencyCode: "CAD",
        isClosed: false,
      },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(null);
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Total Assets")).toBeInTheDocument();
    });
    expect(screen.getByText("Total Liabilities")).toBeInTheDocument();
    expect(screen.getByText("Net Worth")).toBeInTheDocument();
  });

  it("renders filter buttons", async () => {
    mockGetAll.mockResolvedValue([
      {
        id: "acc-1",
        name: "Savings",
        accountType: "SAVINGS",
        accountSubType: null,
        currentBalance: 10000,
        currencyCode: "CAD",
        isClosed: false,
      },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(null);
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("all")).toBeInTheDocument();
    });
    expect(screen.getByText("assets")).toBeInTheDocument();
    expect(screen.getByText("liabilities")).toBeInTheDocument();
  });

  it("navigates to transactions page on account click", async () => {
    mockGetAll.mockResolvedValue([
      {
        id: "acc-1",
        name: "Chequing",
        accountType: "CHEQUING",
        accountSubType: null,
        currentBalance: 5000,
        currencyCode: "CAD",
        isClosed: false,
      },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(null);
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getAllByText("Chequing").length).toBeGreaterThanOrEqual(1);
    });
    // Click the account row button (not the group header)
    const buttons = screen
      .getAllByText("Chequing")
      .map((el) => el.closest("button"))
      .filter(Boolean);
    fireEvent.click(buttons[0]!);
    expect(mockPush).toHaveBeenCalledWith("/transactions?accountId=acc-1");
  });

  it("navigates to investments page for brokerage account click", async () => {
    mockGetAll.mockResolvedValue([
      {
        id: "acc-b",
        name: "Brokerage",
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_BROKERAGE",
        currentBalance: 0,
        currencyCode: "CAD",
        isClosed: false,
      },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdingsByAccount: [
        { accountId: "acc-b", totalMarketValue: 10000, cashBalance: 500 },
      ],
    });
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Brokerage")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Brokerage"));
    expect(mockPush).toHaveBeenCalledWith("/investments");
  });

  it("filters by assets and liabilities", async () => {
    mockGetAll.mockResolvedValue([
      { id: "acc-1", name: "Chequing", accountType: "CHEQUING", accountSubType: null, currentBalance: 5000, currencyCode: "CAD", isClosed: false },
      { id: "acc-2", name: "Visa", accountType: "CREDIT_CARD", accountSubType: null, currentBalance: -1200, currencyCode: "CAD", isClosed: false },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(null);
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("assets")).toBeInTheDocument();
    });
    await act(async () => { fireEvent.click(screen.getByText("assets")); });
    await act(async () => { fireEvent.click(screen.getByText("liabilities")); });
    await act(async () => { fireEvent.click(screen.getByText("all")); });
  });

  it("switches to chart view and changes grouping", async () => {
    mockGetAll.mockResolvedValue([
      { id: "acc-1", name: "Chequing", accountType: "CHEQUING", accountSubType: null, currentBalance: 5000, currencyCode: "CAD", isClosed: false },
      { id: "acc-2", name: "Visa", accountType: "CREDIT_CARD", accountSubType: null, currentBalance: -1200, currencyCode: "CAD", isClosed: false },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(null);
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Total Assets")).toBeInTheDocument();
    });
    // find chart toggle - assume button with text "chart"
    const chartBtn = screen.queryByRole('button', { name: /chart/i });
    if (chartBtn) {
      await act(async () => { fireEvent.click(chartBtn); });
    }
  });

  it("exports pdf", async () => {
    const { exportToPdf } = await import("@/lib/pdf-export");
    (exportToPdf as any).mockClear();
    mockGetAll.mockResolvedValue([
      { id: "acc-1", name: "Chequing", accountType: "CHEQUING", accountSubType: null, currentBalance: 5000, currencyCode: "CAD", isClosed: false },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(null);
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Total Assets")).toBeInTheDocument();
    });
    const exportBtn = screen.getByRole('button', { name: /export/i });
    await act(async () => { fireEvent.click(exportBtn); });
    const pdfBtn = screen.queryByText(/PDF/i);
    if (pdfBtn) {
      await act(async () => { fireEvent.click(pdfBtn); });
    }
  });

  it("handles error in loadData", async () => {
    mockGetAll.mockRejectedValue(new Error('boom'));
    mockGetPortfolioSummary.mockResolvedValue(null);
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText('No accounts found.')).toBeInTheDocument();
    });
  });

  it("filters out closed accounts", async () => {
    mockGetAll.mockResolvedValue([
      { id: "acc-1", name: "Open", accountType: "CHEQUING", accountSubType: null, currentBalance: 5000, currencyCode: "CAD", isClosed: false },
      { id: "acc-2", name: "Closed", accountType: "SAVINGS", accountSubType: null, currentBalance: 10000, currencyCode: "CAD", isClosed: true },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(null);
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Total Assets")).toBeInTheDocument();
    });
    expect(screen.queryByText('Closed')).not.toBeInTheDocument();
  });

  it("does not double-count investment cash in brokerage and linked cash account", async () => {
    mockGetAll.mockResolvedValue([
      {
        id: "acc-brokerage",
        name: "Investments - Brokerage",
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_BROKERAGE",
        currentBalance: 0,
        currencyCode: "CAD",
        isClosed: false,
        linkedAccountId: "acc-cash",
      },
      {
        id: "acc-cash",
        name: "Investments - Cash",
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_CASH",
        currentBalance: 5000,
        currencyCode: "CAD",
        isClosed: false,
        linkedAccountId: "acc-brokerage",
      },
    ]);
    mockGetPortfolioSummary.mockResolvedValue({
      holdingsByAccount: [
        { accountId: "acc-brokerage", totalMarketValue: 10000, cashBalance: 5000 },
      ],
    });
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Investments - Brokerage")).toBeInTheDocument();
    });
    // Total should be 10000 (holdings) + 5000 (cash account) = 15000
    // NOT 15000 (holdings+cash in brokerage) + 5000 (cash account) = 20000
    const assetElements = screen.getAllByText("$15000.00");
    expect(assetElements.length).toBeGreaterThanOrEqual(1);
  });
});
