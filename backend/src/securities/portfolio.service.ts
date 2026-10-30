import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";
import { FxAggregate } from "../common/fx-aggregate";
import {
  FALLBACK_DEFAULT_CURRENCY,
  preferredCurrency,
  resolveUserDefaultCurrency,
} from "../common/default-currency.util";
import { Holding } from "./entities/holding.entity";
import { Security } from "./entities/security.entity";
import {
  EMPTY_RETURN_DIAGNOSTICS,
  ReturnDiagnostics,
  SecurityLabel,
  buildReturnDiagnostics,
} from "./return-diagnostics.util";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  PortfolioCalculationService,
  DailyRateIndex,
  FxRateCache,
} from "./portfolio-calculation.service";
import {
  SectorWeightingService,
  LlmLookThrough,
} from "./sector-weighting.service";
import {
  PeriodResultReason,
  PortfolioPeriodResultService,
} from "../net-worth/portfolio-period-result.service";
import type { IncompleteDataRanges } from "../net-worth/incomplete-data-ranges.util";
import { YahooFinanceService } from "./yahoo-finance.service";
import { QuoteProviderRegistry } from "./providers/quote-provider.registry";
import { isPricedByQuoteProvider } from "./provider-priced.util";
import { roundMoney } from "../common/round.util";
import { collectTagKeys } from "../tags/tag-key-value.util";
import {
  buildPortfolioSummaryMemoKey,
  portfolioSummaryMemo,
} from "./portfolio-summary-memo";
import { mapWithConcurrency } from "../common/concurrency.util";
import { addDaysYMD, formatDateYMD, todayYMD } from "../common/date-utils";
import {
  presetEarliestDate,
  presetWindowStart,
} from "../net-worth/portfolio-period-presets.util";
import {
  NetWorthService,
  type DailyInvestmentValue,
  type DailyPositions,
} from "../net-worth/net-worth.service";
import {
  keepNewestSession,
  priceDateYmd,
  resolveDailyPriceChange,
} from "./daily-change.util";
import {
  IntradayInterval,
  IntradayPoint,
  IntradayRange,
} from "./providers/quote-provider.interface";
import {
  IntradayRangeKey,
  IntradayValuePoint,
  IntradayValueResponse,
  IntradayBreakdownResponse,
  IntradayBreakdownSeries,
  IntradayBreakdownPoint,
} from "./dto/intraday-value.dto";

// Intraday charts run on an interactive request; cap concurrent Yahoo fetches
// so a portfolio with many holdings does not open one connection per symbol.
const INTRADAY_FETCH_CONCURRENCY = 6;

/**
 * What one brokerage or standalone investment account's holdings are worth, in
 * the account's own currency, with the completeness `getAccountMarketValues`
 * could establish. Read the flags before presenting `marketValue` as a total.
 */
export interface AccountMarketValue {
  /** null unless every held position was priced AND converted into the account's currency. */
  marketValue: number | null;
  /** Sum of the positions that were priced and converted. */
  knownMarketValueSubtotal: number;
  pricesComplete: boolean;
  unpricedSecurityIds: string[];
  unpricedSymbols: string[];
  fxComplete: boolean;
  /** "SEC->ACCT" pairs with no rate. */
  missingRatePairs: string[];
  valuationComplete: boolean;
}

export interface TopMover {
  securityId: string;
  symbol: string;
  name: string;
  currencyCode: string;
  currentPrice: number;
  previousPrice: number;
  dailyChange: number;
  dailyChangePercent: number;
  /**
   * The session the change is for -- the calendar day of the newer close.
   * Surfaces caption the figures with it: a Friday close read on a Saturday is
   * still the day's move, and saying which day it was is the difference
   * between a dated figure and one that claims today.
   */
  priceDate: string;
  marketValue: number | null;
  /**
   * What the day's move did to the position: `dailyChange * quantity held`, in
   * the security's own currency. Derived here rather than by each surface so the
   * per-share change, the position's value and the move in that value cannot
   * disagree; a consumer comparing it across currencies converts first.
   */
  dailyValueChange: number | null;
}

export interface HoldingWithMarketValue {
  id: string;
  accountId: string;
  securityId: string;
  symbol: string;
  name: string;
  securityType: string;
  currencyCode: string;
  quantity: number;
  averageCost: number;
  /**
   * Cost basis in the security's native currency (quantity * averageCost).
   */
  costBasis: number;
  /**
   * Cost basis converted to the holding account's currency using the
   * historical exchange rates stored on the original BUY transactions.
   * When no transaction history is available, this falls back to a
   * current-rate conversion of `costBasis`.
   *
   * `null` when neither is possible because no exchange rate exists for the
   * pair. It used to fall back to `costBasis` unconverted -- an implicit 1:1
   * that a consumer could not tell from a real one (audit P5-009), and which
   * fed a gain figure computed against a market value in a different currency.
   */
  costBasisAccountCurrency: number | null;
  currentPrice: number | null;
  marketValue: number | null;
  /**
   * `marketValue` converted into the holding account's currency by the SAME
   * `rateCache` snapshot that produces the account and portfolio totals, so a
   * row and the total it belongs to share one FX snapshot rather than the row
   * re-converting with the client's live rate (which drifted from the total).
   * `null` when the pair has no rate (unknown, never an implicit 1:1) and when
   * `marketValue` itself is null.
   */
  marketValueAccountCurrency: number | null;
  /**
   * `marketValue` converted into the user's default (reporting) currency from
   * the same snapshot that produces `totalPortfolioValue`, so the share of the
   * portfolio has one numerator and denominator in one currency. It is exactly
   * this holding's contribution to `holdingsValueTotal`.
   */
  marketValueDefaultCurrency: number | null;
  gainLoss: number | null;
  gainLossPercent: number | null;
}

export interface AccountHoldings {
  accountId: string;
  accountName: string;
  currencyCode: string;
  cashAccountId: string | null;
  cashBalance: number;
  holdings: HoldingWithMarketValue[];
  totalCostBasis: number;
  /**
   * Sum of the priced holdings only. An unpriced holding contributes nothing,
   * so this is a **subtotal** whenever `unpricedHoldingsCount` is non-zero --
   * read the two together before presenting it as an account's value.
   */
  totalMarketValue: number;
  /**
   * How many of this account's holdings have no price, and so are missing from
   * `totalMarketValue`. Non-zero means the account's market value is unknown
   * rather than measured (`docs/financial-calculation-contract.md` section 1).
   */
  unpricedHoldingsCount: number;
  /**
   * Value less cost over the holdings that have a value (A26-M38): the cost of
   * an unpriced holding is not charged against a value that never included it.
   * Read with `gainCostBasis` and `unpricedCostBasis`, and mark it partial when
   * `valuationComplete` is false.
   */
  totalGainLoss: number;
  /** Over `gainCostBasis`; 0 when that is 0. */
  totalGainLossPercent: number;
  /** Cost of the holdings `totalGainLoss` is over (value converted, cost converted). */
  gainCostBasis: number;
  /** Cost of the holdings left out of the gain because they have no value. */
  unpricedCostBasis: number;
  netInvested: number;
  /**
   * Completeness of *this account's* totals, which is a different question from
   * the summary's.
   *
   * The top-level figures convert each security straight into the user's default
   * currency; these convert it into the account's own currency. So a portfolio can
   * be complete at the top while a JPY account's total is missing `EUR->JPY`
   * entirely -- and before these fields existed that gap was only written to the
   * log, leaving an account screen or an AI answer free to report a confident zero
   * for an account whose holdings could not be converted (recheck RR3-005).
   */
  fxComplete: boolean;
  /** `"EUR->JPY"` for each pair with no rate into this account's currency. */
  missingRatePairs: string[];
  /** False when a position held in this account has no current price. */
  pricesComplete: boolean;
  /** Securities held here in a non-zero quantity with no current price. */
  unpricedSecurityIds: string[];
  /** `fxComplete && pricesComplete` -- gate this account's totals on this. */
  valuationComplete: boolean;
}

export interface PortfolioSummary {
  totalCashValue: number;
  totalHoldingsValue: number;
  totalCostBasis: number;
  totalNetInvested: number;
  totalPortfolioValue: number;
  /**
   * The gain over the holdings that joined `totalHoldingsValue` and whose cost
   * converted: their value less THEIR cost, never less every holding's cost
   * (A26-M38). A partial figure whenever `valuationComplete` is false.
   */
  totalGainLoss: number;
  /** Over `gainCostBasis`; 0 when that is 0. */
  totalGainLossPercent: number;
  /** Cost of the holdings `totalGainLoss` is over. */
  gainCostBasis: number;
  /**
   * Cost of the holdings the gain leaves out because they have no value: the
   * known subtotal of what converted.
   */
  unpricedCostBasis: number;
  /**
   * The invested part's time-weighted return since the portfolio's first
   * transaction, produced by the same path as "Portfolio performance"
   * (INV-PORTRESULT-002). `null` is withheld, never zero, and
   * `timeWeightedReturnReasons` says why.
   */
  timeWeightedReturn: number | null;
  /** Why `timeWeightedReturn` is withheld; empty when the figure is known. */
  timeWeightedReturnReasons: PeriodResultReason[];
  /** The baseline close the return is measured from, or `null` for no window. */
  timeWeightedReturnSince: string | null;
  /**
   * The same measure's second figure: the invested part's ANNUALISED
   * money-weighted return (XIRR) since the portfolio's first transaction, the
   * rate the reader's own money earned with each purchase, sale and
   * distribution weighted by when it happened
   * (`docs/specs/portfolio-period-result.md` section 11). `null` is withheld,
   * never zero, and `moneyWeightedReturnReasons` says why -- a window under 30
   * days is not annualised at all.
   */
  moneyWeightedReturn: number | null;
  /** Why `moneyWeightedReturn` is withheld; empty when the figure is known. */
  moneyWeightedReturnReasons: PeriodResultReason[];
  /**
   * What the two withheld returns above are waiting for: each missing price,
   * rate and cash balance NAMED and DATED, over the same since-inception window
   * both figures are measured across.
   *
   * Withholding a figure is only honest if the reader learns why, and "no
   * price" is not a repair -- "PPK, Mar 2 to May 30" is
   * (`docs/financial-calculation-contract.md` section 1.3). Empty when the
   * window has no gap, which is also what a known return looks like.
   */
  returnDiagnostics: ReturnDiagnostics;
  cagr: number | null;
  /**
   * False when a component of these totals could not be converted into the
   * reporting currency, which makes every `total*` field above a subtotal of what
   * did convert.
   *
   * A consumer that treats a total as complete must check this first. Making the
   * total fields themselves nullable is the end state and is staged -- see
   * `docs/specs/fx-conversion-completeness.md` section 4a -- but the signal has
   * to exist now, because without it an incomplete cash subtotal was accepted as
   * a complete portfolio value by the simulation (review finding FR-005).
   */
  fxComplete: boolean;
  /** `"EUR->USD"` for each pair with no available rate; empty when complete. */
  missingRatePairs: string[];
  /**
   * False when a held position has no current price, which also makes every
   * `total*` field above a subtotal.
   *
   * Separate from `fxComplete` because the two have different causes and different
   * fixes -- a missing rate is a currencies problem, a missing price is a quotes
   * problem -- and because `fxComplete` alone was already being consumed. A
   * consumer deciding whether it may treat a total as a total wants
   * `valuationComplete`, which is both.
   */
  pricesComplete: boolean;
  /** Securities held in a non-zero quantity with no current price. */
  unpricedSecurityIds: string[];
  /**
   * The single flag a consumer should gate a `total*` field on: every component of
   * every total above is known. `fxComplete && pricesComplete`.
   */
  valuationComplete: boolean;
  holdings: HoldingWithMarketValue[];
  holdingsByAccount: AccountHoldings[];
  allocation: AllocationItem[]; // Include allocation to avoid duplicate API call
}

export interface AllocationItem {
  name: string;
  symbol: string | null;
  type: "cash" | "security" | "tag" | "untagged";
  value: number;
  percentage: number;
  color?: string;
  currencyCode?: string;
}

export interface AssetAllocation {
  allocation: AllocationItem[];
  totalValue: number;
}

/**
 * Compact portfolio view shared by the AI Assistant's tool executor and the
 * MCP server. Mirrors `PortfolioSummary` but drops internal UUIDs, rounds
 * monetary and percentage values, and keeps only the fields the model needs
 * to answer holdings questions.
 */
export interface LlmPortfolioHolding {
  // The owned security's UUID, surfaced so the assistant can deep-link a
  // holding to its row on the Securities page (monize://security/<id>). It is
  // the Security id, not the holding-row id, matching what /securities?highlight=
  // resolves against.
  securityId: string;
  symbol: string;
  name: string;
  securityType: string;
  currency: string;
  quantity: number;
  averageCost: number | null;
  costBasis: number;
  marketValue: number | null;
  gainLoss: number | null;
  gainLossPercent: number | null;
}

export interface LlmPortfolioAllocation {
  name: string;
  symbol: string | null;
  type: "cash" | "security" | "tag" | "untagged";
  value: number;
  percentage: number;
}

/**
 * Per-account holdings breakdown embedded in the LLM portfolio summary. Each
 * entry lists the individual positions held in one investment account, the
 * account's cash balance, and its rolled-up totals. This replaces the former
 * standalone holding-details tool so a single summary call answers both
 * portfolio-wide and per-account holdings questions.
 */
export interface LlmAccountHoldings {
  accountName: string;
  currency: string;
  cashBalance: number;
  totalCostBasis: number;
  totalMarketValue: number;
  /** Over the account's holdings that have a value (`gainCostBasis`). */
  totalGainLoss: number;
  totalGainLossPercent: number;
  gainCostBasis: number;
  /** Cost the gain leaves out: holdings with no value. */
  unpricedCostBasis: number;
  /**
   * This account's own completeness, carried for the same reason the top-level
   * flags are: a model reading `totalMarketValue: 0` for a JPY account cannot
   * otherwise tell "holds nothing" from "could not be converted into JPY", and the
   * global flag answers a different question (recheck RR3-005).
   */
  fxComplete: boolean;
  missingRatePairs: string[];
  pricesComplete: boolean;
  valuationComplete: boolean;
  holdings: LlmPortfolioHolding[];
}

export interface LlmPortfolioSummary {
  holdingCount: number;
  /**
   * Same meaning as `PortfolioSummary.fxComplete`, and present for the same
   * reason: this shape is what the AI Assistant and the MCP server quote back to
   * a user. Dropping the flag here let a model state a cash subtotal as a
   * complete balance while the UI-facing summary knew it was not (recheck
   * RR2-007). A subtotal must not cross a consumer boundary under a `total*`
   * name without its incompleteness.
   */
  fxComplete: boolean;
  /** `"EUR->USD"` for each pair with no available rate; empty when complete. */
  missingRatePairs: string[];
  /** False when a held position has no current price. */
  pricesComplete: boolean;
  /** Symbols held in a non-zero quantity with no current price. */
  unpricedSymbols: string[];
  /** `fxComplete && pricesComplete` -- gate a total on this one. */
  valuationComplete: boolean;
  totalCashValue: number;
  totalHoldingsValue: number;
  totalCostBasis: number;
  totalPortfolioValue: number;
  /** Over the holdings that have a value (`gainCostBasis`); partial when `valuationComplete` is false. */
  totalGainLoss: number;
  totalGainLossPercent: number;
  gainCostBasis: number;
  /** Cost the gain leaves out: holdings with no value. */
  unpricedCostBasis: number;
  /** The invested part's TWR since the first transaction; null is withheld. */
  timeWeightedReturn: number | null;
  /** Why it is withheld, so a model reports the cause rather than "n/a". */
  timeWeightedReturnReasons: PeriodResultReason[];
  /** The baseline close it is measured from, so the answer can name the window. */
  timeWeightedReturnSince: string | null;
  /** The invested part's annualised XIRR over the same window; null is withheld. */
  moneyWeightedReturn: number | null;
  /** Why it is withheld, so a model reports the cause rather than "n/a". */
  moneyWeightedReturnReasons: PeriodResultReason[];
  /**
   * The named, dated gaps behind a withheld return, so a model answers "PPK has
   * no close from Mar 2 to May 30" rather than "not available". Carried in full,
   * ids included: they are what a `monize://security/<id>` link quotes, exactly
   * as `LlmPortfolioHolding.securityId` is.
   */
  returnDiagnostics: ReturnDiagnostics;
  cagr: number | null;
  holdings: LlmPortfolioHolding[];
  holdingsByAccount: LlmAccountHoldings[];
  allocation: LlmPortfolioAllocation[];
  /**
   * Country and asset-class look-through breakdowns. Only present when the
   * caller asks for them: they cost a second holdings/FX pass, and most
   * portfolio questions don't need them.
   */
  lookThrough?: LlmLookThrough;
}

/**
 * A currency's live intraday FX bars (times/rates) plus a latest-spot fallback,
 * used to value each grid bar at the rate that prevailed at that moment.
 */
interface IntradayFxSeries {
  times: number[];
  rates: number[];
  /**
   * Fallback rate for a bar the intraday and daily series do not cover.
   *
   * `null` when the pair has no rate at all -- distinct from a rate that
   * happens to be 1. The intraday resolver used to fall back to a bare `1`,
   * which valued a foreign holding at its face number and made the chart look
   * right while being wrong by the whole FX difference (audit P5-009).
   */
  latest: number | null;
}

/**
 * Fully loaded intraday inputs, shared by the total-value and per-security
 * breakdown views so both are derived from a single set of Yahoo fetches. The
 * expensive part (price + FX fetches, cash, the unified time grid) lives here
 * and is cached; the cheap per-bar aggregation runs per view.
 *
 * When `fallbackToDaily` is true (or there are no holdings) the value arrays
 * are empty and the caller renders/flags the daily fallback instead.
 */
interface IntradayLoaded {
  interval: IntradayInterval;
  currency: string;
  range: IntradayRangeKey;
  fetchedAt: string;
  skippedSymbols: string[];
  failedSymbols: string[];
  fallbackToDaily: boolean;
  timestamps: number[];
  /** Holdings with live intraday bars, in the security's native currency. */
  sources: Array<{
    securityId: string;
    symbol: string;
    name: string;
    quantity: number;
    currencyCode: string;
    times: number[];
    opens: Array<number | null | undefined>;
    closes: number[];
  }>;
  /** Holdings valued at their last daily close (native-currency amount). */
  staleSources: Array<{
    securityId: string;
    symbol: string;
    name: string;
    currencyCode: string;
    amount: number;
  }>;
  /** Cash grouped by native currency (currency -> amount). */
  cashByCurrency: Array<[string, number]>;
  fxByCurrency: Map<string, IntradayFxSeries>;
  dailyRateIndex: DailyRateIndex;
  /** Latest spot rate per `${currency}->${display}` fallback. */
  spotRate: FxRateCache;
  /**
   * The positions held at the close of each day of the window, ascending
   * (INV-INTRADAY-001). When present, a bar is valued at its own day's share
   * counts and cash; `sources[].quantity`, `cashByCurrency`'s amounts and
   * `staleSources` are then unused. `null` only when the scope has no
   * investment account for the fold to replay.
   */
  ledgerDays: LedgerDay[] | null;
  /**
   * Grid timestamps that are a finished session's closing point, mapped to the
   * index of the ledger day whose daily figure the point carries.
   */
  sessionCloses: Map<number, number>;
  /**
   * With the ledger: holdings with no intraday bars (failed fetch, inactive
   * security), valued per day at that day's quantity and stored close.
   */
  closeValued: Array<{
    securityId: string;
    symbol: string;
    name: string;
    currencyCode: string;
  }>;
  /**
   * Without the ledger: held securities no bar could value at all -- a bond-
   * linked or inactive security, or one whose fetch failed with no stored close.
   * They are left out of every live bar, so every bar is `pricesComplete: false`.
   * With the ledger this is empty and each bar finds its own unpriced positions
   * (`IntradayBarPositions.unpricedSecurityIds`).
   */
  unpricedSecurityIds: string[];
}

interface IntradayCacheEntry {
  expiresAt: number;
  loaded: IntradayLoaded;
}

/** One held security as the intraday loader sees it. */
interface IntradayHolding {
  securityId: string;
  symbol: string;
  name: string;
  exchange: string | null;
  currencyCode: string;
  /** Today's share count; only the legacy (no-ledger) path values bars by it. */
  quantity: number;
  /** Its quote provider can serve intraday bars (false for MSN Money). */
  hasIntraday: boolean;
  /** Worth asking for bars at all (false for an inactive security). */
  fetchIntraday: boolean;
}

/** What one intraday bar could not value; see `IntradayValuePoint`. */
interface IntradayBarFlags {
  fxComplete: boolean;
  pricesComplete: boolean;
  cashComplete: boolean;
}

/** What the scope held at one intraday bar; see `makeIntradayPositionsAt`. */
interface IntradayBarPositions {
  /** Shares of a security held at the bar; the legacy path answers today's. */
  quantityOf(securityId: string, todayQuantity: number): number;
  /** Cash per native currency. */
  cash: Iterable<[string, number]>;
  /** Holdings with no bars, as a native-currency amount at a daily close. */
  closeValued: Array<{
    securityId: string;
    symbol: string;
    name: string;
    currencyCode: string;
    amount: number;
  }>;
  /** Held securities this bar has no price for: left out, so unknown not zero. */
  unpricedSecurityIds: string[];
}

/** One calendar day of the ledger fold, as the intraday series reads it. */
interface LedgerDay {
  date: string;
  positions: DailyPositions;
  daily: DailyInvestmentValue;
}

/** Below this a replayed share count is zero, as the daily fold treats it. */
const LEDGER_QUANTITY_EPSILON = 0.00000001;

/**
 * How far back the 1D ledger reaches: its grid is the latest session, which a
 * weekend and a holiday can put four days behind today.
 */
const LEDGER_1D_LOOKBACK_DAYS = 7;

const INTERVAL_MS: Record<IntradayInterval, number> = {
  "1m": 60_000,
  "2m": 120_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "60m": 3_600_000,
  "90m": 5_400_000,
};

const RANGE_TO_YAHOO: Record<
  IntradayRangeKey,
  { interval: IntradayInterval; range: IntradayRange }
> = {
  "1d": { interval: "1m", range: "1d" },
  // Yahoo's "5d" range only covers 5 trading days, so a 1W request that lands
  // on a Wednesday would only reach back to the previous Thursday. Pull a
  // full month and let the cutoff filter trim to exactly 7 calendar days.
  "1w": { interval: "5m", range: "1mo" },
  mtd: { interval: "15m", range: "1mo" },
  "1m": { interval: "15m", range: "1mo" },
};

/**
 * Where a range's window opens and which day it is measured from, as the
 * period-result service resolves the same preset (`presetWindowStart`,
 * `presetEarliestDate`): 1W opens seven days back and is measured from the
 * close before that, 1M opens thirty days back and is measured from that day's
 * own close. MTD has no preset: it opens on the 1st and is measured from the
 * previous month's last day, the window the client dates the period result
 * with. Yahoo's range parameter is approximate ("5d" is five trading days,
 * "1mo" excludes the boundary date), so the bars are over-fetched and trimmed
 * to the window here, and the series opens on the measured-from day's close
 * (`planOpeningClose`). 1D is the provider's latest session, whatever day it
 * fell on, and opens at its open.
 */
function intradayWindow(
  range: IntradayRangeKey,
  today: string,
): { windowStart: string; measuredFrom: string } | null {
  if (range === "1d") return null;
  if (range === "mtd") {
    const windowStart = `${today.slice(0, 7)}-01`;
    return { windowStart, measuredFrom: addDaysYMD(windowStart, -1) };
  }
  const windowStart = presetWindowStart(range, today);
  const measuredFrom = presetEarliestDate(range, today);
  if (windowStart === null || measuredFrom === null) return null;
  return { windowStart, measuredFrom };
}

// Per-range fallback chain attempted (per holding, in order) when the
// primary interval fails. Yahoo's narrowest intervals are the most
// rate-limited and most likely to return empty responses for less-liquid
// securities; each step up the ladder is more reliable. We try
// progressively coarser bars at the same range until one works, then
// only after the whole ladder fails do we fall back to the security's
// latest daily close. The user sees no banner -- the chart silently
// degrades to slightly coarser resolution instead.
const RANGE_FALLBACKS: Record<
  IntradayRangeKey,
  Array<{ interval: IntradayInterval; range: IntradayRange }>
> = {
  "1d": [
    { interval: "2m", range: "1d" },
    { interval: "5m", range: "1d" },
    { interval: "15m", range: "1d" },
    { interval: "30m", range: "1d" },
    { interval: "60m", range: "1d" },
    { interval: "90m", range: "1d" },
  ],
  "1w": [
    { interval: "15m", range: "1mo" },
    { interval: "30m", range: "1mo" },
    { interval: "60m", range: "1mo" },
    { interval: "90m", range: "1mo" },
  ],
  mtd: [
    { interval: "30m", range: "1mo" },
    { interval: "60m", range: "1mo" },
    { interval: "90m", range: "1mo" },
  ],
  "1m": [
    { interval: "30m", range: "1mo" },
    { interval: "60m", range: "1mo" },
    { interval: "90m", range: "1mo" },
  ],
};

const INTRADAY_CACHE_TTL_MS = 60_000;

@Injectable()
export class PortfolioService {
  private readonly logger = new Logger(PortfolioService.name);
  private readonly intradayCache = new Map<string, IntradayCacheEntry>();

  constructor(
    private dataSource: DataSource,
    private calculationService: PortfolioCalculationService,
    private yahooFinanceService: YahooFinanceService,
    private quoteProviderRegistry: QuoteProviderRegistry,
    private sectorWeightingService: SectorWeightingService,
    // The summary's time-weighted return is the invested measure over the
    // portfolio's whole life, answered by the service that owns that measure
    // rather than by a second implementation here (#1392). forwardRef for the
    // reason `DailyMovementService` gives: SecuritiesModule and NetWorthModule
    // already close a cycle.
    @Inject(forwardRef(() => PortfolioPeriodResultService))
    private periodResult: PortfolioPeriodResultService,
    // The intraday series values each past day at the positions the daily
    // series holds that day (INV-INTRADAY-001). forwardRef for the same cycle.
    @Inject(forwardRef(() => NetWorthService))
    private netWorth: NetWorthService,
  ) {}

  /**
   * Get the latest prices for a list of security IDs
   * Uses DISTINCT ON for efficient single-pass query instead of correlated subquery
   */
  async getLatestPrices(securityIds: string[]): Promise<Map<string, number>> {
    const observations = await this.getLatestPriceObservations(securityIds);
    return new Map(
      [...observations].map(([securityId, point]) => [securityId, point.close]),
    );
  }

  /**
   * The same latest observations, each with the date it was actually struck on.
   *
   * `getLatestPrices` is this query with the date dropped, so the two cannot
   * name different rows: a caller that has to know whether today's valuation is
   * dated today or carried forward from a month ago is asking about the very
   * observation that priced it, and a second query would be a second rule. The
   * daily portfolio-movement producer reads it for exactly that
   * (INV-PORTMOVE-008).
   */
  async getLatestPriceObservations(
    securityIds: string[],
  ): Promise<Map<string, { close: number; date: string }>> {
    if (securityIds.length === 0) {
      return new Map();
    }

    // Use DISTINCT ON (PostgreSQL) for efficient single-pass latest price lookup
    const latestPrices = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT DISTINCT ON (security_id) security_id, close_price, price_date
         FROM security_prices
         WHERE security_id = ANY($1)
         ORDER BY security_id, price_date DESC`,
        [securityIds],
      ),
    );

    const observations = new Map<string, { close: number; date: string }>();
    for (const price of returnedRows<{
      security_id: string;
      close_price: string;
      price_date: string | Date;
    }>(latestPrices)) {
      observations.set(price.security_id, {
        close: Number(price.close_price),
        date: priceDateYmd(price.price_date),
      });
    }

    return observations;
  }

  /**
   * Convert a set of native-currency security values into the user's default
   * currency, summing by security, and report the pairs that could not convert.
   *
   * A weighting has to be in one currency. Monte Carlo's historical-return
   * weighting summed `quantity * nativePrice` across USD, JPY and EUR holdings as
   * though the units matched, so a balanced mix of a +20% USD holding and an
   * equal-value -20% JPY holding came out near -20% instead of 0% (recheck
   * RR5-003). The choice of common currency does not change the normalized
   * weights -- only that they share one -- so the default currency is the natural
   * denominator, and this reuses the same `convertToDefault` the portfolio summary
   * uses (stored daily rate, `null` on a missing pair, never a silent 1:1).
   *
   * The caller supplies the already-priced values so this does not re-load or
   * re-price holdings; missing *prices* are the caller's to report, missing
   * *rates* are reported here.
   */
  async convertSecurityValuesToDefault(
    userId: string,
    items: Array<{
      securityId: string;
      currencyCode: string;
      nativeValue: number;
    }>,
  ): Promise<{
    valueBySecurity: Map<string, number>;
    missingRatePairs: string[];
  }> {
    const defaultCurrency = await this.resolveDefaultCurrency(userId);
    // FxRateCache, not Map<string, number>: convertToDefault stores null
    // sentinels for missing pairs, and a narrower declared type is a lie the
    // next reader of this map would trust.
    const rateCache: FxRateCache = new Map();

    const valueBySecurity = new Map<string, number>();
    const missingRatePairs = new Set<string>();

    for (const item of items) {
      const converted = await this.calculationService.convertToDefault(
        item.nativeValue,
        item.currencyCode,
        defaultCurrency,
        rateCache,
      );
      if (converted === null) {
        missingRatePairs.add(`${item.currencyCode}->${defaultCurrency}`);
        continue;
      }
      valueBySecurity.set(
        item.securityId,
        (valueBySecurity.get(item.securityId) ?? 0) + converted,
      );
    }

    return {
      valueBySecurity,
      missingRatePairs: [...missingRatePairs].sort(),
    };
  }

  /**
   * Get all investment accounts (both cash and brokerage) for a user
   */
  async getInvestmentAccounts(userId: string): Promise<Account[]> {
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).find({
        where: {
          userId,
          accountType: AccountType.INVESTMENT,
          isClosed: false,
        },
      }),
    );
  }

  /**
   * Get the subset of investment accounts that can hold securities — brokerage
   * and standalone accounts. Cash siblings of brokerage pairs are excluded so
   * UIs that need a single "where the holdings live" picker don't show two
   * rows per brokerage.
   */
  async getBrokerageAccounts(userId: string): Promise<Account[]> {
    const accounts = await this.getInvestmentAccounts(userId);
    const { brokerageAccounts, standaloneAccounts } =
      this.calculationService.categoriseAccounts(accounts);
    return [...brokerageAccounts, ...standaloneAccounts];
  }

  /**
   * Get portfolio summary for a user, optionally filtered by account.
   *
   * Memoized per user, account scope, reporting currency and ambient identity
   * for the memo's TTL (60 s, `portfolio-summary-memo.ts`). The memo wraps the computation
   * here, at the service boundary, so every caller shares it: the controller,
   * the by-tag allocation, the security detail page and the AI / MCP
   * `get_portfolio_summary` tool. Opening the Investments page used to start
   * three of these concurrently and pay for all three.
   */
  async getPortfolioSummary(
    userId: string,
    accountIds?: string[],
  ): Promise<PortfolioSummary> {
    // Get user's default currency for conversion. Read before the memo because
    // it is part of the key: a preference change must not be answered from an
    // entry computed in the previous currency.
    const pref = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    const defaultCurrency = preferredCurrency(pref);
    return portfolioSummaryMemo.run(
      userId,
      buildPortfolioSummaryMemoKey(userId, accountIds, defaultCurrency),
      () => this.computePortfolioSummary(userId, defaultCurrency, accountIds),
    );
  }

  /**
   * The valuation itself.
   */
  private async computePortfolioSummary(
    userId: string,
    defaultCurrency: string,
    accountIds?: string[],
  ): Promise<PortfolioSummary> {
    const rateCache: FxRateCache = new Map();

    // Get investment accounts
    const accounts = await this.resolveAccounts(userId, accountIds);

    // Categorise into cash / brokerage / standalone
    const categorised = this.calculationService.categoriseAccounts(accounts);

    // Prime the rate cache with live spot FX so every "as of now" valuation
    // below (holdings value, cash, net invested, allocation) converts at the
    // current rate and matches the live Portfolio Value Over Time chart rather
    // than the once-a-day stored snapshot. Best effort -- per currency, falls
    // back to the stored daily rate when no live quote is available.
    await this.calculationService.primeLiveRates(
      rateCache,
      accounts,
      categorised.holdingsAccountIds,
      defaultCurrency,
    );

    // Compute effective cash balances excluding future-dated transactions
    const cashAndStandaloneIds = [
      ...categorised.cashAccounts,
      ...categorised.standaloneAccounts,
    ].map((a) => a.id);
    const effectiveBalances =
      await this.calculationService.computeEffectiveBalances(
        cashAndStandaloneIds,
      );

    // Calculate total cash value (converted to default currency)
    const cashResult = await this.calculationService.computeTotalCashValue(
      [...categorised.cashAccounts, ...categorised.standaloneAccounts],
      effectiveBalances,
      defaultCurrency,
      rateCache,
    );
    const totalCashValue = cashResult.total;

    // Compute per-account investment transaction sums for Net Invested
    const investmentFlows =
      await this.calculationService.computeInvestmentFlows(
        userId,
        categorised.holdingsAccountIds,
      );

    // Calculate holdings with market values
    const holdingsResult =
      await this.calculationService.calculateHoldingsWithValues(
        userId,
        categorised.holdingsAccountIds,
        defaultCurrency,
        rateCache,
        (ids) => this.getLatestPrices(ids),
      );

    // Group holdings by account
    const holdingsByAccount =
      await this.calculationService.buildHoldingsByAccount(
        categorised,
        holdingsResult.holdingsWithValues,
        effectiveBalances,
        investmentFlows,
        rateCache,
      );

    const totalPortfolioValue =
      totalCashValue + holdingsResult.totalHoldingsValue;
    // Value less cost of the SAME holdings (A26-M38): `totalCostBasis` carries
    // every holding's cost, `totalHoldingsValue` only the priced ones.
    const totalGainLoss =
      holdingsResult.gainMarketValue - holdingsResult.gainCostBasis;
    const totalGainLossPercent =
      holdingsResult.gainCostBasis > 0
        ? (totalGainLoss / holdingsResult.gainCostBasis) * 100
        : 0;

    // Calculate total net invested (converted to default currency)
    const netInvestedAgg = new FxAggregate();
    for (const acct of holdingsByAccount) {
      netInvestedAgg.add(
        await this.calculationService.convertToDefault(
          acct.netInvested,
          acct.currencyCode,
          defaultCurrency,
          rateCache,
        ),
        acct.currencyCode,
        defaultCurrency,
      );
    }
    if (!netInvestedAgg.isComplete) {
      this.logger.warn(
        `Net invested omits accounts with no exchange rate (${netInvestedAgg.missingPairs.join(", ")})`,
      );
    }
    const totalNetInvested = netInvestedAgg.knownSubtotal;

    // Sort holdings by market value
    const sortedHoldings = [...holdingsResult.holdingsWithValues].sort(
      (a, b) => {
        if (a.marketValue === null && b.marketValue === null) return 0;
        if (a.marketValue === null) return 1;
        if (b.marketValue === null) return -1;
        return b.marketValue - a.marketValue;
      },
    );

    // Build allocation data
    const allocation = await this.calculationService.buildAllocation(
      sortedHoldings,
      holdingsResult.holdings,
      totalCashValue,
      defaultCurrency,
      rateCache,
    );

    // The time-weighted return, over the same measure "Portfolio performance"
    // reports and by the same code path: the invested part's TWR since the
    // portfolio's first transaction (INV-PORTRESULT-002,
    // `docs/specs/portfolio-period-result.md` section 10). It is withheld with
    // its cause rather than approximated, so a position with no stored close on
    // a day the chain spans makes the figure unknown instead of a gain.
    // `fetchMissing: false`: a summary card is not a licence to drive a
    // twenty-six-year provider backfill from inside a GET. The window opens at
    // the scope's first transaction, so a portfolio that started in 2000 asked
    // the rate provider for every month it had no stored rate for -- inline,
    // on the request a person is waiting on, and again on the next request
    // because a provider with no history for that era answers nothing there is
    // to store (issue #1409). The summary already withholds a figure with its
    // cause (`timeWeightedReturnReasons`, `incompleteRanges`), so it reports
    // the gap; filling it is `ExchangeRateHistoryService` and the scheduled
    // jobs, where a person is not waiting.
    const investedSinceInception =
      await this.periodResult.getInvestedResultSinceInception(userId, {
        accountIds,
        displayCurrency: defaultCurrency,
        fetchMissing: false,
      });
    const timeWeightedReturn = investedSinceInception.investmentReturnPercent;
    const timeWeightedReturnReasons = investedSinceInception.investedReasons;
    // The window's baseline, so the caption can name what "since" means. A
    // scope with no valued day has no window at all, which is not a date.
    const timeWeightedReturnSince = timeWeightedReturnReasons.includes(
      "noValueSeries",
    )
      ? null
      : investedSinceInception.startDate;

    // The second figure of that same measure, from the same slice: what the
    // reader's own money earned, annualised, with every purchase, sale and
    // distribution weighted by when it happened (section 11). Withheld with
    // its cause -- including a portfolio too young to annualise -- rather than
    // approximated or defaulted to the time-weighted one.
    const moneyWeightedReturn =
      investedSinceInception.investmentMoneyWeightedReturnPercent;
    const moneyWeightedReturnReasons = investedSinceInception.investedReasons;

    // What a withheld return is waiting for, named: the same window's dated
    // gaps, resolved to symbols and account names so the card can point at the
    // price history rather than at a generic "no price" marker (#1392).
    const returnDiagnostics = await this.resolveReturnDiagnostics(
      userId,
      investedSinceInception.incompleteRanges,
      timeWeightedReturnSince,
      holdingsResult.holdingsWithValues,
      accounts,
    );

    // CAGR divides the portfolio value by what was invested to get there, so an
    // incomplete numerator or denominator produces a growth rate for a portfolio
    // nobody owns: with one unconvertible EUR account, 100 USD of known net
    // invested against a 210 USD true figure overstates the return by more than
    // half, and an unpriced position understates the value it grew to. Unknown, not
    // approximated.
    const cagr =
      netInvestedAgg.isComplete &&
      holdingsResult.fxComplete &&
      holdingsResult.pricesComplete &&
      cashResult.fxComplete
        ? await this.calculationService.calculateCAGR(
            userId,
            categorised.holdingsAccountIds,
            totalNetInvested,
            totalPortfolioValue,
          )
        : null;

    // Whether every component of these totals could be converted into the
    // reporting currency. A log entry is invisible to an API consumer, so the
    // completeness state travels with the numbers: without it an incomplete cash
    // subtotal reached a Monte Carlo starting balance and was treated as a
    // complete portfolio value (review finding FR-005).
    // Every aggregate that feeds a returned `total*` field contributes here.
    // `netInvestedAgg` was left out and only logged, so a portfolio whose cash
    // and holdings converted cleanly could still return an incomplete
    // `totalNetInvested` under `fxComplete: true` -- and feed that subtotal to
    // CAGR as a complete denominator (recheck RR2-005). The flag documents itself
    // as covering every total above, so it has to.
    const missingRatePairs = [
      ...new Set([
        ...cashResult.missingRatePairs,
        ...holdingsResult.missingRatePairs,
        ...netInvestedAgg.missingPairs,
      ]),
    ].sort();

    return {
      totalCashValue,
      totalHoldingsValue: holdingsResult.totalHoldingsValue,
      totalCostBasis: holdingsResult.totalCostBasis,
      totalNetInvested,
      totalPortfolioValue,
      totalGainLoss,
      totalGainLossPercent,
      gainCostBasis: holdingsResult.gainCostBasis,
      unpricedCostBasis: holdingsResult.unpricedCostBasis,
      timeWeightedReturn,
      timeWeightedReturnReasons,
      timeWeightedReturnSince,
      moneyWeightedReturn,
      moneyWeightedReturnReasons,
      returnDiagnostics,
      cagr,
      fxComplete: missingRatePairs.length === 0,
      missingRatePairs,
      pricesComplete: holdingsResult.pricesComplete,
      unpricedSecurityIds: holdingsResult.unpricedSecurityIds,
      valuationComplete:
        missingRatePairs.length === 0 && holdingsResult.pricesComplete,
      holdings: sortedHoldings,
      holdingsByAccount,
      allocation,
    };
  }

  /**
   * The window's dated gaps, turned into rows a reader can act on.
   *
   * The names come from what the summary already loaded wherever they can: the
   * holdings it valued and the accounts it resolved. What is left is looked up
   * by id -- a security sold out of the portfolio, or one whose position is
   * inactive today, is exactly the kind of holding a months-long price gap sits
   * on, and printing its UUID instead of its symbol would be a worse dead end
   * than the generic sentence this replaces.
   */
  private async resolveReturnDiagnostics(
    userId: string,
    ranges: IncompleteDataRanges,
    since: string | null,
    holdings: HoldingWithMarketValue[],
    accounts: Account[],
  ): Promise<ReturnDiagnostics> {
    const securityIds = [...new Set(ranges.prices.map((r) => r.key))];
    const accountIds = [...new Set(ranges.cash.map((r) => r.key))];
    if (securityIds.length === 0 && accountIds.length === 0) {
      return { ...EMPTY_RETURN_DIAGNOSTICS, since };
    }

    const securityLabels = new Map<string, SecurityLabel>(
      holdings.map((h) => [h.securityId, { symbol: h.symbol, name: h.name }]),
    );
    const accountNames = new Map<string, string>(
      accounts.map((a) => [a.id, a.name]),
    );
    const missingSecurities = securityIds.filter(
      (id) => !securityLabels.has(id),
    );
    const missingAccounts = accountIds.filter((id) => !accountNames.has(id));

    if (missingSecurities.length > 0 || missingAccounts.length > 0) {
      await withScopedDb(this.dataSource, async (m) => {
        if (missingSecurities.length > 0) {
          const rows = await m.getRepository(Security).find({
            where: { id: In(missingSecurities), userId },
            select: ["id", "symbol", "name"],
          });
          for (const row of rows) {
            securityLabels.set(row.id, { symbol: row.symbol, name: row.name });
          }
        }
        if (missingAccounts.length > 0) {
          const rows = await m.getRepository(Account).find({
            where: { id: In(missingAccounts), userId },
            select: ["id", "name"],
          });
          for (const row of rows) accountNames.set(row.id, row.name);
        }
      });
    }

    return buildReturnDiagnostics(ranges, since, securityLabels, accountNames);
  }

  /**
   * Compact portfolio summary for LLM / AI consumers. Called by both the AI
   * Assistant's tool executor and the MCP server's `get_portfolio_summary`
   * tool so the two surfaces return the same shape. Monetary values are
   * rounded to 4 decimal places; percentages to 2.
   *
   * `includeLookThrough` adds the country and asset-class breakdowns for
   * exposure questions ("how much am I in the US?", "what's my equity/bond
   * split?"). It is opt-in because it re-walks the holdings with FX conversion.
   */
  async getLlmSummary(
    userId: string,
    accountIds?: string[],
    options?: { includeLookThrough?: boolean },
  ): Promise<LlmPortfolioSummary> {
    const summary = await this.getPortfolioSummary(userId, accountIds);
    const lookThrough = options?.includeLookThrough
      ? await this.sectorWeightingService.getLlmLookThrough(userId, accountIds)
      : null;

    const roundMoneyValue = (v: number | null | undefined): number =>
      v === null || v === undefined ? 0 : roundMoney(Number(v));
    const roundMoneyNullable = (v: number | null | undefined): number | null =>
      v === null || v === undefined ? null : roundMoney(Number(v));
    const roundPct = (v: number | null | undefined): number | null =>
      v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100;

    const toLlmHolding = (h: HoldingWithMarketValue): LlmPortfolioHolding => ({
      securityId: h.securityId,
      symbol: h.symbol,
      name: h.name,
      securityType: h.securityType,
      currency: h.currencyCode,
      quantity: h.quantity,
      averageCost: roundMoneyNullable(h.averageCost),
      costBasis: roundMoneyValue(h.costBasis),
      marketValue: roundMoneyNullable(h.marketValue),
      gainLoss: roundMoneyNullable(h.gainLoss),
      gainLossPercent: roundPct(h.gainLossPercent),
    });

    const holdings: LlmPortfolioHolding[] = summary.holdings.map(toLlmHolding);

    const holdingsByAccount: LlmAccountHoldings[] =
      summary.holdingsByAccount.map((acct) => ({
        accountName: acct.accountName,
        currency: acct.currencyCode,
        cashBalance: roundMoneyValue(acct.cashBalance),
        totalCostBasis: roundMoneyValue(acct.totalCostBasis),
        totalMarketValue: roundMoneyValue(acct.totalMarketValue),
        totalGainLoss: roundMoneyValue(acct.totalGainLoss),
        totalGainLossPercent: roundPct(acct.totalGainLossPercent) ?? 0,
        gainCostBasis: roundMoneyValue(acct.gainCostBasis),
        unpricedCostBasis: roundMoneyValue(acct.unpricedCostBasis),
        fxComplete: acct.fxComplete,
        missingRatePairs: acct.missingRatePairs,
        pricesComplete: acct.pricesComplete,
        valuationComplete: acct.valuationComplete,
        holdings: acct.holdings.map(toLlmHolding),
      }));

    const allocation: LlmPortfolioAllocation[] = summary.allocation.map(
      (a) => ({
        name: a.name,
        symbol: a.symbol,
        type: a.type,
        value: roundMoneyValue(a.value),
        percentage: roundPct(a.percentage) ?? 0,
      }),
    );

    return {
      holdingCount: holdings.length,
      totalCashValue: roundMoneyValue(summary.totalCashValue),
      totalHoldingsValue: roundMoneyValue(summary.totalHoldingsValue),
      totalCostBasis: roundMoneyValue(summary.totalCostBasis),
      totalPortfolioValue: roundMoneyValue(summary.totalPortfolioValue),
      totalGainLoss: roundMoneyValue(summary.totalGainLoss),
      totalGainLossPercent: roundPct(summary.totalGainLossPercent) ?? 0,
      gainCostBasis: roundMoneyValue(summary.gainCostBasis),
      unpricedCostBasis: roundMoneyValue(summary.unpricedCostBasis),
      timeWeightedReturn: roundPct(summary.timeWeightedReturn),
      timeWeightedReturnReasons: summary.timeWeightedReturnReasons,
      timeWeightedReturnSince: summary.timeWeightedReturnSince,
      moneyWeightedReturn: roundPct(summary.moneyWeightedReturn),
      moneyWeightedReturnReasons: summary.moneyWeightedReturnReasons,
      returnDiagnostics: summary.returnDiagnostics,
      cagr: roundPct(summary.cagr),
      fxComplete: summary.fxComplete,
      missingRatePairs: summary.missingRatePairs,
      pricesComplete: summary.pricesComplete,
      // Symbols rather than ids: an id means nothing to a model or a reader.
      unpricedSymbols: summary.unpricedSecurityIds
        .map(
          (id) =>
            summary.holdings.find((holding) => holding.securityId === id)
              ?.symbol ?? id,
        )
        .sort(),
      valuationComplete: summary.valuationComplete,
      holdings,
      holdingsByAccount,
      allocation,
      ...(lookThrough ? { lookThrough } : {}),
    };
  }

  /**
   * Get top movers (daily price changes) for held securities
   */
  async getTopMovers(userId: string): Promise<TopMover[]> {
    // Get all open investment accounts
    const accounts = await this.getInvestmentAccounts(userId);
    const { holdingsAccountIds } =
      this.calculationService.categoriseAccounts(accounts);

    if (holdingsAccountIds.length === 0) return [];

    // Get holdings with non-zero quantity
    const holdings = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Holding).find({
        where: { accountId: In(holdingsAccountIds) },
        relations: ["security"],
      }),
    );
    const activeHoldings = holdings.filter(
      (h) =>
        Math.abs(Number(h.quantity)) >= 0.0001 &&
        h.security?.isActive !== false &&
        // Exclude securities with no regular price feed (e.g. GICs). Their only
        // "prices" come from buy/sell transactions, so the latest two closes are
        // a transaction-to-transaction delta, not a daily market move. The
        // date-gap check below misses this when two transactions land on
        // adjacent days, so filter on the flag that marks the security itself.
        h.security?.skipPriceUpdates !== true &&
        // A bond linked to the engine is valued by accrual, every calendar day:
        // that is not a market move, and its row dated today would otherwise
        // decide which session the board shows and push every equity off it.
        isPricedByQuoteProvider(h.security ?? {}),
    );
    if (activeHoldings.length === 0) return [];

    // Get unique security IDs
    const securityIds = [...new Set(activeHoldings.map((h) => h.securityId))];

    // Query the two most recent prices for each security.
    // No weekday filter: crypto and other 24/7 assets can have weekend prices,
    // and the investments page (getLatestPrices) also returns any-day prices.
    // Filtering to weekdays-only caused the widget to show a stale weekday price
    // while the investments page showed a newer weekend price.
    const priceRows: Array<{
      security_id: string;
      close_price: string;
      price_date: string;
      rn: string;
    }> = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT security_id, close_price, price_date, rn FROM (
         SELECT security_id, close_price, price_date,
                ROW_NUMBER() OVER (PARTITION BY security_id ORDER BY price_date DESC) as rn
         FROM security_prices
         WHERE security_id = ANY($1)
       ) sub
       WHERE rn <= 2
       ORDER BY security_id, rn`,
        [securityIds],
      ),
    );

    // Build a map: securityId -> [latest, previous] price points (newest first)
    const priceMap = new Map<string, Array<{ price: number; date: string }>>();
    for (const row of priceRows) {
      const existing = priceMap.get(row.security_id) || [];
      existing.push({ price: Number(row.close_price), date: row.price_date });
      priceMap.set(row.security_id, existing);
    }

    // Aggregate quantity per security (across accounts)
    const quantityMap = new Map<string, number>();
    for (const h of activeHoldings) {
      const qty = quantityMap.get(h.securityId) || 0;
      quantityMap.set(h.securityId, qty + Number(h.quantity));
    }

    // Build movers list
    const movers: TopMover[] = [];
    const securityLookup = new Map(
      activeHoldings.map((h) => [h.securityId, h.security]),
    );

    // The reader's own day decides whether a stored close is the current
    // session, so it is read once for the whole sweep rather than per security.
    const today = todayYMD();

    for (const securityId of securityIds) {
      // Two closes are a daily move only while they are adjacent sessions and
      // the newer one is current; anything else is a real move of some other
      // period, and a mover list has no figure to show for it.
      const change = resolveDailyPriceChange(priceMap.get(securityId), today);
      if (!change) continue;

      const { currentPrice, previousPrice, dailyChange } = change;
      const security = securityLookup.get(securityId);
      const totalQty = quantityMap.get(securityId) || 0;

      movers.push({
        securityId,
        symbol: security?.symbol || "Unknown",
        name: security?.name || "Unknown",
        currencyCode: security?.currencyCode || FALLBACK_DEFAULT_CURRENCY,
        currentPrice,
        previousPrice,
        dailyChange,
        dailyChangePercent: change.dailyChangePercent,
        priceDate: change.priceDate,
        marketValue: currentPrice * totalQty,
        dailyValueChange: roundMoney(dailyChange * totalQty),
      });
    }

    // A board of movers is one session's. A holding that did not price while
    // the others did has no move for the session being ranked, only an earlier
    // one, and ranked beside them it would hold a place on the board for a day
    // that is over -- every morning, until a new price arrives.
    const board = keepNewestSession(movers);

    // Sort by absolute daily change percent descending
    board.sort(
      (a, b) => Math.abs(b.dailyChangePercent) - Math.abs(a.dailyChangePercent),
    );

    return board;
  }

  /**
   * Get month-over-month price movers for held securities.
   * Compares the latest price on or before currentEnd to the latest price
   * on or before previousEnd for each security.
   */
  async getMonthOverMonthMovers(
    userId: string,
    currentEnd: string,
    previousEnd: string,
  ): Promise<TopMover[]> {
    const accounts = await this.getInvestmentAccounts(userId);
    const { holdingsAccountIds } =
      this.calculationService.categoriseAccounts(accounts);

    if (holdingsAccountIds.length === 0) return [];

    const holdings = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Holding).find({
        where: { accountId: In(holdingsAccountIds) },
        relations: ["security"],
      }),
    );
    const activeHoldings = holdings.filter(
      (h) =>
        Math.abs(Number(h.quantity)) >= 0.0001 &&
        h.security?.isActive !== false &&
        // Exclude securities with no regular price feed (e.g. GICs); their only
        // "prices" are buy/sell transactions, not market moves. Same rationale
        // as getTopMovers.
        h.security?.skipPriceUpdates !== true,
    );
    if (activeHoldings.length === 0) return [];

    const securityIds = [...new Set(activeHoldings.map((h) => h.securityId))];

    // For each security, get the latest price on or before each month-end
    const priceRows: Array<{
      security_id: string;
      close_price: string;
      price_date: string | Date;
      period: string;
    }> = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT security_id, close_price, price_date, period FROM (
         SELECT security_id, close_price, price_date, 'current' as period,
                ROW_NUMBER() OVER (PARTITION BY security_id ORDER BY price_date DESC) as rn
         FROM security_prices
         WHERE security_id = ANY($1)
           AND price_date <= $2::DATE
       ) sub WHERE rn = 1
       UNION ALL
       SELECT security_id, close_price, price_date, period FROM (
         SELECT security_id, close_price, price_date, 'previous' as period,
                ROW_NUMBER() OVER (PARTITION BY security_id ORDER BY price_date DESC) as rn
         FROM security_prices
         WHERE security_id = ANY($1)
           AND price_date <= $3::DATE
       ) sub WHERE rn = 1`,
        [securityIds, currentEnd, previousEnd],
      ),
    );

    // Build price maps per security
    const currentPriceMap = new Map<string, number>();
    const previousPriceMap = new Map<string, number>();
    // The close the current side actually used, which is the last one on or
    // before the period end rather than the period end itself.
    const currentDateMap = new Map<string, string>();
    for (const row of priceRows) {
      if (row.period === "current") {
        currentPriceMap.set(row.security_id, Number(row.close_price));
        currentDateMap.set(row.security_id, priceDateYmd(row.price_date));
      } else {
        previousPriceMap.set(row.security_id, Number(row.close_price));
      }
    }

    // Aggregate quantity per security
    const quantityMap = new Map<string, number>();
    for (const h of activeHoldings) {
      const qty = quantityMap.get(h.securityId) || 0;
      quantityMap.set(h.securityId, qty + Number(h.quantity));
    }

    const securityLookup = new Map(
      activeHoldings.map((h) => [h.securityId, h.security]),
    );

    const movers: TopMover[] = [];
    for (const securityId of securityIds) {
      const currentPrice = currentPriceMap.get(securityId);
      const previousPrice = previousPriceMap.get(securityId);
      if (currentPrice == null || previousPrice == null || previousPrice === 0)
        continue;

      const dailyChange = currentPrice - previousPrice;
      const dailyChangePercent = (dailyChange / previousPrice) * 100;
      const security = securityLookup.get(securityId);
      const totalQty = quantityMap.get(securityId) || 0;

      movers.push({
        securityId,
        symbol: security?.symbol || "Unknown",
        name: security?.name || "Unknown",
        currencyCode: security?.currencyCode || FALLBACK_DEFAULT_CURRENCY,
        currentPrice,
        previousPrice,
        dailyChange,
        dailyChangePercent,
        priceDate: currentDateMap.get(securityId) ?? currentEnd,
        marketValue: currentPrice * totalQty,
        dailyValueChange: roundMoney(dailyChange * totalQty),
      });
    }

    movers.sort(
      (a, b) => Math.abs(b.dailyChangePercent) - Math.abs(a.dailyChangePercent),
    );

    return movers;
  }

  /**
   * Compute per-account holdings market value in each account's own currency.
   *
   * Lightweight alternative to getPortfolioSummary() for callers that only need
   * "how much are the holdings worth in this account?" without TWR/CAGR/cost
   * basis. Useful for balance-style queries where an account's current balance
   * should reflect its holdings, not just the cash side.
   *
   * Only brokerage and standalone investment accounts contribute, and only
   * those holding a position in a non-zero quantity: an account that is absent
   * from the map holds nothing, which is zero rather than unknown. An account
   * that is present carries its own completeness (`docs/financial-calculation-
   * contract.md` section 1): `marketValue` is the total only when every held
   * position was priced and converted into the account's currency, and is
   * `null` otherwise, with the partial sum in `knownMarketValueSubtotal` and the
   * unpriced securities and unconverted pairs named beside it.
   */
  async getAccountMarketValues(
    userId: string,
  ): Promise<Map<string, AccountMarketValue>> {
    const accounts = await this.getInvestmentAccounts(userId);
    const { holdingsAccountIds } =
      this.calculationService.categoriseAccounts(accounts);
    if (holdingsAccountIds.length === 0) return new Map();

    const holdings = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Holding).find({
        where: { accountId: In(holdingsAccountIds) },
        relations: ["security"],
      }),
    );
    if (holdings.length === 0) return new Map();

    const securityIds = [...new Set(holdings.map((h) => h.securityId))];
    const priceMap = await this.getLatestPrices(securityIds);
    // A bond-linked holding is worth its own account's lots, never its quantity
    // times the program-wide blend (bond-program-securities.md 2.4).
    const bondValues = await this.calculationService.valueBondHoldings(
      userId,
      holdings,
    );

    const accountCurrency = new Map<string, string>();
    for (const a of accounts) accountCurrency.set(a.id, a.currencyCode);

    const rateCache: FxRateCache = new Map();
    const perAccount = new Map<
      string,
      {
        total: FxAggregate;
        unpriced: Map<string, string>;
      }
    >();
    for (const h of holdings) {
      if (Math.abs(Number(h.quantity)) < 0.0001) continue;
      let entry = perAccount.get(h.accountId);
      if (!entry) {
        entry = { total: new FxAggregate(), unpriced: new Map() };
        perAccount.set(h.accountId, entry);
      }

      let marketValue: number | null;
      if (h.security.bondProgramId) {
        marketValue =
          bondValues.get(`${h.accountId}:${h.securityId}`)?.marketValue ?? null;
      } else {
        const price = priceMap.get(h.securityId);
        marketValue = price == null ? null : Number(h.quantity) * price;
      }
      if (marketValue === null) {
        // Unpriced is unknown, not zero: the account's value is withheld and
        // the security named so the reader can price it.
        entry.total.addUnknown();
        entry.unpriced.set(h.securityId, h.security.symbol);
        continue;
      }

      const securityCurrency = h.security.currencyCode;
      const acctCurrency = accountCurrency.get(h.accountId) ?? securityCurrency;

      // Zero needs no rate.
      const valueInAccountCurrency =
        marketValue === 0
          ? 0
          : await this.calculationService.convertToDefault(
              marketValue,
              securityCurrency,
              acctCurrency,
              rateCache,
            );

      // No rate for this security's currency into the account's: the pair is
      // recorded rather than counting the position at face value in the wrong
      // currency.
      entry.total.add(valueInAccountCurrency, securityCurrency, acctCurrency);
    }

    const result = new Map<string, AccountMarketValue>();
    for (const [accountId, { total, unpriced }] of perAccount) {
      const pricesComplete = unpriced.size === 0;
      const missingRatePairs = total.missingPairs;
      const fxComplete = missingRatePairs.length === 0;
      result.set(accountId, {
        marketValue: total.isComplete ? roundMoney(total.knownSubtotal) : null,
        knownMarketValueSubtotal: roundMoney(total.knownSubtotal),
        pricesComplete,
        unpricedSecurityIds: [...unpriced.keys()].sort(),
        unpricedSymbols: [...unpriced.values()].sort(),
        fxComplete,
        missingRatePairs,
        valuationComplete: pricesComplete && fxComplete,
      });
    }
    return result;
  }

  /**
   * Get asset allocation breakdown
   * Note: This now just extracts the pre-computed allocation from getPortfolioSummary
   * to maintain backwards compatibility. Prefer using summary.allocation directly.
   */
  async getAssetAllocation(
    userId: string,
    accountIds?: string[],
  ): Promise<AssetAllocation> {
    const summary = await this.getPortfolioSummary(userId, accountIds);
    return {
      allocation: summary.allocation,
      totalValue: summary.totalPortfolioValue,
    };
  }

  /**
   * Portfolio "exposure by tag" allocation. Reuses the by-security allocation
   * from the portfolio summary (values already in the default currency), then
   * regroups it by each security's user-defined tags. See
   * `PortfolioCalculationService.buildAllocationByTag` for the multi-tag
   * (overlapping exposure) semantics.
   */
  async getAllocationByTag(
    userId: string,
    accountIds?: string[],
  ): Promise<AssetAllocation> {
    const inputs = await this.loadTaggedAllocationInputs(userId, accountIds);
    const allocation = this.calculationService.buildAllocationByTag(
      inputs.securityItems,
      inputs.tagsBySymbol,
      inputs.totalCashValue,
      inputs.defaultCurrency,
    );
    return { allocation, totalValue: inputs.totalValue };
  }

  /**
   * Portfolio allocation aggregated by the VALUE of a single KEY:VALUE tag key
   * (e.g. key `country` -> slices per country). See
   * `PortfolioCalculationService.buildAllocationByTagKey` for the value-weighted
   * (overlapping) semantics.
   */
  async getAllocationByTagKey(
    userId: string,
    key: string,
    accountIds?: string[],
  ): Promise<AssetAllocation> {
    const inputs = await this.loadTaggedAllocationInputs(userId, accountIds);
    const allocation = this.calculationService.buildAllocationByTagKey(
      inputs.securityItems,
      inputs.tagsBySymbol,
      inputs.totalCashValue,
      inputs.defaultCurrency,
      key,
    );
    return { allocation, totalValue: inputs.totalValue };
  }

  /**
   * What the chart's grouping switcher needs to know about tags, in one query:
   * whether any held security carries a tag at all, and the distinct KEY:VALUE
   * tag keys among them (case-folded and sorted).
   *
   * This used to compute the whole portfolio valuation and read the tag names
   * off it -- a three-second request whose only output was a list of names.
   * Which tags are in use is a question about the holdings and their tags, and
   * nothing else: no price, no exchange rate, no cost basis. A tag key is also
   * not withheld because a holding is unpriced or has no rate into the
   * reporting currency, which the valuation-based path did silently (the
   * allocation drops an unvalued slice), so a user whose feed was late lost the
   * grouping switcher along with the number.
   */
  async getPortfolioTagSummary(
    userId: string,
    accountIds?: string[],
  ): Promise<{ keys: string[]; hasTaggedHoldings: boolean }> {
    const names = await this.loadHeldTagNames(userId, accountIds);
    return { keys: collectTagKeys(names), hasTaggedHoldings: names.length > 0 };
  }

  /**
   * Distinct KEY:VALUE tag keys present on the portfolio's securities, so the
   * UI can offer "aggregate by key" choices. Case-folded and sorted.
   */
  async getPortfolioTagKeys(
    userId: string,
    accountIds?: string[],
  ): Promise<string[]> {
    return (await this.getPortfolioTagSummary(userId, accountIds)).keys;
  }

  /**
   * The names of the tags carried by the securities currently held in the
   * scope, distinct and sorted.
   *
   * "Held" is the same predicate the valuation uses -- `|quantity| >= 0.0001`,
   * spelled here in SQL -- so a security that has been sold out of every
   * account in the scope contributes no tag, exactly as before.
   */
  private async loadHeldTagNames(
    userId: string,
    accountIds?: string[],
  ): Promise<string[]> {
    const accounts = await this.resolveAccounts(userId, accountIds);
    const { holdingsAccountIds } =
      this.calculationService.categoriseAccounts(accounts);
    if (holdingsAccountIds.length === 0) return [];

    const rows: Array<{ name: string }> = await withScopedDb(
      this.dataSource,
      (m) =>
        m.query(
          `SELECT DISTINCT t.name AS name
             FROM holdings h
             JOIN securities s ON s.id = h.security_id
             JOIN security_tags st ON st.security_id = s.id
             JOIN tags t ON t.id = st.tag_id
            WHERE h.account_id = ANY($1)
              AND s.user_id = $2
              AND ABS(h.quantity) >= 0.0001
            ORDER BY t.name ASC`,
          [holdingsAccountIds, userId],
        ),
    );
    return rows.map((r) => r.name);
  }

  /**
   * Shared prep for the by-tag / by-tag-key allocation views: the per-security
   * slices (values already in the default currency), the cash total, the
   * default currency, and each security's tags keyed by symbol.
   */
  private async loadTaggedAllocationInputs(
    userId: string,
    accountIds?: string[],
  ): Promise<{
    securityItems: AllocationItem[];
    totalCashValue: number;
    defaultCurrency: string;
    tagsBySymbol: Map<
      string,
      Array<{ id: string; name: string; color: string | null }>
    >;
    totalValue: number;
  }> {
    const summary = await this.getPortfolioSummary(userId, accountIds);
    const securityItems = summary.allocation.filter(
      (a) => a.type === "security",
    );
    const cashItem = summary.allocation.find((a) => a.type === "cash");
    const totalCashValue = cashItem?.value ?? 0;
    const defaultCurrency =
      cashItem?.currencyCode ??
      securityItems[0]?.currencyCode ??
      (await this.resolveDefaultCurrency(userId));

    const symbols = securityItems
      .map((i) => i.symbol)
      .filter((s): s is string => Boolean(s));
    const tagsBySymbol = await this.loadTagsBySymbol(userId, symbols);

    return {
      securityItems,
      totalCashValue,
      defaultCurrency,
      tagsBySymbol,
      totalValue: summary.totalPortfolioValue,
    };
  }

  /**
   * The user's default display currency, through the one shared reader so this
   * surface reports in the same currency as every other one.
   */
  private resolveDefaultCurrency(userId: string): Promise<string> {
    return resolveUserDefaultCurrency(this.dataSource, userId);
  }

  /**
   * Load the user's tags for the given security symbols, keyed by symbol.
   * Symbols are unique per user, so a symbol maps to exactly one security.
   */
  private async loadTagsBySymbol(
    userId: string,
    symbols: string[],
  ): Promise<
    Map<string, Array<{ id: string; name: string; color: string | null }>>
  > {
    const result = new Map<
      string,
      Array<{ id: string; name: string; color: string | null }>
    >();
    if (symbols.length === 0) return result;

    const rows: Array<{
      symbol: string;
      id: string;
      name: string;
      color: string | null;
    }> = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT s.symbol AS symbol, t.id AS id, t.name AS name, t.color AS color
         FROM securities s
         JOIN security_tags st ON st.security_id = s.id
         JOIN tags t ON t.id = st.tag_id
        WHERE s.user_id = $1 AND s.symbol = ANY($2)
        ORDER BY t.name ASC`,
        [userId, symbols],
      ),
    );

    for (const row of rows) {
      const arr = result.get(row.symbol);
      const tag = { id: row.id, name: row.name, color: row.color };
      if (arr) {
        arr.push(tag);
      } else {
        result.set(row.symbol, [tag]);
      }
    }
    return result;
  }

  /**
   * Intraday portfolio value series for the 1D / 1W / 1M chart ranges. Sums the
   * per-security and cash contributions loaded by {@link loadIntradayData} into
   * a single total per grid bar.
   *
   * Results are cached in-memory for 60 seconds keyed by
   * `userId|range|accountIds|currency` (via loadIntradayData) to absorb double
   * clicks and the frontend's optimistic refresh.
   */
  async getIntradayValueSeries(
    userId: string,
    query: {
      range: IntradayRangeKey;
      accountIds?: string[];
      displayCurrency?: string;
    },
  ): Promise<IntradayValueResponse> {
    const loaded = await this.loadIntradayData(userId, query);
    const meta = {
      interval: loaded.interval,
      currency: loaded.currency,
      range: loaded.range,
      fetchedAt: loaded.fetchedAt,
      skippedSymbols: loaded.skippedSymbols,
      failedSymbols: loaded.failedSymbols,
      fallbackToDaily: loaded.fallbackToDaily,
    };

    if (loaded.timestamps.length === 0) {
      return {
        points: [],
        ...this.intradayCompleteness([], new Set(), new Set()),
        ...meta,
      };
    }

    const fxAt = this.makeIntradayFxAt(loaded);
    const cursors = loaded.sources.map(() => -1);
    const points: IntradayValuePoint[] = [];

    // Pairs no rate could be resolved for at any bar. A contribution with no
    // rate is omitted rather than valued at 1:1 (audit P5-009), and named once
    // at the end rather than per bar.
    const unratedCurrencies = new Set<string>();
    // The same, for the bar being built: it decides that point's `fxComplete`.
    const barUnrated = new Set<string>();
    const contribution = this.makeIntradayContribution(
      fxAt,
      unratedCurrencies,
      barUnrated,
    );
    const positionsAt = this.makeIntradayPositionsAt(loaded);
    // What the points could not value, for the response's own lists.
    const missingPairs = new Set<string>();
    const unpricedIds = new Set<string>();

    for (const ts of loaded.timestamps) {
      // A finished session's closing point IS the daily series' figure for
      // the day: same closes, same rates, same cash (INV-INTRADAY-001).
      const closeDay = loaded.sessionCloses.get(ts);
      if (closeDay !== undefined && loaded.ledgerDays) {
        const { daily } = loaded.ledgerDays[closeDay];
        points.push({
          timestamp: new Date(ts).toISOString(),
          value: daily.value,
          securitiesValue: daily.securitiesValue,
          fxComplete: daily.fxComplete,
          pricesComplete: daily.pricesComplete,
          cashComplete: daily.cashComplete,
          sessionClose: true,
        });
        daily.missingRatePairs.forEach((pair) => missingPairs.add(pair));
        daily.unpricedSecurityIds.forEach((id) => unpricedIds.add(id));
        continue;
      }
      barUnrated.clear();
      const at = positionsAt(ts);
      let totalCents = 0; // integer arithmetic to avoid float drift
      // The INVESTED part of the same bar: the securities, with the cash
      // beside them left out. The investment charts plot it, because cash held
      // in an investment account is not an investment (INV-PORTRESULT-002,
      // `docs/specs/portfolio-period-result.md` section 10.7), and the daily
      // and monthly series expose the same component under the same name.
      let securitiesCents = 0;
      // Cash contributions, valued at the FX rate prevailing at this bar.
      for (const [ccy, amount] of at.cash) {
        totalCents += contribution(amount, ccy, ts);
      }
      // Holdings with no bars (daily close * quantity), grouped by currency so
      // the per-currency rounding matches the historical total.
      const closeValuedByCurrency = new Map<string, number>();
      for (const h of at.closeValued) {
        closeValuedByCurrency.set(
          h.currencyCode,
          (closeValuedByCurrency.get(h.currencyCode) ?? 0) + h.amount,
        );
      }
      for (const [ccy, amount] of closeValuedByCurrency) {
        const cents = contribution(amount, ccy, ts);
        totalCents += cents;
        securitiesCents += cents;
      }
      for (let i = 0; i < loaded.sources.length; i++) {
        const src = loaded.sources[i];
        cursors[i] = this.advanceIntradayCursor(src.times, cursors[i], ts);
        const price = this.intradayPriceAt(src, cursors[i], ts);
        const quantity = at.quantityOf(src.securityId, src.quantity);
        const cents = contribution(quantity * price, src.currencyCode, ts);
        totalCents += cents;
        securitiesCents += cents;
      }
      at.unpricedSecurityIds.forEach((id) => unpricedIds.add(id));
      points.push({
        timestamp: new Date(ts).toISOString(),
        value: totalCents / 10000,
        securitiesValue: securitiesCents / 10000,
        fxComplete: barUnrated.size === 0,
        pricesComplete: at.unpricedSecurityIds.length === 0,
        // A live bar's cash is the day's ledger balance or today's: it is
        // never a cash account that produced no row.
        cashComplete: true,
      });
    }

    if (unratedCurrencies.size > 0) {
      this.logger.warn(
        `Intraday series omits holdings in ${[...unratedCurrencies].sort().join(", ")}: no exchange rate into ${loaded.currency}`,
      );
    }
    for (const ccy of unratedCurrencies) {
      missingPairs.add(`${ccy}->${loaded.currency}`);
    }

    return {
      points,
      ...this.intradayCompleteness(points, missingPairs, unpricedIds),
      ...meta,
    };
  }

  /**
   * The response-level completeness of an intraday series, over every point: the
   * three per-point bits, their conjunction, and the pairs and securities behind
   * them. An empty series has nothing missing, which is true and empty rather
   * than unknown.
   */
  private intradayCompleteness(
    points: ReadonlyArray<{
      fxComplete: boolean;
      pricesComplete: boolean;
      cashComplete: boolean;
    }>,
    missingPairs: ReadonlySet<string>,
    unpricedIds: ReadonlySet<string>,
  ): Pick<
    IntradayValueResponse,
    | "fxComplete"
    | "pricesComplete"
    | "valuationComplete"
    | "missingRatePairs"
    | "unpricedSecurityIds"
  > {
    return {
      fxComplete: points.every((p) => p.fxComplete),
      pricesComplete: points.every((p) => p.pricesComplete),
      valuationComplete: points.every(
        (p) => p.fxComplete && p.pricesComplete && p.cashComplete,
      ),
      missingRatePairs: [...missingPairs].sort(),
      unpricedSecurityIds: [...unpricedIds].sort(),
    };
  }

  /**
   * Per-security intraday series for the Portfolio Value Over Time report's "by
   * security" view. Shares {@link loadIntradayData} (and its cache) with the
   * total-value series, then values each holding individually so the bands
   * stack up to the total. The top `limit` securities (by peak contribution)
   * keep their own band; the rest roll into a single "other" band, with cash
   * as its own aggregate band.
   */
  async getIntradayBreakdown(
    userId: string,
    query: {
      range: IntradayRangeKey;
      accountIds?: string[];
      displayCurrency?: string;
      limit?: number;
    },
  ): Promise<IntradayBreakdownResponse> {
    const loaded = await this.loadIntradayData(userId, query);
    const meta = {
      interval: loaded.interval,
      currency: loaded.currency,
      range: loaded.range,
      fetchedAt: loaded.fetchedAt,
      skippedSymbols: loaded.skippedSymbols,
      failedSymbols: loaded.failedSymbols,
      fallbackToDaily: loaded.fallbackToDaily,
    };

    if (loaded.timestamps.length === 0) {
      return {
        series: [],
        points: [],
        ...this.intradayCompleteness([], new Set(), new Set()),
        ...meta,
      };
    }

    const fxAt = this.makeIntradayFxAt(loaded);
    const cursors = loaded.sources.map(() => -1);
    const n = loaded.timestamps.length;

    // Per-security value arrays (display currency) plus the aggregate cash band.
    const secValues = new Map<string, number[]>();
    const secMeta = new Map<string, { symbol: string; name: string }>();
    const cash = new Array<number>(n).fill(0);
    const unratedCurrencies = new Set<string>();
    // The bar being built, for each point's `fxComplete`.
    const barUnrated = new Set<string>();
    const contribution = this.makeIntradayContribution(
      fxAt,
      unratedCurrencies,
      barUnrated,
    );
    const barFlags: IntradayBarFlags[] = [];
    const missingPairs = new Set<string>();
    const unpricedIds = new Set<string>();

    const ensureSec = (id: string, symbol: string, name: string) => {
      if (!secValues.has(id)) {
        secValues.set(id, new Array<number>(n).fill(0));
        secMeta.set(id, { symbol, name });
      }
    };

    const positionsAt = this.makeIntradayPositionsAt(loaded);
    // Every held security gets its band up front, so a finished session's
    // closing point can fill any of them.
    for (const src of loaded.sources) {
      ensureSec(src.securityId, src.symbol, src.name);
    }
    for (const h of loaded.closeValued) {
      ensureSec(h.securityId, h.symbol, h.name);
    }

    for (let ti = 0; ti < n; ti++) {
      const ts = loaded.timestamps[ti];
      // A finished session's closing point carries each position at the close
      // the daily series valued it at, and the day's cash (INV-INTRADAY-001).
      const closeDay = loaded.sessionCloses.get(ts);
      if (closeDay !== undefined && loaded.ledgerDays) {
        const { daily, positions } = loaded.ledgerDays[closeDay];
        cash[ti] = roundMoney(daily.value - daily.securitiesValue);
        for (const [id, value] of positions.closeValues) {
          if (value === null || !secValues.has(id)) continue;
          secValues.get(id)![ti] = value;
        }
        barFlags.push({
          fxComplete: daily.fxComplete,
          pricesComplete: daily.pricesComplete,
          cashComplete: daily.cashComplete,
        });
        daily.missingRatePairs.forEach((pair) => missingPairs.add(pair));
        daily.unpricedSecurityIds.forEach((id) => unpricedIds.add(id));
        continue;
      }
      barUnrated.clear();
      const at = positionsAt(ts);
      let cashCents = 0;
      for (const [ccy, amount] of at.cash) {
        cashCents += contribution(amount, ccy, ts);
      }
      cash[ti] = cashCents / 10000;
      // Holdings with no bars keep their own band, unlike the total series
      // which only needs a per-currency subtotal.
      for (const h of at.closeValued) {
        ensureSec(h.securityId, h.symbol, h.name);
        secValues.get(h.securityId)![ti] =
          contribution(h.amount, h.currencyCode, ts) / 10000;
      }
      for (let i = 0; i < loaded.sources.length; i++) {
        const src = loaded.sources[i];
        cursors[i] = this.advanceIntradayCursor(src.times, cursors[i], ts);
        const price = this.intradayPriceAt(src, cursors[i], ts);
        const quantity = at.quantityOf(src.securityId, src.quantity);
        secValues.get(src.securityId)![ti] =
          contribution(quantity * price, src.currencyCode, ts) / 10000;
      }
      at.unpricedSecurityIds.forEach((id) => unpricedIds.add(id));
      barFlags.push({
        fxComplete: barUnrated.size === 0,
        pricesComplete: at.unpricedSecurityIds.length === 0,
        cashComplete: true,
      });
    }

    if (unratedCurrencies.size > 0) {
      this.logger.warn(
        `Intraday breakdown omits holdings in ${[...unratedCurrencies].sort().join(", ")}: no exchange rate into ${loaded.currency}`,
      );
    }
    for (const ccy of unratedCurrencies) {
      missingPairs.add(`${ccy}->${loaded.currency}`);
    }

    const { series, points } = this.groupIntradayBreakdown(
      loaded.timestamps,
      secValues,
      secMeta,
      cash,
      query.limit ?? 10,
      loaded.sessionCloses,
      barFlags,
    );
    return {
      series,
      points,
      ...this.intradayCompleteness(points, missingPairs, unpricedIds),
      ...meta,
    };
  }

  /**
   * What the scope held at grid bar `ts`: the share count per security, the
   * cash per currency, and the holdings valued at a daily close.
   *
   * With the ledger these are the positions at the close of the bar's own UTC
   * day (INV-INTRADAY-001); a bar on a day the fold did not reach takes the
   * latest day before it. Without it (no investment account to replay) they
   * are today's, which is all the legacy path ever knew. Bars must be asked
   * for in ascending order: the lookup keeps a cursor.
   */
  private makeIntradayPositionsAt(
    loaded: IntradayLoaded,
  ): (ts: number) => IntradayBarPositions {
    const days = loaded.ledgerDays;
    if (!days) {
      const legacy: IntradayBarPositions = {
        quantityOf: (_id, todayQuantity) => todayQuantity,
        cash: loaded.cashByCurrency,
        closeValued: loaded.staleSources,
        unpricedSecurityIds: loaded.unpricedSecurityIds,
      };
      return () => legacy;
    }
    let cursor = -1;
    let lastCursor = -2;
    let lastAnswer: IntradayBarPositions = {
      quantityOf: () => 0,
      cash: [],
      closeValued: [],
      unpricedSecurityIds: [],
    };
    return (ts: number) => {
      const date = formatDateYMD(new Date(ts));
      while (cursor + 1 < days.length && days[cursor + 1].date <= date) {
        cursor++;
      }
      if (cursor === lastCursor) return lastAnswer;
      lastCursor = cursor;
      if (cursor < 0) {
        // Before the first day the fold reached: nothing is known to be held.
        return lastAnswer;
      }
      const { positions } = days[cursor];
      const closeValued: IntradayBarPositions["closeValued"] = [];
      const unpricedSecurityIds: string[] = [];
      for (const h of loaded.closeValued) {
        const quantity = positions.quantities.get(h.securityId) ?? 0;
        const close = positions.closes.get(h.securityId);
        if (Math.abs(quantity) < LEDGER_QUANTITY_EPSILON) continue;
        // An unpriced position is unknown, not zero; it is left out as the
        // daily fold leaves it out, and reported (`pricesComplete`).
        if (close == null) {
          unpricedSecurityIds.push(h.securityId);
          continue;
        }
        closeValued.push({ ...h, amount: quantity * close });
      }
      lastAnswer = {
        quantityOf: (id) => positions.quantities.get(id) ?? 0,
        cash: [...positions.cashByCurrency],
        closeValued,
        unpricedSecurityIds,
      };
      return lastAnswer;
    };
  }

  /** Advance a forward-fill cursor to the latest sample at or before `ts`. */
  private advanceIntradayCursor(
    times: number[],
    cursor: number,
    ts: number,
  ): number {
    let c = cursor;
    while (c + 1 < times.length && times[c + 1] <= ts) c++;
    return c;
  }

  /**
   * Price for one holding at grid bar `ts` given its forward-fill cursor.
   * Backfills unstarted series at their first open, and uses the first bar's
   * open (not close) at the very first bar so the chart's starting value
   * matches the day's official opening price.
   */
  private intradayPriceAt(
    src: {
      times: number[];
      opens: Array<number | null | undefined>;
      closes: number[];
    },
    cursor: number,
    ts: number,
  ): number {
    if (cursor < 0) return src.opens[0] ?? src.closes[0];
    const atFirstBar =
      cursor === 0 && ts === src.times[0] && src.opens[0] != null;
    if (atFirstBar) return src.opens[0] as number;
    return src.closes[cursor];
  }

  /**
   * Value one contribution in ten-thousandths of the display currency.
   *
   * Returns 0 and records the currency when no rate could be resolved for the
   * bar: a holding whose pair has no rate is left out of the series rather than
   * valued at its face number, which is what an implicit 1:1 did. `unrated`
   * collects the currencies over the whole series (for the warning and the
   * response's pairs); `barUnrated` collects them for the bar being built (for
   * the point's `fxComplete`). Shared by the
   * total series and the per-security breakdown so the two cannot disagree
   * about which bars a currency contributed to.
   */
  private makeIntradayContribution(
    fxAt: (currency: string, ts: number) => number | null,
    unrated: Set<string>,
    barUnrated?: Set<string>,
  ): (amount: number, currency: string, ts: number) => number {
    return (amount: number, currency: string, ts: number): number => {
      const rate = fxAt(currency, ts);
      if (rate === null) {
        unrated.add(currency);
        // The caller clears this set at the start of each bar, so it says which
        // contributions of THIS bar were left out.
        barUnrated?.add(currency);
        return 0;
      }
      return Math.round(amount * rate * 10000);
    };
  }

  /**
   * Build a fresh FX lookup over the loaded intraday/daily rate series. Each
   * call owns its cursor state, so the total-value and breakdown views can each
   * walk the (ascending) grid independently. See the original inline notes:
   * live intraday bar at-or-before `ts` wins, else the stored daily close for
   * that bar's date, else the latest spot.
   */
  private makeIntradayFxAt(
    loaded: IntradayLoaded,
  ): (currency: string, ts: number) => number | null {
    const display = loaded.currency;
    const cursors = new Map<string, number>();
    const dailyRateCache = new Map<string, number | undefined>();
    const dailyFxAt = (currency: string, ts: number): number | undefined => {
      const dateStr = formatDateYMD(new Date(ts));
      const memoKey = `${currency}|${dateStr}`;
      if (dailyRateCache.has(memoKey)) return dailyRateCache.get(memoKey);
      const rate = this.calculationService.resolveDailyRate(
        loaded.dailyRateIndex,
        currency,
        display,
        dateStr,
      );
      dailyRateCache.set(memoKey, rate);
      return rate;
    };
    // `null` means "no rate for this pair", never 1. Rate 1 is returned only
    // when the currency already IS the display currency.
    return (currency: string, ts: number): number | null => {
      if (currency === display) return 1;
      const fx = loaded.fxByCurrency.get(currency);
      if (!fx) return loaded.spotRate.get(`${currency}->${display}`) ?? null;
      if (fx.times.length > 0) {
        let c = cursors.get(currency) ?? -1;
        while (c + 1 < fx.times.length && fx.times[c + 1] <= ts) c++;
        cursors.set(currency, c);
        if (c >= 0) return fx.rates[c];
      }
      return dailyFxAt(currency, ts) ?? fx.latest;
    };
  }

  /**
   * Rank securities by peak contribution, keep the top `limit` as their own
   * bands, roll the rest into a single "other" band, and append a cash band
   * when any cash is present. Values are rounded to 4 decimals to match the
   * intraday total series' precision.
   */
  private groupIntradayBreakdown(
    timestamps: number[],
    secValues: Map<string, number[]>,
    secMeta: Map<string, { symbol: string; name: string }>,
    cash: number[],
    limit: number,
    sessionCloses: ReadonlyMap<number, number>,
    barFlags: ReadonlyArray<IntradayBarFlags>,
  ): { series: IntradayBreakdownSeries[]; points: IntradayBreakdownPoint[] } {
    const peak = new Map<string, number>();
    for (const [id, arr] of secValues) {
      let p = 0;
      for (const v of arr) if (Math.abs(v) > Math.abs(p)) p = v;
      peak.set(id, p);
    }

    const ranked = [...peak.entries()]
      .filter(([, v]) => Math.abs(v) >= 0.005)
      .sort((a, b) => {
        const diff = Math.abs(b[1]) - Math.abs(a[1]);
        if (diff !== 0) return diff;
        const an = secMeta.get(a[0])?.name ?? "";
        const bn = secMeta.get(b[0])?.name ?? "";
        return an.localeCompare(bn);
      })
      .map(([id]) => id);

    const topIds = ranked.slice(0, limit);
    const otherIds = ranked.slice(limit);
    const hasOther = otherIds.length > 0;
    const hasCash = cash.some((v) => Math.abs(v) >= 0.005);

    const series: IntradayBreakdownSeries[] = topIds.map((id) => {
      const m = secMeta.get(id);
      return {
        key: id,
        type: "security",
        symbol: m?.symbol ?? null,
        name: m?.name ?? m?.symbol ?? id,
      };
    });
    if (hasOther)
      series.push({ key: "other", type: "other", symbol: null, name: "" });
    if (hasCash)
      series.push({ key: "cash", type: "cash", symbol: null, name: "" });

    const round4 = (v: number) => Math.round(v * 10000) / 10000;
    const points: IntradayBreakdownPoint[] = timestamps.map((ts, ti) => {
      const values: Record<string, number> = {};
      let total = 0;
      for (const id of topIds) {
        const v = round4(secValues.get(id)![ti]);
        values[id] = v;
        total += v;
      }
      if (hasOther) {
        let sum = 0;
        for (const id of otherIds) sum += secValues.get(id)![ti];
        const v = round4(sum);
        values.other = v;
        total += v;
      }
      if (hasCash) {
        const v = round4(cash[ti]);
        values.cash = v;
        total += v;
      }
      return {
        timestamp: new Date(ts).toISOString(),
        total: round4(total),
        values,
        ...barFlags[ti],
        ...(sessionCloses.has(ts) ? { sessionClose: true as const } : {}),
      };
    });

    return { series, points };
  }

  /**
   * Load and cache all intraday inputs (Yahoo price + FX fetches, cash, the
   * unified time grid) for a range. Shared by {@link getIntradayValueSeries}
   * and {@link getIntradayBreakdown} so a portfolio is fetched from Yahoo once
   * per 60-second window regardless of which view(s) the frontend requests.
   */
  private async loadIntradayData(
    userId: string,
    query: {
      range: IntradayRangeKey;
      accountIds?: string[];
      displayCurrency?: string;
    },
  ): Promise<IntradayLoaded> {
    const { range, accountIds } = query;
    const pref = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    const displayCurrency = query.displayCurrency || preferredCurrency(pref);

    // The window is a span of the user's calendar, as the client and the
    // period-result service date it: after 20:00 in Toronto the UTC date is
    // already tomorrow, and a UTC "today" opened 1W and 1M a day late.
    const today = todayYMD();
    const cacheKey = this.buildIntradayCacheKey(
      userId,
      range,
      accountIds,
      displayCurrency,
      today,
    );
    const now = Date.now();
    const cached = this.intradayCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.loaded;
    }

    const yahooParams = RANGE_TO_YAHOO[range];

    const accounts = await this.resolveAccounts(userId, accountIds);
    const { cashAccounts, standaloneAccounts, holdingsAccountIds } =
      this.calculationService.categoriseAccounts(accounts);

    const userDefaultProvider = pref?.defaultQuoteProvider ?? null;
    const toIntradayHolding = (
      security: Security,
      quantity: number,
      fetchIntraday: boolean,
    ): IntradayHolding => {
      // Resolve the security's primary quote provider; only providers that
      // implement fetchIntradaySeries can contribute to this chart. MSN Money
      // does not expose intraday quotes -- see the note in the user
      // preferences UI under "Default Stock Quote Provider".
      const [primaryProvider] = this.quoteProviderRegistry.resolveForSecurity(
        security,
        userDefaultProvider,
      );
      // A bond-linked security has no quote feed: it is valued at its stored
      // closes (the bond engine's), like an inactive one (INV-BOND-005).
      const providerPriced = isPricedByQuoteProvider(security);
      return {
        securityId: security.id,
        symbol: security.symbol,
        name: security.name,
        exchange: security.exchange,
        currencyCode: security.currencyCode,
        quantity,
        hasIntraday: typeof primaryProvider.fetchIntradaySeries === "function",
        fetchIntraday: fetchIntraday && providerPriced,
      };
    };

    // Every bar is valued at the positions held at the close of its own day,
    // from the fold the daily series is built by (INV-INTRADAY-001).
    const window = intradayWindow(range, today);
    const ledger = await this.loadIntradayLedger(
      userId,
      window?.measuredFrom ?? addDaysYMD(today, -LEDGER_1D_LOOKBACK_DAYS),
      accountIds,
      displayCurrency,
      today,
    );

    let activeHoldings: IntradayHolding[] = [];
    // Without the ledger: held securities no bar can value, so every live bar
    // is short of them (`IntradayLoaded.unpricedSecurityIds`).
    const legacyUnpriced = new Set<string>();
    if (ledger) {
      // Every security held on any day of the window, not only today: a
      // position sold mid-window keeps its bars up to the sale. An inactive
      // security has no quote feed, so it is valued at its stored closes, as
      // the daily series values it.
      const latest = ledger.days[ledger.days.length - 1].positions.quantities;
      const held = new Set<string>();
      for (const day of ledger.days) {
        for (const [id, qty] of day.positions.quantities) {
          if (Math.abs(qty) >= LEDGER_QUANTITY_EPSILON) held.add(id);
        }
      }
      for (const id of held) {
        const security = ledger.securities.get(id);
        if (!security) continue;
        activeHoldings.push(
          toIntradayHolding(
            security,
            latest.get(id) ?? 0,
            security.isActive !== false,
          ),
        );
      }
    } else if (holdingsAccountIds.length > 0) {
      const holdings = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Holding).find({
          where: { accountId: In(holdingsAccountIds) },
          relations: ["security"],
        }),
      );

      const aggregated = new Map<string, IntradayHolding>();
      for (const h of holdings) {
        const qty = Number(h.quantity);
        if (!h.security) continue;
        if (Math.abs(qty) < 0.0001) continue;
        if (h.security.isActive === false) {
          // Held, but with no quote feed to value it by: left out, not zero.
          legacyUnpriced.add(h.securityId);
          continue;
        }
        const existing = aggregated.get(h.securityId);
        if (existing) {
          existing.quantity += qty;
        } else {
          aggregated.set(
            h.securityId,
            toIntradayHolding(h.security, qty, true),
          );
        }
      }
      activeHoldings = [...aggregated.values()];
      // A bond-linked holding has no quote feed and, without the ledger, no
      // stored-close valuation either: it is dropped from every bar.
      for (const h of activeHoldings) {
        if (!h.fetchIntraday) legacyUnpriced.add(h.securityId);
      }
    }

    const fetchedAt = new Date().toISOString();
    const skippedSymbols = activeHoldings
      .filter((h) => h.fetchIntraday && !h.hasIntraday)
      .map((h) => h.symbol);

    // When any holding's provider lacks intraday support (MSN Money), do not
    // render a partial intraday chart — it would hide a material chunk of the
    // portfolio's value. The frontend uses this flag to:
    //   - 1W / 1M: silently fall back to the existing daily-snapshot endpoint.
    //   - 1D    : show a note explaining intraday is unavailable for this mix
    //             of holdings (no sensible daily-resolution fallback for a
    //             single day's series).
    const fallbackToDaily = skippedSymbols.length > 0;

    // Shape a "no series" result (empty holdings / skip-fallback / all-failed)
    // with the given availability flags.
    const emptyLoaded = (
      overrides: Partial<
        Pick<IntradayLoaded, "failedSymbols" | "fallbackToDaily">
      >,
    ): IntradayLoaded => ({
      interval: yahooParams.interval,
      currency: displayCurrency,
      range,
      fetchedAt,
      skippedSymbols,
      failedSymbols: [],
      fallbackToDaily,
      timestamps: [],
      sources: [],
      staleSources: [],
      cashByCurrency: [],
      fxByCurrency: new Map(),
      dailyRateIndex: new Map() as DailyRateIndex,
      spotRate: new Map(),
      ledgerDays: null,
      sessionCloses: new Map(),
      closeValued: [],
      unpricedSecurityIds: [],
      ...overrides,
    });

    if (activeHoldings.length === 0 || fallbackToDaily) {
      const loaded = emptyLoaded({});
      this.intradayCache.set(cacheKey, {
        expiresAt: now + INTRADAY_CACHE_TTL_MS,
        loaded,
      });
      return loaded;
    }

    const intradayHoldings = activeHoldings.filter((h) => h.fetchIntraday);
    const seriesBySecurity = new Map<string, IntradayPoint[]>();
    const failedSymbols: string[] = [];
    const intervalCandidates = [yahooParams, ...RANGE_FALLBACKS[range]];
    await mapWithConcurrency(
      intradayHoldings,
      INTRADAY_FETCH_CONCURRENCY,
      async (h) => {
        // Try the primary interval first, then any range-specific
        // fallbacks (e.g. 1m -> 5m for 1D). The first non-empty series
        // wins; silently degrade to coarser bars rather than treating it
        // as a failure when the primary interval is spotty.
        let points: IntradayPoint[] | null = null;
        for (const params of intervalCandidates) {
          try {
            points = await this.yahooFinanceService.fetchIntradaySeries(
              h.symbol,
              h.exchange,
              params,
            );
            if (points && points.length > 0) break;
          } catch (error) {
            this.logger.warn(
              `Failed to fetch intraday series for ${h.symbol} at ${params.interval}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        if (points && points.length > 0) {
          seriesBySecurity.set(h.securityId, points);
        } else {
          failedSymbols.push(h.symbol);
        }
      },
    );

    // If literally every holding failed we have nothing to chart -- assume
    // a real upstream outage and fall back to daily for the whole series.
    // We deliberately do NOT cache this failure result: caching it would
    // leave the "Couldn't load intraday prices" banner pinned on screen
    // even after the user clicks Refresh and the issue resolves.
    // The same holds when nothing held has a quote feed at all (only inactive
    // securities): there is no intraday grid to value them on.
    if (seriesBySecurity.size === 0) {
      return emptyLoaded({ failedSymbols, fallbackToDaily: true });
    }

    // Build the unified time grid from the union of all timestamps.
    const timestampSet = new Set<number>();
    for (const series of seriesBySecurity.values()) {
      for (const p of series) timestampSet.add(p.timestamp.getTime());
    }
    let timestamps = [...timestampSet].sort((a, b) => a - b);

    // Trim to the window the range names (`intradayWindow`). Yahoo's range
    // parameter is approximate (e.g. "1mo" excludes the calendar-month
    // boundary date), so we over-fetched above and now drop any bars that
    // fall before the window; the bars before it are kept aside, because the
    // close the window is measured from may be among them.
    const fetchedBars = timestamps;
    if (window) {
      const cutoffMs = Date.parse(`${window.windowStart}T00:00:00.000Z`);
      timestamps = timestamps.filter((ts) => ts >= cutoffMs);
    }

    // Each finished session ends on the daily series' own figure for the day,
    // one grid step after its last bar (INV-INTRADAY-001).
    const step = this.gridStep(timestamps, yahooParams.interval);
    const sessionCloses = ledger
      ? this.planSessionCloses(timestamps, ledger.days, step, now)
      : new Map<number, number>();

    // The series opens on the close the range is measured from, which is
    // where the period-result service opens the same range.
    const opening =
      ledger && window
        ? await this.planOpeningClose({
            userId,
            accountIds:
              accountIds && accountIds.length > 0
                ? accounts.map((a) => a.id)
                : undefined,
            measuredFrom: window.measuredFrom,
            days: ledger.days,
            fetchedBars,
            windowBars: timestamps,
            step,
            sessionCloses,
            // Compared with the bars' own (UTC) dates, not the user's calendar.
            today: formatDateYMD(new Date(now)),
          })
        : null;
    if (opening) {
      sessionCloses.set(opening.ts, opening.dayIndex);
      // The measured-from day's own bars precede the close it is measured
      // from: a 1M window opening on a session shows that session's close,
      // not its morning.
      timestamps = timestamps.filter((ts) => ts > opening.ts);
    } else if (range === "1m") {
      // No close to open on (the day's figure is a subtotal, nothing priced,
      // no ledger). The month is still measured from a close, so it opens on
      // its first session's last bar rather than partway through the morning,
      // as it always has; the caption above names the session it has.
      timestamps = this.keepLastBarOfFirstDay(timestamps);
    }
    timestamps = [...timestamps, ...sessionCloses.keys()].sort((a, b) => a - b);

    // Cash held in the user's investment cash and standalone accounts is
    // part of the portfolio value just like holdings -- the daily-snapshot
    // endpoint already includes it (see net-worth.service.getDailyInvestments)
    // and we mirror that here so the 1D/1W/1M intraday chart agrees with
    // longer-range views.
    //
    // Group cash by native currency so FX can be applied at each timestamp.
    // Cash amounts don't move intraday, but their display-currency value does
    // when FX moves -- so foreign-currency cash can't be a flat additive
    // offset across the chart. With the ledger, each day's own balances are
    // read from it per bar instead; today's balance is only the legacy answer.
    const cashByCurrency = new Map<string, number>();
    if (ledger) {
      for (const day of ledger.days) {
        for (const ccy of day.positions.cashByCurrency.keys()) {
          cashByCurrency.set(ccy, 0);
        }
      }
    } else {
      const cashAccountList = [...cashAccounts, ...standaloneAccounts];
      const cashIds = cashAccountList.map((a) => a.id);
      const effectiveBalances =
        await this.calculationService.computeEffectiveBalances(cashIds);
      for (const account of cashAccountList) {
        const balance =
          effectiveBalances.get(account.id) ?? Number(account.currentBalance);
        cashByCurrency.set(
          account.currencyCode,
          (cashByCurrency.get(account.currencyCode) ?? 0) + balance,
        );
      }
    }

    // For holdings whose intraday fetch failed (Yahoo errored, was
    // rate-limited past the retry budget, or simply has no minute-resolution
    // data for this security -- common for mutual funds and illiquid names),
    // fall back to the security's latest known daily close. Kept per security
    // so the breakdown can give each one its own band; the total series groups
    // them by currency for its per-currency rounding.
    // Without this, a single mutual fund in the user's portfolio would
    // either undercount the chart (if we ignored it) or pin the
    // "Couldn't load intraday prices" banner permanently (if we treated
    // it as a hard failure).
    //
    // With the ledger, such a holding (and an inactive one) is valued per day
    // at that day's quantity and stored close instead -- the same figure the
    // daily series gives it -- rather than as a flat line at today's.
    const failedHoldings = intradayHoldings.filter(
      (h) => !seriesBySecurity.has(h.securityId),
    );
    const closeValued: IntradayLoaded["closeValued"] = ledger
      ? activeHoldings
          .filter((h) => !seriesBySecurity.has(h.securityId))
          .map(({ securityId, symbol, name, currencyCode }) => ({
            securityId,
            symbol,
            name,
            currencyCode,
          }))
      : [];
    const staleSources: IntradayLoaded["staleSources"] = [];
    if (!ledger && failedHoldings.length > 0) {
      const latestPrices = await this.getLatestPrices(
        failedHoldings.map((h) => h.securityId),
      );
      for (const h of failedHoldings) {
        const lastClose = latestPrices.get(h.securityId);
        if (lastClose == null) {
          legacyUnpriced.add(h.securityId);
          continue;
        }
        const amount = h.quantity * lastClose;
        staleSources.push({
          securityId: h.securityId,
          symbol: h.symbol,
          name: h.name,
          currencyCode: h.currencyCode,
          amount,
        });
      }
    }

    // Fetch intraday FX series for every non-display currency in the
    // portfolio (holding currencies + cash currencies). Each bar of the
    // chart is then valued at the FX rate that prevailed at that moment,
    // not the latest spot. Latest-spot is kept as a per-currency fallback
    // for when the FX series fetch fails (rate limited, unsupported pair).
    const rateCache: FxRateCache = new Map();
    const fxCurrencies = new Set<string>([
      ...intradayHoldings.map((h) => h.currencyCode),
      ...closeValued.map((h) => h.currencyCode),
      ...cashByCurrency.keys(),
    ]);
    fxCurrencies.delete(displayCurrency);

    const fxByCurrency = new Map<string, IntradayFxSeries>();
    await mapWithConcurrency(
      [...fxCurrencies],
      INTRADAY_FETCH_CONCURRENCY,
      async (currency) => {
        const latest = await this.calculationService.convertToDefault(
          1,
          currency,
          displayCurrency,
          rateCache,
        );
        // Mirror the per-holding price fetch: try the primary interval, then
        // any range-specific coarser fallbacks. Yahoo's narrowest FX intervals
        // are the most rate-limited and most likely to return a short or empty
        // series, which would otherwise leave the whole currency on a flat
        // fallback rate. Walk up the ladder until one returns bars.
        let series: IntradayPoint[] | null = null;
        for (const params of intervalCandidates) {
          try {
            series = await this.yahooFinanceService.fetchIntradayFxSeries(
              currency,
              displayCurrency,
              params,
            );
            if (series && series.length > 0) break;
          } catch (error) {
            this.logger.warn(
              `Failed to fetch intraday FX ${currency}->${displayCurrency} at ${params.interval}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        fxByCurrency.set(currency, {
          times: series?.map((p) => p.timestamp.getTime()) ?? [],
          rates: series?.map((p) => p.close) ?? [],
          latest,
        });
      },
    );

    // Stored daily-close FX history, used to value any grid bar the live
    // intraday FX series does not cover (pre-market before the first bar of the
    // day, weekend/holiday gaps on 1W/1M, or a currency whose intraday fetch
    // failed). Without this such bars fall back to a single near-current rate,
    // which makes the start of the day and earlier multi-day points drift while
    // only the latest point -- backed by a live intraday bar -- stays correct.
    // Over-fetch a couple of weeks before the grid so an at-or-before rate
    // exists even for the first day.
    const indexStart = formatDateYMD(
      new Date(timestamps[0] - 14 * 24 * 60 * 60 * 1000),
    );
    const indexEnd = formatDateYMD(new Date(now));
    const dailyRateIndex =
      fxCurrencies.size > 0
        ? await this.calculationService.buildDailyRateIndex(
            fxCurrencies,
            displayCurrency,
            indexStart,
            indexEnd,
          )
        : (new Map() as DailyRateIndex);

    // Build per-security ordered timestamp/close arrays for the cursor-based
    // forward-fill so each grid point uses the latest known close.
    const sources: IntradayLoaded["sources"] = intradayHoldings
      .map((h) => {
        const points = seriesBySecurity.get(h.securityId);
        if (!points || points.length === 0) return null;
        return {
          securityId: h.securityId,
          symbol: h.symbol,
          name: h.name,
          quantity: h.quantity,
          currencyCode: h.currencyCode,
          times: points.map((p) => p.timestamp.getTime()),
          opens: points.map((p) => p.open),
          closes: points.map((p) => p.close),
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    const loaded: IntradayLoaded = {
      interval: yahooParams.interval,
      currency: displayCurrency,
      range,
      fetchedAt,
      skippedSymbols,
      failedSymbols: [],
      fallbackToDaily: false,
      timestamps,
      sources,
      staleSources,
      cashByCurrency: [...cashByCurrency],
      fxByCurrency,
      dailyRateIndex,
      spotRate: rateCache,
      ledgerDays: ledger?.days ?? null,
      sessionCloses,
      closeValued,
      unpricedSecurityIds: [...legacyUnpriced].sort(),
    };
    this.intradayCache.set(cacheKey, {
      expiresAt: now + INTRADAY_CACHE_TTL_MS,
      loaded,
    });
    return loaded;
  }

  /**
   * The positions held at the close of each day the intraday window can
   * reach, from the fold `getDailyInvestments` is built by, so a past bar
   * holds exactly what the daily series holds that day (INV-INTRADAY-001).
   *
   * Days are UTC calendar days: the grid's bars are keyed the same way (the
   * FX lookup reads the UTC date), and a North American session never crosses
   * a UTC midnight. `startDate` is the day the range is measured from, so the
   * opening close's figure is among the days. `null` when the fold
   * has no day at all, which happens only when the scope has no investment
   * account -- and then there are no holdings for the legacy path to find
   * either.
   */
  private async loadIntradayLedger(
    userId: string,
    startDate: string,
    accountIds: string[] | undefined,
    displayCurrency: string,
    today: string,
  ): Promise<{ days: LedgerDay[]; securities: Map<string, Security> } | null> {
    const { series, positions, securities } =
      await this.netWorth.getDailyInvestmentPositions(userId, {
        startDate,
        endDate: today,
        accountIds,
        displayCurrency,
      });
    if (positions.length === 0) return null;
    return {
      days: positions.map((dayPositions, i) => ({
        date: dayPositions.date,
        positions: dayPositions,
        daily: series[i],
      })),
      securities,
    };
  }

  /**
   * Where each finished session's closing point goes: one grid step after the
   * day's last bar (so a 15-minute series ends each day at 16:00, not at the
   * 15:45 bar's start), mapped to the ledger day whose daily figure it
   * carries.
   *
   * A session is finished when a later day has bars, or its day is before
   * today (UTC). Today's session is live and ends on its latest bar. A day the
   * daily series could not value completely (an unpriced position, a missing
   * rate or cash balance) gets no closing point: its bars stand rather than a
   * subtotal wearing a total's name.
   */
  private planSessionCloses(
    timestamps: number[],
    days: LedgerDay[],
    step: number,
    now: number,
  ): Map<number, number> {
    const closes = new Map<number, number>();
    if (timestamps.length === 0) return closes;
    const dayIndex = new Map(days.map((d, i) => [d.date, i]));
    const today = formatDateYMD(new Date(now));

    for (let i = 0; i < timestamps.length; i++) {
      const date = formatDateYMD(new Date(timestamps[i]));
      const next = timestamps[i + 1];
      const lastOfDay =
        next === undefined || formatDateYMD(new Date(next)) !== date;
      if (!lastOfDay) continue;
      if (next === undefined && date >= today) continue;
      const idx = dayIndex.get(date);
      if (idx === undefined) continue;
      const daily = days[idx].daily;
      if (
        daily.pricesComplete === false ||
        daily.fxComplete === false ||
        daily.cashComplete === false
      ) {
        continue;
      }
      const closeTs = timestamps[i] + step;
      if (next !== undefined && closeTs >= next) continue;
      closes.set(closeTs, idx);
    }
    return closes;
  }

  /**
   * Every bar of the first day dropped except its last, so the series begins
   * on the nearest thing to that day's close. Left alone when the whole series
   * is one day: collapsing it would leave a single point and no chart.
   */
  private keepLastBarOfFirstDay(timestamps: number[]): number[] {
    if (timestamps.length === 0) return timestamps;
    const firstDay = formatDateYMD(new Date(timestamps[0]));
    let lastOfFirstDay = 0;
    while (
      lastOfFirstDay + 1 < timestamps.length &&
      formatDateYMD(new Date(timestamps[lastOfFirstDay + 1])) === firstDay
    ) {
      lastOfFirstDay += 1;
    }
    if (lastOfFirstDay === timestamps.length - 1) return timestamps;
    return timestamps.slice(lastOfFirstDay);
  }

  /**
   * The grid's own step: the interval's, or the smallest same-day gap where
   * a holding on a coarser fallback interval must not stretch the finer bars'
   * day.
   */
  private gridStep(timestamps: number[], interval: IntradayInterval): number {
    let step = INTERVAL_MS[interval];
    for (let i = 1; i < timestamps.length; i++) {
      const gap = timestamps[i] - timestamps[i - 1];
      const sameDay =
        formatDateYMD(new Date(timestamps[i])) ===
        formatDateYMD(new Date(timestamps[i - 1]));
      if (sameDay && gap > 0 && gap < step) step = gap;
    }
    return step;
  }

  /**
   * The point a 1W / 1M series opens on: the close the range is measured
   * from, so the chart's first point and the "since the close of trading on"
   * caption beside it name one session and carry one figure.
   *
   * `measuredFrom` is the day the period-result service measures the same
   * range from (`presetEarliestDate`). Its ledger day's daily figure is the
   * value, which is the period result's own opening value, and the session
   * that figure came from is `getLastPricedDays` -- the same lookup behind the
   * period result's `startPriceDate` -- so a Monday 1W window measured from
   * Sunday opens on Friday's close, dated Friday.
   *
   * The point is stamped one grid step after the session's last fetched bar
   * when the provider's over-fetch reached that day, which it does for 1W and
   * usually for MTD and 1M. Otherwise it is stamped on the session's date at
   * the time of day the window's newest finished session closed at -- its
   * planned closing point, or its last bar plus one step where that day got
   * none; across a daylight-saving change that reads an hour off in the
   * label, and nowhere else. Null when the ledger has no such day, when the
   * day's figure is a subtotal (an unpriced position, a missing rate or cash
   * balance: no closing point wears a total's caption), when nothing was
   * priced on or before it, or when the window holds no finished session to
   * take a closing hour from.
   */
  private async planOpeningClose(params: {
    userId: string;
    accountIds: string[] | undefined;
    measuredFrom: string;
    days: LedgerDay[];
    /** Every bar the provider returned, including those before the window. */
    fetchedBars: number[];
    /** The bars inside the window. */
    windowBars: number[];
    step: number;
    /** The closes planned inside the window. */
    sessionCloses: ReadonlyMap<number, number>;
    today: string;
  }): Promise<{ ts: number; dayIndex: number } | null> {
    const { measuredFrom, days } = params;
    const dayIndex = days.findIndex((d) => d.date === measuredFrom);
    if (dayIndex === -1) return null;
    const daily = days[dayIndex].daily;
    if (
      daily.pricesComplete === false ||
      daily.fxComplete === false ||
      daily.cashComplete === false
    ) {
      return null;
    }
    const session = (
      await this.netWorth.getLastPricedDays(
        params.userId,
        [measuredFrom],
        params.accountIds,
      )
    ).get(measuredFrom);
    if (!session) return null;

    let lastBarOfSession: number | undefined;
    for (const ts of params.fetchedBars) {
      const date = formatDateYMD(new Date(ts));
      if (date === session) lastBarOfSession = ts;
      else if (date > session) break;
    }
    if (lastBarOfSession !== undefined) {
      return { ts: lastBarOfSession + params.step, dayIndex };
    }

    const newestClose = this.newestSessionClose(params);
    if (newestClose === null) {
      this.logger.debug(
        `Intraday series has no close to open on: ${session} is outside the fetched bars and the window holds no finished session to take a closing hour from`,
      );
      return null;
    }
    const closeTimeOfDay =
      newestClose -
      Date.parse(`${formatDateYMD(new Date(newestClose))}T00:00:00.000Z`);
    return {
      ts: Date.parse(`${session}T00:00:00.000Z`) + closeTimeOfDay,
      dayIndex,
    };
  }

  /**
   * When the window's newest finished session closed: its planned closing
   * point, or -- for a day the daily series could not value completely, which
   * got none -- its last bar plus one grid step. Null when every bar in the
   * window is today's, whose close is not a fact yet.
   */
  private newestSessionClose(params: {
    windowBars: number[];
    step: number;
    sessionCloses: ReadonlyMap<number, number>;
    today: string;
  }): number | null {
    let newest: number | null = null;
    for (const ts of params.sessionCloses.keys()) {
      if (newest === null || ts > newest) newest = ts;
    }
    if (newest !== null) return newest;
    for (let i = params.windowBars.length - 1; i >= 0; i--) {
      const ts = params.windowBars[i];
      if (formatDateYMD(new Date(ts)) < params.today) return ts + params.step;
    }
    return null;
  }

  private buildIntradayCacheKey(
    userId: string,
    range: IntradayRangeKey,
    accountIds: string[] | undefined,
    displayCurrency: string,
    today: string,
  ): string {
    const acctPart = (accountIds ?? []).slice().sort().join(",");
    return `${userId}|${range}|${acctPart}|${displayCurrency}|${today}`;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve investment accounts, including linked pairs when filtering by ID.
   */
  private async resolveAccounts(
    userId: string,
    accountIds?: string[],
  ): Promise<Account[]> {
    if (!accountIds || accountIds.length === 0) {
      return this.getInvestmentAccounts(userId);
    }

    // Batch fetch all requested accounts in one query. Restricted to
    // INVESTMENT accounts so a caller passing non-investment ids (e.g. an
    // acting delegate whose readable set spans chequing/savings granted for
    // other tabs) never leaks them into portfolio/holdings computations.
    // Investment-cash siblings are accountType INVESTMENT, so linked pairs
    // still resolve.
    const requestedAccounts = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).find({
        where: {
          id: In(accountIds),
          userId,
          accountType: AccountType.INVESTMENT,
        },
      }),
    );
    // Resolve linked pairs
    const resolvedIds = new Set<string>(requestedAccounts.map((a) => a.id));
    for (const account of requestedAccounts) {
      if (account.linkedAccountId) {
        resolvedIds.add(account.linkedAccountId);
      }
    }
    // Fetch any linked accounts that weren't in the original request
    const linkedOnly = [...resolvedIds].filter(
      (id) => !requestedAccounts.some((a) => a.id === id),
    );
    if (linkedOnly.length > 0) {
      const linkedAccounts = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Account).find({
          where: {
            id: In(linkedOnly),
            userId,
            accountType: AccountType.INVESTMENT,
          },
        }),
      );
      return [...requestedAccounts, ...linkedAccounts];
    }
    return requestedAccounts;
  }
}
