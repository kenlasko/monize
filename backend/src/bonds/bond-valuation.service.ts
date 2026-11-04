import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { todayInTimezone } from "../common/date-utils";
import { withScopedDb } from "../common/db/scoped-db";
import { getEffectiveTimezoneOfUser } from "../common/users-by-timezone.util";
import { loadBondLedger } from "./bond-ledger";
import { BondLotsRefusal, bondLotsAsOf } from "./bond-lots";
import { BenchmarkData } from "./domain/benchmark";
import { ExactDecimal } from "./domain/exact-decimal";
import {
  benchmarkFieldsOf,
  BondTerms,
  parseBondTerms,
  Redemption,
} from "./domain/bond-terms";
import { BOND_CALENDARS } from "./bond-adapters";
import {
  BondDataInconsistentError,
  BondDataNotFoundError,
} from "./bond-errors";
import {
  BondEngineError,
  BondValuation,
  redemptionSplit,
  valueBondLot,
} from "./engine/bond-engine";
import { marketPriceRequired } from "./engine/price-policy";
import { RedemptionSplit } from "./engine/redemption-split";
import { BondScenarios, scenarioOf, unknownScenario } from "./bond-scenarios";

export interface ValueLotRequest {
  readonly issuerCountryCode: string;
  readonly issuerCode: string;
  readonly seriesCode: string;
  /** The newest version when omitted. */
  readonly termsVersion?: number;
  readonly lot: { readonly purchaseDate: string; readonly quantity: number };
  readonly asOf: string;
  readonly projection?: ReadonlyMap<string, string>;
}

interface InstrumentRow {
  id: string;
  issuer_country_code: string;
  issuer_code: string;
  program_code: string;
  series_code: string;
  currency_code: string;
}

/** A catalog instrument as the API names it. */
export interface BondInstrumentSummary {
  readonly id: string;
  readonly issuerCountryCode: string;
  readonly issuerCode: string;
  readonly programCode: string;
  readonly seriesCode: string;
  readonly currencyCode: string;
  /**
   * `source.provider` of the newest terms version: the publisher a curated
   * manifest names, the official host a fetch read, or `manual` for an
   * administrator's entry (INV-BOND-006).
   */
  readonly termsProvider: string;
  /**
   * The newest terms version's sale window (YYYY-MM-DD both ends), or null when
   * the terms state none. Optional only so internal builders that never read it
   * need not name it; the catalog list always sets it.
   */
  readonly saleWindow?: { readonly from: string; readonly to: string } | null;
}

/**
 * Everything the engine reads about one instrument, loaded once: the terms
 * version, the announced rates and the benchmark observations the rate rule
 * needs. Any number of (lot, asOf) valuations are then computed from it in
 * memory (`valueLotFrom`), so a price series over thousands of days costs one
 * set of reads, not one per day.
 */
export interface BondReferenceData {
  readonly instrument: BondInstrumentSummary;
  readonly termsVersion: number;
  readonly terms: BondTerms;
  readonly announcedRates: ReadonlyMap<number, string>;
  readonly benchmarks: ReadonlyMap<string, BenchmarkData>;
}

/** One open lot of a linked security, valued at the requested day. */
export interface SecurityLotValuation {
  /** The series (bond instrument id) the lot belongs to. */
  readonly instrumentId: string | null;
  readonly accountId?: string | null;
  readonly purchaseDate: string;
  readonly quantity: number;
  readonly purchaseDateAssumed: boolean;
  /** What the lot cost, net of accrued interest, as exact text; null when unknown. */
  readonly cost: string | null;
  readonly valuation: BondValuation;
}

/**
 * Lot totals. Each is null unless every lot has the figure: a subtotal is not a
 * total, so one lot without a gross value makes `grossValue` null rather than
 * the sum of the others. No lots at all is a known zero; lots that cannot be
 * derived (`refusal`) make every figure null.
 */
export interface SecurityValuationTotals {
  readonly quantity: number | null;
  readonly grossValue: string | null;
  readonly earlyRedemptionValue: string | null;
  readonly accruedInterest: string | null;
}

/**
 * How fresh a benchmark series the instrument reads is: the day its stored
 * observations are known to cover (null when no fetch has established one) and
 * when the series was last stored. Lets a reader tell "not published yet" from
 * "the feed has stalled".
 */
export interface BenchmarkCoverage {
  readonly benchmarkId: string;
  readonly coveredThrough: string | null;
  readonly lastFetchedAt: string | null;
}

/** Where a terms version came from: the provider, the document's address and its name. */
export interface BondTermsSource {
  readonly provider: string;
  readonly url: string;
  readonly document: string;
}

/** The program a security is linked to, as the valuation names it. */
export interface BondProgramRef {
  readonly id: string;
  readonly programCode: string;
  readonly issuerCountryCode: string;
  readonly issuerCode: string;
  readonly currency: string;
}

/**
 * One series the security holds: its terms' redemption policy and the document
 * they were read from (INV-BOND-006). Per series, because the series of one
 * program have terms of their own.
 */
export interface SecuritySeriesInfo {
  readonly instrumentId: string;
  readonly seriesCode: string;
  readonly programCode: string;
  readonly termsSource: BondTermsSource;
  /** The terms' redemption policy; null when the bond is redeemable at maturity only. */
  readonly redemptionTerms: Redemption | null;
}

export interface SecurityValuation {
  readonly securityId: string;
  readonly program: BondProgramRef;
  /** The security's switch: fetch every new series of the program automatically. */
  readonly autoFetch: boolean;
  readonly asOf: string;
  readonly lots: readonly SecurityLotValuation[];
  /** The series of the open lots (of the whole ledger when the lots are unknown), ordered by series code. */
  readonly series: readonly SecuritySeriesInfo[];
  readonly benchmarkCoverage: readonly BenchmarkCoverage[];
  readonly totals: SecurityValuationTotals;
  readonly refusal: BondLotsRefusal | null;
  /**
   * True when a series the security holds trades (a MARKETABLE series other than
   * a discount instrument): the engine writes no price for the security, so its
   * price is the person's own, and the surface says so (INV-BOND-005,
   * `docs/financial-calculation-contract.md` 1.3). False when every series is
   * priced by its terms, or none is held.
   */
  readonly marketPriceRequired: boolean;
}

/** One account's lots of a linked security: their bond count and exact gross value. */
export interface AccountLotsValue {
  readonly quantity: number;
  /** Null unless every lot of the account has a gross value. */
  readonly grossValue: string | null;
}

export interface SecurityValueByAccount {
  readonly asOf: string;
  /** Keyed by account id; null when the lots are unknowable (a refusal). */
  readonly accounts: ReadonlyMap<string, AccountLotsValue> | null;
}

/** How far a lot count may sit from a holding's quantity and still be the same position. */
const LOT_QUANTITY_TOLERANCE = 0.0001;

/**
 * The gross value of one account's lots as the value of its holding of
 * `quantity` bonds, or why it has none: the valuation failed or its lots are
 * unknowable or one lot has no gross value (`UNKNOWN`), or the lots count a
 * different number of bonds than the holding (`QUANTITY_MISMATCH`: never price
 * a different quantity). Written once for every surface that values a
 * bond-linked holding (`bond-program-securities.md` 2.4).
 */
export function ownLotsGrossValue(
  valued: SecurityValueByAccount | null | undefined,
  accountId: string,
  quantity: number,
):
  | { readonly grossValue: string; readonly lotQuantity: number }
  | { readonly unpriced: "UNKNOWN" | "QUANTITY_MISMATCH" } {
  const lots = valued?.accounts?.get(accountId);
  if (!lots || lots.grossValue === null) return { unpriced: "UNKNOWN" };
  if (Math.abs(lots.quantity - quantity) >= LOT_QUANTITY_TOLERANCE) {
    return { unpriced: "QUANTITY_MISMATCH" };
  }
  return { grossValue: lots.grossValue, lotQuantity: lots.quantity };
}

/**
 * The user's financial today (R17): the date in the timezone the user's
 * preferences name, the same rule the daily jobs bucket users by
 * (`getUsersByEffectiveTimezone`). Read on the caller's transaction.
 */
export async function financialTodayOf(
  m: EntityManager,
  userId: string,
): Promise<string> {
  const timezone = await getEffectiveTimezoneOfUser(m, userId);
  return (todayInTimezone(timezone) ?? todayInTimezone("UTC")) as string;
}

function decimalPlacesOf(figure: string | null): number {
  return figure === null ? 0 : (figure.split(".")[1]?.length ?? 0);
}

function summarize(
  row: InstrumentRow,
  termsProvider: string,
): BondInstrumentSummary {
  return {
    id: row.id,
    issuerCountryCode: row.issuer_country_code,
    issuerCode: row.issuer_code,
    programCode: row.program_code,
    seriesCode: row.series_code,
    currencyCode: row.currency_code,
    termsProvider,
  };
}

/**
 * Values one holding lot from stored reference data (spec 2.6, section 8). The
 * valuation is computed on read and not stored. Every query runs in one
 * `withScopedDb` transaction, one after another on its single connection.
 *
 * The bond tables are global reference data, so the caller's identity is only
 * what `withScopedDb` needs, never a filter.
 */
/**
 * An assumption about a benchmark that none of the held series reads would
 * change nothing and return figures that look like a scenario; refuse it
 * instead. With no series held there is nothing to refuse.
 */
function assertSomeSeriesReadsBenchmark(
  references: ReadonlyMap<string, BondReferenceData>,
  benchmarkId: string,
  programCode: string,
): void {
  if (references.size === 0) return;
  for (const { terms } of references.values()) {
    if (benchmarkFieldsOf(terms.rateRule)?.benchmarkId === benchmarkId) return;
  }
  throw new BondEngineError(
    "BENCHMARK_NOT_READ",
    { series: programCode, benchmarkId },
    `${programCode} does not read benchmark ${benchmarkId}`,
  );
}

/** The most decimals any of the series rounds money to (a total is exact to that). */
function placesOf(references: readonly BondReferenceData[]): number {
  return references.length === 0
    ? 2
    : references.reduce(
        (n, r) => Math.max(n, r.terms.rounding.moneyDecimals),
        0,
      );
}

@Injectable()
export class BondValuationService {
  constructor(private readonly dataSource: DataSource) {}

  async valueLot(request: ValueLotRequest): Promise<BondValuation> {
    return withScopedDb(this.dataSource, async (m) => {
      const named = `${request.issuerCountryCode} ${request.issuerCode} ${request.seriesCode}`;
      const instrument = await this.loadInstrument(m, request, named);
      const reference = await this.loadReferenceOf(
        m,
        instrument,
        request.termsVersion,
        named,
      );
      return this.valueLotFrom(
        reference,
        request.lot,
        request.asOf,
        request.projection,
      );
    });
  }

  /**
   * The reference data of the instrument with this id (the newest terms version
   * unless one is named). Runs on the caller's transaction, one query after
   * another; throws `BondDataNotFoundError` when the instrument or its terms are
   * not stored and `BondDataInconsistentError` when the rows contradict.
   */
  async loadReference(
    m: EntityManager,
    instrumentId: string,
    termsVersion?: number,
  ): Promise<BondReferenceData> {
    const rows: InstrumentRow[] = await m.query(
      `SELECT id, issuer_country_code, issuer_code, program_code, series_code, currency_code
         FROM bond_instruments
        WHERE id = $1`,
      [instrumentId],
    );
    if (rows.length === 0) {
      throw new BondDataNotFoundError(
        "INSTRUMENT_ID_NOT_FOUND",
        { id: instrumentId },
        `No bond instrument stored with id ${instrumentId}`,
      );
    }
    const named = `${rows[0].issuer_country_code} ${rows[0].issuer_code} ${rows[0].series_code}`;
    return this.loadReferenceOf(m, rows[0], termsVersion, named);
  }

  /**
   * The reference data of every series named, each loaded once, in the order
   * given. One query after another on the caller's transaction.
   */
  async loadReferences(
    m: EntityManager,
    instrumentIds: Iterable<string>,
  ): Promise<Map<string, BondReferenceData>> {
    const references = new Map<string, BondReferenceData>();
    for (const id of instrumentIds) {
      if (!references.has(id))
        references.set(id, await this.loadReference(m, id));
    }
    return references;
  }

  /**
   * The lots a user's program-linked security holds on `asOf`, each valued at
   * `asOf` by its own series' terms, with their totals (spec 12.5 and
   * `bond-program-securities.md` 2.4). Owner-scoped: another user's security and
   * an unlinked one are the same 404. One transaction; the reference data of
   * each series is read once however many lots there are.
   */
  async valueSecurity(
    userId: string,
    securityId: string,
    asOf: string,
    projection?: ReadonlyMap<string, string>,
  ): Promise<SecurityValuation> {
    return withScopedDb(this.dataSource, async (m) => {
      const ledger = await loadBondLedger(m, userId, securityId);
      const program = await this.loadProgram(m, ledger.security.bondProgramId);
      const base = {
        securityId,
        program,
        autoFetch: ledger.security.bondAutoFetch,
        asOf,
      };
      const folded = bondLotsAsOf(ledger.transactions, asOf);
      const heldIds = this.seriesIdsOf(
        folded.lots === null ? ledger.transactions : folded.lots,
      );
      const references = await this.loadReferences(m, heldIds);
      for (const id of projection?.keys() ?? []) {
        assertSomeSeriesReadsBenchmark(references, id, program.programCode);
      }
      const held = [...references.values()].sort((a, b) =>
        a.instrument.seriesCode < b.instrument.seriesCode ? -1 : 1,
      );
      const benchmarkCoverage: BenchmarkCoverage[] = [];
      for (const reference of held) {
        for (const coverage of await this.loadCoverage(m, reference.terms)) {
          if (
            !benchmarkCoverage.some(
              (c) => c.benchmarkId === coverage.benchmarkId,
            )
          ) {
            benchmarkCoverage.push(coverage);
          }
        }
      }
      // Per series, a refusal included: where a series' terms came from and
      // what it redeems at belong to the series, not to the derived lots.
      const needsMarketPrice = marketPriceRequired(held.map((r) => r.terms));
      const series = held.map((reference) => ({
        instrumentId: reference.instrument.id,
        seriesCode: reference.instrument.seriesCode,
        programCode: reference.instrument.programCode,
        termsSource: reference.terms.source,
        redemptionTerms:
          reference.terms.redemption.type === "ON_DEMAND"
            ? reference.terms.redemption
            : null,
      }));
      if (folded.lots === null) {
        return {
          ...base,
          lots: [],
          series,
          benchmarkCoverage,
          totals: {
            quantity: null,
            grossValue: null,
            earlyRedemptionValue: null,
            accruedInterest: null,
          },
          refusal: folded.refusal,
          marketPriceRequired: needsMarketPrice,
        };
      }

      const lots = folded.lots.map((lot) => ({
        ...lot,
        valuation: this.valueLotFrom(
          this.referenceOf(references, lot),
          lot,
          asOf,
          projection,
        ),
      }));
      const places = placesOf(held);
      const sum = (pick: (v: BondValuation) => string | null) =>
        sumKnown(
          lots.map((l) => pick(l.valuation)),
          places,
        );
      return {
        ...base,
        lots,
        series,
        benchmarkCoverage,
        totals: {
          quantity: lots.reduce((n, l) => n + l.quantity, 0),
          grossValue: sum((v) => v.grossValue),
          earlyRedemptionValue: sum((v) => v.earlyRedemptionValue),
          accruedInterest: sum((v) => v.accruedInterest),
        },
        refusal: null,
        marketPriceRequired: needsMarketPrice,
      };
    });
  }

  /**
   * What each account's lots of a program-linked security are worth on the
   * person's financial today (`bond-program-securities.md` 2.4, "A holding's
   * current value is its own lots' value"): one `valueSecurity` call, the lots
   * grouped by the account that holds them.
   *
   * An account's `grossValue` is the exact sum of its lots' gross values and is
   * null unless every one of its lots has one (a subtotal is not a total); a
   * REFUSED lot has none. `accounts` is null when the lots are unknowable
   * (`refusal`), so no account has a value. Lots without an account are keyed
   * `""`, like the fold. `date` is the day valued (the person's financial
   * today when omitted). Owner-scoped like `valueSecurity`.
   */
  async valueByAccount(
    userId: string,
    securityId: string,
    date?: string,
  ): Promise<SecurityValueByAccount> {
    return withScopedDb(this.dataSource, async (m) => {
      const asOf = date ?? (await financialTodayOf(m, userId));
      const valuation = await this.valueSecurity(userId, securityId, asOf);
      if (valuation.refusal !== null) return { asOf, accounts: null };
      const grouped = new Map<
        string,
        { quantity: number; figures: Array<string | null> }
      >();
      for (const lot of valuation.lots) {
        const key = lot.accountId ?? "";
        const entry = grouped.get(key) ?? { quantity: 0, figures: [] };
        entry.quantity += lot.quantity;
        entry.figures.push(
          lot.valuation.status === "REFUSED" ? null : lot.valuation.grossValue,
        );
        grouped.set(key, entry);
      }
      const accounts = new Map<string, AccountLotsValue>();
      for (const [key, { quantity, figures }] of grouped) {
        accounts.set(key, {
          quantity,
          grossValue: sumKnown(
            figures,
            figures.reduce((n, f) => Math.max(n, decimalPlacesOf(f)), 0),
          ),
        });
      }
      return { asOf, accounts };
    });
  }

  /**
   * The security's open lots as of `asOf`, valued once per assumed value of
   * `benchmarkId` and summed (spec 13.3). Owner-scoped like `valueSecurity`; the
   * reference data of each series is read once, every scenario is computed in
   * memory. A series that does not read the benchmark is valued unchanged in
   * every scenario; the request is refused only when none of the held series
   * reads it.
   */
  async scenariosOf(
    userId: string,
    securityId: string,
    benchmarkId: string,
    values: readonly string[],
    asOf: string,
  ): Promise<BondScenarios> {
    return withScopedDb(this.dataSource, async (m) => {
      const ledger = await loadBondLedger(m, userId, securityId);
      const program = await this.loadProgram(m, ledger.security.bondProgramId);
      const folded = bondLotsAsOf(ledger.transactions, asOf);
      const references = await this.loadReferences(
        m,
        this.seriesIdsOf(
          folded.lots === null ? ledger.transactions : folded.lots,
        ),
      );
      assertSomeSeriesReadsBenchmark(
        references,
        benchmarkId,
        program.programCode,
      );
      const base = { securityId, benchmarkId, asOf };
      if (folded.lots === null) {
        return {
          ...base,
          refusal: folded.refusal,
          scenarios: values.map(unknownScenario),
        };
      }
      const places = placesOf([...references.values()]);
      return {
        ...base,
        refusal: null,
        scenarios: values.map((value) =>
          scenarioOf(
            value,
            folded.lots.map((lot) => {
              const reference = this.referenceOf(references, lot);
              // Only a series that reads the benchmark takes the assumption;
              // the others are what they are.
              const reads =
                benchmarkFieldsOf(reference.terms.rateRule)?.benchmarkId ===
                benchmarkId;
              return this.valueLotFrom(
                reference,
                lot,
                asOf,
                reads ? new Map([[benchmarkId, value]]) : undefined,
              );
            }),
            places,
          ),
        ),
      };
    });
  }

  /** The distinct series ids rows or lots name, in first-appearance order. */
  private seriesIdsOf(
    rows: ReadonlyArray<{ readonly instrumentId?: string | null }>,
  ): string[] {
    return [
      ...new Set(
        rows
          .map((r) => r.instrumentId)
          .filter((id): id is string => typeof id === "string"),
      ),
    ];
  }

  /** The reference data of a lot's series; a lot with none cannot be valued. */
  private referenceOf(
    references: ReadonlyMap<string, BondReferenceData>,
    lot: { readonly instrumentId: string | null },
  ): BondReferenceData {
    const reference = lot.instrumentId
      ? references.get(lot.instrumentId)
      : null;
    if (!reference) {
      throw new BondDataNotFoundError(
        "INSTRUMENT_ID_NOT_FOUND",
        { id: lot.instrumentId ?? "" },
        `No bond series is named for a lot (${lot.instrumentId ?? "none"})`,
      );
    }
    return reference;
  }

  private async loadProgram(
    m: EntityManager,
    programId: string,
  ): Promise<BondProgramRef> {
    const rows: Array<{
      id: string;
      program_code: string;
      issuer_country_code: string;
      issuer_code: string;
      currency_code: string;
    }> = await m.query(
      `SELECT id, program_code, issuer_country_code, issuer_code, currency_code
         FROM bond_programs
        WHERE id = $1`,
      [programId],
    );
    if (rows.length === 0) {
      throw new BondDataNotFoundError(
        "INSTRUMENT_ID_NOT_FOUND",
        { id: programId },
        `No bond program stored with id ${programId}`,
      );
    }
    return {
      id: rows[0].id,
      programCode: rows[0].program_code,
      issuerCountryCode: rows[0].issuer_country_code,
      issuerCode: rows[0].issuer_code,
      currency: rows[0].currency_code,
    };
  }

  /** One lot at one date, from reference data already loaded. Pure. */
  valueLotFrom(
    reference: BondReferenceData,
    lot: {
      readonly purchaseDate: string;
      readonly quantity: number;
      readonly purchaseDateAssumed?: boolean;
      readonly cost?: string | null;
    },
    asOf: string,
    projection?: ReadonlyMap<string, string>,
  ): BondValuation {
    return valueBondLot({
      terms: reference.terms,
      termsVersion: reference.termsVersion,
      announcedRates: reference.announcedRates,
      benchmarks: reference.benchmarks,
      calendars: BOND_CALENDARS,
      lot: {
        purchaseDate: lot.purchaseDate,
        quantity: lot.quantity,
        purchaseDateAssumed: lot.purchaseDateAssumed,
        cost: lot.cost,
      },
      asOf,
      projection,
    });
  }

  /**
   * The split of the cash of redeeming one lot portion on `date` into returned
   * principal and interest, from reference data already loaded (the engine's
   * `redemptionSplit`, the same code a commit's figures come from). Pure.
   */
  redemptionSplitFrom(
    reference: BondReferenceData,
    lot: {
      readonly purchaseDate: string;
      readonly quantity: number;
      readonly purchaseDateAssumed?: boolean;
      readonly cost?: string | null;
    },
    date: string,
  ): RedemptionSplit {
    return redemptionSplit(
      {
        terms: reference.terms,
        termsVersion: reference.termsVersion,
        announcedRates: reference.announcedRates,
        benchmarks: reference.benchmarks,
        calendars: BOND_CALENDARS,
        lot: {
          purchaseDate: lot.purchaseDate,
          quantity: lot.quantity,
          purchaseDateAssumed: lot.purchaseDateAssumed,
          cost: lot.cost,
        },
      },
      date,
    );
  }

  private async loadReferenceOf(
    m: EntityManager,
    instrument: InstrumentRow,
    termsVersion: number | undefined,
    named: string,
  ): Promise<BondReferenceData> {
    const { version, terms } = await this.loadTerms(
      m,
      instrument,
      termsVersion,
      named,
    );
    this.assertConsistent(instrument, terms, named, version);
    const announcedRates = await this.loadAnnouncedRates(m, instrument.id);
    const benchmarks = await this.loadBenchmarks(m, terms);
    return {
      instrument: summarize(instrument, terms.source.provider),
      termsVersion: version,
      terms,
      announcedRates,
      benchmarks,
    };
  }

  private async loadInstrument(
    m: EntityManager,
    request: ValueLotRequest,
    named: string,
  ): Promise<InstrumentRow> {
    const rows: InstrumentRow[] = await m.query(
      `SELECT id, issuer_country_code, issuer_code, program_code, series_code, currency_code
         FROM bond_instruments
        WHERE issuer_country_code = $1 AND issuer_code = $2 AND series_code = $3`,
      [request.issuerCountryCode, request.issuerCode, request.seriesCode],
    );
    if (rows.length === 0) {
      throw new BondDataNotFoundError(
        "INSTRUMENT_NOT_FOUND",
        {
          country: request.issuerCountryCode,
          issuer: request.issuerCode,
          series: request.seriesCode,
        },
        `No bond instrument stored for ${named}`,
      );
    }
    return rows[0];
  }

  private async loadTerms(
    m: EntityManager,
    instrument: InstrumentRow,
    termsVersion: number | undefined,
    named: string,
  ): Promise<{ version: number; terms: BondTerms }> {
    const params: unknown[] = [instrument.id];
    let versionFilter = "";
    if (termsVersion !== undefined) {
      params.push(termsVersion);
      versionFilter = "AND version = $2";
    }
    const rows: Array<{ version: number; terms: unknown }> = await m.query(
      `SELECT version, terms
         FROM bond_terms_versions
        WHERE bond_instrument_id = $1 ${versionFilter}
        ORDER BY version DESC
        LIMIT 1`,
      params,
    );
    if (rows.length === 0) {
      const which =
        termsVersion === undefined
          ? "terms version"
          : `terms version ${termsVersion}`;
      const message = `No ${which} stored for ${named}`;
      throw termsVersion === undefined
        ? new BondDataNotFoundError(
            "TERMS_NOT_FOUND",
            { series: instrument.series_code },
            message,
          )
        : new BondDataNotFoundError(
            "TERMS_VERSION_NOT_FOUND",
            { series: instrument.series_code, version: String(termsVersion) },
            message,
          );
    }
    return {
      version: Number(rows[0].version),
      terms: parseBondTerms(rows[0].terms),
    };
  }

  private assertConsistent(
    instrument: InstrumentRow,
    terms: BondTerms,
    named: string,
    version: number,
  ): void {
    const claimed = terms.instrument;
    if (
      instrument.series_code !== claimed.seriesCode ||
      instrument.currency_code !== claimed.currency
    ) {
      throw new BondDataInconsistentError(
        "TERMS_MISMATCH",
        {
          series: instrument.series_code,
          version: String(version),
          claimedSeries: claimed.seriesCode,
          claimedCurrency: claimed.currency,
          storedSeries: instrument.series_code,
          storedCurrency: instrument.currency_code,
        },
        `Terms version ${version} of ${named} describe ${claimed.seriesCode} in ${claimed.currency}, ` +
          `but the instrument row is ${instrument.series_code} in ${instrument.currency_code}`,
      );
    }
  }

  private async loadAnnouncedRates(
    m: EntityManager,
    instrumentId: string,
  ): Promise<ReadonlyMap<number, string>> {
    const rows: Array<{ period_number: number; annual_rate: string }> =
      await m.query(
        `SELECT period_number, annual_rate::text AS annual_rate
           FROM bond_period_rates
          WHERE bond_instrument_id = $1`,
        [instrumentId],
      );
    return new Map(rows.map((r) => [Number(r.period_number), r.annual_rate]));
  }

  /** The coverage of the series the rate rule reads; none for a fixed rate. */
  private async loadCoverage(
    m: EntityManager,
    terms: BondTerms,
  ): Promise<BenchmarkCoverage[]> {
    const fields = benchmarkFieldsOf(terms.rateRule);
    if (fields === null) return [];
    const code = fields.benchmarkId;
    const rows: Array<{
      covered_through: string | null;
      updated_at: Date | string | null;
    }> = await m.query(
      `SELECT TO_CHAR(covered_through, 'YYYY-MM-DD') AS covered_through,
              updated_at
         FROM benchmark_series
        WHERE code = $1`,
      [code],
    );
    if (rows.length === 0) {
      return [{ benchmarkId: code, coveredThrough: null, lastFetchedAt: null }];
    }
    const updated = rows[0].updated_at;
    return [
      {
        benchmarkId: code,
        coveredThrough: rows[0].covered_through,
        lastFetchedAt: !updated ? null : new Date(updated).toISOString(),
      },
    ];
  }

  /** The series the rate rule reads; absent from the map when no row is stored. */
  private async loadBenchmarks(
    m: EntityManager,
    terms: BondTerms,
  ): Promise<ReadonlyMap<string, BenchmarkData>> {
    const benchmarks = new Map<string, BenchmarkData>();
    const fields = benchmarkFieldsOf(terms.rateRule);
    if (fields === null) return benchmarks;
    const code = fields.benchmarkId;

    const series: Array<{
      kind: "STEP" | "MONTHLY";
      publisher: string;
      covered_through: string | null;
    }> = await m.query(
      `SELECT kind, publisher, TO_CHAR(covered_through, 'YYYY-MM-DD') AS covered_through
         FROM benchmark_series
        WHERE code = $1`,
      [code],
    );
    if (series.length === 0) return benchmarks;

    const values: Array<{ observation_date: string; value: string }> =
      await m.query(
        `SELECT TO_CHAR(observation_date, 'YYYY-MM-DD') AS observation_date,
                value::text AS value
           FROM benchmark_values
          WHERE benchmark_code = $1
          ORDER BY observation_date`,
        [code],
      );
    const { kind, publisher, covered_through } = series[0];
    benchmarks.set(
      code,
      kind === "STEP"
        ? {
            kind,
            publisher,
            coveredThrough: covered_through,
            changes: values.map((v) => ({
              effectiveFrom: v.observation_date,
              value: v.value,
            })),
          }
        : {
            kind,
            publisher,
            // A monthly observation is stored on the first day of its month.
            values: new Map(
              values.map((v) => [v.observation_date.slice(0, 7), v.value]),
            ),
          },
    );
    return benchmarks;
  }
}

/** The exact sum of the figures, or null when any is unknown. Zero figures sum to zero. */
function sumKnown(
  figures: ReadonlyArray<string | null>,
  places: number,
): string | null {
  let total = ExactDecimal.ZERO;
  for (const figure of figures) {
    if (figure === null) return null;
    total = total.add(ExactDecimal.parse(figure));
  }
  return total.toFixed(places);
}
