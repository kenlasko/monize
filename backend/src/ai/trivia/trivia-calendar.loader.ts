import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { stripBrokerageSuffix } from "../../accounts/account-name.util";
import { BuiltInReportsService } from "../../built-in-reports/built-in-reports.service";
import {
  yearAgoMonthRange,
  type TriviaCalendarData,
} from "./trivia-calendar-facts";

/** A transaction recorded this recently still counts as "this month's". */
const RECENT_DAYS = 30;

/**
 * Reads what the calendar facts need beyond the ledger: each open account's
 * first transaction, how many rows were recorded before the last 30 days, and
 * the spending of the same month a year ago (from the report a reader can
 * open). Each source fails on its own, leaving out its facts and only those.
 */
@Injectable()
export class TriviaCalendarLoader {
  private readonly logger = new Logger(TriviaCalendarLoader.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly reports: BuiltInReportsService,
  ) {}

  async load(userId: string, today: string): Promise<TriviaCalendarData> {
    const { startDate, endDate } = yearAgoMonthRange(today);
    const accountFirstDates = await this.attempt(userId, "accounts", () =>
      this.readAccountFirstDates(userId),
    );
    const transactionsRecordedBefore = await this.attempt(
      userId,
      "recorded rows",
      () => this.countRecordedBefore(userId),
    );
    const yearAgoMonth = await this.attempt(userId, "a year ago", () =>
      this.reports.getSpendingByCategory(userId, startDate, endDate),
    );
    return { accountFirstDates, transactionsRecordedBefore, yearAgoMonth };
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
   * Accounts have no opening date, so the first non-VOID top-level row is the
   * opening. The brokerage suffix is stripped here; the facts count a pair once.
   */
  private readAccountFirstDates(
    userId: string,
  ): Promise<{ name: string; firstDate: string }[]> {
    return withScopedDb(this.dataSource, async (m) => {
      const rows: { name: string; first_date: string }[] = await m.query(
        `SELECT a.name,
                TO_CHAR(MIN(t.transaction_date), 'YYYY-MM-DD') AS first_date
           FROM accounts a
           JOIN transactions t ON t.account_id = a.id AND t.user_id = a.user_id
          WHERE a.user_id = $1
            AND a.is_closed IS NOT TRUE
            AND t.parent_transaction_id IS NULL
            AND t.status IS DISTINCT FROM 'VOID'
          GROUP BY a.id, a.name
          ORDER BY a.name`,
        [userId],
      );
      return rows.map((row) => ({
        name: stripBrokerageSuffix(row.name),
        firstDate: row.first_date,
      }));
    });
  }

  /** Recorded, not dated: an import of old rows is still "recorded this month". */
  private countRecordedBefore(userId: string): Promise<number> {
    return withScopedDb(this.dataSource, async (m) => {
      const rows: { recorded_before: number }[] = await m.query(
        `SELECT count(*)::int AS recorded_before
           FROM transactions
          WHERE user_id = $1 AND parent_transaction_id IS NULL
            AND status IS DISTINCT FROM 'VOID'
            AND created_at < now() - ($2 || ' days')::interval`,
        [userId, String(RECENT_DAYS)],
      );
      return Number(rows[0]?.recorded_before ?? 0);
    });
  }
}
