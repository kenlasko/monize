import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In, LessThanOrEqual, FindOptionsWhere } from "typeorm";
import { Holding } from "./entities/holding.entity";
import { SecurityPrice } from "./entities/security-price.entity";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "./entities/investment-transaction.entity";
import { Account, AccountSubType } from "../accounts/entities/account.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import {
  HoldingWithMarketValue,
  AccountHoldings,
  AllocationItem,
} from "./portfolio.service";

/**
 * Categorised investment accounts: brokerage, standalone, and cash accounts
 * with pre-computed holdings account IDs.
 */
export interface CategorisedAccounts {
  cashAccounts: Account[];
  brokerageAccounts: Account[];
  standaloneAccounts: Account[];
  holdingsAccountIds: string[];
}

/**
 * A single SELL transaction with the cost basis and realized gain derived
 * from replaying transaction history up to the sale. All monetary fields
 * are denominated in the holding account's currency.
 */
export interface RealizedGainEntry {
  transactionId: string;
  transactionDate: string;
  accountId: string;
  accountName: string | null;
  accountCurrencyCode: string | null;
  securityId: string;
  symbol: string | null;
  securityName: string | null;
  securityCurrencyCode: string | null;
  quantity: number;
  price: number;
  commission: number;
  proceeds: number;
  costBasis: number;
  realizedGain: number;
}

/**
 * Per-(account, security, month) capital-gain breakdown including both the
 * realized portion (from SELLs in the month) and the unrealized mark-to-market
 * change on the position. All monetary values are denominated in the holding
 * account's currency. The decomposition uses:
 *
 *   totalCapitalGain = (endValue - startValue) + sells - buys
 *   unrealizedGain   = totalCapitalGain - realizedGain
 *
 * which is equivalent to "change in market value plus net cash withdrawn from
 * the position". Months with zero quantity and zero activity are dropped.
 */
export interface CapitalGainEntry {
  month: string;
  accountId: string;
  accountName: string | null;
  accountCurrencyCode: string | null;
  securityId: string;
  symbol: string | null;
  securityName: string | null;
  securityCurrencyCode: string | null;
  startQuantity: number;
  endQuantity: number;
  startValue: number;
  endValue: number;
  buys: number;
  sells: number;
  realizedGain: number;
  unrealizedGain: number;
  totalCapitalGain: number;
}

function roundMoney(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Add `days` to a YYYY-MM-DD date string and return a new YYYY-MM-DD string.
 * Uses UTC to avoid local-timezone drift when crossing day boundaries.
 */
function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

interface PeriodBucket {
  key: string; // YYYY-MM for months, YYYY-MM-DD for days
  periodStart: string; // YYYY-MM-DD first day of period
  periodEnd: string; // YYYY-MM-DD last day of period
  priceLookupStart: string; // day before periodStart, used to value the position at period start
}

/**
 * Enumerate calendar months covered by [startDate, endDate]. Each entry
 * carries the YYYY-MM key, the (clamped) start/end day-of-month, and the
 * day-before-start date used to look up the starting price for the month.
 */
function enumerateMonths(startDate: string, endDate: string): PeriodBucket[] {
  const [sy, sm] = startDate.split("-").map(Number);
  const [ey, em] = endDate.split("-").map(Number);
  const buckets: PeriodBucket[] = [];
  let y = sy;
  let m = sm;
  while (y < ey || (y === ey && m <= em)) {
    const firstOfMonth = `${y}-${String(m).padStart(2, "0")}-01`;
    const lastDayNum = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const lastOfMonth = `${y}-${String(m).padStart(2, "0")}-${String(lastDayNum).padStart(2, "0")}`;
    const periodStart = firstOfMonth < startDate ? startDate : firstOfMonth;
    const periodEnd = lastOfMonth > endDate ? endDate : lastOfMonth;
    buckets.push({
      key: `${y}-${String(m).padStart(2, "0")}`,
      periodStart,
      periodEnd,
      priceLookupStart: addDaysIso(periodStart, -1),
    });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return buckets;
}

/**
 * Enumerate calendar days covered by [startDate, endDate]. Each entry
 * carries the YYYY-MM-DD key and the day-before date for the start-of-day
 * price lookup.
 */
function enumerateDays(startDate: string, endDate: string): PeriodBucket[] {
  const buckets: PeriodBucket[] = [];
  let current = startDate;
  while (current <= endDate) {
    buckets.push({
      key: current,
      periodStart: current,
      periodEnd: current,
      priceLookupStart: addDaysIso(current, -1),
    });
    current = addDaysIso(current, 1);
  }
  return buckets;
}

/**
 * Apply a single investment transaction to a running { quantity, costBasis }
 * state in account-currency terms. Used to seed cost basis from history that
 * predates the requested capital-gains window.
 */
function applyTxToState(
  tx: InvestmentTransaction,
  state: { quantity: number; costBasis: number },
): void {
  const quantity = Number(tx.quantity) || 0;
  const price = Number(tx.price) || 0;
  const exchangeRate = Number(tx.exchangeRate) || 1;
  switch (tx.action) {
    case InvestmentAction.BUY:
    case InvestmentAction.REINVEST:
    case InvestmentAction.TRANSFER_IN:
      state.costBasis += quantity * price * exchangeRate;
      state.quantity += quantity;
      break;
    case InvestmentAction.SELL:
    case InvestmentAction.TRANSFER_OUT: {
      const sellQty = Math.min(quantity, state.quantity);
      const avgCostPerShare =
        state.quantity > 0 ? state.costBasis / state.quantity : 0;
      state.costBasis -= sellQty * avgCostPerShare;
      state.quantity -= sellQty;
      break;
    }
    case InvestmentAction.ADD_SHARES:
      state.quantity += quantity;
      break;
    case InvestmentAction.REMOVE_SHARES:
      state.quantity -= quantity;
      break;
    case InvestmentAction.SPLIT: {
      const splitRatio = quantity || 1;
      if (splitRatio > 0) state.quantity *= splitRatio;
      break;
    }
  }
  if (Math.abs(state.quantity) < 0.0001) {
    state.quantity = 0;
    state.costBasis = 0;
  }
}

/**
 * Service responsible for the core portfolio value calculations:
 * holdings valuation, account grouping, allocation, TWR, and CAGR.
 *
 * Extracted from PortfolioService to keep file sizes manageable.
 */
@Injectable()
export class PortfolioCalculationService {
  constructor(
    @InjectRepository(Holding)
    private holdingsRepository: Repository<Holding>,
    @InjectRepository(SecurityPrice)
    private securityPriceRepository: Repository<SecurityPrice>,
    @InjectRepository(InvestmentTransaction)
    private investmentTransactionRepository: Repository<InvestmentTransaction>,
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    private exchangeRateService: ExchangeRateService,
  ) {}

  // ---------------------------------------------------------------------------
  // Currency conversion
  // ---------------------------------------------------------------------------

  /**
   * Convert an amount from one currency to another using latest exchange rates.
   * Returns the original amount if no rate is found or currencies match.
   */
  async convertToDefault(
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

  // ---------------------------------------------------------------------------
  // Account categorisation
  // ---------------------------------------------------------------------------

  /**
   * Split a list of investment accounts into cash, brokerage, and standalone
   * buckets and derive the IDs of accounts that carry holdings.
   */
  categoriseAccounts(accounts: Account[]): CategorisedAccounts {
    const cashAccounts = accounts.filter(
      (a) => a.accountSubType === AccountSubType.INVESTMENT_CASH,
    );
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
    return {
      cashAccounts,
      brokerageAccounts,
      standaloneAccounts,
      holdingsAccountIds,
    };
  }

  // ---------------------------------------------------------------------------
  // Cash balance helpers
  // ---------------------------------------------------------------------------

  /**
   * Get effective cash balances (excluding future-dated transactions)
   * for the given accounts. Uses the account's currentBalance field,
   * which is already maintained to exclude future-dated transactions
   * by recalculateCurrentBalance / updateBalance.
   */
  async computeEffectiveBalances(
    accountIds: string[],
  ): Promise<Map<string, number>> {
    const effectiveBalances = new Map<string, number>();
    if (accountIds.length === 0) return effectiveBalances;

    const accounts = await this.accountsRepository.find({
      where: { id: In(accountIds) },
      select: ["id", "currentBalance"],
    });
    for (const account of accounts) {
      effectiveBalances.set(
        account.id,
        Math.round(Number(account.currentBalance) * 10000) / 10000,
      );
    }
    return effectiveBalances;
  }

  /**
   * Sum cash balances across the given accounts, converting to defaultCurrency.
   */
  async computeTotalCashValue(
    accounts: Account[],
    effectiveBalances: Map<string, number>,
    defaultCurrency: string,
    rateCache: Map<string, number>,
  ): Promise<number> {
    let totalCashValue = 0;
    for (const a of accounts) {
      const balance = effectiveBalances.get(a.id) ?? Number(a.currentBalance);
      totalCashValue += await this.convertToDefault(
        balance,
        a.currencyCode,
        defaultCurrency,
        rateCache,
      );
    }
    return totalCashValue;
  }

  // ---------------------------------------------------------------------------
  // Investment flow helpers
  // ---------------------------------------------------------------------------

  /**
   * Compute per-account investment transaction sums (BUYs, SELLs, Income)
   * for Net Invested calculation.
   *
   * `total_amount` is stored in the security's native currency, so each row
   * is multiplied by its `exchange_rate` (security currency -> cash account
   * currency) to keep the returned figures in the holding account's cash
   * currency. This matches the units of the per-account `cashBalance` used
   * by `buildHoldingsByAccount`, preventing a USD + CAD mix-up when the
   * security and the account use different currencies.
   */
  async computeInvestmentFlows(
    userId: string,
    accountIds: string[],
  ): Promise<Map<string, { buys: number; sells: number; income: number }>> {
    const investmentFlows = new Map<
      string,
      { buys: number; sells: number; income: number }
    >();
    if (accountIds.length === 0) return investmentFlows;

    const flowRows: {
      account_id: string;
      buys: string;
      sells: string;
      income: string;
    }[] = await this.accountsRepository.query(
      `SELECT account_id,
                COALESCE(SUM(CASE WHEN action = 'BUY' THEN total_amount * exchange_rate ELSE 0 END), 0) as buys,
                COALESCE(SUM(CASE WHEN action = 'SELL' THEN total_amount * exchange_rate ELSE 0 END), 0) as sells,
                COALESCE(SUM(CASE WHEN action IN ('DIVIDEND','INTEREST','CAPITAL_GAIN') THEN total_amount * exchange_rate ELSE 0 END), 0) as income
         FROM investment_transactions
         WHERE user_id = $1
           AND account_id = ANY($2)
           AND transaction_date <= CURRENT_DATE
         GROUP BY account_id`,
      [userId, accountIds],
    );
    for (const row of flowRows) {
      investmentFlows.set(row.account_id, {
        buys: Number(row.buys),
        sells: Number(row.sells),
        income: Number(row.income),
      });
    }
    return investmentFlows;
  }

  // ---------------------------------------------------------------------------
  // Holdings valuation
  // ---------------------------------------------------------------------------

  /**
   * Compute historical cost basis in each holding's account currency by
   * walking the investment transaction history chronologically and applying
   * each transaction's stored exchange rate.
   *
   * For BUY-like actions (BUY/REINVEST/TRANSFER_IN), cost basis increases by
   * `quantity * price * exchangeRate` — the amount actually spent in the cash
   * account's currency at that point in time.
   *
   * For SELL-like actions (SELL/TRANSFER_OUT), cost basis is reduced
   * proportionally using the running average (cost / quantity) so that
   * subsequent gains are calculated against the remaining shares.
   *
   * Quantity-only actions (ADD_SHARES/REMOVE_SHARES) do not change cost basis;
   * SPLIT scales the tracked quantity so the per-share average adjusts.
   *
   * @returns Map keyed by `${accountId}:${securityId}` -> cost basis in the
   *          holding account's currency.
   */
  async calculateCostBasesInAccountCurrency(
    userId: string,
    holdingsAccountIds: string[],
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (holdingsAccountIds.length === 0) return result;

    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    const transactions = await this.investmentTransactionRepository.find({
      where: {
        userId,
        accountId: In(holdingsAccountIds),
        transactionDate: LessThanOrEqual(today),
      },
      order: { transactionDate: "ASC", createdAt: "ASC" },
    });

    const state = new Map<string, { quantity: number; costBasis: number }>();

    for (const tx of transactions) {
      if (!tx.securityId) continue;

      const key = `${tx.accountId}:${tx.securityId}`;
      let entry = state.get(key);
      if (!entry) {
        entry = { quantity: 0, costBasis: 0 };
        state.set(key, entry);
      }

      const quantity = Number(tx.quantity) || 0;

      switch (tx.action) {
        case InvestmentAction.BUY:
        case InvestmentAction.REINVEST:
        case InvestmentAction.TRANSFER_IN: {
          const price = Number(tx.price) || 0;
          const exchangeRate = Number(tx.exchangeRate) || 1;
          entry.costBasis += quantity * price * exchangeRate;
          entry.quantity += quantity;
          break;
        }
        case InvestmentAction.SELL:
        case InvestmentAction.TRANSFER_OUT: {
          if (entry.quantity > 0) {
            const avgCostPerShare = entry.costBasis / entry.quantity;
            const sellQty = Math.min(quantity, entry.quantity);
            entry.costBasis -= sellQty * avgCostPerShare;
            entry.quantity -= sellQty;
          }
          break;
        }
        case InvestmentAction.ADD_SHARES:
          entry.quantity += quantity;
          break;
        case InvestmentAction.REMOVE_SHARES:
          entry.quantity -= quantity;
          break;
        case InvestmentAction.SPLIT: {
          const splitRatio = quantity || 1;
          if (splitRatio > 0) {
            entry.quantity *= splitRatio;
          }
          break;
        }
        // DIVIDEND / INTEREST / CAPITAL_GAIN: cash only, no impact on cost basis
      }

      // Snap near-zero quantities to exactly zero so precision drift doesn't
      // leave a stale residual cost basis on fully-closed positions.
      if (Math.abs(entry.quantity) < 0.0001) {
        entry.quantity = 0;
        entry.costBasis = 0;
      }
    }

    for (const [key, entry] of state) {
      result.set(key, Math.round(entry.costBasis * 10000) / 10000);
    }

    return result;
  }

  /**
   * Replay the user's investment transaction history to compute the realized
   * gain or loss of each SELL transaction using the average-cost method.
   *
   * For every prior BUY/REINVEST/TRANSFER_IN, the running cost basis for that
   * (account, security) grows by `quantity * price * exchangeRate` (the same
   * bookkeeping as `calculateCostBasesInAccountCurrency`). A SELL then draws
   * down cost basis proportionally at the running average cost per share, and
   * the realized gain is `proceeds - costBasis` — all in the holding account's
   * currency.
   *
   * The entire history is replayed regardless of the requested date range so
   * SELLs early in the range still see cost basis built up by prior BUYs; only
   * the returned rows are filtered to the requested window.
   */
  async calculateRealizedGains(
    userId: string,
    opts: {
      accountIds?: string[];
      startDate?: string;
      endDate?: string;
    } = {},
  ): Promise<RealizedGainEntry[]> {
    const { accountIds, startDate, endDate } = opts;

    const where: FindOptionsWhere<InvestmentTransaction> = { userId };
    if (accountIds && accountIds.length > 0) {
      where.accountId = In(accountIds);
    }
    if (endDate) {
      where.transactionDate = LessThanOrEqual(endDate);
    }

    const transactions = await this.investmentTransactionRepository.find({
      where,
      relations: ["security", "account"],
      order: { transactionDate: "ASC", createdAt: "ASC" },
    });

    const state = new Map<string, { quantity: number; costBasis: number }>();
    const results: RealizedGainEntry[] = [];

    for (const tx of transactions) {
      if (!tx.securityId) continue;

      const key = `${tx.accountId}:${tx.securityId}`;
      let entry = state.get(key);
      if (!entry) {
        entry = { quantity: 0, costBasis: 0 };
        state.set(key, entry);
      }

      const quantity = Number(tx.quantity) || 0;
      const price = Number(tx.price) || 0;
      const exchangeRate = Number(tx.exchangeRate) || 1;

      switch (tx.action) {
        case InvestmentAction.BUY:
        case InvestmentAction.REINVEST:
        case InvestmentAction.TRANSFER_IN: {
          entry.costBasis += quantity * price * exchangeRate;
          entry.quantity += quantity;
          break;
        }
        case InvestmentAction.SELL:
        case InvestmentAction.TRANSFER_OUT: {
          const sellQty = Math.min(quantity, entry.quantity);
          const avgCostPerShare =
            entry.quantity > 0 ? entry.costBasis / entry.quantity : 0;
          const costBasisSold = sellQty * avgCostPerShare;
          entry.costBasis -= costBasisSold;
          entry.quantity -= sellQty;

          if (tx.action === InvestmentAction.SELL) {
            // totalAmount is already stored in the security's currency and is
            // net of commission; multiply by exchangeRate to put both sides of
            // the gain calculation in the holding account's currency.
            const proceeds = Number(tx.totalAmount) * exchangeRate;
            const realizedGain = proceeds - costBasisSold;

            if (!startDate || tx.transactionDate >= startDate) {
              results.push({
                transactionId: tx.id,
                transactionDate: tx.transactionDate,
                accountId: tx.accountId,
                accountName: tx.account?.name ?? null,
                accountCurrencyCode: tx.account?.currencyCode ?? null,
                securityId: tx.securityId,
                symbol: tx.security?.symbol ?? null,
                securityName: tx.security?.name ?? null,
                securityCurrencyCode: tx.security?.currencyCode ?? null,
                quantity: Math.abs(quantity),
                price,
                commission: Number(tx.commission) || 0,
                proceeds: roundMoney(proceeds),
                costBasis: roundMoney(costBasisSold),
                realizedGain: roundMoney(realizedGain),
              });
            }
          }
          break;
        }
        case InvestmentAction.ADD_SHARES:
          entry.quantity += quantity;
          break;
        case InvestmentAction.REMOVE_SHARES:
          entry.quantity -= quantity;
          break;
        case InvestmentAction.SPLIT: {
          const splitRatio = quantity || 1;
          if (splitRatio > 0) entry.quantity *= splitRatio;
          break;
        }
      }

      if (Math.abs(entry.quantity) < 0.0001) {
        entry.quantity = 0;
        entry.costBasis = 0;
      }
    }

    return results;
  }

  /**
   * Compute realized + unrealized capital gains per (account, security, month)
   * across the requested window. Replays the user's full investment history
   * to derive cost basis and quantities, then snapshots the position at each
   * month boundary using historical close prices to capture mark-to-market
   * changes alongside any realized gains from SELLs in the month.
   *
   * Quantities are snapshotted at each month boundary; market values use the
   * last available close on or before the snapshot date converted to the
   * holding account's currency at the latest exchange rate. BUYs/SELLs use
   * their stored historical exchange rate (matching `calculateRealizedGains`).
   * Months with no holding and no activity are omitted from the result.
   */
  async calculateCapitalGainsByMonth(
    userId: string,
    opts: {
      accountIds?: string[];
      startDate: string;
      endDate: string;
      defaultCurrency?: string;
    },
  ): Promise<CapitalGainEntry[]> {
    const { startDate, endDate } = opts;
    if (!startDate || !endDate || startDate > endDate) return [];
    const periods = enumerateMonths(startDate, endDate);
    if (periods.length === 0) return [];
    return this.calculateCapitalGainsForPeriods(userId, opts, periods);
  }

  /**
   * Compute realized + unrealized capital gains per (account, security, day)
   * across the requested window. Identical to calculateCapitalGainsByMonth but
   * snapshotted at daily rather than monthly boundaries. The `month` field on
   * each returned CapitalGainEntry holds a YYYY-MM-DD key for the day.
   */
  async calculateCapitalGainsByDay(
    userId: string,
    opts: {
      accountIds?: string[];
      startDate: string;
      endDate: string;
      defaultCurrency?: string;
    },
  ): Promise<CapitalGainEntry[]> {
    const { startDate, endDate } = opts;
    if (!startDate || !endDate || startDate > endDate) return [];
    const periods = enumerateDays(startDate, endDate);
    if (periods.length === 0) return [];
    return this.calculateCapitalGainsForPeriods(userId, opts, periods);
  }

  /**
   * Core capital-gains replay loop shared by calculateCapitalGainsByMonth and
   * calculateCapitalGainsByDay. Replays transaction history and snapshots the
   * position at the boundary of each PeriodBucket. The `month` field on each
   * returned entry is set to the bucket's `key` (YYYY-MM for months, YYYY-MM-DD
   * for days).
   */
  private async calculateCapitalGainsForPeriods(
    userId: string,
    opts: {
      accountIds?: string[];
      startDate: string;
      endDate: string;
      defaultCurrency?: string;
    },
    periods: PeriodBucket[],
  ): Promise<CapitalGainEntry[]> {
    const { accountIds, endDate } = opts;

    const where: FindOptionsWhere<InvestmentTransaction> = { userId };
    if (accountIds && accountIds.length > 0) {
      where.accountId = In(accountIds);
    }
    where.transactionDate = LessThanOrEqual(endDate);

    const transactions = await this.investmentTransactionRepository.find({
      where,
      relations: ["security", "account"],
      order: { transactionDate: "ASC", createdAt: "ASC" },
    });

    if (transactions.length === 0) return [];

    const securityIds = [
      ...new Set(
        transactions.filter((t) => t.securityId).map((t) => t.securityId!),
      ),
    ];
    const allPrices = await this.getAllPricesForSecurities(securityIds);

    // Group transactions by (account, security)
    type GroupKey = string;
    const groups = new Map<
      GroupKey,
      {
        accountId: string;
        accountName: string | null;
        accountCurrencyCode: string | null;
        securityId: string;
        symbol: string | null;
        securityName: string | null;
        securityCurrencyCode: string | null;
        txs: InvestmentTransaction[];
      }
    >();
    for (const tx of transactions) {
      if (!tx.securityId) continue;
      const groupKey = `${tx.accountId}:${tx.securityId}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          accountId: tx.accountId,
          accountName: tx.account?.name ?? null,
          accountCurrencyCode: tx.account?.currencyCode ?? null,
          securityId: tx.securityId,
          symbol: tx.security?.symbol ?? null,
          securityName: tx.security?.name ?? null,
          securityCurrencyCode: tx.security?.currencyCode ?? null,
          txs: [],
        };
        groups.set(groupKey, group);
      }
      group.txs.push(tx);
    }

    // Cache FX rates: securityCurrency -> accountCurrency
    const fxCache = new Map<string, number>();
    const fxRate = async (
      from: string | null,
      to: string | null,
    ): Promise<number> => {
      if (!from || !to || from === to) return 1;
      const cacheKey = `${from}->${to}`;
      const cached = fxCache.get(cacheKey);
      if (cached !== undefined) return cached;
      let rate = await this.exchangeRateService.getLatestRate(from, to);
      if (rate === null) {
        const reverse = await this.exchangeRateService.getLatestRate(to, from);
        rate = reverse !== null ? 1 / reverse : 1;
      }
      fxCache.set(cacheKey, rate);
      return rate;
    };

    const results: CapitalGainEntry[] = [];

    for (const group of groups.values()) {
      const txs = group.txs;
      const state = { quantity: 0, costBasis: 0 };
      let txIdx = 0;
      const securityToAccountFx = await fxRate(
        group.securityCurrencyCode,
        group.accountCurrencyCode,
      );

      // Replay any transactions strictly before the first period to seed state.
      while (
        txIdx < txs.length &&
        txs[txIdx].transactionDate < periods[0].periodStart
      ) {
        applyTxToState(txs[txIdx], state);
        txIdx++;
      }

      for (const { key: periodKey, periodEnd, priceLookupStart } of periods) {
        const startQuantity = state.quantity;
        const startPrice =
          this.lookupPrice(group.securityId, priceLookupStart, allPrices) ?? 0;
        const startValue = startQuantity * startPrice * securityToAccountFx;

        let buys = 0;
        let sells = 0;
        let realizedGain = 0;

        while (txIdx < txs.length && txs[txIdx].transactionDate <= periodEnd) {
          const tx = txs[txIdx];
          const quantity = Number(tx.quantity) || 0;
          const price = Number(tx.price) || 0;
          const exchangeRate = Number(tx.exchangeRate) || 1;

          switch (tx.action) {
            case InvestmentAction.BUY:
            case InvestmentAction.REINVEST:
            case InvestmentAction.TRANSFER_IN: {
              buys += quantity * price * exchangeRate;
              state.costBasis += quantity * price * exchangeRate;
              state.quantity += quantity;
              break;
            }
            case InvestmentAction.SELL:
            case InvestmentAction.TRANSFER_OUT: {
              const sellQty = Math.min(quantity, state.quantity);
              const avgCostPerShare =
                state.quantity > 0 ? state.costBasis / state.quantity : 0;
              const costBasisSold = sellQty * avgCostPerShare;
              state.costBasis -= costBasisSold;
              state.quantity -= sellQty;
              if (tx.action === InvestmentAction.SELL) {
                const proceeds = Number(tx.totalAmount) * exchangeRate;
                sells += proceeds;
                realizedGain += proceeds - costBasisSold;
              }
              break;
            }
            case InvestmentAction.ADD_SHARES:
              state.quantity += quantity;
              break;
            case InvestmentAction.REMOVE_SHARES:
              state.quantity -= quantity;
              break;
            case InvestmentAction.SPLIT: {
              const splitRatio = quantity || 1;
              if (splitRatio > 0) state.quantity *= splitRatio;
              break;
            }
          }

          if (Math.abs(state.quantity) < 0.0001) {
            state.quantity = 0;
            state.costBasis = 0;
          }
          txIdx++;
        }

        const endQuantity = state.quantity;
        const endPrice =
          this.lookupPrice(group.securityId, periodEnd, allPrices) ?? 0;
        const endValue = endQuantity * endPrice * securityToAccountFx;

        const totalCapitalGain = endValue - startValue + sells - buys;
        const unrealizedGain = totalCapitalGain - realizedGain;

        const hasActivity =
          buys !== 0 ||
          sells !== 0 ||
          realizedGain !== 0 ||
          startQuantity !== 0 ||
          endQuantity !== 0;
        if (!hasActivity) continue;

        // Suppress vanishingly small float drift to keep the chart clean.
        const round = (n: number) => (Math.abs(n) < 0.005 ? 0 : roundMoney(n));

        results.push({
          month: periodKey,
          accountId: group.accountId,
          accountName: group.accountName,
          accountCurrencyCode: group.accountCurrencyCode,
          securityId: group.securityId,
          symbol: group.symbol,
          securityName: group.securityName,
          securityCurrencyCode: group.securityCurrencyCode,
          startQuantity,
          endQuantity,
          startValue: round(startValue),
          endValue: round(endValue),
          buys: round(buys),
          sells: round(sells),
          realizedGain: round(realizedGain),
          unrealizedGain: round(unrealizedGain),
          totalCapitalGain: round(totalCapitalGain),
        });
      }
    }

    return results;
  }

  /**
   * Fetch holdings for the given account IDs, compute per-holding market value,
   * gain/loss, and accumulate totals (converted to defaultCurrency).
   *
   * Each holding is also annotated with `costBasisAccountCurrency`, the
   * historical cost basis in the holding account's currency derived from the
   * exchange rates stored on the original BUY transactions. Holdings that lack
   * matching transaction history (e.g. imported positions) fall back to
   * converting the current security-currency cost basis with the latest rate.
   *
   * @param getLatestPrices - callback to fetch latest prices by security IDs
   * Returns the enriched holdings array plus the converted totals.
   */
  async calculateHoldingsWithValues(
    userId: string,
    holdingsAccountIds: string[],
    defaultCurrency: string,
    rateCache: Map<string, number>,
    getLatestPrices: (securityIds: string[]) => Promise<Map<string, number>>,
  ): Promise<{
    holdings: Holding[];
    holdingsWithValues: HoldingWithMarketValue[];
    totalCostBasis: number;
    totalHoldingsValue: number;
  }> {
    let holdings: Holding[] = [];
    if (holdingsAccountIds.length > 0) {
      holdings = await this.holdingsRepository.find({
        where: { accountId: In(holdingsAccountIds) },
        relations: ["security", "account"],
      });
    }

    // Get latest prices for all securities in holdings
    const securityIds = [...new Set(holdings.map((h) => h.securityId))];
    const priceMap = await getLatestPrices(securityIds);

    // Historical cost basis in each holding's account currency
    const historicalCostBasis = await this.calculateCostBasesInAccountCurrency(
      userId,
      holdingsAccountIds,
    );

    let totalCostBasis = 0;
    let totalHoldingsValue = 0;
    const holdingsWithValues: HoldingWithMarketValue[] = [];

    for (const h of holdings) {
      if (Math.abs(Number(h.quantity)) < 0.0001) continue;

      const quantity = Number(h.quantity);
      const averageCost = Number(h.averageCost || 0);
      const costBasis = quantity * averageCost;
      const currentPrice = priceMap.get(h.securityId) ?? null;
      const marketValue =
        currentPrice !== null ? quantity * currentPrice : null;
      const gainLoss = marketValue !== null ? marketValue - costBasis : null;
      const gainLossPercent =
        gainLoss !== null && costBasis > 0
          ? (gainLoss / costBasis) * 100
          : null;

      const holdingCurrency = h.security.currencyCode;
      const accountCurrency = h.account?.currencyCode ?? holdingCurrency;

      // Prefer the historical cost basis derived from transaction exchange
      // rates; fall back to current-rate conversion when no transaction
      // history is available (e.g. holdings imported without transactions).
      const historicalKey = `${h.accountId}:${h.securityId}`;
      let costBasisAccountCurrency = historicalCostBasis.get(historicalKey);
      if (costBasisAccountCurrency === undefined) {
        costBasisAccountCurrency = await this.convertToDefault(
          costBasis,
          holdingCurrency,
          accountCurrency,
          rateCache,
        );
      }

      totalCostBasis += await this.convertToDefault(
        costBasisAccountCurrency,
        accountCurrency,
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
        costBasisAccountCurrency,
        currentPrice,
        marketValue,
        gainLoss,
        gainLossPercent,
      });
    }

    return { holdings, holdingsWithValues, totalCostBasis, totalHoldingsValue };
  }

  // ---------------------------------------------------------------------------
  // Account grouping
  // ---------------------------------------------------------------------------

  /**
   * Sort holdings by market value descending (nulls last).
   */
  private sortHoldings(
    items: HoldingWithMarketValue[],
  ): HoldingWithMarketValue[] {
    return items.sort((a, b) => {
      if (a.marketValue === null && b.marketValue === null) return 0;
      if (a.marketValue === null) return 1;
      if (b.marketValue === null) return -1;
      return b.marketValue - a.marketValue;
    });
  }

  /**
   * Group enriched holdings by account, attaching cash balances and net-invested
   * figures. Returns an array of AccountHoldings sorted by total market value.
   */
  async buildHoldingsByAccount(
    categorised: CategorisedAccounts,
    holdingsWithValues: HoldingWithMarketValue[],
    effectiveBalances: Map<string, number>,
    investmentFlows: Map<
      string,
      { buys: number; sells: number; income: number }
    >,
    rateCache: Map<string, number>,
  ): Promise<AccountHoldings[]> {
    // Group holdings by account
    const holdingsByAccountMap = new Map<string, HoldingWithMarketValue[]>();
    for (const holding of holdingsWithValues) {
      const existing = holdingsByAccountMap.get(holding.accountId) || [];
      existing.push(holding);
      holdingsByAccountMap.set(holding.accountId, existing);
    }

    const holdingsByAccount: AccountHoldings[] = [];

    // Process brokerage accounts (paired with cash accounts)
    for (const brokerageAccount of categorised.brokerageAccounts) {
      const accountHoldings =
        holdingsByAccountMap.get(brokerageAccount.id) || [];

      // Find the linked cash account
      const linkedCashAccount = categorised.cashAccounts.find(
        (c) =>
          c.linkedAccountId === brokerageAccount.id ||
          brokerageAccount.linkedAccountId === c.id,
      );

      // Calculate account totals. Cost basis uses the historical (stored)
      // exchange rate from each originating transaction, while market value
      // uses the current exchange rate so unrealised gains reflect today's
      // valuation vs. the price actually paid when shares were bought.
      const acctCurrency = brokerageAccount.currencyCode;
      let accountCostBasis = 0;
      let accountMarketValue = 0;
      for (const h of accountHoldings) {
        accountCostBasis += h.costBasisAccountCurrency;
        accountMarketValue += await this.convertToDefault(
          h.marketValue ?? 0,
          h.currencyCode,
          acctCurrency,
          rateCache,
        );
      }
      const accountGainLoss = accountMarketValue - accountCostBasis;
      const accountGainLossPercent =
        accountCostBasis > 0 ? (accountGainLoss / accountCostBasis) * 100 : 0;

      // Get display name (remove " - Brokerage" suffix if present)
      const accountName = brokerageAccount.name.replace(" - Brokerage", "");

      const cashBalance = linkedCashAccount
        ? (effectiveBalances.get(linkedCashAccount.id) ??
          Number(linkedCashAccount.currentBalance))
        : 0;
      const flows = investmentFlows.get(brokerageAccount.id) ?? {
        buys: 0,
        sells: 0,
        income: 0,
      };
      const accountNetInvested =
        cashBalance + flows.buys - flows.sells - flows.income;

      holdingsByAccount.push({
        accountId: brokerageAccount.id,
        accountName,
        currencyCode: brokerageAccount.currencyCode,
        cashAccountId: linkedCashAccount?.id ?? null,
        cashBalance,
        holdings: this.sortHoldings(accountHoldings),
        totalCostBasis: accountCostBasis,
        totalMarketValue: accountMarketValue,
        totalGainLoss: accountGainLoss,
        totalGainLossPercent: accountGainLossPercent,
        netInvested: Math.round(accountNetInvested * 100) / 100,
      });
    }

    // Process standalone investment accounts (not paired, cash balance is on the same account)
    for (const standaloneAccount of categorised.standaloneAccounts) {
      const accountHoldings =
        holdingsByAccountMap.get(standaloneAccount.id) || [];

      // Calculate account totals — historical cost basis + current-rate
      // market value, same treatment as brokerage accounts above.
      const standaloneCurrency = standaloneAccount.currencyCode;
      let accountCostBasis = 0;
      let accountMarketValue = 0;
      for (const h of accountHoldings) {
        accountCostBasis += h.costBasisAccountCurrency;
        accountMarketValue += await this.convertToDefault(
          h.marketValue ?? 0,
          h.currencyCode,
          standaloneCurrency,
          rateCache,
        );
      }
      const accountGainLoss = accountMarketValue - accountCostBasis;
      const accountGainLossPercent =
        accountCostBasis > 0 ? (accountGainLoss / accountCostBasis) * 100 : 0;

      const standaloneCashBalance =
        effectiveBalances.get(standaloneAccount.id) ??
        Number(standaloneAccount.currentBalance);
      const standaloneFlows = investmentFlows.get(standaloneAccount.id) ?? {
        buys: 0,
        sells: 0,
        income: 0,
      };
      const standaloneNetInvested =
        standaloneCashBalance +
        standaloneFlows.buys -
        standaloneFlows.sells -
        standaloneFlows.income;

      holdingsByAccount.push({
        accountId: standaloneAccount.id,
        accountName: standaloneAccount.name,
        currencyCode: standaloneAccount.currencyCode,
        cashAccountId: standaloneAccount.id, // Cash is on this same account
        cashBalance: standaloneCashBalance,
        holdings: this.sortHoldings(accountHoldings),
        totalCostBasis: accountCostBasis,
        totalMarketValue: accountMarketValue,
        totalGainLoss: accountGainLoss,
        totalGainLossPercent: accountGainLossPercent,
        netInvested: Math.round(standaloneNetInvested * 100) / 100,
      });
    }

    // Sort accounts by total market value descending
    holdingsByAccount.sort((a, b) => b.totalMarketValue - a.totalMarketValue);

    return holdingsByAccount;
  }

  // ---------------------------------------------------------------------------
  // Allocation
  // ---------------------------------------------------------------------------

  /**
   * Build the portfolio allocation breakdown from sorted holdings and cash.
   */
  async buildAllocation(
    sortedHoldings: HoldingWithMarketValue[],
    holdings: Holding[],
    totalCashValue: number,
    totalPortfolioValue: number,
    defaultCurrency: string,
    rateCache: Map<string, number>,
  ): Promise<AllocationItem[]> {
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

    // Consolidate holdings by security so the same security held across
    // multiple accounts appears as a single allocation slice.
    const consolidated = new Map<
      string,
      {
        name: string;
        symbol: string;
        currencyCode: string;
        value: number;
      }
    >();

    for (const holding of sortedHoldings) {
      if (holding.marketValue === null || holding.marketValue <= 0) continue;
      const originalHolding = holdings.find((h) => h.id === holding.id);
      const holdingCurrency =
        originalHolding?.security?.currencyCode || defaultCurrency;
      const convertedValue = await this.convertToDefault(
        holding.marketValue,
        holdingCurrency,
        defaultCurrency,
        rateCache,
      );
      const existing = consolidated.get(holding.securityId);
      if (existing) {
        existing.value += convertedValue;
      } else {
        consolidated.set(holding.securityId, {
          name: holding.name,
          symbol: holding.symbol,
          currencyCode: holdingCurrency,
          value: convertedValue,
        });
      }
    }

    const consolidatedItems = [...consolidated.values()].sort(
      (a, b) => b.value - a.value,
    );

    let colorIndex = 0;
    for (const item of consolidatedItems) {
      allocation.push({
        name: item.name,
        symbol: item.symbol,
        type: "security",
        value: item.value,
        percentage:
          totalPortfolioValue > 0
            ? (item.value / totalPortfolioValue) * 100
            : 0,
        color: colors[colorIndex % colors.length],
        currencyCode: item.currencyCode,
      });
      colorIndex++;
    }

    allocation.sort((a, b) => b.value - a.value);
    return allocation;
  }

  // ---------------------------------------------------------------------------
  // Performance metrics
  // ---------------------------------------------------------------------------

  /**
   * Calculate CAGR (Compound Annual Growth Rate).
   * CAGR = (Portfolio Value / Net Invested) ^ (1/years) - 1
   */
  async calculateCAGR(
    userId: string,
    allInvestmentAccountIds: string[],
    totalNetInvested: number,
    totalPortfolioValue: number,
  ): Promise<number | null> {
    if (
      totalNetInvested <= 0 ||
      totalPortfolioValue <= 0 ||
      allInvestmentAccountIds.length === 0
    ) {
      return null;
    }

    const earliestRow: { earliest: string }[] =
      await this.accountsRepository.query(
        `SELECT MIN(transaction_date) as earliest
       FROM investment_transactions
       WHERE user_id = $1
         AND account_id = ANY($2)
         AND transaction_date <= CURRENT_DATE`,
        [userId, allInvestmentAccountIds],
      );
    if (!earliestRow[0]?.earliest) return null;

    const earliest = new Date(earliestRow[0].earliest);
    const now = new Date();
    const years =
      (now.getTime() - earliest.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    // CAGR annualizes the total return, so for periods shorter than a year
    // it extrapolates a few days of price movement into a multi-decade
    // growth rate. The math is correct but the number is meaningless and
    // can run into the thousands of percent (or worse) for fresh accounts.
    if (years < 1) return null;

    return (
      (Math.pow(totalPortfolioValue / totalNetInvested, 1 / years) - 1) * 100
    );
  }

  // ---------------------------------------------------------------------------
  // Time-Weighted Return (TWR)
  // ---------------------------------------------------------------------------

  /**
   * Get all historical prices for a list of security IDs, ordered by date.
   * Returns a map of securityId -> sorted array of { date, price }.
   */
  async getAllPricesForSecurities(
    securityIds: string[],
  ): Promise<Map<string, { date: string; price: number }[]>> {
    if (securityIds.length === 0) return new Map();

    const rows: {
      security_id: string;
      price_date: string;
      close_price: string;
    }[] = await this.securityPriceRepository.query(
      `SELECT security_id, price_date::text AS price_date, close_price
         FROM security_prices
         WHERE security_id = ANY($1)
         ORDER BY security_id, price_date ASC`,
      [securityIds],
    );

    const result = new Map<string, { date: string; price: number }[]>();
    for (const row of rows) {
      let arr = result.get(row.security_id);
      if (!arr) {
        arr = [];
        result.set(row.security_id, arr);
      }
      arr.push({ date: row.price_date, price: Number(row.close_price) });
    }
    return result;
  }

  /**
   * Look up the price for a security on or before a given date using binary search.
   */
  lookupPrice(
    securityId: string,
    date: string,
    allPrices: Map<string, { date: string; price: number }[]>,
  ): number | null {
    const prices = allPrices.get(securityId);
    if (!prices || prices.length === 0) return null;

    let lo = 0;
    let hi = prices.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (prices[mid].date <= date) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best >= 0 ? prices[best].price : null;
  }

  /**
   * Calculate Time-Weighted Return (TWR) for a set of investment accounts.
   * Forward-simulates holdings at each transaction date boundary and chains
   * sub-period returns to produce a cumulative TWR percentage.
   *
   * @param getLatestPrices - callback to fetch latest prices (injected from PortfolioService)
   */
  async calculateTWR(
    userId: string,
    holdingsAccountIds: string[],
    defaultCurrency: string,
    rateCache: Map<string, number>,
    getLatestPrices: (securityIds: string[]) => Promise<Map<string, number>>,
  ): Promise<number | null> {
    if (holdingsAccountIds.length === 0) return null;

    // Fetch all investment transactions for these accounts, ordered by date
    const transactions = await this.investmentTransactionRepository.find({
      where: { userId, accountId: In(holdingsAccountIds) },
      relations: ["security"],
      order: { transactionDate: "ASC", createdAt: "ASC" },
    });

    if (transactions.length === 0) return null;

    // Gather all referenced security IDs and fetch their full price history
    const securityIds = [
      ...new Set(
        transactions.filter((t) => t.securityId).map((t) => t.securityId!),
      ),
    ];
    const allPrices = await this.getAllPricesForSecurities(securityIds);

    // Build a map of securityId -> currencyCode from transactions
    const currencyMap = new Map<string, string>();
    for (const tx of transactions) {
      if (tx.securityId && tx.security) {
        currencyMap.set(tx.securityId, tx.security.currencyCode);
      }
    }

    // Group transactions by date
    const txByDate = new Map<string, InvestmentTransaction[]>();
    for (const tx of transactions) {
      let arr = txByDate.get(tx.transactionDate);
      if (!arr) {
        arr = [];
        txByDate.set(tx.transactionDate, arr);
      }
      arr.push(tx);
    }

    const sortedDates = [...txByDate.keys()].sort();

    // M16: Batch-fetch all latest prices once to avoid N+1 queries
    const latestPriceCache = await getLatestPrices(securityIds);

    // Helper: compute portfolio value from holdings state (current prices)
    const computeValue = async (
      holdings: Map<string, number>,
    ): Promise<number> => {
      let total = 0;
      for (const [secId, qty] of holdings) {
        if (qty === 0) continue;
        const price = latestPriceCache.get(secId);
        if (price != null) {
          const currency = currencyMap.get(secId) || defaultCurrency;
          total += await this.convertToDefault(
            qty * price,
            currency,
            defaultCurrency,
            rateCache,
          );
        }
      }
      return total;
    };

    // Helper: compute portfolio value from holdings state at a specific date
    const computeValueAtDate = async (
      holdings: Map<string, number>,
      date: string,
    ): Promise<number> => {
      let total = 0;
      for (const [secId, qty] of holdings) {
        if (qty === 0) continue;
        const price = this.lookupPrice(secId, date, allPrices);
        if (price != null) {
          const currency = currencyMap.get(secId) || defaultCurrency;
          total += await this.convertToDefault(
            qty * price,
            currency,
            defaultCurrency,
            rateCache,
          );
        }
      }
      return total;
    };

    // Forward-simulate holdings and chain sub-period returns
    const holdings = new Map<string, number>(); // securityId -> quantity
    const subPeriodFactors: number[] = [];
    let previousValue = 0;
    let previousDate: string | null = null;

    for (const date of sortedDates) {
      const dayTxs = txByDate.get(date)!;

      if (previousDate !== null && previousValue > 0) {
        // Value of existing holdings at this date's prices (before applying today's transactions)
        const currentValue = await computeValueAtDate(holdings, date);
        if (currentValue >= 0) {
          subPeriodFactors.push(currentValue / previousValue);
        }
      }

      // Apply today's transactions to holdings
      for (const tx of dayTxs) {
        if (!tx.securityId) continue;
        const current = holdings.get(tx.securityId) || 0;
        const qty = Number(tx.quantity || 0);

        switch (tx.action) {
          case InvestmentAction.BUY:
          case InvestmentAction.REINVEST:
          case InvestmentAction.TRANSFER_IN:
          case InvestmentAction.ADD_SHARES:
            holdings.set(tx.securityId, current + qty);
            break;
          case InvestmentAction.SELL:
          case InvestmentAction.TRANSFER_OUT:
          case InvestmentAction.REMOVE_SHARES:
            holdings.set(tx.securityId, current - qty);
            break;
          // DIVIDEND, INTEREST, CAPITAL_GAIN, SPLIT: no quantity change
        }
      }

      // Compute portfolio value after today's transactions
      previousValue = await computeValueAtDate(holdings, date);
      previousDate = date;
    }

    // Final sub-period: from last transaction date to today
    if (previousValue > 0) {
      const todayValue = await computeValue(holdings);
      if (todayValue >= 0) {
        subPeriodFactors.push(todayValue / previousValue);
      }
    }

    if (subPeriodFactors.length === 0) return null;

    // Chain: TWR = product of all factors - 1
    let product = 1;
    for (const factor of subPeriodFactors) {
      product *= factor;
    }

    return (product - 1) * 100;
  }
}
