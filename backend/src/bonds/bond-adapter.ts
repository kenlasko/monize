import { TrackedProviderId } from "../provider-health/providers";
import { BenchmarkUnit } from "./domain/benchmark";
import { CalendarRegistry } from "./domain/calendar-registry";

/** A benchmark series an adapter knows how to fetch and keep up to date. */
export interface BenchmarkSeriesDefinition {
  readonly code: string;
  readonly kind: "STEP" | "MONTHLY";
  readonly publisher: string;
  readonly sourceUrl: string;
  /**
   * The only hosts the fetch may talk to: exact host names, https, default
   * port. The door refuses any other address, including a redirect target
   * (`FetchPolicy` in `series-http.ts`); name every host the fetcher requests.
   */
  readonly hosts: readonly string[];
  /**
   * `RATE_FRACTION`: values are stored as fractions, 0.0575 for 5.75 percent.
   * `INDEX_LEVEL`: values are index levels as published, "335.123".
   */
  readonly unit: BenchmarkUnit;
  /** The outbound provider the fetch is gated and reported under. */
  readonly providerId: TrackedProviderId;
}

/**
 * A program (product) an adapter's templates cover, e.g. EDO. The boot seed
 * stores these rows only, so the security form can offer them; no series.
 */
export interface BondProgramDefinition {
  readonly issuerCountryCode: string;
  readonly issuerCode: string;
  readonly programCode: string;
  readonly currency: string;
  /**
   * The nominal of one bond of the program, from the adapter's product template
   * (an exact decimal string, "100.00"). The write-time check of a bond-linked
   * security's quantities reads it for a row that names, or can be given, no
   * stored series (INV-BOND-005); a stored series' own terms win when it has one.
   */
  readonly faceValue: string;
  /**
   * True when the program's securities trade and carry a coupon: a unit's price
   * is then the cash price of one unit of face value (excluding accrued
   * interest; inflation-adjusted for an indexed principal), which may sit far
   * from the face value, so the write-time price band is the wide one. Absent
   * means false (a retail or discount program: the price stays near par).
   */
  readonly cashPriced?: boolean;
  /**
   * True when the program's principal is indexed (rule `INDEX_RATIO`): the cash
   * price is then the inflation-adjusted price, the quoted real price times the
   * index ratio. Absent means false.
   */
  readonly indexedPrincipal?: boolean;
  /**
   * The issuer's own page describing the product, for a reader to follow; an
   * https address on the issuer's site, or absent when the adapter has none.
   */
  readonly infoUrl?: string;
}

/**
 * One terms document of a series (fetched or entered). A correction is a new `termsVersion`, never an
 * edit of an existing entry (INV-BOND-001).
 */
export interface CatalogEntry {
  readonly termsVersion: number;
  readonly publishedAt: string | null;
  /** The raw terms JSON; the catalog service parses and validates it. */
  readonly terms: unknown;
}

export interface BenchmarkObservation {
  readonly observationDate: string;
  /** In the series' unit (a fraction or an index level) as an exact decimal string, never a JSON number. */
  readonly value: string;
  readonly publishedOn: string | null;
  /**
   * The document this observation was read from, when it differs from the
   * result's `sourceUrl` (a feed assembled from more than one file).
   */
  readonly sourceUrl?: string;
}

export interface BenchmarkFetchResult {
  readonly observations: readonly BenchmarkObservation[];
  /** The source is authoritative for every day up to and including this date. */
  readonly coveredThrough: string;
  readonly sourceUrl: string;
}

/**
 * The only door the adapters have to the network. The caller gates it behind the
 * provider's circuit breaker and reads the whole body, so an adapter is a pure
 * function of what comes back and a test needs no socket.
 */
export type BondFetch = (url: string) => Promise<{
  status: number;
  body: Uint8Array;
  /**
   * The URL the body came from after any redirect, when the caller knows it. An
   * adapter that fetches only from its publisher's host refuses a different one.
   */
  url?: string;
}>;

export class BenchmarkFetchError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "BenchmarkFetchError";
  }
}

/** Where a piece of fetched terms came from (provider, document URL, fetch time). */
export interface SourceRef {
  readonly provider: string;
  readonly url: string;
  /** ISO-8601 instant the document was read. */
  readonly retrievedAt: string;
}

/** A series read from its official source, ready to go through the catalog. */
export interface FetchedSeries {
  readonly entry: CatalogEntry;
  readonly sources: readonly SourceRef[];
}

/**
 * The per-series values an administrator types when the official source cannot
 * be read: everything else comes from the adapter's product template. Decimals
 * are strings (a rate as a fraction, a fee as an amount), dates are YYYY-MM-DD.
 * `addend` is the margin or spread, absent for a fixed-rate product; `fee` is the
 * early redemption fee, absent for a product that charges none.
 */
export interface ManualSeriesValues {
  readonly firstPeriodRate: string;
  readonly addend: string | null;
  readonly fee: string | null;
  readonly saleWindow: { readonly from: string; readonly to: string };
  readonly letter: { readonly number: string; readonly date: string };
}

export type SeriesFetchErrorCode =
  | "SERIES_CODE_INVALID"
  | "SERIES_NOT_PUBLISHED"
  | "SOURCE_UNAVAILABLE"
  // A document of this series (its page or letter) answers a permanent 4xx: a
  // refusal of this series only, never a reason to stop a pass.
  | "SOURCE_DOCUMENT_MISSING"
  // An administrator's manual entry has a value that is not acceptable.
  | "MANUAL_ENTRY_INVALID"
  | "SOURCE_FORMAT_CHANGED"
  | "SOURCE_INCONSISTENT"
  | "TEMPLATE_NOT_VALIDATED"
  // The series is a product of the country this version cannot value yet (a
  // security the official source describes but no template covers).
  | "PRODUCT_NOT_SUPPORTED"
  // Raised by the service, never an adapter: the country has no fetch, or the
  // stored version 1 of the series differs from what was read.
  | "SERIES_FETCH_UNSUPPORTED"
  | "SERIES_TERMS_CONFLICT";

/**
 * A refused series fetch or manual entry. `params` carries short machine values
 * (a field name, two compared values) for the translated message; it never holds
 * free text from the source.
 */
export class SeriesFetchError extends Error {
  constructor(
    readonly code: SeriesFetchErrorCode,
    readonly params: Readonly<Record<string, string>> = {},
    options?: { readonly cause?: unknown },
  ) {
    super(
      `${code} ${Object.entries(params)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")}`.trim(),
      options,
    );
    this.name = "SeriesFetchError";
  }
}

/**
 * A transient failure of an issuer's source (`SOURCE_UNAVAILABLE`): `reason` is
 * a short machine value, never free text from the source. Shared by every
 * adapter's single-host GET.
 */
export function sourceUnavailable(
  reason: string,
  extra: Record<string, string> = {},
  cause?: unknown,
): SeriesFetchError {
  return new SeriesFetchError(
    "SOURCE_UNAVAILABLE",
    { reason, ...extra },
    { cause },
  );
}

/**
 * One auction the official source lists for a program, for a person choosing
 * which series a purchase was: nothing here is stored, and the series is read
 * through `fetchSeries(seriesCode)` once chosen. Dates are YYYY-MM-DD; a rate
 * or a price is the source's own decimal text, null until the auction is held.
 */
export interface AuctionListing {
  /** The code `fetchSeries` takes for the series this auction sold. */
  readonly seriesCode: string;
  /** The security's identifier as its market writes it (a CUSIP, an ISIN). */
  readonly identifier: string;
  /** The source's own name for the term ("13-Week", "10-Year"). */
  readonly term: string;
  readonly auctionDate: string;
  readonly issueDate: string;
  readonly maturityDate: string;
  /** More of an outstanding series: the terms are the original issue's. */
  readonly reopening: boolean;
  /** Announced and not yet held: no rate and no price. */
  readonly announced: boolean;
  /** What `ratePercent` is: a discount rate, a coupon, or a spread over an index. */
  readonly rateKind: "DISCOUNT" | "COUPON" | "SPREAD";
  readonly ratePercent: string | null;
  /** The auction price per 100 of face value. */
  readonly pricePer100: string | null;
}

/** Everything one country contributes: calendars, benchmarks, programs, series sources. */
export interface BondAdapter {
  readonly countryCode: string;
  /**
   * The repo-relative path of the country's spec under `docs/specs/`. A country
   * is not installed without it: `adapter-docs.guard.spec.ts` requires that it
   * exists and names every program code, every benchmark code, the country code
   * and an official https source (`docs/backend/bond-adapters.md` section 5).
   */
  readonly specDoc: string;
  /**
   * IANA zone of the market's publishers. The adapter's own calendar day decides
   * whether one of its series is fresh (`BenchmarkRefreshService`).
   */
  readonly timezone: string;
  registerCalendars(registry: CalendarRegistry): CalendarRegistry;
  readonly benchmarks: readonly BenchmarkSeriesDefinition[];
  /** The programs the adapter's product templates cover; no series (spec bond-program-securities.md 2.6). */
  readonly programs: readonly BondProgramDefinition[];
  fetchBenchmark(code: string, fetch: BondFetch): Promise<BenchmarkFetchResult>;
  /**
   * Reads one series' terms from the market's official source. Absent when the
   * adapter cannot; the caller then refuses the request.
   */
  fetchSeries?(seriesCode: string, fetch: BondFetch): Promise<FetchedSeries>;
  /** The same entry built from an administrator's values on the same template. */
  manualSeries?(seriesCode: string, values: ManualSeriesValues): CatalogEntry;
  /**
   * The outbound provider `fetchSeries` and `currentSeries` are gated and
   * reported under. Present whenever either is.
   */
  readonly seriesProviderId?: TrackedProviderId;
  /**
   * The series codes the market's official source lists as on sale now, for the
   * daily check that stores the ones the catalog lacks.
   */
  currentSeries?(fetch: BondFetch): Promise<string[]>;
  /**
   * Every series code the adapter's product templates cover, from the earliest
   * sale month they are validated for up to the month of `today` (YYYY-MM-DD,
   * the market's own day), oldest sale month first: the candidates of the
   * one-off backfill. Most are stored already; the caller asks the catalog.
   */
  backfillCodes?(today: string): string[];
  /**
   * The program (product) code a series code belongs to (`EDO` for `EDO1036`),
   * or null when it is not a code of this adapter. Lets the daily check fetch
   * only the programs a person has switched auto-fetch on for.
   */
  programOf?(seriesCode: string): string | null;
  /**
   * The code of the series of `programCode` sold on `saleDate` (YYYY-MM-DD, a
   * valid calendar date), or null when the adapter cannot name one (not its
   * program, or a code that does not follow from the date). Lets a purchase
   * form offer "Fetch <code>" without a client knowing the country's grammar.
   */
  seriesCodeFor?(programCode: string, saleDate: string): string | null;
  /**
   * The auctions of `programCode` the official source lists with an issue date
   * within a month of `date` (YYYY-MM-DD), nearest first: for a market that
   * sells by auction rather than in monthly sale windows, so a purchase form can
   * show which series were (or will be) issued around the trade date. Read
   * only when a person asks (INV-BOND-008); nothing is stored. Gated under
   * `seriesProviderId`.
   */
  auctionsNear?(
    programCode: string,
    date: string,
    fetch: BondFetch,
  ): Promise<AuctionListing[]>;
  /**
   * The earliest sale month (`YYYY-MM`) the adapter's templates are validated
   * for, the lower bound of its series history.
   */
  readonly seriesValidFrom?: string;
}
