import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource, LessThanOrEqual } from "typeorm";
import { MonthlyAccountBalance } from "./entities/monthly-account-balance.entity";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "../securities/entities/investment-transaction.entity";
import { SecurityPrice } from "../securities/entities/security-price.entity";
import { Security } from "../securities/entities/security.entity";
import { ExchangeRate } from "../currencies/entities/exchange-rate.entity";
import { UserPreference } from "../users/entities/user-preference.entity";

const LIABILITY_TYPES: AccountType[] = [
  AccountType.CREDIT_CARD,
  AccountType.LOAN,
  AccountType.MORTGAGE,
  AccountType.LINE_OF_CREDIT,
];

type RateIndex = Map<string, Array<{ date: string; rate: number }>>;

@Injectable()
export class NetWorthService {
  private readonly logger = new Logger(NetWorthService.name);

  constructor(
    @InjectRepository(MonthlyAccountBalance)
    private mabRepo: Repository<MonthlyAccountBalance>,
    @InjectRepository(Account)
    private accountRepo: Repository<Account>,
    @InjectRepository(InvestmentTransaction)
    private invTxRepo: Repository<InvestmentTransaction>,
    @InjectRepository(SecurityPrice)
    private priceRepo: Repository<SecurityPrice>,
    @InjectRepository(Security)
    private securityRepo: Repository<Security>,
    @InjectRepository(ExchangeRate)
    private rateRepo: Repository<ExchangeRate>,
    @InjectRepository(UserPreference)
    private prefRepo: Repository<UserPreference>,
    private dataSource: DataSource,
  ) {}

  async recalculateAccount(userId: string, accountId: string): Promise<void> {
    const account = await this.accountRepo.findOne({
      where: { id: accountId, userId },
    });
    if (!account) return;

    if (this.isBrokerageOrStandaloneInvestment(account)) {
      await this.recalculateBrokerageAccount(userId, account);
    } else {
      await this.recalculateRegularAccount(userId, account);
    }
  }

  async recalculateAllAccounts(userId: string): Promise<void> {
    // Include closed accounts - they have important historical balances
    const accounts = await this.accountRepo.find({
      where: { userId },
    });
    await Promise.all(
      accounts.map(async (account) => {
        try {
          if (this.isBrokerageOrStandaloneInvestment(account)) {
            await this.recalculateBrokerageAccount(userId, account);
          } else {
            await this.recalculateRegularAccount(userId, account);
          }
        } catch (err) {
          this.logger.warn(
            `Failed to recalculate account ${account.id}: ${err.message}`,
          );
        }
      }),
    );
  }

  async ensurePopulated(userId: string): Promise<void> {
    const count = await this.mabRepo.count({ where: { userId } });
    if (count === 0) {
      await this.recalculateAllAccounts(userId);
    }
  }

  /**
   * Check if an account is a brokerage or standalone investment account
   * (i.e. an account that can hold securities and needs market value tracking)
   */
  private isBrokerageOrStandaloneInvestment(account: Account): boolean {
    return (
      account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE ||
      (account.accountType === AccountType.INVESTMENT &&
        !account.accountSubType)
    );
  }

  /**
   * Recalculate monthly snapshots for all investment accounts that have holdings.
   * Called after security prices are refreshed to keep chart data in sync.
   */
  async recalculateAllInvestmentSnapshots(): Promise<void> {
    const accounts = await this.accountRepo
      .createQueryBuilder("a")
      .where("a.accountType = :type", { type: AccountType.INVESTMENT })
      .andWhere("(a.accountSubType = :brokerage OR a.accountSubType IS NULL)", {
        brokerage: AccountSubType.INVESTMENT_BROKERAGE,
      })
      .getMany();

    await Promise.all(
      accounts.map(async (account) => {
        try {
          await this.recalculateBrokerageAccount(account.userId, account);
        } catch (err) {
          this.logger.warn(
            `Failed to recalculate investment snapshot for account ${account.id}: ${err.message}`,
          );
        }
      }),
    );
  }

  async getMonthlyNetWorth(
    userId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<
    { month: string; assets: number; liabilities: number; netWorth: number }[]
  > {
    await this.ensurePopulated(userId);

    const pref = await this.prefRepo.findOne({ where: { userId } });
    const defaultCurrency = pref?.defaultCurrency || "USD";

    const start = startDate || "1990-01-01";
    const end = endDate || new Date().toISOString().slice(0, 10);

    const snapshots: any[] = await this.dataSource.query(
      `SELECT mab.month, mab.balance, mab.market_value,
              a.id as account_id, a.account_type, a.account_sub_type, a.currency_code
       FROM monthly_account_balances mab
       JOIN accounts a ON a.id = mab.account_id
       WHERE mab.user_id = $1
         AND mab.month >= DATE_TRUNC('month', $2::DATE)
         AND mab.month <= DATE_TRUNC('month', $3::DATE)
       ORDER BY mab.month`,
      [userId, start, end],
    );

    if (snapshots.length === 0) return [];

    // Collect currencies that need conversion
    const currencies = new Set<string>();
    for (const s of snapshots) {
      if (s.currency_code !== defaultCurrency) {
        currencies.add(s.currency_code);
      }
    }

    const rateIndex = await this.buildRateIndex(
      currencies,
      defaultCurrency,
      start,
      end,
    );

    // Aggregate by month
    const monthMap = new Map<string, { assets: number; liabilities: number }>();

    for (const s of snapshots) {
      const monthKey = this.toDateString(s.month);

      if (!monthMap.has(monthKey)) {
        monthMap.set(monthKey, { assets: 0, liabilities: 0 });
      }
      const entry = monthMap.get(monthKey)!;

      // For brokerage accounts: use market_value (holdings only; cash is in linked account)
      // For standalone investment accounts: use market_value + balance (holdings + cash)
      // For all others: use balance
      let rawValue: number;
      if (
        s.account_sub_type === "INVESTMENT_BROKERAGE" &&
        s.market_value != null
      ) {
        rawValue = Number(s.market_value);
      } else if (
        s.account_type === "INVESTMENT" &&
        s.account_sub_type === null &&
        s.market_value != null
      ) {
        rawValue = Number(s.market_value) + Number(s.balance);
      } else {
        rawValue = Number(s.balance);
      }

      // Compute month-end date for rate lookup
      const monthEnd = this.monthEndDate(monthKey);
      const converted = this.convertCurrency(
        rawValue,
        s.currency_code,
        defaultCurrency,
        monthEnd,
        rateIndex,
      );

      const accountType = s.account_type as AccountType;
      if (LIABILITY_TYPES.includes(accountType)) {
        entry.liabilities += Math.abs(converted);
      } else {
        entry.assets += converted;
      }
    }

    return Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({
        month,
        assets: Math.round(data.assets),
        liabilities: Math.round(data.liabilities),
        netWorth: Math.round(data.assets - data.liabilities),
      }));
  }

  async getMonthlyInvestments(
    userId: string,
    startDate?: string,
    endDate?: string,
    accountIds?: string[],
    displayCurrency?: string,
  ): Promise<{ month: string; value: number }[]> {
    await this.ensurePopulated(userId);

    const pref = await this.prefRepo.findOne({ where: { userId } });
    const defaultCurrency = displayCurrency || pref?.defaultCurrency || "USD";

    const start = startDate || "1990-01-01";
    const end = endDate || new Date().toISOString().slice(0, 10);

    let accountFilter = "";
    const params: any[] = [userId, start, end];

    if (accountIds && accountIds.length > 0) {
      // Resolve linked pairs for each account ID
      const resolvedIds = new Set<string>();
      for (const id of accountIds) {
        const accounts: any[] = await this.dataSource.query(
          `SELECT id, linked_account_id FROM accounts WHERE (id = $1 OR linked_account_id = $1 OR id = (SELECT linked_account_id FROM accounts WHERE id = $1)) AND user_id = $2`,
          [id, userId],
        );
        for (const a of accounts) {
          resolvedIds.add(a.id);
        }
      }
      const idArray = [...resolvedIds];
      if (idArray.length === 0) {
        // No matching accounts found — return empty result
        return [];
      }
      // Build parameterized IN clause
      const placeholders = idArray.map((_, i) => `$${i + 4}`).join(", ");
      accountFilter = `AND a.id IN (${placeholders})`;
      params.push(...idArray);
    } else {
      accountFilter = `AND (a.account_sub_type IN ('INVESTMENT_CASH', 'INVESTMENT_BROKERAGE') OR (a.account_type = 'INVESTMENT' AND a.account_sub_type IS NULL))`;
    }

    const snapshots: any[] = await this.dataSource.query(
      `SELECT mab.month, mab.balance, mab.market_value,
              a.id as account_id, a.account_type, a.account_sub_type, a.currency_code
       FROM monthly_account_balances mab
       JOIN accounts a ON a.id = mab.account_id
       WHERE mab.user_id = $1
         AND mab.month >= DATE_TRUNC('month', $2::DATE)
         AND mab.month <= DATE_TRUNC('month', $3::DATE)
         ${accountFilter}
       ORDER BY mab.month`,
      params,
    );

    if (snapshots.length === 0) return [];

    const currencies = new Set<string>();
    for (const s of snapshots) {
      if (s.currency_code !== defaultCurrency) {
        currencies.add(s.currency_code);
      }
    }

    const rateIndex = await this.buildRateIndex(
      currencies,
      defaultCurrency,
      start,
      end,
    );

    const monthMap = new Map<string, number>();

    for (const s of snapshots) {
      const monthKey = this.toDateString(s.month);

      if (!monthMap.has(monthKey)) {
        monthMap.set(monthKey, 0);
      }

      let rawValue: number;
      if (
        s.account_sub_type === "INVESTMENT_BROKERAGE" &&
        s.market_value != null
      ) {
        rawValue = Number(s.market_value);
      } else if (
        s.account_type === "INVESTMENT" &&
        s.account_sub_type === null &&
        s.market_value != null
      ) {
        rawValue = Number(s.market_value) + Number(s.balance);
      } else {
        rawValue = Number(s.balance);
      }

      const monthEnd = this.monthEndDate(monthKey);
      const converted = this.convertCurrency(
        rawValue,
        s.currency_code,
        defaultCurrency,
        monthEnd,
        rateIndex,
      );

      monthMap.set(monthKey, monthMap.get(monthKey)! + converted);
    }

    return Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, value]) => ({
        month,
        value: Math.round(value),
      }));
  }

  // ---- Private helpers ----

  private async recalculateRegularAccount(
    userId: string,
    account: Account,
  ): Promise<void> {
    const openingBalance = Number(account.openingBalance) || 0;

    const [{ earliest }] = await this.dataSource.query(
      `SELECT MIN(transaction_date) as earliest
       FROM transactions
       WHERE account_id = $1
         AND (status IS NULL OR status != 'VOID')
         AND parent_transaction_id IS NULL`,
      [account.id],
    );

    let startDate = this.resolveStartDate(account, earliest);

    // For ASSET with dateAcquired, ensure we start from the earlier of dateAcquired or first tx
    if (account.accountType === AccountType.ASSET && account.dateAcquired) {
      const daStr = this.toDateString(account.dateAcquired);
      if (daStr < startDate) startDate = daStr;
    }

    const rows: any[] = await this.dataSource.query(
      `WITH monthly_tx_sums AS (
        SELECT DATE_TRUNC('month', transaction_date)::DATE as month,
               SUM(amount) as total
        FROM transactions
        WHERE account_id = $1
          AND (status IS NULL OR status != 'VOID')
          AND parent_transaction_id IS NULL
          AND transaction_date <= CURRENT_DATE
        GROUP BY 1
      )
      SELECT m.month::DATE as month,
             ($2::NUMERIC + COALESCE(
               SUM(mts.total) OVER (ORDER BY m.month ROWS UNBOUNDED PRECEDING),
               0
             )) as balance
      FROM generate_series(
        DATE_TRUNC('month', $3::DATE)::TIMESTAMP,
        DATE_TRUNC('month', CURRENT_DATE)::TIMESTAMP,
        '1 month'::INTERVAL
      ) m(month)
      LEFT JOIN monthly_tx_sums mts ON mts.month = m.month::DATE
      ORDER BY m.month`,
      [account.id, openingBalance, startDate],
    );

    // Determine dateAcquired month for ASSET zeroing
    let dateAcquiredYM: string | null = null;
    if (account.accountType === AccountType.ASSET && account.dateAcquired) {
      dateAcquiredYM = this.toDateString(account.dateAcquired).substring(0, 7);
    }

    // Atomic delete + insert
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await queryRunner.query(
        "DELETE FROM monthly_account_balances WHERE account_id = $1",
        [account.id],
      );

      for (const row of rows) {
        const monthStr = this.toDateString(row.month);
        const monthYM = monthStr.substring(0, 7);

        let balance = Number(row.balance);
        if (dateAcquiredYM && monthYM < dateAcquiredYM) {
          balance = 0;
        }

        await queryRunner.query(
          `INSERT INTO monthly_account_balances (user_id, account_id, month, balance)
           VALUES ($1, $2, $3::DATE, $4)`,
          [userId, account.id, monthStr, balance],
        );
      }

      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  private async recalculateBrokerageAccount(
    userId: string,
    account: Account,
  ): Promise<void> {
    const openingBalance = Number(account.openingBalance) || 0;

    // Find earliest date from both regular and investment transactions
    const [{ earliest }] = await this.dataSource.query(
      `SELECT MIN(transaction_date) as earliest
       FROM transactions
       WHERE account_id = $1
         AND (status IS NULL OR status != 'VOID')
         AND parent_transaction_id IS NULL`,
      [account.id],
    );

    const [{ inv_earliest }] = await this.dataSource.query(
      `SELECT MIN(transaction_date) as inv_earliest
       FROM investment_transactions
       WHERE account_id = $1`,
      [account.id],
    );

    const dates: string[] = [];
    if (earliest) dates.push(this.toDateString(earliest));
    if (inv_earliest) dates.push(this.toDateString(inv_earliest));
    const startDate =
      dates.length > 0
        ? dates.sort()[0]
        : account.createdAt.toISOString().substring(0, 10);

    // Compute cost-basis via cumulative transaction sums
    const costRows: any[] = await this.dataSource.query(
      `WITH monthly_tx_sums AS (
        SELECT DATE_TRUNC('month', transaction_date)::DATE as month,
               SUM(amount) as total
        FROM transactions
        WHERE account_id = $1
          AND (status IS NULL OR status != 'VOID')
          AND parent_transaction_id IS NULL
          AND transaction_date <= CURRENT_DATE
        GROUP BY 1
      )
      SELECT m.month::DATE as month,
             ($2::NUMERIC + COALESCE(
               SUM(mts.total) OVER (ORDER BY m.month ROWS UNBOUNDED PRECEDING),
               0
             )) as balance
      FROM generate_series(
        DATE_TRUNC('month', $3::DATE)::TIMESTAMP,
        DATE_TRUNC('month', CURRENT_DATE)::TIMESTAMP,
        '1 month'::INTERVAL
      ) m(month)
      LEFT JOIN monthly_tx_sums mts ON mts.month = m.month::DATE
      ORDER BY m.month`,
      [account.id, openingBalance, startDate],
    );

    const costByMonth = new Map<string, number>();
    const months: string[] = [];
    for (const row of costRows) {
      const monthStr = this.toDateString(row.month);
      costByMonth.set(monthStr, Number(row.balance));
      months.push(monthStr);
    }

    // Load investment transactions for holdings replay (exclude future-dated)
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const invTxs = await this.invTxRepo.find({
      where: {
        accountId: account.id,
        transactionDate: LessThanOrEqual(today),
      },
      order: { transactionDate: "ASC" },
    });

    const securityIds = [
      ...new Set(invTxs.filter((t) => t.securityId).map((t) => t.securityId!)),
    ];
    const securities =
      securityIds.length > 0
        ? await this.securityRepo.findByIds(securityIds)
        : [];
    const securityMap = new Map(securities.map((s) => [s.id, s]));

    // Preload prices
    const marketPrices = new Map<string, Map<string, number>>();
    const txPrices = new Map<string, Map<string, number>>();
    if (securityIds.length > 0) {
      await Promise.all([
        this.loadSecurityPrices(securityIds, securityMap, months, marketPrices),
        this.loadTransactionPrices(securityIds, securityMap, months, txPrices),
      ]);
    }

    // Replay holdings month by month
    const holdings = new Map<string, number>();
    let txIdx = 0;
    const marketValueByMonth = new Map<string, number>();

    for (const monthStr of months) {
      const monthYM = monthStr.substring(0, 7);

      // Process investment transactions up to this month
      while (txIdx < invTxs.length) {
        const tx = invTxs[txIdx];
        const txYM = tx.transactionDate.substring(0, 7);
        if (txYM > monthYM) break;

        const secId = tx.securityId;
        const qty = Number(tx.quantity) || 0;

        if (secId) {
          switch (tx.action) {
            case InvestmentAction.BUY:
            case InvestmentAction.REINVEST:
            case InvestmentAction.TRANSFER_IN:
              holdings.set(secId, (holdings.get(secId) || 0) + qty);
              break;
            case InvestmentAction.SELL:
            case InvestmentAction.TRANSFER_OUT:
              holdings.set(secId, (holdings.get(secId) || 0) - qty);
              break;
            case InvestmentAction.SPLIT:
              holdings.set(secId, (holdings.get(secId) || 0) + qty);
              break;
          }
        }
        txIdx++;
      }

      // Compute market value from holdings
      let marketValue = 0;
      for (const [secId, qty] of holdings) {
        if (Math.abs(qty) < 0.00000001) continue;

        const security = securityMap.get(secId);
        let price: number | undefined;

        if (security?.skipPriceUpdates) {
          price = txPrices.get(secId)?.get(monthStr);
        } else {
          price = marketPrices.get(secId)?.get(monthStr);
        }

        if (price != null) {
          marketValue += qty * price;
        }
      }

      marketValueByMonth.set(monthStr, marketValue);
    }

    // Atomic write
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await queryRunner.query(
        "DELETE FROM monthly_account_balances WHERE account_id = $1",
        [account.id],
      );

      for (const monthStr of months) {
        const balance = costByMonth.get(monthStr) ?? 0;
        const mv = marketValueByMonth.get(monthStr) ?? null;

        await queryRunner.query(
          `INSERT INTO monthly_account_balances
             (user_id, account_id, month, balance, market_value)
           VALUES ($1, $2, $3::DATE, $4, $5)`,
          [userId, account.id, monthStr, balance, mv],
        );
      }

      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  private async loadSecurityPrices(
    securityIds: string[],
    securityMap: Map<string, Security>,
    months: string[],
    result: Map<string, Map<string, number>>,
  ): Promise<void> {
    const marketSecIds = securityIds.filter(
      (id) => !securityMap.get(id)?.skipPriceUpdates,
    );
    if (marketSecIds.length === 0) return;

    const prices: any[] = await this.dataSource.query(
      `SELECT security_id, price_date, close_price
       FROM security_prices
       WHERE security_id = ANY($1::UUID[])
       ORDER BY security_id, price_date`,
      [marketSecIds],
    );

    const bySecId = new Map<string, Array<{ date: string; price: number }>>();
    for (const p of prices) {
      const secId = p.security_id;
      if (!bySecId.has(secId)) bySecId.set(secId, []);
      bySecId.get(secId)!.push({
        date: this.toDateString(p.price_date),
        price: Number(p.close_price),
      });
    }

    for (const secId of marketSecIds) {
      const secPrices = bySecId.get(secId) || [];
      const monthPrices = new Map<string, number>();

      for (const monthStr of months) {
        const monthEnd = this.monthEndDate(monthStr);
        let bestPrice: number | undefined;
        for (const sp of secPrices) {
          if (sp.date <= monthEnd) bestPrice = sp.price;
          else break;
        }
        if (bestPrice != null) monthPrices.set(monthStr, bestPrice);
      }

      result.set(secId, monthPrices);
    }
  }

  private async loadTransactionPrices(
    securityIds: string[],
    securityMap: Map<string, Security>,
    months: string[],
    result: Map<string, Map<string, number>>,
  ): Promise<void> {
    const skipSecIds = securityIds.filter(
      (id) => securityMap.get(id)?.skipPriceUpdates,
    );
    if (skipSecIds.length === 0) return;

    const rows: any[] = await this.dataSource.query(
      `SELECT security_id, transaction_date, price
       FROM investment_transactions
       WHERE security_id = ANY($1::UUID[])
         AND action IN ('BUY', 'SELL', 'REINVEST')
         AND price IS NOT NULL
         AND price > 0
       ORDER BY security_id, transaction_date`,
      [skipSecIds],
    );

    const bySecId = new Map<string, Array<{ date: string; price: number }>>();
    for (const r of rows) {
      const secId = r.security_id;
      if (!bySecId.has(secId)) bySecId.set(secId, []);
      bySecId.get(secId)!.push({
        date: this.toDateString(r.transaction_date),
        price: Number(r.price),
      });
    }

    for (const secId of skipSecIds) {
      const txs = bySecId.get(secId) || [];
      const monthPrices = new Map<string, number>();

      for (const monthStr of months) {
        const monthEnd = this.monthEndDate(monthStr);
        let bestPrice: number | undefined;
        for (const t of txs) {
          if (t.date <= monthEnd) bestPrice = t.price;
          else break;
        }
        if (bestPrice != null) monthPrices.set(monthStr, bestPrice);
      }

      result.set(secId, monthPrices);
    }
  }

  private async buildRateIndex(
    currencies: Set<string>,
    defaultCurrency: string,
    startDate: string,
    endDate: string,
  ): Promise<RateIndex> {
    if (currencies.size === 0) return new Map();

    const currArr = Array.from(currencies);
    const rates: any[] = await this.dataSource.query(
      `SELECT from_currency, to_currency, rate, rate_date
       FROM exchange_rates
       WHERE ((from_currency = ANY($1::TEXT[]) AND to_currency = $2)
           OR (from_currency = $2 AND to_currency = ANY($1::TEXT[])))
         AND rate_date >= ($3::DATE - INTERVAL '90 days')
         AND rate_date <= ($4::DATE + INTERVAL '31 days')
       ORDER BY rate_date`,
      [currArr, defaultCurrency, startDate, endDate],
    );

    const index: RateIndex = new Map();
    for (const r of rates) {
      const key = `${r.from_currency}->${r.to_currency}`;
      if (!index.has(key)) index.set(key, []);
      index.get(key)!.push({
        date: this.toDateString(r.rate_date),
        rate: Number(r.rate),
      });
    }

    return index;
  }

  private convertCurrency(
    amount: number,
    from: string,
    to: string,
    monthEnd: string,
    rateIndex: RateIndex,
  ): number {
    if (from === to) return amount;

    const directRates = rateIndex.get(`${from}->${to}`);
    if (directRates) {
      const rate = this.findBestRate(directRates, monthEnd);
      if (rate != null) return amount * rate;
    }

    const reverseRates = rateIndex.get(`${to}->${from}`);
    if (reverseRates) {
      const rate = this.findBestRate(reverseRates, monthEnd);
      if (rate != null) return amount / rate;
    }

    return amount;
  }

  private findBestRate(
    rates: Array<{ date: string; rate: number }>,
    beforeOrOn: string,
  ): number | undefined {
    let best: number | undefined;
    for (const r of rates) {
      if (r.date <= beforeOrOn) best = r.rate;
      else break;
    }
    // If no rate before this date, use the earliest available
    if (best === undefined && rates.length > 0) {
      best = rates[0].rate;
    }
    return best;
  }

  private resolveStartDate(account: Account, earliest: any): string {
    if (earliest) {
      return this.toDateString(earliest);
    }
    if (account.accountType === AccountType.ASSET && account.dateAcquired) {
      return this.toDateString(account.dateAcquired);
    }
    return account.createdAt.toISOString().substring(0, 10);
  }

  private toDateString(value: string | Date): string {
    if (!value) return new Date().toISOString().substring(0, 10);
    if (typeof value === "string") return value.substring(0, 10);
    return value.toISOString().substring(0, 10);
  }

  private monthEndDate(monthFirstDay: string): string {
    const [y, m] = monthFirstDay.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    return `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  }
}
