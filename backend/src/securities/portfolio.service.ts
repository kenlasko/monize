import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Holding } from './entities/holding.entity';
import { SecurityPrice } from './entities/security-price.entity';
import { Account, AccountType, AccountSubType } from '../accounts/entities/account.entity';

export interface HoldingWithMarketValue {
  id: string;
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

export interface PortfolioSummary {
  totalCashValue: number;
  totalHoldingsValue: number;
  totalCostBasis: number;
  totalPortfolioValue: number;
  totalGainLoss: number;
  totalGainLossPercent: number;
  holdings: HoldingWithMarketValue[];
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
   */
  async getLatestPrices(
    securityIds: string[],
  ): Promise<Map<string, number>> {
    if (securityIds.length === 0) {
      return new Map();
    }

    // Get the latest price for each security using a subquery
    const latestPrices = await this.securityPriceRepository
      .createQueryBuilder('sp')
      .select(['sp.securityId', 'sp.closePrice', 'sp.priceDate'])
      .where('sp.securityId IN (:...ids)', { ids: securityIds })
      .andWhere(
        `sp.priceDate = (
          SELECT MAX(sp2.price_date)
          FROM security_prices sp2
          WHERE sp2.security_id = sp.security_id
        )`,
      )
      .getRawMany();

    const priceMap = new Map<string, number>();
    for (const price of latestPrices) {
      priceMap.set(price.sp_security_id, Number(price.sp_close_price));
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
    const cashAccounts = accounts.filter(
      (a) => a.accountSubType === AccountSubType.INVESTMENT_CASH,
    );
    const brokerageAccounts = accounts.filter(
      (a) => a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE,
    );

    // Calculate total cash value from cash accounts
    const totalCashValue = cashAccounts.reduce(
      (sum, a) => sum + Number(a.currentBalance),
      0,
    );

    // Get holdings for brokerage accounts
    const brokerageAccountIds = brokerageAccounts.map((a) => a.id);
    let holdings: Holding[] = [];
    if (brokerageAccountIds.length > 0) {
      holdings = await this.holdingsRepository.find({
        where: { accountId: In(brokerageAccountIds) },
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

    const totalPortfolioValue = totalCashValue + totalHoldingsValue;
    const totalGainLoss = totalHoldingsValue - totalCostBasis;
    const totalGainLossPercent =
      totalCostBasis > 0 ? (totalGainLoss / totalCostBasis) * 100 : 0;

    return {
      totalCashValue,
      totalHoldingsValue,
      totalCostBasis,
      totalPortfolioValue,
      totalGainLoss,
      totalGainLossPercent,
      holdings: holdingsWithValues.sort((a, b) => {
        // Sort by market value descending, nulls last
        if (a.marketValue === null && b.marketValue === null) return 0;
        if (a.marketValue === null) return 1;
        if (b.marketValue === null) return -1;
        return b.marketValue - a.marketValue;
      }),
    };
  }

  /**
   * Get asset allocation breakdown
   */
  async getAssetAllocation(
    userId: string,
    accountId?: string,
  ): Promise<AssetAllocation> {
    const summary = await this.getPortfolioSummary(userId, accountId);
    const allocation: AllocationItem[] = [];

    // Add cash allocation
    if (summary.totalCashValue > 0) {
      allocation.push({
        name: 'Cash',
        symbol: null,
        type: 'cash',
        value: summary.totalCashValue,
        percentage:
          summary.totalPortfolioValue > 0
            ? (summary.totalCashValue / summary.totalPortfolioValue) * 100
            : 0,
        color: '#6b7280', // gray
      });
    }

    // Add securities allocation
    const colors = [
      '#3b82f6', // blue
      '#22c55e', // green
      '#f97316', // orange
      '#8b5cf6', // purple
      '#ec4899', // pink
      '#14b8a6', // teal
      '#eab308', // yellow
      '#ef4444', // red
    ];

    let colorIndex = 0;
    for (const holding of summary.holdings) {
      if (holding.marketValue !== null && holding.marketValue > 0) {
        allocation.push({
          name: holding.name,
          symbol: holding.symbol,
          type: 'security',
          value: holding.marketValue,
          percentage:
            summary.totalPortfolioValue > 0
              ? (holding.marketValue / summary.totalPortfolioValue) * 100
              : 0,
          color: colors[colorIndex % colors.length],
        });
        colorIndex++;
      }
    }

    return {
      allocation: allocation.sort((a, b) => b.value - a.value),
      totalValue: summary.totalPortfolioValue,
    };
  }
}
