import { Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { POLISH_BOND_ADAPTER } from "./adapters/pl";
import { FIXTURE_CATALOG } from "./adapters/pl/pl-test-input";
import { BondAdapter } from "./bond-adapter";
import { BondCatalogService } from "./bond-catalog.service";
import { bondInstrumentId, bondProgramId } from "./bond-instrument-id";
import { contentHash } from "./canonical-json";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
jest.mock("../common/db/with-context", () => ({
  withSystemContext: jest.fn((fn: () => unknown) => fn()),
}));

type Row = Record<string, unknown>;

interface Db {
  currencies: string[];
  programs: Row[];
  instruments: Row[];
  /** key "<instrumentId>:<version>" -> content hash */
  versions: Map<string, string>;
}

function setup(adapters: readonly BondAdapter[], seed: Partial<Db> = {}) {
  const db: Db = {
    currencies: ["PLN"],
    programs: [],
    instruments: [],
    versions: new Map(),
    ...seed,
  };
  const { manager, dataSource } = createScopedDbMocks();
  const statements: string[] = [];
  manager.query.mockImplementation(async (sql: string, params: unknown[]) => {
    statements.push(sql);
    if (sql.includes("INSERT INTO benchmark_series")) return [];
    if (sql.includes("FROM currencies"))
      return db.currencies.includes(params[0] as string)
        ? [{ "?column?": 1 }]
        : [];
    if (sql.includes("INSERT INTO bond_programs")) {
      // Keyed like the table's unique constraint, and insert only.
      if (
        !db.programs.some(
          (p) =>
            p.issuer_country_code === params[1] &&
            p.issuer_code === params[2] &&
            p.program_code === params[3],
        )
      ) {
        db.programs.push({
          id: params[0],
          issuer_country_code: params[1],
          issuer_code: params[2],
          program_code: params[3],
          currency_code: params[4],
        });
      }
      return [];
    }
    if (sql.includes("FROM bond_programs")) {
      return db.programs.filter(
        (p) =>
          p.issuer_country_code === params[0] &&
          p.issuer_code === params[1] &&
          p.program_code === params[2],
      );
    }
    if (sql.includes("INSERT INTO bond_instruments")) {
      // Keyed like the table's unique constraint, and insert only.
      if (
        !db.instruments.some(
          (i) =>
            i.issuer_country_code === params[0] &&
            i.issuer_code === params[1] &&
            i.series_code === params[3],
        )
      ) {
        db.instruments.push({
          id: `id-${params[3]}`,
          issuer_country_code: params[0],
          issuer_code: params[1],
          program_code: params[2],
          series_code: params[3],
          currency_code: params[4],
          marketability: params[5],
        });
      }
      return [];
    }
    if (sql.includes("ORDER BY i.issuer_country_code")) {
      return [
        {
          id: "i-1",
          issuer_country_code: "PL",
          issuer_code: "PL_MF",
          program_code: "TOS",
          series_code: "TOS1029",
          currency_code: "PLN",
          terms_provider: "curated",
          sale_from: "2026-10-01",
          sale_to: "2026-10-31",
        },
        {
          id: "i-2",
          issuer_country_code: "PL",
          issuer_code: "PL_MF",
          program_code: "TOS",
          series_code: "TOS0000",
          currency_code: "PLN",
          terms_provider: "curated",
          sale_from: null,
          sale_to: null,
        },
      ];
    }
    if (sql.includes("SELECT id, program_code")) {
      return db.instruments.filter(
        (i) =>
          i.issuer_country_code === params[0] &&
          i.issuer_code === params[1] &&
          i.series_code === params[2],
      );
    }
    if (sql.includes("INSERT INTO bond_terms_versions")) {
      const key = `${params[0]}:${params[1]}`;
      if (db.versions.has(key)) return [];
      db.versions.set(key, params[3] as string);
      return [{ version: params[1] }];
    }
    if (sql.includes("SELECT content_hash")) {
      return [{ content_hash: db.versions.get(`${params[0]}:${params[1]}`) }];
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const ensureCatalogCurrency = jest.fn(async (code: string) => {
    if (!db.currencies.includes(code)) db.currencies.push(code);
  });
  const service = new BondCatalogService(dataSource as unknown as DataSource, {
    ensureCatalogCurrency,
  });
  return {
    service,
    db,
    statements,
    manager,
    dataSource,
    ensureCatalogCurrency,
  };
}

describe("BondCatalogService", () => {
  let error: jest.SpyInstance;
  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, "error").mockImplementation();
    jest.spyOn(Logger.prototype, "log").mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it("seeds the eight programs and nothing else: no series, no terms, no benchmark row", async () => {
    const { service, db, statements } = setup([POLISH_BOND_ADAPTER]);
    await service.seed([POLISH_BOND_ADAPTER]);
    expect(db.programs.map((p) => p.program_code).sort()).toEqual([
      "COI",
      "DOR",
      "EDO",
      "OTS",
      "ROD",
      "ROR",
      "ROS",
      "TOS",
    ]);
    for (const program of db.programs) {
      expect(program).toMatchObject({
        id: bondProgramId("PL", "PL_MF", program.program_code as string),
        issuer_country_code: "PL",
        issuer_code: "PL_MF",
        currency_code: "PLN",
      });
    }
    expect(db.instruments).toHaveLength(0);
    expect(db.versions.size).toBe(0);
    expect(
      statements.filter(
        (s) =>
          s.includes("benchmark_series") ||
          s.includes("bond_instruments") ||
          s.includes("bond_terms_versions"),
      ),
    ).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it("is a no-op the second time: no second program, nothing logged", async () => {
    const { service, db } = setup([POLISH_BOND_ADAPTER]);
    await service.seed([POLISH_BOND_ADAPTER]);
    const before = JSON.stringify(db.programs);
    await service.seed([POLISH_BOND_ADAPTER]);
    expect(JSON.stringify(db.programs)).toBe(before);
    expect(error).not.toHaveBeenCalled();
  });

  it("never overwrites a stored program whose currency differs, and logs it", async () => {
    const { service, db } = setup([POLISH_BOND_ADAPTER], {
      programs: [
        {
          id: bondProgramId("PL", "PL_MF", "TOS"),
          issuer_country_code: "PL",
          issuer_code: "PL_MF",
          program_code: "TOS",
          currency_code: "EUR",
        },
      ],
    });
    await service.seed([POLISH_BOND_ADAPTER]);
    expect(db.programs.find((p) => p.program_code === "TOS")).toMatchObject({
      currency_code: "EUR",
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatch(/TOS is stored in EUR.*PLN/);
    expect(db.programs).toHaveLength(8);
  });

  it("stores each program in its own transaction, so one program's SQL failure does not lose the others", async () => {
    const { service, db, manager, dataSource } = setup([POLISH_BOND_ADAPTER]);
    const base = manager.query.getMockImplementation()!;
    manager.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("INSERT INTO bond_programs") && params[3] === "ROR") {
        throw new Error("value too long for type character varying(40)");
      }
      return base(sql, params);
    });
    await service.seed([POLISH_BOND_ADAPTER]);
    expect(db.programs).toHaveLength(7);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatch(
      /ROR could not be stored and was skipped: value too long/,
    );
    expect(dataSource.transaction).toHaveBeenCalledTimes(8);
  });

  it("creates the program's currency on demand on a fresh deployment", async () => {
    const { service, db, ensureCatalogCurrency } = setup(
      [POLISH_BOND_ADAPTER],
      { currencies: [] },
    );
    await service.seed([POLISH_BOND_ADAPTER]);
    expect(ensureCatalogCurrency).toHaveBeenCalledWith("PLN");
    expect(db.currencies).toEqual(["PLN"]);
    expect(db.programs).toHaveLength(8);
    expect(error).not.toHaveBeenCalled();
  });

  it("inserts each stored series under its deterministic id, so a link survives a restore elsewhere", async () => {
    const { service, manager, db } = setup([POLISH_BOND_ADAPTER]);
    for (const entry of FIXTURE_CATALOG)
      await service.storeEntry(manager as never, entry);
    const inserts = manager.query.mock.calls.filter(([s]) =>
      String(s).includes("INSERT INTO bond_instruments"),
    );
    expect(inserts).toHaveLength(8);
    for (const [sql, params] of inserts) {
      expect(String(sql)).toMatch(/\(id, issuer_country_code/);
      expect(params[6]).toBe(bondInstrumentId(params[0], params[1], params[3]));
      expect(params[7]).toBe(bondProgramId(params[0], params[1], params[2]));
    }
    expect(new Set(inserts.map(([, p]) => p[6])).size).toBe(8);
    expect(db.versions.size).toBe(8);
    expect(error).not.toHaveBeenCalled();
  });

  it("stores the content hash of the canonical terms", async () => {
    const { service, manager, db } = setup([POLISH_BOND_ADAPTER]);
    for (const entry of FIXTURE_CATALOG)
      await service.storeEntry(manager as never, entry);
    expect(db.versions.get("id-TOS1029:1")).toBe(
      contentHash(
        FIXTURE_CATALOG.find(
          (e) =>
            (e.terms as { instrument: { seriesCode: string } }).instrument
              .seriesCode === "TOS1029",
        )!.terms,
      ),
    );
  });

  it("lists the catalog ordered by country, issuer and series, in the API's shape", async () => {
    const { service, statements } = setup([POLISH_BOND_ADAPTER]);
    await expect(service.listInstruments()).resolves.toEqual([
      {
        id: "i-1",
        issuerCountryCode: "PL",
        issuerCode: "PL_MF",
        programCode: "TOS",
        seriesCode: "TOS1029",
        currencyCode: "PLN",
        termsProvider: "curated",
        saleWindow: { from: "2026-10-01", to: "2026-10-31" },
      },
      {
        id: "i-2",
        issuerCountryCode: "PL",
        issuerCode: "PL_MF",
        programCode: "TOS",
        seriesCode: "TOS0000",
        currencyCode: "PLN",
        termsProvider: "curated",
        saleWindow: null,
      },
    ]);
    expect(statements[0]).toMatch(
      /ORDER BY i\.issuer_country_code, i\.issuer_code, i\.series_code/,
    );
    // The origin of the newest terms version rides with every instrument.
    expect(statements[0]).toContain("terms->'source'->>'provider'");
    // The sale window is read from the newest version, dates as YYYY-MM-DD text.
    expect(statements[0]).toContain(
      "TO_CHAR((v.terms->'saleWindow'->>'from')::date",
    );
  });

  it("finds a stored series by country and series code, compared without case, and only with version 1 stored", async () => {
    const { service, manager } = setup([POLISH_BOND_ADAPTER]);
    await expect(
      service.findStoredSeries(manager as never, "PL", "tos1029"),
    ).resolves.toMatchObject({ id: "i-1", termsProvider: "curated" });
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toContain("UPPER(i.series_code) = UPPER($2)");
    expect(sql).toContain("v.version = 1");
    expect(params).toEqual(["PL", "tos1029"]);
  });

  it("answers which of many series codes are stored with version 1, in one query", async () => {
    const { service, manager } = setup([POLISH_BOND_ADAPTER]);
    manager.query.mockResolvedValueOnce([{ series_code: "TOS1029" }]);
    await expect(
      service.storedSeriesCodes(manager as never, "PL", ["tos1029", "EDO1036"]),
    ).resolves.toEqual(new Set(["TOS1029"]));
    expect(manager.query).toHaveBeenCalledTimes(1);
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toContain("v.version = 1");
    expect(params).toEqual(["PL", ["TOS1029", "EDO1036"]]);
    manager.query.mockClear();
    await expect(
      service.storedSeriesCodes(manager as never, "PL", []),
    ).resolves.toEqual(new Set());
    expect(manager.query).not.toHaveBeenCalled();
  });

  it("finds one instrument by id, or null", async () => {
    const { service, manager } = setup([POLISH_BOND_ADAPTER]);
    await expect(
      service.findSummary(manager as never, "i-1"),
    ).resolves.toMatchObject({ seriesCode: "TOS1029" });
    manager.query.mockResolvedValueOnce([]);
    await expect(
      service.findSummary(manager as never, "nope"),
    ).resolves.toBeNull();
  });

  it("gives a US program its face value of 100 for the unit hint", async () => {
    const { manager, dataSource } = createScopedDbMocks();
    manager.query.mockResolvedValue([
      {
        id: "p-note",
        issuer_country_code: "US",
        issuer_code: "US_TREASURY",
        program_code: "NOTE",
        currency_code: "USD",
        series_count: 0,
        newest_series_code: null,
      },
    ]);
    const service = new BondCatalogService(
      dataSource as unknown as DataSource,
      { ensureCatalogCurrency: jest.fn() },
    );
    await expect(service.listPrograms()).resolves.toMatchObject([
      {
        programCode: "NOTE",
        faceValue: "100",
        cashPriced: true,
        indexedPrincipal: false,
        infoUrl:
          "https://www.treasurydirect.gov/marketable-securities/treasury-notes/",
      },
    ]);
  });

  it("says which programs price a unit as a cash price and which index the principal", async () => {
    const { manager, dataSource } = createScopedDbMocks();
    const row = (program_code: string) => ({
      id: `p-${program_code}`,
      issuer_country_code: "US",
      issuer_code: "US_TREASURY",
      program_code,
      currency_code: "USD",
      series_count: 0,
      newest_series_code: null,
    });
    manager.query.mockResolvedValue(
      ["BILL", "TIPS", "FRN"].map((code) => row(code)),
    );
    const service = new BondCatalogService(
      dataSource as unknown as DataSource,
      { ensureCatalogCurrency: jest.fn() },
    );
    const programs = await service.listPrograms();
    expect(
      programs.map((p) => [p.programCode, p.cashPriced, p.indexedPrincipal]),
    ).toEqual([
      ["BILL", false, false],
      ["TIPS", true, true],
      ["FRN", true, false],
    ]);
  });

  it("lists the programs with their series count and newest series", async () => {
    const { manager, dataSource } = createScopedDbMocks();
    manager.query.mockResolvedValue([
      {
        id: "p-edo",
        issuer_country_code: "PL",
        issuer_code: "PL_MF",
        program_code: "EDO",
        currency_code: "PLN",
        series_count: "3",
        newest_series_code: "EDO1036",
      },
      {
        id: "p-new",
        issuer_country_code: "PL",
        issuer_code: "PL_MF",
        program_code: "ZZZ",
        currency_code: "PLN",
        series_count: 0,
        newest_series_code: null,
      },
    ]);
    const service = new BondCatalogService(
      dataSource as unknown as DataSource,
      {
        ensureCatalogCurrency: jest.fn(),
      },
    );
    await expect(service.listPrograms()).resolves.toEqual([
      {
        id: "p-edo",
        issuerCountryCode: "PL",
        issuerCode: "PL_MF",
        programCode: "EDO",
        currency: "PLN",
        seriesCount: 3,
        newestSeriesCode: "EDO1036",
        // The installed adapter's product page, which redirects to the series on sale.
        infoUrl:
          "https://www.obligacjeskarbowe.pl/oferta-obligacji/obligacje-10-letnie-edo/",
        faceValue: "100.00",
        cashPriced: false,
        indexedPrincipal: false,
      },
      {
        id: "p-new",
        issuerCountryCode: "PL",
        issuerCode: "PL_MF",
        programCode: "ZZZ",
        currency: "PLN",
        seriesCount: 0,
        newestSeriesCode: null,
        // No installed adapter defines ZZZ.
        infoUrl: null,
        faceValue: null,
        cashPriced: false,
        indexedPrincipal: false,
      },
    ]);
    // Ordered by country, issuer and program code, the newest sale window first.
    expect(String(manager.query.mock.calls[0][0])).toMatch(
      /ORDER BY p\.issuer_country_code, p\.issuer_code, p\.program_code/,
    );
  });

  describe("storeEntry reports what it did and logs nothing", () => {
    const entry = FIXTURE_CATALOG[0];

    it("inserts a new instrument and version", async () => {
      const { service, manager, db } = setup([POLISH_BOND_ADAPTER]);
      const outcome = await service.storeEntry(manager as never, entry);
      expect(outcome).toMatchObject({ kind: "inserted" });
      expect(db.versions.size).toBe(1);
      expect(error).not.toHaveBeenCalled();
    });

    it("is unchanged when the same content is stored, and writes no version", async () => {
      const { service, manager, db } = setup([POLISH_BOND_ADAPTER]);
      await service.storeEntry(manager as never, entry);
      const again = await service.storeEntry(manager as never, entry);
      expect(again).toMatchObject({ kind: "unchanged" });
      expect(db.versions.size).toBe(1);
    });

    it("is a conflict when version 1 is stored with different content", async () => {
      const { service, manager, db } = setup([POLISH_BOND_ADAPTER]);
      await service.storeEntry(manager as never, entry);
      const [key] = [...db.versions.keys()];
      db.versions.set(key, "another-hash");
      await expect(
        service.storeEntry(manager as never, entry),
      ).resolves.toMatchObject({ kind: "conflict" });
    });

    it("reports an instrument row that disagrees with the entry", async () => {
      const { service, manager, db } = setup([POLISH_BOND_ADAPTER]);
      await service.storeEntry(manager as never, entry);
      db.instruments[0].program_code = "OTHER";
      const outcome = await service.storeEntry(manager as never, entry);
      expect(outcome).toMatchObject({
        kind: "instrument-mismatch",
        fields: [["programCode", "OTHER", expect.any(String)]],
      });
    });

    it("stores the program under its deterministic id before its instrument, once per program", async () => {
      const { service, manager, db } = setup([POLISH_BOND_ADAPTER]);
      await service.storeEntry(manager as never, entry);
      const calls = manager.query.mock.calls.map(([sql]) => String(sql));
      const firstProgram = calls.findIndex((c) =>
        c.includes("INSERT INTO bond_programs"),
      );
      const firstInstrument = calls.findIndex((c) =>
        c.includes("INSERT INTO bond_instruments"),
      );
      expect(firstProgram).toBeGreaterThan(-1);
      expect(firstProgram).toBeLessThan(firstInstrument);
      expect(db.programs).toHaveLength(1);
      expect(db.programs[0].id).toBe(
        bondProgramId(
          db.programs[0].issuer_country_code as string,
          db.programs[0].issuer_code as string,
          db.programs[0].program_code as string,
        ),
      );
      await service.storeEntry(manager as never, entry);
      expect(db.programs).toHaveLength(1);
    });

    it("refuses a series whose currency differs from its stored program's, writing no instrument", async () => {
      const { service, manager, db } = setup([POLISH_BOND_ADAPTER]);
      await service.storeEntry(manager as never, entry);
      db.programs[0].currency_code = "EUR";
      db.instruments.length = 0;
      const outcome = await service.storeEntry(manager as never, entry);
      expect(outcome).toMatchObject({
        kind: "instrument-mismatch",
        fields: [["programCurrency", "EUR", "PLN"]],
      });
      expect(db.instruments).toHaveLength(0);
    });

    it("reports terms the strict parser refuses", async () => {
      const { service, manager } = setup([POLISH_BOND_ADAPTER]);
      await expect(
        service.storeEntry(manager as never, {
          termsVersion: 1,
          publishedAt: null,
          terms: { schemaVersion: 1 },
        }),
      ).resolves.toMatchObject({ kind: "invalid" });
    });
  });

  it("seeds the benchmark rows alone, and only the codes asked for", async () => {
    const { service, db, statements } = setup([POLISH_BOND_ADAPTER]);
    await service.seedBenchmarkSeries([POLISH_BOND_ADAPTER]);
    expect(db.instruments).toHaveLength(0);
    expect(statements).toHaveLength(2);
    statements.length = 0;
    await service.seedBenchmarkSeries(
      [POLISH_BOND_ADAPTER],
      new Set(["PL_CPI_GUS_YOY"]),
    );
    expect(statements).toHaveLength(1);
  });

  it("never writes covered_through or updated_at when seeding a benchmark row", async () => {
    const { service, statements } = setup([POLISH_BOND_ADAPTER]);
    await service.seedBenchmarkSeries([POLISH_BOND_ADAPTER]);
    const upsert = statements.find((s) =>
      s.includes("INSERT INTO benchmark_series"),
    )!;
    expect(upsert).not.toMatch(/covered_through/);
    // updated_at is the series' last successful fetch: the boot warm-up reads it.
    expect(upsert).not.toMatch(/updated_at/);
  });

  it("seeds at bootstrap under a system context, and never crashes the boot", async () => {
    const { service } = setup([POLISH_BOND_ADAPTER]);
    const seed = jest
      .spyOn(service, "seed")
      .mockRejectedValueOnce(new Error("db down"));
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(error.mock.calls[0][0]).toMatch(/seeding failed: db down/);
    seed.mockResolvedValueOnce();
    await service.onApplicationBootstrap();
    expect(seed).toHaveBeenCalledTimes(2);
  });
});
