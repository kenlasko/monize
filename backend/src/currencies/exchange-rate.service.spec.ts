import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { ExchangeRateService } from "./exchange-rate.service";
import { ExchangeRate } from "./entities/exchange-rate.entity";
import { Currency } from "./entities/currency.entity";
import { Account } from "../accounts/entities/account.entity";
import { UserPreference } from "../users/entities/user-preference.entity";

describe("ExchangeRateService", () => {
  let service: ExchangeRateService;
  let exchangeRateRepository: Record<string, jest.Mock>;
  let currencyRepository: Record<string, jest.Mock>;
  let accountRepository: Record<string, jest.Mock>;
  let userPreferenceRepository: Record<string, jest.Mock>;
  let dataSource: Record<string, jest.Mock>;

  const originalFetch = global.fetch;

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
    createdAt: new Date("2025-01-01"),
  };

  const createMockQueryBuilder = (overrides: Record<string, jest.Mock> = {}) => ({
    distinctOn: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    ...overrides,
  });

  beforeEach(async () => {
    exchangeRateRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn().mockImplementation((data) => ({ ...data, id: 1 })),
      save: jest.fn().mockImplementation((data) => ({ ...data, id: data.id || 1 })),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    };

    currencyRepository = {
      find: jest.fn(),
    };

    accountRepository = {};

    userPreferenceRepository = {
      findOne: jest.fn(),
    };

    dataSource = {
      query: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExchangeRateService,
        { provide: getRepositoryToken(ExchangeRate), useValue: exchangeRateRepository },
        { provide: getRepositoryToken(Currency), useValue: currencyRepository },
        { provide: getRepositoryToken(Account), useValue: accountRepository },
        { provide: getRepositoryToken(UserPreference), useValue: userPreferenceRepository },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<ExchangeRateService>(ExchangeRateService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
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
      exchangeRateRepository.findOne.mockResolvedValue(mockExchangeRate);
      dataSource.query.mockResolvedValue([{ user_id: "user-1" }]);

      // Mock backfillHistoricalRates dependencies
      userPreferenceRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "USD",
      });

      // The backfill call runs async via .catch(), so we need the query mocks for it
      // First call: usersWithForeignAccounts
      // Subsequent calls: backfill queries
      dataSource.query
        .mockResolvedValueOnce([{ user_id: "user-1" }]) // usersWithForeignAccounts
        .mockResolvedValueOnce([]) // accountCurrencyRows
        .mockResolvedValueOnce([]); // securityCurrencyRows

      await service.onModuleInit();

      // Give the async backfill a moment to execute
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(dataSource.query).toHaveBeenCalled();
    });

    it("handles errors gracefully without throwing", async () => {
      exchangeRateRepository.findOne.mockRejectedValue(new Error("DB down"));

      // Should not throw
      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });
  });

  describe("refreshAllRates", () => {
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

      // Mock fetchYahooRate via global.fetch
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          chart: {
            result: [{ meta: { regularMarketPrice: 1.365 } }],
          },
        }),
      });

      // saveRate: no existing rate found, then save
      exchangeRateRepository.findOne.mockResolvedValue(null);
      exchangeRateRepository.save.mockImplementation((data) => ({ ...data, id: 1 }));

      const result = await service.refreshAllRates();

      // 3 currencies -> 3 pairs: USD/CAD, USD/EUR, CAD/EUR
      expect(result.totalPairs).toBe(3);
      expect(result.updated).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.results).toHaveLength(3);
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it("handles failed Yahoo API calls gracefully", async () => {
      dataSource.query.mockResolvedValue([
        { code: "USD" },
        { code: "CAD" },
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const result = await service.refreshAllRates();

      expect(result.totalPairs).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toBe("No rate data available");
    });

    it("handles fetch network errors gracefully", async () => {
      dataSource.query.mockResolvedValue([
        { code: "USD" },
        { code: "CAD" },
      ]);

      global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));

      const result = await service.refreshAllRates();

      expect(result.totalPairs).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.updated).toBe(0);
    });

    it("handles missing rate data in Yahoo response", async () => {
      dataSource.query.mockResolvedValue([
        { code: "USD" },
        { code: "CAD" },
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          chart: { result: [{ meta: {} }] },
        }),
      });

      const result = await service.refreshAllRates();

      expect(result.failed).toBe(1);
      expect(result.updated).toBe(0);
    });

    it("updates existing rate when one already exists for the date", async () => {
      dataSource.query.mockResolvedValue([
        { code: "USD" },
        { code: "CAD" },
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          chart: {
            result: [{ meta: { regularMarketPrice: 1.40 } }],
          },
        }),
      });

      const existingRate = { ...mockExchangeRate };
      exchangeRateRepository.findOne.mockResolvedValue(existingRate);
      exchangeRateRepository.save.mockImplementation((data) => data);

      const result = await service.refreshAllRates();

      expect(result.updated).toBe(1);
      // Save should be called with updated rate value
      expect(exchangeRateRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ rate: 1.40, source: "yahoo_finance" }),
      );
    });

    it("handles saveRate failure gracefully", async () => {
      dataSource.query.mockResolvedValue([
        { code: "USD" },
        { code: "CAD" },
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          chart: {
            result: [{ meta: { regularMarketPrice: 1.365 } }],
          },
        }),
      });

      exchangeRateRepository.findOne.mockResolvedValue(null);
      exchangeRateRepository.save.mockRejectedValue(new Error("DB write failed"));

      const result = await service.refreshAllRates();

      expect(result.failed).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toBe("DB write failed");
    });

    it("builds correct number of pairs from 4 currencies", async () => {
      dataSource.query.mockResolvedValue([
        { code: "USD" },
        { code: "CAD" },
        { code: "EUR" },
        { code: "GBP" },
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          chart: {
            result: [{ meta: { regularMarketPrice: 1.0 } }],
          },
        }),
      });

      exchangeRateRepository.findOne.mockResolvedValue(null);
      exchangeRateRepository.save.mockImplementation((data) => ({ ...data, id: 1 }));

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
        .mockResolvedValueOnce([{ currency_code: "EUR", earliest: "2025-01-01" }]) // accountCurrencyRows
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
        .mockResolvedValueOnce([{ currency_code: "CAD", earliest: "2025-01-01" }])
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

      const cutoffDate = new Date("2025-06-01");
      const ts1 = new Date("2025-06-01").getTime() / 1000;
      const ts2 = new Date("2025-06-02").getTime() / 1000;

      dataSource.query
        .mockResolvedValueOnce([{ currency_code: "CAD", earliest: "2025-06-01" }])
        .mockResolvedValueOnce([]) // securityCurrencyRows
        .mockResolvedValueOnce([{ count: 0 }]) // no existing rates
        .mockResolvedValueOnce(undefined); // bulk upsert INSERT

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          chart: {
            result: [
              {
                timestamp: [ts1, ts2],
                indicators: {
                  quote: [{ close: [1.365, 1.370] }],
                },
              },
            ],
          },
        }),
      });

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

      // The earliest transaction is 2025-06-15, so rates before that should be filtered out
      const ts1 = new Date("2025-06-01").getTime() / 1000; // before cutoff
      const ts2 = new Date("2025-06-15").getTime() / 1000; // on cutoff
      const ts3 = new Date("2025-06-20").getTime() / 1000; // after cutoff

      dataSource.query
        .mockResolvedValueOnce([{ currency_code: "EUR", earliest: "2025-06-15" }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }])
        .mockResolvedValueOnce(undefined); // bulk upsert

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          chart: {
            result: [
              {
                timestamp: [ts1, ts2, ts3],
                indicators: {
                  quote: [{ close: [1.1, 1.2, 1.3] }],
                },
              },
            ],
          },
        }),
      });

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

      // Two timestamps that resolve to the same date
      const ts1 = new Date("2025-07-01T10:00:00Z").getTime() / 1000;
      const ts2 = new Date("2025-07-01T20:00:00Z").getTime() / 1000;
      const ts3 = new Date("2025-07-02T10:00:00Z").getTime() / 1000;

      dataSource.query
        .mockResolvedValueOnce([{ currency_code: "GBP", earliest: "2025-07-01" }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }])
        .mockResolvedValueOnce(undefined); // bulk upsert

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          chart: {
            result: [
              {
                timestamp: [ts1, ts2, ts3],
                indicators: {
                  quote: [{ close: [1.25, 1.26, 1.27] }],
                },
              },
            ],
          },
        }),
      });

      const result = await service.backfillHistoricalRates("user-1");

      // ts1 and ts2 are the same date after setHours(0,0,0,0), so one is deduped
      expect(result.results[0].ratesLoaded).toBe(2);
    });

    it("handles null/NaN close values in Yahoo response", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "USD",
      });

      const ts1 = new Date("2025-08-01").getTime() / 1000;
      const ts2 = new Date("2025-08-02").getTime() / 1000;
      const ts3 = new Date("2025-08-03").getTime() / 1000;

      dataSource.query
        .mockResolvedValueOnce([{ currency_code: "JPY", earliest: "2025-08-01" }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }])
        .mockResolvedValueOnce(undefined); // bulk upsert

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          chart: {
            result: [
              {
                timestamp: [ts1, ts2, ts3],
                indicators: {
                  quote: [{ close: [null, NaN, 150.5] }],
                },
              },
            ],
          },
        }),
      });

      const result = await service.backfillHistoricalRates("user-1");

      // Only the third rate with value 150.5 should be included
      expect(result.results[0].ratesLoaded).toBe(1);
    });

    it("handles Yahoo API failure for historical rates", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "USD",
      });

      dataSource.query
        .mockResolvedValueOnce([{ currency_code: "CAD", earliest: "2025-01-01" }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

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
        .mockResolvedValueOnce([{ currency_code: "CAD", earliest: "2025-01-01" }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }]);

      global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));

      const result = await service.backfillHistoricalRates("user-1");

      expect(result.failed).toBe(1);
      expect(result.results[0].error).toBe("No historical data available");
    });

    it("handles database error during bulk upsert", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "USD",
      });

      const ts1 = new Date("2025-09-01").getTime() / 1000;

      dataSource.query
        .mockResolvedValueOnce([{ currency_code: "CHF", earliest: "2025-09-01" }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }])
        .mockRejectedValueOnce(new Error("Constraint violation"));

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          chart: {
            result: [
              {
                timestamp: [ts1],
                indicators: {
                  quote: [{ close: [0.92] }],
                },
              },
            ],
          },
        }),
      });

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

      // Earliest transaction is 2026-01-01, but rates are all from 2025
      const ts1 = new Date("2025-01-01").getTime() / 1000;
      const ts2 = new Date("2025-06-01").getTime() / 1000;

      dataSource.query
        .mockResolvedValueOnce([{ currency_code: "MXN", earliest: "2026-01-01" }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          chart: {
            result: [
              {
                timestamp: [ts1, ts2],
                indicators: {
                  quote: [{ close: [17.0, 17.5] }],
                },
              },
            ],
          },
        }),
      });

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
        .mockResolvedValueOnce([{ currency_code: "EUR", earliest: "2025-06-01" }]) // account
        .mockResolvedValueOnce([{ currency_code: "EUR", earliest: "2025-03-01" }]) // security (earlier)
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
        .mockResolvedValueOnce([{ currency_code: "SEK", earliest: "2025-01-01" }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          chart: {
            result: [{ meta: { regularMarketPrice: 10.5 } }], // no timestamp/indicators
          },
        }),
      });

      const result = await service.backfillHistoricalRates("user-1");

      expect(result.failed).toBe(1);
      expect(result.results[0].error).toBe("No historical data available");
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
      expect(exchangeRateRepository.createQueryBuilder).toHaveBeenCalledWith("er");
      expect(qb.distinctOn).toHaveBeenCalledWith(["er.from_currency", "er.to_currency"]);
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
