import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import {
  annualizedReturn,
  annualizedReturnOverDays,
} from "./domain/annualized-return";
import { INSTALLED_BOND_ADAPTERS } from "./bond-adapters";
import { benchmarkReadsOf } from "./domain/benchmark-reads";
import {
  benchmarkFieldsOf,
  BondTerms,
  parseBondTerms,
  Redemption,
  scheduleDaysOf,
  scheduleMonthsOf,
} from "./domain/bond-terms";
import { enumerateMonthKeys } from "./domain/calendar-date";
import { ExactDecimal } from "./domain/exact-decimal";
import {
  BondReferenceData,
  BondTermsSource,
  BondValuationService,
  financialTodayOf,
} from "./bond-valuation.service";
import {
  BondValuation,
  ProjectionAssumption,
  RateRuleDescription,
} from "./engine/bond-engine";

/** What one bond bought today and held to maturity is worth (spec bond-offer-and-history 2). */
export interface BondOfferProjection {
  /**
   * Everything one bond bought today and held to maturity pays, coupons of a
   * coupon bond included and not reinvested; null when any amount is unknown.
   */
  readonly maturityValue: string | null;
  /** (cash received - price paid) / price paid, 4 places; the price is the face value, or the issue price of a discount bill; null with the cash. */
  readonly totalReturn: string | null;
  /** The yearly rate r with (1 + r)^years = cash / face, 4 places; a comparison figure. */
  readonly annualizedReturn: string | null;
  /** True when any period's rate is assumed rather than known. */
  readonly projected: boolean;
  readonly assumptions: readonly ProjectionAssumption[];
  /** A benchmark a future period needs that has neither an observation nor an assumption. */
  readonly projectionMissing: ReadonlyArray<{
    readonly benchmarkId: string;
    readonly publisher: string | null;
  }>;
}

export interface BondOfferSeries {
  readonly instrumentId: string;
  readonly issuerCountryCode: string;
  readonly issuerCode: string;
  readonly programCode: string;
  readonly seriesCode: string;
  readonly currency: string;
  readonly saleWindow: { readonly from: string; readonly to: string };
  readonly periodMonths: number;
  readonly periodCount: number;
  /**
   * The exact length in days of a single issue-to-maturity period (a discount
   * bill: 28 for four weeks), null for a schedule counted in months. When set it
   * is the length the projection's `annualizedReturn` uses; `periodMonths` stays
   * the whole months (at least 1) for display.
   */
  readonly lengthDays: number | null;
  readonly rateRule: RateRuleDescription;
  readonly capitalization: BondTerms["capitalization"]["type"];
  /** The terms' redemption policy; null when redeemable at maturity only. */
  readonly redemption: Redemption | null;
  readonly termsSource: BondTermsSource;
  readonly projection: BondOfferProjection;
}

export interface BondOffer {
  readonly countryCode: string;
  /** The user's financial today, the day the sale windows and the projections are read at. */
  readonly today: string;
  readonly series: readonly BondOfferSeries[];
}

/** One stored series of a program, newest terms version (spec bond-offer-and-history 3). */
export interface BondHistorySeries {
  readonly seriesCode: string;
  readonly saleWindow: { readonly from: string; readonly to: string } | null;
  /** The first period's rate; the annual rate of a fixed-rate series. */
  readonly firstPeriodRate: string | null;
  readonly annualRate: string | null;
  /** The margin or spread added to the benchmark, null for a fixed rate. */
  readonly addend: string | null;
  /** The early redemption fee per bond, null when the series charges none. */
  readonly fee: string | null;
  /** Where the proceeds floor applies, null when there is none. */
  readonly proceedsFloor: "ALL_PERIODS" | "FIRST_PERIOD" | null;
  readonly termsVersion: number;
  readonly termsSource: BondTermsSource;
}

/** The months of a program's history the catalog does not hold. */
export interface BondHistoryCoverage {
  readonly from: string | null;
  readonly to: string | null;
  readonly missingMonths: readonly string[];
}

export interface BondProgramHistory {
  readonly programCode: string;
  readonly series: readonly BondHistorySeries[];
  readonly coverage: BondHistoryCoverage;
}

export interface BondHistory {
  readonly countryCode: string;
  readonly programs: readonly BondProgramHistory[];
}

interface HistoryRow {
  program_code: string;
  version: number;
  terms: unknown;
}

/**
 * The series on sale today and the history of the terms, read from stored
 * reference data and the engine; nothing is written and nothing is fetched on
 * the request path (`docs/specs/bond-offer-and-history.md`).
 *
 * The projection of a series is the engine's own `valueBondLot` on one bond
 * bought today, through the same loading and the same assumption rules as the
 * valuation and the scenarios (`BondValuationService.loadReference` and
 * `valueLotFrom`), so the comparison table and a portfolio's valuation cannot
 * disagree. The bond tables are global reference data: `userId` only names the
 * timezone of "today".
 */
@Injectable()
export class BondOfferService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly valuation: BondValuationService,
  ) {}

  /**
   * Every instrument of the country whose newest terms version's sale window
   * contains the user's financial today, each projected to maturity. An
   * assumption applies to the series that read its benchmark and to no other.
   */
  async offer(
    userId: string,
    countryCode: string,
    assume?: ReadonlyMap<string, string>,
  ): Promise<BondOffer> {
    const country = countryCode.toUpperCase();
    return withScopedDb(this.dataSource, async (m) => {
      const today = await financialTodayOf(m, userId);
      const ids = await this.idsOnSale(m, country, today);
      const series: BondOfferSeries[] = [];
      for (const id of ids) {
        const reference = await this.valuation.loadReference(m, id);
        series.push(this.seriesOf(reference, today, assume));
      }
      return { countryCode: country, today, series };
    });
  }

  /**
   * Every stored series of the country, by program (one program when named),
   * ordered by the start of the sale window, with the months the catalog lacks.
   */
  async history(
    countryCode: string,
    programCode?: string,
  ): Promise<BondHistory> {
    const country = countryCode.toUpperCase();
    const rows = await withScopedDb(this.dataSource, (m) =>
      this.newestTerms(m, country, programCode),
    );
    const validFrom = INSTALLED_BOND_ADAPTERS.find(
      (a) => a.countryCode === country,
    )?.seriesValidFrom;

    const byProgram = new Map<string, BondHistorySeries[]>();
    for (const row of rows) {
      const list = byProgram.get(row.program_code) ?? [];
      list.push(
        historySeriesOf(Number(row.version), parseBondTerms(row.terms)),
      );
      byProgram.set(row.program_code, list);
    }
    const programs = [...byProgram.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([program, list]) => {
        const series = [...list].sort(compareSeries);
        return {
          programCode: program,
          series,
          coverage: coverageOf(series, validFrom),
        };
      });
    return { countryCode: country, programs };
  }

  /**
   * The instruments whose newest terms version has a sale window containing
   * `today`. A terms version without a window is no restriction on a purchase
   * but is not an offer either, so it is left out. ISO dates compare as text.
   */
  private async idsOnSale(
    m: EntityManager,
    country: string,
    today: string,
  ): Promise<string[]> {
    const rows: Array<{ id: string }> = await m.query(
      `SELECT i.id
         FROM bond_instruments i
         JOIN LATERAL (SELECT v.terms
                         FROM bond_terms_versions v
                        WHERE v.bond_instrument_id = i.id
                        ORDER BY v.version DESC
                        LIMIT 1) newest ON TRUE
        WHERE i.issuer_country_code = $1
          AND newest.terms->'saleWindow'->>'from' <= $2
          AND newest.terms->'saleWindow'->>'to' >= $2
        ORDER BY i.issuer_code, i.series_code`,
      [country, today],
    );
    return rows.map((row) => row.id);
  }

  private async newestTerms(
    m: EntityManager,
    country: string,
    programCode: string | undefined,
  ): Promise<HistoryRow[]> {
    const params: unknown[] = [country];
    let programFilter = "";
    if (programCode !== undefined) {
      params.push(programCode);
      programFilter = "AND i.program_code = $2";
    }
    return m.query(
      `SELECT i.program_code, newest.version, newest.terms
         FROM bond_instruments i
         JOIN LATERAL (SELECT v.version, v.terms
                         FROM bond_terms_versions v
                        WHERE v.bond_instrument_id = i.id
                        ORDER BY v.version DESC
                        LIMIT 1) newest ON TRUE
        WHERE i.issuer_country_code = $1 ${programFilter}
        ORDER BY i.program_code, i.series_code`,
      params,
    );
  }

  /** One series: its terms as stated and the engine's valuation of one bond bought today. Pure. */
  private seriesOf(
    reference: BondReferenceData,
    today: string,
    assume: ReadonlyMap<string, string> | undefined,
  ): BondOfferSeries {
    const { terms, instrument } = reference;
    const valuation = this.valuation.valueLotFrom(
      reference,
      { purchaseDate: today, quantity: 1 },
      today,
      assumptionsFor(terms, assume),
    );
    return {
      instrumentId: instrument.id,
      issuerCountryCode: instrument.issuerCountryCode,
      issuerCode: instrument.issuerCode,
      programCode: instrument.programCode,
      seriesCode: instrument.seriesCode,
      currency: instrument.currencyCode,
      // The id query admitted the series by this window.
      saleWindow: terms.saleWindow as { from: string; to: string },
      ...scheduleMonthsOf(terms.schedule),
      lengthDays: scheduleDaysOf(terms.schedule),
      rateRule: valuation.rateRule,
      capitalization: terms.capitalization.type,
      redemption:
        terms.redemption.type === "ON_DEMAND" ? terms.redemption : null,
      termsSource: terms.source,
      projection: projectionOf(terms, valuation),
    };
  }
}

/** The assumptions for the benchmarks the series reads; none for a fixed rate and principal, and none for a benchmark it does not read. */
function assumptionsFor(
  terms: BondTerms,
  assume: ReadonlyMap<string, string> | undefined,
): ReadonlyMap<string, string> | undefined {
  const read = new Map<string, string>();
  for (const { benchmarkId } of benchmarkReadsOf(terms)) {
    const value = assume?.get(benchmarkId);
    if (value !== undefined) read.set(benchmarkId, value);
  }
  return read.size === 0 ? undefined : read;
}

/**
 * Everything the lot pays, from its cash flows: a compounding bond's single
 * payment at maturity, or a coupon bond's every coupon plus the face value,
 * known and projected alike. Null when the lot has no flow or any amount is
 * unknown (a rate it needs is neither stored nor assumed).
 */
function cashReceived(valuation: BondValuation): ExactDecimal | null {
  const flows = [...valuation.knownCashflows, ...valuation.projectedCashflows];
  if (flows.length === 0) return null;
  let total = ExactDecimal.ZERO;
  for (const flow of flows) {
    if (flow.amount === null) return null;
    total = total.add(ExactDecimal.parse(flow.amount));
  }
  return total;
}

function projectionOf(
  terms: BondTerms,
  valuation: BondValuation,
): BondOfferProjection {
  const base = {
    projected: valuation.rateSchedule.some((e) => e.rateSource === "PROJECTED"),
    assumptions: valuation.projectionAssumptions,
    projectionMissing: valuation.projectionMissing,
  };
  const cash = cashReceived(valuation);
  if (cash === null) {
    return {
      ...base,
      maturityValue: null,
      totalReturn: null,
      annualizedReturn: null,
    };
  }
  // What one bond costs today: the issue price of a discount bill (it pays the
  // face value at maturity), the face value of every other product.
  const face = ExactDecimal.parse(
    terms.instrument.issuePrice ?? terms.instrument.faceValue,
  );
  const length = scheduleMonthsOf(terms.schedule);
  const months = length.periodMonths * length.periodCount;
  const days = scheduleDaysOf(terms.schedule);
  const positiveFace = face.cmp(ExactDecimal.ZERO) > 0;
  return {
    ...base,
    maturityValue: cash.toFixed(terms.rounding.moneyDecimals),
    totalReturn: positiveFace ? cash.sub(face).div(face).toFixed(4) : null,
    // A single issue-to-maturity period is measured in actual days over 365; a
    // month schedule in months over 12.
    annualizedReturn:
      days === null
        ? annualizedReturn(cash, face, months)
        : days < 1
          ? null
          : annualizedReturnOverDays(cash, face, days),
  };
}

function historySeriesOf(version: number, terms: BondTerms): BondHistorySeries {
  const rule = terms.rateRule;
  const fields = benchmarkFieldsOf(rule);
  const penalties =
    terms.redemption.type === "ON_DEMAND" ? terms.redemption.penalties : [];
  const fee = penalties.find((p) => p.type === "FIXED_FEE_PER_UNIT");
  const floor =
    terms.redemption.type === "ON_DEMAND"
      ? terms.redemption.proceedsFloor
      : null;
  return {
    seriesCode: terms.instrument.seriesCode,
    saleWindow: terms.saleWindow,
    firstPeriodRate: fields === null ? null : fields.firstPeriodRate,
    annualRate: rule.type === "FIXED" ? rule.annualRate : null,
    addend:
      rule.type === "BENCHMARK_PLUS_SPREAD"
        ? rule.spread
        : rule.type === "INFLATION_PLUS_MARGIN_AS_RATE"
          ? rule.margin
          : null,
    fee: fee?.type === "FIXED_FEE_PER_UNIT" ? fee.amount : null,
    proceedsFloor: floor === null ? null : floor.appliesTo,
    termsVersion: version,
    termsSource: terms.source,
  };
}

/** By the start of the sale window (a series without one last), then by code. */
function compareSeries(a: BondHistorySeries, b: BondHistorySeries): number {
  const left = a.saleWindow?.from ?? "9999-99-99";
  const right = b.saleWindow?.from ?? "9999-99-99";
  if (left !== right) return left < right ? -1 : 1;
  return a.seriesCode < b.seriesCode ? -1 : a.seriesCode > b.seriesCode ? 1 : 0;
}

/**
 * The months the stored series cover: from the earlier of the adapter's first
 * validated month and the earliest stored sale month, to the latest stored
 * one, and each month in between that no stored series was sold in. A program
 * with no dated series has no coverage to speak of.
 */
function coverageOf(
  series: readonly BondHistorySeries[],
  validFrom: string | undefined,
): BondHistoryCoverage {
  const stored = new Set(
    series.flatMap((s) =>
      s.saleWindow ? [s.saleWindow.from.slice(0, 7)] : [],
    ),
  );
  if (stored.size === 0) return { from: null, to: null, missingMonths: [] };
  const months = [...stored].sort();
  const earliest = months[0];
  const latest = months[months.length - 1];
  const from =
    validFrom !== undefined && validFrom < earliest ? validFrom : earliest;
  return {
    from,
    to: latest,
    missingMonths: enumerateMonthKeys(from, latest).filter(
      (month) => !stored.has(month),
    ),
  };
}
