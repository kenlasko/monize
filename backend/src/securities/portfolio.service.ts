import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In } from "typeorm";
import { Holding } from "./entities/holding.entity";
import { SecurityPrice } from "./entities/security-price.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { PortfolioCalculationService } from "./portfolio-calculation.service";

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
  costBasis: number;
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

@Injectable()
export class PortfolioService {
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
        categorised.holdingsAccountIds,
        defaultCurrency,
        rateCache,
        (ids) => this.getLatestPrices(ids),
      );

    // Group holdings by account
    const holdingsByAccount = this.calculationService.buildHoldingsByAccount(
      categorised,
      holdingsResult.holdingsWithValues,
      effectiveBalances,
      investmentFlows,
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
      (h) => Number(h.quantity) !== 0 && h.security?.isActive !== false,
    );
    if (activeHoldings.length === 0) return [];

    // Get unique security IDs
    const securityIds = [...new Set(activeHoldings.map((h) => h.securityId))];

    // Query the two most recent weekday (Mon-Fri) prices for each security
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
           AND EXTRACT(DOW FROM price_date) BETWEEN 1 AND 5
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
      (h) => Number(h.quantity) !== 0 && h.security?.isActive !== false,
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
