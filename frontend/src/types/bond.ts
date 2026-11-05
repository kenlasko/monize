/**
 * Bond API shapes. They mirror the backend exactly
 * (`backend/src/bonds/bond-valuation.service.ts`,
 * `backend/src/bonds/engine/bond-engine-types.ts`, `backend/src/bonds/bond-lots.ts`).
 *
 * Money and rate fields are decimal STRINGS (a rate is a fraction, "0.0440" is
 * 4.40%) or null. Null means unknown, never zero: it is converted to a number
 * only at the formatting boundary, and only when it is not null.
 */

/** A catalog instrument a security can be linked to (`GET /bonds/instruments`). */
export interface BondInstrumentSummary {
  id: string;
  issuerCountryCode: string;
  issuerCode: string;
  programCode: string;
  seriesCode: string;
  currencyCode: string;
  /** Where the terms came from: "curated", "obligacjeskarbowe.pl" or "manual". */
  termsProvider: string;
  /** The newest terms' sale window (YYYY-MM-DD both ends); null when the terms state none. */
  saleWindow: { from: string; to: string } | null;
}

/** One program of the catalog (`GET /bonds/programs`): the product a security is linked to, e.g. EDO. */
export interface BondProgramSummary {
  id: string;
  issuerCountryCode: string;
  issuerCode: string;
  programCode: string;
  currency: string;
  /** How many series of the program the catalog stores. */
  seriesCount: number;
  /** The newest stored series' code; null when the program has no series. */
  newestSeriesCode: string | null;
  /** The issuer's page describing the bond kind; null when the adapter has none. */
  infoUrl?: string | null;
  /** The nominal of one bond of the program, an exact decimal string; null when no adapter states it. */
  faceValue?: string | null;
  /** True when a unit's price is the cash price of one unit of face value (a marketable coupon program). */
  cashPriced?: boolean;
  /** True when the principal is indexed: the price then includes the inflation adjustment. */
  indexedPrincipal?: boolean;
}

/** `POST /bonds/instruments/fetch` body. */
export interface FetchBondSeriesRequest {
  countryCode: string;
  seriesCode: string;
}

/** `POST /bonds/instruments/fetch` response; `created` is false when it was already stored. */
export interface FetchBondSeriesResult extends BondInstrumentSummary {
  created: boolean;
}

/** The document the stored terms were read from. */
export interface BondTermsSource {
  provider: string;
  url: string;
  document: string;
}

export type BondRateSource = 'TERMS' | 'ANNOUNCED' | 'DERIVED' | 'PROJECTED';

export type BondEarlyRedemptionRefusal =
  | 'NOT_REDEEMABLE'
  | 'TOO_EARLY'
  | 'TOO_LATE'
  | 'RECORD_DAY'
  | 'MATURED'
  | 'RATE_UNKNOWN'
  | 'TERMS_INCOMPLETE';

export interface BondCashFlow {
  /** The day the money is paid: the period end, or the next business day when the schedule adjusts payments. */
  date: string;
  /** The unadjusted period end interest accrued to; absent when the payment is not adjusted (it is then `date`). */
  accrualEndDate?: string;
  type: 'INTEREST' | 'PRINCIPAL';
  /** The whole lot; null only when `status` is UNKNOWN (the rate is not known yet). */
  amount: string | null;
  status: 'KNOWN' | 'PROJECTED' | 'UNKNOWN';
  period: number;
}

export interface BondMissingObservation {
  benchmarkId: string;
  /** `YYYY-MM` for a monthly series, the observation day for a step series. */
  observation: string;
  /** Null when the benchmark itself is not stored. */
  publisher: string | null;
}

/** A benchmark value assumed for every period that has not started. */
export interface BondProjectionAssumption {
  benchmarkId: string;
  /** The assumed value as a fraction, e.g. "0.0290". */
  value: string;
  basis: 'SUPPLIED' | 'LATEST_OBSERVATION';
  /** The YYYY-MM-DD or YYYY-MM the value came from; null when SUPPLIED. */
  observation: string | null;
  /** Present for an assumed annual inflation of an indexed principal: later months grow by value x months / 12, not compounded. */
  growth?: 'SIMPLE_ANNUAL';
}

export interface BondCurrentPeriod {
  index: number;
  start: string;
  end: string;
  /** A fraction: "0.0440" is 4.40%; null when the period's rate is not known. */
  annualRate: string | null;
  rateSource: BondRateSource | null;
}

/** The terms' rate rule as stated; every rate is a fraction string. */
export interface BondRateRule {
  type:
    | 'FIXED'
    | 'BENCHMARK_PLUS_SPREAD'
    | 'INFLATION_PLUS_MARGIN_AS_RATE'
    | 'ZERO_COUPON_DISCOUNT'
    | 'DAILY_INDEX_PLUS_SPREAD';
  benchmarkId: string | null;
  /** FIXED only. */
  annualRate: string | null;
  firstPeriodRate: string | null;
  /** The margin or spread. */
  addend: string | null;
  benchmarkFloor: string | null;
  /** DAILY_INDEX_PLUS_SPREAD only: business days before a period end whose auctions are not used. */
  lockoutBusinessDays?: number;
}

export interface BondRateScheduleBenchmark {
  benchmarkId: string;
  /** The YYYY-MM-DD or YYYY-MM key the observation rule computed. */
  observation: string;
  /** Observed (or assumed, when PROJECTED); null when not published. */
  value: string | null;
  /** After the benchmark floor; null when `value` is null. */
  flooredValue: string | null;
}

/** A run of days of a floating period that share an index, or share having none; `to` is exclusive. */
export interface BondDailyRateRun {
  from: string;
  to: string;
  /** A fraction; null for a run of days with no index (not stored, none assumed), with `rate` and `dailyAccrual`. */
  index: string | null;
  rate: string | null;
  dailyAccrual: string | null;
  projected: boolean;
}

/** One period of a lot; `benchmark` is null for a TERMS or ANNOUNCED period. */
export interface BondRateScheduleEntry {
  index: number;
  start: string;
  end: string;
  annualRate: string | null;
  rateSource: BondRateSource | null;
  benchmark: BondRateScheduleBenchmark | null;
  addend: string | null;
  /**
   * Interest of the period PER BOND (spec 13.2), 10 decimal places, split by the
   * components of the rate. All five are null when the period's rate, or any
   * earlier rate of a compounding bond, is unknown; a part that does not apply
   * is "0". Multiply by the lot quantity for the holding.
   */
  interest: string | null;
  fixedPart: string | null;
  benchmarkPart: string | null;
  addendPart: string | null;
  announcedPart: string | null;
  /** A floating period (annualRate null): the days with an index, in runs. */
  dailyRates?: BondDailyRateRun[];
}

export type BondLotStatus = 'OPEN' | 'MATURED' | 'REFUSED';

/** Why a lot has no valuation; rendered from `code` and `params`. */
export type BondValuationRefusal =
  | {
      code: 'PURCHASE_OUTSIDE_SALE_WINDOW';
      params: { from: string; to: string; purchaseDate: string };
    }
  /** A lot of a marketable series bought on or after its maturity. */
  | {
      code: 'PURCHASE_AFTER_MATURITY';
      params: { maturityDate: string; purchaseDate: string };
    };

/** A benchmark with neither an observation nor an assumption to project from. */
export interface BondProjectionMissing {
  benchmarkId: string;
  publisher: string | null;
}

export interface BondValuation {
  asOf: string;
  status: BondLotStatus;
  refusal: BondValuationRefusal | null;
  seriesCode: string;
  termsVersion: number;
  quantity: number;
  maturityDate: string;
  currentPeriod: BondCurrentPeriod | null;
  rateRule: BondRateRule;
  /** One entry per period of the lot. */
  rateSchedule: BondRateScheduleEntry[];
  /** Per bond: the base of the current period. */
  principal: string | null;
  /** Where a discount instrument's principal comes from; null for any other instrument. */
  principalBasis?: "LOT_COST" | "ISSUE_PRICE" | null;
  /** Lot. */
  accruedInterest: string | null;
  /** Lot, before any early redemption penalty. */
  grossValue: string | null;
  earlyRedemptionValue: string | null;
  earlyRedemptionRefusal: BondEarlyRedemptionRefusal | null;
  knownCashflows: BondCashFlow[];
  projectedCashflows: BondCashFlow[];
  maturityValueKnown: string | null;
  maturityValueProjected: string | null;
  projectionAssumptions: BondProjectionAssumption[];
  dataCompleteness: {
    termsComplete: boolean;
    referenceDataComplete: boolean;
    earlyRedemptionTermsComplete: boolean;
  };
  missing: BondMissingObservation[];
  /** Benchmarks no future period can be projected from. */
  projectionMissing: BondProjectionMissing[];
  valuationComplete: boolean;
  /**
   * Every cash flow on the earliest date after `asOf`, UNKNOWN ones included,
   * interest first; empty when the lot is matured or refused.
   */
  nextPayment: BondCashFlow[];
  /** Start of the next period when the rate reads a benchmark and one exists; null otherwise. */
  nextRateReset: string | null;
  /** End of the current period when the bond compounds and it is not the last; null otherwise. */
  nextCapitalization: string | null;
}

export interface BondLotValuation {
  /** The series (`GET /bonds/instruments` id) the lot belongs to. */
  instrumentId: string;
  purchaseDate: string;
  quantity: number;
  /** A transfer in with no linked leg: the real purchase date is unknown. */
  purchaseDateAssumed: boolean;
  /** What the lot cost, net of accrued interest, as exact text; null when unknown. */
  cost?: string | null;
  valuation: BondValuation;
}

/** Each total is null unless every lot has the figure. */
export interface BondValuationTotals {
  quantity: number | null;
  grossValue: string | null;
  earlyRedemptionValue: string | null;
  accruedInterest: string | null;
}

export type BondLotsRefusalCode =
  | 'SPLIT'
  | 'FRACTIONAL_QUANTITY'
  | 'OVER_REMOVAL'
  | 'INVALID_QUANTITY'
  | 'REMOVAL_EXCEEDS_SERIES'
  | 'SERIES_NOT_DETERMINED';

/**
 * The refusal is rendered from `code` and `params` through translated keys.
 * `detail` is server-composed English for logs and is never shown.
 */
export interface BondLotsRefusal {
  code: BondLotsRefusalCode;
  detail: string;
  params: {
    /** The transaction action enum of the offending row, e.g. "SELL". */
    action: string;
    /** YYYY-MM-DD. */
    date: string;
    /** A decimal string, or null when the row has no quantity. */
    quantity: string | null;
  };
}

/** How fresh a benchmark's stored data is. */
export interface BondBenchmarkCoverage {
  benchmarkId: string;
  /** YYYY-MM-DD, or null when nothing is stored. */
  coveredThrough: string | null;
  lastFetchedAt: string | null;
}

export type BondRedemptionPenalty =
  | { type: 'FIXED_FEE_PER_UNIT'; /** Per bond, a decimal string. */ amount: string }
  | { type: 'FORFEIT_ACCRUED_SINCE_LAST_PAYMENT' };

export interface BondRedemptionBlackout {
  type: 'RECORD_DAY_BEFORE_COUPON';
  businessDays: number;
  calendarId: string;
}

/** The terms' redemption policy; `GET .../valuation` sends null for a maturity-only bond. */
export interface BondRedemptionTerms {
  type: 'ON_DEMAND';
  earliestDaysAfterPurchase: number;
  latestDaysBeforeMaturity: number;
  blackouts: BondRedemptionBlackout[];
  penalties: BondRedemptionPenalty[];
  /** Null when the proceeds are not floored. */
  proceedsFloor: {
    type: 'FACE_VALUE';
    appliesTo: 'ALL_PERIODS' | 'FIRST_PERIOD';
  } | null;
}

/** The reference data of one series a security's lots name. */
export interface SecurityBondSeries {
  instrumentId: string;
  seriesCode: string;
  programCode: string;
  /** Absent in an older payload. */
  termsSource?: BondTermsSource;
  /** Null for a series redeemable at maturity only. */
  redemptionTerms: BondRedemptionTerms | null;
}

/** The program a security is linked to, as the valuation names it. */
export interface SecurityBondProgram {
  id: string;
  programCode: string;
  issuerCountryCode: string;
  issuerCode: string;
  currency: string;
}

/** `GET /bonds/securities/:securityId/valuation`. */
export interface SecurityBondValuation {
  securityId: string;
  program: SecurityBondProgram;
  /** Whether new series of the program are fetched automatically. */
  autoFetch: boolean;
  asOf: string;
  /** Each lot names its series by `instrumentId`. */
  lots: BondLotValuation[];
  /** One entry per series the lots name. */
  series: SecurityBondSeries[];
  totals: BondValuationTotals;
  refusal: BondLotsRefusal | null;
  benchmarkCoverage?: BondBenchmarkCoverage[];
  /**
   * True when a series the security holds trades on a market: Monize writes no
   * price for the security, so its price is the person's own. Absent means no
   * information; read it as `=== true`.
   */
  marketPriceRequired?: boolean;
}

/** `GET /bonds/securities/:securityId/expected-series`: the code a purchase on the date would carry, by the program's country's grammar. */
export interface BondExpectedSeries {
  /** Null when the adapter cannot name one. */
  seriesCode: string | null;
  countryCode: string;
  /** True when the country can fetch a series from its official source. */
  fetchable: boolean;
}

/** `GET /bonds/securities/:securityId/series-on-sale`: the series the server infers for a BUY/REINVEST on the date; null when none is stored. */
export interface BondSeriesOnSale {
  instrumentId: string;
  seriesCode: string;
}

/** One series an account holds on a date (`GET /bonds/securities/:securityId/series-holdings`). */
export interface BondSeriesHolding {
  instrumentId: string;
  seriesCode: string;
  quantity: number;
}

export interface BondSeriesHoldings {
  holdings: BondSeriesHolding[];
}

/** Why no redemption split is given (the engine's early-redemption refusals, and a lot bought outside its series' sale window or, for a marketable series, on or after its maturity). */
export type BondRedemptionSplitRefusal =
  | Exclude<BondEarlyRedemptionRefusal, 'MATURED'>
  | BondValuationRefusal['code'];

/**
 * `GET /bonds/securities/:securityId/redemption-split`: what redeeming
 * `quantity` bonds of a series on `date` pays, as returned principal and
 * interest, summed over the lots the removal takes. Exact decimal strings in the
 * terms' money decimals; null where unknown (never zero).
 */
export interface BondRedemptionSplit {
  date: string;
  quantity: number;
  principal: string | null;
  grossInterest: string | null;
  deduction: string | null;
  interest: string | null;
  principalReturned: string | null;
  payout: string | null;
  refusal: BondRedemptionSplitRefusal | null;
}

/** `POST /bonds/securities/:securityId/recompute`. */
export interface BondPriceRecompute {
  written: number;
  deleted: number;
}

/** One assumed benchmark value and the figures it gives over the open lots (spec 13.3). */
export interface BondScenario {
  /** The assumed value as sent, a fraction ("0.05" is 5%). */
  value: string;
  /** Each figure is a lot-summed amount, or null when any lot cannot be valued. */
  maturityValue: string | null;
  totalInterest: string | null;
  fixedInterest: string | null;
  benchmarkInterest: string | null;
  addendInterest: string | null;
  announcedInterest: string | null;
}

/** `GET /bonds/securities/:securityId/scenarios`. */
export interface SecurityBondScenarios {
  securityId: string;
  benchmarkId: string;
  asOf: string;
  /** Set when the lots cannot be derived; every figure is then null. */
  refusal: BondLotsRefusal | null;
  scenarios: BondScenario[];
}

/** A benchmark value assumed for the valuation, `assume=<benchmarkId>:<value>`. */
export interface BondAssumption {
  benchmarkId: string;
  /** A fraction string. */
  value: string;
}

/** The valuation of one bond bought today and held to maturity (spec `bond-offer-and-history.md` 2). */
export interface BondOfferProjection {
  /** Per bond, plus every coupon of a coupon bond (cash received, not reinvested); null when it cannot be valued. */
  maturityValue: string | null;
  /** A fraction: (cash received - face value) / face value; null when unknown. */
  totalReturn: string | null;
  /** The yearly rate as a fraction, a comparison figure; null when unknown. */
  annualizedReturn: string | null;
  /** True when any period's rate is assumed. */
  projected: boolean;
  assumptions: BondProjectionAssumption[];
  projectionMissing: BondProjectionMissing[];
}

/** One series that can be bought today (`GET /bonds/offer`). */
export interface OfferSeries {
  instrumentId: string;
  issuerCountryCode: string;
  issuerCode: string;
  programCode: string;
  seriesCode: string;
  currency: string;
  saleWindow: { from: string; to: string };
  periodMonths: number;
  periodCount: number;
  /** Term in days for a bond whose schedule is dated from the issue; null when it is counted in months. */
  lengthDays: number | null;
  rateRule: BondRateRule;
  capitalization: 'NONE' | 'COMPOUND_AT_PERIOD_END';
  redemption: BondRedemptionTerms | null;
  termsSource: BondTermsSource;
  projection: BondOfferProjection;
}

export interface BondOffer {
  countryCode: string;
  /** The financial today the offer was read for, YYYY-MM-DD. */
  today: string;
  series: OfferSeries[];
}

/** One stored series of a program (`GET /bonds/history`). Rates and the fee are decimal strings. */
export interface HistorySeries {
  seriesCode: string;
  /** Null when the stored terms carry no sale window. */
  saleWindow: { from: string; to: string } | null;
  /** A fixed-rate series sets `annualRate` and leaves this and `addend` null. */
  firstPeriodRate: string | null;
  annualRate: string | null;
  addend: string | null;
  fee: string | null;
  proceedsFloor: 'ALL_PERIODS' | 'FIRST_PERIOD' | null;
  termsVersion: number;
  termsSource: BondTermsSource;
}

export interface BondHistoryCoverage {
  /** YYYY-MM */
  from: string | null;
  to: string | null;
  /** YYYY-MM each */
  missingMonths: string[];
}

export interface BondHistoryProgram {
  programCode: string;
  /** Ordered by the start of the sale window. */
  series: HistorySeries[];
  coverage: BondHistoryCoverage;
}

export interface BondHistory {
  countryCode: string;
  /** Ordered by program code; one entry when `programCode` was asked for. */
  programs: BondHistoryProgram[];
}

/**
 * `GET /bonds/programs/:programId/refresh-progress`: how far the synchronous
 * fetch of a bond kind's offer and history series has got. Every field is null
 * before a refresh has run.
 */
export interface BondRefreshProgress {
  /** ISO timestamp the server began the fetch; null when none has run. */
  startedAt: string | null;
  phase: 'offer' | 'series' | 'done' | null;
  /** Series fetched so far. */
  done: number;
  /** Series to fetch in total; 0 when the history is already complete. */
  total: number;
  /** The series being fetched now; null outside the series phase. */
  seriesCode: string | null;
  finishedAt: string | null;
}
