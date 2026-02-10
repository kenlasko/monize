import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { SecurityPriceService } from "./security-price.service";
import { SecurityPrice } from "./entities/security-price.entity";
import { Security } from "./entities/security.entity";

describe("SecurityPriceService", () => {
  let service: SecurityPriceService;
  let securityPriceRepository: Record<string, jest.Mock>;
  let securitiesRepository: Record<string, jest.Mock>;
  let dataSourceMock: Record<string, jest.Mock>;
  let originalFetch: typeof global.fetch;

  const mockSecurity: Security = {
    id: "sec-1",
    userId: "user-1",
    symbol: "AAPL",
    name: "Apple Inc.",
    securityType: "STOCK",
    exchange: "NASDAQ",
    currencyCode: "USD",
    isActive: true,
    skipPriceUpdates: false,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
  } as Security;

  const mockSecurityTSX: Security = {
    id: "sec-2",
    userId: "user-1",
    symbol: "RY",
    name: "Royal Bank of Canada",
    securityType: "STOCK",
    exchange: "TSX",
    currencyCode: "CAD",
    isActive: true,
    skipPriceUpdates: false,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
  } as Security;

  const mockSecurityNoExchange: Security = {
    id: "sec-3",
    userId: "user-2",
    symbol: "MSFT",
    name: "Microsoft Corp",
    securityType: "STOCK",
    exchange: null,
    currencyCode: "USD",
    isActive: true,
    skipPriceUpdates: false,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
  } as Security;

  const mockPriceEntry: SecurityPrice = {
    id: 1,
    securityId: "sec-1",
    priceDate: new Date("2025-06-01"),
    openPrice: 190.0,
    highPrice: 195.0,
    lowPrice: 189.0,
    closePrice: 193.5,
    volume: 50000000,
    source: "yahoo_finance",
    createdAt: new Date("2025-06-01T17:00:00Z"),
  } as SecurityPrice;

  const makeYahooChartResponse = (overrides: Record<string, any> = {}) => ({
    chart: {
      result: [
        {
          meta: {
            symbol: overrides.symbol ?? "AAPL",
            regularMarketPrice: overrides.regularMarketPrice ?? 193.5,
            regularMarketDayHigh: overrides.regularMarketDayHigh ?? 195.0,
            regularMarketDayLow: overrides.regularMarketDayLow ?? 189.0,
            regularMarketVolume: overrides.regularMarketVolume ?? 50000000,
            regularMarketTime: overrides.regularMarketTime ?? 1748800000,
          },
        },
      ],
    },
  });

  const makeYahooSearchResponse = (
    quotes: Array<Record<string, any>> = [],
  ) => ({
    quotes,
  });

  const makeYahooHistoricalResponse = (overrides: Record<string, any> = {}) => ({
    chart: {
      result: [
        {
          timestamp: overrides.timestamps ?? [1748700000, 1748800000],
          indicators: {
            quote: [
              {
                open: overrides.opens ?? [190.0, 191.0],
                high: overrides.highs ?? [195.0, 196.0],
                low: overrides.lows ?? [189.0, 190.0],
                close: overrides.closes ?? [193.0, 194.0],
                volume: overrides.volumes ?? [50000000, 51000000],
              },
            ],
          },
        },
      ],
    },
  });

  const createMockFetchResponse = (data: any, ok = true, status = 200) =>
    Promise.resolve({
      ok,
      status,
      json: () => Promise.resolve(data),
    } as Response);

  beforeEach(async () => {
    originalFetch = global.fetch;

    securityPriceRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn().mockImplementation((data) => ({ ...data, id: 1 })),
      save: jest.fn().mockImplementation((data) => data),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      })),
    };

    securitiesRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
    };

    dataSourceMock = {
      query: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SecurityPriceService,
        {
          provide: getRepositoryToken(SecurityPrice),
          useValue: securityPriceRepository,
        },
        {
          provide: getRepositoryToken(Security),
          useValue: securitiesRepository,
        },
        {
          provide: DataSource,
          useValue: dataSourceMock,
        },
      ],
    }).compile();

    service = module.get<SecurityPriceService>(SecurityPriceService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("getLatestPrice", () => {
    it("returns the latest price for a security", async () => {
      securityPriceRepository.findOne.mockResolvedValue(mockPriceEntry);

      const result = await service.getLatestPrice("sec-1");

      expect(result).toEqual(mockPriceEntry);
      expect(securityPriceRepository.findOne).toHaveBeenCalledWith({
        where: { securityId: "sec-1" },
        order: { priceDate: "DESC" },
      });
    });

    it("returns null when no price exists", async () => {
      securityPriceRepository.findOne.mockResolvedValue(null);

      const result = await service.getLatestPrice("nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("getPriceHistory", () => {
    it("returns price history with default limit", async () => {
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([mockPriceEntry]),
      };
      securityPriceRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.getPriceHistory("sec-1");

      expect(securityPriceRepository.createQueryBuilder).toHaveBeenCalledWith("sp");
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        "sp.securityId = :securityId",
        { securityId: "sec-1" },
      );
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith("sp.priceDate", "DESC");
      expect(mockQueryBuilder.take).toHaveBeenCalledWith(365);
      expect(mockQueryBuilder.andWhere).not.toHaveBeenCalled();
      expect(result).toEqual([mockPriceEntry]);
    });

    it("applies startDate filter when provided", async () => {
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      securityPriceRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const startDate = new Date("2025-01-01");
      await service.getPriceHistory("sec-1", startDate);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "sp.priceDate >= :startDate",
        { startDate },
      );
    });

    it("applies endDate filter when provided", async () => {
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      securityPriceRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const endDate = new Date("2025-06-30");
      await service.getPriceHistory("sec-1", undefined, endDate);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "sp.priceDate <= :endDate",
        { endDate },
      );
    });

    it("applies both startDate and endDate filters", async () => {
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      securityPriceRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const startDate = new Date("2025-01-01");
      const endDate = new Date("2025-06-30");
      await service.getPriceHistory("sec-1", startDate, endDate);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledTimes(2);
    });

    it("uses custom limit when provided", async () => {
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      securityPriceRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      await service.getPriceHistory("sec-1", undefined, undefined, 30);

      expect(mockQueryBuilder.take).toHaveBeenCalledWith(30);
    });
  });

  describe("getLastUpdateTime", () => {
    it("returns the createdAt of the most recent price entry", async () => {
      const createdAt = new Date("2025-06-01T17:00:00Z");
      securityPriceRepository.findOne.mockResolvedValue({ createdAt });

      const result = await service.getLastUpdateTime();

      expect(result).toEqual(createdAt);
      expect(securityPriceRepository.findOne).toHaveBeenCalledWith({
        where: {},
        order: { createdAt: "DESC" },
      });
    });

    it("returns null when no price entries exist", async () => {
      securityPriceRepository.findOne.mockResolvedValue(null);

      const result = await service.getLastUpdateTime();

      expect(result).toBeNull();
    });
  });

  describe("refreshAllPrices", () => {
    it("returns empty summary when no active securities exist", async () => {
      securitiesRepository.find.mockResolvedValue([]);

      const result = await service.refreshAllPrices();

      expect(result.totalSecurities).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.results).toHaveLength(0);
      expect(result.lastUpdated).toBeInstanceOf(Date);
    });

    it("successfully refreshes prices for a US security", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      const yahooData = makeYahooChartResponse();
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(yahooData),
      ) as jest.Mock;

      // savePriceData: findOne returns null (new price), then create and save
      securityPriceRepository.findOne.mockResolvedValue(null);

      const result = await service.refreshAllPrices();

      expect(result.totalSecurities).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.results[0]).toEqual(
        expect.objectContaining({
          symbol: "AAPL",
          success: true,
          price: 193.5,
        }),
      );
    });

    it("appends exchange suffix for TSX securities", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurityTSX]);

      const yahooData = makeYahooChartResponse({ symbol: "RY.TO" });
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(yahooData),
      ) as jest.Mock;

      securityPriceRepository.findOne.mockResolvedValue(null);

      await service.refreshAllPrices();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("RY.TO"),
        expect.any(Object),
      );
    });

    it("tries alternate symbols when primary fetch returns null", async () => {
      // Security with no exchange (defaults to US) but no data under plain symbol
      securitiesRepository.find.mockResolvedValue([mockSecurityNoExchange]);

      const fetchMock = jest.fn()
        .mockResolvedValueOnce(createMockFetchResponse({ chart: { result: [] } })) // plain "MSFT" fails
        .mockResolvedValueOnce(createMockFetchResponse({ chart: { result: [] } })) // MSFT.TO fails
        .mockResolvedValueOnce(createMockFetchResponse({ chart: { result: [] } })) // MSFT.V fails
        .mockResolvedValueOnce(createMockFetchResponse({ chart: { result: [] } })); // MSFT.CN fails
      global.fetch = fetchMock;

      securityPriceRepository.findOne.mockResolvedValue(null);

      const result = await service.refreshAllPrices();

      // Should have tried plain symbol + 3 alternates
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(result.failed).toBe(1);
      expect(result.results[0].error).toBe("No price data available");
    });

    it("does not try alternates when yahoo symbol has a suffix already", async () => {
      // TSX securities get a suffix from getYahooSymbol, so yahooSymbol !== symbol
      securitiesRepository.find.mockResolvedValue([mockSecurityTSX]);

      // First call returns null data
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse({ chart: { result: [] } }),
      ) as jest.Mock;

      securityPriceRepository.findOne.mockResolvedValue(null);

      const result = await service.refreshAllPrices();

      // Should only try RY.TO, not alternates (because yahooSymbol !== representative.symbol)
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(result.failed).toBe(1);
    });

    it("handles API returning non-ok response", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      // All calls return 500 (primary + alternates since NASDAQ has empty suffix)
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse({}, false, 500),
      ) as jest.Mock;

      const result = await service.refreshAllPrices();

      expect(result.failed).toBe(1);
    });

    it("handles fetch throwing an error", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      global.fetch = jest.fn().mockRejectedValue(
        new Error("Network error"),
      ) as jest.Mock;

      const result = await service.refreshAllPrices();

      expect(result.failed).toBe(1);
    });

    it("updates existing price entry instead of creating new one", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      const yahooData = makeYahooChartResponse();
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(yahooData),
      ) as jest.Mock;

      // savePriceData: findOne returns existing entry
      const existingPrice = { ...mockPriceEntry };
      securityPriceRepository.findOne.mockResolvedValue(existingPrice);

      await service.refreshAllPrices();

      // Should update existing, not create new
      expect(securityPriceRepository.create).not.toHaveBeenCalled();
      expect(securityPriceRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          closePrice: 193.5,
          source: "yahoo_finance",
        }),
      );
    });

    it("handles save error for individual security", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      const yahooData = makeYahooChartResponse();
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(yahooData),
      ) as jest.Mock;

      securityPriceRepository.findOne.mockResolvedValue(null);
      securityPriceRepository.save.mockRejectedValue(new Error("DB write failed"));

      const result = await service.refreshAllPrices();

      expect(result.failed).toBe(1);
      expect(result.results[0]).toEqual(
        expect.objectContaining({
          symbol: "AAPL",
          success: false,
          error: "DB write failed",
        }),
      );
    });

    it("deduplicates API calls for securities with same symbol and exchange", async () => {
      const sec1: Security = {
        ...mockSecurity,
        id: "sec-1",
        userId: "user-1",
      } as Security;
      const sec2: Security = {
        ...mockSecurity,
        id: "sec-10",
        userId: "user-2",
      } as Security;
      securitiesRepository.find.mockResolvedValue([sec1, sec2]);

      const yahooData = makeYahooChartResponse();
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(yahooData),
      ) as jest.Mock;

      securityPriceRepository.findOne.mockResolvedValue(null);

      const result = await service.refreshAllPrices();

      // Only 1 fetch call for the deduplicated group
      expect(global.fetch).toHaveBeenCalledTimes(1);
      // But both securities are updated
      expect(result.updated).toBe(2);
      expect(result.totalSecurities).toBe(2);
    });

    it("handles quote with no regularMarketPrice", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      // Build a response where regularMarketPrice is explicitly undefined
      const yahooData = {
        chart: {
          result: [{ meta: { symbol: "AAPL", regularMarketTime: 1748800000 } }],
        },
      };
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(yahooData),
      ) as jest.Mock;

      const result = await service.refreshAllPrices();

      expect(result.failed).toBe(1);
      expect(result.results[0].error).toBe("No price data available");
    });
  });

  describe("refreshPricesForSecurities", () => {
    it("returns empty summary when no matching securities found", async () => {
      securitiesRepository.find.mockResolvedValue([]);

      const result = await service.refreshPricesForSecurities(["nonexistent"]);

      expect(result.totalSecurities).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.results).toHaveLength(0);
    });

    it("successfully refreshes prices for specific securities", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      const yahooData = makeYahooChartResponse();
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(yahooData),
      ) as jest.Mock;

      securityPriceRepository.findOne.mockResolvedValue(null);

      const result = await service.refreshPricesForSecurities(["sec-1"]);

      expect(result.totalSecurities).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.results[0].price).toBe(193.5);
    });

    it("handles mixed success and failure", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity, mockSecurityTSX]);

      const fetchMock = jest.fn()
        .mockResolvedValueOnce(createMockFetchResponse(makeYahooChartResponse()))
        .mockResolvedValueOnce(createMockFetchResponse({ chart: { result: [] } }));
      global.fetch = fetchMock;

      securityPriceRepository.findOne.mockResolvedValue(null);

      const result = await service.refreshPricesForSecurities(["sec-1", "sec-2"]);

      expect(result.totalSecurities).toBe(2);
      // One succeeds, one fails (order may vary due to Promise.all)
      expect(result.updated + result.failed).toBe(2);
    });

    it("tries alternate symbols when primary fetch fails", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurityNoExchange]);

      const fetchMock = jest.fn()
        .mockResolvedValueOnce(createMockFetchResponse({ chart: { result: [] } })) // MSFT
        .mockResolvedValueOnce(createMockFetchResponse(makeYahooChartResponse({ symbol: "MSFT.TO" }))); // MSFT.TO succeeds
      global.fetch = fetchMock;

      securityPriceRepository.findOne.mockResolvedValue(null);

      const result = await service.refreshPricesForSecurities(["sec-3"]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.updated).toBe(1);
    });

    it("handles save failure for a security", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      const yahooData = makeYahooChartResponse();
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(yahooData),
      ) as jest.Mock;

      securityPriceRepository.findOne.mockResolvedValue(null);
      securityPriceRepository.save.mockRejectedValue(new Error("Constraint violation"));

      const result = await service.refreshPricesForSecurities(["sec-1"]);

      expect(result.failed).toBe(1);
      expect(result.results[0].error).toBe("Constraint violation");
    });
  });

  describe("lookupSecurity", () => {
    it("returns best match from Yahoo Finance search", async () => {
      const searchData = makeYahooSearchResponse([
        {
          symbol: "AAPL",
          shortname: "Apple Inc.",
          longname: "Apple Inc.",
          exchDisp: "NASDAQ",
          typeDisp: "Equity",
        },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(searchData),
      ) as jest.Mock;

      const result = await service.lookupSecurity("AAPL");

      expect(result).toEqual({
        symbol: "AAPL",
        name: "Apple Inc.",
        exchange: "NASDAQ", // falls back to exchDisp when no symbol suffix
        securityType: "STOCK",
        currencyCode: "USD",
      });
    });

    it("returns null when no quotes found", async () => {
      const searchData = makeYahooSearchResponse([]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(searchData),
      ) as jest.Mock;

      const result = await service.lookupSecurity("ZZZZZZ");

      expect(result).toBeNull();
    });

    it("returns null on API error", async () => {
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse({}, false, 500),
      ) as jest.Mock;

      const result = await service.lookupSecurity("AAPL");

      expect(result).toBeNull();
    });

    it("returns null when fetch throws", async () => {
      global.fetch = jest.fn().mockRejectedValue(
        new Error("Network failure"),
      ) as jest.Mock;

      const result = await service.lookupSecurity("AAPL");

      expect(result).toBeNull();
    });

    it("prefers exact symbol match among prioritized results", async () => {
      const searchData = makeYahooSearchResponse([
        {
          symbol: "RY.L",
          shortname: "Reckitt",
          longname: "Reckitt Benckiser",
          exchDisp: "London",
          typeDisp: "Equity",
        },
        {
          symbol: "RY.TO",
          shortname: "Royal Bank",
          longname: "Royal Bank of Canada",
          exchDisp: "Toronto",
          typeDisp: "Equity",
        },
        {
          symbol: "RY",
          shortname: "Royal Bank US",
          longname: "Royal Bank of Canada",
          exchDisp: "NYSE",
          typeDisp: "Equity",
        },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(searchData),
      ) as jest.Mock;

      const result = await service.lookupSecurity("RY");

      // After sorting by priority, TSX (.TO) is priority 1, then US (no suffix) priority 2, then LSE (.L) priority 3
      // Exact match for "RY" base symbol: RY.TO has base "RY", RY has base "RY"
      // The find picks the first exact match in sorted order, which is RY.TO (priority 1)
      expect(result).toEqual(
        expect.objectContaining({
          symbol: "RY",
          exchange: "TSX",
          currencyCode: "CAD",
        }),
      );
    });

    it("falls back to first sorted result when no exact symbol match", async () => {
      const searchData = makeYahooSearchResponse([
        {
          symbol: "SHOP",
          shortname: "Shopify",
          longname: "Shopify Inc.",
          exchDisp: "NYSE",
          typeDisp: "Equity",
        },
        {
          symbol: "SHOP.TO",
          shortname: "Shopify TSX",
          longname: "Shopify Inc.",
          exchDisp: "Toronto",
          typeDisp: "Equity",
        },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(searchData),
      ) as jest.Mock;

      // Query "Shopify" won't match any base symbol exactly
      const result = await service.lookupSecurity("Shopify");

      // SHOP.TO is TSX (priority 1), so it sorts first
      expect(result).toEqual(
        expect.objectContaining({
          symbol: "SHOP",
          exchange: "TSX",
          currencyCode: "CAD",
        }),
      );
    });

    it("maps ETF type correctly", async () => {
      const searchData = makeYahooSearchResponse([
        {
          symbol: "SPY",
          shortname: "SPDR S&P 500 ETF",
          longname: "SPDR S&P 500 ETF Trust",
          exchDisp: "ARCA",
          typeDisp: "ETF",
        },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(searchData),
      ) as jest.Mock;

      const result = await service.lookupSecurity("SPY");

      expect(result).toEqual(
        expect.objectContaining({
          securityType: "ETF",
        }),
      );
    });

    it("maps Mutual Fund type correctly", async () => {
      const searchData = makeYahooSearchResponse([
        {
          symbol: "VFIAX",
          longname: "Vanguard 500 Index Fund",
          typeDisp: "Mutual Fund",
        },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(searchData),
      ) as jest.Mock;

      const result = await service.lookupSecurity("VFIAX");

      expect(result!.securityType).toBe("MUTUAL_FUND");
    });

    it("returns null securityType for unknown type", async () => {
      const searchData = makeYahooSearchResponse([
        {
          symbol: "X",
          longname: "Something",
          typeDisp: "UnknownType",
        },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(searchData),
      ) as jest.Mock;

      const result = await service.lookupSecurity("X");

      expect(result!.securityType).toBeNull();
    });

    it("uses shortname when longname is unavailable", async () => {
      const searchData = makeYahooSearchResponse([
        {
          symbol: "TSLA",
          shortname: "Tesla Inc",
        },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(searchData),
      ) as jest.Mock;

      const result = await service.lookupSecurity("TSLA");

      expect(result!.name).toBe("Tesla Inc");
    });

    it("uses symbol as name when both longname and shortname are missing", async () => {
      const searchData = makeYahooSearchResponse([
        {
          symbol: "XYZ",
        },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(searchData),
      ) as jest.Mock;

      const result = await service.lookupSecurity("XYZ");

      expect(result!.name).toBe("XYZ");
    });

    it("correctly maps various exchange suffixes to currencies", async () => {
      // Test .AX -> ASX -> AUD
      const searchData = makeYahooSearchResponse([
        {
          symbol: "BHP.AX",
          longname: "BHP Group",
          exchDisp: "ASX",
          typeDisp: "Equity",
        },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(searchData),
      ) as jest.Mock;

      const result = await service.lookupSecurity("BHP");

      expect(result).toEqual(
        expect.objectContaining({
          symbol: "BHP",
          exchange: "ASX",
          currencyCode: "AUD",
        }),
      );
    });

    it("handles the .HK suffix correctly", async () => {
      const searchData = makeYahooSearchResponse([
        {
          symbol: "0005.HK",
          longname: "HSBC Holdings",
          typeDisp: "Equity",
        },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(searchData),
      ) as jest.Mock;

      const result = await service.lookupSecurity("0005");

      expect(result).toEqual(
        expect.objectContaining({
          symbol: "0005",
          exchange: "HKEX",
          currencyCode: "HKD",
        }),
      );
    });
  });

  describe("backfillHistoricalPrices", () => {
    it("handles no active securities", async () => {
      securitiesRepository.find.mockResolvedValue([]);
      dataSourceMock.query.mockResolvedValueOnce([]);

      const result = await service.backfillHistoricalPrices();

      expect(result.totalSecurities).toBe(0);
      expect(result.successful).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.totalPricesLoaded).toBe(0);
    });

    it("skips securities with no investment transactions", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      // No transactions for this security
      dataSourceMock.query.mockResolvedValueOnce([]);

      const fetchSpy = jest.fn();
      global.fetch = fetchSpy;

      const result = await service.backfillHistoricalPrices();

      expect(result.successful).toBe(1);
      expect(result.results[0]).toEqual(
        expect.objectContaining({
          symbol: "AAPL",
          success: true,
          pricesLoaded: 0,
        }),
      );
      // Should not have called fetch since no transaction dates
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("successfully backfills historical prices", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      dataSourceMock.query
        .mockResolvedValueOnce([
          { security_id: "sec-1", earliest: "2025-05-01" },
        ]);

      const historicalData = makeYahooHistoricalResponse({
        timestamps: [1748700000, 1748800000],
        closes: [193.0, 194.0],
      });
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(historicalData),
      ) as jest.Mock;

      // Second query call is the INSERT
      dataSourceMock.query.mockResolvedValue(undefined);

      const result = await service.backfillHistoricalPrices();

      expect(result.successful).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.totalPricesLoaded).toBeGreaterThan(0);
    });

    it("handles Yahoo API returning no historical data", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      dataSourceMock.query.mockResolvedValueOnce([
        { security_id: "sec-1", earliest: "2025-01-01" },
      ]);

      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse({ chart: { result: [] } }),
      ) as jest.Mock;

      const result = await service.backfillHistoricalPrices();

      expect(result.failed).toBe(1);
      expect(result.results[0].error).toBe("No historical data available");
    });

    it("handles database insert failure", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      dataSourceMock.query
        .mockResolvedValueOnce([
          { security_id: "sec-1", earliest: "2020-01-01" },
        ])
        .mockRejectedValueOnce(new Error("INSERT failed"));

      const historicalData = makeYahooHistoricalResponse();
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(historicalData),
      ) as jest.Mock;

      const result = await service.backfillHistoricalPrices();

      expect(result.failed).toBe(1);
      expect(result.results[0].error).toBe("INSERT failed");
    });

    it("tries alternate symbols when primary fails for backfill", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurityNoExchange]);
      dataSourceMock.query
        .mockResolvedValueOnce([
          { security_id: "sec-3", earliest: "2025-01-01" },
        ]);

      const fetchMock = jest.fn()
        .mockResolvedValueOnce(createMockFetchResponse({ chart: { result: [] } })) // MSFT fails
        .mockResolvedValueOnce(createMockFetchResponse(makeYahooHistoricalResponse())); // MSFT.TO succeeds
      global.fetch = fetchMock;

      dataSourceMock.query.mockResolvedValue(undefined);

      const result = await service.backfillHistoricalPrices();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.successful).toBe(1);
    });

    it("deduplicates API calls for same symbol/exchange group", async () => {
      const sec1 = { ...mockSecurity, id: "sec-1", userId: "user-1" } as Security;
      const sec2 = { ...mockSecurity, id: "sec-10", userId: "user-2" } as Security;
      securitiesRepository.find.mockResolvedValue([sec1, sec2]);

      dataSourceMock.query
        .mockResolvedValueOnce([
          { security_id: "sec-1", earliest: "2025-01-01" },
          { security_id: "sec-10", earliest: "2025-03-01" },
        ]);

      const historicalData = makeYahooHistoricalResponse({
        timestamps: [1748700000, 1748800000],
      });
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(historicalData),
      ) as jest.Mock;

      dataSourceMock.query.mockResolvedValue(undefined);

      const result = await service.backfillHistoricalPrices();

      // Only 1 fetch call for the deduplicated group
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(result.successful).toBe(2);
    });

    it("filters prices to per-security earliest transaction date", async () => {
      // Two securities in different groups with different earliest dates
      const sec1 = { ...mockSecurity, id: "sec-1" } as Security;
      securitiesRepository.find.mockResolvedValue([sec1]);

      // Earliest transaction is far in the future relative to prices
      dataSourceMock.query
        .mockResolvedValueOnce([
          { security_id: "sec-1", earliest: "2099-01-01" },
        ]);

      const historicalData = makeYahooHistoricalResponse({
        timestamps: [1748700000, 1748800000],
        closes: [193.0, 194.0],
      });
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(historicalData),
      ) as jest.Mock;

      dataSourceMock.query.mockResolvedValue(undefined);

      const result = await service.backfillHistoricalPrices();

      // All prices are before 2099, so 0 prices loaded
      expect(result.results[0].pricesLoaded).toBe(0);
      expect(result.results[0].success).toBe(true);
    });

    it("handles historical response with null close prices", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      dataSourceMock.query.mockResolvedValueOnce([
        { security_id: "sec-1", earliest: "2020-01-01" },
      ]);

      // Response where some close values are null
      const historicalData = {
        chart: {
          result: [
            {
              timestamp: [1748700000, 1748800000, 1748900000],
              indicators: {
                quote: [
                  {
                    open: [190.0, null, 192.0],
                    high: [195.0, null, 197.0],
                    low: [189.0, null, 191.0],
                    close: [193.0, null, 195.0], // middle one is null -> skipped
                    volume: [50000000, null, 52000000],
                  },
                ],
              },
            },
          ],
        },
      };
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(historicalData),
      ) as jest.Mock;

      dataSourceMock.query.mockResolvedValue(undefined);

      const result = await service.backfillHistoricalPrices();

      // Only 2 valid prices (the null close is skipped)
      expect(result.successful).toBe(1);
      expect(result.results[0].pricesLoaded).toBe(2);
    });
  });

  describe("scheduledPriceRefresh", () => {
    it("calls refreshAllPrices", async () => {
      securitiesRepository.find.mockResolvedValue([]);

      await service.scheduledPriceRefresh();

      expect(securitiesRepository.find).toHaveBeenCalled();
    });

    it("does not throw when refreshAllPrices fails", async () => {
      securitiesRepository.find.mockRejectedValue(new Error("DB down"));

      await expect(service.scheduledPriceRefresh()).resolves.not.toThrow();
    });
  });

  describe("getYahooSymbol (via refreshAllPrices)", () => {
    // We test the private getYahooSymbol indirectly through public methods

    it("adds .TO suffix for TSX exchange", async () => {
      securitiesRepository.find.mockResolvedValue([
        { ...mockSecurity, symbol: "RY", exchange: "TSX" },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(makeYahooChartResponse()),
      ) as jest.Mock;
      securityPriceRepository.findOne.mockResolvedValue(null);

      await service.refreshAllPrices();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("RY.TO"),
        expect.any(Object),
      );
    });

    it("adds .V suffix for TSX-V exchange", async () => {
      securitiesRepository.find.mockResolvedValue([
        { ...mockSecurity, symbol: "VGCX", exchange: "TSX-V" },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(makeYahooChartResponse()),
      ) as jest.Mock;
      securityPriceRepository.findOne.mockResolvedValue(null);

      await service.refreshAllPrices();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("VGCX.V"),
        expect.any(Object),
      );
    });

    it("adds no suffix for NYSE exchange", async () => {
      securitiesRepository.find.mockResolvedValue([
        { ...mockSecurity, symbol: "IBM", exchange: "NYSE" },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(makeYahooChartResponse()),
      ) as jest.Mock;
      securityPriceRepository.findOne.mockResolvedValue(null);

      await service.refreshAllPrices();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/IBM?"),
        expect.any(Object),
      );
    });

    it("adds no suffix for NASDAQ exchange", async () => {
      securitiesRepository.find.mockResolvedValue([
        { ...mockSecurity, symbol: "AAPL", exchange: "NASDAQ" },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(makeYahooChartResponse()),
      ) as jest.Mock;
      securityPriceRepository.findOne.mockResolvedValue(null);

      await service.refreshAllPrices();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/AAPL?"),
        expect.any(Object),
      );
    });

    it("keeps symbol with existing dot suffix as-is", async () => {
      securitiesRepository.find.mockResolvedValue([
        { ...mockSecurity, symbol: "BHP.AX", exchange: "ASX" },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(makeYahooChartResponse()),
      ) as jest.Mock;
      securityPriceRepository.findOne.mockResolvedValue(null);

      await service.refreshAllPrices();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("BHP.AX"),
        expect.any(Object),
      );
    });

    it("adds .L suffix for LSE exchange", async () => {
      securitiesRepository.find.mockResolvedValue([
        { ...mockSecurity, symbol: "VOD", exchange: "LSE" },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(makeYahooChartResponse()),
      ) as jest.Mock;
      securityPriceRepository.findOne.mockResolvedValue(null);

      await service.refreshAllPrices();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("VOD.L"),
        expect.any(Object),
      );
    });

    it("adds .HK suffix for HKEX exchange", async () => {
      securitiesRepository.find.mockResolvedValue([
        { ...mockSecurity, symbol: "0005", exchange: "HKEX" },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(makeYahooChartResponse()),
      ) as jest.Mock;
      securityPriceRepository.findOne.mockResolvedValue(null);

      await service.refreshAllPrices();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("0005.HK"),
        expect.any(Object),
      );
    });

    it("returns symbol as-is for unknown exchange", async () => {
      securitiesRepository.find.mockResolvedValue([
        { ...mockSecurity, symbol: "ABC", exchange: "UNKNOWN_EXCHANGE" },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(makeYahooChartResponse()),
      ) as jest.Mock;
      securityPriceRepository.findOne.mockResolvedValue(null);

      await service.refreshAllPrices();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/ABC?"),
        expect.any(Object),
      );
    });

    it("handles case-insensitive exchange names", async () => {
      securitiesRepository.find.mockResolvedValue([
        { ...mockSecurity, symbol: "RY", exchange: "toronto stock exchange" },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(makeYahooChartResponse()),
      ) as jest.Mock;
      securityPriceRepository.findOne.mockResolvedValue(null);

      await service.refreshAllPrices();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("RY.TO"),
        expect.any(Object),
      );
    });
  });

  describe("getTradingDate (via refreshAllPrices)", () => {
    it("uses regularMarketTime from quote when available", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      // timestamp 1748800000 -> some date
      const yahooData = makeYahooChartResponse({ regularMarketTime: 1748800000 });
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(yahooData),
      ) as jest.Mock;

      securityPriceRepository.findOne.mockResolvedValue(null);

      await service.refreshAllPrices();

      // The trading date should be derived from the timestamp
      const expectedDate = new Date(1748800000 * 1000);
      expectedDate.setHours(0, 0, 0, 0);

      expect(securityPriceRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          priceDate: expectedDate,
        }),
      );
    });

    it("falls back to current date when regularMarketTime is missing", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      const yahooData = makeYahooChartResponse({ regularMarketTime: undefined });
      // Remove regularMarketTime from meta
      yahooData.chart.result[0].meta.regularMarketTime = undefined;
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(yahooData),
      ) as jest.Mock;

      securityPriceRepository.findOne.mockResolvedValue(null);

      await service.refreshAllPrices();

      // Should use today (or adjusted for weekend)
      expect(securityPriceRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          priceDate: expect.any(Date),
        }),
      );
    });
  });

  describe("savePriceData (via refreshAllPrices)", () => {
    it("creates new price entry when none exists", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      const yahooData = makeYahooChartResponse({
        regularMarketPrice: 200.0,
        regularMarketDayHigh: 205.0,
        regularMarketDayLow: 198.0,
        regularMarketVolume: 60000000,
      });
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(yahooData),
      ) as jest.Mock;

      securityPriceRepository.findOne.mockResolvedValue(null);

      await service.refreshAllPrices();

      expect(securityPriceRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          securityId: "sec-1",
          closePrice: 200.0,
          highPrice: 205.0,
          lowPrice: 198.0,
          volume: 60000000,
          source: "yahoo_finance",
        }),
      );
      expect(securityPriceRepository.save).toHaveBeenCalled();
    });

    it("updates existing price entry when one exists for the date", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      const yahooData = makeYahooChartResponse({
        regularMarketPrice: 200.0,
        regularMarketDayHigh: 205.0,
        regularMarketDayLow: 198.0,
        regularMarketVolume: 60000000,
      });
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(yahooData),
      ) as jest.Mock;

      const existingPrice = {
        ...mockPriceEntry,
        openPrice: 188.0,
        highPrice: 190.0,
        lowPrice: 185.0,
        closePrice: 189.0,
        volume: 40000000,
      };
      securityPriceRepository.findOne.mockResolvedValue(existingPrice);

      await service.refreshAllPrices();

      // Should NOT call create
      expect(securityPriceRepository.create).not.toHaveBeenCalled();
      // Should update existing and save
      expect(securityPriceRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          closePrice: 200.0,
          highPrice: 205.0,
          lowPrice: 198.0,
          volume: 60000000,
          source: "yahoo_finance",
        }),
      );
    });

    it("preserves existing openPrice when quote has no open", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      // The service code always sets regularMarketOpen to undefined for chart API
      const yahooData = makeYahooChartResponse({
        regularMarketPrice: 200.0,
      });
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(yahooData),
      ) as jest.Mock;

      const existingPrice = {
        ...mockPriceEntry,
        openPrice: 188.0,
      };
      securityPriceRepository.findOne.mockResolvedValue(existingPrice);

      await service.refreshAllPrices();

      // openPrice should remain 188.0 because quote.regularMarketOpen is undefined
      expect(securityPriceRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          openPrice: 188.0,
        }),
      );
    });
  });

  describe("getAlternateSymbols (via refreshAllPrices)", () => {
    it("returns .TO, .V, .CN alternates for plain symbols", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurityNoExchange]);

      const fetchMock = jest.fn()
        .mockResolvedValueOnce(createMockFetchResponse({ chart: { result: [] } })) // MSFT
        .mockResolvedValueOnce(createMockFetchResponse({ chart: { result: [] } })) // MSFT.TO
        .mockResolvedValueOnce(createMockFetchResponse({ chart: { result: [] } })) // MSFT.V
        .mockResolvedValueOnce(createMockFetchResponse({ chart: { result: [] } })); // MSFT.CN
      global.fetch = fetchMock;

      await service.refreshAllPrices();

      // Verify calls: MSFT, then alternates MSFT.TO, MSFT.V, MSFT.CN
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/MSFT?"),
        expect.any(Object),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("MSFT.TO"),
        expect.any(Object),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("MSFT.V"),
        expect.any(Object),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("MSFT.CN"),
        expect.any(Object),
      );
    });

    it("stops trying alternates on first success", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurityNoExchange]);

      const fetchMock = jest.fn()
        .mockResolvedValueOnce(createMockFetchResponse({ chart: { result: [] } })) // MSFT fails
        .mockResolvedValueOnce(
          createMockFetchResponse(makeYahooChartResponse({ symbol: "MSFT.TO" })),
        ); // MSFT.TO succeeds
      global.fetch = fetchMock;

      securityPriceRepository.findOne.mockResolvedValue(null);

      const result = await service.refreshAllPrices();

      // Only 2 fetch calls: MSFT then MSFT.TO (stops after success)
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.updated).toBe(1);
    });
  });

  describe("getExchangePriority (via lookupSecurity)", () => {
    it("prioritizes TSX (.TO) over US exchanges", async () => {
      const searchData = makeYahooSearchResponse([
        { symbol: "TD", exchDisp: "NYSE", typeDisp: "Equity", longname: "TD US" },
        { symbol: "TD.TO", exchDisp: "Toronto", typeDisp: "Equity", longname: "TD Canada" },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(searchData),
      ) as jest.Mock;

      const result = await service.lookupSecurity("TD");

      // TD.TO (TSX, priority 1) should win over TD (US, priority 2)
      expect(result!.exchange).toBe("TSX");
    });

    it("prioritizes US exchanges over international", async () => {
      const searchData = makeYahooSearchResponse([
        { symbol: "VOD.L", exchDisp: "London", typeDisp: "Equity", longname: "Vodafone UK" },
        { symbol: "VOD", exchDisp: "NASDAQ", typeDisp: "Equity", longname: "Vodafone US" },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(searchData),
      ) as jest.Mock;

      const result = await service.lookupSecurity("VOD");

      // US (priority 2) should win over LSE (priority 3), and exact symbol match "VOD"
      expect(result!.exchange).toBe("NASDAQ"); // Falls back to exchDisp when no symbol suffix
      expect(result!.currencyCode).toBe("USD");
    });

    it("recognizes Canada exchange keywords in exchDisp", async () => {
      const searchData = makeYahooSearchResponse([
        { symbol: "X", exchDisp: "NYSE", typeDisp: "Equity", longname: "X US" },
        { symbol: "X", exchDisp: "Canada", typeDisp: "Equity", longname: "X Canada" },
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(searchData),
      ) as jest.Mock;

      const result = await service.lookupSecurity("X");

      // "Canada" in exchDisp maps to priority 1
      expect(result!.name).toBe("X Canada");
    });
  });
});
