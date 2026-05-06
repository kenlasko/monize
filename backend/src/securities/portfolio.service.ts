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
  "1w": { interval: "5m", range: "5d" },
  "1m": { interval: "15m", range: "1mo" },
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
    { interval: "15m", range: "5d" },
    { interval: "30m", range: "5d" },
    { interval: "60m", range: "5d" },
    { interval: "90m", range: "5d" },
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

    const roundMoney = (v: number | null | undefined): number =>
      v === null || v === undefined ? 0 : Math.round(Number(v) * 10000) / 10000;
    const roundMoneyNullable = (v: number | null | undefined): number | null =>
      v === null || v === undefined
        ? null
        : Math.round(Number(v) * 10000) / 10000;
    const roundPct = (v: number | null | undefined): number | null =>
      v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100;

    const holdings: LlmPortfolioHolding[] = summary.holdings.map((h) => ({
      symbol: h.symbol,
      name: h.name,
      securityType: h.securityType,
      currency: h.currencyCode,
      quantity: h.quantity,
      averageCost: roundMoneyNullable(h.averageCost),
      costBasis: roundMoney(h.costBasis),
      marketValue: roundMoneyNullable(h.marketValue),
      gainLoss: roundMoneyNullable(h.gainLoss),
      gainLossPercent: roundPct(h.gainLossPercent),
    }));

    const allocation: LlmPortfolioAllocation[] = summary.allocation.map(
      (a) => ({
        name: a.name,
        symbol: a.symbol,
        type: a.type,
        value: roundMoney(a.value),
        percentage: roundPct(a.percentage) ?? 0,
      }),
    );

    return {
      holdingCount: holdings.length,
      totalCashValue: roundMoney(summary.totalCashValue),
      totalHoldingsValue: roundMoney(summary.totalHoldingsValue),
      totalCostBasis: roundMoney(summary.totalCostBasis),
      totalPortfolioValue: roundMoney(summary.totalPortfolioValue),
      totalGainLoss: roundMoney(summary.totalGainLoss),
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
        h.security?.isActive !== false,
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
      rn: string;
    }> = await this.securityPriceRepository.query(
      `SELECT security_id, close_price, rn FROM (
         SELECT security_id, close_price,
                ROW_NUMBER() OVER (PARTITION BY security_id ORDER BY price_date DESC) as rn
         FROM security_prices
         WHERE security_id = ANY($1)
       ) sub
       WHERE rn <= 2
       ORDER BY security_id, rn`,
      [securityIds],
    );

    // Build a map: securityId -> [latestPrice, previousPrice]
    const priceMap = new Map<string, number[]>();
    for (const row of priceRows) {
      const existing = priceMap.get(row.security_id) || [];
      existing.push(Number(row.close_price));
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

      const [currentPrice, previousPrice] = prices;
      if (previousPrice === 0) continue;

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
        h.security?.isActive !== false,
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
    await Promise.all(
      intradayHoldings.map(async (h) => {
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
      }),
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
    const timestamps = [...timestampSet].sort((a, b) => a - b);

    // Pre-compute FX rates from each security currency to the display
    // currency. Intraday FX moves are tiny relative to chart resolution and
    // we already pay this latency once for the price fetches; reusing the
    // latest spot rate is the same simplification used elsewhere.
    const rateCache = new Map<string, number>();
    const currencies = new Set(intradayHoldings.map((h) => h.currencyCode));
    for (const c of currencies) {
      await this.calculationService.convertToDefault(
        1,
        c,
        displayCurrency,
        rateCache,
      );
    }

    // Cash held in the user's investment cash and standalone accounts is
    // part of the portfolio value just like holdings -- the daily-snapshot
    // endpoint already includes it (see net-worth.service.getDailyInvestments)
    // and we mirror that here so the 1D/1W/1M intraday chart agrees with
    // longer-range views. Cash doesn't move intraday from price changes, so
    // it's a constant additive offset across every grid point.
    const cashAccountList = [...cashAccounts, ...standaloneAccounts];
    const cashIds = cashAccountList.map((a) => a.id);
    const effectiveBalances =
      await this.calculationService.computeEffectiveBalances(cashIds);
    const totalCashValue = await this.calculationService.computeTotalCashValue(
      cashAccountList,
      effectiveBalances,
      displayCurrency,
      rateCache,
    );
    const cashCents = Math.round(totalCashValue * 10000);

    // For holdings whose intraday fetch failed (Yahoo errored, was
    // rate-limited past the retry budget, or simply has no minute-resolution
    // data for this security -- common for mutual funds and illiquid names),
    // fall back to the security's latest known daily close. Treat that
    // value as a constant additive offset, the same way cash is handled.
    // Without this, a single mutual fund in the user's portfolio would
    // either undercount the chart (if we ignored it) or pin the
    // "Couldn't load intraday prices" banner permanently (if we treated
    // it as a hard failure).
    const failedHoldings = intradayHoldings.filter(
      (h) => !seriesBySecurity.has(h.securityId),
    );
    let staleHoldingsCents = 0;
    if (failedHoldings.length > 0) {
      const latestPrices = await this.getLatestPrices(
        failedHoldings.map((h) => h.securityId),
      );
      for (const h of failedHoldings) {
        const lastClose = latestPrices.get(h.securityId);
        if (lastClose == null) continue;
        const fxRate =
          rateCache.get(`${h.currencyCode}->${displayCurrency}`) ?? 1;
        staleHoldingsCents += Math.round(
          h.quantity * lastClose * fxRate * 10000,
        );
      }
    }
    const constantCents = cashCents + staleHoldingsCents;

    // Build per-security ordered timestamp/close arrays and a cursor-based
    // forward-fill so each grid point uses the latest known close.
    const sources = intradayHoldings
      .map((h) => {
        const points = seriesBySecurity.get(h.securityId);
        if (!points || points.length === 0) return null;
        return {
          quantity: h.quantity,
          fxRate:
            rateCache.get(`${h.currencyCode}->${displayCurrency}`) ??
            (h.currencyCode === displayCurrency ? 1 : 1),
          times: points.map((p) => p.timestamp.getTime()),
          closes: points.map((p) => p.close),
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    const cursors = sources.map(() => -1);
    const points: IntradayValuePoint[] = [];

    for (const ts of timestamps) {
      let totalCents = constantCents; // integer arithmetic to avoid float drift
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
        // peers), value it at its earliest known close. Without this, every
        // unstarted series contributes 0 and the aggregate jumps up the
        // moment each one's first bar arrives — which is exactly the
        // "significant jump" the chart used to show on multi-account views.
        const close = cursors[i] < 0 ? src.closes[0] : src.closes[cursors[i]];
        const valueInDisplay = src.quantity * close * src.fxRate;
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

    // Batch fetch all requested accounts in one query
    const requestedAccounts = await this.accountsRepository.find({
      where: { id: In(accountIds), userId },
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
        where: { id: In(linkedOnly), userId },
      });
      return [...requestedAccounts, ...linkedAccounts];
    }
    return requestedAccounts;
  }
}
