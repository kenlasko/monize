import { CurrenciesService } from "../../src/currencies/currencies.service";
import { Logger } from "@nestjs/common";
import { readFileSync } from "fs";
import { join } from "path";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { withScopedDb } from "@/common/db/scoped-db";
import { withSystemContext, withUserContext } from "@/common/db/with-context";
import { todayInTimezone } from "@/common/date-utils";
import {
  FetchSyncJob,
  FetchSyncService,
} from "@/common/jobs/fetch-sync.service";
import { ProviderHealthService } from "@/provider-health/provider-health.service";
import { BenchmarkRefreshService } from "@/bonds/benchmark-refresh.service";
import { BondCatalogService } from "@/bonds/bond-catalog.service";
import { SeriesHttp } from "@/bonds/series-http";
import { INSTALLED_BOND_ADAPTERS } from "@/bonds/bond-adapters";
import { POLISH_BOND_ADAPTER } from "@/bonds/adapters/pl/index";
import { FIXTURE_CATALOG } from "@/bonds/adapters/pl/pl-test-input";
import {
  GUS_CPI_CSV_URL,
  GUS_CPI_LANDING_URL,
} from "@/bonds/adapters/pl/pl-gus-cpi";
import {
  NBP_ARCHIVE_URL,
  NBP_CURRENT_URL,
} from "@/bonds/adapters/pl/pl-nbp-reference";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
  deleteBondInstrumentBypassingImmutability,
  deleteBondProgramBypassingImmutability,
  insertBondProgram,
  storeFixtureSeries,
} from "../helpers/integration-setup";
import { FxProviderChain } from "@/currencies/providers/fx-provider-chain";

// The bond catalog only ensures a currency row; it never asks the FX chain.
const NO_FX_CHAIN = {} as unknown as FxProviderChain;

// Every installed country seeds its own programs, so the count follows the adapters.
const SEEDED_PROGRAMS = INSTALLED_BOND_ADAPTERS.reduce(
  (sum, adapter) => sum + adapter.programs.length,
  0,
);

// The GUS fixture's newest month is 2026-08, and a feed more than three months
// behind today is refused as stale. A fixed Warsaw date keeps the fixture
// "current" whenever the suite runs; the database's own NOW() is untouched.
jest.mock("@/common/date-utils", () => ({
  ...jest.requireActual("@/common/date-utils"),
  todayInTimezone: jest.fn(() => "2026-10-10"),
}));

const fixture = (name: string) =>
  readFileSync(join(__dirname, "../../src/bonds/adapters/pl/fixtures", name));

/** A fetch that answers from memory: no test here touches the network. */
function fakeFetch(gus: Buffer): typeof fetch {
  const answers: Record<string, Buffer> = {
    [NBP_ARCHIVE_URL]: fixture("nbp-archive.xml"),
    [NBP_CURRENT_URL]: fixture("nbp-current.xml"),
    [GUS_CPI_CSV_URL]: gus,
  };
  return (async (url: string) => {
    const body = answers[url];
    if (!body) return new Response("not found", { status: 404 });
    return new Response(new Uint8Array(body), { status: 200 });
  }) as unknown as typeof fetch;
}

/**
 * The program seed and the benchmark refresh against a real PostgreSQL:
 * idempotent upserts, the numeric and date handling, and a publisher's
 * correction updating a stored value are properties a mocked manager cannot show.
 */
describe("bond catalog and benchmark refresh (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let catalog: BondCatalogService;
  let refresh: BenchmarkRefreshService;
  let fetchSync: FetchSyncService;
  let currencies: CurrenciesService;

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    dataSource = module.get(DataSource);
    currencies = new CurrenciesService(dataSource, NO_FX_CHAIN);
    fetchSync = new FetchSyncService(dataSource);
    catalog = new BondCatalogService(dataSource, currencies);
    const health = new ProviderHealthService(dataSource);
    refresh = new BenchmarkRefreshService(
      dataSource,
      health,
      fetchSync,
      catalog,
      new SeriesHttp(health),
      // A store that changes an observation dispatches a recompute (A26-L22);
      // this suite's securities hold no bond, so a no-op stands in for it.
      { recomputeLinkedSecuritiesOfSeries: async () => undefined } as never,
    );
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "bond_programs",
      "bond_instruments",
      "benchmark_series",
      "fetch_sync",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('PLN', 'Zloty', 'z', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
  });

  const count = async (table: string): Promise<number> =>
    Number(
      (await dataSource.query(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n,
    );

  it("seeds every installed adapter's programs and nothing else, idempotently: no series, no terms, no benchmark row", async () => {
    await withSystemContext(() => catalog.seed());
    await withSystemContext(() => catalog.seed());
    expect(await count("bond_programs")).toBe(SEEDED_PROGRAMS);
    expect(await count("bond_instruments")).toBe(0);
    expect(await count("bond_terms_versions")).toBe(0);
    expect(await count("benchmark_series")).toBe(0);
    const expectedIssuers = new Set(
      INSTALLED_BOND_ADAPTERS.flatMap((adapter) =>
        adapter.programs.map(
          (p) => `${p.issuerCountryCode}|${p.issuerCode}|${p.currency}`,
        ),
      ),
    );
    const stored: Array<{
      issuer_country_code: string;
      issuer_code: string;
      currency_code: string;
    }> = await dataSource.query(
      `SELECT DISTINCT issuer_country_code, issuer_code, currency_code FROM bond_programs`,
    );
    expect(
      new Set(
        stored.map(
          (r) => `${r.issuer_country_code}|${r.issuer_code}|${r.currency_code}`,
        ),
      ),
    ).toEqual(expectedIssuers);
  });

  it("a stored series points at the program the seed created, and stores terms with a content hash", async () => {
    await withSystemContext(() => catalog.seed());
    await storeFixtureSeries(dataSource, catalog);
    expect(await count("bond_instruments")).toBe(8);
    expect(await count("bond_terms_versions")).toBe(8);
    expect(await count("benchmark_series")).toBe(2);
    // The programs are the seed's: storing the series added none.
    expect(await count("bond_programs")).toBe(SEEDED_PROGRAMS);
    expect(
      await dataSource.query(
        `SELECT COUNT(*)::int AS n FROM bond_instruments i
           JOIN bond_programs p ON p.id = i.bond_program_id
          WHERE p.program_code = i.program_code
            AND p.issuer_country_code = i.issuer_country_code
            AND p.issuer_code = i.issuer_code
            AND p.currency_code = i.currency_code`,
      ),
    ).toEqual([{ n: 8 }]);
    const hashes = await dataSource.query(
      `SELECT DISTINCT length(content_hash) AS n FROM bond_terms_versions`,
    );
    expect(hashes).toEqual([{ n: 64 }]);
  });

  it("does not move covered_through when the benchmark rows are seeded again", async () => {
    await storeFixtureSeries(dataSource, catalog);
    await dataSource.query(
      `UPDATE benchmark_series SET covered_through = '2026-10-01' WHERE code = 'PL_NBP_REFERENCE'`,
    );
    await withSystemContext(() => catalog.seed());
    await storeFixtureSeries(dataSource, catalog);
    const rows = await dataSource.query(
      `SELECT TO_CHAR(covered_through, 'YYYY-MM-DD') AS c FROM benchmark_series WHERE code = 'PL_NBP_REFERENCE'`,
    );
    expect(rows[0].c).toBe("2026-10-01");
  });

  it("stores the other programs when one program's SQL fails (a program code longer than its column)", async () => {
    const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation();
    try {
      const [first, ...rest] = POLISH_BOND_ADAPTER.programs;
      const adapter = {
        ...POLISH_BOND_ADAPTER,
        programs: [{ ...first, programCode: "X".repeat(41) }, ...rest],
      };
      await withSystemContext(() => catalog.seed([adapter]));
      expect(await count("bond_programs")).toBe(rest.length);
      expect(
        errorSpy.mock.calls.some((c) =>
          /could not be stored and was skipped/.test(String(c[0])),
        ),
      ).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("refuses to rewrite a stored terms version with different content", async () => {
    await storeFixtureSeries(dataSource, catalog);
    const before = await dataSource.query(
      `SELECT content_hash FROM bond_terms_versions ORDER BY content_hash`,
    );
    const first = FIXTURE_CATALOG[0];
    const outcome = await withSystemContext(() =>
      withScopedDb(dataSource, (m) =>
        catalog.storeEntry(m, {
          ...first,
          terms: {
            ...(first.terms as object),
            source: {
              provider: "PL_MF",
              url: "https://example.test/x",
              document: "changed",
            },
          },
        }),
      ),
    );
    expect(outcome.kind).toBe("conflict");
    const after = await dataSource.query(
      `SELECT content_hash FROM bond_terms_versions ORDER BY content_hash`,
    );
    expect(after).toEqual(before);
  });

  it("fetches nothing, and creates no benchmark row, while no series is stored", async () => {
    const calls: string[] = [];
    const inner = fakeFetch(fixture("gus-cpi.csv"));
    const wrapped = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      return inner(url, init);
    }) as unknown as typeof fetch;
    await withSystemContext(() => catalog.seed());
    await withSystemContext(() => refresh.refreshAll({ fetch: wrapped }));
    await withSystemContext(() =>
      refresh.refreshAll({ fetch: wrapped, onlyStale: true }),
    );
    expect(calls).toEqual([]);
    expect(await count("benchmark_series")).toBe(0);
    expect(await count("benchmark_values")).toBe(0);
  });

  describe("the first refresh of a benchmark a stored series reads", () => {
    const instrumentId = async (seriesCode: string): Promise<string> =>
      (
        await dataSource.query(
          `SELECT id FROM bond_instruments WHERE series_code = $1`,
          [seriesCode],
        )
      )[0].id;
    const urlsOf = () => {
      const calls: string[] = [];
      const inner = fakeFetch(fixture("gus-cpi.csv"));
      const wrapped = (async (url: string, init?: RequestInit) => {
        calls.push(url);
        return inner(url, init);
      }) as unknown as typeof fetch;
      return { calls, wrapped };
    };

    it("a fixed-rate series reads none: nothing is fetched", async () => {
      await storeFixtureSeries(dataSource, catalog, ["OTS0127"]);
      const { calls, wrapped } = urlsOf();
      await refresh.refreshNeverFetched([await instrumentId("OTS0127")], {
        fetch: wrapped,
      });
      expect(calls).toEqual([]);
    });

    it("a series that reads GUS fetches GUS and only GUS, then is not fetched again", async () => {
      await storeFixtureSeries(dataSource, catalog, ["EDO1036"]);
      const id = await instrumentId("EDO1036");
      const first = urlsOf();
      await refresh.refreshNeverFetched([id], { fetch: first.wrapped });
      // GUS: the landing page names the CSV, then the CSV itself.
      expect(first.calls).toEqual([GUS_CPI_LANDING_URL, GUS_CPI_CSV_URL]);
      expect(await coveredThrough("PL_CPI_GUS_YOY")).toBe("2026-08-01");
      expect(await count("benchmark_values")).toBeGreaterThan(0);

      // Covered now, so a second series reading it does not refetch.
      const second = urlsOf();
      await refresh.refreshNeverFetched([id], { fetch: second.wrapped });
      expect(second.calls).toEqual([]);
    });

    it("the cron's refresh reads only the benchmarks of stored series", async () => {
      await storeFixtureSeries(dataSource, catalog, ["EDO1036"]);
      const { calls, wrapped } = urlsOf();
      await withSystemContext(() => refresh.refreshAll({ fetch: wrapped }));
      expect(calls).toEqual([GUS_CPI_LANDING_URL, GUS_CPI_CSV_URL]);
      expect(await coveredThrough("PL_NBP_REFERENCE")).toBeNull();
    });
  });

  it("fetches both series, stores exact values and covers them", async () => {
    await storeFixtureSeries(dataSource, catalog);
    const gus = fixture("gus-cpi.csv");
    await withSystemContext(() =>
      refresh.refreshAll({ fetch: fakeFetch(gus) }),
    );

    const nbp = await dataSource.query(
      `SELECT TO_CHAR(observation_date, 'YYYY-MM-DD') AS d, value::text AS v
         FROM benchmark_values WHERE benchmark_code = 'PL_NBP_REFERENCE' ORDER BY observation_date`,
    );
    expect(nbp).toHaveLength(5);
    expect(nbp[nbp.length - 1]).toEqual({ d: "2026-03-05", v: "0.0375000000" });

    const cpi = await dataSource.query(
      `SELECT TO_CHAR(observation_date, 'YYYY-MM-DD') AS d, value::text AS v
         FROM benchmark_values WHERE benchmark_code = 'PL_CPI_GUS_YOY' ORDER BY observation_date`,
    );
    expect(cpi.map((r: { d: string }) => r.d)).toEqual([
      "2025-10-01",
      "2025-11-01",
      "2025-12-01",
      "2026-07-01",
      "2026-08-01",
    ]);
    expect(cpi[4].v).toBe("0.0340000000");

    const coverage = await dataSource.query(
      `SELECT code, TO_CHAR(covered_through, 'YYYY-MM-DD') AS c FROM benchmark_series ORDER BY code`,
    );
    expect(coverage).toEqual([
      { code: "PL_CPI_GUS_YOY", c: "2026-08-01" },
      { code: "PL_NBP_REFERENCE", c: todayInTimezone("Europe/Warsaw") },
    ]);
  });

  it("applies a publisher's correction to a stored value and leaves coverage alone", async () => {
    await storeFixtureSeries(dataSource, catalog);
    await withSystemContext(() =>
      refresh.refreshAll({ fetch: fakeFetch(fixture("gus-cpi.csv")) }),
    );
    const revised = Buffer.from(
      fixture("gus-cpi.csv")
        .toString("latin1")
        .replace(";2026;8;103,4;", ";2026;8;103,5;"),
      "latin1",
    );
    await withSystemContext(() =>
      refresh.refreshAll({ fetch: fakeFetch(revised) }),
    );
    const rows = await dataSource.query(
      `SELECT value::text AS v FROM benchmark_values
        WHERE benchmark_code = 'PL_CPI_GUS_YOY' AND observation_date = '2026-08-01'`,
    );
    expect(rows).toEqual([{ v: "0.0350000000" }]);
    expect(await count("benchmark_values")).toBe(10);
    expect(await coveredThrough("PL_CPI_GUS_YOY")).toBe("2026-08-01");
  });

  const coveredThrough = async (code: string): Promise<string | null> =>
    (
      await dataSource.query(
        `SELECT TO_CHAR(covered_through, 'YYYY-MM-DD') AS c FROM benchmark_series WHERE code = $1`,
        [code],
      )
    )[0].c;

  it("never moves covered_through back when a later fetch covers less (a file without the newest month)", async () => {
    await storeFixtureSeries(dataSource, catalog);
    await withSystemContext(() =>
      refresh.refreshAll({ fetch: fakeFetch(fixture("gus-cpi.csv")) }),
    );
    expect(await coveredThrough("PL_CPI_GUS_YOY")).toBe("2026-08-01");

    // The publisher's file now lacks the 2026-08 row: the adapter reports
    // coverage through 2026-07-01, which must not undo what was known.
    const older = Buffer.from(
      fixture("gus-cpi.csv")
        .toString("latin1")
        .split("\n")
        .filter((line) => !/;2026;8;/.test(line))
        .join("\n"),
      "latin1",
    );
    await withSystemContext(() =>
      refresh.refreshAll({ fetch: fakeFetch(older) }),
    );
    expect(await coveredThrough("PL_CPI_GUS_YOY")).toBe("2026-08-01");
    // And a newer fetch still moves it forward: the rule is "only forward".
    await dataSource.query(
      `UPDATE benchmark_series SET covered_through = '2026-07-01' WHERE code = 'PL_CPI_GUS_YOY'`,
    );
    await withSystemContext(() =>
      refresh.refreshAll({ fetch: fakeFetch(fixture("gus-cpi.csv")) }),
    );
    expect(await coveredThrough("PL_CPI_GUS_YOY")).toBe("2026-08-01");
  });

  it("each NBP row records the document it came from", async () => {
    await storeFixtureSeries(dataSource, catalog);
    await withSystemContext(() =>
      refresh.refreshAll({ fetch: fakeFetch(fixture("gus-cpi.csv")) }),
    );
    const rows = await dataSource.query(
      `SELECT TO_CHAR(observation_date, 'YYYY-MM-DD') AS d, source_url
         FROM benchmark_values WHERE benchmark_code = 'PL_NBP_REFERENCE' ORDER BY observation_date`,
    );
    // The fixture's current table repeats the archive's newest date, and the
    // current table wins for it.
    expect(rows[rows.length - 1]).toEqual({
      d: "2026-03-05",
      source_url: NBP_CURRENT_URL,
    });
    expect(rows[0].source_url).toBe(NBP_ARCHIVE_URL);
  });

  describe("the boot warm-up (onlyStale)", () => {
    const counting = (gus: Buffer) => {
      const calls: string[] = [];
      const inner = fakeFetch(gus);
      const wrapped = (async (url: string, init?: RequestInit) => {
        calls.push(url);
        return inner(url, init);
      }) as unknown as typeof fetch;
      return { calls, wrapped };
    };

    beforeEach(() => storeFixtureSeries(dataSource, catalog));

    it("fetches an empty deployment once, then skips every series, the monthly one included", async () => {
      const first = counting(fixture("gus-cpi.csv"));
      await withSystemContext(() =>
        refresh.refreshAll({ fetch: first.wrapped, onlyStale: true }),
      );
      expect(first.calls).toEqual(
        expect.arrayContaining([GUS_CPI_CSV_URL, NBP_ARCHIVE_URL]),
      );
      // The GUS series is covered only through 2026-08-01, weeks behind today,
      // yet it was fetched today: a second boot (a rollout, a restart) is quiet.
      expect(await coveredThrough("PL_CPI_GUS_YOY")).toBe("2026-08-01");

      const second = counting(fixture("gus-cpi.csv"));
      await withSystemContext(() =>
        refresh.refreshAll({ fetch: second.wrapped, onlyStale: true }),
      );
      expect(second.calls).toEqual([]);
    });

    it("fetches a series last fetched before yesterday, and never one the seed merely re-registered", async () => {
      await withSystemContext(() =>
        refresh.refreshAll({ fetch: fakeFetch(fixture("gus-cpi.csv")) }),
      );
      // Seeding again (every boot does) must not look like a fetch.
      await dataSource.query(
        `UPDATE benchmark_series SET updated_at = '2026-10-01T10:00:00Z'`,
      );
      await storeFixtureSeries(dataSource, catalog);
      const stale = counting(fixture("gus-cpi.csv"));
      await withSystemContext(() =>
        refresh.refreshAll({ fetch: stale.wrapped, onlyStale: true }),
      );
      expect(stale.calls).toEqual(
        expect.arrayContaining([GUS_CPI_CSV_URL, NBP_ARCHIVE_URL]),
      );
    });
  });

  it("records a run where every series fails as a failure in fetch_sync, and a partial one as a success", async () => {
    await storeFixtureSeries(dataSource, catalog);
    const lease = (fetchImpl: typeof fetch) =>
      withSystemContext(() =>
        fetchSync.withLease(FetchSyncJob.BondBenchmarks, 60_000, () =>
          refresh.refreshAll({ fetch: fetchImpl }),
        ),
      );
    const state = async () =>
      (
        await dataSource.query(
          `SELECT last_success_at, last_error FROM fetch_sync WHERE job = 'bond-benchmarks'`,
        )
      )[0];
    const down = (async () =>
      new Response("down", { status: 503 })) as unknown as typeof fetch;

    await expect(lease(down)).rejects.toThrow(
      /Every bond benchmark series failed/,
    );
    const failed = await state();
    expect(failed.last_error).toMatch(/Every bond benchmark series failed/);
    expect(failed.last_success_at).toBeNull();

    // One source up: the run is a success and clears the error.
    const half = (async (url: string) =>
      url.includes("nbp.pl")
        ? new Response("down", { status: 503 })
        : new Response(new Uint8Array(fixture("gus-cpi.csv")), {
            status: 200,
          })) as unknown as typeof fetch;
    await expect(lease(half)).resolves.toBe(true);
    const ok = await state();
    expect(ok.last_error).toBeNull();
    expect(ok.last_success_at).not.toBeNull();
  });

  describe("the currency of an instrument", () => {
    it("is created on a deployment that has no such currency, owned by no user", async () => {
      // The only caller of ensureCatalogCurrency's insert branch: the beforeEach
      // pre-inserts PLN, so remove it and seed on a fresh deployment.
      await dataSource.query(`DELETE FROM currencies WHERE code = 'PLN'`);
      await withSystemContext(() => catalog.seed());
      expect(await count("bond_programs")).toBe(SEEDED_PROGRAMS);
      expect(
        await dataSource.query(
          `SELECT code, created_by_user_id FROM currencies WHERE code = 'PLN'`,
        ),
      ).toEqual([{ code: "PLN", created_by_user_id: null }]);
    });

    it("is created inactive, so no user is offered it, while an existing active currency stays active", async () => {
      const user = await createTestUserDirect(dataSource, {
        email: "bond-ccy-list@example.com",
      });
      await dataSource.query(`DELETE FROM currencies WHERE code = 'PLN'`);
      await withSystemContext(() => catalog.seed());
      expect(
        await dataSource.query(
          `SELECT is_active FROM currencies WHERE code = 'PLN'`,
        ),
      ).toEqual([{ is_active: false }]);
      const offered = await withUserContext(user.id, () =>
        currencies.findAll(user.id),
      );
      expect(offered.map((c) => c.code)).not.toContain("PLN");

      // An already-active PLN (the beforeEach row) is left alone by the seed.
      await dataSource.query(
        `UPDATE currencies SET is_active = true WHERE code = 'PLN'`,
      );
      await withSystemContext(() => catalog.seed());
      expect(
        await dataSource.query(
          `SELECT is_active FROM currencies WHERE code = 'PLN'`,
        ),
      ).toEqual([{ is_active: true }]);
    });

    it("must exist: an instrument in an unknown currency is refused by the foreign key", async () => {
      await expect(
        dataSource.query(
          `INSERT INTO bond_instruments (issuer_country_code, issuer_code, program_code, bond_program_id, series_code, currency_code, marketability)
           VALUES ('PL', 'PL_MF', 'TOS', $1, 'NOCCY', 'ZZZ', 'RETAIL_REDEEMABLE')`,
          [await insertBondProgram(dataSource, "TOS")],
        ),
      ).rejects.toThrow(/violates foreign key constraint/);
    });

    it("counts as use: a currency only a bond instrument names is reported in use and survives its creator's removal", async () => {
      const owner = await createTestUserDirect(dataSource, {
        email: "bond-ccy@example.com",
      });
      // A custom currency its creator holds, referenced by nothing but a
      // catalog instrument (a seeded series in a currency a user had created).
      await dataSource.query(
        `INSERT INTO currencies (code, name, symbol, decimal_places, is_active, created_by_user_id)
         VALUES ('ZBP', 'Test Zloty', 'zb', 2, true, $1)`,
        [owner.id],
      );
      const inUse = async () =>
        (
          await dataSource.query(
            `SELECT currency_code_in_use_globally('ZBP') AS in_use`,
          )
        )[0].in_use;
      expect(await inUse()).toBe(false);

      // A program in the custom currency alone also counts as use.
      const zbpProgram = await insertBondProgram(dataSource, "ZBPONLY", "ZBP");
      expect(await inUse()).toBe(true);
      await deleteBondProgramBypassingImmutability(
        dataSource,
        `DELETE FROM bond_programs WHERE id = $1`,
        [zbpProgram],
      );
      expect(await inUse()).toBe(false);

      // An instrument in it, under a program in another currency.
      await dataSource.query(
        `INSERT INTO bond_instruments (issuer_country_code, issuer_code, program_code, bond_program_id, series_code, currency_code, marketability)
         VALUES ('PL', 'PL_MF', 'TOS', $1, 'CCYONLY', 'ZBP', 'RETAIL_REDEEMABLE')`,
        [await insertBondProgram(dataSource, "TOS")],
      );
      expect(await inUse()).toBe(true);

      // The creator removing the currency must leave the row (a delete would
      // abort on the foreign key, and the answer is what stops it trying).
      await withUserContext(owner.id, () => currencies.remove(owner.id, "ZBP"));
      expect(
        await dataSource.query(
          `SELECT code FROM currencies WHERE code = 'ZBP'`,
        ),
      ).toEqual([{ code: "ZBP" }]);

      await deleteBondInstrumentBypassingImmutability(
        dataSource,
        `DELETE FROM bond_instruments WHERE series_code = 'CCYONLY'`,
        [],
      );
      expect(await inUse()).toBe(false);
    });
  });

  it("a source that fails leaves the other series refreshed", async () => {
    // A stored series of each benchmark, so the refresh has something to read
    // (INV-BOND-008: nothing is fetched for a benchmark no stored series reads).
    await storeFixtureSeries(dataSource, catalog, ["EDO1036", "ROR1027"]);
    const failing = (async (url: string) => {
      if (url.includes("nbp.pl")) return new Response("down", { status: 503 });
      return new Response(new Uint8Array(fixture("gus-cpi.csv")), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    await withSystemContext(() => refresh.refreshAll({ fetch: failing }));
    const rows = await dataSource.query(
      `SELECT benchmark_code, COUNT(*)::int AS n FROM benchmark_values GROUP BY benchmark_code`,
    );
    expect(rows).toEqual([{ benchmark_code: "PL_CPI_GUS_YOY", n: 5 }]);
  });
});
