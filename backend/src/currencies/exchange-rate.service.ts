import {
  Injectable,
  Logger,
  OnModuleInit,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import {
  Repository,
  DataSource,
  MoreThanOrEqual,
  LessThanOrEqual,
  And,
} from "typeorm";
import { Cron } from "@nestjs/schedule";
import { ExchangeRate } from "./entities/exchange-rate.entity";
import { Currency } from "./entities/currency.entity";
import { Account } from "../accounts/entities/account.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { YahooFinanceService } from "../securities/yahoo-finance.service";

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

export interface HistoricalRateBackfillResult {
  pair: string;
  success: boolean;
  ratesLoaded: number;
  error?: string;
}

export interface HistoricalRateBackfillSummary {
  totalPairs: number;
  successful: number;
  failed: number;
  totalRatesLoaded: number;
  results: HistoricalRateBackfillResult[];
}

@Injectable()
export class ExchangeRateService implements OnModuleInit {
  private readonly logger = new Logger(ExchangeRateService.name);

  constructor(
    @InjectRepository(ExchangeRate)
    private exchangeRateRepository: Repository<ExchangeRate>,
    @InjectRepository(Currency)
    private currencyRepository: Repository<Currency>,
    @InjectRepository(Account)
    private accountRepository: Repository<Account>,
    @InjectRepository(UserPreference)
    private userPreferenceRepository: Repository<UserPreference>,
    private dataSource: DataSource,
    @Inject(forwardRef(() => YahooFinanceService))
    private yahooFinanceService: YahooFinanceService,
  ) {}

  /**
   * On application startup, check if exchange rates exist and are recent.
   * If not, trigger a refresh so currency conversions work immediately.
   */
  async onModuleInit(): Promise<void> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Check for rates within the last 3 days (covers weekends — Friday rates still valid on Monday)
      const cutoff = new Date(today);
      cutoff.setDate(cutoff.getDate() - 3);

      const recentRate = await this.exchangeRateRepository.findOne({
        where: { rateDate: MoreThanOrEqual(cutoff) },
      });

      if (!recentRate) {
        this.logger.log(
          "No recent exchange rates found — fetching rates on startup",
        );
        const summary = await this.refreshAllRates();
        this.logger.log(
          `Startup rate refresh: ${summary.updated} updated, ${summary.failed} failed`,
        );
      } else {
        this.logger.log("Exchange rates are up to date");
      }
      // Check if historical rates need backfilling for any user's accounts or securities
      const usersWithForeignAccounts: Array<{ user_id: string }> =
        await this.dataSource.query(
          `SELECT DISTINCT user_id FROM (
             SELECT a.user_id
             FROM accounts a
             INNER JOIN user_preferences up ON up.user_id = a.user_id
             WHERE a.is_closed = false
               AND a.currency_code != up.default_currency
             UNION
             SELECT a.user_id
             FROM securities s
             INNER JOIN holdings h ON h.security_id = s.id
             INNER JOIN accounts a ON a.id = h.account_id AND a.is_closed = false
             INNER JOIN user_preferences up ON up.user_id = a.user_id
             WHERE s.currency_code != up.default_currency
               AND s.is_active = true
               AND h.quantity > 0
           ) sub`,
        );

      for (const { user_id } of usersWithForeignAccounts) {
        this.backfillHistoricalRates(user_id).catch((err) =>
          this.logger.warn(
            `Startup historical rate backfill failed for user ${user_id}: ${err.message}`,
          ),
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to check/refresh exchange rates on startup: ${error.message}`,
      );
    }
  }

  /**
   * Fetch exchange rate from Yahoo Finance for a currency pair.
   * Delegates to YahooFinanceService to avoid duplicating the v8 chart API logic.
   */
  private async fetchYahooRate(
    from: string,
    to: string,
  ): Promise<number | null> {
    if (from === to) return 1.0;

    const symbol = `${from}${to}=X`;
    const quote = await this.yahooFinanceService.fetchQuote(symbol);
    return quote?.regularMarketPrice ?? null;
  }

  /**
   * Fetch historical daily exchange rates from Yahoo Finance for a currency pair.
   * Delegates to YahooFinanceService to avoid duplicating the v8 chart API logic.
   */
  private async fetchYahooHistoricalRates(
    from: string,
    to: string,
  ): Promise<Array<{ date: Date; rate: number }> | null> {
    if (from === to) return [];

    const symbol = `${from}${to}=X`;
    const prices = await this.yahooFinanceService.fetchHistorical(symbol);
    if (!prices) return null;

    return prices.map((p) => ({ date: p.date, rate: p.close }));
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
      existing.source = "yahoo_finance";
      return this.exchangeRateRepository.save(existing);
    }

    const newRate = this.exchangeRateRepository.create({
      fromCurrency: from,
      toCurrency: to,
      rate,
      rateDate: date,
      source: "yahoo_finance",
    });
    return this.exchangeRateRepository.save(newRate);
  }

  /**
   * Refresh exchange rates for all currencies in use
   */
  async refreshAllRates(): Promise<RateRefreshSummary> {
    const startTime = Date.now();
    this.logger.log("Starting exchange rate refresh");

    // Fetch all currencies used in accounts/securities
    const usedCurrencies: { code: string }[] = await this.dataSource.query(
      `SELECT DISTINCT code FROM (
         SELECT currency_code AS code FROM accounts WHERE is_closed = false
         UNION
         SELECT s.currency_code AS code
         FROM securities s
         INNER JOIN holdings h ON h.security_id = s.id
         INNER JOIN accounts a ON a.id = h.account_id AND a.is_closed = false
         WHERE s.is_active = true AND h.quantity > 0
       ) sub`,
    );

    const codes = usedCurrencies.map((c) => c.code);
    this.logger.log(`Currencies in use: ${codes.join(", ")}`);

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
          results.push({
            pair: pairLabel,
            success: false,
            error: "No rate data available",
          });
          failed++;
          return;
        }

        try {
          await this.saveRate(from, to, rate, today);
          results.push({ pair: pairLabel, success: true, rate });
          updated++;
        } catch (error) {
          results.push({
            pair: pairLabel,
            success: false,
            error: error.message,
          });
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
   * Backfill historical exchange rates for accounts with non-default currencies.
   * Fetches daily rates from the earliest transaction date to today.
   *
   * @param userId - The user whose default currency determines the conversion target
   * @param accountIds - Optional list of account IDs to scope the backfill (e.g. post-import)
   */
  async backfillHistoricalRates(
    userId: string,
    accountIds?: string[],
  ): Promise<HistoricalRateBackfillSummary> {
    const startTime = Date.now();
    this.logger.log("Starting historical exchange rate backfill");

    // 1. Get user's default currency
    const pref = await this.userPreferenceRepository.findOne({
      where: { userId },
    });
    const defaultCurrency = pref?.defaultCurrency || "USD";

    // 2. Find non-default currencies and their earliest transaction dates
    //    Includes both account currencies AND security currencies held in those accounts
    let accountFilter = "";
    const params: any[] = [defaultCurrency];

    if (accountIds && accountIds.length > 0) {
      accountFilter = `AND a.id = ANY($2::UUID[])`;
      params.push(accountIds);
    }

    // Query 1: Account-level currencies (accounts in a non-default currency)
    const accountCurrencyRows: Array<{
      currency_code: string;
      earliest: string;
    }> = await this.dataSource.query(
      `SELECT a.currency_code,
              LEAST(
                (SELECT MIN(t.transaction_date) FROM transactions t WHERE t.account_id = a.id),
                (SELECT MIN(it.transaction_date) FROM investment_transactions it WHERE it.account_id = a.id)
              )::TEXT AS earliest
       FROM accounts a
       WHERE a.currency_code != $1
         AND a.is_closed = false
         ${accountFilter}`,
      params,
    );

    // Query 2: Security-level currencies (securities in a non-default currency held in active accounts)
    const securityCurrencyRows: Array<{
      currency_code: string;
      earliest: string;
    }> = await this.dataSource.query(
      `SELECT DISTINCT s.currency_code,
              (SELECT MIN(it.transaction_date)::TEXT
               FROM investment_transactions it
               WHERE it.security_id = s.id) AS earliest
       FROM securities s
       INNER JOIN holdings h ON h.security_id = s.id
       INNER JOIN accounts a ON a.id = h.account_id AND a.is_closed = false
       WHERE s.currency_code != $1
         AND s.is_active = true
         AND h.quantity > 0
         ${accountFilter ? `AND h.account_id = ANY($2::UUID[])` : ""}`,
      params,
    );

    // 3. Determine unique currency pairs and the global earliest date per pair
    const pairEarliest = new Map<string, Date>();
    const allRows = [...accountCurrencyRows, ...securityCurrencyRows];
    for (const row of allRows) {
      if (!row.earliest) continue;
      const pairKey = `${row.currency_code}->${defaultCurrency}`;
      const earliest = new Date(row.earliest);
      earliest.setHours(0, 0, 0, 0);
      const existing = pairEarliest.get(pairKey);
      if (!existing || earliest < existing) {
        pairEarliest.set(pairKey, earliest);
      }
    }

    if (pairEarliest.size === 0) {
      this.logger.log("No currency pairs require historical backfill");
      return {
        totalPairs: 0,
        successful: 0,
        failed: 0,
        totalRatesLoaded: 0,
        results: [],
      };
    }

    this.logger.log(
      `Currency pairs to backfill: ${Array.from(pairEarliest.keys()).join(", ")}`,
    );

    // 4. Fetch and store historical rates for each pair
    const results: HistoricalRateBackfillResult[] = [];
    let successful = 0;
    let failed = 0;
    let totalRatesLoaded = 0;

    for (const [pairKey, cutoffDate] of pairEarliest.entries()) {
      const [from, to] = pairKey.split("->");

      // Skip if we already have historical rates for this pair
      const existingRates = await this.dataSource.query(
        `SELECT COUNT(*)::INT AS count FROM exchange_rates
         WHERE from_currency = $1 AND to_currency = $2`,
        [from, to],
      );

      if (existingRates[0]?.count > 0) {
        results.push({ pair: `${from}/${to}`, success: true, ratesLoaded: 0 });
        successful++;
        continue;
      }

      const rates = await this.fetchYahooHistoricalRates(from, to);

      if (!rates || rates.length === 0) {
        results.push({
          pair: `${from}/${to}`,
          success: false,
          ratesLoaded: 0,
          error: "No historical data available",
        });
        failed++;
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }

      // Filter to only keep rates from the earliest transaction date onward
      let filtered = rates.filter((r) => r.date >= cutoffDate);

      // Deduplicate by date
      const seen = new Set<string>();
      filtered = filtered.filter((r) => {
        const key = r.date.toISOString().substring(0, 10);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (filtered.length === 0) {
        results.push({ pair: `${from}/${to}`, success: true, ratesLoaded: 0 });
        successful++;
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }

      try {
        // Bulk upsert using raw SQL for performance
        const batchSize = 500;
        for (let i = 0; i < filtered.length; i += batchSize) {
          const batch = filtered.slice(i, i + batchSize);
          const values = batch
            .map((_, idx) => {
              const offset = idx * 4;
              return `($${offset + 1}, $${offset + 2}, $${offset + 3}::DATE, $${offset + 4}, 'yahoo_finance')`;
            })
            .join(", ");

          const batchParams: any[] = [];
          for (const r of batch) {
            batchParams.push(from, to, r.date, r.rate);
          }

          await this.dataSource.query(
            `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
             VALUES ${values}
             ON CONFLICT (from_currency, to_currency, rate_date) DO UPDATE SET
               rate = EXCLUDED.rate,
               source = EXCLUDED.source`,
            batchParams,
          );
        }

        this.logger.log(
          `Backfilled ${filtered.length} rates for ${from}/${to} (from ${cutoffDate.toISOString().substring(0, 10)})`,
        );
        results.push({
          pair: `${from}/${to}`,
          success: true,
          ratesLoaded: filtered.length,
        });
        successful++;
        totalRatesLoaded += filtered.length;
      } catch (error) {
        this.logger.error(
          `Failed to save historical rates for ${from}/${to}: ${error.message}`,
        );
        results.push({
          pair: `${from}/${to}`,
          success: false,
          ratesLoaded: 0,
          error: error.message,
        });
        failed++;
      }

      // Small delay between pairs to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const duration = Date.now() - startTime;
    this.logger.log(
      `Historical rate backfill completed in ${duration}ms: ${successful} successful, ${failed} failed, ${totalRatesLoaded} total rates`,
    );

    return {
      totalPairs: pairEarliest.size,
      successful,
      failed,
      totalRatesLoaded,
      results,
    };
  }

  /**
   * Get the latest exchange rates (most recent per currency pair)
   */
  async getLatestRates(): Promise<ExchangeRate[]> {
    return this.exchangeRateRepository
      .createQueryBuilder("er")
      .distinctOn(["er.from_currency", "er.to_currency"])
      .orderBy("er.from_currency")
      .addOrderBy("er.to_currency")
      .addOrderBy("er.rate_date", "DESC")
      .getMany();
  }

  /**
   * Get the latest rate for a specific currency pair
   */
  async getLatestRate(from: string, to: string): Promise<number | null> {
    if (from === to) return 1;
    const rate = await this.exchangeRateRepository.findOne({
      where: { fromCurrency: from, toCurrency: to },
      order: { rateDate: "DESC" },
    });
    return rate ? Number(rate.rate) : null;
  }

  /**
   * Get exchange rates within a date range (for historical net worth)
   */
  async getRateHistory(
    startDate?: string,
    endDate?: string,
  ): Promise<ExchangeRate[]> {
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
      order: { rateDate: "ASC", fromCurrency: "ASC", toCurrency: "ASC" },
    });
  }

  /**
   * Get all active currencies
   */
  async getCurrencies(): Promise<Currency[]> {
    return this.currencyRepository.find({
      where: { isActive: true },
      order: { code: "ASC" },
    });
  }

  /**
   * Get the last time exchange rates were updated
   */
  async getLastUpdateTime(): Promise<Date | null> {
    const latest = await this.exchangeRateRepository.findOne({
      where: {},
      order: { createdAt: "DESC" },
    });
    return latest?.createdAt ?? null;
  }

  /**
   * Scheduled job to refresh exchange rates daily at 5 PM EST (after market close)
   * Runs Monday-Friday only
   */
  @Cron("0 17 * * 1-5", { timeZone: "America/New_York" })
  async scheduledRateRefresh(): Promise<void> {
    this.logger.log("Running scheduled exchange rate refresh");
    try {
      await this.refreshAllRates();
    } catch (error) {
      this.logger.error(
        `Scheduled exchange rate refresh failed: ${error.message}`,
      );
    }
  }
}
