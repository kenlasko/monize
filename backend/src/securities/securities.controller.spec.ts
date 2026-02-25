import { Test, TestingModule } from "@nestjs/testing";
import { SecuritiesController } from "./securities.controller";
import { SecuritiesService } from "./securities.service";
import { SecurityPriceService } from "./security-price.service";
import { NetWorthService } from "../net-worth/net-worth.service";

describe("SecuritiesController", () => {
  let controller: SecuritiesController;
  let securitiesService: Record<string, jest.Mock>;
  let securityPriceService: Record<string, jest.Mock>;
  let netWorthService: Record<string, jest.Mock>;

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
    };

    securityPriceService = {
      lookupSecurity: jest.fn(),
      refreshAllPrices: jest.fn(),
      refreshPricesForSecurities: jest.fn(),
      backfillHistoricalPrices: jest.fn(),
      getLastUpdateTime: jest.fn(),
      getPriceHistory: jest.fn(),
    };

    netWorthService = {
      recalculateAllInvestmentSnapshots: jest.fn().mockResolvedValue(undefined),
      recalculateAllAccounts: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SecuritiesController],
      providers: [
        { provide: SecuritiesService, useValue: securitiesService },
        { provide: SecurityPriceService, useValue: securityPriceService },
        { provide: NetWorthService, useValue: netWorthService },
      ],
    }).compile();

    controller = module.get<SecuritiesController>(SecuritiesController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
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
    it("delegates to securityPriceService.lookupSecurity", async () => {
      const lookupResult = {
        symbol: "AAPL",
        name: "Apple Inc.",
        exchange: "NASDAQ",
        securityType: "STOCK",
        currencyCode: "USD",
      };
      securityPriceService.lookupSecurity.mockResolvedValue(lookupResult);

      const result = await controller.lookup("AAPL");

      expect(securityPriceService.lookupSecurity).toHaveBeenCalledWith("AAPL");
      expect(result).toEqual(lookupResult);
    });

    it("returns null when lookup finds nothing", async () => {
      securityPriceService.lookupSecurity.mockResolvedValue(null);

      const result = await controller.lookup("INVALID");

      expect(result).toBeNull();
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
});
