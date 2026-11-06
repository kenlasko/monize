import { readFileSync } from "fs";
import { join } from "path";
import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ExchangeRateService } from "./exchange-rate.service";
import { ExchangeRate } from "./entities/exchange-rate.entity";
import { addDaysYMD, todayYMD } from "../common/date-utils";
import { Currency } from "./entities/currency.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { roundFxRate } from "../common/fx-entry.util";
import { FX_MAX_RATE_AGE_DAYS } from "../common/time-series/fx-rate-resolver";
import {
  getRequestContext,
  requestContextStorage,
} from "../common/request-context";
import {
  createFetchSyncMock,
  fetchSyncProvider,
  type FetchSyncMock,
} from "../test-helpers/job-claim-testing";
import { FetchSyncJob } from "../common/jobs/fetch-sync.service";
import {
  FxChainObservation,
  FxDailySeriesResult,
  FxLatestResult,
  FxProviderChain,
} from "./providers/fx-provider-chain";
import { FxObservation } from "./providers/fx-provider.interface";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

// `ensureRatesForDate` clamps its fetch window at today, so today has to be a
// fixture: otherwise "does this month run past today" is a question about the
// day the suite happens to run on. Only `todayYMD` is replaced -- the month
// arithmetic beside it is the real thing.
jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  todayYMD: jest.fn(() => "2026-08-18"),
}));

/** The slug the Yahoo adapter writes; the chain copies it onto each observation. */
const YAHOO_SOURCE = "yahoo_finance";

/**
 * The chain behind a typed double. The three members the service reaches are
 * typed from the real class, so a fake answer `tsc` accepts is a shape the
 * chain can produce (`docs/backend/testing.md`); the builders below produce
 * them in the orientations and with the sources the adapters hand back.
 */
type ChainDouble = jest.Mocked<
  Pick<FxProviderChain, "latest" | "dailySeries" | "live">
>;

const observation = (
  from: string,
  to: string,
  date: string,
  rate: number,
  source: string = YAHOO_SOURCE,
): FxChainObservation => ({ from, to, date, rate, source });

/**
 * A `latest` answer as the chain shapes it: each observation keyed by the quote
 * it answers for `base`, whichever orientation it came back in.
 */
const latestAnswer = (
  base: string,
  found: FxChainObservation[],
  rest: Partial<Pick<FxLatestResult, "unanswered" | "uncarried">> = {},
): FxLatestResult => ({
  found: new Map(found.map((o) => [o.from === base ? o.to : o.from, o])),
  unanswered: rest.unanswered ?? [],
  uncarried: rest.uncarried ?? [],
});

/** Nothing answered for any quote: every quote is an outage, none is absent. */
const nobodyAnswered = (
  _base: string,
  quotes: readonly string[],
): FxLatestResult => ({
  found: new Map(),
  unanswered: [...quotes],
  uncarried: [],
});

/** A `dailySeries` answer: points under one source, `answered` per the chain. */
const seriesAnswer = (
  points: FxObservation[],
  options: { answered?: boolean; source?: string } = {},
): FxDailySeriesResult => ({
  points,
  answered: options.answered ?? true,
  carried: true,
  source: points.length > 0 ? (options.source ?? YAHOO_SOURCE) : null,
});

/** Every carrying provider answered, and none had anything in the window. */
const EMPTY_WINDOW: FxDailySeriesResult = {
  points: [],
  answered: true,
  carried: true,
  source: null,
};

/** No provider that may be asked carries the pair: a coin without a price symbol. */
const UNCARRIED: FxDailySeriesResult = {
  points: [],
  answered: true,
  carried: false,
  source: null,
};

/** A carrying provider did not answer and nothing was found: not an answer. */
const NO_ANSWER: FxDailySeriesResult = {
  points: [],
  answered: false,
  carried: true,
  source: null,
};

const point = (
  from: string,
  to: string,
  date: string,
  rate: number,
): FxObservation => ({ from, to, date, rate });

/** One observation per weekday in `[start, end]`, the shape of a daily series. */
const weekdayPoints = (
  from: string,
  to: string,
  start: string,
  end: string,
  rate: number,
): FxObservation[] => {
  const points: FxObservation[] = [];
  for (let day = start; day <= end; day = addDaysYMD(day, 1)) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) points.push(point(from, to, day, rate));
  }
  return points;
};

describe("ExchangeRateService", () => {
  let service: ExchangeRateService;
  let fetchSync: FetchSyncMock;
  let chain: ChainDouble;
  let exchangeRateRepository: Record<string, jest.Mock>;
  /** Rows the single-rate upsert wrote, in order, as the service supplied them. */
  let upsertedRates: Array<{
    fromCurrency: string;
    toCurrency: string;
    rateDate: string;
    rate: number;
    source: string;
  }>;
  let currencyRepository: Record<string, jest.Mock>;
  let userPreferenceRepository: Record<string, jest.Mock>;
  let dataSource: Record<string, jest.Mock>;

  const mockExchangeRate: ExchangeRate = {
    id: 1,
    fromCurrency: "USD",
    toCurrency: "CAD",
    rate: 1.365,
    rateDate: new Date("2026-02-10"),
    source: YAHOO_SOURCE,
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

    kind: "FIAT",
    quoteSymbol: null,
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

  /** The bulk upserts' parameter lists, read back as rows. */
  type InsertedRow = {
    from: string;
    to: string;
    date: string;
    rate: number;
    source: string;
  };
  const bulkInsertedRows = (): InsertedRow[] => {
    const rows: InsertedRow[] = [];
    for (const call of dataSource.query.mock.calls as Array<
      [string, unknown[] | undefined]
    >) {
      const [sql, params] = call;
      if (
        typeof sql !== "string" ||
        !sql.includes("INSERT INTO exchange_rates") ||
        sql.includes("RETURNING id") ||
        !Array.isArray(params)
      ) {
        continue;
      }
      for (let i = 0; i < params.length; i += 5) {
        rows.push({
          from: params[i] as string,
          to: params[i + 1] as string,
          date: params[i + 2] as string,
          rate: params[i + 3] as number,
          source: params[i + 4] as string,
        });
      }
    }
    return rows;
  };

  /**
   * Answer `manager.query` by statement instead of with one blanket value.
   *
   * The single-rate save is `INSERT ... ON CONFLICT DO UPDATE RETURNING id`,
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
          const [fromCurrency, toCurrency, rateDate, rate, source] = params as [
            string,
            string,
            string,
            number,
            string,
          ];
          const id = upsertedRates.length + 1;
          upsertedRates.push({
            fromCurrency,
            toCurrency,
            rateDate,
            rate,
            source,
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
    // The single-rate save is one `INSERT ... ON CONFLICT DO UPDATE RETURNING
    // id` through the manager, so the spec records the statement and hands back
    // the row it wrote. `findOne` still answers the by-id read-back.
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

    // `find` also answers the writers' coin lookup (`loadCoinLookup`): no coins
    // unless a case says otherwise.
    currencyRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    userPreferenceRepository = {
      findOne: jest.fn(),
    };

    // Raw SQL runs on the scoped transaction's EntityManager; alias the spec's
    // `dataSource.query` to it so the assertions watch the same statements.
    const scoped = createScopedDbMocks([
      [ExchangeRate, exchangeRateRepository],
      [Currency, currencyRepository],
      [UserPreference, userPreferenceRepository],
    ]);
    scoped.dataSource.query = scoped.manager.query;
    dataSource = scoped.dataSource as unknown as Record<string, jest.Mock>;

    // The chain's default is silence: nothing answered, which no path may read
    // as a rate or remember as an empty window. Each case says what answered.
    chain = {
      latest: jest.fn(async (base: string, quotes: readonly string[]) =>
        nobodyAnswered(base, quotes),
      ),
      dailySeries: jest.fn(
        async (_from: string, _to: string, _start: string, _end: string) =>
          NO_ANSWER,
      ),
      live: jest.fn(
        async (
          _from: string,
          _to: string,
        ): Promise<FxChainObservation | null> => null,
      ),
    };

    fetchSync = createFetchSyncMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExchangeRateService,
        { provide: DataSource, useValue: dataSource },
        { provide: FxProviderChain, useValue: chain },
        fetchSyncProvider(fetchSync),
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
      expect(chain.latest).not.toHaveBeenCalled();
    });

    it("returns empty summary when no currencies are in use", async () => {
      dataSource.query.mockResolvedValue([]);

      const result = await service.refreshAllRates();

      expect(result.totalPairs).toBe(0);
      expect(result.updated).toBe(0);
    });

    /**
     * One chain question per base, carrying every quote stored against it: the
     * canonical pairs grouped by their first code, bases in sequence. A provider
     * that publishes a whole base at once answers each group in one call; one
     * that quotes pair by pair fans out inside its adapter.
     */
    it("asks the chain once per base with every quote stored against it, bases in sequence", async () => {
      // The query's order is not the chain's: the codes are sorted first, so
      // the grouping is the same on every replica.
      routeRateQueries(["USD", "CAD", "EUR"]);
      chain.latest.mockImplementation(async (base, quotes) =>
        latestAnswer(
          base,
          quotes.map((quote) => observation(base, quote, "2026-08-18", 1.5)),
        ),
      );

      const result = await service.refreshAllRates();

      expect(chain.latest.mock.calls).toEqual([
        ["CAD", ["EUR", "USD"]],
        ["EUR", ["USD"]],
      ]);
      const [first, second] = chain.latest.mock.invocationCallOrder;
      expect(first).toBeLessThan(second);
      // 3 currencies -> 3 pairs: CAD/EUR, CAD/USD, EUR/USD
      expect(result.totalPairs).toBe(3);
      expect(result.updated).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.results.map((r) => r.pair)).toEqual([
        "CAD/EUR",
        "CAD/USD",
        "EUR/USD",
      ]);
    });

    it("builds correct number of pairs from 4 currencies", async () => {
      routeRateQueries(["USD", "CAD", "EUR", "GBP"]);
      chain.latest.mockImplementation(async (base, quotes) =>
        latestAnswer(
          base,
          quotes.map((quote) => observation(base, quote, "2026-08-18", 1.0)),
        ),
      );

      const result = await service.refreshAllRates();

      // 4 currencies -> C(4,2) = 6 pairs, over 3 bases
      expect(result.totalPairs).toBe(6);
      expect(result.updated).toBe(6);
      expect(chain.latest).toHaveBeenCalledTimes(3);
    });

    it("upserts one canonical row rather than reading first and then writing", async () => {
      // The rate cron fires on every replica, so two processes routinely fetch
      // the same pair for the same day. The old shape read the row and then
      // either saved it or inserted -- a check-then-act whose loser hit
      // `UNIQUE(from_currency, to_currency, rate_date)` and reported a pair it
      // had in fact fetched as failed.
      routeRateQueries(["USD", "CAD"]);
      // The Yahoo adapter answers USD->CAD for the CAD base: its direct symbol
      // quotes below 1, so it asked the reverse one and that carried the digits.
      chain.latest.mockResolvedValue(
        latestAnswer("CAD", [observation("USD", "CAD", "2026-08-18", 1.4)]),
      );

      const result = await service.refreshAllRates();

      expect(result.updated).toBe(1);
      const upserts = dataSource.query.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "string" &&
          call[0].includes("INSERT INTO exchange_rates") &&
          call[0].includes("RETURNING id"),
      );
      // One row, not a pair. The inverse row that used to be written beside it
      // was what a one-sided write could then contradict (INV-FX-003).
      expect(upserts).toHaveLength(1);
      expect(upserts[0][0]).toContain(
        "ON CONFLICT (from_currency, to_currency, rate_date) DO UPDATE",
      );
      // The provider answered USD->CAD; the pair is stored as CAD->USD, so the
      // rate is inverted at the rate column's ten decimal places, not at money
      // precision: rounding it to four (0.7143) inverts back to 1.39997, which a
      // statement quoting six decimals reconciles against by cents.
      expect(upsertedRates).toHaveLength(1);
      expect(upsertedRates[0]).toMatchObject({
        fromCurrency: "CAD",
        toCurrency: "USD",
        rate: roundFxRate(1 / 1.4),
        source: YAHOO_SOURCE,
      });
      expect(upsertedRates[0].rate).not.toBe(0.7143);
      expect(roundFxRate(1 / upsertedRates[0].rate)).toBeCloseTo(1.4, 6);
    });

    it("stores an observation that is already canonical as it stands", async () => {
      // CAD sorts before USD, so a CAD->USD observation needs no inversion and
      // the stored rate is the provider's number itself.
      routeRateQueries(["CAD", "USD"]);
      chain.latest.mockResolvedValue(
        latestAnswer("CAD", [observation("CAD", "USD", "2026-08-18", 0.72)]),
      );

      const result = await service.refreshAllRates();

      expect(upsertedRates).toEqual([
        {
          fromCurrency: "CAD",
          toCurrency: "USD",
          rateDate: "2026-08-18",
          rate: 0.72,
          source: YAHOO_SOURCE,
        },
      ]);
      expect(result.results[0]).toEqual({
        pair: "CAD/USD",
        success: true,
        rate: 0.72,
      });
    });

    /**
     * The reverse symbol on the refresh: the chain answers in whichever
     * orientation the provider quoted -- the Yahoo adapter asks the reverse
     * symbol when the direct one has no quote or quotes below 1 -- and the
     * refresh stores one canonical row from it and reports the rate it was
     * asked for, reciprocated at the rate column's precision
     * (`docs/specs/exchange-rate-canonical-orientation.md` section 10).
     */
    it("stores one canonical row from an observation answered the other way round and reports the rate as asked", async () => {
      routeRateQueries(["SGD", "VND"]);
      // `SGDVND=X` quotes 0.00005 and loses its digits; the adapter answered
      // from `VNDSGD=X`... in the orientation that carried them.
      chain.latest.mockResolvedValue(
        latestAnswer("SGD", [observation("VND", "SGD", "2026-08-18", 20278.5)]),
      );

      const result = await service.refreshAllRates();

      expect(result.updated).toBe(1);
      expect(upsertedRates).toEqual([
        {
          fromCurrency: "SGD",
          toCurrency: "VND",
          rateDate: "2026-08-18",
          rate: roundFxRate(1 / 20278.5),
          source: YAHOO_SOURCE,
        },
      ]);
      expect(result.results[0]).toEqual({
        pair: "SGD/VND",
        success: true,
        rate: roundFxRate(1 / 20278.5),
      });
    });

    /**
     * Plan decision 5: the provider dates the observation. A reference rate
     * published for Friday is Friday's row whichever day the refresh runs, and
     * the row carries the slug of the provider that published it, not a name
     * this service knows (INV-FX-005).
     */
    it("dates the row by the observation and attributes it to the answering provider", async () => {
      routeRateQueries(["CAD", "USD"]);
      // Today is the fixture's 2026-08-18; the observation is Friday's.
      chain.latest.mockResolvedValue(
        latestAnswer("CAD", [
          observation("USD", "CAD", "2026-08-14", 1.4253, "frankfurter"),
        ]),
      );

      await service.refreshAllRates();

      expect(upsertedRates).toEqual([
        {
          fromCurrency: "CAD",
          toCurrency: "USD",
          rateDate: "2026-08-14",
          rate: roundFxRate(1 / 1.4253),
          source: "frankfurter",
        },
      ]);
      // The date crosses the driver as the calendar string the provider gave,
      // never as a `Date` rendered in the process time zone.
      const [, params] = dataSource.query.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes("RETURNING id"),
      ) as [string, unknown[]];
      expect(params).toEqual([
        "CAD",
        "USD",
        "2026-08-14",
        expect.any(Number),
        "frankfurter",
      ]);
    });

    it("passes each observation's own source through when one refresh draws on two providers", async () => {
      routeRateQueries(["CAD", "EUR", "USD"]);
      chain.latest.mockImplementation(async (base, quotes) =>
        latestAnswer(
          base,
          quotes.map((quote) =>
            observation(
              base,
              quote,
              "2026-08-18",
              2,
              quote === "USD" ? YAHOO_SOURCE : "frankfurter",
            ),
          ),
        ),
      );

      await service.refreshAllRates();

      expect(
        upsertedRates.map((row) => [
          row.fromCurrency,
          row.toCurrency,
          row.source,
        ]),
      ).toEqual([
        ["CAD", "EUR", "frankfurter"],
        ["CAD", "USD", YAHOO_SOURCE],
        ["EUR", "USD", YAHOO_SOURCE],
      ]);
    });

    /**
     * Three reports, kept apart (INV-FX-005): an outage, a quote the provider
     * has no rate for, and a pair no configured provider carries have three
     * different repairs, and nothing is stored for any of them.
     */
    it("reports a quote no provider answered as an outage, not as missing data", async () => {
      routeRateQueries(["CAD", "USD"]);
      chain.latest.mockResolvedValue(
        latestAnswer("CAD", [], { unanswered: ["USD"] }),
      );

      const result = await service.refreshAllRates();

      expect(result.totalPairs).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.results[0]).toEqual({
        pair: "CAD/USD",
        success: false,
        error: "No provider answered",
      });
      expect(upsertedRates).toEqual([]);
    });

    it("reports a quote answered without a rate as no rate data", async () => {
      // Every carrying provider answered the base and none had this quote:
      // Yahoo's 200 without a price, or a pair quoted too coarsely either way.
      routeRateQueries(["CAD", "USD"]);
      chain.latest.mockResolvedValue(latestAnswer("CAD", []));

      const result = await service.refreshAllRates();

      expect(result.failed).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.results[0]).toEqual({
        pair: "CAD/USD",
        success: false,
        error: "No rate data available",
      });
    });

    it("names a pair no configured provider carries", async () => {
      routeRateQueries(["TWD", "USD"]);
      chain.latest.mockResolvedValue(
        latestAnswer("TWD", [], { uncarried: ["USD"] }),
      );

      const result = await service.refreshAllRates();

      expect(result.failed).toBe(1);
      expect(result.results[0]).toEqual({
        pair: "TWD/USD",
        success: false,
        error: "No configured provider carries TWD/USD",
      });
    });

    it("keeps the three reports apart within one base", async () => {
      routeRateQueries(["CAD", "EUR", "TWD", "USD"]);
      chain.latest.mockImplementation(async (base) =>
        base === "CAD"
          ? latestAnswer(
              "CAD",
              [observation("CAD", "EUR", "2026-08-18", 0.62)],
              { unanswered: ["USD"], uncarried: ["TWD"] },
            )
          : latestAnswer(base, []),
      );

      const result = await service.refreshAllRates();

      expect(result.totalPairs).toBe(6);
      expect(result.updated).toBe(1);
      expect(result.failed).toBe(5);
      expect(result.results.slice(0, 3)).toEqual([
        { pair: "CAD/EUR", success: true, rate: 0.62 },
        {
          pair: "CAD/TWD",
          success: false,
          error: "No configured provider carries CAD/TWD",
        },
        { pair: "CAD/USD", success: false, error: "No provider answered" },
      ]);
    });

    it("refuses an observation that cannot be a rate and reports the pair failed", async () => {
      // `saveRate`'s own guard: a non-positive rate is absent, not a rate, and
      // is refused before the write rather than stored as a rate nothing may
      // use. No adapter produces one; the chain's type permits it.
      routeRateQueries(["CAD", "USD"]);
      chain.latest.mockResolvedValue(
        latestAnswer("CAD", [observation("CAD", "USD", "2026-08-18", 0)]),
      );

      const result = await service.refreshAllRates();

      expect(result.failed).toBe(1);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toContain(
        "Refusing to store exchange rate CAD/USD at 0 for 2026-08-18",
      );
      expect(upsertedRates).toEqual([]);
    });

    it("handles a rate write failure gracefully", async () => {
      routeRateQueries(["USD", "CAD"]);
      chain.latest.mockResolvedValue(
        latestAnswer("CAD", [observation("CAD", "USD", "2026-08-18", 0.7)]),
      );
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

    it("reports an upsert that returned no row as a fault rather than synthesising an entity", async () => {
      routeRateQueries(["CAD", "USD"]);
      chain.latest.mockResolvedValue(
        latestAnswer("CAD", [observation("CAD", "USD", "2026-08-18", 0.7)]),
      );
      exchangeRateRepository.findOne.mockResolvedValue(null);

      const result = await service.refreshAllRates();

      expect(result.failed).toBe(1);
      expect(result.results[0].error).toBe(
        "Failed to persist exchange rate CAD/USD for 2026-08-18",
      );
    });
  });

  describe("backfillHistoricalRates", () => {
    const TODAY = "2026-08-18";

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

    it("counts a pair stored in the other direction as already covered", async () => {
      // A pair is stored once. Asking only about `EUR->USD` read a pair held as
      // `USD->EUR` as uncovered and re-fetched it from the provider on every
      // run, forever.
      userPreferenceRepository.findOne.mockResolvedValue(null);
      dataSource.query
        .mockResolvedValueOnce([
          { currency_code: "EUR", earliest: "2025-01-01" },
        ]) // accountCurrencyRows
        .mockResolvedValueOnce([]) // securityCurrencyRows
        .mockResolvedValueOnce([{ count: 5 }]); // the coverage probe

      const result = await service.backfillHistoricalRates("user-1");

      const probe = dataSource.query.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes("COUNT(*)::INT AS count FROM exchange_rates"),
      );
      expect(probe).toBeDefined();
      expect(String(probe[0])).toContain(
        "(from_currency = $1 AND to_currency = $2)",
      );
      expect(String(probe[0])).toContain(
        "(from_currency = $2 AND to_currency = $1)",
      );
      expect(result.results[0].ratesLoaded).toBe(0);
      expect(chain.dailySeries).not.toHaveBeenCalled();
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

    /**
     * One question to the chain over the span the user's data covers: from
     * the earliest transaction through today, in one window. The whole-history
     * download and the date filter over it are gone with it.
     */
    it("asks the chain for the span from the earliest use through today and stores what it answers", async () => {
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
      chain.dailySeries.mockResolvedValue(
        seriesAnswer([
          point("CAD", "USD", "2025-06-02", 0.7326),
          point("CAD", "USD", "2025-06-03", 0.7299),
        ]),
      );

      const result = await service.backfillHistoricalRates("user-1");

      expect(chain.dailySeries).toHaveBeenCalledTimes(1);
      expect(chain.dailySeries).toHaveBeenCalledWith(
        "CAD",
        "USD",
        "2025-06-01",
        TODAY,
      );
      expect(result.totalPairs).toBe(1);
      expect(result.successful).toBe(1);
      expect(result.totalRatesLoaded).toBe(2);
      expect(result.results[0]).toEqual({
        pair: "CAD/USD",
        success: true,
        ratesLoaded: 2,
      });
      expect(bulkInsertedRows()).toEqual([
        {
          from: "CAD",
          to: "USD",
          date: "2025-06-02",
          rate: 0.7326,
          source: YAHOO_SOURCE,
        },
        {
          from: "CAD",
          to: "USD",
          date: "2025-06-03",
          rate: 0.7299,
          source: YAHOO_SOURCE,
        },
      ]);
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
        .mockResolvedValueOnce([{ count: 0 }]);
      chain.dailySeries.mockResolvedValue(
        seriesAnswer([point("EUR", "USD", "2025-03-03", 1.08)]),
      );

      const result = await service.backfillHistoricalRates("user-1");

      // Should only have 1 pair (EUR->USD) not 2, over the earlier span.
      expect(result.totalPairs).toBe(1);
      expect(chain.dailySeries).toHaveBeenCalledTimes(1);
      expect(chain.dailySeries).toHaveBeenCalledWith(
        "EUR",
        "USD",
        "2025-03-01",
        TODAY,
      );
    });

    it("writes one row per day, the last point for a day winning, whichever orientation each came in", async () => {
      userPreferenceRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "USD",
      });
      dataSource.query
        .mockResolvedValueOnce([
          { currency_code: "GBP", earliest: "2025-07-01" },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: 0 }])
        .mockResolvedValueOnce(undefined); // bulk upsert
      chain.dailySeries.mockResolvedValue(
        seriesAnswer([
          point("GBP", "USD", "2025-07-01", 1.25),
          // The same day again, the other way round, at a rate whose
          // reciprocal is not the first point's: one row, this value.
          point("USD", "GBP", "2025-07-01", 0.79),
          point("GBP", "USD", "2025-07-02", 1.27),
        ]),
      );

      const result = await service.backfillHistoricalRates("user-1");

      expect(result.results[0].ratesLoaded).toBe(2);
      expect(bulkInsertedRows()).toEqual([
        {
          from: "GBP",
          to: "USD",
          date: "2025-07-01",
          rate: roundFxRate(1 / 0.79),
          source: YAHOO_SOURCE,
        },
        {
          from: "GBP",
          to: "USD",
          date: "2025-07-02",
          rate: 1.27,
          source: YAHOO_SOURCE,
        },
      ]);
    });

    /**
     * Two reports, kept apart (INV-FX-005): a window the providers answered
     * with nothing has no history to load, and a window a carrying provider
     * never answered is an outage the next startup retries. Neither is a rate.
     */
    it("reports a window the providers answered as empty as no historical data", async () => {
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
      chain.dailySeries.mockResolvedValue(EMPTY_WINDOW);

      const result = await service.backfillHistoricalRates("user-1");

      expect(result.totalPairs).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.successful).toBe(0);
      expect(result.results[0]).toEqual({
        pair: "CAD/USD",
        success: false,
        ratesLoaded: 0,
        error: "No historical data available",
      });
      expect(bulkInsertedRows()).toEqual([]);
    });

    it("reports a window no carrying provider answered as an outage, not as missing history", async () => {
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
      chain.dailySeries.mockResolvedValue(NO_ANSWER);

      const result = await service.backfillHistoricalRates("user-1");

      expect(result.failed).toBe(1);
      expect(result.results[0]).toEqual({
        pair: "CAD/USD",
        success: false,
        ratesLoaded: 0,
        error: "A provider did not answer",
      });
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
      chain.dailySeries.mockResolvedValue(
        seriesAnswer([point("CHF", "USD", "2025-09-01", 1.25)]),
      );

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
  });

  /**
   * A stored row, dated: the age policy means a fixture's date is part of what
   * it asserts, not scenery.
   */
  const storedRow = (
    from: string,
    to: string,
    rate: number,
    date: string,
  ): ExchangeRate => ({
    ...mockExchangeRate,
    fromCurrency: from,
    toCurrency: to,
    rate,
    // `main.ts` sets the pg DATE parser to hand the literal back unparsed, so a
    // row that crossed the driver carries the `YYYY-MM-DD` string. The entity
    // declares `Date` for the SQL column type; the fixture is the shape
    // production actually produces, because a fixture the producer could not
    // have written is not evidence.
    rateDate: date as unknown as Date,
  });

  /** The [floor, ceiling] the span query asked the database for. */
  const spanBounds = (call: any): [string, string] => {
    const operator = call.where[0].rateDate;
    const [lower, upper] = operator.value as Array<{ value: unknown }>;
    return [String(lower.value), String(upper.value)];
  };

  describe("resolveStoredRate", () => {
    /**
     * Issue #1390. The span used to be built from UTC-midnight `Date` objects.
     * TypeORM does not normalise a select-side parameter, `pg` renders a `Date`
     * in the process time zone and PostgreSQL's cast to `date` keeps whatever
     * literal that rendering produced, so anywhere west of UTC the upper bound
     * named the previous calendar day and the reference date's own row -- in
     * `live` mode, today's rate -- was excluded from the result. The bounds are
     * calendar-date strings, which name the same day in every time zone.
     */
    it("bounds the span with calendar-date strings on both sides", async () => {
      exchangeRateRepository.find.mockResolvedValue([]);

      await service.resolveStoredRate("USD", "CAD", "2026-06-08");

      const call = exchangeRateRepository.find.mock.calls[0][0];
      const [lower, upper] = (call.where[0].rateDate as any).value as Array<{
        value: unknown;
      }>;
      expect(typeof lower.value).toBe("string");
      expect(typeof upper.value).toBe("string");
      expect(upper.value).toBe("2026-06-08");
      expect(lower.value).toBe("2026-04-24"); // the 45-day age bound
      // Both stored directions are read over the one span.
      expect(call.where[1].rateDate).toBe(call.where[0].rateDate);
    });

    /**
     * `onDate` reaches here from a query parameter, and Express parses a
     * repeated key into an array, so a value declared `string` need not be one.
     * The span was built by slicing it: an array sliced to an array, the
     * comparison that clamps a future date became a text coercion, and the
     * query ran over bounds nobody named (CodeQL
     * `js/type-confusion-through-parameter-tampering`).
     */
    it("refuses a date that names no day instead of querying a coerced span", async () => {
      for (const tampered of [
        ["2026-06-08"] as unknown as string,
        ["2026-06-08", "2026-06-09"] as unknown as string,
        "08/06/2026",
      ]) {
        const resolution = await service.resolveStoredRate(
          "USD",
          "CAD",
          tampered,
        );

        expect(resolution).toMatchObject({
          status: "unknown",
          rate: null,
          reason: "invalid_date",
        });
      }
      expect(exchangeRateRepository.find).not.toHaveBeenCalled();
    });

    it("bounds a live lookup at today, so today's own row is inside the span", async () => {
      // Today is the suite's fixture date (`todayYMD` is mocked above).
      exchangeRateRepository.find.mockResolvedValue([
        storedRow("USD", "CAD", 1.42, "2026-08-18"),
      ]);

      const resolution = await service.resolveStoredRate(
        "USD",
        "CAD",
        "2026-06-08",
        { mode: "live" },
      );

      const [floor, ceiling] = spanBounds(
        exchangeRateRepository.find.mock.calls[0][0],
      );
      expect(ceiling).toBe("2026-08-18");
      expect(floor).toBe("2026-07-04"); // today minus the 45-day bound
      expect(resolution.rate).toBe(1.42);
      expect(resolution.observedOn).toBe("2026-08-18");
    });

    /**
     * The entity declares `rateDate: Date` and only the pg DATE parser makes it
     * a string, so the normalisation keeps a `Date` readable for any caller
     * that builds a row without the driver. One case, deliberately: every other
     * fixture carries the string production produces.
     */
    it("normalises a Date-valued rateDate as well as the stored string", async () => {
      exchangeRateRepository.find.mockResolvedValue([
        {
          ...mockExchangeRate,
          fromCurrency: "USD",
          toCurrency: "CAD",
          rate: 1.31,
          rateDate: new Date("2026-06-05T00:00:00.000Z"),
        },
      ]);

      const resolution = await service.resolveStoredRate(
        "USD",
        "CAD",
        "2026-06-08",
      );

      expect(resolution.rate).toBe(1.31);
      expect(resolution.observedOn).toBe("2026-06-05");
    });
  });

  describe("getRateForDate", () => {
    /** The window step 2 asks for around a target: the age bound back, a week on. */
    const windowAround = (target: string): [string, string] => [
      addDaysYMD(target, -FX_MAX_RATE_AGE_DAYS),
      addDaysYMD(target, 7),
    ];

    it("returns 1 for the same currency without any lookup", async () => {
      const result = await service.getRateForDate("USD", "USD", "2026-06-08");

      expect(result).toBe(1);
      expect(exchangeRateRepository.find).not.toHaveBeenCalled();
      expect(chain.dailySeries).not.toHaveBeenCalled();
    });

    it("returns the closest stored rate on or before the target date", async () => {
      exchangeRateRepository.find.mockResolvedValue([
        storedRow("USD", "CAD", 1.3, "2026-06-01"),
        storedRow("USD", "CAD", 1.365, "2026-06-05"),
      ]);

      const result = await service.getRateForDate("USD", "CAD", "2026-06-08");

      expect(result).toBe(1.365);
      // Both stored directions are read, over a bounded span -- not a single
      // unbounded "any earlier row" lookup.
      const call = exchangeRateRepository.find.mock.calls[0][0];
      expect(call.where).toHaveLength(2);
      expect(call.where[0].fromCurrency).toBe("USD");
      expect(call.where[1].fromCurrency).toBe("CAD");
      // No provider fetch needed when the span covers the target.
      expect(chain.dailySeries).not.toHaveBeenCalled();
    });

    /**
     * Issue #1390. The stored step used to be "the newest row on or before the
     * target, whatever its age", so a single row from 2019 answered every later
     * date AND short-circuited the provider fetch that would have filled the
     * gap. A 285-day hole therefore stayed a hole, silently back-filled.
     */
    it("reads only the span the age policy admits, so an ancient row neither answers nor blocks the fetch", async () => {
      exchangeRateRepository.find.mockResolvedValue([]);
      chain.dailySeries.mockResolvedValue(
        seriesAnswer([point("USD", "CAD", "2026-06-05", 1.4)]),
      );

      const result = await service.getRateForDate("USD", "CAD", "2026-06-08");

      expect(result).toBe(1.4);
      expect(chain.dailySeries).toHaveBeenCalledTimes(1);
      const [floor, ceiling] = spanBounds(
        exchangeRateRepository.find.mock.calls[0][0],
      );
      expect(floor).toBe("2026-04-24"); // 2026-06-08 minus the 45-day bound
      expect(ceiling).toBe("2026-06-08");
    });

    it("uses a fresh inverse observation over an older direct one", async () => {
      exchangeRateRepository.find.mockResolvedValue([
        storedRow("USD", "CAD", 1.3, "2026-05-20"),
        storedRow("CAD", "USD", 0.8, "2026-06-05"),
      ]);

      const result = await service.getRateForDate("USD", "CAD", "2026-06-08");

      expect(result).toBe(1.25);
      expect(chain.dailySeries).not.toHaveBeenCalled();
    });

    it("fetches a bounded window around the date through the chain when none is stored", async () => {
      exchangeRateRepository.find.mockResolvedValue([]);
      // Daily series straddling the target 2026-06-08 (a weekend in this set):
      // the closest day on or before is 2026-06-05.
      chain.dailySeries.mockResolvedValue(
        seriesAnswer([
          point("EUR", "PLN", "2026-06-05", 4.25),
          point("EUR", "PLN", "2026-06-09", 4.3),
        ]),
      );

      const result = await service.getRateForDate("EUR", "PLN", "2026-06-08");

      expect(result).toBe(4.25);
      // A bounded window is asked for (not the whole history), as calendar
      // dates: the age bound back, so the fetch covers exactly what the bound
      // would accept, and a week on. One call has to cover a run of nearby
      // dates or a user stepping the date field hits the provider's rate limit.
      expect(chain.dailySeries).toHaveBeenCalledTimes(1);
      const [start, end] = windowAround("2026-06-08");
      expect(chain.dailySeries).toHaveBeenCalledWith("EUR", "PLN", start, end);
      expect(start).toBe("2026-04-24");
      expect(end).toBe("2026-06-15");
    });

    it("stores every day in the fetched window, not just the day asked for", async () => {
      exchangeRateRepository.find.mockResolvedValue([]);
      chain.dailySeries.mockResolvedValue(
        seriesAnswer([
          point("EUR", "PLN", "2026-06-05", 4.25),
          point("EUR", "PLN", "2026-06-09", 4.3),
        ]),
      );

      await service.getRateForDate("EUR", "PLN", "2026-06-08");

      // One bulk upsert carrying both days. Keeping only the chosen point sent
      // the next lookup for a neighbouring date straight back out to the
      // provider, which is what ran into its rate limits.
      const insert = dataSource.query.mock.calls.find((call: any[]) =>
        String(call[0]).includes("INSERT INTO exchange_rates"),
      );
      expect(insert).toBeDefined();
      expect(insert[1]).toHaveLength(2 * 5); // 2 days x 5 columns, one row each

      // EUR sorts before PLN, so the fetched orientation is the stored one,
      // and every row carries the answering provider's source.
      expect(bulkInsertedRows()).toEqual([
        {
          from: "EUR",
          to: "PLN",
          date: "2026-06-05",
          rate: 4.25,
          source: YAHOO_SOURCE,
        },
        {
          from: "EUR",
          to: "PLN",
          date: "2026-06-09",
          rate: 4.3,
          source: YAHOO_SOURCE,
        },
      ]);
    });

    /**
     * The chain answers in whichever orientation the provider quoted (the Yahoo
     * adapter's reverse symbol, or a provider that publishes the pair the other
     * way), and the lookup resolves it as it resolves a stored row held the
     * other way: through `resolveFxRate`, inverted at the rate column's
     * precision. The direct-only window this step used to fetch answered
     * nothing for such a pair.
     */
    it("resolves a window answered in the reverse orientation and stores it canonical", async () => {
      exchangeRateRepository.find.mockResolvedValue([]);
      chain.dailySeries.mockResolvedValue(
        seriesAnswer([
          point("CAD", "USD", "2026-06-04", 0.8),
          point("CAD", "USD", "2026-06-05", 0.75),
        ]),
      );

      const result = await service.getRateForDate("USD", "CAD", "2026-06-08");

      // Inverted by the resolver, as a stored reverse row is.
      expect(result).toBeCloseTo(1 / 0.75, 9);
      expect(bulkInsertedRows()).toEqual([
        {
          from: "CAD",
          to: "USD",
          date: "2026-06-04",
          rate: 0.8,
          source: YAHOO_SOURCE,
        },
        {
          from: "CAD",
          to: "USD",
          date: "2026-06-05",
          rate: 0.75,
          source: YAHOO_SOURCE,
        },
      ]);
    });

    it("stores a coin window coin-first, read the kinds once, and skips a rate out of range", async () => {
      // XBT is a coin; IDR sorts first but the pair is stored XBT->IDR. A
      // 1.1e10 close does not fit NUMERIC(20,10) and is skipped, not allowed to
      // fail the statement for the rest of the window.
      currencyRepository.find.mockResolvedValue([{ code: "XBT" }]);
      exchangeRateRepository.find.mockResolvedValue([]);
      chain.dailySeries.mockResolvedValue(
        seriesAnswer([
          point("IDR", "XBT", "2026-06-04", 1 / 1.52e9),
          point("XBT", "IDR", "2026-06-05", 1.53e9),
          point("XBT", "IDR", "2026-06-06", 1.1e10),
        ]),
      );

      await service.getRateForDate("XBT", "IDR", "2026-06-08");

      const rows = bulkInsertedRows();
      expect(rows.map((r) => [r.from, r.to, r.date])).toEqual([
        ["XBT", "IDR", "2026-06-04"],
        ["XBT", "IDR", "2026-06-05"],
      ]);
      expect(Math.abs(rows[0].rate - 1.52e9) / 1.52e9).toBeLessThan(1e-9);
      expect(rows[1].rate).toBe(1.53e9);
      expect(currencyRepository.find).toHaveBeenCalledTimes(1);
      expect(currencyRepository.find).toHaveBeenCalledWith({
        select: { code: true },
        where: { kind: "CRYPTO" },
      });
    });

    it("still answers from the fetched window when persisting it fails", async () => {
      exchangeRateRepository.find.mockResolvedValue([]);
      chain.dailySeries.mockResolvedValue(
        seriesAnswer([point("EUR", "PLN", "2026-06-05", 4.25)]),
      );
      dataSource.query.mockImplementation(async (sql: string) => {
        if (String(sql).includes("INSERT INTO exchange_rates")) {
          throw new Error("DB write failed");
        }
        return [];
      });

      const result = await service.getRateForDate("EUR", "PLN", "2026-06-08");

      // The rate the provider gave is still the rate for the date; only the
      // next lookup pays for the fetch again.
      expect(result).toBe(4.25);
    });

    it("returns null when neither a stored rate nor a provider window is available", async () => {
      exchangeRateRepository.find.mockResolvedValue([]);
      chain.dailySeries.mockResolvedValue(NO_ANSWER);

      const result = await service.getRateForDate("EUR", "PLN", "2026-06-08");

      expect(result).toBeNull();
      expect(bulkInsertedRows()).toEqual([]);
    });

    it("returns null when the providers answer the window as empty", async () => {
      exchangeRateRepository.find.mockResolvedValue([]);
      chain.dailySeries.mockResolvedValue(EMPTY_WINDOW);

      expect(
        await service.getRateForDate("EUR", "PLN", "2026-06-08"),
      ).toBeNull();
    });

    it("stays inside the database when the caller asks it to", async () => {
      exchangeRateRepository.find.mockResolvedValue([]);

      const result = await service.getRateForDate("EUR", "PLN", "2026-06-08", {
        fetchMissing: false,
      });

      expect(result).toBeNull();
      expect(chain.dailySeries).not.toHaveBeenCalled();
    });

    it("clamps a future date to today rather than hunting for a rate that cannot exist", async () => {
      // `todayYMD` is pinned to 2026-08-18 at the top of this file.
      const today = "2026-08-18";
      exchangeRateRepository.find.mockResolvedValue([
        storedRow("USD", "CAD", 1.365, today),
      ]);

      // A scheduled transaction posted ahead of time: there is no rate for its
      // due date and there never will be until the day arrives, so today's is
      // the answer -- the same figure the bills list is already showing.
      const result = await service.getRateForDate("USD", "CAD", "2099-01-01");

      expect(result).toBe(1.365);
      const [, ceiling] = spanBounds(
        exchangeRateRepository.find.mock.calls[0][0],
      );
      expect(ceiling).toBe(today);
      // No historical window: a future window contains nothing to choose from.
      expect(chain.dailySeries).not.toHaveBeenCalled();
    });

    it("carries the last trading day forward across a weekend", async () => {
      // 2026-06-06 is a Saturday; 2026-06-05 the Friday before it.
      exchangeRateRepository.find.mockResolvedValue([
        storedRow("USD", "CAD", 1.365, "2026-06-05"),
      ]);

      const result = await service.getRateForDate("USD", "CAD", "2026-06-06");

      expect(result).toBe(1.365);
      expect(chain.dailySeries).not.toHaveBeenCalled();
    });

    /**
     * Was: "takes the nearest day either side when the target predates the
     * window". A bar struck after the target is not evidence about the target
     * (issue #1390); the window answers nothing and the caller learns so.
     */
    it("refuses a fetched window whose every bar is dated after the target", async () => {
      exchangeRateRepository.find.mockResolvedValue([]);
      chain.dailySeries.mockResolvedValue(
        seriesAnswer([
          point("EUR", "PLN", "2026-06-20", 4.4),
          point("EUR", "PLN", "2026-06-10", 4.3),
        ]),
      );

      const result = await service.getRateForDate("EUR", "PLN", "2026-06-08");

      expect(result).toBeNull();
      // The bars are still persisted: a neighbouring date they DO cover is
      // then a database read rather than a second provider call.
      expect(bulkInsertedRows()).toHaveLength(2);
    });

    /**
     * Was: "falls back to the latest stored rate of any date when the provider
     * has nothing". An arbitrarily old rate does not describe the date being
     * asked about (`docs/time-series-contract.md` section 2.2), and reporting
     * it as that date's rate is the second half of issue #1390.
     */
    it("is null, not a rate from years away, when nothing covers the date", async () => {
      exchangeRateRepository.find.mockResolvedValue([]);
      chain.dailySeries.mockResolvedValue(NO_ANSWER);

      const result = await service.getRateForDate("USD", "CAD", "2019-01-01");

      expect(result).toBeNull();
    });
  });

  describe("convertOnDate", () => {
    it("is 1:1 for the same currency without any lookup", async () => {
      const result = await service.convertOnDate(
        250,
        "usd",
        "USD",
        "2026-06-08",
      );

      expect(result).toEqual({
        amount: 250,
        fromCurrency: "USD",
        toCurrency: "USD",
        date: "2026-06-08",
        rate: 1,
        convertedAmount: 250,
      });
      expect(exchangeRateRepository.find).not.toHaveBeenCalled();
    });

    it("applies the stored rate on or before the date and reports that date", async () => {
      exchangeRateRepository.find.mockResolvedValue([
        storedRow("USD", "CAD", 1.365, "2026-06-05"),
      ]);

      const result = await service.convertOnDate(
        100,
        "USD",
        "CAD",
        "2026-06-08",
      );

      expect(result).toEqual({
        amount: 100,
        fromCurrency: "USD",
        toCurrency: "CAD",
        date: "2026-06-08",
        rate: 1.365,
        convertedAmount: 136.5,
      });
      const call = exchangeRateRepository.find.mock.calls[0][0];
      expect(call.where[0].fromCurrency).toBe("USD");
      expect(call.where[0].toCurrency).toBe("CAD");
    });

    it("defaults the date to today and clamps a future date to today", async () => {
      exchangeRateRepository.find.mockResolvedValue([
        storedRow("USD", "CAD", 1.365, "2026-08-18"),
      ]);

      const defaulted = await service.convertOnDate(1, "USD", "CAD");
      const future = await service.convertOnDate(1, "USD", "CAD", "2099-01-01");

      // `todayYMD` is pinned to 2026-08-18 at the top of this file.
      expect(defaulted?.date).toBe("2026-08-18");
      expect(future?.date).toBe("2026-08-18");
    });

    it("rounds the converted amount to money precision, never the rate", async () => {
      exchangeRateRepository.find.mockResolvedValue([
        storedRow("USD", "CAD", 0.7325312345, "2026-06-05"),
      ]);

      const result = await service.convertOnDate(
        1234.56,
        "USD",
        "CAD",
        "2026-06-08",
      );

      expect(result?.rate).toBe(0.7325312345);
      expect(result?.convertedAmount).toBe(904.3538);
    });

    it("reciprocates a rate stored only in the reverse direction", async () => {
      exchangeRateRepository.find.mockResolvedValue([
        storedRow("CAD", "USD", 1.365, "2026-06-05"),
      ]);

      // Only CAD->USD is stored (at 1.365); USD->CAD is derived from it.
      const result = await service.convertOnDate(
        136.5,
        "USD",
        "CAD",
        "2026-06-08",
      );

      expect(result?.rate).toBe(roundFxRate(1 / 1.365));
      expect(result?.convertedAmount).toBe(100);
      // One trip to the store. The second lookup this used to make -- the pair
      // reversed, the answer reciprocated -- could never add anything, because
      // the ladder it calls already reads both stored directions.
      expect(exchangeRateRepository.find).toHaveBeenCalledTimes(1);
    });

    it("returns null -- never 1, never the input -- when no rate exists either way", async () => {
      exchangeRateRepository.find.mockResolvedValue([]);

      const result = await service.convertOnDate(
        100,
        "USD",
        "XXX",
        "2026-06-08",
      );

      expect(result).toBeNull();
    });

    it("treats a zero or negative stored rate as absent", async () => {
      exchangeRateRepository.find.mockResolvedValue([
        storedRow("USD", "CAD", 0, "2026-06-05"),
      ]);

      const result = await service.convertOnDate(
        100,
        "USD",
        "CAD",
        "2026-06-08",
      );

      expect(result).toBeNull();
    });
  });

  describe("getLatestRates", () => {
    const listed = (
      fromCurrency: string,
      toCurrency: string,
      rate: number | string,
      rateDate: string,
    ): ExchangeRate =>
      ({
        ...mockExchangeRate,
        fromCurrency,
        toCurrency,
        rate,
        rateDate,
      }) as unknown as ExchangeRate;

    const answerWith = (rows: ExchangeRate[]) => {
      const qb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue(rows),
      });
      exchangeRateRepository.createQueryBuilder.mockReturnValue(qb);
      return qb;
    };

    it("reads the newest row per stored direction with a distinctOn query", async () => {
      const fresh = listed("USD", "CAD", 1.365, todayYMD());
      const qb = answerWith([fresh]);

      const result = await service.getLatestRates();

      expect(result).toEqual([fresh]);
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
      answerWith([]);

      expect(await service.getLatestRates()).toEqual([]);
    });

    it("breaks a same-day tie towards the coin-first row of a coin pair", async () => {
      // IDR sorts before XBT, but XBT is a coin, so XBT->IDR is the stored
      // orientation now and the frozen IDR->XBT row loses the tie.
      currencyRepository.find.mockResolvedValue([{ code: "XBT" }]);
      const fiatFirst = listed("IDR", "XBT", "0.0000000007", todayYMD());
      const coinFirst = listed("XBT", "IDR", 1.52e9, todayYMD());
      answerWith([fiatFirst, coinFirst]);

      expect(await service.getLatestRates()).toEqual([coinFirst]);
    });

    it("returns one row per pair, the fresh canonical one, when a stale mirror survives", async () => {
      // A deployment upgraded from before 1.17 holds the mirror row the refresh
      // no longer writes beside the canonical row it does.
      const staleMirror = listed(
        "USD",
        "CAD",
        1.3,
        addDaysYMD(todayYMD(), -80),
      );
      const freshCanonical = listed("CAD", "USD", "0.7142857143", todayYMD());
      answerWith([freshCanonical, staleMirror]);

      const result = await service.getLatestRates();

      expect(result).toEqual([freshCanonical]);
    });

    it("keeps the fresher row whichever direction it is stored in", async () => {
      const freshMirror = listed("USD", "CAD", 1.3, addDaysYMD(todayYMD(), -1));
      const olderCanonical = listed(
        "CAD",
        "USD",
        0.5,
        addDaysYMD(todayYMD(), -9),
      );
      answerWith([olderCanonical, freshMirror]);

      expect(await service.getLatestRates()).toEqual([freshMirror]);
    });

    it("gives a tie to the canonical orientation, whatever order the rows arrive in", async () => {
      const date = addDaysYMD(todayYMD(), -2);
      const canonical = listed("CAD", "USD", 0.5, date);
      const mirror = listed("USD", "CAD", 1.3, date);

      answerWith([mirror, canonical]);
      expect(await service.getLatestRates()).toEqual([canonical]);
      answerWith([canonical, mirror]);
      expect(await service.getLatestRates()).toEqual([canonical]);
    });

    it("omits a pair whose newest row is older than the age bound", async () => {
      const stale = listed(
        "EUR",
        "USD",
        1.1,
        addDaysYMD(todayYMD(), -(FX_MAX_RATE_AGE_DAYS + 1)),
      );
      const edge = listed(
        "CAD",
        "GBP",
        0.6,
        addDaysYMD(todayYMD(), -FX_MAX_RATE_AGE_DAYS),
      );
      answerWith([edge, stale]);

      expect(await service.getLatestRates()).toEqual([edge]);
    });

    it("treats a non-positive stored rate as absent", async () => {
      answerWith([listed("USD", "CAD", 0, todayYMD())]);

      expect(await service.getLatestRates()).toEqual([]);
    });

    it("lists the pairs in a stable order", async () => {
      const a = listed("USD", "CAD", 1.3, todayYMD());
      const b = listed("EUR", "USD", 1.1, todayYMD());
      const c = listed("CAD", "EUR", 0.7, todayYMD());
      answerWith([a, b, c]);

      expect(await service.getLatestRates()).toEqual([c, b, a]);
    });
  });

  describe("getLatestRate", () => {
    /**
     * The truth table in `docs/specs/exchange-rate-canonical-orientation.md`
     * section 4. A pair is stored in one orientation, so "the latest rate" has to
     * be answered from whichever direction holds it -- this used to read
     * `from->to` alone and returned null for a pair held the other way.
     */
    const row = (
      fromCurrency: string,
      toCurrency: string,
      rate: number | string,
      rateDate: Date | string,
    ): ExchangeRate =>
      ({
        ...mockExchangeRate,
        fromCurrency,
        toCurrency,
        rate,
        rateDate,
      }) as unknown as ExchangeRate;

    /** Answer each direction's newest-row query from what the store holds. */
    const store = (rows: ExchangeRate[]): void => {
      exchangeRateRepository.findOne.mockImplementation(
        async (options: {
          where: { fromCurrency: string; toCurrency: string };
        }) =>
          rows.find(
            (r) =>
              r.fromCurrency === options.where.fromCurrency &&
              r.toCurrency === options.where.toCurrency,
          ) ?? null,
      );
    };

    const today = todayYMD();

    it("returns 1 when from and to are the same currency", async () => {
      const result = await service.getLatestRate("USD", "USD");

      expect(result).toBe(1);
      expect(exchangeRateRepository.findOne).not.toHaveBeenCalled();
    });

    it("returns the rate when the pair is stored in the direction asked for", async () => {
      store([row("USD", "CAD", 1.365, addDaysYMD(today, -10))]);

      const result = await service.getLatestRate("USD", "CAD");

      expect(result).toBe(1.365);
      // Both directions are read; the resolver decides between them.
      expect(exchangeRateRepository.findOne).toHaveBeenCalledWith({
        where: {
          fromCurrency: "USD",
          toCurrency: "CAD",
          rateDate: expect.anything(),
        },
        order: { rateDate: "DESC" },
      });
      expect(exchangeRateRepository.findOne).toHaveBeenCalledWith({
        where: {
          fromCurrency: "CAD",
          toCurrency: "USD",
          rateDate: expect.anything(),
        },
        order: { rateDate: "DESC" },
      });
    });

    it("inverts the stored row when the pair is held the other way", async () => {
      // The case that used to come back null. CAD sorts first, so this is the
      // orientation the collapse stores.
      store([row("CAD", "USD", 0.7326, addDaysYMD(today, -10))]);

      const result = await service.getLatestRate("USD", "CAD");

      expect(result).toBeCloseTo(1 / 0.7326, 9);
    });

    it("returns null when neither direction is stored", async () => {
      store([]);

      expect(await service.getLatestRate("USD", "XYZ")).toBeNull();
    });

    it("prefers the more recently observed direction", async () => {
      store([
        row("USD", "CAD", 1.3, addDaysYMD(today, -10)),
        row("CAD", "USD", 0.5, addDaysYMD(today, -1)),
      ]);

      // The fresher inverse row wins over the older direct one.
      expect(await service.getLatestRate("USD", "CAD")).toBeCloseTo(2, 9);
    });

    it("gives a tie to the direction asked for, so the answer is deterministic", async () => {
      store([
        row("USD", "CAD", 1.3, addDaysYMD(today, -2)),
        row("CAD", "USD", 0.5, addDaysYMD(today, -2)),
      ]);

      expect(await service.getLatestRate("USD", "CAD")).toBe(1.3);
    });

    it("bounds the answer at FX_MAX_RATE_AGE_DAYS when no age is passed", async () => {
      store([row("USD", "CAD", 1.3, addDaysYMD(today, -60))]);

      expect(await service.getLatestRate("USD", "CAD")).toBeNull();
    });

    it("answers a rate inside the default bound", async () => {
      store([row("USD", "CAD", 1.3, addDaysYMD(today, -10))]);

      expect(await service.getLatestRate("USD", "CAD")).toBe(1.3);
    });

    it("applies an age bound to both directions", async () => {
      store([
        row("USD", "CAD", 1.3, addDaysYMD(today, -200)),
        row("CAD", "USD", 0.5, addDaysYMD(today, -200)),
      ]);

      // A rate is a price: past the bound the answer is unknown, not the last
      // one on file, whichever direction that one is stored in.
      expect(await service.getLatestRate("USD", "CAD", 30)).toBeNull();
      const [call] = exchangeRateRepository.findOne.mock.calls;
      expect(call[0].where.rateDate).toBeDefined();
    });

    it("answers from an admissible direction when the other is stale", async () => {
      store([
        row("USD", "CAD", 1.3, addDaysYMD(today, -200)),
        row("CAD", "USD", 0.5, addDaysYMD(today, -3)),
      ]);

      expect(await service.getLatestRate("USD", "CAD", 30)).toBeCloseTo(2, 9);
    });

    it("treats a non-positive stored rate as absent", async () => {
      store([row("USD", "CAD", 0, addDaysYMD(today, -10))]);

      expect(await service.getLatestRate("USD", "CAD")).toBeNull();
    });

    it("converts a decimal string from the driver to a number", async () => {
      // The `pg` DATE parser hands the date back as a literal string and numerics
      // arrive as strings too, so this is the shape the real repository returns.
      store([row("USD", "CAD", "1.3650000000", addDaysYMD(today, -10))]);

      const result = await service.getLatestRate("USD", "CAD");

      expect(result).toBe(1.365);
      expect(typeof result).toBe("number");
    });
  });

  describe("getLiveRate", () => {
    it("returns 1 when from and to are the same currency", async () => {
      const result = await service.getLiveRate("USD", "USD");

      expect(result).toBe(1);
      expect(chain.live).not.toHaveBeenCalled();
      expect(exchangeRateRepository.find).not.toHaveBeenCalled();
    });

    it("returns the chain's live observation when there is one", async () => {
      chain.live.mockResolvedValue(
        observation("USD", "CAD", "2026-08-18", 1.372),
      );

      const result = await service.getLiveRate("USD", "CAD");

      expect(result).toBe(1.372);
      expect(chain.live).toHaveBeenCalledWith("USD", "CAD");
      // Does not touch the stored daily snapshot when a live quote exists
      expect(exchangeRateRepository.find).not.toHaveBeenCalled();
    });

    /**
     * The adapter decides which symbol carries the digits (`JPYUSD=X` is quoted
     * 0.0063 against a close of 0.006336; `USDJPY=X` keeps them) and answers in
     * that orientation; the live rate reciprocates it at the rate column's
     * precision, never money's.
     */
    it("reciprocates a live observation answered in the reverse orientation", async () => {
      chain.live.mockResolvedValue(
        observation("USD", "JPY", "2026-08-18", 157.93),
      );

      const result = await service.getLiveRate("JPY", "USD");

      expect(result).toBe(roundFxRate(1 / 157.93));
      expect(exchangeRateRepository.find).not.toHaveBeenCalled();
    });

    it("falls back to a recent stored rate when the chain has no live observation", async () => {
      chain.live.mockResolvedValue(null);
      exchangeRateRepository.find.mockResolvedValue([
        storedRow("USD", "CAD", 1.365, "2026-08-15"),
      ]);

      const result = await service.getLiveRate("USD", "CAD");

      expect(result).toBe(1.365);
      // Through the one door, over the bounded span -- not an unbounded
      // newest-row read.
      expect(exchangeRateRepository.findOne).not.toHaveBeenCalled();
      const [floor, ceiling] = spanBounds(
        exchangeRateRepository.find.mock.calls[0][0],
      );
      expect(floor).toBe("2026-07-04");
      expect(ceiling).toBe("2026-08-18");
    });

    it("falls back to a recent stored rate when the live fetch throws", async () => {
      chain.live.mockRejectedValue(new Error("rate limited"));
      exchangeRateRepository.find.mockResolvedValue([
        storedRow("USD", "CAD", 1.365, "2026-08-15"),
      ]);

      const result = await service.getLiveRate("USD", "CAD");

      expect(result).toBe(1.365);
      expect(exchangeRateRepository.find).toHaveBeenCalled();
    });

    /**
     * Issue #1390. The stored fallback was `getLatestRate` with no age bound,
     * so with the provider down a rate struck nine months ago was returned as
     * the live one -- and cached as live by `primeLiveRates`, which is how a
     * portfolio total was built on it and still reported itself complete. A
     * rate quoted as "right now" is a price: past the age bound it is unknown.
     */
    it("refuses a stored rate older than the age bound instead of quoting it as live", async () => {
      chain.live.mockResolvedValue(null);
      // 276 days before the fixture's today: outside FX_MAX_RATE_AGE_DAYS.
      exchangeRateRepository.find.mockResolvedValue([
        storedRow("USD", "CAD", 1.2, "2025-11-15"),
      ]);

      const result = await service.getLiveRate("USD", "CAD");

      expect(result).toBeNull();
    });

    it("returns null when neither a live quote nor a stored rate exists", async () => {
      chain.live.mockResolvedValue(null);
      exchangeRateRepository.find.mockResolvedValue([]);

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

    it("takes the deployment-wide lease before calling the provider", async () => {
      dataSource.query.mockResolvedValue([{ code: "USD" }]);

      await service.scheduledRateRefresh();

      expect(fetchSync.withLease).toHaveBeenCalledWith(
        FetchSyncJob.ExchangeRates,
        expect.any(Number),
        expect.any(Function),
      );
    });

    // The reason the lease exists: N replicas firing this cron is N times the
    // provider bill, and the upserts underneath converge either way.
    it("makes no provider call when another replica holds the lease", async () => {
      fetchSync.withLease.mockImplementation(async () => false);
      dataSource.query.mockResolvedValue([{ code: "USD" }, { code: "CAD" }]);

      await service.scheduledRateRefresh();

      expect(chain.latest).not.toHaveBeenCalled();
    });

    it("keeps the lease shorter than the daily interval", async () => {
      dataSource.query.mockResolvedValue([{ code: "USD" }]);

      await service.scheduledRateRefresh();

      // A crashed holder must never block the next tick; the expiry alone is
      // what hands the job back.
      const [, leaseMs] = fetchSync.withLease.mock.calls[0];
      expect(leaseMs).toBeLessThan(24 * 60 * 60 * 1000);
      expect(leaseMs).toBeGreaterThan(0);
    });
  });

  /**
   * The weekend tick (`docs/specs/crypto-accounts.md`, decision 6): only the
   * pairs with a CRYPTO side, under the weekday refresh's lease.
   */
  describe("refreshCryptoRates and scheduledCryptoRateRefresh", () => {
    /** The used-currency query answering each code's kind and price symbol. */
    function routeKindedQueries(
      rows: Array<{
        code: string;
        kind: "FIAT" | "CRYPTO";
        quoteSymbol?: string | null;
      }>,
    ): void {
      routeRateQueries([]);
      const base = dataSource.query.getMockImplementation()!;
      dataSource.query.mockImplementation(
        async (sql: string, params?: unknown[]) =>
          typeof sql === "string" && sql.includes("SELECT DISTINCT code")
            ? rows.map((row) => ({ quoteSymbol: null, ...row }))
            : base(sql, params),
      );
    }

    const IN_USE = [
      { code: "BTC", kind: "CRYPTO" as const, quoteSymbol: "BTC-CAD" },
      { code: "CAD", kind: "FIAT" as const },
      { code: "EUR", kind: "FIAT" as const },
      { code: "USD", kind: "FIAT" as const },
    ];

    it("reads each currency's kind with the currencies in use", async () => {
      routeKindedQueries(IN_USE);
      chain.latest.mockImplementation(async (base) => latestAnswer(base, []));

      await service.refreshCryptoRates();

      const [sql] = dataSource.query.mock.calls.find(([q]) =>
        String(q).includes("SELECT DISTINCT code"),
      )!;
      expect(sql).toContain("LEFT JOIN currencies c USING (code)");
      expect(sql).toContain('c.quote_symbol AS "quoteSymbol"');
    });

    it("asks the chain only for the canonical pairs with a coin side", async () => {
      routeKindedQueries(IN_USE);
      chain.latest.mockImplementation(async (base, quotes) =>
        latestAnswer(
          base,
          quotes.map((quote) =>
            observation(base, quote, "2026-11-07", 137000, "yahoo_crypto"),
          ),
        ),
      );

      const result = await service.refreshCryptoRates();

      // BTC sorts first, so every pair with it is under the BTC base; the
      // fiat bases CAD and EUR have no coin quote and are not asked.
      expect(chain.latest.mock.calls).toEqual([["BTC", ["CAD", "EUR", "USD"]]]);
      expect(result.totalPairs).toBe(3);
      expect(result.updated).toBe(3);
      expect(upsertedRates.map((r) => r.source)).toEqual([
        "yahoo_crypto",
        "yahoo_crypto",
        "yahoo_crypto",
      ]);
    });

    it("puts a coin that sorts after its fiats under its own base", async () => {
      // `ZZZ` sorts after the fiat codes, but a coin pair is stored coin ->
      // fiat (`isCanonicalOrientation`), so its pairs are one question under
      // the coin, not one under each fiat.
      routeKindedQueries([
        { code: "CAD", kind: "FIAT" },
        { code: "EUR", kind: "FIAT" },
        { code: "ZZZ", kind: "CRYPTO", quoteSymbol: "ZZZ-USD" },
      ]);
      chain.latest.mockImplementation(async (base) => latestAnswer(base, []));

      await service.refreshCryptoRates();

      expect(chain.latest.mock.calls).toEqual([["ZZZ", ["CAD", "EUR"]]]);
    });

    it("stores XBT->IDR coin-first although IDR sorts first", async () => {
      routeKindedQueries([
        { code: "IDR", kind: "FIAT" },
        { code: "XBT", kind: "CRYPTO", quoteSymbol: "BTC-IDR" },
      ]);
      // The adapter answers coin -> fiat; stored fiat-first at ten decimals
      // this would be 0.0000000007 and resolve back 6% off.
      chain.latest.mockImplementation(async (base) =>
        latestAnswer(base, [
          observation("XBT", "IDR", "2026-11-07", 1.52e9, "yahoo_crypto"),
        ]),
      );

      const result = await service.refreshCryptoRates();

      expect(chain.latest.mock.calls).toEqual([["XBT", ["IDR"]]]);
      expect(result.updated).toBe(1);
      expect(upsertedRates).toEqual([
        {
          fromCurrency: "XBT",
          toCurrency: "IDR",
          rateDate: "2026-11-07",
          rate: 1.52e9,
          source: "yahoo_crypto",
        },
      ]);
    });

    it("reports a rate the column cannot hold as out of range and saves the rest", async () => {
      routeKindedQueries([
        { code: "BTC", kind: "CRYPTO", quoteSymbol: "BTC-USD" },
        { code: "CAD", kind: "FIAT" },
        { code: "LBP", kind: "FIAT" },
      ]);
      chain.latest.mockImplementation(async (base) =>
        latestAnswer(base, [
          observation("BTC", "CAD", "2026-11-07", 137000, "yahoo_crypto"),
          observation("BTC", "LBP", "2026-11-07", 1.1e10, "yahoo_crypto"),
        ]),
      );

      const result = await service.refreshCryptoRates();

      expect(result.updated).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.results[1]).toEqual({
        pair: "BTC/LBP",
        success: false,
        error: expect.stringMatching(/^Rate out of range/),
      });
      expect(upsertedRates.map((r) => r.toCurrency)).toEqual(["CAD"]);
    });

    it("asks nothing when no coin is in use", async () => {
      routeKindedQueries(IN_USE.filter((row) => row.kind === "FIAT"));

      const result = await service.refreshCryptoRates();

      expect(chain.latest).not.toHaveBeenCalled();
      expect(result.totalPairs).toBe(0);
    });

    it("names the Currencies page for a coin with no price symbol, on the weekday refresh too", async () => {
      routeKindedQueries([
        { code: "CAD", kind: "FIAT" },
        { code: "TWD", kind: "FIAT" },
        { code: "XYZ", kind: "CRYPTO", quoteSymbol: null },
      ]);
      chain.latest.mockImplementation(async (base, quotes) =>
        latestAnswer(base, [], { uncarried: [...quotes] }),
      );

      const result = await service.refreshAllRates();

      expect(result.results).toEqual([
        {
          pair: "CAD/TWD",
          success: false,
          error: "No configured provider carries CAD/TWD",
        },
        {
          pair: "XYZ/CAD",
          success: false,
          error: "XYZ has no price symbol; map one on the Currencies page",
        },
        {
          pair: "XYZ/TWD",
          success: false,
          error: "XYZ has no price symbol; map one on the Currencies page",
        },
      ]);
    });

    it("the weekend tick runs the crypto refresh under the exchange-rate lease", async () => {
      routeKindedQueries(IN_USE);
      chain.latest.mockImplementation(async (base) => latestAnswer(base, []));

      await service.scheduledCryptoRateRefresh();

      expect(fetchSync.withLease).toHaveBeenCalledWith(
        FetchSyncJob.ExchangeRates,
        expect.any(Number),
        expect.any(Function),
      );
      expect(chain.latest.mock.calls).toEqual([["BTC", ["CAD", "EUR", "USD"]]]);
    });

    it("the weekend tick asks no provider when another replica holds the lease", async () => {
      fetchSync.withLease.mockImplementation(async () => false);
      routeKindedQueries(IN_USE);

      await service.scheduledCryptoRateRefresh();

      expect(chain.latest).not.toHaveBeenCalled();
    });

    it("the weekend tick swallows a failure", async () => {
      dataSource.query.mockRejectedValue(new Error("DB error"));

      await expect(
        service.scheduledCryptoRateRefresh(),
      ).resolves.toBeUndefined();
    });

    it("the weekend tick is scheduled Saturday and Sunday at 17:10 New York", () => {
      const source = readFileSync(
        join(__dirname, "exchange-rate.service.ts"),
        "utf8",
      );
      expect(source).toMatch(
        /@Cron\("10 17 \* \* 0,6", \{ timeZone: "America\/New_York" \}\)\s*async scheduledCryptoRateRefresh/,
      );
    });
  });

  /**
   * The one window door, public so `ExchangeRateHistoryService` asks the chain
   * exactly the question the on-demand fill asks. Its `{ stored, answered }` is
   * what reaches the user-facing gap fill (`docs/specs/fx-history-gap-fill.md`).
   */
  describe("fillRateWindow", () => {
    it("persists what the chain answered under its source and reports the window answered", async () => {
      const points = weekdayPoints(
        "USD",
        "CAD",
        "2024-01-01",
        "2024-01-12",
        1.33,
      );
      chain.dailySeries.mockResolvedValue(seriesAnswer(points));

      const result = await service.fillRateWindow(
        "USD",
        "CAD",
        "2024-01-01",
        "2024-01-12",
      );

      expect(chain.dailySeries).toHaveBeenCalledWith(
        "USD",
        "CAD",
        "2024-01-01",
        "2024-01-12",
      );
      expect(result).toEqual({
        stored: points.length,
        answered: true,
        carried: true,
      });
      const rows = bulkInsertedRows();
      expect(rows).toHaveLength(points.length);
      // Asked for USD->CAD, stored as the canonical CAD->USD, every row under
      // the answering provider's slug.
      for (const row of rows) {
        expect(row).toMatchObject({
          from: "CAD",
          to: "USD",
          rate: roundFxRate(1 / 1.33),
          source: YAHOO_SOURCE,
        });
      }
    });

    it("writes the source the chain named, whichever provider that was", async () => {
      chain.dailySeries.mockResolvedValue(
        seriesAnswer([point("USD", "CAD", "2001-03-01", 1.5509)], {
          source: "frankfurter",
        }),
      );

      await service.fillRateWindow("USD", "CAD", "2001-03-01", "2001-03-31");

      expect(bulkInsertedRows()).toEqual([
        {
          from: "CAD",
          to: "USD",
          date: "2001-03-01",
          rate: roundFxRate(1 / 1.5509),
          source: "frankfurter",
        },
      ]);
    });

    it("orients each point from its own orientation when a window came back in both", async () => {
      // The Yahoo adapter merges its direct and reverse symbols densest first,
      // so one answer carries both orientations; each lands on the same rows.
      chain.dailySeries.mockResolvedValue(
        seriesAnswer([
          point("SGD", "VND", "2017-08-17", 17_000),
          point("SGD", "VND", "2017-08-18", 17_010),
          point("VND", "SGD", "2017-08-19", 0.00005),
        ]),
      );

      const result = await service.fillRateWindow(
        "VND",
        "SGD",
        "2017-08-17",
        "2017-08-19",
      );

      expect(result).toEqual({ stored: 3, answered: true, carried: true });
      expect(bulkInsertedRows()).toEqual([
        {
          from: "SGD",
          to: "VND",
          date: "2017-08-17",
          rate: 17_000,
          source: YAHOO_SOURCE,
        },
        {
          from: "SGD",
          to: "VND",
          date: "2017-08-18",
          rate: 17_010,
          source: YAHOO_SOURCE,
        },
        {
          from: "SGD",
          to: "VND",
          date: "2017-08-19",
          rate: roundFxRate(1 / 0.00005),
          source: YAHOO_SOURCE,
        },
      ]);
    });

    it("skips a point whose rate is not a positive number", async () => {
      chain.dailySeries.mockResolvedValue(
        seriesAnswer([
          point("USD", "CAD", "2024-01-02", 1.33),
          point("USD", "CAD", "2024-01-03", 0),
          point("USD", "CAD", "2024-01-04", Number.NaN),
        ]),
      );

      const result = await service.fillRateWindow(
        "USD",
        "CAD",
        "2024-01-01",
        "2024-01-05",
      );

      expect(result.stored).toBe(1);
      expect(bulkInsertedRows().map((row) => row.date)).toEqual(["2024-01-02"]);
    });

    it("reports a window answered as empty: nothing stored, answered", async () => {
      chain.dailySeries.mockResolvedValue(EMPTY_WINDOW);

      const result = await service.fillRateWindow(
        "USD",
        "CAD",
        "2000-01-01",
        "2000-01-31",
      );

      expect(result).toEqual({ stored: 0, answered: true, carried: true });
      expect(bulkInsertedRows()).toEqual([]);
    });

    it("reports a pair no provider carries (a coin without a price symbol): nothing stored, uncarried", async () => {
      chain.dailySeries.mockResolvedValue(UNCARRIED);

      const result = await service.fillRateWindow(
        "DOG",
        "CAD",
        "2000-01-01",
        "2000-01-31",
      );

      expect(result).toEqual({ stored: 0, answered: true, carried: false });
      expect(bulkInsertedRows()).toEqual([]);
    });

    it("reports a window no carrying provider answered: nothing stored, not answered", async () => {
      chain.dailySeries.mockResolvedValue(NO_ANSWER);

      const result = await service.fillRateWindow(
        "USD",
        "CAD",
        "2000-01-01",
        "2000-01-31",
      );

      expect(result).toEqual({ stored: 0, answered: false, carried: true });
      expect(bulkInsertedRows()).toEqual([]);
    });

    it("lets a persist failure reach the caller", async () => {
      chain.dailySeries.mockResolvedValue(
        seriesAnswer([point("USD", "CAD", "2024-01-02", 1.33)]),
      );
      dataSource.query.mockRejectedValue(new Error("Constraint violation"));

      await expect(
        service.fillRateWindow("USD", "CAD", "2024-01-01", "2024-01-05"),
      ).rejects.toThrow("Constraint violation");
    });
  });

  /**
   * On-demand historical fill, for the pairs a point-in-time report cannot
   * convert (issue: "Total unavailable" on the Account Balances report as the
   * date moves back through years the daily refresh never covered).
   */
  describe("ensureRatesForDate", () => {
    // One provider call returns the whole daily series for whatever period it is
    // asked for and costs the same either way, so the unit is a calendar month --
    // plus the lead `closeAt` may reach back over, without which the first days
    // of the month would have nothing to carry forward from.
    it("fetches the whole month, with the boundary lead the lookup needs", async () => {
      const points = weekdayPoints(
        "USD",
        "CAD",
        "2017-07-18",
        "2017-08-31",
        1.27,
      );
      chain.dailySeries.mockResolvedValue(seriesAnswer(points));

      const loaded = await service.ensureRatesForDate(
        [{ from: "USD", to: "CAD" }],
        "2017-08-18",
      );

      expect(loaded).toBe(points.length);
      expect(chain.dailySeries).toHaveBeenCalledTimes(1);
      expect(chain.dailySeries).toHaveBeenCalledWith(
        "USD",
        "CAD",
        "2017-07-18",
        "2017-08-31",
      );
    });

    it("persists one canonical row from the one call", async () => {
      chain.dailySeries.mockResolvedValue(
        seriesAnswer([point("USD", "CAD", "2017-08-17", 1.25)]),
      );

      await service.ensureRatesForDate(
        [{ from: "USD", to: "CAD" }],
        "2017-08-18",
      );

      // Asked for USD->CAD at 1.25, stored as the canonical CAD->USD at 0.8.
      expect(bulkInsertedRows()).toEqual([
        {
          from: "CAD",
          to: "USD",
          date: "2017-08-17",
          rate: 0.8,
          source: YAHOO_SOURCE,
        },
      ]);
    });

    // One fetch lands on the pair's one set of rows, so USD->CAD and CAD->USD
    // are one unit of work -- fetching each would be the same request twice.
    it("asks once for a pair named in both directions", async () => {
      chain.dailySeries.mockResolvedValue(
        seriesAnswer(
          weekdayPoints("USD", "CAD", "2017-07-18", "2017-08-31", 1.25),
        ),
      );

      await service.ensureRatesForDate(
        [
          { from: "USD", to: "CAD" },
          { from: "CAD", to: "USD" },
        ],
        "2017-08-18",
      );

      expect(chain.dailySeries).toHaveBeenCalledTimes(1);
    });

    it("ignores a pair whose two sides are the same currency", async () => {
      const loaded = await service.ensureRatesForDate(
        [{ from: "CAD", to: "CAD" }],
        "2017-08-18",
      );

      expect(loaded).toBe(0);
      expect(chain.dailySeries).not.toHaveBeenCalled();
    });

    // A window answered the other way round lands on the same rows: the chain
    // answers in whichever orientation the provider carried the pair.
    it("stores a window answered in the reverse orientation on the pair's rows", async () => {
      chain.dailySeries.mockResolvedValue(
        seriesAnswer([point("CAD", "USD", "2017-08-17", 0.8)]),
      );

      const loaded = await service.ensureRatesForDate(
        [{ from: "USD", to: "CAD" }],
        "2017-08-18",
      );

      expect(loaded).toBe(1);
      // CAD->USD is already the stored orientation, so it is written as it came.
      expect(bulkInsertedRows()).toEqual([
        {
          from: "CAD",
          to: "USD",
          date: "2017-08-17",
          rate: 0.8,
          source: YAHOO_SOURCE,
        },
      ]);
    });

    // The one case the fetch can never satisfy is the one that would otherwise
    // repeat on every page load: a date before the pair's history begins.
    it("does not ask again for a pair-month the providers had nothing for", async () => {
      // Answered and empty, not unanswered: only an answered-empty window may be
      // remembered. No answer -- a failure, or a call the breaker refused --
      // remembered here leaves every foreign-currency total in the report null
      // for half an hour after the provider came back.
      chain.dailySeries.mockResolvedValue(EMPTY_WINDOW);

      await service.ensureRatesForDate(
        [{ from: "USD", to: "CAD" }],
        "2017-08-18",
      );
      expect(chain.dailySeries).toHaveBeenCalledTimes(1);

      const loaded = await service.ensureRatesForDate(
        [{ from: "CAD", to: "USD" }],
        "2017-08-30",
      );

      expect(loaded).toBe(0);
      expect(chain.dailySeries).toHaveBeenCalledTimes(1);
    });

    it("does ask again for a different month", async () => {
      chain.dailySeries.mockResolvedValue(EMPTY_WINDOW);

      await service.ensureRatesForDate(
        [{ from: "USD", to: "CAD" }],
        "2017-08-18",
      );

      await service.ensureRatesForDate(
        [{ from: "USD", to: "CAD" }],
        "2017-09-18",
      );

      expect(chain.dailySeries).toHaveBeenCalledTimes(2);
    });

    // The market has not been to the end of this month yet, so nothing asks it.
    it("clamps the window at today", async () => {
      chain.dailySeries.mockResolvedValue(
        seriesAnswer([point("USD", "CAD", "2026-08-17", 1.4)]),
      );

      await service.ensureRatesForDate(
        [{ from: "USD", to: "CAD" }],
        "2026-08-18",
      );

      expect(chain.dailySeries).toHaveBeenCalledWith(
        "USD",
        "CAD",
        "2026-07-18",
        "2026-08-18",
      );
    });

    // Best-effort by construction: this runs inside a read the database could
    // answer for every other pair.
    it("lets the other pairs through when one chain call fails", async () => {
      chain.dailySeries.mockImplementation(async (from: string) => {
        if (from === "USD") throw new Error("rate limited");
        return seriesAnswer([point("EUR", "CAD", "2017-08-17", 1.47)]);
      });

      const loaded = await service.ensureRatesForDate(
        [
          { from: "USD", to: "CAD" },
          { from: "EUR", to: "CAD" },
        ],
        "2017-08-18",
      );

      expect(loaded).toBe(1);
      // Fetched as EUR->CAD, stored as the canonical CAD->EUR.
      expect(bulkInsertedRows()).toContainEqual({
        from: "CAD",
        to: "EUR",
        date: "2017-08-17",
        rate: roundFxRate(1 / 1.47),
        source: YAHOO_SOURCE,
      });
    });

    it("does nothing at all when asked for no pairs", async () => {
      const loaded = await service.ensureRatesForDate([], "2017-08-18");

      expect(loaded).toBe(0);
      expect(chain.dailySeries).not.toHaveBeenCalled();
      expect(dataSource.query).not.toHaveBeenCalled();
    });
  });

  /**
   * An empty answer is not a refusal, anywhere it gets cached
   * (`docs/specs/provider-outage-alerts.md`): the chain reports whether the
   * window was answered, and only an answered window may be remembered.
   */
  describe("ensureRatesForDate and the empty-window memory", () => {
    it("does not remember a window no carrying provider answered", async () => {
      // A refusal and a transport failure both persist zero rates, and this
      // memory holds for 30 minutes: remembering one leaves every
      // foreign-currency total in the report null long after a two-minute
      // outage ended. The chain reports such a window as not answered, whether
      // it was one symbol of one provider or every provider that fell silent
      // (section 5 of `docs/specs/exchange-rate-providers.md`).
      chain.dailySeries.mockResolvedValue(NO_ANSWER);

      await service.ensureRatesForDate(
        [{ from: "USD", to: "CAD" }],
        "2026-03-15",
      );
      expect(chain.dailySeries).toHaveBeenCalledTimes(1);

      await service.ensureRatesForDate(
        [{ from: "USD", to: "CAD" }],
        "2026-03-16",
      );
      expect(chain.dailySeries).toHaveBeenCalledTimes(2);
    });

    it("does not remember a window of a pair no provider carries, so a symbol mapped next is asked at once", async () => {
      chain.dailySeries.mockResolvedValue(UNCARRIED);

      await service.ensureRatesForDate(
        [{ from: "DOG", to: "CAD" }],
        "2026-03-15",
      );
      await service.ensureRatesForDate(
        [{ from: "DOG", to: "CAD" }],
        "2026-03-16",
      );

      expect(chain.dailySeries).toHaveBeenCalledTimes(2);
    });

    it("forgets the windows remembered for a code whose price symbol changed, and only those", async () => {
      chain.dailySeries.mockResolvedValue(EMPTY_WINDOW);
      const pairs = [
        { from: "BTC", to: "CAD" },
        { from: "USD", to: "CAD" },
      ];
      await service.ensureRatesForDate(pairs, "2026-03-15");
      expect(chain.dailySeries).toHaveBeenCalledTimes(2);

      service.forgetEmptyRateWindowsFor("btc");
      await service.ensureRatesForDate(pairs, "2026-03-16");

      expect(chain.dailySeries).toHaveBeenCalledTimes(3);
      expect(chain.dailySeries).toHaveBeenLastCalledWith(
        "BTC",
        "CAD",
        expect.any(String),
        expect.any(String),
      );
    });

    it("still remembers a window the providers answered as empty", async () => {
      chain.dailySeries.mockResolvedValue(EMPTY_WINDOW);

      await service.ensureRatesForDate(
        [{ from: "USD", to: "CAD" }],
        "2026-03-15",
      );
      expect(chain.dailySeries).toHaveBeenCalledTimes(1);

      await service.ensureRatesForDate(
        [{ from: "USD", to: "CAD" }],
        "2026-03-16",
      );
      expect(chain.dailySeries).toHaveBeenCalledTimes(1);
    });
  });
});
