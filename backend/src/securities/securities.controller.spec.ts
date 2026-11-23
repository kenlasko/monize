import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { SecuritiesController } from "./securities.controller";
import { SecuritiesService } from "./securities.service";
import { SecurityPriceService } from "./security-price.service";
import { MsnFinanceService } from "./msn-finance.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { SecurityDetailService } from "./security-detail.service";
import { SecurityDocumentsService } from "./security-documents.service";
import { SecurityNewsService } from "./security-news.service";
import { SectorWeightingService } from "./sector-weighting.service";

describe("SecuritiesController", () => {
  let controller: SecuritiesController;
  let securitiesService: Record<string, jest.Mock>;
  let securityPriceService: Record<string, jest.Mock>;
  let securityDetailService: Record<string, jest.Mock>;
  let securityDocumentsService: Record<string, jest.Mock>;
  let securityNewsService: Record<string, jest.Mock>;
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
      getFavouriteSecurities: jest.fn(),
      getSuggestedDescription: jest.fn(),
      getCountryOptions: jest.fn(),
      getAssetOptions: jest.fn(),
      deleteAssetOption: jest.fn(),
      recomputeLinkedPrices: jest
        .fn()
        .mockResolvedValue({ results: [], updated: 0, failed: 0 }),
    };

    securityPriceService = {
      lookupSecurity: jest.fn(),
      refreshAllPrices: jest.fn(),
      refreshPricesForSecurities: jest.fn(),
      backfillHistoricalPrices: jest.fn(),
      backfillSecurityHoldingPeriod: jest.fn(),
      backfillTransactionPrices: jest.fn(),
      getLastUpdateTime: jest.fn(),
      getPriceHistory: jest.fn(),
      createManualPrice: jest.fn(),
      updatePrice: jest.fn(),
      deletePrice: jest.fn(),
    };

    securityNewsService = {
      getNews: jest.fn(),
      getThumbnail: jest.fn(),
    };
    securityDocumentsService = {
      findAll: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };
    securityDetailService = {
      getDetail: jest.fn(),
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
        { provide: SecurityDetailService, useValue: securityDetailService },
        {
          provide: SecurityDocumentsService,
          useValue: securityDocumentsService,
        },
        { provide: SecurityNewsService, useValue: securityNewsService },
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

  describe("news", () => {
    it("returns the headlines for the caller's security", async () => {
      const news = { provider: "yahoo", items: [] };
      securityNewsService.getNews.mockResolvedValue(news);

      expect(await controller.getNews(req, "sec-1")).toBe(news);
      expect(securityNewsService.getNews).toHaveBeenCalledWith(
        "user-1",
        "sec-1",
      );
    });

    describe("thumbnail", () => {
      const mockRes = () => {
        const res: Record<string, jest.Mock> = {
          set: jest.fn(),
          end: jest.fn(),
        };
        res.status = jest.fn().mockReturnValue(res);
        return res;
      };

      it("streams the image with the no-sniff hardening", async () => {
        securityNewsService.getThumbnail.mockResolvedValue({
          data: Buffer.from([1, 2, 3]),
          contentType: "image/jpeg",
        });
        const res = mockRes();

        await controller.getNewsThumbnail(req, "sec-1", "uuid-1", res as never);

        expect(securityNewsService.getThumbnail).toHaveBeenCalledWith(
          "user-1",
          "sec-1",
          "uuid-1",
        );
        const headers = res.set.mock.calls[0][0];
        expect(headers["Content-Type"]).toBe("image/jpeg");
        expect(headers["Content-Length"]).toBe("3");
        // Same hardening as the attachment download: the bytes came from a
        // third party, so the browser must not reinterpret them.
        expect(headers["X-Content-Type-Options"]).toBe("nosniff");
        expect(headers["Content-Security-Policy"]).toBe("default-src 'none'");
        expect(headers["Cache-Control"]).toContain("private");
        expect(res.end).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
      });

      it("404s with no body when there is no image to serve", async () => {
        securityNewsService.getThumbnail.mockResolvedValue(null);
        const res = mockRes();

        await controller.getNewsThumbnail(req, "sec-1", "uuid-1", res as never);

        // A picture nobody can fetch is not an error worth a body; the row
        // simply renders without one.
        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.set).not.toHaveBeenCalled();
      });
    });
  });

  describe("documents", () => {
    // Thin adapters: the service owns ownership and scoping, so what matters
    // here is that the userId comes off the JWT and both ids are passed on.
    it("lists a security's documents for the caller", async () => {
      const documents = [{ id: "doc-1" }];
      securityDocumentsService.findAll.mockResolvedValue(documents);

      expect(await controller.listDocuments(req, "sec-1")).toBe(documents);
      expect(securityDocumentsService.findAll).toHaveBeenCalledWith(
        "user-1",
        "sec-1",
      );
    });

    it("creates a document against the security", async () => {
      const dto = { name: "Factsheet", url: "https://example.com/a.pdf" };
      securityDocumentsService.create.mockResolvedValue({ id: "doc-1" });

      await controller.createDocument(req, "sec-1", dto);
      expect(securityDocumentsService.create).toHaveBeenCalledWith(
        "user-1",
        "sec-1",
        dto,
      );
    });

    it("updates a document within its security", async () => {
      const dto = { name: "Renamed" };
      securityDocumentsService.update.mockResolvedValue({ id: "doc-1" });

      await controller.updateDocument(req, "sec-1", "doc-1", dto);
      expect(securityDocumentsService.update).toHaveBeenCalledWith(
        "user-1",
        "sec-1",
        "doc-1",
        dto,
      );
    });

    it("deletes a document within its security", async () => {
      await controller.removeDocument(req, "sec-1", "doc-1");
      expect(securityDocumentsService.remove).toHaveBeenCalledWith(
        "user-1",
        "sec-1",
        "doc-1",
      );
    });
  });

  describe("getCountryOptions", () => {
    it("delegates to securitiesService.getCountryOptions with userId", async () => {
      securitiesService.getCountryOptions.mockResolvedValue([
        "Canada",
        "United States",
      ]);

      const result = await controller.getCountryOptions(req);

      expect(securitiesService.getCountryOptions).toHaveBeenCalledWith(
        "user-1",
      );
      expect(result).toEqual(["Canada", "United States"]);
    });
  });

  describe("getAssetOptions", () => {
    it("delegates to securitiesService.getAssetOptions with userId", async () => {
      securitiesService.getAssetOptions.mockResolvedValue(["Cash", "Equity"]);

      const result = await controller.getAssetOptions(req);

      expect(securitiesService.getAssetOptions).toHaveBeenCalledWith("user-1");
      expect(result).toEqual(["Cash", "Equity"]);
    });
  });

  describe("deleteAssetOption", () => {
    it("delegates to securitiesService.deleteAssetOption with userId and name", async () => {
      securitiesService.deleteAssetOption.mockResolvedValue({
        name: "Equity",
        removedFrom: 2,
      });

      const result = await controller.deleteAssetOption(req, "Equity");

      expect(securitiesService.deleteAssetOption).toHaveBeenCalledWith(
        "user-1",
        "Equity",
      );
      expect(result).toEqual({ name: "Equity", removedFrom: 2 });
    });

    it("caps an over-long name before it reaches the service", async () => {
      securitiesService.deleteAssetOption.mockResolvedValue({
        name: "x".repeat(100),
        removedFrom: 0,
      });

      await controller.deleteAssetOption(req, "x".repeat(500));

      expect(securitiesService.deleteAssetOption).toHaveBeenCalledWith(
        "user-1",
        "x".repeat(100),
      );
    });

    it("rejects a repeated name query param", async () => {
      expect(() =>
        controller.deleteAssetOption(req, ["a", "b"] as unknown as string),
      ).toThrow(BadRequestException);
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

  describe("getFavourites", () => {
    it("delegates to securitiesService.getFavouriteSecurities", async () => {
      const favourites = [
        {
          securityId: "sec-1",
          symbol: "AAPL",
          name: "Apple Inc.",
          currencyCode: "USD",
          currentPrice: 110,
          previousPrice: 100,
          dailyChange: 10,
          dailyChangePercent: 10,
        },
      ];
      securitiesService.getFavouriteSecurities.mockResolvedValue(favourites);

      const result = await controller.getFavourites(req);

      expect(securitiesService.getFavouriteSecurities).toHaveBeenCalledWith(
        "user-1",
      );
      expect(result).toEqual(favourites);
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

    it("recomputes a bond-linked security's engine prices instead of asking a quote provider (R24)", async () => {
      const linked = { ...mockSecurity, id: "bond-1", bondProgramId: "i-1" };
      securitiesService.findOne.mockImplementation(
        async (_u: string, id: string) =>
          id === "bond-1" ? linked : { ...mockSecurity, id },
      );
      securityPriceService.refreshPricesForSecurities.mockResolvedValue({
        totalSecurities: 1,
        updated: 1,
        failed: 0,
        skipped: 0,
        results: [{ symbol: "AAPL", success: true }],
        lastUpdated: new Date(),
      });
      securitiesService.recomputeLinkedPrices.mockResolvedValue({
        results: [{ symbol: "AAPL", success: true }],
        updated: 1,
        failed: 0,
      });

      const result = await controller.refreshSelectedPrices(req, {
        securityIds: ["sec-1", "bond-1"],
      } as any);

      expect(
        securityPriceService.refreshPricesForSecurities,
      ).toHaveBeenCalledWith(["sec-1"]);
      expect(securitiesService.recomputeLinkedPrices).toHaveBeenCalledWith(
        "user-1",
        [linked],
      );
      expect(result).toMatchObject({
        totalSecurities: 2,
        updated: 2,
        failed: 0,
      });
      expect(result.results).toHaveLength(2);
    });

    it("a selection of only linked securities never reaches a provider and is not '0 updated'", async () => {
      const linked = { ...mockSecurity, id: "bond-1", bondProgramId: "i-1" };
      securitiesService.findOne.mockResolvedValue(linked);
      securitiesService.recomputeLinkedPrices.mockResolvedValue({
        results: [{ symbol: "EDO1036", success: true }],
        updated: 1,
        failed: 0,
      });

      const result = await controller.refreshSelectedPrices(req, {
        securityIds: ["bond-1"],
      } as any);

      expect(
        securityPriceService.refreshPricesForSecurities,
      ).not.toHaveBeenCalled();
      expect(result).toMatchObject({ totalSecurities: 1, updated: 1 });
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

      const result = await controller.backfillHistoricalPrices({});

      expect(securityPriceService.backfillHistoricalPrices).toHaveBeenCalled();
      expect(result).toEqual(summary);
    });
  });

  describe("backfillSecurityPrices", () => {
    it("delegates to backfillSecurityHoldingPeriod and recalculates accounts when prices loaded", async () => {
      const result = {
        symbol: "AAPL",
        success: true,
        pricesLoaded: 250,
        provider: "yahoo" as const,
      };
      securityPriceService.backfillSecurityHoldingPeriod.mockResolvedValue(
        result,
      );

      const response = await controller.backfillSecurityPrices(
        req,
        "sec-1",
        {},
      );

      expect(
        securityPriceService.backfillSecurityHoldingPeriod,
      ).toHaveBeenCalledWith("user-1", "sec-1", undefined);
      expect(response).toEqual(result);
      // Fire-and-forget recalc runs in the background.
      await Promise.resolve();
      expect(netWorthService.recalculateAllAccounts).toHaveBeenCalledWith(
        "user-1",
      );
    });

    it("does not recalculate when no prices were loaded", async () => {
      securityPriceService.backfillSecurityHoldingPeriod.mockResolvedValue({
        symbol: "AAPL",
        success: true,
        pricesLoaded: 0,
        provider: "yahoo",
      });

      await controller.backfillSecurityPrices(req, "sec-1", {});

      expect(netWorthService.recalculateAllAccounts).not.toHaveBeenCalled();
    });

    it("does not recalculate when the backfill failed", async () => {
      securityPriceService.backfillSecurityHoldingPeriod.mockResolvedValue({
        symbol: "AAPL",
        success: false,
        error: "No historical data available",
      });

      const response = await controller.backfillSecurityPrices(
        req,
        "sec-1",
        {},
      );

      expect(response.success).toBe(false);
      expect(netWorthService.recalculateAllAccounts).not.toHaveBeenCalled();
    });

    it("swallows background recalculation errors", async () => {
      securityPriceService.backfillSecurityHoldingPeriod.mockResolvedValue({
        symbol: "AAPL",
        success: true,
        pricesLoaded: 10,
        provider: "yahoo",
      });
      netWorthService.recalculateAllAccounts.mockRejectedValue(
        new Error("recalc failed"),
      );

      await expect(
        controller.backfillSecurityPrices(req, "sec-1", {}),
      ).resolves.toBeDefined();
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

      const result = await controller.getPriceHistory(req, "sec-1", {
        limit: 365,
      });

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

      await controller.getPriceHistory(req, "sec-1", { limit: 30 });

      expect(securityPriceService.getPriceHistory).toHaveBeenCalledWith(
        "sec-1",
        undefined,
        undefined,
        30,
      );
    });

    it("passes a date window through to the service", async () => {
      securitiesService.findOne.mockResolvedValue(mockSecurity);
      securityPriceService.getPriceHistory.mockResolvedValue([]);

      await controller.getPriceHistory(req, "sec-1", {
        startDate: "2020-01-01",
        endDate: "2025-12-31",
      });

      expect(securityPriceService.getPriceHistory).toHaveBeenCalledWith(
        "sec-1",
        "2020-01-01",
        "2025-12-31",
        undefined,
      );
    });

    it("treats a blank date as absent rather than as a filter", async () => {
      securitiesService.findOne.mockResolvedValue(mockSecurity);
      securityPriceService.getPriceHistory.mockResolvedValue([]);

      // A range control sitting on a preset submits empty strings; passing them
      // on would filter on "" and return nothing.
      await controller.getPriceHistory(req, "sec-1", {
        startDate: "",
        endDate: "",
      });

      expect(securityPriceService.getPriceHistory).toHaveBeenCalledWith(
        "sec-1",
        undefined,
        undefined,
        undefined,
      );
    });

    it("checks ownership before reading any price", async () => {
      securitiesService.findOne.mockRejectedValue(new Error("not yours"));

      await expect(
        controller.getPriceHistory(req, "sec-1", {}),
      ).rejects.toThrow();
      expect(securityPriceService.getPriceHistory).not.toHaveBeenCalled();
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

    it("answers only once the net worth snapshots have been recalculated", async () => {
      // The dashboard reloads the net worth as soon as the refresh answers, and
      // the monthly figures are read from these snapshots: answering first let
      // that reload read the month priced before the refresh.
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
      let finishRecalc: () => void = () => {};
      netWorthService.recalculateAllAccounts.mockReturnValue(
        new Promise<void>((resolve) => {
          finishRecalc = resolve;
        }),
      );

      let answered = false;
      const response = controller
        .refreshSelectedPrices(req, { securityIds: ["sec-1"] } as any)
        .then((value) => {
          answered = true;
          return value;
        });
      await new Promise((r) => setImmediate(r));
      expect(netWorthService.recalculateAllAccounts).toHaveBeenCalledWith(
        "user-1",
      );
      expect(answered).toBe(false);

      finishRecalc();
      await expect(response).resolves.toEqual(summary);
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

      expect(securityPriceService.backfillTransactionPrices).toHaveBeenCalled();
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
        "user-1",
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
        "user-1",
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
      expect(securityPriceService.deletePrice).toHaveBeenCalledWith(
        "sec-1",
        9,
        "user-1",
      );
    });
  });

  describe("suggestDescription", () => {
    it("delegates to the service with the trimmed symbol and exchange", async () => {
      securitiesService.getSuggestedDescription.mockResolvedValue({
        symbol: "AGGG",
        description: "Bond ETF.",
      });

      const result = await controller.suggestDescription("AGGG", "LSE");

      expect(securitiesService.getSuggestedDescription).toHaveBeenCalledWith(
        "AGGG",
        "LSE",
      );
      expect(result).toEqual({ symbol: "AGGG", description: "Bond ETF." });
    });

    it("passes undefined when no exchange is given", async () => {
      securitiesService.getSuggestedDescription.mockResolvedValue({
        symbol: "AAPL",
        description: null,
      });

      await controller.suggestDescription("AAPL");

      expect(securitiesService.getSuggestedDescription).toHaveBeenCalledWith(
        "AAPL",
        undefined,
      );
    });
  });
});
