import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { timingSafeEqual } from "crypto";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { CurrenciesService } from "../currencies/currencies.service";
import {
  BondAdapter,
  BondProgramDefinition,
  CatalogEntry,
} from "./bond-adapter";
import { bondInstrumentId, bondProgramId } from "./bond-instrument-id";
import {
  INSTALLED_BOND_ADAPTERS,
  templateCashPricedOf,
  templateFaceValueOf,
  templateIndexedPrincipalOf,
} from "./bond-adapters";
import { BondInstrumentSummary } from "./bond-valuation.service";
import { contentHash } from "./canonical-json";
import { BondTerms, parseBondTerms } from "./domain/bond-terms";

/** A catalog program (the product, e.g. EDO) as the API names it. */
export interface BondProgramSummary {
  readonly id: string;
  readonly issuerCountryCode: string;
  readonly issuerCode: string;
  readonly programCode: string;
  readonly currency: string;
  readonly seriesCount: number;
  /** The series most recently on sale (newest sale window); null when the program has none. */
  readonly newestSeriesCode: string | null;
  /** The issuer's page describing the product (the adapter's `infoUrl`); null when none. */
  readonly infoUrl: string | null;
  /**
   * The nominal of one bond of the program (the adapter's `faceValue`, an exact
   * decimal string), so a form can say what one unit is; null when no installed
   * adapter declares the program.
   */
  readonly faceValue: string | null;
  /**
   * True when a unit's price is the cash price of one unit of face value (a
   * marketable coupon program), so a form says so; false otherwise.
   */
  readonly cashPriced: boolean;
  /** True when the principal is indexed, so the price includes the inflation adjustment. */
  readonly indexedPrincipal: boolean;
}

/**
 * Seeds the programs of every installed adapter (the product, e.g. EDO) so the
 * security form can offer them, and stores a series' terms version when a fetch
 * or an entry hands one over (`storeEntry`). No series is seeded and nothing is
 * fetched at boot (spec bond-program-securities.md 2.6): a series exists because
 * a person asked for it.
 *
 * Global reference data with no owner, so a system context at boot. Every
 * statement is idempotent (`ON CONFLICT`), so N replicas booting together
 * converge on the same rows. A terms version already stored is never rewritten
 * (INV-BOND-001): an entry whose content differs from the stored one is refused,
 * and a correction is published as a new `termsVersion`.
 */
@Injectable()
export class BondCatalogService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BondCatalogService.name);

  constructor(
    private readonly dataSource: DataSource,
    // Currencies are created on demand in Monize, so a fresh deployment holds
    // none of an instrument's currencies until something asks for one.
    @Inject(forwardRef(() => CurrenciesService))
    private readonly currencies: Pick<
      CurrenciesService,
      "ensureCatalogCurrency"
    >,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await withSystemContext(() => this.seed());
    } catch (error) {
      // Reference data that cannot be seeded is an error to read, not a reason
      // for the whole application to refuse to start.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Bond catalog seeding failed: ${message}`);
    }
  }

  /**
   * The adapters' programs, in their currencies (created inactive). No series
   * and no benchmark row: those follow a stored series. Needs an ambient
   * identity (`withSystemContext`), like any database access.
   */
  async seed(
    adapters: readonly BondAdapter[] = INSTALLED_BOND_ADAPTERS,
  ): Promise<void> {
    for (const adapter of adapters) {
      for (const program of adapter.programs) {
        // One transaction per program: a statement that fails (a value the
        // schema refuses) aborts PostgreSQL's transaction, so a shared one would
        // lose every program after it.
        try {
          await withScopedDb(this.dataSource, async (m) => {
            // The currency is created on demand but inactive: reference data
            // for the catalog, not a currency any user chose.
            await this.currencies.ensureCatalogCurrency(program.currency);
            const stored = await this.ensureProgram(m, program);
            if (stored.currency_code !== program.currency) {
              this.logger.error(
                `Bond program ${program.issuerCountryCode} ${program.issuerCode} ${program.programCode} is stored in ${stored.currency_code}, ` +
                  `the adapter declares ${program.currency}; the program row is never overwritten.`,
              );
            }
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.error(
            `Bond program ${adapter.countryCode} ${program.programCode} could not be stored and was skipped: ${message}`,
          );
        }
      }
    }
  }

  /**
   * The program row, created once and never overwritten, with its stored id and
   * currency. A program stored in another currency than a series is a curation
   * error (the security link compares one currency); the caller compares.
   */
  private async ensureProgram(
    m: EntityManager,
    program: Pick<
      BondProgramDefinition,
      "issuerCountryCode" | "issuerCode" | "programCode" | "currency"
    >,
  ): Promise<{ id: string; currency_code: string }> {
    await m.query(
      `INSERT INTO bond_programs
         (id, issuer_country_code, issuer_code, program_code, currency_code)
       VALUES ($1::uuid, $2, $3, $4, $5)
       ON CONFLICT (issuer_country_code, issuer_code, program_code) DO NOTHING`,
      [
        bondProgramId(
          program.issuerCountryCode,
          program.issuerCode,
          program.programCode,
        ),
        program.issuerCountryCode,
        program.issuerCode,
        program.programCode,
        program.currency,
      ],
    );
    const rows: Array<{ id: string; currency_code: string }> = await m.query(
      `SELECT id, currency_code FROM bond_programs
        WHERE issuer_country_code = $1 AND issuer_code = $2 AND program_code = $3`,
      [program.issuerCountryCode, program.issuerCode, program.programCode],
    );
    return rows[0];
  }

  /**
   * The catalog's programs for the program picker, ordered by country, issuer
   * and program code, each with its series count and its newest series (the
   * newest sale window's start, then the series code).
   */
  async listPrograms(): Promise<BondProgramSummary[]> {
    const rows: Array<{
      id: string;
      issuer_country_code: string;
      issuer_code: string;
      program_code: string;
      currency_code: string;
      series_count: number | string;
      newest_series_code: string | null;
    }> = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT p.id, p.issuer_country_code, p.issuer_code, p.program_code, p.currency_code,
                (SELECT COUNT(*) FROM bond_instruments i WHERE i.bond_program_id = p.id) AS series_count,
                (SELECT i.series_code
                   FROM bond_instruments i
                   LEFT JOIN LATERAL (
                     SELECT v.terms -> 'saleWindow' ->> 'from' AS sale_from
                       FROM bond_terms_versions v
                      WHERE v.bond_instrument_id = i.id
                      ORDER BY v.version DESC
                      LIMIT 1
                   ) tv ON TRUE
                  WHERE i.bond_program_id = p.id
                  ORDER BY tv.sale_from DESC NULLS LAST, i.series_code DESC
                  LIMIT 1) AS newest_series_code
           FROM bond_programs p
          ORDER BY p.issuer_country_code, p.issuer_code, p.program_code`,
      ),
    );
    return rows.map((r) => {
      const key = {
        issuerCountryCode: r.issuer_country_code,
        issuerCode: r.issuer_code,
        programCode: r.program_code,
      };
      return {
        id: r.id,
        issuerCountryCode: r.issuer_country_code,
        issuerCode: r.issuer_code,
        programCode: r.program_code,
        currency: r.currency_code,
        seriesCount: Number(r.series_count),
        newestSeriesCode: r.newest_series_code,
        infoUrl: infoUrlOf(
          INSTALLED_BOND_ADAPTERS,
          r.issuer_country_code,
          r.issuer_code,
          r.program_code,
        ),
        faceValue: templateFaceValueOf(key),
        cashPriced: templateCashPricedOf(key),
        indexedPrincipal: templateIndexedPrincipalOf(key),
      };
    });
  }

  /** The catalog for the link picker, ordered by country, issuer and series. */
  async listInstruments(): Promise<BondInstrumentSummary[]> {
    return withScopedDb(this.dataSource, (m) => this.selectSummaries(m));
  }

  /**
   * The stored instrument of a country's series that already has terms version
   * 1, or null. The series code is compared case-insensitively (a request's
   * spelling is not the catalog's); the issuer is not known to the caller, so a
   * country with two issuers of one series code answers the first by issuer.
   */
  async findStoredSeries(
    m: EntityManager,
    countryCode: string,
    seriesCode: string,
  ): Promise<BondInstrumentSummary | null> {
    const rows = await this.selectSummaries(
      m,
      `WHERE i.issuer_country_code = $1 AND UPPER(i.series_code) = UPPER($2)
         AND EXISTS (SELECT 1 FROM bond_terms_versions v
                      WHERE v.bond_instrument_id = i.id AND v.version = 1)`,
      [countryCode, seriesCode],
    );
    return rows[0] ?? null;
  }

  /**
   * Which of `seriesCodes` the country already holds with terms version 1, in
   * upper case, in one query. The backfill asks this once instead of once per
   * candidate.
   */
  async storedSeriesCodes(
    m: EntityManager,
    countryCode: string,
    seriesCodes: readonly string[],
  ): Promise<Set<string>> {
    if (seriesCodes.length === 0) return new Set();
    const rows: Array<{ series_code: string }> = await m.query(
      `SELECT UPPER(i.series_code) AS series_code
         FROM bond_instruments i
        WHERE i.issuer_country_code = $1
          AND UPPER(i.series_code) = ANY($2::text[])
          AND EXISTS (SELECT 1 FROM bond_terms_versions v
                       WHERE v.bond_instrument_id = i.id AND v.version = 1)`,
      [countryCode, seriesCodes.map((code) => code.toUpperCase())],
    );
    return new Set(rows.map((row) => row.series_code));
  }

  /** One instrument by id, as the API names it, or null. */
  async findSummary(
    m: EntityManager,
    instrumentId: string,
  ): Promise<BondInstrumentSummary | null> {
    const rows = await this.selectSummaries(m, "WHERE i.id = $1", [
      instrumentId,
    ]);
    return rows[0] ?? null;
  }

  private async selectSummaries(
    m: EntityManager,
    where = "",
    params: unknown[] = [],
  ): Promise<BondInstrumentSummary[]> {
    const rows: Array<{
      id: string;
      issuer_country_code: string;
      issuer_code: string;
      program_code: string;
      series_code: string;
      currency_code: string;
      terms_provider: string;
      sale_from: string | null;
      sale_to: string | null;
    }> = await m.query(
      `SELECT i.id, i.issuer_country_code, i.issuer_code, i.program_code, i.series_code, i.currency_code,
              COALESCE((SELECT v.terms->'source'->>'provider'
                          FROM bond_terms_versions v
                         WHERE v.bond_instrument_id = i.id
                         ORDER BY v.version DESC LIMIT 1), '') AS terms_provider,
              sw.sale_from, sw.sale_to
         FROM bond_instruments i
         LEFT JOIN LATERAL (
           SELECT TO_CHAR((v.terms->'saleWindow'->>'from')::date, 'YYYY-MM-DD') AS sale_from,
                  TO_CHAR((v.terms->'saleWindow'->>'to')::date, 'YYYY-MM-DD') AS sale_to
             FROM bond_terms_versions v
            WHERE v.bond_instrument_id = i.id
            ORDER BY v.version DESC LIMIT 1
         ) sw ON TRUE
         ${where}
        ORDER BY i.issuer_country_code, i.issuer_code, i.series_code`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      issuerCountryCode: r.issuer_country_code,
      issuerCode: r.issuer_code,
      programCode: r.program_code,
      seriesCode: r.series_code,
      currencyCode: r.currency_code,
      termsProvider: r.terms_provider,
      saleWindow:
        r.sale_from != null && r.sale_to != null
          ? { from: r.sale_from, to: r.sale_to }
          : null,
    }));
  }

  /**
   * The benchmark series rows of the adapters, for a refresh that must not
   * depend on boot order, and for a stored series so the valuation names the
   * publisher of an observation it lacks. `only` restricts it to the codes a
   * stored series reads; absent, every definition. Joins the ambient
   * transaction.
   */
  async seedBenchmarkSeries(
    adapters: readonly BondAdapter[] = INSTALLED_BOND_ADAPTERS,
    only?: ReadonlySet<string>,
  ): Promise<void> {
    await withScopedDb(this.dataSource, async (m) => {
      for (const adapter of adapters)
        await this.upsertBenchmarkSeries(m, adapter, only);
    });
  }

  /**
   * `covered_through` is never touched: it only moves forward, by the refresh.
   * Nor is `updated_at`: the refresh stamps it as the series' last successful
   * fetch, and the boot warm-up reads it to decide whether to fetch again.
   */
  private async upsertBenchmarkSeries(
    m: EntityManager,
    adapter: BondAdapter,
    only?: ReadonlySet<string>,
  ): Promise<void> {
    for (const series of adapter.benchmarks) {
      if (only && !only.has(series.code)) continue;
      await m.query(
        `INSERT INTO benchmark_series (code, kind, publisher, source_url, unit)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (code) DO UPDATE
            SET kind = EXCLUDED.kind,
                publisher = EXCLUDED.publisher,
                source_url = EXCLUDED.source_url,
                unit = EXCLUDED.unit`,
        [
          series.code,
          series.kind,
          series.publisher,
          series.sourceUrl,
          series.unit,
        ],
      );
    }
  }

  /**
   * Stores one terms entry on the caller's transaction: the program and
   * instrument rows (created once, never overwritten) and the terms version
   * (inserted once, never rewritten). A fetched and an entered series both come
   * here (INV-BOND-001, INV-BOND-006). Reports what happened and logs nothing:
   * the caller refuses.
   */
  async storeEntry(
    m: EntityManager,
    entry: CatalogEntry,
  ): Promise<StoreOutcome> {
    let terms: BondTerms;
    try {
      terms = parseBondTerms(entry.terms);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { kind: "invalid", message };
    }
    const { instrument } = terms;
    const named = `${instrument.issuerCountryCode} ${instrument.issuerCode} ${instrument.seriesCode}`;

    // The currency is created on demand but inactive: it is reference data for
    // the catalog, not a currency any user chose. The nested withScopedDb joins
    // this transaction.
    await this.currencies.ensureCatalogCurrency(instrument.currency);

    // The program row first, in the same transaction as its instrument (spec
    // bond-program-securities.md 2.1): created once, never overwritten, with the
    // program's currency. A program stored in another currency than this series
    // is a curation error (the security link compares one currency), refused.
    const program = await this.ensureProgram(m, {
      issuerCountryCode: instrument.issuerCountryCode,
      issuerCode: instrument.issuerCode,
      programCode: instrument.programCode,
      currency: instrument.currency,
    });
    if (program.currency_code !== instrument.currency) {
      return {
        kind: "instrument-mismatch",
        named,
        instrumentId: bondInstrumentId(
          instrument.issuerCountryCode,
          instrument.issuerCode,
          instrument.seriesCode,
        ),
        fields: [
          ["programCurrency", program.currency_code, instrument.currency],
        ],
      };
    }

    // The id is derived from the unique key, not generated: the table is not in
    // the user backup, so a security's link survives a restore onto another
    // deployment only if the same series has the same id there.
    await m.query(
      `INSERT INTO bond_instruments
         (id, issuer_country_code, issuer_code, program_code, bond_program_id, series_code, currency_code, marketability)
       VALUES ($7::uuid, $1, $2, $3, $8::uuid, $4, $5, $6)
       ON CONFLICT (issuer_country_code, issuer_code, series_code) DO NOTHING`,
      [
        instrument.issuerCountryCode,
        instrument.issuerCode,
        instrument.programCode,
        instrument.seriesCode,
        instrument.currency,
        instrument.marketability,
        bondInstrumentId(
          instrument.issuerCountryCode,
          instrument.issuerCode,
          instrument.seriesCode,
        ),
        program.id,
      ],
    );
    const rows: Array<{
      id: string;
      program_code: string;
      currency_code: string;
      marketability: string;
    }> = await m.query(
      `SELECT id, program_code, currency_code, marketability FROM bond_instruments
        WHERE issuer_country_code = $1 AND issuer_code = $2 AND series_code = $3`,
      [
        instrument.issuerCountryCode,
        instrument.issuerCode,
        instrument.seriesCode,
      ],
    );
    const stored = rows[0];
    // bond_instruments is insert only: an existing row is never overwritten, so a
    // catalog entry that describes the series differently is a curation error, not
    // a correction. Reported naming the series and the field.
    const mismatched = (
      [
        ["programCode", stored.program_code, instrument.programCode],
        ["currency", stored.currency_code, instrument.currency],
        ["marketability", stored.marketability, instrument.marketability],
      ] as const
    ).filter(([, was, now]) => was !== now);
    if (mismatched.length > 0) {
      return {
        kind: "instrument-mismatch",
        named,
        instrumentId: stored.id,
        fields: mismatched,
      };
    }
    const instrumentId = stored.id;

    const hash = contentHash(entry.terms);
    const inserted: unknown[] = await m.query(
      `INSERT INTO bond_terms_versions
         (bond_instrument_id, version, terms, content_hash, source_url, published_at, retrieved_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, NOW())
       ON CONFLICT (bond_instrument_id, version) DO NOTHING
       RETURNING version`,
      [
        instrumentId,
        entry.termsVersion,
        JSON.stringify(entry.terms),
        hash,
        terms.source.url,
        entry.publishedAt,
      ],
    );
    if (inserted.length > 0) {
      return { kind: "inserted", named, instrumentId };
    }

    const storedVersion: Array<{ content_hash: string }> = await m.query(
      `SELECT content_hash FROM bond_terms_versions
        WHERE bond_instrument_id = $1 AND version = $2`,
      [instrumentId, entry.termsVersion],
    );
    return sameContentHash(storedVersion[0]?.content_hash, hash)
      ? { kind: "unchanged", named, instrumentId }
      : { kind: "conflict", named, instrumentId };
  }
}

/** What `BondCatalogService.storeEntry` did with one entry. */
export type StoreOutcome =
  | { kind: "invalid"; message: string }
  | {
      kind: "instrument-mismatch";
      named: string;
      instrumentId: string;
      fields: ReadonlyArray<readonly [string, string, string]>;
    }
  | { kind: "inserted"; named: string; instrumentId: string }
  | { kind: "unchanged"; named: string; instrumentId: string }
  | { kind: "conflict"; named: string; instrumentId: string };

/**
 * Two content hashes (hex SHA-256) compared in constant time. The hash is not a
 * secret, but one comparison everywhere keeps the security scan's timing rule
 * quiet without an exception list.
 */
function sameContentHash(
  stored: string | undefined,
  computed: string,
): boolean {
  if (stored === undefined) return false;
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(computed, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The `infoUrl` an installed adapter gives a program, or null. */
function infoUrlOf(
  adapters: readonly BondAdapter[],
  country: string,
  issuer: string,
  program: string,
): string | null {
  for (const adapter of adapters) {
    for (const p of adapter.programs) {
      if (
        p.issuerCountryCode === country &&
        p.issuerCode === issuer &&
        p.programCode === program
      ) {
        return p.infoUrl ?? null;
      }
    }
  }
  return null;
}
