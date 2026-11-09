import { PortfolioService } from "./portfolio.service";
import { PortfolioCalculationService } from "./portfolio-calculation.service";
import { Holding } from "./entities/holding.entity";
import { SecurityPrice } from "./entities/security-price.entity";
import { Security } from "./entities/security.entity";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "./entities/investment-transaction.entity";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { requestContextStorage } from "../common/request-context";
import { PortfolioPeriodResultService } from "../net-worth/portfolio-period-result.service";
import {
  NetWorthService,
  type DailyInvestmentsWithPositions,
} from "../net-worth/net-worth.service";
import { NO_INVESTED_PERIOD } from "../net-worth/invested-period-result.util";
import {
  EMPTY_INCOMPLETE_RANGES,
  type IncompleteDataRanges,
} from "../net-worth/incomplete-data-ranges.util";
import { EMPTY_RETURN_DIAGNOSTICS } from "./return-diagnostics.util";
import {
  invalidatePortfolioSummary,
  portfolioSummaryMemo,
} from "./portfolio-summary-memo";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("PortfolioService", () => {
  let service: PortfolioService;
  let bondValuation: { valueByAccount: jest.Mock };
  let holdingsRepository: Record<string, jest.Mock>;
  let securityPriceRepository: Record<string, jest.Mock>;
  let securityRepository: Record<string, jest.Mock>;
  let investmentTransactionRepository: Record<string, jest.Mock>;
  let accountsRepository: Record<string, jest.Mock>;
  let prefRepository: Record<string, jest.Mock>;
  let exchangeRateService: Record<string, jest.Mock>;
  let yahooFinanceService: Record<string, jest.Mock>;
  let quoteProviderRegistry: { resolveForSecurity: jest.Mock };
  let sectorWeightingService: { getLlmLookThrough: jest.Mock };
  let periodResultService: { getInvestedResultSinceInception: jest.Mock };
  let netWorthService: {
    getDailyInvestmentPositions: jest.MockedFunction<
      NetWorthService["getDailyInvestmentPositions"]
    >;
    getLastPricedDays: jest.MockedFunction<
      NetWorthService["getLastPricedDays"]
    >;
  };

  const userId = "user-1";

  /**
   * What the invested measure answers for one window, as the real service
   * would: a mock returns what the real collaborator returns, so the summary's
   * fields are exercised through the shape the route actually produces.
   */
  const investedSince = (
    overrides: Partial<{
      investmentReturnPercent: number | null;
      investmentMoneyWeightedReturnPercent: number | null;
      investedReasons: string[];
      startDate: string;
      incompleteRanges: IncompleteDataRanges;
    }> = {},
  ) => ({
    currency: "CAD",
    startDate: "2025-06-14",
    endDate: "2026-02-24",
    startValue: null,
    endValue: null,
    valueChange: null,
    netExternalFlows: null,
    knownFlowSubtotal: 0,
    investmentResult: null,
    returnPercent: null,
    returnMethod: "simple" as const,
    complete: false,
    reasons: [] as string[],
    missingRatePairs: [],
    unpricedSecurityIds: [],
    unknownCashAccountIds: [],
    incompleteRanges: EMPTY_INCOMPLETE_RANGES,
    ...NO_INVESTED_PERIOD,
    investedReasons: [] as string[],
    ...overrides,
  });

  // -- Mock accounts --
  const mockBrokerageAccount: Partial<Account> = {
    id: "acct-brokerage-1",
    userId,
    name: "TFSA - Brokerage",
    accountType: AccountType.INVESTMENT,
    accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
    currencyCode: "CAD",
    currentBalance: 0,
    isClosed: false,
    linkedAccountId: "acct-cash-1",
  };

  const mockCashAccount: Partial<Account> = {
    id: "acct-cash-1",
    userId,
    name: "TFSA - Cash",
    accountType: AccountType.INVESTMENT,
    accountSubType: AccountSubType.INVESTMENT_CASH,
    currencyCode: "CAD",
    currentBalance: 5000,
    isClosed: false,
    linkedAccountId: "acct-brokerage-1",
  };

  const mockStandaloneAccount: Partial<Account> = {
    id: "acct-standalone-1",
    userId,
    name: "Wealthsimple",
    accountType: AccountType.INVESTMENT,
    accountSubType: null,
    currencyCode: "CAD",
    currentBalance: 2000,
    isClosed: false,
    linkedAccountId: null,
  };

  // -- Mock securities (attached to holdings via .security) --
  const mockSecurityAAPL = {
    id: "sec-1",
    symbol: "AAPL",
    name: "Apple Inc.",
    securityType: "STOCK",
    currencyCode: "USD",
    isActive: true,
  };

  const mockSecurityVFV = {
    id: "sec-2",
    symbol: "VFV.TO",
    name: "Vanguard S&P 500 ETF",
    securityType: "ETF",
    currencyCode: "CAD",
    isActive: true,
  };

  const mockSecurityXIC = {
    id: "sec-3",
    symbol: "XIC.TO",
    name: "iShares Core S&P/TSX",
    securityType: "ETF",
    currencyCode: "CAD",
    isActive: true,
  };

  // -- Mock holdings (account relation mirrors the brokerage/standalone) --
  const mockHoldingAAPL: Partial<Holding> = {
    id: "hold-1",
    accountId: "acct-brokerage-1",
    securityId: "sec-1",
    quantity: 10 as any,
    averageCost: 150 as any,
    security: mockSecurityAAPL as any,
    account: mockBrokerageAccount as any,
  };

  const mockHoldingVFV: Partial<Holding> = {
    id: "hold-2",
    accountId: "acct-brokerage-1",
    securityId: "sec-2",
    quantity: 50 as any,
    averageCost: 80 as any,
    security: mockSecurityVFV as any,
    account: mockBrokerageAccount as any,
  };

  const mockHoldingXIC: Partial<Holding> = {
    id: "hold-3",
    accountId: "acct-standalone-1",
    securityId: "sec-3",
    quantity: 100 as any,
    averageCost: 30 as any,
    security: mockSecurityXIC as any,
    account: mockStandaloneAccount as any,
  };

  // -- Mock user preference --
  const mockPref: Partial<UserPreference> = {
    userId,
    defaultCurrency: "CAD",
  };

  beforeEach(async () => {
    // The summary memo is process-wide and survives between tests, which is the
    // point in production and a source of cross-test contamination here: two
    // cases that ask the same user for the same scope would otherwise share the
    // first one's fixtures for a minute.
    portfolioSummaryMemo.clearAll();
    holdingsRepository = {
      find: jest.fn(),
      // primeLiveRates queries distinct holding currencies via the query
      // builder. Default: no rows, so only account currencies are considered.
      createQueryBuilder: jest.fn(() => ({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      })),
    };

    securityPriceRepository = {
      query: jest.fn(),
    };

    // Only the return diagnostics read it, and only for a security the
    // summary's own holdings do not name.
    securityRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    investmentTransactionRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    accountsRepository = {
      find: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    };

    prefRepository = {
      findOne: jest.fn(),
    };

    exchangeRateService = {
      getLatestRate: jest.fn(),
      // `resolveStoredRate` is the door `convertToDefault` asks. It answers
      // from the same stored pairs these tests configure through
      // `getLatestRate`, direct then inverse, in the resolution shape the real
      // method returns -- a double that handed back a bare number could not
      // express the "unknown, and here is why" half the callers branch on.
      resolveStoredRate: jest.fn(async (from: string, to: string) => {
        const direct = await exchangeRateService.getLatestRate(from, to);
        const usableDirect = direct != null && direct > 0 ? direct : null;
        const inverse = usableDirect
          ? null
          : await exchangeRateService.getLatestRate(to, from);
        const usableInverse = inverse != null && inverse > 0 ? inverse : null;
        const rate = usableDirect ?? (usableInverse ? 1 / usableInverse : null);
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
          observedRate: usableDirect ?? usableInverse,
          observedOn: "2026-02-07",
          direction: usableDirect ? "direct" : "inverse",
          ageDays: 0,
          reason: null,
        };
      }),
      // Default: no live quote available, so primeLiveRates leaves the cache
      // unset and conversions fall back to the stored getLatestRate path that
      // these tests configure. Tests for the live-rate path override this.
      getLiveRate: jest.fn().mockResolvedValue(null),
      // Default: no stored daily history, so the intraday chart's date-aware
      // FX fallback resolves nothing and drops through to the latest spot.
      // Tests for the historical-fallback path override this.
      getRateHistory: jest.fn().mockResolvedValue([]),
    };

    yahooFinanceService = {
      fetchIntradaySeries: jest.fn(),
      // Default: no intraday FX series available. Tests that exercise the
      // FX-per-timestamp path mock this explicitly. When this returns null
      // the chart falls back to the latest spot from ExchangeRateService.
      fetchIntradayFxSeries: jest.fn().mockResolvedValue(null),
    };

    // Default: every security resolves to a Yahoo-like provider that exposes
    // fetchIntradaySeries. Tests for MSN override this per-security.
    quoteProviderRegistry = {
      resolveForSecurity: jest.fn().mockReturnValue([
        {
          name: "yahoo",
          fetchIntradaySeries: yahooFinanceService.fetchIntradaySeries,
        },
      ]),
    };

    // getLlmSummary only calls this when includeLookThrough is set.
    sectorWeightingService = {
      getLlmLookThrough: jest.fn().mockResolvedValue({
        totalPortfolioValue: 1000,
        byCountry: {
          items: [{ name: "United States", value: 750, percentage: 75 }],
          unclassifiedValue: 250,
          unclassifiedPercentage: 25,
        },
        byAssetClass: {
          items: [{ name: "Equity", value: 600, percentage: 60 }],
          unclassifiedValue: 400,
          unclassifiedPercentage: 40,
        },
      }),
    };

    const { manager, dataSource } = createScopedDbMocks([
      [Holding, holdingsRepository],
      [SecurityPrice, securityPriceRepository],
      [Security, securityRepository],
      [InvestmentTransaction, investmentTransactionRepository],
      [Account, accountsRepository],
      [UserPreference, prefRepository],
    ]);
    // Every raw statement now runs through the transaction manager. Route it
    // back to the two mocks the assertions already use -- price history vs.
    // everything else -- so each test's fixtures stay independent.
    manager.query.mockImplementation((sql: string, params?: unknown[]) =>
      /security_prices/.test(sql)
        ? securityPriceRepository.query(sql, params)
        : accountsRepository.query(sql, params),
    );

    bondValuation = { valueByAccount: jest.fn() };
    const calculationService = new PortfolioCalculationService(
      dataSource as never,
      exchangeRateService as never,
      bondValuation as never,
    );
    // Default: a portfolio with no investment transaction at all, which is the
    // empty decision rather than a zero return.
    periodResultService = {
      getInvestedResultSinceInception: jest.fn().mockResolvedValue(
        investedSince({
          investmentReturnPercent: null,
          investedReasons: ["noValueSeries"],
        }),
      ),
    };

    // Default: a scope with no investment account for the ledger fold to
    // replay, which is what the real method answers for one -- the intraday
    // loader then reads today's holdings and balances. The per-day ledger
    // tests configure the days explicitly.
    netWorthService = {
      getDailyInvestmentPositions: jest.fn().mockResolvedValue({
        series: [],
        positions: [],
        securities: new Map(),
      }),
      getLastPricedDays: jest.fn().mockResolvedValue(new Map()),
    };

    service = new PortfolioService(
      dataSource as never,
      calculationService,
      yahooFinanceService as never,
      quoteProviderRegistry as never,
      sectorWeightingService as never,
      periodResultService as unknown as PortfolioPeriodResultService,
      netWorthService as unknown as NetWorthService,
    );
  });

  describe("getLatestPrices", () => {
    it("returns an empty map when securityIds is empty", async () => {
      const result = await service.getLatestPrices([]);

      expect(result).toEqual(new Map());
      expect(securityPriceRepository.query).not.toHaveBeenCalled();
    });

    it("returns a map of securityId to close price", async () => {
      securityPriceRepository.query.mockResolvedValue([
        {
          security_id: "sec-1",
          close_price: "175.50",
          price_date: "2026-02-07",
        },
        {
          security_id: "sec-2",
          close_price: "95.25",
          price_date: "2026-02-07",
        },
      ]);

      const result = await service.getLatestPrices(["sec-1", "sec-2"]);

      expect(result.get("sec-1")).toBe(175.5);
      expect(result.get("sec-2")).toBe(95.25);
      expect(result.size).toBe(2);
      expect(securityPriceRepository.query).toHaveBeenCalledWith(
        expect.stringContaining("DISTINCT ON"),
        [["sec-1", "sec-2"]],
      );
    });

    it("handles securities with no price data", async () => {
      securityPriceRepository.query.mockResolvedValue([]);

      const result = await service.getLatestPrices(["sec-1"]);

      expect(result.size).toBe(0);
    });
  });

  describe("getInvestmentAccounts", () => {
    it("returns open investment accounts for the user", async () => {
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);

      const result = await service.getInvestmentAccounts(userId);

      expect(accountsRepository.find).toHaveBeenCalledWith({
        where: {
          userId,
          accountType: AccountType.INVESTMENT,
          isClosed: false,
        },
      });
      expect(result).toHaveLength(2);
    });

    it("returns empty array when user has no investment accounts", async () => {
      accountsRepository.find.mockResolvedValue([]);

      const result = await service.getInvestmentAccounts(userId);

      expect(result).toHaveLength(0);
    });
  });

  describe("getPortfolioSummary", () => {
    describe("when user has brokerage and cash accounts with holdings", () => {
      beforeEach(() => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([
          mockHoldingAAPL,
          mockHoldingVFV,
        ]);
        // Latest prices: AAPL=175, VFV=95
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-1",
            close_price: "175",
            price_date: "2026-02-07",
          },
          { security_id: "sec-2", close_price: "95", price_date: "2026-02-07" },
        ]);
        // USD->CAD rate for AAPL conversion
        exchangeRateService.getLatestRate.mockImplementation(
          (from: string, to: string) => {
            if (from === "USD" && to === "CAD") return Promise.resolve(1.35);
            if (from === "CAD" && to === "USD") return Promise.resolve(null);
            return Promise.resolve(null);
          },
        );
      });

      it("returns correct portfolio totals", async () => {
        const result = await service.getPortfolioSummary(userId);

        // Cash: 5000 CAD (cash account)
        expect(result.totalCashValue).toBe(5000);

        // AAPL: 10 * 175 = 1750 USD * 1.35 = 2362.5 CAD
        // VFV: 50 * 95 = 4750 CAD (same currency, no conversion)
        expect(result.totalHoldingsValue).toBe(2362.5 + 4750);

        // Cost basis: AAPL: 10*150=1500 USD * 1.35 = 2025 CAD, VFV: 50*80=4000 CAD
        expect(result.totalCostBasis).toBe(2025 + 4000);

        expect(result.totalPortfolioValue).toBe(
          result.totalCashValue + result.totalHoldingsValue,
        );
      });

      it("returns holdings with calculated market values", async () => {
        const result = await service.getPortfolioSummary(userId);

        expect(result.holdings).toHaveLength(2);

        // Holdings should be sorted by market value descending
        // VFV: 50*95=4750, AAPL: 10*175=1750
        expect(result.holdings[0].symbol).toBe("VFV.TO");
        expect(result.holdings[0].marketValue).toBe(4750);
        expect(result.holdings[1].symbol).toBe("AAPL");
        expect(result.holdings[1].marketValue).toBe(1750);
      });

      it("calculates gain/loss correctly per holding", async () => {
        const result = await service.getPortfolioSummary(userId);

        const aaplHolding = result.holdings.find((h) => h.symbol === "AAPL");
        expect(aaplHolding).toBeDefined();
        // costBasis = 10 * 150 = 1500, marketValue = 10 * 175 = 1750
        expect(aaplHolding!.costBasis).toBe(1500);
        expect(aaplHolding!.gainLoss).toBe(250);
        expect(aaplHolding!.gainLossPercent).toBeCloseTo(16.6667, 2);
      });

      it("returns holdings grouped by account", async () => {
        const result = await service.getPortfolioSummary(userId);

        expect(result.holdingsByAccount).toHaveLength(1);
        const brokerageGroup = result.holdingsByAccount[0];
        expect(brokerageGroup.accountId).toBe("acct-brokerage-1");
        // Name strips " - Brokerage" suffix
        expect(brokerageGroup.accountName).toBe("TFSA");
        expect(brokerageGroup.cashAccountId).toBe("acct-cash-1");
        expect(brokerageGroup.cashBalance).toBe(5000);
        expect(brokerageGroup.holdings).toHaveLength(2);
      });

      it("includes allocation data", async () => {
        const result = await service.getPortfolioSummary(userId);

        expect(result.allocation.length).toBeGreaterThan(0);

        // Should have cash entry + 2 securities
        const cashAlloc = result.allocation.find((a) => a.type === "cash");
        expect(cashAlloc).toBeDefined();
        expect(cashAlloc!.name).toBe("Cash");
        expect(cashAlloc!.value).toBe(5000);

        const securityAllocs = result.allocation.filter(
          (a) => a.type === "security",
        );
        expect(securityAllocs).toHaveLength(2);
      });

      it("sorts allocation by value descending", async () => {
        const result = await service.getPortfolioSummary(userId);

        for (let i = 0; i < result.allocation.length - 1; i++) {
          expect(result.allocation[i].value).toBeGreaterThanOrEqual(
            result.allocation[i + 1].value,
          );
        }
      });
    });

    describe("when brokerage account holds securities in a different currency", () => {
      beforeEach(() => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        // AAPL (USD) and VFV (CAD) both in the same CAD brokerage account
        holdingsRepository.find.mockResolvedValue([
          mockHoldingAAPL,
          mockHoldingVFV,
        ]);
        // AAPL=175, VFV=95
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-1",
            close_price: "175",
            price_date: "2026-02-07",
          },
          { security_id: "sec-2", close_price: "95", price_date: "2026-02-07" },
        ]);
        // USD->CAD rate
        exchangeRateService.getLatestRate.mockImplementation(
          (from: string, to: string) => {
            if (from === "USD" && to === "CAD") return Promise.resolve(1.35);
            if (from === "CAD" && to === "USD") return Promise.resolve(null);
            return Promise.resolve(null);
          },
        );
      });

      it("converts holdings to account currency for account-level totals", async () => {
        const result = await service.getPortfolioSummary(userId);

        const acct = result.holdingsByAccount[0];
        expect(acct.currencyCode).toBe("CAD");

        // VFV (CAD): costBasis = 50*80 = 4000, marketValue = 50*95 = 4750
        // AAPL (USD): costBasis = 10*150 = 1500 * 1.35 = 2025 CAD
        //             marketValue = 10*175 = 1750 * 1.35 = 2362.5 CAD
        expect(acct.totalCostBasis).toBeCloseTo(4000 + 2025, 2);
        expect(acct.totalMarketValue).toBeCloseTo(4750 + 2362.5, 2);
        expect(acct.totalGainLoss).toBeCloseTo(
          acct.totalMarketValue - acct.totalCostBasis,
          2,
        );
      });

      it("keeps individual holding values in their native currency", async () => {
        const result = await service.getPortfolioSummary(userId);

        const aaplHolding = result.holdings.find((h) => h.symbol === "AAPL");
        // Individual holding values stay in USD (not converted)
        expect(aaplHolding!.costBasis).toBe(1500);
        expect(aaplHolding!.marketValue).toBe(1750);
        expect(aaplHolding!.currencyCode).toBe("USD");
      });
    });

    describe("when the same security is held in multiple accounts", () => {
      beforeEach(() => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
          mockStandaloneAccount,
        ]);
        // VFV held in both the brokerage and standalone accounts
        holdingsRepository.find.mockResolvedValue([
          mockHoldingVFV,
          {
            id: "hold-4",
            accountId: "acct-standalone-1",
            securityId: "sec-2",
            quantity: 25 as any,
            averageCost: 82 as any,
            security: mockSecurityVFV as any,
            account: mockStandaloneAccount as any,
          },
        ]);
        securityPriceRepository.query.mockResolvedValue([
          { security_id: "sec-2", close_price: "95", price_date: "2026-02-07" },
        ]);
        exchangeRateService.getLatestRate.mockResolvedValue(null);
      });

      it("consolidates the security into a single allocation slice", async () => {
        const result = await service.getPortfolioSummary(userId);

        const vfvAllocs = result.allocation.filter(
          (a) => a.symbol === "VFV.TO",
        );
        expect(vfvAllocs).toHaveLength(1);
        // Combined market value: 50*95 + 25*95 = 4750 + 2375 = 7125
        expect(vfvAllocs[0].value).toBe(7125);
      });

      it("retains per-account holdings in holdingsByAccount", async () => {
        const result = await service.getPortfolioSummary(userId);

        // The underlying holdings are still split per account
        expect(result.holdingsByAccount).toHaveLength(2);
        expect(result.holdings).toHaveLength(2);
      });
    });

    describe("when user has standalone investment accounts", () => {
      beforeEach(() => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([mockStandaloneAccount]);
        holdingsRepository.find.mockResolvedValue([mockHoldingXIC]);
        securityPriceRepository.query.mockResolvedValue([
          { security_id: "sec-3", close_price: "35", price_date: "2026-02-07" },
        ]);
        exchangeRateService.getLatestRate.mockResolvedValue(null);
      });

      it("includes standalone account balance as cash", async () => {
        const result = await service.getPortfolioSummary(userId);

        // Standalone account's currentBalance = 2000 (treated as cash)
        expect(result.totalCashValue).toBe(2000);
      });

      it("includes standalone account holdings", async () => {
        const result = await service.getPortfolioSummary(userId);

        expect(result.holdings).toHaveLength(1);
        expect(result.holdings[0].symbol).toBe("XIC.TO");
        expect(result.holdings[0].marketValue).toBe(100 * 35);
      });

      it("sets cashAccountId to the standalone account id", async () => {
        const result = await service.getPortfolioSummary(userId);

        expect(result.holdingsByAccount).toHaveLength(1);
        expect(result.holdingsByAccount[0].cashAccountId).toBe(
          "acct-standalone-1",
        );
        expect(result.holdingsByAccount[0].cashBalance).toBe(2000);
      });
    });

    describe("when filtering by accountIds", () => {
      beforeEach(() => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        exchangeRateService.getLatestRate.mockResolvedValue(null);
      });

      it("fetches requested accounts plus linked accounts", async () => {
        accountsRepository.find
          // First call: fetch requested accounts
          .mockResolvedValueOnce([mockBrokerageAccount])
          // Second call: fetch linked accounts that weren't in the original request
          .mockResolvedValueOnce([mockCashAccount])
          // Third call: computeEffectiveBalances
          .mockResolvedValueOnce([mockCashAccount]);
        holdingsRepository.find.mockResolvedValue([]);
        securityPriceRepository.query.mockResolvedValue([]);

        await service.getPortfolioSummary(userId, ["acct-brokerage-1"]);

        // Should have made 3 find calls: initial + linked + effectiveBalances
        expect(accountsRepository.find).toHaveBeenCalledTimes(3);
        expect(accountsRepository.find).toHaveBeenNthCalledWith(1, {
          where: {
            id: expect.anything(),
            userId,
            accountType: AccountType.INVESTMENT,
          },
        });
      });

      it("restricts requested and linked fetches to INVESTMENT accounts so non-investment readable accounts (delegate) never leak in", async () => {
        accountsRepository.find
          .mockResolvedValueOnce([mockBrokerageAccount])
          .mockResolvedValueOnce([mockCashAccount])
          .mockResolvedValueOnce([mockCashAccount]);
        holdingsRepository.find.mockResolvedValue([]);
        securityPriceRepository.query.mockResolvedValue([]);

        await service.getPortfolioSummary(userId, [
          "acct-brokerage-1",
          "acct-chequing-1",
        ]);

        expect(accountsRepository.find).toHaveBeenNthCalledWith(1, {
          where: expect.objectContaining({
            accountType: AccountType.INVESTMENT,
          }),
        });
        expect(accountsRepository.find).toHaveBeenNthCalledWith(2, {
          where: expect.objectContaining({
            accountType: AccountType.INVESTMENT,
          }),
        });
      });

      it("does not fetch linked accounts if all are already included", async () => {
        accountsRepository.find
          .mockResolvedValueOnce([mockBrokerageAccount, mockCashAccount])
          // Second call: computeEffectiveBalances
          .mockResolvedValueOnce([mockCashAccount]);
        holdingsRepository.find.mockResolvedValue([]);
        securityPriceRepository.query.mockResolvedValue([]);

        await service.getPortfolioSummary(userId, [
          "acct-brokerage-1",
          "acct-cash-1",
        ]);

        // 2 find calls: initial + effectiveBalances (no linked fetch needed)
        expect(accountsRepository.find).toHaveBeenCalledTimes(2);
      });
    });

    describe("when user has no preferences", () => {
      /**
       * This case was titled "defaults to CAD as the default currency" and
       * asserted only that the totals were zero, so it stayed green through the
       * change that moved this surface's fallback from CAD to the shared USD --
       * a title claiming more than the body checks is a test that cannot fail
       * for the reason it names. The currency claim now lives where it is
       * observable and machine-checked (`common/default-currency.guard.spec.ts`
       * routes every reader through one constant and pins it to the column's own
       * default); what is asserted HERE is what this case really covers: a
       * missing preference row is not an error.
       */
      it("still answers when no preference row exists", async () => {
        prefRepository.findOne.mockResolvedValue(null);
        accountsRepository.find.mockResolvedValue([]);
        holdingsRepository.find.mockResolvedValue([]);
        securityPriceRepository.query.mockResolvedValue([]);

        const result = await service.getPortfolioSummary(userId);

        // Zero, not unknown: an empty portfolio holds nothing, and that is a
        // settled answer needing no exchange rate at all.
        expect(result.totalCashValue).toBe(0);
        expect(result.totalPortfolioValue).toBe(0);
      });
    });

    describe("when holdings have zero quantity", () => {
      it("skips holdings with zero quantity", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([
          { ...mockHoldingAAPL, quantity: 0 },
          mockHoldingVFV,
        ]);
        securityPriceRepository.query.mockResolvedValue([
          { security_id: "sec-2", close_price: "95", price_date: "2026-02-07" },
        ]);
        exchangeRateService.getLatestRate.mockResolvedValue(null);

        const result = await service.getPortfolioSummary(userId);

        // Only VFV should be included
        expect(result.holdings).toHaveLength(1);
        expect(result.holdings[0].symbol).toBe("VFV.TO");
      });

      it("skips holdings with near-zero quantity", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([
          { ...mockHoldingAAPL, quantity: 0.00001 },
          { ...mockHoldingVFV, quantity: -0.00005 },
          mockHoldingXIC,
        ]);
        securityPriceRepository.query.mockResolvedValue([
          { security_id: "sec-3", close_price: "35", price_date: "2026-02-07" },
        ]);
        exchangeRateService.getLatestRate.mockResolvedValue(null);

        const result = await service.getPortfolioSummary(userId);

        // Only XIC (quantity 100) should be included; near-zero holdings filtered out
        expect(result.holdings).toHaveLength(1);
        expect(result.holdings[0].symbol).toBe("XIC.TO");
      });
    });

    describe("when no prices are available for a security", () => {
      it("sets marketValue, gainLoss, gainLossPercent to null", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);
        securityPriceRepository.query.mockResolvedValue([]); // No prices
        exchangeRateService.getLatestRate.mockResolvedValue(null);

        const result = await service.getPortfolioSummary(userId);

        expect(result.holdings).toHaveLength(1);
        expect(result.holdings[0].currentPrice).toBeNull();
        expect(result.holdings[0].marketValue).toBeNull();
        expect(result.holdings[0].gainLoss).toBeNull();
        expect(result.holdings[0].gainLossPercent).toBeNull();
      });
    });

    describe("when holding has zero averageCost", () => {
      it("computes gainLoss from market value and sets gainLossPercent to null", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([
          { ...mockHoldingAAPL, averageCost: 0 },
        ]);
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-1",
            close_price: "175",
            price_date: "2026-02-07",
          },
        ]);
        exchangeRateService.getLatestRate.mockImplementation(
          (from: string, to: string) => {
            if (from === "USD" && to === "CAD") return Promise.resolve(1.35);
            return Promise.resolve(null);
          },
        );

        const result = await service.getPortfolioSummary(userId);

        expect(result.holdings).toHaveLength(1);
        expect(result.holdings[0].marketValue).toBe(1750);
        // costBasis is 0, gainLoss = marketValue - costBasis = 1750
        expect(result.holdings[0].gainLoss).toBe(1750);
        // gainLossPercent is null because dividing by zero costBasis is undefined
        expect(result.holdings[0].gainLossPercent).toBeNull();
      });
    });

    describe("when holding has null averageCost", () => {
      it("treats averageCost as 0", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([
          { ...mockHoldingAAPL, averageCost: null },
        ]);
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-1",
            close_price: "175",
            price_date: "2026-02-07",
          },
        ]);
        exchangeRateService.getLatestRate.mockImplementation(
          (from: string, to: string) => {
            if (from === "USD" && to === "CAD") return Promise.resolve(1.35);
            return Promise.resolve(null);
          },
        );

        const result = await service.getPortfolioSummary(userId);

        expect(result.holdings[0].averageCost).toBe(0);
        expect(result.holdings[0].costBasis).toBe(0);
      });
    });

    describe("currency conversion", () => {
      it("uses reverse rate when direct rate is not available", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-1",
            close_price: "175",
            price_date: "2026-02-07",
          },
        ]);
        // Direct USD->CAD returns null, reverse CAD->USD returns 0.74
        exchangeRateService.getLatestRate.mockImplementation(
          (from: string, to: string) => {
            if (from === "USD" && to === "CAD") return Promise.resolve(null);
            if (from === "CAD" && to === "USD") return Promise.resolve(0.74);
            return Promise.resolve(null);
          },
        );

        const result = await service.getPortfolioSummary(userId);

        // Rate should be 1/0.74 = ~1.3514
        const expectedRate = 1 / 0.74;
        const expectedHoldingsValue = 10 * 175 * expectedRate;
        expect(result.totalHoldingsValue).toBeCloseTo(expectedHoldingsValue, 2);
      });

      it("omits a holding it cannot convert instead of using a rate of 1", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-1",
            close_price: "175",
            price_date: "2026-02-07",
          },
        ]);
        // No rates available at all
        exchangeRateService.getLatestRate.mockResolvedValue(null);

        const result = await service.getPortfolioSummary(userId);

        // A USD holding with no USD->CAD rate is NOT reported as though 1 USD
        // were 1 CAD (audit P5-009). This assertion previously read
        // `toBe(10 * 175)` under the name "uses rate of 1 ...", documenting the
        // defect as intended behaviour.
        expect(result.totalHoldingsValue).toBe(0);
      });

      it("caches exchange rates for repeated conversions", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        // Two holdings in USD - should only look up USD->CAD once
        const secondUSDHolding = {
          ...mockHoldingVFV,
          id: "hold-usd-2",
          securityId: "sec-usd-2",
          security: {
            ...mockSecurityAAPL,
            id: "sec-usd-2",
            symbol: "MSFT",
            name: "Microsoft",
          },
        };
        holdingsRepository.find.mockResolvedValue([
          mockHoldingAAPL,
          secondUSDHolding,
        ]);
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-1",
            close_price: "175",
            price_date: "2026-02-07",
          },
          {
            security_id: "sec-usd-2",
            close_price: "400",
            price_date: "2026-02-07",
          },
        ]);
        exchangeRateService.getLatestRate.mockImplementation(
          (from: string, to: string) => {
            if (from === "USD" && to === "CAD") return Promise.resolve(1.35);
            return Promise.resolve(null);
          },
        );

        await service.getPortfolioSummary(userId);

        // getLatestRate for USD->CAD should be called only once due to caching
        const usdToCadCalls =
          exchangeRateService.getLatestRate.mock.calls.filter(
            ([from, to]: [string, string]) => from === "USD" && to === "CAD",
          );
        expect(usdToCadCalls).toHaveLength(1);
      });

      it("does not convert when holding currency matches default", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([mockHoldingVFV]); // VFV is in CAD
        securityPriceRepository.query.mockResolvedValue([
          { security_id: "sec-2", close_price: "95", price_date: "2026-02-07" },
        ]);

        const result = await service.getPortfolioSummary(userId);

        // No exchange rate lookups needed
        expect(exchangeRateService.getLatestRate).not.toHaveBeenCalled();
        expect(result.totalHoldingsValue).toBe(50 * 95);
      });
    });

    describe("historical cost basis from transaction exchange rates", () => {
      beforeEach(() => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-1",
            close_price: "175",
            price_date: "2026-02-07",
          },
        ]);
        // Current USD->CAD rate used for market value conversion
        exchangeRateService.getLatestRate.mockImplementation(
          (from: string, to: string) => {
            if (from === "USD" && to === "CAD") return Promise.resolve(1.35);
            return Promise.resolve(null);
          },
        );
      });

      it("uses the stored exchange rate from BUY transactions for account cost basis", async () => {
        // 10 shares of AAPL bought for 150 USD/share at a historical rate of 1.25
        investmentTransactionRepository.find.mockResolvedValue([
          {
            id: "tx-1",
            userId,
            accountId: "acct-brokerage-1",
            securityId: "sec-1",
            action: InvestmentAction.BUY,
            transactionDate: "2025-06-01",
            quantity: 10,
            price: 150,
            totalAmount: 1500,
            exchangeRate: 1.25,
          },
        ]);

        const result = await service.getPortfolioSummary(userId);

        const acct = result.holdingsByAccount[0];
        // Historical cost basis: 10 * 150 * 1.25 = 1875 CAD (NOT 2025 CAD at
        // current 1.35 rate)
        expect(acct.totalCostBasis).toBeCloseTo(1875, 2);
        // Market value uses the current rate: 10 * 175 * 1.35 = 2362.5 CAD
        expect(acct.totalMarketValue).toBeCloseTo(2362.5, 2);
        // Gain/loss is derived: 2362.5 - 1875 = 487.5 CAD
        expect(acct.totalGainLoss).toBeCloseTo(487.5, 2);

        // Holdings include the historical cost basis in account currency
        const holding = acct.holdings[0];
        expect(holding.costBasisAccountCurrency).toBeCloseTo(1875, 2);
        // The security-currency cost basis is still quantity * averageCost
        expect(holding.costBasis).toBe(1500);
      });

      it("reduces cost basis proportionally on SELL transactions", async () => {
        // Buy 10 @ 150 USD with 1.25 rate = 1875 CAD total cost
        // Sell 4 @ 180 USD — cost basis reduces by 4/10 = 750 CAD
        // Remaining cost basis = 1125 CAD for 6 shares
        investmentTransactionRepository.find.mockResolvedValue([
          {
            id: "tx-1",
            userId,
            accountId: "acct-brokerage-1",
            securityId: "sec-1",
            action: InvestmentAction.BUY,
            transactionDate: "2025-06-01",
            quantity: 10,
            price: 150,
            totalAmount: 1500,
            exchangeRate: 1.25,
          },
          {
            id: "tx-2",
            userId,
            accountId: "acct-brokerage-1",
            securityId: "sec-1",
            action: InvestmentAction.SELL,
            transactionDate: "2025-08-01",
            quantity: 4,
            price: 180,
            totalAmount: 720,
            exchangeRate: 1.3,
          },
        ]);
        // Holding reflects remaining 6 shares
        holdingsRepository.find.mockResolvedValue([
          { ...mockHoldingAAPL, quantity: 6 as any },
        ]);

        const result = await service.getPortfolioSummary(userId);

        const holding = result.holdingsByAccount[0].holdings[0];
        expect(holding.costBasisAccountCurrency).toBeCloseTo(1125, 2);
      });

      it("combines BUYs at different historical rates using a running weighted average", async () => {
        // Buy 10 @ 150 USD * 1.20 rate = 1800 CAD cost basis
        // Buy 10 @ 200 USD * 1.40 rate = 2800 CAD cost basis
        // Total: 20 shares, 4600 CAD cost basis
        investmentTransactionRepository.find.mockResolvedValue([
          {
            id: "tx-1",
            userId,
            accountId: "acct-brokerage-1",
            securityId: "sec-1",
            action: InvestmentAction.BUY,
            transactionDate: "2025-01-01",
            quantity: 10,
            price: 150,
            totalAmount: 1500,
            exchangeRate: 1.2,
          },
          {
            id: "tx-2",
            userId,
            accountId: "acct-brokerage-1",
            securityId: "sec-1",
            action: InvestmentAction.BUY,
            transactionDate: "2025-06-01",
            quantity: 10,
            price: 200,
            totalAmount: 2000,
            exchangeRate: 1.4,
          },
        ]);
        holdingsRepository.find.mockResolvedValue([
          { ...mockHoldingAAPL, quantity: 20 as any },
        ]);

        const result = await service.getPortfolioSummary(userId);

        const holding = result.holdingsByAccount[0].holdings[0];
        expect(holding.costBasisAccountCurrency).toBeCloseTo(4600, 2);
      });

      it("falls back to current-rate conversion when no transactions exist", async () => {
        // No transactions fetched — fall back to quantity * averageCost
        // converted at the current exchange rate.
        investmentTransactionRepository.find.mockResolvedValue([]);

        const result = await service.getPortfolioSummary(userId);

        const holding = result.holdingsByAccount[0].holdings[0];
        // 1500 USD * 1.35 = 2025 CAD
        expect(holding.costBasisAccountCurrency).toBeCloseTo(2025, 2);
      });
    });

    describe("with no accounts or holdings", () => {
      it("returns zero totals and empty arrays", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([]);
        holdingsRepository.find.mockResolvedValue([]);
        securityPriceRepository.query.mockResolvedValue([]);

        const result = await service.getPortfolioSummary(userId);

        expect(result.totalCashValue).toBe(0);
        expect(result.totalHoldingsValue).toBe(0);
        expect(result.totalCostBasis).toBe(0);
        expect(result.totalNetInvested).toBe(0);
        expect(result.totalPortfolioValue).toBe(0);
        expect(result.totalGainLoss).toBe(0);
        expect(result.totalGainLossPercent).toBe(0);
        expect(result.cagr).toBeNull();
        expect(result.holdings).toHaveLength(0);
        expect(result.holdingsByAccount).toHaveLength(0);
        expect(result.allocation).toHaveLength(0);
      });
    });

    describe("gainLossPercent at portfolio level", () => {
      it("returns 0 when totalCostBasis is 0", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([mockCashAccount]);
        holdingsRepository.find.mockResolvedValue([]);
        securityPriceRepository.query.mockResolvedValue([]);

        const result = await service.getPortfolioSummary(userId);

        // Only cash, no cost basis
        expect(result.totalGainLossPercent).toBe(0);
      });
    });

    describe("allocation percentages", () => {
      it("calculates correct percentages relative to total portfolio value", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([mockHoldingVFV]);
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-2",
            close_price: "100",
            price_date: "2026-02-07",
          },
        ]);
        exchangeRateService.getLatestRate.mockResolvedValue(null);

        const result = await service.getPortfolioSummary(userId);

        // Cash: 5000, VFV: 50*100=5000, total=10000
        const totalPortfolioValue = result.totalPortfolioValue;
        expect(totalPortfolioValue).toBe(10000);

        const cashAlloc = result.allocation.find((a) => a.type === "cash");
        expect(cashAlloc!.percentage).toBeCloseTo(50, 2);

        const vfvAlloc = result.allocation.find((a) => a.symbol === "VFV.TO");
        expect(vfvAlloc!.percentage).toBeCloseTo(50, 2);
      });

      it("does not include cash in allocation when cash is 0", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        // Brokerage account with NO linked cash account
        const brokerageNoCash = {
          ...mockBrokerageAccount,
          linkedAccountId: null,
        };
        accountsRepository.find.mockResolvedValue([brokerageNoCash]);
        holdingsRepository.find.mockResolvedValue([mockHoldingVFV]);
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-2",
            close_price: "100",
            price_date: "2026-02-07",
          },
        ]);
        exchangeRateService.getLatestRate.mockResolvedValue(null);

        const result = await service.getPortfolioSummary(userId);

        const cashAlloc = result.allocation.find((a) => a.type === "cash");
        expect(cashAlloc).toBeUndefined();
      });

      it("does not include securities with zero or null market value", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);
        // No price data
        securityPriceRepository.query.mockResolvedValue([]);
        exchangeRateService.getLatestRate.mockResolvedValue(null);

        const result = await service.getPortfolioSummary(userId);

        const securityAllocs = result.allocation.filter(
          (a) => a.type === "security",
        );
        expect(securityAllocs).toHaveLength(0);
      });
    });

    describe("holdingsByAccount sorting", () => {
      it("sorts accounts by total market value descending", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
          mockStandaloneAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([
          mockHoldingVFV,
          mockHoldingXIC,
        ]);
        securityPriceRepository.query.mockResolvedValue([
          { security_id: "sec-2", close_price: "95", price_date: "2026-02-07" },
          { security_id: "sec-3", close_price: "35", price_date: "2026-02-07" },
        ]);
        exchangeRateService.getLatestRate.mockResolvedValue(null);

        const result = await service.getPortfolioSummary(userId);

        expect(result.holdingsByAccount.length).toBe(2);
        // Brokerage: VFV = 50*95=4750, Standalone: XIC = 100*35=3500
        expect(result.holdingsByAccount[0].accountId).toBe("acct-brokerage-1");
        expect(result.holdingsByAccount[1].accountId).toBe("acct-standalone-1");
      });

      it("sorts holdings within accounts by market value descending, nulls last", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);

        const holdingNoPrice = {
          ...mockHoldingAAPL,
          id: "hold-no-price",
          securityId: "sec-no-price",
          security: {
            ...mockSecurityAAPL,
            id: "sec-no-price",
            symbol: "NOPRICE",
            currencyCode: "CAD",
          },
        };
        holdingsRepository.find.mockResolvedValue([
          holdingNoPrice,
          mockHoldingVFV,
        ]);
        securityPriceRepository.query.mockResolvedValue([
          { security_id: "sec-2", close_price: "95", price_date: "2026-02-07" },
          // No price for sec-no-price
        ]);
        exchangeRateService.getLatestRate.mockResolvedValue(null);

        const result = await service.getPortfolioSummary(userId);

        const accountHoldings = result.holdingsByAccount[0].holdings;
        expect(accountHoldings[0].symbol).toBe("VFV.TO");
        expect(accountHoldings[1].symbol).toBe("NOPRICE");
        expect(accountHoldings[1].marketValue).toBeNull();
      });
    });

    describe("brokerage account name cleanup", () => {
      it("removes ' - Brokerage' suffix from account name", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([
          { ...mockBrokerageAccount, name: "TFSA - Brokerage" },
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([]);
        securityPriceRepository.query.mockResolvedValue([]);

        const result = await service.getPortfolioSummary(userId);

        expect(result.holdingsByAccount[0].accountName).toBe("TFSA");
      });

      it("keeps account name as-is when no suffix present", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([
          { ...mockBrokerageAccount, name: "My Portfolio" },
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([]);
        securityPriceRepository.query.mockResolvedValue([]);

        const result = await service.getPortfolioSummary(userId);

        expect(result.holdingsByAccount[0].accountName).toBe("My Portfolio");
      });
    });

    describe("effective balance from currentBalance", () => {
      it("uses currentBalance from the account for cash balance", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([]);
        securityPriceRepository.query.mockResolvedValue([]);
        exchangeRateService.getLatestRate.mockResolvedValue(null);

        const result = await service.getPortfolioSummary(userId);

        // Uses currentBalance = 5000 from mockCashAccount
        expect(result.totalCashValue).toBe(5000);
        expect(result.holdingsByAccount[0].cashBalance).toBe(5000);
      });

      it("uses currentBalance for standalone accounts", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([mockStandaloneAccount]);
        holdingsRepository.find.mockResolvedValue([]);
        securityPriceRepository.query.mockResolvedValue([]);
        exchangeRateService.getLatestRate.mockResolvedValue(null);

        const result = await service.getPortfolioSummary(userId);

        // Uses currentBalance = 2000 from mockStandaloneAccount
        expect(result.totalCashValue).toBe(2000);
        expect(result.holdingsByAccount[0].cashBalance).toBe(2000);
      });

      it("does not run balance query when no cash or standalone accounts exist", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        // Only a brokerage account with no linked cash
        const brokerageOnly = {
          ...mockBrokerageAccount,
          linkedAccountId: null,
        };
        accountsRepository.find.mockResolvedValue([brokerageOnly]);
        holdingsRepository.find.mockResolvedValue([]);
        securityPriceRepository.query.mockResolvedValue([]);

        await service.getPortfolioSummary(userId);

        // Balance query should not run, but investment flows query will run
        // Verify no call contains the balance SQL (opening_balance)
        const balanceCalls = accountsRepository.query.mock.calls.filter(
          ([sql]: [string]) => sql.includes("opening_balance"),
        );
        expect(balanceCalls).toHaveLength(0);
      });
    });

    describe("linked cash account discovery for holdingsByAccount", () => {
      it("finds cash account linked to brokerage via brokerage.linkedAccountId", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        const brokerage = {
          ...mockBrokerageAccount,
          linkedAccountId: "acct-cash-1",
        };
        const cash = { ...mockCashAccount, linkedAccountId: null };
        accountsRepository.find.mockResolvedValue([brokerage, cash]);
        holdingsRepository.find.mockResolvedValue([]);
        securityPriceRepository.query.mockResolvedValue([]);

        const result = await service.getPortfolioSummary(userId);

        expect(result.holdingsByAccount[0].cashAccountId).toBe("acct-cash-1");
        expect(result.holdingsByAccount[0].cashBalance).toBe(5000);
      });

      it("finds cash account linked via cash.linkedAccountId", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        const brokerage = {
          ...mockBrokerageAccount,
          linkedAccountId: null,
        };
        const cash = {
          ...mockCashAccount,
          linkedAccountId: "acct-brokerage-1",
        };
        accountsRepository.find.mockResolvedValue([brokerage, cash]);
        holdingsRepository.find.mockResolvedValue([]);
        securityPriceRepository.query.mockResolvedValue([]);

        const result = await service.getPortfolioSummary(userId);

        expect(result.holdingsByAccount[0].cashAccountId).toBe("acct-cash-1");
        expect(result.holdingsByAccount[0].cashBalance).toBe(5000);
      });

      it("sets cashBalance to 0 when no linked cash account exists", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        const brokerageNoLink = {
          ...mockBrokerageAccount,
          linkedAccountId: null,
        };
        accountsRepository.find.mockResolvedValue([brokerageNoLink]);
        holdingsRepository.find.mockResolvedValue([]);
        securityPriceRepository.query.mockResolvedValue([]);

        const result = await service.getPortfolioSummary(userId);

        expect(result.holdingsByAccount[0].cashAccountId).toBeNull();
        expect(result.holdingsByAccount[0].cashBalance).toBe(0);
      });
    });
  });

  describe("FX completeness covers every returned total", () => {
    it("marks the summary incomplete when only net invested cannot convert (RR2-005)", async () => {
      // A EUR brokerage account with no linked cash account and no holdings, so
      // the cash and holdings aggregates never touch EUR -- but its investment
      // flows give it a non-zero `netInvested`, which is denominated in the
      // brokerage account's currency. `netInvestedAgg`'s gap was only logged, so
      // the response carried a net-invested subtotal of 0 under
      // `fxComplete: true` and fed it to CAGR as a complete denominator.
      prefRepository.findOne.mockResolvedValue(mockPref);
      accountsRepository.find.mockResolvedValue([
        {
          ...mockBrokerageAccount,
          id: "acct-eur",
          name: "Europe - Brokerage",
          currencyCode: "EUR",
          linkedAccountId: null,
        },
      ]);
      holdingsRepository.find.mockResolvedValue([]);
      securityPriceRepository.query.mockResolvedValue([]);
      // The investment-flows aggregate: 1,000 EUR of buys, nothing sold.
      accountsRepository.query.mockImplementation(async (sql: string) =>
        /investment_transactions/.test(sql)
          ? [
              {
                account_id: "acct-eur",
                buys: "1000",
                sells: "0",
                income: "0",
              },
            ]
          : [],
      );
      // No EUR->CAD rate in either direction.
      exchangeRateService.getLatestRate.mockResolvedValue(null);

      const result = await service.getPortfolioSummary(userId);

      expect(result.missingRatePairs).toContain("EUR->CAD");
      expect(result.fxComplete).toBe(false);
      // Growth over an unknown amount invested is not a growth rate.
      expect(result.cagr).toBeNull();
    });

    it("marks the valuation incomplete when a held position has no price (RR3-004)", async () => {
      // The unpriced holding was skipped out of the total with nothing recorded,
      // so a portfolio holding one priced position and one unpriced one reported a
      // confident total of the priced one with `fxComplete: true`. A subtotal under
      // a total's name is what section 1 of the contract forbids -- and it seeded
      // Monte Carlo.
      prefRepository.findOne.mockResolvedValue(mockPref);
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      holdingsRepository.find.mockResolvedValue([
        mockHoldingAAPL,
        mockHoldingVFV,
      ]);
      // Only AAPL has a price; VFV has none.
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-1", close_price: "175", price_date: "2026-02-07" },
      ]);
      exchangeRateService.getLatestRate.mockImplementation(
        (from: string, to: string) =>
          Promise.resolve(from === "USD" && to === "CAD" ? 1.35 : null),
      );

      const result = await service.getPortfolioSummary(userId);

      expect(result.pricesComplete).toBe(false);
      expect(result.unpricedSecurityIds).toEqual(["sec-2"]);
      // FX is fine; the valuation is not. Two causes, two flags, one gate.
      expect(result.fxComplete).toBe(true);
      expect(result.valuationComplete).toBe(false);
      // Growth to an unknown value is not a growth rate.
      expect(result.cagr).toBeNull();
    });

    it("stays complete when every held position is priced", async () => {
      // The control: the price gate must not fire on a fully priced portfolio.
      prefRepository.findOne.mockResolvedValue(mockPref);
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      holdingsRepository.find.mockResolvedValue([
        mockHoldingAAPL,
        mockHoldingVFV,
      ]);
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-1", close_price: "175", price_date: "2026-02-07" },
        { security_id: "sec-2", close_price: "95", price_date: "2026-02-07" },
      ]);
      exchangeRateService.getLatestRate.mockImplementation(
        (from: string, to: string) =>
          Promise.resolve(from === "USD" && to === "CAD" ? 1.35 : null),
      );

      const result = await service.getPortfolioSummary(userId);

      expect(result.pricesComplete).toBe(true);
      expect(result.unpricedSecurityIds).toEqual([]);
      expect(result.valuationComplete).toBe(true);
    });

    it("takes the gain over the priced holdings and reports the excluded cost apart (A26-M38)", async () => {
      // AAPL priced: value 2362.5 CAD, cost 2025 CAD. VFV unpriced: cost 4000.
      // Value less EVERY holding's cost read -3662.5 with no marker; the gain is
      // over the holdings that have a value.
      prefRepository.findOne.mockResolvedValue(mockPref);
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      holdingsRepository.find.mockResolvedValue([
        mockHoldingAAPL,
        mockHoldingVFV,
      ]);
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-1", close_price: "175", price_date: "2026-02-07" },
      ]);
      exchangeRateService.getLatestRate.mockImplementation(
        (from: string, to: string) =>
          Promise.resolve(from === "USD" && to === "CAD" ? 1.35 : null),
      );

      const result = await service.getPortfolioSummary(userId);

      expect(result.totalGainLoss).toBeCloseTo(337.5, 4);
      expect(result.totalGainLossPercent).toBeCloseTo(16.6667, 3);
      expect(result.gainCostBasis).toBe(2025);
      expect(result.unpricedCostBasis).toBe(4000);
      expect(result.totalCostBasis).toBe(6025);
      expect(result.valuationComplete).toBe(false);

      const acct = result.holdingsByAccount[0];
      expect(acct.totalGainLoss).toBeCloseTo(337.5, 4);
      expect(acct.totalGainLossPercent).toBeCloseTo(16.6667, 3);
      expect(acct.gainCostBasis).toBe(2025);
      expect(acct.unpricedCostBasis).toBe(4000);
      expect(acct.totalCostBasis).toBe(6025);
      expect(acct.valuationComplete).toBe(false);
    });

    it("leaves the gain of a complete portfolio as value less cost (A26-M38)", async () => {
      prefRepository.findOne.mockResolvedValue(mockPref);
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      holdingsRepository.find.mockResolvedValue([
        mockHoldingAAPL,
        mockHoldingVFV,
      ]);
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-1", close_price: "175", price_date: "2026-02-07" },
        { security_id: "sec-2", close_price: "95", price_date: "2026-02-07" },
      ]);
      exchangeRateService.getLatestRate.mockImplementation(
        (from: string, to: string) =>
          Promise.resolve(from === "USD" && to === "CAD" ? 1.35 : null),
      );

      const result = await service.getPortfolioSummary(userId);

      expect(result.totalGainLoss).toBeCloseTo(
        result.totalHoldingsValue - result.totalCostBasis,
        4,
      );
      expect(result.gainCostBasis).toBe(result.totalCostBasis);
      expect(result.unpricedCostBasis).toBe(0);
    });

    it("reports a per-account gap the global flag cannot see (RR3-005)", async () => {
      // The two conversions are different paths: the top-level total converts the
      // security straight into the user's default currency, the account total
      // converts it into the account's own. So a USD-reporting portfolio holding a
      // USD security in a JPY account is complete at the top and missing USD->JPY
      // underneath -- and that gap was only logged, leaving an account screen or an
      // AI answer free to report a confident zero for the account.
      prefRepository.findOne.mockResolvedValue(mockPref);
      const jpyBrokerage = {
        ...mockBrokerageAccount,
        currencyCode: "JPY",
        linkedAccountId: null,
      };
      accountsRepository.find.mockResolvedValue([jpyBrokerage]);
      holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-1", close_price: "175", price_date: "2026-02-07" },
      ]);
      // USD converts into the reporting currency (CAD) but not into JPY.
      exchangeRateService.getLatestRate.mockImplementation(
        (from: string, to: string) =>
          Promise.resolve(from === "USD" && to === "CAD" ? 1.35 : null),
      );

      const result = await service.getPortfolioSummary(userId);

      // Complete at the top: every component of the CAD totals converted.
      expect(result.fxComplete).toBe(true);
      // Not complete for the account, whose totals are in JPY.
      const account = result.holdingsByAccount[0];
      expect(account.fxComplete).toBe(false);
      expect(account.missingRatePairs).toContain("USD->JPY");
      expect(account.valuationComplete).toBe(false);
    });

    it("stays complete for an empty foreign account with no rate", async () => {
      // The control for the zero-conversion rule: an account holding nothing
      // needs no rate, so it must not make the portfolio's totals unknown.
      // "Nothing to report" and "could not be worked out" are different answers.
      prefRepository.findOne.mockResolvedValue(mockPref);
      accountsRepository.find.mockResolvedValue([
        {
          ...mockBrokerageAccount,
          id: "acct-eur",
          name: "Europe - Brokerage",
          currencyCode: "EUR",
          linkedAccountId: null,
        },
      ]);
      holdingsRepository.find.mockResolvedValue([]);
      securityPriceRepository.query.mockResolvedValue([]);
      accountsRepository.query.mockResolvedValue([]);
      exchangeRateService.getLatestRate.mockResolvedValue(null);

      const result = await service.getPortfolioSummary(userId);

      expect(result.missingRatePairs).toEqual([]);
      expect(result.fxComplete).toBe(true);
      expect(result.totalNetInvested).toBe(0);
    });
  });

  describe("getLlmSummary", () => {
    it("attaches the country and asset-class look-through when asked", async () => {
      jest.spyOn(service, "getPortfolioSummary").mockResolvedValue({
        totalCashValue: 0,
        totalHoldingsValue: 1000,
        totalCostBasis: 900,
        totalNetInvested: 900,
        totalPortfolioValue: 1000,
        totalGainLoss: 100,
        totalGainLossPercent: 11.11,
        gainCostBasis: 900,
        unpricedCostBasis: 0,
        fxComplete: true,
        missingRatePairs: [],
        pricesComplete: true,
        unpricedSecurityIds: [],
        valuationComplete: true,
        timeWeightedReturn: null,
        timeWeightedReturnReasons: [],
        timeWeightedReturnSince: null,
        moneyWeightedReturn: null,
        moneyWeightedReturnReasons: [],
        returnDiagnostics: EMPTY_RETURN_DIAGNOSTICS,
        cagr: null,
        holdings: [],
        holdingsByAccount: [],
        allocation: [],
      } as never);

      const result = await service.getLlmSummary("user-1", ["acct-1"], {
        includeLookThrough: true,
      });

      expect(sectorWeightingService.getLlmLookThrough).toHaveBeenCalledWith(
        "user-1",
        ["acct-1"],
      );
      expect(result.lookThrough?.byCountry.items[0]).toEqual({
        name: "United States",
        value: 750,
        percentage: 75,
      });
      expect(result.lookThrough?.byAssetClass.items[0]).toEqual({
        name: "Equity",
        value: 600,
        percentage: 60,
      });
      expect(result.lookThrough?.byAssetClass.unclassifiedPercentage).toBe(40);
    });

    it("maps raw holdings into the compact LLM shape and rounds monetary and percentage values", async () => {
      const getPortfolioSummary = jest
        .spyOn(service, "getPortfolioSummary")
        .mockResolvedValue({
          totalCashValue: 100.12345,
          totalHoldingsValue: 9900.56789,
          totalCostBasis: 9000.1234,
          totalNetInvested: 9000,
          totalPortfolioValue: 10000.6913,
          totalGainLoss: 900.5544,
          totalGainLossPercent: 10.123456,
          gainCostBasis: 9000.1234,
          unpricedCostBasis: 0,
          fxComplete: true,
          missingRatePairs: [],
          pricesComplete: true,
          unpricedSecurityIds: [],
          valuationComplete: true,
          timeWeightedReturn: 8.56789,
          timeWeightedReturnReasons: [],
          timeWeightedReturnSince: null,
          moneyWeightedReturn: null,
          moneyWeightedReturnReasons: [],
          returnDiagnostics: EMPTY_RETURN_DIAGNOSTICS,
          cagr: null,
          holdings: [
            {
              id: "h1",
              accountId: "a1",
              securityId: "s1",
              symbol: "AAPL",
              name: "Apple Inc.",
              securityType: "STOCK",
              currencyCode: "USD",
              quantity: 10,
              averageCost: 150.0,
              costBasis: 1500.0,
              costBasisAccountCurrency: 1500.0,
              currentPrice: 180.0,
              marketValue: 1800.12345,
              marketValueAccountCurrency: 1800.12345,
              marketValueDefaultCurrency: 1800.12345,
              gainLoss: 300.12345,
              gainLossPercent: 20.567,
            },
          ],
          holdingsByAccount: [],
          allocation: [
            {
              name: "AAPL",
              symbol: "AAPL",
              type: "security",
              value: 1800.12345,
              percentage: 18.56789,
            },
          ],
        });

      const result = await service.getLlmSummary("user-1");

      expect(getPortfolioSummary).toHaveBeenCalledWith("user-1", undefined);
      // Not requested, so the extra holdings/FX pass is skipped entirely.
      expect(sectorWeightingService.getLlmLookThrough).not.toHaveBeenCalled();
      expect(result.lookThrough).toBeUndefined();
      expect(result.holdingCount).toBe(1);
      expect(result.totalCashValue).toBe(100.1235);
      expect(result.totalHoldingsValue).toBe(9900.5679);
      expect(result.totalPortfolioValue).toBe(10000.6913);
      expect(result.totalGainLoss).toBe(900.5544);
      expect(result.totalGainLossPercent).toBe(10.12);
      expect(result.timeWeightedReturn).toBe(8.57);
      expect(result.cagr).toBeNull();
      expect(result.holdings[0]).toMatchObject({
        // The security's own id is surfaced (not the holding-row id) so the
        // assistant can deep-link the holding to its Securities-page row.
        securityId: "s1",
        symbol: "AAPL",
        name: "Apple Inc.",
        securityType: "STOCK",
        currency: "USD",
        quantity: 10,
        averageCost: 150,
        costBasis: 1500,
        marketValue: 1800.1235,
        gainLoss: 300.1235,
        gainLossPercent: 20.57,
      });
      expect(result.allocation[0]).toMatchObject({
        name: "AAPL",
        symbol: "AAPL",
        type: "security",
        value: 1800.1235,
        percentage: 18.57,
      });
    });

    it("passes accountIds filter through to getPortfolioSummary", async () => {
      const spy = jest.spyOn(service, "getPortfolioSummary").mockResolvedValue({
        totalCashValue: 0,
        totalHoldingsValue: 0,
        totalCostBasis: 0,
        totalNetInvested: 0,
        totalPortfolioValue: 0,
        totalGainLoss: 0,
        totalGainLossPercent: 0,
        gainCostBasis: 0,
        unpricedCostBasis: 0,
        fxComplete: true,
        missingRatePairs: [],
        pricesComplete: true,
        unpricedSecurityIds: [],
        valuationComplete: true,
        timeWeightedReturn: null,
        timeWeightedReturnReasons: [],
        timeWeightedReturnSince: null,
        moneyWeightedReturn: null,
        moneyWeightedReturnReasons: [],
        returnDiagnostics: EMPTY_RETURN_DIAGNOSTICS,
        cagr: null,
        holdings: [],
        holdingsByAccount: [],
        allocation: [],
      });

      await service.getLlmSummary("user-1", ["acc-1", "acc-2"]);

      expect(spy).toHaveBeenCalledWith("user-1", ["acc-1", "acc-2"]);
    });

    it("carries FX incompleteness across the LLM boundary (RR2-007)", async () => {
      // The compact shape is what the AI Assistant and the MCP server hand to a
      // model. It dropped `fxComplete` and `missingRatePairs`, so the same
      // numeric subtotal the UI knew was partial was quoted to the user as a
      // complete balance. A subtotal must not cross a consumer boundary under a
      // `total*` name without its incompleteness.
      jest.spyOn(service, "getPortfolioSummary").mockResolvedValue({
        totalCashValue: 100,
        totalHoldingsValue: 0,
        totalCostBasis: 0,
        totalNetInvested: 0,
        totalPortfolioValue: 100,
        totalGainLoss: 0,
        totalGainLossPercent: 0,
        gainCostBasis: 0,
        unpricedCostBasis: 0,
        fxComplete: false,
        missingRatePairs: ["EUR->USD"],
        pricesComplete: true,
        unpricedSecurityIds: [],
        valuationComplete: false,
        timeWeightedReturn: null,
        timeWeightedReturnReasons: [],
        timeWeightedReturnSince: null,
        moneyWeightedReturn: null,
        moneyWeightedReturnReasons: [],
        returnDiagnostics: EMPTY_RETURN_DIAGNOSTICS,
        cagr: null,
        holdings: [],
        holdingsByAccount: [],
        allocation: [],
      });

      const result = await service.getLlmSummary("user-1");

      expect(result.fxComplete).toBe(false);
      expect(result.missingRatePairs).toEqual(["EUR->USD"]);
    });

    it("preserves null averageCost", async () => {
      jest.spyOn(service, "getPortfolioSummary").mockResolvedValue({
        totalCashValue: 0,
        totalHoldingsValue: 100,
        totalCostBasis: 0,
        totalNetInvested: 0,
        totalPortfolioValue: 100,
        totalGainLoss: 0,
        totalGainLossPercent: 0,
        gainCostBasis: 0,
        unpricedCostBasis: 0,
        fxComplete: true,
        missingRatePairs: [],
        pricesComplete: true,
        unpricedSecurityIds: [],
        valuationComplete: true,
        timeWeightedReturn: null,
        timeWeightedReturnReasons: [],
        timeWeightedReturnSince: null,
        moneyWeightedReturn: null,
        moneyWeightedReturnReasons: [],
        returnDiagnostics: EMPTY_RETURN_DIAGNOSTICS,
        cagr: null,
        holdings: [
          {
            id: "h1",
            accountId: "a1",
            securityId: "s1",
            symbol: "ACB",
            name: "Aurora",
            securityType: "STOCK",
            currencyCode: "CAD",
            quantity: 5,
            averageCost: null as unknown as number,
            costBasis: 0,
            costBasisAccountCurrency: 0,
            currentPrice: 20,
            marketValue: 100,
            marketValueAccountCurrency: 100,
            marketValueDefaultCurrency: 100,
            gainLoss: null,
            gainLossPercent: null,
          },
        ],
        holdingsByAccount: [],
        allocation: [],
      });

      const result = await service.getLlmSummary("user-1");

      expect(result.holdings[0].averageCost).toBeNull();
      expect(result.holdings[0].gainLoss).toBeNull();
      expect(result.holdings[0].gainLossPercent).toBeNull();
    });

    it("maps the per-account holdings breakdown into the compact LLM shape", async () => {
      jest.spyOn(service, "getPortfolioSummary").mockResolvedValue({
        totalCashValue: 0,
        totalHoldingsValue: 1800,
        totalCostBasis: 1500,
        totalNetInvested: 1500,
        totalPortfolioValue: 1800,
        totalGainLoss: 300,
        totalGainLossPercent: 20,
        gainCostBasis: 1500,
        unpricedCostBasis: 0,
        fxComplete: true,
        missingRatePairs: [],
        pricesComplete: true,
        unpricedSecurityIds: [],
        valuationComplete: true,
        timeWeightedReturn: null,
        timeWeightedReturnReasons: [],
        timeWeightedReturnSince: null,
        moneyWeightedReturn: null,
        moneyWeightedReturnReasons: [],
        returnDiagnostics: EMPTY_RETURN_DIAGNOSTICS,
        cagr: null,
        holdings: [],
        holdingsByAccount: [
          {
            accountId: "acct-1",
            accountName: "TFSA",
            currencyCode: "CAD",
            cashAccountId: "cash-1",
            cashBalance: 250.12345,
            holdings: [
              {
                id: "h1",
                accountId: "acct-1",
                securityId: "s1",
                symbol: "AAPL",
                name: "Apple Inc.",
                securityType: "STOCK",
                currencyCode: "USD",
                quantity: 10,
                averageCost: 150,
                costBasis: 1500,
                costBasisAccountCurrency: 1500,
                currentPrice: 180,
                marketValue: 1800.12345,
                marketValueAccountCurrency: 1800.12345,
                marketValueDefaultCurrency: 1800.12345,
                gainLoss: 300.12345,
                gainLossPercent: 20.567,
              },
            ],
            totalCostBasis: 1500.1234,
            totalMarketValue: 1800.5678,
            unpricedHoldingsCount: 0,
            totalGainLoss: 300.4444,
            totalGainLossPercent: 20.123456,
            gainCostBasis: 1500.1234,
            unpricedCostBasis: 0,
            netInvested: 1500,
            // The real producer always sets these; a fixture without them is a row
            // the service could not have built.
            fxComplete: true,
            missingRatePairs: [],
            pricesComplete: true,
            unpricedSecurityIds: [],
            valuationComplete: true,
          },
        ],
        allocation: [],
      });

      const result = await service.getLlmSummary("user-1");

      expect(result.holdingsByAccount).toHaveLength(1);
      const acct = result.holdingsByAccount[0];
      expect(acct).toMatchObject({
        accountName: "TFSA",
        currency: "CAD",
        cashBalance: 250.1235,
        totalCostBasis: 1500.1234,
        totalMarketValue: 1800.5678,
        totalGainLoss: 300.4444,
        totalGainLossPercent: 20.12,
      });
      expect(acct.holdings[0]).toMatchObject({
        symbol: "AAPL",
        name: "Apple Inc.",
        securityType: "STOCK",
        currency: "USD",
        quantity: 10,
        averageCost: 150,
        costBasis: 1500,
        marketValue: 1800.1235,
        gainLoss: 300.1235,
        gainLossPercent: 20.57,
      });
    });
  });

  describe("getTopMovers", () => {
    // Whether a stored close is still the current session is a question about
    // today, so every case here has one: the fixtures price Friday 2026-02-06
    // and Monday 2026-02-09, and the clock is that Monday.
    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date("2026-02-09T12:00:00.000Z"));
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    describe("when user has active holdings with price history", () => {
      beforeEach(() => {
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([
          mockHoldingAAPL,
          mockHoldingVFV,
        ]);
      });

      it("returns movers sorted by absolute daily change percent descending", async () => {
        securityPriceRepository.query.mockResolvedValue([
          // AAPL: current=180, previous=175 => +2.86%
          {
            security_id: "sec-1",
            close_price: "180",
            price_date: "2026-02-09",
            rn: "1",
          },
          {
            security_id: "sec-1",
            close_price: "175",
            price_date: "2026-02-06",
            rn: "2",
          },
          // VFV: current=90, previous=95 => -5.26%
          {
            security_id: "sec-2",
            close_price: "90",
            price_date: "2026-02-09",
            rn: "1",
          },
          {
            security_id: "sec-2",
            close_price: "95",
            price_date: "2026-02-06",
            rn: "2",
          },
        ]);

        const result = await service.getTopMovers(userId);

        expect(result).toHaveLength(2);
        // VFV has larger absolute change (-5.26%) > AAPL (+2.86%)
        expect(result[0].symbol).toBe("VFV.TO");
        expect(result[0].dailyChange).toBeCloseTo(-5, 0);
        expect(result[0].dailyChangePercent).toBeCloseTo(-5.2632, 2);
        expect(result[1].symbol).toBe("AAPL");
        expect(result[1].dailyChangePercent).toBeCloseTo(2.8571, 2);
      });

      it("calculates market value using total quantity and current price", async () => {
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-1",
            close_price: "180",
            price_date: "2026-02-09",
            rn: "1",
          },
          {
            security_id: "sec-1",
            close_price: "175",
            price_date: "2026-02-06",
            rn: "2",
          },
          {
            security_id: "sec-2",
            close_price: "90",
            price_date: "2026-02-09",
            rn: "1",
          },
          {
            security_id: "sec-2",
            close_price: "95",
            price_date: "2026-02-06",
            rn: "2",
          },
        ]);

        const result = await service.getTopMovers(userId);

        const aaplMover = result.find((m) => m.symbol === "AAPL");
        expect(aaplMover!.marketValue).toBe(180 * 10); // currentPrice * quantity
        expect(aaplMover!.currentPrice).toBe(180);
        expect(aaplMover!.previousPrice).toBe(175);
      });

      it("reports what the day's move did to each position held", async () => {
        securityPriceRepository.query.mockResolvedValue([
          // AAPL: 175 -> 180 on 10 shares => +50.00
          {
            security_id: "sec-1",
            close_price: "180",
            price_date: "2026-02-09",
            rn: "1",
          },
          {
            security_id: "sec-1",
            close_price: "175",
            price_date: "2026-02-06",
            rn: "2",
          },
          // VFV: 95 -> 90 on 50 shares => -250.00
          {
            security_id: "sec-2",
            close_price: "90",
            price_date: "2026-02-09",
            rn: "1",
          },
          {
            security_id: "sec-2",
            close_price: "95",
            price_date: "2026-02-06",
            rn: "2",
          },
        ]);

        const result = await service.getTopMovers(userId);

        // The per-share change alone ranks AAPL's +5 above VFV's -5 in size;
        // what each did to the portfolio is the quantity-weighted figure, and a
        // surface that shows holdings must be given it rather than derive it.
        expect(result.find((m) => m.symbol === "AAPL")!.dailyValueChange).toBe(
          50,
        );
        expect(
          result.find((m) => m.symbol === "VFV.TO")!.dailyValueChange,
        ).toBe(-250);
      });
    });

    describe("when user has no investment accounts", () => {
      it("returns empty array", async () => {
        accountsRepository.find.mockResolvedValue([]);

        const result = await service.getTopMovers(userId);

        expect(result).toEqual([]);
        expect(holdingsRepository.find).not.toHaveBeenCalled();
      });
    });

    describe("when user has only cash investment accounts", () => {
      it("returns empty array", async () => {
        accountsRepository.find.mockResolvedValue([mockCashAccount]);

        const result = await service.getTopMovers(userId);

        expect(result).toEqual([]);
        expect(holdingsRepository.find).not.toHaveBeenCalled();
      });
    });

    describe("when all holdings have zero quantity", () => {
      it("returns empty array", async () => {
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([
          { ...mockHoldingAAPL, quantity: 0 },
        ]);

        const result = await service.getTopMovers(userId);

        expect(result).toEqual([]);
      });
    });

    describe("when a security has inactive status", () => {
      it("excludes inactive securities from movers", async () => {
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        const inactiveHolding = {
          ...mockHoldingAAPL,
          security: { ...mockSecurityAAPL, isActive: false },
        };
        holdingsRepository.find.mockResolvedValue([
          inactiveHolding,
          mockHoldingVFV,
        ]);
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-2",
            close_price: "90",
            price_date: "2026-02-09",
            rn: "1",
          },
          {
            security_id: "sec-2",
            close_price: "95",
            price_date: "2026-02-06",
            rn: "2",
          },
        ]);

        const result = await service.getTopMovers(userId);

        expect(result).toHaveLength(1);
        expect(result[0].symbol).toBe("VFV.TO");
      });
    });

    describe("a bond linked to the engine is not a market mover (R13)", () => {
      it("is left off the board, so its daily accrual row does not push every equity off the newest session", async () => {
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        const bondHolding = {
          ...mockHoldingVFV,
          securityId: "sec-bond",
          security: {
            ...mockSecurityVFV,
            id: "sec-bond",
            symbol: "EDO1036",
            bondProgramId: "11111111-1111-5111-8111-111111111111",
          },
        };
        holdingsRepository.find.mockResolvedValue([
          mockHoldingAAPL,
          bondHolding,
        ]);
        securityPriceRepository.query.mockResolvedValue([
          // AAPL's newest close is Friday's session; the engine wrote Monday.
          {
            security_id: "sec-1",
            close_price: "180",
            price_date: "2026-02-06",
            rn: "1",
          },
          {
            security_id: "sec-1",
            close_price: "175",
            price_date: "2026-02-05",
            rn: "2",
          },
          {
            security_id: "sec-bond",
            close_price: "100.05",
            price_date: "2026-02-09",
            rn: "1",
          },
          {
            security_id: "sec-bond",
            close_price: "100.04",
            price_date: "2026-02-08",
            rn: "2",
          },
        ]);

        const board = await service.getTopMovers(userId);

        expect(board.map((m) => m.symbol)).not.toContain("EDO1036");
        // The bond's rows are not even asked for.
        const asked = securityPriceRepository.query.mock.calls[0][1][0];
        expect(asked).toEqual(["sec-1"]);
      });
    });

    describe("when a security has only one price point", () => {
      it("skips securities without two price points", async () => {
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([
          mockHoldingAAPL,
          mockHoldingVFV,
        ]);
        securityPriceRepository.query.mockResolvedValue([
          // Only one price for AAPL
          {
            security_id: "sec-1",
            close_price: "180",
            price_date: "2026-02-09",
            rn: "1",
          },
          // Two prices for VFV
          {
            security_id: "sec-2",
            close_price: "90",
            price_date: "2026-02-09",
            rn: "1",
          },
          {
            security_id: "sec-2",
            close_price: "95",
            price_date: "2026-02-06",
            rn: "2",
          },
        ]);

        const result = await service.getTopMovers(userId);

        expect(result).toHaveLength(1);
        expect(result[0].symbol).toBe("VFV.TO");
      });
    });

    describe("when previous price is zero", () => {
      it("skips securities where previous price is 0", async () => {
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-1",
            close_price: "180",
            price_date: "2026-02-09",
            rn: "1",
          },
          {
            security_id: "sec-1",
            close_price: "0",
            price_date: "2026-02-06",
            rn: "2",
          },
        ]);

        const result = await service.getTopMovers(userId);

        expect(result).toHaveLength(0);
      });
    });

    describe("when same security is held in multiple accounts", () => {
      it("aggregates quantity across accounts for market value", async () => {
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
          mockStandaloneAccount,
        ]);
        // Same security in two different accounts
        const holdingInAccount1 = {
          ...mockHoldingVFV,
          id: "hold-vfv-1",
          accountId: "acct-brokerage-1",
          quantity: 50,
        };
        const holdingInAccount2 = {
          ...mockHoldingVFV,
          id: "hold-vfv-2",
          accountId: "acct-standalone-1",
          quantity: 30,
        };
        holdingsRepository.find.mockResolvedValue([
          holdingInAccount1,
          holdingInAccount2,
        ]);
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-2",
            close_price: "100",
            price_date: "2026-02-09",
            rn: "1",
          },
          {
            security_id: "sec-2",
            close_price: "95",
            price_date: "2026-02-06",
            rn: "2",
          },
        ]);

        const result = await service.getTopMovers(userId);

        expect(result).toHaveLength(1);
        expect(result[0].symbol).toBe("VFV.TO");
        // Total quantity: 50 + 30 = 80, market value: 80 * 100 = 8000
        expect(result[0].marketValue).toBe(8000);
      });
    });

    describe("when security data is missing on holding", () => {
      it("uses fallback values for missing security properties", async () => {
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        const holdingWithMinimalSecurity = {
          ...mockHoldingAAPL,
          security: {
            id: "sec-1",
            symbol: undefined,
            name: undefined,
            currencyCode: undefined,
            isActive: true,
          },
        };
        holdingsRepository.find.mockResolvedValue([holdingWithMinimalSecurity]);
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-1",
            close_price: "180",
            price_date: "2026-02-09",
            rn: "1",
          },
          {
            security_id: "sec-1",
            close_price: "175",
            price_date: "2026-02-06",
            rn: "2",
          },
        ]);

        const result = await service.getTopMovers(userId);

        expect(result).toHaveLength(1);
        expect(result[0].symbol).toBe("Unknown");
        expect(result[0].name).toBe("Unknown");
        expect(result[0].currencyCode).toBe("USD");
      });
    });

    describe("standalone accounts", () => {
      it("includes holdings from standalone accounts in movers", async () => {
        accountsRepository.find.mockResolvedValue([mockStandaloneAccount]);
        holdingsRepository.find.mockResolvedValue([mockHoldingXIC]);
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-3",
            close_price: "36",
            price_date: "2026-02-09",
            rn: "1",
          },
          {
            security_id: "sec-3",
            close_price: "35",
            price_date: "2026-02-06",
            rn: "2",
          },
        ]);

        const result = await service.getTopMovers(userId);

        expect(result).toHaveLength(1);
        expect(result[0].symbol).toBe("XIC.TO");
        expect(result[0].dailyChange).toBeCloseTo(1, 0);
        expect(result[0].marketValue).toBe(36 * 100);
      });
    });

    describe("when the two most recent prices are far apart in time", () => {
      it("skips the security so a sparsely priced holding (e.g. a GIC) is not a perpetual mover", async () => {
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);
        // A matured GIC re-bought under the same symbol: the previous price
        // (80,000, a year ago) and the current price (50,000) are not adjacent
        // trading sessions, so the -37.5% delta is not a daily move. The newer
        // close is today's, so adjacency is the only rule that can exclude it.
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-1",
            close_price: "50000",
            price_date: "2026-02-09",
            rn: "1",
          },
          {
            security_id: "sec-1",
            close_price: "80000",
            price_date: "2025-02-10",
            rn: "2",
          },
        ]);

        const result = await service.getTopMovers(userId);

        expect(result).toHaveLength(0);
      });

      it("includes the security when the gap is within the daily window (e.g. a long weekend)", async () => {
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-1",
            close_price: "180",
            price_date: "2026-02-09",
            rn: "1",
          },
          {
            security_id: "sec-1",
            close_price: "175",
            price_date: "2026-02-06",
            rn: "2",
          },
        ]);

        const result = await service.getTopMovers(userId);

        expect(result).toHaveLength(1);
        expect(result[0].symbol).toBe("AAPL");
      });

      it("skips a weekly-priced security whose two prices are exactly 7 days apart", async () => {
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);
        // Exactly a 7-day cadence (e.g. a weekly-priced fund): the week-over-week
        // delta is not a daily move and must not surface as one.
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-1",
            close_price: "180",
            price_date: "2026-02-09",
            rn: "1",
          },
          {
            security_id: "sec-1",
            close_price: "175",
            price_date: "2026-02-02",
            rn: "2",
          },
        ]);

        const result = await service.getTopMovers(userId);

        expect(result).toHaveLength(0);
      });
    });

    describe("when the most recent price is no longer the current session", () => {
      beforeEach(() => {
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);
      });

      it("skips the security rather than serving an earlier session's move as today's", async () => {
        // No price row landed for this holding all week -- its provider skipped
        // the symbol -- so its two most recent closes are still last Monday's
        // and the Friday before. That delta is a real move, but it is not
        // today's, and the widget used to repeat it every morning until a new
        // price arrived.
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-1",
            close_price: "180",
            price_date: "2026-02-02",
            rn: "1",
          },
          {
            security_id: "sec-1",
            close_price: "175",
            price_date: "2026-01-30",
            rn: "2",
          },
        ]);

        const result = await service.getTopMovers(userId);

        expect(result).toHaveLength(0);
      });

      it("keeps a close old enough only for a holiday weekend", async () => {
        // Thursday's close read on the Monday of a Good Friday weekend: four
        // days old, and the most recent session there is.
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-1",
            close_price: "180",
            price_date: "2026-02-05",
            rn: "1",
          },
          {
            security_id: "sec-1",
            close_price: "175",
            price_date: "2026-02-04",
            rn: "2",
          },
        ]);

        const result = await service.getTopMovers(userId);

        expect(result).toHaveLength(1);
        expect(result[0].priceDate).toBe("2026-02-05");
      });
    });

    describe("when one holding has not priced for the session the others have", () => {
      beforeEach(() => {
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([
          mockHoldingAAPL,
          mockHoldingVFV,
        ]);
      });

      it("drops it rather than ranking yesterday's move on today's board", async () => {
        // The defect: AAPL's provider has not posted Monday's close yet, so its
        // two most recent rows are Friday's and Thursday's. Four days is inside
        // the staleness window -- it has to be, or a Monday after a holiday
        // Friday would empty the board -- so the age rule passes it, and its
        // Friday move (+11.43%) outranked every holding that actually moved
        // today. Only the rest of the board says Friday is over.
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-1",
            close_price: "195",
            price_date: "2026-02-06",
            rn: "1",
          },
          {
            security_id: "sec-1",
            close_price: "175",
            price_date: "2026-02-05",
            rn: "2",
          },
          {
            security_id: "sec-2",
            close_price: "90",
            price_date: "2026-02-09",
            rn: "1",
          },
          {
            security_id: "sec-2",
            close_price: "95",
            price_date: "2026-02-06",
            rn: "2",
          },
        ]);

        const result = await service.getTopMovers(userId);

        expect(result.map((m) => m.symbol)).toEqual(["VFV.TO"]);
        expect(result[0].priceDate).toBe("2026-02-09");
      });

      it("keeps both when neither priced today, so a weekend still has a board", async () => {
        // Read on the Monday before either market reports: nothing is behind
        // anything else, Friday's session is the newest there is, and Friday's
        // board is what the widget captions with Friday's date.
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-1",
            close_price: "180",
            price_date: "2026-02-06",
            rn: "1",
          },
          {
            security_id: "sec-1",
            close_price: "175",
            price_date: "2026-02-05",
            rn: "2",
          },
          {
            security_id: "sec-2",
            close_price: "90",
            price_date: "2026-02-06",
            rn: "1",
          },
          {
            security_id: "sec-2",
            close_price: "95",
            price_date: "2026-02-05",
            rn: "2",
          },
        ]);

        const result = await service.getTopMovers(userId);

        expect(result).toHaveLength(2);
        expect(result.every((m) => m.priceDate === "2026-02-06")).toBe(true);
      });
    });

    describe("when a security has no regular price feed (skipPriceUpdates)", () => {
      it("excludes it even when its two transaction prices are on adjacent days", async () => {
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        // A GIC whose only "prices" are buy/sell transactions. A sell on
        // 2026-02-06 and a re-buy on 2026-02-09 land one session apart and are
        // current, so neither date rule catches it; the skipPriceUpdates flag
        // must.
        const gicHolding = {
          ...mockHoldingAAPL,
          security: { ...mockSecurityAAPL, skipPriceUpdates: true },
        };
        holdingsRepository.find.mockResolvedValue([gicHolding]);
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-1",
            close_price: "50000",
            price_date: "2026-02-09",
            rn: "1",
          },
          {
            security_id: "sec-1",
            close_price: "80000",
            price_date: "2026-02-06",
            rn: "2",
          },
        ]);

        const result = await service.getTopMovers(userId);

        expect(result).toHaveLength(0);
      });
    });
  });

  describe("getMonthOverMonthMovers", () => {
    describe("when user has active holdings with prices in both months", () => {
      beforeEach(() => {
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([
          mockHoldingAAPL,
          mockHoldingVFV,
        ]);
      });

      it("compares end-of-month prices and returns sorted movers", async () => {
        securityPriceRepository.query.mockResolvedValue([
          // AAPL: current month-end=190, previous month-end=180 => +5.56%
          { security_id: "sec-1", close_price: "190", period: "current" },
          { security_id: "sec-1", close_price: "180", period: "previous" },
          // VFV: current month-end=85, previous month-end=95 => -10.53%
          { security_id: "sec-2", close_price: "85", period: "current" },
          { security_id: "sec-2", close_price: "95", period: "previous" },
        ]);

        const result = await service.getMonthOverMonthMovers(
          userId,
          "2026-01-31",
          "2025-12-31",
        );

        expect(result).toHaveLength(2);
        // VFV has larger absolute change
        expect(result[0].symbol).toBe("VFV.TO");
        expect(result[0].currentPrice).toBe(85);
        expect(result[0].previousPrice).toBe(95);
        expect(result[0].dailyChangePercent).toBeCloseTo(-10.53, 1);
        expect(result[1].symbol).toBe("AAPL");
        expect(result[1].currentPrice).toBe(190);
        expect(result[1].previousPrice).toBe(180);
      });

      it("passes both date bounds to the price query", async () => {
        securityPriceRepository.query.mockResolvedValue([]);

        await service.getMonthOverMonthMovers(
          userId,
          "2026-01-31",
          "2025-12-31",
        );

        const queryCall = securityPriceRepository.query.mock.calls[0];
        expect(queryCall[0]).toContain("price_date <= $2::DATE");
        expect(queryCall[0]).toContain("price_date <= $3::DATE");
        expect(queryCall[1][1]).toBe("2026-01-31");
        expect(queryCall[1][2]).toBe("2025-12-31");
      });

      it("skips securities missing a price in either month", async () => {
        securityPriceRepository.query.mockResolvedValue([
          // Only current month price for AAPL, no previous
          { security_id: "sec-1", close_price: "190", period: "current" },
          // Both months for VFV
          { security_id: "sec-2", close_price: "90", period: "current" },
          { security_id: "sec-2", close_price: "85", period: "previous" },
        ]);

        const result = await service.getMonthOverMonthMovers(
          userId,
          "2026-01-31",
          "2025-12-31",
        );

        expect(result).toHaveLength(1);
        expect(result[0].symbol).toBe("VFV.TO");
      });

      it("skips securities where previous price is zero", async () => {
        securityPriceRepository.query.mockResolvedValue([
          { security_id: "sec-1", close_price: "190", period: "current" },
          { security_id: "sec-1", close_price: "0", period: "previous" },
        ]);

        const result = await service.getMonthOverMonthMovers(
          userId,
          "2026-01-31",
          "2025-12-31",
        );

        expect(result).toHaveLength(0);
      });

      it("calculates market value using current price and total quantity", async () => {
        securityPriceRepository.query.mockResolvedValue([
          { security_id: "sec-1", close_price: "200", period: "current" },
          { security_id: "sec-1", close_price: "180", period: "previous" },
        ]);

        const result = await service.getMonthOverMonthMovers(
          userId,
          "2026-01-31",
          "2025-12-31",
        );

        expect(result[0].marketValue).toBe(200 * 10); // currentPrice * quantity
      });
    });

    describe("when user has no investment accounts", () => {
      it("returns empty array", async () => {
        accountsRepository.find.mockResolvedValue([]);

        const result = await service.getMonthOverMonthMovers(
          userId,
          "2026-01-31",
          "2025-12-31",
        );

        expect(result).toEqual([]);
      });
    });

    describe("when all holdings have zero quantity", () => {
      it("returns empty array", async () => {
        accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
        holdingsRepository.find.mockResolvedValue([
          { ...mockHoldingAAPL, quantity: 0 },
        ]);

        const result = await service.getMonthOverMonthMovers(
          userId,
          "2026-01-31",
          "2025-12-31",
        );

        expect(result).toEqual([]);
      });
    });
  });

  describe("getAssetAllocation", () => {
    it("delegates to getPortfolioSummary and extracts allocation", async () => {
      prefRepository.findOne.mockResolvedValue(mockPref);
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      holdingsRepository.find.mockResolvedValue([mockHoldingVFV]);
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-2", close_price: "100", price_date: "2026-02-07" },
      ]);
      exchangeRateService.getLatestRate.mockResolvedValue(null);

      const result = await service.getAssetAllocation(userId);

      expect(result.totalValue).toBeDefined();
      expect(result.allocation).toBeDefined();
      expect(Array.isArray(result.allocation)).toBe(true);
    });

    it("returns correct totalValue matching portfolio total", async () => {
      prefRepository.findOne.mockResolvedValue(mockPref);
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      holdingsRepository.find.mockResolvedValue([mockHoldingVFV]);
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-2", close_price: "100", price_date: "2026-02-07" },
      ]);
      exchangeRateService.getLatestRate.mockResolvedValue(null);

      const result = await service.getAssetAllocation(userId);

      // Cash: 5000 + VFV: 50*100=5000 = 10000
      expect(result.totalValue).toBe(10000);
    });

    it("passes accountIds through to getPortfolioSummary", async () => {
      prefRepository.findOne.mockResolvedValue(mockPref);
      accountsRepository.find.mockResolvedValue([mockStandaloneAccount]);
      holdingsRepository.find.mockResolvedValue([mockHoldingXIC]);
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-3", close_price: "35", price_date: "2026-02-07" },
      ]);
      exchangeRateService.getLatestRate.mockResolvedValue(null);

      const result = await service.getAssetAllocation(userId, [
        "acct-standalone-1",
      ]);

      expect(result.totalValue).toBeDefined();
      expect(accountsRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId }),
        }),
      );
    });
  });

  /**
   * The summary's "TWR (time-weighted)" is the invested measure over the
   * portfolio's whole life, answered by `PortfolioPeriodResultService` and
   * printed as it comes. It used to be a second implementation
   * (`PortfolioCalculationService.calculateTWR`) that valued each sub-period
   * boundary from `security_prices` alone and left an unpriced position OUT of
   * the value, so a position entered the chain as a gain on the first boundary
   * that priced it (#1392).
   */
  describe("TWR (via getPortfolioSummary)", () => {
    beforeEach(() => {
      prefRepository.findOne.mockResolvedValue(mockPref);
      exchangeRateService.getLatestRate.mockResolvedValue(null);
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      accountsRepository.query.mockResolvedValue([
        { account_id: "acct-cash-1", balance: "0" },
      ]);
      holdingsRepository.find.mockResolvedValue([]);
      securityPriceRepository.query.mockResolvedValue([]);
      investmentTransactionRepository.find.mockResolvedValue([]);
    });

    it("values the portfolio without the since-inception walk or any return field", async () => {
      const valuation = await service.getPortfolioValuation(userId);

      expect(
        periodResultService.getInvestedResultSinceInception,
      ).not.toHaveBeenCalled();
      expect(valuation).toEqual(
        expect.objectContaining({
          holdings: expect.any(Array),
          totalPortfolioValue: expect.any(Number),
        }),
      );
      for (const field of [
        "timeWeightedReturn",
        "timeWeightedReturnReasons",
        "timeWeightedReturnSince",
        "moneyWeightedReturn",
        "moneyWeightedReturnReasons",
        "returnDiagnostics",
        "cagr",
      ]) {
        expect(valuation).not.toHaveProperty(field);
      }
    });

    it("builds the summary on the same valuation rather than working it out again", async () => {
      const valuation = await service.getPortfolioValuation(userId);
      const valuationReads = accountsRepository.find.mock.calls.length;

      const summary = await service.getPortfolioSummary(userId);

      expect(accountsRepository.find.mock.calls.length).toBe(valuationReads);
      expect(summary).toMatchObject(valuation);
      expect(summary).toHaveProperty("timeWeightedReturn");
      expect(
        periodResultService.getInvestedResultSinceInception,
      ).toHaveBeenCalledTimes(1);
    });

    it("works the valuation out afresh once the user's entries are invalidated", async () => {
      await service.getPortfolioValuation(userId);
      const valuationReads = accountsRepository.find.mock.calls.length;

      invalidatePortfolioSummary(userId);
      await service.getPortfolioValuation(userId);

      expect(accountsRepository.find.mock.calls.length).toBeGreaterThan(
        valuationReads,
      );
    });

    it("asks the invested measure for this scope and reporting currency, and does not fetch rates for it", async () => {
      // `fetchMissing: false` is the second half of the assertion, not a
      // detail of it: the window opens at the scope's first transaction, so
      // without the opt-out one summary card drives a provider backfill over
      // every month of a twenty-six-year history, inline, on a request a
      // person is waiting on (issue #1409).
      await service.getPortfolioSummary(userId, ["acct-brokerage-1"]);

      expect(
        periodResultService.getInvestedResultSinceInception,
      ).toHaveBeenCalledWith(userId, {
        accountIds: ["acct-brokerage-1"],
        displayCurrency: "CAD",
        fetchMissing: false,
      });
    });

    it("prints the invested return and the close it is measured from", async () => {
      periodResultService.getInvestedResultSinceInception.mockResolvedValue(
        investedSince({
          investmentReturnPercent: 25.8,
          startDate: "2025-06-14",
        }),
      );

      const result = await service.getPortfolioSummary(userId);

      expect(result.timeWeightedReturn).toBe(25.8);
      expect(result.timeWeightedReturnReasons).toEqual([]);
      expect(result.timeWeightedReturnSince).toBe("2025-06-14");
    });

    it("withholds the return, with its cause, when a position had no close on a day the chain spans", async () => {
      // The defect fixture: two securities, one priced throughout and one
      // whose first stored close comes after its purchase. The old walk
      // omitted the unpriced position from the period value and reported a
      // gain when it appeared; the invested measure withholds the figure and
      // names the missing price.
      periodResultService.getInvestedResultSinceInception.mockResolvedValue(
        investedSince({
          investmentReturnPercent: null,
          investedReasons: ["incompletePrices"],
          startDate: "2025-06-14",
        }),
      );

      const result = await service.getPortfolioSummary(userId);

      expect(result.timeWeightedReturn).toBeNull();
      expect(result.timeWeightedReturnReasons).toEqual(["incompletePrices"]);
      // The window is still named: what is unknown is the return, not the dates.
      expect(result.timeWeightedReturnSince).toBe("2025-06-14");
    });

    it("prints the money-weighted return from the same slice", async () => {
      // One call, two figures: the summary asks the invested measure once and
      // reports what it answered, rather than deriving a second rate of its own
      // (spec section 11.8).
      periodResultService.getInvestedResultSinceInception.mockResolvedValue(
        investedSince({
          investmentReturnPercent: 25.8,
          investmentMoneyWeightedReturnPercent: 19.42,
          startDate: "2025-06-14",
        }),
      );

      const result = await service.getPortfolioSummary(userId);

      expect(result.moneyWeightedReturn).toBe(19.42);
      expect(result.moneyWeightedReturnReasons).toEqual([]);
      expect(
        periodResultService.getInvestedResultSinceInception,
      ).toHaveBeenCalledTimes(1);
    });

    it("withholds the money-weighted return with its cause", async () => {
      // A portfolio younger than a month has a time-weighted return and no
      // annualised rate: a fortnight's move is not a claim about a year.
      periodResultService.getInvestedResultSinceInception.mockResolvedValue(
        investedSince({
          investmentReturnPercent: 1.4,
          investmentMoneyWeightedReturnPercent: null,
          investedReasons: ["windowTooShort"],
          startDate: "2026-02-10",
        }),
      );

      const result = await service.getPortfolioSummary(userId);

      expect(result.timeWeightedReturn).toBe(1.4);
      expect(result.moneyWeightedReturn).toBeNull();
      expect(result.moneyWeightedReturnReasons).toEqual(["windowTooShort"]);
    });

    it("carries both returns and their causes to the LLM summary", async () => {
      periodResultService.getInvestedResultSinceInception.mockResolvedValue(
        investedSince({
          investmentReturnPercent: 25.8,
          investmentMoneyWeightedReturnPercent: 19.4242,
          investedReasons: [],
          startDate: "2025-06-14",
        }),
      );

      const summary = await service.getLlmSummary(userId);

      // Rounded like every other percentage the model is handed.
      expect(summary.moneyWeightedReturn).toBe(19.42);
      expect(summary.moneyWeightedReturnReasons).toEqual([]);
    });

    /**
     * "No price" is not a repair; "VFV.TO, Mar 2 to Mar 5" is. The summary has
     * no series on the client, so the names are resolved here, over the same
     * since-inception window both returns are measured across (#1392).
     */
    describe("returnDiagnostics", () => {
      const withRanges = (ranges: Partial<IncompleteDataRanges>) =>
        investedSince({
          investmentReturnPercent: null,
          investedReasons: ["incompletePrices"],
          startDate: "2025-06-14",
          incompleteRanges: { ...EMPTY_INCOMPLETE_RANGES, ...ranges },
        });

      it("is empty, but still names the window, when nothing is missing", async () => {
        periodResultService.getInvestedResultSinceInception.mockResolvedValue(
          investedSince({
            investmentReturnPercent: 25.8,
            startDate: "2025-06-14",
          }),
        );

        const result = await service.getPortfolioSummary(userId);

        expect(result.returnDiagnostics).toEqual({
          since: "2025-06-14",
          prices: [],
          rates: [],
          cash: [],
          truncated: { prices: false, rates: false, cash: false },
        });
        expect(securityRepository.find).not.toHaveBeenCalled();
      });

      it("names a held security from the holdings it already valued", async () => {
        holdingsRepository.find.mockResolvedValue([mockHoldingVFV]);
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-2",
            close_price: "100",
            price_date: "2026-02-07",
          },
        ]);
        periodResultService.getInvestedResultSinceInception.mockResolvedValue(
          withRanges({
            prices: [{ key: "sec-2", start: "2026-03-02", end: "2026-03-05" }],
          }),
        );

        const result = await service.getPortfolioSummary(userId);

        expect(result.returnDiagnostics.prices).toEqual([
          {
            securityId: "sec-2",
            symbol: "VFV.TO",
            name: "Vanguard S&P 500 ETF",
            start: "2026-03-02",
            end: "2026-03-05",
          },
        ]);
        // Already loaded, so nothing is fetched a second time.
        expect(securityRepository.find).not.toHaveBeenCalled();
      });

      it("loads the name of a security nobody holds today", async () => {
        // The gap is most likely on exactly the position that was sold out or
        // made inactive, which is not among today's holdings; printing its
        // UUID would be a worse dead end than the sentence this replaces.
        securityRepository.find.mockResolvedValue([
          { id: "sec-9", symbol: "PPK", name: "PPK Fund" },
        ]);
        periodResultService.getInvestedResultSinceInception.mockResolvedValue(
          withRanges({
            prices: [{ key: "sec-9", start: "2026-03-02", end: "2026-05-30" }],
            truncated: { prices: true, rates: false, cash: false },
          }),
        );

        const result = await service.getPortfolioSummary(userId);

        expect(securityRepository.find).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ userId }),
          }),
        );
        expect(result.returnDiagnostics.prices).toEqual([
          {
            securityId: "sec-9",
            symbol: "PPK",
            name: "PPK Fund",
            start: "2026-03-02",
            end: "2026-05-30",
          },
        ]);
        expect(result.returnDiagnostics.truncated.prices).toBe(true);
      });

      it("names the cash account and carries the pair as it stands", async () => {
        periodResultService.getInvestedResultSinceInception.mockResolvedValue(
          withRanges({
            rates: [
              { key: "USD->CAD", start: "2026-01-02", end: "2026-01-09" },
            ],
            cash: [
              { key: "acct-cash-1", start: "2026-01-02", end: "2026-01-02" },
            ],
          }),
        );

        const result = await service.getPortfolioSummary(userId);

        expect(result.returnDiagnostics.rates).toEqual([
          { pair: "USD->CAD", start: "2026-01-02", end: "2026-01-09" },
        ]);
        expect(result.returnDiagnostics.cash).toEqual([
          {
            accountId: "acct-cash-1",
            name: "TFSA - Cash",
            start: "2026-01-02",
            end: "2026-01-02",
          },
        ]);
      });

      it("carries the diagnostics to the LLM summary", async () => {
        securityRepository.find.mockResolvedValue([
          { id: "sec-9", symbol: "PPK", name: "PPK Fund" },
        ]);
        periodResultService.getInvestedResultSinceInception.mockResolvedValue(
          withRanges({
            prices: [{ key: "sec-9", start: "2026-03-02", end: "2026-05-30" }],
          }),
        );

        const summary = await service.getLlmSummary(userId);

        expect(summary.returnDiagnostics.prices).toEqual([
          {
            securityId: "sec-9",
            symbol: "PPK",
            name: "PPK Fund",
            start: "2026-03-02",
            end: "2026-05-30",
          },
        ]);
      });
    });

    it("has no window at all when the scope never held an investment", async () => {
      const result = await service.getPortfolioSummary(userId);

      expect(result.timeWeightedReturn).toBeNull();
      expect(result.timeWeightedReturnReasons).toEqual(["noValueSeries"]);
      expect(result.timeWeightedReturnSince).toBeNull();
    });
  });

  describe("Net Invested calculation (via getPortfolioSummary)", () => {
    beforeEach(() => {
      prefRepository.findOne.mockResolvedValue(mockPref);
      exchangeRateService.getLatestRate.mockResolvedValue(null);
    });

    it("computes netInvested as cashBalance + buys - sells - income per account", async () => {
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        { ...mockCashAccount, currentBalance: 2000 },
      ]);
      holdingsRepository.find.mockResolvedValue([mockHoldingVFV]);
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-2", close_price: "95", price_date: "2026-02-07" },
      ]);

      // First call: investment flows, second: CAGR earliest
      let queryCallCount = 0;
      accountsRepository.query.mockImplementation(() => {
        queryCallCount++;
        if (queryCallCount === 1) {
          // Investment flows: bought 5000, sold 1000, received 500 income
          return [
            {
              account_id: "acct-brokerage-1",
              buys: "5000",
              sells: "1000",
              income: "500",
            },
          ];
        }
        // CAGR earliest date
        return [{ earliest: "2024-01-15" }];
      });

      const result = await service.getPortfolioSummary(userId);

      // netInvested = cashBalance(2000) + buys(5000) - sells(1000) - income(500) = 5500
      expect(result.holdingsByAccount[0].netInvested).toBe(5500);
      expect(result.totalNetInvested).toBe(5500);
    });

    it("returns 0 netInvested when no investment flows exist", async () => {
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      holdingsRepository.find.mockResolvedValue([]);
      securityPriceRepository.query.mockResolvedValue([]);
      accountsRepository.query.mockResolvedValue([]);

      const result = await service.getPortfolioSummary(userId);

      // No flows, cash falls back to currentBalance=5000, so netInvested=5000
      expect(result.holdingsByAccount[0].netInvested).toBe(5000);
    });

    it("computes netInvested for standalone accounts", async () => {
      accountsRepository.find.mockResolvedValue([
        { ...mockStandaloneAccount, currentBalance: 1000 },
      ]);
      holdingsRepository.find.mockResolvedValue([mockHoldingXIC]);
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-3", close_price: "35", price_date: "2026-02-07" },
      ]);

      // First call: investment flows, second: CAGR earliest
      let queryCallCount = 0;
      accountsRepository.query.mockImplementation(() => {
        queryCallCount++;
        if (queryCallCount === 1) {
          return [
            {
              account_id: "acct-standalone-1",
              buys: "3000",
              sells: "0",
              income: "200",
            },
          ];
        }
        return [{ earliest: "2025-01-15" }];
      });

      const result = await service.getPortfolioSummary(userId);

      // netInvested = cashBalance(1000) + buys(3000) - sells(0) - income(200) = 3800
      expect(result.holdingsByAccount[0].netInvested).toBe(3800);
    });

    it("includes totalNetInvested and cagr fields in response", async () => {
      accountsRepository.find.mockResolvedValue([]);
      holdingsRepository.find.mockResolvedValue([]);
      securityPriceRepository.query.mockResolvedValue([]);

      const result = await service.getPortfolioSummary(userId);

      expect(result).toHaveProperty("totalNetInvested");
      expect(result).toHaveProperty("cagr");
    });

    it("sums investment flows in the cash account currency via total_amount * exchange_rate", async () => {
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      holdingsRepository.find.mockResolvedValue([]);
      securityPriceRepository.query.mockResolvedValue([]);
      accountsRepository.query.mockResolvedValue([]);

      await service.getPortfolioSummary(userId);

      // The flows sum must convert each row from the security's currency into
      // the cash account's currency by multiplying total_amount * exchange_rate,
      // otherwise netInvested would mix USD and CAD for cross-currency holdings.
      const flowsCall = accountsRepository.query.mock.calls.find(
        (call) =>
          typeof call[0] === "string" &&
          call[0].includes("investment_transactions"),
      );
      expect(flowsCall).toBeDefined();
      expect(flowsCall![0]).toContain("total_amount * exchange_rate");
    });

    it("computes netInvested correctly for a USD security held in a CAD account", async () => {
      // Scenario: CAD brokerage with 50,000 CAD opening balance.
      // User buys 100 shares of a USD stock at 27.16 USD while USD->CAD = 1.35.
      //   Cash debited: 2716 USD * 1.35 = 3666.60 CAD
      //   Remaining cash: 46,333.40 CAD
      //   total_amount on the BUY row: 2716 (USD, stored raw)
      // The SQL query multiplies total_amount * exchange_rate, so flows.buys
      // comes back already in CAD (3666.60), matching the cash balance's units.
      //
      // Expected netInvested = cash(46,333.40) + buys(3666.60) = 50,000 CAD,
      // i.e. the original opening balance, which is what "money I put in"
      // should show.
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        { ...mockCashAccount, currentBalance: 46333.4 },
      ]);
      holdingsRepository.find.mockResolvedValue([
        {
          ...mockHoldingAAPL,
          quantity: 100 as any,
          averageCost: 27.16 as any,
        },
      ]);
      securityPriceRepository.query.mockResolvedValue([
        {
          security_id: "sec-1",
          close_price: "25.6750",
          price_date: "2026-02-07",
        },
      ]);
      exchangeRateService.getLatestRate.mockImplementation(
        (from: string, to: string) => {
          if (from === "USD" && to === "CAD") return Promise.resolve(1.35);
          return Promise.resolve(null);
        },
      );

      let queryCallCount = 0;
      accountsRepository.query.mockImplementation(() => {
        queryCallCount++;
        if (queryCallCount === 1) {
          // With the fix, the query returns flows already in CAD:
          //   buys = 2716 * 1.35 = 3666.60
          return [
            {
              account_id: "acct-brokerage-1",
              buys: "3666.60",
              sells: "0",
              income: "0",
            },
          ];
        }
        return [{ earliest: "2025-01-15" }];
      });

      const result = await service.getPortfolioSummary(userId);

      // Opening balance preserved -> 50,000 CAD net invested.
      expect(result.holdingsByAccount[0].netInvested).toBeCloseTo(50000, 2);
      expect(result.totalNetInvested).toBeCloseTo(50000, 2);

      // Portfolio value: cash 46333.40 + holdings (100 * 25.675 * 1.35 = 3466.125)
      //                = 49,799.525 CAD
      expect(result.totalPortfolioValue).toBeCloseTo(49799.525, 2);

      // Total Gain (portfolio - netInvested) must be negative because the
      // USD price dropped between purchase and today.
      const totalGain = result.totalPortfolioValue - result.totalNetInvested;
      expect(totalGain).toBeLessThan(0);
      expect(totalGain).toBeCloseTo(-200.475, 2);
    });
  });

  describe("CAGR calculation (via getPortfolioSummary)", () => {
    beforeEach(() => {
      prefRepository.findOne.mockResolvedValue(mockPref);
      exchangeRateService.getLatestRate.mockResolvedValue(null);
    });

    it("returns null when no accounts exist", async () => {
      accountsRepository.find.mockResolvedValue([]);
      holdingsRepository.find.mockResolvedValue([]);
      securityPriceRepository.query.mockResolvedValue([]);

      const result = await service.getPortfolioSummary(userId);

      expect(result.cagr).toBeNull();
    });

    it("returns null when net invested is zero", async () => {
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      holdingsRepository.find.mockResolvedValue([]);
      securityPriceRepository.query.mockResolvedValue([]);

      // Cash balance 0, no flows → netInvested=0
      let queryCallCount = 0;
      accountsRepository.query.mockImplementation(() => {
        queryCallCount++;
        if (queryCallCount === 1) {
          return [{ account_id: "acct-cash-1", balance: "0" }];
        }
        return [];
      });

      const result = await service.getPortfolioSummary(userId);

      expect(result.cagr).toBeNull();
    });

    it("returns null when no earliest transaction date exists", async () => {
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      holdingsRepository.find.mockResolvedValue([]);
      securityPriceRepository.query.mockResolvedValue([]);

      let queryCallCount = 0;
      accountsRepository.query.mockImplementation(() => {
        queryCallCount++;
        if (queryCallCount === 1) {
          return [{ account_id: "acct-cash-1", balance: "5000" }];
        }
        if (queryCallCount === 2) {
          // No investment flows
          return [];
        }
        // No earliest date
        return [{ earliest: null }];
      });

      const result = await service.getPortfolioSummary(userId);

      expect(result.cagr).toBeNull();
    });

    it("calculates CAGR correctly for a known scenario", async () => {
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        { ...mockCashAccount, currentBalance: 0 },
      ]);
      holdingsRepository.find.mockResolvedValue([mockHoldingVFV]);
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-2", close_price: "100", price_date: "2026-02-07" },
      ]);

      // Set up: portfolio=0+5000=5000, netInvested=5000
      // Earliest transaction 2 years ago
      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
      const earliestDate = twoYearsAgo.toISOString().split("T")[0];

      // First call: investment flows, second: CAGR earliest
      let queryCallCount = 0;
      accountsRepository.query.mockImplementation(() => {
        queryCallCount++;
        if (queryCallCount === 1) {
          // buys=5000, sells=0, income=0 → netInvested = 0 + 5000 - 0 - 0 = 5000
          return [
            {
              account_id: "acct-brokerage-1",
              buys: "5000",
              sells: "0",
              income: "0",
            },
          ];
        }
        return [{ earliest: earliestDate }];
      });

      const result = await service.getPortfolioSummary(userId);

      // Portfolio = 0 (cash) + 5000 (holdings) = 5000
      // Net invested = 0 + 5000 - 0 - 0 = 5000
      // CAGR = (5000/5000)^(1/2) - 1 = 0%
      expect(result.cagr).not.toBeNull();
      expect(result.cagr).toBeCloseTo(0, 0);
    });

    it("calculates positive CAGR when portfolio exceeds net invested", async () => {
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      // VFV: 50 shares at $100 = $5000 market value
      holdingsRepository.find.mockResolvedValue([mockHoldingVFV]);
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-2", close_price: "100", price_date: "2026-02-07" },
      ]);

      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
      const earliestDate = twoYearsAgo.toISOString().split("T")[0];

      // First call: investment flows, second: CAGR earliest
      let queryCallCount = 0;
      accountsRepository.query.mockImplementation(() => {
        queryCallCount++;
        if (queryCallCount === 1) {
          // buys=4000, sells=0, income=0 → netInvested = 5000 + 4000 = 9000
          return [
            {
              account_id: "acct-brokerage-1",
              buys: "4000",
              sells: "0",
              income: "0",
            },
          ];
        }
        return [{ earliest: earliestDate }];
      });

      const result = await service.getPortfolioSummary(userId);

      // Portfolio = 5000 (cash) + 5000 (holdings) = 10000
      // Net invested = 5000 + 4000 = 9000
      // CAGR = (10000/9000)^(1/2) - 1 ≈ 5.41%
      expect(result.cagr).not.toBeNull();
      expect(result.cagr!).toBeGreaterThan(0);
      const expectedCagr = (Math.pow(10000 / 9000, 1 / 2) - 1) * 100;
      expect(result.cagr).toBeCloseTo(expectedCagr, 1);
    });

    it("returns null when the holding period is less than one year", async () => {
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      holdingsRepository.find.mockResolvedValue([mockHoldingVFV]);
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-2", close_price: "100", price_date: "2026-02-07" },
      ]);

      // Earliest transaction was a few days ago — annualizing a short
      // period explodes into nonsensical CAGR values, so the service
      // should report null instead.
      const fewDaysAgo = new Date();
      fewDaysAgo.setDate(fewDaysAgo.getDate() - 3);
      const earliestDate = fewDaysAgo.toISOString().split("T")[0];

      let queryCallCount = 0;
      accountsRepository.query.mockImplementation(() => {
        queryCallCount++;
        if (queryCallCount === 1) {
          return [
            {
              account_id: "acct-brokerage-1",
              buys: "1000",
              sells: "0",
              income: "0",
            },
          ];
        }
        return [{ earliest: earliestDate }];
      });

      const result = await service.getPortfolioSummary(userId);

      expect(result.cagr).toBeNull();
    });
  });

  describe("getAccountMarketValues", () => {
    it("returns an empty map when there are no investment accounts", async () => {
      accountsRepository.find.mockResolvedValue([]);
      const result = await service.getAccountMarketValues(userId);
      expect(result.size).toBe(0);
    });

    it("returns an empty map when there are no holdings accounts", async () => {
      // Cash-only account does not have brokerage subtype, so categoriseAccounts
      // returns no holdingsAccountIds.
      accountsRepository.find.mockResolvedValue([mockCashAccount]);
      const result = await service.getAccountMarketValues(userId);
      expect(result.size).toBe(0);
    });

    it("returns an empty map when there are no holdings rows", async () => {
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      holdingsRepository.find.mockResolvedValue([]);
      const result = await service.getAccountMarketValues(userId);
      expect(result.size).toBe(0);
    });

    it("computes market value summed per account (CAD/USD same)", async () => {
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount, // CAD
      ]);
      holdingsRepository.find.mockResolvedValue([
        { ...mockHoldingVFV, quantity: "10" } as any, // 10 * price -> in CAD, same currency
      ]);
      securityPriceRepository.query.mockResolvedValue([
        {
          security_id: "sec-2",
          close_price: "100",
          price_date: "2026-02-01",
        },
      ]);

      const result = await service.getAccountMarketValues(userId);
      expect(result.get("acct-brokerage-1")).toEqual({
        marketValue: 1000,
        knownMarketValueSubtotal: 1000,
        pricesComplete: true,
        unpricedSecurityIds: [],
        unpricedSymbols: [],
        fxComplete: true,
        missingRatePairs: [],
        valuationComplete: true,
      });
    });

    it("skips holdings with effectively zero quantity", async () => {
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([
        { ...mockHoldingVFV, quantity: "0" } as any,
      ]);
      securityPriceRepository.query.mockResolvedValue([
        {
          security_id: "sec-2",
          close_price: "100",
          price_date: "2026-02-01",
        },
      ]);

      const result = await service.getAccountMarketValues(userId);
      expect(result.size).toBe(0);
    });

    it("records a holding without a current price as unknown, not as absent", async () => {
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([
        { ...mockHoldingVFV, quantity: "5" } as any,
      ]);
      // No price for sec-2
      securityPriceRepository.query.mockResolvedValue([]);

      const result = await service.getAccountMarketValues(userId);
      const row = result.get("acct-brokerage-1")!;
      expect(row.marketValue).toBeNull();
      expect(row.knownMarketValueSubtotal).toBe(0);
      expect(row.pricesComplete).toBe(false);
      expect(row.unpricedSecurityIds).toEqual(["sec-2"]);
      expect(row.valuationComplete).toBe(false);
    });

    it("withholds the market value when one holding is priced and another is not", async () => {
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([
        { ...mockHoldingVFV, quantity: "10" } as any, // 10 * 100 = 1000
        {
          ...mockHoldingVFV,
          id: "hold-other",
          securityId: "sec-3",
          security: mockSecurityXIC,
          quantity: "20",
        } as any, // no price
      ]);
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-2", close_price: "100", price_date: "2026-02-01" },
      ]);

      const row = (await service.getAccountMarketValues(userId)).get(
        "acct-brokerage-1",
      )!;
      expect(row.marketValue).toBeNull();
      expect(row.knownMarketValueSubtotal).toBe(1000);
      expect(row.pricesComplete).toBe(false);
      expect(row.unpricedSecurityIds).toEqual(["sec-3"]);
      expect(row.unpricedSymbols).toEqual([mockSecurityXIC.symbol]);
      expect(row.valuationComplete).toBe(false);
    });

    it("names the pair when the security's currency has no rate into the account's", async () => {
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]); // CAD
      holdingsRepository.find.mockResolvedValue([
        { ...mockHoldingAAPL, quantity: "10" } as any, // USD
      ]);
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-1", close_price: "100", price_date: "2026-02-01" },
      ]);
      exchangeRateService.getLatestRate.mockResolvedValue(null);

      const row = (await service.getAccountMarketValues(userId)).get(
        "acct-brokerage-1",
      )!;
      expect(row.marketValue).toBeNull();
      expect(row.knownMarketValueSubtotal).toBe(0);
      expect(row.fxComplete).toBe(false);
      expect(row.missingRatePairs).toEqual(["USD->CAD"]);
      expect(row.pricesComplete).toBe(true);
      expect(row.valuationComplete).toBe(false);
    });

    it("aggregates multiple holdings in the same account", async () => {
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([
        { ...mockHoldingVFV, quantity: "10" } as any, // 10 * 100 = 1000
        {
          ...mockHoldingVFV,
          id: "hold-other",
          securityId: "sec-3",
          security: mockSecurityXIC,
          quantity: "20",
        } as any, // 20 * 50 = 1000
      ]);
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-2", close_price: "100", price_date: "2026-02-01" },
        { security_id: "sec-3", close_price: "50", price_date: "2026-02-01" },
      ]);

      const result = await service.getAccountMarketValues(userId);
      expect(result.get("acct-brokerage-1")?.marketValue).toBe(2000);
    });

    describe("a bond-linked holding", () => {
      const bondSecurity = {
        ...mockSecurityXIC,
        id: "sec-bond",
        securityType: "BOND",
        bondProgramId: "prog-1",
      };
      const heldIn = (accountId: string) =>
        ({
          ...mockHoldingVFV,
          id: `hold-${accountId}`,
          accountId,
          securityId: "sec-bond",
          security: bondSecurity,
          quantity: "10",
        }) as any;

      beforeEach(() => {
        accountsRepository.find.mockResolvedValue([
          mockBrokerageAccount,
          { ...mockBrokerageAccount, id: "acct-brokerage-2" },
        ]);
        holdingsRepository.find.mockResolvedValue([
          heldIn("acct-brokerage-1"),
          heldIn("acct-brokerage-2"),
        ]);
        // The blend (117.74) a quantity x price reading would use.
        securityPriceRepository.query.mockResolvedValue([
          {
            security_id: "sec-bond",
            close_price: "117.74",
            price_date: "2026-02-01",
          },
        ]);
      });

      it("values each account by its own lots, not quantity x the blend", async () => {
        bondValuation.valueByAccount.mockResolvedValue({
          asOf: "2026-02-01",
          accounts: new Map([
            ["acct-brokerage-1", { quantity: 10, grossValue: "1354.00" }],
            ["acct-brokerage-2", { quantity: 10, grossValue: "1000.80" }],
          ]),
        });

        const result = await service.getAccountMarketValues(userId);

        expect(result.get("acct-brokerage-1")?.marketValue).toBe(1354);
        expect(result.get("acct-brokerage-2")?.marketValue).toBe(1000.8);
        expect(bondValuation.valueByAccount).toHaveBeenCalledTimes(1);
      });

      it("values a marketable coupon security at the stored price, not the engine's par (INV-BOND-005)", async () => {
        bondValuation.valueByAccount.mockResolvedValue({
          asOf: "2026-02-01",
          accounts: new Map([
            [
              "acct-brokerage-1",
              {
                quantity: 10,
                grossValue: "1000.00",
                marketPriceRequired: true,
              },
            ],
            [
              "acct-brokerage-2",
              {
                quantity: 10,
                grossValue: "1000.00",
                marketPriceRequired: true,
              },
            ],
          ]),
        });

        const result = await service.getAccountMarketValues(userId);

        expect(result.get("acct-brokerage-1")?.marketValue).toBe(1177.4);
        securityPriceRepository.query.mockResolvedValue([]);
        const unpriced = await service.getAccountMarketValues(userId);
        expect(unpriced.get("acct-brokerage-1")?.marketValue).toBeNull();
        expect(unpriced.get("acct-brokerage-1")?.pricesComplete).toBe(false);
      });

      it("marks an account whose lots have an unknown value as unpriced", async () => {
        bondValuation.valueByAccount.mockResolvedValue({
          asOf: "2026-02-01",
          accounts: new Map([
            ["acct-brokerage-1", { quantity: 10, grossValue: null }],
            ["acct-brokerage-2", { quantity: 10, grossValue: "1000.80" }],
          ]),
        });

        const result = await service.getAccountMarketValues(userId);

        const unknown = result.get("acct-brokerage-1")!;
        expect(unknown.marketValue).toBeNull();
        expect(unknown.pricesComplete).toBe(false);
        expect(unknown.unpricedSecurityIds).toEqual(["sec-bond"]);
        expect(result.get("acct-brokerage-2")?.marketValue).toBe(1000.8);
      });
    });
  });

  describe("getIntradayValueSeries", () => {
    beforeEach(() => {
      prefRepository.findOne.mockResolvedValue(mockPref);
    });

    it("returns empty series when user has no holdings", async () => {
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([]);

      const result = await service.getIntradayValueSeries(userId, {
        range: "1d",
      });

      expect(result.points).toEqual([]);
      expect(result.interval).toBe("1m");
      expect(result.currency).toBe("CAD");
      expect(yahooFinanceService.fetchIntradaySeries).not.toHaveBeenCalled();
    });

    it("aggregates intraday bars across multiple holdings on the same time grid", async () => {
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      holdingsRepository.find.mockResolvedValue([
        mockHoldingAAPL,
        mockHoldingVFV,
      ]);

      const ts1 = new Date("2026-05-06T13:30:00.000Z");
      const ts2 = new Date("2026-05-06T13:31:00.000Z");

      yahooFinanceService.fetchIntradaySeries.mockImplementation(
        async (symbol: string) => {
          if (symbol === "AAPL") {
            return [
              { timestamp: ts1, close: 100 },
              { timestamp: ts2, close: 110 },
            ];
          }
          if (symbol === "VFV.TO") {
            return [
              { timestamp: ts1, close: 80 },
              { timestamp: ts2, close: 81 },
            ];
          }
          return null;
        },
      );

      // USD->CAD = 1.4 for AAPL conversion; VFV.TO already CAD.
      exchangeRateService.getLatestRate.mockImplementation(
        async (from: string, to: string) => {
          if (from === "USD" && to === "CAD") return 1.4;
          return null;
        },
      );

      const result = await service.getIntradayValueSeries(userId, {
        range: "1d",
      });

      expect(result.points).toHaveLength(2);
      expect(result.interval).toBe("1m");
      expect(result.currency).toBe("CAD");
      // ts1: 10 * 100 * 1.4 + 50 * 80 + 5000 cash = 1400 + 4000 + 5000 = 10400
      expect(result.points[0].value).toBeCloseTo(10400, 4);
      // ts2: 10 * 110 * 1.4 + 50 * 81 + 5000 cash = 1540 + 4050 + 5000 = 10590
      expect(result.points[1].value).toBeCloseTo(10590, 4);
    });

    it("uses each security's first-bar open for the chart's starting value", async () => {
      // Regression test: previously the chart's first point used the close
      // of the first 1-minute bar, which differs from the day's official
      // opening price stored in security_prices.open_price. The starting
      // value must match the opening price reflected in the Security Prices
      // table so users can reconcile the chart against their own math.
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      holdingsRepository.find.mockResolvedValue([
        mockHoldingAAPL,
        mockHoldingVFV,
      ]);

      const ts1 = new Date("2026-05-06T13:30:00.000Z");
      const ts2 = new Date("2026-05-06T13:31:00.000Z");

      yahooFinanceService.fetchIntradaySeries.mockImplementation(
        async (symbol: string) => {
          if (symbol === "AAPL") {
            return [
              { timestamp: ts1, open: 99, close: 100 },
              { timestamp: ts2, open: 100, close: 110 },
            ];
          }
          if (symbol === "VFV.TO") {
            return [
              { timestamp: ts1, open: 79, close: 80 },
              { timestamp: ts2, open: 80, close: 81 },
            ];
          }
          return null;
        },
      );

      exchangeRateService.getLatestRate.mockImplementation(
        async (from: string, to: string) => {
          if (from === "USD" && to === "CAD") return 1.4;
          return null;
        },
      );

      const result = await service.getIntradayValueSeries(userId, {
        range: "1d",
      });

      // First bar uses the open price of each security: AAPL=99, VFV=79.
      // ts1: 10 * 99 * 1.4 + 50 * 79 + 5000 cash = 1386 + 3950 + 5000 = 10336
      expect(result.points[0].value).toBeCloseTo(10336, 4);
      // Subsequent bars still use closes — ts2 cursor is at index 1, which
      // is not the first bar, so closes[1] is used: AAPL=110, VFV=81.
      // ts2: 10 * 110 * 1.4 + 50 * 81 + 5000 cash = 10590
      expect(result.points[1].value).toBeCloseTo(10590, 4);
    });

    it("backfills a late-starting series at that series' open price", async () => {
      // When one holding's first bar is later than the unified grid's first
      // timestamp, the late starter is valued at its OWN open price for any
      // earlier grid points -- not at zero, and not at its later close.
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      holdingsRepository.find.mockResolvedValue([
        mockHoldingAAPL,
        mockHoldingVFV,
      ]);

      const ts1 = new Date("2026-05-06T13:30:00.000Z");
      const ts2 = new Date("2026-05-06T13:31:00.000Z");

      yahooFinanceService.fetchIntradaySeries.mockImplementation(
        async (symbol: string) => {
          if (symbol === "AAPL") {
            // Starts at ts1.
            return [
              { timestamp: ts1, open: 99, close: 100 },
              { timestamp: ts2, open: 100, close: 110 },
            ];
          }
          if (symbol === "VFV.TO") {
            // Starts at ts2 -- ts1 must backfill from VFV's first open (79).
            return [{ timestamp: ts2, open: 79, close: 80 }];
          }
          return null;
        },
      );

      exchangeRateService.getLatestRate.mockImplementation(
        async (from: string, to: string) => {
          if (from === "USD" && to === "CAD") return 1.4;
          return null;
        },
      );

      const result = await service.getIntradayValueSeries(userId, {
        range: "1d",
      });

      // ts1: AAPL at open=99 (first bar), VFV backfilled at its own open=79.
      // = 10 * 99 * 1.4 + 50 * 79 + 5000 = 1386 + 3950 + 5000 = 10336
      expect(result.points[0].value).toBeCloseTo(10336, 4);
    });

    it("never asks a quote provider for a bond-linked holding's intraday bars (INV-BOND-005)", async () => {
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([
        mockHoldingAAPL,
        {
          ...mockHoldingVFV,
          security: {
            ...mockSecurityVFV,
            bondProgramId: "11111111-1111-5111-8111-111111111111",
          } as any,
        },
      ]);
      yahooFinanceService.fetchIntradaySeries.mockResolvedValue([
        { timestamp: new Date("2026-05-06T13:30:00.000Z"), close: 100 },
      ]);
      exchangeRateService.getLatestRate.mockResolvedValue(1.4);

      await service.getIntradayValueSeries(userId, { range: "1d" });

      const asked = yahooFinanceService.fetchIntradaySeries.mock.calls.map(
        ([symbol]: [string]) => symbol,
      );
      expect(asked).toEqual([mockSecurityAAPL.symbol]);
      // This is the legacy (holdings-table) branch, reached because the default
      // ledger mock is empty; production values a linked holding on the ledger
      // path, which the next test pins (its stored close, per day).
    });

    it("caches results for 60 seconds keyed by user/range/accounts/currency", async () => {
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);
      yahooFinanceService.fetchIntradaySeries.mockResolvedValue([
        { timestamp: new Date("2026-05-06T13:30:00.000Z"), close: 100 },
      ]);
      exchangeRateService.getLatestRate.mockResolvedValue(1.4);

      await service.getIntradayValueSeries(userId, { range: "1d" });
      await service.getIntradayValueSeries(userId, { range: "1d" });

      expect(yahooFinanceService.fetchIntradaySeries).toHaveBeenCalledTimes(1);
    });

    it("falls back on 1D too when holdings mix Yahoo and MSN providers", async () => {
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([
        mockHoldingAAPL,
        mockHoldingVFV,
      ]);

      // VFV resolves to MSN (no fetchIntradaySeries); AAPL stays on Yahoo.
      quoteProviderRegistry.resolveForSecurity.mockImplementation(
        (sec: { id: string }) => {
          if (sec.id === "sec-2") return [{ name: "msn" }];
          return [
            {
              name: "yahoo",
              fetchIntradaySeries: yahooFinanceService.fetchIntradaySeries,
            },
          ];
        },
      );

      const result = await service.getIntradayValueSeries(userId, {
        range: "1d",
      });

      // Mixed providers: do not render a partial intraday chart at all.
      // For 1D the frontend will show a note instead.
      expect(result.skippedSymbols).toEqual(["VFV.TO"]);
      expect(result.fallbackToDaily).toBe(true);
      expect(result.points).toEqual([]);
      expect(yahooFinanceService.fetchIntradaySeries).not.toHaveBeenCalled();
    });

    it("returns fallbackToDaily=true on 1W when any holding is MSN-tracked", async () => {
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([
        mockHoldingAAPL,
        mockHoldingVFV,
      ]);

      quoteProviderRegistry.resolveForSecurity.mockImplementation(
        (sec: { id: string }) => {
          if (sec.id === "sec-2") return [{ name: "msn" }];
          return [
            {
              name: "yahoo",
              fetchIntradaySeries: yahooFinanceService.fetchIntradaySeries,
            },
          ];
        },
      );

      const result = await service.getIntradayValueSeries(userId, {
        range: "1w",
      });

      expect(result.fallbackToDaily).toBe(true);
      expect(result.points).toEqual([]);
      expect(result.skippedSymbols).toContain("VFV.TO");
      // No Yahoo fetches happen when we're going to fall back anyway.
      expect(yahooFinanceService.fetchIntradaySeries).not.toHaveBeenCalled();
    });

    it("back-fills securities whose first bar is later than the grid start", async () => {
      // Repro for the multi-account intraday jump: when one holding's first
      // bar arrives later than another's, the aggregate used to undercount
      // before that bar and jump up the moment it arrived.
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([
        mockHoldingAAPL,
        mockHoldingVFV,
      ]);

      const ts0 = new Date("2026-05-06T13:30:00.000Z");
      const ts1 = new Date("2026-05-06T13:31:00.000Z");
      const ts2 = new Date("2026-05-06T13:32:00.000Z");

      yahooFinanceService.fetchIntradaySeries.mockImplementation(
        async (symbol: string) => {
          if (symbol === "AAPL") {
            return [
              { timestamp: ts0, close: 100 },
              { timestamp: ts1, close: 100 },
              { timestamp: ts2, close: 100 },
            ];
          }
          // VFV's first available bar is at ts1, not ts0.
          return [
            { timestamp: ts1, close: 80 },
            { timestamp: ts2, close: 80 },
          ];
        },
      );
      exchangeRateService.getLatestRate.mockResolvedValue(1.4);

      const result = await service.getIntradayValueSeries(userId, {
        range: "1d",
      });

      expect(result.points).toHaveLength(3);
      // Without the back-fill, ts0 would only contain AAPL (1400) and ts1
      // would jump to 1400 + 4000 = 5400. With the back-fill, ts0 already
      // includes VFV at its earliest known close (80), so all three points
      // share the same value and there is no jump.
      const ts0Value = result.points[0].value;
      const ts1Value = result.points[1].value;
      expect(ts0Value).toBeCloseTo(10 * 100 * 1.4 + 50 * 80, 4);
      expect(ts1Value).toBeCloseTo(ts0Value, 4);
    });

    it("forward-fills when one security misses a timestamp the other has", async () => {
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([
        mockHoldingAAPL,
        mockHoldingVFV,
      ]);

      const ts1 = new Date("2026-05-06T13:30:00.000Z");
      const ts2 = new Date("2026-05-06T13:31:00.000Z");

      yahooFinanceService.fetchIntradaySeries.mockImplementation(
        async (symbol: string) => {
          if (symbol === "AAPL") {
            return [{ timestamp: ts1, close: 100 }];
          }
          return [
            { timestamp: ts1, close: 80 },
            { timestamp: ts2, close: 90 },
          ];
        },
      );
      exchangeRateService.getLatestRate.mockResolvedValue(1.4);

      const result = await service.getIntradayValueSeries(userId, {
        range: "1d",
      });

      // ts2 should still include AAPL at its last known price (100). No
      // cash account is in scope here so cash contributes 0.
      expect(result.points).toHaveLength(2);
      expect(result.points[1].value).toBeCloseTo(10 * 100 * 1.4 + 50 * 90, 4);
    });

    it("adds the cash balance of the investment cash account to every point", async () => {
      // Repro for the bug where the 1D/1W/1M intraday chart undershot the
      // daily-snapshot chart because the cash sleeve wasn't included.
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount, // currentBalance: 5000 CAD
      ]);
      holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);

      const ts = new Date("2026-05-06T13:30:00.000Z");
      yahooFinanceService.fetchIntradaySeries.mockResolvedValue([
        { timestamp: ts, close: 100 },
      ]);
      exchangeRateService.getLatestRate.mockResolvedValue(1.4);

      const result = await service.getIntradayValueSeries(userId, {
        range: "1d",
      });

      // 10 * 100 * 1.4 (USD->CAD) + 5000 cash = 1400 + 5000 = 6400.
      expect(result.points).toHaveLength(1);
      expect(result.points[0].value).toBeCloseTo(6400, 4);
    });

    it("includes standalone-account cash balances in every point", async () => {
      accountsRepository.find.mockResolvedValue([mockStandaloneAccount]);
      holdingsRepository.find.mockResolvedValue([
        { ...mockHoldingAAPL, accountId: "acct-standalone-1" } as any,
      ]);

      const ts = new Date("2026-05-06T13:30:00.000Z");
      yahooFinanceService.fetchIntradaySeries.mockResolvedValue([
        { timestamp: ts, close: 100 },
      ]);
      exchangeRateService.getLatestRate.mockResolvedValue(1.4);

      const result = await service.getIntradayValueSeries(userId, {
        range: "1d",
      });

      // 10 * 100 * 1.4 + 2000 standalone cash = 1400 + 2000 = 3400.
      expect(result.points[0].value).toBeCloseTo(3400, 4);
    });

    it("walks the 1D fallback chain (1m -> 2m -> 5m...) until one interval works", async () => {
      // Yahoo's narrow intervals are the most rate-limited and most likely
      // to return empty responses. When a holding fails at the primary
      // interval, retry at progressively coarser intervals before giving
      // up on intraday entirely.
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);

      const ts = new Date("2026-05-06T13:30:00.000Z");
      yahooFinanceService.fetchIntradaySeries.mockImplementation(
        async (
          _symbol: string,
          _exchange: string | null,
          opts: { interval: string },
        ) => {
          // 1m and 2m fail; 5m succeeds.
          if (opts.interval === "5m") return [{ timestamp: ts, close: 100 }];
          return null;
        },
      );
      exchangeRateService.getLatestRate.mockResolvedValue(1.4);

      const result = await service.getIntradayValueSeries(userId, {
        range: "1d",
      });

      expect(result.fallbackToDaily).toBe(false);
      expect(result.failedSymbols).toEqual([]);
      expect(result.points).toHaveLength(1);
      expect(result.points[0].value).toBeCloseTo(1400, 4);
      // Intervals are tried in order until one yields data.
      const calls = yahooFinanceService.fetchIntradaySeries.mock.calls;
      expect(calls[0][2].interval).toBe("1m");
      expect(calls[1][2].interval).toBe("2m");
      expect(calls[2][2].interval).toBe("5m");
      // Stops once a non-empty response comes back.
      expect(calls.length).toBe(3);
    });

    it("walks the 1W chain starting at 5m (not 1m, not 2m)", async () => {
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);

      yahooFinanceService.fetchIntradaySeries.mockResolvedValue([
        { timestamp: new Date("2026-05-06T13:30:00.000Z"), close: 100 },
      ]);
      exchangeRateService.getLatestRate.mockResolvedValue(1.4);

      await service.getIntradayValueSeries(userId, { range: "1w" });

      const calls = yahooFinanceService.fetchIntradaySeries.mock.calls;
      expect(calls[0][2].interval).toBe("5m");
    });

    it("walks the 1M chain starting at 15m (not 1m, not 5m)", async () => {
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);

      yahooFinanceService.fetchIntradaySeries.mockResolvedValue([
        { timestamp: new Date("2026-05-06T13:30:00.000Z"), close: 100 },
      ]);
      exchangeRateService.getLatestRate.mockResolvedValue(1.4);

      await service.getIntradayValueSeries(userId, { range: "1m" });

      const calls = yahooFinanceService.fetchIntradaySeries.mock.calls;
      expect(calls[0][2].interval).toBe("15m");
    });

    it("fetches a wider Yahoo range for 1W and trims to a 7-day cutoff", async () => {
      // Yahoo's "5d" range only covers 5 trading days, which leaves a 1W
      // request on a Wednesday reaching back only to the previous Thursday.
      // We over-fetch (range="1mo") and trim here to a precise
      // start-of-day(today - 7 days) cutoff so the chart always covers a
      // full week.
      jest.useFakeTimers().setSystemTime(new Date("2026-05-13T18:00:00.000Z"));
      try {
        accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
        holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);

        yahooFinanceService.fetchIntradaySeries.mockResolvedValue([
          // Outside the 7-day window: must be filtered out.
          { timestamp: new Date("2026-05-05T13:30:00.000Z"), close: 90 },
          { timestamp: new Date("2026-05-05T23:59:59.000Z"), close: 91 },
          // Right at the boundary: start of day(2026-05-06) is inclusive.
          { timestamp: new Date("2026-05-06T00:00:00.000Z"), close: 95 },
          { timestamp: new Date("2026-05-06T13:30:00.000Z"), close: 100 },
          { timestamp: new Date("2026-05-13T15:00:00.000Z"), close: 110 },
        ]);
        exchangeRateService.getLatestRate.mockResolvedValue(1);

        const result = await service.getIntradayValueSeries(userId, {
          range: "1w",
        });

        const calls = yahooFinanceService.fetchIntradaySeries.mock.calls;
        expect(calls[0][2]).toEqual({ interval: "5m", range: "1mo" });

        const isoTimestamps = result.points.map((p) => p.timestamp);
        expect(isoTimestamps).toEqual([
          "2026-05-06T00:00:00.000Z",
          "2026-05-06T13:30:00.000Z",
          "2026-05-13T15:00:00.000Z",
        ]);
      } finally {
        jest.useRealTimers();
      }
    });

    it("trims the 1M series to a 30-day cutoff", async () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-05-13T18:00:00.000Z"));
      try {
        accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
        holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);

        yahooFinanceService.fetchIntradaySeries.mockResolvedValue([
          // Outside the 30-day window: must be filtered out.
          { timestamp: new Date("2026-04-12T13:30:00.000Z"), close: 90 },
          // Inside the 30-day window: start of day(2026-04-13) is inclusive.
          { timestamp: new Date("2026-04-13T13:30:00.000Z"), close: 100 },
          { timestamp: new Date("2026-05-13T15:00:00.000Z"), close: 110 },
        ]);
        exchangeRateService.getLatestRate.mockResolvedValue(1);

        const result = await service.getIntradayValueSeries(userId, {
          range: "1m",
        });

        const isoTimestamps = result.points.map((p) => p.timestamp);
        expect(isoTimestamps).toEqual([
          "2026-04-13T13:30:00.000Z",
          "2026-05-13T15:00:00.000Z",
        ]);
      } finally {
        jest.useRealTimers();
      }
    });

    it("uses each failed holding's latest known close as a constant offset", async () => {
      // When some intraday fetches fail (Yahoo errored, was rate-limited
      // past retry, or simply has no minute-resolution data for the
      // security -- common for mutual funds), keep showing intraday for
      // the holdings that succeeded and value the failed ones at their
      // latest daily close. Treats them like cash: a flat additive offset.
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([
        mockHoldingAAPL,
        mockHoldingVFV,
      ]);

      const ts = new Date("2026-05-06T13:30:00.000Z");
      yahooFinanceService.fetchIntradaySeries.mockImplementation(
        async (symbol: string) => {
          if (symbol === "AAPL") return [{ timestamp: ts, close: 100 }];
          throw new Error("yahoo 500");
        },
      );
      // VFV's latest daily close = 80 CAD per share, 50 shares = 4000 CAD.
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-2", close_price: "80", price_date: "2026-05-05" },
      ]);
      exchangeRateService.getLatestRate.mockResolvedValue(1.4);

      const result = await service.getIntradayValueSeries(userId, {
        range: "1d",
      });

      // Don't fall back -- the failure is partial and we have a fallback price.
      expect(result.fallbackToDaily).toBe(false);
      expect(result.failedSymbols).toEqual([]);
      expect(result.points).toHaveLength(1);
      // 10 * 100 * 1.4 (AAPL intraday) + 50 * 80 (VFV stale) = 5400.
      expect(result.points[0].value).toBeCloseTo(5400, 4);
    });

    describe("completeness flags", () => {
      const ts1 = new Date("2026-05-06T13:30:00.000Z");
      const ts2 = new Date("2026-05-06T13:31:00.000Z");

      it("reports every flag true for a series that valued every holding", async () => {
        accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
        holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);
        yahooFinanceService.fetchIntradaySeries.mockResolvedValue([
          { timestamp: ts1, close: 100 },
          { timestamp: ts2, close: 110 },
        ]);
        exchangeRateService.getLatestRate.mockResolvedValue(1.4);

        const result = await service.getIntradayValueSeries(userId, {
          range: "1d",
        });

        expect(result.points).toHaveLength(2);
        for (const p of result.points) {
          expect(p.fxComplete).toBe(true);
          expect(p.pricesComplete).toBe(true);
          expect(p.cashComplete).toBe(true);
        }
        expect(result.fxComplete).toBe(true);
        expect(result.pricesComplete).toBe(true);
        expect(result.valuationComplete).toBe(true);
        expect(result.missingRatePairs).toEqual([]);
        expect(result.unpricedSecurityIds).toEqual([]);
      });

      it("reports true and empty lists when there are no points", async () => {
        accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
        holdingsRepository.find.mockResolvedValue([]);

        const result = await service.getIntradayValueSeries(userId, {
          range: "1d",
        });

        expect(result.points).toEqual([]);
        expect(result.fxComplete).toBe(true);
        expect(result.pricesComplete).toBe(true);
        expect(result.valuationComplete).toBe(true);
        expect(result.missingRatePairs).toEqual([]);
        expect(result.unpricedSecurityIds).toEqual([]);
      });

      it("marks a bar fxComplete false and names the pair when a currency has no rate", async () => {
        accountsRepository.find.mockResolvedValue([mockBrokerageAccount]); // CAD
        holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]); // USD
        yahooFinanceService.fetchIntradaySeries.mockResolvedValue([
          { timestamp: ts1, close: 100 },
        ]);
        exchangeRateService.getLatestRate.mockResolvedValue(null);

        const result = await service.getIntradayValueSeries(userId, {
          range: "1d",
        });

        expect(result.points).toHaveLength(1);
        expect(result.points[0].fxComplete).toBe(false);
        expect(result.points[0].pricesComplete).toBe(true);
        expect(result.fxComplete).toBe(false);
        expect(result.valuationComplete).toBe(false);
        expect(result.missingRatePairs).toEqual(["USD->CAD"]);
      });

      it("marks a bar pricesComplete false and lists the holding whose fetch failed and has no stored close", async () => {
        accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
        holdingsRepository.find.mockResolvedValue([
          mockHoldingAAPL,
          mockHoldingVFV,
        ]);
        yahooFinanceService.fetchIntradaySeries.mockImplementation(
          async (symbol: string) => {
            if (symbol === "AAPL") return [{ timestamp: ts1, close: 100 }];
            throw new Error("yahoo 500");
          },
        );
        // No stored close for VFV (sec-2): the position cannot be valued.
        securityPriceRepository.query.mockResolvedValue([]);
        exchangeRateService.getLatestRate.mockResolvedValue(1.4);

        const result = await service.getIntradayValueSeries(userId, {
          range: "1d",
        });

        expect(result.points[0].pricesComplete).toBe(false);
        expect(result.points[0].fxComplete).toBe(true);
        expect(result.pricesComplete).toBe(false);
        expect(result.valuationComplete).toBe(false);
        expect(result.unpricedSecurityIds).toEqual(["sec-2"]);
      });
    });

    it("falls back only when EVERY intraday fetch fails", async () => {
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([
        mockHoldingAAPL,
        mockHoldingVFV,
      ]);

      yahooFinanceService.fetchIntradaySeries.mockRejectedValue(
        new Error("yahoo 500"),
      );

      const result = await service.getIntradayValueSeries(userId, {
        range: "1d",
      });

      expect(result.fallbackToDaily).toBe(true);
      expect(result.failedSymbols.sort()).toEqual(["AAPL", "VFV.TO"]);
      expect(result.points).toEqual([]);
    });

    it("does not cache the failure payload so a retry actually retries", async () => {
      // Caching the failure for the usual 60s would leave the
      // "Couldn't load intraday prices" banner stuck on screen even after
      // the user clicks Refresh and the upstream blip resolves.
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);

      // Fail every interval in the 1D fallback chain on the first call so
      // we trigger the all-failed fallbackToDaily path. Then succeed on the
      // next call to prove the cache wasn't holding the failure.
      yahooFinanceService.fetchIntradaySeries.mockRejectedValue(
        new Error("yahoo 500"),
      );
      exchangeRateService.getLatestRate.mockResolvedValue(1.4);

      const first = await service.getIntradayValueSeries(userId, {
        range: "1d",
      });
      expect(first.fallbackToDaily).toBe(true);
      expect(first.failedSymbols).toEqual(["AAPL"]);
      const callsAfterFirst =
        yahooFinanceService.fetchIntradaySeries.mock.calls.length;
      expect(callsAfterFirst).toBeGreaterThan(0);

      yahooFinanceService.fetchIntradaySeries.mockReset();
      yahooFinanceService.fetchIntradaySeries.mockResolvedValue([
        { timestamp: new Date("2026-05-06T13:30:00.000Z"), close: 100 },
      ]);

      const second = await service.getIntradayValueSeries(userId, {
        range: "1d",
      });
      expect(second.fallbackToDaily).toBe(false);
      expect(second.points).toHaveLength(1);
      // The retry actually hit Yahoo again (cache wasn't serving the failure).
      expect(yahooFinanceService.fetchIntradaySeries).toHaveBeenCalled();
    });

    it("values foreign-currency holdings at the FX rate prevailing at each bar", async () => {
      // Each bar of a foreign-currency holding should be converted using
      // the FX rate at that bar, not a single latest spot applied flat.
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);

      const ts1 = new Date("2026-05-06T13:30:00.000Z");
      const ts2 = new Date("2026-05-06T13:31:00.000Z");

      yahooFinanceService.fetchIntradaySeries.mockResolvedValue([
        { timestamp: ts1, close: 100 },
        { timestamp: ts2, close: 100 },
      ]);
      yahooFinanceService.fetchIntradayFxSeries.mockImplementation(
        async (from: string, to: string) => {
          if (from === "USD" && to === "CAD") {
            return [
              { timestamp: ts1, close: 1.4 },
              { timestamp: ts2, close: 1.5 },
            ];
          }
          return null;
        },
      );
      exchangeRateService.getLatestRate.mockResolvedValue(1.4);

      const result = await service.getIntradayValueSeries(userId, {
        range: "1d",
      });

      // ts1: 10 * 100 * 1.4 = 1400; ts2 keeps the same price but FX moved.
      expect(result.points[0].value).toBeCloseTo(1400, 4);
      expect(result.points[1].value).toBeCloseTo(10 * 100 * 1.5, 4);
    });

    it("values bars before the first intraday FX bar at the prior daily close, not the first intraday rate", async () => {
      // Yahoo's intraday FX series often starts later than the price series
      // (sparse leading data). Bars before the first FX bar must use the stored
      // daily close for that date -- the rate that actually prevailed -- rather
      // than backfilling the first intraday bar, which is a later, near-current
      // rate. Regression test for the chart's start-of-day / earlier points
      // drifting while only the latest point stayed correct.
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);

      const ts0 = new Date("2026-06-04T13:30:00.000Z");
      const ts1 = new Date("2026-06-04T13:31:00.000Z");
      const ts2 = new Date("2026-06-04T13:32:00.000Z");

      yahooFinanceService.fetchIntradaySeries.mockResolvedValue([
        { timestamp: ts0, close: 100 },
        { timestamp: ts1, close: 100 },
        { timestamp: ts2, close: 100 },
      ]);
      // FX series only covers ts1 and ts2 -- nothing at or before ts0.
      yahooFinanceService.fetchIntradayFxSeries.mockImplementation(
        async (from: string, to: string) => {
          if (from === "USD" && to === "CAD") {
            return [
              { timestamp: ts1, close: 1.4 },
              { timestamp: ts2, close: 1.5 },
            ];
          }
          return null;
        },
      );
      // Prior day's stored daily close used for the uncovered ts0 bar.
      exchangeRateService.getRateHistory.mockResolvedValue([
        {
          fromCurrency: "USD",
          toCurrency: "CAD",
          rate: 1.3,
          rateDate: "2026-06-03",
        },
      ]);
      exchangeRateService.getLatestRate.mockResolvedValue(1.3);

      const result = await service.getIntradayValueSeries(userId, {
        range: "1d",
      });

      // ts0: no intraday FX yet -> prior daily close 1.3 (NOT the first
      // intraday bar 1.4). ts1/ts2: per-bar intraday FX.
      expect(result.points[0].value).toBeCloseTo(10 * 100 * 1.3, 4);
      expect(result.points[1].value).toBeCloseTo(10 * 100 * 1.4, 4);
      expect(result.points[2].value).toBeCloseTo(10 * 100 * 1.5, 4);
    });

    it("applies per-bar FX to cash held in a foreign currency", async () => {
      // Cash amounts don't move intraday, but their value in the display
      // currency does when FX moves. Confirms the chart no longer treats
      // foreign-currency cash as a flat additive offset.
      const usdCashAccount: Partial<Account> = {
        ...mockCashAccount,
        currencyCode: "USD",
        currentBalance: 1000 as any,
      };
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        usdCashAccount,
      ]);
      holdingsRepository.find.mockResolvedValue([mockHoldingVFV]); // CAD-native, no FX

      const ts1 = new Date("2026-05-06T13:30:00.000Z");
      const ts2 = new Date("2026-05-06T13:31:00.000Z");

      yahooFinanceService.fetchIntradaySeries.mockResolvedValue([
        { timestamp: ts1, close: 80 },
        { timestamp: ts2, close: 80 },
      ]);
      yahooFinanceService.fetchIntradayFxSeries.mockImplementation(
        async (from: string, to: string) => {
          if (from === "USD" && to === "CAD") {
            return [
              { timestamp: ts1, close: 1.4 },
              { timestamp: ts2, close: 1.5 },
            ];
          }
          return null;
        },
      );
      exchangeRateService.getLatestRate.mockResolvedValue(1.4);

      const result = await service.getIntradayValueSeries(userId, {
        range: "1d",
      });

      // VFV is CAD-native: 50 * 80 = 4000 at both bars.
      // USD cash 1000 valued at 1.4 then 1.5 -> 1400 then 1500.
      expect(result.points[0].value).toBeCloseTo(4000 + 1400, 4);
      expect(result.points[1].value).toBeCloseTo(4000 + 1500, 4);
    });

    it("falls back to the latest spot when the intraday FX fetch fails", async () => {
      // When Yahoo can't serve an FX series (rate limit, unsupported pair),
      // we still need a sensible value per bar. Fall back to the latest spot
      // rate from ExchangeRateService so the chart degrades gracefully rather
      // than dropping the foreign-currency contribution.
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);

      const ts = new Date("2026-05-06T13:30:00.000Z");
      yahooFinanceService.fetchIntradaySeries.mockResolvedValue([
        { timestamp: ts, close: 100 },
      ]);
      yahooFinanceService.fetchIntradayFxSeries.mockRejectedValue(
        new Error("yahoo FX 429"),
      );
      exchangeRateService.getLatestRate.mockImplementation(
        async (from: string, to: string) => {
          if (from === "USD" && to === "CAD") return 1.4;
          return null;
        },
      );

      const result = await service.getIntradayValueSeries(userId, {
        range: "1d",
      });

      expect(result.points).toHaveLength(1);
      expect(result.points[0].value).toBeCloseTo(10 * 100 * 1.4, 4);
    });

    it("does not surface failedSymbols on partial failures (fallback price covers it)", async () => {
      // Mutual funds and illiquid securities legitimately return no
      // intraday bars from Yahoo. Treat that the same as a fetch failure:
      // value the holding at its latest close instead of pinning the
      // "Couldn't load intraday prices" banner.
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([
        mockHoldingAAPL,
        mockHoldingVFV,
      ]);

      yahooFinanceService.fetchIntradaySeries.mockImplementation(
        async (symbol: string) => {
          if (symbol === "AAPL") {
            return [
              { timestamp: new Date("2026-05-06T13:30:00.000Z"), close: 100 },
            ];
          }
          return null;
        },
      );
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-2", close_price: "80", price_date: "2026-05-05" },
      ]);
      exchangeRateService.getLatestRate.mockResolvedValue(1.4);

      const result = await service.getIntradayValueSeries(userId, {
        range: "1d",
      });

      expect(result.fallbackToDaily).toBe(false);
      expect(result.failedSymbols).toEqual([]);
      expect(result.points).toHaveLength(1);
    });
  });

  describe("getAllocationByTag", () => {
    it("regroups the by-security allocation by each security's tags", async () => {
      jest.spyOn(service, "getPortfolioSummary").mockResolvedValue({
        totalCashValue: 50,
        totalHoldingsValue: 150,
        totalCostBasis: 0,
        totalNetInvested: 0,
        totalPortfolioValue: 200,
        totalGainLoss: 0,
        totalGainLossPercent: 0,
        gainCostBasis: 0,
        unpricedCostBasis: 0,
        fxComplete: true,
        missingRatePairs: [],
        pricesComplete: true,
        unpricedSecurityIds: [],
        valuationComplete: true,
        timeWeightedReturn: null,
        timeWeightedReturnReasons: [],
        timeWeightedReturnSince: null,
        moneyWeightedReturn: null,
        moneyWeightedReturnReasons: [],
        returnDiagnostics: EMPTY_RETURN_DIAGNOSTICS,
        cagr: null,
        holdings: [],
        holdingsByAccount: [],
        allocation: [
          {
            name: "Cash",
            symbol: null,
            type: "cash",
            value: 50,
            percentage: 25,
            currencyCode: "CAD",
          },
          {
            name: "VWCE",
            symbol: "VWCE",
            type: "security",
            value: 100,
            percentage: 50,
            currencyCode: "CAD",
          },
          {
            name: "SMH",
            symbol: "SMH",
            type: "security",
            value: 50,
            percentage: 25,
            currencyCode: "CAD",
          },
        ],
      });

      // The symbol -> tag lookup is a raw statement; it lands on the
      // non-price branch of the manager.query router.
      accountsRepository.query.mockResolvedValue([
        { symbol: "VWCE", id: "t-aw", name: "All-World", color: null },
        { symbol: "SMH", id: "t-ai", name: "AI", color: null },
      ]);

      const result = await service.getAllocationByTag("user-1");

      expect(result.totalValue).toBe(200);
      expect(result.allocation.find((a) => a.name === "All-World")?.value).toBe(
        100,
      );
      expect(result.allocation.find((a) => a.name === "AI")?.value).toBe(50);
      expect(result.allocation.find((a) => a.type === "cash")?.value).toBe(50);
    });
  });

  describe("getPortfolioTagSummary", () => {
    beforeEach(() => {
      prefRepository.findOne.mockResolvedValue(mockPref);
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
    });

    it("reads the held securities' tags without valuing the portfolio", async () => {
      const summarySpy = jest.spyOn(service, "getPortfolioSummary");
      // Only the tags of securities the scope still holds come back: the
      // statement's `ABS(quantity) >= 0.0001` leaves a sold-out security's tag
      // out of the result set, exactly as the valuation-based path did by
      // dropping its allocation slice.
      accountsRepository.query.mockResolvedValue([
        { name: "AI" },
        { name: "country:canada" },
        { name: "sector:tech" },
      ]);

      const result = await service.getPortfolioTagSummary(userId);

      expect(result).toEqual({
        keys: ["country", "sector"],
        hasTaggedHoldings: true,
      });
      expect(summarySpy).not.toHaveBeenCalled();
      expect(holdingsRepository.find).not.toHaveBeenCalled();
      const [sql, params] = accountsRepository.query.mock.calls[0];
      expect(sql).toContain("FROM holdings h");
      expect(sql).toContain("JOIN security_tags st");
      expect(sql).toContain("ABS(h.quantity) >= 0.0001");
      expect(params).toEqual([["acct-brokerage-1"], userId]);
    });

    it("reports no tags when every holding in the scope is untagged", async () => {
      accountsRepository.query.mockResolvedValue([]);

      await expect(service.getPortfolioTagSummary(userId)).resolves.toEqual({
        keys: [],
        hasTaggedHoldings: false,
      });
    });

    it("offers the by-tag grouping for plain labels, which carry no key", async () => {
      accountsRepository.query.mockResolvedValue([
        { name: "Core" },
        { name: "Speculative" },
      ]);

      await expect(service.getPortfolioTagSummary(userId)).resolves.toEqual({
        keys: [],
        hasTaggedHoldings: true,
      });
    });

    it("asks nothing of the database when the scope holds no securities", async () => {
      accountsRepository.find.mockResolvedValue([mockCashAccount]);

      await expect(service.getPortfolioTagSummary(userId)).resolves.toEqual({
        keys: [],
        hasTaggedHoldings: false,
      });
      expect(accountsRepository.query).not.toHaveBeenCalled();
    });

    it("getPortfolioTagKeys is the keys of that same answer", async () => {
      accountsRepository.query.mockResolvedValue([
        { name: "country:canada" },
        { name: "Core" },
      ]);

      await expect(service.getPortfolioTagKeys(userId)).resolves.toEqual([
        "country",
      ]);
    });
  });

  describe("the summary memo", () => {
    beforeEach(() => {
      prefRepository.findOne.mockResolvedValue(mockPref);
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);
      securityPriceRepository.query.mockResolvedValue([
        {
          security_id: "sec-1",
          close_price: "175.50",
          price_date: "2026-02-07",
        },
      ]);
      accountsRepository.query.mockResolvedValue([]);
    });

    it("computes one valuation for concurrent summary and by-tag callers", async () => {
      const compute = jest.spyOn(
        service as unknown as {
          computePortfolioSummary: (...args: unknown[]) => Promise<unknown>;
        },
        "computePortfolioSummary",
      );

      const [summary, byTag] = await Promise.all([
        service.getPortfolioSummary(userId),
        service.getAllocationByTag(userId),
      ]);

      expect(compute).toHaveBeenCalledTimes(1);
      expect(byTag.totalValue).toBe(summary.totalPortfolioValue);
    });

    it("recomputes after the user's derived state is invalidated", async () => {
      const compute = jest.spyOn(
        service as unknown as {
          computePortfolioSummary: (...args: unknown[]) => Promise<unknown>;
        },
        "computePortfolioSummary",
      );

      await service.getPortfolioSummary(userId);
      await service.getPortfolioSummary(userId);
      expect(compute).toHaveBeenCalledTimes(1);

      invalidatePortfolioSummary(userId);

      await service.getPortfolioSummary(userId);
      expect(compute).toHaveBeenCalledTimes(2);
    });

    it("does not share one scope's valuation with another", async () => {
      const compute = jest.spyOn(
        service as unknown as {
          computePortfolioSummary: (...args: unknown[]) => Promise<unknown>;
        },
        "computePortfolioSummary",
      );

      await service.getPortfolioSummary(userId, ["acct-brokerage-1"]);
      await service.getPortfolioSummary(userId);
      expect(compute).toHaveBeenCalledTimes(2);
    });
  });

  describe("getIntradayBreakdown", () => {
    beforeEach(() => {
      prefRepository.findOne.mockResolvedValue(mockPref);
    });

    it("returns empty series when the user has no holdings", async () => {
      accountsRepository.find.mockResolvedValue([mockBrokerageAccount]);
      holdingsRepository.find.mockResolvedValue([]);

      const result = await service.getIntradayBreakdown(userId, {
        range: "1d",
      });

      expect(result.series).toEqual([]);
      expect(result.points).toEqual([]);
      expect(result.currency).toBe("CAD");
    });

    it("splits the intraday value into per-security bands that stack to the total", async () => {
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      holdingsRepository.find.mockResolvedValue([
        mockHoldingAAPL,
        mockHoldingVFV,
      ]);

      const ts1 = new Date("2026-05-06T13:30:00.000Z");
      const ts2 = new Date("2026-05-06T13:31:00.000Z");
      yahooFinanceService.fetchIntradaySeries.mockImplementation(
        async (symbol: string) => {
          if (symbol === "AAPL")
            return [
              { timestamp: ts1, close: 100 },
              { timestamp: ts2, close: 110 },
            ];
          if (symbol === "VFV.TO")
            return [
              { timestamp: ts1, close: 80 },
              { timestamp: ts2, close: 81 },
            ];
          return null;
        },
      );
      exchangeRateService.getLatestRate.mockImplementation(
        async (from: string, to: string) =>
          from === "USD" && to === "CAD" ? 1.4 : null,
      );

      const result = await service.getIntradayBreakdown(userId, {
        range: "1d",
      });

      expect(result.fallbackToDaily).toBe(false);
      // Ranked by peak contribution: VFV (peak 4050) before AAPL (peak 1540),
      // then the cash band.
      expect(result.series.map((s) => s.key)).toEqual([
        "sec-2",
        "sec-1",
        "cash",
      ]);
      expect(result.series[0]).toEqual({
        key: "sec-2",
        type: "security",
        symbol: "VFV.TO",
        name: "Vanguard S&P 500 ETF",
      });
      expect(result.series[2].type).toBe("cash");

      expect(result.points).toHaveLength(2);
      // ts1: AAPL 10*100*1.4=1400, VFV 50*80=4000, cash 5000 -> 10400
      expect(result.points[0].values).toEqual({
        "sec-1": 1400,
        "sec-2": 4000,
        cash: 5000,
      });
      expect(result.points[0].total).toBeCloseTo(10400, 4);
      // ts2: AAPL 10*110*1.4=1540, VFV 50*81=4050, cash 5000 -> 10590
      expect(result.points[1].values).toEqual({
        "sec-1": 1540,
        "sec-2": 4050,
        cash: 5000,
      });
      expect(result.points[1].total).toBeCloseTo(10590, 4);
    });

    it("rolls securities beyond the limit into a single 'other' band", async () => {
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      holdingsRepository.find.mockResolvedValue([
        mockHoldingAAPL,
        mockHoldingVFV,
        { ...mockHoldingXIC, accountId: "acct-brokerage-1" },
      ]);

      const ts1 = new Date("2026-05-06T13:30:00.000Z");
      yahooFinanceService.fetchIntradaySeries.mockImplementation(
        async (symbol: string) => {
          if (symbol === "AAPL") return [{ timestamp: ts1, close: 100 }];
          if (symbol === "VFV.TO") return [{ timestamp: ts1, close: 80 }];
          if (symbol === "XIC.TO") return [{ timestamp: ts1, close: 30 }];
          return null;
        },
      );
      exchangeRateService.getLatestRate.mockImplementation(
        async (from: string, to: string) =>
          from === "USD" && to === "CAD" ? 1.4 : null,
      );

      const result = await service.getIntradayBreakdown(userId, {
        range: "1d",
        limit: 1,
      });

      // VFV (4000) keeps its band; XIC (3000) + AAPL (1400) roll into "other".
      expect(result.series.map((s) => s.key)).toEqual([
        "sec-2",
        "other",
        "cash",
      ]);
      expect(result.series[1].type).toBe("other");
      expect(result.points[0].values).toEqual({
        "sec-2": 4000,
        other: 4400,
        cash: 5000,
      });
      expect(result.points[0].total).toBeCloseTo(13400, 4);
    });

    it("passes through fallbackToDaily when a holding lacks intraday support", async () => {
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      holdingsRepository.find.mockResolvedValue([
        mockHoldingAAPL,
        mockHoldingVFV,
      ]);
      // VFV resolves to a provider without fetchIntradaySeries (e.g. MSN Money).
      quoteProviderRegistry.resolveForSecurity.mockImplementation(
        (security: { symbol: string }) =>
          security.symbol === "VFV.TO"
            ? [{ name: "msn" }]
            : [
                {
                  name: "yahoo",
                  fetchIntradaySeries: yahooFinanceService.fetchIntradaySeries,
                },
              ],
      );

      const result = await service.getIntradayBreakdown(userId, {
        range: "1d",
      });

      expect(result.fallbackToDaily).toBe(true);
      expect(result.skippedSymbols).toEqual(["VFV.TO"]);
      expect(result.series).toEqual([]);
      expect(result.points).toEqual([]);
    });
  });

  // INV-INTRADAY-001, docs/specs/intraday-historical-positions.md: every bar
  // is valued at the positions held at the close of its own day, and a
  // finished session ends on the daily series' own figure for that day.
  describe("intraday series on the ledger's per-day positions", () => {
    const xgro = {
      id: "sec-xgro",
      symbol: "XGRO.TO",
      name: "iShares Core Growth ETF Portfolio",
      securityType: "ETF",
      exchange: "TSX",
      currencyCode: "CAD",
      isActive: true,
    } as unknown as Security;
    const xcns = {
      id: "sec-xcns",
      symbol: "XCNS.TO",
      name: "iShares Core Conservative ETF Portfolio",
      securityType: "ETF",
      exchange: "TSX",
      currencyCode: "CAD",
      isActive: true,
    } as unknown as Security;
    const fund = {
      id: "sec-fund",
      symbol: "TDB900",
      name: "TD Canadian Index Fund",
      securityType: "MUTUAL_FUND",
      exchange: null,
      currencyCode: "CAD",
      isActive: true,
    } as unknown as Security;

    interface DayFixture {
      date: string;
      quantities?: Record<string, number>;
      closes?: Record<string, number | null>;
      closeValues?: Record<string, number | null>;
      cash?: Record<string, number>;
      value: number;
      securitiesValue: number;
      pricesComplete?: boolean;
    }

    /** What `getDailyInvestmentPositions` answers for these days. */
    const ledgerOf = (
      days: DayFixture[],
      securities: Security[],
    ): DailyInvestmentsWithPositions => ({
      series: days.map((d) => ({
        date: d.date,
        value: d.value,
        securitiesValue: d.securitiesValue,
        fxComplete: true,
        missingRatePairs: [],
        pricesComplete: d.pricesComplete ?? true,
        unpricedSecurityIds: [],
        cashComplete: true,
        unknownCashAccountIds: [],
      })),
      positions: days.map((d) => ({
        date: d.date,
        quantities: new Map(Object.entries(d.quantities ?? {})),
        closes: new Map(Object.entries(d.closes ?? {})),
        closeValues: new Map(Object.entries(d.closeValues ?? {})),
        cashByCurrency: new Map(Object.entries(d.cash ?? {})),
      })),
      securities: new Map(securities.map((sec) => [sec.id, sec])),
    });

    const bar = (iso: string, close: number) => ({
      timestamp: new Date(iso),
      open: null,
      close,
    });

    const seriesBySymbol = (bars: Record<string, ReturnType<typeof bar>[]>) =>
      yahooFinanceService.fetchIntradaySeries.mockImplementation(
        async (symbol: string) => bars[symbol] ?? null,
      );

    beforeEach(() => {
      // Every fixture day below is a fixed calendar date meant to read as
      // "finished" against the 1M lookback's 30-day cutoff and against
      // planSessionCloses' own-day check; bracket "now" so neither drifts
      // out from under the assertions as real time passes.
      jest.useFakeTimers().setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
      prefRepository.findOne.mockResolvedValue(mockPref);
      accountsRepository.find.mockResolvedValue([
        mockBrokerageAccount,
        mockCashAccount,
      ]);
      // Today's holdings row disagrees with every past day on purpose: the
      // ledger path must never read it.
      holdingsRepository.find.mockResolvedValue([mockHoldingVFV]);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("ends each finished session on the daily close, one step after its last bar (XGRO, Sep 2)", async () => {
      const qty = 2891.173;
      netWorthService.getDailyInvestmentPositions.mockResolvedValue(
        ledgerOf(
          [
            {
              date: "2026-09-01",
              quantities: { [xgro.id]: qty },
              closes: { [xgro.id]: 38.53 },
              closeValues: { [xgro.id]: 111396.8957 },
              value: 111396.8957,
              securitiesValue: 111396.8957,
            },
            {
              date: "2026-09-02",
              quantities: { [xgro.id]: qty },
              closes: { [xgro.id]: 38.58 },
              closeValues: { [xgro.id]: 111541.4543 },
              value: 111541.4543,
              securitiesValue: 111541.4543,
            },
          ],
          [xgro],
        ),
      );
      seriesBySymbol({
        "XGRO.TO": [
          bar("2026-09-01T19:30:00.000Z", 38.5),
          bar("2026-09-01T19:45:00.000Z", 38.53),
          bar("2026-09-02T19:30:00.000Z", 38.55),
          // The last 15-minute bar's last trade, not the closing auction.
          bar("2026-09-02T19:45:00.000Z", 38.575),
        ],
      });

      const result = await service.getIntradayValueSeries(userId, {
        range: "1m",
      });

      // The ledger does not reach the day the month is measured from, so
      // there is no close to open on and the month opens on its first
      // session's last bar rather than its 15:30 one.
      expect(result.points.map((p) => p.timestamp)).toEqual([
        "2026-09-01T19:45:00.000Z",
        "2026-09-01T20:00:00.000Z",
        "2026-09-02T19:30:00.000Z",
        "2026-09-02T19:45:00.000Z",
        "2026-09-02T20:00:00.000Z",
      ]);
      // The 15:45 bar is the last trade ...
      expect(result.points[3].value).toBeCloseTo(qty * 38.575, 4);
      // ... and the 16:00 point is the daily series' figure, to the cent.
      expect(result.points[4].value).toBe(111541.4543);
      expect(result.points[4].securitiesValue).toBe(111541.4543);
      expect(result.points[1].value).toBe(111396.8957);
    });

    it("marks a live bar pricesComplete false when a close-valued holding has no close", async () => {
      netWorthService.getDailyInvestmentPositions.mockResolvedValue(
        ledgerOf(
          [
            {
              date: "2026-09-02",
              quantities: { [xgro.id]: 10, [fund.id]: 5 },
              closes: { [xgro.id]: 100, [fund.id]: null },
              closeValues: { [xgro.id]: 1000, [fund.id]: null },
              value: 1000,
              securitiesValue: 1000,
              pricesComplete: false,
            },
          ],
          [xgro, fund],
        ),
      );
      seriesBySymbol({
        "XGRO.TO": [
          bar("2026-09-02T19:30:00.000Z", 100),
          bar("2026-09-02T19:45:00.000Z", 101),
        ],
      });

      const result = await service.getIntradayValueSeries(userId, {
        range: "1m",
      });

      const live = result.points.find(
        (p) => p.timestamp === "2026-09-02T19:45:00.000Z",
      )!;
      expect(live.pricesComplete).toBe(false);
      expect(live.fxComplete).toBe(true);
      expect(live.cashComplete).toBe(true);
      expect(result.pricesComplete).toBe(false);
      expect(result.valuationComplete).toBe(false);
      expect(result.unpricedSecurityIds).toEqual([fund.id]);

      const breakdown = await service.getIntradayBreakdown(userId, {
        range: "1m",
      });
      const liveBand = breakdown.points.find(
        (p) => p.timestamp === "2026-09-02T19:45:00.000Z",
      )!;
      expect(liveBand.pricesComplete).toBe(false);
      expect(breakdown.pricesComplete).toBe(false);
      expect(breakdown.unpricedSecurityIds).toEqual([fund.id]);
    });

    it("values a bond-linked holding at its stored close on the ledger path and never asks a provider for it (INV-BOND-005)", async () => {
      const bond = {
        id: "sec-bond",
        symbol: "TOS1029",
        name: "TOS1029",
        securityType: "BOND",
        exchange: null,
        currencyCode: "CAD",
        isActive: true,
        bondProgramId: "11111111-1111-5111-8111-111111111111",
      } as unknown as Security;
      netWorthService.getDailyInvestmentPositions.mockResolvedValue(
        ledgerOf(
          [
            {
              date: "2026-09-01",
              quantities: { [xgro.id]: 10, [bond.id]: 100 },
              closes: { [xgro.id]: 100, [bond.id]: 100 },
              // The bond's close is the engine's stored price, per day.
              closeValues: { [xgro.id]: 1000, [bond.id]: 10000 },
              value: 11000,
              securitiesValue: 11000,
            },
            {
              date: "2026-09-02",
              quantities: { [xgro.id]: 10, [bond.id]: 100 },
              closes: { [xgro.id]: 101, [bond.id]: 100.1 },
              closeValues: { [xgro.id]: 1010, [bond.id]: 10010 },
              value: 11020,
              securitiesValue: 11020,
            },
          ],
          [xgro, bond],
        ),
      );
      seriesBySymbol({
        "XGRO.TO": [
          bar("2026-09-01T19:45:00.000Z", 100),
          bar("2026-09-02T19:45:00.000Z", 102),
        ],
      });

      const result = await service.getIntradayValueSeries(userId, {
        range: "1m",
      });

      const asked = yahooFinanceService.fetchIntradaySeries.mock.calls.map(
        ([symbol]: [string]) => symbol,
      );
      expect(asked).not.toContain("TOS1029");
      // Mid-session the bond contributes its stored close beside the live bar:
      // 10 x 102 + 10010. Dropping a holding that is not fetched would leave 1020.
      const midSession = result.points.find(
        (p) => p.timestamp === "2026-09-02T19:45:00.000Z",
      )!;
      expect(midSession.value).toBeCloseTo(1020 + 10010, 4);
      // The session's last point is the daily series' figure, bond included.
      const close = result.points.find(
        (p) => p.timestamp === "2026-09-02T20:00:00.000Z",
      )!;
      expect(close.value).toBe(11020);
      expect(close.securitiesValue).toBe(11020);
    });

    it("values each day at that day's share count and cash, not today's (a deposit, then a buy)", async () => {
      // Pinned so the fixture's Aug 28 stays inside the 1M range's rolling
      // 30-day cutoff regardless of the real date the suite runs on.
      jest.useFakeTimers().setSystemTime(new Date("2026-09-05T12:00:00.000Z"));
      try {
        netWorthService.getDailyInvestmentPositions.mockResolvedValue(
          ledgerOf(
            [
              {
                date: "2026-08-28",
                quantities: { [xcns.id]: 100 },
                closes: { [xcns.id]: 40 },
                closeValues: { [xcns.id]: 4000 },
                cash: { CAD: 2000 },
                value: 6000,
                securitiesValue: 4000,
              },
              {
                date: "2026-08-31",
                quantities: { [xcns.id]: 150 },
                closes: { [xcns.id]: 41 },
                closeValues: { [xcns.id]: 6150 },
                cash: { CAD: 0 },
                value: 6150,
                securitiesValue: 6150,
              },
            ],
            [xcns],
          ),
        );
        seriesBySymbol({
          "XCNS.TO": [
            bar("2026-08-28T14:00:00.000Z", 40),
            bar("2026-08-31T14:00:00.000Z", 41),
          ],
        });

        const result = await service.getIntradayValueSeries(userId, {
          range: "1m",
        });
        const at = (iso: string) =>
          result.points.find((p) => p.timestamp === iso)!;

        // Aug 28: the pre-buy 100 shares and the $2,000 not yet invested.
        expect(at("2026-08-28T14:00:00.000Z").value).toBeCloseTo(6000, 4);
        expect(at("2026-08-28T14:00:00.000Z").securitiesValue).toBeCloseTo(
          4000,
          4,
        );
        // Aug 31: the bought shares, the cash spent.
        expect(at("2026-08-31T14:00:00.000Z").value).toBeCloseTo(6150, 4);
        // Today's holdings and balances were never consulted.
        expect(holdingsRepository.find).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it("keeps a position sold mid-window up to the sale, though nothing holds it today", async () => {
      holdingsRepository.find.mockResolvedValue([]);
      netWorthService.getDailyInvestmentPositions.mockResolvedValue(
        ledgerOf(
          [
            {
              date: "2026-09-10",
              quantities: { [xgro.id]: 10 },
              closes: { [xgro.id]: 38 },
              closeValues: { [xgro.id]: 380 },
              value: 380,
              securitiesValue: 380,
            },
            {
              date: "2026-09-11",
              quantities: { [xgro.id]: 0 },
              cash: { CAD: 385 },
              value: 385,
              securitiesValue: 0,
            },
          ],
          [xgro],
        ),
      );
      seriesBySymbol({
        "XGRO.TO": [
          bar("2026-09-10T15:00:00.000Z", 38.2),
          bar("2026-09-11T15:00:00.000Z", 38.6),
        ],
      });

      const result = await service.getIntradayValueSeries(userId, {
        range: "1m",
      });
      const at = (iso: string) =>
        result.points.find((p) => p.timestamp === iso)!;

      expect(yahooFinanceService.fetchIntradaySeries).toHaveBeenCalledWith(
        "XGRO.TO",
        "TSX",
        expect.anything(),
      );
      expect(at("2026-09-10T15:00:00.000Z").securitiesValue).toBeCloseTo(
        382,
        4,
      );
      expect(at("2026-09-11T15:00:00.000Z").securitiesValue).toBe(0);
      expect(at("2026-09-11T15:00:00.000Z").value).toBeCloseTo(385, 4);
    });

    it("values a holding with no intraday bars at each day's own close", async () => {
      netWorthService.getDailyInvestmentPositions.mockResolvedValue(
        ledgerOf(
          [
            {
              date: "2026-09-14",
              quantities: { [xgro.id]: 10, [fund.id]: 5 },
              closes: { [xgro.id]: 38, [fund.id]: 20 },
              value: 480,
              securitiesValue: 480,
            },
            {
              date: "2026-09-15",
              quantities: { [xgro.id]: 10, [fund.id]: 5 },
              closes: { [xgro.id]: 39, [fund.id]: 21 },
              value: 495,
              securitiesValue: 495,
            },
          ],
          [xgro, fund],
        ),
      );
      seriesBySymbol({
        "XGRO.TO": [
          bar("2026-09-14T15:00:00.000Z", 38),
          bar("2026-09-15T15:00:00.000Z", 39),
        ],
      });

      const result = await service.getIntradayValueSeries(userId, {
        range: "1m",
      });
      const at = (iso: string) =>
        result.points.find((p) => p.timestamp === iso)!;

      // 10 x 38 + 5 x 20, then 10 x 39 + 5 x 21: the fund moves with its
      // closes rather than sitting flat at the latest one.
      expect(at("2026-09-14T15:00:00.000Z").value).toBeCloseTo(480, 4);
      expect(at("2026-09-15T15:00:00.000Z").value).toBeCloseTo(495, 4);
    });

    it("gives today's live session no closing point", async () => {
      const today = new Date().toISOString().slice(0, 10);
      netWorthService.getDailyInvestmentPositions.mockResolvedValue(
        ledgerOf(
          [
            {
              date: today,
              quantities: { [xgro.id]: 10 },
              closes: { [xgro.id]: 38 },
              value: 380,
              securitiesValue: 380,
            },
          ],
          [xgro],
        ),
      );
      seriesBySymbol({
        "XGRO.TO": [
          bar(`${today}T00:00:00.000Z`, 38.1),
          bar(`${today}T00:01:00.000Z`, 38.2),
        ],
      });

      const result = await service.getIntradayValueSeries(userId, {
        range: "1d",
      });

      expect(result.points.map((p) => p.timestamp)).toEqual([
        `${today}T00:00:00.000Z`,
        `${today}T00:01:00.000Z`,
      ]);
      expect(result.points[1].value).toBeCloseTo(382, 4);
    });

    it("leaves a day the daily series could not value completely on its bars", async () => {
      netWorthService.getDailyInvestmentPositions.mockResolvedValue(
        ledgerOf(
          [
            {
              date: "2026-09-16",
              quantities: { [xgro.id]: 10 },
              closes: { [xgro.id]: null },
              value: 0,
              securitiesValue: 0,
              pricesComplete: false,
            },
            {
              date: "2026-09-17",
              quantities: { [xgro.id]: 10 },
              closes: { [xgro.id]: 39 },
              value: 390,
              securitiesValue: 390,
            },
          ],
          [xgro],
        ),
      );
      seriesBySymbol({
        "XGRO.TO": [
          bar("2026-09-16T19:45:00.000Z", 38.5),
          bar("2026-09-17T19:45:00.000Z", 39),
        ],
      });

      const result = await service.getIntradayValueSeries(userId, {
        range: "1m",
      });

      // No subtotal wearing Sep 16's closing caption; Sep 17 still closes.
      expect(result.points.map((p) => p.timestamp)).toEqual([
        "2026-09-16T19:45:00.000Z",
        "2026-09-17T19:45:00.000Z",
        "2026-09-17T20:00:00.000Z",
      ]);
      expect(result.points[0].value).toBeCloseTo(385, 4);
    });

    it("carries each position at its daily close in the breakdown's closing point", async () => {
      netWorthService.getDailyInvestmentPositions.mockResolvedValue(
        ledgerOf(
          [
            {
              date: "2026-09-18",
              quantities: { [xgro.id]: 10, [xcns.id]: 20 },
              closes: { [xgro.id]: 38, [xcns.id]: 40 },
              closeValues: { [xgro.id]: 380, [xcns.id]: 800 },
              cash: { CAD: 50 },
              value: 1230,
              securitiesValue: 1180,
            },
          ],
          [xgro, xcns],
        ),
      );
      seriesBySymbol({
        "XGRO.TO": [bar("2026-09-18T19:45:00.000Z", 37.9)],
        "XCNS.TO": [bar("2026-09-18T19:45:00.000Z", 39.9)],
      });

      const result = await service.getIntradayBreakdown(userId, {
        range: "1m",
      });

      expect(result.points).toHaveLength(2);
      const bars = result.points[0];
      expect(bars.values[xgro.id]).toBeCloseTo(379, 4);
      expect(bars.values[xcns.id]).toBeCloseTo(798, 4);
      expect(bars.values.cash).toBeCloseTo(50, 4);
      const close = result.points[1];
      expect(close.timestamp).toBe("2026-09-18T20:00:00.000Z");
      expect(close.values[xgro.id]).toBe(380);
      expect(close.values[xcns.id]).toBe(800);
      expect(close.values.cash).toBe(50);
      expect(close.total).toBe(1230);
      expect(close.sessionClose).toBe(true);
      expect(bars.sessionClose).toBeUndefined();
    });

    /**
     * The series opens on the close the range is measured from, dated on the
     * session that close came from -- the same day and the same figure the
     * period-result service reports for the range, so the chart's first point
     * and its "since the close of trading on" caption agree (issue #1461).
     */
    describe("the close the series opens on", () => {
      // Monday 28 September 2026, the day the issue was reported on. 1W is
      // served at five-minute bars, so its sessions end on a 19:55 bar and
      // close at 20:00.
      const monday = "2026-09-28T14:00:00.000Z";
      const day = (
        date: string,
        value: number,
        extra: Partial<DayFixture> = {},
      ): DayFixture => ({
        date,
        quantities: { [xgro.id]: 10 },
        closes: { [xgro.id]: value / 10 },
        closeValues: { [xgro.id]: value },
        value,
        securitiesValue: value,
        ...extra,
      });

      it("opens 1W on the prior session's close, from the day the period is measured from", async () => {
        jest.setSystemTime(new Date(monday));
        // 1W opens on the 21st and is measured from the 20th (a Sunday),
        // whose figure is Friday the 18th's close. The 20th is given its own
        // figure here so the test can tell which day was read.
        netWorthService.getDailyInvestmentPositions.mockResolvedValue(
          ledgerOf(
            [
              day("2026-09-18", 380),
              day("2026-09-19", 380),
              day("2026-09-20", 381),
              day("2026-09-21", 390),
            ],
            [xgro],
          ),
        );
        netWorthService.getLastPricedDays.mockResolvedValue(
          new Map([["2026-09-20", "2026-09-18"]]),
        );
        seriesBySymbol({
          "XGRO.TO": [
            bar("2026-09-18T19:30:00.000Z", 37.9),
            bar("2026-09-18T19:55:00.000Z", 38),
            bar("2026-09-21T13:30:00.000Z", 38.5),
            bar("2026-09-21T19:55:00.000Z", 39),
          ],
        });

        const result = await service.getIntradayValueSeries(userId, {
          range: "1w",
        });

        expect(result.points.map((p) => p.timestamp)).toEqual([
          "2026-09-18T20:00:00.000Z",
          "2026-09-21T13:30:00.000Z",
          "2026-09-21T19:55:00.000Z",
          "2026-09-21T20:00:00.000Z",
        ]);
        // Friday's close carries the measured-from day's figure, flagged as
        // a close; Friday's own bars are not in a one-week window.
        expect(result.points[0]).toEqual({
          timestamp: "2026-09-18T20:00:00.000Z",
          value: 381,
          securitiesValue: 381,
          fxComplete: true,
          pricesComplete: true,
          cashComplete: true,
          sessionClose: true,
        });
        expect(result.points[1].sessionClose).toBeUndefined();
        // The session is the period result's own lookup, for the same day.
        expect(netWorthService.getLastPricedDays).toHaveBeenCalledWith(
          userId,
          ["2026-09-20"],
          undefined,
        );
        // The ledger reaches back to the measured-from day.
        expect(
          netWorthService.getDailyInvestmentPositions,
        ).toHaveBeenCalledWith(
          userId,
          expect.objectContaining({
            startDate: "2026-09-20",
            endDate: "2026-09-28",
          }),
        );
      });

      it("dates the window by the user's calendar, not UTC's, in the evening west of Greenwich", async () => {
        // 22:30 on Wednesday 21 October in Toronto is already the 22nd in UTC.
        // The caption reads the user's day, so 1W opens on the 14th and is
        // measured from Tuesday the 13th's close. A UTC "today" measured it
        // from the 14th and cut the 14th's bars out of the window.
        jest.setSystemTime(new Date("2026-10-22T02:30:00.000Z"));
        netWorthService.getDailyInvestmentPositions.mockResolvedValue(
          ledgerOf([day("2026-10-13", 400), day("2026-10-14", 410)], [xgro]),
        );
        netWorthService.getLastPricedDays.mockResolvedValue(
          new Map([["2026-10-13", "2026-10-13"]]),
        );
        seriesBySymbol({
          "XGRO.TO": [
            bar("2026-10-13T19:55:00.000Z", 40),
            bar("2026-10-14T13:30:00.000Z", 40.5),
            bar("2026-10-14T19:55:00.000Z", 41),
          ],
        });

        const result = await requestContextStorage.run(
          { timezone: "America/Toronto" },
          () => service.getIntradayValueSeries(userId, { range: "1w" }),
        );

        expect(result.points.map((p) => p.timestamp)).toEqual([
          "2026-10-13T20:00:00.000Z",
          "2026-10-14T13:30:00.000Z",
          "2026-10-14T19:55:00.000Z",
          "2026-10-14T20:00:00.000Z",
        ]);
        expect(result.points[0].value).toBe(400);
        expect(netWorthService.getLastPricedDays).toHaveBeenCalledWith(
          userId,
          ["2026-10-13"],
          undefined,
        );
        expect(
          netWorthService.getDailyInvestmentPositions,
        ).toHaveBeenCalledWith(
          userId,
          expect.objectContaining({
            startDate: "2026-10-13",
            endDate: "2026-10-21",
          }),
        );
      });

      it("dates a 1M window that opens on a weekend by the session before it, at the hour the window's sessions close", async () => {
        jest.setSystemTime(new Date(monday));
        // 1M opens on Saturday 29 August and is measured from it; the close
        // is Friday the 28th's, which the provider's month of bars did not
        // reach, so the point is stamped at the hour the newest finished
        // session closed at.
        netWorthService.getDailyInvestmentPositions.mockResolvedValue(
          ledgerOf(
            [
              day("2026-08-29", 1000),
              day("2026-08-30", 1000),
              day("2026-08-31", 1010),
              day("2026-09-01", 1020),
            ],
            [xgro],
          ),
        );
        netWorthService.getLastPricedDays.mockResolvedValue(
          new Map([["2026-08-29", "2026-08-28"]]),
        );
        seriesBySymbol({
          "XGRO.TO": [
            bar("2026-08-31T13:30:00.000Z", 100.5),
            bar("2026-08-31T19:45:00.000Z", 101),
            bar("2026-09-01T13:30:00.000Z", 101.5),
            bar("2026-09-01T19:45:00.000Z", 102),
          ],
        });

        const result = await service.getIntradayValueSeries(userId, {
          range: "1m",
        });

        expect(result.points.map((p) => p.timestamp)).toEqual([
          "2026-08-28T20:00:00.000Z",
          "2026-08-31T13:30:00.000Z",
          "2026-08-31T19:45:00.000Z",
          "2026-08-31T20:00:00.000Z",
          "2026-09-01T13:30:00.000Z",
          "2026-09-01T19:45:00.000Z",
          "2026-09-01T20:00:00.000Z",
        ]);
        expect(result.points[0].value).toBe(1000);
        expect(result.points[0].sessionClose).toBe(true);
      });

      it("opens a 1M window that starts on a session at that session's close, not its morning", async () => {
        // Wednesday 30 September: 1M opens on Monday 31 August, a session.
        jest.setSystemTime(new Date("2026-09-30T14:00:00.000Z"));
        netWorthService.getDailyInvestmentPositions.mockResolvedValue(
          ledgerOf([day("2026-08-31", 1010), day("2026-09-01", 1020)], [xgro]),
        );
        netWorthService.getLastPricedDays.mockResolvedValue(
          new Map([["2026-08-31", "2026-08-31"]]),
        );
        seriesBySymbol({
          "XGRO.TO": [
            bar("2026-08-31T13:30:00.000Z", 100.5),
            bar("2026-08-31T19:45:00.000Z", 101),
            bar("2026-09-01T13:30:00.000Z", 101.5),
            bar("2026-09-01T19:45:00.000Z", 102),
          ],
        });

        const result = await service.getIntradayValueSeries(userId, {
          range: "1m",
        });

        expect(result.points.map((p) => p.timestamp)).toEqual([
          "2026-08-31T20:00:00.000Z",
          "2026-09-01T13:30:00.000Z",
          "2026-09-01T19:45:00.000Z",
          "2026-09-01T20:00:00.000Z",
        ]);
        expect(result.points[0].value).toBe(1010);
      });

      it("opens on the first bar when the measured-from day's figure is a subtotal", async () => {
        jest.setSystemTime(new Date(monday));
        netWorthService.getDailyInvestmentPositions.mockResolvedValue(
          ledgerOf(
            [
              day("2026-09-20", 0, {
                closes: { [xgro.id]: null },
                closeValues: { [xgro.id]: null },
                pricesComplete: false,
              }),
              day("2026-09-21", 390),
            ],
            [xgro],
          ),
        );
        seriesBySymbol({
          "XGRO.TO": [
            bar("2026-09-18T19:55:00.000Z", 38),
            bar("2026-09-21T19:55:00.000Z", 39),
          ],
        });

        const result = await service.getIntradayValueSeries(userId, {
          range: "1w",
        });

        // No subtotal wearing the opening close's caption, and no lookup for
        // a session it would not be dated on.
        expect(result.points.map((p) => p.timestamp)).toEqual([
          "2026-09-21T19:55:00.000Z",
          "2026-09-21T20:00:00.000Z",
        ]);
        expect(netWorthService.getLastPricedDays).not.toHaveBeenCalled();
      });

      it("serves MTD on its own window, opened on the previous month's last close", async () => {
        // Saturday 31 October: a thirty-day 1M window opens on 1 October
        // itself, so MTD cannot be cut out of it. Its own window opens on the
        // 1st and is measured from 30 September, whose bars the provider's
        // month did not reach: the point is stamped at the hour the newest
        // finished session (2 October) closed at.
        jest.setSystemTime(new Date("2026-10-31T14:00:00.000Z"));
        netWorthService.getDailyInvestmentPositions.mockResolvedValue(
          ledgerOf(
            [
              day("2026-09-30", 1000),
              day("2026-10-01", 1010),
              day("2026-10-02", 1020),
            ],
            [xgro],
          ),
        );
        netWorthService.getLastPricedDays.mockResolvedValue(
          new Map([["2026-09-30", "2026-09-30"]]),
        );
        seriesBySymbol({
          "XGRO.TO": [
            bar("2026-10-01T13:30:00.000Z", 100.5),
            bar("2026-10-01T19:45:00.000Z", 101),
            bar("2026-10-02T13:30:00.000Z", 101.5),
            bar("2026-10-02T19:45:00.000Z", 102),
          ],
        });

        const result = await service.getIntradayValueSeries(userId, {
          range: "mtd",
        });

        expect(result.range).toBe("mtd");
        expect(result.points.map((p) => p.timestamp)).toEqual([
          "2026-09-30T20:00:00.000Z",
          "2026-10-01T13:30:00.000Z",
          "2026-10-01T19:45:00.000Z",
          "2026-10-01T20:00:00.000Z",
          "2026-10-02T13:30:00.000Z",
          "2026-10-02T19:45:00.000Z",
          "2026-10-02T20:00:00.000Z",
        ]);
        expect(result.points[0]).toEqual({
          timestamp: "2026-09-30T20:00:00.000Z",
          value: 1000,
          securitiesValue: 1000,
          fxComplete: true,
          pricesComplete: true,
          cashComplete: true,
          sessionClose: true,
        });
        expect(
          netWorthService.getDailyInvestmentPositions,
        ).toHaveBeenCalledWith(
          userId,
          expect.objectContaining({ startDate: "2026-09-30" }),
        );
      });

      it("takes the closing hour from an unvalued session's last bar when no close was planned", async () => {
        jest.setSystemTime(new Date(monday));
        netWorthService.getDailyInvestmentPositions.mockResolvedValue(
          ledgerOf(
            [
              day("2026-09-20", 381),
              // Monday's figure is a subtotal, so Monday gets no closing point.
              day("2026-09-21", 0, {
                closes: { [xgro.id]: null },
                closeValues: { [xgro.id]: null },
                pricesComplete: false,
              }),
            ],
            [xgro],
          ),
        );
        netWorthService.getLastPricedDays.mockResolvedValue(
          new Map([["2026-09-20", "2026-09-18"]]),
        );
        seriesBySymbol({
          "XGRO.TO": [
            bar("2026-09-21T13:30:00.000Z", 38.5),
            bar("2026-09-21T19:55:00.000Z", 39),
          ],
        });

        const result = await service.getIntradayValueSeries(userId, {
          range: "1w",
        });

        // Friday's close is still the opening point, at the hour Monday's
        // session ended (its last bar plus one five-minute step).
        expect(result.points.map((p) => p.timestamp)).toEqual([
          "2026-09-18T20:00:00.000Z",
          "2026-09-21T13:30:00.000Z",
          "2026-09-21T19:55:00.000Z",
        ]);
        expect(result.points[0].value).toBe(381);
      });

      it("has no opening close when the window holds only today's live session and no bars reach the session", async () => {
        // Monday morning, the provider's bars start today and Friday's were
        // not fetched: no finished session says when a close falls, so the
        // series opens on its first bar rather than on a guessed hour.
        jest.setSystemTime(new Date(monday));
        netWorthService.getDailyInvestmentPositions.mockResolvedValue(
          ledgerOf([day("2026-09-20", 381), day("2026-09-28", 390)], [xgro]),
        );
        netWorthService.getLastPricedDays.mockResolvedValue(
          new Map([["2026-09-20", "2026-09-18"]]),
        );
        seriesBySymbol({
          "XGRO.TO": [
            bar("2026-09-28T13:30:00.000Z", 38.5),
            bar("2026-09-28T13:35:00.000Z", 38.6),
          ],
        });

        const result = await service.getIntradayValueSeries(userId, {
          range: "1w",
        });

        expect(result.points.map((p) => p.timestamp)).toEqual([
          "2026-09-28T13:30:00.000Z",
          "2026-09-28T13:35:00.000Z",
        ]);
        expect(result.points.every((p) => p.sessionClose === undefined)).toBe(
          true,
        );
      });

      it("opens 1M on its first session's last bar when there is no close to open on", async () => {
        // Wednesday 30 September: 1M is measured from Monday 31 August, whose
        // figure is a subtotal. The month still does not open partway through
        // that morning.
        jest.setSystemTime(new Date("2026-09-30T14:00:00.000Z"));
        netWorthService.getDailyInvestmentPositions.mockResolvedValue(
          ledgerOf(
            [
              day("2026-08-31", 0, {
                closes: { [xgro.id]: null },
                closeValues: { [xgro.id]: null },
                pricesComplete: false,
              }),
              day("2026-09-01", 1020),
            ],
            [xgro],
          ),
        );
        seriesBySymbol({
          "XGRO.TO": [
            bar("2026-08-31T13:30:00.000Z", 100.5),
            bar("2026-08-31T19:45:00.000Z", 101),
            bar("2026-09-01T13:30:00.000Z", 101.5),
            bar("2026-09-01T19:45:00.000Z", 102),
          ],
        });

        const result = await service.getIntradayValueSeries(userId, {
          range: "1m",
        });

        expect(result.points.map((p) => p.timestamp)).toEqual([
          "2026-08-31T19:45:00.000Z",
          "2026-09-01T13:30:00.000Z",
          "2026-09-01T19:45:00.000Z",
          "2026-09-01T20:00:00.000Z",
        ]);
        expect(result.points[0].sessionClose).toBeUndefined();
      });

      it("opens the breakdown on the same point, each position at its close", async () => {
        jest.setSystemTime(new Date(monday));
        netWorthService.getDailyInvestmentPositions.mockResolvedValue(
          ledgerOf(
            [
              {
                date: "2026-09-20",
                quantities: { [xgro.id]: 10, [xcns.id]: 20 },
                closes: { [xgro.id]: 38, [xcns.id]: 40 },
                closeValues: { [xgro.id]: 380, [xcns.id]: 800 },
                cash: { CAD: 50 },
                value: 1230,
                securitiesValue: 1180,
              },
              {
                date: "2026-09-21",
                quantities: { [xgro.id]: 10, [xcns.id]: 20 },
                closes: { [xgro.id]: 39, [xcns.id]: 41 },
                closeValues: { [xgro.id]: 390, [xcns.id]: 820 },
                cash: { CAD: 50 },
                value: 1260,
                securitiesValue: 1210,
              },
            ],
            [xgro, xcns],
          ),
        );
        netWorthService.getLastPricedDays.mockResolvedValue(
          new Map([["2026-09-20", "2026-09-18"]]),
        );
        seriesBySymbol({
          "XGRO.TO": [
            bar("2026-09-18T19:55:00.000Z", 38),
            bar("2026-09-21T19:55:00.000Z", 39),
          ],
          "XCNS.TO": [
            bar("2026-09-18T19:55:00.000Z", 40),
            bar("2026-09-21T19:55:00.000Z", 41),
          ],
        });

        const result = await service.getIntradayBreakdown(userId, {
          range: "1w",
        });

        expect(result.points.map((p) => p.timestamp)).toEqual([
          "2026-09-18T20:00:00.000Z",
          "2026-09-21T19:55:00.000Z",
          "2026-09-21T20:00:00.000Z",
        ]);
        const opening = result.points[0];
        expect(opening.sessionClose).toBe(true);
        expect(opening.values[xgro.id]).toBe(380);
        expect(opening.values[xcns.id]).toBe(800);
        expect(opening.values.cash).toBe(50);
        expect(opening.total).toBe(1230);
        expect(result.points[1].sessionClose).toBeUndefined();
      });
    });
  });

  // A currency with neither an intraday FX series nor a spot rate has no rate
  // (INV-FX-001). The lookup answers `null`, the contribution leaves the holding
  // out and records the currency for the warning, and nothing values it at 1.
  describe("the intraday FX lookup for a currency with no series and no spot rate", () => {
    type FxAt = (currency: string, ts: number) => number | null;
    const privates = () =>
      service as unknown as {
        makeIntradayFxAt: (loaded: unknown) => FxAt;
        makeIntradayContribution: (
          fxAt: FxAt,
          unrated: Set<string>,
        ) => (amount: number, currency: string, ts: number) => number;
      };
    const loadedWith = (spot: Array<[string, number]>) => ({
      currency: "CAD",
      fxByCurrency: new Map(),
      spotRate: new Map(spot),
      dailyRateIndex: new Map(),
    });
    const ts = Date.parse("2026-05-06T13:30:00.000Z");

    it("answers null, not 1, so the holding is not valued at its face number", () => {
      const fxAt = privates().makeIntradayFxAt(loadedWith([]));

      expect(fxAt("JPY", ts)).toBeNull();
      // Rate 1 is only ever the display currency itself.
      expect(fxAt("CAD", ts)).toBe(1);
    });

    it("uses the spot rate when there is one", () => {
      const fxAt = privates().makeIntradayFxAt(loadedWith([["USD->CAD", 1.4]]));

      expect(fxAt("USD", ts)).toBe(1.4);
      expect(fxAt("JPY", ts)).toBeNull();
    });

    it("leaves the holding out of the point and records the currency for the warning", () => {
      const unrated = new Set<string>();
      const fxAt = privates().makeIntradayFxAt(loadedWith([["USD->CAD", 1.4]]));
      const contribution = privates().makeIntradayContribution(fxAt, unrated);

      // 100,000 JPY with no rate contributes nothing; it is not 100,000 CAD.
      expect(contribution(100000, "JPY", ts)).toBe(0);
      expect(contribution(100, "USD", ts)).toBe(1400000);
      expect([...unrated]).toEqual(["JPY"]);
    });
  });
});
