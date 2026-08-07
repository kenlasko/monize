import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ExchangeRateService } from "./exchange-rate.service";
import { ExchangeRate } from "./entities/exchange-rate.entity";
import { Currency } from "./entities/currency.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { YahooFinanceService } from "../securities/yahoo-finance.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { roundFxRate } from "../common/fx-entry.util";
import {
  getRequestContext,
  requestContextStorage,
} from "../common/request-context";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("ExchangeRateService", () => {
  let service: ExchangeRateService;
  let exchangeRateRepository: Record<string, jest.Mock>;
  /** Rows the single-rate upsert wrote, in order, as the service supplied them. */
  let upsertedRates: Array<{
    fromCurrency: string;
    toCurrency: string;
    rate: number;
    source: string;
  }>;
  let currencyRepository: Record<string, jest.Mock>;
  let userPreferenceRepository: Record<string, jest.Mock>;
  let dataSource: Record<string, jest.Mock>;
  let yahooFinanceService: Record<string, jest.Mock>;

  const mockExchangeRate: ExchangeRate = {
    id: 1,
    fromCurrency: "USD",
    toCurrency: "CAD",
    rate: 1.365,
    rateDate: new Date("2026-02-10"),
    source: "yahoo_finance",
    fromCurrencyRef: null as any,
    toCurrencyRef: null as any,
    createdAt: new Date("2026-02-10T12:00:00Z"),
  };

  const mockCurrency: Currency = {
    code: "USD",
    name: "US Dollar",
    symbol: "$",
    decimalPlaces: 2,
    isActive: true,
    createdByUserId: null,
    createdAt: new Date("2025-01-01"),
  };

  const createMockQueryBuilder = (
    overrides: Record<string, jest.Mock> = {},
  ) => ({
    distinctOn: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    ...overrides,
  });

  /**
   * Answer `manager.query` by statement instead of with one blanket value.
   *
   * The single-rate save is now `INSERT ... ON CONFLICT DO UPDATE RETURNING id`,
   * so a test that also needs the currency-list query cannot use one
   * `mockResolvedValue` for both. This records what the upsert wrote -- which is
   * what the assertions are about -- and answers the currency list from
   * `codes`.
   */
  function routeRateQueries(codes: string[]): void {
    dataSource.query.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (
          typeof sql === "string" &&
          sql.includes("INSERT INTO exchange_rates") &&
          sql.includes("RETURNING id")
        ) {
          const [fromCurrency, toCurrency, , rate] = params as [
            string,
            string,
            Date,
            number,
          ];
          const id = upsertedRates.length + 1;
          upsertedRates.push({
            fromCurrency,
            toCurrency,
            rate,
            source: "yahoo_finance",
          });
          return [{ id }];
        }
        if (typeof sql === "string" && sql.includes("SELECT DISTINCT code")) {
          return codes.map((code) => ({ code }));
        }
        return [];
      },
    );
    // The service reads the upserted row back by id.
    exchangeRateRepository.findOne.mockImplementation(
      async ({ where }: { where: { id?: number } }) =>
        where?.id === undefined
          ? null
          : { id: where.id, ...upsertedRates[where.id - 1] },
    );
  }

  beforeEach(async () => {
    // The single-rate save is now one `INSERT ... ON CONFLICT DO UPDATE
    // RETURNING id` through the manager, so the spec records the statement and
    // hands back the row it wrote. `findOne` still answers the by-id read-back.
    upsertedRates = [];
    exchangeRateRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn().mockImplementation((data) => ({ ...data, id: 1 })),
      save: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: data.id || 1 })),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    };

    currencyRepository = {
      find: jest.fn(),
    };

    userPreferenceRepository = {
      findOne: jest.fn(),
    };

    // Raw SQL now runs on the scoped transaction's EntityManager; alias the
    // spec's `dataSource.query` to it so the existing assertions still watch
    // the same statements.
    const scoped = createScopedDbMocks([
      [ExchangeRate, exchangeRateRepository],
      [Currency, currencyRepository],
      [UserPreference, userPreferenceRepository],
    ]);
    scoped.dataSource.query = scoped.manager.query;
    dataSource = scoped.dataSource as unknown as Record<string, jest.Mock>;

    yahooFinanceService = {
      fetchQuote: jest.fn(),
      fetchHistorical: jest.fn(),
      fetchHistoricalWindow: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExchangeRateService,
        { provide: DataSource, useValue: dataSource },
        { provide: YahooFinanceService, useValue: yahooFinanceService },
      ],
    }).compile();

    service = module.get<ExchangeRateService>(ExchangeRateService);
  });

  describe("onModuleInit", () => {
    it("fetches rates on startup when no recent rates exist", async () => {
      // No recent rate found
      exchangeRateRepository.findOne.mockResolvedValue(null);
      // refreshAllRates dependencies: dataSource.query for used currencies
      dataSource.query
        .mockResolvedValueOnce([{ code: "USD" }]) // usedCurrencies (only 1, so no pairs)
        .mockResolvedValueOnce([]); // usersWithForeignAccounts

      await service.onModuleInit();

      // First findOne checks for recent rates
      expect(exchangeRateRepository.findOne).toHaveBeenCalledWith({
        where: { rateDate: expect.anything() },
      });
      // dataSource.query called for refreshAllRates + usersWithForeignAccounts
      expect(dataSource.query).toHaveBeenCalled();
    });

    it("skips rate fetch when recent rates exist", async () => {
      exchangeRateRepository.findOne.mockResolvedValue(mockExchangeRate);
      dataSource.query.mockResolvedValue([]); // usersWithForeignAccounts

      await service.onModuleInit();

      // dataSource.query called only once for usersWithForeignAccounts, not for refreshAllRates
      expect(dataSource.query).toHaveBeenCalledTimes(1);
    });

    it("triggers backfill for users with foreign accounts", async () => {
      // A real UUID: the startup fan-out re-wraps each backfill in
      // withUserContext, which rejects a non-UUID id.
      const backfillUserId = "11111111-1111-4111-8111-111111111111";
      exchangeRateRepository.findOne.mockResolvedValue(mockExchangeRate);
      dataSource.query.mockResolvedValue([{ user_id: backfillUserId }]);

      // Mock backfillHistoricalRates dependencies
      userPreferenceRepository.findOne.mockResolvedValue({
        userId: backfillUserId,
        defaultCurrency: "USD",
      });

      // The backfill call runs async via .catch(), so we need the query mocks for it
      // First call: usersWithForeignAccounts
      // Subsequent calls: backfill queries
      dataSource.query
        .mockResolvedValueOnce([{ user_id: backfillUserId }]) // usersWithForeignAccounts
        .mockResolvedValueOnce([]) // accountCurrencyRows
        .mockResolvedValueOnce([]); // securityCurrencyRows

      await service.onModuleInit();

      // Give the async backfill a moment to execute
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(userPreferenceRepository.findOne).toHaveBeenCalledWith({
        where: { userId: backfillUserId },
      });
    });

    it("handles errors gracefully without throwing", async () => {
      exchangeRateRepository.findOne.mockRejectedValue(new Error("DB down"));

      // Should not throw
      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });
  });

  describe("refreshAllRates", () => {
    /**
     * The pair set is assembled from every user's accounts, securities and default
     * currency, and `exchange_rates` is shared reference data -- so this is global
     * by definition. The system context used to live only in the cron, which left
     * the manual endpoint reading those tables in the requesting user's own scope:
     * identical to global at RLS_MODE=off, silently narrowed to the caller's own
     * currencies at enforce. A maintenance operation whose reach depends on which
     * caller reached it is the trap.
     */
    it("runs under a system context regardless of the caller", async () => {
      dataSource.query.mockResolvedValue([{ code: "USD" }]);
      let ctx: ReturnType<typeof getRequestContext>;
      dataSource.query.mockImplementation(() => {
        ctx = getRequestContext();
        return Promise.resolve([{ code: "USD" }]);
      });

      await requestContextStorage.run({ userId: "user-1" }, () =>
        service.refreshAllRates(),
      );

      expect(ctx).toMatchObject({ system: true });
      expect(ctx).not.toHaveProperty("userId");
    });

    it("returns empty summary when fewer than 2 currencies are in use", async () => {
      dataSource.query.mockResolvedValue([{ code: "USD" }]);

      const result = await service.refreshAllRates();

      expect(result.totalPairs).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.results).toEqual([]);
    });

    it("returns empty summary when no currencies are in use", async () => {
      dataSource.query.mockResolvedValue([]);

      const result = await service.refreshAllRates();

      expect(result.totalPairs).toBe(0);
      expect(result.updated).toBe(0);
    });

    it("builds correct pairs from 3 currencies and fetches rates", async () => {
      dataSource.query.mockResolvedValue([
        { code: "USD" },
        { code: "CAD" },
        { code: "EUR" },
      ]);

      routeRateQueries(["USD", "CAD", "EUR"]);
      yahooFinanceService.fetchQuote.mockResolvedValue({
        regularMarketPrice: 1.365,
      });

      const result = await service.refreshAllRates();

      // 3 currencies -> 3 pairs: USD/CAD, USD/EUR, CAD/EUR
      expect(result.totalPairs).toBe(3);
      expect(result.updated).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.results).toHaveLength(3);
      expect(yahooFinanceService.fetchQuote).toHaveBeenCalledTimes(3);
    });

    it("handles failed Yahoo API calls gracefully", async () => {
      dataSource.query.mockResolvedValue([{ code: "USD" }, { code: "CAD" }]);

      // fetchQuote returns null when Yahoo API fails
      yahooFinanceService.fetchQuote.mockResolvedValue(null);

      const result = await service.refreshAllRates();

      expect(result.totalPairs).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toBe("No rate data available");
    });

    it("handles fetch network errors gracefully", async () => {
      dataSource.query.mockResolvedValue([{ code: "USD" }, { code: "CAD" }]);

      // fetchQuote returns null when network error occurs (YahooFinanceService catches internally)
      yahooFinanceService.fetchQuote.mockResolvedValue(null);

      const result = await service.refreshAllRates();

      expect(result.totalPairs).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.updated).toBe(0);
    });

    it("handles missing rate data in Yahoo response", async () => {
      dataSource.query.mockResolvedValue([{ code: "USD" }, { code: "CAD" }]);

      // fetchQuote returns result without regularMarketPrice
      yahooFinanceService.fetchQuote.mockResolvedValue({});

      const result = await service.refreshAllRates();

      expect(result.failed).toBe(1);
      expect(result.updated).toBe(0);
    });

    it("upserts both directions rather than reading first and then writing", async () => {
      // The rate cron fires on every replica, so two processes routinely fetch
      // the same pair for the same day. The old shape read the row and then
      // either saved it or inserted -- a check-then-act whose loser hit
      // `UNIQUE(from_currency, to_currency, rate_date)` and, because the two
      // directions share a transaction, lost the inverse rate with it.
      routeRateQueries(["USD", "CAD"]);

      yahooFinanceService.fetchQuote.mockResolvedValue({
        regularMarketPrice: 1.4,
      });

      const result = await service.refreshAllRates();

      expect(result.updated).toBe(1);
      const upserts = dataSource.query.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "string" &&
          call[0].includes("INSERT INTO exchange_rates") &&
          call[0].includes("RETURNING id"),
      );
      expect(upserts).toHaveLength(2);
      expect(upserts[0][0]).toContain(
        "ON CONFLICT (from_currency, to_currency, rate_date) DO UPDATE",
      );
      // Forward, then the inverse.
      expect(upsertedRates[0]).toMatchObject({
        fromCurrency: "USD",
        toCurrency: "CAD",
        rate: 1.4,
      });
      // The inverse is stored at the rate column's ten decimal places, not at
      // money precision: rounding it to four (0.7143) inverts back to 1.39997,
      // which a statement quoting six decimals reconciles against by cents.
      expect(upsertedRates[1]).toMatchObject({
        fromCurrency: "CAD",
        toCurrency: "USD",
        rate: roundFxRate(1 / 1.4),
        source: "yahoo_finance",
      });
      expect(upsertedRates[1].rate).not.toBe(0.7143);
      expect(roundFxRate(1 / upsertedRates[1].rate)).toBeCloseTo(1.4, 6);
    });

    it("handles a rate write failure gracefully", async () => {
      routeRateQueries(["USD", "CAD"]);
      yahooFinanceService.fetchQuote.mockResolvedValue({
        regularMarketPrice: 1.365,
      });
      // The upsert itself fails: one pair is reported failed and the sweep
      // carries on.
      dataSource.query.mockImplementation(async (sql: string) => {
        if (
          typeof sql === "string" &&
          sql.includes("INSERT INTO exchange_rates")
        ) {
          throw new Error("DB write failed");
        }
        if (typeof sql === "string" && sql.includes("SELECT DISTINCT code")) {
          return [{ code: "USD" }, { code: "CAD" }];
        }
        return [];
      });

      const result = await service.refreshAllRates();

      expect(result.failed).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toBe("DB write failed");
    });

    it("builds correct number of pairs from 4 currencies", async () => {
      routeRateQueries(["USD", "CAD", "EUR", "GBP"]);
      yahooFinanceService.fetchQuote.mockResolvedValue({
        regularMarketPrice: 1.0,
      });

      const result = await service.refreshAllRates();

      // 4 currencies -> C(4,2) = 6 pairs
      expect(result.totalPairs).toBe(6);
      expect(result.updated).toBe(6);
    });
  });

  describe("backfillHistoricalRates", () => {
    it("uses user default currency from preferences", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "CAD",
      });
      dataSource.query
        .mockResolvedValueOnce([]) // accountCurrencyRows
        .mockResolvedValueOnce([]); // securityCurrencyRows

      const result = await service.backfillHistoricalRates("user-1");

      expect(userPreferenceRepository.findOne).toHaveBeenCalledWith({
        where: { userId: "user-1" },
      });
      expect(result.totalPairs).toBe(0);
      expect(result.successful).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.totalRatesLoaded).toBe(0);
    });

    it("defaults to USD when user has no preference", async () => {
      userPreferenceRepository.findOne.mockResolvedValue(null);
      dataSource.query
        .mockResolvedValueOnce([
          { currency_code: "EUR", earliest: "2025-01-01" },
        ]) // accountCurrencyRows
        .mockResolvedValueOnce([]) // securityCurrencyRows
        .mockResolvedValueOnce([{ count: 5 }]); // existingRates check (already exists, skip)

      const result = await service.backfillHistoricalRates("user-1");

      // Should query for EUR->USD pair (default currency is USD)
      expect(result.totalPairs).toBe(1);
      expect(result.successful).toBe(1);
      expect(result.results[0].pair).toBe("EUR/USD");
      expect(result.results[0].ratesLoaded).toBe(0); // skipped because existing
    });

    it("returns empty summary when no pairs need backfill", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "USD",
      });
      dataSource.query
        .mockResolvedValueOnce([]) // accountCurrencyRows
        .mockResolvedValueOnce([]); // securityCurrencyRows

      const result = await service.backfillHistoricalRates("user-1");

      expect(result.totalPairs).toBe(0);
      expect(result.results).toEqual([]);
    });

    it("skips rows without earliest dates", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "USD",
      });
      dataSource.query
        .mockResolvedValueOnce([{ currency_code: "EUR", earliest: null }]) // no earliest date
        .mockResolvedValueOnce([]); // securityCurrencyRows

      const result = await service.backfillHistoricalRates("user-1");

      expect(result.totalPairs).toBe(0);
    });

    it("skips pair when existing rates already exist in DB", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "USD",
      });
      dataSource.query
        .mockResolvedValueOnce([
          { currency_code: "CAD", earliest: "2025-01-01" },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 100 }]); // existing rates count > 0

      const result = await service.backfillHistoricalRates("user-1");

      expect(result.totalPairs).toBe(1);
      expect(result.successful).toBe(1);
      expect(result.results[0].ratesLoaded).toBe(0);
    });

    it("fetches and stores historical rates from Yahoo Finance", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "USD",
      });

      dataSource.query
        .mockResolvedValueOnce([
          { currency_code: "CAD", earliest: "2025-06-01" },
        ])
        .mockResolvedValueOnce([]) // securityCurrencyRows
        .mockResolvedValueOnce([{ count: 0 }]) // no existing rates
        .mockResolvedValueOnce(undefined); // bulk upsert INSERT

      yahooFinanceService.fetchHistorical.mockResolvedValue([
        {
          date: new Date("2025-06-01"),
          open: null,
          high: null,
          low: null,
          close: 1.365,
          volume: null,
        },
        {
          date: new Date("2025-06-02"),
          open: null,
          high: null,
          low: null,
          close: 1.37,
          volume: null,
        },
      ]);

      const result = await service.backfillHistoricalRates("user-1");

      expect(result.totalPairs).toBe(1);
      expect(result.successful).toBe(1);
      expect(result.totalRatesLoaded).toBe(2);
      expect(result.results[0].pair).toBe("CAD/USD");
      expect(result.results[0].ratesLoaded).toBe(2);
    });

    it("filters historical rates by cutoff date", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "USD",
      });

      dataSource.query
        .mockResolvedValueOnce([
          { currency_code: "EUR", earliest: "2025-06-15" },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }])
        .mockResolvedValueOnce(undefined); // bulk upsert

      yahooFinanceService.fetchHistorical.mockResolvedValue([
        {
          date: new Date("2025-06-01"),
          open: null,
          high: null,
          low: null,
          close: 1.1,
          volume: null,
        }, // before cutoff
        {
          date: new Date("2025-06-15"),
          open: null,
          high: null,
          low: null,
          close: 1.2,
          volume: null,
        }, // on cutoff
        {
          date: new Date("2025-06-20"),
          open: null,
          high: null,
          low: null,
          close: 1.3,
          volume: null,
        }, // after cutoff
      ]);

      const result = await service.backfillHistoricalRates("user-1");

      expect(result.successful).toBe(1);
      // Only ts2 and ts3 should pass the filter (>= cutoff)
      expect(result.results[0].ratesLoaded).toBe(2);
    });

    it("deduplicates rates with the same date", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "USD",
      });

      // YahooFinanceService already normalizes dates to midnight, so two entries with same date
      const date1 = new Date("2025-07-01");
      date1.setHours(0, 0, 0, 0);
      const date2 = new Date("2025-07-01");
      date2.setHours(0, 0, 0, 0);
      const date3 = new Date("2025-07-02");
      date3.setHours(0, 0, 0, 0);

      dataSource.query
        .mockResolvedValueOnce([
          { currency_code: "GBP", earliest: "2025-07-01" },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }])
        .mockResolvedValueOnce(undefined); // bulk upsert

      yahooFinanceService.fetchHistorical.mockResolvedValue([
        {
          date: date1,
          open: null,
          high: null,
          low: null,
          close: 1.25,
          volume: null,
        },
        {
          date: date2,
          open: null,
          high: null,
          low: null,
          close: 1.26,
          volume: null,
        },
        {
          date: date3,
          open: null,
          high: null,
          low: null,
          close: 1.27,
          volume: null,
        },
      ]);

      const result = await service.backfillHistoricalRates("user-1");

      // date1 and date2 are the same date, so one is deduped
      expect(result.results[0].ratesLoaded).toBe(2);
    });

    it("handles null/NaN close values in Yahoo response", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "USD",
      });

      dataSource.query
        .mockResolvedValueOnce([
          { currency_code: "JPY", earliest: "2025-08-01" },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }])
        .mockResolvedValueOnce(undefined); // bulk upsert

      // YahooFinanceService.fetchHistorical already filters null/NaN, so only valid entries returned
      yahooFinanceService.fetchHistorical.mockResolvedValue([
        {
          date: new Date("2025-08-03"),
          open: null,
          high: null,
          low: null,
          close: 150.5,
          volume: null,
        },
      ]);

      const result = await service.backfillHistoricalRates("user-1");

      // Only the rate with value 150.5 should be included
      expect(result.results[0].ratesLoaded).toBe(1);
    });

    it("handles Yahoo API failure for historical rates", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "USD",
      });

      dataSource.query
        .mockResolvedValueOnce([
          { currency_code: "CAD", earliest: "2025-01-01" },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }]);

      // YahooFinanceService returns null on API failure
      yahooFinanceService.fetchHistorical.mockResolvedValue(null);

      const result = await service.backfillHistoricalRates("user-1");

      expect(result.totalPairs).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.successful).toBe(0);
      expect(result.results[0].error).toBe("No historical data available");
    });

    it("handles fetch network error for historical rates", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "USD",
      });

      dataSource.query
        .mockResolvedValueOnce([
          { currency_code: "CAD", earliest: "2025-01-01" },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }]);

      // YahooFinanceService returns null on network error
      yahooFinanceService.fetchHistorical.mockResolvedValue(null);

      const result = await service.backfillHistoricalRates("user-1");

      expect(result.failed).toBe(1);
      expect(result.results[0].error).toBe("No historical data available");
    });

    it("handles database error during bulk upsert", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "USD",
      });

      dataSource.query
        .mockResolvedValueOnce([
          { currency_code: "CHF", earliest: "2025-09-01" },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }])
        .mockRejectedValueOnce(new Error("Constraint violation"));

      yahooFinanceService.fetchHistorical.mockResolvedValue([
        {
          date: new Date("2025-09-01"),
          open: null,
          high: null,
          low: null,
          close: 0.92,
          volume: null,
        },
      ]);

      const result = await service.backfillHistoricalRates("user-1");

      expect(result.failed).toBe(1);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toBe("Constraint violation");
    });

    it("passes accountIds filter when provided", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "USD",
      });
      dataSource.query
        .mockResolvedValueOnce([]) // accountCurrencyRows
        .mockResolvedValueOnce([]); // securityCurrencyRows

      await service.backfillHistoricalRates("user-1", ["acc-1", "acc-2"]);

      // The first query should include the accountIds parameter
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining("AND a.id = ANY($2::UUID[])"),
        ["USD", ["acc-1", "acc-2"]],
      );
    });

    it("returns success with 0 ratesLoaded when all filtered rates are before cutoff", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "USD",
      });

      dataSource.query
        .mockResolvedValueOnce([
          { currency_code: "MXN", earliest: "2026-01-01" },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }]);

      // Earliest transaction is 2026-01-01, but rates are all from 2025
      yahooFinanceService.fetchHistorical.mockResolvedValue([
        {
          date: new Date("2025-01-01"),
          open: null,
          high: null,
          low: null,
          close: 17.0,
          volume: null,
        },
        {
          date: new Date("2025-06-01"),
          open: null,
          high: null,
          low: null,
          close: 17.5,
          volume: null,
        },
      ]);

      const result = await service.backfillHistoricalRates("user-1");

      expect(result.successful).toBe(1);
      expect(result.results[0].ratesLoaded).toBe(0);
    });

    it("merges security and account currency rows picking the earliest date", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "USD",
      });

      // Same currency from both account and security, different earliest dates
      dataSource.query
        .mockResolvedValueOnce([
          { currency_code: "EUR", earliest: "2025-06-01" },
        ]) // account
        .mockResolvedValueOnce([
          { currency_code: "EUR", earliest: "2025-03-01" },
        ]) // security (earlier)
        .mockResolvedValueOnce([{ count: 5 }]); // existing rates

      const result = await service.backfillHistoricalRates("user-1");

      // Should only have 1 pair (EUR->USD) not 2
      expect(result.totalPairs).toBe(1);
    });

    it("handles missing timestamp or indicators in Yahoo response", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "USD",
      });

      dataSource.query
        .mockResolvedValueOnce([
          { currency_code: "SEK", earliest: "2025-01-01" },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }]);

      // YahooFinanceService returns null when response has no timestamp/indicators
      yahooFinanceService.fetchHistorical.mockResolvedValue(null);

      const result = await service.backfillHistoricalRates("user-1");

      expect(result.failed).toBe(1);
      expect(result.results[0].error).toBe("No historical data available");
    });
  });

  describe("getRateForDate", () => {
    it("returns 1 for the same currency without any lookup", async () => {
      const result = await service.getRateForDate("USD", "USD", "2026-06-08");

      expect(result).toBe(1);
      expect(exchangeRateRepository.findOne).not.toHaveBeenCalled();
      expect(yahooFinanceService.fetchHistoricalWindow).not.toHaveBeenCalled();
    });

    it("returns the closest stored rate on or before the target date", async () => {
      exchangeRateRepository.findOne.mockResolvedValue(mockExchangeRate);

      const result = await service.getRateForDate("USD", "CAD", "2026-06-08");

      expect(result).toBe(1.365);
      // Looked up the latest stored rate not after the target date.
      const call = exchangeRateRepository.findOne.mock.calls[0][0];
      expect(call.where.fromCurrency).toBe("USD");
      expect(call.where.toCurrency).toBe("CAD");
      expect(call.order).toEqual({ rateDate: "DESC" });
      // No Yahoo fetch needed when a stored rate exists.
      expect(yahooFinanceService.fetchHistoricalWindow).not.toHaveBeenCalled();
    });

    it("fetches a bounded Yahoo window around the date when none is stored", async () => {
      exchangeRateRepository.findOne.mockResolvedValue(null);
      exchangeRateRepository.save.mockImplementation((data) => data);
      // Daily series straddling the target 2026-06-08 (a weekend in this set):
      // the closest day on or before is 2026-06-05.
      yahooFinanceService.fetchHistoricalWindow.mockResolvedValue([
        {
          date: new Date("2026-06-05"),
          close: 4.25,
          open: null,
          high: null,
          low: null,
          volume: null,
        },
        {
          date: new Date("2026-06-09"),
          close: 4.3,
          open: null,
          high: null,
          low: null,
          volume: null,
        },
      ]);

      const result = await service.getRateForDate("EUR", "PLN", "2026-06-08");

      expect(result).toBe(4.25);
      // A bounded window is fetched (not the full "max" history).
      expect(yahooFinanceService.fetchHistorical).not.toHaveBeenCalled();
      expect(yahooFinanceService.fetchHistoricalWindow).toHaveBeenCalledTimes(
        1,
      );
      const [sym, fromDate, toDate] =
        yahooFinanceService.fetchHistoricalWindow.mock.calls[0];
      expect(sym).toBe("EURPLN=X");
      // Window brackets the target date, and is wide enough to be worth
      // storing: one call has to cover a run of nearby dates or a user
      // stepping the date field hits the provider's rate limit.
      const target = new Date("2026-06-08T00:00:00.000Z").getTime();
      expect((fromDate as Date).getTime()).toBeLessThan(
        target - 30 * 86_400_000,
      );
      expect((toDate as Date).getTime()).toBeGreaterThanOrEqual(target);
    });

    it("stores every day in the fetched window, both directions, not just the day asked for", async () => {
      exchangeRateRepository.findOne.mockResolvedValue(null);
      yahooFinanceService.fetchHistoricalWindow.mockResolvedValue([
        {
          date: new Date("2026-06-05"),
          close: 4.25,
          open: null,
          high: null,
          low: null,
          volume: null,
        },
        {
          date: new Date("2026-06-09"),
          close: 4.3,
          open: null,
          high: null,
          low: null,
          volume: null,
        },
      ]);

      await service.getRateForDate("EUR", "PLN", "2026-06-08");

      // One bulk upsert carrying both days in both directions. Keeping only
      // the chosen point sent the next lookup for a neighbouring date straight
      // back out to the provider, which is what ran into its rate limits.
      const insert = dataSource.query.mock.calls.find((call: any[]) =>
        String(call[0]).includes("INSERT INTO exchange_rates"),
      );
      expect(insert).toBeDefined();
      const params = insert[1] as unknown[];
      expect(params).toHaveLength(2 * 2 * 4); // 2 days x 2 directions x 4 columns

      // Read the flat parameter list back as (from, to, date, rate) rows.
      const rows: Array<[string, string, Date, number]> = [];
      for (let i = 0; i < params.length; i += 4) {
        rows.push(params.slice(i, i + 4) as [string, string, Date, number]);
      }
      const rowFor = (from: string, to: string, day: string) =>
        rows.find(
          (r) =>
            r[0] === from &&
            r[1] === to &&
            r[2].toISOString().slice(0, 10) === day,
        );

      expect(rowFor("EUR", "PLN", "2026-06-05")?.[3]).toBe(4.25);
      expect(rowFor("EUR", "PLN", "2026-06-09")?.[3]).toBe(4.3);
      // The inverse pair is written too, so a PLN->EUR lookup is a DB read --
      // and at rate precision, not money precision.
      expect(rowFor("PLN", "EUR", "2026-06-05")?.[3]).toBe(
        roundFxRate(1 / 4.25),
      );
      expect(rowFor("PLN", "EUR", "2026-06-09")?.[3]).toBe(
        roundFxRate(1 / 4.3),
      );
    });

    it("returns null when neither a stored rate nor a Yahoo window is available", async () => {
      exchangeRateRepository.findOne.mockResolvedValue(null);
      yahooFinanceService.fetchHistoricalWindow.mockResolvedValue(null);

      const result = await service.getRateForDate("EUR", "PLN", "2026-06-08");

      expect(result).toBeNull();
    });

    it("clamps a future date to today rather than hunting for a rate that cannot exist", async () => {
      exchangeRateRepository.findOne.mockResolvedValue(mockExchangeRate);
      const todayYMD = new Date().toISOString().slice(0, 10);

      // A scheduled transaction posted ahead of time: there is no rate for its
      // due date and there never will be until the day arrives, so today's is
      // the answer -- the same figure the bills list is already showing.
      const result = await service.getRateForDate("USD", "CAD", "2099-01-01");

      expect(result).toBe(1.365);
      const where = exchangeRateRepository.findOne.mock.calls[0][0].where;
      expect(where.rateDate.value.toISOString().slice(0, 10)).toBe(todayYMD);
      // No historical window: a future window contains nothing to choose from.
      expect(yahooFinanceService.fetchHistoricalWindow).not.toHaveBeenCalled();
    });

    it("carries the last trading day forward across a weekend", async () => {
      // 2026-06-06 is a Saturday. The stored lookup is on-or-before, so it
      // resolves to Friday's rate without any fetch.
      exchangeRateRepository.findOne.mockResolvedValue(mockExchangeRate);

      const result = await service.getRateForDate("USD", "CAD", "2026-06-06");

      expect(result).toBe(1.365);
      const where = exchangeRateRepository.findOne.mock.calls[0][0].where;
      expect(where.rateDate.value.toISOString().slice(0, 10)).toBe(
        "2026-06-06",
      );
      expect(yahooFinanceService.fetchHistoricalWindow).not.toHaveBeenCalled();
    });

    it("takes the nearest day either side when the target predates the window", async () => {
      exchangeRateRepository.findOne.mockResolvedValue(null);
      exchangeRateRepository.save.mockImplementation((data) => data);
      // Nothing on or before the target: the nearest point is 2026-06-10, not
      // the earliest one the series happens to start with.
      yahooFinanceService.fetchHistoricalWindow.mockResolvedValue([
        {
          date: new Date("2026-06-20"),
          close: 4.4,
          open: null,
          high: null,
          low: null,
          volume: null,
        },
        {
          date: new Date("2026-06-10"),
          close: 4.3,
          open: null,
          high: null,
          low: null,
          volume: null,
        },
      ]);

      const result = await service.getRateForDate("EUR", "PLN", "2026-06-08");

      expect(result).toBe(4.3);
    });

    it("falls back to the latest stored rate of any date when the provider has nothing", async () => {
      // The on-or-before lookup misses (the target predates every stored row),
      // and the window comes back empty -- but the pair does have a rate.
      exchangeRateRepository.findOne.mockImplementation((options: any) =>
        options.where.rateDate ? null : mockExchangeRate,
      );
      yahooFinanceService.fetchHistoricalWindow.mockResolvedValue(null);

      const result = await service.getRateForDate("USD", "CAD", "2019-01-01");

      // A known rate from another day beats refusing the posting outright.
      expect(result).toBe(1.365);
    });
  });

  describe("getLatestRates", () => {
    it("returns latest rates using distinctOn query", async () => {
      const rates = [mockExchangeRate];
      const qb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue(rates),
      });
      exchangeRateRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getLatestRates();

      expect(result).toEqual(rates);
      expect(exchangeRateRepository.createQueryBuilder).toHaveBeenCalledWith(
        "er",
      );
      expect(qb.distinctOn).toHaveBeenCalledWith([
        "er.from_currency",
        "er.to_currency",
      ]);
      expect(qb.orderBy).toHaveBeenCalledWith("er.from_currency");
      expect(qb.addOrderBy).toHaveBeenCalledWith("er.to_currency");
      expect(qb.addOrderBy).toHaveBeenCalledWith("er.rate_date", "DESC");
    });

    it("returns empty array when no rates exist", async () => {
      const qb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      exchangeRateRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getLatestRates();

      expect(result).toEqual([]);
    });
  });

  describe("getLatestRate", () => {
    it("returns 1 when from and to are the same currency", async () => {
      const result = await service.getLatestRate("USD", "USD");

      expect(result).toBe(1);
      expect(exchangeRateRepository.findOne).not.toHaveBeenCalled();
    });

    it("returns the rate value when a rate is found", async () => {
      exchangeRateRepository.findOne.mockResolvedValue(mockExchangeRate);

      const result = await service.getLatestRate("USD", "CAD");

      expect(result).toBe(1.365);
      expect(exchangeRateRepository.findOne).toHaveBeenCalledWith({
        where: { fromCurrency: "USD", toCurrency: "CAD" },
        order: { rateDate: "DESC" },
      });
    });

    it("returns null when no rate is found", async () => {
      exchangeRateRepository.findOne.mockResolvedValue(null);

      const result = await service.getLatestRate("USD", "XYZ");

      expect(result).toBeNull();
    });

    it("converts decimal rate to number", async () => {
      exchangeRateRepository.findOne.mockResolvedValue({
        ...mockExchangeRate,
        rate: "1.3650000000", // decimal string from DB
      });

      const result = await service.getLatestRate("USD", "CAD");

      expect(result).toBe(1.365);
      expect(typeof result).toBe("number");
    });
  });

  describe("getLiveRate", () => {
    it("returns 1 when from and to are the same currency", async () => {
      const result = await service.getLiveRate("USD", "USD");

      expect(result).toBe(1);
      expect(yahooFinanceService.fetchQuote).not.toHaveBeenCalled();
      expect(exchangeRateRepository.findOne).not.toHaveBeenCalled();
    });

    it("returns the live direct quote when available", async () => {
      yahooFinanceService.fetchQuote.mockResolvedValue({
        regularMarketPrice: 1.372,
      });

      const result = await service.getLiveRate("USD", "CAD");

      expect(result).toBe(1.372);
      expect(yahooFinanceService.fetchQuote).toHaveBeenCalledWith("USDCAD=X");
      // Does not touch the stored daily snapshot when a live quote exists
      expect(exchangeRateRepository.findOne).not.toHaveBeenCalled();
    });

    it("inverts the reverse live quote when the direct pair is unavailable", async () => {
      yahooFinanceService.fetchQuote
        .mockResolvedValueOnce({ regularMarketPrice: null }) // direct USDCAD=X
        .mockResolvedValueOnce({ regularMarketPrice: 0.5 }); // reverse CADUSD=X

      const result = await service.getLiveRate("USD", "CAD");

      expect(result).toBe(2);
      expect(yahooFinanceService.fetchQuote).toHaveBeenNthCalledWith(
        1,
        "USDCAD=X",
      );
      expect(yahooFinanceService.fetchQuote).toHaveBeenNthCalledWith(
        2,
        "CADUSD=X",
      );
      expect(exchangeRateRepository.findOne).not.toHaveBeenCalled();
    });

    it("falls back to the stored daily rate when no live quote is available", async () => {
      yahooFinanceService.fetchQuote.mockResolvedValue({
        regularMarketPrice: null,
      });
      exchangeRateRepository.findOne.mockResolvedValue(mockExchangeRate);

      const result = await service.getLiveRate("USD", "CAD");

      expect(result).toBe(1.365);
      expect(exchangeRateRepository.findOne).toHaveBeenCalledWith({
        where: { fromCurrency: "USD", toCurrency: "CAD" },
        order: { rateDate: "DESC" },
      });
    });

    it("falls back to the stored daily rate when the live fetch throws", async () => {
      yahooFinanceService.fetchQuote.mockRejectedValue(
        new Error("rate limited"),
      );
      exchangeRateRepository.findOne.mockResolvedValue(mockExchangeRate);

      const result = await service.getLiveRate("USD", "CAD");

      expect(result).toBe(1.365);
      expect(exchangeRateRepository.findOne).toHaveBeenCalled();
    });

    it("returns null when neither a live quote nor a stored rate exists", async () => {
      yahooFinanceService.fetchQuote.mockResolvedValue({
        regularMarketPrice: null,
      });
      exchangeRateRepository.findOne.mockResolvedValue(null);

      const result = await service.getLiveRate("USD", "XYZ");

      expect(result).toBeNull();
    });
  });

  describe("getRateHistory", () => {
    it("returns all rates when no date filters are provided", async () => {
      const rates = [mockExchangeRate];
      exchangeRateRepository.find.mockResolvedValue(rates);

      const result = await service.getRateHistory();

      expect(result).toEqual(rates);
      expect(exchangeRateRepository.find).toHaveBeenCalledWith({
        where: {},
        order: { rateDate: "ASC", fromCurrency: "ASC", toCurrency: "ASC" },
      });
    });

    it("filters by startDate only", async () => {
      exchangeRateRepository.find.mockResolvedValue([]);

      await service.getRateHistory("2025-01-01");

      expect(exchangeRateRepository.find).toHaveBeenCalledWith({
        where: { rateDate: expect.anything() },
        order: { rateDate: "ASC", fromCurrency: "ASC", toCurrency: "ASC" },
      });
    });

    it("filters by endDate only", async () => {
      exchangeRateRepository.find.mockResolvedValue([]);

      await service.getRateHistory(undefined, "2025-12-31");

      expect(exchangeRateRepository.find).toHaveBeenCalledWith({
        where: { rateDate: expect.anything() },
        order: { rateDate: "ASC", fromCurrency: "ASC", toCurrency: "ASC" },
      });
    });

    it("filters by both startDate and endDate", async () => {
      exchangeRateRepository.find.mockResolvedValue([]);

      await service.getRateHistory("2025-01-01", "2025-12-31");

      expect(exchangeRateRepository.find).toHaveBeenCalledWith({
        where: { rateDate: expect.anything() },
        order: { rateDate: "ASC", fromCurrency: "ASC", toCurrency: "ASC" },
      });
    });

    it("returns empty array when no rates match the date range", async () => {
      exchangeRateRepository.find.mockResolvedValue([]);

      const result = await service.getRateHistory("2099-01-01", "2099-12-31");

      expect(result).toEqual([]);
    });
  });

  describe("getCurrencies", () => {
    it("returns active currencies ordered by code", async () => {
      const currencies = [
        mockCurrency,
        { ...mockCurrency, code: "CAD", name: "Canadian Dollar" },
      ];
      currencyRepository.find.mockResolvedValue(currencies);

      const result = await service.getCurrencies();

      expect(result).toEqual(currencies);
      expect(currencyRepository.find).toHaveBeenCalledWith({
        where: { isActive: true },
        order: { code: "ASC" },
      });
    });

    it("returns empty array when no active currencies exist", async () => {
      currencyRepository.find.mockResolvedValue([]);

      const result = await service.getCurrencies();

      expect(result).toEqual([]);
    });
  });

  describe("getLastUpdateTime", () => {
    it("returns the createdAt of the most recently created exchange rate", async () => {
      const date = new Date("2026-02-10T15:30:00Z");
      exchangeRateRepository.findOne.mockResolvedValue({
        ...mockExchangeRate,
        createdAt: date,
      });

      const result = await service.getLastUpdateTime();

      expect(result).toEqual(date);
      expect(exchangeRateRepository.findOne).toHaveBeenCalledWith({
        where: {},
        order: { createdAt: "DESC" },
      });
    });

    it("returns null when no exchange rates exist", async () => {
      exchangeRateRepository.findOne.mockResolvedValue(null);

      const result = await service.getLastUpdateTime();

      expect(result).toBeNull();
    });

    it("returns null when rate exists but createdAt is undefined", async () => {
      exchangeRateRepository.findOne.mockResolvedValue({
        ...mockExchangeRate,
        createdAt: undefined,
      });

      const result = await service.getLastUpdateTime();

      expect(result).toBeNull();
    });
  });

  describe("scheduledRateRefresh", () => {
    it("calls refreshAllRates", async () => {
      // Mock refreshAllRates dependencies
      dataSource.query.mockResolvedValue([{ code: "USD" }]);

      await service.scheduledRateRefresh();

      expect(dataSource.query).toHaveBeenCalled();
    });

    it("handles refreshAllRates errors without throwing", async () => {
      dataSource.query.mockRejectedValue(new Error("DB error"));

      // Should not throw
      await expect(service.scheduledRateRefresh()).resolves.toBeUndefined();
    });
  });
});
