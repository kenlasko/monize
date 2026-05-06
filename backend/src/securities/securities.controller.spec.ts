import { Test, TestingModule } from "@nestjs/testing";
import { SecuritiesController } from "./securities.controller";
import { SecuritiesService } from "./securities.service";
import { SecurityPriceService } from "./security-price.service";
import { MsnFinanceService } from "./msn-finance.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { SectorWeightingService } from "./sector-weighting.service";

describe("SecuritiesController", () => {
  let controller: SecuritiesController;
  let securitiesService: Record<string, jest.Mock>;
  let securityPriceService: Record<string, jest.Mock>;
  let msnFinanceService: Record<string, jest.Mock>;
  let netWorthService: Record<string, jest.Mock>;
  let sectorWeightingService: Record<string, jest.Mock>;

  const req = { user: { id: "user-1" } };

  const mockSecurity = {
    id: "sec-1",
    userId: "user-1",
    symbol: "AAPL",
    name: "Apple Inc.",
    securityType: "STOCK",
    exchange: "NASDAQ",
    currencyCode: "USD",
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    securitiesService = {
      create: jest.fn(),
      findAll: jest.fn(),
      search: jest.fn(),
      findOne: jest.fn(),
      findBySymbol: jest.fn(),
      update: jest.fn(),
      deactivate: jest.fn(),
      activate: jest.fn(),
      remove: jest.fn(),
      getSecurityIdsWithTransactions: jest.fn(),
    };

    securityPriceService = {
      lookupSecurity: jest.fn(),
      refreshAllPrices: jest.fn(),
      refreshPricesForSecurities: jest.fn(),
      backfillHistoricalPrices: jest.fn(),
      backfillTransactionPrices: jest.fn(),
      getLastUpdateTime: jest.fn(),
      getPriceHistory: jest.fn(),
      createManualPrice: jest.fn(),
      updatePrice: jest.fn(),
      deletePrice: jest.fn(),
    };

    netWorthService = {
      recalculateAllInvestmentSnapshots: jest.fn().mockResolvedValue(undefined),
      recalculateAllAccounts: jest.fn().mockResolvedValue(undefined),
    };

    sectorWeightingService = {
      ensureSectorDataByIds: jest.fn().mockResolvedValue(undefined),
    };

    msnFinanceService = {
      isApiKeyConfigured: jest.fn().mockReturnValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SecuritiesController],
      providers: [
        { provide: SecuritiesService, useValue: securitiesService },
        { provide: SecurityPriceService, useValue: securityPriceService },
        { provide: NetWorthService, useValue: netWorthService },
        { provide: SectorWeightingService, useValue: sectorWeightingService },
        { provide: MsnFinanceService, useValue: msnFinanceService },
      ],
    }).compile();

    controller = module.get<SecuritiesController>(SecuritiesController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("providerStatus", () => {
    it("reports msn ready when MSN api key is configured", () => {
      msnFinanceService.isApiKeyConfigured.mockReturnValue(true);
      expect(controller.providerStatus()).toEqual({
        yahoo: { ready: true },
        msn: { ready: true },
      });
    });

    it("reports msn not ready when MSN api key is missing", () => {
      msnFinanceService.isApiKeyConfigured.mockReturnValue(false);
      expect(controller.providerStatus()).toEqual({
        yahoo: { ready: true },
        msn: { ready: false },
      });
    });
  });

  describe("create", () => {
    it("delegates to securitiesService.create with userId and dto", async () => {
      const dto = {
        symbol: "MSFT",
        name: "Microsoft",
        securityType: "STOCK",
        currencyCode: "USD",
      };
      securitiesService.create.mockResolvedValue({
        ...mockSecurity,
        ...dto,
        id: "sec-2",
      });

      const result = await controller.create(req, dto as any);

      expect(securitiesService.create).toHaveBeenCalledWith("user-1", dto);
      expect(result.symbol).toBe("MSFT");
    });
  });

  describe("findAll", () => {
    it("returns all active securities by default", async () => {
      securitiesService.findAll.mockResolvedValue([mockSecurity]);

      const result = await controller.findAll(req, false);

      expect(securitiesService.findAll).toHaveBeenCalledWith("user-1", false);
      expect(result).toEqual([mockSecurity]);
    });

    it("includes inactive securities when requested", async () => {
      securitiesService.findAll.mockResolvedValue([mockSecurity]);

      await controller.findAll(req, true);

      expect(securitiesService.findAll).toHaveBeenCalledWith("user-1", true);
    });
  });

  describe("search", () => {
    it("delegates to securitiesService.search with query", async () => {
      securitiesService.search.mockResolvedValue([mockSecurity]);

      const result = await controller.search(req, "AAPL");

      expect(securitiesService.search).toHaveBeenCalledWith("user-1", "AAPL");
      expect(result).toEqual([mockSecurity]);
    });
  });

  describe("lookup", () => {
    const mockReq = { user: { id: "user-1" } };

    it("delegates to securityPriceService.lookupSecurity", async () => {
      const lookupResult = {
        symbol: "AAPL",
        name: "Apple Inc.",
        exchange: "NASDAQ",
        securityType: "STOCK",
        currencyCode: "USD",
      };
      securityPriceService.lookupSecurity.mockResolvedValue(lookupResult);

      const result = await controller.lookup(mockReq, "AAPL");

      expect(securityPriceService.lookupSecurity).toHaveBeenCalledWith(
        "user-1",
        "AAPL",
        undefined,
        undefined,
      );
      expect(result).toEqual(lookupResult);
    });

    it("returns null when lookup finds nothing", async () => {
      securityPriceService.lookupSecurity.mockResolvedValue(null);

      const result = await controller.lookup(mockReq, "INVALID");

      expect(result).toBeNull();
    });

    it("passes preferred exchanges from comma-separated query param", async () => {
      securityPriceService.lookupSecurity.mockResolvedValue(null);

      await controller.lookup(mockReq, "VOD", "LSE,ASX");

      expect(securityPriceService.lookupSecurity).toHaveBeenCalledWith(
        "user-1",
        "VOD",
        ["LSE", "ASX"],
        undefined,
      );
    });

    it("limits preferred exchanges to 3", async () => {
      securityPriceService.lookupSecurity.mockResolvedValue(null);

      await controller.lookup(mockReq, "VOD", "LSE,ASX,TSX,NYSE");

      expect(securityPriceService.lookupSecurity).toHaveBeenCalledWith(
        "user-1",
        "VOD",
        ["LSE", "ASX", "TSX"],
        undefined,
      );
    });

    it("handles single exchange in query param", async () => {
      securityPriceService.lookupSecurity.mockResolvedValue(null);

      await controller.lookup(mockReq, "VOD", "LSE");

      expect(securityPriceService.lookupSecurity).toHaveBeenCalledWith(
        "user-1",
        "VOD",
        ["LSE"],
        undefined,
      );
    });

    it("handles empty exchanges param", async () => {
      securityPriceService.lookupSecurity.mockResolvedValue(null);

      await controller.lookup(mockReq, "AAPL", "");

      expect(securityPriceService.lookupSecurity).toHaveBeenCalledWith(
        "user-1",
        "AAPL",
        undefined,
        undefined,
      );
    });

    it("forwards explicit provider choice", async () => {
      securityPriceService.lookupSecurity.mockResolvedValue(null);

      await controller.lookup(mockReq, "VOD", "LSE", "msn");

      expect(securityPriceService.lookupSecurity).toHaveBeenCalledWith(
        "user-1",
        "VOD",
        ["LSE"],
        "msn",
      );
    });

    it("ignores invalid provider choice", async () => {
      securityPriceService.lookupSecurity.mockResolvedValue(null);

      await controller.lookup(mockReq, "VOD", undefined, "bogus");

      expect(securityPriceService.lookupSecurity).toHaveBeenCalledWith(
        "user-1",
        "VOD",
        undefined,
        undefined,
      );
    });
  });

  describe("findOne", () => {
    it("delegates to securitiesService.findOne with userId and id", async () => {
      securitiesService.findOne.mockResolvedValue(mockSecurity);

      const result = await controller.findOne(req, "sec-1");

      expect(securitiesService.findOne).toHaveBeenCalledWith("user-1", "sec-1");
      expect(result).toEqual(mockSecurity);
    });
  });

  describe("findBySymbol", () => {
    it("delegates to securitiesService.findBySymbol with userId and symbol", async () => {
      securitiesService.findBySymbol.mockResolvedValue(mockSecurity);

      const result = await controller.findBySymbol(req, "AAPL");

      expect(securitiesService.findBySymbol).toHaveBeenCalledWith(
        "user-1",
        "AAPL",
      );
      expect(result).toEqual(mockSecurity);
    });
  });

  describe("update", () => {
    it("delegates to securitiesService.update with userId, id, and dto", async () => {
      const dto = { name: "Apple Inc. Updated" };
      securitiesService.update.mockResolvedValue({ ...mockSecurity, ...dto });

      const result = await controller.update(req, "sec-1", dto as any);

      expect(securitiesService.update).toHaveBeenCalledWith(
        "user-1",
        "sec-1",
        dto,
      );
      expect(result.name).toBe("Apple Inc. Updated");
    });
  });

  describe("deactivate", () => {
    it("delegates to securitiesService.deactivate", async () => {
      securitiesService.deactivate.mockResolvedValue({
        ...mockSecurity,
        isActive: false,
      });

      const result = await controller.deactivate(req, "sec-1");

      expect(securitiesService.deactivate).toHaveBeenCalledWith(
        "user-1",
        "sec-1",
      );
      expect(result.isActive).toBe(false);
    });
  });

  describe("activate", () => {
    it("delegates to securitiesService.activate", async () => {
      securitiesService.activate.mockResolvedValue({
        ...mockSecurity,
        isActive: true,
      });

      const result = await controller.activate(req, "sec-1");

      expect(securitiesService.activate).toHaveBeenCalledWith(
        "user-1",
        "sec-1",
      );
      expect(result.isActive).toBe(true);
    });
  });

  describe("remove", () => {
    it("delegates to securitiesService.remove", async () => {
      securitiesService.remove.mockResolvedValue(undefined);

      await controller.remove(req, "sec-1");

      expect(securitiesService.remove).toHaveBeenCalledWith("user-1", "sec-1");
    });
  });

  describe("getUsedSecurityIds", () => {
    it("delegates to securitiesService.getSecurityIdsWithTransactions", async () => {
      securitiesService.getSecurityIdsWithTransactions.mockResolvedValue([
        "sec-1",
        "sec-2",
      ]);

      const result = await controller.getUsedSecurityIds(req);

      expect(
        securitiesService.getSecurityIdsWithTransactions,
      ).toHaveBeenCalledWith("user-1");
      expect(result).toEqual(["sec-1", "sec-2"]);
    });
  });

  describe("refreshAllPrices", () => {
    it("delegates to securityPriceService.refreshAllPrices", async () => {
      const summary = {
        totalSecurities: 5,
        updated: 4,
        failed: 1,
        skipped: 0,
        results: [],
        lastUpdated: new Date(),
      };
      securityPriceService.refreshAllPrices.mockResolvedValue(summary);

      const result = await controller.refreshAllPrices();

      expect(securityPriceService.refreshAllPrices).toHaveBeenCalled();
      expect(result).toEqual(summary);
    });
  });

  describe("refreshSelectedPrices", () => {
    it("verifies ownership of each security before refreshing", async () => {
      securitiesService.findOne.mockResolvedValue(mockSecurity);
      const summary = {
        totalSecurities: 2,
        updated: 2,
        failed: 0,
        skipped: 0,
        results: [],
        lastUpdated: new Date(),
      };
      securityPriceService.refreshPricesForSecurities.mockResolvedValue(
        summary,
      );

      const dto = { securityIds: ["sec-1", "sec-2"] };
      const result = await controller.refreshSelectedPrices(req, dto as any);

      expect(securitiesService.findOne).toHaveBeenCalledWith("user-1", "sec-1");
      expect(securitiesService.findOne).toHaveBeenCalledWith("user-1", "sec-2");
      expect(securitiesService.findOne).toHaveBeenCalledTimes(2);
      expect(
        securityPriceService.refreshPricesForSecurities,
      ).toHaveBeenCalledWith(dto.securityIds);
      expect(result).toEqual(summary);
    });

    it("triggers sector data update as fire-and-forget", async () => {
      securitiesService.findOne.mockResolvedValue(mockSecurity);
      const summary = {
        totalSecurities: 2,
        updated: 0,
        failed: 0,
        skipped: 2,
        results: [],
        lastUpdated: new Date(),
      };
      securityPriceService.refreshPricesForSecurities.mockResolvedValue(
        summary,
      );

      const dto = { securityIds: ["sec-1", "sec-2"] };
      await controller.refreshSelectedPrices(req, dto as any);

      expect(sectorWeightingService.ensureSectorDataByIds).toHaveBeenCalledWith(
        ["sec-1", "sec-2"],
      );
    });

    it("propagates error if findOne rejects (ownership check fails)", async () => {
      securitiesService.findOne.mockRejectedValue(new Error("Not found"));

      await expect(
        controller.refreshSelectedPrices(req, {
          securityIds: ["bad-id"],
        } as any),
      ).rejects.toThrow("Not found");
      expect(
        securityPriceService.refreshPricesForSecurities,
      ).not.toHaveBeenCalled();
    });
  });

  describe("backfillHistoricalPrices", () => {
    it("delegates to securityPriceService.backfillHistoricalPrices", async () => {
      const summary = {
        totalSecurities: 3,
        successful: 3,
        failed: 0,
        totalPricesLoaded: 1000,
        results: [],
      };
      securityPriceService.backfillHistoricalPrices.mockResolvedValue(summary);

      const result = await controller.backfillHistoricalPrices();

      expect(securityPriceService.backfillHistoricalPrices).toHaveBeenCalled();
      expect(result).toEqual(summary);
    });
  });

  describe("getPriceStatus", () => {
    it("returns lastUpdated from securityPriceService", async () => {
      const date = new Date("2025-01-15T10:00:00Z");
      securityPriceService.getLastUpdateTime.mockResolvedValue(date);

      const result = await controller.getPriceStatus();

      expect(securityPriceService.getLastUpdateTime).toHaveBeenCalled();
      expect(result).toEqual({ lastUpdated: date });
    });

    it("returns null lastUpdated when no prices exist", async () => {
      securityPriceService.getLastUpdateTime.mockResolvedValue(null);

      const result = await controller.getPriceStatus();

      expect(result).toEqual({ lastUpdated: null });
    });
  });

  describe("getPriceHistory", () => {
    it("verifies ownership then returns price history", async () => {
      securitiesService.findOne.mockResolvedValue(mockSecurity);
      const prices = [{ date: "2025-01-15", close: 150.0 }];
      securityPriceService.getPriceHistory.mockResolvedValue(prices);

      const result = await controller.getPriceHistory(req, "sec-1", 365);

      expect(securitiesService.findOne).toHaveBeenCalledWith("user-1", "sec-1");
      expect(securityPriceService.getPriceHistory).toHaveBeenCalledWith(
        "sec-1",
        undefined,
        undefined,
        365,
      );
      expect(result).toEqual(prices);
    });

    it("uses custom limit", async () => {
      securitiesService.findOne.mockResolvedValue(mockSecurity);
      securityPriceService.getPriceHistory.mockResolvedValue([]);

      await controller.getPriceHistory(req, "sec-1", 30);

      expect(securityPriceService.getPriceHistory).toHaveBeenCalledWith(
        "sec-1",
        undefined,
        undefined,
        30,
      );
    });
  });

  describe("lookupCandidates", () => {
    beforeEach(() => {
      securityPriceService.lookupSecurityCandidates = jest.fn();
    });

    it("delegates with parsed exchanges and provider 'auto'", async () => {
      securityPriceService.lookupSecurityCandidates.mockResolvedValue([]);

      await controller.lookupCandidates(req, "VOD", "LSE,NYSE", "auto");

      expect(
        securityPriceService.lookupSecurityCandidates,
      ).toHaveBeenCalledWith("user-1", "VOD", ["LSE", "NYSE"], "auto");
    });

    it("ignores invalid provider and undefined exchanges", async () => {
      securityPriceService.lookupSecurityCandidates.mockResolvedValue([]);

      await controller.lookupCandidates(req, "AAPL");

      expect(
        securityPriceService.lookupSecurityCandidates,
      ).toHaveBeenCalledWith("user-1", "AAPL", undefined, undefined);
    });

    it("forwards 'yahoo' provider choice", async () => {
      securityPriceService.lookupSecurityCandidates.mockResolvedValue([]);

      await controller.lookupCandidates(req, "AAPL", undefined, "yahoo");

      expect(
        securityPriceService.lookupSecurityCandidates,
      ).toHaveBeenCalledWith("user-1", "AAPL", undefined, "yahoo");
    });

    it("forwards 'msn' provider choice", async () => {
      securityPriceService.lookupSecurityCandidates.mockResolvedValue([]);
      await controller.lookupCandidates(req, "AAPL", undefined, "msn");
      expect(
        securityPriceService.lookupSecurityCandidates,
      ).toHaveBeenCalledWith("user-1", "AAPL", undefined, "msn");
    });

    it("treats empty q as empty safeQuery", async () => {
      securityPriceService.lookupSecurityCandidates.mockResolvedValue([]);
      await controller.lookupCandidates(req, undefined as never);
      expect(
        securityPriceService.lookupSecurityCandidates,
      ).toHaveBeenCalledWith("user-1", "", undefined, undefined);
    });
  });

  describe("search edge cases", () => {
    it("treats undefined q as empty safeQuery", async () => {
      securitiesService.search.mockResolvedValue([]);
      await controller.search(req, undefined as never);
      expect(securitiesService.search).toHaveBeenCalledWith("user-1", "");
    });
  });

  describe("lookup edge cases", () => {
    const mockReq = { user: { id: "user-1" } };
    it("treats undefined q as empty safeQuery", async () => {
      securityPriceService.lookupSecurity.mockResolvedValue(null);
      await controller.lookup(mockReq, undefined as never);
      expect(securityPriceService.lookupSecurity).toHaveBeenCalledWith(
        "user-1",
        "",
        undefined,
        undefined,
      );
    });
  });

  describe("refreshAllPrices background recalc", () => {
    it("triggers recalculateAllInvestmentSnapshots when updated > 0", async () => {
      const summary = {
        totalSecurities: 3,
        updated: 2,
        failed: 0,
        skipped: 1,
        results: [],
        lastUpdated: new Date(),
      };
      securityPriceService.refreshAllPrices.mockResolvedValue(summary);

      await controller.refreshAllPrices();

      expect(
        netWorthService.recalculateAllInvestmentSnapshots,
      ).toHaveBeenCalled();
    });

    it("skips background recalc when no prices updated", async () => {
      const summary = {
        totalSecurities: 3,
        updated: 0,
        failed: 0,
        skipped: 3,
        results: [],
        lastUpdated: new Date(),
      };
      securityPriceService.refreshAllPrices.mockResolvedValue(summary);

      await controller.refreshAllPrices();

      expect(
        netWorthService.recalculateAllInvestmentSnapshots,
      ).not.toHaveBeenCalled();
    });

    it("swallows background snapshot recalculation errors", async () => {
      const summary = {
        totalSecurities: 1,
        updated: 1,
        failed: 0,
        skipped: 0,
        results: [],
        lastUpdated: new Date(),
      };
      securityPriceService.refreshAllPrices.mockResolvedValue(summary);
      netWorthService.recalculateAllInvestmentSnapshots.mockRejectedValue(
        new Error("recalc failed"),
      );

      await expect(controller.refreshAllPrices()).resolves.toEqual(summary);
      // Allow the catch handler to run
      await new Promise((r) => setImmediate(r));
    });
  });

  describe("refreshSelectedPrices background hooks", () => {
    it("triggers recalculateAllAccounts when updated > 0", async () => {
      securitiesService.findOne.mockResolvedValue(mockSecurity);
      const summary = {
        totalSecurities: 1,
        updated: 1,
        failed: 0,
        skipped: 0,
        results: [],
        lastUpdated: new Date(),
      };
      securityPriceService.refreshPricesForSecurities.mockResolvedValue(
        summary,
      );

      await controller.refreshSelectedPrices(req, {
        securityIds: ["sec-1"],
      } as any);

      expect(netWorthService.recalculateAllAccounts).toHaveBeenCalledWith(
        "user-1",
      );
    });

    it("swallows background recalc errors and sector update errors", async () => {
      securitiesService.findOne.mockResolvedValue(mockSecurity);
      const summary = {
        totalSecurities: 1,
        updated: 1,
        failed: 0,
        skipped: 0,
        results: [],
        lastUpdated: new Date(),
      };
      securityPriceService.refreshPricesForSecurities.mockResolvedValue(
        summary,
      );
      netWorthService.recalculateAllAccounts.mockRejectedValue(
        new Error("recalc failed"),
      );
      sectorWeightingService.ensureSectorDataByIds.mockRejectedValue(
        new Error("sector failed"),
      );

      await expect(
        controller.refreshSelectedPrices(req, {
          securityIds: ["sec-1"],
        } as any),
      ).resolves.toEqual(summary);
      await new Promise((r) => setImmediate(r));
    });
  });

  describe("backfillTransactionPrices", () => {
    it("delegates to securityPriceService.backfillTransactionPrices", async () => {
      const summary = { totalSecurities: 2, successful: 2, failed: 0 };
      securityPriceService.backfillTransactionPrices = jest
        .fn()
        .mockResolvedValue(summary);

      const result = await controller.backfillTransactionPrices();

      expect(
        securityPriceService.backfillTransactionPrices,
      ).toHaveBeenCalled();
      expect(result).toEqual(summary);
    });
  });

  describe("createPrice", () => {
    it("verifies ownership before creating manual price", async () => {
      securitiesService.findOne.mockResolvedValue(mockSecurity);
      securityPriceService.createManualPrice.mockResolvedValue({
        id: 1,
        close: 100,
      });

      const dto = {
        priceDate: "2025-01-01",
        closePrice: 100,
      } as any;
      const result = await controller.createPrice(req, "sec-1", dto);

      expect(securitiesService.findOne).toHaveBeenCalledWith("user-1", "sec-1");
      expect(securityPriceService.createManualPrice).toHaveBeenCalledWith(
        "sec-1",
        dto,
      );
      expect(result).toEqual({ id: 1, close: 100 });
    });
  });

  describe("updatePrice", () => {
    it("verifies ownership before updating price", async () => {
      securitiesService.findOne.mockResolvedValue(mockSecurity);
      securityPriceService.updatePrice.mockResolvedValue({
        id: 9,
        close: 200,
      });

      const dto = { closePrice: 200 } as any;
      const result = await controller.updatePrice(req, "sec-1", 9, dto);

      expect(securitiesService.findOne).toHaveBeenCalledWith("user-1", "sec-1");
      expect(securityPriceService.updatePrice).toHaveBeenCalledWith(
        "sec-1",
        9,
        dto,
      );
      expect(result).toEqual({ id: 9, close: 200 });
    });
  });

  describe("deletePrice", () => {
    it("verifies ownership then deletes", async () => {
      securitiesService.findOne.mockResolvedValue(mockSecurity);
      securityPriceService.deletePrice.mockResolvedValue(undefined);

      await controller.deletePrice(req, "sec-1", 9);

      expect(securitiesService.findOne).toHaveBeenCalledWith("user-1", "sec-1");
      expect(securityPriceService.deletePrice).toHaveBeenCalledWith("sec-1", 9);
    });
  });
});
