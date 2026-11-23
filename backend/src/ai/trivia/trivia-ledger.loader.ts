import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { allWithConcurrency } from "../../common/concurrency.util";
import { withScopedDb } from "../../common/db/scoped-db";
import { BuiltInReportsService } from "../../built-in-reports/built-in-reports.service";
import { warrantyStatusBounds } from "../../warranties/warranty-status.util";
import { triviaWindow } from "./trivia-windows";
import {
  readWindowedReports,
  type TriviaPicks,
  type TriviaWindowedReads,
} from "./trivia-windowed-reads";
import type {
  TriviaLedgerInput,
  TriviaRecordCounts,
  TriviaWarranties,
} from "./trivia-ledger-facts";

/**
 * Report reads one build runs at once. With the daily job's user concurrency
 * this keeps a tick well inside the default pool of ten connections.
 */
export const TRIVIA_READ_CONCURRENCY = 2;

/** The ledger's twelve-month reads, and the other windows the picks asked for. */
export interface TriviaLedgerLoad extends TriviaLedgerInput {
  windowed: TriviaWindowedReads;
}

/**
 * Reads what the spending, income, activity and warranty trivia are built
 * from. Every money figure comes from the report a reader can open (the same
 * conversion, the same exclusions); counts are read here. Each source fails on
 * its own: a report that throws leaves out its facts and only those.
 */
@Injectable()
export class TriviaLedgerLoader {
  private readonly logger = new Logger(TriviaLedgerLoader.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly reports: BuiltInReportsService,
  ) {}

  async load(
    userId: string,
    currency: string,
    today: string,
    picks: TriviaPicks,
  ): Promise<TriviaLedgerLoad> {
    const { startDate, endDate } = triviaWindow(today);

    // Independent reads, each already isolated by `attempt`. Each opens its
    // own transaction, so at most TRIVIA_READ_CONCURRENCY connections are held
    // at once: the daily job builds several users side by side and a page
    // load shares the pool with the rest of the dashboard.
    const [
      spendingByCategory,
      spendingByPayee,
      incomeVsExpenses,
      incomeBySource,
      records,
      warranties,
    ] = await allWithConcurrency(TRIVIA_READ_CONCURRENCY, [
      () =>
        this.attempt(userId, "spending", () =>
          this.reports.getSpendingByCategory(userId, startDate, endDate),
        ),
      () =>
        this.attempt(userId, "payees", () =>
          this.reports.getSpendingByPayee(userId, startDate, endDate),
        ),
      () =>
        this.attempt(userId, "cash flow", () =>
          this.reports.getIncomeVsExpenses(userId, startDate, endDate),
        ),
      () =>
        this.attempt(userId, "income", () =>
          this.reports.getIncomeBySource(userId, startDate, endDate),
        ),
      () => this.attempt(userId, "records", () => this.countRecords(userId)),
      () =>
        this.attempt(userId, "warranties", () =>
          this.readWarranties(userId, today),
        ),
    ] as const);
    const windowed = await readWindowedReports(
      this.reports,
      (source, read) => this.attempt(userId, source, read),
      userId,
      today,
      picks,
      TRIVIA_READ_CONCURRENCY,
    );

    return {
      currency,
      spendingByCategory,
      spendingByPayee,
      incomeVsExpenses,
      incomeBySource,
      records,
      warranties,
      windowed,
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

  private countRecords(userId: string): Promise<TriviaRecordCounts> {
    return withScopedDb(this.dataSource, async (m) => {
      const rows: {
        transactions: number;
        first_date: string | null;
        payees: number;
        categories: number;
        scheduled: number;
      }[] = await m.query(
        `SELECT
           (SELECT count(*)::int FROM transactions
             WHERE user_id = $1 AND parent_transaction_id IS NULL
               AND status IS DISTINCT FROM 'VOID') AS transactions,
           (SELECT to_char(min(transaction_date), 'YYYY-MM-DD') FROM transactions
             WHERE user_id = $1 AND parent_transaction_id IS NULL
               AND status IS DISTINCT FROM 'VOID') AS first_date,
           (SELECT count(*)::int FROM payees
             WHERE user_id = $1 AND is_active) AS payees,
           (SELECT count(*)::int FROM categories
             WHERE user_id = $1) AS categories,
           (SELECT count(*)::int FROM scheduled_transactions
             WHERE user_id = $1 AND is_active IS TRUE) AS scheduled`,
        [userId],
      );
      const row = rows[0];
      return {
        transactions: Number(row?.transactions ?? 0),
        firstTransactionDate: row?.first_date ?? null,
        activePayees: Number(row?.payees ?? 0),
        categories: Number(row?.categories ?? 0),
        activeScheduled: Number(row?.scheduled ?? 0),
      };
    });
  }

  /**
   * Expiry is `warrantyStatus`'s to decide (WTY-002): the bounds come from
   * `warrantyStatusBounds`, which is held to it day by day, never a date
   * compare written here.
   */
  private readWarranties(
    userId: string,
    today: string,
  ): Promise<TriviaWarranties> {
    // The last day a warranty reads `expired`; any later end is in cover.
    const lastExpired = warrantyStatusBounds("expired", today)
      .expiresTo as string;
    return withScopedDb(this.dataSource, async (m) => {
      const counts: { covered: number }[] = await m.query(
        `SELECT count(*)::int AS covered FROM warranties
          WHERE user_id = $1 AND archived_at IS NULL
            AND (is_lifetime OR expires_on > $2)`,
        [userId, lastExpired],
      );
      const next: { name: string; expires_on: string }[] = await m.query(
        `SELECT name, to_char(expires_on, 'YYYY-MM-DD') AS expires_on
           FROM warranties
          WHERE user_id = $1 AND archived_at IS NULL
            AND NOT is_lifetime AND expires_on > $2
          ORDER BY expires_on, name
          LIMIT 1`,
        [userId, lastExpired],
      );
      return {
        covered: Number(counts[0]?.covered ?? 0),
        nextExpiring: next[0]
          ? { name: next[0].name, expiresOn: next[0].expires_on }
          : null,
      };
    });
  }
}
