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
import { mapWithConcurrency } from "../common/concurrency.util";
import { roundMoney } from "../common/round.util";
import { withSystemContext } from "../common/db/with-context";

// Cap concurrent Yahoo FX fetches so the daily refresh does not burst every
// currency pair at once (this cron also runs alongside the security price
// refresh, so the combined load on Yahoo needs to stay bounded).
const FX_FETCH_CONCURRENCY = 6;

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
   * Like fetchYahooHistoricalRates, but bounded to a [from, to] date window so a
   * single-date lookup fetches a handful of bars instead of the entire history.
   */
  private async fetchYahooHistoricalRatesWindow(
    from: string,
    to: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<Array<{ date: Date; rate: number }> | null> {
    if (from === to) return [];

    const symbol = `${from}${to}=X`;
    const prices = await this.yahooFinanceService.fetchHistoricalWindow(
      symbol,
      fromDate,
      toDate,
    );
    if (!prices) return null;

    return prices.map((p) => ({ date: p.date, rate: p.close }));
  }

  /**
   * Save or update an exchange rate for a given date,
   * and also save the inverse rate for the reverse pair.
   */
  private async saveRate(
    from: string,
    to: string,
    rate: number,
    date: Date,
  ): Promise<ExchangeRate> {
    const result = await this.saveOneDirection(from, to, rate, date);

    // Also save the inverse rate so both directions stay current
    const inverseRate = roundMoney(1 / rate);
    await this.saveOneDirection(to, from, inverseRate, date);

    return result;
  }

  private async saveOneDirection(
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

    // Fetch all currencies in use: account currencies, security currencies for
    // active holdings, and every user's preferred default currency. Including
    // defaults ensures we fetch (CAD, GBP) even when the user has no GBP-
    // denominated accounts -- otherwise their GBP totals would silently fall
    // back to unconverted CAD values.
    const usedCurrencies: { code: string }[] = await this.dataSource.query(
      `SELECT DISTINCT code FROM (
         SELECT currency_code AS code FROM accounts WHERE is_closed = false
         UNION
         SELECT s.currency_code AS code
         FROM securities s
         INNER JOIN holdings h ON h.security_id = s.id
         INNER JOIN accounts a ON a.id = h.account_id AND a.is_closed = false
         WHERE s.is_active = true AND h.quantity > 0
         UNION
         SELECT default_currency AS code FROM user_preferences
         WHERE default_currency IS NOT NULL
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

    // Fetch rates with bounded concurrency
    await mapWithConcurrency(
      pairs,
      FX_FETCH_CONCURRENCY,
      async ({ from, to }) => {
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
      },
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
   * Get the exchange rate for a currency pair as of a specific date.
   *
   * Unlike getLatestRate (the once-a-day stored snapshot), this returns the
   * rate that applied on the transaction's date -- essential for back-dated
   * transactions, where the latest snapshot can be far from the historical
   * rate. Precedence:
   *   1. The stored rate on the closest date on or before the target
   *      (carry-forward, matching how a missing weekend/holiday is handled).
   *   2. A short historical daily window fetched from Yahoo around the target
   *      date; the value on the closest day on or before the target is used and
   *      persisted for reuse. The window (not the full "max" history) keeps the
   *      request small and fast.
   * Returns null when no rate can be determined (so the caller can reject or
   * flag the operation rather than silently assuming 1.0).
   */
  async getRateForDate(
    from: string,
    to: string,
    date: string | Date,
  ): Promise<number | null> {
    if (from === to) return 1;

    const target =
      typeof date === "string"
        ? date.slice(0, 10)
        : date.toISOString().slice(0, 10);
    const targetDate = new Date(`${target}T00:00:00.000Z`);

    // 1. Closest stored rate on or before the target date.
    const stored = await this.exchangeRateRepository.findOne({
      where: {
        fromCurrency: from,
        toCurrency: to,
        rateDate: LessThanOrEqual(targetDate),
      },
      order: { rateDate: "DESC" },
    });
    if (stored) return Number(stored.rate);

    // 2. Fetch a short Yahoo window around the target (not the full "max"
    //    history) and use the rate on the closest day on or before the target.
    //    The lower bound reaches back two weeks so weekends/holidays before the
    //    target still resolve; the upper bound adds two days to cover the target
    //    itself (and minor timezone slack). Persist just the chosen point (and
    //    its inverse, via saveRate) so a repeat lookup hits the database.
    const windowStart = new Date(targetDate.getTime() - 14 * 86_400_000);
    const windowEnd = new Date(targetDate.getTime() + 2 * 86_400_000);
    const series = await this.fetchYahooHistoricalRatesWindow(
      from,
      to,
      windowStart,
      windowEnd,
    );
    if (series && series.length > 0) {
      const targetTime = targetDate.getTime();
      const sorted = [...series].sort(
        (a, b) => a.date.getTime() - b.date.getTime(),
      );
      const onOrBefore = sorted.filter((p) => p.date.getTime() <= targetTime);
      // Fall back to the earliest available point when the target predates the
      // series -- a best-effort rate is still far better than a silent 1.0.
      const chosen =
        onOrBefore.length > 0 ? onOrBefore[onOrBefore.length - 1] : sorted[0];
      try {
        await this.saveRate(from, to, chosen.rate, chosen.date);
      } catch (error) {
        this.logger.warn(
          `Could not persist historical rate ${from}->${to} for ${target}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return chosen.rate;
    }

    return null;
  }

  /**
   * Get the current spot rate for a currency pair, fetched live from the quote
   * provider. Tries the direct pair, then the reverse pair (inverted), then
   * falls back to the most recent stored daily rate when the live fetch is
   * unavailable (rate limited, unsupported pair, offline).
   *
   * Use this for "as of now" valuations such as the Investments portfolio
   * summary so they line up with the live intraday Portfolio Value Over Time
   * chart, which fetches live FX directly from the quote provider, rather than
   * the once-a-day stored snapshot returned by getLatestRate. Returns null when
   * neither a live quote nor a stored rate is available, letting callers apply
   * their own fallback (e.g. reverse lookup or treating the rate as 1).
   */
  async getLiveRate(from: string, to: string): Promise<number | null> {
    if (from === to) return 1;
    try {
      const direct = await this.fetchYahooRate(from, to);
      if (direct !== null && direct > 0) return direct;
      const reverse = await this.fetchYahooRate(to, from);
      if (reverse !== null && reverse > 0) return 1 / reverse;
    } catch (error) {
      this.logger.warn(
        `Live FX fetch ${from}->${to} failed, falling back to stored rate: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return this.getLatestRate(from, to);
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
   * Scheduled job to refresh exchange rates daily at 5:05 PM EST (after market
   * close). Runs Monday-Friday only. Staggered five minutes after the security
   * price refresh (5:00 PM) so the two Yahoo-hitting jobs do not burst at the
   * same instant.
   */
  @Cron("5 17 * * 1-5", { timeZone: "America/New_York" })
  async scheduledRateRefresh(): Promise<void> {
    this.logger.log("Running scheduled exchange rate refresh");
    try {
      // RLS (task C2): the currency-detection read spans all users' accounts,
      // securities, holdings and preferences (writes only the global
      // exchange_rates table), so the refresh runs under a system context.
      await withSystemContext(() => this.refreshAllRates());
    } catch (error) {
      this.logger.error(
        `Scheduled exchange rate refresh failed: ${error.message}`,
      );
    }
  }
}
