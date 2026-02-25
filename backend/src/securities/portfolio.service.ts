import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In } from "typeorm";
import { Holding } from "./entities/holding.entity";
import { SecurityPrice } from "./entities/security-price.entity";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "./entities/investment-transaction.entity";
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
  netInvested: number;
}

export interface PortfolioSummary {
  totalCashValue: number;
  totalHoldingsValue: number;
  totalCostBasis: number;
  totalNetInvested: number;
  totalPortfolioValue: number;
  totalGainLoss: number;
  totalGainLossPercent: number;
  timeWeightedReturn: number | null;
  cagr: number | null;
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
    @InjectRepository(InvestmentTransaction)
    private investmentTransactionRepository: Repository<InvestmentTransaction>,
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

    // Binary search for the last entry with date <= target
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
   */
  private async calculateTWR(
    userId: string,
    holdingsAccountIds: string[],
    defaultCurrency: string,
    rateCache: Map<string, number>,
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

    // Helper: compute portfolio value from holdings state
    const computeValue = async (
      holdings: Map<string, number>,
    ): Promise<number> => {
      let total = 0;
      for (const [secId, qty] of holdings) {
        if (qty === 0) continue;
        const latestPriceMap = await this.getLatestPrices([secId]);
        const price = latestPriceMap.get(secId);
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

    // Compute per-account investment transaction sums for Net Invested calculation
    // Net Invested = Cash Balance + BUYs - SELLs - Income (DIVIDEND/INTEREST/CAPITAL_GAIN)
    // This algebraically equals the net external cash contributed to the account
    const investmentFlows = new Map<
      string,
      { buys: number; sells: number; income: number }
    >();
    const allInvestmentAccountIds = [
      ...brokerageAccounts.map((a) => a.id),
      ...standaloneAccounts.map((a) => a.id),
    ];
    if (allInvestmentAccountIds.length > 0) {
      const flowRows: {
        account_id: string;
        buys: string;
        sells: string;
        income: string;
      }[] = await this.accountsRepository.query(
        `SELECT account_id,
                  COALESCE(SUM(CASE WHEN action = 'BUY' THEN total_amount ELSE 0 END), 0) as buys,
                  COALESCE(SUM(CASE WHEN action = 'SELL' THEN total_amount ELSE 0 END), 0) as sells,
                  COALESCE(SUM(CASE WHEN action IN ('DIVIDEND','INTEREST','CAPITAL_GAIN') THEN total_amount ELSE 0 END), 0) as income
           FROM investment_transactions
           WHERE user_id = $1
             AND account_id = ANY($2)
             AND transaction_date <= CURRENT_DATE
           GROUP BY account_id`,
        [userId, allInvestmentAccountIds],
      );
      for (const row of flowRows) {
        investmentFlows.set(row.account_id, {
          buys: Number(row.buys),
          sells: Number(row.sells),
          income: Number(row.income),
        });
      }
    }

    // Get holdings for brokerage accounts AND standalone accounts
    const holdingsAccountIds = allInvestmentAccountIds;
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
        netInvested: Math.round(accountNetInvested * 100) / 100,
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
        netInvested: Math.round(standaloneNetInvested * 100) / 100,
      });
    }

    // Sort accounts by total market value descending
    holdingsByAccount.sort((a, b) => b.totalMarketValue - a.totalMarketValue);

    const totalPortfolioValue = totalCashValue + totalHoldingsValue;
    const totalGainLoss = totalHoldingsValue - totalCostBasis;
    const totalGainLossPercent =
      totalCostBasis > 0 ? (totalGainLoss / totalCostBasis) * 100 : 0;

    // Calculate total net invested (converted to default currency)
    let totalNetInvested = 0;
    for (const acct of holdingsByAccount) {
      totalNetInvested += await this.convertToDefault(
        acct.netInvested,
        acct.currencyCode,
        defaultCurrency,
        rateCache,
      );
    }

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

    // Calculate Time-Weighted Return
    const timeWeightedReturn = await this.calculateTWR(
      userId,
      holdingsAccountIds,
      defaultCurrency,
      rateCache,
    );

    // Calculate CAGR (Compound Annual Growth Rate)
    // CAGR = (Portfolio Value / Net Invested) ^ (1/years) - 1
    let cagr: number | null = null;
    if (
      totalNetInvested > 0 &&
      totalPortfolioValue > 0 &&
      allInvestmentAccountIds.length > 0
    ) {
      const earliestRow: { earliest: string }[] =
        await this.accountsRepository.query(
          `SELECT MIN(transaction_date) as earliest
         FROM investment_transactions
         WHERE user_id = $1
           AND account_id = ANY($2)
           AND transaction_date <= CURRENT_DATE`,
          [userId, allInvestmentAccountIds],
        );
      if (earliestRow[0]?.earliest) {
        const earliest = new Date(earliestRow[0].earliest);
        const now = new Date();
        const years =
          (now.getTime() - earliest.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
        if (years >= 1 / 365.25) {
          // At least 1 day of history
          cagr =
            (Math.pow(totalPortfolioValue / totalNetInvested, 1 / years) - 1) *
            100;
        }
      }
    }

    return {
      totalCashValue,
      totalHoldingsValue,
      totalCostBasis,
      totalNetInvested,
      totalPortfolioValue,
      totalGainLoss,
      totalGainLossPercent,
      timeWeightedReturn,
      cagr,
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
      if (currentPrice == null || previousPrice == null || previousPrice === 0)
        continue;

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
