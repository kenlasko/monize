import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { PortfolioCalculationService } from "./portfolio-calculation.service";
import { Holding } from "./entities/holding.entity";
import { SecurityPrice } from "./entities/security-price.entity";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "./entities/investment-transaction.entity";
import { Account } from "../accounts/entities/account.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { HoldingWithMarketValue } from "./portfolio.service";

describe("PortfolioCalculationService.calculateRealizedGains", () => {
  let service: PortfolioCalculationService;
  let txRepo: { find: jest.Mock };

  const userId = "user-1";
  const accountId = "acct-1";
  const securityId = "sec-1";

  const makeTx = (overrides: Partial<InvestmentTransaction>) =>
    ({
      id: overrides.id ?? "tx",
      userId,
      accountId,
      securityId,
      action: InvestmentAction.BUY,
      transactionDate: "2024-01-01",
      quantity: 0,
      price: 0,
      commission: 0,
      totalAmount: 0,
      exchangeRate: 1,
      description: null,
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
      account: {
        id: accountId,
        name: "TFSA",
        currencyCode: "CAD",
      } as Partial<Account>,
      security: {
        id: securityId,
        symbol: "ABC",
        name: "ABC Corp",
        currencyCode: "CAD",
      },
      ...overrides,
    }) as unknown as InvestmentTransaction;

  beforeEach(async () => {
    txRepo = { find: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioCalculationService,
        { provide: getRepositoryToken(Holding), useValue: {} },
        { provide: getRepositoryToken(SecurityPrice), useValue: {} },
        {
          provide: getRepositoryToken(InvestmentTransaction),
          useValue: txRepo,
        },
        { provide: getRepositoryToken(Account), useValue: {} },
        { provide: ExchangeRateService, useValue: {} },
      ],
    }).compile();
    service = module.get(PortfolioCalculationService);
  });

  it("uses average cost at sale time, not quantity * price, as the cost basis", async () => {
    // Buy 100 @ $50, then sell 100 @ $60. True realized gain = 100 * ($60 - $50) = $1000.
    // The old buggy formula would have produced cost basis = 100 * $60 = $6000 -> gain near zero.
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "buy",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 100,
        price: 50,
        totalAmount: 5000,
      }),
      makeTx({
        id: "sell",
        action: InvestmentAction.SELL,
        transactionDate: "2024-06-10",
        quantity: 100,
        price: 60,
        commission: 10,
        totalAmount: 5990, // 100 * 60 - 10 commission
      }),
    ]);

    const result = await service.calculateRealizedGains(userId);

    expect(result).toHaveLength(1);
    const sell = result[0];
    expect(sell.transactionId).toBe("sell");
    expect(sell.costBasis).toBe(5000);
    expect(sell.proceeds).toBe(5990); // net of commission
    expect(sell.realizedGain).toBe(990); // 5990 - 5000
  });

  it("averages cost across multiple BUYs before a partial SELL", async () => {
    // Buy 100 @ $50 -> costBasis 5000, qty 100
    // Buy 100 @ $70 -> costBasis 12000, qty 200, avg = 60
    // Sell 50 -> cost basis for sold = 50 * 60 = 3000
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "b1",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 100,
        price: 50,
        totalAmount: 5000,
      }),
      makeTx({
        id: "b2",
        action: InvestmentAction.BUY,
        transactionDate: "2024-03-10",
        quantity: 100,
        price: 70,
        totalAmount: 7000,
      }),
      makeTx({
        id: "s1",
        action: InvestmentAction.SELL,
        transactionDate: "2024-06-10",
        quantity: 50,
        price: 80,
        totalAmount: 4000,
      }),
    ]);

    const result = await service.calculateRealizedGains(userId);
    expect(result).toHaveLength(1);
    expect(result[0].costBasis).toBe(3000);
    expect(result[0].realizedGain).toBe(1000);
  });

  it("filters the output by startDate but still replays history before the range", async () => {
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "b1",
        action: InvestmentAction.BUY,
        transactionDate: "2022-01-10", // well before the window
        quantity: 100,
        price: 20,
        totalAmount: 2000,
      }),
      makeTx({
        id: "s1",
        action: InvestmentAction.SELL,
        transactionDate: "2024-06-10",
        quantity: 50,
        price: 40,
        totalAmount: 2000,
      }),
    ]);

    const result = await service.calculateRealizedGains(userId, {
      startDate: "2024-01-01",
      endDate: "2024-12-31",
    });

    expect(result).toHaveLength(1);
    // Cost basis from the 2022 BUY at $20/share still applies.
    expect(result[0].costBasis).toBe(1000); // 50 * 20
    expect(result[0].realizedGain).toBe(1000); // 2000 - 1000
  });

  it("converts to account currency using the SELL transaction's exchange rate", async () => {
    // BUY 10 @ $100 USD with rate 1.3 -> costBasis 1300 CAD
    // SELL 10 @ $150 USD, totalAmount 1500 USD, rate 1.35 -> proceeds 2025 CAD
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "b1",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-01",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
        exchangeRate: 1.3,
      }),
      makeTx({
        id: "s1",
        action: InvestmentAction.SELL,
        transactionDate: "2024-06-01",
        quantity: 10,
        price: 150,
        totalAmount: 1500,
        exchangeRate: 1.35,
      }),
    ]);

    const result = await service.calculateRealizedGains(userId);
    expect(result[0].proceeds).toBe(2025); // 1500 * 1.35
    expect(result[0].costBasis).toBe(1300); // 10 * 100 * 1.3
    expect(result[0].realizedGain).toBe(725); // 2025 - 1300
  });

  it("returns zero realized gain when a SELL has no prior position", async () => {
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "orphan-sell",
        action: InvestmentAction.SELL,
        transactionDate: "2024-06-01",
        quantity: 10,
        price: 50,
        totalAmount: 500,
      }),
    ]);

    const result = await service.calculateRealizedGains(userId);
    expect(result).toHaveLength(1);
    expect(result[0].costBasis).toBe(0);
    expect(result[0].proceeds).toBe(500);
    expect(result[0].realizedGain).toBe(500);
  });
});

describe("PortfolioCalculationService.calculateCapitalGainsByMonth", () => {
  let service: PortfolioCalculationService;
  let txRepo: { find: jest.Mock };
  let priceRepo: { query: jest.Mock };
  let exchangeRateService: { getLatestRate: jest.Mock };

  const userId = "user-1";
  const accountId = "acct-1";
  const securityId = "sec-1";

  const makeTx = (overrides: Partial<InvestmentTransaction>) =>
    ({
      id: overrides.id ?? "tx",
      userId,
      accountId,
      securityId,
      action: InvestmentAction.BUY,
      transactionDate: "2024-01-01",
      quantity: 0,
      price: 0,
      commission: 0,
      totalAmount: 0,
      exchangeRate: 1,
      description: null,
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
      account: {
        id: accountId,
        name: "TFSA",
        currencyCode: "CAD",
      } as Partial<Account>,
      security: {
        id: securityId,
        symbol: "ABC",
        name: "ABC Corp",
        currencyCode: "CAD",
      },
      ...overrides,
    }) as unknown as InvestmentTransaction;

  // Build the rows that getAllPricesForSecurities returns from
  // security_prices, in the shape the SQL query produces.
  const priceRows = (
    rows: Array<{ date: string; price: number; securityId?: string }>,
  ) =>
    rows.map((r) => ({
      security_id: r.securityId ?? securityId,
      price_date: r.date,
      close_price: String(r.price),
    }));

  beforeEach(async () => {
    txRepo = { find: jest.fn() };
    priceRepo = { query: jest.fn().mockResolvedValue([]) };
    exchangeRateService = { getLatestRate: jest.fn().mockResolvedValue(null) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioCalculationService,
        { provide: getRepositoryToken(Holding), useValue: {} },
        { provide: getRepositoryToken(SecurityPrice), useValue: priceRepo },
        {
          provide: getRepositoryToken(InvestmentTransaction),
          useValue: txRepo,
        },
        { provide: getRepositoryToken(Account), useValue: {} },
        { provide: ExchangeRateService, useValue: exchangeRateService },
      ],
    }).compile();
    service = module.get(PortfolioCalculationService);
  });

  it("returns an empty array when there are no transactions", async () => {
    txRepo.find.mockResolvedValue([]);
    const result = await service.calculateCapitalGainsByMonth(userId, {
      startDate: "2024-01-01",
      endDate: "2024-03-31",
    });
    expect(result).toEqual([]);
  });

  it("captures unrealized mark-to-market change for a held position with no SELL", async () => {
    // Buy 100 shares at $50 in Dec; price climbs $50 -> $55 -> $60 across Jan/Feb.
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "buy",
        action: InvestmentAction.BUY,
        transactionDate: "2023-12-15",
        quantity: 100,
        price: 50,
        totalAmount: 5000,
      }),
    ]);
    priceRepo.query.mockResolvedValue(
      priceRows([
        { date: "2023-12-31", price: 50 },
        { date: "2024-01-31", price: 55 },
        { date: "2024-02-29", price: 60 },
      ]),
    );

    const result = await service.calculateCapitalGainsByMonth(userId, {
      startDate: "2024-01-01",
      endDate: "2024-02-29",
    });

    expect(result).toHaveLength(2);
    const jan = result.find((r) => r.month === "2024-01")!;
    const feb = result.find((r) => r.month === "2024-02")!;
    // Jan: (55*100) - (50*100) = +500, all unrealized
    expect(jan.totalCapitalGain).toBe(500);
    expect(jan.realizedGain).toBe(0);
    expect(jan.unrealizedGain).toBe(500);
    // Feb: (60*100) - (55*100) = +500
    expect(feb.totalCapitalGain).toBe(500);
    expect(feb.unrealizedGain).toBe(500);
  });

  it("decomposes a SELL month into realized + unrealized capital gains", async () => {
    // Hold 100 shares at avg cost $50 since Dec.
    // Feb: price goes $50 -> $60, sell 40 shares mid-month at $60 (proceeds 2400),
    //      end-of-month price = $60. Remaining 60 shares.
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "buy",
        action: InvestmentAction.BUY,
        transactionDate: "2023-12-15",
        quantity: 100,
        price: 50,
        totalAmount: 5000,
      }),
      makeTx({
        id: "sell",
        action: InvestmentAction.SELL,
        transactionDate: "2024-02-15",
        quantity: 40,
        price: 60,
        totalAmount: 2400,
      }),
    ]);
    priceRepo.query.mockResolvedValue(
      priceRows([
        { date: "2024-01-31", price: 50 },
        { date: "2024-02-29", price: 60 },
      ]),
    );

    const result = await service.calculateCapitalGainsByMonth(userId, {
      startDate: "2024-02-01",
      endDate: "2024-02-29",
    });

    expect(result).toHaveLength(1);
    const feb = result[0];
    // realized = 40 * (60 - 50) = 400
    expect(feb.realizedGain).toBe(400);
    // total = (endValue - startValue) + sells - buys
    //       = (60*60 - 50*100) + 2400 - 0 = 3600 - 5000 + 2400 = 1000
    expect(feb.totalCapitalGain).toBe(1000);
    // unrealized = total - realized = 600 (price gain $50 -> $60 on the 60
    // shares still held at end of month).
    expect(feb.unrealizedGain).toBe(600);
  });

  it("emits negative capital gains when prices fall", async () => {
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "buy",
        action: InvestmentAction.BUY,
        transactionDate: "2023-12-15",
        quantity: 100,
        price: 50,
        totalAmount: 5000,
      }),
    ]);
    priceRepo.query.mockResolvedValue(
      priceRows([
        { date: "2023-12-31", price: 50 },
        { date: "2024-01-31", price: 42 },
      ]),
    );

    const result = await service.calculateCapitalGainsByMonth(userId, {
      startDate: "2024-01-01",
      endDate: "2024-01-31",
    });

    expect(result).toHaveLength(1);
    expect(result[0].totalCapitalGain).toBe(-800); // (42-50) * 100
    expect(result[0].unrealizedGain).toBe(-800);
  });

  it("seeds cost basis from history that predates the requested window", async () => {
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "old-buy",
        action: InvestmentAction.BUY,
        transactionDate: "2022-06-01",
        quantity: 100,
        price: 20,
        totalAmount: 2000,
      }),
      makeTx({
        id: "sell",
        action: InvestmentAction.SELL,
        transactionDate: "2024-03-15",
        quantity: 100,
        price: 30,
        totalAmount: 3000,
      }),
    ]);
    priceRepo.query.mockResolvedValue(
      priceRows([
        { date: "2024-02-29", price: 28 },
        { date: "2024-03-31", price: 30 },
      ]),
    );

    const result = await service.calculateCapitalGainsByMonth(userId, {
      startDate: "2024-03-01",
      endDate: "2024-03-31",
    });

    expect(result).toHaveLength(1);
    const mar = result[0];
    // Realized: 100 * (30 - 20) = 1000
    expect(mar.realizedGain).toBe(1000);
    // Total: (0 - 28*100) + 3000 - 0 = 200
    // (start value at Feb-29 close = $2800; end value = 0; cash from sale = $3000)
    expect(mar.totalCapitalGain).toBe(200);
    // Unrealized: 200 - 1000 = -800 (the price-driven unrealized gain of $800
    // from the original $20 cost has been crystallized into realized).
    expect(mar.unrealizedGain).toBe(-800);
  });

  it("drops months with no holding and no activity", async () => {
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "buy",
        action: InvestmentAction.BUY,
        transactionDate: "2024-02-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
      makeTx({
        id: "sell",
        action: InvestmentAction.SELL,
        transactionDate: "2024-02-20",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
    ]);
    priceRepo.query.mockResolvedValue(
      priceRows([{ date: "2024-02-29", price: 100 }]),
    );

    const result = await service.calculateCapitalGainsByMonth(userId, {
      startDate: "2024-01-01",
      endDate: "2024-04-30",
    });

    // Jan: no holding, no activity -> dropped.
    // Feb: BUY+SELL in the same month -> kept.
    // Mar/Apr: no holding, no activity -> dropped.
    expect(result.map((r) => r.month)).toEqual(["2024-02"]);
  });

  it("returns empty when startDate is after endDate", async () => {
    txRepo.find.mockResolvedValue([]);
    const result = await service.calculateCapitalGainsByMonth(userId, {
      startDate: "2024-12-01",
      endDate: "2024-01-01",
    });
    expect(result).toEqual([]);
  });
});

describe("PortfolioCalculationService.calculateCapitalGainsByDay", () => {
  let service: PortfolioCalculationService;
  let txRepo: { find: jest.Mock };
  let priceRepo: { query: jest.Mock };
  let exchangeRateService: { getLatestRate: jest.Mock };

  const userId = "user-1";
  const accountId = "acct-1";
  const securityId = "sec-1";

  const makeTx = (overrides: Partial<InvestmentTransaction>) =>
    ({
      id: overrides.id ?? "tx",
      userId,
      accountId,
      securityId,
      action: InvestmentAction.BUY,
      transactionDate: "2024-01-01",
      quantity: 0,
      price: 0,
      commission: 0,
      totalAmount: 0,
      exchangeRate: 1,
      description: null,
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
      account: {
        id: accountId,
        name: "TFSA",
        currencyCode: "CAD",
      } as Partial<Account>,
      security: {
        id: securityId,
        symbol: "ABC",
        name: "ABC Corp",
        currencyCode: "CAD",
      },
      ...overrides,
    }) as unknown as InvestmentTransaction;

  const priceRows = (
    rows: Array<{ date: string; price: number; securityId?: string }>,
  ) =>
    rows.map((r) => ({
      security_id: r.securityId ?? securityId,
      price_date: r.date,
      close_price: String(r.price),
    }));

  beforeEach(async () => {
    txRepo = { find: jest.fn() };
    priceRepo = { query: jest.fn().mockResolvedValue([]) };
    exchangeRateService = { getLatestRate: jest.fn().mockResolvedValue(null) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioCalculationService,
        { provide: getRepositoryToken(Holding), useValue: {} },
        { provide: getRepositoryToken(SecurityPrice), useValue: priceRepo },
        {
          provide: getRepositoryToken(InvestmentTransaction),
          useValue: txRepo,
        },
        { provide: getRepositoryToken(Account), useValue: {} },
        { provide: ExchangeRateService, useValue: exchangeRateService },
      ],
    }).compile();
    service = module.get(PortfolioCalculationService);
  });

  it("returns an empty array when there are no transactions", async () => {
    txRepo.find.mockResolvedValue([]);
    const result = await service.calculateCapitalGainsByDay(userId, {
      startDate: "2024-01-01",
      endDate: "2024-01-03",
    });
    expect(result).toEqual([]);
  });

  it("uses YYYY-MM-DD keys in the month field", async () => {
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "buy",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-01",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
    ]);
    priceRepo.query.mockResolvedValue(
      priceRows([
        { date: "2023-12-31", price: 100 },
        { date: "2024-01-01", price: 105 },
      ]),
    );

    const result = await service.calculateCapitalGainsByDay(userId, {
      startDate: "2024-01-01",
      endDate: "2024-01-01",
    });

    expect(result).toHaveLength(1);
    expect(result[0].month).toBe("2024-01-01");
  });

  it("captures unrealized mark-to-market change for a held position across two days", async () => {
    // Buy 100 shares on Dec 31; price goes $50 -> $55 on Jan 1, $55 -> $60 on Jan 2.
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "buy",
        action: InvestmentAction.BUY,
        transactionDate: "2023-12-31",
        quantity: 100,
        price: 50,
        totalAmount: 5000,
      }),
    ]);
    priceRepo.query.mockResolvedValue(
      priceRows([
        { date: "2023-12-30", price: 50 },
        { date: "2023-12-31", price: 50 },
        { date: "2024-01-01", price: 55 },
        { date: "2024-01-02", price: 60 },
      ]),
    );

    const result = await service.calculateCapitalGainsByDay(userId, {
      startDate: "2024-01-01",
      endDate: "2024-01-02",
    });

    expect(result).toHaveLength(2);
    const jan1 = result.find((r) => r.month === "2024-01-01")!;
    const jan2 = result.find((r) => r.month === "2024-01-02")!;
    // Jan 1: startValue = 50*100=5000, endValue = 55*100=5500, gain = +500
    expect(jan1.totalCapitalGain).toBe(500);
    expect(jan1.unrealizedGain).toBe(500);
    expect(jan1.realizedGain).toBe(0);
    // Jan 2: startValue = 55*100=5500, endValue = 60*100=6000, gain = +500
    expect(jan2.totalCapitalGain).toBe(500);
    expect(jan2.unrealizedGain).toBe(500);
  });

  it("decomposes a SELL day into realized + unrealized capital gains", async () => {
    // Hold 100 shares at avg cost $50. On Jan 5, price is $60 and sell 40 shares.
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "buy",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-01",
        quantity: 100,
        price: 50,
        totalAmount: 5000,
      }),
      makeTx({
        id: "sell",
        action: InvestmentAction.SELL,
        transactionDate: "2024-01-05",
        quantity: 40,
        price: 60,
        totalAmount: 2400,
      }),
    ]);
    priceRepo.query.mockResolvedValue(
      priceRows([
        { date: "2024-01-04", price: 50 },
        { date: "2024-01-05", price: 60 },
      ]),
    );

    const result = await service.calculateCapitalGainsByDay(userId, {
      startDate: "2024-01-05",
      endDate: "2024-01-05",
    });

    expect(result).toHaveLength(1);
    const day = result[0];
    // realized = 40 * (60 - 50) = 400
    expect(day.realizedGain).toBe(400);
    // total = (endValue - startValue) + sells - buys
    //       = (60*60 - 50*100) + 2400 - 0 = 3600 - 5000 + 2400 = 1000
    expect(day.totalCapitalGain).toBe(1000);
    // unrealized = 1000 - 400 = 600
    expect(day.unrealizedGain).toBe(600);
  });

  it("drops days with no holding and no activity", async () => {
    // Buy on Jan 3, sell on Jan 3 (same day). Jan 1, 2, 4 have no holding or activity.
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "buy",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-03",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
      makeTx({
        id: "sell",
        action: InvestmentAction.SELL,
        transactionDate: "2024-01-03",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
    ]);
    priceRepo.query.mockResolvedValue(
      priceRows([{ date: "2024-01-03", price: 100 }]),
    );

    const result = await service.calculateCapitalGainsByDay(userId, {
      startDate: "2024-01-01",
      endDate: "2024-01-05",
    });

    expect(result.map((r) => r.month)).toEqual(["2024-01-03"]);
  });

  it("returns empty when startDate is after endDate", async () => {
    txRepo.find.mockResolvedValue([]);
    const result = await service.calculateCapitalGainsByDay(userId, {
      startDate: "2024-12-01",
      endDate: "2024-01-01",
    });
    expect(result).toEqual([]);
  });
});

describe("PortfolioCalculationService.primeLiveRates", () => {
  let service: PortfolioCalculationService;
  let holdingsRepo: { createQueryBuilder: jest.Mock };
  let exchangeRateService: { getLiveRate: jest.Mock };
  let rawCurrencies: Array<{ currency: string | null }>;

  const makeQueryBuilder = () => ({
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(rawCurrencies),
  });

  beforeEach(async () => {
    rawCurrencies = [];
    holdingsRepo = {
      createQueryBuilder: jest.fn(() => makeQueryBuilder()),
    };
    exchangeRateService = { getLiveRate: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioCalculationService,
        { provide: getRepositoryToken(Holding), useValue: holdingsRepo },
        { provide: getRepositoryToken(SecurityPrice), useValue: {} },
        { provide: getRepositoryToken(InvestmentTransaction), useValue: {} },
        { provide: getRepositoryToken(Account), useValue: {} },
        { provide: ExchangeRateService, useValue: exchangeRateService },
      ],
    }).compile();
    service = module.get(PortfolioCalculationService);
  });

  const account = (currencyCode: string) =>
    ({ id: "a", currencyCode }) as Account;

  it("primes the cache with live rates for account and holding currencies", async () => {
    rawCurrencies = [{ currency: "EUR" }, { currency: "GBP" }];
    exchangeRateService.getLiveRate.mockImplementation(
      async (from: string) =>
        ({ USD: 1.37, EUR: 1.48, GBP: 1.72 })[from] ?? null,
    );
    const rateCache = new Map<string, number>();

    await service.primeLiveRates(
      rateCache,
      [account("USD")],
      ["acct-1"],
      "CAD",
    );

    expect(rateCache.get("USD->CAD")).toBe(1.37);
    expect(rateCache.get("EUR->CAD")).toBe(1.48);
    expect(rateCache.get("GBP->CAD")).toBe(1.72);
  });

  it("skips the default currency and de-duplicates currencies", async () => {
    rawCurrencies = [{ currency: "USD" }, { currency: "CAD" }];
    exchangeRateService.getLiveRate.mockResolvedValue(1.37);
    const rateCache = new Map<string, number>();

    await service.primeLiveRates(
      rateCache,
      [account("USD"), account("CAD")],
      ["acct-1"],
      "CAD",
    );

    // CAD is the default currency, so it is never fetched or cached
    expect(rateCache.has("CAD->CAD")).toBe(false);
    expect(exchangeRateService.getLiveRate).toHaveBeenCalledTimes(1);
    expect(exchangeRateService.getLiveRate).toHaveBeenCalledWith("USD", "CAD");
  });

  it("leaves the cache unset for a currency when no live rate is available", async () => {
    rawCurrencies = [];
    exchangeRateService.getLiveRate.mockResolvedValue(null);
    const rateCache = new Map<string, number>();

    await service.primeLiveRates(rateCache, [account("USD")], [], "CAD");

    expect(rateCache.has("USD->CAD")).toBe(false);
  });

  it("does not query holdings when there are no holdings accounts", async () => {
    exchangeRateService.getLiveRate.mockResolvedValue(1.37);
    const rateCache = new Map<string, number>();

    await service.primeLiveRates(rateCache, [account("USD")], [], "CAD");

    expect(holdingsRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(rateCache.get("USD->CAD")).toBe(1.37);
  });
});

describe("PortfolioCalculationService daily rate index", () => {
  let service: PortfolioCalculationService;
  let exchangeRateService: { getRateHistory: jest.Mock };

  const rate = (
    fromCurrency: string,
    toCurrency: string,
    r: number,
    rateDate: string,
  ) => ({ fromCurrency, toCurrency, rate: r, rateDate });

  beforeEach(async () => {
    exchangeRateService = { getRateHistory: jest.fn().mockResolvedValue([]) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioCalculationService,
        { provide: getRepositoryToken(Holding), useValue: {} },
        { provide: getRepositoryToken(SecurityPrice), useValue: {} },
        { provide: getRepositoryToken(InvestmentTransaction), useValue: {} },
        { provide: getRepositoryToken(Account), useValue: {} },
        { provide: ExchangeRateService, useValue: exchangeRateService },
      ],
    }).compile();
    service = module.get(PortfolioCalculationService);
  });

  describe("buildDailyRateIndex", () => {
    it("returns an empty index and skips the query when no foreign currencies", async () => {
      const index = await service.buildDailyRateIndex(
        ["CAD"],
        "CAD",
        "2026-05-01",
        "2026-06-04",
      );

      expect(index.size).toBe(0);
      expect(exchangeRateService.getRateHistory).not.toHaveBeenCalled();
    });

    it("keeps only pairs involving the default and a requested currency", async () => {
      exchangeRateService.getRateHistory.mockResolvedValue([
        rate("USD", "CAD", 1.3, "2026-06-02"),
        rate("CAD", "USD", 0.74, "2026-06-02"), // reverse direction kept
        rate("EUR", "GBP", 0.85, "2026-06-02"), // unrelated pair dropped
        rate("USD", "EUR", 0.92, "2026-06-02"), // not involving default dropped
      ]);

      const index = await service.buildDailyRateIndex(
        ["USD"],
        "CAD",
        "2026-05-20",
        "2026-06-04",
      );

      expect([...index.keys()].sort()).toEqual(["CAD->USD", "USD->CAD"]);
      expect(exchangeRateService.getRateHistory).toHaveBeenCalledWith(
        "2026-05-20",
        "2026-06-04",
      );
    });

    it("normalizes Date and numeric-string rate values and sorts by date", async () => {
      exchangeRateService.getRateHistory.mockResolvedValue([
        rate("USD", "CAD", "1.50" as unknown as number, "2026-06-03"),
        rate("USD", "CAD", "1.40" as unknown as number, "2026-06-01"),
        {
          fromCurrency: "USD",
          toCurrency: "CAD",
          rate: 1.45,
          rateDate: new Date("2026-06-02T00:00:00.000Z"),
        },
      ]);

      const index = await service.buildDailyRateIndex(
        ["USD"],
        "CAD",
        "2026-05-20",
        "2026-06-04",
      );

      expect(index.get("USD->CAD")).toEqual([
        { date: "2026-06-01", rate: 1.4 },
        { date: "2026-06-02", rate: 1.45 },
        { date: "2026-06-03", rate: 1.5 },
      ]);
    });
  });

  describe("resolveDailyRate", () => {
    it("returns the most recent direct rate at or before the date", async () => {
      exchangeRateService.getRateHistory.mockResolvedValue([
        rate("USD", "CAD", 1.4, "2026-06-01"),
        rate("USD", "CAD", 1.5, "2026-06-03"),
      ]);
      const index = await service.buildDailyRateIndex(
        ["USD"],
        "CAD",
        "2026-05-20",
        "2026-06-04",
      );

      // On 2026-06-02 the most recent rate at or before is the 06-01 close.
      expect(service.resolveDailyRate(index, "USD", "CAD", "2026-06-02")).toBe(
        1.4,
      );
      // On 2026-06-03 the same-day close applies.
      expect(service.resolveDailyRate(index, "USD", "CAD", "2026-06-03")).toBe(
        1.5,
      );
    });

    it("falls back to the earliest known rate when the date precedes all history", async () => {
      exchangeRateService.getRateHistory.mockResolvedValue([
        rate("USD", "CAD", 1.4, "2026-06-01"),
      ]);
      const index = await service.buildDailyRateIndex(
        ["USD"],
        "CAD",
        "2026-05-20",
        "2026-06-04",
      );

      expect(service.resolveDailyRate(index, "USD", "CAD", "2026-05-15")).toBe(
        1.4,
      );
    });

    it("inverts the reverse pair when only that direction is stored", async () => {
      exchangeRateService.getRateHistory.mockResolvedValue([
        rate("CAD", "USD", 0.5, "2026-06-01"),
      ]);
      const index = await service.buildDailyRateIndex(
        ["USD"],
        "CAD",
        "2026-05-20",
        "2026-06-04",
      );

      // 1 USD -> CAD via the reciprocal of the stored CAD->USD rate.
      expect(service.resolveDailyRate(index, "USD", "CAD", "2026-06-02")).toBe(
        2,
      );
    });

    it("returns undefined when the pair is absent in both directions", async () => {
      const index = await service.buildDailyRateIndex(
        ["USD"],
        "CAD",
        "2026-05-20",
        "2026-06-04",
      );

      expect(
        service.resolveDailyRate(index, "USD", "CAD", "2026-06-02"),
      ).toBeUndefined();
    });
  });
});

describe("PortfolioCalculationService.buildAllocationByTag", () => {
  let service: PortfolioCalculationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioCalculationService,
        { provide: getRepositoryToken(Holding), useValue: {} },
        { provide: getRepositoryToken(SecurityPrice), useValue: {} },
        { provide: getRepositoryToken(InvestmentTransaction), useValue: {} },
        { provide: getRepositoryToken(Account), useValue: {} },
        { provide: ExchangeRateService, useValue: {} },
      ],
    }).compile();
    service = module.get(PortfolioCalculationService);
  });

  const securityItem = (symbol: string, value: number) => ({
    name: symbol,
    symbol,
    type: "security" as const,
    value,
    percentage: 0,
    currencyCode: "CAD",
  });

  it("counts a multi-tagged holding in full under each tag (overlapping exposure)", () => {
    const items = [securityItem("VWCE", 100), securityItem("SMH", 50)];
    const tags = new Map([
      ["VWCE", [{ id: "t-aw", name: "All-World", color: "#111111" }]],
      [
        "SMH",
        [
          { id: "t-aw", name: "All-World", color: "#111111" },
          { id: "t-ai", name: "AI", color: null },
        ],
      ],
    ]);

    const result = service.buildAllocationByTag(items, tags, 0, "CAD");

    const allWorld = result.find((r) => r.name === "All-World");
    const ai = result.find((r) => r.name === "AI");
    // VWCE (100) + SMH (50) both touch All-World => 150 (100% of portfolio)
    expect(allWorld?.value).toBe(150);
    expect(allWorld?.percentage).toBe(100);
    // SMH (50) touches AI => 50 (33.33%)
    expect(ai?.value).toBe(50);
    // Overlap means tag percentages sum to more than 100%
    const tagPct = result
      .filter((r) => r.type === "tag")
      .reduce((s, r) => s + r.percentage, 0);
    expect(tagPct).toBeGreaterThan(100);
  });

  it("uses the tag's own colour when set, else a palette colour", () => {
    const items = [securityItem("VWCE", 100), securityItem("SMH", 100)];
    const tags = new Map([
      ["VWCE", [{ id: "t-aw", name: "All-World", color: "#abcdef" }]],
      ["SMH", [{ id: "t-ai", name: "AI", color: null }]],
    ]);

    const result = service.buildAllocationByTag(items, tags, 0, "CAD");

    expect(result.find((r) => r.name === "All-World")?.color).toBe("#abcdef");
    expect(result.find((r) => r.name === "AI")?.color).toMatch(/^#/);
  });

  it("buckets untagged holdings and cash as explicit slices", () => {
    const items = [securityItem("VWCE", 100), securityItem("XYZ", 40)];
    const tags = new Map([
      ["VWCE", [{ id: "t-aw", name: "All-World", color: null }]],
    ]);

    const result = service.buildAllocationByTag(items, tags, 60, "CAD");

    const cash = result.find((r) => r.type === "cash");
    const untagged = result.find((r) => r.type === "untagged");
    expect(cash?.value).toBe(60);
    expect(cash?.percentage).toBe(30);
    expect(untagged?.name).toBe("Untagged");
    expect(untagged?.value).toBe(40);
  });

  it("omits cash and untagged slices when there is nothing to show", () => {
    const items = [securityItem("VWCE", 100)];
    const tags = new Map([
      ["VWCE", [{ id: "t-aw", name: "All-World", color: null }]],
    ]);

    const result = service.buildAllocationByTag(items, tags, 0, "CAD");

    expect(result.some((r) => r.type === "cash")).toBe(false);
    expect(result.some((r) => r.type === "untagged")).toBe(false);
    expect(result).toHaveLength(1);
  });

  it("ignores zero/negative-value securities", () => {
    const items = [securityItem("VWCE", 0), securityItem("SMH", 100)];
    const tags = new Map([
      ["VWCE", [{ id: "t-aw", name: "All-World", color: null }]],
      ["SMH", [{ id: "t-ai", name: "AI", color: null }]],
    ]);

    const result = service.buildAllocationByTag(items, tags, 0, "CAD");

    expect(result.some((r) => r.name === "All-World")).toBe(false);
    expect(result.find((r) => r.name === "AI")?.value).toBe(100);
  });

  it("reconciles to ~100% when cash is negative (margin/loan is not in the base)", () => {
    // Regression for #842: a negative cash balance must not be folded into the
    // denominator. Here a single tag (Equities) plus the disjoint Untagged
    // bucket would sum to 139% of the net portfolio value (932 + 458 vs a net
    // of 1110). The drawn slices must instead share the base 932 + 458 = 1390.
    const items = [securityItem("AKC", 932), securityItem("XYZ", 458)];
    const tags = new Map([
      ["AKC", [{ id: "t-eq", name: "Equities", color: null }]],
    ]);

    const result = service.buildAllocationByTag(items, tags, -280, "CAD");

    // Negative cash is not drawn as a slice.
    expect(result.some((r) => r.type === "cash")).toBe(false);

    const equities = result.find((r) => r.name === "Equities");
    const untagged = result.find((r) => r.type === "untagged");
    expect(equities?.percentage).toBeCloseTo((932 / 1390) * 100, 5);
    expect(untagged?.percentage).toBeCloseTo((458 / 1390) * 100, 5);
    // Disjoint tag + Untagged now reconcile, instead of totalling 139%.
    expect(
      (equities?.percentage ?? 0) + (untagged?.percentage ?? 0),
    ).toBeCloseTo(100, 5);
  });
});

describe("PortfolioCalculationService.buildAllocationByTagKey", () => {
  let service: PortfolioCalculationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioCalculationService,
        { provide: getRepositoryToken(Holding), useValue: {} },
        { provide: getRepositoryToken(SecurityPrice), useValue: {} },
        { provide: getRepositoryToken(InvestmentTransaction), useValue: {} },
        { provide: getRepositoryToken(Account), useValue: {} },
        { provide: ExchangeRateService, useValue: {} },
      ],
    }).compile();
    service = module.get(PortfolioCalculationService);
  });

  const securityItem = (symbol: string, value: number) => ({
    name: symbol,
    symbol,
    type: "security" as const,
    value,
    percentage: 0,
    currencyCode: "CAD",
  });

  it("aggregates security value by the value of the given key", () => {
    // country:usa is one tag applied to two securities; poland and germany one
    // each. With equal values that is 50% usa, 25% poland, 25% germany.
    const items = [
      securityItem("A", 100),
      securityItem("B", 100),
      securityItem("C", 100),
      securityItem("D", 100),
    ];
    const tags = new Map([
      ["A", [{ id: "t-usa", name: "country:usa", color: null }]],
      ["B", [{ id: "t-usa", name: "country:usa", color: null }]],
      ["C", [{ id: "t-pl", name: "country:poland", color: null }]],
      ["D", [{ id: "t-de", name: "country:germany", color: null }]],
    ]);

    const result = service.buildAllocationByTagKey(
      items,
      tags,
      0,
      "CAD",
      "country",
    );

    expect(result.find((r) => r.name === "usa")?.value).toBe(200);
    expect(result.find((r) => r.name === "usa")?.percentage).toBeCloseTo(50, 5);
    expect(result.find((r) => r.name === "poland")?.percentage).toBeCloseTo(
      25,
      5,
    );
    expect(result.find((r) => r.name === "germany")?.percentage).toBeCloseTo(
      25,
      5,
    );
    // No cash, every security assigned -> reconciles to 100%.
    expect(result.reduce((s, r) => s + r.percentage, 0)).toBeCloseTo(100, 5);
  });

  it("matches the key case-insensitively and ignores other keys", () => {
    const items = [securityItem("A", 100), securityItem("B", 100)];
    const tags = new Map([
      [
        "A",
        [
          { id: "t1", name: "Country:USA", color: null },
          { id: "t2", name: "sector:tech", color: null },
        ],
      ],
      ["B", [{ id: "t3", name: "COUNTRY:usa", color: null }]],
    ]);

    const result = service.buildAllocationByTagKey(
      items,
      tags,
      0,
      "CAD",
      "country",
    );

    // Both securities are "usa" (case-folded), summing to 200 / 100%.
    expect(result.find((r) => r.name === "USA")?.value).toBe(200);
    expect(result.some((r) => r.name === "tech")).toBe(false);
  });

  it("puts securities with no value for the key into Untagged (incl. bare key:)", () => {
    const items = [
      securityItem("A", 100),
      securityItem("B", 40),
      securityItem("C", 60),
    ];
    const tags = new Map([
      ["A", [{ id: "t-usa", name: "country:usa", color: null }]],
      ["B", [{ id: "t-bare", name: "country:", color: null }]], // key, no value
      ["C", [{ id: "t-sec", name: "sector:tech", color: null }]], // key absent
    ]);

    const result = service.buildAllocationByTagKey(
      items,
      tags,
      0,
      "CAD",
      "country",
    );

    expect(result.find((r) => r.name === "usa")?.value).toBe(100);
    const untagged = result.find((r) => r.type === "untagged");
    expect(untagged?.value).toBe(100); // 40 (bare) + 60 (no country tag)
  });

  it("counts a mixed holding under each of its values (overlapping exposure)", () => {
    const items = [securityItem("MIX", 100), securityItem("US", 100)];
    const tags = new Map([
      [
        "MIX",
        [
          { id: "t-usa", name: "country:usa", color: null },
          { id: "t-pl", name: "country:poland", color: null },
        ],
      ],
      ["US", [{ id: "t-usa", name: "country:usa", color: null }]],
    ]);

    const result = service.buildAllocationByTagKey(
      items,
      tags,
      0,
      "CAD",
      "country",
    );

    // MIX counts under both; usa = 100 (MIX) + 100 (US) = 200, poland = 100.
    expect(result.find((r) => r.name === "usa")?.value).toBe(200);
    expect(result.find((r) => r.name === "poland")?.value).toBe(100);
    // Overlap pushes the total past 100%.
    expect(result.reduce((s, r) => s + r.percentage, 0)).toBeGreaterThan(100);
  });

  it("keeps cash in the denominator and reconciles with negative cash excluded", () => {
    const items = [securityItem("A", 140)];
    const tagsPositive = new Map([
      ["A", [{ id: "t-usa", name: "country:usa", color: null }]],
    ]);

    const withCash = service.buildAllocationByTagKey(
      items,
      tagsPositive,
      60,
      "CAD",
      "country",
    );
    expect(withCash.find((r) => r.type === "cash")?.percentage).toBeCloseTo(
      30,
      5,
    );
    expect(withCash.find((r) => r.name === "usa")?.percentage).toBeCloseTo(
      70,
      5,
    );

    const withNegCash = service.buildAllocationByTagKey(
      items,
      tagsPositive,
      -40,
      "CAD",
      "country",
    );
    expect(withNegCash.some((r) => r.type === "cash")).toBe(false);
    expect(withNegCash.find((r) => r.name === "usa")?.percentage).toBeCloseTo(
      100,
      5,
    );
  });
});

describe("PortfolioCalculationService.buildAllocation", () => {
  let service: PortfolioCalculationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioCalculationService,
        { provide: getRepositoryToken(Holding), useValue: {} },
        { provide: getRepositoryToken(SecurityPrice), useValue: {} },
        { provide: getRepositoryToken(InvestmentTransaction), useValue: {} },
        { provide: getRepositoryToken(Account), useValue: {} },
        { provide: ExchangeRateService, useValue: {} },
      ],
    }).compile();
    service = module.get(PortfolioCalculationService);
  });

  const holdingWithValue = (
    id: string,
    securityId: string,
    symbol: string,
    marketValue: number,
  ): HoldingWithMarketValue =>
    ({
      id,
      accountId: "acct-1",
      securityId,
      symbol,
      name: symbol,
      securityType: "STOCK",
      currencyCode: "CAD",
      quantity: 1,
      averageCost: 0,
      costBasis: 0,
      costBasisAccountCurrency: 0,
      currentPrice: marketValue,
      marketValue,
      gainLoss: null,
      gainLossPercent: null,
    }) as HoldingWithMarketValue;

  const holdingRow = (id: string, securityId: string) =>
    ({
      id,
      securityId,
      security: { currencyCode: "CAD" },
    }) as unknown as Holding;

  it("measures by-security slices against the drawn total, not the net value when cash is negative", async () => {
    // Regression for #842 (by-security parity): a negative cash balance must
    // not shrink the denominator. Slices must share the base 932 + 458 = 1390
    // and reconcile to ~100%, rather than being inflated against a net 1110.
    const sortedHoldings = [
      holdingWithValue("h1", "s1", "AKC", 932),
      holdingWithValue("h2", "s2", "XYZ", 458),
    ];
    const holdings = [holdingRow("h1", "s1"), holdingRow("h2", "s2")];

    const result = await service.buildAllocation(
      sortedHoldings,
      holdings,
      -280,
      "CAD",
      new Map<string, number>(),
    );

    expect(result.some((r) => r.type === "cash")).toBe(false);
    const securityPctTotal = result
      .filter((r) => r.type === "security")
      .reduce((sum, r) => sum + r.percentage, 0);
    expect(securityPctTotal).toBeCloseTo(100, 5);
    expect(result.find((r) => r.symbol === "AKC")?.percentage).toBeCloseTo(
      (932 / 1390) * 100,
      5,
    );
  });

  it("keeps positive cash in the base so slices sum to ~100%", async () => {
    const sortedHoldings = [holdingWithValue("h1", "s1", "AKC", 140)];
    const holdings = [holdingRow("h1", "s1")];

    const result = await service.buildAllocation(
      sortedHoldings,
      holdings,
      60,
      "CAD",
      new Map<string, number>(),
    );

    // base = 140 + 60 = 200
    expect(result.find((r) => r.type === "cash")?.percentage).toBeCloseTo(
      30,
      5,
    );
    expect(result.find((r) => r.symbol === "AKC")?.percentage).toBeCloseTo(
      70,
      5,
    );
  });
});
