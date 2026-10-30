import {
  CategorisedAccounts,
  PortfolioCalculationService,
  ReplayedLot,
} from "./portfolio-calculation.service";
import { Holding } from "./entities/holding.entity";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "./entities/investment-transaction.entity";
import { Account, AccountSubType } from "../accounts/entities/account.entity";
import { HoldingWithMarketValue } from "./portfolio.service";
import { SecurityValueByAccount } from "../bonds/bond-valuation.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

/**
 * Build the service on scoped-db mocks. `repos` maps entity -> mock repository;
 * `rawQuery` backs the raw statements the service issues through
 * `manager.query`.
 */
function buildService(
  repos: Array<[unknown, Record<string, jest.Mock>]>,
  exchangeRateService: unknown,
  rawQuery?: jest.Mock,
  bondValuation: unknown = { valueByAccount: jest.fn() },
): PortfolioCalculationService {
  const { manager, dataSource } = createScopedDbMocks(repos as never);
  manager.query.mockImplementation((sql: string, params?: unknown[]) =>
    rawQuery ? rawQuery(sql, params) : Promise.resolve([]),
  );
  return new PortfolioCalculationService(
    dataSource as never,
    exchangeRateService as never,
    bondValuation as never,
  );
}

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

  beforeEach(() => {
    txRepo = { find: jest.fn() };
    service = buildService([[InvestmentTransaction, txRepo as never]], {});
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

  describe("a position holding shares of unknown cost", () => {
    const addShares = makeTx({
      id: "add",
      action: InvestmentAction.ADD_SHARES,
      transactionDate: "2024-01-05",
      quantity: 10,
      price: null as never,
      totalAmount: 0,
    });
    const buy = (id: string, date: string) =>
      makeTx({
        id,
        action: InvestmentAction.BUY,
        transactionDate: date,
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      });
    const sell = (id: string, date: string, quantity: number, total: number) =>
      makeTx({
        id,
        action: InvestmentAction.SELL,
        transactionDate: date,
        quantity,
        price: total / quantity,
        totalAmount: total,
      });

    it("reports a sale's cost and gain as unknown, with the proceeds still known", async () => {
      // 10 shares of unknown cost plus 10 bought for 1,000: selling all 20 for
      // 3,000 would read as a 2,000 gain against a 1,000 basis that is only
      // the priced half.
      txRepo.find.mockResolvedValue([
        addShares,
        buy("buy", "2024-02-01"),
        sell("sell", "2024-03-01", 20, 3000),
      ]);

      const result = await service.calculateRealizedGains(userId);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        transactionId: "sell",
        proceeds: 3000,
        costBasis: null,
        realizedGain: null,
      });
    });

    it("knows the basis again once the position has gone back to zero", async () => {
      txRepo.find.mockResolvedValue([
        addShares,
        sell("sell-1", "2024-02-01", 10, 1200),
        buy("buy", "2024-03-01"),
        sell("sell-2", "2024-04-01", 10, 1500),
      ]);

      const result = await service.calculateRealizedGains(userId);

      expect(result.map((r) => r.realizedGain)).toEqual([null, 500]);
      expect(result[1].costBasis).toBe(1000);
    });
  });

  it("measures a later sale against the basis a return of capital left (#1800)", async () => {
    // Buy 100 @ 50 = 5,000; 1,000 of capital returned leaves 4,000 of basis;
    // selling all 100 for 6,000 realizes 2,000, not 1,000.
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
        id: "roc",
        action: InvestmentAction.RETURN_OF_CAPITAL,
        transactionDate: "2024-03-10",
        quantity: null as never,
        price: null as never,
        totalAmount: 1000,
      }),
      makeTx({
        id: "sell",
        action: InvestmentAction.SELL,
        transactionDate: "2024-06-10",
        quantity: 100,
        price: 60,
        totalAmount: 6000,
      }),
    ]);

    const result = await service.calculateRealizedGains(userId);

    // Within the basis, the distribution realizes nothing on its own.
    expect(result.map((r) => r.transactionId)).toEqual(["sell"]);
    expect(result[0].action).toBe(InvestmentAction.SELL);
    expect(result[0].costBasis).toBe(4000);
    expect(result[0].realizedGain).toBe(2000);
  });

  it("does not convert a return of capital at par when its stored rate is 0", async () => {
    // A 0 rate cannot convert the distribution, so it is not taken off the
    // basis at 1:1 -- the same as an unpriced acquisition, which this replay
    // leaves out of the basis rather than guessing.
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "buy",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 50,
        totalAmount: 500,
      }),
      makeTx({
        id: "roc",
        action: InvestmentAction.RETURN_OF_CAPITAL,
        transactionDate: "2024-03-10",
        totalAmount: 700,
        exchangeRate: 0,
      }),
    ]);

    const result = await service.calculateRealizedGains(userId);

    // At par it would have realized 200 beyond the 500 basis.
    expect(result).toEqual([]);
  });

  it("realizes the part of a return of capital the basis cannot absorb", async () => {
    // 10 shares that cost 500 receive 700: the basis stops at zero and the
    // 200 beyond it is a gain on the distribution's date, with no shares sold.
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "buy",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 50,
        totalAmount: 500,
      }),
      makeTx({
        id: "roc",
        action: InvestmentAction.RETURN_OF_CAPITAL,
        transactionDate: "2024-03-10",
        totalAmount: 700,
      }),
    ]);

    const result = await service.calculateRealizedGains(userId);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      transactionId: "roc",
      action: InvestmentAction.RETURN_OF_CAPITAL,
      quantity: 0,
      proceeds: 700,
      costBasis: 500,
      realizedGain: 200,
    });
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

  it("includes the acquisition commission in the cost basis a sale is measured against (P5-006)", async () => {
    // The audit's worked example. Buy 10 at 100 with 10 commission -- the cash
    // debit is 1,010 -- then sell all 10 at 110 with no sell commission.
    //
    // Basis 1,000 reports a realized gain of 100 and taxes the commission as
    // profit. The basis is 1,010, so the gain is 90.
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "b1",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        commission: 10,
        totalAmount: 1010,
      }),
      makeTx({
        id: "s1",
        action: InvestmentAction.SELL,
        transactionDate: "2024-06-10",
        quantity: 10,
        price: 110,
        commission: 0,
        totalAmount: 1100,
      }),
    ]);

    const result = await service.calculateRealizedGains(userId);
    expect(result).toHaveLength(1);
    expect(result[0].costBasis).toBe(1010);
    expect(result[0].realizedGain).toBe(90);
  });

  it("relieves a commissioned basis proportionally on a partial sale", async () => {
    // Buy 10 at 100 + 10 commission = 1,010 basis, 101.00 per share. Selling 4
    // relieves 404, not 400.
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "b1",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        commission: 10,
        totalAmount: 1010,
      }),
      makeTx({
        id: "s1",
        action: InvestmentAction.SELL,
        transactionDate: "2024-06-10",
        quantity: 4,
        price: 120,
        commission: 0,
        totalAmount: 480,
      }),
    ]);

    const result = await service.calculateRealizedGains(userId);
    expect(result[0].costBasis).toBe(404);
    expect(result[0].realizedGain).toBe(76); // 480 - 404
  });

  it("converts the commission at the trade's rate, not separately", async () => {
    // 10 @ 100 USD + 10 USD commission at 1.3 -> (1000 + 10) * 1.3 = 1313 CAD.
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "b1",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-01",
        quantity: 10,
        price: 100,
        commission: 10,
        totalAmount: 1010,
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
    expect(result[0].costBasis).toBe(1313);
    expect(result[0].realizedGain).toBe(712); // 2025 - 1313
  });

  it("does not treat an unpriced acquisition as a free one", async () => {
    // `price` is nullable. Folding null to 0 gave the position a basis of zero
    // and reported the entire proceeds as gain.
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "b1",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: null as never,
        commission: 0,
        totalAmount: 0,
      }),
      makeTx({
        id: "s1",
        action: InvestmentAction.SELL,
        transactionDate: "2024-06-10",
        quantity: 10,
        price: 110,
        totalAmount: 1100,
      }),
    ]);

    const result = await service.calculateRealizedGains(userId);
    // The shares still joined the position, so the sale is still reported --
    // but no cost was invented for them, and the gain is unknown, not 1,100.
    expect(result[0].proceeds).toBe(1100);
    expect(result[0].costBasis).toBeNull();
    expect(result[0].realizedGain).toBeNull();
  });

  it("multiplies the position by a split ratio when relieving basis", async () => {
    // Buy 10 @ 100 (basis 1,000), 2-for-1 split -> 20 shares, basis unchanged,
    // so 50 per share. Selling all 20 at 60 realizes 1,200 - 1,000 = 200.
    // Additive split semantics would have left 12 shares and mispriced basis.
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "b1",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
      makeTx({
        id: "sp1",
        action: InvestmentAction.SPLIT,
        transactionDate: "2024-03-01",
        quantity: 2,
      }),
      makeTx({
        id: "s1",
        action: InvestmentAction.SELL,
        transactionDate: "2024-06-10",
        quantity: 20,
        price: 60,
        totalAmount: 1200,
      }),
    ]);

    const result = await service.calculateRealizedGains(userId);
    expect(result[0].costBasis).toBe(1000);
    expect(result[0].realizedGain).toBe(200);
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

  it("reports an unknown gain when a SELL has no prior position", async () => {
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
    // Shares that were never recorded as bought have no known cost: the
    // whole 500 is not a gain, it is a gain that cannot be stated.
    expect(result[0].costBasis).toBeNull();
    expect(result[0].proceeds).toBe(500);
    expect(result[0].realizedGain).toBeNull();
    expect(result[0].basisGap).toBe("quantity_only_action");
  });

  it("takes the whole sale off the quantity and marks the oversold part unknown", async () => {
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "buy",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-01",
        quantity: 5,
        price: 10,
        totalAmount: 50,
      }),
      makeTx({
        id: "oversell",
        action: InvestmentAction.SELL,
        transactionDate: "2024-06-01",
        quantity: 8,
        price: 20,
        totalAmount: 160,
      }),
    ]);

    const result = await service.calculateRealizedGains(userId);
    expect(result).toHaveLength(1);
    expect(result[0].realizedGain).toBeNull();
    expect(result[0].basisGap).toBe("quantity_only_action");
  });

  describe("a transferred-in lot (A26-M21)", () => {
    const destinationId = "acct-2";
    const transferAt = new Date("2024-02-10T12:00:00Z");
    const cadAccount = (id: string) => ({
      id,
      name: id,
      currencyCode: "CAD",
    });

    // USD security bought in CAD account A at 1.37, moved to CAD account B
    // (carried per-share figure 100, rate 1 -- what transferSecurity writes),
    // sold in B at 1.37.
    const buyInA = () =>
      makeTx({
        id: "buy",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
        exchangeRate: 1.37,
      });
    const outInA = () =>
      makeTx({
        id: "out",
        action: InvestmentAction.TRANSFER_OUT,
        transactionDate: "2024-02-10",
        createdAt: transferAt,
        quantity: 10,
        price: 100,
        linkedTransactionId: "in",
      });
    const inInB = (currencyCode = "CAD") =>
      makeTx({
        id: "in",
        accountId: destinationId,
        action: InvestmentAction.TRANSFER_IN,
        transactionDate: "2024-02-10",
        createdAt: transferAt,
        quantity: 10,
        price: 100,
        linkedTransactionId: "out",
        account: { ...cadAccount(destinationId), currencyCode } as never,
      });
    const sellInB = () =>
      makeTx({
        id: "sell",
        accountId: destinationId,
        action: InvestmentAction.SELL,
        transactionDate: "2024-03-10",
        quantity: 10,
        price: 140,
        totalAmount: 1400,
        exchangeRate: 1.37,
        account: cadAccount(destinationId) as never,
      });

    it("is sold against the account-currency basis the OUT leg released, not the carried figure at rate 1", async () => {
      // The IN leg is listed first: the two legs share `created_at`.
      txRepo.find.mockResolvedValue([buyInA(), inInB(), outInA(), sellInB()]);

      const result = await service.calculateRealizedGains(userId);

      expect(result).toHaveLength(1);
      // 10 x 140 x 1.37 = 1,918 of proceeds against 10 x 100 x 1.37 = 1,370.
      expect(result[0].costBasis).toBe(1370);
      expect(result[0].realizedGain).toBe(548);
    });

    it("keeps the carried basis when the caller asks only about the destination", async () => {
      txRepo.find.mockResolvedValue([buyInA(), outInA(), inInB(), sellInB()]);

      const result = await service.calculateRealizedGains(userId, {
        accountIds: [destinationId],
      });

      // The source's rows are read for the replay and only the results are
      // filtered, so the query itself carries no account filter.
      expect(txRepo.find.mock.calls[0][0].where).not.toHaveProperty(
        "accountId",
      );
      expect(result).toHaveLength(1);
      expect(result[0].accountId).toBe(destinationId);
      expect(result[0].realizedGain).toBe(548);
    });

    it("carries nothing from a source whose basis holds an unpriced lot", async () => {
      // An unpriced BUY makes the source's basis a subtotal: carrying it would
      // report a confident cost for shares the ledger never priced.
      const unpriced = makeTx({
        id: "unpriced",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-11",
        quantity: 5,
        price: null as never,
        totalAmount: 0,
        exchangeRate: 1.37,
      });
      txRepo.find.mockResolvedValue([
        buyInA(),
        unpriced,
        outInA(),
        inInB(),
        sellInB(),
      ]);

      const result = await service.calculateRealizedGains(userId);

      // The IN leg's own row: 10 x 100 at rate 1.
      expect(result[0].costBasis).toBe(1000);
    });

    it("falls back to the leg's own price when the two accounts differ in currency (residual)", async () => {
      txRepo.find.mockResolvedValue([
        buyInA(),
        outInA(),
        inInB("USD"),
        sellInB(),
      ]);

      const result = await service.calculateRealizedGains(userId);

      // The leg's own 10 x 100 x 1 -- the pre-existing behaviour, named as the
      // residual rather than guessed at.
      expect(result[0].costBasis).toBe(1000);
    });

    it("falls back to the leg's own price when the OUT leg is not in the rows", async () => {
      txRepo.find.mockResolvedValue([inInB(), sellInB()]);

      const result = await service.calculateRealizedGains(userId);

      expect(result[0].costBasis).toBe(1000);
    });
  });
});

describe("PortfolioCalculationService.calculateCapitalGainsByMonth", () => {
  let service: PortfolioCalculationService;
  let txRepo: { find: jest.Mock };
  let priceRepo: { query: jest.Mock };
  let exchangeRateService: { resolveStoredRate: jest.Mock };

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

  beforeEach(() => {
    txRepo = { find: jest.fn() };
    priceRepo = { query: jest.fn().mockResolvedValue([]) };
    exchangeRateService = { resolveStoredRate: storedRateDouble() };
    service = buildService(
      [[InvestmentTransaction, txRepo as never]],
      exchangeRateService,
      priceRepo.query,
    );
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

  it("nets a return of capital against the price it lowered (#1800)", async () => {
    // 100 shares bought at 50; in January the fund pays back 2 a share (200)
    // and its price falls from 50 to 48 by exactly that. Nothing was gained
    // or lost: the 200 is capital coming back, and the basis falls with it.
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
        id: "roc",
        action: InvestmentAction.RETURN_OF_CAPITAL,
        transactionDate: "2024-01-15",
        totalAmount: 200,
      }),
    ]);
    priceRepo.query.mockResolvedValue(
      priceRows([
        { date: "2023-12-31", price: 50 },
        { date: "2024-01-31", price: 48 },
      ]),
    );

    const result = await service.calculateCapitalGainsByMonth(userId, {
      startDate: "2024-01-01",
      endDate: "2024-01-31",
    });

    const jan = result.find((r) => r.month === "2024-01")!;
    expect(jan.sells).toBe(200);
    expect(jan.totalCapitalGain).toBe(0);
    expect(jan.realizedGain).toBe(0);
    expect(jan.unrealizedGain).toBe(0);
  });

  it("reports the period unknown when a return of capital's stored rate is 0, never converting it at par", async () => {
    // `Number(rate) || 1` would turn the 0 into 1 and report a confident
    // figure; a rate that cannot convert is unknown (AGENTS.md: rate 1 means
    // same currency, never no rate found).
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
        id: "roc",
        action: InvestmentAction.RETURN_OF_CAPITAL,
        transactionDate: "2024-01-15",
        totalAmount: 200,
        exchangeRate: 0,
      }),
    ]);
    priceRepo.query.mockResolvedValue(
      priceRows([
        { date: "2023-12-31", price: 50 },
        { date: "2024-01-31", price: 48 },
      ]),
    );

    const result = await service.calculateCapitalGainsByMonth(userId, {
      startDate: "2024-01-01",
      endDate: "2024-01-31",
    });

    const jan = result.find((r) => r.month === "2024-01")!;
    expect(jan.totalCapitalGain).toBeNull();
    expect(jan.realizedGain).toBeNull();
    expect(jan.unrealizedGain).toBeNull();
  });

  it("carries a return of capital from before the window into the basis a sale in it is measured against", async () => {
    // Buy 100 @ 50 and get 1,000 back, both before January: the basis entering
    // the window is 4,000, so selling all 100 for 6,000 realizes 2,000.
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "buy",
        action: InvestmentAction.BUY,
        transactionDate: "2023-11-15",
        quantity: 100,
        price: 50,
        totalAmount: 5000,
      }),
      makeTx({
        id: "roc",
        action: InvestmentAction.RETURN_OF_CAPITAL,
        transactionDate: "2023-12-15",
        totalAmount: 1000,
      }),
      makeTx({
        id: "sell",
        action: InvestmentAction.SELL,
        transactionDate: "2024-01-20",
        quantity: 100,
        price: 60,
        totalAmount: 6000,
      }),
    ]);
    priceRepo.query.mockResolvedValue(
      priceRows([
        { date: "2023-12-31", price: 55 },
        { date: "2024-01-31", price: 60 },
      ]),
    );

    const result = await service.calculateCapitalGainsByMonth(userId, {
      startDate: "2024-01-01",
      endDate: "2024-01-31",
    });

    const jan = result.find((r) => r.month === "2024-01")!;
    expect(jan.realizedGain).toBe(2000);
  });

  it("reports gains as unknown when the basis carries an unpriced acquisition", async () => {
    // An unpriced BUY joins the position with an unknown cost. `?? 0` replayed
    // it as free, so the eventual SELL reported the full proceeds as confident
    // realized gain -- while getCostBasis marks the identical row
    // `unpriced_acquisition`. Unknown, not zero: the gain fields go null and
    // `buys` stays the known subtotal of the priced acquisitions.
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "buy-unpriced",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: null as never,
        totalAmount: 0,
      }),
      makeTx({
        id: "sell",
        action: InvestmentAction.SELL,
        transactionDate: "2024-01-20",
        quantity: 10,
        price: 110,
        totalAmount: 1100,
      }),
    ]);
    priceRepo.query.mockResolvedValue(
      priceRows([
        { date: "2023-12-31", price: 100 },
        { date: "2024-01-31", price: 110 },
      ]),
    );

    const result = await service.calculateCapitalGainsByMonth(userId, {
      startDate: "2024-01-01",
      endDate: "2024-01-31",
    });

    expect(result).toHaveLength(1);
    const jan = result[0];
    expect(jan.realizedGain).toBeNull();
    expect(jan.totalCapitalGain).toBeNull();
    expect(jan.unrealizedGain).toBeNull();
    expect(jan.buys).toBe(0);
    expect(jan.sells).toBe(1100);
  });

  it("a closed position clears the unknown-basis state for later periods", async () => {
    // Once the position holding the unknown lot is fully disposed of, a fresh
    // priced position's gains are knowable again -- an empty position holds a
    // known zero basis.
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "buy-unpriced",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: null as never,
        totalAmount: 0,
      }),
      makeTx({
        id: "sell-all",
        action: InvestmentAction.SELL,
        transactionDate: "2024-01-20",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
      makeTx({
        id: "buy-priced",
        action: InvestmentAction.BUY,
        transactionDate: "2024-02-05",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
      makeTx({
        id: "sell-2",
        action: InvestmentAction.SELL,
        transactionDate: "2024-02-20",
        quantity: 10,
        price: 110,
        totalAmount: 1100,
      }),
    ]);
    priceRepo.query.mockResolvedValue(
      priceRows([
        { date: "2023-12-31", price: 100 },
        { date: "2024-01-31", price: 100 },
        { date: "2024-02-29", price: 110 },
      ]),
    );

    const result = await service.calculateCapitalGainsByMonth(userId, {
      startDate: "2024-01-01",
      endDate: "2024-02-29",
    });

    const jan = result.find((r) => r.month === "2024-01")!;
    const feb = result.find((r) => r.month === "2024-02")!;
    expect(jan.realizedGain).toBeNull();
    // Feb's position was acquired at a known 1,000 and sold for 1,100.
    expect(feb.realizedGain).toBe(100);
    expect(feb.totalCapitalGain).toBe(100);
  });

  it("reports unknown boundary values when the security currency cannot be converted (P5-009)", async () => {
    // A USD security in a CAD account with no USD/CAD rate in either direction.
    // The security's value at each month boundary is therefore unknown, so the
    // capital gain measured between them is unknown too.
    //
    // The rate used to fall back to 1, which valued 100 USD shares as 100 CAD
    // and produced a confident gain figure from an arbitrary conversion.
    exchangeRateService.resolveStoredRate = storedRateDouble();
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "buy",
        action: InvestmentAction.BUY,
        transactionDate: "2023-12-15",
        quantity: 100,
        price: 50,
        totalAmount: 5000,
        security: {
          id: securityId,
          symbol: "ABC",
          name: "ABC Corp",
          currencyCode: "USD",
        },
      } as never),
    ]);
    priceRepo.query.mockResolvedValue(
      priceRows([
        { date: "2023-12-31", price: 50 },
        { date: "2024-01-31", price: 55 },
      ]),
    );

    const result = await service.calculateCapitalGainsByMonth(userId, {
      startDate: "2024-01-01",
      endDate: "2024-01-31",
    });

    expect(result).toHaveLength(1);
    const jan = result[0];
    expect(jan.startValue).toBeNull();
    expect(jan.endValue).toBeNull();
    expect(jan.unrealizedGain).toBeNull();
    expect(jan.totalCapitalGain).toBeNull();
    // Realized gain comes from each transaction's own stored rate, so it stays
    // known -- there were no sales, and zero is the right answer for that.
    expect(jan.realizedGain).toBe(0);
  });

  it("resolves an unrated pair once per boundary date, however many securities carry it", async () => {
    // The cache held only found rates, so a refusal was re-resolved (and
    // re-warned) for every security group in that currency. An absence is an
    // answer and is cached like one. The cache is now keyed by boundary date
    // too (the fold values each boundary at that date's FX, P5), so the pair is
    // resolved once PER DISTINCT boundary date -- here the two January
    // boundaries, 2023-12-31 and 2024-01-31 -- and shared across both security
    // groups rather than re-resolved four times.
    exchangeRateService.resolveStoredRate = storedRateDouble();
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "buy-a",
        securityId: "sec-a",
        action: InvestmentAction.BUY,
        transactionDate: "2023-12-15",
        quantity: 100,
        price: 50,
        totalAmount: 5000,
        security: {
          id: "sec-a",
          symbol: "AAA",
          name: "AAA Corp",
          currencyCode: "USD",
        },
      } as never),
      makeTx({
        id: "buy-b",
        securityId: "sec-b",
        action: InvestmentAction.BUY,
        transactionDate: "2023-12-16",
        quantity: 50,
        price: 20,
        totalAmount: 1000,
        security: {
          id: "sec-b",
          symbol: "BBB",
          name: "BBB Corp",
          currencyCode: "USD",
        },
      } as never),
    ]);
    priceRepo.query.mockResolvedValue(
      priceRows([
        { date: "2023-12-31", price: 50, securityId: "sec-a" },
        { date: "2024-01-31", price: 55, securityId: "sec-a" },
        { date: "2023-12-31", price: 20, securityId: "sec-b" },
        { date: "2024-01-31", price: 22, securityId: "sec-b" },
      ]),
    );

    await service.calculateCapitalGainsByMonth(userId, {
      startDate: "2024-01-01",
      endDate: "2024-01-31",
    });

    const usdCad = exchangeRateService.resolveStoredRate.mock.calls.filter(
      (call: unknown[]) => call[0] === "USD" && call[1] === "CAD",
    );
    // Two distinct boundary dates, each resolved once -- not four times (two
    // securities * two dates), which is what dropping the cache would cost.
    const distinctDates = new Set(usdCad.map((call: unknown[]) => call[2]));
    expect(distinctDates).toEqual(new Set(["2023-12-31", "2024-01-31"]));
    expect(usdCad).toHaveLength(2);
  });

  it("still computes gains when the security and account share a currency", async () => {
    // The same-currency path must not be caught by the missing-rate handling:
    // rate 1 is correct here because the codes are equal, and no lookup happens.
    exchangeRateService.resolveStoredRate = storedRateDouble();
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
      ]),
    );

    const result = await service.calculateCapitalGainsByMonth(userId, {
      startDate: "2024-01-01",
      endDate: "2024-01-31",
    });

    expect(result[0].totalCapitalGain).toBe(500);
    expect(result[0].startValue).toBe(5000);
    expect(result[0].endValue).toBe(5500);
  });

  it("values each boundary at that boundary's own accepted FX, not today's (P5)", async () => {
    // 10 units of a USD security held in a PLN account, no trades, price flat at
    // 100 USD. USD/PLN was 4.0 on the period's start boundary (2023-12-31) and
    // 5.0 on its end boundary (2024-01-31), so the PLN value moved
    // 10*100*4 = 4,000 -> 10*100*5 = 5,000: a +1,000 change that is purely the
    // currency's. The old fold resolved USD->PLN ONCE, at todayYMD() in live
    // mode, and multiplied that single rate into both ends, reporting a flat
    // price as a flat value (0) and hiding the FX move entirely.
    const byDate: Record<string, number> = {
      "2023-12-31": 4.0,
      "2024-01-31": 5.0,
    };
    exchangeRateService.resolveStoredRate = jest.fn(
      async (from: string, to: string, onDate: string) => {
        if (from === to) return resolutionFor(1);
        if (from === "USD" && to === "PLN") {
          // Any date the fold did not ask for -- notably today, which the old
          // code used for both ends -- resolves to a distinct rate so the old
          // single-rate behaviour reports a change of 0.
          return resolutionFor(byDate[onDate] ?? 4.5);
        }
        return resolutionFor(null);
      },
    );
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "buy",
        action: InvestmentAction.BUY,
        transactionDate: "2023-12-15",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
        account: { id: accountId, name: "Brokerage", currencyCode: "PLN" },
        security: {
          id: securityId,
          symbol: "ABC",
          name: "ABC Corp",
          currencyCode: "USD",
        },
      } as never),
    ]);
    priceRepo.query.mockResolvedValue(
      priceRows([
        { date: "2023-12-31", price: 100 },
        { date: "2024-01-31", price: 100 },
      ]),
    );

    const result = await service.calculateCapitalGainsByMonth(userId, {
      startDate: "2024-01-01",
      endDate: "2024-01-31",
    });

    expect(result).toHaveLength(1);
    const jan = result[0];
    expect(jan.startValue).toBe(4000);
    expect(jan.endValue).toBe(5000);
    // +1,000, the currency's move on a flat price -- NOT 0 (one rate for both
    // ends) and NOT a figure using either boundary's rate for both.
    expect(jan.totalCapitalGain).toBe(1000);
    expect(jan.unrealizedGain).toBe(1000);

    // The two ends were resolved at their own dates, in historical (non-live)
    // mode, never at todayYMD().
    expect(exchangeRateService.resolveStoredRate).toHaveBeenCalledWith(
      "USD",
      "PLN",
      "2023-12-31",
      { mode: "historical" },
    );
    expect(exchangeRateService.resolveStoredRate).toHaveBeenCalledWith(
      "USD",
      "PLN",
      "2024-01-31",
      { mode: "historical" },
    );
  });

  it("withholds the period when a held position has no price on a boundary it spans (P5)", async () => {
    // 10 units held across January in a same-currency account, but the security
    // has no stored close on or before either boundary. Its market value is then
    // UNKNOWN, so both boundary values and the gain are withheld (null). The old
    // `lookupPrice(...) ?? 0` valued the held position at zero and reported a
    // confident 0 gain.
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "buy",
        action: InvestmentAction.BUY,
        transactionDate: "2023-12-15",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
      }),
    ]);
    // No prices at all for the security.
    priceRepo.query.mockResolvedValue(priceRows([]));

    const result = await service.calculateCapitalGainsByMonth(userId, {
      startDate: "2024-01-01",
      endDate: "2024-01-31",
    });

    expect(result).toHaveLength(1);
    const jan = result[0];
    expect(jan.startQuantity).toBe(10);
    expect(jan.endQuantity).toBe(10);
    expect(jan.startValue).toBeNull();
    expect(jan.endValue).toBeNull();
    expect(jan.totalCapitalGain).toBeNull();
    expect(jan.unrealizedGain).toBeNull();
  });

  it("values a closed (zero-quantity) boundary at 0 without needing a rate (P5)", async () => {
    // A full round-trip within January of a USD security in a PLN account with
    // NO USD/PLN rate available in either direction. The position is zero at both
    // period boundaries, so each boundary value is a genuine zero that needs no
    // rate; the realized figures come from each transaction's own stored rate.
    // The old fold resolved the pair once, got null, and withheld the boundary
    // values even though the position was empty at both ends.
    exchangeRateService.resolveStoredRate = jest.fn(
      async (from: string, to: string) => resolutionFor(from === to ? 1 : null),
    );
    txRepo.find.mockResolvedValue([
      makeTx({
        id: "buy",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
        exchangeRate: 4,
        account: { id: accountId, name: "Brokerage", currencyCode: "PLN" },
        security: {
          id: securityId,
          symbol: "ABC",
          name: "ABC Corp",
          currencyCode: "USD",
        },
      } as never),
      makeTx({
        id: "sell",
        action: InvestmentAction.SELL,
        transactionDate: "2024-01-20",
        quantity: 10,
        price: 110,
        totalAmount: 1100,
        exchangeRate: 4,
        account: { id: accountId, name: "Brokerage", currencyCode: "PLN" },
        security: {
          id: securityId,
          symbol: "ABC",
          name: "ABC Corp",
          currencyCode: "USD",
        },
      } as never),
    ]);
    priceRepo.query.mockResolvedValue(
      priceRows([
        { date: "2023-12-31", price: 100 },
        { date: "2024-01-31", price: 110 },
      ]),
    );

    const result = await service.calculateCapitalGainsByMonth(userId, {
      startDate: "2024-01-01",
      endDate: "2024-01-31",
    });

    expect(result).toHaveLength(1);
    const jan = result[0];
    expect(jan.startQuantity).toBe(0);
    expect(jan.endQuantity).toBe(0);
    // A zero position is worth zero on any date and needs no rate.
    expect(jan.startValue).toBe(0);
    expect(jan.endValue).toBe(0);
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

  describe("a transferred-in lot (A26-M21)", () => {
    const destinationId = "acct-2";
    const transferAt = new Date("2024-02-10T12:00:00Z");
    const accountB = { id: destinationId, name: "B", currencyCode: "CAD" };

    const rows = () => [
      // The destination group is listed first, so it is folded before its
      // source group: the carry cannot depend on group order.
      makeTx({
        id: "in",
        accountId: destinationId,
        action: InvestmentAction.TRANSFER_IN,
        transactionDate: "2024-02-10",
        createdAt: transferAt,
        quantity: 10,
        price: 100,
        linkedTransactionId: "out",
        account: accountB as never,
      }),
      makeTx({
        id: "buy",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
        exchangeRate: 1.37,
      }),
      makeTx({
        id: "out",
        action: InvestmentAction.TRANSFER_OUT,
        transactionDate: "2024-02-10",
        createdAt: transferAt,
        quantity: 10,
        price: 100,
        linkedTransactionId: "in",
      }),
      makeTx({
        id: "sell",
        accountId: destinationId,
        action: InvestmentAction.SELL,
        transactionDate: "2024-03-10",
        quantity: 10,
        price: 140,
        totalAmount: 1400,
        exchangeRate: 1.37,
        account: accountB as never,
      }),
    ];

    it("reports the sale against the carried account-currency basis", async () => {
      txRepo.find.mockResolvedValue(rows());

      const result = await service.calculateCapitalGainsByMonth(userId, {
        startDate: "2024-01-01",
        endDate: "2024-04-30",
      });

      const march = result.find(
        (r) => r.accountId === destinationId && r.month === "2024-03",
      )!;
      // 1,918 of proceeds against 1,370 -- not against 1,000.
      expect(march.realizedGain).toBe(548);
      const february = result.find(
        (r) => r.accountId === destinationId && r.month === "2024-02",
      )!;
      // The transfer leg is a flow at market value (unpriced here: unknown),
      // never the carried basis booked as a purchase.
      expect(february.buys).toBe(0);
      expect(february.totalCapitalGain).toBeNull();
    });

    it("leaves both accounts' capital gain unchanged by a transfer", async () => {
      // 10 shares, basis 80, price 100 throughout, moved A -> B.
      txRepo.find.mockResolvedValue([
        makeTx({
          id: "buy",
          action: InvestmentAction.BUY,
          transactionDate: "2024-01-10",
          quantity: 10,
          price: 80,
          totalAmount: 800,
        }),
        makeTx({
          id: "out",
          action: InvestmentAction.TRANSFER_OUT,
          transactionDate: "2024-02-10",
          createdAt: transferAt,
          quantity: 10,
          price: 80,
          linkedTransactionId: "in",
        }),
        makeTx({
          id: "in",
          accountId: destinationId,
          action: InvestmentAction.TRANSFER_IN,
          transactionDate: "2024-02-10",
          createdAt: transferAt,
          quantity: 10,
          price: 80,
          linkedTransactionId: "out",
          account: accountB as never,
        }),
      ]);
      priceRepo.query.mockResolvedValue(
        priceRows([
          { date: "2024-01-31", price: 100 },
          { date: "2024-02-29", price: 100 },
        ]),
      );

      const result = await service.calculateCapitalGainsByMonth(userId, {
        startDate: "2024-02-01",
        endDate: "2024-02-29",
      });

      const a = result.find((r) => r.accountId === accountId)!;
      const b = result.find((r) => r.accountId === destinationId)!;
      expect(a.totalCapitalGain).toBe(0);
      expect(b.totalCapitalGain).toBe(0);
    });

    it("keeps the carried basis when only the destination is requested", async () => {
      txRepo.find.mockResolvedValue(rows());

      const result = await service.calculateCapitalGainsByMonth(userId, {
        accountIds: [destinationId],
        startDate: "2024-01-01",
        endDate: "2024-04-30",
      });

      expect(txRepo.find.mock.calls[0][0].where).not.toHaveProperty(
        "accountId",
      );
      expect(result.every((r) => r.accountId === destinationId)).toBe(true);
      const march = result.find((r) => r.month === "2024-03")!;
      expect(march.realizedGain).toBe(548);
    });
  });
});

describe("PortfolioCalculationService.calculateCapitalGainsByDay", () => {
  let service: PortfolioCalculationService;
  let txRepo: { find: jest.Mock };
  let priceRepo: { query: jest.Mock };
  let exchangeRateService: { resolveStoredRate: jest.Mock };

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

  beforeEach(() => {
    txRepo = { find: jest.fn() };
    priceRepo = { query: jest.fn().mockResolvedValue([]) };
    exchangeRateService = { resolveStoredRate: storedRateDouble() };
    service = buildService(
      [[InvestmentTransaction, txRepo as never]],
      exchangeRateService,
      priceRepo.query,
    );
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

describe("one replay behind realized gains, lots and the capital-gains periods (#1859)", () => {
  const userId = "user-1";
  const brokerage = "acct-1";
  const usdChequing = "chq-usd";
  const cadChequing = "chq-cad";
  const securityId = "sec-1";

  const account = (id: string, currencyCode: string, name = id) =>
    ({ id, name, currencyCode }) as Partial<Account>;

  const makeTx = (
    overrides: Partial<InvestmentTransaction> & {
      accountCurrency?: string;
      securityCurrency?: string;
    },
  ) => {
    const {
      accountCurrency = "CAD",
      securityCurrency = "CAD",
      ...rest
    } = overrides;
    return {
      id: "tx",
      userId,
      accountId: brokerage,
      securityId,
      action: InvestmentAction.BUY,
      transactionDate: "2024-01-01",
      quantity: 0,
      price: 0,
      commission: 0,
      totalAmount: 0,
      exchangeRate: 1,
      fundingAccountId: null,
      description: null,
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
      account: account(brokerage, accountCurrency, "Brokerage"),
      security: {
        id: securityId,
        symbol: "ABC",
        name: "ABC Corp",
        currencyCode: securityCurrency,
      },
      ...rest,
    } as unknown as InvestmentTransaction;
  };

  const accounts = (accountCurrency: string) => [
    {
      id: brokerage,
      currencyCode: accountCurrency,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      linkedAccountId: null,
    },
    {
      id: usdChequing,
      currencyCode: "USD",
      accountSubType: AccountSubType.INVESTMENT_CASH,
      linkedAccountId: null,
    },
    {
      id: cadChequing,
      currencyCode: "CAD",
      accountSubType: AccountSubType.INVESTMENT_CASH,
      linkedAccountId: null,
    },
  ];

  const build = (
    transactions: InvestmentTransaction[],
    opts: {
      accountCurrency?: string;
      rates?: Record<string, number | null>;
      prices?: Array<{ date: string; price: number }>;
    } = {},
  ) => {
    const txRepo = { find: jest.fn().mockResolvedValue(transactions) };
    const known = accounts(opts.accountCurrency ?? "CAD");
    const accountRepo = {
      find: jest.fn(({ where }: { where: { id: { _value: string[] } } }) =>
        Promise.resolve(known.filter((a) => where.id._value.includes(a.id))),
      ),
    };
    const resolveStoredRate = storedRateDouble(opts.rates);
    const priceQuery = jest.fn().mockResolvedValue(
      (opts.prices ?? []).map((r) => ({
        security_id: securityId,
        price_date: r.date,
        close_price: String(r.price),
      })),
    );
    const service = buildService(
      [
        [InvestmentTransaction, txRepo],
        [Account, accountRepo],
      ],
      { resolveStoredRate },
      priceQuery,
    );
    return { service, resolveStoredRate };
  };

  const addUnpriced = (overrides: Partial<InvestmentTransaction> = {}) =>
    makeTx({
      id: "add",
      action: InvestmentAction.ADD_SHARES,
      transactionDate: "2023-12-05",
      quantity: 100,
      price: null as never,
      ...overrides,
    });
  const buy100 = (overrides: Partial<InvestmentTransaction> = {}) =>
    makeTx({
      id: "buy",
      action: InvestmentAction.BUY,
      transactionDate: "2024-01-10",
      quantity: 100,
      price: 50,
      totalAmount: 5000,
      ...overrides,
    });
  const sell100 = (overrides: Partial<InvestmentTransaction> = {}) =>
    makeTx({
      id: "sell",
      action: InvestmentAction.SELL,
      transactionDate: "2024-02-10",
      quantity: 100,
      price: 60,
      totalAmount: 6000,
      ...overrides,
    });

  describe("shares added with no cost (example 1)", () => {
    const history = () => [addUnpriced(), buy100(), sell100()];

    it("realized gains: the sale's cost and gain are unknown, its proceeds are not", async () => {
      const { service } = build(history());

      const [sale] = await service.calculateRealizedGains(userId);

      expect(sale).toMatchObject({
        proceeds: 6000,
        costBasis: null,
        realizedGain: null,
        basisGap: "quantity_only_action",
      });
    });

    it("by period: the sale's month has no realized gain, a flag and a known subtotal of zero", async () => {
      // ADD 100 (no cost) + BUY 100 @ 50 + SELL 100 @ 60 used to report a
      // realized gain of 3,500 here: the average of the priced half only.
      const { service } = build(history(), {
        prices: [
          { date: "2023-12-31", price: 50 },
          { date: "2024-01-31", price: 55 },
          { date: "2024-02-29", price: 60 },
        ],
      });

      const result = await service.calculateCapitalGainsByMonth(userId, {
        startDate: "2024-01-01",
        endDate: "2024-02-29",
      });

      const jan = result.find((r) => r.month === "2024-01")!;
      const feb = result.find((r) => r.month === "2024-02")!;
      expect(jan).toMatchObject({
        realizedGain: 0,
        realizedGainComplete: true,
        realizedGainKnownSubtotal: null,
        totalCapitalGain: 1000,
      });
      expect(feb).toMatchObject({
        sells: 6000,
        realizedGain: null,
        realizedGainComplete: false,
        realizedGainKnownSubtotal: 0,
        unrealizedGain: null,
      });
    });

    it("by period: the known part is the sales on a known basis, and the unknown lot clears when the position closes", async () => {
      const { service } = build(
        [
          addUnpriced({ quantity: 10 }),
          sell100({
            id: "sell-1",
            transactionDate: "2024-01-10",
            quantity: 10,
            totalAmount: 600,
          }),
          buy100({
            id: "buy-2",
            transactionDate: "2024-02-01",
            quantity: 10,
            totalAmount: 500,
          }),
          sell100({
            id: "sell-2",
            transactionDate: "2024-02-10",
            quantity: 5,
            totalAmount: 300,
          }),
          sell100({
            id: "sell-3",
            transactionDate: "2024-02-11",
            quantity: 5,
            totalAmount: 300,
          }),
        ],
        { prices: [{ date: "2024-02-29", price: 60 }] },
      );

      const result = await service.calculateCapitalGainsByMonth(userId, {
        startDate: "2024-01-01",
        endDate: "2024-02-29",
      });

      const jan = result.find((r) => r.month === "2024-01")!;
      const feb = result.find((r) => r.month === "2024-02")!;
      expect(jan.realizedGain).toBeNull();
      // 500 for 10 shares: 5 sold for 300 and 5 for 300 realize 50 and 50.
      expect(feb).toMatchObject({
        realizedGain: 50 + 50,
        realizedGainComplete: true,
        realizedGainKnownSubtotal: null,
      });
    });

    it("by period: shares added in the period make its total capital gain unknown", async () => {
      const { service } = build(
        [
          buy100({ transactionDate: "2023-12-10" }),
          addUnpriced({ transactionDate: "2024-01-15", quantity: 10 }),
        ],
        {
          prices: [
            { date: "2023-12-31", price: 50 },
            { date: "2024-01-31", price: 60 },
          ],
        },
      );

      const [jan] = await service.calculateCapitalGainsByMonth(userId, {
        startDate: "2024-01-01",
        endDate: "2024-01-31",
      });

      // The 10 free shares are in the end value and nowhere in `buys`.
      expect(jan).toMatchObject({
        endQuantity: 110,
        totalCapitalGain: null,
        unrealizedGain: null,
      });
    });

    it("by period: shares removed in the period make its total capital gain unknown", async () => {
      const { service } = build(
        [
          buy100({ transactionDate: "2023-12-10" }),
          makeTx({
            id: "remove",
            action: InvestmentAction.REMOVE_SHARES,
            transactionDate: "2024-01-15",
            quantity: 10,
          }),
        ],
        {
          prices: [
            { date: "2023-12-31", price: 50 },
            { date: "2024-01-31", price: 60 },
          ],
        },
      );

      const [jan] = await service.calculateCapitalGainsByMonth(userId, {
        startDate: "2024-01-01",
        endDate: "2024-01-31",
      });

      expect(jan).toMatchObject({ endQuantity: 90, totalCapitalGain: null });
    });
  });

  describe("a basis in another currency than the proceeds (examples 3 to 6)", () => {
    // A CAD brokerage holds a USD security. The BUY is funded from USD chequing
    // (the row's rate is 1, into USD); the SELL settles into the brokerage's own
    // CAD at 1.35.
    const usdBuy = (
      overrides: Partial<InvestmentTransaction> & {
        accountCurrency?: string;
      } = {},
    ) =>
      makeTx({
        id: "buy",
        securityCurrency: "USD",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-10",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
        exchangeRate: 1,
        fundingAccountId: usdChequing,
        ...overrides,
      });
    const cadSell = (
      overrides: Partial<InvestmentTransaction> & {
        accountCurrency?: string;
      } = {},
    ) =>
      makeTx({
        id: "sell",
        securityCurrency: "USD",
        action: InvestmentAction.SELL,
        transactionDate: "2024-02-10",
        quantity: 10,
        price: 110,
        totalAmount: 1100,
        exchangeRate: 1.35,
        ...overrides,
      });

    it("converts the USD basis at the rate on the purchase date, not subtracting USD from CAD", async () => {
      const { service, resolveStoredRate } = build([usdBuy(), cadSell()], {
        rates: { "USD->CAD": 1.35 },
      });

      const [sale] = await service.calculateRealizedGains(userId);

      // 1,485 CAD of proceeds against 1,000 USD x 1.35 = 1,350 CAD; it read 485.
      expect(sale).toMatchObject({
        proceeds: 1485,
        costBasis: 1350,
        realizedGain: 135,
        basisGap: null,
      });
      expect(resolveStoredRate).toHaveBeenCalledWith(
        "USD",
        "CAD",
        "2024-01-10",
        { mode: "historical" },
      );
    });

    it("keeps the currency move on the cost in the gain", async () => {
      const { service } = build([usdBuy(), cadSell()], {
        rates: { "USD->CAD": 1.3 },
      });

      const [sale] = await service.calculateRealizedGains(userId);

      expect(sale).toMatchObject({ costBasis: 1300, realizedGain: 185 });
    });

    it("reports the gain unknown, naming mixed_basis_currency, when no rate converts the basis", async () => {
      const { service } = build([usdBuy(), cadSell()]);

      const [sale] = await service.calculateRealizedGains(userId);

      expect(sale).toMatchObject({
        proceeds: 1485,
        costBasis: null,
        realizedGain: null,
        basisGap: "mixed_basis_currency",
      });
    });

    it("reports the gain unknown when the sale's stored rate cannot convert it, never at par", async () => {
      const { service } = build([usdBuy(), cadSell({ exchangeRate: 0 })], {
        rates: { "USD->CAD": 1.35 },
      });

      const [sale] = await service.calculateRealizedGains(userId);

      expect(sale).toMatchObject({
        costBasis: null,
        realizedGain: null,
        basisGap: "mixed_basis_currency",
      });
    });

    it("by period: buys are in the account's currency", async () => {
      const { service } = build([usdBuy()], {
        rates: { "USD->CAD": 1.35 },
        prices: [{ date: "2024-01-31", price: 110 }],
      });

      const [jan] = await service.calculateCapitalGainsByMonth(userId, {
        startDate: "2024-01-01",
        endDate: "2024-01-31",
      });

      // 10 x 110 x 1.35 = 1,485 of value against 1,350 spent: 135. With the
      // purchase left in USD it read 485.
      expect(jan).toMatchObject({ buys: 1350, totalCapitalGain: 135 });
    });

    it("by period: a basis that cannot be converted makes the total unknown, not 485", async () => {
      const { service } = build([usdBuy()], {
        prices: [{ date: "2024-01-31", price: 110 }],
      });

      const result = await service.calculateCapitalGainsByMonth(userId, {
        startDate: "2024-01-01",
        endDate: "2024-01-31",
      });

      // The end value needs the same missing rate; either way nothing is stated.
      expect(result[0].totalCapitalGain).toBeNull();
    });

    it("uses the row's own amounts, and no market rate, when the account holds the security's currency", async () => {
      // A USD brokerage, a USD security, bought with CAD at 1.35 (CAD 1,350) and
      // sold into USD: the basis is the USD the row names, 1,000.
      const { service, resolveStoredRate } = build(
        [
          usdBuy({
            accountCurrency: "USD",
            exchangeRate: 1.35,
            fundingAccountId: cadChequing,
          }),
          cadSell({ accountCurrency: "USD", exchangeRate: 1 }),
        ],
        { accountCurrency: "USD" },
      );

      const [sale] = await service.calculateRealizedGains(userId);

      expect(sale).toMatchObject({ costBasis: 1000, realizedGain: 100 });
      expect(resolveStoredRate).not.toHaveBeenCalled();
    });
  });

  describe("one basis through all three reports", () => {
    // BUY 10 @ 100 with 10 of commission (1,010), 100 of capital returned (910),
    // SELL 5 for 600.
    const history = () => [
      makeTx({
        id: "buy",
        quantity: 10,
        price: 100,
        commission: 10,
        totalAmount: 1010,
      }),
      makeTx({
        id: "roc",
        action: InvestmentAction.RETURN_OF_CAPITAL,
        transactionDate: "2024-01-20",
        quantity: null as never,
        price: null as never,
        totalAmount: 100,
      }),
      makeTx({
        id: "sell",
        action: InvestmentAction.SELL,
        transactionDate: "2024-01-25",
        quantity: 5,
        price: 120,
        totalAmount: 600,
      }),
    ];

    it("relieves the same basis in realized gains and the lots, commission and return of capital included", async () => {
      const { service } = build(history());

      const sales = await service.calculateRealizedGains(userId);
      const sale = sales.find((r) => r.transactionId === "sell")!;
      const lots = await service.calculateCostBasisLotsInAccountCurrency(
        userId,
        [brokerage],
      );

      // 1,010 less 100 is 910: 455 relieved by the sale, 455 left.
      expect(sale.costBasis).toBe(455);
      expect(lots.get(`${brokerage}:${securityId}`)?.costBasis).toBe(455);
      expect(
        sale.costBasis! + lots.get(`${brokerage}:${securityId}`)!.costBasis,
      ).toBe(910);
    });

    it("realizes the same gain by period as per sale", async () => {
      const { service } = build(history(), {
        prices: [
          { date: "2023-12-31", price: 100 },
          { date: "2024-01-31", price: 110 },
        ],
      });

      const [sale] = (await service.calculateRealizedGains(userId)).filter(
        (r) => r.transactionId === "sell",
      );
      const [jan] = await service.calculateCapitalGainsByMonth(userId, {
        startDate: "2024-01-01",
        endDate: "2024-01-31",
      });

      expect(sale.realizedGain).toBe(145);
      expect(jan.realizedGain).toBe(sale.realizedGain);
    });
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

  beforeEach(() => {
    rawCurrencies = [];
    holdingsRepo = {
      createQueryBuilder: jest.fn(() => makeQueryBuilder()),
    };
    exchangeRateService = { getLiveRate: jest.fn() };
    service = buildService([[Holding, holdingsRepo]], exchangeRateService);
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

  /**
   * Issue #1390, the consequence chain. With the provider down and the only
   * stored observation past the age bound, `getLiveRate` answers `null` (the
   * bound itself is proven in `exchange-rate.service.spec.ts`), so nothing is
   * seeded here and `convertToDefault` refuses the same pair through the same
   * door. The figure that reaches the caller is a subtotal that says so, rather
   * than a total built on a nine-month-old rate.
   */
  it("leaves a refused pair out of the cash total instead of valuing it at a stale rate", async () => {
    rawCurrencies = [];
    exchangeRateService.getLiveRate.mockResolvedValue(null);
    const withStored = {
      getLiveRate: exchangeRateService.getLiveRate,
      resolveStoredRate: storedRateDouble(),
    };
    const cashService = buildService([[Holding, holdingsRepo]], withStored);
    const rateCache = new Map<string, number | null>();

    const accounts = [
      { id: "usd", currencyCode: "USD", currentBalance: 1000 } as Account,
      { id: "cad", currencyCode: "CAD", currentBalance: 250 } as Account,
    ];
    await cashService.primeLiveRates(rateCache, accounts, [], "CAD");
    // Nothing seeded: priming leaves the pair for the door to refuse.
    expect(rateCache.has("USD->CAD")).toBe(false);

    const cash = await cashService.computeTotalCashValue(
      accounts,
      new Map<string, number>(),
      "CAD",
      rateCache,
    );

    // The refusal is cached as an absence, never as a number.
    expect(rateCache.get("USD->CAD")).toBeNull();
    expect(cash.fxComplete).toBe(false);
    expect(cash.missingRatePairs).toEqual(["USD->CAD"]);
    // The CAD balance still converts; the subtotal carries what is known.
    expect(cash.total).toBe(250);
  });

  it("does not query holdings when there are no holdings accounts", async () => {
    exchangeRateService.getLiveRate.mockResolvedValue(1.37);
    const rateCache = new Map<string, number>();

    await service.primeLiveRates(rateCache, [account("USD")], [], "CAD");

    expect(holdingsRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(rateCache.get("USD->CAD")).toBe(1.37);
  });
});

/**
 * `ExchangeRateService.resolveStoredRate` as the real one answers: the stored
 * observation for a pair, or an `unknown` resolution naming why there is none.
 * A double that returned a bare number could not express the second, which is
 * the half the callers branch on.
 */
/**
 * The `FxRateResolution` shape `resolveStoredRate` returns for a single rate:
 * `resolved` with the number, or `unknown` naming why there is none. Used by the
 * date-aware doubles that assert the capital-gains fold resolves each boundary
 * at that boundary's own date.
 */
function resolutionFor(rate: number | null) {
  if (rate === null || !(rate > 0)) {
    return {
      status: "unknown",
      rate: null,
      observedRate: null,
      observedOn: null,
      direction: null,
      ageDays: null,
      reason: "no_observation",
    };
  }
  return {
    status: "resolved",
    rate,
    observedRate: rate,
    observedOn: null,
    direction: "direct",
    ageDays: 0,
    reason: null,
  };
}

function storedRateDouble(
  rates: Record<string, number | null> = {},
): jest.Mock {
  return jest.fn(async (from: string, to: string) => {
    if (from === to) {
      return {
        status: "same_currency",
        rate: 1,
        observedRate: 1,
        observedOn: null,
        direction: "identity",
        ageDays: 0,
        reason: null,
      };
    }
    const direct = rates[`${from}->${to}`];
    const inverse = rates[`${to}->${from}`];
    const rate =
      direct != null && direct > 0
        ? direct
        : inverse != null && inverse > 0
          ? 1 / inverse
          : null;
    if (rate === null) {
      return {
        status: "unknown",
        rate: null,
        observedRate: null,
        observedOn: null,
        direction: null,
        ageDays: null,
        reason: "no_observation",
      };
    }
    return {
      status: "resolved",
      rate,
      observedRate: direct != null && direct > 0 ? direct : inverse,
      observedOn: "2026-06-15",
      direction: direct != null && direct > 0 ? "direct" : "inverse",
      ageDays: 0,
      reason: null,
    };
  });
}

describe("PortfolioCalculationService.convertToDefault", () => {
  let service: PortfolioCalculationService;
  let exchangeRateService: { resolveStoredRate: jest.Mock };

  beforeEach(() => {
    exchangeRateService = { resolveStoredRate: storedRateDouble() };
    service = buildService([], exchangeRateService);
  });

  it("returns zero for a zero amount without looking for a rate", async () => {
    // Zero converts to zero at any rate, so it needs none. Asking for one turned
    // an empty foreign account -- no cash, no holdings, nothing invested -- into
    // an unresolvable pair that made the whole portfolio's totals unknown. A
    // settled question must not be reported as one that could not be worked out.
    const result = await service.convertToDefault(
      0,
      "EUR",
      "CAD",
      new Map<string, number>(),
    );

    expect(result).toBe(0);
    expect(exchangeRateService.resolveStoredRate).not.toHaveBeenCalled();
  });

  it("still reports a non-zero amount with no rate as unknown", async () => {
    // The control: the zero shortcut must not become a general fallback.
    const result = await service.convertToDefault(
      100,
      "EUR",
      "CAD",
      new Map<string, number>(),
    );

    expect(result).toBeNull();
  });

  it("caches the absence of a rate, resolving a missing pair once per cache", async () => {
    // A portfolio with 50 holdings in one unrated currency used to re-run both
    // lookups (direct + inverse) and re-log the warning for every holding.
    const cache = new Map<string, number | null>();

    expect(await service.convertToDefault(100, "EUR", "CAD", cache)).toBeNull();
    expect(await service.convertToDefault(250, "EUR", "CAD", cache)).toBeNull();
    expect(await service.convertToDefault(999, "EUR", "CAD", cache)).toBeNull();

    // One resolution for the first call only; the cached null answers the rest.
    expect(exchangeRateService.resolveStoredRate).toHaveBeenCalledTimes(1);
  });

  it("a cached absence does not shadow the zero shortcut", async () => {
    const cache = new Map<string, number | null>([["EUR->CAD", null]]);
    expect(await service.convertToDefault(0, "EUR", "CAD", cache)).toBe(0);
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

  beforeEach(() => {
    exchangeRateService = { getRateHistory: jest.fn().mockResolvedValue([]) };
    service = buildService([], exchangeRateService);
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
      // One age bound before the window opens, so a bar's rate does not
      // change when the chart around it is widened (issue #1390).
      expect(exchangeRateService.getRateHistory).toHaveBeenCalledWith(
        "2026-04-05",
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

    /**
     * Was: "falls back to the earliest known rate when the date precedes all
     * history". Issue #1390: a bar is never valued at a rate struck after it,
     * and a rate older than the age bound is not that bar's rate either.
     */
    it("is undefined for a date the whole loaded history postdates", async () => {
      exchangeRateService.getRateHistory.mockResolvedValue([
        rate("USD", "CAD", 1.4, "2026-06-01"),
      ]);
      const index = await service.buildDailyRateIndex(
        ["USD"],
        "CAD",
        "2026-05-20",
        "2026-06-04",
      );

      expect(
        service.resolveDailyRate(index, "USD", "CAD", "2026-05-15"),
      ).toBeUndefined();
    });

    it("is undefined once the newest loaded rate is past the age bound", async () => {
      exchangeRateService.getRateHistory.mockResolvedValue([
        rate("USD", "CAD", 1.4, "2026-06-01"),
      ]);
      const index = await service.buildDailyRateIndex(
        ["USD"],
        "CAD",
        "2026-05-20",
        "2026-09-04",
      );

      expect(
        service.resolveDailyRate(index, "USD", "CAD", "2026-09-01"),
      ).toBeUndefined();
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

  beforeEach(() => {
    service = buildService([], {});
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

  beforeEach(() => {
    service = buildService([], {});
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

  beforeEach(() => {
    service = buildService([], {});
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

describe("PortfolioCalculationService.buildHoldingsByAccount", () => {
  let service: PortfolioCalculationService;

  beforeEach(() => {
    service = buildService([], {});
  });

  const account = (
    id: string,
    subType: AccountSubType | null,
    linkedAccountId: string | null = null,
  ) =>
    ({
      id,
      name: id,
      currencyCode: "CAD",
      currentBalance: 0,
      accountSubType: subType,
      linkedAccountId,
    }) as unknown as Account;

  const holding = (
    id: string,
    accountId: string,
    marketValue: number | null,
  ): HoldingWithMarketValue =>
    ({
      id,
      accountId,
      securityId: `sec-${id}`,
      symbol: id,
      name: id,
      securityType: "STOCK",
      currencyCode: "CAD",
      quantity: 1,
      averageCost: 100,
      costBasis: 100,
      costBasisAccountCurrency: 100,
      currentPrice: marketValue,
      marketValue,
      gainLoss: null,
      gainLossPercent: null,
    }) as HoldingWithMarketValue;

  const categorised = (over: Partial<CategorisedAccounts>) => ({
    cashAccounts: [],
    brokerageAccounts: [],
    standaloneAccounts: [],
    holdingsAccountIds: [],
    ...over,
  });

  // An unpriced holding contributes 0 to totalMarketValue, which makes a
  // priced-zero account and an unpriceable one identical in the payload. The
  // count is what tells them apart, so a total built on the market value can
  // go unknown rather than reporting the cash-only subtotal
  // (docs/financial-calculation-contract.md section 1).
  it("counts a brokerage account's unpriced holdings without changing totalMarketValue", async () => {
    const brokerage = account("brok-1", AccountSubType.INVESTMENT_BROKERAGE);

    const [result] = await service.buildHoldingsByAccount(
      categorised({ brokerageAccounts: [brokerage] }),
      [holding("h1", "brok-1", 900), holding("h2", "brok-1", null)],
      new Map<string, number>(),
      new Map(),
      new Map<string, number>(),
    );

    expect(result.unpricedHoldingsCount).toBe(1);
    expect(result.totalMarketValue).toBe(900);
  });

  it("reports zero unpriced holdings when every position is priced", async () => {
    const brokerage = account("brok-1", AccountSubType.INVESTMENT_BROKERAGE);

    const [result] = await service.buildHoldingsByAccount(
      categorised({ brokerageAccounts: [brokerage] }),
      [holding("h1", "brok-1", 900), holding("h2", "brok-1", 100)],
      new Map<string, number>(),
      new Map(),
      new Map<string, number>(),
    );

    expect(result.unpricedHoldingsCount).toBe(0);
    expect(result.totalMarketValue).toBe(1000);
  });

  it("counts unpriced holdings on a standalone investment account too", async () => {
    const standalone = account("solo-1", null);

    const [result] = await service.buildHoldingsByAccount(
      categorised({ standaloneAccounts: [standalone] }),
      [holding("h1", "solo-1", null), holding("h2", "solo-1", null)],
      new Map<string, number>(),
      new Map(),
      new Map<string, number>(),
    );

    expect(result.unpricedHoldingsCount).toBe(2);
    expect(result.totalMarketValue).toBe(0);
  });

  it("reports zero for an account holding nothing -- a settled value, not an unknown one", async () => {
    const brokerage = account("brok-1", AccountSubType.INVESTMENT_BROKERAGE);

    const [result] = await service.buildHoldingsByAccount(
      categorised({ brokerageAccounts: [brokerage] }),
      [],
      new Map<string, number>(),
      new Map(),
      new Map<string, number>(),
    );

    expect(result.unpricedHoldingsCount).toBe(0);
    expect(result.totalMarketValue).toBe(0);
  });
});

describe("PortfolioCalculationService.calculateCostBasisLotsInAccountCurrency", () => {
  const userId = "user-1";

  /**
   * The accounts a replay resolves settlement currencies against.
   *
   * `acct-1` is a plain USD holding account with no linked cash account, so
   * the fixtures below exercise the same-currency case and their basis comes
   * back in USD. A test about currency declares its own accounts.
   */
  const usdAccounts = [
    {
      id: "acct-1",
      currencyCode: "USD",
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      linkedAccountId: null,
    },
  ];

  const lots = async (
    transactions: Array<Partial<InvestmentTransaction>>,
    accounts: Array<Record<string, unknown>> = usdAccounts,
    requested: string[] = ["acct-1"],
  ) => {
    const txRepo = { find: jest.fn().mockResolvedValue(transactions) };
    // Two reads: the accounts asked for, then any linked cash account those
    // named. The second is answered from the same fixture list.
    const accountRepo = {
      find: jest.fn(({ where }: { where: { id: { _value: string[] } } }) =>
        Promise.resolve(
          accounts.filter((account) =>
            where.id._value.includes(account.id as string),
          ),
        ),
      ),
    };
    const service = buildService(
      [
        [InvestmentTransaction, txRepo],
        [Account, accountRepo],
      ],
      {},
    );
    return service.calculateCostBasisLotsInAccountCurrency(userId, requested);
  };

  /**
   * Invariant: cost basis is what the acquisition cost, commission included.
   * Canonical adversarial input: money with a fee alongside the principal.
   * Minimal mutation: drop the commission term from the BUY branch.
   * Test that fails under it: this one -- the basis comes back 1,000.
   */
  it("includes the acquisition commission in the basis", async () => {
    const replayed = await lots([
      {
        accountId: "acct-1",
        securityId: "sec-a",
        action: InvestmentAction.BUY,
        quantity: 100,
        price: 10,
        commission: 20,
        exchangeRate: 1,
      } as InvestmentTransaction,
    ]);

    // 100 x 10 plus the 20 it cost to place the trade. Leaving the commission
    // out reports 200 of gain on a 1,200 sale where the truth is 180, and
    // 38.00 of tax at 19% where the truth is 34.20.
    expect(replayed.get("acct-1:sec-a")).toEqual({
      quantity: 100,
      costBasis: 1020,
      currencyCode: "USD",
      basisKnown: true,
      basisGap: null,
    });
  });

  it("converts the commission at the trade's own rate", async () => {
    const replayed = await lots([
      {
        accountId: "acct-1",
        securityId: "sec-a",
        action: InvestmentAction.BUY,
        quantity: 10,
        price: 100,
        commission: 5,
        exchangeRate: 4,
      } as InvestmentTransaction,
    ]);

    // (10 x 100 + 5) x 4. The commission is recorded in the trade's currency,
    // so it moves with the trade rather than being added afterwards.
    expect(replayed.get("acct-1:sec-a")?.costBasis).toBe(4020);
  });

  /**
   * Invariant: a return of capital comes off the basis at the rate it settled
   * at, and never below zero (issue #1800).
   * Minimal mutation: drop the RETURN_OF_CAPITAL branch.
   * Test that fails under it: this one -- the basis comes back 4,020.
   */
  it("takes a return of capital off the basis at its own rate", async () => {
    const replayed = await lots([
      {
        accountId: "acct-1",
        securityId: "sec-a",
        action: InvestmentAction.BUY,
        quantity: 10,
        price: 100,
        commission: 5,
        exchangeRate: 4,
      } as InvestmentTransaction,
      {
        accountId: "acct-1",
        securityId: "sec-a",
        action: InvestmentAction.RETURN_OF_CAPITAL,
        quantity: null,
        price: null,
        totalAmount: 50,
        exchangeRate: 4,
      } as unknown as InvestmentTransaction,
    ]);

    // 4,020 less 50 x 4; the ten shares stay.
    expect(replayed.get("acct-1:sec-a")).toEqual({
      quantity: 10,
      costBasis: 3820,
      currencyCode: "USD",
      basisKnown: true,
      basisGap: null,
    });
  });

  it("reports the quantity the history accounts for", async () => {
    const replayed = await lots([
      {
        accountId: "acct-1",
        securityId: "sec-a",
        action: InvestmentAction.BUY,
        quantity: 50,
        price: 10,
        commission: 0,
        exchangeRate: 1,
      } as InvestmentTransaction,
    ]);

    // The caller pairs this with a current holding, and 50 replayed against
    // 100 held is a basis for a different position.
    expect(replayed.get("acct-1:sec-a")?.quantity).toBe(50);
  });

  /**
   * Invariant: a row that moves units without a price leaves the basis
   * unknown, because the application keeps two answers for what they cost.
   * Canonical adversarial input: a quantity that reconciles over a cost that
   * does not.
   * Minimal mutation: stop setting `basisGap` in the ADD_SHARES /
   * REMOVE_SHARES branches.
   * Test that fails under it: each of the first two below.
   */
  describe("quantity-only rows", () => {
    const buy = (quantity: number, price: number) =>
      ({
        accountId: "acct-1",
        securityId: "sec-a",
        action: InvestmentAction.BUY,
        quantity,
        price,
        commission: 0,
        exchangeRate: 1,
      }) as InvestmentTransaction;

    const move = (action: InvestmentAction, quantity: number) =>
      ({
        accountId: "acct-1",
        securityId: "sec-a",
        action,
        quantity,
        price: 0,
        commission: 0,
        exchangeRate: 1,
      }) as InvestmentTransaction;

    it("marks the basis unknown after an ADD_SHARES", async () => {
      const replayed = await lots([
        buy(50, 10),
        move(InvestmentAction.ADD_SHARES, 50),
      ]);

      // The units reconcile against a 100-share holding and the 500 prices
      // half of them. `adjustQuantity` would have stored a basis of 1,000 for
      // the same history, and a full rebuild 500.
      expect(replayed.get("acct-1:sec-a")).toEqual({
        quantity: 100,
        costBasis: 500,
        currencyCode: "USD",
        basisKnown: false,
        basisGap: "quantity_only_action",
      });
    });

    it("marks the basis unknown after a REMOVE_SHARES", async () => {
      const replayed = await lots([
        buy(100, 10),
        move(InvestmentAction.REMOVE_SHARES, 50),
      ]);

      // The other direction: the whole 1,000 left standing against the 50
      // shares that remain.
      expect(replayed.get("acct-1:sec-a")).toEqual({
        quantity: 50,
        costBasis: 1000,
        currencyCode: "USD",
        basisKnown: false,
        basisGap: "quantity_only_action",
      });
    });

    it("keeps the basis known across a split, which prices what it moves", async () => {
      const replayed = await lots([
        buy(100, 10),
        move(InvestmentAction.SPLIT, 2),
      ]);

      // A split scales the units and preserves the total cost -- what both
      // live paths do -- so the per-share average halves and nothing is
      // unaccounted for.
      expect(replayed.get("acct-1:sec-a")).toEqual({
        quantity: 200,
        costBasis: 1000,
        currencyCode: "USD",
        basisKnown: true,
        basisGap: null,
      });
    });

    it("clears the gap once the position closes and is bought again", async () => {
      const replayed = await lots([
        buy(50, 10),
        move(InvestmentAction.ADD_SHARES, 50),
        {
          accountId: "acct-1",
          securityId: "sec-a",
          action: InvestmentAction.SELL,
          quantity: 100,
          price: 12,
          commission: 0,
          exchangeRate: 1,
        } as InvestmentTransaction,
        buy(10, 20),
      ]);

      // Whatever the history could not price has been disposed of; the 10
      // shares held now were bought by a row that says what they cost.
      expect(replayed.get("acct-1:sec-a")).toEqual({
        quantity: 10,
        costBasis: 200,
        currencyCode: "USD",
        basisKnown: true,
        basisGap: null,
      });
    });

    it("ignores a zero-quantity adjustment, which moves nothing", async () => {
      const replayed = await lots([
        buy(100, 10),
        move(InvestmentAction.ADD_SHARES, 0),
      ]);

      expect(replayed.get("acct-1:sec-a")).toEqual({
        quantity: 100,
        costBasis: 1000,
        currencyCode: "USD",
        basisKnown: true,
        basisGap: null,
      });
    });
  });

  /**
   * Invariant: every component of a cost basis is known before the total is.
   * Canonical adversarial input: a nullable money column left null (testing
   * contract, money precision / missing data).
   * Minimal mutation: restore `const price = Number(tx.price) || 0` at the top
   * of the acquisition branch, or weaken `priced` back to "not null and
   * finite", which readmits a stored zero as a known cost.
   * Test that fails under it: each of the four below -- the basis comes back
   * known, having counted the units and none of their cost.
   */
  describe("acquisitions with no price", () => {
    const buy = (quantity: number, price: number | null) =>
      ({
        accountId: "acct-1",
        securityId: "sec-a",
        action: InvestmentAction.BUY,
        quantity,
        price,
        commission: 0,
        exchangeRate: 1,
      }) as InvestmentTransaction;

    it("marks the basis unknown for a wholly unpriced holding", async () => {
      const replayed = await lots([buy(100, null)]);

      expect(replayed.get("acct-1:sec-a")).toEqual({
        quantity: 100,
        costBasis: 0,
        currencyCode: null,
        basisKnown: false,
        basisGap: "unpriced_acquisition",
      });
    });

    it("marks the basis unknown when only some of the history is priced", async () => {
      const replayed = await lots([buy(50, 10), buy(50, null)]);

      // The dangerous shape: 100 units against 100 units, so the quantity
      // reconciliation passes and only the flag stands between an incomplete
      // import and a confident 1,000 of gain on a 1,500 market value.
      expect(replayed.get("acct-1:sec-a")).toEqual({
        quantity: 100,
        costBasis: 500,
        currencyCode: "USD",
        basisKnown: false,
        basisGap: "unpriced_acquisition",
      });
    });

    it("reads a stored zero price as no price, not as free shares", async () => {
      // A zero on an acquisition is not a cost, it is a blank. Before
      // `assertAcquisitionPriced` shipped, `create()` stored `price ?? 0` and
      // the form accepted an empty field, so real databases hold zero-price BUY
      // and REINVEST rows that mean "nobody recorded what this cost". Replaying
      // one as a known zero-cost lot is the confident-understated-basis defect
      // this file exists to prevent, arriving by the other route: the units
      // reconcile, the flag says known, and the whole market value is reported
      // as gain and taxed.
      //
      // And no legitimate zero can be written from here on -- the guard refuses
      // one on every path -- so nothing is lost by folding them together.
      // Shares that arrived without a cost are `ADD_SHARES`, which says the
      // cost is unknown rather than nil.
      const replayed = await lots([buy(100, 0)]);

      expect(replayed.get("acct-1:sec-a")).toEqual({
        quantity: 100,
        costBasis: 0,
        currencyCode: null,
        basisKnown: false,
        basisGap: "unpriced_acquisition",
      });
    });

    it("marks the basis unknown when a stored zero sits beside priced history", async () => {
      // The same dangerous shape as the null case above: 100 units against 100
      // units, so quantity reconciliation passes and only the flag stands
      // between a legacy import and 1,000 of invented gain.
      const replayed = await lots([buy(50, 10), buy(50, 0)]);

      expect(replayed.get("acct-1:sec-a")).toEqual({
        quantity: 100,
        costBasis: 500,
        currencyCode: "USD",
        basisKnown: false,
        basisGap: "unpriced_acquisition",
      });
    });
  });

  /**
   * Invariant: a monetary amount keeps the currency it was calculated into.
   * Canonical adversarial input: three currencies in one trade (testing
   * contract, currency conversion).
   * Minimal mutation: hardcode the lot's `currencyCode` to the holding
   * account's currency. Test that fails under it: the linked-cash and
   * funding-account cases below.
   */
  describe("the currency a basis is denominated in", () => {
    const brokerage = (linkedAccountId: string | null, currency: string) => ({
      id: "acct-1",
      currencyCode: currency,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      linkedAccountId,
    });

    const buy = (overrides: Partial<InvestmentTransaction> = {}) =>
      ({
        accountId: "acct-1",
        securityId: "sec-a",
        action: InvestmentAction.BUY,
        quantity: 10,
        price: 100,
        commission: 0,
        exchangeRate: 0.9,
        ...overrides,
      }) as InvestmentTransaction;

    it("reports the linked cash account's currency, not the brokerage's", async () => {
      // `exchangeRate` converted the trade into the account that paid for it.
      // A PLN brokerage settling through a EUR cash account holds a basis in
      // EUR; calling it PLN and setting it beside a PLN market value reports
      // the exchange rate as profit and taxes it.
      const replayed = await lots(
        [buy()],
        [
          brokerage("cash-eur", "PLN"),
          { id: "cash-eur", currencyCode: "EUR", linkedAccountId: null },
        ],
      );

      expect(replayed.get("acct-1:sec-a")).toMatchObject({
        costBasis: 900,
        currencyCode: "EUR",
        basisKnown: true,
      });
    });

    it("leaves the basis unknown when a return of capital settled in another currency", async () => {
      // The basis is in EUR (the linked cash account); the distribution paid
      // into a USD account, converted at a USD rate. Subtracting it from a
      // EUR basis would mix two currencies, so the basis is a gap instead.
      const replayed = await lots(
        [
          buy(),
          {
            accountId: "acct-1",
            securityId: "sec-a",
            action: InvestmentAction.RETURN_OF_CAPITAL,
            quantity: null,
            price: null,
            totalAmount: 50,
            exchangeRate: 1.1,
            fundingAccountId: "fund-usd",
          } as unknown as InvestmentTransaction,
        ],
        [
          brokerage("cash-eur", "PLN"),
          { id: "cash-eur", currencyCode: "EUR", linkedAccountId: null },
          { id: "fund-usd", currencyCode: "USD", linkedAccountId: null },
        ],
      );

      expect(replayed.get("acct-1:sec-a")).toMatchObject({
        costBasis: 900,
        basisKnown: false,
        basisGap: "mixed_basis_currency",
      });
    });

    it("reports the funding account's currency when the row names one", async () => {
      const replayed = await lots(
        [buy({ fundingAccountId: "fund-eur" })],
        [
          brokerage(null, "PLN"),
          { id: "fund-eur", currencyCode: "EUR", linkedAccountId: null },
        ],
      );

      expect(replayed.get("acct-1:sec-a")).toMatchObject({
        currencyCode: "EUR",
        basisKnown: true,
      });
    });

    it("does not redirect a funding account that is itself a brokerage", async () => {
      // `resolveExchangeRate` looks a named funding account up directly --
      // `accountsService.findOne(fundingAccountId)` -- and redirects through a
      // linked cash account only when no funding account was named. Applying the
      // redirect to both roles reported the trade as settled in the funding
      // brokerage's *cash* account (USD) when it had settled in the funding
      // brokerage itself (EUR): the right number under the wrong currency, and a
      // spurious `mixed_basis_currency` beside any leg that really was EUR.
      const replayed = await lots(
        [buy({ fundingAccountId: "fund-brokerage-eur" })],
        [
          brokerage(null, "PLN"),
          {
            id: "fund-brokerage-eur",
            currencyCode: "EUR",
            accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
            linkedAccountId: "fund-cash-usd",
          },
          { id: "fund-cash-usd", currencyCode: "USD", linkedAccountId: null },
        ],
      );

      expect(replayed.get("acct-1:sec-a")).toMatchObject({
        costBasis: 900,
        currencyCode: "EUR",
        basisKnown: true,
      });
    });

    it("refuses a basis whose acquisitions settled in two currencies", async () => {
      // There is no rate that reconciles these. Converting at today's would
      // answer a question about today; each leg was paid at its own.
      const replayed = await lots(
        [buy(), buy({ fundingAccountId: "fund-pln", exchangeRate: 4 })],
        [
          brokerage("cash-eur", "PLN"),
          { id: "cash-eur", currencyCode: "EUR", linkedAccountId: null },
          { id: "fund-pln", currencyCode: "PLN", linkedAccountId: null },
        ],
      );

      expect(replayed.get("acct-1:sec-a")).toMatchObject({
        basisKnown: false,
        basisGap: "mixed_basis_currency",
      });
    });

    it("reports the brokerage's own currency when it settles itself", async () => {
      // The ordinary single-account case, and the one that must not regress:
      // no linked cash account, no funding account, so the money stayed put.
      const replayed = await lots(
        [buy({ exchangeRate: 1 })],
        [brokerage(null, "CAD")],
      );

      expect(replayed.get("acct-1:sec-a")).toMatchObject({
        costBasis: 1000,
        currencyCode: "CAD",
        basisKnown: true,
      });
    });
  });
  /**
   * Invariant: a transfer moves shares and the cost they already carry. It is
   * not a sale and not a new acquisition, so it creates no gain, no tax and no
   * basis of its own.
   * Canonical adversarial input: money crossing an account boundary between
   * currencies (testing contract, currency conversion / ownership).
   * Minimal mutation: treat TRANSFER_IN as an acquisition again -- basis
   * `quantity * price * exchangeRate` off its own row.
   * Test that fails under it: the first of these, which is the reviewed
   * numerical case.
   */
  describe("cost carried across a transfer", () => {
    /**
     * A PLN-settling source and a PLN-settling destination, so the carried
     * amount needs no conversion and the arithmetic below is about the basis
     * rather than about a rate.
     */
    const plnPair = [
      {
        id: "acct-1",
        currencyCode: "PLN",
        accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
        linkedAccountId: null,
      },
      {
        id: "acct-2",
        currencyCode: "PLN",
        accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
        linkedAccountId: null,
      },
    ];

    const at = (day: number) => new Date(Date.UTC(2024, 0, day));

    /** USD 100 a share bought when USD/PLN was 3.00: PLN 3,000 for ten. */
    const sourceBuy = (overrides: Partial<InvestmentTransaction> = {}) =>
      ({
        id: "buy-1",
        accountId: "acct-1",
        securityId: "sec-a",
        action: InvestmentAction.BUY,
        transactionDate: "2024-01-01",
        createdAt: at(1),
        quantity: 10,
        price: 100,
        commission: 0,
        exchangeRate: 3,
        ...overrides,
      }) as InvestmentTransaction;

    /**
     * The two legs `transferSecurity` writes: same date, same `created_at`
     * (one transaction, one statement timestamp), paired by
     * `linkedTransactionId`, priced at the carried average with a rate of 1.
     * Those last two are exactly what must *not* be used to rebuild the basis.
     */
    const legs = (quantity: number) =>
      [
        {
          id: "out-1",
          linkedTransactionId: "in-1",
          accountId: "acct-1",
          securityId: "sec-a",
          action: InvestmentAction.TRANSFER_OUT,
          transactionDate: "2024-02-01",
          createdAt: at(2),
          quantity,
          price: 100,
          commission: 0,
          exchangeRate: 1,
        },
        {
          id: "in-1",
          linkedTransactionId: "out-1",
          accountId: "acct-2",
          securityId: "sec-a",
          action: InvestmentAction.TRANSFER_IN,
          transactionDate: "2024-02-01",
          createdAt: at(2),
          quantity,
          price: 100,
          commission: 0,
          exchangeRate: 1,
        },
      ] as InvestmentTransaction[];

    it("hands the destination the whole basis the source gave up", async () => {
      const replayed = await lots([sourceBuy(), ...legs(10)], plnPair, [
        "acct-1",
        "acct-2",
      ]);

      // PLN 3,000, not the PLN 1,000 that `10 x 100 x 1` off the IN leg gives.
      // Against a market value of PLN 4,400 that is 1,400 of gain and 266 of
      // tax at 19%, where the wrong basis showed 3,400 and 646.
      expect(replayed.get("acct-2:sec-a")).toMatchObject({
        quantity: 10,
        costBasis: 3000,
        currencyCode: "PLN",
        basisKnown: true,
      });
      // And the source kept nothing: it holds no shares and no cost.
      expect(replayed.get("acct-1:sec-a")).toMatchObject({
        quantity: 0,
        costBasis: 0,
      });
    });

    it("splits the basis in proportion on a partial transfer", async () => {
      const replayed = await lots([sourceBuy(), ...legs(4)], plnPair, [
        "acct-1",
        "acct-2",
      ]);

      // Four of ten shares carry four tenths of the cost; six tenths stay.
      expect(replayed.get("acct-2:sec-a")).toMatchObject({
        quantity: 4,
        costBasis: 1200,
        currencyCode: "PLN",
        basisKnown: true,
      });
      expect(replayed.get("acct-1:sec-a")).toMatchObject({
        quantity: 6,
        costBasis: 1800,
        basisKnown: true,
      });
    });

    it("carries the blended cost of several lots", async () => {
      const replayed = await lots(
        [
          sourceBuy(),
          sourceBuy({
            id: "buy-2",
            transactionDate: "2024-01-15",
            createdAt: at(15),
            quantity: 10,
            price: 200,
            exchangeRate: 3,
          }),
          ...legs(10),
        ],
        plnPair,
        ["acct-1", "acct-2"],
      );

      // 3,000 + 6,000 over 20 shares is 450 a share; ten of them move.
      expect(replayed.get("acct-2:sec-a")).toMatchObject({
        quantity: 10,
        costBasis: 4500,
        basisKnown: true,
      });
      expect(replayed.get("acct-1:sec-a")).toMatchObject({
        quantity: 10,
        costBasis: 4500,
      });
    });

    it("carries the acquisition commission inside the cost it moves", async () => {
      const replayed = await lots(
        [sourceBuy({ commission: 50 }), ...legs(5)],
        plnPair,
        ["acct-1", "acct-2"],
      );

      // (10 x 100 + 50) x 3 = 3,150 for ten shares. Half of them move with
      // half the commission already inside the average.
      expect(replayed.get("acct-2:sec-a")).toMatchObject({
        quantity: 5,
        costBasis: 1575,
        basisKnown: true,
      });
    });

    it("keeps an unknown source basis unknown at the destination", async () => {
      const replayed = await lots(
        [
          sourceBuy(),
          {
            id: "add-1",
            accountId: "acct-1",
            securityId: "sec-a",
            action: InvestmentAction.ADD_SHARES,
            transactionDate: "2024-01-20",
            createdAt: at(20),
            quantity: 5,
            price: null,
            commission: 0,
            exchangeRate: 1,
          } as InvestmentTransaction,
          ...legs(15),
        ],
        plnPair,
        ["acct-1", "acct-2"],
      );

      // The source could not price its own position, so neither can whatever
      // it hands on. Laundering it through a transfer must not make it known.
      expect(replayed.get("acct-2:sec-a")).toMatchObject({
        quantity: 15,
        basisKnown: false,
        basisGap: "transferred_basis_unknown",
      });
    });

    it("refuses a basis whose source leg is outside the replay", async () => {
      // The shares came from an account the caller did not ask about, so
      // nothing here knows what they cost -- and the IN leg's own price is a
      // carried average at a rate of 1, which is not an answer.
      const replayed = await lots([legs(10)[1]], plnPair, ["acct-2"]);

      expect(replayed.get("acct-2:sec-a")).toMatchObject({
        quantity: 10,
        basisKnown: false,
        basisGap: "transferred_basis_unknown",
      });
    });

    it("refuses to carry a basis into a differently settling account", async () => {
      // The source's cost is in PLN and the destination settles in EUR. There
      // is no rate for a multi-year aggregate, and today's would answer a
      // different question, so the destination's basis is unknown rather than
      // converted.
      const mixed = [
        plnPair[0],
        {
          id: "acct-2",
          currencyCode: "EUR",
          accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
          linkedAccountId: null,
        },
      ];
      const replayed = await lots(
        [
          sourceBuy(),
          {
            id: "buy-eur",
            accountId: "acct-2",
            securityId: "sec-a",
            action: InvestmentAction.BUY,
            transactionDate: "2024-01-05",
            createdAt: at(5),
            quantity: 1,
            price: 100,
            commission: 0,
            exchangeRate: 1,
          } as InvestmentTransaction,
          ...legs(10),
        ],
        mixed,
        ["acct-1", "acct-2"],
      );

      expect(replayed.get("acct-2:sec-a")).toMatchObject({
        basisKnown: false,
        basisGap: "mixed_basis_currency",
      });
    });

    it("does not let a transfer invent a basis the source never had", async () => {
      // No history behind the shares being moved: the OUT leg draws nothing
      // down, so the destination inherits nothing knowable rather than a cost
      // of zero.
      const replayed = await lots(legs(10), plnPair, ["acct-1", "acct-2"]);

      expect(replayed.get("acct-2:sec-a")).toMatchObject({
        basisKnown: false,
        basisGap: "transferred_basis_unknown",
      });
    });

    it("conserves the total basis across the pair", async () => {
      // The whole point, stated as one sum: a transfer neither creates nor
      // destroys cost. Anything else is a gain or a loss the user never made.
      const replayed = await lots([sourceBuy(), ...legs(4)], plnPair, [
        "acct-1",
        "acct-2",
      ]);

      const source = replayed.get("acct-1:sec-a");
      const destination = replayed.get("acct-2:sec-a");
      expect(
        (source?.costBasis ?? 0) + (destination?.costBasis ?? 0),
      ).toBeCloseTo(3000, 4);
      expect((source?.quantity ?? 0) + (destination?.quantity ?? 0)).toBe(10);
    });

    it("puts the OUT leg first even when the IN leg is read first", async () => {
      // Both rows are written in one transaction, so `created_at` is identical
      // and the SQL order between them is whatever the plan produces. Fed in
      // the wrong order the replay must still see the source give the shares
      // up before the destination receives them.
      const [out, incoming] = legs(10);
      const replayed = await lots([sourceBuy(), incoming, out], plnPair, [
        "acct-1",
        "acct-2",
      ]);

      expect(replayed.get("acct-2:sec-a")).toMatchObject({
        costBasis: 3000,
        basisKnown: true,
      });
    });
  });
});

/**
 * Invariant: a replayed basis is only usable as an account-currency figure
 * when the replay knows it and denominated it in that currency.
 * Canonical adversarial input: three currencies and an unpriced row (testing
 * contract, currency conversion / missing data).
 * Minimal mutation: return `lot.costBasis` for every lot, as the old
 * `calculateCostBasesInAccountCurrency` projection did.
 * Test that fails under it: the first two below -- a EUR figure is summed
 * into a PLN total, and a position the history cannot price contributes a
 * confident partial sum.
 */
describe("PortfolioCalculationService.calculateHoldingsWithValues", () => {
  const userId = "user-1";

  /** One PLN brokerage holding 10 shares of a USD security at 30 average. */
  const holdingRow = {
    id: "h-1",
    accountId: "acct-1",
    securityId: "sec-a",
    quantity: 10,
    averageCost: 30,
    security: {
      id: "sec-a",
      symbol: "AAA",
      name: "Alpha",
      securityType: "STOCK",
      currencyCode: "PLN",
    },
    account: { id: "acct-1", currencyCode: "PLN" },
  };

  const valuation = async (lot: ReplayedLot) => {
    const holdingRepo = { find: jest.fn().mockResolvedValue([holdingRow]) };
    const txRepo = { find: jest.fn().mockResolvedValue([]) };
    const accountRepo = { find: jest.fn().mockResolvedValue([]) };
    const service = buildService(
      [
        [Holding, holdingRepo],
        [InvestmentTransaction, txRepo],
        [Account, accountRepo],
      ],
      { resolveStoredRate: storedRateDouble() },
    );
    jest
      .spyOn(service, "calculateCostBasisLotsInAccountCurrency")
      .mockResolvedValue(new Map([["acct-1:sec-a", lot]]));
    return service.calculateHoldingsWithValues(
      userId,
      ["acct-1"],
      "PLN",
      new Map(),
      async () => new Map([["sec-a", 50]]),
    );
  };

  const lot = (over: Partial<ReplayedLot> = {}): ReplayedLot => ({
    quantity: 10,
    costBasis: 900,
    currencyCode: "PLN",
    basisKnown: true,
    basisGap: null,
    ...over,
  });

  it("uses a replayed basis that is known and in the account's currency", async () => {
    const result = await valuation(lot());

    // The replay's 900 PLN, not the stored 10 x 30 = 300.
    expect(result.holdingsWithValues[0].costBasisAccountCurrency).toBe(900);
    expect(result.totalCostBasis).toBe(900);
  });

  it("carries the market value in the account and reporting currencies from one snapshot (P9)", async () => {
    // Price 50 x 10 = 500, all in PLN here, so both converted figures equal the
    // market value and neither is null: the row now carries the value the
    // client used to re-derive with a second, drifting client-side rate.
    const result = await valuation(lot());

    const h = result.holdingsWithValues[0];
    expect(h.marketValue).toBe(500);
    expect(h.marketValueAccountCurrency).toBe(500);
    expect(h.marketValueDefaultCurrency).toBe(500);
  });

  it("ignores a basis denominated in another currency", async () => {
    const result = await valuation(lot({ currencyCode: "EUR" }));

    // 900 EUR is not 900 PLN, and there is no historical rate here to make it
    // one. Falls back to the stored average cost, which is at least a figure
    // about this holding in this currency.
    expect(result.holdingsWithValues[0].costBasisAccountCurrency).toBe(300);
    expect(result.totalCostBasis).toBe(300);
  });

  it("ignores a basis the replay could not price", async () => {
    const result = await valuation(
      lot({ basisKnown: false, basisGap: "quantity_only_action" }),
    );

    // The 900 covers only the part of the position the history prices.
    // Reported as the cost it becomes a confident number for a different
    // position.
    expect(result.holdingsWithValues[0].costBasisAccountCurrency).toBe(300);
  });

  /**
   * Invariant: a replayed basis is only the basis of the position it replayed.
   * Canonical adversarial input: an incomplete import -- history for half the
   * units the holding has (testing contract, missing data).
   * Minimal mutation: drop the quantity comparison from `knownCostBasesIn`.
   * Test that fails under it: the first of these two.
   * `calculateCostBasisLotsInAccountCurrency` states this rule for every caller;
   * this one did not apply it, so a basis for 5 shares was reported as the cost
   * of 10 and the missing half came out as gain.
   */
  it("ignores a basis replayed for fewer units than are held", async () => {
    const result = await valuation(lot({ quantity: 5, costBasis: 450 }));

    expect(result.holdingsWithValues[0].costBasisAccountCurrency).toBe(300);
    expect(result.totalCostBasis).toBe(300);
  });

  it("ignores a basis replayed for more units than are held", async () => {
    // The other direction is no safer: units sold outside the replayed window
    // leave a basis for a bigger position, which understates the gain.
    const result = await valuation(lot({ quantity: 15, costBasis: 1350 }));

    expect(result.holdingsWithValues[0].costBasisAccountCurrency).toBe(300);
  });

  it("accepts a quantity that differs only by dust", async () => {
    // A residual fraction from a sale is the same position, and refusing it
    // would throw away a good basis over rounding.
    const result = await valuation(lot({ quantity: 10.00001 }));

    expect(result.holdingsWithValues[0].costBasisAccountCurrency).toBe(900);
  });

  it("names the pair that actually failed when a basis cannot reach the account currency", async () => {
    // USD security in a PLN account, user default PLN, no USD->PLN rate. The
    // failed conversion is USD->PLN; recording it as accountCurrency->default
    // filed the gap under the degenerate "PLN->PLN" -- a pair that is not
    // missing -- so the report pointed the user (and any AI consumer) at a rate
    // that did not need fixing while never naming the one that did.
    const usdHolding = {
      ...holdingRow,
      security: { ...holdingRow.security, currencyCode: "USD" },
    };
    const holdingRepo = { find: jest.fn().mockResolvedValue([usdHolding]) };
    const txRepo = { find: jest.fn().mockResolvedValue([]) };
    const accountRepo = { find: jest.fn().mockResolvedValue([]) };
    const service = buildService(
      [
        [Holding, holdingRepo],
        [InvestmentTransaction, txRepo],
        [Account, accountRepo],
      ],
      { resolveStoredRate: storedRateDouble() },
    );
    jest
      .spyOn(service, "calculateCostBasisLotsInAccountCurrency")
      .mockResolvedValue(new Map());

    const result = await service.calculateHoldingsWithValues(
      userId,
      ["acct-1"],
      "PLN",
      new Map(),
      async () => new Map([["sec-a", 50]]),
    );

    expect(result.holdingsWithValues[0].costBasisAccountCurrency).toBeNull();
    expect(result.fxComplete).toBe(false);
    expect(result.missingRatePairs).toContain("USD->PLN");
    expect(result.missingRatePairs).not.toContain("PLN->PLN");
  });

  /**
   * A holding carries two cost-basis figures with two different definitions, and
   * they are labelled the same word on one screen: the portfolio card shows the
   * replayed `costBasisAccountCurrency`, which includes each purchase's
   * commission, while the holdings list's Cost Basis column shows the native
   * `costBasis`, which is `quantity x averageCost` and carries none --
   * `HoldingsService.updateHolding` blends only the price into the average.
   *
   * That is deliberate today, not an oversight, and the UI now says so in the
   * column's tooltip. It is pinned here because the difference is otherwise
   * invisible: both are plausible currency figures, and the gap is exactly the
   * commission. If a product decision later makes the native basis
   * commission-inclusive, this test is the one that has to change, and its
   * failure is the prompt to update the tooltip with it.
   */
  it("reads costBasis from the stored average cost and costBasisAccountCurrency from the replay", async () => {
    // Two cost-basis figures reach the holdings list from different sources and
    // the projection must not conflate them. `costBasis` is quantity times the
    // live `averageCost` -- which includes each purchase's commission
    // (P5-006/FR-008), so it is not a commission-free figure -- expressed in the
    // security's own currency. `costBasisAccountCurrency` is the replayed lot
    // basis in the account's currency. Both include commission; they can still
    // differ through currency conversion or the replay's lot handling versus a
    // running average, so the mock gives them distinct values to prove each field
    // is read from its own source rather than one overwriting the other. gainLoss
    // follows the native figure.
    const result = await valuation(lot({ costBasis: 305 }));
    const holding = result.holdingsWithValues[0];

    // 10 x stored averageCost 30.
    expect(holding.costBasis).toBe(300);
    // The replayed lot basis, surfaced as its own field.
    expect(holding.costBasisAccountCurrency).toBe(305);
    // Gain follows the native costBasis: 10 x 50 market - 300.
    expect(holding.gainLoss).toBe(200);
  });
});

/**
 * Invariant: a gain is the value of the holdings that joined the value total
 * less the cost of THOSE SAME holdings (audit A26-M38). Canonical adversarial
 * input: one priced and one unpriced holding. Minimal mutation: subtract
 * `totalCostBasis` (every holding's cost) from `totalHoldingsValue` again.
 * Test that fails under it: the first of these.
 */
describe("PortfolioCalculationService gain over the priced holdings (A26-M38)", () => {
  const userId = "user-1";

  const row = (
    id: string,
    securityId: string,
    quantity: number,
    averageCost: number,
    currencyCode = "PLN",
  ) => ({
    id,
    accountId: "acct-1",
    securityId,
    quantity,
    averageCost,
    security: {
      id: securityId,
      symbol: securityId.toUpperCase(),
      name: securityId,
      securityType: "STOCK",
      currencyCode,
    },
    account: { id: "acct-1", currencyCode: "PLN" },
  });

  const run = async (
    rows: ReturnType<typeof row>[],
    prices: Array<[string, number]>,
  ) => {
    const service = buildService(
      [
        [Holding, { find: jest.fn().mockResolvedValue(rows) }],
        [InvestmentTransaction, { find: jest.fn().mockResolvedValue([]) }],
        [Account, { find: jest.fn().mockResolvedValue([]) }],
      ],
      { resolveStoredRate: storedRateDouble() },
    );
    jest
      .spyOn(service, "calculateCostBasisLotsInAccountCurrency")
      .mockResolvedValue(new Map());
    return service.calculateHoldingsWithValues(
      userId,
      ["acct-1"],
      "PLN",
      new Map(),
      async () => new Map(prices),
    );
  };

  it("keeps an unpriced holding's cost out of the gain and reports it apart", async () => {
    // A: 1000 x 100 = 100,000 value, 1000 x 80 = 80,000 cost. B: no price, 50,000 cost.
    const result = await run(
      [row("h-a", "sec-a", 1000, 80), row("h-b", "sec-b", 500, 100)],
      [["sec-a", 100]],
    );

    expect(result.totalHoldingsValue).toBe(100000);
    expect(result.totalCostBasis).toBe(130000);
    expect(result.gainMarketValue).toBe(100000);
    expect(result.gainCostBasis).toBe(80000);
    expect(result.unpricedCostBasis).toBe(50000);
    expect(result.pricesComplete).toBe(false);
  });

  it("leaves a holding whose cost did not convert out of both sides of the gain", async () => {
    // B is USD in a PLN account with no USD->PLN rate: its value does not join
    // the value total either, so neither side of the gain carries it.
    const result = await run(
      [row("h-a", "sec-a", 1000, 80), row("h-b", "sec-b", 10, 5, "USD")],
      [
        ["sec-a", 100],
        ["sec-b", 7],
      ],
    );

    expect(result.gainMarketValue).toBe(100000);
    expect(result.gainCostBasis).toBe(80000);
    expect(result.unpricedCostBasis).toBe(0);
    expect(result.missingRatePairs).toContain("USD->PLN");
  });

  it("leaves a complete portfolio's gain as value less cost", async () => {
    const result = await run(
      [row("h-a", "sec-a", 1000, 80), row("h-b", "sec-b", 500, 100)],
      [
        ["sec-a", 100],
        ["sec-b", 120],
      ],
    );

    expect(result.gainMarketValue).toBe(result.totalHoldingsValue);
    expect(result.gainCostBasis).toBe(result.totalCostBasis);
    expect(result.unpricedCostBasis).toBe(0);
    expect(result.pricesComplete).toBe(true);
  });

  describe("per account", () => {
    const account = {
      id: "acct-1",
      name: "acct-1",
      currencyCode: "CAD",
      currentBalance: 0,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      linkedAccountId: null,
    } as unknown as Account;

    const held = (
      id: string,
      marketValue: number | null,
      cost: number,
    ): HoldingWithMarketValue =>
      ({
        id,
        accountId: "acct-1",
        securityId: `sec-${id}`,
        symbol: id,
        name: id,
        securityType: "STOCK",
        currencyCode: "CAD",
        quantity: 1,
        averageCost: cost,
        costBasis: cost,
        costBasisAccountCurrency: cost,
        currentPrice: marketValue,
        marketValue,
        gainLoss: null,
        gainLossPercent: null,
      }) as HoldingWithMarketValue;

    const build = async (holdings: HoldingWithMarketValue[]) => {
      const [result] = await buildService([], {}).buildHoldingsByAccount(
        {
          cashAccounts: [],
          brokerageAccounts: [account],
          standaloneAccounts: [],
          holdingsAccountIds: [],
        },
        holdings,
        new Map<string, number>(),
        new Map(),
        new Map<string, number>(),
      );
      return result;
    };

    it("takes the account's gain over its priced holdings only", async () => {
      const result = await build([
        held("a", 100000, 80000),
        held("b", null, 50000),
      ]);

      expect(result.totalGainLoss).toBe(20000);
      expect(result.totalGainLossPercent).toBe(25);
      expect(result.gainCostBasis).toBe(80000);
      expect(result.unpricedCostBasis).toBe(50000);
      expect(result.totalCostBasis).toBe(130000);
      expect(result.valuationComplete).toBe(false);
    });

    it("leaves a complete account unchanged", async () => {
      const result = await build([
        held("a", 100000, 80000),
        held("b", 40000, 50000),
      ]);

      expect(result.totalGainLoss).toBe(10000);
      expect(result.gainCostBasis).toBe(130000);
      expect(result.unpricedCostBasis).toBe(0);
      expect(result.valuationComplete).toBe(true);
    });

    it("reports a zero percent over a zero matched cost", async () => {
      const result = await build([held("b", null, 50000)]);

      expect(result.totalGainLoss).toBe(0);
      expect(result.totalGainLossPercent).toBe(0);
      expect(result.gainCostBasis).toBe(0);
      expect(result.unpricedCostBasis).toBe(50000);
    });
  });
});

/**
 * Invariant: a bond-linked holding is worth its own account's lots, never
 * quantity x the program-wide blend (bond-program-securities.md 2.4, audit H2).
 * Minimal mutation: price a linked holding as `quantity x priceMap.get(...)`.
 * Test that fails under it: the two-account case (1177.40 each instead of
 * 1354.00 and 1000.80).
 */
describe("PortfolioCalculationService.calculateHoldingsWithValues (bond-linked)", () => {
  const userId = "user-1";
  const BLEND = 117.74;

  const holdingOf = (
    id: string,
    accountId: string,
    securityId: string,
    over: { quantity?: number; linked?: boolean } = {},
  ) => ({
    id,
    accountId,
    securityId,
    quantity: over.quantity ?? 10,
    averageCost: 100,
    security: {
      id: securityId,
      symbol: securityId.toUpperCase(),
      name: securityId,
      securityType: "BOND",
      currencyCode: "PLN",
      bondProgramId: over.linked === false ? null : "prog-1",
    },
    account: { id: accountId, currencyCode: "PLN" },
  });

  const byAccount = (
    entries: Array<[string, number, string | null]>,
  ): SecurityValueByAccount => ({
    asOf: "2026-10-13",
    accounts: new Map(
      entries.map(([accountId, quantity, grossValue]) => [
        accountId,
        { quantity, grossValue },
      ]),
    ),
  });

  const run = async (
    holdings: ReturnType<typeof holdingOf>[],
    valueByAccount: jest.Mock,
    prices: Array<[string, number]> = holdings.map(
      (h) => [h.securityId, BLEND] as [string, number],
    ),
  ) => {
    const service = buildService(
      [
        [Holding, { find: jest.fn().mockResolvedValue(holdings) }],
        [InvestmentTransaction, { find: jest.fn().mockResolvedValue([]) }],
        [Account, { find: jest.fn().mockResolvedValue([]) }],
      ],
      { resolveStoredRate: storedRateDouble() },
      undefined,
      { valueByAccount },
    );
    jest
      .spyOn(service, "calculateCostBasisLotsInAccountCurrency")
      .mockResolvedValue(new Map());
    return service.calculateHoldingsWithValues(
      userId,
      ["ike", "reg"],
      "PLN",
      new Map(),
      async () => new Map(prices),
    );
  };

  it("values each account by its own lots, not by the blend", async () => {
    const valueByAccount = jest.fn().mockResolvedValue(
      byAccount([
        ["ike", 10, "1354.00"],
        ["reg", 10, "1000.80"],
      ]),
    );

    const result = await run(
      [holdingOf("h-1", "ike", "edo"), holdingOf("h-2", "reg", "edo")],
      valueByAccount,
    );

    const [ike, reg] = result.holdingsWithValues;
    expect(ike.marketValue).toBe(1354);
    expect(ike.currentPrice).toBe(135.4);
    expect(ike.gainLoss).toBe(354);
    expect(reg.marketValue).toBe(1000.8);
    expect(reg.currentPrice).toBe(100.08);
    expect(reg.gainLoss).toBeCloseTo(0.8, 10);
    expect(result.totalHoldingsValue).toBeCloseTo(2354.8, 10);
    expect(result.pricesComplete).toBe(true);
    // One valuation for the security, not one per holding.
    expect(valueByAccount).toHaveBeenCalledTimes(1);
    expect(valueByAccount).toHaveBeenCalledWith(userId, "edo", undefined);
  });

  it("leaves an account with an unknown lot unpriced and the total a subtotal", async () => {
    const result = await run(
      [holdingOf("h-1", "ike", "edo"), holdingOf("h-2", "reg", "edo")],
      jest.fn().mockResolvedValue(
        byAccount([
          ["ike", 10, null],
          ["reg", 10, "1000.80"],
        ]),
      ),
    );

    const [ike, reg] = result.holdingsWithValues;
    expect(ike.marketValue).toBeNull();
    expect(ike.currentPrice).toBeNull();
    expect(ike.gainLoss).toBeNull();
    expect(reg.marketValue).toBe(1000.8);
    expect(result.pricesComplete).toBe(false);
    expect(result.unpricedSecurityIds).toEqual(["edo"]);
    expect(result.totalHoldingsValue).toBe(1000.8);
  });

  it("leaves every holding unpriced when the lots are unknowable", async () => {
    const result = await run(
      [holdingOf("h-1", "ike", "edo")],
      jest.fn().mockResolvedValue({ asOf: "2026-10-13", accounts: null }),
    );

    expect(result.holdingsWithValues[0].marketValue).toBeNull();
    expect(result.pricesComplete).toBe(false);
  });

  it("never prices a different quantity than the holding's", async () => {
    const result = await run(
      [holdingOf("h-1", "ike", "edo", { quantity: 10 })],
      jest.fn().mockResolvedValue(byAccount([["ike", 8, "1083.20"]])),
    );

    expect(result.holdingsWithValues[0].marketValue).toBeNull();
    expect(result.unpricedSecurityIds).toEqual(["edo"]);
  });

  it("leaves a holding with no lots in its account unpriced", async () => {
    const result = await run(
      [holdingOf("h-1", "ike", "edo")],
      jest.fn().mockResolvedValue(byAccount([["reg", 10, "1000.80"]])),
    );

    expect(result.holdingsWithValues[0].marketValue).toBeNull();
  });

  it("prices the other holdings when one security's valuation throws", async () => {
    const valueByAccount = jest.fn().mockImplementation(async (_u, id) => {
      if (id === "edo") throw new Error("boom");
      return byAccount([["ike", 10, "1000.00"]]);
    });

    const result = await run(
      [
        holdingOf("h-1", "ike", "edo"),
        holdingOf("h-2", "ike", "tos"),
        holdingOf("h-3", "ike", "stock", { linked: false }),
      ],
      valueByAccount,
      [
        ["edo", BLEND],
        ["tos", BLEND],
        ["stock", 50],
      ],
    );

    const [edo, tos, stock] = result.holdingsWithValues;
    expect(edo.marketValue).toBeNull();
    expect(tos.marketValue).toBe(1000);
    expect(stock.marketValue).toBe(500);
    expect(result.unpricedSecurityIds).toEqual(["edo"]);
    expect(result.pricesComplete).toBe(false);
  });

  it("leaves a non-bond security on quantity x price and never values it as a bond", async () => {
    const valueByAccount = jest.fn();

    const result = await run(
      [holdingOf("h-1", "ike", "stock", { linked: false })],
      valueByAccount,
      [["stock", 50]],
    );

    expect(result.holdingsWithValues[0].marketValue).toBe(500);
    expect(valueByAccount).not.toHaveBeenCalled();
  });
});

describe("PortfolioCalculationService.computeInvestmentFlows", () => {
  it("counts a return of capital with the sale proceeds, not with income (#1800)", async () => {
    // Net invested is cash + buys - sells - income. A return of capital puts
    // cash in the sleeve that no deposit put there, and it is capital coming
    // back, not earnings: it belongs with the proceeds.
    const rawQuery = jest
      .fn()
      .mockResolvedValue([
        { account_id: "acct-1", buys: "1000", sells: "250", income: "40" },
      ]);
    const service = buildService([], {}, rawQuery);

    const flows = await service.computeInvestmentFlows("user-1", ["acct-1"]);

    const params = rawQuery.mock.calls[0][1] as unknown[];
    expect(params[2]).toEqual(
      expect.arrayContaining([
        InvestmentAction.SELL,
        InvestmentAction.REDEEM,
        InvestmentAction.RETURN_OF_CAPITAL,
      ]),
    );
    expect(params[3]).not.toContain(InvestmentAction.RETURN_OF_CAPITAL);
    expect(flows.get("acct-1")).toEqual({ buys: 1000, sells: 250, income: 40 });
  });
});
