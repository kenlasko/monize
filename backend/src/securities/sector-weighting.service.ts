import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In } from "typeorm";
import { Security } from "./entities/security.entity";
import { Holding } from "./entities/holding.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { SecurityPrice } from "./entities/security-price.entity";
import { YahooFinanceService } from "./yahoo-finance.service";
import { PortfolioCalculationService } from "./portfolio-calculation.service";

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

@Injectable()
export class SectorWeightingService {
  private readonly logger = new Logger(SectorWeightingService.name);

  constructor(
    @InjectRepository(Security)
    private securityRepository: Repository<Security>,
    @InjectRepository(Holding)
    private holdingsRepository: Repository<Holding>,
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    @InjectRepository(SecurityPrice)
    private securityPriceRepository: Repository<SecurityPrice>,
    private yahooFinanceService: YahooFinanceService,
    private portfolioCalculationService: PortfolioCalculationService,
  ) {}

  /**
   * Fetch and cache sector data from Yahoo Finance for securities that
   * are missing it or have stale data (> 7 days old).
   */
  async ensureSectorData(securities: Security[]): Promise<void> {
    const STALE_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const toUpdate: Security[] = [];

    for (const sec of securities) {
      if (sec.skipPriceUpdates) continue;

      const isFresh =
        sec.sectorDataUpdatedAt &&
        now - new Date(sec.sectorDataUpdatedAt).getTime() < STALE_MS;
      if (isFresh) continue;

      const isStock =
        sec.securityType === "STOCK" || sec.securityType === "Equity";
      const isEtf = sec.securityType === "ETF";

      if (isStock && !sec.sector) {
        const yahooSymbol = this.yahooFinanceService.getYahooSymbol(
          sec.symbol,
          sec.exchange,
        );
        const info =
          await this.yahooFinanceService.fetchStockSectorInfo(yahooSymbol);
        if (info) {
          sec.sector = info.sector;
          sec.industry = info.industry;
        }
        sec.sectorDataUpdatedAt = new Date();
        toUpdate.push(sec);
      } else if (isEtf && !sec.sectorWeightings) {
        const yahooSymbol = this.yahooFinanceService.getYahooSymbol(
          sec.symbol,
          sec.exchange,
        );
        const weightings =
          await this.yahooFinanceService.fetchEtfSectorWeightings(yahooSymbol);
        if (weightings) {
          sec.sectorWeightings = weightings;
        }
        sec.sectorDataUpdatedAt = new Date();
        toUpdate.push(sec);
      } else if (sec.sectorDataUpdatedAt && !isFresh && (isStock || isEtf)) {
        // Re-fetch stale data
        const yahooSymbol = this.yahooFinanceService.getYahooSymbol(
          sec.symbol,
          sec.exchange,
        );
        if (isStock) {
          const info =
            await this.yahooFinanceService.fetchStockSectorInfo(yahooSymbol);
          if (info) {
            sec.sector = info.sector;
            sec.industry = info.industry;
          }
        } else {
          const weightings =
            await this.yahooFinanceService.fetchEtfSectorWeightings(
              yahooSymbol,
            );
          if (weightings) {
            sec.sectorWeightings = weightings;
          }
        }
        sec.sectorDataUpdatedAt = new Date();
        toUpdate.push(sec);
      }
    }

    if (toUpdate.length > 0) {
      await this.securityRepository.save(toUpdate);
    }
  }

  /**
   * Get the latest price per security from security_prices table.
   */
  private async getLatestPrices(
    securityIds: string[],
  ): Promise<Map<string, number>> {
    const priceMap = new Map<string, number>();
    if (securityIds.length === 0) return priceMap;

    const rows: { security_id: string; close_price: string }[] =
      await this.securityPriceRepository.query(
        `SELECT DISTINCT ON (security_id) security_id, close_price
         FROM security_prices
         WHERE security_id = ANY($1)
         ORDER BY security_id, price_date DESC`,
        [securityIds],
      );

    for (const row of rows) {
      priceMap.set(row.security_id, Number(row.close_price));
    }
    return priceMap;
  }

  /**
   * Convenience method: load securities by IDs and ensure sector data is cached.
   * Used by the price refresh flow to populate sector data alongside prices.
   */
  async ensureSectorDataByIds(securityIds: string[]): Promise<void> {
    if (securityIds.length === 0) return;
    const securities = await this.securityRepository.find({
      where: { id: In(securityIds) },
    });
    await this.ensureSectorData(securities);
  }

  /**
   * Compute sector weightings for a user's investment portfolio.
   */
  async getSectorWeightings(
    userId: string,
    accountIds?: string[],
    securityIds?: string[],
  ): Promise<SectorWeightingResult> {
    // 1. Resolve investment accounts
    let investmentAccounts: Account[];
    if (accountIds && accountIds.length > 0) {
      investmentAccounts = await this.accountsRepository.find({
        where: {
          userId,
          id: In(accountIds),
          accountType: AccountType.INVESTMENT,
        },
      });
    } else {
      investmentAccounts = await this.accountsRepository.find({
        where: { userId, accountType: AccountType.INVESTMENT },
      });
    }

    const categorised =
      this.portfolioCalculationService.categoriseAccounts(investmentAccounts);

    // 2. Get holdings for those accounts
    let holdings: Holding[];
    if (categorised.holdingsAccountIds.length > 0) {
      holdings = await this.holdingsRepository.find({
        where: { accountId: In(categorised.holdingsAccountIds) },
        relations: ["security"],
      });
    } else {
      holdings = [];
    }

    // Filter by securityIds if provided
    if (securityIds && securityIds.length > 0) {
      holdings = holdings.filter((h) => securityIds.includes(h.securityId));
    }

    // Filter out zero-quantity holdings
    holdings = holdings.filter((h) => Math.abs(Number(h.quantity)) >= 0.0001);

    if (holdings.length === 0) {
      return {
        items: [],
        totalPortfolioValue: 0,
        totalDirectValue: 0,
        totalEtfValue: 0,
        unclassifiedValue: 0,
      };
    }

    // 3. Get latest prices
    const uniqueSecurityIds = [...new Set(holdings.map((h) => h.securityId))];
    const priceMap = await this.getLatestPrices(uniqueSecurityIds);

    // 4. Ensure sector data is cached
    const securities = holdings.map((h) => h.security);
    const uniqueSecurities = Array.from(
      new Map(securities.map((s) => [s.id, s])).values(),
    );
    await this.ensureSectorData(uniqueSecurities);

    // 5. Build sector maps
    const rateCache = new Map<string, number>();
    // Determine default currency from first account
    const defaultCurrency =
      investmentAccounts.length > 0
        ? investmentAccounts[0].currencyCode
        : "CAD";

    const directMap = new Map<string, number>(); // sector -> value
    const etfMap = new Map<string, number>(); // sector -> value
    let unclassifiedValue = 0;

    for (const holding of holdings) {
      const quantity = Number(holding.quantity);
      const price = priceMap.get(holding.securityId);
      if (price == null) continue;

      let marketValue = quantity * price;

      // Convert to default currency
      marketValue = await this.portfolioCalculationService.convertToDefault(
        marketValue,
        holding.security.currencyCode,
        defaultCurrency,
        rateCache,
      );

      const sec = holding.security;
      const isStock =
        sec.securityType === "STOCK" || sec.securityType === "Equity";
      const isEtf = sec.securityType === "ETF";

      if (isStock && sec.sector) {
        directMap.set(
          sec.sector,
          (directMap.get(sec.sector) || 0) + marketValue,
        );
      } else if (isEtf && sec.sectorWeightings?.length) {
        for (const sw of sec.sectorWeightings) {
          const allocated = marketValue * sw.weight;
          etfMap.set(sw.sector, (etfMap.get(sw.sector) || 0) + allocated);
        }
      } else {
        unclassifiedValue += marketValue;
      }
    }

    // 6. Merge maps and compute percentages
    const allSectors = new Set([...directMap.keys(), ...etfMap.keys()]);
    let totalDirectValue = 0;
    let totalEtfValue = 0;

    const items: SectorWeightingItem[] = [];
    for (const sector of allSectors) {
      const dv = directMap.get(sector) || 0;
      const ev = etfMap.get(sector) || 0;
      totalDirectValue += dv;
      totalEtfValue += ev;
      items.push({
        sector,
        directValue: Math.round(dv * 100) / 100,
        etfValue: Math.round(ev * 100) / 100,
        totalValue: Math.round((dv + ev) * 100) / 100,
        percentage: 0, // computed below
      });
    }

    const totalPortfolioValue =
      totalDirectValue + totalEtfValue + unclassifiedValue;

    // Compute percentages
    for (const item of items) {
      item.percentage =
        totalPortfolioValue > 0
          ? Math.round((item.totalValue / totalPortfolioValue) * 10000) / 100
          : 0;
    }

    // Sort by totalValue descending
    items.sort((a, b) => b.totalValue - a.totalValue);

    return {
      items,
      totalPortfolioValue: Math.round(totalPortfolioValue * 100) / 100,
      totalDirectValue: Math.round(totalDirectValue * 100) / 100,
      totalEtfValue: Math.round(totalEtfValue * 100) / 100,
      unclassifiedValue: Math.round(unclassifiedValue * 100) / 100,
    };
  }
}
