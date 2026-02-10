import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { PortfolioService } from "./portfolio.service";
import { Holding } from "./entities/holding.entity";
import { SecurityPrice } from "./entities/security-price.entity";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";

describe("PortfolioService", () => {
  let service: PortfolioService;
  let holdingsRepository: Record<string, jest.Mock>;
  let securityPriceRepository: Record<string, jest.Mock>;
  let accountsRepository: Record<string, jest.Mock>;
  let prefRepository: Record<string, jest.Mock>;
  let exchangeRateService: Record<string, jest.Mock>;

  const userId = "user-1";

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

  // -- Mock holdings --
  const mockHoldingAAPL: Partial<Holding> = {
    id: "hold-1",
    accountId: "acct-brokerage-1",
    securityId: "sec-1",
    quantity: 10 as any,
    averageCost: 150 as any,
    security: mockSecurityAAPL as any,
  };

  const mockHoldingVFV: Partial<Holding> = {
    id: "hold-2",
    accountId: "acct-brokerage-1",
    securityId: "sec-2",
    quantity: 50 as any,
    averageCost: 80 as any,
    security: mockSecurityVFV as any,
  };

  const mockHoldingXIC: Partial<Holding> = {
    id: "hold-3",
    accountId: "acct-standalone-1",
    securityId: "sec-3",
    quantity: 100 as any,
    averageCost: 30 as any,
    security: mockSecurityXIC as any,
  };

  // -- Mock user preference --
  const mockPref: Partial<UserPreference> = {
    userId,
    defaultCurrency: "CAD",
  };

  beforeEach(async () => {
    holdingsRepository = {
      find: jest.fn(),
    };

    securityPriceRepository = {
      query: jest.fn(),
    };

    accountsRepository = {
      find: jest.fn(),
    };

    prefRepository = {
      findOne: jest.fn(),
    };

    exchangeRateService = {
      getLatestRate: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioService,
        {
          provide: getRepositoryToken(Holding),
          useValue: holdingsRepository,
        },
        {
          provide: getRepositoryToken(SecurityPrice),
          useValue: securityPriceRepository,
        },
        {
          provide: getRepositoryToken(Account),
          useValue: accountsRepository,
        },
        {
          provide: getRepositoryToken(UserPreference),
          useValue: prefRepository,
        },
        {
          provide: ExchangeRateService,
          useValue: exchangeRateService,
        },
      ],
    }).compile();

    service = module.get<PortfolioService>(PortfolioService);
  });

  describe("getLatestPrices", () => {
    it("returns an empty map when securityIds is empty", async () => {
      const result = await service.getLatestPrices([]);

      expect(result).toEqual(new Map());
      expect(securityPriceRepository.query).not.toHaveBeenCalled();
    });

    it("returns a map of securityId to close price", async () => {
      securityPriceRepository.query.mockResolvedValue([
        { security_id: "sec-1", close_price: "175.50", price_date: "2026-02-07" },
        { security_id: "sec-2", close_price: "95.25", price_date: "2026-02-07" },
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
          { security_id: "sec-1", close_price: "175", price_date: "2026-02-07" },
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
        // First call: fetch requested accounts
        accountsRepository.find
          .mockResolvedValueOnce([mockBrokerageAccount])
          // Second call: fetch linked accounts that weren't in the original request
          .mockResolvedValueOnce([mockCashAccount]);
        holdingsRepository.find.mockResolvedValue([]);
        securityPriceRepository.query.mockResolvedValue([]);

        await service.getPortfolioSummary(userId, ["acct-brokerage-1"]);

        // Should have made 2 find calls: initial + linked
        expect(accountsRepository.find).toHaveBeenCalledTimes(2);
        expect(accountsRepository.find).toHaveBeenNthCalledWith(1, {
          where: {
            id: expect.anything(),
            userId,
          },
        });
      });

      it("does not fetch linked accounts if all are already included", async () => {
        accountsRepository.find.mockResolvedValueOnce([
          mockBrokerageAccount,
          mockCashAccount,
        ]);
        holdingsRepository.find.mockResolvedValue([]);
        securityPriceRepository.query.mockResolvedValue([]);

        await service.getPortfolioSummary(userId, [
          "acct-brokerage-1",
          "acct-cash-1",
        ]);

        // Only the initial find call - no second fetch for linked
        expect(accountsRepository.find).toHaveBeenCalledTimes(1);
      });
    });

    describe("when user has no preferences", () => {
      it("defaults to CAD as the default currency", async () => {
        prefRepository.findOne.mockResolvedValue(null);
        accountsRepository.find.mockResolvedValue([]);
        holdingsRepository.find.mockResolvedValue([]);
        securityPriceRepository.query.mockResolvedValue([]);

        const result = await service.getPortfolioSummary(userId);

        // Should still succeed with defaults
        expect(result.totalCashValue).toBe(0);
        expect(result.totalPortfolioValue).toBe(0);
      });
    });

    describe("when holdings have zero quantity", () => {
      it("skips holdings with zero quantity", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([mockBrokerageAccount, mockCashAccount]);
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
    });

    describe("when no prices are available for a security", () => {
      it("sets marketValue, gainLoss, gainLossPercent to null", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([mockBrokerageAccount, mockCashAccount]);
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
      it("sets gainLoss and gainLossPercent to null", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([mockBrokerageAccount, mockCashAccount]);
        holdingsRepository.find.mockResolvedValue([
          { ...mockHoldingAAPL, averageCost: 0 },
        ]);
        securityPriceRepository.query.mockResolvedValue([
          { security_id: "sec-1", close_price: "175", price_date: "2026-02-07" },
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
        // costBasis is 0, so gainLoss should be null
        expect(result.holdings[0].gainLoss).toBeNull();
        expect(result.holdings[0].gainLossPercent).toBeNull();
      });
    });

    describe("when holding has null averageCost", () => {
      it("treats averageCost as 0", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([mockBrokerageAccount, mockCashAccount]);
        holdingsRepository.find.mockResolvedValue([
          { ...mockHoldingAAPL, averageCost: null },
        ]);
        securityPriceRepository.query.mockResolvedValue([
          { security_id: "sec-1", close_price: "175", price_date: "2026-02-07" },
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
        accountsRepository.find.mockResolvedValue([mockBrokerageAccount, mockCashAccount]);
        holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);
        securityPriceRepository.query.mockResolvedValue([
          { security_id: "sec-1", close_price: "175", price_date: "2026-02-07" },
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

      it("uses rate of 1 when neither direct nor reverse rate available", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([mockBrokerageAccount, mockCashAccount]);
        holdingsRepository.find.mockResolvedValue([mockHoldingAAPL]);
        securityPriceRepository.query.mockResolvedValue([
          { security_id: "sec-1", close_price: "175", price_date: "2026-02-07" },
        ]);
        // No rates available at all
        exchangeRateService.getLatestRate.mockResolvedValue(null);

        const result = await service.getPortfolioSummary(userId);

        // Falls back to rate of 1, so USD values treated as-is
        expect(result.totalHoldingsValue).toBe(10 * 175);
      });

      it("caches exchange rates for repeated conversions", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([mockBrokerageAccount, mockCashAccount]);
        // Two holdings in USD - should only look up USD->CAD once
        const secondUSDHolding = {
          ...mockHoldingVFV,
          id: "hold-usd-2",
          securityId: "sec-usd-2",
          security: { ...mockSecurityAAPL, id: "sec-usd-2", symbol: "MSFT", name: "Microsoft" },
        };
        holdingsRepository.find.mockResolvedValue([
          mockHoldingAAPL,
          secondUSDHolding,
        ]);
        securityPriceRepository.query.mockResolvedValue([
          { security_id: "sec-1", close_price: "175", price_date: "2026-02-07" },
          { security_id: "sec-usd-2", close_price: "400", price_date: "2026-02-07" },
        ]);
        exchangeRateService.getLatestRate.mockImplementation(
          (from: string, to: string) => {
            if (from === "USD" && to === "CAD") return Promise.resolve(1.35);
            return Promise.resolve(null);
          },
        );

        await service.getPortfolioSummary(userId);

        // getLatestRate for USD->CAD should be called only once due to caching
        const usdToCadCalls = exchangeRateService.getLatestRate.mock.calls.filter(
          ([from, to]: [string, string]) => from === "USD" && to === "CAD",
        );
        expect(usdToCadCalls).toHaveLength(1);
      });

      it("does not convert when holding currency matches default", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([mockBrokerageAccount, mockCashAccount]);
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
        expect(result.totalPortfolioValue).toBe(0);
        expect(result.totalGainLoss).toBe(0);
        expect(result.totalGainLossPercent).toBe(0);
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
          { security_id: "sec-2", close_price: "100", price_date: "2026-02-07" },
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
          { security_id: "sec-2", close_price: "100", price_date: "2026-02-07" },
        ]);
        exchangeRateService.getLatestRate.mockResolvedValue(null);

        const result = await service.getPortfolioSummary(userId);

        const cashAlloc = result.allocation.find((a) => a.type === "cash");
        expect(cashAlloc).toBeUndefined();
      });

      it("does not include securities with zero or null market value", async () => {
        prefRepository.findOne.mockResolvedValue(mockPref);
        accountsRepository.find.mockResolvedValue([mockBrokerageAccount, mockCashAccount]);
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
        accountsRepository.find.mockResolvedValue([mockBrokerageAccount, mockCashAccount]);

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

  describe("getTopMovers", () => {
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
          { security_id: "sec-1", close_price: "180", rn: "1" },
          { security_id: "sec-1", close_price: "175", rn: "2" },
          // VFV: current=90, previous=95 => -5.26%
          { security_id: "sec-2", close_price: "90", rn: "1" },
          { security_id: "sec-2", close_price: "95", rn: "2" },
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
          { security_id: "sec-1", close_price: "180", rn: "1" },
          { security_id: "sec-1", close_price: "175", rn: "2" },
          { security_id: "sec-2", close_price: "90", rn: "1" },
          { security_id: "sec-2", close_price: "95", rn: "2" },
        ]);

        const result = await service.getTopMovers(userId);

        const aaplMover = result.find((m) => m.symbol === "AAPL");
        expect(aaplMover!.marketValue).toBe(180 * 10); // currentPrice * quantity
        expect(aaplMover!.currentPrice).toBe(180);
        expect(aaplMover!.previousPrice).toBe(175);
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
          { security_id: "sec-2", close_price: "90", rn: "1" },
          { security_id: "sec-2", close_price: "95", rn: "2" },
        ]);

        const result = await service.getTopMovers(userId);

        expect(result).toHaveLength(1);
        expect(result[0].symbol).toBe("VFV.TO");
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
          { security_id: "sec-1", close_price: "180", rn: "1" },
          // Two prices for VFV
          { security_id: "sec-2", close_price: "90", rn: "1" },
          { security_id: "sec-2", close_price: "95", rn: "2" },
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
          { security_id: "sec-1", close_price: "180", rn: "1" },
          { security_id: "sec-1", close_price: "0", rn: "2" },
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
          { security_id: "sec-2", close_price: "100", rn: "1" },
          { security_id: "sec-2", close_price: "95", rn: "2" },
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
          { security_id: "sec-1", close_price: "180", rn: "1" },
          { security_id: "sec-1", close_price: "175", rn: "2" },
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
          { security_id: "sec-3", close_price: "36", rn: "1" },
          { security_id: "sec-3", close_price: "35", rn: "2" },
        ]);

        const result = await service.getTopMovers(userId);

        expect(result).toHaveLength(1);
        expect(result[0].symbol).toBe("XIC.TO");
        expect(result[0].dailyChange).toBeCloseTo(1, 0);
        expect(result[0].marketValue).toBe(36 * 100);
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
});
