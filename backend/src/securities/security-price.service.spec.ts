import { Not } from "typeorm";
import { Logger, NotFoundException } from "@nestjs/common";
import {
  SecurityPriceService,
  settlePendingPriceWrites,
} from "./security-price.service";
import { SecurityPrice } from "./entities/security-price.entity";
import {
  DEFAULT_PRICE_HISTORY_ROWS,
  MAX_PRICE_HISTORY_ROWS,
} from "./dto/price-history-query.dto";
import { Security } from "./entities/security.entity";
import { YahooFinanceService } from "./yahoo-finance.service";
import { createTestProviderHealth } from "../test-helpers/provider-health-testing";
import { ProviderHealthService } from "../provider-health/provider-health.service";
import { QuoteProviderRegistry } from "./providers/quote-provider.registry";
import { UserPreference } from "../users/entities/user-preference.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  getRequestContext,
  requestContextStorage,
} from "../common/request-context";
import {
  createFetchSyncMock,
  type FetchSyncMock,
} from "../test-helpers/job-claim-testing";
import { FetchSyncJob } from "../common/jobs/fetch-sync.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const TEST_USER_ID = "user-1";

describe("SecurityPriceService", () => {
  let service: SecurityPriceService;
  let fetchSync: FetchSyncMock;
  let securityPriceRepository: Record<string, jest.Mock>;
  let securitiesRepository: Record<string, jest.Mock>;
  let userPreferenceRepository: Record<string, jest.Mock>;
  let dataSourceMock: Record<string, jest.Mock>;
  /** The `html_table` provider double, so a spec can see what it was asked. */
  let htmlTableProvider: { fetchQuote: jest.Mock };
  /** The SQL of the last single-price upsert the service issued. */
  function priceUpsertSql(): string {
    const call = scopedManagerQuery.mock.calls
      .filter((c) => String(c[0]).includes("INSERT INTO security_prices"))
      .pop();
    return String(call?.[0] ?? "");
  }

  /** Make the next single-price upsert fail, the way a DB error would. */
  function failPriceWrite(error: Error): void {
    priceWriteError = error;
  }

  /**
   * Pretend a price row is already stored for a security and date, so the
   * upsert's `ON CONFLICT DO UPDATE` merges onto it. Replaces the old
   * `findOne.mockResolvedValue(existing)`, which stubbed a read the write path
   * no longer performs.
   */
  function seedStoredPrice(row: Record<string, unknown>): void {
    upsertedPrices.push({
      id: (row.id as number) ?? upsertedPrices.length + 1,
      securityId: row.securityId as string,
      priceDate: row.priceDate as string,
      openPrice: (row.openPrice as number) ?? null,
      highPrice: (row.highPrice as number) ?? null,
      lowPrice: (row.lowPrice as number) ?? null,
      closePrice: row.closePrice as number,
      adjustedClose: (row.adjustedClose as number) ?? null,
      volume: (row.volume as number) ?? null,
      source: (row.source as string) ?? "yahoo_finance",
      quotedAt: (row.quotedAt as Date) ?? null,
    });
  }

  /** The scoped transaction manager's `query`, for asserting on statements. */
  let scopedManagerQuery: jest.Mock;
  /** Set to make the next single-price upsert reject. */
  let priceWriteError: Error | null;
  /** Rows the single-price upsert wrote, in the shape the statement stores them. */
  let upsertedPrices: Array<{
    id: number;
    securityId: string;
    priceDate: string;
    openPrice: number | null;
    highPrice: number | null;
    lowPrice: number | null;
    closePrice: number;
    adjustedClose: number | null;
    volume: number | null;
    source: string;
    quotedAt: Date | null;
  }>;
  let netWorthService: Record<string, jest.Mock>;
  let msnFinanceService: Record<string, jest.Mock>;
  /** The real Yahoo provider the registry is built with, so tests can spy on it. */
  let yahoo: YahooFinanceService;
  let health: ProviderHealthService;
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
    priceDate: "2025-06-01",
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
            // Absent unless a test states one: Yahoo's chart meta carries
            // `currency` for some instruments and not others, and "not
            // reported" is a case of its own.
            ...(overrides.currency ? { currency: overrides.currency } : {}),
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

  const makeYahooHistoricalResponse = (
    overrides: Record<string, any> = {},
  ) => ({
    chart: {
      result: [
        {
          meta: {
            exchangeTimezoneName:
              overrides.exchangeTimezone ?? "America/New_York",
            ...(overrides.currency ? { currency: overrides.currency } : {}),
          },
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
            ...(overrides.adjcloses
              ? { adjclose: [{ adjclose: overrides.adjcloses }] }
              : {}),
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
      // Default: answer a by-id read (the price upsert's read-back) from the
      // rows the upsert recorded. Tests that care about a specific stored row
      // still override this with `mockResolvedValue`.
      findOne: jest.fn(
        async ({
          where,
        }: {
          where?: { id?: number; securityId?: string; priceDate?: string };
        } = {}) => {
          if (where?.id !== undefined) {
            return upsertedPrices.find((row) => row.id === where.id) ?? null;
          }
          // The read-back the write path falls to when its `DO UPDATE` was
          // refused, so the refusal returns the row that won.
          if (
            where?.securityId !== undefined &&
            where?.priceDate !== undefined
          ) {
            return (
              upsertedPrices.find(
                (row) =>
                  row.securityId === where.securityId &&
                  row.priceDate === where.priceDate,
              ) ?? null
            );
          }
          return null;
        },
      ),
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
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    userPreferenceRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    // Raw statements now run through the scoped transaction's manager; the
    // spec keeps asserting against this mock.
    dataSourceMock = { query: jest.fn() };

    netWorthService = {
      recalculateAllInvestmentSnapshots: jest.fn().mockResolvedValue(undefined),
      recalculateAllAccounts: jest.fn().mockResolvedValue(undefined),
      triggerDebouncedRecalc: jest.fn(),
    };

    // Mock MSN to always return null by default so most tests stay
    // Yahoo-focused. Individual tests override these to exercise the MSN path.
    msnFinanceService = {
      fetchQuote: jest.fn().mockResolvedValue(null),
      fetchHistorical: jest.fn().mockResolvedValue(null),
      // Every price write path takes the series, so the double answers with
      // the bundle the real provider returns: bars plus the currency they are
      // quoted in.
      fetchHistoricalSeries: jest.fn().mockResolvedValue(null),
      lookupSecurity: jest.fn().mockResolvedValue(null),
      fetchStockSectorInfo: jest.fn().mockResolvedValue(null),
      fetchEtfSectorWeightings: jest.fn().mockResolvedValue(null),
      resolveInstrumentId: jest.fn().mockResolvedValue(null),
      getTradingDate: jest.fn((q: { regularMarketTime?: number }) => {
        if (q.regularMarketTime) {
          const d = new Date(q.regularMarketTime * 1000);
          d.setUTCHours(0, 0, 0, 0);
          return d;
        }
        return new Date();
      }),
    };
    // The registry reads provider.name to order/resolve providers.
    (msnFinanceService as Record<string, unknown>).name = "msn";

    const { manager, dataSource } = createScopedDbMocks([
      [SecurityPrice, securityPriceRepository],
      [Security, securitiesRepository],
      [UserPreference, userPreferenceRepository],
    ]);
    // The single-price write is now one `INSERT ... ON CONFLICT DO UPDATE
    // RETURNING id`, so the spec records what it wrote and answers the by-id
    // read-back with the resulting row -- which is what the assertions are about.
    upsertedPrices = [];
    priceWriteError = null;
    scopedManagerQuery = manager.query;
    manager.query.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (
          typeof sql === "string" &&
          sql.includes("INSERT INTO security_prices") &&
          sql.includes("RETURNING id")
        ) {
          if (priceWriteError) throw priceWriteError;
          const [
            securityId,
            priceDate,
            openPrice,
            highPrice,
            lowPrice,
            closePrice,
            volume,
            source,
            quotedAt,
          ] = params as unknown[];
          const previous = upsertedPrices.find(
            (row) =>
              row.securityId === securityId && row.priceDate === priceDate,
          );
          // `WHERE security_prices.source IS DISTINCT FROM 'manual'` on the
          // `DO UPDATE`: a manual correction refuses the write and the
          // statement returns no row.
          if (previous?.source === "manual") return [];
          // The statement's `CASE WHEN EXISTS (... adjusted_close IS NOT NULL)`:
          // the close doubles as the adjusted close only for a series that is
          // already on the adjusted basis.
          const seriesIsAdjusted = upsertedPrices.some(
            (row) =>
              row.securityId === securityId && row.adjustedClose !== null,
          );
          // `COALESCE(EXCLUDED.x, security_prices.x)` in the statement: a value
          // the quote did not supply keeps whatever is stored.
          const row = {
            id: (previous?.id ?? upsertedPrices.length + 1) as number,
            securityId: securityId as string,
            priceDate: priceDate as string,
            openPrice: (openPrice ?? previous?.openPrice ?? null) as
              number | null,
            highPrice: (highPrice ?? previous?.highPrice ?? null) as
              number | null,
            lowPrice: (lowPrice ?? previous?.lowPrice ?? null) as number | null,
            closePrice: closePrice as number,
            adjustedClose: (seriesIsAdjusted
              ? (closePrice as number)
              : null) as number | null,
            volume: (volume ?? previous?.volume ?? null) as number | null,
            source: (source ?? "manual") as string,
            quotedAt: (quotedAt ?? previous?.quotedAt ?? null) as Date | null,
          };
          if (previous) Object.assign(previous, row);
          else upsertedPrices.push(row);
          return [{ id: row.id }];
        }
        return dataSourceMock.query(sql, params);
      },
    );

    health = createTestProviderHealth();
    yahoo = new YahooFinanceService(health);
    // LSE and Deutsche Börse take part in the auto fallback order; the price
    // service tests exercise Yahoo/MSN, so these stand in as inert no-ops that
    // add no fetches and answer nothing, exactly as the msn double does.
    const inertProvider = (name: string) =>
      ({
        name,
        fetchQuote: jest.fn().mockResolvedValue(null),
        fetchHistorical: jest.fn().mockResolvedValue(null),
        fetchHistoricalSeries: jest.fn().mockResolvedValue(null),
        lookupSecurity: jest.fn().mockResolvedValue(null),
        fetchStockSectorInfo: jest.fn().mockResolvedValue(null),
        fetchEtfSectorWeightings: jest.fn().mockResolvedValue(null),
        getTradingDate: jest.fn(() => new Date()),
      }) as never;
    htmlTableProvider = inertProvider("html_table") as unknown as {
      fetchQuote: jest.Mock;
    };
    const providers = new QuoteProviderRegistry(
      yahoo,
      msnFinanceService as never,
      inertProvider("lse"),
      inertProvider("deutsche_boerse"),
      htmlTableProvider as never,
    );

    fetchSync = createFetchSyncMock();
    service = new SecurityPriceService(
      dataSource as never,
      netWorthService as never,
      providers,
      fetchSync as never,
    );
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
      securityPriceRepository.createQueryBuilder.mockReturnValue(
        mockQueryBuilder,
      );

      const result = await service.getPriceHistory("sec-1");

      expect(securityPriceRepository.createQueryBuilder).toHaveBeenCalledWith(
        "sp",
      );
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        "sp.securityId = :securityId",
        { securityId: "sec-1" },
      );
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith(
        "sp.priceDate",
        "DESC",
      );
      expect(mockQueryBuilder.take).toHaveBeenCalledWith(
        DEFAULT_PRICE_HISTORY_ROWS,
      );
      expect(mockQueryBuilder.andWhere).not.toHaveBeenCalled();
      expect(result).toEqual([mockPriceEntry]);
    });

    /**
     * The rows come back newest-first and `take(n)` keeps the first `n`, so a
     * cap shorter than the history drops its *oldest* end -- silently, because
     * a shorter array is a perfectly well-formed answer. A caller asking for
     * "the last five years" would get the newest 365 days of it and no
     * indication that the rest was cut.
     */
    it("does not truncate the oldest end of a requested window", async () => {
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      securityPriceRepository.createQueryBuilder.mockReturnValue(
        mockQueryBuilder,
      );

      await service.getPriceHistory("sec-1", "2015-01-01");

      // The window bounds the result; the cap is a memory bound, not a filter.
      expect(mockQueryBuilder.take).toHaveBeenCalledWith(
        MAX_PRICE_HISTORY_ROWS,
      );
      expect(mockQueryBuilder.take).not.toHaveBeenCalledWith(365);
    });

    /**
     * "All time" is a request with no start date, so a chart asking for the
     * whole history sends only an end date. Keying the cap on `startDate` alone
     * left that case on the 365-row default -- roughly one year, handed back as
     * everything there is, with a well-formed array and nothing to say so.
     */
    it("does not truncate a window that is open at its start", async () => {
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      securityPriceRepository.createQueryBuilder.mockReturnValue(
        mockQueryBuilder,
      );

      await service.getPriceHistory("sec-1", undefined, "2026-08-06");

      expect(mockQueryBuilder.take).toHaveBeenCalledWith(
        MAX_PRICE_HISTORY_ROWS,
      );
      expect(mockQueryBuilder.take).not.toHaveBeenCalledWith(
        DEFAULT_PRICE_HISTORY_ROWS,
      );
    });

    it("still honours an explicit limit alongside a window", async () => {
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      securityPriceRepository.createQueryBuilder.mockReturnValue(
        mockQueryBuilder,
      );

      await service.getPriceHistory("sec-1", "2015-01-01", undefined, 50);

      expect(mockQueryBuilder.take).toHaveBeenCalledWith(50);
    });

    it("applies startDate filter when provided", async () => {
      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      securityPriceRepository.createQueryBuilder.mockReturnValue(
        mockQueryBuilder,
      );

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
      securityPriceRepository.createQueryBuilder.mockReturnValue(
        mockQueryBuilder,
      );

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
      securityPriceRepository.createQueryBuilder.mockReturnValue(
        mockQueryBuilder,
      );

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
      securityPriceRepository.createQueryBuilder.mockReturnValue(
        mockQueryBuilder,
      );

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
        // A bond-engine row is written every day by accrual: it is not a quote
        // provider's write, and counting it would hide a provider outage.
        where: { source: Not("bond_engine") },
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
    /**
     * Prices are keyed by symbol, not by owner, so one fetch serves every holder
     * and this is global by definition. The system context used to live only in the
     * cron, leaving the admin maintenance endpoint reading `securities` in the
     * requesting admin's own scope -- global at RLS_MODE=off, and silently narrowed
     * to "the admin's own holdings" the moment enforcement is switched on, which
     * would stop the maintenance endpoint doing maintenance.
     */
    it("runs under a system context regardless of the caller", async () => {
      let ctx: ReturnType<typeof getRequestContext>;
      securitiesRepository.find.mockImplementation(() => {
        ctx = getRequestContext();
        return Promise.resolve([]);
      });

      await requestContextStorage.run({ userId: "admin-1" }, () =>
        service.refreshAllPrices(),
      );

      expect(ctx).toMatchObject({ system: true });
      expect(ctx).not.toHaveProperty("userId");
    });

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
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(yahooData)) as jest.Mock;

      // savePriceData: findOne returns null (new price), then create and save

      const result = await service.refreshAllPrices();

      expect(result.results[0].error).toBeUndefined();
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
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(yahooData)) as jest.Mock;

      await service.refreshAllPrices();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("RY.TO"),
        expect.any(Object),
      );
    });

    it("tries alternate symbols when primary fetch returns null", async () => {
      // Security with no exchange (defaults to US) but no data under plain symbol
      securitiesRepository.find.mockResolvedValue([mockSecurityNoExchange]);

      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          createMockFetchResponse({ chart: { result: [] } }),
        ) // plain "MSFT" fails
        .mockResolvedValueOnce(
          createMockFetchResponse({ chart: { result: [] } }),
        ) // MSFT.TO fails
        .mockResolvedValueOnce(
          createMockFetchResponse({ chart: { result: [] } }),
        ) // MSFT.V fails
        .mockResolvedValueOnce(
          createMockFetchResponse({ chart: { result: [] } }),
        ); // MSFT.CN fails
      global.fetch = fetchMock;

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
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse({ chart: { result: [] } }),
        ) as jest.Mock;

      const result = await service.refreshAllPrices();

      // Should only try RY.TO, not alternates (because yahooSymbol !== representative.symbol)
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(result.failed).toBe(1);
    });

    it("handles API returning non-ok response", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      // All calls return 500 (primary + alternates since NASDAQ has empty suffix)
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse({}, false, 500),
        ) as jest.Mock;

      const result = await service.refreshAllPrices();

      expect(result.failed).toBe(1);
    });

    it("handles fetch throwing an error", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error("Network error")) as jest.Mock;

      const result = await service.refreshAllPrices();

      expect(result.failed).toBe(1);
    });

    it("updates existing price entry instead of creating new one", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      const yahooData = makeYahooChartResponse();
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(yahooData)) as jest.Mock;

      // savePriceData: findOne returns existing entry
      const existingPrice = { ...mockPriceEntry };
      // A row already stored for this security and date: the upsert's
      // `ON CONFLICT DO UPDATE` merges onto it rather than inserting.
      seedStoredPrice(existingPrice);

      await service.refreshAllPrices();

      // Merged onto the stored row, not inserted alongside it.
      expect(upsertedPrices).toHaveLength(1);
      expect(upsertedPrices[0]).toMatchObject({
        closePrice: 193.5,
        source: "yahoo_finance",
      });
    });

    it("handles save error for individual security", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      const yahooData = makeYahooChartResponse();
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(yahooData)) as jest.Mock;

      failPriceWrite(new Error("DB write failed"));

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
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(yahooData)) as jest.Mock;

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
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(yahooData)) as jest.Mock;

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
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(yahooData)) as jest.Mock;

      const result = await service.refreshPricesForSecurities(["sec-1"]);

      expect(result.totalSecurities).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.results[0].price).toBe(193.5);
    });

    it("handles mixed success and failure", async () => {
      securitiesRepository.find.mockResolvedValue([
        mockSecurity,
        mockSecurityTSX,
      ]);

      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          createMockFetchResponse(makeYahooChartResponse()),
        )
        .mockResolvedValueOnce(
          createMockFetchResponse({ chart: { result: [] } }),
        );
      global.fetch = fetchMock;

      const result = await service.refreshPricesForSecurities([
        "sec-1",
        "sec-2",
      ]);

      expect(result.totalSecurities).toBe(2);
      // One succeeds, one fails (order may vary due to Promise.all)
      expect(result.updated + result.failed).toBe(2);
    });

    it("tries alternate symbols when primary fetch fails", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurityNoExchange]);

      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          createMockFetchResponse({ chart: { result: [] } }),
        ) // MSFT
        .mockResolvedValueOnce(
          createMockFetchResponse(
            makeYahooChartResponse({ symbol: "MSFT.TO" }),
          ),
        ); // MSFT.TO succeeds
      global.fetch = fetchMock;

      const result = await service.refreshPricesForSecurities(["sec-3"]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.updated).toBe(1);
    });

    it("handles save failure for a security", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      const yahooData = makeYahooChartResponse();
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(yahooData)) as jest.Mock;

      failPriceWrite(new Error("Constraint violation"));

      const result = await service.refreshPricesForSecurities(["sec-1"]);

      expect(result.failed).toBe(1);
      expect(result.results[0].error).toBe("Constraint violation");
    });
  });

  describe("securities priced from a web page are grouped by the page", () => {
    const onPage = (id: string, quoteUrl: string): Security =>
      ({
        ...mockSecurity,
        id,
        symbol: "ACME",
        exchange: null,
        quoteProvider: "html_table",
        quoteUrl,
      }) as Security;

    it("asks each page, not one page for two owners' look-alike symbols", async () => {
      securitiesRepository.find.mockResolvedValue([
        onPage("sec-a", "https://one.example/prices"),
        onPage("sec-b", "https://two.example/prices"),
      ]);

      await service.refreshAllPrices();

      const asked = htmlTableProvider.fetchQuote.mock.calls
        .map((call) => call[2]?.quoteUrl)
        .sort();
      expect(asked).toEqual([
        "https://one.example/prices",
        "https://two.example/prices",
      ]);
    });

    it("still shares one fetch between securities naming the same page", async () => {
      securitiesRepository.find.mockResolvedValue([
        onPage("sec-a", "https://one.example/prices"),
      ]);
      await service.refreshAllPrices();
      const forOne = htmlTableProvider.fetchQuote.mock.calls.length;
      htmlTableProvider.fetchQuote.mockClear();

      securitiesRepository.find.mockResolvedValue([
        onPage("sec-a", "https://one.example/prices"),
        onPage("sec-b", "https://one.example/prices"),
      ]);
      await service.refreshAllPrices();

      expect(forOne).toBeGreaterThan(0);
      expect(htmlTableProvider.fetchQuote).toHaveBeenCalledTimes(forOne);
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
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(searchData)) as jest.Mock;

      const result = await service.lookupSecurity(TEST_USER_ID, "AAPL");

      expect(result).toEqual({
        symbol: "AAPL",
        name: "Apple Inc.",
        exchange: "NASDAQ", // falls back to exchDisp when no symbol suffix
        securityType: "STOCK",
        currencyCode: "USD",
        provider: "yahoo",
      });
    });

    it("returns null when no quotes found", async () => {
      const searchData = makeYahooSearchResponse([]);
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(searchData)) as jest.Mock;

      const result = await service.lookupSecurity(TEST_USER_ID, "ZZZZZZ");

      expect(result).toBeNull();
    });

    it("returns null on API error", async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse({}, false, 500),
        ) as jest.Mock;

      const result = await service.lookupSecurity(TEST_USER_ID, "AAPL");

      expect(result).toBeNull();
    });

    it("returns null when fetch throws", async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error("Network failure")) as jest.Mock;

      const result = await service.lookupSecurity(TEST_USER_ID, "AAPL");

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
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(searchData)) as jest.Mock;

      const result = await service.lookupSecurity(TEST_USER_ID, "RY");

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
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(searchData)) as jest.Mock;

      // Query "Shopify" won't match any base symbol exactly
      const result = await service.lookupSecurity(TEST_USER_ID, "Shopify");

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
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(searchData)) as jest.Mock;

      const result = await service.lookupSecurity(TEST_USER_ID, "SPY");

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
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(searchData)) as jest.Mock;

      const result = await service.lookupSecurity(TEST_USER_ID, "VFIAX");

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
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(searchData)) as jest.Mock;

      const result = await service.lookupSecurity(TEST_USER_ID, "X");

      expect(result!.securityType).toBeNull();
    });

    it("uses shortname when longname is unavailable", async () => {
      const searchData = makeYahooSearchResponse([
        {
          symbol: "TSLA",
          shortname: "Tesla Inc",
        },
      ]);
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(searchData)) as jest.Mock;

      const result = await service.lookupSecurity(TEST_USER_ID, "TSLA");

      expect(result!.name).toBe("Tesla Inc");
    });

    it("uses symbol as name when both longname and shortname are missing", async () => {
      const searchData = makeYahooSearchResponse([
        {
          symbol: "XYZ",
        },
      ]);
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(searchData)) as jest.Mock;

      const result = await service.lookupSecurity(TEST_USER_ID, "XYZ");

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
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(searchData)) as jest.Mock;

      const result = await service.lookupSecurity(TEST_USER_ID, "BHP");

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
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(searchData)) as jest.Mock;

      const result = await service.lookupSecurity(TEST_USER_ID, "0005");

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

    it("backfills 1Y of daily prices for securities with no investment transactions", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      // No transactions for this security
      dataSourceMock.query.mockResolvedValueOnce([]);

      // Timestamps relative to "now" so the prices always land inside the
      // rolling 1-year backfill window (cutoff = today - 1y), regardless of
      // when the test runs. Hardcoded dates here rot once the window passes
      // them.
      const daySeconds = 24 * 60 * 60;
      const nowSeconds = Math.floor(Date.now() / 1000);
      const historicalData = makeYahooHistoricalResponse({
        timestamps: [nowSeconds - 2 * daySeconds, nowSeconds - daySeconds],
        closes: [193.0, 194.0],
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(historicalData),
        ) as jest.Mock;

      dataSourceMock.query.mockResolvedValue(undefined);

      const result = await service.backfillHistoricalPrices();

      expect(result.successful).toBe(1);
      expect(result.totalPricesLoaded).toBeGreaterThan(0);
      // Should fetch 1Y daily data even without transactions
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain(
        "range=1y",
      );
    });

    // Issue #1389: `deactivate` refuses while a holding is non-zero, so an
    // inactive security is one that was held and sold out -- and the days it
    // was held still have to be valued. The backfill is the only operation that
    // fills price HISTORY, so skipping it there left that holding period
    // permanently unpriced on "Portfolio value over time".
    it("backfills an inactive security that was once held (#1389)", async () => {
      const soldOut = { ...mockSecurity, id: "sec-sold", isActive: false };
      securitiesRepository.find.mockResolvedValue([soldOut]);
      dataSourceMock.query.mockResolvedValueOnce([
        { security_id: "sec-sold", earliest: "2025-05-01" },
      ]);

      const historicalData = makeYahooHistoricalResponse({
        timestamps: [1748700000, 1748800000],
        closes: [193.0, 194.0],
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(historicalData),
        ) as jest.Mock;
      dataSourceMock.query.mockResolvedValue(undefined);

      const result = await service.backfillHistoricalPrices();

      expect(result.totalSecurities).toBe(1);
      expect(result.successful).toBe(1);
      expect(global.fetch).toHaveBeenCalled();
    });

    // The other side of the same predicate: an inactive security nobody ever
    // transacted has no holding period to value, so it stays out.
    it("leaves an inactive, never-held security out of the backfill (#1389)", async () => {
      securitiesRepository.find.mockResolvedValue([
        { ...mockSecurity, id: "sec-watch", isActive: false },
      ]);
      dataSourceMock.query.mockResolvedValueOnce([]);
      global.fetch = jest.fn() as jest.Mock;

      const result = await service.backfillHistoricalPrices();

      expect(result.totalSecurities).toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("successfully backfills historical prices", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      dataSourceMock.query.mockResolvedValueOnce([
        { security_id: "sec-1", earliest: "2025-05-01" },
      ]);

      const historicalData = makeYahooHistoricalResponse({
        timestamps: [1748700000, 1748800000],
        closes: [193.0, 194.0],
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(
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

      global.fetch = jest
        .fn()
        .mockResolvedValue(
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
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(historicalData),
        ) as jest.Mock;

      const result = await service.backfillHistoricalPrices();

      expect(result.failed).toBe(1);
      expect(result.results[0].error).toBe("INSERT failed");
    });

    it("tries alternate symbols when primary fails for backfill", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurityNoExchange]);
      dataSourceMock.query.mockResolvedValueOnce([
        { security_id: "sec-3", earliest: "2026-01-01" },
      ]);

      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          createMockFetchResponse({ chart: { result: [] } }),
        ) // MSFT 1y fails
        .mockResolvedValueOnce(
          createMockFetchResponse(makeYahooHistoricalResponse()),
        ); // MSFT.TO 1y succeeds
      global.fetch = fetchMock;

      dataSourceMock.query.mockResolvedValue(undefined);

      const result = await service.backfillHistoricalPrices();

      // 2 calls: MSFT 1y (fails) -> MSFT.TO 1y (succeeds)
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.successful).toBe(1);
    });

    it("deduplicates API calls for same symbol/exchange group", async () => {
      const sec1 = {
        ...mockSecurity,
        id: "sec-1",
        userId: "user-1",
      } as Security;
      const sec2 = {
        ...mockSecurity,
        id: "sec-10",
        userId: "user-2",
      } as Security;
      securitiesRepository.find.mockResolvedValue([sec1, sec2]);

      dataSourceMock.query.mockResolvedValueOnce([
        { security_id: "sec-1", earliest: "2026-01-01" },
        { security_id: "sec-10", earliest: "2026-02-01" },
      ]);

      const historicalData = makeYahooHistoricalResponse({
        timestamps: [1748700000, 1748800000],
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(historicalData),
        ) as jest.Mock;

      dataSourceMock.query.mockResolvedValue(undefined);

      const result = await service.backfillHistoricalPrices();

      // 1 fetch for 1y daily data (no max needed since earliest tx is within 1y)
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(result.successful).toBe(2);
    });

    it("uses 1Y lookback even when earliest transaction is in the future", async () => {
      // Earliest transaction is far in the future, but we still backfill 1Y
      const sec1 = { ...mockSecurity, id: "sec-1" } as Security;
      securitiesRepository.find.mockResolvedValue([sec1]);

      dataSourceMock.query.mockResolvedValueOnce([
        { security_id: "sec-1", earliest: "2099-01-01" },
      ]);

      // Use timestamps relative to "now" so both prices fall inside backfill's
      // rolling one-year lookback window. With the earliest transaction in the
      // future, the cutoff is pinned to one-year-ago, so hardcoded calendar
      // dates became a date-bomb: once a year elapsed past them the boundary
      // price dropped out of the window and only one price was counted.
      const daySec = 24 * 60 * 60;
      const nowSec = Math.floor(Date.now() / 1000);
      const historicalData = makeYahooHistoricalResponse({
        timestamps: [nowSec - 10 * daySec, nowSec - 5 * daySec],
        closes: [193.0, 194.0],
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(historicalData),
        ) as jest.Mock;

      dataSourceMock.query.mockResolvedValue(undefined);

      const result = await service.backfillHistoricalPrices();

      // Prices within 1Y are loaded even though earliest tx is 2099
      expect(result.results[0].pricesLoaded).toBe(2);
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
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(historicalData),
        ) as jest.Mock;

      dataSourceMock.query.mockResolvedValue(undefined);

      const result = await service.backfillHistoricalPrices();

      // Only 2 valid prices (the null close is skipped)
      expect(result.successful).toBe(1);
      expect(result.results[0].pricesLoaded).toBe(2);
    });

    it("fetches both 1y and max range when transactions exist before 1Y ago", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      // Earliest transaction is more than 1 year ago
      dataSourceMock.query.mockResolvedValueOnce([
        { security_id: "sec-1", earliest: "2020-01-01" },
      ]);

      const historicalData = makeYahooHistoricalResponse({
        timestamps: [1748700000, 1748800000],
        closes: [193.0, 194.0],
      });
      const fetchMock = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(historicalData),
        ) as jest.Mock;
      global.fetch = fetchMock;

      dataSourceMock.query.mockResolvedValue(undefined);

      const result = await service.backfillHistoricalPrices();

      // 2 fetches: 1y for daily data + max for older monthly data
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toContain("range=1y");
      expect(fetchMock.mock.calls[1][0]).toContain("range=max");
      expect(result.successful).toBe(1);
      expect(result.totalPricesLoaded).toBeGreaterThan(0);
    });
  });

  describe("backfillSecurity", () => {
    it("skips securities with skipPriceUpdates", async () => {
      const skipSec = { ...mockSecurity, skipPriceUpdates: true } as Security;
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy;

      await service.backfillSecurity(skipSec);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("fetches 1Y of daily prices for a single security", async () => {
      const historicalData = makeYahooHistoricalResponse({
        timestamps: [1748700000, 1748800000],
        closes: [193.0, 194.0],
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(historicalData),
        ) as jest.Mock;

      dataSourceMock.query.mockResolvedValue(undefined);

      await service.backfillSecurity(mockSecurity);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain(
        "range=1y",
      );
    });

    it("handles no prices available gracefully", async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse({ chart: { result: [] } }),
        ) as jest.Mock;

      await expect(
        service.backfillSecurity(mockSecurity),
      ).resolves.not.toThrow();
    });

    /**
     * Invariant: a price write nobody awaited is still visible to something
     * that needs the database quiet.
     * Canonical adversarial input: an operation outliving the request that
     * started it (testing contract, concurrency).
     * Minimal mutation: drop the `trackPriceWrite` wrapper in
     * `backfillSecurity`.
     * Test that fails under it: this one -- `settlePendingPriceWrites`
     * returns while the write is still in flight, which in an integration
     * suite is the truncate racing the insert.
     */
    it("is visible to settlePendingPriceWrites until it finishes", async () => {
      const historicalData = makeYahooHistoricalResponse({
        timestamps: [1748700000, 1748800000],
        closes: [193.0, 194.0],
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(historicalData),
        ) as jest.Mock;
      dataSourceMock.query.mockResolvedValue(undefined);

      // What the waiter has to outlast is the *write*, not the promise that
      // wraps it. Untracked, the register is empty and
      // `settlePendingPriceWrites` returns on the next microtask -- before the
      // fetch has even resolved, let alone the insert -- and that gap is
      // exactly where a TRUNCATE meets a live INSERT.
      let writes = 0;
      dataSourceMock.query.mockImplementation(async () => {
        writes += 1;
      });

      // Started and deliberately not awaited, exactly as SecuritiesService
      // does it.
      const backfill = service.backfillSecurity(mockSecurity);
      const writesWhenSettled = settlePendingPriceWrites().then(() => writes);

      expect(await writesWhenSettled).toBeGreaterThan(0);

      await backfill;
      // The write really did go through this mock, so the assertion above is
      // about ordering and not about a counter nothing increments.
      expect(writes).toBeGreaterThan(0);
      // And the register is empty again, so the next suite's teardown is free.
      await expect(settlePendingPriceWrites()).resolves.toBeUndefined();
    });
  });

  describe("backfillSecurityHoldingPeriod", () => {
    const daySeconds = 24 * 60 * 60;
    const nowSeconds = Math.floor(Date.now() / 1000);

    it("throws NotFoundException when the security is not owned by the user", async () => {
      securitiesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.backfillSecurityHoldingPeriod(TEST_USER_ID, "missing"),
      ).rejects.toThrow(NotFoundException);
      expect(securitiesRepository.findOne).toHaveBeenCalledWith({
        where: { id: "missing", userId: TEST_USER_ID },
      });
    });

    it("backfills only 1Y when the earliest transaction is within the last year", async () => {
      securitiesRepository.findOne.mockResolvedValue(mockSecurity);
      const recent = new Date();
      recent.setMonth(recent.getMonth() - 1);
      const recentStr = recent.toISOString().substring(0, 10);
      dataSourceMock.query.mockResolvedValueOnce([{ earliest: recentStr }]);

      const historicalData = makeYahooHistoricalResponse({
        timestamps: [nowSeconds - 2 * daySeconds, nowSeconds - daySeconds],
        closes: [193.0, 194.0],
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(historicalData),
        ) as jest.Mock;
      dataSourceMock.query.mockResolvedValue(undefined);

      const result = await service.backfillSecurityHoldingPeriod(
        TEST_USER_ID,
        "sec-1",
      );

      expect(result.success).toBe(true);
      expect(result.symbol).toBe("AAPL");
      expect(result.pricesLoaded).toBeGreaterThan(0);
      // Only the 1Y range is fetched -- no "max" call -- since the holding
      // period is under a year.
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain(
        "range=1y",
      );
    });

    it("keeps the full 1Y of fetched bars even when the security was bought last month", async () => {
      // A security purchased recently should still get the whole year of
      // history the "1y" fetch already pulled -- clipping to the purchase
      // date threw away everything before it, leaving a security bought a
      // month ago with only a month of stored prices.
      securitiesRepository.findOne.mockResolvedValue(mockSecurity);
      const recent = new Date();
      recent.setMonth(recent.getMonth() - 1);
      const recentStr = recent.toISOString().substring(0, 10);
      dataSourceMock.query.mockResolvedValueOnce([{ earliest: recentStr }]);

      const eightMonthsAgo = nowSeconds - 8 * 30 * daySeconds;
      const historicalData = makeYahooHistoricalResponse({
        timestamps: [eightMonthsAgo, nowSeconds - daySeconds],
        closes: [180.0, 194.0],
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(historicalData),
        ) as jest.Mock;
      dataSourceMock.query.mockResolvedValue(undefined);

      const result = await service.backfillSecurityHoldingPeriod(
        TEST_USER_ID,
        "sec-1",
      );

      expect(result.success).toBe(true);
      // Both bars are kept, including the one eight months before the
      // purchase date -- the clip only excludes anything older than 1y.
      expect(result.pricesLoaded).toBe(2);
    });

    it("fetches max history when the earliest transaction predates one year", async () => {
      securitiesRepository.findOne.mockResolvedValue(mockSecurity);
      dataSourceMock.query.mockResolvedValueOnce([{ earliest: "2018-01-01" }]);

      const historicalData = makeYahooHistoricalResponse({
        timestamps: [nowSeconds - 2 * daySeconds, nowSeconds - daySeconds],
        closes: [193.0, 194.0],
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(historicalData),
        ) as jest.Mock;
      dataSourceMock.query.mockResolvedValue(undefined);

      const result = await service.backfillSecurityHoldingPeriod(
        TEST_USER_ID,
        "sec-1",
      );

      expect(result.success).toBe(true);
      // Both 1Y and max ranges are fetched and merged for deep history.
      expect(global.fetch).toHaveBeenCalledTimes(2);
      const ranges = (global.fetch as jest.Mock).mock.calls.map((c) => c[0]);
      expect(ranges.some((u: string) => u.includes("range=1y"))).toBe(true);
      expect(ranges.some((u: string) => u.includes("range=max"))).toBe(true);
    });

    it("falls back to 1Y when the security has no transactions", async () => {
      securitiesRepository.findOne.mockResolvedValue(mockSecurity);
      dataSourceMock.query.mockResolvedValueOnce([{ earliest: null }]);

      const historicalData = makeYahooHistoricalResponse({
        timestamps: [nowSeconds - 2 * daySeconds, nowSeconds - daySeconds],
        closes: [193.0, 194.0],
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(historicalData),
        ) as jest.Mock;
      dataSourceMock.query.mockResolvedValue(undefined);

      const result = await service.backfillSecurityHoldingPeriod(
        TEST_USER_ID,
        "sec-1",
      );

      expect(result.success).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain(
        "range=1y",
      );
    });

    it("bypasses the skipPriceUpdates flag (force update)", async () => {
      const skipSec = { ...mockSecurity, skipPriceUpdates: true } as Security;
      securitiesRepository.findOne.mockResolvedValue(skipSec);
      dataSourceMock.query.mockResolvedValueOnce([{ earliest: null }]);

      const historicalData = makeYahooHistoricalResponse({
        timestamps: [nowSeconds - daySeconds],
        opens: [191.0],
        highs: [196.0],
        lows: [190.0],
        closes: [194.0],
        volumes: [51000000],
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(historicalData),
        ) as jest.Mock;
      dataSourceMock.query.mockResolvedValue(undefined);

      const result = await service.backfillSecurityHoldingPeriod(
        TEST_USER_ID,
        "sec-1",
      );

      expect(result.success).toBe(true);
      expect(global.fetch).toHaveBeenCalled();
    });

    it("returns failure when no historical data is available", async () => {
      securitiesRepository.findOne.mockResolvedValue(mockSecurity);
      dataSourceMock.query.mockResolvedValueOnce([{ earliest: null }]);
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse({ chart: { result: [] } }),
        ) as jest.Mock;

      const result = await service.backfillSecurityHoldingPeriod(
        TEST_USER_ID,
        "sec-1",
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("No historical data available");
    });

    it("returns failure when the upsert throws", async () => {
      securitiesRepository.findOne.mockResolvedValue(mockSecurity);
      dataSourceMock.query
        .mockResolvedValueOnce([{ earliest: null }])
        .mockRejectedValueOnce(new Error("INSERT failed"));

      const historicalData = makeYahooHistoricalResponse({
        timestamps: [nowSeconds - daySeconds],
        closes: [194.0],
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(historicalData),
        ) as jest.Mock;

      const result = await service.backfillSecurityHoldingPeriod(
        TEST_USER_ID,
        "sec-1",
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("INSERT failed");
    });

    it("returns success with zero prices loaded when all data predates the cutoff", async () => {
      securitiesRepository.findOne.mockResolvedValue(mockSecurity);
      // No transactions -> cutoff falls back to one year ago.
      dataSourceMock.query.mockResolvedValueOnce([{ earliest: null }]);

      // Prices two years old are entirely clipped by the 1y fallback cutoff.
      const twoYearsAgo = nowSeconds - 2 * 365 * daySeconds;
      const historicalData = makeYahooHistoricalResponse({
        timestamps: [twoYearsAgo, twoYearsAgo + daySeconds],
        closes: [100.0, 101.0],
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(historicalData),
        ) as jest.Mock;

      const result = await service.backfillSecurityHoldingPeriod(
        TEST_USER_ID,
        "sec-1",
      );

      expect(result.success).toBe(true);
      expect(result.pricesLoaded).toBe(0);
      // No INSERT is issued when there is nothing within the window.
      expect(dataSourceMock.query).toHaveBeenCalledTimes(1);
    });

    it("persists the MSN instrument id when MSN wins the backfill", async () => {
      const msnSec = {
        ...mockSecurity,
        quoteProvider: "msn",
        msnInstrumentId: null,
      } as Security;
      securitiesRepository.findOne.mockResolvedValue(msnSec);
      dataSourceMock.query.mockResolvedValueOnce([{ earliest: null }]);
      dataSourceMock.query.mockResolvedValue(undefined);

      const recent = new Date(Date.now() - daySeconds * 1000);
      recent.setHours(0, 0, 0, 0);
      msnFinanceService.fetchHistoricalSeries.mockResolvedValue({
        prices: [
          {
            date: recent,
            open: 10,
            high: 11,
            low: 9,
            close: 10.5,
            adjClose: 10.5,
            volume: 1000,
          },
        ],
        currencyCode: "USD",
      });
      msnFinanceService.resolveInstrumentId.mockResolvedValue("MSN-123");
      // Yahoo should never be reached, but guard against accidental calls.
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse({ chart: { result: [] } }),
        ) as jest.Mock;

      const result = await service.backfillSecurityHoldingPeriod(
        TEST_USER_ID,
        "sec-1",
      );

      expect(result.success).toBe(true);
      expect(result.provider).toBe("msn");
      expect(result.pricesLoaded).toBe(1);
      expect(msnFinanceService.fetchHistoricalSeries).toHaveBeenCalled();
      expect(securitiesRepository.update).toHaveBeenCalledWith("sec-1", {
        msnInstrumentId: "MSN-123",
      });
    });
  });

  describe("settleDailyBars", () => {
    const DAY_SECONDS = 24 * 60 * 60;

    /** The bulk historical upsert the settlement pass issues, if any. */
    function bulkUpsertCall(): [string, unknown[]] | undefined {
      return dataSourceMock.query.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === "string" &&
          call[0].includes("INSERT INTO security_prices") &&
          call[0].includes("adjusted_close"),
      ) as [string, unknown[]] | undefined;
    }

    beforeEach(() => {
      dataSourceMock.query.mockResolvedValue(undefined);
    });

    it("stores the adjusted close the daily bar carries", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      const nowSeconds = Math.floor(Date.now() / 1000);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(
          makeYahooHistoricalResponse({
            timestamps: [
              nowSeconds - 3 * DAY_SECONDS,
              nowSeconds - 2 * DAY_SECONDS,
            ],
            closes: [193.0, 194.0],
            adjcloses: [192.4, 193.4],
          }),
        ),
      ) as jest.Mock;

      const result = await service.settleDailyBars();

      expect(result.barsSettled).toBe(2);
      const call = bulkUpsertCall();
      expect(call).toBeDefined();
      // Nine params per bar; the adjusted close is the seventh.
      const params = call![1];
      expect(params[6]).toBe(192.4);
      expect(params[15]).toBe(193.4);
    });

    /**
     * A bar for a session that has not finished is the same provisional
     * half-day the intraday quote already stored, so writing it as the day's
     * bar would launder a quote into a close. A date in the future is
     * unsettled under every timezone rule, which keeps the case independent of
     * the clock the suite happens to run on.
     */
    it("does not settle a bar whose session has not ended", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      const nowSeconds = Math.floor(Date.now() / 1000);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(
          makeYahooHistoricalResponse({
            timestamps: [
              nowSeconds - 2 * DAY_SECONDS,
              nowSeconds + 2 * DAY_SECONDS,
            ],
            closes: [193.0, 194.0],
            adjcloses: [192.4, 193.4],
          }),
        ),
      ) as jest.Mock;

      const result = await service.settleDailyBars();

      expect(result.barsSettled).toBe(1);
      const params = bulkUpsertCall()![1];
      expect(params).toHaveLength(9);
      expect(params[5]).toBe(193.0);
    });

    it("reads a bounded recent window rather than the full history", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(makeYahooHistoricalResponse()),
        ) as jest.Mock;

      await service.settleDailyBars();

      expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain(
        "range=1mo",
      );
    });

    it("counts a provider that returns nothing as a failure, not a settlement", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse({ chart: { result: [] } }),
        ) as jest.Mock;

      const result = await service.settleDailyBars();

      expect(result.failed).toBe(1);
      expect(result.barsSettled).toBe(0);
      expect(bulkUpsertCall()).toBeUndefined();
    });

    it("skips securities flagged to skip price updates", async () => {
      securitiesRepository.find.mockResolvedValue([
        { ...mockSecurity, skipPriceUpdates: true, quoteProvider: null },
      ]);
      global.fetch = jest.fn() as jest.Mock;

      const result = await service.settleDailyBars();

      expect(result.totalSecurities).toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    // The flag is the user's "disable price updates" switch; a provider
    // override or MSN instrument id saved beside it must not turn it back on.
    it("skips a flagged security even when it carries a provider override", async () => {
      securitiesRepository.find.mockResolvedValue([
        {
          ...mockSecurity,
          skipPriceUpdates: true,
          quoteProvider: "msn",
          msnInstrumentId: "MSN-123",
        },
      ]);
      global.fetch = jest.fn() as jest.Mock;

      const result = await service.settleDailyBars();

      expect(result.totalSecurities).toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("runs under a system context: prices are global, not the caller's", async () => {
      let ctx: ReturnType<typeof getRequestContext>;
      securitiesRepository.find.mockImplementation(() => {
        ctx = getRequestContext();
        return Promise.resolve([]);
      });

      await requestContextStorage.run({ userId: "admin-1" }, () =>
        service.settleDailyBars(),
      );

      expect(ctx).toMatchObject({ system: true });
      expect(ctx).not.toHaveProperty("userId");
    });

    /**
     * A manual price is a correction the user typed. Before this the backfill's
     * `DO UPDATE` overwrote every column unconditionally, so the settlement
     * pass would have undone those corrections nightly.
     */
    it("leaves a manually entered price alone", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      const nowSeconds = Math.floor(Date.now() / 1000);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(
          makeYahooHistoricalResponse({
            timestamps: [nowSeconds - 2 * DAY_SECONDS],
            closes: [193.0],
          }),
        ),
      ) as jest.Mock;

      await service.settleDailyBars();

      expect(bulkUpsertCall()![0]).toContain(
        "WHERE security_prices.source IS DISTINCT FROM 'manual'",
      );
    });

    /**
     * A daily bar is a session, not an instant. Leaving the timestamp of the
     * intraday quote these numbers replaced would describe the row as a quote
     * struck at 14:42 whose close is the official one -- two claims that
     * cannot both be true.
     */
    it("clears the quote timestamp it supersedes", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      const nowSeconds = Math.floor(Date.now() / 1000);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(
          makeYahooHistoricalResponse({
            timestamps: [nowSeconds - 2 * DAY_SECONDS],
            closes: [193.0],
          }),
        ),
      ) as jest.Mock;

      await service.settleDailyBars();

      expect(bulkUpsertCall()![0]).toContain("quoted_at = NULL");
    });
  });

  describe("a coarser-than-daily payload is refused, not spliced", () => {
    const DAY = 24 * 60 * 60;

    /** `count` bars `stepDays` apart, ending a week ago so all are settled. */
    function timestamps(count: number, stepDays: number): number[] {
      // At 16:00 UTC, midday in New York under either offset, so a DST change
      // inside the window cannot move a bar onto its neighbour's date.
      const end =
        Math.floor(Date.now() / 1000 / DAY) * DAY - 7 * DAY + 16 * 3600;
      return Array.from(
        { length: count },
        (_, i) => end - (count - 1 - i) * stepDays * DAY,
      );
    }

    function bulkUpsertCalls(): unknown[][] {
      return dataSourceMock.query.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "string" && call[0].includes("adjusted_close"),
      );
    }

    beforeEach(() => {
      dataSourceMock.query.mockResolvedValue(undefined);
    });

    /**
     * The defect this catches, seen in production data: six years of one
     * adjusted row per month spliced through a daily history, from a
     * long-range request the provider answered with monthly bars. Under the
     * one-basis-per-series rule those monthly rows then *excluded* every daily
     * row around them, reducing the window to twelve points a year -- and they
     * had already overwritten the real daily close on each date they landed on.
     */
    it("writes nothing when the provider returns monthly bars", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(
          makeYahooHistoricalResponse({
            timestamps: timestamps(72, 30),
            closes: Array.from({ length: 72 }, (_, i) => 100 + i),
            adjcloses: Array.from({ length: 72 }, (_, i) => 100 + i),
          }),
        ),
      ) as jest.Mock;

      const result = await service.settleDailyBars();

      expect(bulkUpsertCalls()).toHaveLength(0);
      expect(result.barsSettled).toBe(0);
      expect(result.failed).toBe(1);
    });

    it("writes a daily payload as before", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(
          makeYahooHistoricalResponse({
            timestamps: timestamps(30, 1),
            closes: Array.from({ length: 30 }, (_, i) => 100 + i),
            adjcloses: Array.from({ length: 30 }, (_, i) => 100 + i),
          }),
        ),
      ) as jest.Mock;

      const result = await service.settleDailyBars();

      expect(bulkUpsertCalls()).toHaveLength(1);
      expect(result.barsSettled).toBe(30);
    });

    /**
     * The guard sits in `bulkUpsertPrices` rather than in each caller because
     * there are four of them, and a guard one caller forgets is not a guard.
     */
    it("refuses on the force-backfill path too, and says why", async () => {
      securitiesRepository.findOne.mockResolvedValue(mockSecurity);
      dataSourceMock.query.mockResolvedValueOnce([{ earliest: "2016-05-01" }]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(
          makeYahooHistoricalResponse({
            timestamps: timestamps(60, 7),
            closes: Array.from({ length: 60 }, (_, i) => 100 + i),
          }),
        ),
      ) as jest.Mock;

      const result = await service.backfillSecurityHoldingPeriod(
        TEST_USER_ID,
        mockSecurity.id,
        "max",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("daily series was requested");
      expect(bulkUpsertCalls()).toHaveLength(0);
    });
  });

  describe("backfillSecurityHoldingPeriod with an explicit range", () => {
    const DAY = 24 * 60 * 60;

    function dailyResponse(count: number) {
      // Yesterday at 16:00 UTC, midday in New York under either offset. A bar
      // at `now - k days` is dated in the exchange's zone, so between 04:00
      // and 05:00 UTC a window spanning a DST change put two bars on one New
      // York date and the dedupe dropped one.
      const end = Math.floor(Date.now() / 1000 / DAY) * DAY - DAY + 16 * 3600;
      return makeYahooHistoricalResponse({
        timestamps: Array.from(
          { length: count },
          (_, i) => end - (count - 1 - i) * DAY,
        ),
        closes: Array.from({ length: count }, (_, i) => 100 + i),
      });
    }

    beforeEach(() => {
      dataSourceMock.query.mockResolvedValue(undefined);
      securitiesRepository.findOne.mockResolvedValue(mockSecurity);
    });

    it("asks the provider for the range it was given", async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(dailyResponse(40)),
        ) as jest.Mock;

      await service.backfillSecurityHoldingPeriod(
        TEST_USER_ID,
        mockSecurity.id,
        "10y",
      );

      expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain(
        "range=10y",
      );
    });

    /**
     * The point of the parameter. Without it the write is clipped to the first
     * transaction date, so a security first bought in May 2025 could hold
     * fifteen months of history and no more -- and a backtest, the GEM report
     * and the comparison chart all need prices from before the user bought.
     */
    it("does not clip to the first transaction date", async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(dailyResponse(40)),
        ) as jest.Mock;

      const result = await service.backfillSecurityHoldingPeriod(
        TEST_USER_ID,
        mockSecurity.id,
        "max",
      );

      expect(result.pricesLoaded).toBe(40);
      // Never consults the earliest-transaction date, because it cannot matter.
      for (const [sql] of scopedManagerQuery.mock.calls) {
        expect(String(sql)).not.toContain("MIN(transaction_date)");
      }
    });

    /**
     * Imports set `skipPriceUpdates` on securities whose symbol was
     * auto-generated, which is exactly the set a user is most likely to be
     * correcting by hand -- so the explicit request overrides the flag, as the
     * unranged path already did.
     */
    it("overrides skipPriceUpdates, as the default path does", async () => {
      securitiesRepository.findOne.mockResolvedValue({
        ...mockSecurity,
        skipPriceUpdates: true,
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(dailyResponse(40)),
        ) as jest.Mock;

      const result = await service.backfillSecurityHoldingPeriod(
        TEST_USER_ID,
        mockSecurity.id,
        "max",
      );

      expect(result.pricesLoaded).toBe(40);
    });

    /**
     * "No range" still clips -- but only to the 1y-ago floor, never to a
     * *recent* purchase date. A holding bought a month ago is not the case
     * this clip exists for (that would throw away the very 1y of daily bars
     * the default path just fetched); a holding bought years ago still gets
     * its pre-purchase prices dropped.
     */
    it("still clips to the earliest transaction when it predates a year, with no range given", async () => {
      dataSourceMock.query.mockResolvedValueOnce([{ earliest: "2023-01-01" }]);
      const beforePurchase = Math.floor(
        new Date("2019-01-01T00:00:00Z").getTime() / 1000,
      );
      const afterPurchase = Math.floor(
        new Date("2023-06-01T00:00:00Z").getTime() / 1000,
      );
      const recent = Math.floor(Date.now() / 1000) - DAY;
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(
          makeYahooHistoricalResponse({
            timestamps: [beforePurchase, afterPurchase, recent],
            closes: [50, 60, 70],
          }),
        ),
      ) as jest.Mock;

      const result = await service.backfillSecurityHoldingPeriod(
        TEST_USER_ID,
        mockSecurity.id,
      );

      // The 2019 bar predates the 2023 purchase and is clipped; the other
      // two -- one before the 1y-ago floor, one after -- are both kept.
      expect(result.pricesLoaded).toBe(2);
    });

    /**
     * The recent-purchase counterpart to the test above: with no range given
     * and a holding bought within the last year, the clip must not undo the
     * default 1y fetch. See `security-price.service.spec.ts`'s
     * "keeps the full 1Y of fetched bars even when the security was bought
     * last month" for the same guarantee against the unranged daily-only path.
     */
    it("does not clip a recent purchase back below the 1y floor, with no range given", async () => {
      const recentPurchase = new Date();
      recentPurchase.setMonth(recentPurchase.getMonth() - 1);
      dataSourceMock.query.mockResolvedValueOnce([
        { earliest: recentPurchase.toISOString().substring(0, 10) },
      ]);
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(dailyResponse(40)),
        ) as jest.Mock;

      const result = await service.backfillSecurityHoldingPeriod(
        TEST_USER_ID,
        mockSecurity.id,
      );

      expect(result.pricesLoaded).toBe(40);
    });
  });

  describe("scheduledPriceRefresh", () => {
    it("calls refreshAllPrices", async () => {
      securitiesRepository.find.mockResolvedValue([]);

      await service.scheduledPriceRefresh();

      expect(securitiesRepository.find).toHaveBeenCalled();
    });

    it("takes the deployment-wide lease before calling the provider", async () => {
      securitiesRepository.find.mockResolvedValue([]);

      await service.scheduledPriceRefresh();

      expect(fetchSync.withLease).toHaveBeenCalledWith(
        FetchSyncJob.SecurityPrices,
        expect.any(Number),
        expect.any(Function),
      );
      // Shorter than the daily interval, so a crashed holder never blocks
      // tomorrow's tick.
      const [, leaseMs] = fetchSync.withLease.mock.calls[0];
      expect(leaseMs).toBeLessThan(24 * 60 * 60 * 1000);
    });

    // The whole point: one replica per tick pays the provider quota. The price
    // upserts are idempotent, so nothing about the data depends on this.
    it("does nothing when another replica holds the lease", async () => {
      fetchSync.withLease.mockImplementation(async () => false);
      securitiesRepository.find.mockResolvedValue([]);

      await service.scheduledPriceRefresh();

      expect(securitiesRepository.find).not.toHaveBeenCalled();
    });

    /**
     * Order is the whole point. The quote refresh stores what the security is
     * worth at 17:00; settlement then replaces the day with the provider's
     * official bar, which is the only thing carrying a full-session high, low,
     * volume and adjusted close. Run the other way round, the quote would
     * overwrite the bar and the day would be provisional again.
     */
    it("settles the day's official bars after refreshing quotes", async () => {
      const order: string[] = [];
      const refresh = jest
        .spyOn(service, "refreshAllPrices")
        .mockImplementation(async () => {
          order.push("refresh");
          return {
            totalSecurities: 0,
            updated: 0,
            failed: 0,
            skipped: 0,
            results: [],
            lastUpdated: new Date(),
          };
        });
      const settle = jest
        .spyOn(service, "settleDailyBars")
        .mockImplementation(async () => {
          order.push("settle");
          return {
            totalSecurities: 0,
            securitiesSettled: 0,
            barsSettled: 0,
            failed: 0,
          };
        });

      await service.scheduledPriceRefresh();

      expect(refresh).toHaveBeenCalled();
      expect(settle).toHaveBeenCalled();
      expect(order).toEqual(["refresh", "settle"]);
    });

    it("recalculates snapshots when settlement moved prices but no quote did", async () => {
      jest.spyOn(service, "refreshAllPrices").mockResolvedValue({
        totalSecurities: 3,
        updated: 0,
        failed: 3,
        skipped: 0,
        results: [],
        lastUpdated: new Date(),
      });
      jest.spyOn(service, "settleDailyBars").mockResolvedValue({
        totalSecurities: 3,
        securitiesSettled: 3,
        barsSettled: 12,
        failed: 0,
      });

      await service.scheduledPriceRefresh();

      expect(
        netWorthService.recalculateAllInvestmentSnapshots,
      ).toHaveBeenCalled();
    });

    /**
     * The regression that motivated all of this, pinned where it happened.
     *
     * The closing job passed `skipFresh`, which skipped any security already
     * carrying a provider-written row for today. The frontend auto-refreshes
     * quotes through the trading session, so on any day the user opened the
     * app there *was* such a row -- a quote struck mid-session, with a running
     * volume and a high that was only the highest so far -- and the job skipped
     * the one fetch that would have replaced it with the close. Real data: of
     * seventeen consecutive XGRO rows, the only two matching the provider's
     * published close were the two written at 17:00 by a run that had nothing
     * to skip.
     *
     * Two assertions, because each alone is satisfiable by the wrong code. The
     * quote fetch is the behaviour; the absent freshness query is what
     * actually fails against the old job, whose skip was decided by a
     * `SELECT DISTINCT security_id ... source IS DISTINCT FROM 'manual'` this
     * job must no longer ask.
     */
    it("fetches the close unconditionally, with no freshness query in front of it", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      seedStoredPrice({
        securityId: mockSecurity.id,
        priceDate: new Date().toISOString().substring(0, 10),
        closePrice: 191.11,
        source: "yahoo_finance",
        quotedAt: new Date(),
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(makeYahooChartResponse()),
        ) as jest.Mock;

      await service.scheduledPriceRefresh();

      const quoteFetches = (global.fetch as jest.Mock).mock.calls.filter(
        (call) => String(call[0]).includes("range=1d"),
      );
      expect(quoteFetches).toHaveLength(1);
      for (const [sql] of scopedManagerQuery.mock.calls) {
        expect(String(sql)).not.toContain("SELECT DISTINCT security_id");
      }
    });

    it("does not throw when refreshAllPrices fails", async () => {
      securitiesRepository.find.mockRejectedValue(new Error("DB down"));

      await expect(service.scheduledPriceRefresh()).resolves.not.toThrow();
    });

    it("does not throw when settlement fails", async () => {
      jest.spyOn(service, "refreshAllPrices").mockResolvedValue({
        totalSecurities: 0,
        updated: 0,
        failed: 0,
        skipped: 0,
        results: [],
        lastUpdated: new Date(),
      });
      jest
        .spyOn(service, "settleDailyBars")
        .mockRejectedValue(new Error("Yahoo down"));

      await expect(service.scheduledPriceRefresh()).resolves.not.toThrow();
    });
  });

  /**
   * A coin trades every day and its Yahoo session is the UTC day, so with the
   * weekday closing job alone Friday's, Saturday's and Sunday's bars all waited
   * for Monday's run to settle. The weekend tick runs the same body over CRYPTO
   * securities only, settling the previous UTC day each run; every other
   * security is closed.
   */
  describe("scheduledWeekendCryptoRefresh", () => {
    const coin: Security = {
      ...mockSecurity,
      id: "sec-coin",
      symbol: "BTC-EUR",
      name: "Bitcoin EUR",
      securityType: "CRYPTO",
      // Created before the lookup named CRYPTO: the type, not the exchange, is
      // what selects it.
      exchange: "CCC",
      currencyCode: "EUR",
    } as Security;

    /** A repository that honours the `where` it is given, as the real one does. */
    const seedFilteringRepository = () => {
      securitiesRepository.find.mockImplementation(
        async ({ where }: { where: Partial<Security> }) =>
          [mockSecurity, coin].filter((s) =>
            Object.entries(where).every(
              ([key, value]) => s[key as keyof Security] === value,
            ),
          ),
      );
    };

    const quotedSymbols = () =>
      (global.fetch as jest.Mock).mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.includes("range=1d"))
        .map((url) =>
          decodeURIComponent(url.split("/chart/")[1].split("?")[0]),
        );

    it("refreshes and settles only CRYPTO securities", async () => {
      seedFilteringRepository();
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(makeYahooChartResponse()),
        ) as jest.Mock;

      await service.scheduledWeekendCryptoRefresh();

      // Both passes select through the scope, so the settlement covers exactly
      // what the refresh did.
      expect(securitiesRepository.find).toHaveBeenCalledTimes(2);
      for (const [options] of securitiesRepository.find.mock.calls) {
        expect(options).toEqual({
          where: { isActive: true, securityType: "CRYPTO" },
        });
      }
      expect(quotedSymbols()).toEqual(["BTC-EUR"]);
    });

    it("runs the quote refresh, then settlement, then the snapshot recalc, scoped to CRYPTO", async () => {
      const order: string[] = [];
      const refresh = jest
        .spyOn(service, "refreshAllPrices")
        .mockImplementation(async () => {
          order.push("refresh");
          return {
            totalSecurities: 1,
            updated: 1,
            failed: 0,
            skipped: 0,
            results: [],
            lastUpdated: new Date(),
          };
        });
      const settle = jest
        .spyOn(service, "settleDailyBars")
        .mockImplementation(async () => {
          order.push("settle");
          return {
            totalSecurities: 1,
            securitiesSettled: 1,
            barsSettled: 1,
            failed: 0,
          };
        });
      netWorthService.recalculateAllInvestmentSnapshots.mockImplementation(
        async () => {
          order.push("recalc");
        },
      );

      await service.scheduledWeekendCryptoRefresh();

      expect(refresh).toHaveBeenCalledWith({ securityType: "CRYPTO" });
      expect(settle).toHaveBeenCalledWith({ securityType: "CRYPTO" });
      expect(order).toEqual(["refresh", "settle", "recalc"]);
    });

    it("takes the same deployment-wide lease as the weekday run", async () => {
      seedFilteringRepository();

      await service.scheduledWeekendCryptoRefresh();

      expect(fetchSync.withLease).toHaveBeenCalledWith(
        FetchSyncJob.SecurityPrices,
        expect.any(Number),
        expect.any(Function),
      );
    });

    it("does nothing when another replica holds the lease", async () => {
      fetchSync.withLease.mockImplementation(async () => false);

      await service.scheduledWeekendCryptoRefresh();

      expect(securitiesRepository.find).not.toHaveBeenCalled();
    });

    it("does not throw when the refresh fails", async () => {
      securitiesRepository.find.mockRejectedValue(new Error("DB down"));

      await expect(
        service.scheduledWeekendCryptoRefresh(),
      ).resolves.not.toThrow();
    });

    // The weekday job is unchanged: every active security, crypto included,
    // selected by `isActive` alone.
    it("leaves the weekday run unscoped", async () => {
      seedFilteringRepository();
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(makeYahooChartResponse()),
        ) as jest.Mock;

      await service.scheduledPriceRefresh();

      for (const [options] of securitiesRepository.find.mock.calls) {
        expect(options).toEqual({ where: { isActive: true } });
      }
      expect(quotedSymbols().sort()).toEqual(["AAPL", "BTC-EUR"]);
    });
  });

  describe("getYahooSymbol (via refreshAllPrices)", () => {
    // We test the private getYahooSymbol indirectly through public methods

    it("adds .TO suffix for TSX exchange", async () => {
      securitiesRepository.find.mockResolvedValue([
        { ...mockSecurity, symbol: "RY", exchange: "TSX" },
      ]);
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(makeYahooChartResponse()),
        ) as jest.Mock;

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
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(makeYahooChartResponse()),
        ) as jest.Mock;

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
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(makeYahooChartResponse()),
        ) as jest.Mock;

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
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(makeYahooChartResponse()),
        ) as jest.Mock;

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
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(makeYahooChartResponse()),
        ) as jest.Mock;

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
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(makeYahooChartResponse()),
        ) as jest.Mock;

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
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(makeYahooChartResponse()),
        ) as jest.Mock;

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
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(makeYahooChartResponse()),
        ) as jest.Mock;

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
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(makeYahooChartResponse()),
        ) as jest.Mock;

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
      const yahooData = makeYahooChartResponse({
        regularMarketTime: 1748800000,
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(yahooData)) as jest.Mock;

      await service.refreshAllPrices();

      // The trading date should be derived from the timestamp (zeroed in UTC)
      // and formatted as YYYY-MM-DD using UTC components.
      const expected = new Date(1748800000 * 1000);
      const expectedDateStr = `${expected.getUTCFullYear()}-${String(
        expected.getUTCMonth() + 1,
      ).padStart(2, "0")}-${String(expected.getUTCDate()).padStart(2, "0")}`;

      expect(upsertedPrices[0]).toMatchObject({
        priceDate: expectedDateStr,
      });
    });

    it("falls back to current date when regularMarketTime is missing", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      const yahooData = makeYahooChartResponse({
        regularMarketTime: undefined,
      });
      // Remove regularMarketTime from meta
      yahooData.chart.result[0].meta.regularMarketTime = undefined;
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(yahooData)) as jest.Mock;

      await service.refreshAllPrices();

      // Should use today (or adjusted for weekend) as a YYYY-MM-DD string
      expect(upsertedPrices[0]).toMatchObject({
        priceDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      });
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
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(yahooData)) as jest.Mock;

      await service.refreshAllPrices();

      expect(upsertedPrices).toHaveLength(1);
      expect(upsertedPrices[0]).toMatchObject({
        securityId: "sec-1",
        closePrice: 200.0,
        highPrice: 205.0,
        lowPrice: 198.0,
        volume: 60000000,
        source: "yahoo_finance",
      });
    });

    it("updates existing price entry when one exists for the date", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      const yahooData = makeYahooChartResponse({
        regularMarketPrice: 200.0,
        regularMarketDayHigh: 205.0,
        regularMarketDayLow: 198.0,
        regularMarketVolume: 60000000,
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(yahooData)) as jest.Mock;

      const existingPrice = {
        ...mockPriceEntry,
        openPrice: 188.0,
        highPrice: 190.0,
        lowPrice: 185.0,
        closePrice: 189.0,
        volume: 40000000,
      };
      // A row already stored for this security and date: the upsert's
      // `ON CONFLICT DO UPDATE` merges onto it rather than inserting.
      seedStoredPrice(existingPrice);

      await service.refreshAllPrices();

      // Merged onto the row that was there, not inserted alongside it.
      expect(upsertedPrices).toHaveLength(1);
      expect(upsertedPrices[0]).toMatchObject({
        closePrice: 200.0,
        highPrice: 205.0,
        lowPrice: 198.0,
        volume: 60000000,
        source: "yahoo_finance",
      });
    });

    it("preserves existing openPrice when quote has no open", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      // The mock omits both meta.regularMarketOpen and indicators, so the
      // Yahoo service returns regularMarketOpen=undefined.
      const yahooData = makeYahooChartResponse({
        regularMarketPrice: 200.0,
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(yahooData)) as jest.Mock;

      const existingPrice = {
        ...mockPriceEntry,
        openPrice: 188.0,
      };
      // A row already stored for this security and date: the upsert's
      // `ON CONFLICT DO UPDATE` merges onto it rather than inserting.
      seedStoredPrice(existingPrice);

      await service.refreshAllPrices();

      // openPrice stays 188.0 because the quote carries no open and the
      // statement says `COALESCE(EXCLUDED.open_price, security_prices.open_price)`
      // -- read from the stored row rather than from a copy fetched earlier.
      expect(priceUpsertSql()).toContain(
        "COALESCE(EXCLUDED.open_price,  security_prices.open_price)",
      );
      expect(upsertedPrices[0]).toMatchObject(
        expect.objectContaining({
          openPrice: 188.0,
        }),
      );
    });
  });

  describe("getAlternateSymbols (via refreshAllPrices)", () => {
    it("returns .TO, .V, .CN alternates for plain symbols", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurityNoExchange]);

      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          createMockFetchResponse({ chart: { result: [] } }),
        ) // MSFT
        .mockResolvedValueOnce(
          createMockFetchResponse({ chart: { result: [] } }),
        ) // MSFT.TO
        .mockResolvedValueOnce(
          createMockFetchResponse({ chart: { result: [] } }),
        ) // MSFT.V
        .mockResolvedValueOnce(
          createMockFetchResponse({ chart: { result: [] } }),
        ); // MSFT.CN
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

      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          createMockFetchResponse({ chart: { result: [] } }),
        ) // MSFT fails
        .mockResolvedValueOnce(
          createMockFetchResponse(
            makeYahooChartResponse({ symbol: "MSFT.TO" }),
          ),
        ); // MSFT.TO succeeds
      global.fetch = fetchMock;

      const result = await service.refreshAllPrices();

      // Only 2 fetch calls: MSFT then MSFT.TO (stops after success)
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.updated).toBe(1);
    });
  });

  describe("getExchangePriority (via lookupSecurity)", () => {
    it("prioritizes TSX (.TO) over US exchanges", async () => {
      const searchData = makeYahooSearchResponse([
        {
          symbol: "TD",
          exchDisp: "NYSE",
          typeDisp: "Equity",
          longname: "TD US",
        },
        {
          symbol: "TD.TO",
          exchDisp: "Toronto",
          typeDisp: "Equity",
          longname: "TD Canada",
        },
      ]);
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(searchData)) as jest.Mock;

      const result = await service.lookupSecurity(TEST_USER_ID, "TD");

      // TD.TO (TSX, priority 1) should win over TD (US, priority 2)
      expect(result!.exchange).toBe("TSX");
    });

    it("prioritizes US exchanges over international", async () => {
      const searchData = makeYahooSearchResponse([
        {
          symbol: "VOD.L",
          exchDisp: "London",
          typeDisp: "Equity",
          longname: "Vodafone UK",
        },
        {
          symbol: "VOD",
          exchDisp: "NASDAQ",
          typeDisp: "Equity",
          longname: "Vodafone US",
        },
      ]);
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(searchData)) as jest.Mock;

      const result = await service.lookupSecurity(TEST_USER_ID, "VOD");

      // US (priority 2) should win over LSE (priority 3), and exact symbol match "VOD"
      expect(result!.exchange).toBe("NASDAQ"); // Falls back to exchDisp when no symbol suffix
      expect(result!.currencyCode).toBe("USD");
    });

    it("recognizes Canada exchange keywords in exchDisp", async () => {
      const searchData = makeYahooSearchResponse([
        { symbol: "X", exchDisp: "NYSE", typeDisp: "Equity", longname: "X US" },
        {
          symbol: "X",
          exchDisp: "Canada",
          typeDisp: "Equity",
          longname: "X Canada",
        },
      ]);
      global.fetch = jest
        .fn()
        .mockResolvedValue(createMockFetchResponse(searchData)) as jest.Mock;

      const result = await service.lookupSecurity(TEST_USER_ID, "X");

      // "Canada" in exchDisp maps to priority 1
      expect(result!.name).toBe("X Canada");
    });
  });

  describe("upsertTransactionPrice", () => {
    it("should create a price row from transaction data", async () => {
      dataSourceMock.query
        .mockResolvedValueOnce([
          { avg_price: "150.500000", latest_action: "BUY" },
        ])
        .mockResolvedValueOnce(undefined);

      await service.upsertTransactionPrice("sec-1", "2025-06-01");

      expect(dataSourceMock.query).toHaveBeenCalledTimes(2);
      const upsertCall = dataSourceMock.query.mock.calls[1];
      expect(upsertCall[0]).toContain("INSERT INTO security_prices");
      expect(upsertCall[1]).toEqual([
        "sec-1",
        "2025-06-01",
        150.5,
        "buy",
        [
          "buy",
          "sell",
          "reinvest",
          "reinvest_interest",
          "reinvest_capital_gain_short",
          "reinvest_capital_gain_long",
          "redeem",
          "transfer_in",
          "transfer_out",
          // Not "bond_engine": a trade price is one lot's price, not the
          // holding's value, so it never replaces the engine's row (R3).
        ],
      ]);
    });

    it("should delete transaction-sourced price when no transactions remain", async () => {
      dataSourceMock.query.mockResolvedValueOnce([
        { avg_price: null, latest_action: null },
      ]);

      await service.upsertTransactionPrice("sec-1", "2025-06-01");

      expect(dataSourceMock.query).toHaveBeenCalledTimes(2);
      const deleteCall = dataSourceMock.query.mock.calls[1];
      expect(deleteCall[0]).toContain("DELETE FROM security_prices");
    });

    it("should use most recent transaction action as source", async () => {
      dataSourceMock.query
        .mockResolvedValueOnce([
          { avg_price: "160.000000", latest_action: "SELL" },
        ])
        .mockResolvedValueOnce(undefined);

      await service.upsertTransactionPrice("sec-1", "2025-06-01");

      const upsertCall = dataSourceMock.query.mock.calls[1];
      expect(upsertCall[1][3]).toBe("sell");
    });

    it("should round price to 6 decimal places", async () => {
      dataSourceMock.query
        .mockResolvedValueOnce([
          { avg_price: "150.1234567", latest_action: "BUY" },
        ])
        .mockResolvedValueOnce(undefined);

      await service.upsertTransactionPrice("sec-1", "2025-06-01");

      const upsertCall = dataSourceMock.query.mock.calls[1];
      expect(upsertCall[1][2]).toBe(150.123457);
    });
  });

  describe("a quote completes the adjusted basis for the day it is for", () => {
    /**
     * `loadPriceSeries` keeps only the adjusted rows once any row in the window
     * has one, so a today-row with a null `adjusted_close` is not a raw
     * fallback -- it is dropped, and every return series ends yesterday until
     * the evening settlement. The quote may fill it because the newest
     * session's adjustment factor is 1: nothing has gone ex after it, which is
     * why the provider's own last bar reports the close as its adjusted close.
     */
    it("writes the close as the adjusted close on an adjusted series", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      // One backfilled row is what puts this series on the adjusted basis.
      seedStoredPrice({
        securityId: mockSecurity.id,
        priceDate: "2026-08-10",
        closePrice: 190.0,
        adjustedClose: 189.2,
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(
            makeYahooChartResponse({ regularMarketPrice: 200.0 }),
          ),
        ) as jest.Mock;

      await service.refreshAllPrices();

      const written = upsertedPrices.find((row) => row.closePrice === 200.0);
      expect(written?.adjustedClose).toBe(200.0);
    });

    /**
     * The other half, and the reason this is a `CASE` rather than an
     * assignment. MSN publishes no adjusted closes, so such a series is raw
     * throughout -- consistent, and complete. A single adjusted row would flip
     * `bool_or(adjusted_close IS NOT NULL)` to true and collapse the entire
     * series to that one row, which is a worse outcome than the gap this is
     * fixing.
     */
    it("leaves it null on a series that has no adjusted closes at all", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      seedStoredPrice({
        securityId: mockSecurity.id,
        priceDate: "2026-08-10",
        closePrice: 190.0,
        adjustedClose: null,
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(
            makeYahooChartResponse({ regularMarketPrice: 200.0 }),
          ),
        ) as jest.Mock;

      await service.refreshAllPrices();

      const written = upsertedPrices.find((row) => row.closePrice === 200.0);
      expect(written?.adjustedClose).toBeNull();
      expect(priceUpsertSql()).toContain("adj.adjusted_close IS NOT NULL");
    });

    it("keeps the close and the adjusted close in step on a same-day re-quote", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      seedStoredPrice({
        securityId: mockSecurity.id,
        priceDate: "2026-08-10",
        closePrice: 190.0,
        adjustedClose: 189.2,
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(
            makeYahooChartResponse({ regularMarketPrice: 200.0 }),
          ),
        ) as jest.Mock;
      await service.refreshAllPrices();

      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(
            makeYahooChartResponse({ regularMarketPrice: 201.5 }),
          ),
        ) as jest.Mock;
      await service.refreshAllPrices();

      const written = upsertedPrices.find(
        (row) => row.priceDate !== "2026-08-10",
      );
      expect(written).toMatchObject({
        closePrice: 201.5,
        adjustedClose: 201.5,
      });
    });

    /**
     * A manual price is the user's own correction. The quote path used to
     * overwrite it -- the freshness query excluded manual rows from counting as
     * fresh, which let the fetch through and then wrote straight over the
     * entry. The refusal is a successful no-op, so the caller gets the row that
     * won rather than an error.
     */
    it("refuses to overwrite a manual price, and returns the manual row", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      const tradingDate = new Date(1748800000 * 1000)
        .toISOString()
        .substring(0, 10);
      seedStoredPrice({
        securityId: mockSecurity.id,
        priceDate: tradingDate,
        closePrice: 123.45,
        source: "manual",
      });
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(
            makeYahooChartResponse({ regularMarketPrice: 200.0 }),
          ),
        ) as jest.Mock;

      const result = await service.refreshAllPrices();

      expect(result.failed).toBe(0);
      expect(result.updated).toBe(1);
      expect(upsertedPrices).toHaveLength(1);
      expect(upsertedPrices[0]).toMatchObject({
        closePrice: 123.45,
        source: "manual",
      });
      expect(priceUpsertSql()).toContain(
        "WHERE security_prices.source IS DISTINCT FROM 'manual'",
      );
    });
  });

  describe("single-price writes are one guarded statement", () => {
    it("does not read the row before deciding to insert or update", async () => {
      // The regression: this used to `findOne` and then either save a mutated
      // copy or insert a fresh row. The 5 PM ET price cron fires on every
      // replica, so two processes routinely fetch the same quote for the same
      // security and day, both find no row, and both insert -- the loser hit
      // `UNIQUE(security_id, price_date)` and that security had no price at all
      // for the day. There is now nothing to check and nothing to get wrong.
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(makeYahooChartResponse()),
        ) as jest.Mock;

      await service.refreshAllPrices();

      const sql = priceUpsertSql();
      expect(sql).toContain("ON CONFLICT (security_id, price_date) DO UPDATE");
      // The read-back is by the id the statement returned, so it cannot pick up
      // a different row.
      expect(sql).toContain("RETURNING id");
      const reads = securityPriceRepository.findOne.mock.calls.map(
        (call) => (call[0] as { where?: Record<string, unknown> })?.where ?? {},
      );
      expect(
        reads.some(
          (where) =>
            "securityId" in where && "priceDate" in where && !("id" in where),
        ),
      ).toBe(false);
    });

    it("keeps a stored field the quote does not carry, reading it from the row", async () => {
      // `?? existing.x` on a copy fetched earlier would write back whatever that
      // copy held, overwriting a value another writer had since stored. The
      // COALESCE reads the row as it is at write time.
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      seedStoredPrice({ ...mockPriceEntry, openPrice: 111.0 });
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(
            makeYahooChartResponse({ regularMarketPrice: 200 }),
          ),
        ) as jest.Mock;

      await service.refreshAllPrices();

      expect(upsertedPrices).toHaveLength(1);
      // The fixture carries a close and a volume but no open, so only the open
      // falls back -- and it falls back to what is stored.
      expect(upsertedPrices[0]).toMatchObject({
        closePrice: 200,
        openPrice: 111.0,
      });
      for (const column of [
        "open_price",
        "high_price",
        "low_price",
        "volume",
      ]) {
        expect(priceUpsertSql()).toContain(`COALESCE(EXCLUDED.${column},`);
      }
    });
  });

  describe("createManualPrice", () => {
    it("should create a new manual price entry", async () => {
      await service.createManualPrice(
        "sec-1",
        {
          priceDate: "2025-06-01",
          closePrice: 150.5,
        },
        "user-1",
      );

      expect(upsertedPrices).toHaveLength(1);
      expect(upsertedPrices[0]).toMatchObject({
        securityId: "sec-1",
        priceDate: "2025-06-01",
        closePrice: 150.5,
        source: "manual",
      });
      expect(priceUpsertSql()).toContain(
        "ON CONFLICT (security_id, price_date) DO UPDATE",
      );
    });

    it("should overwrite existing price entry", async () => {
      const existing = { ...mockPriceEntry, source: "yahoo_finance" };
      // A row already stored for this security and date: the upsert's
      // `ON CONFLICT DO UPDATE` merges onto it rather than inserting.
      seedStoredPrice(existing);

      await service.createManualPrice(
        "sec-1",
        {
          priceDate: "2025-06-01",
          closePrice: 200.0,
        },
        "user-1",
      );

      // One statement: the manual entry merges onto the provider's row for the
      // same day instead of racing it to a unique violation.
      expect(upsertedPrices).toHaveLength(1);
      expect(upsertedPrices[0]).toMatchObject({
        closePrice: 200.0,
        source: "manual",
      });
    });

    it("a manual price written over a bond-engine row takes no adjusted close from it (R3)", async () => {
      await service.createManualPrice(
        "sec-1",
        { priceDate: "2025-06-01", closePrice: 101.5 },
        "user-1",
      );
      // The conflict branch sets the adjusted close from the manual entry's own
      // input (it has none) when the row it replaces is the engine's; any other
      // row keeps the adjusted close it had.
      expect(priceUpsertSql()).toMatch(
        /adjusted_close = CASE WHEN security_prices\.source = 'bond_engine'\s+THEN NULL ELSE security_prices\.adjusted_close END/,
      );
    });

    // Issue #1242 invalidation: a manual price changes an accepted close, so
    // every account holding the security has a stale monthly snapshot. The
    // create recomputes them through the shared debounced net-worth path.
    it("recalculates the snapshots of accounts holding the security", async () => {
      dataSourceMock.query.mockImplementation(async (sql: string) => {
        if (/SELECT DISTINCT account_id/.test(sql)) {
          return [{ account_id: "acc-1" }, { account_id: "acc-2" }];
        }
        return [];
      });

      await service.createManualPrice(
        "sec-1",
        { priceDate: "2026-08-20", closePrice: 120 },
        "user-1",
      );

      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "acc-1",
        "user-1",
      );
      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "acc-2",
        "user-1",
      );
    });

    // MZ-1242-R2: the recompute must survive a crash before the debounce
    // timer fires, so the write path advances accounts.updated_at in the same
    // transaction as the price -- a marker sweepStaleSnapshots reads.
    // The debounce is only a latency optimization on top of it.
    it("advances holding accounts' updated_at as a stale-recovery marker", async () => {
      const calls: Array<{ sql: string; params?: unknown[] }> = [];
      dataSourceMock.query.mockImplementation(
        async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params });
          if (/SELECT DISTINCT account_id/.test(sql)) {
            return [{ account_id: "acc-1" }, { account_id: "acc-2" }];
          }
          return [];
        },
      );

      await service.createManualPrice(
        "sec-1",
        { priceDate: "2026-08-20", closePrice: 120 },
        "user-1",
      );

      const touch = calls.find(
        (c) =>
          /UPDATE accounts/.test(c.sql) &&
          /updated_at\s*=\s*now\(\)/.test(c.sql),
      );
      expect(touch).toBeDefined();
      // Scoped to the holding accounts and the owner.
      expect(touch?.params?.[0]).toEqual(["acc-1", "acc-2"]);
      expect(touch?.params?.[1]).toBe("user-1");
    });

    // MZ-1242 lock ordering: the marker's UPDATE locks the same holding
    // accounts a background recompute locks, and the debounced recompute runs
    // concurrently -- so the marker must take the row locks in the shared
    // ascending-id order (lockAccountsForBalanceWrite) *before* the UPDATE, or
    // two overlapping manual-price saves deadlock (40P01). Assert both the
    // ordering relative to the UPDATE and that the lock is sorted and
    // owner-scoped.
    it("locks holding accounts in ascending-id order before advancing the marker", async () => {
      const calls: Array<{ sql: string; params?: unknown[] }> = [];
      dataSourceMock.query.mockImplementation(
        async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params });
          if (/SELECT DISTINCT account_id/.test(sql)) {
            // Returned out of order on purpose: the lock helper must sort.
            return [{ account_id: "acc-2" }, { account_id: "acc-1" }];
          }
          return [];
        },
      );

      await service.createManualPrice(
        "sec-1",
        { priceDate: "2026-08-20", closePrice: 120 },
        "user-1",
      );

      const lockIdx = calls.findIndex(
        (c) =>
          /FROM accounts/.test(c.sql) &&
          /FOR UPDATE/.test(c.sql) &&
          /ORDER BY id/.test(c.sql),
      );
      const updateIdx = calls.findIndex(
        (c) =>
          /UPDATE accounts/.test(c.sql) &&
          /updated_at\s*=\s*now\(\)/.test(c.sql),
      );
      expect(lockIdx).toBeGreaterThanOrEqual(0);
      expect(updateIdx).toBeGreaterThanOrEqual(0);
      // The lock is taken before the write it protects.
      expect(lockIdx).toBeLessThan(updateIdx);
      // Ascending-id order, owner-scoped -- the deadlock guard.
      expect(calls[lockIdx].params?.[0]).toEqual(["acc-1", "acc-2"]);
      expect(calls[lockIdx].params?.[1]).toBe("user-1");
    });
  });

  describe("updatePrice", () => {
    it("should update an existing price entry", async () => {
      securityPriceRepository.findOne.mockResolvedValue({
        ...mockPriceEntry,
      });

      await service.updatePrice("sec-1", 1, { closePrice: 200.0 }, "user-1");

      expect(securityPriceRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          closePrice: 200.0,
          source: "manual",
        }),
      );
    });

    it("editing a bond-engine row makes it manual and drops the engine's adjusted close", async () => {
      securityPriceRepository.findOne.mockResolvedValue({
        ...mockPriceEntry,
        source: "bond_engine",
        adjustedClose: 99.5,
      });
      await service.updatePrice("sec-1", 1, { closePrice: 200.0 }, "user-1");
      expect(securityPriceRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "manual",
          closePrice: 200.0,
          adjustedClose: null,
        }),
      );
    });

    it("editing a provider row keeps its adjusted close", async () => {
      securityPriceRepository.findOne.mockResolvedValue({
        ...mockPriceEntry,
        source: "yahoo_finance",
        adjustedClose: 99.5,
      });
      await service.updatePrice("sec-1", 1, { closePrice: 200.0 }, "user-1");
      expect(securityPriceRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ source: "manual", adjustedClose: 99.5 }),
      );
    });

    it("recalculates the snapshots of accounts holding the security", async () => {
      securityPriceRepository.findOne.mockResolvedValue({ ...mockPriceEntry });
      dataSourceMock.query.mockImplementation(async (sql: string) =>
        /SELECT DISTINCT account_id/.test(sql) ? [{ account_id: "acc-1" }] : [],
      );

      await service.updatePrice("sec-1", 1, { closePrice: 200.0 }, "user-1");

      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "acc-1",
        "user-1",
      );
    });

    it("should throw NotFoundException when price not found", async () => {
      securityPriceRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updatePrice("sec-1", 999, { closePrice: 200.0 }, "user-1"),
      ).rejects.toThrow("Security price not found");
    });
  });

  describe("deletePrice", () => {
    it("should delete a price entry and attempt backfill", async () => {
      const priceToDelete = {
        ...mockPriceEntry,
        priceDate: "2025-06-01",
      };
      securityPriceRepository.findOne.mockResolvedValue(priceToDelete);
      securityPriceRepository.remove = jest.fn().mockResolvedValue(undefined);
      dataSourceMock.query.mockResolvedValue([
        { avg_price: null, latest_action: null },
      ]);

      await service.deletePrice("sec-1", 1, "user-1");

      expect(securityPriceRepository.remove).toHaveBeenCalledWith(
        priceToDelete,
      );
    });

    it("recalculates the snapshots of accounts holding the security after deletion", async () => {
      securityPriceRepository.findOne.mockResolvedValue({
        ...mockPriceEntry,
        priceDate: "2025-06-01",
      });
      securityPriceRepository.remove = jest.fn().mockResolvedValue(undefined);
      dataSourceMock.query.mockImplementation(async (sql: string) => {
        if (/SELECT DISTINCT account_id/.test(sql)) {
          return [{ account_id: "acc-1" }];
        }
        // upsertTransactionPrice's read finds no transaction to restore.
        return [{ avg_price: null, latest_action: null }];
      });

      await service.deletePrice("sec-1", 1, "user-1");

      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "acc-1",
        "user-1",
      );
    });

    it("should throw NotFoundException when price not found", async () => {
      securityPriceRepository.findOne.mockResolvedValue(null);

      await expect(service.deletePrice("sec-1", 999, "user-1")).rejects.toThrow(
        "Security price not found",
      );
    });
  });

  describe("backfillTransactionPrices", () => {
    it("should process all transaction pairs", async () => {
      dataSourceMock.query
        .mockResolvedValueOnce([
          {
            security_id: "sec-1",
            transaction_date: "2025-06-01",
            avg_price: "150.000000",
            latest_action: "BUY",
          },
          {
            security_id: "sec-1",
            transaction_date: "2025-06-02",
            avg_price: "155.000000",
            latest_action: "SELL",
          },
        ])
        .mockResolvedValueOnce({ rowCount: 2 });

      const result = await service.backfillTransactionPrices();

      expect(result.processed).toBe(2);
      expect(dataSourceMock.query).toHaveBeenCalledTimes(2);
      const insertCall = dataSourceMock.query.mock.calls[1];
      expect(insertCall[0]).toContain("INSERT INTO security_prices");
    });

    it("should return zeros when no transactions exist", async () => {
      dataSourceMock.query.mockResolvedValueOnce([]);

      const result = await service.backfillTransactionPrices();

      expect(result.processed).toBe(0);
      expect(result.created).toBe(0);
    });
  });

  describe("fetchAuthoritativeCurrency", () => {
    it("returns the instrument's currency from a live quote", async () => {
      const spy = jest
        .spyOn(YahooFinanceService.prototype, "fetchQuote")
        .mockResolvedValue({
          symbol: "AGGG.L",
          currencyCode: "USD",
        } as never);

      const currency = await service.fetchAuthoritativeCurrency(
        "user-1",
        "AGGG.L",
        "LSE",
      );

      expect(currency).toBe("USD");
      spy.mockRestore();
    });

    it("returns null when no provider reports a currency", async () => {
      // Yahoo returns a quote without a currency; MSN is mocked to null.
      const spy = jest
        .spyOn(YahooFinanceService.prototype, "fetchQuote")
        .mockResolvedValue({ symbol: "X" } as never);

      const currency = await service.fetchAuthoritativeCurrency(
        "user-1",
        "X",
        null,
      );

      expect(currency).toBeNull();
      spy.mockRestore();
    });
  });
  /**
   * On-demand price fill, for the securities a point-in-time report could not
   * price (the price half of "Total unavailable" on the Account Balances
   * report as its date moves back through years nothing ever backfilled).
   */
  describe("ensurePricesForDate", () => {
    /** An ISO date `days` before today, so the fixtures never pin a calendar. */
    const daysAgo = (days: number): string =>
      new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

    /** Rows the bulk upsert wrote, flattened out of its parameter list. */
    const bulkInserted = (): Array<{ securityId: string; date: string }> => {
      const rows: Array<{ securityId: string; date: string }> = [];
      for (const [sql, params] of dataSourceMock.query.mock.calls) {
        if (
          typeof sql !== "string" ||
          !sql.includes("INSERT INTO security_prices") ||
          !Array.isArray(params)
        ) {
          continue;
        }
        for (let i = 0; i < params.length; i += 9) {
          rows.push({
            securityId: params[i] as string,
            date: params[i + 1] as string,
          });
        }
      }
      return rows;
    };

    const bar = (date: string, close: number) => ({
      date: new Date(`${date}T00:00:00.000Z`),
      open: close,
      high: close,
      low: close,
      close,
      adjClose: close,
      volume: 1,
    });

    let windowSpy: jest.SpyInstance;

    beforeEach(() => {
      windowSpy = jest
        .spyOn(yahoo, "fetchHistoricalWindowSeries")
        .mockResolvedValue(null);
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
    });

    afterEach(() => windowSpy.mockRestore());

    // A month rather than a day, and with the boundary lead, for the same
    // reason the FX fill uses one: the call costs the same either way and the
    // rest of the month becomes a database read.
    it("fetches the month around the date and stores every bar", async () => {
      const date = "2017-08-18";
      windowSpy.mockResolvedValue({
        prices: [bar("2017-08-16", 20), bar("2017-08-17", 21)],
        currencyCode: "USD",
      });

      const loaded = await service.ensurePricesForDate(["sec-1"], date);

      expect(loaded).toBe(2);
      expect(windowSpy).toHaveBeenCalledTimes(1);
      const [symbol, exchange, from, to] = windowSpy.mock.calls[0];
      expect(symbol).toBe("AAPL");
      expect(exchange).toBe("NASDAQ");
      expect((from as Date).toISOString().slice(0, 10)).toBe("2017-07-18");
      expect((to as Date).toISOString().slice(0, 10)).toBe("2017-08-31");
      expect(bulkInserted()).toEqual([
        { securityId: "sec-1", date: "2017-08-16" },
        { securityId: "sec-1", date: "2017-08-17" },
      ]);
    });

    // An import that auto-generated a symbol set the flag precisely because
    // fetching against it can only fail.
    it("skips a security marked to skip price updates", async () => {
      securitiesRepository.find.mockResolvedValue([
        {
          ...mockSecurity,
          skipPriceUpdates: true,
          quoteProvider: null,
          msnInstrumentId: null,
        },
      ]);

      const loaded = await service.ensurePricesForDate(["sec-1"], "2017-08-18");

      expect(loaded).toBe(0);
      expect(windowSpy).not.toHaveBeenCalled();
    });

    // MSN's chart API takes a named timeframe, not a window, so the fill asks
    // for the narrowest range that still reaches the date.
    it("falls back to a named range for a provider with no window fetch", async () => {
      securitiesRepository.find.mockResolvedValue([
        { ...mockSecurity, quoteProvider: "msn" },
      ]);
      msnFinanceService.fetchHistoricalSeries.mockResolvedValue({
        prices: [bar(daysAgo(3000), 20)],
        currencyCode: "USD",
      });

      const loaded = await service.ensurePricesForDate(
        ["sec-1"],
        daysAgo(3000),
      );

      expect(loaded).toBe(1);
      expect(windowSpy).not.toHaveBeenCalled();
      const [, , range] = msnFinanceService.fetchHistoricalSeries.mock.calls[0];
      // A shade over eight years back: "5y" would not reach it and "max" is
      // more than it needs.
      expect(range).toBe("10y");
    });

    it("asks for only a year when the date is months old", async () => {
      securitiesRepository.find.mockResolvedValue([
        { ...mockSecurity, quoteProvider: "msn" },
      ]);
      msnFinanceService.fetchHistoricalSeries.mockResolvedValue({
        prices: [bar(daysAgo(60), 20)],
        currencyCode: "USD",
      });

      await service.ensurePricesForDate(["sec-1"], daysAgo(60));

      const [, , range] = msnFinanceService.fetchHistoricalSeries.mock.calls[0];
      expect(range).toBe("1y");
    });

    // The one case the fetch can never satisfy is the one that would otherwise
    // repeat on every page load.
    it("does not ask again for a security-month that came back empty", async () => {
      // `[]`, not `null`: the provider answering "no bars in that window" is
      // what may be remembered. `null` is no answer at all -- a failure or a
      // refusal -- and remembering that poisons the month for everyone. Every
      // routed provider answers empty here (A26-L20).
      windowSpy.mockResolvedValue({ prices: [], currencyCode: null });
      msnFinanceService.fetchHistoricalSeries.mockResolvedValue({
        prices: [],
        currencyCode: null,
      });

      await service.ensurePricesForDate(["sec-1"], "2017-08-18");
      const afterFirst = windowSpy.mock.calls.length;
      expect(afterFirst).toBeGreaterThan(0);

      const loaded = await service.ensurePricesForDate(["sec-1"], "2017-08-30");

      expect(loaded).toBe(0);
      expect(windowSpy).toHaveBeenCalledTimes(afterFirst);
    });

    it("does ask again for a different month", async () => {
      windowSpy.mockResolvedValue({ prices: [], currencyCode: null });

      await service.ensurePricesForDate(["sec-1"], "2017-08-18");
      const afterFirst = windowSpy.mock.calls.length;

      await service.ensurePricesForDate(["sec-1"], "2017-09-18");

      expect(windowSpy.mock.calls.length).toBeGreaterThan(afterFirst);
    });

    // Best-effort by construction: this runs inside a read that answered
    // everything else.
    it("lets the other securities through when one fetch throws", async () => {
      securitiesRepository.find.mockResolvedValue([
        mockSecurity,
        mockSecurityTSX,
      ]);
      windowSpy.mockImplementation(async (symbol: string) => {
        if (symbol === "AAPL") throw new Error("rate limited");
        // RY is the TSX security, recorded in CAD: the answer has to be in the
        // security's own currency or the fill refuses it, which is a different
        // test.
        return { prices: [bar("2017-08-17", 90)], currencyCode: "CAD" };
      });

      const loaded = await service.ensurePricesForDate(
        ["sec-1", "sec-2"],
        "2017-08-18",
      );

      expect(loaded).toBe(1);
      expect(bulkInserted()).toEqual([
        { securityId: "sec-2", date: "2017-08-17" },
      ]);
    });

    it("does nothing at all when asked for no securities", async () => {
      const loaded = await service.ensurePricesForDate([], "2017-08-18");

      expect(loaded).toBe(0);
      expect(securitiesRepository.find).not.toHaveBeenCalled();
      expect(windowSpy).not.toHaveBeenCalled();
    });
  });
  describe("ensurePricesForDate and the empty-window memory", () => {
    /** One security the fill will ask the provider about. */
    const seedSecurity = () => {
      securitiesRepository.find.mockResolvedValue([
        {
          id: "sec-1",
          userId: "user-1",
          symbol: "AAPL",
          exchange: "NASDAQ",
          currencyCode: "USD",
          isActive: true,
          skipPriceUpdates: false,
        },
      ]);
    };

    const dnsFailure = () =>
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("getaddrinfo EAI_AGAIN"), {
          code: "EAI_AGAIN",
        }),
      });

    it("does not remember an empty window the provider never answered", async () => {
      // A refusal and a transport failure both produce zero stored bars, and
      // this memory holds for 30 minutes across every security in the report:
      // remembering one leaves a whole portfolio unpriced long after a
      // two-minute outage ended.
      seedSecurity();
      jest
        .spyOn(yahoo, "fetchHistoricalWindowSeries")
        .mockImplementation(async () => {
          health.recordFailure("yahoo_finance", dnsFailure());
          return null;
        });

      await service.ensurePricesForDate(["sec-1"], "2026-03-15");

      // Asked again in the same month: the provider is asked again, not
      // written off.
      securitiesRepository.find.mockClear();
      await service.ensurePricesForDate(["sec-1"], "2026-03-16");
      expect(securitiesRepository.find).toHaveBeenCalled();
    });

    it("does not remember a window empty while another routed provider failed", async () => {
      // A26-L20: Yahoo answering [] for a window it lacks is not "this month
      // has no prices" while MSN, the next provider routed, timed out -- MSN
      // was never heard from, so the month is asked again.
      seedSecurity();
      jest
        .spyOn(yahoo, "fetchHistoricalWindowSeries")
        .mockResolvedValue({ prices: [], currencyCode: "USD" });
      msnFinanceService.fetchHistoricalSeries.mockRejectedValue(
        new Error("timeout"),
      );

      await service.ensurePricesForDate(["sec-1"], "2017-03-15");
      expect(msnFinanceService.fetchHistoricalSeries).toHaveBeenCalled();

      securitiesRepository.find.mockClear();
      await service.ensurePricesForDate(["sec-1"], "2017-03-16");
      expect(securitiesRepository.find).toHaveBeenCalled();
    });

    it("still remembers a window the provider answered as empty", async () => {
      // The memory has to keep working, or a report reloaded on the same date
      // re-asks the provider for every security it has no history for.
      seedSecurity();
      jest
        .spyOn(yahoo, "fetchHistoricalWindowSeries")
        .mockResolvedValue({ prices: [], currencyCode: null });
      msnFinanceService.fetchHistoricalSeries.mockResolvedValue({
        prices: [],
        currencyCode: null,
      });

      await service.ensurePricesForDate(["sec-1"], "2026-03-15");

      securitiesRepository.find.mockClear();
      await service.ensurePricesForDate(["sec-1"], "2026-03-16");
      expect(securitiesRepository.find).not.toHaveBeenCalled();
    });
  });

  /**
   * A stored price row is a bare number; the currency it is read in is the
   * security's. So an answer about another listing of the same ticker is wrong
   * by the exchange rate on every row, and nothing in the series says so.
   * INV-PRICE-001.
   */
  describe("provider currency acceptance", () => {
    /** Every statement that would have written into `security_prices`. */
    const priceWrites = (): unknown[][] =>
      [
        ...scopedManagerQuery.mock.calls,
        ...dataSourceMock.query.mock.calls,
      ].filter(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("INSERT INTO security_prices"),
      );

    it("refuses a quote in another currency and writes nothing", async () => {
      // AAPL is recorded in USD; the provider answers about a GBP listing.
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(
          makeYahooChartResponse({
            currency: "GBP",
            regularMarketPrice: 150,
          }),
        ),
      ) as jest.Mock;

      const result = await service.refreshAllPrices();

      expect(result.updated).toBe(0);
      expect(result.failed).toBe(1);
      // Both currencies named, because the reader has to know which side to
      // correct.
      expect(result.results[0].error).toContain("GBP");
      expect(result.results[0].error).toContain("USD");
      expect(priceWrites()).toHaveLength(0);
    });

    it("accepts the pence quote unit for a GBP security, converted once", async () => {
      securitiesRepository.find.mockResolvedValue([
        { ...mockSecurity, currencyCode: "GBP" } as Security,
      ]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(
          makeYahooChartResponse({
            currency: "GBp",
            regularMarketPrice: 19350,
          }),
        ),
      ) as jest.Mock;

      const result = await service.refreshAllPrices();

      expect(result.updated).toBe(1);
      // 19350 pence stored as 193.50 pounds: the provider divides once, and
      // the acceptance check maps the code without touching the number again.
      expect(result.results[0].price).toBe(193.5);
    });

    it("stores an answer from a provider that reports no currency, and says so", async () => {
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(makeYahooChartResponse()),
        ) as jest.Mock;

      const result = await service.refreshAllPrices();

      // Unverifiable is accepted rather than refused: MSN's chart series
      // reports no currency at all, and refusing every silent provider would
      // leave those securities with no prices.
      expect(result.updated).toBe(1);
      expect(
        warn.mock.calls.some(([line]) => String(line).includes("unverified")),
      ).toBe(true);
      warn.mockRestore();
    });

    it("refuses a mismatching historical series and upserts no bars", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      dataSourceMock.query.mockResolvedValueOnce([]);
      const daySeconds = 24 * 60 * 60;
      const nowSeconds = Math.floor(Date.now() / 1000);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(
          makeYahooHistoricalResponse({
            currency: "GBP",
            timestamps: [nowSeconds - 2 * daySeconds, nowSeconds - daySeconds],
            closes: [193.0, 194.0],
          }),
        ),
      ) as jest.Mock;

      const result = await service.backfillHistoricalPrices();

      expect(result.successful).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.results[0].error).toContain("GBP");
      expect(priceWrites()).toHaveLength(0);
    });

    /**
     * A symbol group is keyed on symbol and exchange, never on currency. One
     * member's mis-recorded currency must not decide the fetch for the rest:
     * the group is asked as a whole, and the refusal is made per security at
     * the write.
     */
    it("prices the members a group answer fits although the representative refuses it", async () => {
      const misrecorded = {
        ...mockSecurity,
        id: "sec-eur",
        currencyCode: "EUR",
      } as Security;
      const correct = {
        ...mockSecurity,
        id: "sec-usd",
        currencyCode: "USD",
      } as Security;
      // The mis-recorded one is first, so it is the group's representative.
      securitiesRepository.find.mockResolvedValue([misrecorded, correct]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(
          makeYahooChartResponse({
            currency: "USD",
            regularMarketPrice: 150,
          }),
        ),
      ) as jest.Mock;

      const result = await service.refreshAllPrices();

      expect(result.updated).toBe(1);
      expect(result.failed).toBe(1);
      const writes = priceWrites();
      expect(writes).toHaveLength(1);
      expect((writes[0][1] as unknown[])[0]).toBe("sec-usd");
      const refused = result.results.find((r) => !r.success);
      expect(refused?.error).toContain("EUR");
    });

    it("fails the whole group only when no member could store the answer", async () => {
      const eur = { ...mockSecurity, id: "sec-eur", currencyCode: "EUR" };
      const cad = { ...mockSecurity, id: "sec-cad", currencyCode: "CAD" };
      securitiesRepository.find.mockResolvedValue([eur, cad] as Security[]);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(
          makeYahooChartResponse({
            currency: "USD",
            regularMarketPrice: 150,
          }),
        ),
      ) as jest.Mock;

      const result = await service.refreshAllPrices();

      expect(result.updated).toBe(0);
      expect(result.failed).toBe(2);
      expect(priceWrites()).toHaveLength(0);
    });

    /**
     * The per-security check at the backfill write, which the group fetch now
     * relies on: it is the only thing standing between a group answer and a
     * member recorded in another currency.
     */
    it("backfills only the group members the series' currency fits", async () => {
      const misrecorded = {
        ...mockSecurity,
        id: "sec-eur",
        currencyCode: "EUR",
      } as Security;
      const correct = {
        ...mockSecurity,
        id: "sec-usd",
        currencyCode: "USD",
      } as Security;
      securitiesRepository.find.mockResolvedValue([misrecorded, correct]);
      dataSourceMock.query.mockResolvedValueOnce([]);
      const daySeconds = 24 * 60 * 60;
      const nowSeconds = Math.floor(Date.now() / 1000);
      global.fetch = jest.fn().mockResolvedValue(
        createMockFetchResponse(
          makeYahooHistoricalResponse({
            currency: "USD",
            timestamps: [nowSeconds - 2 * daySeconds, nowSeconds - daySeconds],
            closes: [193.0, 194.0],
          }),
        ),
      ) as jest.Mock;

      const result = await service.backfillHistoricalPrices();

      expect(result.successful).toBe(1);
      expect(result.failed).toBe(1);
      const writes = priceWrites();
      expect(writes.length).toBeGreaterThan(0);
      // Whatever the bulk statement was issued through, every bar it carries
      // belongs to the security the series' currency fits.
      for (const [, params] of writes) {
        expect((params as unknown[]).includes("sec-eur")).toBe(false);
        expect((params as unknown[]).includes("sec-usd")).toBe(true);
      }
    });

    it("refuses the fallback provider's answer on the same comparison", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      // The primary has nothing usable, so the fallback gets its turn -- and
      // faces the same check rather than being trusted for having answered.
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse({ chart: { result: [] } }),
        ) as jest.Mock;
      msnFinanceService.fetchQuote.mockResolvedValue({
        symbol: "AAPL",
        regularMarketPrice: 150,
        regularMarketTime: 1748800000,
        currencyCode: "GBP",
        provider: "msn",
      });

      const result = await service.refreshAllPrices();

      expect(result.updated).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.results[0].error).toContain("GBP");
      expect(priceWrites()).toHaveLength(0);
    });
  });
  // INV-BOND-005: the bond engine is a linked security's only automatic price
  // source. Each path below fetches from a provider for some other security
  // class; none may fetch for this one. provider-priced.guard.spec.ts holds that
  // every such path consults the predicate; these hold what it does.
  describe("a bond-linked security is never priced by a quote provider", () => {
    const linked = {
      ...mockSecurity,
      symbol: "TOS1029",
      bondProgramId: "11111111-1111-5111-8111-111111111111",
      // The strongest opt-in a user can give a provider: an explicit override.
      quoteProvider: "yahoo",
      skipPriceUpdates: false,
    } as Security;

    beforeEach(() => {
      global.fetch = jest.fn() as jest.Mock;
      securitiesRepository.find.mockResolvedValue([linked]);
    });

    it("is skipped by the scheduled quote refresh", async () => {
      const result = await service.refreshAllPrices();
      expect(result.totalSecurities).toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(msnFinanceService.fetchQuote).not.toHaveBeenCalled();
    });

    it("is skipped by the refresh of selected securities", async () => {
      const result = await service.refreshPricesForSecurities(["sec-1"]);
      expect(result.totalSecurities).toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("is skipped by the daily settlement", async () => {
      const result = await service.settleDailyBars();
      expect(result.totalSecurities).toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("is skipped by the scheduled historical backfill", async () => {
      dataSourceMock.query.mockResolvedValueOnce([]);
      const result = await service.backfillHistoricalPrices();
      expect(result.totalSecurities).toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("is skipped by the on-demand fill behind a report", async () => {
      const loaded = await service.ensurePricesForDate(["sec-1"], "2026-10-01");
      expect(loaded).toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("is skipped by the one-year backfill a new security gets, forced or not", async () => {
      await service.backfillSecurity(linked);
      await expect(
        service.backfillSecurityRange(linked, "max", { force: true }),
      ).resolves.toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("answers an explicit holding-period backfill with the reason, fetching nothing", async () => {
      securitiesRepository.findOne.mockResolvedValue(linked);

      for (const range of [undefined, "5y" as const]) {
        const result = await service.backfillSecurityHoldingPeriod(
          TEST_USER_ID,
          "sec-1",
          range,
        );
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/priced by the bond engine/);
      }
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("leaves an unlinked security with the same override eligible", async () => {
      securitiesRepository.find.mockResolvedValue([
        { ...mockSecurity, bondProgramId: null, quoteProvider: "yahoo" },
      ]);
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          createMockFetchResponse(makeYahooChartResponse()),
        ) as jest.Mock;
      const result = await service.refreshPricesForSecurities(["sec-1"]);
      expect(result.totalSecurities).toBe(1);
    });
  });
});
