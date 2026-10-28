import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { ConfigService } from "@nestjs/config";
import { I18nService } from "nestjs-i18n";
import { emailTranslator } from "../i18n/email-translator";
import { DEFAULT_LOCALE } from "../i18n/config";
import { getMonthEndYMD } from "../common/date-utils";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import {
  JobClaimService,
  JobClaimType,
} from "../common/jobs/job-claim.service";
import { Budget } from "./entities/budget.entity";
import {
  Notification,
  NotificationType,
  NotificationSeverity,
  NotificationCategory,
  typesForCategory,
} from "../notification-center/entities/notification.entity";
import { NotificationService } from "../notification-center/notification.service";
import { NotificationPreferenceService } from "../notification-center/notification-preference.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { EmailService } from "../notifications/email.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { notificationEmailCopy } from "../notifications/notification-email-copy";
import {
  budgetAlertImmediateTemplate,
  budgetWeeklyDigestTemplate,
} from "../notifications/email-templates";
import {
  getCurrentMonthPeriodDates,
  PeriodDateRange,
} from "./budget-date.utils";
import {
  queryCategorySpending,
  resolveCategoryName,
  resolveCategorySpent,
} from "./budget-spending.util";
import { FALLBACK_DEFAULT_CURRENCY } from "../common/default-currency.util";
import {
  NumberT,
  defaultNumberT,
  numberFormatterFor,
} from "../common/number-locale.util";
import { roundMoney, sumMoney } from "../common/round.util";

interface SeasonalProfile {
  budgetCategoryId: string;
  categoryId: string;
  categoryName: string;
  highMonths: number[];
  typicalMonthlySpend: number;
  typicalIncrease: number;
}

interface CategoryActual {
  budgetCategoryId: string;
  categoryId: string | null;
  categoryName: string;
  currencyCode: string;
  budgeted: number;
  spent: number;
  percentUsed: number;
  isIncome: boolean;
  alertWarnPercent: number;
  alertCriticalPercent: number;
  flexGroup: string | null;
}

interface AlertCandidate {
  budgetId: string;
  budgetCategoryId: string | null;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  data: Record<string, unknown>;
}

/**
 * What the weekly budget digest is about: the budget types and the bill
 * reminders, and nothing else that happens to share the table and a
 * `period_start`. A reminder's re-emitted nag of one of these is dropped after
 * the read (`isReminderReEmit`): it is the user's own repeat of a row already in
 * the digest, not news.
 */
export const DIGEST_TYPES: readonly NotificationType[] = [
  ...typesForCategory(NotificationCategory.BUDGETS),
  NotificationType.BILL_DUE,
];

/**
 * How long one replica holds a user's weekly digest: one SMTP round trip with
 * room to spare, and short enough that a replica killed mid-send hands the user
 * back to the next run rather than locking them out.
 */
export const DIGEST_LEASE_MS = 10 * 60 * 1000;

function isReminderReEmit(row: Notification): boolean {
  const value = (row.data as Record<string, unknown> | null | undefined)
    ?.reminderId;
  return typeof value === "string" && value.length > 0;
}

@Injectable()
export class BudgetAlertService {
  private readonly logger = new Logger(BudgetAlertService.name);

  constructor(
    private dataSource: DataSource,
    private emailService: EmailService,
    private configService: ConfigService,
    private readonly i18n: I18nService,
    // Every notification this service produces goes through the one write door.
    // `markEmailSent` is called directly; new alerts are written through the
    // dispatch below so they also fan out to push and immediate email.
    private notifications: NotificationService,
    // Email for budget alerts is gated by the BUDGETS channel matrix.
    private readonly notificationPreferences: NotificationPreferenceService,
    // The Phase 5 fan-out seam: writing a budget alert through `notify` adds the
    // notification-mode push and immediate email (matrix- and throttle-gated) on
    // top of the in-app row, without changing the batched critical email below,
    // which is report-mode and stays as it is.
    private readonly dispatch: NotificationDispatchService,
    // The weekly digest's lease and delivery record, so N replicas send one.
    private readonly jobClaims: JobClaimService,
  ) {}

  @Cron("0 7 * * *")
  async checkBudgetAlerts(): Promise<void> {
    this.logger.log("Running daily budget alert check...");

    try {
      // RLS (task C2): cross-user fan-out over all active budgets.
      const activeBudgets = await withSystemContext(() =>
        withScopedDb(this.dataSource, (m) =>
          m.getRepository(Budget).find({
            where: { isActive: true },
            relations: [
              "categories",
              "categories.category",
              "categories.category.parent",
              "categories.transferAccount",
            ],
          }),
        ),
      );

      if (activeBudgets.length === 0) {
        this.logger.log("No active budgets found");
        return;
      }

      let alertsCreated = 0;
      let emailsSent = 0;

      for (const budget of activeBudgets) {
        try {
          // RLS: per-user body keeps the user's RLS net.
          const result = await withUserContext(budget.userId, () =>
            this.processAlerts(budget),
          );
          alertsCreated += result.alertsCreated;
          emailsSent += result.emailsSent;
        } catch (error) {
          this.logger.error(
            `Failed to process alerts for budget ${budget.id}`,
            error instanceof Error ? error.stack : error,
          );
        }
      }

      this.logger.log(
        `Budget alert check complete: ${alertsCreated} alerts created, ${emailsSent} emails sent`,
      );
    } catch (error) {
      this.logger.error(
        "Failed to run budget alert check",
        error instanceof Error ? error.stack : error,
      );
    }
  }

  @Cron("0 7 * * 1")
  async sendWeeklyDigest(): Promise<void> {
    this.logger.log("Running weekly budget digest...");

    try {
      // RLS (task C2): cross-user fan-out over all active budgets.
      const activeBudgets = await withSystemContext(() =>
        withScopedDb(this.dataSource, (m) =>
          m.getRepository(Budget).find({
            where: { isActive: true },
            relations: [
              "categories",
              "categories.category",
              "categories.category.parent",
              "categories.transferAccount",
            ],
          }),
        ),
      );

      if (activeBudgets.length === 0) {
        this.logger.log("No active budgets for weekly digest");
        return;
      }

      if (!this.emailService.getStatus().configured) {
        this.logger.debug("SMTP not configured, skipping weekly budget digest");
        return;
      }

      const budgetsByUser = new Map<string, Budget[]>();
      for (const budget of activeBudgets) {
        const existing = budgetsByUser.get(budget.userId) || [];
        existing.push(budget);
        budgetsByUser.set(budget.userId, existing);
      }

      // The run's date, read ONCE for every user. It is the digest's claim
      // key, and a run that spans midnight while reading the date per user
      // claims the early users under one key and the rest under another --
      // which is how the bill reminder's two passes came to disagree.
      //
      // The UTC day, not `todayYMD()`: outside a request that is the server's
      // local date, so two replicas with different TZ settings would key the
      // same Monday's digest differently and both send it. UTC is the same
      // string on every replica, as the demo reset's key is.
      const runDate = new Date().toISOString().slice(0, 10);

      let sentCount = 0;
      let skipCount = 0;

      for (const [userId, userBudgets] of budgetsByUser) {
        try {
          // RLS: per-user body keeps the user's RLS net.
          const sent = await withUserContext(userId, () =>
            this.sendDigestForUser(userId, userBudgets, runDate),
          );
          if (sent) {
            sentCount++;
          } else {
            skipCount++;
          }
        } catch (error) {
          this.logger.error(
            `Failed to send weekly digest for user ${userId}`,
            error instanceof Error ? error.stack : error,
          );
        }
      }

      this.logger.log(
        `Weekly budget digest complete: ${sentCount} sent, ${skipCount} skipped`,
      );
    } catch (error) {
      this.logger.error(
        "Failed to run weekly budget digest",
        error instanceof Error ? error.stack : error,
      );
    }
  }

  async processAlerts(
    budget: Budget,
  ): Promise<{ alertsCreated: number; emailsSent: number }> {
    const { periodStart, periodEnd } = this.getCurrentPeriodDates();
    const categories = budget.categories || [];

    if (categories.length === 0) {
      return { alertsCreated: 0, emailsSent: 0 };
    }

    const actuals = await this.computeCategoryActuals(
      budget.userId,
      budget,
      periodStart,
      periodEnd,
    );

    // Every figure below is read by this budget's owner, so it is rendered in
    // their number locale rather than the server's (issue #1316). Resolved once
    // per budget: the `check*` methods are pure and take it as an argument.
    const prefs = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({
        where: { userId: budget.userId },
      }),
    );
    const n = numberFormatterFor(prefs?.numberFormat, prefs?.language);

    const today = new Date();
    const startDate = new Date(periodStart);
    const endDate = new Date(periodEnd);
    // periodEnd is the inclusive last day, so the period spans one more day.
    const totalDays =
      Math.ceil(
        (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
      ) + 1;
    const daysElapsed = Math.max(
      1,
      Math.ceil(
        (today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
      ),
    );
    const daysRemaining = Math.max(0, totalDays - daysElapsed);
    const periodProgress = daysElapsed / totalDays;

    const candidates: AlertCandidate[] = [];

    const expenseActuals = actuals.filter((a) => !a.isIncome);
    const incomeActuals = actuals.filter((a) => a.isIncome);

    // 1. Threshold alerts per category
    for (const cat of expenseActuals) {
      if (cat.budgeted <= 0) continue;

      const alerts = this.checkThresholdAlerts(cat, n);
      candidates.push(...alerts.map((a) => ({ ...a, budgetId: budget.id })));
    }

    // 2. Velocity / projected overspend alerts per category
    for (const cat of expenseActuals) {
      if (cat.budgeted <= 0 || daysElapsed < 3) continue;

      const velocityAlert = this.checkVelocityAlert(
        cat,
        daysElapsed,
        totalDays,
        n,
      );
      if (velocityAlert) {
        candidates.push({ ...velocityAlert, budgetId: budget.id });
      }
    }

    // 3. Flex group alerts
    const flexAlerts = this.checkFlexGroupAlerts(expenseActuals, n);
    candidates.push(...flexAlerts.map((a) => ({ ...a, budgetId: budget.id })));

    // 4. Income shortfall (income-linked budgets)
    if (budget.incomeLinked && budget.baseIncome) {
      const incomeAlert = this.checkIncomeShortfall(
        incomeActuals,
        budget.baseIncome,
        periodProgress,
        n,
      );
      if (incomeAlert) {
        candidates.push({ ...incomeAlert, budgetId: budget.id });
      }
    }

    // 5. Positive milestones
    const milestoneAlerts = this.checkPositiveMilestones(
      expenseActuals,
      periodProgress,
      daysRemaining,
      n,
    );
    candidates.push(
      ...milestoneAlerts.map((a) => ({ ...a, budgetId: budget.id })),
    );

    // 6. Seasonal spike warnings
    try {
      const seasonalAlerts = await this.checkSeasonalSpikes(
        budget.userId,
        budget,
        n,
      );
      candidates.push(
        ...seasonalAlerts.map((a) => ({ ...a, budgetId: budget.id })),
      );
    } catch (error) {
      this.logger.error(
        `Failed to check seasonal spikes for budget ${budget.id}`,
        error instanceof Error ? error.stack : error,
      );
    }

    // De-duplicate against existing alerts for same period
    const existingAlerts = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Notification).find({
        where: {
          budgetId: budget.id,
          periodStart,
        },
      }),
    );

    const newCandidates = this.deduplicateAlerts(candidates, existingAlerts);

    if (newCandidates.length === 0) {
      return { alertsCreated: 0, emailsSent: 0 };
    }

    // Save new alerts. What the INSERT returns -- not what the candidate list
    // hoped to save -- decides which alerts are new.
    //
    // The in-memory de-duplication above is a check-then-act, and every backend
    // replica runs this cron: two processors both read no existing OVER_BUDGET
    // alert for the period, both inserted one, and both sent the critical email
    // (audit P4-015). The unique fingerprint from migration 140 arbitrates
    // instead, and `ON CONFLICT DO NOTHING RETURNING` reports the outcome
    // honestly: the loser gets no row and therefore sends nothing.
    const savedAlerts: Notification[] = [];
    for (const candidate of newCandidates) {
      // `null` from the door means the fingerprint index refused the row --
      // another replica holds this alert -- so this processor sends nothing for
      // it. That is the whole arbitration; there is no second check.
      const saved = await this.dispatch.notify(budget.userId, {
        type: candidate.type,
        severity: candidate.severity,
        title: candidate.title,
        message: candidate.message,
        // The amounts were computed in this budget's currency. Carry the
        // code with the snapshot so later emails never guess from preferences.
        data: { ...candidate.data, currencyCode: budget.currencyCode },
        budgetId: candidate.budgetId,
        budgetCategoryId: candidate.budgetCategoryId,
        // Where the bell sends the reader: the budget the alert is about.
        target: `/budgets/${candidate.budgetId}`,
        periodStart,
      });
      if (saved) savedAlerts.push(saved);
    }

    if (savedAlerts.length === 0) {
      return { alertsCreated: 0, emailsSent: 0 };
    }

    // Send immediate emails for critical alerts
    let emailsSent = 0;
    const criticalAlerts = savedAlerts.filter(
      (a) =>
        a.severity === NotificationSeverity.CRITICAL &&
        (a.type === NotificationType.THRESHOLD_CRITICAL ||
          a.type === NotificationType.OVER_BUDGET ||
          a.type === NotificationType.INCOME_SHORTFALL),
    );

    if (criticalAlerts.length > 0) {
      const sent = await this.sendImmediateAlertEmail(
        budget.userId,
        criticalAlerts,
      );
      if (sent) {
        emailsSent = 1;
        for (const alert of criticalAlerts) {
          // The flag is set through the door, on that row alone. Mutating the
          // loaded entity as well would read as if the local copy mattered --
          // it is never saved, and a full-row save is what this replaced.
          await this.notifications.markEmailSent(alert.userId, alert.id);
        }
      }
    }

    return { alertsCreated: savedAlerts.length, emailsSent };
  }

  /**
   * The `title`/`message` pair is the English fallback a reader without a
   * localizing client sees (the digest email, an API consumer); the UI composes
   * its own copy from `type` + `data`. The FIGURES inside it still follow the
   * recipient's number locale, because a Polish reader misreads `zl18,812.71`
   * whatever language the sentence around it is in (issue #1316). `n` defaults
   * to the default-locale formatter so a caller with no preferences to hand
   * (a unit test) is unchanged.
   */
  checkThresholdAlerts(
    cat: CategoryActual,
    n: NumberT = defaultNumberT,
  ): AlertCandidate[] {
    const alerts: AlertCandidate[] = [];

    if (cat.percentUsed > 100) {
      alerts.push({
        budgetId: "",
        budgetCategoryId: cat.budgetCategoryId,
        type: NotificationType.OVER_BUDGET,
        severity: NotificationSeverity.CRITICAL,
        title: `${cat.categoryName} is over budget`,
        message: `You have spent ${n.formatCurrency(cat.spent, cat.currencyCode)} of your ${n.formatCurrency(cat.budgeted, cat.currencyCode)} budget for ${cat.categoryName} (${n.formatPercent(cat.percentUsed, 1)}).`,
        data: {
          categoryName: cat.categoryName,
          percent: cat.percentUsed,
          amount: cat.spent,
          limit: cat.budgeted,
        },
      });
    } else if (cat.percentUsed >= cat.alertCriticalPercent) {
      alerts.push({
        budgetId: "",
        budgetCategoryId: cat.budgetCategoryId,
        type: NotificationType.THRESHOLD_CRITICAL,
        severity: NotificationSeverity.WARNING,
        title: `${cat.categoryName} approaching limit`,
        message: `You have used ${n.formatPercent(cat.percentUsed, 1)} of your ${cat.categoryName} budget (${n.formatCurrency(cat.spent, cat.currencyCode)} of ${n.formatCurrency(cat.budgeted, cat.currencyCode)}).`,
        data: {
          categoryName: cat.categoryName,
          percent: cat.percentUsed,
          amount: cat.spent,
          limit: cat.budgeted,
          threshold: cat.alertCriticalPercent,
        },
      });
    } else if (cat.percentUsed >= cat.alertWarnPercent) {
      alerts.push({
        budgetId: "",
        budgetCategoryId: cat.budgetCategoryId,
        type: NotificationType.THRESHOLD_WARNING,
        severity: NotificationSeverity.WARNING,
        title: `${cat.categoryName} reaching budget limit`,
        message: `You have used ${n.formatPercent(cat.percentUsed, 1)} of your ${cat.categoryName} budget (${n.formatCurrency(cat.spent, cat.currencyCode)} of ${n.formatCurrency(cat.budgeted, cat.currencyCode)}).`,
        data: {
          categoryName: cat.categoryName,
          percent: cat.percentUsed,
          amount: cat.spent,
          limit: cat.budgeted,
          threshold: cat.alertWarnPercent,
        },
      });
    }

    return alerts;
  }

  checkVelocityAlert(
    cat: CategoryActual,
    daysElapsed: number,
    totalDays: number,
    n: NumberT = defaultNumberT,
  ): AlertCandidate | null {
    const dailyRate = cat.spent / daysElapsed;
    const projectedTotal = dailyRate * totalDays;
    const projectedPercent = (projectedTotal / cat.budgeted) * 100;

    if (projectedPercent > 110 && cat.percentUsed < 100) {
      return {
        budgetId: "",
        budgetCategoryId: cat.budgetCategoryId,
        type: NotificationType.PROJECTED_OVERSPEND,
        severity: NotificationSeverity.WARNING,
        title: `${cat.categoryName} projected to overspend`,
        message: `At your current pace, ${cat.categoryName} is projected to reach ${n.formatCurrency(projectedTotal, cat.currencyCode)} by the end of the period (budget: ${n.formatCurrency(cat.budgeted, cat.currencyCode)}).`,
        data: {
          categoryName: cat.categoryName,
          projectedTotal: roundMoney(projectedTotal),
          budgeted: cat.budgeted,
          dailyRate: roundMoney(dailyRate),
          projectedPercent: Math.round(projectedPercent * 10) / 10,
        },
      };
    }

    return null;
  }

  checkFlexGroupAlerts(
    actuals: CategoryActual[],
    n: NumberT = defaultNumberT,
  ): AlertCandidate[] {
    const alerts: AlertCandidate[] = [];
    const flexGroups = new Map<
      string,
      { totalBudgeted: number; totalSpent: number; currencyCode: string }
    >();

    for (const cat of actuals) {
      if (!cat.flexGroup) continue;

      const group = flexGroups.get(cat.flexGroup) || {
        totalBudgeted: 0,
        totalSpent: 0,
        currencyCode: cat.currencyCode,
      };
      group.totalBudgeted += cat.budgeted;
      group.totalSpent += cat.spent;
      flexGroups.set(cat.flexGroup, group);
    }

    for (const [groupName, group] of flexGroups) {
      if (group.totalBudgeted <= 0) continue;

      const groupPercent = (group.totalSpent / group.totalBudgeted) * 100;
      if (groupPercent >= 90) {
        alerts.push({
          budgetId: "",
          budgetCategoryId: null,
          type: NotificationType.FLEX_GROUP_WARNING,
          severity: NotificationSeverity.WARNING,
          title: `Flex group "${groupName}" at ${n.formatPercent(groupPercent, 0)}`,
          message: `The "${groupName}" flex group has used ${n.formatCurrency(group.totalSpent, group.currencyCode)} of its combined ${n.formatCurrency(group.totalBudgeted, group.currencyCode)} budget (${n.formatPercent(groupPercent, 1)}).`,
          data: {
            flexGroup: groupName,
            totalBudgeted: group.totalBudgeted,
            totalSpent: group.totalSpent,
            percent: Math.round(groupPercent * 10) / 10,
          },
        });
      }
    }

    return alerts;
  }

  checkIncomeShortfall(
    incomeActuals: CategoryActual[],
    expectedIncome: number,
    periodProgress: number,
    n: NumberT = defaultNumberT,
  ): AlertCandidate | null {
    if (periodProgress < 0.5) return null;

    const totalActualIncome = sumMoney(incomeActuals.map((cat) => cat.spent));
    const expectedSoFar = expectedIncome * periodProgress;
    const incomeRatio = totalActualIncome / expectedSoFar;

    if (incomeRatio < 0.8) {
      return {
        budgetId: "",
        budgetCategoryId: null,
        type: NotificationType.INCOME_SHORTFALL,
        severity: NotificationSeverity.CRITICAL,
        title: "Income below expected",
        message: `Your actual income (${n.formatCurrency(
          totalActualIncome,
          incomeActuals[0]?.currencyCode || FALLBACK_DEFAULT_CURRENCY,
        )}) is below ${n.formatPercent(Math.round(incomeRatio * 100), 0)} of expected income (${n.formatCurrency(
          expectedSoFar,
          incomeActuals[0]?.currencyCode || FALLBACK_DEFAULT_CURRENCY,
        )}) at this point in the period.`,
        data: {
          actualIncome: totalActualIncome,
          expectedIncome: expectedSoFar,
          fullPeriodExpected: expectedIncome,
          ratio: Math.round(incomeRatio * 100),
        },
      };
    }

    return null;
  }

  checkPositiveMilestones(
    actuals: CategoryActual[],
    periodProgress: number,
    daysRemaining: number,
    n: NumberT = defaultNumberT,
  ): AlertCandidate[] {
    if (periodProgress < 0.5 || daysRemaining <= 0) return [];

    const totalBudgeted = sumMoney(actuals.map((c) => c.budgeted));
    const totalSpent = sumMoney(actuals.map((c) => c.spent));

    if (totalBudgeted <= 0) return [];

    const overallPercent = (totalSpent / totalBudgeted) * 100;

    if (overallPercent < 60) {
      return [
        {
          budgetId: "",
          budgetCategoryId: null,
          type: NotificationType.POSITIVE_MILESTONE,
          severity: NotificationSeverity.SUCCESS,
          title: "Budget on track",
          message: `You are ${n.formatPercent(Math.round(periodProgress * 100), 0)} through the period and have only used ${n.formatPercent(overallPercent, 1)} of your total budget. Keep it up!`,
          data: {
            periodProgress: Math.round(periodProgress * 100),
            percentUsed: Math.round(overallPercent * 10) / 10,
            totalBudgeted,
            totalSpent,
            daysRemaining,
          },
        },
      ];
    }

    return [];
  }

  deduplicateAlerts(
    candidates: AlertCandidate[],
    existing: Notification[],
  ): AlertCandidate[] {
    // M25: Allow severity escalation (e.g., WARNING -> CRITICAL)
    const severityRank: Record<string, number> = {
      info: 0,
      success: 0,
      warning: 1,
      critical: 2,
    };

    // The same key as `idx_notifications_fingerprint`: a flex-group warning is
    // budget-wide (no category), so the group in `data` is what tells two of
    // them apart (audit A26-L39).
    const flexGroupOf = (data: Record<string, unknown> | null | undefined) =>
      typeof data?.flexGroup === "string" ? data.flexGroup : "";
    return candidates.filter((candidate) => {
      const match = existing.find(
        (e) =>
          e.type === candidate.type &&
          e.budgetCategoryId === candidate.budgetCategoryId &&
          flexGroupOf(e.data) === flexGroupOf(candidate.data),
      );
      if (!match) return true;
      // Allow if candidate severity is higher than existing
      return (
        (severityRank[candidate.severity] || 0) >
        (severityRank[match.severity] || 0)
      );
    });
  }

  private async sendImmediateAlertEmail(
    userId: string,
    alerts: Notification[],
  ): Promise<boolean> {
    if (!this.emailService.getStatus().configured) return false;

    try {
      // A budget alert is the BUDGETS category; email is gated by that channel
      // matrix and the global email master switch together (the resolver reads
      // both). Runs under the user's own withUserContext.
      const emailEnabled = await this.notificationPreferences.resolveEmail(
        userId,
        NotificationCategory.BUDGETS,
      );
      if (!emailEnabled) return false;

      // The user's stored locale for the alert copy, composed off-request.
      const prefs = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(UserPreference).findOne({
          where: { userId },
        }),
      );

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

      const lang = prefs?.language || DEFAULT_LOCALE;
      const t = emailTranslator(this.i18n, lang);
      const alertData = alerts.map((a) => ({
        // The figures follow the recipient's own `numberFormat`, which is
        // independent of `lang` (issue #1316); `prefs` is the row `lang` came
        // from, so this costs no extra read.
        ...notificationEmailCopy(a, t, lang, {
          numberFormat: prefs?.numberFormat,
        }),
        severity: a.severity,
        categoryName: (a.data?.categoryName as string) || "",
      }));

      const html = budgetAlertImmediateTemplate(
        user.firstName || "",
        alertData,
        appUrl,
        t,
      );

      const subject =
        alerts.length === 1
          ? t(
              "emails.budgetAlertImmediate.subject",
              `Monize: Alert - ${alertData[0].title}`,
              { title: alertData[0].title },
            )
          : t(
              "emails.budgetAlertImmediate.subjectPlural",
              `Monize: ${alerts.length} alerts need attention`,
              { count: alerts.length },
            );

      await this.emailService.sendMail(user.email, subject, html);
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to send immediate budget alert email to user ${userId}`,
        error instanceof Error ? error.stack : error,
      );
      return false;
    }
  }

  private async sendDigestForUser(
    userId: string,
    budgets: Budget[],
    runDate: string,
  ): Promise<boolean> {
    const prefs = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({
        where: { userId },
      }),
    );
    const emailEnabled = await this.notificationPreferences.resolveEmail(
      userId,
      NotificationCategory.BUDGETS,
    );
    if (!emailEnabled) return false;
    // The digest has its own toggle beyond the channel matrix.
    if (prefs && prefs.budgetDigestEnabled === false) return false;

    const user = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(User).findOne({
        where: { id: userId },
      }),
    );
    if (!user || !user.email) return false;

    const { periodStart } = this.getCurrentPeriodDates();

    const allRecentAlerts = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Notification).find({
        where: {
          userId,
          periodStart,
          // Budget news, selected POSITIVELY: the budget types plus BILL_DUE.
          // Two exclusions came before this and both leaked. `dedupe_key IS
          // NULL` assumed only a system alert carries a key, and stopped
          // holding the day BILL_DUE rows gained an occurrence key -- every
          // bill-due row silently left the digest. `type NOT IN the system
          // set` let SCHEDULED_POST_FAILED (a PAYMENTS type, deliberately not
          // system) raised on the FIRST of a month -- whose `period_start` is
          // that day, also the budget period start -- render inside the budget
          // digest for the rest of the month. Naming what belongs cannot leak
          // a type nobody thought of.
          type: In(DIGEST_TYPES),
        },
        order: { createdAt: "DESC" },
        take: 20,
      }),
    );

    const budgetNews = allRecentAlerts.filter((a) => !isReminderReEmit(a));
    if (budgetNews.length === 0) return false;

    // Filter out BILL_DUE alerts for bills already paid ahead of time
    const billAlerts = budgetNews.filter(
      (a) => a.type === NotificationType.BILL_DUE,
    );
    const paidBillIds = new Set<string>();
    if (billAlerts.length > 0) {
      const billIds = billAlerts
        .map((a) => (a.data as Record<string, unknown>)?.billId as string)
        .filter(Boolean);
      if (billIds.length > 0) {
        const bills = await withScopedDb(this.dataSource, (m) =>
          m
            .getRepository(ScheduledTransaction)
            .createQueryBuilder("st")
            .where("st.id IN (:...billIds)", { billIds })
            .getMany(),
        );
        for (const bill of bills) {
          const alertForBill = billAlerts.find(
            (a) => (a.data as Record<string, unknown>)?.billId === bill.id,
          );
          if (!alertForBill) continue;
          const alertData = alertForBill.data as Record<string, unknown>;
          // "Has the schedule moved past this occurrence" is a question about the
          // occurrence's SLOT, not about the day it was announced for: an
          // override can move an occurrence EARLIER, and comparing `nextDueDate`
          // against the moved date then reads an unposted bill as already paid
          // and drops it from the digest (issue #1247). `originalDate` is the
          // slot; rows written before it was recorded fall back to the announced
          // date, which is what they were compared against before.
          const alertSlot =
            (alertData?.originalDate as string) ||
            (alertData?.dueDate as string);
          if (
            alertSlot &&
            bill.nextDueDate &&
            String(bill.nextDueDate) > alertSlot
          ) {
            paidBillIds.add(bill.id);
          }
        }
      }
    }

    const recentAlerts = budgetNews.filter((a) => {
      if (a.type !== NotificationType.BILL_DUE) return true;
      const billId = (a.data as Record<string, unknown>)?.billId as string;
      return !paidBillIds.has(billId);
    });

    if (recentAlerts.length === 0) return false;

    const appUrl = this.configService.get<string>(
      "PUBLIC_APP_URL",
      "http://localhost:3000",
    );

    const lang = prefs?.language || DEFAULT_LOCALE;
    const t = emailTranslator(this.i18n, lang);
    const alertData = recentAlerts.map((a) => ({
      ...notificationEmailCopy(a, t, lang, {
        numberFormat: prefs?.numberFormat,
      }),
      severity: a.severity,
      categoryName: (a.data?.categoryName as string) || "",
    }));

    const budgetNames = budgets.map((b) => b.name);

    const html = budgetWeeklyDigestTemplate(
      user.firstName || "",
      alertData,
      budgetNames,
      appUrl,
      t,
    );

    const subject = t(
      "emails.budgetWeeklyDigest.subject",
      "Monize: Your weekly budget summary",
    );

    // Claim this user's digest for the run date before anything leaves the
    // process.
    //
    // Every backend replica fires this cron (docs/cron-jobs.md), and nothing
    // here claimed or recorded the send -- so with N replicas each user got N
    // copies of the Monday digest. Not a rare race: the normal outcome of
    // running more than one replica.
    //
    // A **lease** plus a durable **delivery record**, not `claimOnce`. A
    // permanent claim taken before the send is the only record that the send
    // was owed, so a replica killed in between would leave a row every later
    // run reads as "already handled" and the digest would silently never go
    // out. The lease is the exclusion for one send; `delivered_at`, written
    // after the send and re-read here, is what says it was done.
    //
    // The contract is at-least-once: a process killed after the SMTP server
    // accepted but before the record committed re-sends next run. For a weekly
    // summary that is the right trade.
    const leaseToken = await this.jobClaims.claimLease(
      JobClaimType.BudgetWeeklyDigest,
      userId,
      runDate,
      DIGEST_LEASE_MS,
    );
    if (!leaseToken) {
      // Another replica holds this user's digest for today.
      return false;
    }
    if (
      await this.jobClaims.wasDelivered(
        JobClaimType.BudgetWeeklyDigest,
        userId,
        runDate,
      )
    ) {
      // Already sent, durably. Hand the lease back rather than holding it for
      // its whole TTL.
      await this.jobClaims.releaseLease(
        JobClaimType.BudgetWeeklyDigest,
        userId,
        runDate,
        leaseToken,
      );
      return false;
    }

    try {
      await this.emailService.sendMail(user.email, subject, html);
      // The delivery record, after the side effect and never before it.
      await this.jobClaims.markDelivered(
        JobClaimType.BudgetWeeklyDigest,
        userId,
        runDate,
        leaseToken,
      );
      return true;
    } catch (error) {
      // Hand the lease back so a transient SMTP outage costs a retry rather
      // than the user's week. A failed release must not mask the send error,
      // which the caller logs per user; the lease then simply expires.
      await this.jobClaims
        .releaseLease(
          JobClaimType.BudgetWeeklyDigest,
          userId,
          runDate,
          leaseToken,
        )
        .catch(() => undefined);
      throw error;
    }
  }

  async checkSeasonalSpikes(
    userId: string,
    budget: Budget,
    n: NumberT = defaultNumberT,
  ): Promise<AlertCandidate[]> {
    const categories = (budget.categories || []).filter(
      (bc) => !bc.isIncome && bc.categoryId !== null && !bc.isTransfer,
    );

    if (categories.length === 0) return [];

    const categoryIds = categories.map((bc) => bc.categoryId as string);

    const profiles = await this.buildSeasonalProfiles(
      userId,
      categories,
      categoryIds,
    );

    if (profiles.length === 0) return [];

    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const nextMonthNum = nextMonth.getMonth() + 1;

    const alerts: AlertCandidate[] = [];

    for (const profile of profiles) {
      if (
        profile.highMonths.includes(nextMonthNum) &&
        profile.typicalIncrease >= 1.5
      ) {
        const monthName = this.getMonthName(nextMonthNum);
        alerts.push({
          budgetId: "",
          budgetCategoryId: profile.budgetCategoryId,
          type: NotificationType.SEASONAL_SPIKE,
          severity: NotificationSeverity.INFO,
          title: `Seasonal spike expected for ${profile.categoryName}`,
          message: `Last ${monthName} you spent ${n.formatNumber(profile.typicalIncrease, 1)}x your usual on ${profile.categoryName}. Consider adjusting your budget.`,
          data: {
            categoryName: profile.categoryName,
            highMonth: nextMonthNum,
            highMonthName: monthName,
            typicalMonthlySpend: profile.typicalMonthlySpend,
            typicalIncrease: profile.typicalIncrease,
            suggestedBudget: roundMoney(
              profile.typicalMonthlySpend * profile.typicalIncrease,
            ),
          },
        });
      }
    }

    return alerts;
  }

  private async buildSeasonalProfiles(
    userId: string,
    categories: Array<{
      id: string;
      categoryId: string | null;
      category: any;
    }>,
    categoryIds: string[],
  ): Promise<SeasonalProfile[]> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 12);
    const startStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-01`;
    const endStr = getMonthEndYMD(
      endDate.getFullYear(),
      endDate.getMonth() + 1,
    );

    const directSpending = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .select("t.category_id", "categoryId")
        .addSelect("EXTRACT(MONTH FROM t.transaction_date)::int", "month")
        .addSelect("COALESCE(ABS(SUM(t.amount)), 0)", "total")
        .where("t.user_id = :userId", { userId })
        .andWhere("t.category_id IN (:...categoryIds)", { categoryIds })
        .andWhere("t.transaction_date >= :startStr", { startStr })
        .andWhere("t.transaction_date <= :endStr", { endStr })
        .andWhere("t.status != :void", { void: "VOID" })
        .andWhere("t.is_split = false")
        .groupBy("t.category_id")
        .addGroupBy("EXTRACT(MONTH FROM t.transaction_date)")
        .getRawMany(),
    );

    const splitSpending = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(TransactionSplit)
        .createQueryBuilder("s")
        .innerJoin("s.transaction", "t")
        .select("s.category_id", "categoryId")
        .addSelect("EXTRACT(MONTH FROM t.transaction_date)::int", "month")
        .addSelect("COALESCE(ABS(SUM(s.amount)), 0)", "total")
        .where("t.user_id = :userId", { userId })
        .andWhere("s.category_id IN (:...categoryIds)", { categoryIds })
        .andWhere("t.transaction_date >= :startStr", { startStr })
        .andWhere("t.transaction_date <= :endStr", { endStr })
        .andWhere("t.status != :void", { void: "VOID" })
        .groupBy("s.category_id")
        .addGroupBy("EXTRACT(MONTH FROM t.transaction_date)")
        .getRawMany(),
    );

    const spendingMap = new Map<string, Map<number, number>>();

    for (const row of [...directSpending, ...splitSpending]) {
      const catId = row.categoryId as string;
      const month = Number(row.month);
      const total = parseFloat(row.total || "0");

      if (!spendingMap.has(catId)) {
        spendingMap.set(catId, new Map());
      }
      const monthMap = spendingMap.get(catId)!;
      monthMap.set(month, (monthMap.get(month) || 0) + total);
    }

    const categoryNameMap = new Map<string, { name: string; bcId: string }>();
    for (const bc of categories) {
      if (bc.categoryId) {
        const cat = bc.category;
        const name = cat
          ? cat.parent
            ? `${cat.parent.name}: ${cat.name}`
            : cat.name
          : "Uncategorized";
        categoryNameMap.set(bc.categoryId, { name, bcId: bc.id });
      }
    }

    const profiles: SeasonalProfile[] = [];

    for (const [catId, monthMap] of spendingMap.entries()) {
      const amounts: number[] = [];
      for (let m = 1; m <= 12; m++) {
        amounts.push(monthMap.get(m) || 0);
      }

      const nonZero = amounts.filter((a) => a > 0);
      if (nonZero.length < 3) continue;

      const mean = sumMoney(nonZero) / nonZero.length;
      const stdDev = this.standardDeviation(nonZero);
      const threshold = mean + 1.5 * stdDev;

      const highMonths: number[] = [];
      let maxIncrease = 0;

      for (let i = 0; i < 12; i++) {
        if (amounts[i] > threshold) {
          highMonths.push(i + 1);
          const increase = mean > 0 ? amounts[i] / mean : 0;
          if (increase > maxIncrease) maxIncrease = increase;
        }
      }

      if (highMonths.length === 0) continue;

      const info = categoryNameMap.get(catId);
      if (!info) continue;

      profiles.push({
        budgetCategoryId: info.bcId,
        categoryId: catId,
        categoryName: info.name,
        highMonths,
        typicalMonthlySpend: roundMoney(mean),
        typicalIncrease: Math.round(maxIncrease * 10) / 10,
      });
    }

    return profiles;
  }

  private standardDeviation(values: number[]): number {
    if (values.length <= 1) return 0;
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    const squaredDiffs = values.map((v) => (v - avg) ** 2);
    const variance = squaredDiffs.reduce((s, v) => s + v, 0) / values.length;
    return Math.sqrt(variance);
  }

  private getMonthName(month: number): string {
    const names = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    return names[month - 1] || "";
  }

  getCurrentPeriodDates(): PeriodDateRange {
    return getCurrentMonthPeriodDates();
  }

  private async computeCategoryActuals(
    userId: string,
    budget: Budget,
    periodStart: string,
    periodEnd: string,
  ): Promise<CategoryActual[]> {
    const budgetCategories = budget.categories || [];

    if (budgetCategories.length === 0) {
      return [];
    }

    // The two spending queries share one scoped transaction so the direct and
    // split halves of a category's total come from the same snapshot.
    const { spendingMap, transferSpendingMap } = await withScopedDb(
      this.dataSource,
      (m) =>
        queryCategorySpending(
          m.getRepository(Transaction),
          m.getRepository(TransactionSplit),
          userId,
          budgetCategories,
          periodStart,
          periodEnd,
          budget.currencyCode,
        ),
    );

    return budgetCategories.map((bc) => {
      const budgeted = Number(bc.amount);
      const spent = resolveCategorySpent(bc, spendingMap, transferSpendingMap);
      const categoryName = resolveCategoryName(bc);
      const percentUsed =
        budgeted > 0 ? Math.round((spent / budgeted) * 10000) / 100 : 0;

      return {
        budgetCategoryId: bc.id,
        categoryId: bc.categoryId,
        categoryName,
        currencyCode: budget.currencyCode,
        budgeted,
        spent,
        percentUsed,
        isIncome: bc.isIncome,
        alertWarnPercent: bc.alertWarnPercent,
        alertCriticalPercent: bc.alertCriticalPercent,
        flexGroup: bc.flexGroup,
      };
    });
  }
}
