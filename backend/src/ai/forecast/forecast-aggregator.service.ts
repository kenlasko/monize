import { Injectable, Inject, Logger, forwardRef } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import {
  investmentLinkedTransactionExclusion,
  reportableTransactionAmountSql,
} from "../../common/investment-filter.util";
import { Transaction } from "../../transactions/entities/transaction.entity";
import { ScheduledTransaction } from "../../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledOccurrenceService } from "../../scheduled-transactions/scheduled-occurrence.service";
import { addDaysYMD, todayYMD } from "../../common/date-utils";
import { roundMoney } from "../../common/round.util";
import { AccountsService } from "../../accounts/accounts.service";
import { TransactionAnalyticsService } from "../../transactions/transaction-analytics.service";
import { RecurringCharge } from "../../transactions/recurring-charges.util";
import { FxAggregate } from "../../common/fx-aggregate";
import {
  buildRateIndex,
  convertAtDate,
  RateIndex,
} from "../../common/time-series/rate-index.util";

export interface MonthlyHistoryEntry {
  month: string;
  totalIncome: number;
  totalExpenses: number;
  netCashFlow: number;
  categoryBreakdown: Array<{
    categoryName: string;
    total: number;
    isIncome: boolean;
  }>;
}

export interface AccountBalanceSummary {
  /**
   * Every balance converted into the reporting currency, or `null` when any
   * account's currency has no rate; `knownBalanceSubtotal` is then the part
   * that converted and `missingRatePairs` names what is missing.
   */
  totalBalance: number | null;
  knownBalanceSubtotal: number;
  missingRatePairs: string[];
  accounts: Array<{
    name: string;
    accountType: string;
    balance: number;
    currencyCode: string;
  }>;
}

/**
 * One scheduled schedule as the forecast prompt describes it. `amount` is the
 * effective amount -- what the occurrence would post today -- as a positive
 * magnitude, and `null` when the server could not determine it (issue #1247):
 * the prompt must say "unknown" rather than quote a snapshot taken at an older
 * exchange rate.
 */
export interface ScheduledTransactionSummary {
  name: string;
  amount: number | null;
  amountComplete: boolean;
  frequency: string;
  nextDueDate: string;
  categoryName: string | null;
  /**
   * `null` when the occurrence's direction cannot be derived: an unpriceable
   * mixed-sign split can post on either side of zero, so the prompt must say so
   * rather than let the model treat a guess as a classification.
   */
  isIncome: boolean | null;
  isTransfer: boolean;
}

export interface IncomePatterns {
  monthlyIncome: Array<{
    month: string;
    total: number;
    sourceCount: number;
  }>;
  averageMonthlyIncome: number;
  incomeVariability: number;
}

export interface ForecastAggregates {
  currency: string;
  monthlyHistory: MonthlyHistoryEntry[];
  accountBalances: AccountBalanceSummary;
  scheduledTransactions: ScheduledTransactionSummary[];
  incomePatterns: IncomePatterns;
  recurringCharges: RecurringCharge[];
  today: string;
  /**
   * False when a currency had no rate: the history and income figures then
   * leave that part out. Read as `=== false`; the pairs are named beside it.
   */
  fxComplete: boolean;
  missingRatePairs: string[];
}

export { RecurringCharge };

/**
 * The forecast trains on one row per payment and joins no splits, so a split
 * parent's own amount -- the sum of every line, an embedded investment line
 * included -- is not what the household spent. A -60 grocery split beside a -500
 * embedded BUY taught the baseline 560 of monthly spending (re-audit).
 */
const REPORTABLE_TX_AMOUNT = reportableTransactionAmountSql("t");

/**
 * How far ahead the forecast summary looks for each schedule's next occurrence.
 *
 * Not a product window: the summary describes every active schedule, and each
 * contributes exactly one occurrence. Ten years is long enough that only a
 * schedule which has genuinely run out of occurrences yields none.
 *
 * It is emphatically NOT what bounds the walk -- 3,650 daily steps is past
 * `OCCURRENCE_WALK_GUARD`, so for a while the runaway backstop was quietly doing
 * the bounding here. The expander stops as soon as no unwalked slot can change
 * the answer, which for `maxOccurrences: 1` is one step past the first
 * occurrence.
 */
const FORECAST_OCCURRENCE_HORIZON_DAYS = 3650;

@Injectable()
export class ForecastAggregatorService {
  private readonly logger = new Logger(ForecastAggregatorService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => AccountsService))
    private readonly accountsService: AccountsService,
    private readonly transactionAnalytics: TransactionAnalyticsService,
    // The date and the amount a forecast prompt quotes are the occurrence's own,
    // from the one server-side occurrence contract (issue #1247).
    @Inject(forwardRef(() => ScheduledOccurrenceService))
    private readonly occurrences: ScheduledOccurrenceService,
  ) {}

  async computeAggregates(
    userId: string,
    currency: string,
  ): Promise<ForecastAggregates> {
    const now = new Date();
    const today = now.toISOString().substring(0, 10);
    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 12, 1)
      .toISOString()
      .substring(0, 10);

    const [
      history,
      accountBalances,
      scheduledTransactions,
      income,
      recurringCharges,
    ] = await Promise.all([
      this.getMonthlyHistory(userId, twelveMonthsAgo, today, currency),
      this.getAccountBalances(userId, currency, today),
      this.getActiveScheduledTransactions(userId),
      this.getIncomePatterns(userId, twelveMonthsAgo, today, currency),
      this.transactionAnalytics.getRecurringCharges(
        userId,
        twelveMonthsAgo,
        today,
        { uncategorizedLabel: "Uncategorized" },
      ),
    ]);

    const missingRatePairs = [
      ...new Set([
        ...history.missingPairs,
        ...income.missingPairs,
        ...accountBalances.missingRatePairs,
      ]),
    ].sort();

    return {
      currency,
      monthlyHistory: history.entries,
      accountBalances,
      scheduledTransactions,
      incomePatterns: income.patterns,
      recurringCharges,
      today,
      fxComplete: missingRatePairs.length === 0,
      missingRatePairs,
    };
  }

  /** Rates for every foreign currency in `currencies`, loaded in one read. */
  private async loadRateIndex(
    currencies: Iterable<string>,
    currency: string,
    startDate: string,
    endDate: string,
  ): Promise<RateIndex> {
    const foreign = new Set([...currencies].filter((c) => c !== currency));
    if (foreign.size === 0) return new Map();
    return withScopedDb(this.dataSource, (manager) =>
      buildRateIndex(
        (sql, params) => manager.query(sql, params),
        foreign,
        currency,
        startDate,
        endDate,
      ),
    );
  }

  /** Last day of a `YYYY-MM` month; the resolver clamps a future date to today. */
  private monthEnd(month: string): string {
    const [y, m] = month.split("-").map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().substring(0, 10);
  }

  /** Add `amount` to `agg` in `currency`; a missing rate is recorded, never 1. */
  private addConverted(
    agg: FxAggregate,
    amount: number,
    from: string,
    currency: string,
    date: string,
    rateIndex: RateIndex,
  ): void {
    if (from === currency || amount === 0) {
      agg.addConverted(amount);
      return;
    }
    agg.add(
      convertAtDate(amount, from, currency, date, rateIndex),
      from,
      currency,
    );
  }

  private async getMonthlyHistory(
    userId: string,
    startDate: string,
    endDate: string,
    currency: string,
  ): Promise<{ entries: MonthlyHistoryEntry[]; missingPairs: string[] }> {
    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .leftJoin("t.category", "cat")
        .select("TO_CHAR(t.transactionDate, 'YYYY-MM')", "month")
        .addSelect("cat.id", "categoryId")
        .addSelect("COALESCE(cat.name, 'Uncategorized')", "categoryName")
        .addSelect("COALESCE(cat.isIncome, false)", "isIncome")
        .addSelect("(cat.id IS NULL)", "uncategorized")
        .addSelect("t.currencyCode", "currencyCode")
        .addSelect(
          `SUM(CASE WHEN ${REPORTABLE_TX_AMOUNT} > 0 THEN ${REPORTABLE_TX_AMOUNT} ELSE 0 END)`,
          "income",
        )
        .addSelect(
          `SUM(CASE WHEN ${REPORTABLE_TX_AMOUNT} < 0 THEN ABS(${REPORTABLE_TX_AMOUNT}) ELSE 0 END)`,
          "expenses",
        )
        .where("t.userId = :userId", { userId })
        .andWhere("t.transactionDate >= :startDate", { startDate })
        .andWhere("t.transactionDate <= :endDate", { endDate })
        .andWhere("t.status != 'VOID'")
        .andWhere("t.isTransfer = false")
        .andWhere("t.parentTransactionId IS NULL")
        // Exclude investment-linked cash transactions so BUY/SELL/DIVIDEND
        // side-effects don't skew the historical income/expense baseline
        // used to train the forecast.
        .andWhere(investmentLinkedTransactionExclusion("t"))
        .groupBy("TO_CHAR(t.transactionDate, 'YYYY-MM')")
        .addGroupBy("cat.id")
        .addGroupBy("cat.name")
        .addGroupBy("cat.isIncome")
        .addGroupBy("t.currencyCode")
        .orderBy("month", "ASC")
        .getRawMany(),
    );

    const rateIndex = await this.loadRateIndex(
      rows.map((r) => r.currencyCode ?? currency),
      currency,
      startDate,
      endDate,
    );

    // One signed figure per (month, category), converted per row at the rate
    // for the month: a refund nets against the spending it reverses instead of
    // counting as income. An uncategorized row has no side to net within, so
    // its credits and debits stay on their own sides.
    const monthMap = new Map<
      string,
      {
        income: FxAggregate;
        expenses: FxAggregate;
        categories: Map<
          string,
          { categoryName: string; isIncome: boolean; net: FxAggregate }
        >;
      }
    >();
    const missing = new Set<string>();

    for (const row of rows) {
      const entry = monthMap.get(row.month) ?? {
        income: new FxAggregate(),
        expenses: new FxAggregate(),
        categories: new Map(),
      };
      monthMap.set(row.month, entry);
      const from: string = row.currencyCode ?? currency;
      const date = this.monthEnd(row.month);
      const income = Number(row.income) || 0;
      const expenses = Number(row.expenses) || 0;
      const isIncome = row.isIncome === true || row.isIncome === "true";
      const uncategorized =
        row.uncategorized === true || row.uncategorized === "true";

      // The query groups by cat.id, so the id is the key (NULL is its own
      // bucket): two categories sharing a name, or a real one named
      // "Uncategorized", must not merge.
      const key: string = row.categoryId ?? "uncategorized";
      const cat = entry.categories.get(key) ?? {
        categoryName: row.categoryName,
        isIncome,
        net: new FxAggregate(),
      };
      entry.categories.set(key, cat);
      if (uncategorized) {
        this.addConverted(
          entry.income,
          income,
          from,
          currency,
          date,
          rateIndex,
        );
        this.addConverted(cat.net, -expenses, from, currency, date, rateIndex);
      } else {
        this.addConverted(
          cat.net,
          income - expenses,
          from,
          currency,
          date,
          rateIndex,
        );
      }
    }

    const entries = Array.from(monthMap.entries()).map(([month, data]) => {
      const breakdown: MonthlyHistoryEntry["categoryBreakdown"] = [];
      for (const cat of data.categories.values()) {
        for (const pair of cat.net.missingPairs) missing.add(pair);
        const net = cat.net.knownSubtotal;
        if (cat.isIncome) data.income.addConverted(net);
        else data.expenses.addConverted(-net);
        const total = cat.isIncome ? net : -net;
        if (total > 0) {
          breakdown.push({
            categoryName: cat.categoryName,
            total,
            isIncome: cat.isIncome,
          });
        }
      }
      for (const pair of data.income.missingPairs) missing.add(pair);
      for (const pair of data.expenses.missingPairs) missing.add(pair);
      const totalIncome = data.income.knownSubtotal;
      const totalExpenses = data.expenses.knownSubtotal;
      return {
        month,
        totalIncome,
        totalExpenses,
        netCashFlow: roundMoney(totalIncome - totalExpenses),
        categoryBreakdown: breakdown.sort((a, b) => b.total - a.total),
      };
    });

    return { entries, missingPairs: [...missing].sort() };
  }

  private async getAccountBalances(
    userId: string,
    currency: string,
    today: string,
  ): Promise<AccountBalanceSummary> {
    const accounts = await this.accountsService.findAll(userId, false);

    const accountList = accounts.map((a) => ({
      name: a.name,
      accountType: a.accountType,
      balance: Number(a.currentBalance),
      currencyCode: a.currencyCode,
    }));

    // Balances are summed in the reporting currency at today's rate, never as
    // raw numbers of different currencies.
    const rateIndex = await this.loadRateIndex(
      accountList.map((a) => a.currencyCode),
      currency,
      today,
      today,
    );
    const total = new FxAggregate();
    for (const a of accountList) {
      this.addConverted(
        total,
        a.balance,
        a.currencyCode,
        currency,
        today,
        rateIndex,
      );
    }

    return {
      totalBalance: total.total,
      knownBalanceSubtotal: total.knownSubtotal,
      missingRatePairs: total.missingPairs,
      accounts: accountList,
    };
  }

  private async getActiveScheduledTransactions(
    userId: string,
  ): Promise<ScheduledTransactionSummary[]> {
    const scheduled = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(ScheduledTransaction).find({
        where: { userId, isActive: true },
        // `splits` decides whether the cash total re-prices at the current FX
        // rate, which the effective-amount resolver needs (issue #1247).
        relations: ["category", "splits"],
        order: { nextDueDate: "ASC" },
      }),
    );
    // The NEXT occurrence of each schedule, with the date and amount it will
    // actually post -- an occurrence the user re-priced or moved is what the
    // model should be forecasting from, not the template it came from.
    // The horizon is wide rather than a product window: every active schedule
    // belongs in this summary, and asking for one occurrence costs one step past
    // it (see FORECAST_OCCURRENCE_HORIZON_DAYS).
    const occurrences = await this.occurrences.expand(userId, scheduled, {
      through: addDaysYMD(todayYMD(), FORECAST_OCCURRENCE_HORIZON_DAYS),
      maxOccurrences: 1,
    });

    return occurrences.map((occurrence) => {
      const st = occurrence.schedule;
      // Both halves come from the occurrence. The category is an independent
      // semantic and still wins where it is set; the sign is the occurrence's
      // (`directionAmount`), because a mixed-sign split parent's effective
      // amount can land on the other side of zero from its stored snapshot --
      // "an FX rate is positive, so it cannot flip a sign" holds for one scalar
      // times one rate, not for a parent whose investment line alone re-prices.
      // The category is an independent semantic and still wins where it is set.
      // Otherwise the occurrence's own direction decides -- and `null` there is
      // "not derivable", which travels to the prompt rather than collapsing to
      // "expense".
      const isIncome =
        st.category?.isIncome === true
          ? true
          : occurrence.directionAmount === null
            ? null
            : occurrence.directionAmount > 0;

      return {
        name: st.name,
        amount: occurrence.amount === null ? null : Math.abs(occurrence.amount),
        amountComplete: occurrence.amount !== null,
        frequency: st.frequency,
        nextDueDate: occurrence.dueDate,
        categoryName: st.category?.name || null,
        isIncome,
        isTransfer: st.isTransfer,
      };
    });
  }

  private async getIncomePatterns(
    userId: string,
    startDate: string,
    endDate: string,
    currency: string,
  ): Promise<{ patterns: IncomePatterns; missingPairs: string[] }> {
    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .select("TO_CHAR(t.transactionDate, 'YYYY-MM')", "month")
        .addSelect("t.currencyCode", "currencyCode")
        .addSelect(`SUM(${REPORTABLE_TX_AMOUNT})`, "total")
        .addSelect("COUNT(DISTINCT t.payeeName)", "sourceCount")
        .where("t.userId = :userId", { userId })
        .andWhere("t.transactionDate >= :startDate", { startDate })
        .andWhere("t.transactionDate <= :endDate", { endDate })
        .andWhere(`${REPORTABLE_TX_AMOUNT} > 0`)
        .andWhere("t.status != 'VOID'")
        .andWhere("t.isTransfer = false")
        .andWhere("t.parentTransactionId IS NULL")
        // Exclude investment-linked cash credits (SELL / DIVIDEND) so
        // they don't inflate the income baseline.
        .andWhere(investmentLinkedTransactionExclusion("t"))
        .groupBy("TO_CHAR(t.transactionDate, 'YYYY-MM')")
        .addGroupBy("t.currencyCode")
        .orderBy("month", "ASC")
        .getRawMany(),
    );

    const rateIndex = await this.loadRateIndex(
      rows.map((r) => r.currencyCode ?? currency),
      currency,
      startDate,
      endDate,
    );
    // One converted figure per month; a payee paid in two currencies counts
    // once per currency.
    const byMonth = new Map<
      string,
      { total: FxAggregate; sourceCount: number }
    >();
    for (const r of rows) {
      const m = byMonth.get(r.month) ?? {
        total: new FxAggregate(),
        sourceCount: 0,
      };
      byMonth.set(r.month, m);
      this.addConverted(
        m.total,
        Number(r.total) || 0,
        r.currencyCode ?? currency,
        currency,
        this.monthEnd(r.month),
        rateIndex,
      );
      m.sourceCount += Number(r.sourceCount) || 0;
    }
    const missing = new Set<string>();
    const monthlyIncome = [...byMonth.entries()].map(([month, m]) => {
      for (const pair of m.total.missingPairs) missing.add(pair);
      return {
        month,
        total: m.total.knownSubtotal,
        sourceCount: m.sourceCount,
      };
    });

    const totals = monthlyIncome.map((m) => m.total);
    const averageMonthlyIncome =
      totals.length > 0
        ? totals.reduce((sum, t) => sum + t, 0) / totals.length
        : 0;

    let incomeVariability = 0;
    if (totals.length > 1 && averageMonthlyIncome > 0) {
      const variance =
        totals.reduce(
          (sum, t) => sum + Math.pow(t - averageMonthlyIncome, 2),
          0,
        ) / totals.length;
      incomeVariability = Math.sqrt(variance) / averageMonthlyIncome;
    }

    return {
      patterns: { monthlyIncome, averageMonthlyIncome, incomeVariability },
      missingPairs: [...missing].sort(),
    };
  }
}
