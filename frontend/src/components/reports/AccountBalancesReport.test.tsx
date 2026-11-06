import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, within } from "@/test/render";
import { AccountBalancesReport } from "./AccountBalancesReport";

vi.mock("@/lib/pdf-export", () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

const mockExportToCsv = vi.fn();
vi.mock("@/lib/csv-export", () => ({
  exportToCsv: (...args: any[]) => mockExportToCsv(...args),
}));

vi.mock("@/components/ui/ExportDropdown", () => ({
  ExportDropdown: ({ onExportCsv, onExportPdf }: any) => (
    <div data-testid="export-dropdown">
      {onExportCsv && <button data-testid="export-csv" onClick={onExportCsv}>CSV</button>}
      <button data-testid="export-pdf" onClick={onExportPdf}>PDF</button>
    </div>
  ),
}));

// The real DateInput carries locale parsing and a calendar popover neither of
// which this report owns; a plain field keeps the test about the report.
vi.mock("@/components/ui/DateInput", () => ({
  DateInput: ({ label, value, onDateChange, ...props }: any) => (
    <label>
      {label}
      <input
        value={value ?? ""}
        onChange={(e) => onDateChange?.(e.target.value)}
        {...props}
      />
    </label>
  ),
}));

vi.mock("@/components/ui/MultiSelect", () => ({
  MultiSelect: ({ label, options, value, onChange }: any) => (
    <div data-testid={`multiselect-${label}`}>
      <span>{label}</span>
      {options.map((option: any) => (
        <button
          key={option.value}
          data-testid={`option-${option.value}`}
          onClick={() =>
            onChange(
              value.includes(option.value)
                ? value.filter((v: string) => v !== option.value)
                : [...value, option.value],
            )
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
}));

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number, _currency?: string) => `$${n.toFixed(2)}`,
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
      defaultCurrency: "CAD",
    }),
};
});
vi.mock("@/hooks/useDateFormat", () => ({
  useDateFormat: () => ({ formatDate: (d: string) => `date(${d})` }),
}));

vi.mock("@/lib/chart-colours", () => ({
  CHART_COLOURS: ["#3b82f6", "#ef4444", "#22c55e"],
  // Pinned so the tests can tell an asset slice's colour from a liability's
  // without depending on the real palettes.
  CHART_COLOURS_ASSETS: ["#111111", "#222222"],
  CHART_COLOURS_LIABILITIES: ["#999999", "#888888"],
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  PieChart: ({ children }: any) => <div data-testid="pie-chart">{children}</div>,
  Pie: () => null,
  Cell: () => null,
  Tooltip: ({ content }: any) => {
    if (content && content.type) {
      const C = content.type;
      try {
        return (
          <div>
            <C {...content.props} active={true} payload={[{ payload: { name: "Cat", value: 100 } }]} />
            <C {...content.props} active={false} payload={[]} />
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
const mockGetBalancesAsOf = vi.fn();
const mockGetInstitutions = vi.fn();

vi.mock("@/lib/accounts", () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    getBalancesAsOf: (...args: any[]) => mockGetBalancesAsOf(...args),
  },
}));

vi.mock("@/lib/institutions", () => ({
  institutionsApi: {
    getAll: (...args: any[]) => mockGetInstitutions(...args),
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

const TODAY = new Date().toISOString().slice(0, 10);

function acc(overrides: Record<string, unknown> = {}) {
  return {
    id: "acc-1",
    name: "Chequing",
    accountType: "CHEQUING",
    accountSubType: null,
    currencyCode: "CAD",
    isClosed: false,
    isFavourite: false,
    institution: null,
    institutionId: null,
    currentBalance: 0,
    ...overrides,
  };
}

function balance(accountId: string, value: number, overrides: Record<string, unknown> = {}) {
  return {
    accountId,
    currencyCode: "CAD",
    balance: value,
    marketValue: null,
    knownMarketValueSubtotal: 0,
    unpricedHoldingsCount: 0,
    missingRatePairs: [],
    pricesComplete: true,
    fxComplete: true,
    valuationComplete: true,
    existsAsOf: true,
    ...overrides,
  };
}

function balancesFor(
  rows: any[],
  asOfDate = TODAY,
  displayRates: Record<string, number> = { CAD: 1 },
) {
  return { asOfDate, displayCurrency: "CAD", displayRates, accounts: rows };
}

describe("AccountBalancesReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    mockExportToCsv.mockClear();
    mockGetInstitutions.mockResolvedValue([]);
  });

  it("shows loading state initially", () => {
    mockGetAll.mockReturnValue(new Promise(() => {}));
    mockGetBalancesAsOf.mockReturnValue(new Promise(() => {}));
    render(<AccountBalancesReport />);
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("renders empty state when no accounts", async () => {
    mockGetAll.mockResolvedValue([]);
    mockGetBalancesAsOf.mockResolvedValue(balancesFor([]));
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("No accounts found.")).toBeInTheDocument();
    });
  });

  // A balance is measured at an instant, and the instant a report with no date
  // chosen is about is today (issue #1198).
  it("asks the server for today's balances and says which date it is showing", async () => {
    mockGetAll.mockResolvedValue([acc()]);
    mockGetBalancesAsOf.mockResolvedValue(balancesFor([balance("acc-1", 5000)]));
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Total Assets")).toBeInTheDocument();
    });
    expect(mockGetBalancesAsOf).toHaveBeenCalledWith(TODAY);
    expect(screen.getByTestId("as-of-caption")).toHaveTextContent(`date(${TODAY})`);
  });

  // The behaviour change in docs/specs/account-balances-as-of.md section 2:
  // the report used to add every future-dated transaction to today's balance
  // and call the result the balance. It now shows the measured figure.
  it("shows the server's measured balance, not today's balance plus future rows", async () => {
    mockGetAll.mockResolvedValue([
      acc({ currentBalance: 3000, futureTransactionsSum: 500 }),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(balancesFor([balance("acc-1", 3000)]));
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getAllByText("$3000.00").length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.queryByText("$3500.00")).not.toBeInTheDocument();
  });

  it("refetches when the date changes and moves the caption with it", async () => {
    mockGetAll.mockResolvedValue([acc()]);
    mockGetBalancesAsOf.mockImplementation(async (date: string) =>
      balancesFor([balance("acc-1", date === "2020-01-01" ? 100 : 5000)], date),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getAllByText("$5000.00").length).toBeGreaterThanOrEqual(1);
    });

    await act(async () => {
      fireEvent.change(screen.getByTestId("as-of-date"), {
        target: { value: "2020-01-01" },
      });
    });

    await waitFor(() => {
      expect(screen.getAllByText("$100.00").length).toBeGreaterThanOrEqual(1);
    });
    expect(mockGetBalancesAsOf).toHaveBeenLastCalledWith("2020-01-01");
    expect(screen.getByTestId("as-of-caption")).toHaveTextContent("date(2020-01-01)");
  });

  it("renders summary cards with assets and liabilities", async () => {
    mockGetAll.mockResolvedValue([
      acc(),
      acc({ id: "acc-2", name: "Visa", accountType: "CREDIT_CARD" }),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(
      balancesFor([balance("acc-1", 5000), balance("acc-2", -1200)]),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Total Assets")).toBeInTheDocument();
    });
    expect(
      within(screen.getByTestId("summary-assets")).getByText("$5000.00"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("summary-liabilities")).getByText("$1200.00"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("summary-networth")).getByText("$3800.00"),
    ).toBeInTheDocument();
  });

  it("navigates to the register on an account click", async () => {
    mockGetAll.mockResolvedValue([acc()]);
    mockGetBalancesAsOf.mockResolvedValue(balancesFor([balance("acc-1", 5000)]));
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getAllByText("Chequing").length).toBeGreaterThanOrEqual(1);
    });
    fireEvent.click(rowButtons()[0]);
    expect(mockPush).toHaveBeenCalledWith("/transactions?accountId=acc-1");
  });

  it("navigates to investments for a holdings account", async () => {
    mockGetAll.mockResolvedValue([
      acc({
        id: "acc-b",
        name: "Brokerage",
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_BROKERAGE",
      }),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(
      balancesFor([balance("acc-b", 0, { marketValue: 10000, knownMarketValueSubtotal: 10000 })]),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Brokerage")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Brokerage"));
    expect(mockPush).toHaveBeenCalledWith("/investments");
  });

  it("filters to assets or liabilities", async () => {
    mockGetAll.mockResolvedValue([
      acc(),
      acc({ id: "acc-2", name: "Visa Card", accountType: "CREDIT_CARD" }),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(
      balancesFor([balance("acc-1", 5000), balance("acc-2", -1000)]),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByLabelText("Show")).toBeInTheDocument();
    });
    expect(rowNames()).toEqual(["Chequing", "Visa Card"]);

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Show"), { target: { value: "assets" } });
    });
    expect(rowNames()).toEqual(["Chequing"]);

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Show"), {
        target: { value: "liabilities" },
      });
    });
    expect(rowNames()).toEqual(["Visa Card"]);
  });

  it("hides closed accounts by default and shows them on request", async () => {
    mockGetAll.mockResolvedValue([
      acc(),
      acc({ id: "acc-2", name: "Old Savings", accountType: "SAVINGS", isClosed: true }),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(
      balancesFor([balance("acc-1", 5000), balance("acc-2", 800)]),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Total Assets")).toBeInTheDocument();
    });
    expect(screen.queryByText("Old Savings")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Status"), { target: { value: "all" } });
    });
    await waitFor(() => {
      expect(screen.getByText("Old Savings")).toBeInTheDocument();
    });
  });

  it("filters to favourites", async () => {
    mockGetAll.mockResolvedValue([
      acc({ isFavourite: true }),
      acc({ id: "acc-2", name: "Rainy Day", accountType: "SAVINGS" }),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(
      balancesFor([balance("acc-1", 5000), balance("acc-2", 800)]),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Rainy Day")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Favourites"), {
        target: { value: "favourites" },
      });
    });
    await waitFor(() => {
      expect(rowNames()).toEqual(["Chequing"]);
    });
  });

  it("filters by institution, naming the institution record", async () => {
    mockGetInstitutions.mockResolvedValue([{ id: "inst-1", name: "Big Bank" }]);
    mockGetAll.mockResolvedValue([
      acc({ institutionId: "inst-1" }),
      acc({ id: "acc-2", name: "Elsewhere", accountType: "SAVINGS" }),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(
      balancesFor([balance("acc-1", 5000), balance("acc-2", 800)]),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Elsewhere")).toBeInTheDocument();
    });
    expect(screen.getByTestId("option-inst-1")).toHaveTextContent("Big Bank");
    await act(async () => { fireEvent.click(screen.getByTestId("option-inst-1")); });
    await waitFor(() => {
      expect(rowNames()).toEqual(["Chequing"]);
    });
  });

  // The institutions request is allowed to fail without taking the report with
  // it, and a joint account's institution belongs to its owner -- so "no record
  // in hand" must not collapse into "this account has no institution".
  it("names an institution from the account's own text when no record resolves", async () => {
    mockGetInstitutions.mockResolvedValue([]);
    mockGetAll.mockResolvedValue([
      acc({ institutionId: "inst-1", institution: "Legacy Bank" }),
      acc({ id: "acc-2", name: "Wallet", accountType: "CASH" }),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(
      balancesFor([balance("acc-1", 5000), balance("acc-2", 40)]),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Wallet")).toBeInTheDocument();
    });
    expect(screen.getByTestId("option-inst-1")).toHaveTextContent("Legacy Bank");
    expect(screen.getByTestId("option-__none__")).toHaveTextContent("No institution");
  });

  it("says an institution is unnamed rather than calling the account unfiled", async () => {
    mockGetInstitutions.mockResolvedValue([]);
    mockGetAll.mockResolvedValue([
      acc({ institutionId: "inst-1" }),
      acc({ id: "acc-2", name: "Wallet", accountType: "CASH" }),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(
      balancesFor([balance("acc-1", 5000), balance("acc-2", 40)]),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Wallet")).toBeInTheDocument();
    });
    expect(screen.getByTestId("option-inst-1")).toHaveTextContent(
      "Institution not named",
    );
    // Still its own bucket: the account is filed somewhere, we just cannot
    // say where.
    expect(screen.getByTestId("option-__none__")).toHaveTextContent("No institution");
  });

  it("filters by account type", async () => {
    mockGetAll.mockResolvedValue([
      acc(),
      acc({ id: "acc-2", name: "Rainy Day", accountType: "SAVINGS" }),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(
      balancesFor([balance("acc-1", 5000), balance("acc-2", 800)]),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Rainy Day")).toBeInTheDocument();
    });
    await act(async () => { fireEvent.click(screen.getByTestId("option-SAVINGS")); });
    await waitFor(() => {
      expect(rowNames()).toEqual(["Rainy Day"]);
    });
  });

  it("says so when the filters leave nothing, rather than claiming no accounts", async () => {
    mockGetAll.mockResolvedValue([acc()]);
    mockGetBalancesAsOf.mockResolvedValue(balancesFor([balance("acc-1", 5000)]));
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByLabelText("Show")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Show"), {
        target: { value: "liabilities" },
      });
    });
    await waitFor(() => {
      expect(
        screen.getByText("No accounts match the current filters."),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("No accounts found.")).not.toBeInTheDocument();
    expect(rowNames()).toEqual([]);
  });

  it("groups by institution when asked", async () => {
    mockGetInstitutions.mockResolvedValue([{ id: "inst-1", name: "Big Bank" }]);
    mockGetAll.mockResolvedValue([
      acc({ institutionId: "inst-1" }),
      acc({ id: "acc-2", name: "Wallet", accountType: "CASH" }),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(
      balancesFor([balance("acc-1", 5000), balance("acc-2", 40)]),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Wallet")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Group by"), {
        target: { value: "institution" },
      });
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Big Bank" })).toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "No institution" })).toBeInTheDocument();
  });

  it("groups by assets and liabilities, assets first", async () => {
    mockGetAll.mockResolvedValue([
      acc({ id: "acc-2", name: "Visa", accountType: "CREDIT_CARD" }),
      acc(),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(
      balancesFor([balance("acc-2", -1000), balance("acc-1", 5000)]),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Visa")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Group by"), {
        target: { value: "assetLiability" },
      });
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Assets" })).toBeInTheDocument();
    });
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings).toEqual(["Assets", "Liabilities"]);
  });

  it("sorts by name within a group", async () => {
    mockGetAll.mockResolvedValue([
      acc({ id: "acc-1", name: "Zephyr" }),
      acc({ id: "acc-2", name: "Aardvark" }),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(
      balancesFor([balance("acc-1", 100), balance("acc-2", 900)]),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Zephyr")).toBeInTheDocument();
    });
    // Default sort is balance, highest first.
    expect(rowNames()).toEqual(["Aardvark", "Zephyr"]);

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "name" } });
    });
    await waitFor(() => {
      expect(rowNames()).toEqual(["Zephyr", "Aardvark"]);
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle(/Sorted/));
    });
    await waitFor(() => {
      expect(rowNames()).toEqual(["Aardvark", "Zephyr"]);
    });
  });

  it("reports no total for an account whose holdings could not all be priced", async () => {
    mockGetAll.mockResolvedValue([
      acc({
        id: "acc-brokerage",
        name: "Investments - Brokerage",
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_BROKERAGE",
        linkedAccountId: "acc-cash",
      }),
      acc({
        id: "acc-cash",
        name: "Investments - Cash",
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_CASH",
        linkedAccountId: "acc-brokerage",
      }),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(
      balancesFor([
        balance("acc-brokerage", 0, {
          marketValue: null,
          knownMarketValueSubtotal: 10000,
          unpricedHoldingsCount: 2,
          pricesComplete: false,
          valuationComplete: false,
        }),
        balance("acc-cash", 5000),
      ]),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Investments")).toBeInTheDocument();
    });
    const row = screen.getByText("Investments").closest("button")!;
    expect(within(row).getByText("Total unavailable")).toBeInTheDocument();
    expect(within(row).queryByText("$15000.00")).not.toBeInTheDocument();
    expect(within(row).queryByText("$5000.00")).not.toBeInTheDocument();
  });

  it("folds a linked investment pair into one row worth both halves", async () => {
    mockGetAll.mockResolvedValue([
      acc({
        id: "acc-brokerage",
        name: "Investments - Brokerage",
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_BROKERAGE",
        linkedAccountId: "acc-cash",
      }),
      acc({
        id: "acc-cash",
        name: "Investments - Cash",
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_CASH",
        linkedAccountId: "acc-brokerage",
      }),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(
      balancesFor([
        balance("acc-brokerage", 0, {
          marketValue: 10000,
          knownMarketValueSubtotal: 10000,
        }),
        balance("acc-cash", 5000),
      ]),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Investments")).toBeInTheDocument();
    });
    expect(screen.getAllByText("$15000.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Investments - Brokerage")).not.toBeInTheDocument();
    expect(screen.queryByText("Investments - Cash")).not.toBeInTheDocument();
    expect(
      screen.getByText("Investments $10000.00 · Cash $5000.00"),
    ).toBeInTheDocument();
  });

  // A brokerage the user closed years ago still held positions on a date before
  // it was emptied, and the report can be asked about that date.
  it("values a closed holdings account from the measured market value", async () => {
    mockGetAll.mockResolvedValue([
      acc({
        id: "acc-b",
        name: "Old Brokerage",
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_BROKERAGE",
        isClosed: true,
      }),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(
      balancesFor(
        [balance("acc-b", 0, { marketValue: 7000, knownMarketValueSubtotal: 7000 })],
        "2020-06-30",
      ),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Total Assets")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Status"), { target: { value: "closed" } });
    });
    await waitFor(() => {
      expect(screen.getByText("Old Brokerage")).toBeInTheDocument();
    });
    expect(screen.getAllByText("$7000.00").length).toBeGreaterThanOrEqual(1);
  });

  // A currency the payload has no rate for leaves the total, and the total says
  // so rather than quietly shrinking.
  it("marks the summary cards partial when an account cannot be converted", async () => {
    mockGetAll.mockResolvedValue([
      acc(),
      acc({ id: "acc-2", name: "Exotic", accountType: "SAVINGS", currencyCode: "XXX" }),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(
      balancesFor(
        [balance("acc-1", 5000), balance("acc-2", 900, { currencyCode: "XXX" })],
        TODAY,
        // XXX omitted: the server found no rate for it on this date.
        { CAD: 1 },
      ),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Total Assets")).toBeInTheDocument();
    });
    const assets = screen.getByTestId("summary-assets");
    expect(within(assets).getByText("$5000.00")).toBeInTheDocument();
    expect(within(assets).getByTestId("partial-total-marker")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("summary-networth")).getByTestId("partial-total-marker"),
    ).toBeInTheDocument();
    // Never the unconverted amount under the display currency's symbol.
    const row = screen.getByText("Exotic").closest("button")!;
    expect(within(row).queryByText(/≈/)).not.toBeInTheDocument();
  });

  // The rates travel with the figures because they belong to the same instant:
  // a 2019 balance converted at today's rate answers a different question, and
  // nothing on screen would say which of the two the number is.
  it("converts a foreign account at the rate the payload carries for that date", async () => {
    mockGetAll.mockResolvedValue([
      acc({ name: "US Savings", accountType: "SAVINGS", currencyCode: "USD" }),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(
      balancesFor(
        [balance("acc-1", 1000, { currencyCode: "USD" })],
        "2019-06-28",
        { CAD: 1, USD: 1.3 },
      ),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("US Savings")).toBeInTheDocument();
    });
    // The row keeps its own currency; the approximation and the totals are
    // converted at the payload's rate.
    const row = screen.getByText("US Savings").closest("button")!;
    expect(within(row).getByText("$1000.00")).toBeInTheDocument();
    expect(within(row).getByText(/≈/)).toHaveTextContent("$1300.00");
    expect(
      within(screen.getByTestId("summary-assets")).getByText("$1300.00"),
    ).toBeInTheDocument();
  });

  it("re-converts at the new date's rates when the date changes", async () => {
    mockGetAll.mockResolvedValue([
      acc({ name: "US Savings", accountType: "SAVINGS", currencyCode: "USD" }),
    ]);
    mockGetBalancesAsOf.mockImplementation(async (date: string) =>
      balancesFor([balance("acc-1", 1000, { currencyCode: "USD" })], date, {
        CAD: 1,
        USD: date === "2019-06-28" ? 1.3 : 1.4,
      }),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(
        within(screen.getByTestId("summary-assets")).getByText("$1400.00"),
      ).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByTestId("as-of-date"), {
        target: { value: "2019-06-28" },
      });
    });

    await waitFor(() => {
      expect(
        within(screen.getByTestId("summary-assets")).getByText("$1300.00"),
      ).toBeInTheDocument();
    });
  });

  it("switches to the chart view and back", async () => {
    mockGetAll.mockResolvedValue([
      acc(),
      acc({ id: "acc-2", name: "Rainy Day", accountType: "SAVINGS" }),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(
      balancesFor([balance("acc-1", 3000), balance("acc-2", 7000)]),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Total Assets")).toBeInTheDocument();
    });
    await act(async () => { fireEvent.click(chartViewButton()); });
    await waitFor(() => {
      expect(screen.getByTestId("pie-chart")).toBeInTheDocument();
    });
    await act(async () => { fireEvent.click(tableViewButton()); });
    await waitFor(() => {
      expect(screen.queryByTestId("pie-chart")).not.toBeInTheDocument();
    });
  });

  /**
   * The pie used to Math.abs() every balance, so a $30,000 mortgage became a
   * $30,000 asset-looking slice and the footer summed assets plus debt under
   * "Total" (issue #1243). The chart now keeps the sign beside the magnitude:
   * liability slices are identified by palette and by a signed amount, mixed
   * groups net the way the table does, and the footer of a mixed chart is the
   * signed net worth.
   */
  describe("pie chart with assets and liabilities", () => {
    function legendItems(): string[] {
      return screen
        .getAllByTestId("chart-legend-item")
        .map((item) => item.textContent ?? "");
    }

    it("shows liabilities signed and labels the footer Net Worth, not Total", async () => {
      mockGetAll.mockResolvedValue([
        acc({ currentBalance: 100000 }),
        acc({ id: "acc-2", name: "Home Loan", accountType: "MORTGAGE" }),
      ]);
      mockGetBalancesAsOf.mockResolvedValue(
        balancesFor([balance("acc-1", 100000), balance("acc-2", -30000)]),
      );
      render(<AccountBalancesReport />);
      await waitFor(() => {
        expect(screen.getByText("Total Assets")).toBeInTheDocument();
      });
      await act(async () => { fireEvent.click(chartViewButton()); });
      await waitFor(() => {
        expect(screen.getByTestId("pie-chart")).toBeInTheDocument();
      });

      // The liability slice keeps its sign; percentages are shares of the pie.
      const legend = legendItems();
      expect(legend.find((item) => item.includes("Chequing"))).toContain(
        "$100000.00 (76.9%)",
      );
      expect(legend.find((item) => item.includes("Mortgage"))).toContain(
        "$-30000.00 (23.1%)",
      );

      // The footer is the signed net worth, matching the summary card -- never
      // assets plus debt presented as "Total".
      expect(screen.getByTestId("chart-net-worth")).toHaveTextContent("$70000.00");
      expect(screen.queryByTestId("chart-total")).not.toBeInTheDocument();
      expect(screen.queryByText("$130000.00")).not.toBeInTheDocument();
    });

    it("colours liability slices from the liability palette", async () => {
      mockGetAll.mockResolvedValue([
        acc(),
        acc({ id: "acc-2", name: "Visa", accountType: "CREDIT_CARD" }),
      ]);
      mockGetBalancesAsOf.mockResolvedValue(
        balancesFor([balance("acc-1", 5000), balance("acc-2", -1200)]),
      );
      render(<AccountBalancesReport />);
      await waitFor(() => {
        expect(screen.getByText("Total Assets")).toBeInTheDocument();
      });
      await act(async () => { fireEvent.click(chartViewButton()); });
      await waitFor(() => {
        expect(screen.getByTestId("pie-chart")).toBeInTheDocument();
      });

      const items = screen.getAllByTestId("chart-legend-item");
      const dotColour = (name: string) =>
        items
          .find((item) => item.textContent?.includes(name))!
          .querySelector("div")!.style.backgroundColor;
      // The mocked palettes: assets #111111..., liabilities #999999...
      expect(dotColour("Chequing")).toBe("rgb(17, 17, 17)");
      expect(dotColour("Credit Card")).toBe("rgb(153, 153, 153)");
    });

    it("nets assets against liabilities within an institution group, as the table does", async () => {
      mockGetInstitutions.mockResolvedValue([{ id: "inst-1", name: "Big Bank" }]);
      mockGetAll.mockResolvedValue([
        acc({ institutionId: "inst-1" }),
        acc({
          id: "acc-2",
          name: "Home Loan",
          accountType: "MORTGAGE",
          institutionId: "inst-1",
        }),
        acc({ id: "acc-3", name: "Car Loan", accountType: "LOAN" }),
      ]);
      mockGetBalancesAsOf.mockResolvedValue(
        balancesFor([
          balance("acc-1", 100000),
          balance("acc-2", -30000),
          balance("acc-3", -50000),
        ]),
      );
      render(<AccountBalancesReport />);
      await waitFor(() => {
        expect(screen.getByText("Total Assets")).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Group by"), {
          target: { value: "institution" },
        });
      });
      await act(async () => { fireEvent.click(chartViewButton()); });
      await waitFor(() => {
        expect(screen.getByTestId("pie-chart")).toBeInTheDocument();
      });

      // Big Bank's slice is its net, never |100000| + |-30000| = 130000; the
      // no-institution group is a pure liability and stays signed. The pie's
      // denominator is 70000 + 50000.
      const legend = legendItems();
      expect(legend.find((item) => item.includes("Big Bank"))).toContain(
        "$70000.00 (58.3%)",
      );
      expect(legend.find((item) => item.includes("No institution"))).toContain(
        "$-50000.00 (41.7%)",
      );
      expect(screen.queryByText(/130000\.00/)).not.toBeInTheDocument();

      // Footer: 100000 - 30000 - 50000, not a sum of magnitudes.
      expect(screen.getByTestId("chart-net-worth")).toHaveTextContent("$20000.00");
    });

    it("keeps the Total footer for a chart holding only assets", async () => {
      mockGetAll.mockResolvedValue([
        acc({ currentBalance: 3000 }),
        acc({ id: "acc-2", name: "Rainy Day", accountType: "SAVINGS" }),
      ]);
      mockGetBalancesAsOf.mockResolvedValue(
        balancesFor([balance("acc-1", 3000), balance("acc-2", 7000)]),
      );
      render(<AccountBalancesReport />);
      await waitFor(() => {
        expect(screen.getByText("Total Assets")).toBeInTheDocument();
      });
      await act(async () => { fireEvent.click(chartViewButton()); });
      await waitFor(() => {
        expect(screen.getByTestId("pie-chart")).toBeInTheDocument();
      });
      expect(screen.getByTestId("chart-total")).toHaveTextContent("$10000.00");
      expect(screen.queryByTestId("chart-net-worth")).not.toBeInTheDocument();
    });

    it("draws each ungrouped account signed, liabilities on their own palette", async () => {
      mockGetAll.mockResolvedValue([
        acc(),
        acc({ id: "acc-2", name: "Visa", accountType: "CREDIT_CARD" }),
      ]);
      mockGetBalancesAsOf.mockResolvedValue(
        balancesFor([balance("acc-1", 5000), balance("acc-2", -1200)]),
      );
      render(<AccountBalancesReport />);
      await waitFor(() => {
        expect(screen.getByText("Total Assets")).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Group by"), {
          target: { value: "none" },
        });
      });
      await act(async () => { fireEvent.click(chartViewButton()); });
      await waitFor(() => {
        expect(screen.getByTestId("pie-chart")).toBeInTheDocument();
      });

      const items = screen.getAllByTestId("chart-legend-item");
      const visa = items.find((item) => item.textContent?.includes("Visa"))!;
      expect(visa).toHaveTextContent("$-1200.00");
      expect(visa.querySelector("div")!.style.backgroundColor).toBe(
        "rgb(153, 153, 153)",
      );
      expect(screen.getByTestId("chart-net-worth")).toHaveTextContent("$3800.00");
    });
  });

  it("shows the empty chart message when every balance is zero", async () => {
    mockGetAll.mockResolvedValue([acc({ name: "Empty Account" })]);
    mockGetBalancesAsOf.mockResolvedValue(balancesFor([balance("acc-1", 0)]));
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Total Assets")).toBeInTheDocument();
    });
    await act(async () => { fireEvent.click(chartViewButton()); });
    await waitFor(() => {
      expect(screen.getByText("No data to display.")).toBeInTheDocument();
    });
  });

  it("exports a PDF carrying the measured date", async () => {
    const { exportToPdf } = await import("@/lib/pdf-export");
    (exportToPdf as any).mockClear();
    mockGetAll.mockResolvedValue([acc()]);
    mockGetBalancesAsOf.mockResolvedValue(
      balancesFor([balance("acc-1", 5000)], "2024-03-31"),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByTestId("export-pdf")).toBeInTheDocument();
    });
    await act(async () => { fireEvent.click(screen.getByTestId("export-pdf")); });
    const call = (exportToPdf as any).mock.calls[0][0];
    expect(call.title).toBe("Account Balances");
    expect(call.subtitle).toBe("Balances as of date(2024-03-31)");
    expect(call.filename).toBe("account-balances-2024-03-31");
    expect(call.tableData.headers).toEqual(["Account", "Group", "Balance"]);
  });

  it("exports a CSV through the shared writer", async () => {
    mockGetAll.mockResolvedValue([acc()]);
    mockGetBalancesAsOf.mockResolvedValue(
      balancesFor([balance("acc-1", 5000)], "2024-03-31"),
    );
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByTestId("export-csv")).toBeInTheDocument();
    });
    await act(async () => { fireEvent.click(screen.getByTestId("export-csv")); });
    await waitFor(() => {
      expect(mockExportToCsv).toHaveBeenCalled();
    });
    const [filename, headers, rows] = mockExportToCsv.mock.calls[0];
    expect(filename).toBe("account-balances-2024-03-31");
    expect(headers).toEqual(["Account", "Group", "Balance"]);
    expect(rows).toEqual([["Chequing", "Chequing", "$5000.00"]]);
  });

  it("shows the report error state when a fetch fails", async () => {
    mockGetAll.mockRejectedValue(new Error("boom"));
    mockGetBalancesAsOf.mockResolvedValue(balancesFor([]));
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load report data/)).toBeInTheDocument();
    });
  });

  // "Other" used to borrow the Asset label, so the type picker offered two
  // options reading "Asset" and one group heading named the wrong kind.
  it("names an OTHER account by its own label, not the Asset one", async () => {
    mockGetAll.mockResolvedValue([acc({ name: "Odds and ends", accountType: "OTHER" })]);
    mockGetBalancesAsOf.mockResolvedValue(balancesFor([balance("acc-1", 42)]));
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Other" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("heading", { name: "Asset" })).not.toBeInTheDocument();
  });

  it("names a CRYPTO account by its own label", async () => {
    mockGetAll.mockResolvedValue([
      acc({ name: "Bitcoin Wallet", accountType: "CRYPTO", currencyCode: "BTC" }),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(balancesFor([balance("acc-1", 0.0125)]));
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Crypto Wallet" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("heading", { name: "CRYPTO" })).not.toBeInTheDocument();
  });

  it("falls back to the raw type for a type it has no label for", async () => {
    mockGetAll.mockResolvedValue([
      acc({ name: "Exotic Account", accountType: "EXOTIC_TYPE" }),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(balancesFor([balance("acc-1", 1000)]));
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "EXOTIC_TYPE" })).toBeInTheDocument();
    });
  });

  /**
   * A balance is a fact about something that exists. An asset bought in 2024
   * was not worth its purchase price in 2019, and an opening balance is the sum
   * an account *started* at rather than one it carried backwards forever -- so
   * the server marks those rows and the report leaves them out entirely, rather
   * than drawing them at zero.
   */
  describe("an account that did not exist on the chosen date", () => {
    it("leaves it out of the rows and out of the totals", async () => {
      mockGetAll.mockResolvedValue([
        acc(),
        acc({ id: "acc-2", name: "Lake House", accountType: "ASSET" }),
      ]);
      mockGetBalancesAsOf.mockResolvedValue(
        balancesFor([
          balance("acc-1", 5000),
          balance("acc-2", 0, { existsAsOf: false }),
        ]),
      );
      render(<AccountBalancesReport />);
      await waitFor(() => {
        expect(screen.getByText("Total Assets")).toBeInTheDocument();
      });
      expect(rowNames()).toEqual(["Chequing"]);
      expect(screen.queryByText("Lake House")).not.toBeInTheDocument();
      expect(
        within(screen.getByTestId("summary-assets")).getByText("$5000.00"),
      ).toBeInTheDocument();
    });

    // Not "worth nothing" -- a zero row is a measured zero, and this is not a
    // measurement. It must not appear even as an empty group.
    it("does not draw it as a zero row when its own type is the only group", async () => {
      mockGetAll.mockResolvedValue([
        acc({ id: "acc-2", name: "Lake House", accountType: "ASSET" }),
      ]);
      mockGetBalancesAsOf.mockResolvedValue(
        balancesFor([balance("acc-2", 450000, { existsAsOf: false })]),
      );
      render(<AccountBalancesReport />);
      await waitFor(() => {
        expect(screen.getByText("Total Assets")).toBeInTheDocument();
      });
      expect(rowNames()).toEqual([]);
      expect(screen.queryByText("$450000.00")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "Asset" }),
      ).not.toBeInTheDocument();
    });

    // The filters are not what emptied the report, and saying they were sends
    // the user to undo a filter they never set.
    it("says the accounts postdate the day, rather than blaming the filters", async () => {
      mockGetAll.mockResolvedValue([acc()]);
      mockGetBalancesAsOf.mockResolvedValue(
        balancesFor([balance("acc-1", 5000, { existsAsOf: false })]),
      );
      render(<AccountBalancesReport />);
      await waitFor(() => {
        expect(
          screen.getByText(`None of your accounts existed on date(${TODAY}).`),
        ).toBeInTheDocument();
      });
      expect(
        screen.queryByText("No accounts match the current filters."),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("No accounts found.")).not.toBeInTheDocument();
    });

    // An investment pair is one entity with two ledgers, and the cash sleeve
    // can be funded before the first trade settles. One live member is enough
    // to have something to report.
    it("keeps a pair whose brokerage half is not yet trading", async () => {
      mockGetAll.mockResolvedValue([
        acc({
          id: "acc-brokerage",
          name: "Investments - Brokerage",
          accountType: "INVESTMENT",
          accountSubType: "INVESTMENT_BROKERAGE",
          linkedAccountId: "acc-cash",
        }),
        acc({
          id: "acc-cash",
          name: "Investments - Cash",
          accountType: "INVESTMENT",
          accountSubType: "INVESTMENT_CASH",
          linkedAccountId: "acc-brokerage",
        }),
      ]);
      mockGetBalancesAsOf.mockResolvedValue(
        balancesFor([
          balance("acc-brokerage", 0, {
            marketValue: 0,
            existsAsOf: false,
          }),
          balance("acc-cash", 5000),
        ]),
      );
      render(<AccountBalancesReport />);
      await waitFor(() => {
        expect(screen.getByText("Investments")).toBeInTheDocument();
      });
      const row = screen.getByText("Investments").closest("button")!;
      expect(within(row).getByText("$5000.00")).toBeInTheDocument();
    });

    // Absent means "no information", not "did not exist": during a rolling
    // deploy a page can be handed a response from a backend predating the
    // field, and hiding every account would be the worse reading of it.
    it("shows an account whose row carries no existence field at all", async () => {
      mockGetAll.mockResolvedValue([acc()]);
      mockGetBalancesAsOf.mockResolvedValue(
        balancesFor([balance("acc-1", 5000, { existsAsOf: undefined })]),
      );
      render(<AccountBalancesReport />);
      await waitFor(() => {
        expect(screen.getByText("Total Assets")).toBeInTheDocument();
      });
      expect(rowNames()).toEqual(["Chequing"]);
    });
  });

  /**
   * The server falls back to the closest stored price or rate when the chosen
   * date has none (spec sections 4.2 and 7.2), so a figure can be a real
   * observation from a neighbouring day. The number alone cannot say that, and
   * every case here is about the report saying it -- or, where nothing was
   * approximated, not saying it.
   */
  describe("figures taken from the closest available date", () => {
    const usdAccount = acc({
      id: "acc-usd",
      name: "US Savings",
      accountType: "SAVINGS",
      currencyCode: "USD",
    });

    it("says nothing when every figure stood on the date itself", async () => {
      mockGetAll.mockResolvedValue([acc()]);
      mockGetBalancesAsOf.mockResolvedValue(balancesFor([balance("acc-1", 5000)]));
      render(<AccountBalancesReport />);
      await waitFor(() => {
        expect(screen.getByText("Total Assets")).toBeInTheDocument();
      });
      expect(screen.queryByTestId("approximation-notice")).toBeNull();
    });

    it("marks a holding priced from a neighbouring day, and still totals it", async () => {
      mockGetAll.mockResolvedValue([
        acc({ id: "acc-b", name: "Brokerage", accountType: "INVESTMENT" }),
      ]);
      mockGetBalancesAsOf.mockResolvedValue(
        balancesFor([
          balance("acc-b", 0, {
            marketValue: 220,
            knownMarketValueSubtotal: 220,
            approximatedPriceCount: 2,
            approximatedRatePairs: [],
          }),
        ]),
      );
      render(<AccountBalancesReport />);
      await waitFor(() => {
        expect(screen.getByTestId("approximation-notice")).toBeInTheDocument();
      });
      // The whole point of the fallback: the total is a number, not "Total
      // unavailable" -- and it is not a subtotal either, because nothing was
      // left out of it.
      expect(screen.getByTestId("summary-assets")).toHaveTextContent("$220.00");
      expect(screen.queryByTestId("partial-total")).toBeNull();
      expect(
        screen.getByLabelText(/2 holdings are priced from the closest available date/),
      ).toBeInTheDocument();
    });

    it("names the day an approximated exchange rate was struck on", async () => {
      mockGetAll.mockResolvedValue([usdAccount]);
      mockGetBalancesAsOf.mockResolvedValue({
        ...balancesFor([balance("acc-usd", 100, { currencyCode: "USD" })], TODAY, {
          CAD: 1,
          USD: 1.35,
        }),
        approximatedDisplayRates: { USD: "2024-05-01" },
      });
      render(<AccountBalancesReport />);
      await waitFor(() => {
        expect(screen.getByTestId("approximation-notice")).toBeInTheDocument();
      });
      expect(
        screen.getByLabelText(/USD on date\(2024-05-01\)/),
      ).toBeInTheDocument();
    });

    // A caveat belongs to the figures on screen. An approximated currency whose
    // only account the filters removed is not part of any of them.
    it("drops the caveat when the approximated account is filtered out", async () => {
      mockGetAll.mockResolvedValue([acc(), usdAccount]);
      mockGetBalancesAsOf.mockResolvedValue({
        ...balancesFor(
          [
            balance("acc-1", 5000),
            balance("acc-usd", 100, { currencyCode: "USD" }),
          ],
          TODAY,
          { CAD: 1, USD: 1.35 },
        ),
        approximatedDisplayRates: { USD: "2024-05-01" },
      });
      render(<AccountBalancesReport />);
      await waitFor(() => {
        expect(screen.getByTestId("approximation-notice")).toBeInTheDocument();
      });
      // Narrowing to chequing leaves only the CAD account on screen; the USD
      // one -- and its approximated rate -- is no longer part of any figure.
      fireEvent.click(screen.getByTestId("option-CHEQUING"));
      await waitFor(() => {
        expect(screen.queryByTestId("approximation-notice")).toBeNull();
      });
    });

    // A backend that predates these fields sends nothing, and absent means "no
    // information" -- not "approximated", and not a crash.
    it("renders a row whose approximation fields are absent", async () => {
      mockGetAll.mockResolvedValue([acc()]);
      mockGetBalancesAsOf.mockResolvedValue({
        asOfDate: TODAY,
        displayCurrency: "CAD",
        displayRates: { CAD: 1 },
        accounts: [balance("acc-1", 5000)],
      });
      render(<AccountBalancesReport />);
      await waitFor(() => {
        expect(screen.getByTestId("summary-assets")).toHaveTextContent("$5000.00");
      });
      expect(screen.queryByTestId("approximation-notice")).toBeNull();
    });
  });

  it("shows an account description under its name", async () => {
    mockGetAll.mockResolvedValue([
      acc({ name: "My Savings", accountType: "SAVINGS", description: "Emergency fund" }),
    ]);
    mockGetBalancesAsOf.mockResolvedValue(balancesFor([balance("acc-1", 8000)]));
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText("Emergency fund")).toBeInTheDocument();
    });
  });
});

/**
 * The view toggle, found by the titles `ChartViewToggle` gives it.
 *
 * The report used to hand-roll this pair of buttons under its own "Chart
 * view"/"Table view" copy, which is how they came to stand short of every
 * field beside them; the shared component names them from `common`.
 */
function chartViewButton(): HTMLElement {
  return screen.getByTitle("Pie Chart");
}

function tableViewButton(): HTMLElement {
  return screen.getByTitle("Table");
}

/** The account rows the table is rendering, in order. */
function rowButtons(): HTMLElement[] {
  return screen
    .getAllByRole("button")
    .filter((button) => button.className.includes("px-6 py-4"));
}

/** Account names in the order the table renders them. */
function rowNames(): string[] {
  return rowButtons().map(
    (button) => button.querySelector("div.font-medium")?.textContent?.trim() ?? "",
  );
}
