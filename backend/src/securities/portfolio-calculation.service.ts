import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In, LessThanOrEqual } from "typeorm";
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
    if (years < 1 / 365.25) return null; // Less than 1 day of history

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
  private async getAllPricesForSecurities(
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
  private lookupPrice(
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
