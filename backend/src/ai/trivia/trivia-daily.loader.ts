import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { addDaysYMD, getMonthEndYMD } from "../../common/date-utils";
import {
  convertingTotal,
  memoizedRateResolver,
} from "../../common/converting-total";
import { BuiltInReportsService } from "../../built-in-reports/built-in-reports.service";
import type { SpendingByPayeeResponse } from "../../built-in-reports/dto/spending-by-payee.dto";
import {
  PURCHASE_AMOUNT_SQL,
  PURCHASE_ROW_CONDITIONS_SQL,
} from "../../built-in-reports/purchase-rows-sql";
import { Budget } from "../../budgets/entities/budget.entity";
import {
  queryCategorySpending,
  resolveBudgetLineBudgeted,
  resolveCategorySpentOrNull,
} from "../../budgets/budget-spending.util";
import { getMonthPeriodDates } from "../../budgets/budget-date.utils";
import {
  effectiveLineBudget,
  loadExpenseRolloverIn,
} from "../../budgets/budget-rollover.util";
import { ExchangeRateService } from "../../currencies/exchange-rate.service";
import { ScheduledOccurrenceService } from "../../scheduled-transactions/scheduled-occurrence.service";
import { PortfolioService } from "../../securities/portfolio.service";
import { Transaction } from "../../transactions/entities/transaction.entity";
import { TransactionSplit } from "../../transactions/entities/transaction-split.entity";
import { isStreakLength, type TriviaDailyInput } from "./trivia-daily-facts";
import { asOfDay, dayIndex, seedHash } from "./trivia-windows";

export interface TriviaDailyOptions {
  /** Read the next seven days' bills (a cron does; a page load must stay cheap). */
  bills: boolean;
  /** The twelve-month payee report, which the "days since" payee is drawn from. */
  spendingByPayee: SpendingByPayeeResponse | null;
}

/** The payees "days since" may name: the reader's biggest few. */
const SINCE_PAYEE_CANDIDATES = 5;
const BILL_DAYS_AHEAD = 6;

/**
 * Reads what moves every day: the recent days' spending, the month so far,
 * the biggest purchase, streaks, the next bills, the budget's pace and the
 * top mover. Totals come from the reports and services a reader can open;
 * the SQL here reads only a date, a count or a single row. Each source fails
 * on its own: one that throws leaves out its facts and only those.
 */
@Injectable()
export class TriviaDailyLoader {
  private readonly logger = new Logger(TriviaDailyLoader.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly reports: BuiltInReportsService,
    private readonly occurrences: ScheduledOccurrenceService,
    private readonly exchangeRates: ExchangeRateService,
    private readonly portfolio: PortfolioService,
  ) {}

  async load(
    userId: string,
    currency: string,
    today: string,
    options: TriviaDailyOptions,
  ): Promise<TriviaDailyInput> {
    const asOf = asOfDay(today);
    const monthToDate = await this.attempt(userId, "month to date", () =>
      this.readMonthToDate(userId, today, asOf),
    );
    const lastDay = await this.attempt(userId, "last day", async () => ({
      date: asOf,
      spent: (await this.reports.getSpendingByCategory(userId, asOf, asOf))
        .totalSpending,
    }));
    const weekFrom = addDaysYMD(today, -7);
    const lastSevenDays = await this.attempt(userId, "last week", async () => ({
      from: weekFrom,
      spent: (await this.reports.getSpendingByCategory(userId, weekFrom, asOf))
        .totalSpending,
    }));
    const biggestPurchase = await this.attempt(userId, "purchases", () =>
      this.readBiggestPurchase(userId, currency, weekFrom, asOf),
    );
    const lastSpendDate = await this.attempt(userId, "last spend", () =>
      this.readLastSpendDate(userId, asOf, null),
    );
    const streakSpent = await this.attempt(userId, "streak", () =>
      this.readStreakSpent(userId, lastSpendDate, asOf),
    );
    const sincePayee = await this.attempt(userId, "payee recency", () =>
      this.readSincePayee(userId, today, asOf, options.spendingByPayee),
    );
    const bills = options.bills
      ? await this.attempt(userId, "bills", () =>
          this.readBills(userId, currency, today),
        )
      : null;
    const budget = await this.attempt(userId, "budget", () =>
      this.readBudget(userId, today),
    );
    const topMover = await this.attempt(
      userId,
      "top mover",
      async () => (await this.portfolio.getTopMovers(userId))[0] ?? null,
    );

    return {
      currency,
      today,
      monthToDate,
      lastDay,
      lastSevenDays,
      biggestPurchase,
      lastSpendDate,
      streakSpent,
      sincePayee,
      bills,
      budget,
      topMover,
    };
  }

  private async attempt<T>(
    userId: string,
    source: string,
    read: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.logger.warn(
        `Trivia could not read ${source} for user ${userId}: ${message}`,
      );
      return null;
    }
  }

  /**
   * This month's first day to `asOf`, against the last month's first day to
   * the same day of the month, clamped to that month's end.
   */
  private async readMonthToDate(
    userId: string,
    today: string,
    asOf: string,
  ): Promise<TriviaDailyInput["monthToDate"]> {
    // The 1st has no complete day of its own month yet.
    if (Number(today.slice(8, 10)) < 2) return null;
    const [year, month] = asOf.split("-").map(Number);
    const previousMonthEnd = getMonthEndYMD(
      month === 1 ? year - 1 : year,
      month === 1 ? 12 : month - 1,
    );
    const previousFrom = `${previousMonthEnd.slice(0, 7)}-01`;
    const previousTo = `${previousMonthEnd.slice(0, 7)}-${String(
      Math.min(Number(asOf.slice(8, 10)), Number(previousMonthEnd.slice(8))),
    ).padStart(2, "0")}`;
    const current = await this.reports.getSpendingByCategory(
      userId,
      `${asOf.slice(0, 7)}-01`,
      asOf,
    );
    const previous = await this.reports.getSpendingByCategory(
      userId,
      previousFrom,
      previousTo,
    );
    return {
      through: asOf,
      spent: current.totalSpending,
      previousSpent: previous.totalSpending,
    };
  }

  /**
   * The largest purchase of the window, and whether every purchase in it is in
   * the reporting currency: an amount in its own currency cannot be ranked
   * against another's.
   */
  private readBiggestPurchase(
    userId: string,
    currency: string,
    from: string,
    through: string,
  ): Promise<TriviaDailyInput["biggestPurchase"]> {
    return withScopedDb(this.dataSource, async (m) => {
      const rows: {
        amount: string;
        currency_code: string;
        payee: string | null;
        tx_date: string;
        foreign_rows: string;
      }[] = await m.query(
        `SELECT ABS(${PURCHASE_AMOUNT_SQL}) AS amount,
                t.currency_code,
                COALESCE(p.name, t.payee_name) AS payee,
                to_char(t.transaction_date, 'YYYY-MM-DD') AS tx_date,
                COUNT(*) FILTER (WHERE t.currency_code <> $4) OVER () AS foreign_rows
           FROM transactions t
           LEFT JOIN accounts a ON a.id = t.account_id
           LEFT JOIN payees p ON p.id = t.payee_id
          WHERE t.user_id = $1
            AND t.transaction_date >= $2
            AND t.transaction_date <= $3
            AND ${PURCHASE_ROW_CONDITIONS_SQL}
          ORDER BY amount DESC, t.transaction_date DESC, t.id DESC
          LIMIT 1`,
        [userId, from, through, currency],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        amount: Number(row.amount),
        currency: row.currency_code,
        payee: row.payee,
        date: row.tx_date,
        singleCurrency: Number(row.foreign_rows) === 0,
      };
    });
  }

  /** The newest purchase on or before `through`, optionally at one payee. */
  private readLastSpendDate(
    userId: string,
    through: string,
    payeeId: string | null,
  ): Promise<string | null> {
    return withScopedDb(this.dataSource, async (m) => {
      const rows: { last_date: string | null }[] = await m.query(
        `SELECT to_char(MAX(t.transaction_date), 'YYYY-MM-DD') AS last_date
           FROM transactions t
           LEFT JOIN accounts a ON a.id = t.account_id
          WHERE t.user_id = $1
            AND t.transaction_date <= $2
            AND ($3::uuid IS NULL OR t.payee_id = $3::uuid)
            AND ${PURCHASE_ROW_CONDITIONS_SQL}`,
        [userId, through, payeeId],
      );
      return rows[0]?.last_date ?? null;
    });
  }

  /**
   * What the spending report says was spent on the days after the last
   * purchase, to the last complete day. The streak is stated only when this is
   * zero, so it never sits beside "you spent X" on one of those days: the last
   * day and the week come from the same report. `null` when there is no streak
   * to check or the report could not say.
   */
  private async readStreakSpent(
    userId: string,
    lastSpendDate: string | null,
    asOf: string,
  ): Promise<number | null> {
    if (!lastSpendDate || !isStreakLength(lastSpendDate, asOf)) return null;
    const report = await this.reports.getSpendingByCategory(
      userId,
      addDaysYMD(lastSpendDate, 1),
      asOf,
    );
    return report.totalSpending;
  }

  /** One of the reader's top five payees, a different one most days. */
  private async readSincePayee(
    userId: string,
    today: string,
    asOf: string,
    byPayee: SpendingByPayeeResponse | null,
  ): Promise<TriviaDailyInput["sincePayee"]> {
    const candidates = (byPayee?.data ?? [])
      .filter((row) => row.payeeId !== null)
      .slice(0, SINCE_PAYEE_CANDIDATES);
    if (candidates.length === 0) return null;
    const pick =
      candidates[
        seedHash(userId, "sincePayee", String(dayIndex(today))) %
          candidates.length
      ];
    const lastDate = await this.readLastSpendDate(userId, asOf, pick.payeeId);
    return lastDate ? { name: pick.payeeName, lastDate } : null;
  }

  /**
   * The next seven days' outflows from `ScheduledOccurrenceService` (INV-
   * OCCURRENCE-003), never a schedule's own amount or due date.
   */
  private async readBills(
    userId: string,
    currency: string,
    today: string,
  ): Promise<TriviaDailyInput["bills"]> {
    const occurrences = await this.occurrences.findOccurrences(
      userId,
      { from: today, through: addDaysYMD(today, BILL_DAYS_AHEAD) },
      { outflowsOnly: true },
    );
    const { total } = await convertingTotal(
      occurrences.map((o) => ({
        amount: o.amount === null ? null : Math.abs(o.amount),
        currency: o.currencyCode,
      })),
      currency,
      memoizedRateResolver(this.exchangeRates, currency, today),
    );
    return { occurrences, total };
  }

  /**
   * The newest active budget, read as the dashboard summary reads it, over the
   * reader's calendar month. Its period helper reads the server's day in a
   * cron, so the month comes from `today`.
   */
  private readBudget(
    userId: string,
    today: string,
  ): Promise<TriviaDailyInput["budget"]> {
    const [year, month] = today.split("-").map(Number);
    const { periodStart, periodEnd } = getMonthPeriodDates(year, month - 1);
    return withScopedDb(this.dataSource, async (m) => {
      const budgets = await m.getRepository(Budget).find({
        where: { userId, isActive: true },
        relations: [
          "categories",
          "categories.category",
          "categories.category.parent",
          "categories.transferAccount",
        ],
        order: { createdAt: "DESC" },
        // Only the newest is read: the lines of the others are never used.
        take: 1,
      });
      const budget = budgets[0];
      if (!budget) return null;
      const spending = await queryCategorySpending(
        m.getRepository(Transaction),
        m.getRepository(TransactionSplit),
        userId,
        budget.categories,
        periodStart,
        periodEnd,
        budget.id,
      );
      const rollover = await loadExpenseRolloverIn(m, budget, periodStart);
      return {
        name: budget.name,
        currency: spending.currency,
        incomeLinked: budget.incomeLinked,
        lines: budget.categories
          .filter((line) => !line.isIncome)
          .map((line) => ({
            spent: resolveCategorySpentOrNull(line, spending),
            budgeted: effectiveLineBudget(
              resolveBudgetLineBudgeted(line, false, 0),
              rollover.get(line.id),
            ),
          })),
      };
    });
  }
}
