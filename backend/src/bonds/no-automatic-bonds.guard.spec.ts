import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { BenchmarkRefreshService } from "./benchmark-refresh.service";
import { BondAdapter } from "./bond-adapter";
import { INSTALLED_BOND_ADAPTERS } from "./bond-adapters";
import { BondCatalogService } from "./bond-catalog.service";
import { BondSeriesService } from "./bond-series.service";
import { SeriesHttp } from "./series-http";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
jest.mock("../common/db/with-context", () => ({
  withSystemContext: jest.fn((fn: () => unknown) => fn()),
}));

/**
 * INV-BOND-008: no bond data without a person's action. No country's series is
 * stored and no request leaves the deployment (the issuer, NBP, GUS or any
 * adapter's source) until a person adds a series, switches auto-fetch on, or
 * asks for a fetch. Every installed adapter is covered, so a new country is
 * held to the rule without touching this file.
 */
const RULE =
  "INV-BOND-008: no bond data without a person's action, see docs/backend/securities-and-providers.md";

/** Every network door an adapter has, as a spy that records and answers nothing. */
function watched(adapter: BondAdapter) {
  const calls: string[] = [];
  const spy = (name: keyof BondAdapter) => {
    const original = adapter[name];
    if (typeof original !== "function") return;
    jest
      .spyOn(adapter as never, name as never)
      .mockImplementation((async () => {
        calls.push(`${adapter.countryCode}.${String(name)}`);
        throw new Error(`${RULE} (${adapter.countryCode}.${String(name)})`);
      }) as never);
  };
  for (const name of [
    "fetchBenchmark",
    "fetchSeries",
    "currentSeries",
  ] as const)
    spy(name);
  return calls;
}

function setup() {
  const { manager, dataSource } = createScopedDbMocks();
  const queries: string[] = [];
  // An empty deployment: every read answers no rows.
  manager.query.mockImplementation(async (sql: string) => {
    queries.push(sql);
    return [];
  });
  const calls = INSTALLED_BOND_ADAPTERS.flatMap(watched);
  const globalFetch = jest
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error(RULE));
  const fetchSync = {
    withLease: jest.fn(
      async (_job: string, _ms: number, fn: () => Promise<void>) => {
        await fn();
        return true;
      },
    ),
  };
  const health = {
    assertAvailable: jest.fn(() => {
      throw new Error(RULE);
    }),
    recordDataFailure: jest.fn(),
    recordDataRecovered: jest.fn(),
    logFailure: jest.fn(),
  };
  const ds = dataSource as unknown as DataSource;
  const catalog = new BondCatalogService(ds, {
    ensureCatalogCurrency: jest.fn(async () => undefined),
  });
  const storeEntry = jest.spyOn(catalog, "storeEntry");
  return {
    ds,
    catalog,
    storeEntry,
    queries,
    calls,
    globalFetch,
    fetchSync,
    health,
  };
}

describe("no bond data without a person's action (INV-BOND-008)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("the installed adapters are known", () => {
    expect(INSTALLED_BOND_ADAPTERS.length).toBeGreaterThan(0);
  });

  it(`the boot seed stores programs only and fetches nothing. ${RULE}`, async () => {
    const { catalog, storeEntry, queries, calls, globalFetch } = setup();
    await catalog.seed();
    expect({ rule: RULE, storeEntry: storeEntry.mock.calls.length }).toEqual({
      rule: RULE,
      storeEntry: 0,
    });
    expect(
      queries.filter((q) =>
        /bond_instruments|bond_terms_versions|bond_period_rates|benchmark_/.test(
          q,
        ),
      ),
    ).toEqual([]);
    expect(queries.some((q) => q.includes("INSERT INTO bond_programs"))).toBe(
      true,
    );
    expect(calls).toEqual([]);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it(`the benchmark refresh, at boot and on its cron, fetches nothing while no series is stored. ${RULE}`, async () => {
    const { ds, catalog, calls, globalFetch, fetchSync, health } = setup();
    const refresh = new BenchmarkRefreshService(
      ds,
      health as never,
      fetchSync as never,
      catalog,
      new SeriesHttp(health as never),
      // A run that stored nothing recomputes nothing (A26-L22).
      { recomputeLinkedSecuritiesOfSeries: jest.fn() } as never,
    );
    refresh.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));
    await refresh.scheduledRefresh();
    await refresh.refreshNeverFetched(["any-instrument"]);
    expect(fetchSync.withLease).toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(health.assertAvailable).not.toHaveBeenCalled();
  });

  it(`the daily series cron fetches nothing while no security has auto-fetch on. ${RULE}`, async () => {
    const { ds, catalog, calls, globalFetch, fetchSync, health } = setup();
    const gated = jest.fn(() => {
      throw new Error(RULE);
    });
    const service = new BondSeriesService(
      ds,
      catalog,
      { gated } as never,
      health as never,
      fetchSync as never,
      { recomputeLinkedSecuritiesOfSeries: jest.fn() } as never,
      { refreshNeverFetched: jest.fn() } as never,
      { increment: jest.fn() } as never,
    );
    await service.scheduledCurrentOffer();
    expect(fetchSync.withLease).toHaveBeenCalled();
    expect(gated).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  describe("product templates carry no per-series value", () => {
    /** Keys that hold a series' own value; a template holds structure only. */
    const DENIED = [
      "seriesCode",
      "firstPeriodRate",
      "annualRate",
      "margin",
      "spread",
      "baseReference",
      "saleWindow",
      "amount",
      "source",
      "publishedAt",
      "letter",
    ];
    const root = join(__dirname, "adapters");

    function offenders(value: unknown, path: string, into: string[]): string[] {
      if (Array.isArray(value))
        value.forEach((v, i) => offenders(v, `${path}[${i}]`, into));
      else if (value && typeof value === "object")
        for (const [k, v] of Object.entries(value)) {
          if (DENIED.includes(k)) into.push(`${path}.${k}`);
          offenders(v, `${path}.${k}`, into);
        }
      return into;
    }

    it.each(INSTALLED_BOND_ADAPTERS.map((a) => a.countryCode))(
      `%s has templates and none holds a series value. ${RULE}`,
      (countryCode) => {
        const dir = join(root, countryCode.toLowerCase(), "templates");
        expect(existsSync(dir)).toBe(true);
        const files = readdirSync(dir).filter((f) =>
          f.endsWith(".template.json"),
        );
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) {
          const doc = JSON.parse(readFileSync(join(dir, file), "utf8"));
          expect({ file, offenders: offenders(doc, file, []) }).toEqual({
            file,
            offenders: [],
          });
        }
      },
    );
  });

  describe("the bond notification producer fetches nothing", () => {
    /** Services that reach a provider, by class and by the file that holds it. */
    const FETCHING = [
      { name: "BondSeriesService", file: "bond-series.service" },
      { name: "BenchmarkRefreshService", file: "benchmark-refresh.service" },
      { name: "SeriesHttp", file: "series-http" },
      { name: "BondOfferService", file: "bond-offer.service" },
    ];
    const stripComments = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    /** What of the fetching services a source mentions, by class or by import. */
    const fetchingIn = (text: string): string[] =>
      FETCHING.filter(
        ({ name, file }) =>
          new RegExp(`\\b${name}\\b`).test(text) ||
          new RegExp(`from\\s+["'][^"']*${file}["']`).test(text),
      ).map(({ name }) => name);
    const producer = stripComments(
      readFileSync(join(__dirname, "bond-notification.service.ts"), "utf8"),
    );

    it(`injects and imports no service that fetches. ${RULE}`, () => {
      expect({ rule: RULE, fetching: fetchingIn(producer) }).toEqual({
        rule: RULE,
        fetching: [],
      });
    });

    it(`makes no request of its own. ${RULE}`, () => {
      expect({
        rule: RULE,
        fetches: /\bfetch\s*\(|\bhttps?\.request\b|\baxios\b/.test(producer),
      }).toEqual({ rule: RULE, fetches: false });
    });

    it("the scan names a fetching service that is injected or imported", () => {
      expect(
        fetchingIn(
          "constructor(private readonly series: BondSeriesService) {}",
        ),
      ).toEqual(["BondSeriesService"]);
      expect(
        fetchingIn('import { Refresh } from "./benchmark-refresh.service";'),
      ).toEqual(["BenchmarkRefreshService"]);
      expect(fetchingIn("// BondOfferService is not used")).toEqual([
        "BondOfferService",
      ]);
      expect(
        fetchingIn(stripComments("// BondOfferService is not used")),
      ).toEqual([]);
    });
  });

  it(`a BondAdapter has no series catalog. ${RULE}`, () => {
    const adapter = INSTALLED_BOND_ADAPTERS[0];
    // @ts-expect-error INV-BOND-008: an adapter ships programs, never series
    const catalog: unknown = adapter.catalog;
    expect(catalog).toBeUndefined();
  });
});
