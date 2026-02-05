import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual, LessThanOrEqual, And } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { ExchangeRate } from './entities/exchange-rate.entity';
import { Currency } from './entities/currency.entity';
import { Account } from '../accounts/entities/account.entity';

export interface RateUpdateResult {
  pair: string;
  success: boolean;
  rate?: number;
  error?: string;
}

export interface RateRefreshSummary {
  totalPairs: number;
  updated: number;
  failed: number;
  results: RateUpdateResult[];
  lastUpdated: Date;
}

@Injectable()
export class ExchangeRateService {
  private readonly logger = new Logger(ExchangeRateService.name);

  constructor(
    @InjectRepository(ExchangeRate)
    private exchangeRateRepository: Repository<ExchangeRate>,
    @InjectRepository(Currency)
    private currencyRepository: Repository<Currency>,
    @InjectRepository(Account)
    private accountRepository: Repository<Account>,
  ) {}

  /**
   * Fetch exchange rate from Yahoo Finance for a currency pair
   * Uses the same v8 chart API as SecurityPriceService
   */
  private async fetchYahooRate(from: string, to: string): Promise<number | null> {
    if (from === to) return 1.0;

    try {
      const symbol = `${from}${to}=X`;
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;

      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      if (!response.ok) {
        this.logger.warn(
          `Yahoo Finance API returned ${response.status} for ${symbol}`,
        );
        return null;
      }

      const data = await response.json();

      if (data.chart?.result?.[0]?.meta?.regularMarketPrice) {
        return data.chart.result[0].meta.regularMarketPrice;
      }

      return null;
    } catch (error) {
      this.logger.error(
        `Failed to fetch exchange rate for ${from}/${to}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Save or update an exchange rate for a given date
   */
  private async saveRate(
    from: string,
    to: string,
    rate: number,
    date: Date,
  ): Promise<ExchangeRate> {
    const existing = await this.exchangeRateRepository.findOne({
      where: {
        fromCurrency: from,
        toCurrency: to,
        rateDate: date,
      },
    });

    if (existing) {
      existing.rate = rate;
      existing.source = 'yahoo_finance';
      return this.exchangeRateRepository.save(existing);
    }

    const newRate = this.exchangeRateRepository.create({
      fromCurrency: from,
      toCurrency: to,
      rate,
      rateDate: date,
      source: 'yahoo_finance',
    });
    return this.exchangeRateRepository.save(newRate);
  }

  /**
   * Refresh exchange rates only for currencies actively used in accounts
   */
  async refreshAllRates(): Promise<RateRefreshSummary> {
    const startTime = Date.now();
    this.logger.log('Starting exchange rate refresh');

    // Only fetch rates for currencies that are actually used in accounts
    const usedCurrencies: { code: string }[] = await this.accountRepository
      .createQueryBuilder('a')
      .select('DISTINCT a.currency_code', 'code')
      .where('a.is_closed = false')
      .getRawMany();

    const codes = usedCurrencies.map((c) => c.code);
    this.logger.log(`Currencies in use: ${codes.join(', ')}`);

    if (codes.length < 2) {
      return {
        totalPairs: 0,
        updated: 0,
        failed: 0,
        results: [],
        lastUpdated: new Date(),
      };
    }

    // Build all unique currency pairs from in-use currencies
    const pairs: { from: string; to: string }[] = [];
    for (let i = 0; i < codes.length; i++) {
      for (let j = i + 1; j < codes.length; j++) {
        pairs.push({
          from: codes[i],
          to: codes[j],
        });
      }
    }

    const results: RateUpdateResult[] = [];
    let updated = 0;
    let failed = 0;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Fetch rates in parallel
    await Promise.all(
      pairs.map(async ({ from, to }) => {
        const pairLabel = `${from}/${to}`;
        const rate = await this.fetchYahooRate(from, to);

        if (rate === null) {
          results.push({ pair: pairLabel, success: false, error: 'No rate data available' });
          failed++;
          return;
        }

        try {
          await this.saveRate(from, to, rate, today);
          results.push({ pair: pairLabel, success: true, rate });
          updated++;
        } catch (error) {
          results.push({ pair: pairLabel, success: false, error: error.message });
          failed++;
        }
      }),
    );

    const duration = Date.now() - startTime;
    this.logger.log(
      `Exchange rate refresh completed in ${duration}ms: ${updated} updated, ${failed} failed`,
    );

    return {
      totalPairs: pairs.length,
      updated,
      failed,
      results,
      lastUpdated: new Date(),
    };
  }

  /**
   * Get the latest exchange rates (most recent per currency pair)
   */
  async getLatestRates(): Promise<ExchangeRate[]> {
    return this.exchangeRateRepository
      .createQueryBuilder('er')
      .distinctOn(['er.from_currency', 'er.to_currency'])
      .orderBy('er.from_currency')
      .addOrderBy('er.to_currency')
      .addOrderBy('er.rate_date', 'DESC')
      .getMany();
  }

  /**
   * Get the latest rate for a specific currency pair
   */
  async getLatestRate(from: string, to: string): Promise<number | null> {
    if (from === to) return 1;
    const rate = await this.exchangeRateRepository.findOne({
      where: { fromCurrency: from, toCurrency: to },
      order: { rateDate: 'DESC' },
    });
    return rate ? Number(rate.rate) : null;
  }

  /**
   * Get exchange rates within a date range (for historical net worth)
   */
  async getRateHistory(startDate?: string, endDate?: string): Promise<ExchangeRate[]> {
    const where: any = {};
    if (startDate) {
      where.rateDate = MoreThanOrEqual(startDate);
    }
    if (endDate) {
      where.rateDate = startDate
        ? And(MoreThanOrEqual(startDate), LessThanOrEqual(endDate))
        : LessThanOrEqual(endDate);
    }

    return this.exchangeRateRepository.find({
      where,
      order: { rateDate: 'ASC', fromCurrency: 'ASC', toCurrency: 'ASC' },
    });
  }

  /**
   * Get all active currencies
   */
  async getCurrencies(): Promise<Currency[]> {
    return this.currencyRepository.find({
      where: { isActive: true },
      order: { code: 'ASC' },
    });
  }

  /**
   * Get the last time exchange rates were updated
   */
  async getLastUpdateTime(): Promise<Date | null> {
    const latest = await this.exchangeRateRepository.findOne({
      where: {},
      order: { createdAt: 'DESC' },
    });
    return latest?.createdAt ?? null;
  }

  /**
   * Scheduled job to refresh exchange rates daily at 5 PM EST (after market close)
   * Runs Monday-Friday only
   */
  @Cron('0 17 * * 1-5', { timeZone: 'America/New_York' })
  async scheduledRateRefresh(): Promise<void> {
    this.logger.log('Running scheduled exchange rate refresh');
    try {
      await this.refreshAllRates();
    } catch (error) {
      this.logger.error(
        `Scheduled exchange rate refresh failed: ${error.message}`,
      );
    }
  }
}
