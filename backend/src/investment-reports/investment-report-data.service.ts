import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In } from "typeorm";
import { Holding } from "../securities/entities/holding.entity";
import { Security } from "../securities/entities/security.entity";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "../securities/entities/investment-transaction.entity";
import { Account } from "../accounts/entities/account.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { InvestmentCellValue } from "./dto/execute-investment-report.dto";
import { todayYMD } from "../common/date-utils";

/** One computed holding row plus the fields needed to group it. */
export interface ComputedHolding {
  accountId: string;
  accountName: string;
  securityId: string;
  symbol: string;
  securityName: string;
  currencyCode: string;
  /** Rate to convert this holding's native monetary values to the base currency. */
  exchangeRate: number;
  /** Every column key -> computed value (null when unavailable). */
  values: Record<string, InvestmentCellValue>;
}

interface PriceRow {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

interface ReplayState {
  quantity: number;
  costBasis: number;
  income: number;
  commissions: number;
  purchases: number;
  sales: number;
  reinvestments: number;
  realizedGains: number;
  lastTransactionDate: string | null;
}

interface GroupRecord {
  accountId: string;
  securityId: string;
  txs: InvestmentTransaction[];
  state: ReplayState;
}

function round(value: number, dp = 4): number {
  const f = Math.pow(10, dp);
  return Math.round(value * f) / f;
}

function isoAddDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function isoAddMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCMonth(dt.getUTCMonth() + months);
  return dt.toISOString().slice(0, 10);
}

function isoAddYears(iso: string, years: number): string {
  return isoAddMonths(iso, years * 12);
}

const SECURITY_TYPE_LABELS: Record<string, string> = {
  STOCK: "Stock",
  EQUITY: "Equity",
  ETF: "ETF",
  MUTUAL_FUND: "Mutual Fund",
  BOND: "Bond",
  OPTION: "Option",
  GIC: "GIC",
  CRYPTO: "Cryptocurrency",
  CASH: "Cash/Money Market",
  INDEX: "Index",
  OTHER: "Other",
};

/** Friendly display label for a raw security type (e.g. MUTUAL_FUND -> Mutual Fund). */
function formatSecurityType(raw: string | null): string {
  if (!raw) return "Stock";
  const known = SECURITY_TYPE_LABELS[raw.toUpperCase()];
  if (known) return known;
  return raw
    .split("_")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

/** Apply a transaction's quantity effect (used to reconstruct historical shares). */
function applyQuantity(
  state: { quantity: number },
  tx: InvestmentTransaction,
): void {
  const quantity = Number(tx.quantity) || 0;
  switch (tx.action) {
    case InvestmentAction.BUY:
    case InvestmentAction.REINVEST:
    case InvestmentAction.TRANSFER_IN:
    case InvestmentAction.ADD_SHARES:
      state.quantity += quantity;
      break;
    case InvestmentAction.SELL:
    case InvestmentAction.TRANSFER_OUT:
    case InvestmentAction.REMOVE_SHARES:
      state.quantity -= quantity;
      break;
    case InvestmentAction.SPLIT:
      if (quantity > 0) state.quantity *= quantity;
      break;
  }
}

/**
 * Computes the per-holding rows that back a custom investment report. Each row
 * represents one security held in one account, valued as of a requested date.
 * Positions and cost basis are reconstructed by replaying the user's
 * investment transactions (so any historical date works); prices come from the
 * stored daily OHLCV history. All monetary column values are denominated in the
 * holding's own (security) currency; only "% of portfolio" and "exchange rate"
 * use the base currency.
 */
@Injectable()
export class InvestmentReportDataService {
  constructor(
    @InjectRepository(InvestmentTransaction)
    private txRepository: Repository<InvestmentTransaction>,
    @InjectRepository(Holding)
    private holdingsRepository: Repository<Holding>,
    @InjectRepository(Security)
    private securitiesRepository: Repository<Security>,
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    private exchangeRateService: ExchangeRateService,
  ) {}

  /**
   * The latest day we hold any price for the given accounts' securities. Used
   * to default the report's as-of date to the last day the markets were open.
   * Falls back to today when there is no stored price history.
   */
  async getLatestMarketDay(
    userId: string,
    accountIds: string[],
  ): Promise<string> {
    // "Today" in the caller's timezone (RequestContext), not UTC -- otherwise
    // the default as-of date can land a day off near midnight in the user's
    // local time and replay the wrong set of transactions.
    const today = todayYMD();
    if (accountIds.length === 0) return today;
    const rows: { d: string | null }[] = await this.txRepository.query(
      `SELECT MAX(sp.price_date)::text AS d
         FROM security_prices sp
        WHERE sp.security_id IN (
          SELECT security_id FROM holdings WHERE account_id = ANY($1)
          UNION
          SELECT security_id FROM investment_transactions
            WHERE user_id = $2 AND account_id = ANY($1) AND security_id IS NOT NULL
        )`,
      [accountIds, userId],
    );
    return rows[0]?.d || today;
  }

  async computeHoldings(
    userId: string,
    accountIds: string[],
    asOfDate: string,
    baseCurrency: string,
    mergeAccounts = false,
  ): Promise<ComputedHolding[]> {
    if (accountIds.length === 0) return [];

    const accountMap = await this.loadAccounts(accountIds);

    // The maintained holdings table is the authoritative current snapshot.
    const holdings = await this.holdingsRepository.find({
      where: { accountId: In(accountIds) },
    });
    const holdingsMap = new Map<string, { quantity: number; averageCost: number }>();
    // Summed across accounts per security, for the merged (cross-account) view.
    const summedHoldings = new Map<string, { quantity: number; costBasis: number }>();
    for (const h of holdings) {
      const quantity = Number(h.quantity) || 0;
      const averageCost = Number(h.averageCost) || 0;
      holdingsMap.set(`${h.accountId}:${h.securityId}`, { quantity, averageCost });
      const summed = summedHoldings.get(h.securityId) ?? { quantity: 0, costBasis: 0 };
      summed.quantity += quantity;
      summed.costBasis += quantity * averageCost;
      summedHoldings.set(h.securityId, summed);
    }

    // Replay transactions up to the as-of date, grouped by (account, security).
    const transactions = await this.txRepository.find({
      where: { userId, accountId: In(accountIds) },
      order: { transactionDate: "ASC", createdAt: "ASC" },
    });
    let groups = this.groupTransactions(transactions, asOfDate);

    // Holdings without any transactions (e.g. imported positions) still belong
    // in the report; seed them so they are not dropped.
    this.seedTransactionlessHoldings(holdings, groups);

    // Optionally merge identical securities held across multiple accounts into a
    // single combined position (replaying their pooled transaction history).
    if (mergeAccounts) {
      groups = this.mergeGroupsBySecurity(groups, asOfDate);
    }

    const securityIds = [
      ...new Set([...groups.values()].map((g) => g.securityId)),
    ];
    const [securityMap, priceMap] = await Promise.all([
      this.loadSecurities(securityIds),
      this.loadPrices(securityIds, asOfDate),
    ]);

    const fxCache = new Map<string, number>();
    const year = Number(asOfDate.slice(0, 4));
    const periodStarts: Record<string, string> = {
      totalReturn1Week: isoAddDays(asOfDate, -7),
      totalReturn4Weeks: isoAddDays(asOfDate, -28),
      totalReturn3Month: isoAddMonths(asOfDate, -3),
      totalReturn1Year: isoAddYears(asOfDate, -1),
      totalReturn3Year: isoAddYears(asOfDate, -3),
      totalReturnYtd: `${year - 1}-12-31`,
    };

    const computed: {
      holding: ComputedHolding;
      marketValueBase: number | null;
    }[] = [];

    for (const group of groups.values()) {
      const security = securityMap.get(group.securityId);
      if (!security) continue;

      const prices = priceMap.get(group.securityId) ?? [];
      const asOfIdx = prices.length - 1; // prices already filtered to <= asOfDate
      const asOfRow = asOfIdx >= 0 ? prices[asOfIdx] : null;
      const prevRow = asOfIdx >= 1 ? prices[asOfIdx - 1] : null;

      const lastPrice = asOfRow ? asOfRow.close : null;
      const previousClose = prevRow ? prevRow.close : null;

      let quantity = round(group.state.quantity, 8);
      let costBasis = round(group.state.costBasis, 4);

      // When no transactions occur after the as-of date, the maintained
      // holdings table is the authoritative snapshot of this position. Defer to
      // it (matching the portfolio view): drop positions it reports as closed
      // (fully-sold/deactivated securities) and use its quantity and cost basis.
      const lastTxDate = group.txs.length
        ? group.txs[group.txs.length - 1].transactionDate
        : null;
      const reflectsPresent = !lastTxDate || lastTxDate <= asOfDate;
      if (reflectsPresent) {
        if (mergeAccounts) {
          const current = summedHoldings.get(group.securityId);
          if (!current || Math.abs(current.quantity) < 0.0001) continue;
          quantity = round(current.quantity, 8);
          costBasis = round(current.costBasis, 4);
        } else {
          const current = holdingsMap.get(`${group.accountId}:${group.securityId}`);
          if (!current || Math.abs(current.quantity) < 0.0001) continue;
          quantity = round(current.quantity, 8);
          costBasis = round(current.quantity * current.averageCost, 4);
        }
      } else if (Math.abs(quantity) < 0.0001) {
        continue;
      }

      const averageCost =
        quantity !== 0 ? round(costBasis / quantity, 6) : null;
      const marketValue =
        lastPrice !== null ? round(quantity * lastPrice, 4) : null;
      const income = round(group.state.income, 4);
      const gain =
        marketValue !== null
          ? round(marketValue + income - costBasis, 4)
          : null;
      const priceAppreciation =
        marketValue !== null ? round(marketValue - costBasis, 4) : null;
      const gainPercent =
        gain !== null && costBasis > 0
          ? round((gain / costBasis) * 100, 4)
          : null;
      const change =
        lastPrice !== null && previousClose !== null
          ? round(lastPrice - previousClose, 6)
          : null;
      const changePercent =
        change !== null && previousClose
          ? round((change / previousClose) * 100, 4)
          : null;
      const todaysTotalChange =
        change !== null ? round(change * quantity, 4) : null;

      const fxRate = await this.fxRate(
        security.currencyCode,
        baseCurrency,
        fxCache,
      );
      const marketValueBase =
        marketValue !== null ? marketValue * fxRate : null;

      const { high: high52, low: low52 } = this.fiftyTwoWeek(prices, asOfDate);

      const accountName = mergeAccounts
        ? "Multiple accounts"
        : (accountMap.get(group.accountId) ?? "Unknown");

      const values: Record<string, InvestmentCellValue> = {
        symbol: security.symbol,
        name: security.name,
        securityType: formatSecurityType(security.securityType),
        currency: security.currencyCode,
        account: accountName,
        quantity,
        averageCost,
        costBasis,
        lastPrice,
        marketValue,
        gain,
        gainPercent,
        priceAppreciation,
        portfolioPercent: null, // filled in second pass
        open: asOfRow?.open ?? null,
        dayHigh: asOfRow?.high ?? null,
        dayLow: asOfRow?.low ?? null,
        previousClose,
        change,
        changePercent,
        todaysTotalChange,
        volume: asOfRow?.volume ?? null,
        lastTransactionDate: group.state.lastTransactionDate,
        income,
        commissions: round(group.state.commissions, 4),
        purchases: round(group.state.purchases, 4),
        sales: round(group.state.sales, 4),
        reinvestments: round(group.state.reinvestments, 4),
        realizedGains: round(group.state.realizedGains, 4),
        exchangeRate: round(fxRate, 6),
        lastUpdated: asOfRow?.date ?? null,
        fiftyTwoWeekHigh: high52,
        fiftyTwoWeekLow: low52,
        ...this.periodReturns(
          group,
          prices,
          asOfDate,
          periodStarts,
          marketValue,
          costBasis,
        ),
      };

      computed.push({
        holding: {
          accountId: group.accountId,
          accountName,
          securityId: group.securityId,
          symbol: security.symbol,
          securityName: security.name,
          currencyCode: security.currencyCode,
          exchangeRate: fxRate,
          values,
        },
        marketValueBase,
      });
    }

    // Second pass: % of portfolio against total (base-currency) market value.
    const totalBase = computed.reduce(
      (sum, c) => sum + (c.marketValueBase ?? 0),
      0,
    );
    for (const c of computed) {
      if (c.marketValueBase !== null && totalBase > 0) {
        c.holding.values.portfolioPercent = round(
          (c.marketValueBase / totalBase) * 100,
          4,
        );
      }
    }

    return computed.map((c) => c.holding);
  }

  // ---------------------------------------------------------------------------

  private async loadAccounts(
    accountIds: string[],
  ): Promise<Map<string, string>> {
    const accounts = await this.accountsRepository.find({
      where: { id: In(accountIds) },
      select: ["id", "name"],
    });
    return new Map(accounts.map((a) => [a.id, a.name]));
  }

  private async loadSecurities(
    securityIds: string[],
  ): Promise<Map<string, Security>> {
    if (securityIds.length === 0) return new Map();
    const securities = await this.securitiesRepository.find({
      where: { id: In(securityIds) },
    });
    return new Map(securities.map((s) => [s.id, s]));
  }

  /**
   * Load OHLCV history (oldest first) for the given securities, limited to rows
   * on or before the as-of date so the last element is the as-of quote.
   */
  private async loadPrices(
    securityIds: string[],
    asOfDate: string,
  ): Promise<Map<string, PriceRow[]>> {
    const result = new Map<string, PriceRow[]>();
    if (securityIds.length === 0) return result;
    const rows: {
      security_id: string;
      price_date: string;
      open_price: string | null;
      high_price: string | null;
      low_price: string | null;
      close_price: string;
      volume: string | null;
    }[] = await this.txRepository.query(
      `SELECT security_id, price_date::text AS price_date,
              open_price, high_price, low_price, close_price, volume
         FROM security_prices
        WHERE security_id = ANY($1) AND price_date <= $2
        ORDER BY security_id, price_date ASC`,
      [securityIds, asOfDate],
    );
    for (const row of rows) {
      let arr = result.get(row.security_id);
      if (!arr) {
        arr = [];
        result.set(row.security_id, arr);
      }
      arr.push({
        date: row.price_date,
        open: row.open_price === null ? null : Number(row.open_price),
        high: row.high_price === null ? null : Number(row.high_price),
        low: row.low_price === null ? null : Number(row.low_price),
        close: Number(row.close_price),
        volume: row.volume === null ? null : Number(row.volume),
      });
    }
    return result;
  }

  private groupTransactions(
    transactions: InvestmentTransaction[],
    asOfDate: string,
  ): Map<string, GroupRecord> {
    const groups = new Map<string, GroupRecord>();
    for (const tx of transactions) {
      if (!tx.securityId) continue;
      const key = `${tx.accountId}:${tx.securityId}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          accountId: tx.accountId,
          securityId: tx.securityId,
          txs: [],
          state: this.emptyState(),
        };
        groups.set(key, group);
      }
      group.txs.push(tx);
      if (tx.transactionDate <= asOfDate) {
        this.applyToState(group.state, tx);
      }
    }
    return groups;
  }

  /**
   * Combine per-(account, security) groups into one group per security by
   * pooling their transactions and replaying the merged history. Used to show
   * a single combined position for a security held across multiple accounts.
   */
  private mergeGroupsBySecurity(
    groups: Map<string, GroupRecord>,
    asOfDate: string,
  ): Map<string, GroupRecord> {
    const merged = new Map<string, GroupRecord>();
    for (const g of groups.values()) {
      let m = merged.get(g.securityId);
      if (!m) {
        m = {
          accountId: "MERGED",
          securityId: g.securityId,
          txs: [],
          state: this.emptyState(),
        };
        merged.set(g.securityId, m);
      }
      m.txs.push(...g.txs);
    }
    for (const m of merged.values()) {
      m.txs.sort((a, b) => {
        if (a.transactionDate !== b.transactionDate) {
          return a.transactionDate < b.transactionDate ? -1 : 1;
        }
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
      for (const tx of m.txs) {
        if (tx.transactionDate <= asOfDate) this.applyToState(m.state, tx);
      }
    }
    return merged;
  }

  private emptyState(): ReplayState {
    return {
      quantity: 0,
      costBasis: 0,
      income: 0,
      commissions: 0,
      purchases: 0,
      sales: 0,
      reinvestments: 0,
      realizedGains: 0,
      lastTransactionDate: null,
    };
  }

  /** Apply one transaction to the cumulative state (native security currency). */
  private applyToState(state: ReplayState, tx: InvestmentTransaction): void {
    const quantity = Number(tx.quantity) || 0;
    const price = Number(tx.price) || 0;
    const totalAmount = Number(tx.totalAmount) || 0;
    const commission = Number(tx.commission) || 0;
    state.commissions += commission;
    state.lastTransactionDate = tx.transactionDate;

    switch (tx.action) {
      case InvestmentAction.BUY:
      case InvestmentAction.TRANSFER_IN:
        state.costBasis += quantity * price;
        state.quantity += quantity;
        if (tx.action === InvestmentAction.BUY) state.purchases += totalAmount;
        break;
      case InvestmentAction.REINVEST:
        state.costBasis += quantity * price;
        state.quantity += quantity;
        state.reinvestments += totalAmount;
        break;
      case InvestmentAction.SELL:
      case InvestmentAction.TRANSFER_OUT: {
        const sellQty = Math.min(quantity, state.quantity);
        const avgCost =
          state.quantity > 0 ? state.costBasis / state.quantity : 0;
        const costSold = sellQty * avgCost;
        state.costBasis -= costSold;
        state.quantity -= sellQty;
        if (tx.action === InvestmentAction.SELL) {
          state.sales += totalAmount;
          state.realizedGains += totalAmount - costSold;
        }
        break;
      }
      case InvestmentAction.DIVIDEND:
      case InvestmentAction.INTEREST:
      case InvestmentAction.CAPITAL_GAIN:
        state.income += totalAmount;
        break;
      case InvestmentAction.ADD_SHARES:
        state.quantity += quantity;
        break;
      case InvestmentAction.REMOVE_SHARES:
        state.quantity -= quantity;
        break;
      case InvestmentAction.SPLIT:
        if (quantity > 0) state.quantity *= quantity;
        break;
    }

    if (Math.abs(state.quantity) < 0.0001) {
      state.quantity = 0;
      state.costBasis = 0;
    }
  }

  /**
   * Add synthetic groups for holdings that have no investment transactions so
   * imported positions still appear (valued at their stored average cost).
   */
  private seedTransactionlessHoldings(
    holdings: Holding[],
    groups: Map<string, GroupRecord>,
  ): void {
    for (const h of holdings) {
      const key = `${h.accountId}:${h.securityId}`;
      if (groups.has(key)) continue;
      const quantity = Number(h.quantity) || 0;
      if (Math.abs(quantity) < 0.0001) continue;
      const averageCost = Number(h.averageCost) || 0;
      const state = this.emptyState();
      state.quantity = quantity;
      state.costBasis = quantity * averageCost;
      groups.set(key, {
        accountId: h.accountId,
        securityId: h.securityId,
        txs: [],
        state,
      });
    }
  }

  /** Highest day-high / lowest day-low over the trailing 52 weeks of stored prices. */
  private fiftyTwoWeek(
    prices: PriceRow[],
    asOfDate: string,
  ): { high: number | null; low: number | null } {
    const start = isoAddDays(asOfDate, -364);
    let high: number | null = null;
    let low: number | null = null;
    for (const p of prices) {
      if (p.date < start) continue;
      const h = p.high ?? p.close;
      const l = p.low ?? p.close;
      if (high === null || h > high) high = h;
      if (low === null || l < low) low = l;
    }
    return {
      high: high === null ? null : round(high, 6),
      low: low === null ? null : round(low, 6),
    };
  }

  /** Close price on or before a date (binary search over the ascending series). */
  private priceOnOrBefore(prices: PriceRow[], date: string): number | null {
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
    return best >= 0 ? prices[best].close : null;
  }

  /** Shares held as of a date, reconstructed from the group's transactions. */
  private quantityAsOf(group: GroupRecord, date: string): number {
    const s = { quantity: 0 };
    for (const tx of group.txs) {
      if (tx.transactionDate > date) break;
      applyQuantity(s, tx);
    }
    return s.quantity;
  }

  /** Income (dividends/interest/capital gains) received in (after, upto]. */
  private incomeBetween(
    group: GroupRecord,
    after: string,
    upto: string,
  ): number {
    let income = 0;
    for (const tx of group.txs) {
      if (tx.transactionDate <= after || tx.transactionDate > upto) continue;
      if (
        tx.action === InvestmentAction.DIVIDEND ||
        tx.action === InvestmentAction.INTEREST ||
        tx.action === InvestmentAction.CAPITAL_GAIN
      ) {
        income += Number(tx.totalAmount) || 0;
      }
    }
    return income;
  }

  /**
   * Compute the MS Money-style total return columns:
   *   (current value + income in period - beginning value) / beginning value.
   * "All dates" measures against cost basis (return since inception); the
   * annualized column annualizes that figure over the holding period.
   */
  private periodReturns(
    group: GroupRecord,
    prices: PriceRow[],
    asOfDate: string,
    periodStarts: Record<string, string>,
    marketValue: number | null,
    costBasis: number,
  ): Record<string, number | null> {
    const result: Record<string, number | null> = {
      totalReturn1Week: null,
      totalReturn4Weeks: null,
      totalReturn3Month: null,
      totalReturn1Year: null,
      totalReturn3Year: null,
      totalReturnYtd: null,
      totalReturnAllDates: null,
      totalAnnualizedReturn: null,
    };

    for (const [key, start] of Object.entries(periodStarts)) {
      if (marketValue === null) continue;
      const beginQty = this.quantityAsOf(group, start);
      const beginPrice = this.priceOnOrBefore(prices, start);
      if (beginPrice === null || beginQty === 0) continue;
      const beginValue = beginQty * beginPrice;
      if (beginValue <= 0) continue;
      const income = this.incomeBetween(group, start, asOfDate);
      result[key] = round(
        ((marketValue + income - beginValue) / beginValue) * 100,
        4,
      );
    }

    // All-dates total return is measured against invested cost.
    if (marketValue !== null && costBasis > 0) {
      const allIncome = group.state.income;
      const allDates =
        ((marketValue + allIncome - costBasis) / costBasis) * 100;
      result.totalReturnAllDates = round(allDates, 4);

      const firstDate = group.txs[0]?.transactionDate;
      if (firstDate) {
        const years =
          (Date.parse(asOfDate) - Date.parse(firstDate)) /
          (365.25 * 24 * 60 * 60 * 1000);
        if (years >= 0.5) {
          const growth = 1 + allDates / 100;
          result.totalAnnualizedReturn =
            growth > 0
              ? round((Math.pow(growth, 1 / years) - 1) * 100, 4)
              : -100;
        }
      }
    }

    return result;
  }

  private async fxRate(
    from: string,
    to: string,
    cache: Map<string, number>,
  ): Promise<number> {
    if (!from || !to || from === to) return 1;
    const key = `${from}->${to}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let rate = await this.exchangeRateService.getLatestRate(from, to);
    if (rate === null) {
      const reverse = await this.exchangeRateService.getLatestRate(to, from);
      rate = reverse !== null ? 1 / reverse : 1;
    }
    cache.set(key, rate);
    return rate;
  }
}
