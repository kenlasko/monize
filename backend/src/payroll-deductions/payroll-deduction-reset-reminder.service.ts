import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { todayInTimezoneOrUtc } from "../common/date-utils";
import { returnedRows } from "../common/db/query-result";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import { getUsersByEffectiveTimezone } from "../common/users-by-timezone.util";
import { roundMoney } from "../common/round.util";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { buildResetReminderNotification } from "./payroll-deduction-notifications";
import { resetReminderDueFor } from "./payroll-deduction-period";
import {
  figuresForPeriod,
  loadRulePeriods,
  RulePeriodFigures,
} from "./payroll-deduction-rule-periods";

/** A rule with the names its reminder prints. */
interface RuleCandidate {
  id: string;
  userId: string;
  resetDate: string;
  yearlyMaximum: number;
  /** The figures the rule stores per period (spec section 11). */
  periods: RulePeriodFigures[];
  categoryName: string;
  scheduledTransactionName: string;
  currencyCode: string;
}

export interface ResetReminderTally {
  /** Notification rows this replica wrote. */
  written: number;
}

/**
 * Two months before a rule resets, ask the owner to confirm the next period's
 * maximum (docs/specs/payroll-deductions.md section 5.5, decision 8). Every
 * replica fires every cron; the notification's dedupe key, one per rule per
 * reset date, is what makes the window fire once (INV-PAYROLL-004):
 * `NotificationService.create` is `INSERT ... ON CONFLICT DO NOTHING`, so the
 * insert-winner fans out and a loser gets `null` and sends nothing.
 *
 * The shape is the out-of-request one: `withSystemContext` for the cross-user
 * read of every rule and every user's timezone, `withUserContext` around each
 * user's body; a failure of one rule or one user is logged and the loop goes
 * on. The rules are few, so every one is read and the window is judged in
 * code, in the owner's own calendar.
 */
@Injectable()
export class PayrollDeductionResetReminderService {
  private readonly logger = new Logger(
    PayrollDeductionResetReminderService.name,
  );

  constructor(
    private readonly dataSource: DataSource,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  @Cron("23 6 * * *", { timeZone: "UTC" })
  async run(): Promise<void> {
    try {
      const tally = await this.evaluate(new Date());
      if (tally.written > 0) {
        this.logger.log(
          `Payroll deduction reset reminders: ${tally.written} written by this replica`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Payroll deduction reset reminders could not run: ${errorMessage(error)}`,
      );
    }
  }

  /** Judge every rule as of `now`. Public so a test can pin the clock. */
  async evaluate(now: Date): Promise<ResetReminderTally> {
    const { candidates, timezoneOf } = await withSystemContext(async () => {
      const found = await this.candidates();
      return {
        candidates: found,
        timezoneOf:
          found.length === 0
            ? new Map<string, string>()
            : await this.timezones(),
      };
    });

    const byUser = new Map<string, RuleCandidate[]>();
    for (const candidate of candidates) {
      byUser.set(candidate.userId, [
        ...(byUser.get(candidate.userId) ?? []),
        candidate,
      ]);
    }

    const tally: ResetReminderTally = { written: 0 };
    for (const [userId, rules] of byUser) {
      try {
        const today = todayInTimezoneOrUtc(
          timezoneOf.get(userId) ?? "UTC",
          now,
        );
        await withUserContext(userId, async () => {
          for (const rule of rules) {
            try {
              if (await this.remind(rule, today)) tally.written += 1;
            } catch (error) {
              this.logger.error(
                `Payroll deduction reminder for ${rule.id} failed: ${errorMessage(error)}`,
              );
            }
          }
        });
      } catch (error) {
        this.logger.error(
          `Payroll deduction reminders failed for user ${userId}: ${errorMessage(error)}`,
        );
      }
    }
    return tally;
  }

  private async candidates(): Promise<RuleCandidate[]> {
    return withScopedDb(this.dataSource, async (m) => {
      const rows = returnedRows<{
        id: string;
        user_id: string;
        reset_date: string;
        yearly_maximum: string;
        category_name: string;
        scheduled_name: string;
        currency_code: string;
      }>(
        await m.query(
          `SELECT r.id, r.user_id,
                  TO_CHAR(r.reset_date, 'YYYY-MM-DD') AS reset_date,
                  r.yearly_maximum,
                  c.name AS category_name,
                  st.name AS scheduled_name,
                  st.currency_code
             FROM payroll_deduction_rules r
             JOIN categories c ON c.id = r.category_id
             JOIN scheduled_transactions st ON st.id = r.scheduled_transaction_id
            WHERE st.is_active = true
            ORDER BY r.user_id, r.created_at, r.id`,
        ),
      );
      const periods = await loadRulePeriods(
        m,
        rows.map((row) => row.id),
      );
      return rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        resetDate: row.reset_date,
        yearlyMaximum: roundMoney(Number(row.yearly_maximum)),
        periods: periods.get(row.id) ?? [],
        categoryName: row.category_name,
        scheduledTransactionName: row.scheduled_name,
        currencyCode: row.currency_code,
      }));
    });
  }

  private async timezones(): Promise<Map<string, string>> {
    const byZone = await getUsersByEffectiveTimezone(this.dataSource);
    const byUser = new Map<string, string>();
    for (const [timezone, userIds] of byZone) {
      for (const userId of userIds) byUser.set(userId, timezone);
    }
    return byUser;
  }

  /** True when this replica wrote the row; `null` is the other replica's. */
  private async remind(rule: RuleCandidate, today: string): Promise<boolean> {
    const resetOn = resetReminderDueFor(rule.resetDate, today);
    if (resetOn === null) return false;
    const written = await this.dispatch.notify(
      rule.userId,
      buildResetReminderNotification(
        {
          ruleId: rule.id,
          categoryName: rule.categoryName,
          scheduledTransactionName: rule.scheduledTransactionName,
          resetOn,
          // The figure the period starting on the reset will cap with.
          yearlyMaximum: figuresForPeriod(rule, resetOn).yearlyMaximum,
          currencyCode: rule.currencyCode,
        },
        today,
      ),
    );
    return written !== null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
