import { Injectable, Logger } from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Holding } from "../securities/entities/holding.entity";
import { Security } from "../securities/entities/security.entity";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "../securities/entities/investment-transaction.entity";
import { NON_VOID_INVESTMENT_STATUS } from "../securities/investment-row-effects.util";
import {
  acquisitionCost,
  applyActionToQuantity,
  baseInvestmentAction,
  investedFlowKind,
  CASH_INCOME_ACTIONS,
  applyReturnOfCapital,
  returnOfCapitalAmount,
  INVESTMENT_REPLAY_ORDER,
  reinvestedIncomeAmount,
  isQuantityOnlyAction,
} from "../securities/investment-replay.util";
import { Account } from "../accounts/entities/account.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { InvestmentCellValue } from "./dto/execute-investment-report.dto";
import { roundToDecimals, sumMoney } from "../common/round.util";
import { daysBetween } from "../common/time-series/price-boundary.util";
import { FxAggregate } from "../common/fx-aggregate";
import { todayYMD } from "../common/date-utils";
import { addMonthsClamped } from "../common/recurrence";
import { resolveDailyPriceChange } from "../securities/daily-change.util";

/**
 * The rows of a holdings computation and how complete their conversion was.
 *
 * `fxComplete` and `missingPairs` travel with the rows because the rate gap is
 * not visible in them: an unresolvable pair leaves `exchangeRate` null on one
 * row and blanks `portfolioPercent` on *every* row, and nothing in the payload
 * said why. A consumer reads `fxComplete === false` and relabels the figures;
 * `missingPairs` names what to fix.
 *
 * A missing *price* withholds the same denominator by the same arithmetic and
 * is a different repair -- refresh the security's price, not the rate table --
 * so it is tracked separately: `pricesComplete` and `unpricedSymbols`. A
 * consumer that only read `fxComplete` showed a blank "% of portfolio" column
 * under no explanation at all whenever one holding had no close.
 */
export interface ComputedHoldings {
  rows: ComputedHolding[];
  /** False when any pair the rows needed could not be resolved. */
  fxComplete: boolean;
  /** `"SEK->USD"` for each unresolvable pair, in first-seen order. */
  missingPairs: string[];
  /** False when any held position had no price on or before the as-of date. */
  pricesComplete: boolean;
  /** The symbol of each such position, in first-seen order. */
  unpricedSymbols: string[];
}

/** One computed holding row plus the fields needed to group it. */
export interface ComputedHolding {
  accountId: string;
  accountName: string;
  securityId: string;
  symbol: string;
  securityName: string;
  currencyCode: string;
  /**
   * Rate to convert this holding's native monetary values to the base currency,
   * or `null` when no rate exists for the pair. `null` must not render as a
   * measured value, and the "% of portfolio" column it feeds is unknown too.
   */
  exchangeRate: number | null;
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
  /**
   * False once shares of unknown cost (ADD_SHARES / REMOVE_SHARES, an unpriced
   * acquisition) join the position, until it closes to zero.
   */
  basisKnown: boolean;
  /** False once a sale drew on an unknown basis: `realizedGains` is then a subtotal. */
  realizedKnown: boolean;
  lastTransactionDate: string | null;
}

interface GroupRecord {
  accountId: string;
  securityId: string;
  txs: InvestmentTransaction[];
  state: ReplayState;
}

function isoAddDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
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
  state.quantity = applyActionToQuantity(
    state.quantity,
    tx.action,
    Number(tx.quantity) || 0,
  );
}

/**
 * What an acquisition cost in the **security's** currency.
 *
 * Every monetary column this report produces is denominated in the holding's
 * own currency (see the class comment), so the row's `exchangeRate` -- which
 * converts into the settlement account's currency -- must not be applied here.
 * The commission still belongs in the basis: it is part of what was paid.
 */
function securityCurrencyAcquisitionCost(
  tx: InvestmentTransaction,
): number | null {
  return acquisitionCost({
    quantity: tx.quantity,
    price: tx.price,
    commission: tx.commission,
    totalAmount: tx.totalAmount,
  });
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
  private readonly logger = new Logger(InvestmentReportDataService.name);

  constructor(
    private dataSource: DataSource,
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
    const rows: { d: string | null }[] = await withScopedDb(
      this.dataSource,
      (m) =>
        m.query(
          `SELECT MAX(sp.price_date)::text AS d
         FROM security_prices sp
        WHERE sp.security_id IN (
          SELECT security_id FROM holdings WHERE account_id = ANY($1)
          UNION
          SELECT security_id FROM investment_transactions
            WHERE user_id = $2 AND account_id = ANY($1) AND security_id IS NOT NULL
              AND status != 'VOID'
        )`,
          [accountIds, userId],
        ),
    );
    return rows[0]?.d || today;
  }

  async computeHoldings(
    userId: string,
    accountIds: string[],
    asOfDate: string,
    baseCurrency: string,
    mergeAccounts = false,
  ): Promise<ComputedHoldings> {
    if (accountIds.length === 0)
      return {
        rows: [],
        fxComplete: true,
        missingPairs: [],
        pricesComplete: true,
        unpricedSymbols: [],
      };

    const accountMap = await this.loadAccounts(accountIds);

    // The maintained holdings table is the authoritative current snapshot.
    const holdings = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Holding).find({
        where: { accountId: In(accountIds) },
      }),
    );
    const holdingsMap = new Map<
      string,
      { quantity: number; averageCost: number }
    >();
    // Summed across accounts per security, for the merged (cross-account) view.
    const summedHoldings = new Map<
      string,
      { quantity: number; costBasis: number }
    >();
    for (const h of holdings) {
      const quantity = Number(h.quantity) || 0;
      const averageCost = Number(h.averageCost) || 0;
      holdingsMap.set(`${h.accountId}:${h.securityId}`, {
        quantity,
        averageCost,
      });
      const summed = summedHoldings.get(h.securityId) ?? {
        quantity: 0,
        costBasis: 0,
      };
      summed.quantity += quantity;
      summed.costBasis += quantity * averageCost;
      summedHoldings.set(h.securityId, summed);
    }

    // Replay transactions up to the as-of date, grouped by (account, security).
    const transactions = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(InvestmentTransaction).find({
        // Rows as effects: a VOID transaction moved no shares and no cost.
        where: {
          userId,
          accountId: In(accountIds),
          status: NON_VOID_INVESTMENT_STATUS,
        },
        order: INVESTMENT_REPLAY_ORDER,
      }),
    );
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

    const fxCache = new Map<string, number | null>();
    const year = Number(asOfDate.slice(0, 4));
    const periodStarts: Record<string, string> = {
      totalReturn1Week: isoAddDays(asOfDate, -7),
      totalReturn4Weeks: isoAddDays(asOfDate, -28),
      totalReturn3Month: addMonthsClamped(asOfDate, -3),
      totalReturn1Year: addMonthsClamped(asOfDate, -12),
      totalReturn3Year: addMonthsClamped(asOfDate, -36),
      totalReturnYtd: `${year - 1}-12-31`,
    };

    const computed: {
      holding: ComputedHolding;
      marketValueBase: number | null;
    }[] = [];
    // Held positions with no close on or before the as-of date. A Set keeps
    // first-seen order and does not repeat a symbol held in two accounts.
    const unpricedSymbols = new Set<string>();

    for (const group of groups.values()) {
      const security = securityMap.get(group.securityId);
      if (!security) continue;

      const prices = priceMap.get(group.securityId) ?? [];
      const asOfIdx = prices.length - 1; // prices already filtered to <= asOfDate
      const asOfRow = asOfIdx >= 0 ? prices[asOfIdx] : null;
      const prevRow = asOfIdx >= 1 ? prices[asOfIdx - 1] : null;

      const lastPrice = asOfRow ? asOfRow.close : null;
      // A daily move only between adjacent, current sessions; otherwise null.
      const daily =
        asOfRow && prevRow
          ? resolveDailyPriceChange(
              [
                { price: asOfRow.close, date: asOfRow.date },
                { price: prevRow.close, date: prevRow.date },
              ],
              asOfDate,
            )
          : null;
      const previousClose = prevRow ? prevRow.close : null;

      let quantity = roundToDecimals(group.state.quantity, 8);
      let costBasis = roundToDecimals(group.state.costBasis, 4);

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
          quantity = roundToDecimals(current.quantity, 8);
          costBasis = roundToDecimals(current.costBasis, 4);
        } else {
          const current = holdingsMap.get(
            `${group.accountId}:${group.securityId}`,
          );
          if (!current || Math.abs(current.quantity) < 0.0001) continue;
          quantity = roundToDecimals(current.quantity, 8);
          costBasis = roundToDecimals(
            current.quantity * current.averageCost,
            4,
          );
        }
      } else if (Math.abs(quantity) < 0.0001) {
        continue;
      }

      // Shares of unknown cost are in this position: the basis, and everything
      // measured against it, is unknown rather than the priced part alone.
      const knownBasis = group.state.basisKnown ? costBasis : null;
      const averageCost =
        knownBasis !== null && quantity !== 0
          ? roundToDecimals(knownBasis / quantity, 6)
          : null;
      const marketValue =
        lastPrice !== null ? roundToDecimals(quantity * lastPrice, 4) : null;
      const income = roundToDecimals(group.state.income, 4);
      const gain =
        marketValue !== null && knownBasis !== null
          ? roundToDecimals(marketValue + income - knownBasis, 4)
          : null;
      const priceAppreciation =
        marketValue !== null && knownBasis !== null
          ? roundToDecimals(marketValue - knownBasis, 4)
          : null;
      const gainPercent =
        gain !== null && knownBasis !== null && knownBasis > 0
          ? roundToDecimals((gain / knownBasis) * 100, 4)
          : null;
      const change = daily ? roundToDecimals(daily.dailyChange, 6) : null;
      const changePercent = daily
        ? roundToDecimals(daily.dailyChangePercent, 4)
        : null;
      const todaysTotalChange =
        change !== null ? roundToDecimals(change * quantity, 4) : null;

      const fxRate = await this.fxRate(
        security.currencyCode,
        baseCurrency,
        asOfDate,
        fxCache,
      );
      // Unknown rate makes the base-currency value unknown, not equal to the
      // native one.
      const marketValueBase =
        marketValue !== null && fxRate !== null ? marketValue * fxRate : null;

      // Recorded after the closed-position filters above, so a position the
      // report does not list cannot mark the report incomplete.
      if (lastPrice === null) unpricedSymbols.add(security.symbol);

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
        costBasis: knownBasis,
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
        commissions: roundToDecimals(group.state.commissions, 4),
        purchases: roundToDecimals(group.state.purchases, 4),
        sales: roundToDecimals(group.state.sales, 4),
        reinvestments: roundToDecimals(group.state.reinvestments, 4),
        // A sale drawn on shares of unknown cost has no gain; the column is
        // unknown, not the proceeds measured against the priced part.
        realizedGains: group.state.realizedKnown
          ? roundToDecimals(group.state.realizedGains, 4)
          : null,
        exchangeRate: fxRate === null ? null : roundToDecimals(fxRate, 6),
        lastUpdated: asOfRow?.date ?? null,
        fiftyTwoWeekHigh: high52,
        fiftyTwoWeekLow: low52,
        ...this.periodReturns(
          group,
          prices,
          asOfDate,
          periodStarts,
          marketValue,
          knownBasis,
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
    //
    // Through `FxAggregate`, so a holding whose rate or price is unknown
    // withholds the denominator instead of shrinking it: `?? 0` silently
    // divided by a partial sum, which inflated every other row's share of the
    // portfolio and wore a total's name while doing it.
    const portfolioValue = new FxAggregate();
    for (const c of computed) {
      if (c.marketValueBase === null) portfolioValue.addUnknown();
      else portfolioValue.addConverted(c.marketValueBase);
    }
    const totalBase = portfolioValue.total;
    for (const c of computed) {
      if (c.marketValueBase !== null && totalBase !== null && totalBase > 0) {
        c.holding.values.portfolioPercent = roundToDecimals(
          (c.marketValueBase / totalBase) * 100,
          4,
        );
      }
    }

    // The cache holds one entry per pair the rows actually needed, and a `null`
    // entry is a pair the door refused. Read here rather than tracked
    // separately so the report cannot report itself complete while a row's
    // conversion was refused.
    const missingPairs = [...fxCache.entries()]
      .filter(([, rate]) => rate === null)
      .map(([pair]) => pair);

    return {
      rows: computed.map((c) => c.holding),
      fxComplete: missingPairs.length === 0,
      missingPairs,
      pricesComplete: unpricedSymbols.size === 0,
      unpricedSymbols: [...unpricedSymbols],
    };
  }

  // ---------------------------------------------------------------------------

  private async loadAccounts(
    accountIds: string[],
  ): Promise<Map<string, string>> {
    const accounts = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).find({
        where: { id: In(accountIds) },
        select: ["id", "name"],
      }),
    );
    return new Map(accounts.map((a) => [a.id, a.name]));
  }

  private async loadSecurities(
    securityIds: string[],
  ): Promise<Map<string, Security>> {
    if (securityIds.length === 0) return new Map();
    const securities = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).find({
        where: { id: In(securityIds) },
      }),
    );
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
    }[] = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT security_id, price_date::text AS price_date,
              open_price, high_price, low_price, close_price, volume
         FROM security_prices
        WHERE security_id = ANY($1) AND price_date <= $2
        ORDER BY security_id, price_date ASC`,
        [securityIds, asOfDate],
      ),
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
        return (
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
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
      basisKnown: true,
      realizedKnown: true,
      lastTransactionDate: null,
    };
  }

  /** Apply one transaction to the cumulative state (native security currency). */
  private applyToState(state: ReplayState, tx: InvestmentTransaction): void {
    const quantity = Number(tx.quantity) || 0;
    const totalAmount = Number(tx.totalAmount) || 0;
    const commission = Number(tx.commission) || 0;
    state.commissions += commission;
    state.lastTransactionDate = tx.transactionDate;

    switch (baseInvestmentAction(tx.action)) {
      case InvestmentAction.BUY:
      case InvestmentAction.TRANSFER_IN:
      case InvestmentAction.REINVEST: {
        // The acquisition commission is part of the basis a later disposal is
        // measured against -- omitting it reported the commission as realized
        // gain in this report's gain columns too. `null` means the row cannot
        // say what it cost, and unknown is not free.
        const cost = securityCurrencyAcquisitionCost(tx);
        if (cost !== null) state.costBasis += cost;
        else state.basisKnown = false;
        state.quantity = applyActionToQuantity(
          state.quantity,
          tx.action,
          quantity,
        );
        if (tx.action === InvestmentAction.BUY) state.purchases += totalAmount;
        if (baseInvestmentAction(tx.action) === InvestmentAction.REINVEST) {
          // A reinvested distribution is income as surely as a cash one, so
          // `value + income - cost` nets the reinvestment to the distribution
          // it was. Not `totalAmount` alone: a reinvest created in the app
          // stores none, and is valued from its quantity and price.
          const distribution = reinvestedIncomeAmount(tx);
          if (distribution !== null) {
            state.reinvestments += distribution;
            state.income += distribution;
          }
        }
        break;
      }
      case InvestmentAction.SELL:
      case InvestmentAction.TRANSFER_OUT: {
        const sellQty = Math.min(quantity, Math.max(state.quantity, 0));
        const avgCost =
          state.quantity > 0 ? state.costBasis / state.quantity : 0;
        const costSold = sellQty * avgCost;
        state.costBasis -= costSold;
        // The whole sale comes off, as in the holdings rebuild (INV-HOLDING-002);
        // the part the position did not hold has no known cost.
        if (sellQty < quantity - 0.0001) state.basisKnown = false;
        state.quantity = applyActionToQuantity(
          state.quantity,
          tx.action,
          quantity,
        );
        // Base-normalized: a REDEEM realizes its proceeds like the sale it is.
        if (baseInvestmentAction(tx.action) === InvestmentAction.SELL) {
          state.sales += totalAmount;
          state.realizedGains += totalAmount - costSold;
          if (!state.basisKnown) state.realizedKnown = false;
        }
        break;
      }
      case InvestmentAction.DIVIDEND:
      case InvestmentAction.INTEREST:
      case InvestmentAction.CAPITAL_GAIN:
        state.income += totalAmount;
        break;
      case InvestmentAction.RETURN_OF_CAPITAL: {
        // Not income: it pays back cost, so it comes off the basis, and only
        // what the basis could not absorb is a realized gain.
        const amount = returnOfCapitalAmount({ totalAmount: tx.totalAmount });
        if (amount !== null) {
          const effect = applyReturnOfCapital(state.costBasis, amount);
          state.costBasis = effect.costBasis;
          state.realizedGains += effect.realizedGain;
          if (!state.basisKnown && effect.realizedGain > 0) {
            state.realizedKnown = false;
          }
        } else {
          state.basisKnown = false;
        }
        break;
      }
      default:
        // ADD_SHARES / REMOVE_SHARES move units with no cost in the ledger.
        if (isQuantityOnlyAction(tx.action) && quantity !== 0) {
          state.basisKnown = false;
        }
        state.quantity = applyActionToQuantity(
          state.quantity,
          tx.action,
          quantity,
        );
        break;
    }

    if (Math.abs(state.quantity) < 0.0001) {
      state.quantity = 0;
      state.costBasis = 0;
      state.basisKnown = true;
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
      high: high === null ? null : roundToDecimals(high, 6),
      low: low === null ? null : roundToDecimals(low, 6),
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

  /**
   * Cash distributions (dividends/interest/capital gains, and capital
   * returned) received in (after, upto].
   *
   * Cash only, unlike the Income column: a period return compares the market
   * value, which already holds any shares a reinvestment bought, against the
   * window's starting value, which holds none of their cost. Adding the
   * reinvested distribution as well would count it twice.
   *
   * A return of capital is not income, but it is in a total return: the price
   * falls by what was paid back, so leaving the cash out would read the
   * distribution as a loss.
   */
  private incomeBetween(
    group: GroupRecord,
    after: string,
    upto: string,
  ): number {
    let income = 0;
    for (const tx of group.txs) {
      if (tx.transactionDate <= after || tx.transactionDate > upto) continue;
      if (
        CASH_INCOME_ACTIONS.includes(tx.action) ||
        tx.action === InvestmentAction.RETURN_OF_CAPITAL
      ) {
        income += Number(tx.totalAmount) || 0;
      }
    }
    return income;
  }

  /**
   * The value that crossed the position's boundary in (after, upto]: shares
   * bought or moved in (`inflows`) and shares sold or moved out (`outflows`).
   * A return that ignores them reads a purchase as a gain and a sale as a loss.
   *
   * A BUY and a SELL are valued at what they cost and fetched; a transfer or a
   * share adjustment has no price of its own, so it is valued at the close on
   * its date. A REINVEST is left out on purpose: it spends income the position
   * earned, its shares are already in the market value, and counting it as a
   * deposit would hide that income (`incomeBetween`). A return of capital is a
   * cash distribution `incomeBetween` already counts.
   *
   * `weightedNet` is the Modified Dietz weighting of those flows: each is
   * weighted by the share of the window's days it was invested, counting its
   * own day (start-of-day convention: a flow on the window's first day weighs
   * 1, one on `upto` weighs 1/days), inflows positive and outflows negative
   * (`docs/specs/investment-report-period-returns.md`).
   *
   * `null` when a flow cannot be valued: a missing price is unknown, not free.
   */
  private flowsBetween(
    group: GroupRecord,
    prices: PriceRow[],
    after: string,
    upto: string,
  ): { inflows: number; outflows: number; weightedNet: number } | null {
    const inflows: number[] = [];
    const outflows: number[] = [];
    // `after < upto` for every window the report asks for, so windowDays > 0.
    const windowDays = daysBetween(after, upto);
    const weighted: number[] = [];
    for (const tx of group.txs) {
      if (tx.transactionDate <= after || tx.transactionDate > upto) continue;
      const base = baseInvestmentAction(tx.action);
      const kind = investedFlowKind(tx.action);
      if (
        base === InvestmentAction.REINVEST ||
        base === InvestmentAction.RETURN_OF_CAPITAL ||
        (kind !== "capitalIn" && kind !== "capitalOut")
      ) {
        continue;
      }
      let amount: number | null;
      if (base === InvestmentAction.BUY) {
        amount = securityCurrencyAcquisitionCost(tx);
      } else if (base === InvestmentAction.SELL) {
        const total = Number(tx.totalAmount);
        amount = Number.isFinite(total) && total > 0 ? total : null;
      } else {
        const price = this.priceOnOrBefore(prices, tx.transactionDate);
        amount = price === null ? null : (Number(tx.quantity) || 0) * price;
      }
      if (amount === null) return null;
      (kind === "capitalIn" ? inflows : outflows).push(amount);
      const weight = (daysBetween(tx.transactionDate, upto) + 1) / windowDays;
      weighted.push((kind === "capitalIn" ? amount : -amount) * weight);
    }
    return {
      inflows: sumMoney(inflows),
      outflows: sumMoney(outflows),
      weightedNet: sumMoney(weighted),
    };
  }

  /**
   * Compute the per-security total return columns by the Modified Dietz
   * method (`docs/specs/investment-report-period-returns.md`):
   *   (current value + income + sales - beginning value - purchases)
   *   / (beginning value + day-weighted purchases - day-weighted sales),
   * flows taken inside the window. Income stays out of the denominator.
   * "All dates" measures against cost basis (return since inception); the
   * annualized column annualizes that figure over the holding period.
   */
  private periodReturns(
    group: GroupRecord,
    prices: PriceRow[],
    asOfDate: string,
    periodStarts: Record<string, string>,
    marketValue: number | null,
    costBasis: number | null,
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
      const flows = this.flowsBetween(group, prices, start, asOfDate);
      // A flow that cannot be valued leaves the return unknown, not wrong.
      if (flows === null) continue;
      const denominator = beginValue + flows.weightedNet;
      if (denominator <= 0) continue;
      result[key] = roundToDecimals(
        ((marketValue + income + flows.outflows - beginValue - flows.inflows) /
          denominator) *
          100,
        4,
      );
    }

    // All-dates total return is measured against invested cost.
    if (marketValue !== null && costBasis !== null && costBasis > 0) {
      const allIncome = group.state.income;
      const allDates =
        ((marketValue + allIncome - costBasis) / costBasis) * 100;
      result.totalReturnAllDates = roundToDecimals(allDates, 4);

      const firstDate = group.txs[0]?.transactionDate;
      if (firstDate) {
        const years =
          (Date.parse(asOfDate) - Date.parse(firstDate)) /
          (365.25 * 24 * 60 * 60 * 1000);
        if (years >= 0.5) {
          const growth = 1 + allDates / 100;
          result.totalAnnualizedReturn =
            growth > 0
              ? roundToDecimals((Math.pow(growth, 1 / years) - 1) * 100, 4)
              : -100;
        }
      }
    }

    return result;
  }

  /**
   * The rate for a pair **on the report's as-of date**, or `null`.
   *
   * It used to call `getLatestRate` regardless of the date, so a report run
   * "as of" last March valued its holdings at today's rate and changed every
   * morning; and it returned 1 whenever either code was missing, which is a
   * base-currency column carrying a foreign number (issue #1390, INV-FX-001).
   * Rate 1 is returned only when the two codes are equal. The lookup goes
   * through `getRateForDate`, the one ladder, so this report and every other
   * surface quote one rate for one pair on one date.
   */
  private async fxRate(
    from: string,
    to: string,
    onDate: string,
    cache: Map<string, number | null>,
  ): Promise<number | null> {
    // A missing code is not a pair, so there is nothing to convert and nothing
    // to claim: unknown, never 1.
    if (!from || !to) return null;
    if (from === to) return 1;
    const key = `${from}->${to}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    // `fetchMissing: false`: running a report is a read. Fanning out to the
    // provider per unresolved pair made a GET write rate rows and, with no
    // negative cache on that path, repeat the fan-out on every refresh.
    const rate = await this.exchangeRateService.getRateForDate(
      from,
      to,
      onDate,
      { fetchMissing: false },
    );
    const usable = rate !== null && rate > 0 ? rate : null;
    if (usable === null) {
      this.logger.warn(
        `No exchange rate available for ${key} on or before ${onDate}; the affected base-currency figures are reported as unknown rather than converted 1:1`,
      );
    }
    cache.set(key, usable);
    return usable;
  }
}
