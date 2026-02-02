import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Holding } from './entities/holding.entity';
import { SecurityPrice } from './entities/security-price.entity';
import { Account, AccountType, AccountSubType } from '../accounts/entities/account.entity';

export interface HoldingWithMarketValue {
  id: string;
  accountId: string;
  symbol: string;
  name: string;
  securityType: string;
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
  allocation: AllocationItem[];  // Include allocation to avoid duplicate API call
}

export interface AllocationItem {
  name: string;
  symbol: string | null;
  type: 'cash' | 'security';
  value: number;
  percentage: number;
  color?: string;
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
  ) {}

  /**
   * Get the latest prices for a list of security IDs
   * Uses DISTINCT ON for efficient single-pass query instead of correlated subquery
   */
  async getLatestPrices(
    securityIds: string[],
  ): Promise<Map<string, number>> {
    if (securityIds.length === 0) {
      return new Map();
    }

    // Use DISTINCT ON (PostgreSQL) for efficient single-pass latest price lookup
    // This is much faster than correlated subquery approach
    const latestPrices = await this.securityPriceRepository
      .query(
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
    accountId?: string,
  ): Promise<PortfolioSummary> {
    // Get investment accounts
    let accounts: Account[];
    if (accountId) {
      // If account ID provided, get the pair
      const account = await this.accountsRepository.findOne({
        where: { id: accountId, userId },
      });
      if (account?.linkedAccountId) {
        accounts = await this.accountsRepository.find({
          where: { id: In([accountId, account.linkedAccountId]) },
        });
      } else {
        accounts = account ? [account] : [];
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

    // Calculate total cash value from cash accounts + standalone accounts
    const totalCashValue = cashAccounts.reduce(
      (sum, a) => sum + Number(a.currentBalance),
      0,
    ) + standaloneAccounts.reduce(
      (sum, a) => sum + Number(a.currentBalance),
      0,
    );

    // Get holdings for brokerage accounts AND standalone accounts
    const holdingsAccountIds = [
      ...brokerageAccounts.map((a) => a.id),
      ...standaloneAccounts.map((a) => a.id),
    ];
    let holdings: Holding[] = [];
    if (holdingsAccountIds.length > 0) {
      holdings = await this.holdingsRepository.find({
        where: { accountId: In(holdingsAccountIds) },
        relations: ['security'],
      });
    }

    // Get latest prices for all securities in holdings
    const securityIds = [...new Set(holdings.map((h) => h.securityId))];
    const priceMap = await this.getLatestPrices(securityIds);

    // Calculate holdings with market values
    let totalCostBasis = 0;
    let totalHoldingsValue = 0;

    const holdingsWithValues: HoldingWithMarketValue[] = holdings
      .filter((h) => Number(h.quantity) !== 0)
      .map((h) => {
        const quantity = Number(h.quantity);
        const averageCost = Number(h.averageCost || 0);
        const costBasis = quantity * averageCost;
        const currentPrice = priceMap.get(h.securityId) ?? null;
        const marketValue = currentPrice !== null ? quantity * currentPrice : null;
        const gainLoss =
          marketValue !== null && costBasis > 0 ? marketValue - costBasis : null;
        const gainLossPercent =
          gainLoss !== null && costBasis > 0
            ? (gainLoss / costBasis) * 100
            : null;

        totalCostBasis += costBasis;
        if (marketValue !== null) {
          totalHoldingsValue += marketValue;
        }

        return {
          id: h.id,
          accountId: h.accountId,
          securityId: h.securityId,
          symbol: h.security.symbol,
          name: h.security.name,
          securityType: h.security.securityType || 'STOCK',
          quantity,
          averageCost,
          costBasis,
          currentPrice,
          marketValue,
          gainLoss,
          gainLossPercent,
        };
      });

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
      const accountHoldings = holdingsByAccountMap.get(brokerageAccount.id) || [];

      // Find the linked cash account
      const linkedCashAccount = cashAccounts.find(
        (c) => c.linkedAccountId === brokerageAccount.id || brokerageAccount.linkedAccountId === c.id,
      );

      // Calculate account totals
      const accountCostBasis = accountHoldings.reduce((sum, h) => sum + h.costBasis, 0);
      const accountMarketValue = accountHoldings.reduce(
        (sum, h) => sum + (h.marketValue ?? 0),
        0,
      );
      const accountGainLoss = accountMarketValue - accountCostBasis;
      const accountGainLossPercent =
        accountCostBasis > 0 ? (accountGainLoss / accountCostBasis) * 100 : 0;

      // Get display name (remove " - Brokerage" suffix if present)
      const accountName = brokerageAccount.name.replace(' - Brokerage', '');

      holdingsByAccount.push({
        accountId: brokerageAccount.id,
        accountName,
        cashAccountId: linkedCashAccount?.id ?? null,
        cashBalance: linkedCashAccount ? Number(linkedCashAccount.currentBalance) : 0,
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
      const accountHoldings = holdingsByAccountMap.get(standaloneAccount.id) || [];

      // Calculate account totals
      const accountCostBasis = accountHoldings.reduce((sum, h) => sum + h.costBasis, 0);
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
        cashAccountId: standaloneAccount.id, // Cash is on this same account
        cashBalance: Number(standaloneAccount.currentBalance),
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
      '#3b82f6', '#22c55e', '#f97316', '#8b5cf6',
      '#ec4899', '#14b8a6', '#eab308', '#ef4444',
    ];

    if (totalCashValue > 0) {
      allocation.push({
        name: 'Cash',
        symbol: null,
        type: 'cash',
        value: totalCashValue,
        percentage: totalPortfolioValue > 0 ? (totalCashValue / totalPortfolioValue) * 100 : 0,
        color: '#6b7280',
      });
    }

    let colorIndex = 0;
    for (const holding of sortedHoldings) {
      if (holding.marketValue !== null && holding.marketValue > 0) {
        allocation.push({
          name: holding.name,
          symbol: holding.symbol,
          type: 'security',
          value: holding.marketValue,
          percentage: totalPortfolioValue > 0 ? (holding.marketValue / totalPortfolioValue) * 100 : 0,
          color: colors[colorIndex % colors.length],
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
   * Get asset allocation breakdown
   * Note: This now just extracts the pre-computed allocation from getPortfolioSummary
   * to maintain backwards compatibility. Prefer using summary.allocation directly.
   */
  async getAssetAllocation(
    userId: string,
    accountId?: string,
  ): Promise<AssetAllocation> {
    const summary = await this.getPortfolioSummary(userId, accountId);
    return {
      allocation: summary.allocation,
      totalValue: summary.totalPortfolioValue,
    };
  }
}
