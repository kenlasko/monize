import { Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { ProviderHealthService } from "../provider-health/provider-health.service";
import { ProviderUnavailableError } from "../provider-health/provider-unavailable.error";
import { FetchSyncService } from "../common/jobs/fetch-sync.service";
import { BondAdapter, BenchmarkFetchResult } from "./bond-adapter";
import { todayInTimezone } from "../common/date-utils";
import { BenchmarkRefreshService } from "./benchmark-refresh.service";
import { SeriesHttp } from "./series-http";
import { BondCatalogService } from "./bond-catalog.service";
import { BondPriceService } from "./bond-price.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
jest.mock("../common/db/with-context", () => ({
  withSystemContext: jest.fn((fn: () => unknown) => fn()),
}));
jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  todayInTimezone: jest.fn(() => "2026-10-10"),
}));

const result = (code: string, through: string): BenchmarkFetchResult => ({
  observations: [
    { observationDate: "2026-08-01", value: "0.0340", publishedOn: null },
  ],
  coveredThrough: through,
  sourceUrl: `https://example.test/${code}`,
});

function build(opts: {
  fetchers?: Record<string, jest.Mock>;
  /** Warsaw date of each series' last successful fetch; null: never fetched. */
  fetched?: Record<string, string | null>;
  /**
   * What the upsert statement returns: the rows it wrote, a NULL old_value for
   * an inserted one, the replaced value for a correction.
   */
  corrections?: Array<{
    observation_date: string;
    old_value: string | null;
    new_value: string;
  }>;
  /** The stored series whose newest terms read a changed code. */
  instruments?: string[];
  health?: Partial<Record<keyof ProviderHealthService, jest.Mock>>;
  /** The benchmarks a stored series reads (the one-query answer); default both. */
  read?: string[];
}) {
  const fetchers = opts.fetchers ?? {
    NBP_X: jest.fn(async () => result("NBP_X", "2026-10-10")),
    CPI_X: jest.fn(async () => result("CPI_X", "2026-08-01")),
  };
  const adapter: BondAdapter = {
    countryCode: "PL",
    specDoc: "docs/specs/polish-retail-bonds.md",
    timezone: "Europe/Warsaw",
    registerCalendars: (r) => r,
    programs: [],
    benchmarks: [
      {
        code: "NBP_X",
        kind: "STEP",
        publisher: "NBP",
        sourceUrl: "u",
        hosts: ["x"],
        unit: "RATE_FRACTION",
        providerId: "nbp",
      },
      {
        code: "CPI_X",
        kind: "MONTHLY",
        publisher: "GUS",
        sourceUrl: "u",
        hosts: ["x"],
        unit: "RATE_FRACTION",
        providerId: "gus",
      },
    ],
    fetchBenchmark: (code, fetch) => fetchers[code](fetch),
  };
  const { manager, dataSource } = createScopedDbMocks();
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const reads: Array<{ sql: string; params: unknown[] }> = [];
  manager.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes("SELECT i.id")) {
      reads.push({ sql, params });
      return (opts.instruments ?? ["inst-1"]).map((id) => ({ id }));
    }
    if (sql.includes("FROM bond_instruments i")) {
      reads.push({ sql, params });
      return (opts.read ?? ["NBP_X", "CPI_X"]).map((code) => ({ code }));
    }
    if (sql.includes("AS fetched_on")) {
      expect(params[1]).toBe("Europe/Warsaw");
      const fetched = opts.fetched?.[params[0] as string];
      return fetched === undefined ? [] : [{ fetched_on: fetched }];
    }
    writes.push({ sql, params });
    return sql.includes("INSERT INTO benchmark_values")
      ? (opts.corrections ?? [])
      : [];
  });
  const health = {
    assertAvailable: jest.fn(() => "open-gate"),
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(() => true),
    releaseProbe: jest.fn(),
    logFailure: jest.fn(),
    recordDataFailure: jest.fn(),
    recordDataRecovered: jest.fn(),
    ...opts.health,
  };
  const fetchSync = {
    withLease: jest.fn(
      async (_job: string, _ms: number, fn: () => Promise<void>) => {
        await fn();
        return true;
      },
    ),
  };
  const catalog = { seedBenchmarkSeries: jest.fn(async () => undefined) };
  const prices = {
    recomputeLinkedSecuritiesOfSeries: jest.fn(async () => undefined),
  };
  const service = new BenchmarkRefreshService(
    dataSource as unknown as DataSource,
    health as unknown as ProviderHealthService,
    fetchSync as unknown as FetchSyncService,
    catalog as unknown as BondCatalogService,
    new SeriesHttp(health as unknown as ProviderHealthService),
    prices as unknown as BondPriceService,
  );
  return {
    service,
    adapter,
    fetchers,
    writes,
    reads,
    health,
    fetchSync,
    catalog,
    manager,
    prices,
  };
}

describe("BenchmarkRefreshService", () => {
  let logError: jest.SpyInstance;
  beforeEach(() => {
    logError = jest.spyOn(Logger.prototype, "error").mockImplementation();
    jest.spyOn(Logger.prototype, "log").mockImplementation();
    jest.spyOn(Logger.prototype, "warn").mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it("seeds the series rows, fetches each benchmark a stored series reads, stores the values and moves coverage forward", async () => {
    const { service, adapter, writes, catalog } = build({});
    await service.refreshAll({ adapters: [adapter] });
    expect(catalog.seedBenchmarkSeries).toHaveBeenCalledWith(
      [adapter],
      new Set(["NBP_X", "CPI_X"]),
    );
    const inserts = writes.filter((w) =>
      w.sql.includes("INSERT INTO benchmark_values"),
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[0].sql).toMatch(/IS DISTINCT FROM EXCLUDED\.value/);
    expect(inserts[0].params).toEqual([
      "NBP_X",
      ["2026-08-01"],
      ["0.0340"],
      [null],
      "https://example.test/NBP_X",
      [null],
    ]);
    const coverage = writes.filter((w) =>
      w.sql.includes("UPDATE benchmark_series"),
    );
    expect(coverage.map((w) => w.params)).toEqual([
      ["NBP_X", "2026-10-10"],
      ["CPI_X", "2026-08-01"],
    ]);
    expect(coverage[0].sql).toMatch(/GREATEST\(COALESCE\(covered_through/);
  });

  it("fetches nothing, seeds nothing and writes nothing while no stored series reads a benchmark", async () => {
    const { service, adapter, fetchers, catalog, writes, health } = build({
      read: [],
    });
    await expect(
      service.refreshAll({ adapters: [adapter] }),
    ).resolves.toBeUndefined();
    await service.refreshAll({ adapters: [adapter], onlyStale: true });
    expect(fetchers.NBP_X).not.toHaveBeenCalled();
    expect(fetchers.CPI_X).not.toHaveBeenCalled();
    expect(catalog.seedBenchmarkSeries).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(health.assertAvailable).not.toHaveBeenCalled();
  });

  it("fetches only the benchmarks a stored series reads", async () => {
    const { service, adapter, fetchers, catalog, reads } = build({
      read: ["CPI_X"],
    });
    await service.refreshAll({ adapters: [adapter] });
    expect(fetchers.NBP_X).not.toHaveBeenCalled();
    expect(fetchers.CPI_X).toHaveBeenCalledTimes(1);
    expect(catalog.seedBenchmarkSeries).toHaveBeenCalledWith(
      [adapter],
      new Set(["CPI_X"]),
    );
    // One query, over the newest terms version of each stored series, reference tables only.
    expect(reads).toHaveLength(1);
    expect(reads[0].sql).toMatch(/ORDER BY t\.version DESC\s+LIMIT 1/);
    expect(reads[0].sql).toMatch(/'benchmarkId'/);
    expect(reads[0].sql).not.toMatch(/securities|users|accounts/);
    expect(reads[0].params).toEqual([null, false]);
  });

  it("reads the benchmark of an indexed principal as well as that of a rate rule", async () => {
    const { service, adapter, reads } = build({ read: ["CPI_X"] });
    await service.refreshAll({ adapters: [adapter] });
    expect(reads[0].sql).toMatch(/'rateRule' ->> 'benchmarkId'/);
    expect(reads[0].sql).toMatch(/'principalRule' ->> 'benchmarkId'/);
  });

  describe("refreshNeverFetched, after a series is stored", () => {
    it("refreshes the never-fetched benchmark of the stored series under the lease, and no other", async () => {
      const { service, fetchSync, reads } = build({ read: ["CPI_X"] });
      const refresh = jest.spyOn(service, "refreshAll").mockResolvedValue();
      await service.refreshNeverFetched(["inst-1"]);
      expect(reads[0].params).toEqual([["inst-1"], true]);
      expect(reads[0].sql).toMatch(/covered_through IS NOT NULL/);
      expect(fetchSync.withLease).toHaveBeenCalledWith(
        "bond-benchmarks",
        600000,
        expect.any(Function),
      );
      expect(refresh).toHaveBeenCalledWith({
        only: new Set(["CPI_X"]),
        changed: expect.any(Set),
      });
      await service.refreshNeverFetched(["inst-1"], { fetch: jest.fn() });
      expect(refresh).toHaveBeenLastCalledWith({
        fetch: expect.any(Function),
        only: new Set(["CPI_X"]),
        changed: expect.any(Set),
      });
    });

    it("the refresh it runs is limited to those codes, even when other stored series read more", async () => {
      const { service, adapter, fetchers, catalog } = build({});
      await service.refreshAll({
        adapters: [adapter],
        only: new Set(["CPI_X"]),
      });
      expect(fetchers.NBP_X).not.toHaveBeenCalled();
      expect(fetchers.CPI_X).toHaveBeenCalledTimes(1);
      expect(catalog.seedBenchmarkSeries).toHaveBeenCalledWith(
        [adapter],
        new Set(["CPI_X"]),
      );
    });

    it("does nothing when every benchmark of the stored series has been fetched, or no series was stored", async () => {
      const { service, fetchSync, reads } = build({ read: [] });
      await service.refreshNeverFetched(["inst-1"]);
      expect(reads).toHaveLength(1);
      expect(fetchSync.withLease).not.toHaveBeenCalled();
      await service.refreshNeverFetched([]);
      expect(reads).toHaveLength(1);
    });

    it("never throws: a failed refresh or a lost lease leaves the repair to the cron", async () => {
      const { service, fetchSync } = build({ read: ["CPI_X"] });
      fetchSync.withLease.mockRejectedValueOnce(new Error("lease table gone"));
      await expect(
        service.refreshNeverFetched(["inst-1"]),
      ).resolves.toBeUndefined();
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining("lease table gone"),
      );
      fetchSync.withLease.mockResolvedValueOnce(false);
      await expect(
        service.refreshNeverFetched(["inst-1"]),
      ).resolves.toBeUndefined();
    });
  });

  it("skips the write of values when a source returns none, but still records coverage", async () => {
    const empty = jest.fn(async () => ({
      ...result("NBP_X", "2026-10-10"),
      observations: [],
    }));
    const { service, adapter, writes } = build({
      fetchers: {
        NBP_X: empty,
        CPI_X: jest.fn(async () => result("CPI_X", "2026-08-01")),
      },
    });
    await service.refreshAll({ adapters: [adapter] });
    expect(
      writes.filter((w) => w.sql.includes("INSERT INTO benchmark_values")),
    ).toHaveLength(1);
    expect(
      writes.filter((w) => w.sql.includes("UPDATE benchmark_series")),
    ).toHaveLength(2);
  });

  it("computes each adapter's today in its own timezone", async () => {
    const zones: Record<string, string> = {
      "Europe/Warsaw": "2026-10-10",
      "America/New_York": "2026-10-09",
    };
    (todayInTimezone as jest.Mock).mockImplementation(
      (tz: string) => zones[tz],
    );
    const seen: Array<[string, unknown]> = [];
    const { service, adapter, manager } = build({
      fetched: { NBP_X: "2026-10-09", CPI_X: "2026-10-09", US_X: "2026-10-09" },
    });
    const usFetch = jest.fn(async () => result("US_X", "2026-10-09"));
    const us: BondAdapter = {
      ...adapter,
      countryCode: "US",
      timezone: "America/New_York",
      benchmarks: [{ ...adapter.benchmarks[0], code: "US_X" }],
      fetchBenchmark: usFetch,
    };
    manager.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("FROM bond_instruments i"))
        return ["NBP_X", "CPI_X", "US_X"].map((code) => ({ code }));
      if (sql.includes("AS fetched_on")) {
        seen.push([params[0] as string, params[1]]);
        return [{ fetched_on: "2026-10-08" }];
      }
      return [];
    });
    await service.refreshAll({ adapters: [adapter, us], onlyStale: true });
    // Warsaw's today is 10-10, so 10-08 is stale there; New York's today is
    // 10-09, so 10-08 is still yesterday and fresh.
    expect(todayInTimezone).toHaveBeenCalledWith("America/New_York");
    expect(seen).toEqual([
      ["NBP_X", "Europe/Warsaw"],
      ["CPI_X", "Europe/Warsaw"],
      ["US_X", "America/New_York"],
    ]);
    expect(usFetch).not.toHaveBeenCalled();
    (todayInTimezone as jest.Mock).mockImplementation(() => "2026-10-10");
  });

  it("logs a correction with the old and the new value, and nothing for an unchanged value", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn");
    const changed = build({
      corrections: [
        {
          observation_date: "2026-08-01",
          old_value: "0.0340000000",
          new_value: "0.0350000000",
        },
      ],
    });
    await changed.service.refreshAll({ adapters: [changed.adapter] });
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.filter((m) => /correction/.test(m))).toHaveLength(2);
    expect(messages[0]).toMatch(
      /NBP_X.*2026-08-01.*0\.0340000000.*0\.0350000000/,
    );
    const insert = changed.writes.find((w) =>
      w.sql.includes("INSERT INTO benchmark_values"),
    )!;
    expect(insert.sql).toMatch(/WITH incoming AS/);
    expect(insert.sql).toMatch(/IS DISTINCT FROM EXCLUDED\.value/);

    warn.mockClear();
    const same = build({});
    await same.service.refreshAll({ adapters: [same.adapter] });
    expect(
      warn.mock.calls.filter((c) => /correction/.test(String(c[0]))),
    ).toEqual([]);
  });

  it("one series failing does not stop the other, and a plain failure is logged as an error", async () => {
    const { service, adapter, fetchers, writes } = build({
      fetchers: {
        NBP_X: jest.fn(async () => {
          throw new Error("unparseable");
        }),
        CPI_X: jest.fn(async () => result("CPI_X", "2026-08-01")),
      },
    });
    await service.refreshAll({ adapters: [adapter] });
    expect(fetchers.CPI_X).toHaveBeenCalled();
    expect(writes.some((w) => w.params[0] === "CPI_X")).toBe(true);
    expect(logError.mock.calls[0][0]).toMatch(/NBP_X failed: unparseable/);
  });

  it("a provider the breaker refuses is skipped quietly through the health logger", async () => {
    const refused = new ProviderUnavailableError(
      "Narodowy Bank Polski",
      1000,
      null,
    );
    const { service, adapter, health, writes } = build({
      fetchers: {
        NBP_X: jest.fn(async (fetch: (u: string) => Promise<unknown>) =>
          fetch("https://x"),
        ),
        CPI_X: jest.fn(async () => result("CPI_X", "2026-08-01")),
      },
      health: {
        assertAvailable: jest.fn((id: string) => {
          if (id === "nbp") throw refused;
          return "open-gate";
        }),
      },
    });
    await service.refreshAll({ adapters: [adapter] });
    expect(health.logFailure).toHaveBeenCalledWith(
      expect.anything(),
      "nbp",
      expect.stringContaining("NBP_X"),
      refused,
    );
    expect(logError).not.toHaveBeenCalled();
    expect(writes.some((w) => w.params[0] === "CPI_X")).toBe(true);
  });

  it("gates the injected fetch through the breaker and records success after the body", async () => {
    const http = jest.fn(async () => new Response("ok", { status: 200 }));
    const { service, adapter, health } = build({
      fetchers: {
        NBP_X: jest.fn(
          async (
            fetch: (u: string) => Promise<{ status: number; body: Uint8Array }>,
          ) => {
            const got = await fetch("https://x/a");
            expect(got.status).toBe(200);
            expect(new TextDecoder().decode(got.body)).toBe("ok");
            return result("NBP_X", "2026-10-10");
          },
        ),
        CPI_X: jest.fn(async () => result("CPI_X", "2026-08-01")),
      },
    });
    await service.refreshAll({
      adapters: [adapter],
      fetch: http as unknown as typeof fetch,
    });
    expect(health.assertAvailable).toHaveBeenCalledWith("nbp");
    expect(http).toHaveBeenCalledWith(
      "https://x/a",
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(health.recordSuccess).toHaveBeenCalledWith("nbp");
  });

  it("counts a transport failure, hands back an uncounted probe, and rethrows", async () => {
    const boom = new TypeError("fetch failed");
    const http = jest.fn(async () => {
      throw boom;
    });
    const { service, adapter, health } = build({
      fetchers: {
        NBP_X: jest.fn(async (fetch: (u: string) => Promise<unknown>) =>
          fetch("https://x"),
        ),
        CPI_X: jest.fn(async () => result("CPI_X", "2026-08-01")),
      },
      health: {
        assertAvailable: jest.fn(() => "probe"),
        recordFailure: jest.fn(() => false),
      },
    });
    await service.refreshAll({
      adapters: [adapter],
      fetch: http as unknown as typeof fetch,
    });
    expect(health.recordFailure).toHaveBeenCalledWith("nbp", boom);
    expect(health.releaseProbe).toHaveBeenCalledWith("nbp");
    expect(health.recordSuccess).not.toHaveBeenCalledWith("nbp");
    // Routed to the rate-limited health logger, not to an unbounded error line.
    expect(health.logFailure).toHaveBeenCalledWith(
      expect.anything(),
      "nbp",
      expect.stringContaining("NBP_X"),
      boom,
    );
    expect(logError).not.toHaveBeenCalled();
  });

  it("the warm-up fetches only a series never fetched or last fetched before yesterday", async () => {
    // Today is 2026-10-10 (Warsaw). Yesterday and today are fresh; the day
    // before yesterday is stale, whatever the series' own coverage.
    for (const [fetched, expected] of [
      ["2026-10-10", false],
      ["2026-10-09", false],
      ["2026-10-08", true],
      ["2026-08-01", true],
      [null, true],
    ] as const) {
      const { service, adapter, fetchers } = build({
        fetched: { NBP_X: fetched, CPI_X: fetched },
      });
      await service.refreshAll({ adapters: [adapter], onlyStale: true });
      expect([fetched, fetchers.NBP_X.mock.calls.length > 0]).toEqual([
        fetched,
        expected,
      ]);
      expect([fetched, fetchers.CPI_X.mock.calls.length > 0]).toEqual([
        fetched,
        expected,
      ]);
    }
  });

  it("a MONTHLY series fetched today is fresh although its newest month is weeks old", async () => {
    // CPI_X covers only through 2026-08-01, but it was fetched today.
    const { service, adapter, fetchers } = build({
      fetched: { NBP_X: "2026-10-10", CPI_X: "2026-10-10" },
    });
    await service.refreshAll({ adapters: [adapter], onlyStale: true });
    await service.refreshAll({ adapters: [adapter], onlyStale: true });
    expect(fetchers.CPI_X).not.toHaveBeenCalled();
  });

  it("asks the database for the last fetch, never for covered_through", async () => {
    const { service, adapter, manager } = build({
      fetched: { NBP_X: "2026-10-10", CPI_X: "2026-10-10" },
    });
    await service.refreshAll({ adapters: [adapter], onlyStale: true });
    const sql = String(
      manager.query.mock.calls.find(([q]) =>
        String(q).includes("fetched_on"),
      )![0],
    );
    expect(sql).toMatch(/updated_at AT TIME ZONE/);
    expect(sql).not.toMatch(/covered_through</);
  });

  it("records each row's own source URL when an observation names one", async () => {
    const withUrl = jest.fn(async () => ({
      observations: [
        {
          observationDate: "2026-08-01",
          value: "0.0340",
          publishedOn: null,
          sourceUrl: "https://example.test/current",
        },
      ],
      coveredThrough: "2026-10-10",
      sourceUrl: "https://example.test/archive",
    }));
    const { service, adapter, writes } = build({
      fetchers: {
        NBP_X: withUrl,
        CPI_X: jest.fn(async () => result("CPI_X", "2026-08-01")),
      },
    });
    await service.refreshAll({ adapters: [adapter] });
    const insert = writes.find(
      (w) =>
        w.params[0] === "NBP_X" &&
        w.sql.includes("INSERT INTO benchmark_values"),
    )!;
    expect(insert.sql).toMatch(/COALESCE\(t\.u, \$5::text\)/);
    expect(insert.params[4]).toBe("https://example.test/archive");
    expect(insert.params[5]).toEqual(["https://example.test/current"]);
  });

  it("a run where every attempted series fails throws, so fetch_sync records a failure", async () => {
    const down = () =>
      jest.fn(async () => {
        throw new Error("unparseable");
      });
    const { service, adapter } = build({
      fetchers: { NBP_X: down(), CPI_X: down() },
    });
    await expect(service.refreshAll({ adapters: [adapter] })).rejects.toThrow(
      /Every bond benchmark series failed to refresh \(2 of 2\)/,
    );
  });

  it("reports a series that has not been stored for more than 3 days to the health service, and a recent one not", async () => {
    const failing = () =>
      jest.fn(async () => {
        throw new Error("GUS CPI: the feed is stale");
      });
    // Today is 2026-10-10 in Warsaw.
    const { service, adapter, health } = build({
      fetchers: { NBP_X: failing(), CPI_X: failing() },
      fetched: { NBP_X: "2026-10-08", CPI_X: "2026-10-06" },
    });
    await expect(service.refreshAll({ adapters: [adapter] })).rejects.toThrow();
    expect(health.recordDataFailure).toHaveBeenCalledTimes(1);
    expect(health.recordDataFailure).toHaveBeenCalledWith(
      "gus",
      expect.stringMatching(/CPI_X: .*stale.*last stored 2026-10-06/),
    );
    expect(health.recordDataRecovered).not.toHaveBeenCalled();
  });

  it("reports a series that was never stored, and clears the report when a store succeeds", async () => {
    const never = build({
      fetchers: {
        NBP_X: jest.fn(async () => {
          throw new Error("unparseable");
        }),
        CPI_X: jest.fn(async () => result("CPI_X", "2026-08-01")),
      },
    });
    await never.service.refreshAll({ adapters: [never.adapter] });
    expect(never.health.recordDataFailure).toHaveBeenCalledWith(
      "nbp",
      expect.stringContaining("never stored"),
    );
    expect(never.health.recordDataRecovered).toHaveBeenCalledWith("gus");
    expect(never.health.recordDataRecovered).not.toHaveBeenCalledWith("nbp");
  });

  it("one series failing is not a failed run, and a run that skipped everything is not one either", async () => {
    const partial = build({
      fetchers: {
        NBP_X: jest.fn(async () => {
          throw new Error("unparseable");
        }),
        CPI_X: jest.fn(async () => result("CPI_X", "2026-08-01")),
      },
    });
    await expect(
      partial.service.refreshAll({ adapters: [partial.adapter] }),
    ).resolves.toBeUndefined();
    const fresh = build({
      fetched: { NBP_X: "2026-10-10", CPI_X: "2026-10-10" },
    });
    await expect(
      fresh.service.refreshAll({ adapters: [fresh.adapter], onlyStale: true }),
    ).resolves.toBeUndefined();
  });

  it("the lease wrapper records a failed run: the cron and the warm-up pass the throw through it", async () => {
    const { service, fetchSync } = build({});
    jest
      .spyOn(service, "refreshAll")
      .mockRejectedValue(new Error("Every bond benchmark series failed"));
    fetchSync.withLease.mockImplementation(
      async (_j: string, _ms: number, fn: () => Promise<void>) => {
        await fn();
        return true;
      },
    );
    // The cron never dies on it; withLease (real) has already marked the failure.
    await expect(service.scheduledRefresh()).resolves.toBeUndefined();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("Every bond benchmark series failed"),
    );
  });

  it("does not fetch at all when another replica holds the lease", async () => {
    const { service, fetchSync, fetchers } = build({});
    fetchSync.withLease.mockResolvedValue(false);
    await service.scheduledRefresh();
    expect(fetchSync.withLease).toHaveBeenCalledWith(
      "bond-benchmarks",
      600000,
      expect.any(Function),
    );
    expect(fetchers.NBP_X).not.toHaveBeenCalled();
  });

  it("the cron and the warm-up run refreshAll under the lease", async () => {
    const { service, fetchSync } = build({});
    const refresh = jest.spyOn(service, "refreshAll").mockResolvedValue();
    await service.scheduledRefresh();
    expect(refresh).toHaveBeenLastCalledWith({ changed: expect.any(Set) });
    service.onApplicationBootstrap();
    await new Promise((r) => setImmediate(r));
    expect(refresh).toHaveBeenLastCalledWith({
      onlyStale: true,
      changed: expect.any(Set),
    });
    expect(fetchSync.withLease).toHaveBeenCalledTimes(2);
  });

  /**
   * A26-L22 (A26-S14-03), INV-CACHE-001: an observation stored outside the
   * 06:25 run (the boot warm-up, the refresh after a stored series) left the
   * engine prices without it until the next 06:45 recompute, up to a weekend.
   */
  describe("the recompute after a store", () => {
    /** The cron and the warm-up refresh the installed adapters; use the fake. */
    const onFakeAdapter = (
      service: BenchmarkRefreshService,
      adapter: BondAdapter,
    ) => {
      const original = service.refreshAll.bind(service);
      jest
        .spyOn(service, "refreshAll")
        .mockImplementation((options = {}) =>
          original({ ...options, adapters: [adapter] }),
        );
    };

    it("recomputes the series reading a code whose observation was inserted, after the store", async () => {
      const { service, adapter, prices, writes, reads } = build({
        read: ["CPI_X"],
        corrections: [
          {
            observation_date: "2026-08-01",
            old_value: null,
            new_value: "0.0340000000",
          },
        ],
        instruments: ["inst-edo"],
      });
      prices.recomputeLinkedSecuritiesOfSeries.mockImplementation(async () => {
        // Dispatched after the store committed: the coverage write has run.
        expect(
          writes.some((w) => w.sql.includes("UPDATE benchmark_series")),
        ).toBe(true);
      });

      onFakeAdapter(service, adapter);
      await service.scheduledRefresh();

      expect(prices.recomputeLinkedSecuritiesOfSeries).toHaveBeenCalledTimes(1);
      expect(prices.recomputeLinkedSecuritiesOfSeries).toHaveBeenCalledWith([
        "inst-edo",
      ]);
      const lookup = reads.find((r) => r.sql.includes("SELECT i.id"))!;
      expect(lookup.params).toEqual([["CPI_X"]]);
    });

    it("recomputes after a correction too, from the boot warm-up", async () => {
      const { service, adapter, prices } = build({
        read: ["NBP_X"],
        corrections: [
          {
            observation_date: "2026-08-01",
            old_value: "0.0340000000",
            new_value: "0.0350000000",
          },
        ],
      });

      onFakeAdapter(service, adapter);
      service.onApplicationBootstrap();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(prices.recomputeLinkedSecuritiesOfSeries).toHaveBeenCalledWith([
        "inst-1",
      ]);
    });

    it("recomputes nothing when the store changed no observation", async () => {
      const { service, adapter, prices, reads, writes } = build({
        corrections: [],
      });

      onFakeAdapter(service, adapter);
      await service.scheduledRefresh();

      // The run did store: it is the store that changed nothing.
      expect(
        writes.some((w) => w.sql.includes("INSERT INTO benchmark_values")),
      ).toBe(true);

      expect(prices.recomputeLinkedSecuritiesOfSeries).not.toHaveBeenCalled();
      expect(reads.some((r) => r.sql.includes("SELECT i.id"))).toBe(false);
    });
  });

  it("a failed warm-up is a warning, not a crash", async () => {
    const { service, fetchSync } = build({});
    fetchSync.withLease.mockRejectedValue(new Error("lease table gone"));
    expect(() => service.onApplicationBootstrap()).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("lease table gone"),
    );
  });
});
