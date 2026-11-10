import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import {
  formatMonthKey,
  getMonthEndYMD,
  todayInTimezoneOrUtc,
} from "../../common/date-utils";
import { getEffectiveTimezoneOfUser } from "../../common/users-by-timezone.util";
import { BuiltInReportsService } from "../../built-in-reports/built-in-reports.service";
import { warrantyStatus } from "../../warranties/warranty-status.util";
import type {
  TriviaLedgerInput,
  TriviaRecordCounts,
  TriviaWarranties,
} from "./trivia-ledger-facts";

/** The window the spending and income facts describe, in whole months. */
export const TRIVIA_WINDOW_MONTHS = 12;

/**
 * The last `TRIVIA_WINDOW_MONTHS` whole months before `today`'s, so the
 * figures never move with the day of the month a reader happens to look.
 */
export function triviaWindow(today: string): {
  startDate: string;
  endDate: string;
} {
  const [year, month] = today.split("-").map(Number);
  // `month - 1` is the last whole month; Date arithmetic would bring a zone.
  const endIndex = year * 12 + (month - 1) - 1;
  const startIndex = endIndex - (TRIVIA_WINDOW_MONTHS - 1);
  const yearOf = (index: number) => Math.floor(index / 12);
  const monthOf = (index: number) => (index % 12) + 1;
  return {
    startDate: `${formatMonthKey(yearOf(startIndex), monthOf(startIndex))}-01`,
    endDate: getMonthEndYMD(yearOf(endIndex), monthOf(endIndex)),
  };
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

  async load(userId: string, currency: string): Promise<TriviaLedgerInput> {
    const timezone = await withScopedDb(this.dataSource, (m) =>
      getEffectiveTimezoneOfUser(m, userId),
    );
    const today = todayInTimezoneOrUtc(timezone);
    const { startDate, endDate } = triviaWindow(today);

    const spendingByCategory = await this.attempt(userId, "spending", () =>
      this.reports.getSpendingByCategory(userId, startDate, endDate),
    );
    const spendingByPayee = await this.attempt(userId, "payees", () =>
      this.reports.getSpendingByPayee(userId, startDate, endDate),
    );
    const incomeVsExpenses = await this.attempt(userId, "cash flow", () =>
      this.reports.getIncomeVsExpenses(userId, startDate, endDate),
    );
    const incomeBySource = await this.attempt(userId, "income", () =>
      this.reports.getIncomeBySource(userId, startDate, endDate),
    );
    const records = await this.attempt(userId, "records", () =>
      this.countRecords(userId),
    );
    const warranties = await this.attempt(userId, "warranties", () =>
      this.readWarranties(userId, today),
    );

    return {
      currency,
      spendingByCategory,
      spendingByPayee,
      incomeVsExpenses,
      incomeBySource,
      records,
      warranties,
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

  /** Expiry is `warrantyStatus`'s to decide (WTY-002), never a date compare here. */
  private readWarranties(
    userId: string,
    today: string,
  ): Promise<TriviaWarranties> {
    return withScopedDb(this.dataSource, async (m) => {
      const rows: {
        name: string;
        expires_on: string | null;
        is_lifetime: boolean;
      }[] = await m.query(
        `SELECT name, to_char(expires_on, 'YYYY-MM-DD') AS expires_on, is_lifetime
           FROM warranties
          WHERE user_id = $1 AND archived_at IS NULL`,
        [userId],
      );
      const covered = rows.filter(
        (row) =>
          warrantyStatus(row.expires_on, row.is_lifetime, today).status !==
          "expired",
      );
      const next =
        covered
          .filter((row) => !row.is_lifetime && row.expires_on !== null)
          .sort(
            (a, b) =>
              (a.expires_on as string).localeCompare(b.expires_on as string) ||
              a.name.localeCompare(b.name),
          )[0] ?? null;
      return {
        covered: covered.length,
        nextExpiring: next
          ? { name: next.name, expiresOn: next.expires_on as string }
          : null,
      };
    });
  }
}
