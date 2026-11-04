import type { AccountType } from '@/types/account';

export interface MonthlyNetWorth {
  month: string; // "2023-01-01"
  assets: number;
  liabilities: number;
  netWorth: number;
  /**
   * False when a component of this month could not be converted into the
   * reporting currency: `assets`, `liabilities` and `netWorth` are then
   * SUBTOTALS of what did convert, not totals. Read as `=== false` -- optional
   * because a response from an older backend mid-deploy carries none of the
   * flags, and absent means no information, not "complete".
   */
  fxComplete?: boolean;
  /** `"ZZZ->USD"` for each pair with no rate this month; empty when complete. */
  missingRatePairs?: string[];
  /** `assets` alone is complete when this is not `false`; falls back to `fxComplete`. */
  assetsFxComplete?: boolean;
  /** `liabilities` alone is complete when this is not `false`; falls back to `fxComplete`. */
  liabilitiesFxComplete?: boolean;
  /**
   * What each account type contributes to `netWorth`: an asset type's value,
   * a liability type's owed amount negated, so the entries sum to `netWorth`
   * (to rounding). Only the types the month holds appear. Optional because a
   * response from an older backend mid-deploy does not carry it.
   */
  byAccountType?: Partial<Record<AccountType, number>>;
}

export interface MonthlyInvestmentValue {
  month: string;
  /** Securities plus the cash beside them, at the month's close. */
  value: number;
  /**
   * The INVESTED part of the same month -- the securities, no cash. The
   * investment charts plot this; see `DailyInvestmentValue.securitiesValue`.
   */
  securitiesValue?: number;
}

/**
 * One day of GET /net-worth/investments-daily.
 *
 * `value` is the scope's market value plus cash at that close -- and it is a
 * SUBTOTAL on any day either completeness flag is false: the server skips a
 * position it cannot price and drops a component it cannot convert. Read the
 * flags before printing this under a total's caption.
 *
 * All of the flags are optional because a response from an older backend
 * mid-deploy carries none of them, and absent means NO INFORMATION, not
 * "complete". That is why every read of them is `=== false`, never `!flag`:
 * truthiness turns a silent response into a withheld figure on every day.
 */
export interface DailyInvestmentValue {
  date: string;
  value: number;
  /**
   * `IV(t)`: the INVESTED part of that same close -- the securities, without
   * the cash beside them. `value` is this plus the scope's ledger cash.
   *
   * The investment charts plot THIS: cash held in an investment account is not
   * an investment, so a deposit must not draw as a rise in portfolio value
   * (INV-PORTRESULT-002, `docs/specs/portfolio-period-result.md` section 10.7).
   * The net worth chart is net worth and keeps reading `value`.
   *
   * Optional for the same reason the flags are: a response from an older
   * backend mid-deploy does not carry it.
   */
  securitiesValue?: number;
  /** False when a component could not be converted; see missingRatePairs. */
  fxComplete?: boolean;
  /** `"USD->EUR"` for each pair with no rate on that day. */
  missingRatePairs?: string[];
  /**
   * False when a position held at that close had no accepted price on or before
   * it, so its market value is unknown rather than zero.
   */
  pricesComplete?: boolean;
  /** The securities behind `pricesComplete: false`, so a reader can price them. */
  unpricedSecurityIds?: string[];
  /**
   * False when a cash account in the scope produced no balance for this day, so
   * its contribution is unknown rather than zero.
   */
  cashComplete?: boolean;
  /** The accounts behind `cashComplete: false`. */
  unknownCashAccountIds?: string[];
}

/**
 * `monthEnd` samples the daily fold on the window's first day, each month-end
 * inside it and its last day, so a long-range breakdown opens on the same close
 * the period figures are measured from. `monthly` is the older month-bucket
 * replay.
 */
export type InvestmentBreakdownGranularity = 'daily' | 'monthly' | 'monthEnd';

/**
 * One stacked band on the Portfolio Value Over Time "by security" chart:
 * an individual security, the rolled-up "other" bucket, or aggregate cash.
 * `symbol`/`name` are only populated for real securities; `cash` and `other`
 * are labelled on the client so their copy stays localized.
 */
export interface InvestmentBreakdownSeries {
  key: string; // securityId, or the sentinel 'cash' / 'other'
  type: 'security' | 'cash' | 'other';
  symbol: string | null;
  name: string;
}

export interface InvestmentBreakdownPoint {
  date: string; // YYYY-MM-DD; month-first for monthly granularity
  total: number;
  values: Record<string, number>; // keyed by InvestmentBreakdownSeries.key
  /**
   * False when a cash account in the scope produced no balance for this point,
   * so the cash band and `total` are short a component whose value is unknown
   * rather than zero. Optional, and read as `=== false`: an older backend
   * mid-deploy sends neither flag, which is no information.
   */
  cashComplete?: boolean;
  /** The accounts behind `cashComplete: false`. */
  unknownCashAccountIds?: string[];
  /**
   * False when a security held at this point had no accepted close on or before
   * it: its band is absent entirely, so `total` is a subtotal of the rest.
   * Read as `=== false`.
   */
  pricesComplete?: boolean;
  /** The securities behind `pricesComplete: false`, so a reader can price them. */
  unpricedSecurityIds?: string[];
  /**
   * `"USD->EUR"` for each pair THIS point could not convert, so the dates that
   * need a rate are identifiable rather than only the pairs.
   */
  missingRatePairs?: string[];
}

export interface InvestmentBreakdown {
  granularity: InvestmentBreakdownGranularity;
  currency: string;
  series: InvestmentBreakdownSeries[];
  points: InvestmentBreakdownPoint[];
  /** False when a component could not be converted into `currency`. */
  fxComplete?: boolean;
  /** `"USD->EUR"` for each pair with no rate; empty when complete. */
  missingRatePairs?: string[];
}

/**
 * Why a period's figures could not be reported, as the server's closed set.
 * `docs/specs/portfolio-period-result.md` section 4 is the truth table.
 */
export type PeriodResultReason =
  | 'noValueSeries'
  | 'incompletePrices'
  | 'incompleteCash'
  | 'missingRatePairs'
  | 'zeroStart'
  /** A trade in the window settled outside the accounts whose cash is valued. */
  | 'externallySettledTrade'
  /** A split parent in the window mixes an investment line with ordinary cash. */
  | 'mixedSplit'
  /**
   * The money-weighted return alone: its schedule of dated flows defines no
   * single rate. The P&L and the time-weighted return are unaffected.
   */
  | 'mwrUndefined'
  /**
   * The money-weighted return alone: the window is too short to annualise, so
   * only its un-annualised total is reported.
   */
  | 'windowTooShort';

/** One cause of an incomplete window, over the run of points it affected. */
export interface IncompleteDataRange {
  /** A security id, a `"USD->PLN"` pair, or an account id. */
  key: string;
  /** First date of the run. */
  start: string;
  /** Last date of the run; equal to `start` for a single point. */
  end: string;
}

/**
 * The three causes of an incomplete window, each folded into its runs, with a
 * flag per cause saying whether older runs were dropped to keep the payload
 * bounded. Mirrors `IncompleteDataRanges` in
 * `backend/src/net-worth/incomplete-data-ranges.util.ts`.
 */
export interface IncompleteDataRanges {
  /** Securities with no usable price, by run. */
  prices: IncompleteDataRange[];
  /** Currency pairs with no rate, by run. */
  rates: IncompleteDataRange[];
  /** Cash accounts with no balance, by run. */
  cash: IncompleteDataRange[];
  /** Per cause: true when runs older than the ones listed were dropped. */
  truncated: { prices: boolean; rates: boolean; cash: boolean };
}

/**
 * What GET /net-worth/investments-period-result answers: what the portfolio did
 * over the window, and how much of that was the reader's own money.
 *
 * Three figures, deliberately not one. `valueChange` is what the portfolio is
 * worth now less what it was worth then -- it counts a deposit. `netExternalFlows`
 * is that deposit. `investmentResult` is what is left, and it is the only one a
 * percentage belongs over: the report used to print the value change under a
 * "Return" caption, so two deposits with a flat price read as +100% (#1392).
 *
 * Every figure is nullable and carries its cause in `reasons`; nothing here is
 * re-derived on the client.
 */
export interface PortfolioPeriodResult {
  currency: string;
  /** The close the period is measured from (the baseline, where one applied). */
  startDate: string;
  /**
   * The trading session `startDate`'s value came from: the newest day on or
   * before it carrying a close for anything the scope held.
   *
   * `startDate` is a CALENDAR day and the value series prices every calendar
   * day from the latest close at or before it, so a window opening on a Sunday
   * is measured from Friday's close. This is the day a surface prints. `null`
   * is unknown -- never the calendar day in its place.
   */
  startPriceDate?: string | null;
  endDate: string;
  startValue: number | null;
  endValue: number | null;
  valueChange: number | null;
  netExternalFlows: number | null;
  /** The part of the flow that converted, when the total is withheld. */
  knownFlowSubtotal: number;
  investmentResult: number | null;
  returnPercent: number | null;
  /** How the percentage was arrived at; `simple` is not time-weighted. */
  returnMethod: 'simple';
  complete: boolean;
  reasons: PeriodResultReason[];
  missingRatePairs: string[];
  unpricedSecurityIds: string[];
  unknownCashAccountIds: string[];
  /**
   * The same three causes DATED: each key's runs of consecutive points over the
   * window, rather than the union sets above, which say what is missing and not
   * when. Bounded per cause; `truncated` says a list is the newest runs rather
   * than all of them. Optional: an older backend omits it.
   */
  incompleteRanges?: IncompleteDataRanges;

  // The INVESTED part of the same window: securities only, cash excluded
  // entirely. These are what "Portfolio performance" and the investment charts
  // report; the fields above are what the ACCOUNT did, which is the question
  // the daily movement notification and the calendar layer ask.

  /** IV(b): the securities at the starting close, no cash. */
  investedValueStart?: number | null;
  /** IV(e): the securities at the ending close, no cash. */
  investedValueEnd?: number | null;
  /**
   * IV(e) - IV(b): the last point the value chart draws less its first, cash
   * excluded. Known whenever both boundary days are complete, even where the
   * P&L beside it is withheld. Absent from an older backend, which is unknown.
   */
  investedValueChange?: number | null;
  /** Net value paid into the securities after startDate: buys less disposals. */
  investmentCapitalFlows?: number | null;
  /** Dividends, interest and capital-gain distributions over the same days. */
  investmentIncome?: number | null;
  /** What the investments earned: IV(e) - IV(b) - capital + income. */
  investmentPnl?: number | null;
  /** The time-weighted return over the same days. */
  investmentReturnPercent?: number | null;
  /** How that percentage was arrived at; `twr` neutralises capital flows. */
  investmentReturnMethod?: 'twr';
  /**
   * The ANNUALISED money-weighted return (XIRR) over the same flows: what the
   * reader's own money earned, weighted by when it was paid in. Withheld with
   * `mwrUndefined` or `windowTooShort` among `investedReasons`.
   */
  investmentMoneyWeightedReturnPercent?: number | null;
  /** The same rate over the window rather than a year; a rate, not a realised total. */
  investmentMoneyWeightedTotalPercent?: number | null;
  /** How that rate was arrived at; `xirr` weights each flow by its own date. */
  investmentMoneyWeightedMethod?: 'xirr';
  /** True only when both invested figures are known. */
  investedComplete?: boolean;
  /** Why an invested figure is withheld; the same closed set as `reasons`. */
  investedReasons?: PeriodResultReason[];
}

/** The trailing windows the Investments page reports a portfolio result over. */
export const PORTFOLIO_PERIOD_PRESETS = [
  '1d',
  '1w',
  '1m',
  '3m',
  'ytd',
  '1y',
  '2y',
  '5y',
  '10y',
  'all',
] as const;

export type PortfolioPeriodPreset = (typeof PORTFOLIO_PERIOD_PRESETS)[number];

/**
 * Whether the server resolves this window itself, from its own preset
 * arithmetic, rather than being sent a pair of dates.
 *
 * A chart names its range here instead of dating it: the window a price chart
 * DRAWS is deliberately not the period its button names, and sending the drawn
 * one measures the wrong days (`usePortfolioPeriodResult`). A range with no
 * preset -- `mtd`, a custom window -- still sends its dates.
 */
export function isPortfolioPeriodPreset(
  value: string,
): value is PortfolioPeriodPreset {
  return (PORTFOLIO_PERIOD_PRESETS as readonly string[]).includes(value);
}

/**
 * The windows every scope is answered for, whatever its history.
 *
 * The server reports the longer ones only where the portfolio reaches back to
 * them, and `all` only where it has ever held anything, so which windows exist
 * is not knowable until it answers. These are what a card shows in the
 * meantime: the rows that are always coming, so the list does not grow a
 * skeleton it then has to take away.
 */
export const BASE_PORTFOLIO_PERIOD_PRESETS = [
  '1d',
  '1w',
  '1m',
  '3m',
  'ytd',
  '1y',
] as const satisfies readonly PortfolioPeriodPreset[];

/**
 * What GET /net-worth/investments-period-results answers: the same measure as
 * the single-range route, for several trailing windows at once.
 *
 * The server builds the value series once for the widest window and slices the
 * rest out of it, so every window costs one valuation.
 *
 * `periods` is partial for a reason a consumer must not confuse with a
 * withheld figure. A window that is PRESENT with every figure null and
 * `noValueSeries` among its reasons is one the scope cannot measure, which the
 * card reads as "n/a". A window that is ABSENT is one this portfolio does not
 * have at all -- a five-year return on a two-year-old portfolio -- and a
 * surface shows the windows it was sent rather than a row nobody can fill in.
 */
export interface PortfolioPeriodResults {
  /** The currency every figure in every period is in. */
  currency: string;
  /** The day every period is measured to. */
  asOf: string;
  periods: Partial<Record<PortfolioPeriodPreset, PortfolioPeriodResult>>;
}

/** Why a security's price change over a window is withheld. */
export type SecurityPriceChangeReason =
  | 'noStartClose'
  | 'noEndClose'
  /** Two quoted closes either side of a split are two different units. */
  | 'splitInWindow';

/**
 * One security's share of the invested period result: the same P&L and
 * time-weighted return `PortfolioPeriodResult` reports for the scope, over the
 * same window, measured over this security's own positions and rows
 * (`docs/specs/investment-performance-report-period.md`).
 */
export interface SecurityPeriodResult {
  securityId: string;
  /** Null only when the server could not read the security's own row. */
  symbol: string | null;
  name: string | null;
  /** The currency `startClose` and `endClose` are quoted in. */
  securityCurrency: string | null;
  /** Shares held at the opening and closing close; 0 is not held. */
  startQuantity: number;
  endQuantity: number;
  startClose: number | null;
  endClose: number | null;
  /** The quoted close's move over the window, in its own currency; not a return. */
  priceChangePercent: number | null;
  priceChangeReason: SecurityPriceChangeReason | null;
  investedValueStart: number | null;
  investedValueEnd: number | null;
  investedValueChange: number | null;
  investmentCapitalFlows: number | null;
  investmentIncome: number | null;
  /** IV(e) - IV(b) - capital + income, in the response's `currency`. */
  investmentPnl: number | null;
  /** The time-weighted return over the same days. */
  investmentReturnPercent: number | null;
  investmentReturnMethod: 'twr';
  investedComplete: boolean;
  investedReasons: PeriodResultReason[];
}

/** What GET /net-worth/investments-period-result/securities answers. */
export interface SecurityPeriodResults {
  /** The currency every money figure is in. */
  currency: string;
  startDate: string;
  endDate: string;
  /** `noValueSeries` when the window had no valued day. */
  reasons: PeriodResultReason[];
  securities: SecurityPeriodResult[];
  /**
   * What the investment rows naming no security earned over the window, so the
   * rows still add up to the period's `investmentPnl`. Null when one of them
   * did not convert.
   */
  unattributedPnl: number | null;
}

/**
 * Per-security intraday breakdown (1D / 1W / 1M ranges). Same band shape as
 * the daily/monthly breakdown, but points are keyed by timestamp and the
 * response carries the intraday availability metadata so the report applies the
 * same fallback handling as the total intraday series.
 */
export interface IntradayBreakdownPoint {
  timestamp: string;
  total: number;
  values: Record<string, number>;
  /**
   * Three completeness bits, as on `InvestmentBreakdownPoint`: `total` is a
   * SUBTOTAL on a bar where one is false. Optional and read as `=== false`.
   */
  fxComplete?: boolean;
  pricesComplete?: boolean;
  cashComplete?: boolean;
  /** Set on a session's closing point; see `getIntradayValue`. */
  sessionClose?: true;
}

export interface IntradayBreakdown {
  series: InvestmentBreakdownSeries[];
  points: IntradayBreakdownPoint[];
  interval: '1m' | '2m' | '5m' | '15m' | '30m' | '60m' | '90m';
  currency: string;
  range: '1d' | '1w' | 'mtd' | '1m';
  fetchedAt: string;
  skippedSymbols: string[];
  failedSymbols: string[];
  fallbackToDaily: boolean;
  /** Completeness over every point; optional, read as `=== false`. */
  fxComplete?: boolean;
  pricesComplete?: boolean;
  valuationComplete?: boolean;
  /** `"CCY->DISPLAY"` for each pair with no rate at any bar. */
  missingRatePairs?: string[];
  /** The securities behind `pricesComplete: false`. */
  unpricedSecurityIds?: string[];
}
