import { InvestmentTransactionSummaryService } from "./investment-transaction-summary.service";
import { InvestmentAction } from "../securities/entities/investment-transaction.entity";
import { TransactionStatus } from "../transactions/entities/transaction-status.enum";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  createScopedDbMocks,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

interface RowInput {
  action?: InvestmentAction;
  status?: TransactionStatus;
  date?: string;
  amount?: string;
  currency?: string | null;
  symbol?: string | null;
  /** The row's own settlement rate, as the column stores it. */
  rate?: string | null;
  /** The currency that rate converts the amount into. */
  settlement?: string | null;
}

function row(over: RowInput = {}) {
  return {
    action: over.action ?? InvestmentAction.BUY,
    status: over.status ?? TransactionStatus.CLEARED,
    transaction_date: over.date ?? "2026-09-01",
    total_amount: over.amount ?? "1000.0000",
    currency_code: over.currency === undefined ? "EUR" : over.currency,
    symbol: over.symbol === undefined ? "AAA" : over.symbol,
    exchange_rate: over.rate === undefined ? null : over.rate,
    settlement_currency_code:
      over.settlement === undefined ? null : over.settlement,
  };
}

describe("InvestmentTransactionSummaryService", () => {
  let service: InvestmentTransactionSummaryService;
  let manager: ManagerMock;
  let preferences: { findOne: jest.Mock };
  let exchangeRateService: { getRateForDate: jest.Mock };

  /** Rows the statement returns; the linked-account lookup answers empty. */
  function returnRows(rows: unknown[]): void {
    manager.query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes("FROM accounts")
          ? []
          : (rows as Record<string, unknown>[]),
      ),
    );
  }

  beforeEach(() => {
    preferences = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "PLN" }),
    };
    exchangeRateService = { getRateForDate: jest.fn() };
    const { manager: managerMock, dataSource } = createScopedDbMocks([
      [UserPreference, preferences as never],
    ]);
    manager = managerMock;
    service = new InvestmentTransactionSummaryService(
      dataSource as never,
      exchangeRateService as never,
    );
  });

  it("converts each row at its own transaction date and totals in the reporting currency", async () => {
    // The reproduction from issue #1394: two 1,000 trades of equal NUMERIC
    // value in different currencies. Their arithmetic sum, 2,000, is never the
    // answer.
    returnRows([
      row({ currency: "EUR", date: "2026-09-01", symbol: "AAA" }),
      row({ currency: "USD", date: "2026-09-02", symbol: "BBB" }),
    ]);
    exchangeRateService.getRateForDate.mockImplementation(
      (from: string, _to: string, date: string) => {
        if (from === "EUR" && date === "2026-09-01")
          return Promise.resolve(4.339);
        if (from === "USD" && date === "2026-09-02")
          return Promise.resolve(3.7538);
        return Promise.resolve(null);
      },
    );

    const summary = await service.summarize("u1", {});

    expect(summary.currencyCode).toBe("PLN");
    expect(summary.total).toBeCloseTo(8092.8, 4);
    expect(summary.total).not.toBe(2000);
    expect(summary.fxComplete).toBe(true);
    expect(summary.missingPairs).toEqual([]);
    expect(summary.transactionCount).toBe(2);
    expect(summary.securitiesTraded).toBe(2);
    expect(summary.amountCurrencies).toEqual(["EUR", "USD"]);
  });

  it("withholds the total and names the pair when one rate is missing", async () => {
    returnRows([
      row({ currency: "EUR", date: "2026-09-01" }),
      row({ currency: "USD", date: "2026-09-02" }),
    ]);
    exchangeRateService.getRateForDate.mockImplementation((from: string) =>
      Promise.resolve(from === "EUR" ? 4.339 : null),
    );

    const summary = await service.summarize("u1", {});

    expect(summary.total).toBeNull();
    expect(summary.knownSubtotal).toBeCloseTo(4339, 4);
    expect(summary.missingPairs).toEqual(["USD->PLN"]);
    expect(summary.fxComplete).toBe(false);
    // The pairs alone cannot say how many rows fell out of the subtotal.
    expect(summary.excludedCount).toBe(1);
  });

  it("asks for no rate when the row is already in the reporting currency", async () => {
    returnRows([row({ currency: "PLN", amount: "250.0000" })]);

    const summary = await service.summarize("u1", {});

    expect(exchangeRateService.getRateForDate).not.toHaveBeenCalled();
    expect(summary.total).toBe(250);
    expect(summary.fxComplete).toBe(true);
  });

  it("asks for no rate for a zero amount, and still reports it as a known zero", async () => {
    returnRows([row({ currency: "JPY", amount: "0.0000" })]);

    const summary = await service.summarize("u1", {});

    expect(exchangeRateService.getRateForDate).not.toHaveBeenCalled();
    expect(summary.total).toBe(0);
    expect(summary.fxComplete).toBe(true);
  });

  /**
   * Invariant: a row that carries its own exchange rate is converted at that
   * rate on every surface (INV-FX-002).
   * Canonical adversarial input: the sale the realized-gains report shows as
   * 3,060.92 PLN -- 820.91 USD settled at the broker's 3.7287 -- on a day the
   * market rate was 3.7134.
   * Minimal mutation: drop the stored-rate branch and ask `getRateForDate`.
   * Test that fails under it: this one -- the KPI reads 3,048.37 while the
   * realized-gains report reads 3,060.92 for the same sale.
   */
  it("converts a row at its own settlement rate, not at the market rate", async () => {
    returnRows([
      row({
        action: InvestmentAction.SELL,
        currency: "USD",
        amount: "820.9100",
        rate: "3.7287000000",
        settlement: "PLN",
      }),
    ]);
    exchangeRateService.getRateForDate.mockResolvedValue(3.7134);

    const summary = await service.summarize("u1", {});

    expect(exchangeRateService.getRateForDate).not.toHaveBeenCalled();
    // 820.91 x 3.7287, which is what the realized-gains report reports for
    // the same row; the market rate would have made it 3,048.37.
    expect(summary.total).toBeCloseTo(3060.9271, 4);
    expect(summary.transactionRateCount).toBe(1);
    expect(summary.marketRateCount).toBe(0);
    expect(summary.onwardMarketCount).toBe(0);
  });

  it("falls back to the market rate for a row with no rate of its own, and counts it", async () => {
    returnRows([
      row({ currency: "USD", amount: "100.0000", rate: null }),
      row({
        currency: "USD",
        amount: "100.0000",
        rate: "3.7287000000",
        settlement: "PLN",
      }),
    ]);
    exchangeRateService.getRateForDate.mockResolvedValue(3.7134);

    const summary = await service.summarize("u1", {});

    expect(summary.knownSubtotal).toBeCloseTo(371.34 + 372.87, 2);
    expect(summary.transactionRateCount).toBe(1);
    expect(summary.marketRateCount).toBe(1);
  });

  it("carries a row settled in a third currency onward at the market rate", async () => {
    returnRows([
      row({
        currency: "USD",
        amount: "100.0000",
        rate: "0.9000000000",
        settlement: "EUR",
      }),
    ]);
    exchangeRateService.getRateForDate.mockImplementation((from: string) =>
      Promise.resolve(from === "EUR" ? 4.3 : null),
    );

    const summary = await service.summarize("u1", {});

    expect(summary.total).toBeCloseTo(387, 4);
    expect(summary.transactionRateCount).toBe(1);
    expect(summary.onwardMarketCount).toBe(1);
    expect(summary.marketRateCount).toBe(0);
  });

  it("ignores a stored 1 across two different currencies and uses the market rate", async () => {
    // The column's default, not a rate anybody struck.
    returnRows([
      row({
        currency: "USD",
        amount: "100.0000",
        rate: "1.0000000000",
        settlement: "PLN",
      }),
    ]);
    exchangeRateService.getRateForDate.mockResolvedValue(3.7134);

    const summary = await service.summarize("u1", {});

    expect(summary.total).toBeCloseTo(371.34, 4);
    expect(summary.marketRateCount).toBe(1);
    expect(summary.transactionRateCount).toBe(0);
  });

  it("reports an empty filter as a known zero, not as unknown", async () => {
    returnRows([]);
    const summary = await service.summarize("u1", {});
    expect(summary.total).toBe(0);
    expect(summary.transactionCount).toBe(0);
    expect(summary.byAction).toEqual([]);
  });

  /**
   * A cash INTEREST posting names no security, and its amount is not unknown:
   * the write path denominated it in the investment account's currency
   * (`resolveSettlementCurrencyPair`). Reading it as unknown withheld the whole
   * "Total volume" card over one such row (issue #1394).
   */
  it("counts a security-less row in its account's currency", async () => {
    returnRows([
      row({
        action: InvestmentAction.INTEREST,
        currency: "USD",
        symbol: null,
        amount: "100.0000",
      }),
    ]);
    exchangeRateService.getRateForDate.mockResolvedValue(3.7538);

    const summary = await service.summarize("u1", {});

    expect(summary.total).toBeCloseTo(375.38, 4);
    expect(summary.hasUnknownCurrency).toBe(false);
    expect(summary.unknownCount).toBe(0);
    expect(summary.excludedCount).toBe(0);
    expect(summary.amountCurrencies).toEqual(["USD"]);
    expect(summary.securitiesTraded).toBe(0);
  });

  it("reads a row's currency from its account when it names no security", async () => {
    // The statement is where that fallback lives, so this is what proves it:
    // the fold above cannot see which column the code came from.
    returnRows([]);

    await service.summarize("u1", {});

    const sql = manager.query.mock.calls
      .map(([text]) => String(text))
      .find((text) => text.includes("FROM investment_transactions"));
    expect(sql).toContain("COALESCE(s.currency_code, a.currency_code)");
    expect(sql).toContain("LEFT JOIN accounts a ON a.id = it.account_id");
  });

  it("withholds without naming a pair when neither a security nor the account has a currency", async () => {
    returnRows([row({ currency: null, symbol: null, amount: "40.0000" })]);

    const summary = await service.summarize("u1", {});

    expect(summary.total).toBeNull();
    expect(summary.missingPairs).toEqual([]);
    expect(summary.unknownCount).toBe(1);
    expect(summary.excludedCount).toBe(1);
    expect(summary.hasUnknownCurrency).toBe(true);
    expect(summary.knownSubtotal).toBe(0);
  });

  it("counts a VOID row with the table and leaves it out of the volume", async () => {
    // The card sits over the register's own rows, which list VOID trades
    // struck through: counting fewer rows than the table lists is the defect.
    // The voided 1,000 is a known zero, so the total stays complete.
    returnRows([
      row({
        status: TransactionStatus.CLEARED,
        currency: "PLN",
        amount: "1000.0000",
        symbol: "AAA",
      }),
      row({
        status: TransactionStatus.VOID,
        currency: "PLN",
        amount: "1000.0000",
        symbol: "BBB",
      }),
    ]);

    const summary = await service.summarize("u1", {});

    expect(summary.transactionCount).toBe(2);
    expect(summary.securitiesTraded).toBe(2);
    expect(summary.total).toBe(1000);
    expect(summary.fxComplete).toBe(true);
    expect(summary.excludedCount).toBe(0);
    expect(summary.byAction).toEqual([
      expect.objectContaining({
        action: InvestmentAction.BUY,
        count: 2,
        total: 1000,
      }),
    ]);
  });

  it("asks for no rate for a VOID row in a foreign currency", async () => {
    returnRows([row({ status: TransactionStatus.VOID, currency: "EUR" })]);

    const summary = await service.summarize("u1", {});

    expect(exchangeRateService.getRateForDate).not.toHaveBeenCalled();
    expect(summary.total).toBe(0);
    expect(summary.transactionCount).toBe(1);
  });

  it("reads stored rates only, never fetching a provider window per row-day", async () => {
    // A report GET converting hundreds of row-days must stay inside the
    // database: nothing caches a miss, so one absent pair-day would fan out
    // to the provider on every request.
    returnRows([row({ currency: "EUR", date: "2026-09-01" })]);
    exchangeRateService.getRateForDate.mockResolvedValue(4);

    await service.summarize("u1", {});

    expect(exchangeRateService.getRateForDate).toHaveBeenCalledWith(
      "EUR",
      "PLN",
      "2026-09-01",
      { fetchMissing: false },
    );
  });

  it("withholds the action's total too when one of its rows has no currency", async () => {
    returnRows([
      row({ currency: "PLN", amount: "100.0000" }),
      row({ currency: null, symbol: null, amount: "40.0000" }),
    ]);

    const summary = await service.summarize("u1", {});

    expect(summary.total).toBeNull();
    expect(summary.knownSubtotal).toBe(100);
    expect(summary.byAction).toEqual([
      expect.objectContaining({
        action: InvestmentAction.BUY,
        count: 2,
        total: null,
        knownSubtotal: 100,
        unknownCount: 1,
        excludedCount: 1,
        fxComplete: false,
      }),
    ]);
  });

  it("sums volume as magnitude and splits it by action", async () => {
    returnRows([
      row({
        action: InvestmentAction.BUY,
        currency: "PLN",
        amount: "100.0000",
      }),
      row({
        action: InvestmentAction.SELL,
        currency: "PLN",
        amount: "-300.0000",
      }),
    ]);

    const summary = await service.summarize("u1", {});

    expect(summary.total).toBe(400);
    expect(summary.byAction).toEqual([
      expect.objectContaining({
        action: InvestmentAction.SELL,
        count: 1,
        total: 300,
      }),
      expect.objectContaining({
        action: InvestmentAction.BUY,
        count: 1,
        total: 100,
      }),
    ]);
  });

  it("marks only the affected action incomplete", async () => {
    returnRows([
      row({
        action: InvestmentAction.BUY,
        currency: "PLN",
        amount: "100.0000",
      }),
      row({
        action: InvestmentAction.SELL,
        currency: "USD",
        amount: "50.0000",
      }),
    ]);
    exchangeRateService.getRateForDate.mockResolvedValue(null);

    const summary = await service.summarize("u1", {});

    const buy = summary.byAction.find((a) => a.action === InvestmentAction.BUY);
    const sell = summary.byAction.find(
      (a) => a.action === InvestmentAction.SELL,
    );
    expect(buy?.total).toBe(100);
    expect(buy?.fxComplete).toBe(true);
    expect(sell?.total).toBeNull();
    expect(sell?.missingPairs).toEqual(["USD->PLN"]);
  });

  it("asks for one rate per currency-day however many rows share it", async () => {
    returnRows([
      row({ currency: "EUR", date: "2026-09-01" }),
      row({ currency: "EUR", date: "2026-09-01" }),
      row({ currency: "EUR", date: "2026-09-02" }),
    ]);
    exchangeRateService.getRateForDate.mockResolvedValue(4);

    await service.summarize("u1", {});

    expect(exchangeRateService.getRateForDate).toHaveBeenCalledTimes(2);
  });

  it("treats a non-positive rate as no rate rather than as a conversion", async () => {
    returnRows([row({ currency: "EUR" })]);
    exchangeRateService.getRateForDate.mockResolvedValue(0);

    const summary = await service.summarize("u1", {});

    expect(summary.total).toBeNull();
    expect(summary.missingPairs).toEqual(["EUR->PLN"]);
  });

  it("filters by account, date and action, widening to linked cash accounts", async () => {
    manager.query.mockImplementation((sql: string) =>
      Promise.resolve(sql.includes("FROM accounts") ? [{ id: "cash-1" }] : []),
    );

    await service.summarize("u1", {
      accountIds: ["acc-1"],
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      actions: [InvestmentAction.BUY],
    });

    const rowsCall = manager.query.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("investment_transactions"),
    );
    expect(rowsCall?.[0]).toContain("it.account_id = ANY($5)");
    expect(rowsCall?.[0]).toContain("it.transaction_date >= $6");
    expect(rowsCall?.[0]).toContain("it.transaction_date <= $7");
    expect(rowsCall?.[0]).toContain("it.action = ANY($8)");
    // Only a brokerage settles in its linked cash account.
    expect(rowsCall?.[0]).toContain("AND a.account_sub_type = $4");
    expect(rowsCall?.[1]).toEqual([
      "u1",
      InvestmentAction.INTEREST,
      InvestmentAction.REDEEM,
      "INVESTMENT_BROKERAGE",
      ["acc-1", "cash-1"],
      "2026-01-01",
      "2026-12-31",
      [InvestmentAction.BUY],
    ]);
  });

  it("falls back to the one reporting-currency constant when no preference is stored", async () => {
    preferences.findOne.mockResolvedValue(null);
    returnRows([]);
    const summary = await service.summarize("u1", {});
    expect(summary.currencyCode).toBe("USD");
  });
});
