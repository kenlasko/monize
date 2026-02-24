import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In } from "typeorm";
import { Holding } from "./entities/holding.entity";
import { SecurityPrice } from "./entities/security-price.entity";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";

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
}

export interface PortfolioSummary {
  totalCashValue: number;
  totalHoldingsValue: number;
  totalCostBasis: number;
  totalPortfolioValue: number;
  totalGainLoss: number;
  totalGainLossPercent: number;
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
    private exchangeRateService: ExchangeRateService,
  ) {}

  /**
   * Convert an amount from one currency to another using latest exchange rates.
   * Returns the original amount if no rate is found or currencies match.
   */
  private async convertToDefault(
    amount: number,
    fromCurrency: string,
    defaultCurrency: string,
    rateCache: Map<string, number>,
  ): Promise<number> {
    if (fromCurrency === defaultCurrency) return amount;

    const cacheKey = `${fromCurrency}->${defaultCurrency}`;
    let rate = rateCache.get(cacheKey);
    if (rate === undefined) {
      const directRate = await this.exchangeRateService.getLatestRate(
        fromCurrency,
        defaultCurrency,
      );
      if (directRate !== null) {
        rate = directRate;
      } else {
        const reverseRate = await this.exchangeRateService.getLatestRate(
          defaultCurrency,
          fromCurrency,
        );
        rate = reverseRate !== null ? 1 / reverseRate : 1;
      }
      rateCache.set(cacheKey, rate);
    }
    return amount * rate;
  }

  /**
   * Get the latest prices for a list of security IDs
   * Uses DISTINCT ON for efficient single-pass query instead of correlated subquery
   */
  async getLatestPrices(securityIds: string[]): Promise<Map<string, number>> {
    if (securityIds.length === 0) {
      return new Map();
    }

    // Use DISTINCT ON (PostgreSQL) for efficient single-pass latest price lookup
    // This is much faster than correlated subquery approach
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
    let accounts: Account[];
    if (accountIds && accountIds.length > 0) {
      // Batch fetch all requested accounts in one query (instead of N individual queries)
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
        accounts = [...requestedAccounts, ...linkedAccounts];
      } else {
        accounts = requestedAccounts;
      }
    } else {
      accounts = await this.getInvestmentAccounts(userId);
    }

    // Separate cash and brokerage accounts
    // Also handle standalone investment accounts (no subType) - treat them as having holdings with their own cash balance
    const cashAccounts = accounts.filter(
      (a) => a.accountSubType === AccountSubType.INVESTMENT_CASH,
    );
    const brokerageAccounts = accounts.filter(
      (a) => a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE,
    );
    // Standalone accounts are investment accounts without a subType
    const standaloneAccounts = accounts.filter(
      (a) => a.accountSubType === null || a.accountSubType === undefined,
    );

    // Compute effective cash balances excluding future-dated transactions
    const cashAndStandaloneIds = [...cashAccounts, ...standaloneAccounts].map(
      (a) => a.id,
    );
    const effectiveBalances = new Map<string, number>();

    if (cashAndStandaloneIds.length > 0) {
      const balanceRows: { account_id: string; balance: string }[] =
        await this.accountsRepository.query(
          `SELECT a.id as account_id,
                  COALESCE(a.opening_balance, 0) + COALESCE(SUM(t.amount), 0) as balance
           FROM accounts a
           LEFT JOIN transactions t ON t.account_id = a.id
             AND (t.status IS NULL OR t.status != 'VOID')
             AND t.parent_transaction_id IS NULL
             AND t.transaction_date <= CURRENT_DATE
           WHERE a.id = ANY($1)
           GROUP BY a.id, a.opening_balance`,
          [cashAndStandaloneIds],
        );
      for (const row of balanceRows) {
        effectiveBalances.set(
          row.account_id,
          Math.round(Number(row.balance) * 100) / 100,
        );
      }
    }

    // Calculate total cash value from cash accounts + standalone accounts (converted to default currency)
    let totalCashValue = 0;
    for (const a of [...cashAccounts, ...standaloneAccounts]) {
      const balance = effectiveBalances.get(a.id) ?? Number(a.currentBalance);
      totalCashValue += await this.convertToDefault(
        balance,
        a.currencyCode,
        defaultCurrency,
        rateCache,
      );
    }

    // Get holdings for brokerage accounts AND standalone accounts
    const holdingsAccountIds = [
      ...brokerageAccounts.map((a) => a.id),
      ...standaloneAccounts.map((a) => a.id),
    ];
    let holdings: Holding[] = [];
    if (holdingsAccountIds.length > 0) {
      holdings = await this.holdingsRepository.find({
        where: { accountId: In(holdingsAccountIds) },
        relations: ["security"],
      });
    }

    // Get latest prices for all securities in holdings
    const securityIds = [...new Set(holdings.map((h) => h.securityId))];
    const priceMap = await this.getLatestPrices(securityIds);

    // Calculate holdings with market values
    // Individual holding values stay in native currency; totals are converted to default currency
    let totalCostBasis = 0;
    let totalHoldingsValue = 0;

    const holdingsWithValues: HoldingWithMarketValue[] = [];
    for (const h of holdings) {
      if (Number(h.quantity) === 0) continue;

      const quantity = Number(h.quantity);
      const averageCost = Number(h.averageCost || 0);
      const costBasis = quantity * averageCost;
      const currentPrice = priceMap.get(h.securityId) ?? null;
      const marketValue =
        currentPrice !== null ? quantity * currentPrice : null;
      const gainLoss =
        marketValue !== null && costBasis > 0 ? marketValue - costBasis : null;
      const gainLossPercent =
        gainLoss !== null && costBasis > 0
          ? (gainLoss / costBasis) * 100
          : null;

      const holdingCurrency = h.security.currencyCode;
      totalCostBasis += await this.convertToDefault(
        costBasis,
        holdingCurrency,
        defaultCurrency,
        rateCache,
      );
      if (marketValue !== null) {
        totalHoldingsValue += await this.convertToDefault(
          marketValue,
          holdingCurrency,
          defaultCurrency,
          rateCache,
        );
      }

      holdingsWithValues.push({
        id: h.id,
        accountId: h.accountId,
        securityId: h.securityId,
        symbol: h.security.symbol,
        name: h.security.name,
        securityType: h.security.securityType || "STOCK",
        currencyCode: holdingCurrency,
        quantity,
        averageCost,
        costBasis,
        currentPrice,
        marketValue,
        gainLoss,
        gainLossPercent,
      });
    }

    // Group holdings by account
    const holdingsByAccountMap = new Map<string, HoldingWithMarketValue[]>();
    for (const holding of holdingsWithValues) {
      const existing = holdingsByAccountMap.get(holding.accountId) || [];
      existing.push(holding);
      holdingsByAccountMap.set(holding.accountId, existing);
    }

    // Build holdingsByAccount array with account info and totals
    const holdingsByAccount: AccountHoldings[] = [];

    // Process brokerage accounts (paired with cash accounts)
    for (const brokerageAccount of brokerageAccounts) {
      const accountHoldings =
        holdingsByAccountMap.get(brokerageAccount.id) || [];

      // Find the linked cash account
      const linkedCashAccount = cashAccounts.find(
        (c) =>
          c.linkedAccountId === brokerageAccount.id ||
          brokerageAccount.linkedAccountId === c.id,
      );

      // Calculate account totals
      const accountCostBasis = accountHoldings.reduce(
        (sum, h) => sum + h.costBasis,
        0,
      );
      const accountMarketValue = accountHoldings.reduce(
        (sum, h) => sum + (h.marketValue ?? 0),
        0,
      );
      const accountGainLoss = accountMarketValue - accountCostBasis;
      const accountGainLossPercent =
        accountCostBasis > 0 ? (accountGainLoss / accountCostBasis) * 100 : 0;

      // Get display name (remove " - Brokerage" suffix if present)
      const accountName = brokerageAccount.name.replace(" - Brokerage", "");

      holdingsByAccount.push({
        accountId: brokerageAccount.id,
        accountName,
        currencyCode: brokerageAccount.currencyCode,
        cashAccountId: linkedCashAccount?.id ?? null,
        cashBalance: linkedCashAccount
          ? (effectiveBalances.get(linkedCashAccount.id) ??
            Number(linkedCashAccount.currentBalance))
          : 0,
        holdings: accountHoldings.sort((a, b) => {
          if (a.marketValue === null && b.marketValue === null) return 0;
          if (a.marketValue === null) return 1;
          if (b.marketValue === null) return -1;
          return b.marketValue - a.marketValue;
        }),
        totalCostBasis: accountCostBasis,
        totalMarketValue: accountMarketValue,
        totalGainLoss: accountGainLoss,
        totalGainLossPercent: accountGainLossPercent,
      });
    }

    // Process standalone investment accounts (not paired, cash balance is on the same account)
    for (const standaloneAccount of standaloneAccounts) {
      const accountHoldings =
        holdingsByAccountMap.get(standaloneAccount.id) || [];

      // Calculate account totals
      const accountCostBasis = accountHoldings.reduce(
        (sum, h) => sum + h.costBasis,
        0,
      );
      const accountMarketValue = accountHoldings.reduce(
        (sum, h) => sum + (h.marketValue ?? 0),
        0,
      );
      const accountGainLoss = accountMarketValue - accountCostBasis;
      const accountGainLossPercent =
        accountCostBasis > 0 ? (accountGainLoss / accountCostBasis) * 100 : 0;

      holdingsByAccount.push({
        accountId: standaloneAccount.id,
        accountName: standaloneAccount.name,
        currencyCode: standaloneAccount.currencyCode,
        cashAccountId: standaloneAccount.id, // Cash is on this same account
        cashBalance:
          effectiveBalances.get(standaloneAccount.id) ??
          Number(standaloneAccount.currentBalance),
        holdings: accountHoldings.sort((a, b) => {
          if (a.marketValue === null && b.marketValue === null) return 0;
          if (a.marketValue === null) return 1;
          if (b.marketValue === null) return -1;
          return b.marketValue - a.marketValue;
        }),
        totalCostBasis: accountCostBasis,
        totalMarketValue: accountMarketValue,
        totalGainLoss: accountGainLoss,
        totalGainLossPercent: accountGainLossPercent,
      });
    }

    // Sort accounts by total market value descending
    holdingsByAccount.sort((a, b) => b.totalMarketValue - a.totalMarketValue);

    const totalPortfolioValue = totalCashValue + totalHoldingsValue;
    const totalGainLoss = totalHoldingsValue - totalCostBasis;
    const totalGainLossPercent =
      totalCostBasis > 0 ? (totalGainLoss / totalCostBasis) * 100 : 0;

    // Sort holdings by market value
    const sortedHoldings = holdingsWithValues.sort((a, b) => {
      if (a.marketValue === null && b.marketValue === null) return 0;
      if (a.marketValue === null) return 1;
      if (b.marketValue === null) return -1;
      return b.marketValue - a.marketValue;
    });

    // Build allocation data inline (avoid duplicate getPortfolioSummary call)
    const allocation: AllocationItem[] = [];
    const colors = [
      "#3b82f6",
      "#22c55e",
      "#f97316",
      "#8b5cf6",
      "#ec4899",
      "#14b8a6",
      "#eab308",
      "#ef4444",
    ];

    if (totalCashValue > 0) {
      allocation.push({
        name: "Cash",
        symbol: null,
        type: "cash",
        value: totalCashValue,
        percentage:
          totalPortfolioValue > 0
            ? (totalCashValue / totalPortfolioValue) * 100
            : 0,
        color: "#6b7280",
        currencyCode: defaultCurrency,
      });
    }

    let colorIndex = 0;
    for (const holding of sortedHoldings) {
      if (holding.marketValue !== null && holding.marketValue > 0) {
        const originalHolding = holdings.find((h) => h.id === holding.id);
        const holdingCurrency =
          originalHolding?.security?.currencyCode || defaultCurrency;
        const convertedValue = await this.convertToDefault(
          holding.marketValue,
          holdingCurrency,
          defaultCurrency,
          rateCache,
        );
        allocation.push({
          name: holding.name,
          symbol: holding.symbol,
          type: "security",
          value: convertedValue,
          percentage:
            totalPortfolioValue > 0
              ? (convertedValue / totalPortfolioValue) * 100
              : 0,
          color: colors[colorIndex % colors.length],
          currencyCode: holdingCurrency,
        });
        colorIndex++;
      }
    }

    allocation.sort((a, b) => b.value - a.value);

    return {
      totalCashValue,
      totalHoldingsValue,
      totalCostBasis,
      totalPortfolioValue,
      totalGainLoss,
      totalGainLossPercent,
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
    const brokerageAccounts = accounts.filter(
      (a) => a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE,
    );
    const standaloneAccounts = accounts.filter(
      (a) => a.accountSubType === null || a.accountSubType === undefined,
    );
    const holdingsAccountIds = [
      ...brokerageAccounts.map((a) => a.id),
      ...standaloneAccounts.map((a) => a.id),
    ];

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
    const brokerageAccounts = accounts.filter(
      (a) => a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE,
    );
    const standaloneAccounts = accounts.filter(
      (a) => a.accountSubType === null || a.accountSubType === undefined,
    );
    const holdingsAccountIds = [
      ...brokerageAccounts.map((a) => a.id),
      ...standaloneAccounts.map((a) => a.id),
    ];

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
      if (currentPrice == null || previousPrice == null || previousPrice === 0) continue;

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
}
