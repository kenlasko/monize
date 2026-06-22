import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { SectorWeightingService } from "./sector-weighting.service";
import { Security } from "./entities/security.entity";
import { Holding } from "./entities/holding.entity";
import { Account } from "../accounts/entities/account.entity";
import { SecurityPrice } from "./entities/security-price.entity";
import { YahooFinanceService } from "./yahoo-finance.service";
import { PortfolioCalculationService } from "./portfolio-calculation.service";

describe("SectorWeightingService", () => {
  let service: SectorWeightingService;
  let securityRepo: Record<string, jest.Mock>;
  let holdingsRepo: Record<string, jest.Mock>;
  let accountsRepo: Record<string, jest.Mock>;
  let priceRepo: Record<string, jest.Mock>;
  let yahooService: Record<string, jest.Mock>;
  let calcService: Record<string, jest.Mock>;

  const mockStockSecurity: Partial<Security> = {
    id: "sec-stock-1",
    userId: "user-1",
    symbol: "AAPL",
    name: "Apple Inc.",
    securityType: "STOCK",
    exchange: "NASDAQ",
    currencyCode: "USD",
    skipPriceUpdates: false,
    sector: "Technology",
    industry: "Consumer Electronics",
    sectorWeightings: null,
    sectorDataUpdatedAt: new Date(),
  };

  const mockEtfSecurity: Partial<Security> = {
    id: "sec-etf-1",
    userId: "user-1",
    symbol: "VTI",
    name: "Vanguard Total Stock Market",
    securityType: "ETF",
    exchange: "NASDAQ",
    currencyCode: "USD",
    skipPriceUpdates: false,
    sector: null,
    industry: null,
    sectorWeightings: [
      { sector: "Technology", weight: 0.3 },
      { sector: "Healthcare", weight: 0.15 },
    ],
    sectorDataUpdatedAt: new Date(),
  };

  const mockNoSectorSecurity: Partial<Security> = {
    id: "sec-none-1",
    userId: "user-1",
    symbol: "UNKNOWN",
    name: "Unknown Security",
    securityType: "STOCK",
    exchange: null,
    currencyCode: "USD",
    skipPriceUpdates: false,
    sector: null,
    industry: null,
    sectorWeightings: null,
    sectorDataUpdatedAt: new Date(),
  };

  beforeEach(async () => {
    securityRepo = {
      save: jest.fn().mockResolvedValue(undefined),
    };
    holdingsRepo = {
      find: jest.fn().mockResolvedValue([]),
    };
    accountsRepo = {
      find: jest.fn().mockResolvedValue([]),
    };
    priceRepo = {
      query: jest.fn().mockResolvedValue([]),
    };
    yahooService = {
      fetchStockSectorInfo: jest.fn().mockResolvedValue(null),
      fetchEtfSectorWeightings: jest.fn().mockResolvedValue(null),
      getYahooSymbol: jest.fn().mockImplementation((sym) => sym),
    };
    calcService = {
      categoriseAccounts: jest.fn().mockReturnValue({
        cashAccounts: [],
        brokerageAccounts: [],
        standaloneAccounts: [],
        holdingsAccountIds: [],
      }),
      convertToDefault: jest
        .fn()
        .mockImplementation((amount) => Promise.resolve(amount)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SectorWeightingService,
        { provide: getRepositoryToken(Security), useValue: securityRepo },
        { provide: getRepositoryToken(Holding), useValue: holdingsRepo },
        { provide: getRepositoryToken(Account), useValue: accountsRepo },
        {
          provide: getRepositoryToken(SecurityPrice),
          useValue: priceRepo,
        },
        { provide: YahooFinanceService, useValue: yahooService },
        {
          provide: PortfolioCalculationService,
          useValue: calcService,
        },
      ],
    }).compile();

    service = module.get<SectorWeightingService>(SectorWeightingService);
  });

  describe("ensureSectorData", () => {
    it("fetches sector info for stocks missing sector data", async () => {
      const sec = {
        ...mockStockSecurity,
        sector: null,
        sectorDataUpdatedAt: null,
      } as Security;
      yahooService.fetchStockSectorInfo.mockResolvedValue({
        sector: "Technology",
        industry: "Consumer Electronics",
      });

      await service.ensureSectorData([sec]);

      expect(yahooService.fetchStockSectorInfo).toHaveBeenCalled();
      expect(sec.sector).toBe("Technology");
      expect(sec.industry).toBe("Consumer Electronics");
      expect(securityRepo.save).toHaveBeenCalledWith([sec]);
    });

    it("fetches ETF weightings for ETFs missing sector_weightings", async () => {
      const sec = {
        ...mockEtfSecurity,
        sectorWeightings: null,
        sectorDataUpdatedAt: null,
      } as Security;
      yahooService.fetchEtfSectorWeightings.mockResolvedValue([
        { sector: "Technology", weight: 0.3 },
      ]);

      await service.ensureSectorData([sec]);

      expect(yahooService.fetchEtfSectorWeightings).toHaveBeenCalled();
      expect(sec.sectorWeightings).toEqual([
        { sector: "Technology", weight: 0.3 },
      ]);
      expect(securityRepo.save).toHaveBeenCalledWith([sec]);
    });

    it("skips securities with skipPriceUpdates = true", async () => {
      const sec = {
        ...mockStockSecurity,
        sector: null,
        skipPriceUpdates: true,
        sectorDataUpdatedAt: null,
      } as Security;

      await service.ensureSectorData([sec]);

      expect(yahooService.fetchStockSectorInfo).not.toHaveBeenCalled();
      expect(securityRepo.save).not.toHaveBeenCalled();
    });

    it("skips securities with fresh sectorDataUpdatedAt", async () => {
      const sec = {
        ...mockStockSecurity,
        sector: "Technology",
        sectorDataUpdatedAt: new Date(), // fresh
      } as Security;

      await service.ensureSectorData([sec]);

      expect(yahooService.fetchStockSectorInfo).not.toHaveBeenCalled();
      expect(securityRepo.save).not.toHaveBeenCalled();
    });

    it("re-fetches when sectorDataUpdatedAt is stale", async () => {
      const staleDate = new Date();
      staleDate.setDate(staleDate.getDate() - 10); // 10 days ago
      const sec = {
        ...mockStockSecurity,
        sector: "Technology",
        sectorDataUpdatedAt: staleDate,
      } as Security;
      yahooService.fetchStockSectorInfo.mockResolvedValue({
        sector: "Technology",
        industry: "Consumer Electronics",
      });

      await service.ensureSectorData([sec]);

      expect(yahooService.fetchStockSectorInfo).toHaveBeenCalled();
      expect(securityRepo.save).toHaveBeenCalled();
    });

    it("handles Yahoo API returning null gracefully", async () => {
      const sec = {
        ...mockStockSecurity,
        sector: null,
        sectorDataUpdatedAt: null,
      } as Security;
      yahooService.fetchStockSectorInfo.mockResolvedValue(null);

      await service.ensureSectorData([sec]);

      expect(sec.sector).toBeNull();
      expect(securityRepo.save).toHaveBeenCalledWith([sec]);
    });
  });

  describe("getSectorWeightings", () => {
    it("returns empty items when user has no holdings", async () => {
      accountsRepo.find.mockResolvedValue([]);
      calcService.categoriseAccounts.mockReturnValue({
        cashAccounts: [],
        brokerageAccounts: [],
        standaloneAccounts: [],
        holdingsAccountIds: [],
      });

      const result = await service.getSectorWeightings("user-1");

      expect(result.items).toEqual([]);
      expect(result.totalPortfolioValue).toBe(0);
    });

    it("calculates stock sector exposure correctly", async () => {
      const account = {
        id: "acct-1",
        userId: "user-1",
        accountType: "INVESTMENT",
        currencyCode: "USD",
      };
      accountsRepo.find.mockResolvedValue([account]);
      calcService.categoriseAccounts.mockReturnValue({
        cashAccounts: [],
        brokerageAccounts: [],
        standaloneAccounts: [account],
        holdingsAccountIds: ["acct-1"],
      });

      holdingsRepo.find.mockResolvedValue([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-stock-1",
          quantity: 100,
          security: mockStockSecurity,
        },
      ]);

      priceRepo.query.mockResolvedValue([
        { security_id: "sec-stock-1", close_price: "180" },
      ]);

      const result = await service.getSectorWeightings("user-1");

      // 100 shares × $180 = $18,000 all in Technology
      expect(result.items).toHaveLength(1);
      expect(result.items[0].sector).toBe("Technology");
      expect(result.items[0].directValue).toBe(18000);
      expect(result.items[0].etfValue).toBe(0);
      expect(result.items[0].totalValue).toBe(18000);
    });

    it("distributes ETF value across sectors", async () => {
      const account = {
        id: "acct-1",
        userId: "user-1",
        accountType: "INVESTMENT",
        currencyCode: "USD",
      };
      accountsRepo.find.mockResolvedValue([account]);
      calcService.categoriseAccounts.mockReturnValue({
        cashAccounts: [],
        brokerageAccounts: [],
        standaloneAccounts: [account],
        holdingsAccountIds: ["acct-1"],
      });

      holdingsRepo.find.mockResolvedValue([
        {
          id: "h2",
          accountId: "acct-1",
          securityId: "sec-etf-1",
          quantity: 50,
          security: mockEtfSecurity,
        },
      ]);

      priceRepo.query.mockResolvedValue([
        { security_id: "sec-etf-1", close_price: "250" },
      ]);

      const result = await service.getSectorWeightings("user-1");

      // 50 × $250 = $12,500. Tech = 12500 × 0.3 = 3750, Healthcare = 12500 × 0.15 = 1875
      const techItem = result.items.find((i) => i.sector === "Technology");
      const healthItem = result.items.find((i) => i.sector === "Healthcare");
      expect(techItem!.etfValue).toBe(3750);
      expect(healthItem!.etfValue).toBe(1875);
    });

    it("merges stock + ETF contributions to same sector", async () => {
      const account = {
        id: "acct-1",
        userId: "user-1",
        accountType: "INVESTMENT",
        currencyCode: "USD",
      };
      accountsRepo.find.mockResolvedValue([account]);
      calcService.categoriseAccounts.mockReturnValue({
        cashAccounts: [],
        brokerageAccounts: [],
        standaloneAccounts: [account],
        holdingsAccountIds: ["acct-1"],
      });

      holdingsRepo.find.mockResolvedValue([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-stock-1",
          quantity: 100,
          security: mockStockSecurity,
        },
        {
          id: "h2",
          accountId: "acct-1",
          securityId: "sec-etf-1",
          quantity: 50,
          security: mockEtfSecurity,
        },
      ]);

      priceRepo.query.mockResolvedValue([
        { security_id: "sec-stock-1", close_price: "180" },
        { security_id: "sec-etf-1", close_price: "250" },
      ]);

      const result = await service.getSectorWeightings("user-1");

      const techItem = result.items.find((i) => i.sector === "Technology");
      // Stock: 100 × 180 = 18000, ETF: 50 × 250 × 0.3 = 3750
      expect(techItem!.directValue).toBe(18000);
      expect(techItem!.etfValue).toBe(3750);
      expect(techItem!.totalValue).toBe(21750);
    });

    it("computes percentages correctly", async () => {
      const account = {
        id: "acct-1",
        userId: "user-1",
        accountType: "INVESTMENT",
        currencyCode: "USD",
      };
      accountsRepo.find.mockResolvedValue([account]);
      calcService.categoriseAccounts.mockReturnValue({
        cashAccounts: [],
        brokerageAccounts: [],
        standaloneAccounts: [account],
        holdingsAccountIds: ["acct-1"],
      });

      holdingsRepo.find.mockResolvedValue([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-stock-1",
          quantity: 100,
          security: mockStockSecurity,
        },
      ]);

      priceRepo.query.mockResolvedValue([
        { security_id: "sec-stock-1", close_price: "180" },
      ]);

      const result = await service.getSectorWeightings("user-1");

      expect(result.items[0].percentage).toBe(100);
    });

    it("sorts items by totalValue descending", async () => {
      const account = {
        id: "acct-1",
        userId: "user-1",
        accountType: "INVESTMENT",
        currencyCode: "USD",
      };
      accountsRepo.find.mockResolvedValue([account]);
      calcService.categoriseAccounts.mockReturnValue({
        cashAccounts: [],
        brokerageAccounts: [],
        standaloneAccounts: [account],
        holdingsAccountIds: ["acct-1"],
      });

      holdingsRepo.find.mockResolvedValue([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-stock-1",
          quantity: 100,
          security: mockStockSecurity,
        },
        {
          id: "h2",
          accountId: "acct-1",
          securityId: "sec-etf-1",
          quantity: 50,
          security: mockEtfSecurity,
        },
      ]);

      priceRepo.query.mockResolvedValue([
        { security_id: "sec-stock-1", close_price: "180" },
        { security_id: "sec-etf-1", close_price: "250" },
      ]);

      const result = await service.getSectorWeightings("user-1");

      // Items should be sorted descending by totalValue
      for (let i = 1; i < result.items.length; i++) {
        expect(result.items[i - 1].totalValue).toBeGreaterThanOrEqual(
          result.items[i].totalValue,
        );
      }
    });

    it("tracks unclassified value for securities without sector data", async () => {
      const account = {
        id: "acct-1",
        userId: "user-1",
        accountType: "INVESTMENT",
        currencyCode: "USD",
      };
      accountsRepo.find.mockResolvedValue([account]);
      calcService.categoriseAccounts.mockReturnValue({
        cashAccounts: [],
        brokerageAccounts: [],
        standaloneAccounts: [account],
        holdingsAccountIds: ["acct-1"],
      });

      holdingsRepo.find.mockResolvedValue([
        {
          id: "h3",
          accountId: "acct-1",
          securityId: "sec-none-1",
          quantity: 10,
          security: mockNoSectorSecurity,
        },
      ]);

      priceRepo.query.mockResolvedValue([
        { security_id: "sec-none-1", close_price: "50" },
      ]);

      const result = await service.getSectorWeightings("user-1");

      expect(result.unclassifiedValue).toBe(500);
      expect(result.items).toHaveLength(0);
    });

    it("filters by accountIds when provided", async () => {
      accountsRepo.find.mockResolvedValue([]);
      calcService.categoriseAccounts.mockReturnValue({
        cashAccounts: [],
        brokerageAccounts: [],
        standaloneAccounts: [],
        holdingsAccountIds: [],
      });

      await service.getSectorWeightings("user-1", ["acct-specific"]);

      expect(accountsRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: expect.anything(),
          }),
        }),
      );
    });

    it("filters by securityIds when provided", async () => {
      const account = {
        id: "acct-1",
        userId: "user-1",
        accountType: "INVESTMENT",
        currencyCode: "USD",
      };
      accountsRepo.find.mockResolvedValue([account]);
      calcService.categoriseAccounts.mockReturnValue({
        cashAccounts: [],
        brokerageAccounts: [],
        standaloneAccounts: [account],
        holdingsAccountIds: ["acct-1"],
      });

      holdingsRepo.find.mockResolvedValue([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-stock-1",
          quantity: 100,
          security: mockStockSecurity,
        },
        {
          id: "h2",
          accountId: "acct-1",
          securityId: "sec-etf-1",
          quantity: 50,
          security: mockEtfSecurity,
        },
      ]);

      priceRepo.query.mockResolvedValue([
        { security_id: "sec-stock-1", close_price: "180" },
      ]);

      // Only include the stock, not the ETF
      const result = await service.getSectorWeightings("user-1", undefined, [
        "sec-stock-1",
      ]);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].sector).toBe("Technology");
      expect(result.totalEtfValue).toBe(0);
    });
  });

  describe("ensureSectorDataByIds", () => {
    it("loads securities by IDs and delegates to ensureSectorData", async () => {
      const securities = [
        { ...mockStockSecurity, sector: null, sectorDataUpdatedAt: null },
      ];
      securityRepo.find = jest.fn().mockResolvedValue(securities);
      yahooService.fetchStockSectorInfo.mockResolvedValue({
        sector: "Technology",
        industry: "Consumer Electronics",
      });

      await service.ensureSectorDataByIds(["sec-stock-1"]);

      expect(securityRepo.find).toHaveBeenCalledWith({
        where: { id: expect.anything() },
      });
      expect(yahooService.fetchStockSectorInfo).toHaveBeenCalled();
      expect(securityRepo.save).toHaveBeenCalled();
    });

    it("does nothing for empty securityIds array", async () => {
      securityRepo.find = jest.fn();

      await service.ensureSectorDataByIds([]);

      expect(securityRepo.find).not.toHaveBeenCalled();
    });
  });

  describe("getCountryWeightings", () => {
    const account = {
      id: "acct-1",
      userId: "user-1",
      accountType: "INVESTMENT",
      currencyCode: "USD",
    };

    function withAccount() {
      accountsRepo.find.mockResolvedValue([account]);
      calcService.categoriseAccounts.mockReturnValue({
        cashAccounts: [],
        brokerageAccounts: [],
        standaloneAccounts: [account],
        holdingsAccountIds: ["acct-1"],
      });
    }

    it("splits ETF value across countries and routes the remainder to Other", async () => {
      withAccount();
      holdingsRepo.find.mockResolvedValue([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-etf-1",
          quantity: 10,
          security: {
            ...mockEtfSecurity,
            countryWeightings: [
              { name: "United States", weight: 0.6 },
              { name: "Canada", weight: 0.3 },
            ],
          },
        },
      ]);
      priceRepo.query.mockResolvedValue([
        { security_id: "sec-etf-1", close_price: "100" },
      ]);

      const result = await service.getCountryWeightings("user-1");

      // 10 × $100 = $1,000: US 600, Canada 300, Other 100.
      const us = result.items.find((i) => i.country === "United States");
      const ca = result.items.find((i) => i.country === "Canada");
      expect(us?.etfValue).toBe(600);
      expect(ca?.etfValue).toBe(300);
      expect(result.unclassifiedValue).toBe(100);
      expect(result.totalPortfolioValue).toBe(1000);
    });

    it("places individual stocks by their listing exchange", async () => {
      withAccount();
      holdingsRepo.find.mockResolvedValue([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-stock-1",
          quantity: 100,
          security: mockStockSecurity, // NASDAQ -> United States
        },
      ]);
      priceRepo.query.mockResolvedValue([
        { security_id: "sec-stock-1", close_price: "180" },
      ]);

      const result = await service.getCountryWeightings("user-1");

      const us = result.items.find((i) => i.country === "United States");
      expect(us?.directValue).toBe(18000);
      expect(result.unclassifiedValue).toBe(0);
    });

    it("treats an ETF with no country weightings as fully Other", async () => {
      withAccount();
      holdingsRepo.find.mockResolvedValue([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-etf-1",
          quantity: 5,
          security: { ...mockEtfSecurity, countryWeightings: null },
        },
      ]);
      priceRepo.query.mockResolvedValue([
        { security_id: "sec-etf-1", close_price: "100" },
      ]);

      const result = await service.getCountryWeightings("user-1");

      expect(result.items).toEqual([]);
      expect(result.unclassifiedValue).toBe(500);
    });
  });
});
