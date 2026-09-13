import { Tag } from './tag';
import { TransactionStatus } from './transaction';

export type InvestmentAction =
  | 'BUY'
  | 'SELL'
  | 'DIVIDEND'
  | 'INTEREST'
  | 'CAPITAL_GAIN'
  | 'SPLIT'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'REINVEST'
  | 'ADD_SHARES'
  | 'REMOVE_SHARES'
  // Microsoft Money's full distribution vocabulary (issue #1149). Each is a
  // refinement of a base action -- same share and cash behaviour, distinct
  // income kind -- normalized through `baseInvestmentAction`
  // (@/lib/investment-actions) wherever behaviour, not labelling, is decided.
  | 'REINVEST_INTEREST'
  | 'REINVEST_CAPITAL_GAIN_SHORT'
  | 'REINVEST_CAPITAL_GAIN_LONG'
  | 'CAPITAL_GAIN_SHORT'
  | 'CAPITAL_GAIN_LONG'
  | 'REDEEM';

export type QuoteProviderName = 'yahoo' | 'msn';


export interface Security {
  id: string;
  symbol: string;
  name: string;
  securityType: string | null;
  exchange: string | null;
  currencyCode: string;
  description?: string | null;
  tags?: Tag[];
  isActive: boolean;
  isFavourite: boolean;
  priceAlertPercent?: number | null;
  priceChartEnabled?: boolean;
  skipPriceUpdates: boolean;
  sector: string | null;
  industry: string | null;
  sectorWeightings: { sector: string; weight: number }[] | null;
  /** Manual ETF/fund country breakdown; weight is a decimal 0-1 (like sectorWeightings). */
  countryWeightings: { name: string; weight: number }[] | null;
  /** Manual ETF/fund asset-class breakdown (free-text names); weight is a decimal 0-1. */
  assetWeightings: { name: string; weight: number }[] | null;
  /** The issuer's or product's page; auto-filled from Yahoo for shares. */
  website: string | null;
  /** The investor-relations page; manual, no provider supplies one. */
  irWebsite: string | null;
  quoteProvider: QuoteProviderName | null;
  msnInstrumentId: string | null;
  /**
   * Where and when the instrument trades, as reported by the provider. The
   * session times are local to `marketTimezone` ("HH:mm:ss"). All three are
   * null until a price refresh reports them, and for providers that do not.
   */
  marketTimezone?: string | null;
  marketOpenTime?: string | null;
  marketCloseTime?: string | null;
  /** Source of the most recent price row for this security (e.g. "yahoo_finance", "msn_finance", "manual"), or null if no prices exist. */
  lastPriceSource?: string | null;
  /**
   * The close on that same most recent price row, in this security's own
   * `currencyCode` -- so a position's worth is `quantity * lastPrice` with no
   * exchange rate involved, and none that can be missing.
   *
   * `null` when the security has no prices at all, which is a gap and not a
   * price of zero: `securityPositionValue` (`@/lib/security-value`) is the one
   * place that turns the pair into a figure, and it returns `null` rather than
   * report a held position as worthless.
   *
   * Optional for the rolling-deploy reason the portfolio flags are: a backend
   * that predates the field sends nothing, and absent means "no information".
   */
  lastPrice?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SectorWeightingItem {
  sector: string;
  directValue: number;
  etfValue: number;
  totalValue: number;
  percentage: number;
}

export interface SectorWeightingResult {
  items: SectorWeightingItem[];
  totalPortfolioValue: number;
  totalDirectValue: number;
  totalEtfValue: number;
  unclassifiedValue: number;
}

export interface CountryWeightingItem {
  country: string;
  directValue: number;
  etfValue: number;
  totalValue: number;
  percentage: number;
}

export interface CountryWeightingResult {
  items: CountryWeightingItem[];
  totalPortfolioValue: number;
  totalDirectValue: number;
  totalEtfValue: number;
  unclassifiedValue: number;
}

export interface AssetClassWeightingItem {
  assetClass: string;
  directValue: number;
  etfValue: number;
  totalValue: number;
  percentage: number;
}

export interface AssetClassWeightingResult {
  items: AssetClassWeightingItem[];
  totalPortfolioValue: number;
  totalDirectValue: number;
  totalEtfValue: number;
  /**
   * Value with no asset-class classification: fund value beyond the manual
   * weightings plus securities whose type says nothing definite. Rendered as
   * the "Other" slice.
   */
  unclassifiedValue: number;
}

export interface Holding {
  id: string;
  accountId: string;
  securityId: string;
  quantity: number;
  averageCost: number | null;
  security: Security;
  createdAt: string;
  updatedAt: string;
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
  /** Cost basis in the security's native currency. */
  costBasis: number;
  /**
   * Cost basis in the holding account's currency, calculated using the
   * historical exchange rates stored on the original BUY transactions.
   *
   * `null` when no exchange rate exists for the pair, so the basis in this
   * currency is unknown. It must not render as a measured zero, and must not be
   * subtracted from a market value to produce a gain -- the server used to send
   * the unconverted figure here, an implicit 1:1 (audit P5-009).
   */
  costBasisAccountCurrency: number | null;
  currentPrice: number | null;
  marketValue: number | null;
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
   * Sum of the priced holdings only -- a subtotal, not a total, whenever
   * `unpricedHoldingsCount` is non-zero.
   */
  totalMarketValue: number;
  /**
   * How many of this account's holdings have no price, and so are missing from
   * `totalMarketValue`. Non-zero means the account's market value is unknown,
   * so any total built on it is unknown too (see `buildLogicalAccounts`).
   */
  unpricedHoldingsCount: number;
  totalGainLoss: number;
  totalGainLossPercent: number;
  netInvested: number;
  /**
   * Whether every component of *this account's* totals is known. The totals above
   * are in the account's own currency, which is a different conversion from the
   * summary's, so a portfolio can be complete overall while one account is not.
   *
   * The API has always sent these; the type omitted them, so the account list
   * rendered a known subtotal as the account's value and gain (recheck RR4-002).
   * Check `valuationComplete` before presenting any of the four totals as final.
   *
   * Declared optional deliberately: during a rolling deploy this payload can
   * come from an older backend without these fields, and absent means "no
   * information" -- not "incomplete". The optional type makes the compiler
   * force the defensive read (`=== false`, never `!flag`) that a required
   * declaration would let a consumer skip (review #1133).
   */
  fxComplete?: boolean;
  /** `"EUR->JPY"` for each pair with no rate into this account's currency. */
  missingRatePairs?: string[];
  /** False when a position held here has no current price. */
  pricesComplete?: boolean;
  /** Securities held here with no current price. */
  unpricedSecurityIds?: string[];
  /** `fxComplete && pricesComplete` -- gate this account's totals on this. */
  valuationComplete?: boolean;
}

export interface PortfolioSummary {
  totalCashValue: number;
  totalHoldingsValue: number;
  totalCostBasis: number;
  totalNetInvested: number;
  totalPortfolioValue: number;
  totalGainLoss: number;
  totalGainLossPercent: number;
  timeWeightedReturn: number | null;
  cagr: number | null;
  /**
   * Whether every currency conversion behind the `total*` fields succeeded.
   * False makes each of them a subtotal of what could be converted.
   *
   * Optional for the same rolling-deploy reason as on `AccountHoldings`: an
   * older backend's payload has none of these, absent means "no information",
   * and the optional type is what makes the compiler enforce the `=== false`
   * defensive read (review #1133).
   */
  fxComplete?: boolean;
  /** `"EUR->USD"` for each pair with no available rate; empty when complete. */
  missingRatePairs?: string[];
  /** False when a held position has no current price. */
  pricesComplete?: boolean;
  /** Securities held in a non-zero quantity with no current price. */
  unpricedSecurityIds?: string[];
  /**
   * The single flag to gate a `total*` field on: every component of every total is
   * known. `fxComplete && pricesComplete`.
   *
   * Dropping these from the type meant the summary card rendered a subtotal under
   * a "Total Portfolio Value" label while the server knew it was incomplete
   * (recheck RR4-002).
   */
  valuationComplete?: boolean;
  holdings: HoldingWithMarketValue[];
  holdingsByAccount: AccountHoldings[];
  allocation: AllocationItem[];  // Included to avoid duplicate API call
}

export interface AllocationItem {
  name: string;
  symbol: string | null;
  type: 'cash' | 'security' | 'tag' | 'untagged' | 'country' | 'assetClass' | 'other';
  value: number;
  percentage: number;
  color?: string;
  currencyCode?: string;
}

export interface AssetAllocation {
  allocation: AllocationItem[];
  totalValue: number;
}

export interface InvestmentTransaction {
  id: string;
  accountId: string;
  securityId: string | null;
  fundingAccountId: string | null;
  action: InvestmentAction;
  transactionDate: string;
  quantity: number | null;
  price: number | null;
  commission: number | null;
  totalAmount: number;
  // Accrued interest paid out with a REDEEM, read from its linked INTEREST
  // transaction. `totalAmount` stays proceeds; the cash movement is the two
  // added (`redemptionTotalWithInterest`). Absent on a backend that predates
  // the field, which means no information -- not zero interest.
  accruedInterest?: number;
  exchangeRate: number;
  description: string | null;
  // Same enum as regular transactions. A VOID row moves no shares and no
  // cash; the register strikes it through and excludes it from balances.
  status: TransactionStatus;
  // Set on security-transfer legs; points at the paired TRANSFER_IN/OUT leg.
  linkedTransactionId: string | null;
  // Set when this row is embedded inside a split transaction. The parent
  // split transaction owns the row's status; the form disables the status
  // field and the backend refuses a direct change.
  transactionSplitId?: string | null;
  security: Security | null;
  fundingAccount: {
    id: string;
    name: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface SecurityHistoryAccount {
  accountId: string;
  accountName: string;
  isClosed: boolean;
  currentQuantity: number;
}

export interface SecurityHistoryTransaction {
  id: string;
  transactionDate: string;
  accountId: string;
  accountName: string;
  action: InvestmentAction;
  quantity: number | null;
  price: number | null;
  commission: number;
  totalAmount: number;
  description: string | null;
  // A VOID row is listed but moved no shares; the running balances skip it.
  status: TransactionStatus;
  runningQuantityAccount: number;
  runningQuantityAll: number;
}

export interface SecurityTransactionHistory {
  securityId: string;
  symbol: string;
  name: string;
  currencyCode: string;
  isActive: boolean;
  accounts: SecurityHistoryAccount[];
  transactions: SecurityHistoryTransaction[];
  currentQuantityAll: number;
}

/**
 * The position in one account holding a security.
 *
 * Every amount is in the **security's own currency** -- what its price and
 * average cost are quoted in -- except `costBasisAccountCurrency`, which is the
 * portfolio's historical-rate conversion and is named for it. Nullable
 * throughout: a position held in a closed account, or a dust residual, is known
 * to exist from the transaction history but has no figures in the portfolio
 * calculation, and a zero there would be a claim rather than an absence.
 */
export interface SecurityDetailAccountPosition {
  accountId: string;
  accountName: string;
  accountCurrencyCode: string | null;
  isClosed: boolean;
  quantity: number;
  /** Average cost per unit, in the security's currency. */
  averageCost: number | null;
  costBasis: number | null;
  costBasisAccountCurrency: number | null;
  marketValue: number | null;
  gainLoss: number | null;
  gainLossPercent: number | null;
}

/**
 * The aggregate position across every account, for the summary cards. All
 * amounts are in the security's currency.
 */
export interface SecurityDetailPosition {
  quantity: number;
  averageCost: number | null;
  currentPrice: number | null;
  costBasis: number | null;
  marketValue: number | null;
  gainLoss: number | null;
  gainLossPercent: number | null;
}

/** Lifetime totals for the Position info card, in the security's currency. */
export interface SecurityDetailActivity {
  firstTransactionDate: string | null;
  lastTransactionDate: string | null;
  totalInvested: number;
  totalSold: number;
  dividends: number;
  fees: number;
  /**
   * Realized gain in `realizedGainCurrency` -- the holding account's currency,
   * which is how the canonical replay denominates it. Null when the security was
   * sold from accounts of more than one currency, because those gains cannot be
   * added into a single figure.
   */
  realizedGain: number | null;
  realizedGainCurrency: string | null;
  /** Currencies the security was sold from, for naming them when they differ. */
  realizedGainCurrencies: string[];
  /**
   * Sales the replay found. Distinguishes "never sold" (zero) from "sold across
   * currencies, so the gains cannot be added" -- both of which leave
   * `realizedGain` null.
   */
  realizedSaleCount: number;
  transactionCount: number;
}

/** One headline filed against a security. */
export interface SecurityNewsItem {
  id: string;
  title: string;
  publisher: string | null;
  link: string;
  /** ISO timestamp, or null when the provider gave none. */
  publishedAt: string | null;
  /** `STORY` or `VIDEO`. */
  type: string | null;
  /**
   * Path on our own API, never the publisher's CDN: the backend fetches the
   * image so the reader's browser does not have to contact a third party.
   */
  thumbnailUrl: string | null;
  /** Every symbol the item was filed under, which is more than just this one. */
  relatedTickers: string[];
}

export interface SecurityNewsResult {
  /**
   * Which provider supplied the headlines, or null when the security's quote
   * provider supplies none. Distinguishes "nothing published" from "cannot ask".
   */
  provider: 'yahoo' | 'msn' | null;
  items: SecurityNewsItem[];
}

/** The kinds of document a security can carry. Mirrors the backend enum. */
export const SECURITY_DOCUMENT_TYPES = [
  'FACTSHEET',
  'KIID',
  'PROSPECTUS',
  'ANNUAL_REPORT',
  'SEMI_ANNUAL_REPORT',
  'TAX',
  'RESEARCH',
  'OTHER',
] as const;

export type SecurityDocumentType = (typeof SECURITY_DOCUMENT_TYPES)[number];

/** A document recorded against a security. */
export interface SecurityDocument {
  id: string;
  securityId: string;
  documentType: SecurityDocumentType;
  name: string;
  /** The date on the document, not when it was recorded. Null where it has none. */
  documentDate: string | null;
  url: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSecurityDocumentData {
  documentType?: SecurityDocumentType;
  name: string;
  /**
   * Explicit `null` clears the stored date on an edit. `undefined` omits the
   * field, which on a PATCH means "leave it alone" -- the difference is what
   * makes clearing possible at all.
   */
  documentDate?: string | null;
  url: string;
  notes?: string | null;
}

export interface SecurityDetail {
  security: Security;
  position: SecurityDetailPosition;
  accounts: SecurityDetailAccountPosition[];
  activity: SecurityDetailActivity;
  hasTransactions: boolean;
  isPositionClosed: boolean;
}

export interface CreateInvestmentTransactionData {
  accountId: string;
  securityId?: string;
  fundingAccountId?: string;
  action: InvestmentAction;
  transactionDate: string;
  quantity?: number;
  price?: number;
  commission?: number;
  /** REDEEM only. Recorded as a linked INTEREST transaction, not a second cash entry. */
  accruedInterest?: number;
  exchangeRate?: number;
  description?: string;
  status?: TransactionStatus;
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
  marketValue: number | null;
  /**
   * What the day's move did to the position held: `dailyChange * quantity`, in
   * the security's own currency. The server derives it so no surface multiplies
   * a price change by a share count of its own; convert before ranking it
   * against a holding priced in another currency.
   */
  dailyValueChange: number | null;
}

export interface SecurityPrice {
  id: number;
  securityId: string;
  priceDate: string;
  openPrice: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  closePrice: number;
  /**
   * Split- and dividend-adjusted close, i.e. the total-return series. Stored by
   * the backend from provider data and returned by the prices endpoint; null for
   * a security whose provider does not supply it (MSN today).
   *
   * Keep `closePrice` for anything that shows the quote itself.
   *
   * **A return is not computed from a per-row fallback.** `adjustedClose` is
   * nullable per row and only the provider backfill writes it, so a
   * transaction-derived price, an import or a seed lands raw beside it: reading
   * `adjustedClose ?? closePrice` row by row splices raw rows into an adjusted
   * series, which around a split is a several-hundred-percent return that never
   * happened. The basis is chosen once per series over the window being read --
   * `backend/src/common/time-series/price-series.util.ts` is the one place that
   * decides it, and `GET /investments/performance/comparison` is how a
   * percentage series reaches this app. See `docs/time-series-contract.md`
   * rule 1.
   */
  adjustedClose: number | null;
  volume: number | null;
  source: string | null;
  /**
   * The instant the provider says this quote was struck. Distinct from
   * `priceDate` (the calendar day) and from `createdAt` (when the row was
   * first written -- a same-day refresh updates it in place, so createdAt does
   * not advance). Null for manual entries, rows derived from transactions, and
   * anything stored before the column existed.
   */
  quotedAt: string | null;
  createdAt: string;
}

export interface CreateSecurityPriceData {
  priceDate: string;
  closePrice: number;
  openPrice?: number;
  highPrice?: number;
  lowPrice?: number;
  volume?: number;
}

export interface CreateSecurityData {
  symbol: string;
  name: string;
  securityType?: string;
  exchange?: string;
  currencyCode: string;
  description?: string;
  /** Empty string clears the stored address; the backend normalises the rest. */
  website?: string | null;
  irWebsite?: string | null;
  tagIds?: string[];
  quoteProvider?: QuoteProviderName | null;
  msnInstrumentId?: string;
  isFavourite?: boolean;
  priceAlertPercent?: number | null;
  priceChartEnabled?: boolean;
  /** Manual ETF/fund country breakdown; weight is a decimal 0-1 (like sectorWeightings). */
  countryWeightings?: { name: string; weight: number }[];
  /** Manual ETF/fund asset-class breakdown (free-text names); weight is a decimal 0-1. */
  assetWeightings?: { name: string; weight: number }[];
}

/** A favourite security decorated with its latest price and daily change. */
export interface FavouriteSecurityQuote {
  securityId: string;
  symbol: string;
  name: string;
  currencyCode: string;
  currentPrice: number | null;
  previousPrice: number | null;
  dailyChange: number;
  dailyChangePercent: number;
}

export interface InvestmentTransactionPaginationInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export interface PaginatedInvestmentTransactions {
  data: InvestmentTransaction[];
  pagination: InvestmentTransactionPaginationInfo;
}

/**
 * What a brokerage register's filter pickers offer: the actions and symbols its
 * own rows use -- the actions in the vocabulary's order, the symbols
 * alphabetical.
 *
 * A household brokerage uses four of the twenty-odd actions, so offering all of
 * them to narrow a handful of rows is a list to read rather than a filter. The
 * symbols answer a sharper question than length: built from current holdings,
 * the picker omitted every position sold in full, whose trades are exactly what
 * somebody filtering by symbol tends to be looking for.
 */
export interface InvestmentRegisterFilterOptions {
  actions: string[];
  symbols: string[];
}

export interface RealizedGainEntry {
  transactionId: string;
  transactionDate: string;
  accountId: string;
  accountName: string | null;
  accountCurrencyCode: string | null;
  securityId: string;
  symbol: string | null;
  securityName: string | null;
  securityCurrencyCode: string | null;
  quantity: number;
  price: number;
  commission: number;
  proceeds: number;
  costBasis: number;
  realizedGain: number;
}

/**
 * Per-(account, security, month) capital gain entry combining realized SELL
 * gains with the unrealized mark-to-market change on the position. All values
 * are in the holding account's currency.
 */
export interface CapitalGainEntry {
  month: string;
  accountId: string;
  accountName: string | null;
  accountCurrencyCode: string | null;
  securityId: string;
  symbol: string | null;
  securityName: string | null;
  securityCurrencyCode: string | null;
  startQuantity: number;
  endQuantity: number;
  /**
   * Period-boundary market values in the account's currency, and the gains
   * derived from them. `null` when the security's currency could not be
   * converted into the account's: the value at each boundary is unknown, so a
   * gain measured between them is too -- never 0, never the native amount
   * relabelled. `buys`, `sells` and `realizedGain` stay known: they come from
   * the exchange rate stored on each transaction.
   */
  startValue: number | null;
  endValue: number | null;
  buys: number;
  sells: number;
  /**
   * `null` when the gain rests on a basis carrying an unpriced acquisition:
   * unknown, never the proceeds measured against a zero basis.
   */
  realizedGain: number | null;
  unrealizedGain: number | null;
  totalCapitalGain: number | null;
}

// --- Performance comparison (Security Performance report) -------------------
//
// The wire shape of `GET /investments/performance/comparison`. Several of these
// fields exist only to make a refusal visible, so dropping one turns a stated
// gap into a silent zero -- `docs/security-benchmark-comparison.md` is the
// contract, and `backend/src/securities/performance-comparison.types.ts` is the
// half of it these mirror.

/** Whether a plotted line is one of the user's instruments or a benchmark. */
export type PerformanceSeriesKind = 'SECURITY' | 'INDEX';

/** Which price series answered, decided once per instrument. */
export type PerformanceBasis = 'ADJUSTED' | 'RAW';

/** Why an instrument the user selected is not drawn. */
export type PerformanceExclusionReason =
  | 'NO_PRICE_HISTORY'
  | 'NO_PRICE_AT_WINDOW_START'
  | 'NON_POSITIVE_BASE'
  | 'SINGLE_OBSERVATION';

export interface PerformanceSeriesRef {
  /** `sec:<uuid>` or `idx:<code>`; also the key inside `values` and `totals`. */
  key: string;
  kind: PerformanceSeriesKind;
  id: string;
  label: string;
  name: string;
  /**
   * The currency the underlying closes are quoted in. Nothing is converted, so
   * this is not the currency of the percentage -- it is what tells the reader
   * which market's money the line was measured in.
   */
  currencyCode: string;
  basis: PerformanceBasis;
}

export interface PerformanceExclusion {
  key: string;
  kind: PerformanceSeriesKind;
  id: string;
  label: string;
  reason: PerformanceExclusionReason;
}

export interface PerformanceGap {
  key: string;
  from: string;
  to: string;
}

export interface PerformancePoint {
  date: string;
  /** Percent return since the window start; null where it is not known. */
  values: Record<string, number | null>;
}

export interface PerformanceComparison {
  window: { start: string; end: string };
  sampling: 'day' | 'week' | 'month';
  series: PerformanceSeriesRef[];
  points: PerformancePoint[];
  /** Return over the whole window; null where the series does not reach its end. */
  totals: Record<string, number | null>;
  gaps: PerformanceGap[];
  excluded: PerformanceExclusion[];
  status: 'complete' | 'incomplete';
}

/** Where an index's stored history begins and ends. */
export interface MarketIndexCoverage {
  earliestDate: string | null;
  latestDate: string | null;
}

/** A benchmark the report can overlay, with what we actually hold for it. */
export interface MarketIndex {
  code: string;
  yahooSymbol: string;
  defaultName: string;
  currencyCode: string;
  region: 'NORTH_AMERICA' | 'EUROPE' | 'ASIA_PACIFIC';
  /** Exchanges this index is the natural benchmark for. */
  exchanges: string[];
  coverage: MarketIndexCoverage;
}

/**
 * Why a day's market movement could not be reported.
 *
 * `notTradingDay` is a THIRD state, not a kind of unknown: nothing happened, the
 * cell is blank, and there is nothing for the reader to fix. Every other reason
 * shows the unknown marker and names a repair, and the two renderings never
 * overlap.
 */
export type DailyMovementReason =
  | 'notTradingDay'
  | 'unpricedHolding'
  | 'missingRate'
  | 'flowIncomplete'
  | 'noPriorValue'
  | 'zeroBaseline';

/** One day of GET /portfolio/daily-movements. */
export interface DailyMovementPoint {
  date: string;
  isTradingDay: boolean;
  /**
   * The day's market movement in the response's currency. Also non-null on a
   * `zeroBaseline` day, where the money moved is known and only the percentage
   * is not; the cell still renders blank, because it reads `complete`.
   */
  movement: number | null;
  movementPercent: number | null;
  /** Render the cell from THIS, never by re-deriving the reasons. */
  complete: boolean;
  reasons: DailyMovementReason[];
}

export interface DailyMovementsResponse {
  currencyCode: string;
  /** The server's financial today; nothing after it was evaluated. */
  today: string;
  days: DailyMovementPoint[];
}

/** One security's contribution to a day's movement. */
export interface SecurityDayMove {
  securityId: string;
  symbol: string;
  name: string;
  /** The security's own currency, which the prices below are in. */
  currencyCode: string;
  quantity: number;
  close: number;
  previousClose: number;
  /** The date the previous close was struck on, which need not be the day before. */
  previousCloseDate: string;
  /** `close - previousClose`, in the security's currency, at price precision. */
  priceChange: number;
  changePercent: number | null;
  /** The money it moved, in the reporting currency; null when no rate was known. */
  change: number | null;
}

/** GET /portfolio/daily-movements/detail: one day, broken down by security. */
export interface DailyMovementDetailResponse {
  date: string;
  currencyCode: string;
  movement: number | null;
  movementPercent: number | null;
  complete: boolean;
  reasons: DailyMovementReason[];
  /** Already sorted by the money each row moved, largest first. Do not re-sort. */
  gains: SecurityDayMove[];
  losses: SecurityDayMove[];
  unchangedCount: number;
  /**
   * The part of the day's move no per-security close explains: a dividend, a
   * position first priced that day, cash interest. `null` when any component is
   * unknown, so a popup that shows it can be trusted to reconcile.
   */
  remainder: number | null;
}
