import { InvestmentReportDataService } from "./investment-report-data.service";
import {
  InvestmentAction,
  InvestmentTransaction,
} from "../securities/entities/investment-transaction.entity";
import { Holding } from "../securities/entities/holding.entity";
import { Security } from "../securities/entities/security.entity";
import { Account } from "../accounts/entities/account.entity";
import { requestContextStorage } from "../common/request-context";
import { todayInTimezone, todayYMD } from "../common/date-utils";
import {
  createScopedDbMocks,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

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
  return {
    accountId: "acc1",
    securityId: "sec1",
    quantity: 10,
    averageCost: 100,
    ...over,
  };
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
  let txRepository: { find: jest.Mock };
  let holdingsRepository: { find: jest.Mock };
  let securitiesRepository: { find: jest.Mock };
  let accountsRepository: { find: jest.Mock };
  let exchangeRateService: { getRateForDate: jest.Mock };
  let manager: ManagerMock;

  beforeEach(() => {
    txRepository = { find: jest.fn() };
    holdingsRepository = { find: jest.fn().mockResolvedValue([]) };
    securitiesRepository = { find: jest.fn() };
    accountsRepository = {
      find: jest.fn().mockResolvedValue([{ id: "acc1", name: "Brokerage" }]),
    };
    exchangeRateService = {
      getRateForDate: jest.fn().mockResolvedValue(null),
    };
    const { manager: managerMock, dataSource } = createScopedDbMocks([
      [InvestmentTransaction, txRepository as never],
      [Holding, holdingsRepository as never],
      [Security, securitiesRepository as never],
      [Account, accountsRepository as never],
    ]);
    manager = managerMock;
    service = new InvestmentReportDataService(
      dataSource as any,
      exchangeRateService as any,
    );
  });

  it("returns no rows when there are no accounts", async () => {
    const { rows } = await service.computeHoldings(
      "u1",
      [],
      "2024-06-10",
      "USD",
    );
    expect(rows).toEqual([]);
  });

  it("computes position, valuation, change and analytics for a holding", async () => {
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec1",
        symbol: "AAA",
        name: "Alpha Inc",
        securityType: "STOCK",
        currencyCode: "USD",
      },
    ]);
    holdingsRepository.find.mockResolvedValue([
      holding({ quantity: 10, averageCost: 100 }),
    ]);
    txRepository.find.mockResolvedValue([
      makeTx({
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
        commission: 5,
      }),
      makeTx({
        action: InvestmentAction.DIVIDEND,
        transactionDate: "2024-03-01",
        quantity: 0,
        totalAmount: 20,
      }),
    ]);
    manager.query.mockResolvedValue([
      priceRow({
        price_date: "2024-01-10",
        open_price: "100",
        high_price: "101",
        low_price: "99",
        close_price: "100",
        volume: "500",
      }),
      priceRow({
        price_date: "2024-06-03",
        open_price: "117",
        high_price: "119",
        low_price: "116",
        close_price: "118",
        volume: "800",
      }),
      priceRow({
        price_date: "2024-06-07",
        open_price: "118",
        high_price: "120",
        low_price: "117",
        close_price: "119",
        volume: "900",
      }),
      priceRow({
        price_date: "2024-06-10",
        open_price: "119",
        high_price: "121",
        low_price: "118",
        close_price: "120",
        volume: "1000",
      }),
    ]);

    const { rows } = await service.computeHoldings(
      "u1",
      ["acc1"],
      "2024-06-10",
      "USD",
    );

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

  describe("daily change needs adjacent, current closes", () => {
    const changeFor = async (closes: Record<string, string>) => {
      securitiesRepository.find.mockResolvedValue([
        {
          id: "sec1",
          symbol: "AAA",
          name: "Alpha",
          securityType: "STOCK",
          currencyCode: "USD",
        },
      ]);
      holdingsRepository.find.mockResolvedValue([holding({ quantity: 10 })]);
      txRepository.find.mockResolvedValue([
        makeTx({
          transactionDate: "2024-01-10",
          quantity: 10,
          price: 100,
          totalAmount: 1000,
        }),
      ]);
      manager.query.mockResolvedValue(
        Object.entries(closes).map(([price_date, close_price]) =>
          priceRow({ price_date, close_price }),
        ),
      );
      const { rows } = await service.computeHoldings(
        "u1",
        ["acc1"],
        "2024-06-10",
        "USD",
      );
      return rows[0].values;
    };

    it("is null when the two closes are weeks apart", async () => {
      const v = await changeFor({ "2024-05-01": "100", "2024-06-10": "120" });
      expect(v.change).toBeNull();
      expect(v.changePercent).toBeNull();
      expect(v.todaysTotalChange).toBeNull();
    });

    it("is null when the newer close is stale against the as-of date", async () => {
      const v = await changeFor({ "2024-05-30": "100", "2024-05-31": "120" });
      expect(v.change).toBeNull();
      expect(v.todaysTotalChange).toBeNull();
    });

    it("keeps the figures for adjacent, current closes", async () => {
      const v = await changeFor({ "2024-06-07": "119", "2024-06-10": "120" });
      expect(v.change).toBe(1);
      expect(v.changePercent).toBe(0.8403);
      expect(v.todaysTotalChange).toBe(10);
    });
  });

  describe("period starts at month ends", () => {
    const returnFor = async (
      asOf: string,
      closes: Record<string, string>,
      key: "totalReturn3Month" | "totalReturn1Year",
    ) => {
      securitiesRepository.find.mockResolvedValue([
        {
          id: "sec1",
          symbol: "AAA",
          name: "Alpha",
          securityType: "STOCK",
          currencyCode: "USD",
        },
      ]);
      holdingsRepository.find.mockResolvedValue([holding({ quantity: 10 })]);
      txRepository.find.mockResolvedValue([
        makeTx({
          transactionDate: "2020-01-10",
          quantity: 10,
          price: 100,
          totalAmount: 1000,
        }),
      ]);
      manager.query.mockResolvedValue(
        Object.entries(closes).map(([price_date, close_price]) =>
          priceRow({ price_date, close_price }),
        ),
      );
      const { rows } = await service.computeHoldings(
        "u1",
        ["acc1"],
        asOf,
        "USD",
      );
      return rows[0].values[key];
    };

    it("clamps 3 months before May 31 to Feb 28, not Mar 3", async () => {
      expect(
        await returnFor(
          "2026-05-31",
          { "2026-02-28": "100", "2026-03-03": "200", "2026-05-31": "220" },
          "totalReturn3Month",
        ),
      ).toBe(120);
    });

    it("clamps 1 year before Feb 29 to Feb 28, not Mar 1", async () => {
      expect(
        await returnFor(
          "2024-02-29",
          { "2023-02-28": "100", "2023-03-01": "200", "2024-02-29": "110" },
          "totalReturn1Year",
        ),
      ).toBe(10);
    });
  });

  it("drops fully-sold positions (not in the holdings table)", async () => {
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec1",
        symbol: "AAA",
        name: "Alpha",
        securityType: "STOCK",
        currencyCode: "USD",
      },
    ]);
    holdingsRepository.find.mockResolvedValue([]); // no current holding -> sold
    txRepository.find.mockResolvedValue([
      makeTx({
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
      makeTx({
        action: InvestmentAction.SELL,
        transactionDate: "2024-02-10",
        quantity: 10,
        price: 130,
        totalAmount: 1300,
      }),
    ]);
    manager.query.mockResolvedValue([
      priceRow({ price_date: "2024-02-10", close_price: "130" }),
    ]);

    const { rows } = await service.computeHoldings(
      "u1",
      ["acc1"],
      "2024-06-10",
      "USD",
    );
    expect(rows).toHaveLength(0);
  });

  it("drops a position the holdings table reports as closed even if the replay is non-zero", async () => {
    // Simulates the bug: transaction replay leaves a stale non-zero quantity,
    // but the authoritative holdings table shows the position is closed/sold.
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec1",
        symbol: "AAA",
        name: "Alpha",
        securityType: "STOCK",
        currencyCode: "USD",
      },
    ]);
    holdingsRepository.find.mockResolvedValue([
      holding({ quantity: 0, averageCost: 0 }),
    ]);
    txRepository.find.mockResolvedValue([
      makeTx({
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
    ]);
    manager.query.mockResolvedValue([priceRow({ close_price: "120" })]);

    const { rows } = await service.computeHoldings(
      "u1",
      ["acc1"],
      "2024-06-10",
      "USD",
    );
    expect(rows).toHaveLength(0);
  });

  it("defers to the holdings table quantity when it differs from the replay", async () => {
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec1",
        symbol: "AAA",
        name: "Alpha",
        securityType: "STOCK",
        currencyCode: "USD",
      },
    ]);
    // Replay would compute 10, but the authoritative holdings table says 8.
    holdingsRepository.find.mockResolvedValue([
      holding({ quantity: 8, averageCost: 100 }),
    ]);
    txRepository.find.mockResolvedValue([
      makeTx({
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
    ]);
    manager.query.mockResolvedValue([priceRow({ close_price: "120" })]);

    const { rows } = await service.computeHoldings(
      "u1",
      ["acc1"],
      "2024-06-10",
      "USD",
    );
    expect(rows[0].values.quantity).toBe(8);
    expect(rows[0].values.marketValue).toBe(960); // 8 * 120
    expect(rows[0].values.costBasis).toBe(800); // 8 * 100
  });

  it("values a historical date from the replay even if currently sold", async () => {
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec1",
        symbol: "AAA",
        name: "Alpha",
        securityType: "STOCK",
        currencyCode: "USD",
      },
    ]);
    holdingsRepository.find.mockResolvedValue([]); // currently sold (no holding)
    txRepository.find.mockResolvedValue([
      makeTx({
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
      // Sale happens AFTER the as-of date, so the position was held then.
      makeTx({
        action: InvestmentAction.SELL,
        transactionDate: "2024-12-01",
        quantity: 10,
        price: 130,
        totalAmount: 1300,
      }),
    ]);
    manager.query.mockResolvedValue([
      priceRow({ price_date: "2024-05-01", close_price: "110" }),
    ]);

    const { rows } = await service.computeHoldings(
      "u1",
      ["acc1"],
      "2024-06-10",
      "USD",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].values.quantity).toBe(10);
  });

  it("merges identical securities across accounts when requested", async () => {
    accountsRepository.find.mockResolvedValue([
      { id: "acc1", name: "RRSP" },
      { id: "acc2", name: "TFSA" },
    ]);
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec1",
        symbol: "AAA",
        name: "Alpha",
        securityType: "STOCK",
        currencyCode: "USD",
      },
    ]);
    holdingsRepository.find.mockResolvedValue([
      { accountId: "acc1", securityId: "sec1", quantity: 10, averageCost: 100 },
      { accountId: "acc2", securityId: "sec1", quantity: 5, averageCost: 120 },
    ]);
    txRepository.find.mockResolvedValue([
      makeTx({
        accountId: "acc1",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
      makeTx({
        accountId: "acc2",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-11",
        quantity: 5,
        price: 120,
        totalAmount: 600,
      }),
    ]);
    manager.query.mockResolvedValue([priceRow({ close_price: "130" })]);

    const { rows } = await service.computeHoldings(
      "u1",
      ["acc1", "acc2"],
      "2024-06-10",
      "USD",
      true,
    );
    expect(rows).toHaveLength(1); // combined into a single position
    expect(rows[0].values.quantity).toBe(15); // 10 + 5
    expect(rows[0].values.costBasis).toBe(1600); // 10*100 + 5*120
    expect(rows[0].values.marketValue).toBe(1950); // 15 * 130
    expect(rows[0].values.account).toBe("Multiple accounts");
  });

  it("keeps securities separate across accounts by default (account name per row)", async () => {
    accountsRepository.find.mockResolvedValue([
      { id: "acc1", name: "RRSP" },
      { id: "acc2", name: "TFSA" },
    ]);
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec1",
        symbol: "AAA",
        name: "Alpha",
        securityType: "STOCK",
        currencyCode: "USD",
      },
    ]);
    holdingsRepository.find.mockResolvedValue([
      { accountId: "acc1", securityId: "sec1", quantity: 10, averageCost: 100 },
      { accountId: "acc2", securityId: "sec1", quantity: 5, averageCost: 120 },
    ]);
    txRepository.find.mockResolvedValue([
      makeTx({
        accountId: "acc1",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
      makeTx({
        accountId: "acc2",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-11",
        quantity: 5,
        price: 120,
        totalAmount: 600,
      }),
    ]);
    manager.query.mockResolvedValue([priceRow({ close_price: "130" })]);

    const { rows } = await service.computeHoldings(
      "u1",
      ["acc1", "acc2"],
      "2024-06-10",
      "USD",
      false,
    );
    expect(rows).toHaveLength(2);
    const accounts = rows.map((r) => r.values.account).sort();
    expect(accounts).toEqual(["RRSP", "TFSA"]);
  });

  it("seeds holdings without transactions (imported positions)", async () => {
    txRepository.find.mockResolvedValue([]);
    holdingsRepository.find.mockResolvedValue([
      { accountId: "acc1", securityId: "sec2", quantity: 5, averageCost: 50 },
    ]);
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec2",
        symbol: "BBB",
        name: "Beta",
        securityType: "ETF",
        currencyCode: "USD",
      },
    ]);
    manager.query.mockResolvedValue([
      {
        security_id: "sec2",
        price_date: "2024-06-10",
        open_price: "60",
        high_price: "61",
        low_price: "59",
        close_price: "60",
        volume: "100",
      },
    ]);

    const { rows } = await service.computeHoldings(
      "u1",
      ["acc1"],
      "2024-06-10",
      "USD",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].values.symbol).toBe("BBB");
    expect(rows[0].values.quantity).toBe(5);
    expect(rows[0].values.costBasis).toBe(250);
    expect(rows[0].values.marketValue).toBe(300);
  });

  it("converts market value to base currency for exchange rate and % of portfolio", async () => {
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec1",
        symbol: "AAA",
        name: "Alpha",
        securityType: "STOCK",
        currencyCode: "CAD",
      },
    ]);
    holdingsRepository.find.mockResolvedValue([
      holding({ quantity: 10, averageCost: 100 }),
    ]);
    txRepository.find.mockResolvedValue([
      makeTx({
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
    ]);
    manager.query.mockResolvedValue([
      priceRow({
        open_price: "120",
        high_price: "121",
        low_price: "119",
        close_price: "120",
        volume: "1000",
      }),
    ]);
    exchangeRateService.getRateForDate.mockResolvedValue(0.75); // CAD -> USD

    const { rows } = await service.computeHoldings(
      "u1",
      ["acc1"],
      "2024-06-10",
      "USD",
    );
    expect(rows[0].values.exchangeRate).toBe(0.75);
    expect(rows[0].exchangeRate).toBe(0.75); // native -> base rate on the row
    expect(rows[0].currencyCode).toBe("CAD");
    expect(rows[0].values.portfolioPercent).toBe(100);
    // Monetary values stay in the holding's native (CAD) currency.
    expect(rows[0].values.marketValue).toBe(1200);
  });

  it("marks the basis unknown when a sale exceeds what was held", async () => {
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec1",
        symbol: "AAA",
        name: "Alpha",
        securityType: "STOCK",
        currencyCode: "USD",
      },
    ]);
    holdingsRepository.find.mockResolvedValue([
      holding({ quantity: 7, averageCost: 10 }),
    ]);
    txRepository.find.mockResolvedValue([
      makeTx({
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-04",
        quantity: 5,
        price: 10,
        totalAmount: 50,
      }),
      makeTx({
        action: InvestmentAction.SELL,
        transactionDate: "2024-02-04",
        quantity: 8,
        price: 10,
        totalAmount: 80,
      }),
      makeTx({
        action: InvestmentAction.BUY,
        transactionDate: "2024-03-04",
        quantity: 10,
        price: 10,
        totalAmount: 100,
      }),
    ]);
    manager.query.mockResolvedValue([
      priceRow({ price_date: "2024-01-04", close_price: "10", volume: "10" }),
      priceRow({ price_date: "2024-06-10", close_price: "12", volume: "10" }),
    ]);

    const { rows } = await service.computeHoldings(
      "u1",
      ["acc1"],
      "2024-06-10",
      "USD",
    );
    const v = rows[0].values;
    // 5 - 8 + 10: the full sale comes off the quantity.
    expect(v.quantity).toBe(7);
    expect(v.costBasis).toBeNull();
    expect(v.gain).toBeNull();
    expect(v.realizedGains).toBeNull();
  });

  it("handles reinvest/interest/capital-gain/split/add actions and annualized return", async () => {
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec1",
        symbol: "AAA",
        name: "Alpha",
        securityType: "STOCK",
        currencyCode: "USD",
      },
    ]);
    holdingsRepository.find.mockResolvedValue([
      holding({ quantity: 26, averageCost: 100 }),
    ]);
    txRepository.find.mockResolvedValue([
      makeTx({
        action: InvestmentAction.BUY,
        transactionDate: "2021-01-04",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
        commission: 2,
      }),
      makeTx({
        action: InvestmentAction.REINVEST,
        transactionDate: "2021-06-01",
        quantity: 1,
        price: 110,
        totalAmount: 110,
      }),
      makeTx({
        action: InvestmentAction.INTEREST,
        transactionDate: "2021-07-01",
        quantity: 0,
        totalAmount: 5,
      }),
      makeTx({
        action: InvestmentAction.CAPITAL_GAIN,
        transactionDate: "2021-08-01",
        quantity: 0,
        totalAmount: 7,
      }),
      makeTx({
        action: InvestmentAction.ADD_SHARES,
        transactionDate: "2021-09-01",
        quantity: 2,
      }),
      makeTx({
        action: InvestmentAction.SPLIT,
        transactionDate: "2022-01-01",
        quantity: 2,
      }),
    ]);
    manager.query.mockResolvedValue([
      priceRow({ price_date: "2021-01-04", close_price: "100", volume: "10" }),
      priceRow({
        price_date: "2024-06-10",
        open_price: "60",
        high_price: "61",
        low_price: "59",
        close_price: "60",
        volume: "10",
      }),
    ]);

    const { rows } = await service.computeHoldings(
      "u1",
      ["acc1"],
      "2024-06-10",
      "USD",
    );
    const v = rows[0].values;
    expect(v.quantity).toBe(26); // from the holdings table
    expect(v.reinvestments).toBe(110);
    // The reinvested dividend 110 + interest 5 + capital gain 7.
    expect(v.income).toBe(122);
    // ADD_SHARES joined shares of unknown cost: nothing measured against the
    // basis is stated, but the window return needs no basis.
    expect(v.costBasis).toBeNull();
    expect(v.averageCost).toBeNull();
    expect(v.gain).toBeNull();
    expect(v.gainPercent).toBeNull();
    expect(v.priceAppreciation).toBeNull();
    expect(v.totalReturnAllDates).toBeNull();
    expect(v.totalAnnualizedReturn).toBeNull();
    expect(v.totalReturn3Year).not.toBeNull();
  });

  /**
   * Discussion #1670. A reinvested dividend is income, but a reinvest created
   * in the app stores no total, and the Income column read only cash rows: the
   * distribution sat in the cost basis with nothing to offset it, so the gain
   * understated it by exactly its value.
   */
  it("counts a reinvested dividend as income at its shares' cost, without counting it twice in a period return", async () => {
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec1",
        symbol: "AAA",
        name: "Alpha",
        securityType: "STOCK",
        currencyCode: "USD",
      },
    ]);
    holdingsRepository.find.mockResolvedValue([
      holding({ quantity: 10, averageCost: 100 }),
    ]);
    txRepository.find.mockResolvedValue([
      makeTx({
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 9,
        price: 100,
        totalAmount: 900,
      }),
      // As the app writes one: quantity and price, no total.
      makeTx({
        action: InvestmentAction.REINVEST,
        transactionDate: "2024-06-05",
        quantity: 1,
        price: 100,
        totalAmount: 0,
      }),
    ]);
    manager.query.mockResolvedValue([
      priceRow({ price_date: "2024-06-01", close_price: "100" }),
      priceRow({ price_date: "2024-06-10", close_price: "110" }),
    ]);

    const { rows } = await service.computeHoldings(
      "u1",
      ["acc1"],
      "2024-06-10",
      "USD",
    );
    const v = rows[0].values;
    expect(v.reinvestments).toBe(100);
    expect(v.income).toBe(100);
    // 900 of cash bought what is now 1,100: market value 1,100 plus the
    // reinvested 100 of income, less the 1,000 basis that includes it.
    expect(v.gain).toBe(200);
    // 9 shares worth 900 at the window's start became 10 worth 1,100. The
    // reinvested shares are already in the market value, so the period return
    // reads cash income only: 22.22%, not 33.33%.
    expect(v.totalReturn1Week).toBeCloseTo(22.2222, 4);
  });

  describe("period returns with share flows inside the window", () => {
    // The 1-week window opens on 2024-06-03; the report is as of 2024-06-10.
    const returnWeek = async (
      txs: Record<string, unknown>[],
      closes: Record<string, string>,
      // The maintained holdings row is the position the report values.
      quantityNow = 10,
    ) => {
      securitiesRepository.find.mockResolvedValue([
        {
          id: "sec1",
          symbol: "AAA",
          name: "Alpha",
          securityType: "STOCK",
          currencyCode: "USD",
        },
      ]);
      holdingsRepository.find.mockResolvedValue([
        holding({ quantity: quantityNow }),
      ]);
      txRepository.find.mockResolvedValue(txs.map((t) => makeTx(t)));
      manager.query.mockResolvedValue(
        Object.entries(closes).map(([price_date, close_price]) =>
          priceRow({ price_date, close_price }),
        ),
      );
      const { rows } = await service.computeHoldings(
        "u1",
        ["acc1"],
        "2024-06-10",
        "USD",
      );
      return rows[0].values.totalReturn1Week;
    };
    const held10 = {
      action: InvestmentAction.BUY,
      transactionDate: "2024-01-10",
      quantity: 10,
      price: 100,
      totalAmount: 1000,
    };

    it("measures a price rise with no flows unchanged", async () => {
      expect(
        await returnWeek([held10], {
          "2024-06-01": "100",
          "2024-06-10": "110",
        }),
      ).toBe(10);
    });

    it("does not read shares bought inside the window as gain", async () => {
      // 10 held, 90 bought at a flat 100: nothing was earned.
      expect(
        await returnWeek(
          [
            held10,
            {
              action: InvestmentAction.BUY,
              transactionDate: "2024-06-05",
              quantity: 90,
              price: 100,
              totalAmount: 9000,
            },
          ],
          { "2024-06-01": "100", "2024-06-10": "100" },
          100,
        ),
      ).toBe(0);
    });

    it("does not read shares sold inside the window as loss", async () => {
      expect(
        await returnWeek(
          [
            held10,
            {
              action: InvestmentAction.SELL,
              transactionDate: "2024-06-05",
              quantity: 9,
              price: 100,
              totalAmount: 900,
            },
          ],
          { "2024-06-01": "100", "2024-06-10": "100" },
          1,
        ),
      ).toBe(0);
    });

    it("values a transfer in at the price on its date", async () => {
      // 5 shares enter at 100 (500), 10 and 5 are worth 110 each at the end:
      // Modified Dietz, start of day: 150 / (1000 + 500 * 6/7) = 10.5%.
      expect(
        await returnWeek(
          [
            held10,
            {
              action: InvestmentAction.TRANSFER_IN,
              transactionDate: "2024-06-05",
              quantity: 5,
              price: null,
              totalAmount: 0,
            },
          ],
          {
            "2024-06-01": "100",
            "2024-06-05": "100",
            "2024-06-10": "110",
          },
          15,
        ),
      ).toBeCloseTo(10.5, 4);
    });

    it("weights a mid-window purchase by the days it was held", async () => {
      // 10 held at 100, 90 bought on 06-05 at 100, 100 worth 110 on 06-10:
      // invested 6 of the window's 7 days (06-05..06-10, its own day counted):
      // 1000 / (1000 + 9000 * 6/7) = 1000 / 8714.2857 = 11.4754%. The old
      // start-of-window denominator (10000) read 10%.
      expect(
        await returnWeek(
          [
            held10,
            {
              action: InvestmentAction.BUY,
              transactionDate: "2024-06-05",
              quantity: 90,
              price: 100,
              totalAmount: 9000,
            },
          ],
          { "2024-06-01": "100", "2024-06-10": "110" },
          100,
        ),
      ).toBeCloseTo(11.4754, 4);
    });

    it("weights a sale out of the denominator", async () => {
      // 10 held at 100, 9 sold on 06-04 for 900, 1 worth 110 on 06-10:
      // the sale on the window's first day weighs 1, so the 1 share still held
      // carries the whole base: (110 + 900 - 1000) / (1000 - 900) = 10%, the
      // price move.
      expect(
        await returnWeek(
          [
            held10,
            {
              action: InvestmentAction.SELL,
              transactionDate: "2024-06-04",
              quantity: 9,
              price: 100,
              totalAmount: 900,
            },
          ],
          { "2024-06-01": "100", "2024-06-10": "110" },
          1,
        ),
      ).toBeCloseTo(10, 4);
    });

    it("reports no return when the weighted denominator is not positive", async () => {
      // 9 sold on 06-04 for 1,200: 1000 - 1200 * 7/7 = -200.
      expect(
        await returnWeek(
          [
            held10,
            {
              action: InvestmentAction.SELL,
              transactionDate: "2024-06-04",
              quantity: 9,
              price: 133.33,
              totalAmount: 1200,
            },
          ],
          { "2024-06-01": "100", "2024-06-10": "110" },
          1,
        ),
      ).toBeNull();
    });

    it("weights a flow on the as-of date by its own day", async () => {
      // 90 bought on 06-10 at 100 and closing at 110: the 900 earned that day
      // is over 9000 invested for 1 of 7 days, not over nothing, so the
      // column does not read 100%: 1000 / (1000 + 9000 / 7) = 43.75%.
      expect(
        await returnWeek(
          [
            held10,
            {
              action: InvestmentAction.BUY,
              transactionDate: "2024-06-10",
              quantity: 90,
              price: 100,
              totalAmount: 9000,
            },
          ],
          { "2024-06-01": "100", "2024-06-10": "110" },
          100,
        ),
      ).toBeCloseTo(43.75, 4);
    });

    it("equals the plain return when a dividend is reinvested", async () => {
      // 1 share bought with the distribution at a flat 100: 1,000 became
      // 1,100, which is the 10% a cash dividend of 100 would have earned.
      expect(
        await returnWeek(
          [
            held10,
            {
              action: InvestmentAction.REINVEST,
              transactionDate: "2024-06-05",
              quantity: 1,
              price: 100,
              totalAmount: 0,
            },
          ],
          { "2024-06-01": "100", "2024-06-10": "100" },
          11,
        ),
      ).toBe(10);
    });

    it("reports no return when a flow in the window cannot be valued", async () => {
      // A BUY with no price is an unknown cost, not a free purchase.
      expect(
        await returnWeek(
          [
            held10,
            {
              action: InvestmentAction.BUY,
              transactionDate: "2024-06-05",
              quantity: 90,
              price: 0,
              totalAmount: 0,
            },
          ],
          { "2024-06-01": "100", "2024-06-10": "100" },
          100,
        ),
      ).toBeNull();
    });
  });

  it("reports realized gains as unknown once a sale draws on shares added with no cost (#1859)", async () => {
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec1",
        symbol: "AAA",
        name: "Alpha",
        securityType: "STOCK",
        currencyCode: "USD",
      },
    ]);
    holdingsRepository.find.mockResolvedValue([
      holding({ quantity: 100, averageCost: 0 }),
    ]);
    txRepository.find.mockResolvedValue([
      makeTx({
        action: InvestmentAction.ADD_SHARES,
        transactionDate: "2024-01-05",
        quantity: 100,
        price: null,
        totalAmount: 0,
      }),
      makeTx({
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 100,
        price: 50,
        totalAmount: 5000,
      }),
      makeTx({
        action: InvestmentAction.SELL,
        transactionDate: "2024-06-05",
        quantity: 100,
        price: 60,
        totalAmount: 6000,
      }),
    ]);
    manager.query.mockResolvedValue([
      priceRow({ price_date: "2024-06-10", close_price: "60" }),
    ]);

    const { rows } = await service.computeHoldings(
      "u1",
      ["acc1"],
      "2024-06-10",
      "USD",
    );

    // The average over 200 shares is 25, which read as a gain of 3,500.
    expect(rows[0].values.realizedGains).toBeNull();
    expect(rows[0].values.sales).toBe(6000);
  });

  it("treats a return of capital as capital paid back, not income (#1800)", async () => {
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec1",
        symbol: "AAA",
        name: "Alpha",
        securityType: "STOCK",
        currencyCode: "USD",
      },
    ]);
    holdingsRepository.find.mockResolvedValue([
      holding({ quantity: 10, averageCost: 0 }),
    ]);
    txRepository.find.mockResolvedValue([
      makeTx({
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
      // 120 a share paid back on 100 a share of cost: 1,000 comes off the
      // basis and the 200 beyond it is realized.
      makeTx({
        action: InvestmentAction.RETURN_OF_CAPITAL,
        transactionDate: "2024-06-05",
        quantity: null,
        price: null,
        totalAmount: 1200,
      }),
    ]);
    manager.query.mockResolvedValue([
      priceRow({ price_date: "2024-06-01", close_price: "200" }),
      priceRow({ price_date: "2024-06-10", close_price: "80" }),
    ]);

    const { rows } = await service.computeHoldings(
      "u1",
      ["acc1"],
      "2024-06-10",
      "USD",
    );
    const v = rows[0].values;
    expect(v.income).toBe(0);
    expect(v.realizedGains).toBe(200);
    // 2,000 at the window's start became 800 of shares plus 1,200 of cash
    // paid back: no return, where leaving the cash out read it as -60%.
    expect(v.totalReturn1Week).toBe(0);
  });

  it("keeps an imported reinvest that carries a total but no price in Reinvestments and Income", async () => {
    // A QIF ReinvDiv with no price line: the basis cannot price it, but the
    // distribution itself is the file's total.
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec1",
        symbol: "AAA",
        name: "Alpha",
        securityType: "STOCK",
        currencyCode: "USD",
      },
    ]);
    holdingsRepository.find.mockResolvedValue([
      holding({ quantity: 20, averageCost: 50 }),
    ]);
    txRepository.find.mockResolvedValue([
      makeTx({
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 50,
        totalAmount: 500,
      }),
      makeTx({
        action: InvestmentAction.REINVEST,
        transactionDate: "2024-03-01",
        quantity: 10,
        price: null,
        totalAmount: 500,
      }),
    ]);
    manager.query.mockResolvedValue([
      priceRow({ price_date: "2024-06-10", close_price: "50" }),
    ]);

    const { rows } = await service.computeHoldings(
      "u1",
      ["acc1"],
      "2024-06-10",
      "USD",
    );
    expect(rows[0].values.reinvestments).toBe(500);
    expect(rows[0].values.income).toBe(500);
  });

  /**
   * Issue #1390. One unresolvable pair blanks every row's % of portfolio --
   * the denominator is withheld, correctly -- but the response said nothing
   * about why, so the blanks read as zero and only a server log named the
   * pair. The completeness now travels with the rows.
   */
  it("reports the pair it could not resolve instead of only logging it", async () => {
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec1",
        symbol: "AAA",
        name: "Alpha",
        securityType: "STOCK",
        currencyCode: "SEK",
      },
    ]);
    holdingsRepository.find.mockResolvedValue([
      holding({ quantity: 10, averageCost: 100 }),
    ]);
    txRepository.find.mockResolvedValue([
      makeTx({
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
    ]);
    manager.query.mockResolvedValue([priceRow({ close_price: "120" })]);
    exchangeRateService.getRateForDate.mockResolvedValue(null);

    const result = await service.computeHoldings(
      "u1",
      ["acc1"],
      "2024-06-10",
      "USD",
    );

    expect(result.fxComplete).toBe(false);
    expect(result.missingPairs).toEqual(["SEK->USD"]);
    // The withheld figures stay withheld: the flag explains them, it does not
    // replace them with a number.
    expect(result.rows[0].values.portfolioPercent).toBeNull();
    expect(result.rows[0].exchangeRate).toBeNull();
  });

  it("reports a fully converted run as complete", async () => {
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec1",
        symbol: "AAA",
        name: "Alpha",
        securityType: "STOCK",
        currencyCode: "USD",
      },
    ]);
    holdingsRepository.find.mockResolvedValue([
      holding({ quantity: 10, averageCost: 100 }),
    ]);
    txRepository.find.mockResolvedValue([
      makeTx({
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
    ]);
    manager.query.mockResolvedValue([priceRow({ close_price: "120" })]);

    const result = await service.computeHoldings(
      "u1",
      ["acc1"],
      "2024-06-10",
      "USD",
    );

    expect(result.fxComplete).toBe(true);
    expect(result.missingPairs).toEqual([]);
    expect(result.pricesComplete).toBe(true);
    expect(result.unpricedSymbols).toEqual([]);
  });

  /**
   * Issue #1390, the other cause. An unpriced holding withholds the same
   * denominator by the same arithmetic, but `fxComplete` stayed true and
   * `missingPairs` empty, so the blank "% of portfolio" column carried no
   * explanation at all and the rate table was the wrong thing to go and check.
   */
  it("reports an unpriced holding as its own cause, not as a rate gap", async () => {
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec1",
        symbol: "AAA",
        name: "Alpha",
        securityType: "STOCK",
        currencyCode: "USD",
      },
      {
        id: "sec2",
        symbol: "BBB",
        name: "Beta",
        securityType: "STOCK",
        currencyCode: "USD",
      },
    ]);
    holdingsRepository.find.mockResolvedValue([
      holding({ quantity: 10, averageCost: 100 }),
      holding({ securityId: "sec2", quantity: 5, averageCost: 40 }),
    ]);
    txRepository.find.mockResolvedValue([
      makeTx({
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
      makeTx({
        securityId: "sec2",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 5,
        price: 40,
        totalAmount: 200,
      }),
    ]);
    // Only the first security has a close on or before the as-of date.
    manager.query.mockResolvedValue([priceRow({ close_price: "120" })]);

    const result = await service.computeHoldings(
      "u1",
      ["acc1"],
      "2024-06-10",
      "USD",
    );

    expect(result.pricesComplete).toBe(false);
    expect(result.unpricedSymbols).toEqual(["BBB"]);
    // The rate table is not the thing to go and fix.
    expect(result.fxComplete).toBe(true);
    expect(result.missingPairs).toEqual([]);
    // The denominator is still withheld, on every row.
    expect(result.rows.map((r) => r.values.portfolioPercent)).toEqual([
      null,
      null,
    ]);
  });

  it("leaves the direct/inverse decision to the one ladder and converts at the as-of date", async () => {
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec1",
        symbol: "AAA",
        name: "Alpha",
        securityType: "STOCK",
        currencyCode: "EUR",
      },
    ]);
    holdingsRepository.find.mockResolvedValue([
      holding({ quantity: 10, averageCost: 100 }),
    ]);
    txRepository.find.mockResolvedValue([
      makeTx({
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
    ]);
    manager.query.mockResolvedValue([priceRow({ close_price: "120" })]);
    // Only EUR->USD is asked for: `getRateForDate` already consults both
    // stored directions, so a caller-side reverse chase would be a second
    // resolver (issue #1390). 1/0.8 = 1.25 is what the ladder hands back.
    exchangeRateService.getRateForDate.mockResolvedValue(1.25);

    const { rows } = await service.computeHoldings(
      "u1",
      ["acc1"],
      "2024-06-10",
      "USD",
    );
    expect(rows[0].values.exchangeRate).toBe(1.25);
    // The report's as-of date, not today; and `fetchMissing: false`, because
    // running a report is a read: the provider fan-out it used to trigger
    // wrote rate rows from a GET and repeated on every refresh.
    expect(exchangeRateService.getRateForDate).toHaveBeenCalledWith(
      "EUR",
      "USD",
      "2024-06-10",
      { fetchMissing: false },
    );
  });

  it("returns null valuation columns when no price is available", async () => {
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec1",
        symbol: "AAA",
        name: "Alpha",
        securityType: "STOCK",
        currencyCode: "USD",
      },
    ]);
    holdingsRepository.find.mockResolvedValue([
      holding({ quantity: 10, averageCost: 100 }),
    ]);
    txRepository.find.mockResolvedValue([
      makeTx({
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
    ]);
    manager.query.mockResolvedValue([]); // no stored prices

    const { rows } = await service.computeHoldings(
      "u1",
      ["acc1"],
      "2024-06-10",
      "USD",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].values.lastPrice).toBeNull();
    expect(rows[0].values.marketValue).toBeNull();
    expect(rows[0].values.gain).toBeNull();
    expect(rows[0].values.portfolioPercent).toBeNull();
    expect(rows[0].values.totalReturn1Year).toBeNull();
  });

  it("handles transfers, share removals, and 52-week lows from null-OHLC rows", async () => {
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec1",
        symbol: "AAA",
        name: "Alpha",
        securityType: "STOCK",
        currencyCode: "USD",
      },
    ]);
    holdingsRepository.find.mockResolvedValue([
      holding({ quantity: 20, averageCost: 50 }),
    ]);
    txRepository.find.mockResolvedValue([
      makeTx({
        action: InvestmentAction.TRANSFER_IN,
        transactionDate: "2022-01-10",
        quantity: 20,
        price: 50,
        totalAmount: 1000,
      }),
      makeTx({
        action: InvestmentAction.REMOVE_SHARES,
        transactionDate: "2022-06-10",
        quantity: 5,
      }),
      makeTx({
        action: InvestmentAction.TRANSFER_OUT,
        transactionDate: "2023-01-10",
        quantity: 5,
        price: 60,
        totalAmount: 300,
      }),
      makeTx({
        action: InvestmentAction.BUY,
        transactionDate: "2023-06-10",
        quantity: 10,
        price: 70,
        totalAmount: 700,
      }),
    ]);
    manager.query.mockResolvedValue([
      priceRow({
        price_date: "2022-01-10",
        open_price: null,
        high_price: null,
        low_price: null,
        close_price: "50",
        volume: null,
      }),
      priceRow({
        price_date: "2023-06-09",
        open_price: "65",
        high_price: "66",
        low_price: "64",
        close_price: "65",
        volume: "10",
      }),
      priceRow({
        price_date: "2024-01-15",
        open_price: "80",
        high_price: null,
        low_price: null,
        close_price: "80",
        volume: "10",
      }),
      priceRow({
        price_date: "2024-06-10",
        open_price: "88",
        high_price: "91",
        low_price: "87",
        close_price: "90",
        volume: "100",
      }),
    ]);

    const { rows } = await service.computeHoldings(
      "u1",
      ["acc1"],
      "2024-06-10",
      "USD",
    );
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
    holdingsRepository.find.mockResolvedValue([
      holding({ quantity: 10, averageCost: 100 }),
    ]);
    txRepository.find.mockResolvedValue([
      makeTx({
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
    ]);
    manager.query.mockResolvedValue([]);
    const { rows } = await service.computeHoldings(
      "u1",
      ["acc1"],
      "2024-06-10",
      "USD",
    );
    expect(rows).toHaveLength(0);
  });

  it("maps raw security types to friendly labels", async () => {
    securitiesRepository.find.mockResolvedValue([
      {
        id: "sec1",
        symbol: "AAA",
        name: "A",
        securityType: "MUTUAL_FUND",
        currencyCode: "USD",
      },
      {
        id: "sec2",
        symbol: "BBB",
        name: "B",
        securityType: "CUSTOM_TYPE",
        currencyCode: "USD",
      },
    ]);
    holdingsRepository.find.mockResolvedValue([
      holding({ securityId: "sec1", quantity: 10, averageCost: 100 }),
      holding({ securityId: "sec2", quantity: 5, averageCost: 50 }),
    ]);
    txRepository.find.mockResolvedValue([
      makeTx({
        securityId: "sec1",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
      makeTx({
        securityId: "sec2",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 5,
        price: 50,
        totalAmount: 250,
      }),
    ]);
    manager.query.mockResolvedValue([
      priceRow({ security_id: "sec1", close_price: "100" }),
      priceRow({ security_id: "sec2", close_price: "50" }),
    ]);
    const { rows } = await service.computeHoldings(
      "u1",
      ["acc1"],
      "2024-06-10",
      "USD",
    );
    const types = rows.map((r) => r.values.securityType);
    expect(types).toContain("Mutual Fund"); // known mapping
    expect(types).toContain("Custom Type"); // unknown -> title-cased
  });

  describe("getLatestMarketDay", () => {
    it("returns today when there are no accounts", async () => {
      expect(await service.getLatestMarketDay("u1", [])).toBe(todayYMD());
    });

    it("returns the max stored price date", async () => {
      manager.query.mockResolvedValue([{ d: "2024-06-10" }]);
      expect(await service.getLatestMarketDay("u1", ["acc1"])).toBe(
        "2024-06-10",
      );
    });

    it("falls back to today when no prices exist", async () => {
      manager.query.mockResolvedValue([{ d: null }]);
      expect(await service.getLatestMarketDay("u1", ["acc1"])).toBe(todayYMD());
    });

    it("uses the request-context timezone for the today fallback, not UTC", async () => {
      // Kiritimata (UTC+14) is far enough that 'today' there can differ from
      // the UTC date; the default must follow the caller's local day.
      const tz = "Pacific/Kiritimati";
      await requestContextStorage.run({ timezone: tz }, async () => {
        expect(await service.getLatestMarketDay("u1", [])).toBe(
          todayInTimezone(tz),
        );
      });
    });
  });
});
