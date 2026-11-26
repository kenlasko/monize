import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { ConfigService } from "@nestjs/config";
import { I18nService } from "nestjs-i18n";
import { emailTranslator } from "../i18n/email-translator";
import { DEFAULT_LOCALE } from "../i18n/config";
import { Budget } from "./entities/budget.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  BudgetPeriodService,
  NoOpenPeriodError,
} from "./budget-period.service";
import { BudgetReportsService } from "./budget-reports.service";
import { EmailService } from "../notifications/email.service";
import { budgetMonthlySummaryTemplate } from "../notifications/email-templates";
import { roundMoney, sumMoney } from "../common/round.util";
import { numberFormatterFor } from "../common/number-locale.util";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import { NotificationCategory } from "../notification-center/entities/notification.entity";
import { NotificationPreferenceService } from "../notification-center/notification-preference.service";
import {
  JobClaimService,
  JobClaimType,
} from "../common/jobs/job-claim.service";

interface ClosedPeriodInfo {
  budget: Budget;
  period: BudgetPeriod;
}

/**
 * The claim key: one rollover per owner per calendar month.
 *
 * UTC, because two replicas in two zones must derive the same key from the same
 * instant or the claim names two different months and both of them run.
 */
export function rolloverMonthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Budgets grouped by their owner, which is the unit the claim is taken in. */
function groupByOwner(budgets: Budget[]): Map<string, Budget[]> {
  const byOwner = new Map<string, Budget[]>();
  for (const budget of budgets) {
    const owned = byOwner.get(budget.userId);
    if (owned) owned.push(budget);
    else byOwner.set(budget.userId, [budget]);
  }
  return byOwner;
}

@Injectable()
export class BudgetPeriodCronService {
  private readonly logger = new Logger(BudgetPeriodCronService.name);

  constructor(
    private dataSource: DataSource,
    private budgetPeriodService: BudgetPeriodService,
    private budgetReportsService: BudgetReportsService,
    private emailService: EmailService,
    private configService: ConfigService,
    private readonly i18n: I18nService,
    // The monthly summary is a BUDGETS email, gated by the same channel matrix
    // as the weekly digest.
    private readonly notificationPreferences: NotificationPreferenceService,
    private readonly jobClaims: JobClaimService,
  ) {}

  @Cron("0 0 1 * *")
  async closeExpiredPeriods(): Promise<void> {
    this.logger.log("Running budget period close check...");

    try {
      // RLS (task C2): cross-user fan-out over all active budgets.
      const activeBudgets = await withSystemContext(() =>
        withScopedDb(this.dataSource, (m) =>
          m.getRepository(Budget).find({
            where: { isActive: true },
            relations: [
              "categories",
              "categories.category",
              "categories.transferAccount",
            ],
          }),
        ),
      );

      if (activeBudgets.length === 0) {
        this.logger.log("No active budgets found");
        return;
      }

      let closedCount = 0;
      let errorCount = 0;
      let skippedOwners = 0;
      const closedPeriods: ClosedPeriodInfo[] = [];
      const monthKey = rolloverMonthKey(new Date());

      for (const [ownerUserId, ownedBudgets] of groupByOwner(activeBudgets)) {
        // One month rolls over once per owner, and every replica fires this
        // cron. The claim is what keeps a losing replica out of the owner
        // entirely, rather than racing it budget by budget.
        //
        // It is **not** the record that the rollover happened --
        // `JobClaimService`'s own contract: "a claim is not a record that the
        // work was done, and reaching for `claimOnce` as though it were is how
        // a delivery gets lost". So it is handed back below whenever the
        // owner's pass did not complete. Nothing is rolled over twice as a
        // result: `closePeriod` locks the OPEN period row and the next period
        // is `ON CONFLICT (budget_id, period_start) DO NOTHING`, which is what
        // actually enforces "once", and a second pass over an owner already
        // rolled over finds no expired OPEN period and does nothing.
        //
        // The claim is per OWNER rather than per deployment because
        // `job_claims.user_id` is a NOT NULL foreign key to `users`, and per
        // owner is also the unit the rollover works in.
        const claimed = await withUserContext(ownerUserId, () =>
          this.jobClaims.claimOnce(
            JobClaimType.BudgetPeriodRollover,
            ownerUserId,
            monthKey,
          ),
        );
        if (!claimed) {
          skippedOwners++;
          this.logger.debug(
            `Budget rollover for ${monthKey} already claimed for user ${ownerUserId}; skipping`,
          );
          continue;
        }

        // Whether this owner's whole pass got through. One budget failing is
        // enough to hand the month back: the claim covers the owner, so keeping
        // it would assert a rollover that did not happen for that budget and
        // lock every other replica out of finishing it.
        let ownerComplete = true;

        for (const budget of ownedBudgets) {
          try {
            // RLS (task C2): per-user reads/writes run under the owner's context.
            const openPeriod = await withUserContext(budget.userId, () =>
              withScopedDb(this.dataSource, (m) =>
                m.getRepository(BudgetPeriod).findOne({
                  where: { budgetId: budget.id, status: PeriodStatus.OPEN },
                }),
              ),
            );

            if (!openPeriod) {
              continue;
            }

            const periodEnd = new Date(openPeriod.periodEnd + "T23:59:59");
            const now = new Date();

            if (now > periodEnd) {
              const closedPeriod = await withUserContext(budget.userId, () =>
                this.budgetPeriodService.closePeriod(budget.userId, budget.id),
              );
              closedCount++;
              closedPeriods.push({ budget, period: closedPeriod });
              this.logger.log(
                `Closed period for budget "${budget.name}" (${budget.id})`,
              );
            }
          } catch (error) {
            // "No open period to close" is what the loser of `closePeriod`'s row
            // lock sees, and with the claim above it should be unreachable for a
            // claimed owner. It is still a skip rather than an error, because a
            // rollout that briefly runs two processes on one replica reaches it
            // without anything being wrong -- and counting a normal tick as a
            // failure is how the gap F3 recorded reads today.
            if (error instanceof NoOpenPeriodError) {
              this.logger.log(
                `Period for budget ${budget.id} was closed by another process; skipping`,
              );
              continue;
            }
            errorCount++;
            ownerComplete = false;
            this.logger.error(
              `Failed to close period for budget ${budget.id}`,
              error instanceof Error ? error.stack : error,
            );
          }
        }

        if (!ownerComplete) {
          // Give the month back. Without this, one transient error -- a
          // serialization failure on the period lock, a pool timeout -- consumed
          // the owner's claim permanently, and because this cron is monthly
          // there was no later tick to repair it: the previous month's period
          // stayed OPEN and the following month's tick then skipped straight to
          // the month it ran in.
          //
          // Releasing does not by itself produce a retry within the month (see
          // the gap this leaves in docs/concurrency-and-idempotency.md); what it
          // does is stop a failure from being recorded as a success.
          await withUserContext(ownerUserId, () =>
            this.jobClaims.releasePermanentClaim(
              JobClaimType.BudgetPeriodRollover,
              ownerUserId,
              monthKey,
            ),
          );
        }
      }

      this.logger.log(
        `Budget period close complete: ${closedCount} closed, ` +
          `${errorCount} errors, ${skippedOwners} owner(s) claimed elsewhere`,
      );

      if (closedPeriods.length > 0) {
        await this.sendMonthlySummaryEmails(closedPeriods);
      }
    } catch (error) {
      this.logger.error(
        "Failed to run budget period close check",
        error instanceof Error ? error.stack : error,
      );
    }
  }

  async sendMonthlySummaryEmails(
    closedPeriods: ClosedPeriodInfo[],
  ): Promise<void> {
    if (!this.emailService.getStatus().configured) {
      this.logger.debug(
        "SMTP not configured, skipping monthly budget summary emails",
      );
      return;
    }

    const periodsByUser = new Map<string, ClosedPeriodInfo[]>();
    for (const info of closedPeriods) {
      const existing = periodsByUser.get(info.budget.userId) || [];
      existing.push(info);
      periodsByUser.set(info.budget.userId, existing);
    }

    let sentCount = 0;

    for (const [userId, userPeriods] of periodsByUser) {
      try {
        // RLS (task C2): per-user body keeps the owner's RLS net.
        const sent = await withUserContext(userId, () =>
          this.sendMonthlySummaryForUser(userId, userPeriods),
        );
        if (sent) sentCount++;
      } catch (error) {
        this.logger.error(
          `Failed to send monthly summary email for user ${userId}`,
          error instanceof Error ? error.stack : error,
        );
      }
    }

    this.logger.log(`Monthly summary emails sent: ${sentCount}`);
  }

  private async sendMonthlySummaryForUser(
    userId: string,
    periods: ClosedPeriodInfo[],
  ): Promise<boolean> {
    // A budget monthly summary is the BUDGETS category; email is gated by that
    // channel matrix and the global email master switch together (the resolver
    // reads both), exactly as the weekly digest is. Runs under the user's own
    // withUserContext, which the resolver's nested withScopedDb joins.
    const emailEnabled = await this.notificationPreferences.resolveEmail(
      userId,
      NotificationCategory.BUDGETS,
    );
    if (!emailEnabled) return false;

    // The user's stored locale and the digest's own toggle.
    const prefs = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({
        where: { userId },
      }),
    );
    if (prefs && prefs.budgetDigestEnabled === false) return false;

    const user = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(User).findOne({
        where: { id: userId },
      }),
    );
    if (!user || !user.email) return false;

    const appUrl = this.configService.get<string>(
      "PUBLIC_APP_URL",
      "http://localhost:3000",
    );

    const summaries = await Promise.all(
      periods.map(async ({ budget, period }) => {
        let healthScore: number | null = null;
        let healthLabel: string | null = null;
        try {
          const health = await this.budgetReportsService.getHealthScore(
            userId,
            budget.id,
          );
          healthScore = health.score;
          healthLabel = health.label;
        } catch {
          // Health score is optional
        }

        const categories = budget.categories || [];
        const expenseCategories = categories.filter((c) => !c.isIncome);

        const frozenByLine = new Map(
          (period.periodCategories ?? []).map((pc) => [
            pc.budgetCategoryId,
            pc,
          ]),
        );
        const categoryData = expenseCategories.map((bc) => {
          const pc = frozenByLine.get(bc.id);
          const budgeted = Number(
            pc?.effectiveBudget ?? pc?.budgetedAmount ?? bc.amount,
          );
          const actual = Number(pc?.actualAmount ?? 0);
          return {
            categoryName: bc.category?.name || "Uncategorized",
            budgeted,
            actual,
            percentUsed:
              budgeted > 0 ? Math.round((actual / budgeted) * 10000) / 100 : 0,
          };
        });

        const overBudgetCategories = categoryData.filter(
          (c) => c.actual > c.budgeted,
        );

        const topCategories = [...categoryData]
          .sort((a, b) => b.actual - a.actual)
          .slice(0, 5);

        // The header holds the opening plan. The frozen expense lines hold the
        // amounts actually available, including carry and income-linked funding.
        // A partial set of lines can adjust the header only by its known carry.
        const allExpensesFrozen =
          expenseCategories.length > 0 &&
          expenseCategories.every((bc) => frozenByLine.has(bc.id));
        const totalBudgeted = allExpensesFrozen
          ? sumMoney(categoryData.map((c) => c.budgeted))
          : sumMoney([
              Number(period.totalBudgeted),
              ...expenseCategories.map((bc) =>
                Number(frozenByLine.get(bc.id)?.rolloverIn ?? 0),
              ),
            ]);
        const totalSpent = Number(period.actualExpenses);
        const totalIncome = Number(period.actualIncome);
        const remaining = roundMoney(totalBudgeted - totalSpent);
        const percentUsed =
          totalBudgeted > 0
            ? Math.round((totalSpent / totalBudgeted) * 10000) / 100
            : 0;

        const periodDate = new Date(period.periodStart + "T00:00:00");
        const periodLabel = periodDate.toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
        });

        return {
          budgetName: budget.name,
          currencyCode: budget.currencyCode,
          periodLabel,
          totalBudgeted,
          totalSpent,
          totalIncome,
          remaining,
          percentUsed,
          healthScore,
          healthLabel,
          overBudgetCategories,
          topCategories,
        };
      }),
    );

    const lang = prefs?.language || DEFAULT_LOCALE;
    const t = emailTranslator(this.i18n, lang);
    const n = numberFormatterFor(prefs?.numberFormat, prefs?.language);

    const html = budgetMonthlySummaryTemplate(
      user.firstName || "",
      summaries,
      appUrl,
      t,
      n,
    );

    const subject =
      summaries.length === 1
        ? t(
            "emails.budgetMonthlySummary.subject",
            `Monize: Monthly budget summary - ${summaries[0].periodLabel}`,
            { period: summaries[0].periodLabel },
          )
        : t(
            "emails.budgetMonthlySummary.subjectPlural",
            `Monize: Monthly budget summary for ${summaries.length} budgets`,
            { count: summaries.length },
          );

    await this.emailService.sendMail(user.email, subject, html);
    return true;
  }
}
