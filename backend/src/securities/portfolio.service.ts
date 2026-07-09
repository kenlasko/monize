import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In } from "typeorm";
import { Holding } from "./entities/holding.entity";
import { SecurityPrice } from "./entities/security-price.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  PortfolioCalculationService,
  DailyRateIndex,
} from "./portfolio-calculation.service";
import { YahooFinanceService } from "./yahoo-finance.service";
import { QuoteProviderRegistry } from "./providers/quote-provider.registry";
import { roundMoney } from "../common/round.util";
import { collectTagKeys } from "../tags/tag-key-value.util";
import { mapWithConcurrency } from "../common/concurrency.util";
import { formatDateYMD } from "../common/date-utils";
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
   */
  costBasisAccountCurrency: number;
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
  totalMarketValue: number;
  totalGainLoss: number;
  totalGainLossPercent: number;
  netInvested: number;
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
  totalGainLoss: number;
  totalGainLossPercent: number;
  holdings: LlmPortfolioHolding[];
}

export interface LlmPortfolioSummary {
  holdingCount: number;
  totalCashValue: number;
  totalHoldingsValue: number;
  totalCostBasis: number;
  totalPortfolioValue: number;
  totalGainLoss: number;
  totalGainLossPercent: number;
  timeWeightedReturn: number | null;
  cagr: number | null;
  holdings: LlmPortfolioHolding[];
  holdingsByAccount: LlmAccountHoldings[];
  allocation: LlmPortfolioAllocation[];
}

/**
 * A currency's live intraday FX bars (times/rates) plus a latest-spot fallback,
 * used to value each grid bar at the rate that prevailed at that moment.
 */
interface IntradayFxSeries {
  times: number[];
  rates: number[];
  latest: number;
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
  /**
   * Stale-holding amounts grouped by native currency, used by the total series
   * so its per-currency rounding matches the pre-refactor output exactly.
   */
  staleByCurrency: Array<[string, number]>;
  /** Cash grouped by native currency (currency -> amount). */
  cashByCurrency: Array<[string, number]>;
  fxByCurrency: Map<string, IntradayFxSeries>;
  dailyRateIndex: DailyRateIndex;
  /** Latest spot rate per `${currency}->${display}` fallback. */
  spotRate: Map<string, number>;
}

interface IntradayCacheEntry {
  expiresAt: number;
  loaded: IntradayLoaded;
}

const RANGE_TO_YAHOO: Record<
  IntradayRangeKey,
  { interval: IntradayInterval; range: IntradayRange }
> = {
  "1d": { interval: "1m", range: "1d" },
  // Yahoo's "5d" range only covers 5 trading days, so a 1W request that lands
  // on a Wednesday would only reach back to the previous Thursday. Pull a
  // full month and let the cutoff filter trim to exactly 7 calendar days.
  "1w": { interval: "5m", range: "1mo" },
  "1m": { interval: "15m", range: "1mo" },
};

// Calendar-day lookback used to trim the intraday series to a precise
// "beginning of (today - N days)" boundary. Yahoo's range parameter is
// approximate (e.g. "5d" returns 5 trading days, "1mo" excludes the
// boundary date), so we over-fetch and filter here.
const RANGE_LOOKBACK_DAYS: Record<IntradayRangeKey, number | null> = {
  "1d": null,
  "1w": 7,
  "1m": 30,
};

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
  "1m": [
    { interval: "30m", range: "1mo" },
    { interval: "60m", range: "1mo" },
    { interval: "90m", range: "1mo" },
  ],
};

const INTRADAY_CACHE_TTL_MS = 60_000;

// Gap (in days) between a security's two most recent prices at or above which
// their delta is NOT treated as a "daily" move in Top Movers. A normal
// daily-priced security spans 1-4 days (weekends/holidays); a weekly-priced
// fund spans exactly 7, and a sparsely priced holding such as a GIC can span
// months -- all of which would otherwise surface a stale, perpetual daily
// change.
const DAILY_PRICE_GAP_EXCLUSION_DAYS = 7;

@Injectable()
export class PortfolioService {
  private readonly logger = new Logger(PortfolioService.name);
  private readonly intradayCache = new Map<string, IntradayCacheEntry>();

  constructor(
    @InjectRepository(Holding)
    private holdingsRepository: Repository<Holding>,
    @InjectRepository(SecurityPrice)
    private securityPriceRepository: Repository<SecurityPrice>,
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    @InjectRepository(UserPreference)
    private prefRepository: Repository<UserPreference>,
    private calculationService: PortfolioCalculationService,
    private yahooFinanceService: YahooFinanceService,
    private quoteProviderRegistry: QuoteProviderRegistry,
  ) {}

  /**
   * Get the latest prices for a list of security IDs
   * Uses DISTINCT ON for efficient single-pass query instead of correlated subquery
   */
  async getLatestPrices(securityIds: string[]): Promise<Map<string, number>> {
    if (securityIds.length === 0) {
      return new Map();
    }

    // Use DISTINCT ON (PostgreSQL) for efficient single-pass latest price lookup
    const latestPrices = await this.securityPriceRepository.query(
      `SELECT DISTINCT ON (security_id) security_id, close_price, price_date
         FROM security_prices
         WHERE security_id = ANY($1)
         ORDER BY security_id, price_date DESC`,
      [securityIds],
    );

    const priceMap = new Map<string, number>();
    for (const price of latestPrices) {
      priceMap.set(price.security_id, Number(price.close_price));
    }

    return priceMap;
  }

  /**
   * Get all investment accounts (both cash and brokerage) for a user
   */
  async getInvestmentAccounts(userId: string): Promise<Account[]> {
    return this.accountsRepository.find({
      where: {
        userId,
        accountType: AccountType.INVESTMENT,
        isClosed: false,
      },
    });
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
   * Get portfolio summary for a user, optionally filtered by account
   */
  async getPortfolioSummary(
    userId: string,
    accountIds?: string[],
  ): Promise<PortfolioSummary> {
    // Get user's default currency for conversion
    const pref = await this.prefRepository.findOne({ where: { userId } });
    const defaultCurrency = pref?.defaultCurrency || "CAD";
    const rateCache = new Map<string, number>();

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
    const totalCashValue = await this.calculationService.computeTotalCashValue(
      [...categorised.cashAccounts, ...categorised.standaloneAccounts],
      effectiveBalances,
      defaultCurrency,
      rateCache,
    );

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
    const totalGainLoss =
      holdingsResult.totalHoldingsValue - holdingsResult.totalCostBasis;
    const totalGainLossPercent =
      holdingsResult.totalCostBasis > 0
        ? (totalGainLoss / holdingsResult.totalCostBasis) * 100
        : 0;

    // Calculate total net invested (converted to default currency)
    let totalNetInvested = 0;
    for (const acct of holdingsByAccount) {
      totalNetInvested += await this.calculationService.convertToDefault(
        acct.netInvested,
        acct.currencyCode,
        defaultCurrency,
        rateCache,
      );
    }

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

    // Calculate Time-Weighted Return
    const timeWeightedReturn = await this.calculationService.calculateTWR(
      userId,
      categorised.holdingsAccountIds,
      defaultCurrency,
      rateCache,
      (ids) => this.getLatestPrices(ids),
    );

    // Calculate CAGR
    const cagr = await this.calculationService.calculateCAGR(
      userId,
      categorised.holdingsAccountIds,
      totalNetInvested,
      totalPortfolioValue,
    );

    return {
      totalCashValue,
      totalHoldingsValue: holdingsResult.totalHoldingsValue,
      totalCostBasis: holdingsResult.totalCostBasis,
      totalNetInvested,
      totalPortfolioValue,
      totalGainLoss,
      totalGainLossPercent,
      timeWeightedReturn,
      cagr,
      holdings: sortedHoldings,
      holdingsByAccount,
      allocation,
    };
  }

  /**
   * Compact portfolio summary for LLM / AI consumers. Called by both the AI
   * Assistant's tool executor and the MCP server's `get_portfolio_summary`
   * tool so the two surfaces return the same shape. Monetary values are
   * rounded to 4 decimal places; percentages to 2.
   */
  async getLlmSummary(
    userId: string,
    accountIds?: string[],
  ): Promise<LlmPortfolioSummary> {
    const summary = await this.getPortfolioSummary(userId, accountIds);

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
      timeWeightedReturn: roundPct(summary.timeWeightedReturn),
      cagr: roundPct(summary.cagr),
      holdings,
      holdingsByAccount,
      allocation,
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
    const holdings = await this.holdingsRepository.find({
      where: { accountId: In(holdingsAccountIds) },
      relations: ["security"],
    });
    const activeHoldings = holdings.filter(
      (h) =>
        Math.abs(Number(h.quantity)) >= 0.0001 &&
        h.security?.isActive !== false &&
        // Exclude securities with no regular price feed (e.g. GICs). Their only
        // "prices" come from buy/sell transactions, so the latest two closes are
        // a transaction-to-transaction delta, not a daily market move. The
        // date-gap check below misses this when two transactions land on
        // adjacent days, so filter on the flag that marks the security itself.
        h.security?.skipPriceUpdates !== true,
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
    }> = await this.securityPriceRepository.query(
      `SELECT security_id, close_price, price_date, rn FROM (
         SELECT security_id, close_price, price_date,
                ROW_NUMBER() OVER (PARTITION BY security_id ORDER BY price_date DESC) as rn
         FROM security_prices
         WHERE security_id = ANY($1)
       ) sub
       WHERE rn <= 2
       ORDER BY security_id, rn`,
      [securityIds],
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

    for (const securityId of securityIds) {
      const prices = priceMap.get(securityId);
      if (!prices || prices.length < 2) continue;

      const [current, previous] = prices;
      if (previous.price === 0) continue;

      // Skip securities whose two most recent prices are far apart: the
      // "previous" close isn't an adjacent trading session, so the delta is a
      // long-period change rather than a daily move. Without this a sparsely
      // priced holding (e.g. a matured GIC re-bought under the same symbol) or a
      // weekly-priced fund reports the same stale "daily" change every day.
      const gapDays = Math.round(
        (new Date(current.date).getTime() - new Date(previous.date).getTime()) /
          86_400_000,
      );
      if (gapDays >= DAILY_PRICE_GAP_EXCLUSION_DAYS) continue;

      const currentPrice = current.price;
      const previousPrice = previous.price;
      const dailyChange = currentPrice - previousPrice;
      const dailyChangePercent = (dailyChange / previousPrice) * 100;
      const security = securityLookup.get(securityId);
      const totalQty = quantityMap.get(securityId) || 0;

      movers.push({
        securityId,
        symbol: security?.symbol || "Unknown",
        name: security?.name || "Unknown",
        currencyCode: security?.currencyCode || "USD",
        currentPrice,
        previousPrice,
        dailyChange,
        dailyChangePercent,
        marketValue: currentPrice * totalQty,
      });
    }

    // Sort by absolute daily change percent descending
    movers.sort(
      (a, b) => Math.abs(b.dailyChangePercent) - Math.abs(a.dailyChangePercent),
    );

    return movers;
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

    const holdings = await this.holdingsRepository.find({
      where: { accountId: In(holdingsAccountIds) },
      relations: ["security"],
    });
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
      period: string;
    }> = await this.securityPriceRepository.query(
      `SELECT security_id, close_price, period FROM (
         SELECT security_id, close_price, 'current' as period,
                ROW_NUMBER() OVER (PARTITION BY security_id ORDER BY price_date DESC) as rn
         FROM security_prices
         WHERE security_id = ANY($1)
           AND price_date <= $2::DATE
       ) sub WHERE rn = 1
       UNION ALL
       SELECT security_id, close_price, period FROM (
         SELECT security_id, close_price, 'previous' as period,
                ROW_NUMBER() OVER (PARTITION BY security_id ORDER BY price_date DESC) as rn
         FROM security_prices
         WHERE security_id = ANY($1)
           AND price_date <= $3::DATE
       ) sub WHERE rn = 1`,
      [securityIds, currentEnd, previousEnd],
    );

    // Build price maps per security
    const currentPriceMap = new Map<string, number>();
    const previousPriceMap = new Map<string, number>();
    for (const row of priceRows) {
      if (row.period === "current") {
        currentPriceMap.set(row.security_id, Number(row.close_price));
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
        currencyCode: security?.currencyCode || "USD",
        currentPrice,
        previousPrice,
        dailyChange,
        dailyChangePercent,
        marketValue: currentPrice * totalQty,
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
   * Only brokerage and standalone investment accounts contribute; cash-only
   * accounts are omitted. Accounts whose holdings have no current price are
   * also omitted (caller should treat "missing" as "no market-value info
   * available" rather than zero).
   */
  async getAccountMarketValues(userId: string): Promise<Map<string, number>> {
    const accounts = await this.getInvestmentAccounts(userId);
    const { holdingsAccountIds } =
      this.calculationService.categoriseAccounts(accounts);
    if (holdingsAccountIds.length === 0) return new Map();

    const holdings = await this.holdingsRepository.find({
      where: { accountId: In(holdingsAccountIds) },
      relations: ["security"],
    });
    if (holdings.length === 0) return new Map();

    const securityIds = [...new Set(holdings.map((h) => h.securityId))];
    const priceMap = await this.getLatestPrices(securityIds);

    const accountCurrency = new Map<string, string>();
    for (const a of accounts) accountCurrency.set(a.id, a.currencyCode);

    const rateCache = new Map<string, number>();
    const result = new Map<string, number>();
    for (const h of holdings) {
      if (Math.abs(Number(h.quantity)) < 0.0001) continue;
      const price = priceMap.get(h.securityId);
      if (price == null) continue;

      const marketValue = Number(h.quantity) * price;
      const securityCurrency = h.security.currencyCode;
      const acctCurrency = accountCurrency.get(h.accountId) ?? securityCurrency;

      const valueInAccountCurrency =
        await this.calculationService.convertToDefault(
          marketValue,
          securityCurrency,
          acctCurrency,
          rateCache,
        );

      result.set(
        h.accountId,
        (result.get(h.accountId) ?? 0) + valueInAccountCurrency,
      );
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
   * Distinct KEY:VALUE tag keys present on the portfolio's securities, so the
   * UI can offer "aggregate by key" choices. Case-folded and sorted.
   */
  async getPortfolioTagKeys(
    userId: string,
    accountIds?: string[],
  ): Promise<string[]> {
    const inputs = await this.loadTaggedAllocationInputs(userId, accountIds);
    const names: string[] = [];
    for (const tags of inputs.tagsBySymbol.values()) {
      for (const tag of tags) names.push(tag.name);
    }
    return collectTagKeys(names);
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

  /** The user's default display currency, falling back to CAD. */
  private async resolveDefaultCurrency(userId: string): Promise<string> {
    const pref = await this.prefRepository.findOne({ where: { userId } });
    return pref?.defaultCurrency || "CAD";
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
    }> = await this.holdingsRepository.manager.query(
      `SELECT s.symbol AS symbol, t.id AS id, t.name AS name, t.color AS color
         FROM securities s
         JOIN security_tags st ON st.security_id = s.id
         JOIN tags t ON t.id = st.tag_id
        WHERE s.user_id = $1 AND s.symbol = ANY($2)
        ORDER BY t.name ASC`,
      [userId, symbols],
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
      return { points: [], ...meta };
    }

    const fxAt = this.makeIntradayFxAt(loaded);
    const cursors = loaded.sources.map(() => -1);
    const points: IntradayValuePoint[] = [];

    for (const ts of loaded.timestamps) {
      let totalCents = 0; // integer arithmetic to avoid float drift
      // Cash contributions, valued at the FX rate prevailing at this bar.
      for (const [ccy, amount] of loaded.cashByCurrency) {
        totalCents += Math.round(amount * fxAt(ccy, ts) * 10000);
      }
      // Stale-holding contributions (last daily close * quantity), grouped by
      // currency so the per-currency rounding matches the historical total.
      for (const [ccy, amount] of loaded.staleByCurrency) {
        totalCents += Math.round(amount * fxAt(ccy, ts) * 10000);
      }
      for (let i = 0; i < loaded.sources.length; i++) {
        const src = loaded.sources[i];
        cursors[i] = this.advanceIntradayCursor(src.times, cursors[i], ts);
        const price = this.intradayPriceAt(src, cursors[i], ts);
        totalCents += Math.round(
          src.quantity * price * fxAt(src.currencyCode, ts) * 10000,
        );
      }
      points.push({
        timestamp: new Date(ts).toISOString(),
        value: totalCents / 10000,
      });
    }

    return { points, ...meta };
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
      return { series: [], points: [], ...meta };
    }

    const fxAt = this.makeIntradayFxAt(loaded);
    const cursors = loaded.sources.map(() => -1);
    const n = loaded.timestamps.length;

    // Per-security value arrays (display currency) plus the aggregate cash band.
    const secValues = new Map<string, number[]>();
    const secMeta = new Map<string, { symbol: string; name: string }>();
    const cash = new Array<number>(n).fill(0);
    const ensureSec = (id: string, symbol: string, name: string) => {
      if (!secValues.has(id)) {
        secValues.set(id, new Array<number>(n).fill(0));
        secMeta.set(id, { symbol, name });
      }
    };

    for (let ti = 0; ti < n; ti++) {
      const ts = loaded.timestamps[ti];
      let cashCents = 0;
      for (const [ccy, amount] of loaded.cashByCurrency) {
        cashCents += Math.round(amount * fxAt(ccy, ts) * 10000);
      }
      cash[ti] = cashCents / 10000;
      // Stale (last-close) holdings keep their own band, unlike the total
      // series which only needs a per-currency subtotal.
      for (const s of loaded.staleSources) {
        ensureSec(s.securityId, s.symbol, s.name);
        secValues.get(s.securityId)![ti] =
          Math.round(s.amount * fxAt(s.currencyCode, ts) * 10000) / 10000;
      }
      for (let i = 0; i < loaded.sources.length; i++) {
        const src = loaded.sources[i];
        cursors[i] = this.advanceIntradayCursor(src.times, cursors[i], ts);
        const price = this.intradayPriceAt(src, cursors[i], ts);
        ensureSec(src.securityId, src.symbol, src.name);
        secValues.get(src.securityId)![ti] =
          Math.round(
            src.quantity * price * fxAt(src.currencyCode, ts) * 10000,
          ) / 10000;
      }
    }

    const { series, points } = this.groupIntradayBreakdown(
      loaded.timestamps,
      secValues,
      secMeta,
      cash,
      query.limit ?? 10,
    );
    return { series, points, ...meta };
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
   * Build a fresh FX lookup over the loaded intraday/daily rate series. Each
   * call owns its cursor state, so the total-value and breakdown views can each
   * walk the (ascending) grid independently. See the original inline notes:
   * live intraday bar at-or-before `ts` wins, else the stored daily close for
   * that bar's date, else the latest spot.
   */
  private makeIntradayFxAt(
    loaded: IntradayLoaded,
  ): (currency: string, ts: number) => number {
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
    return (currency: string, ts: number): number => {
      if (currency === display) return 1;
      const fx = loaded.fxByCurrency.get(currency);
      if (!fx) return loaded.spotRate.get(`${currency}->${display}`) ?? 1;
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
    const pref = await this.prefRepository.findOne({ where: { userId } });
    const displayCurrency =
      query.displayCurrency || pref?.defaultCurrency || "CAD";

    const cacheKey = this.buildIntradayCacheKey(
      userId,
      range,
      accountIds,
      displayCurrency,
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

    let activeHoldings: Array<{
      securityId: string;
      symbol: string;
      name: string;
      exchange: string | null;
      currencyCode: string;
      quantity: number;
      hasIntraday: boolean;
    }> = [];

    if (holdingsAccountIds.length > 0) {
      const holdings = await this.holdingsRepository.find({
        where: { accountId: In(holdingsAccountIds) },
        relations: ["security"],
      });

      const userDefaultProvider = pref?.defaultQuoteProvider ?? null;

      const aggregated = new Map<
        string,
        {
          securityId: string;
          symbol: string;
          name: string;
          exchange: string | null;
          currencyCode: string;
          quantity: number;
          hasIntraday: boolean;
        }
      >();
      for (const h of holdings) {
        const qty = Number(h.quantity);
        if (!h.security || h.security.isActive === false) continue;
        if (Math.abs(qty) < 0.0001) continue;
        const existing = aggregated.get(h.securityId);
        if (existing) {
          existing.quantity += qty;
        } else {
          // Resolve the security's primary quote provider; only providers
          // that implement fetchIntradaySeries can contribute to this chart.
          // MSN Money does not expose intraday quotes — see the note in the
          // user preferences UI under "Default Stock Quote Provider".
          const [primaryProvider] =
            this.quoteProviderRegistry.resolveForSecurity(
              h.security,
              userDefaultProvider,
            );
          const hasIntraday =
            typeof primaryProvider.fetchIntradaySeries === "function";
          aggregated.set(h.securityId, {
            securityId: h.securityId,
            symbol: h.security.symbol,
            name: h.security.name,
            exchange: h.security.exchange,
            currencyCode: h.security.currencyCode,
            quantity: qty,
            hasIntraday,
          });
        }
      }
      activeHoldings = [...aggregated.values()];
    }

    const fetchedAt = new Date().toISOString();
    const skippedSymbols = activeHoldings
      .filter((h) => !h.hasIntraday)
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
      staleByCurrency: [],
      cashByCurrency: [],
      fxByCurrency: new Map(),
      dailyRateIndex: new Map() as DailyRateIndex,
      spotRate: new Map(),
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

    const intradayHoldings = activeHoldings.filter((h) => h.hasIntraday);
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
    if (
      failedSymbols.length > 0 &&
      failedSymbols.length === intradayHoldings.length
    ) {
      return emptyLoaded({ failedSymbols, fallbackToDaily: true });
    }

    // Build the unified time grid from the union of all timestamps.
    const timestampSet = new Set<number>();
    for (const series of seriesBySecurity.values()) {
      for (const p of series) timestampSet.add(p.timestamp.getTime());
    }
    let timestamps = [...timestampSet].sort((a, b) => a - b);

    // Trim to a precise "start of (today - N days)" boundary. Yahoo's range
    // parameter is approximate (e.g. "1mo" excludes the calendar-month
    // boundary date), so we over-fetched above and now drop any bars that
    // fall before the requested calendar window.
    const lookbackDays = RANGE_LOOKBACK_DAYS[range];
    if (lookbackDays != null) {
      const cutoff = new Date();
      cutoff.setUTCHours(0, 0, 0, 0);
      cutoff.setUTCDate(cutoff.getUTCDate() - lookbackDays);
      const cutoffMs = cutoff.getTime();
      timestamps = timestamps.filter((ts) => ts >= cutoffMs);
    }

    // Cash held in the user's investment cash and standalone accounts is
    // part of the portfolio value just like holdings -- the daily-snapshot
    // endpoint already includes it (see net-worth.service.getDailyInvestments)
    // and we mirror that here so the 1D/1W/1M intraday chart agrees with
    // longer-range views.
    const cashAccountList = [...cashAccounts, ...standaloneAccounts];
    const cashIds = cashAccountList.map((a) => a.id);
    const effectiveBalances =
      await this.calculationService.computeEffectiveBalances(cashIds);

    // Group cash by native currency so FX can be applied at each timestamp.
    // Cash amounts don't move intraday, but their display-currency value does
    // when FX moves -- so foreign-currency cash can't be a flat additive
    // offset across the chart.
    const cashByCurrency = new Map<string, number>();
    for (const account of cashAccountList) {
      const balance =
        effectiveBalances.get(account.id) ?? Number(account.currentBalance);
      cashByCurrency.set(
        account.currencyCode,
        (cashByCurrency.get(account.currencyCode) ?? 0) + balance,
      );
    }

    // For holdings whose intraday fetch failed (Yahoo errored, was
    // rate-limited past the retry budget, or simply has no minute-resolution
    // data for this security -- common for mutual funds and illiquid names),
    // fall back to the security's latest known daily close. Kept both grouped
    // by currency (for the total series' per-currency rounding) and per
    // security (so the breakdown can give each stale holding its own band).
    // Without this, a single mutual fund in the user's portfolio would
    // either undercount the chart (if we ignored it) or pin the
    // "Couldn't load intraday prices" banner permanently (if we treated
    // it as a hard failure).
    const failedHoldings = intradayHoldings.filter(
      (h) => !seriesBySecurity.has(h.securityId),
    );
    const staleByCurrency = new Map<string, number>();
    const staleSources: IntradayLoaded["staleSources"] = [];
    if (failedHoldings.length > 0) {
      const latestPrices = await this.getLatestPrices(
        failedHoldings.map((h) => h.securityId),
      );
      for (const h of failedHoldings) {
        const lastClose = latestPrices.get(h.securityId);
        if (lastClose == null) continue;
        const amount = h.quantity * lastClose;
        staleByCurrency.set(
          h.currencyCode,
          (staleByCurrency.get(h.currencyCode) ?? 0) + amount,
        );
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
    const rateCache = new Map<string, number>();
    const fxCurrencies = new Set<string>([
      ...intradayHoldings.map((h) => h.currencyCode),
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
      staleByCurrency: [...staleByCurrency],
      cashByCurrency: [...cashByCurrency],
      fxByCurrency,
      dailyRateIndex,
      spotRate: rateCache,
    };
    this.intradayCache.set(cacheKey, {
      expiresAt: now + INTRADAY_CACHE_TTL_MS,
      loaded,
    });
    return loaded;
  }

  private buildIntradayCacheKey(
    userId: string,
    range: IntradayRangeKey,
    accountIds: string[] | undefined,
    displayCurrency: string,
  ): string {
    const acctPart = (accountIds ?? []).slice().sort().join(",");
    return `${userId}|${range}|${acctPart}|${displayCurrency}`;
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
    const requestedAccounts = await this.accountsRepository.find({
      where: {
        id: In(accountIds),
        userId,
        accountType: AccountType.INVESTMENT,
      },
    });
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
      const linkedAccounts = await this.accountsRepository.find({
        where: {
          id: In(linkedOnly),
          userId,
          accountType: AccountType.INVESTMENT,
        },
      });
      return [...requestedAccounts, ...linkedAccounts];
    }
    return requestedAccounts;
  }
}
