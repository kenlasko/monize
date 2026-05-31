import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In } from "typeorm";
import { Holding } from "./entities/holding.entity";
import { SecurityPrice } from "./entities/security-price.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { PortfolioCalculationService } from "./portfolio-calculation.service";
import { YahooFinanceService } from "./yahoo-finance.service";
import { QuoteProviderRegistry } from "./providers/quote-provider.registry";
import { roundMoney } from "../common/round.util";
import { mapWithConcurrency } from "../common/concurrency.util";
import {
  IntradayInterval,
  IntradayPoint,
  IntradayRange,
} from "./providers/quote-provider.interface";
import {
  IntradayRangeKey,
  IntradayValuePoint,
  IntradayValueResponse,
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
  type: "cash" | "security";
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
  type: "cash" | "security";
  value: number;
  percentage: number;
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
  allocation: LlmPortfolioAllocation[];
}

interface IntradayCacheEntry {
  expiresAt: number;
  payload: IntradayValueResponse;
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
      totalPortfolioValue,
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

    const holdings: LlmPortfolioHolding[] = summary.holdings.map((h) => ({
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
   * Compute the intraday portfolio value series for the user's current
   * holdings. Pulls live minute/hour bars from Yahoo Finance for each
   * security, aligns them on a unified time grid, and converts each bar to
   * the user's display currency.
   *
   * Results are cached in-memory for 60 seconds keyed by
   * `userId|range|accountIds|currency` to absorb double clicks and the
   * frontend's optimistic refresh.
   */
  async getIntradayValueSeries(
    userId: string,
    query: {
      range: IntradayRangeKey;
      accountIds?: string[];
      displayCurrency?: string;
    },
  ): Promise<IntradayValueResponse> {
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
      return cached.payload;
    }

    const yahooParams = RANGE_TO_YAHOO[range];

    const accounts = await this.resolveAccounts(userId, accountIds);
    const { cashAccounts, standaloneAccounts, holdingsAccountIds } =
      this.calculationService.categoriseAccounts(accounts);

    let activeHoldings: Array<{
      securityId: string;
      symbol: string;
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

    if (activeHoldings.length === 0 || fallbackToDaily) {
      const payload: IntradayValueResponse = {
        points: [],
        interval: yahooParams.interval,
        currency: displayCurrency,
        range,
        fetchedAt,
        skippedSymbols,
        failedSymbols: [],
        fallbackToDaily,
      };
      this.intradayCache.set(cacheKey, {
        expiresAt: now + INTRADAY_CACHE_TTL_MS,
        payload,
      });
      return payload;
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
    // We deliberately do NOT cache this failure payload: caching it would
    // leave the "Couldn't load intraday prices" banner pinned on screen
    // even after the user clicks Refresh and the issue resolves.
    if (
      failedSymbols.length > 0 &&
      failedSymbols.length === intradayHoldings.length
    ) {
      return {
        points: [],
        interval: yahooParams.interval,
        currency: displayCurrency,
        range,
        fetchedAt,
        skippedSymbols,
        failedSymbols,
        fallbackToDaily: true,
      };
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
    // fall back to the security's latest known daily close. Group by native
    // currency so per-timestamp FX still applies to these "stale" amounts.
    // Without this, a single mutual fund in the user's portfolio would
    // either undercount the chart (if we ignored it) or pin the
    // "Couldn't load intraday prices" banner permanently (if we treated
    // it as a hard failure).
    const failedHoldings = intradayHoldings.filter(
      (h) => !seriesBySecurity.has(h.securityId),
    );
    const staleByCurrency = new Map<string, number>();
    if (failedHoldings.length > 0) {
      const latestPrices = await this.getLatestPrices(
        failedHoldings.map((h) => h.securityId),
      );
      for (const h of failedHoldings) {
        const lastClose = latestPrices.get(h.securityId);
        if (lastClose == null) continue;
        staleByCurrency.set(
          h.currencyCode,
          (staleByCurrency.get(h.currencyCode) ?? 0) + h.quantity * lastClose,
        );
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

    type FxCursor = {
      times: number[];
      rates: number[];
      cursor: number;
      latest: number;
    };
    const fxByCurrency = new Map<string, FxCursor>();
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
        let series: IntradayPoint[] | null = null;
        try {
          series = await this.yahooFinanceService.fetchIntradayFxSeries(
            currency,
            displayCurrency,
            yahooParams,
          );
        } catch (error) {
          this.logger.warn(
            `Failed to fetch intraday FX ${currency}->${displayCurrency}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        fxByCurrency.set(currency, {
          times: series?.map((p) => p.timestamp.getTime()) ?? [],
          rates: series?.map((p) => p.close) ?? [],
          cursor: -1,
          latest,
        });
      },
    );

    // Walk each FX cursor monotonically as the grid advances; if no
    // intraday FX series is available (failed fetch or same-currency),
    // use the latest spot. Backfill the earliest known rate when the
    // first FX bar arrives after the current grid timestamp.
    const fxAt = (currency: string, ts: number): number => {
      if (currency === displayCurrency) return 1;
      const fx = fxByCurrency.get(currency);
      if (!fx) return rateCache.get(`${currency}->${displayCurrency}`) ?? 1;
      if (fx.times.length === 0) return fx.latest;
      while (fx.cursor + 1 < fx.times.length && fx.times[fx.cursor + 1] <= ts) {
        fx.cursor++;
      }
      return fx.cursor < 0 ? fx.rates[0] : fx.rates[fx.cursor];
    };

    // Build per-security ordered timestamp/close arrays and a cursor-based
    // forward-fill so each grid point uses the latest known close.
    const sources = intradayHoldings
      .map((h) => {
        const points = seriesBySecurity.get(h.securityId);
        if (!points || points.length === 0) return null;
        return {
          quantity: h.quantity,
          currencyCode: h.currencyCode,
          times: points.map((p) => p.timestamp.getTime()),
          opens: points.map((p) => p.open),
          closes: points.map((p) => p.close),
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    const cursors = sources.map(() => -1);
    const points: IntradayValuePoint[] = [];

    for (const ts of timestamps) {
      let totalCents = 0; // integer arithmetic to avoid float drift
      // Cash contributions, valued at the FX rate prevailing at this bar.
      for (const [ccy, amount] of cashByCurrency) {
        totalCents += Math.round(amount * fxAt(ccy, ts) * 10000);
      }
      // Stale-holding contributions (last daily close * quantity), same
      // per-timestamp FX treatment as live holdings.
      for (const [ccy, amount] of staleByCurrency) {
        totalCents += Math.round(amount * fxAt(ccy, ts) * 10000);
      }
      for (let i = 0; i < sources.length; i++) {
        const src = sources[i];
        // Advance cursor to the latest sample at-or-before ts.
        while (
          cursors[i] + 1 < src.times.length &&
          src.times[cursors[i] + 1] <= ts
        ) {
          cursors[i]++;
        }
        // Backfill: when this security's first bar is later than the current
        // grid timestamp (e.g. one holding is on an exchange with thinner
        // intraday coverage, or just has a slightly later first-bar than its
        // peers), value it at its earliest known open. Without this, every
        // unstarted series contributes 0 and the aggregate jumps up the
        // moment each one's first bar arrives — which is exactly the
        // "significant jump" the chart used to show on multi-account views.
        //
        // At the very first bar of each security (cursor=0 and ts equals the
        // first bar's timestamp) we also use that bar's open rather than its
        // close, so the chart's starting value matches the day's official
        // opening price (the same one stored in security_prices.open_price)
        // rather than the price at the end of the first 1-minute bar.
        const atFirstBar =
          cursors[i] === 0 && ts === src.times[0] && src.opens[0] != null;
        let price: number;
        if (cursors[i] < 0) {
          price = src.opens[0] ?? src.closes[0];
        } else if (atFirstBar) {
          price = src.opens[0] as number;
        } else {
          price = src.closes[cursors[i]];
        }
        const valueInDisplay =
          src.quantity * price * fxAt(src.currencyCode, ts);
        totalCents += Math.round(valueInDisplay * 10000);
      }
      points.push({
        timestamp: new Date(ts).toISOString(),
        value: totalCents / 10000,
      });
    }

    const payload: IntradayValueResponse = {
      points,
      interval: yahooParams.interval,
      currency: displayCurrency,
      range,
      fetchedAt,
      skippedSymbols,
      failedSymbols: [],
      fallbackToDaily: false,
    };
    this.intradayCache.set(cacheKey, {
      expiresAt: now + INTRADAY_CACHE_TTL_MS,
      payload,
    });
    return payload;
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
