import { SectorWeightingService } from "./sector-weighting.service";
import { Security } from "./entities/security.entity";
import { Holding } from "./entities/holding.entity";
import { Account } from "../accounts/entities/account.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  createScopedDbMocks,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("SectorWeightingService", () => {
  let service: SectorWeightingService;
  let securityRepo: Record<string, jest.Mock>;
  let holdingsRepo: Record<string, jest.Mock>;
  let accountsRepo: Record<string, jest.Mock>;
  let prefsRepo: Record<string, jest.Mock>;
  let manager: ManagerMock;
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

  beforeEach(() => {
    securityRepo = {
      save: jest.fn().mockResolvedValue(undefined),
    };
    holdingsRepo = {
      find: jest.fn().mockResolvedValue([]),
    };
    accountsRepo = {
      find: jest.fn().mockResolvedValue([]),
    };
    prefsRepo = {
      findOne: jest.fn().mockResolvedValue(null),
    };
    yahooService = {
      fetchStockSectorInfo: jest.fn().mockResolvedValue(null),
      fetchEtfBreakdowns: jest
        .fn()
        .mockResolvedValue({ sectors: null, assets: null }),
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
      valueBondHoldings: jest.fn().mockResolvedValue(new Map()),
    };

    const { manager: managerMock, dataSource } = createScopedDbMocks([
      [Security, securityRepo],
      [Holding, holdingsRepo],
      [Account, accountsRepo],
      [UserPreference, prefsRepo],
    ]);
    manager = managerMock;
    manager.query.mockResolvedValue([]);

    service = new SectorWeightingService(
      dataSource as never,
      yahooService as never,
      calcService as never,
    );
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

    it("fills a fund's asset-class split from the provider", async () => {
      // The GEM report compares its defensive roles on exactly this breakdown,
      // and Yahoo has always returned it -- it was only ever read for prose.
      const sec = {
        ...mockEtfSecurity,
        sectorWeightings: null,
        assetWeightings: null,
        sectorDataUpdatedAt: null,
      } as Security;
      yahooService.fetchEtfBreakdowns.mockResolvedValue({
        sectors: [{ sector: "Technology", weight: 0.3 }],
        assets: [{ name: "Bonds", weight: 0.98 }],
      });

      await service.ensureSectorData([sec]);

      expect(sec.assetWeightings).toEqual([{ name: "Bonds", weight: 0.98 }]);
      // Both breakdowns come out of one response, so one request fills both.
      expect(yahooService.fetchEtfBreakdowns).toHaveBeenCalledTimes(1);
      expect(sec.sectorWeightings).toEqual([
        { sector: "Technology", weight: 0.3 },
      ]);
    });

    it("never overwrites an asset-class split the user recorded", async () => {
      // The column is the allocation editor's; a fetched value is a
      // convenience for undescribed funds, not an authority over the owner.
      const own = [{ name: "Bonds", weight: 1 }];
      const sec = {
        ...mockEtfSecurity,
        sectorWeightings: null,
        assetWeightings: own,
        sectorDataUpdatedAt: null,
      } as Security;
      yahooService.fetchEtfBreakdowns.mockResolvedValue({
        sectors: [{ sector: "Technology", weight: 0.3 }],
        assets: [{ name: "Stocks", weight: 1 }],
      });

      await service.ensureSectorData([sec]);

      expect(sec.assetWeightings).toBe(own);
      // The request still happens -- the sector half is wanted -- but the
      // provider's asset split is discarded rather than replacing the user's.
      expect(sec.sectorWeightings).toEqual([
        { sector: "Technology", weight: 0.3 },
      ]);
    });

    it("fetches ETF weightings for ETFs missing sector_weightings", async () => {
      const sec = {
        ...mockEtfSecurity,
        sectorWeightings: null,
        sectorDataUpdatedAt: null,
      } as Security;
      yahooService.fetchEtfBreakdowns.mockResolvedValue({
        sectors: [{ sector: "Technology", weight: 0.3 }],
        assets: null,
      });

      await service.ensureSectorData([sec]);

      expect(yahooService.fetchEtfBreakdowns).toHaveBeenCalled();
      expect(sec.sectorWeightings).toEqual([
        { sector: "Technology", weight: 0.3 },
      ]);
      expect(securityRepo.save).toHaveBeenCalledWith([sec]);
    });

    /**
     * The provider distinguishes a failed request (`null`) from a fund with
     * nothing to report (`[]`), and only the second is knowledge. Stamping
     * freshness on a failure hid the fund behind an up-to-date-looking row for
     * a week, so a transient outage became missing asset-class data with no
     * way back until the timestamp aged out.
     */
    it("leaves a failed ETF fetch stale and retryable", async () => {
      const sec = {
        ...mockEtfSecurity,
        sectorWeightings: null,
        assetWeightings: null,
        sectorDataUpdatedAt: null,
      } as Security;
      yahooService.fetchEtfBreakdowns.mockResolvedValue({
        sectors: null,
        assets: null,
      });

      await service.ensureSectorData([sec]);

      expect(sec.sectorDataUpdatedAt).toBeNull();
      expect(securityRepo.save).not.toHaveBeenCalled();
      // Nothing was learned, so nothing was written over either.
      expect(sec.sectorWeightings).toBeNull();
      expect(sec.assetWeightings).toBeNull();
    });

    it("counts an empty but successful response as fresh", async () => {
      // The fund was described; it simply has no breakdown. Re-asking every
      // sweep would not change that.
      const sec = {
        ...mockEtfSecurity,
        sectorWeightings: null,
        assetWeightings: null,
        sectorDataUpdatedAt: null,
      } as Security;
      yahooService.fetchEtfBreakdowns.mockResolvedValue({
        sectors: [],
        assets: [],
      });

      await service.ensureSectorData([sec]);

      expect(sec.sectorDataUpdatedAt).toBeInstanceOf(Date);
      expect(securityRepo.save).toHaveBeenCalledWith([sec]);
    });

    it("keeps the half that arrived and counts the fetch as fresh", async () => {
      const sec = {
        ...mockEtfSecurity,
        sectorWeightings: null,
        assetWeightings: null,
        sectorDataUpdatedAt: null,
      } as Security;
      yahooService.fetchEtfBreakdowns.mockResolvedValue({
        sectors: null,
        assets: [{ name: "Bonds", weight: 1 }],
      });

      await service.ensureSectorData([sec]);

      expect(sec.assetWeightings).toEqual([{ name: "Bonds", weight: 1 }]);
      expect(sec.sectorDataUpdatedAt).toBeInstanceOf(Date);
    });

    it("leaves a failed refresh of stale data exactly as stale", async () => {
      const stale = new Date("2024-01-01T00:00:00Z");
      const sec = {
        ...mockEtfSecurity,
        sectorWeightings: [{ sector: "Technology", weight: 0.3 }],
        assetWeightings: null,
        sectorDataUpdatedAt: stale,
      } as unknown as Security;
      yahooService.fetchEtfBreakdowns.mockResolvedValue({
        sectors: null,
        assets: null,
      });

      await service.ensureSectorData([sec]);

      expect(sec.sectorDataUpdatedAt).toBe(stale);
      expect(securityRepo.save).not.toHaveBeenCalled();
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

      manager.query.mockResolvedValue([
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

    it("converts into the user's reporting currency, not the first account's", async () => {
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
      manager.query.mockResolvedValue([
        { security_id: "sec-stock-1", close_price: "100" },
      ]);
      prefsRepo.findOne.mockResolvedValue({ defaultCurrency: "EUR" });
      // USD -> EUR at 2: 10,000 USD is 20,000 EUR.
      calcService.convertToDefault.mockImplementation(
        (amount: number, from: string, to: string) =>
          Promise.resolve(from === "USD" && to === "EUR" ? amount * 2 : amount),
      );

      const result = await service.getSectorWeightings("user-1");

      expect(calcService.convertToDefault).toHaveBeenCalledWith(
        10000,
        "USD",
        "EUR",
        expect.anything(),
      );
      expect(result.totalPortfolioValue).toBe(20000);
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

      manager.query.mockResolvedValue([
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

      manager.query.mockResolvedValue([
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

      manager.query.mockResolvedValue([
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

      manager.query.mockResolvedValue([
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

      manager.query.mockResolvedValue([
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

      manager.query.mockResolvedValue([
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

  describe("a bond-linked holding is its own account's lots", () => {
    const accounts = ["acct-ike", "acct-reg"].map((id) => ({
      id,
      userId: "user-1",
      accountType: "INVESTMENT",
      currencyCode: "USD",
    }));
    const bond: Partial<Security> = {
      ...mockNoSectorSecurity,
      id: "sec-bond",
      securityType: "BOND",
      bondProgramId: "prog-1",
    };
    const heldIn = (accountId: string) => ({
      id: `h-${accountId}`,
      accountId,
      securityId: "sec-bond",
      quantity: 10,
      security: bond,
    });

    beforeEach(() => {
      accountsRepo.find.mockResolvedValue(accounts);
      calcService.categoriseAccounts.mockReturnValue({
        cashAccounts: [],
        brokerageAccounts: [],
        standaloneAccounts: accounts,
        holdingsAccountIds: accounts.map((a) => a.id),
      });
      holdingsRepo.find.mockResolvedValue(accounts.map((a) => heldIn(a.id)));
      // The blend (117.74) a quantity x price reading would use.
      manager.query.mockResolvedValue([
        { security_id: "sec-bond", close_price: "117.74" },
      ]);
    });

    it("sums each account's own lots, not quantity x the blend", async () => {
      calcService.valueBondHoldings.mockResolvedValue(
        new Map([
          ["acct-ike:sec-bond", { marketValue: 1354, unitPrice: 135.4 }],
          ["acct-reg:sec-bond", { marketValue: 1000.8, unitPrice: 100.08 }],
        ]),
      );

      const result = await service.getSectorWeightings("user-1");

      expect(result.unclassifiedValue).toBeCloseTo(2354.8, 6);
    });

    it("hands the price map to the bond valuation, so a traded series is the person's price", async () => {
      calcService.valueBondHoldings.mockResolvedValue(new Map());

      await service.getSectorWeightings("user-1");
      await service.getAssetClassWeightings("user-1");

      for (const call of calcService.valueBondHoldings.mock.calls) {
        expect(call[2]).toEqual(new Map([["sec-bond", 117.74]]));
      }
      expect(calcService.valueBondHoldings).toHaveBeenCalledTimes(2);
    });

    it("leaves an unpriced account out and never falls back to the blend", async () => {
      calcService.valueBondHoldings.mockResolvedValue(
        new Map([
          ["acct-ike:sec-bond", null],
          ["acct-reg:sec-bond", { marketValue: 1000.8, unitPrice: 100.08 }],
        ]),
      );

      const result = await service.getAssetClassWeightings("user-1");

      expect(result.totalPortfolioValue).toBeNull();
      expect(result.knownSubtotal).toBeCloseTo(1000.8, 6);
      expect(result.valuationComplete).toBe(false);
    });
  });

  describe("a holding left out withholds the total", () => {
    const account = {
      id: "acct-1",
      userId: "user-1",
      accountType: "INVESTMENT",
      currencyCode: "USD",
    };
    const held = (id: string, symbol: string, currencyCode: string) => ({
      id: `h-${id}`,
      accountId: "acct-1",
      securityId: id,
      quantity: 10,
      security: { ...mockStockSecurity, id, symbol, currencyCode },
    });

    beforeEach(() => {
      accountsRepo.find.mockResolvedValue([account]);
      calcService.categoriseAccounts.mockReturnValue({
        cashAccounts: [],
        brokerageAccounts: [],
        standaloneAccounts: [account],
        holdingsAccountIds: ["acct-1"],
      });
      prefsRepo.findOne.mockResolvedValue({ defaultCurrency: "USD" });
      // sec-ok and sec-jpy are priced; sec-nop has no price row.
      manager.query.mockResolvedValue([
        { security_id: "sec-ok", close_price: "100" },
        { security_id: "sec-jpy", close_price: "5000" },
      ]);
      calcService.convertToDefault.mockImplementation(
        (amount: number, from: string) =>
          Promise.resolve(from === "JPY" ? null : amount),
      );
    });

    it("names the unpriced security and the missing pair, weights over the known part", async () => {
      holdingsRepo.find.mockResolvedValue([
        held("sec-ok", "OK", "USD"),
        held("sec-nop", "NOP", "USD"),
        held("sec-jpy", "JPY1", "JPY"),
      ]);

      const result = await service.getSectorWeightings("user-1");

      expect(result.totalPortfolioValue).toBeNull();
      expect(result.knownSubtotal).toBe(1000);
      expect(result.valuationComplete).toBe(false);
      expect(result.pricesComplete).toBe(false);
      expect(result.fxComplete).toBe(false);
      expect(result.unpricedSecurityIds).toEqual(["sec-nop"]);
      expect(result.unpricedSymbols).toEqual(["NOP"]);
      expect(result.missingRatePairs).toEqual(["JPY->USD"]);
      expect(result.items[0].percentage).toBe(100);
    });

    it("withholds the total on the country and asset-class views too", async () => {
      holdingsRepo.find.mockResolvedValue([
        held("sec-ok", "OK", "USD"),
        held("sec-nop", "NOP", "USD"),
      ]);

      const country = await service.getCountryWeightings("user-1");
      const assetClass = await service.getAssetClassWeightings("user-1");
      const llm = await service.getLlmLookThrough("user-1");

      for (const r of [country, assetClass, llm]) {
        expect(r.totalPortfolioValue).toBeNull();
        expect(r.knownSubtotal).toBe(1000);
        expect(r.valuationComplete).toBe(false);
        expect(r.unpricedSymbols).toEqual(["NOP"]);
      }
      expect(llm.byCountry.items[0].percentage).toBe(100);
    });

    it("keeps the total when every holding is priced and converted", async () => {
      holdingsRepo.find.mockResolvedValue([held("sec-ok", "OK", "USD")]);

      const result = await service.getSectorWeightings("user-1");

      expect(result.totalPortfolioValue).toBe(1000);
      expect(result.knownSubtotal).toBe(1000);
      expect(result.valuationComplete).toBe(true);
      expect(result.unpricedSecurityIds).toEqual([]);
      expect(result.missingRatePairs).toEqual([]);
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
      manager.query.mockResolvedValue([
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
      manager.query.mockResolvedValue([
        { security_id: "sec-stock-1", close_price: "180" },
      ]);

      const result = await service.getCountryWeightings("user-1");

      const us = result.items.find((i) => i.country === "United States");
      expect(us?.directValue).toBe(18000);
      expect(result.unclassifiedValue).toBe(0);
    });

    it("folds a provider 'Other' slice into the unclassified remainder", async () => {
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
              { name: "Other", weight: 0.1 },
            ],
          },
        },
      ]);
      manager.query.mockResolvedValue([
        { security_id: "sec-etf-1", close_price: "100" },
      ]);

      const result = await service.getCountryWeightings("user-1");

      // No "Other" country item; the 0.1 stays in the remainder along with the
      // unallocated 0.3 -> $400 unclassified out of $1,000.
      expect(result.items.find((i) => i.country === "Other")).toBeUndefined();
      const us = result.items.find((i) => i.country === "United States");
      expect(us?.etfValue).toBe(600);
      expect(result.unclassifiedValue).toBe(400);
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
      manager.query.mockResolvedValue([
        { security_id: "sec-etf-1", close_price: "100" },
      ]);

      const result = await service.getCountryWeightings("user-1");

      expect(result.items).toEqual([]);
      expect(result.unclassifiedValue).toBe(500);
    });
  });

  describe("getAssetClassWeightings", () => {
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

    it("splits fund value across asset classes and routes the remainder to Other", async () => {
      withAccount();
      holdingsRepo.find.mockResolvedValue([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-etf-1",
          quantity: 10,
          security: {
            ...mockEtfSecurity,
            assetWeightings: [
              { name: "Equity", weight: 0.6 },
              { name: "Fixed Income", weight: 0.3 },
            ],
          },
        },
      ]);
      manager.query.mockResolvedValue([
        { security_id: "sec-etf-1", close_price: "100" },
      ]);

      const result = await service.getAssetClassWeightings("user-1");

      // 10 x $100 = $1,000: equity 600, fixed income 300, Other 100.
      expect(
        result.items.find((i) => i.assetClassKey === "equity")?.etfValue,
      ).toBe(600);
      expect(
        result.items.find((i) => i.assetClassKey === "fixedIncome")?.etfValue,
      ).toBe(300);
      expect(result.unclassifiedValue).toBe(100);
      expect(result.totalPortfolioValue).toBe(1000);
    });

    it("places a plain stock in Equity by its security type", async () => {
      withAccount();
      holdingsRepo.find.mockResolvedValue([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-stock-1",
          quantity: 100,
          security: mockStockSecurity,
        },
      ]);
      manager.query.mockResolvedValue([
        { security_id: "sec-stock-1", close_price: "180" },
      ]);

      const result = await service.getAssetClassWeightings("user-1");

      expect(result.items).toEqual([
        expect.objectContaining({
          assetClass: "Equities",
          assetClassKey: "equity",
          directValue: 18000,
        }),
      ]);
      expect(result.unclassifiedValue).toBe(0);
    });

    it("merges a lower-case canonical name with the type default under the canonical label", async () => {
      withAccount();
      holdingsRepo.find.mockResolvedValue([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-etf-1",
          quantity: 10,
          security: {
            ...mockEtfSecurity,
            assetWeightings: [{ name: "equity", weight: 1 }],
          },
        },
        {
          id: "h2",
          accountId: "acct-1",
          securityId: "sec-stock-1",
          quantity: 1,
          security: mockStockSecurity, // security-type default is "Equity"
        },
      ]);
      manager.query.mockResolvedValue([
        { security_id: "sec-etf-1", close_price: "100" },
        { security_id: "sec-stock-1", close_price: "200" },
      ]);

      const result = await service.getAssetClassWeightings("user-1");

      expect(result.items).toHaveLength(1);
      // Both are the canonical equity class, named by its label.
      expect(result.items[0].assetClass).toBe("Equities");
      expect(result.items[0].assetClassKey).toBe("equity");
      expect(result.items[0].etfValue).toBe(1000);
      expect(result.items[0].directValue).toBe(200);
      expect(result.items[0].totalValue).toBe(1200);
    });

    it("merges a held stock and a fund's Yahoo 'Stocks' slice into one equity bucket", async () => {
      withAccount();
      holdingsRepo.find.mockResolvedValue([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-stock-1",
          quantity: 1,
          security: mockStockSecurity,
        },
        {
          id: "h2",
          accountId: "acct-1",
          securityId: "sec-etf-1",
          quantity: 10,
          security: {
            ...mockEtfSecurity,
            assetWeightings: [{ name: "Stocks", weight: 1 }],
          },
        },
      ]);
      manager.query.mockResolvedValue([
        { security_id: "sec-stock-1", close_price: "200" },
        { security_id: "sec-etf-1", close_price: "100" },
      ]);

      const result = await service.getAssetClassWeightings("user-1");

      expect(result.items).toEqual([
        {
          assetClass: "Equities",
          assetClassKey: "equity",
          directValue: 200,
          etfValue: 1000,
          totalValue: 1200,
          percentage: 100,
        },
      ]);
    });

    it("merges a held bond and a fund's Yahoo 'Bonds' slice into one fixed income bucket", async () => {
      withAccount();
      holdingsRepo.find.mockResolvedValue([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-bond-1",
          quantity: 5,
          security: {
            ...mockStockSecurity,
            id: "sec-bond-1",
            symbol: "BOND1",
            securityType: "BOND",
          },
        },
        {
          id: "h2",
          accountId: "acct-1",
          securityId: "sec-etf-1",
          quantity: 10,
          security: {
            ...mockEtfSecurity,
            assetWeightings: [
              { name: "Bonds", weight: 0.9 },
              { name: "Cash", weight: 0.1 },
            ],
          },
        },
      ]);
      manager.query.mockResolvedValue([
        { security_id: "sec-bond-1", close_price: "100" },
        { security_id: "sec-etf-1", close_price: "100" },
      ]);

      const result = await service.getAssetClassWeightings("user-1");

      expect(result.items).toEqual([
        {
          assetClass: "Fixed Income",
          assetClassKey: "fixedIncome",
          directValue: 500,
          etfValue: 900,
          totalValue: 1400,
          percentage: 93.33,
        },
        {
          assetClass: "Cash",
          assetClassKey: "cash",
          directValue: 0,
          etfValue: 100,
          totalValue: 100,
          percentage: 6.67,
        },
      ]);
    });

    it("passes a user-typed class that maps to no canonical class through as typed", async () => {
      withAccount();
      holdingsRepo.find.mockResolvedValue([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-etf-1",
          quantity: 10,
          security: {
            ...mockEtfSecurity,
            assetWeightings: [
              { name: "Real Estate", weight: 0.5 },
              { name: "real estate", weight: 0.25 },
              { name: "Stocks", weight: 0.25 },
            ],
          },
        },
      ]);
      manager.query.mockResolvedValue([
        { security_id: "sec-etf-1", close_price: "100" },
      ]);

      const result = await service.getAssetClassWeightings("user-1");

      expect(
        result.items.map(({ assetClass, assetClassKey, totalValue }) => ({
          assetClass,
          assetClassKey,
          totalValue,
        })),
      ).toEqual([
        { assetClass: "Real Estate", assetClassKey: null, totalValue: 750 },
        { assetClass: "Equities", assetClassKey: "equity", totalValue: 250 },
      ]);
    });

    it("filters by the requested accounts and securities", async () => {
      withAccount();
      holdingsRepo.find.mockResolvedValue([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-stock-1",
          quantity: 10,
          security: mockStockSecurity,
        },
        {
          id: "h2",
          accountId: "acct-1",
          securityId: "sec-etf-1",
          quantity: 10,
          security: {
            ...mockEtfSecurity,
            assetWeightings: [{ name: "Fixed Income", weight: 1 }],
          },
        },
      ]);
      manager.query.mockResolvedValue([
        { security_id: "sec-stock-1", close_price: "100" },
        { security_id: "sec-etf-1", close_price: "100" },
      ]);

      const result = await service.getAssetClassWeightings(
        "user-1",
        ["acct-1"],
        ["sec-stock-1"],
      );

      // Only the requested account is queried...
      expect(accountsRepo.find).toHaveBeenCalledWith({
        where: {
          userId: "user-1",
          id: expect.anything(),
          accountType: "INVESTMENT",
        },
      });
      // ...and the excluded security contributes nothing.
      expect(result.items).toHaveLength(1);
      expect(result.items[0].assetClassKey).toBe("equity");
      expect(result.totalPortfolioValue).toBe(1000);
    });

    it("treats a fund with no asset weightings as fully Other", async () => {
      withAccount();
      holdingsRepo.find.mockResolvedValue([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-etf-1",
          quantity: 5,
          security: { ...mockEtfSecurity, assetWeightings: null },
        },
      ]);
      manager.query.mockResolvedValue([
        { security_id: "sec-etf-1", close_price: "100" },
      ]);

      const result = await service.getAssetClassWeightings("user-1");

      expect(result.items).toEqual([]);
      expect(result.unclassifiedValue).toBe(500);
    });
  });

  describe("getLlmLookThrough", () => {
    const account = {
      id: "acct-1",
      userId: "user-1",
      accountType: "INVESTMENT",
      currencyCode: "USD",
    };

    beforeEach(() => {
      accountsRepo.find.mockResolvedValue([account]);
      calcService.categoriseAccounts.mockReturnValue({
        cashAccounts: [],
        brokerageAccounts: [],
        standaloneAccounts: [account],
        holdingsAccountIds: ["acct-1"],
      });
    });

    it("returns both breakdowns with percentages and an Other bucket", async () => {
      holdingsRepo.find.mockResolvedValue([
        {
          id: "h1",
          accountId: "acct-1",
          securityId: "sec-etf-1",
          quantity: 10,
          security: {
            ...mockEtfSecurity,
            countryWeightings: [{ name: "United States", weight: 0.75 }],
            assetWeightings: [{ name: "Equity", weight: 0.5 }],
          },
        },
      ]);
      manager.query.mockResolvedValue([
        { security_id: "sec-etf-1", close_price: "100" },
      ]);

      const result = await service.getLlmLookThrough("user-1");

      expect(result.totalPortfolioValue).toBe(1000);
      expect(result.byCountry.items).toEqual([
        { name: "United States", value: 750, percentage: 75 },
      ]);
      expect(result.byCountry.unclassifiedValue).toBe(250);
      expect(result.byCountry.unclassifiedPercentage).toBe(25);
      expect(result.byAssetClass.items).toEqual([
        { name: "Equities", value: 500, percentage: 50 },
      ]);
      expect(result.byAssetClass.unclassifiedValue).toBe(500);
      expect(result.byAssetClass.unclassifiedPercentage).toBe(50);
    });

    it("is empty (not an error) for a portfolio with no holdings", async () => {
      holdingsRepo.find.mockResolvedValue([]);

      const result = await service.getLlmLookThrough("user-1");

      expect(result.byCountry.items).toEqual([]);
      expect(result.byAssetClass.items).toEqual([]);
      expect(result.byCountry.unclassifiedValue).toBe(0);
      expect(result.byAssetClass.unclassifiedPercentage).toBe(0);
    });
  });
});
