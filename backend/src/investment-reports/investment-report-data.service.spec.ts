import { InvestmentReportDataService } from "./investment-report-data.service";
import { InvestmentAction } from "../securities/entities/investment-transaction.entity";

function makeTx(overrides: Record<string, unknown>): any {
  return {
    accountId: "acc1",
    securityId: "sec1",
    action: InvestmentAction.BUY,
    transactionDate: "2024-01-10",
    quantity: 0,
    price: 0,
    totalAmount: 0,
    commission: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

function holding(over: Record<string, unknown> = {}): any {
  return { accountId: "acc1", securityId: "sec1", quantity: 10, averageCost: 100, ...over };
}

function priceRow(over: Record<string, unknown>): any {
  return {
    security_id: "sec1",
    price_date: "2024-06-10",
    open_price: "100",
    high_price: "100",
    low_price: "100",
    close_price: "100",
    volume: "1",
    ...over,
  };
}

describe("InvestmentReportDataService", () => {
  let service: InvestmentReportDataService;
  let txRepository: { find: jest.Mock; query: jest.Mock };
  let holdingsRepository: { find: jest.Mock };
  let securitiesRepository: { find: jest.Mock };
  let accountsRepository: { find: jest.Mock };
  let exchangeRateService: { getLatestRate: jest.Mock };

  beforeEach(() => {
    txRepository = { find: jest.fn(), query: jest.fn() };
    holdingsRepository = { find: jest.fn().mockResolvedValue([]) };
    securitiesRepository = { find: jest.fn() };
    accountsRepository = { find: jest.fn().mockResolvedValue([{ id: "acc1", name: "Brokerage" }]) };
    exchangeRateService = { getLatestRate: jest.fn().mockResolvedValue(null) };
    service = new InvestmentReportDataService(
      txRepository as any,
      holdingsRepository as any,
      securitiesRepository as any,
      accountsRepository as any,
      exchangeRateService as any,
    );
  });

  it("returns no rows when there are no accounts", async () => {
    const rows = await service.computeHoldings("u1", [], "2024-06-10", "USD");
    expect(rows).toEqual([]);
  });

  it("computes position, valuation, change and analytics for a holding", async () => {
    securitiesRepository.find.mockResolvedValue([
      { id: "sec1", symbol: "AAA", name: "Alpha Inc", securityType: "STOCK", currencyCode: "USD" },
    ]);
    holdingsRepository.find.mockResolvedValue([holding({ quantity: 10, averageCost: 100 })]);
    txRepository.find.mockResolvedValue([
      makeTx({ action: InvestmentAction.BUY, transactionDate: "2024-01-10", quantity: 10, price: 100, totalAmount: 1000, commission: 5 }),
      makeTx({ action: InvestmentAction.DIVIDEND, transactionDate: "2024-03-01", quantity: 0, totalAmount: 20 }),
    ]);
    txRepository.query.mockResolvedValue([
      priceRow({ price_date: "2024-01-10", open_price: "100", high_price: "101", low_price: "99", close_price: "100", volume: "500" }),
      priceRow({ price_date: "2024-06-03", open_price: "117", high_price: "119", low_price: "116", close_price: "118", volume: "800" }),
      priceRow({ price_date: "2024-06-07", open_price: "118", high_price: "120", low_price: "117", close_price: "119", volume: "900" }),
      priceRow({ price_date: "2024-06-10", open_price: "119", high_price: "121", low_price: "118", close_price: "120", volume: "1000" }),
    ]);

    const rows = await service.computeHoldings("u1", ["acc1"], "2024-06-10", "USD");

    expect(rows).toHaveLength(1);
    const v = rows[0].values;
    expect(v.symbol).toBe("AAA");
    expect(v.securityType).toBe("Stock"); // STOCK -> friendly label
    expect(v.quantity).toBe(10);
    expect(v.costBasis).toBe(1000);
    expect(v.averageCost).toBe(100);
    expect(v.lastPrice).toBe(120);
    expect(v.marketValue).toBe(1200);
    expect(v.income).toBe(20);
    expect(v.gain).toBe(220); // marketValue + income - costBasis
    expect(v.priceAppreciation).toBe(200);
    expect(v.gainPercent).toBe(22);
    expect(v.previousClose).toBe(119);
    expect(v.change).toBe(1);
    expect(v.todaysTotalChange).toBe(10);
    expect(v.open).toBe(119);
    expect(v.dayHigh).toBe(121);
    expect(v.dayLow).toBe(118);
    expect(v.volume).toBe(1000);
    expect(v.commissions).toBe(5);
    expect(v.purchases).toBe(1000);
    expect(v.sales).toBe(0);
    expect(v.realizedGains).toBe(0);
    expect(v.portfolioPercent).toBe(100);
    expect(v.exchangeRate).toBe(1);
    expect(v.lastUpdated).toBe("2024-06-10");
    expect(v.fiftyTwoWeekHigh).toBe(121);
    expect(v.fiftyTwoWeekLow).toBe(99);
    expect(v.lastTransactionDate).toBe("2024-03-01");
    expect(v.totalReturnAllDates).toBe(22);
    // 1-week return: begin value 10*118=1180 -> (1200-1180)/1180*100
    expect(v.totalReturn1Week).toBeCloseTo(1.6949, 3);
  });

  it("drops fully-sold positions (not in the holdings table)", async () => {
    securitiesRepository.find.mockResolvedValue([
      { id: "sec1", symbol: "AAA", name: "Alpha", securityType: "STOCK", currencyCode: "USD" },
    ]);
    holdingsRepository.find.mockResolvedValue([]); // no current holding -> sold
    txRepository.find.mockResolvedValue([
      makeTx({ action: InvestmentAction.BUY, transactionDate: "2024-01-10", quantity: 10, price: 100, totalAmount: 1000 }),
      makeTx({ action: InvestmentAction.SELL, transactionDate: "2024-02-10", quantity: 10, price: 130, totalAmount: 1300 }),
    ]);
    txRepository.query.mockResolvedValue([priceRow({ price_date: "2024-02-10", close_price: "130" })]);

    const rows = await service.computeHoldings("u1", ["acc1"], "2024-06-10", "USD");
    expect(rows).toHaveLength(0);
  });

  it("drops a position the holdings table reports as closed even if the replay is non-zero", async () => {
    // Simulates the bug: transaction replay leaves a stale non-zero quantity,
    // but the authoritative holdings table shows the position is closed/sold.
    securitiesRepository.find.mockResolvedValue([
      { id: "sec1", symbol: "AAA", name: "Alpha", securityType: "STOCK", currencyCode: "USD" },
    ]);
    holdingsRepository.find.mockResolvedValue([holding({ quantity: 0, averageCost: 0 })]);
    txRepository.find.mockResolvedValue([
      makeTx({ action: InvestmentAction.BUY, transactionDate: "2024-01-10", quantity: 10, price: 100, totalAmount: 1000 }),
    ]);
    txRepository.query.mockResolvedValue([priceRow({ close_price: "120" })]);

    const rows = await service.computeHoldings("u1", ["acc1"], "2024-06-10", "USD");
    expect(rows).toHaveLength(0);
  });

  it("defers to the holdings table quantity when it differs from the replay", async () => {
    securitiesRepository.find.mockResolvedValue([
      { id: "sec1", symbol: "AAA", name: "Alpha", securityType: "STOCK", currencyCode: "USD" },
    ]);
    // Replay would compute 10, but the authoritative holdings table says 8.
    holdingsRepository.find.mockResolvedValue([holding({ quantity: 8, averageCost: 100 })]);
    txRepository.find.mockResolvedValue([
      makeTx({ action: InvestmentAction.BUY, transactionDate: "2024-01-10", quantity: 10, price: 100, totalAmount: 1000 }),
    ]);
    txRepository.query.mockResolvedValue([priceRow({ close_price: "120" })]);

    const rows = await service.computeHoldings("u1", ["acc1"], "2024-06-10", "USD");
    expect(rows[0].values.quantity).toBe(8);
    expect(rows[0].values.marketValue).toBe(960); // 8 * 120
    expect(rows[0].values.costBasis).toBe(800); // 8 * 100
  });

  it("values a historical date from the replay even if currently sold", async () => {
    securitiesRepository.find.mockResolvedValue([
      { id: "sec1", symbol: "AAA", name: "Alpha", securityType: "STOCK", currencyCode: "USD" },
    ]);
    holdingsRepository.find.mockResolvedValue([]); // currently sold (no holding)
    txRepository.find.mockResolvedValue([
      makeTx({ action: InvestmentAction.BUY, transactionDate: "2024-01-10", quantity: 10, price: 100, totalAmount: 1000 }),
      // Sale happens AFTER the as-of date, so the position was held then.
      makeTx({ action: InvestmentAction.SELL, transactionDate: "2024-12-01", quantity: 10, price: 130, totalAmount: 1300 }),
    ]);
    txRepository.query.mockResolvedValue([priceRow({ price_date: "2024-05-01", close_price: "110" })]);

    const rows = await service.computeHoldings("u1", ["acc1"], "2024-06-10", "USD");
    expect(rows).toHaveLength(1);
    expect(rows[0].values.quantity).toBe(10);
  });

  it("seeds holdings without transactions (imported positions)", async () => {
    txRepository.find.mockResolvedValue([]);
    holdingsRepository.find.mockResolvedValue([
      { accountId: "acc1", securityId: "sec2", quantity: 5, averageCost: 50 },
    ]);
    securitiesRepository.find.mockResolvedValue([
      { id: "sec2", symbol: "BBB", name: "Beta", securityType: "ETF", currencyCode: "USD" },
    ]);
    txRepository.query.mockResolvedValue([
      { security_id: "sec2", price_date: "2024-06-10", open_price: "60", high_price: "61", low_price: "59", close_price: "60", volume: "100" },
    ]);

    const rows = await service.computeHoldings("u1", ["acc1"], "2024-06-10", "USD");
    expect(rows).toHaveLength(1);
    expect(rows[0].values.symbol).toBe("BBB");
    expect(rows[0].values.quantity).toBe(5);
    expect(rows[0].values.costBasis).toBe(250);
    expect(rows[0].values.marketValue).toBe(300);
  });

  it("converts market value to base currency for exchange rate and % of portfolio", async () => {
    securitiesRepository.find.mockResolvedValue([
      { id: "sec1", symbol: "AAA", name: "Alpha", securityType: "STOCK", currencyCode: "CAD" },
    ]);
    holdingsRepository.find.mockResolvedValue([holding({ quantity: 10, averageCost: 100 })]);
    txRepository.find.mockResolvedValue([
      makeTx({ action: InvestmentAction.BUY, transactionDate: "2024-01-10", quantity: 10, price: 100, totalAmount: 1000 }),
    ]);
    txRepository.query.mockResolvedValue([
      priceRow({ open_price: "120", high_price: "121", low_price: "119", close_price: "120", volume: "1000" }),
    ]);
    exchangeRateService.getLatestRate.mockResolvedValue(0.75); // CAD -> USD

    const rows = await service.computeHoldings("u1", ["acc1"], "2024-06-10", "USD");
    expect(rows[0].values.exchangeRate).toBe(0.75);
    expect(rows[0].exchangeRate).toBe(0.75); // native -> base rate on the row
    expect(rows[0].currencyCode).toBe("CAD");
    expect(rows[0].values.portfolioPercent).toBe(100);
    // Monetary values stay in the holding's native (CAD) currency.
    expect(rows[0].values.marketValue).toBe(1200);
  });

  it("handles reinvest/interest/capital-gain/split/add actions and annualized return", async () => {
    securitiesRepository.find.mockResolvedValue([
      { id: "sec1", symbol: "AAA", name: "Alpha", securityType: "STOCK", currencyCode: "USD" },
    ]);
    holdingsRepository.find.mockResolvedValue([holding({ quantity: 26, averageCost: 100 })]);
    txRepository.find.mockResolvedValue([
      makeTx({ action: InvestmentAction.BUY, transactionDate: "2021-01-04", quantity: 10, price: 100, totalAmount: 1000, commission: 2 }),
      makeTx({ action: InvestmentAction.REINVEST, transactionDate: "2021-06-01", quantity: 1, price: 110, totalAmount: 110 }),
      makeTx({ action: InvestmentAction.INTEREST, transactionDate: "2021-07-01", quantity: 0, totalAmount: 5 }),
      makeTx({ action: InvestmentAction.CAPITAL_GAIN, transactionDate: "2021-08-01", quantity: 0, totalAmount: 7 }),
      makeTx({ action: InvestmentAction.ADD_SHARES, transactionDate: "2021-09-01", quantity: 2 }),
      makeTx({ action: InvestmentAction.SPLIT, transactionDate: "2022-01-01", quantity: 2 }),
    ]);
    txRepository.query.mockResolvedValue([
      priceRow({ price_date: "2021-01-04", close_price: "100", volume: "10" }),
      priceRow({ price_date: "2024-06-10", open_price: "60", high_price: "61", low_price: "59", close_price: "60", volume: "10" }),
    ]);

    const rows = await service.computeHoldings("u1", ["acc1"], "2024-06-10", "USD");
    const v = rows[0].values;
    expect(v.quantity).toBe(26); // from the holdings table
    expect(v.reinvestments).toBe(110);
    expect(v.income).toBe(12); // interest 5 + capital gain 7
    // Held > 0.5 years -> annualized return is computed (not null)
    expect(v.totalAnnualizedReturn).not.toBeNull();
    expect(v.totalReturn3Year).not.toBeNull();
  });

  it("uses the reverse FX rate when only the inverse pair exists", async () => {
    securitiesRepository.find.mockResolvedValue([
      { id: "sec1", symbol: "AAA", name: "Alpha", securityType: "STOCK", currencyCode: "EUR" },
    ]);
    holdingsRepository.find.mockResolvedValue([holding({ quantity: 10, averageCost: 100 })]);
    txRepository.find.mockResolvedValue([
      makeTx({ action: InvestmentAction.BUY, transactionDate: "2024-01-10", quantity: 10, price: 100, totalAmount: 1000 }),
    ]);
    txRepository.query.mockResolvedValue([priceRow({ close_price: "120" })]);
    // EUR->USD missing, USD->EUR = 0.8 -> rate = 1/0.8 = 1.25
    exchangeRateService.getLatestRate.mockImplementation((from: string) =>
      from === "EUR" ? Promise.resolve(null) : Promise.resolve(0.8),
    );

    const rows = await service.computeHoldings("u1", ["acc1"], "2024-06-10", "USD");
    expect(rows[0].values.exchangeRate).toBe(1.25);
  });

  it("returns null valuation columns when no price is available", async () => {
    securitiesRepository.find.mockResolvedValue([
      { id: "sec1", symbol: "AAA", name: "Alpha", securityType: "STOCK", currencyCode: "USD" },
    ]);
    holdingsRepository.find.mockResolvedValue([holding({ quantity: 10, averageCost: 100 })]);
    txRepository.find.mockResolvedValue([
      makeTx({ action: InvestmentAction.BUY, transactionDate: "2024-01-10", quantity: 10, price: 100, totalAmount: 1000 }),
    ]);
    txRepository.query.mockResolvedValue([]); // no stored prices

    const rows = await service.computeHoldings("u1", ["acc1"], "2024-06-10", "USD");
    expect(rows).toHaveLength(1);
    expect(rows[0].values.lastPrice).toBeNull();
    expect(rows[0].values.marketValue).toBeNull();
    expect(rows[0].values.gain).toBeNull();
    expect(rows[0].values.portfolioPercent).toBeNull();
    expect(rows[0].values.totalReturn1Year).toBeNull();
  });

  it("handles transfers, share removals, and 52-week lows from null-OHLC rows", async () => {
    securitiesRepository.find.mockResolvedValue([
      { id: "sec1", symbol: "AAA", name: "Alpha", securityType: "STOCK", currencyCode: "USD" },
    ]);
    holdingsRepository.find.mockResolvedValue([holding({ quantity: 20, averageCost: 50 })]);
    txRepository.find.mockResolvedValue([
      makeTx({ action: InvestmentAction.TRANSFER_IN, transactionDate: "2022-01-10", quantity: 20, price: 50, totalAmount: 1000 }),
      makeTx({ action: InvestmentAction.REMOVE_SHARES, transactionDate: "2022-06-10", quantity: 5 }),
      makeTx({ action: InvestmentAction.TRANSFER_OUT, transactionDate: "2023-01-10", quantity: 5, price: 60, totalAmount: 300 }),
      makeTx({ action: InvestmentAction.BUY, transactionDate: "2023-06-10", quantity: 10, price: 70, totalAmount: 700 }),
    ]);
    txRepository.query.mockResolvedValue([
      priceRow({ price_date: "2022-01-10", open_price: null, high_price: null, low_price: null, close_price: "50", volume: null }),
      priceRow({ price_date: "2023-06-09", open_price: "65", high_price: "66", low_price: "64", close_price: "65", volume: "10" }),
      priceRow({ price_date: "2024-01-15", open_price: "80", high_price: null, low_price: null, close_price: "80", volume: "10" }),
      priceRow({ price_date: "2024-06-10", open_price: "88", high_price: "91", low_price: "87", close_price: "90", volume: "100" }),
    ]);

    const rows = await service.computeHoldings("u1", ["acc1"], "2024-06-10", "USD");
    const v = rows[0].values;
    expect(v.quantity).toBe(20);
    // A TRANSFER_OUT is not a sale, so it does not create realized gains.
    expect(v.realizedGains).toBe(0);
    expect(v.fiftyTwoWeekHigh).toBe(91);
    // The null-OHLC row falls back to its close (80) for the 52-week low.
    expect(v.fiftyTwoWeekLow).toBe(80);
  });

  it("skips a holding whose security record is missing", async () => {
    securitiesRepository.find.mockResolvedValue([]); // security not found
    holdingsRepository.find.mockResolvedValue([holding({ quantity: 10, averageCost: 100 })]);
    txRepository.find.mockResolvedValue([
      makeTx({ action: InvestmentAction.BUY, transactionDate: "2024-01-10", quantity: 10, price: 100, totalAmount: 1000 }),
    ]);
    txRepository.query.mockResolvedValue([]);
    const rows = await service.computeHoldings("u1", ["acc1"], "2024-06-10", "USD");
    expect(rows).toHaveLength(0);
  });

  it("maps raw security types to friendly labels", async () => {
    securitiesRepository.find.mockResolvedValue([
      { id: "sec1", symbol: "AAA", name: "A", securityType: "MUTUAL_FUND", currencyCode: "USD" },
      { id: "sec2", symbol: "BBB", name: "B", securityType: "CUSTOM_TYPE", currencyCode: "USD" },
    ]);
    holdingsRepository.find.mockResolvedValue([
      holding({ securityId: "sec1", quantity: 10, averageCost: 100 }),
      holding({ securityId: "sec2", quantity: 5, averageCost: 50 }),
    ]);
    txRepository.find.mockResolvedValue([
      makeTx({ securityId: "sec1", action: InvestmentAction.BUY, transactionDate: "2024-01-10", quantity: 10, price: 100, totalAmount: 1000 }),
      makeTx({ securityId: "sec2", action: InvestmentAction.BUY, transactionDate: "2024-01-10", quantity: 5, price: 50, totalAmount: 250 }),
    ]);
    txRepository.query.mockResolvedValue([
      priceRow({ security_id: "sec1", close_price: "100" }),
      priceRow({ security_id: "sec2", close_price: "50" }),
    ]);
    const rows = await service.computeHoldings("u1", ["acc1"], "2024-06-10", "USD");
    const types = rows.map((r) => r.values.securityType);
    expect(types).toContain("Mutual Fund"); // known mapping
    expect(types).toContain("Custom Type"); // unknown -> title-cased
  });

  describe("getLatestMarketDay", () => {
    it("returns today when there are no accounts", async () => {
      const today = new Date().toISOString().slice(0, 10);
      expect(await service.getLatestMarketDay("u1", [])).toBe(today);
    });

    it("returns the max stored price date", async () => {
      txRepository.query.mockResolvedValue([{ d: "2024-06-10" }]);
      expect(await service.getLatestMarketDay("u1", ["acc1"])).toBe("2024-06-10");
    });

    it("falls back to today when no prices exist", async () => {
      const today = new Date().toISOString().slice(0, 10);
      txRepository.query.mockResolvedValue([{ d: null }]);
      expect(await service.getLatestMarketDay("u1", ["acc1"])).toBe(today);
    });
  });
});
