import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { Budget } from "./entities/budget.entity";
import {
  BudgetAlert,
  AlertType,
  AlertSeverity,
} from "./entities/budget-alert.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { EmailService } from "../notifications/email.service";
import {
  budgetAlertImmediateTemplate,
  budgetWeeklyDigestTemplate,
} from "../notifications/email-templates";
import {
  getCurrentMonthPeriodDates,
  PeriodDateRange,
} from "./budget-date.utils";

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
  alertType: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  data: Record<string, unknown>;
}

@Injectable()
export class BudgetAlertService {
  private readonly logger = new Logger(BudgetAlertService.name);

  constructor(
    @InjectRepository(Budget)
    private budgetsRepository: Repository<Budget>,
    @InjectRepository(BudgetAlert)
    private alertsRepository: Repository<BudgetAlert>,
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(TransactionSplit)
    private splitsRepository: Repository<TransactionSplit>,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(UserPreference)
    private preferencesRepository: Repository<UserPreference>,
    private emailService: EmailService,
    private configService: ConfigService,
  ) {}

  @Cron("0 7 * * *")
  async checkBudgetAlerts(): Promise<void> {
    this.logger.log("Running daily budget alert check...");

    try {
      const activeBudgets = await this.budgetsRepository.find({
        where: { isActive: true },
        relations: [
          "categories",
          "categories.category",
          "categories.category.parent",
          "categories.transferAccount",
        ],
      });

      if (activeBudgets.length === 0) {
        this.logger.log("No active budgets found");
        return;
      }

      let alertsCreated = 0;
      let emailsSent = 0;

      for (const budget of activeBudgets) {
        try {
          const result = await this.processAlerts(budget);
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
      const activeBudgets = await this.budgetsRepository.find({
        where: { isActive: true },
        relations: [
          "categories",
          "categories.category",
          "categories.category.parent",
          "categories.transferAccount",
        ],
      });

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

      let sentCount = 0;
      let skipCount = 0;

      for (const [userId, userBudgets] of budgetsByUser) {
        try {
          const sent = await this.sendDigestForUser(userId, userBudgets);
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

    const today = new Date();
    const startDate = new Date(periodStart);
    const endDate = new Date(periodEnd);
    const totalDays = Math.ceil(
      (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
    );
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

      const alerts = this.checkThresholdAlerts(cat);
      candidates.push(...alerts.map((a) => ({ ...a, budgetId: budget.id })));
    }

    // 2. Velocity / projected overspend alerts per category
    for (const cat of expenseActuals) {
      if (cat.budgeted <= 0 || daysElapsed < 3) continue;

      const velocityAlert = this.checkVelocityAlert(
        cat,
        daysElapsed,
        totalDays,
      );
      if (velocityAlert) {
        candidates.push({ ...velocityAlert, budgetId: budget.id });
      }
    }

    // 3. Flex group alerts
    const flexAlerts = this.checkFlexGroupAlerts(expenseActuals);
    candidates.push(...flexAlerts.map((a) => ({ ...a, budgetId: budget.id })));

    // 4. Income shortfall (income-linked budgets)
    if (budget.incomeLinked && budget.baseIncome) {
      const incomeAlert = this.checkIncomeShortfall(
        incomeActuals,
        budget.baseIncome,
        periodProgress,
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
    );
    candidates.push(
      ...milestoneAlerts.map((a) => ({ ...a, budgetId: budget.id })),
    );

    // 6. Seasonal spike warnings
    try {
      const seasonalAlerts = await this.checkSeasonalSpikes(
        budget.userId,
        budget,
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
    const existingAlerts = await this.alertsRepository.find({
      where: {
        budgetId: budget.id,
        periodStart,
      },
    });

    const newCandidates = this.deduplicateAlerts(candidates, existingAlerts);

    if (newCandidates.length === 0) {
      return { alertsCreated: 0, emailsSent: 0 };
    }

    // Save new alerts
    const savedAlerts: BudgetAlert[] = [];
    for (const candidate of newCandidates) {
      const alert = this.alertsRepository.create({
        userId: budget.userId,
        budgetId: candidate.budgetId,
        budgetCategoryId: candidate.budgetCategoryId,
        alertType: candidate.alertType,
        severity: candidate.severity,
        title: candidate.title,
        message: candidate.message,
        data: candidate.data,
        periodStart,
      });
      savedAlerts.push(await this.alertsRepository.save(alert));
    }

    // Send immediate emails for critical alerts
    let emailsSent = 0;
    const criticalAlerts = savedAlerts.filter(
      (a) =>
        a.severity === AlertSeverity.CRITICAL &&
        (a.alertType === AlertType.THRESHOLD_CRITICAL ||
          a.alertType === AlertType.OVER_BUDGET ||
          a.alertType === AlertType.INCOME_SHORTFALL),
    );

    if (criticalAlerts.length > 0) {
      const sent = await this.sendImmediateAlertEmail(
        budget.userId,
        criticalAlerts,
      );
      if (sent) {
        emailsSent = 1;
        for (const alert of criticalAlerts) {
          alert.isEmailSent = true;
          await this.alertsRepository.save(alert);
        }
      }
    }

    return { alertsCreated: savedAlerts.length, emailsSent };
  }

  checkThresholdAlerts(cat: CategoryActual): AlertCandidate[] {
    const alerts: AlertCandidate[] = [];

    if (cat.percentUsed >= 100) {
      alerts.push({
        budgetId: "",
        budgetCategoryId: cat.budgetCategoryId,
        alertType: AlertType.OVER_BUDGET,
        severity: AlertSeverity.CRITICAL,
        title: `${cat.categoryName} is over budget`,
        message: `You have spent $${cat.spent.toFixed(2)} of your $${cat.budgeted.toFixed(2)} budget for ${cat.categoryName} (${cat.percentUsed.toFixed(1)}%).`,
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
        alertType: AlertType.THRESHOLD_CRITICAL,
        severity: AlertSeverity.CRITICAL,
        title: `${cat.categoryName} approaching limit`,
        message: `You have used ${cat.percentUsed.toFixed(1)}% of your ${cat.categoryName} budget ($${cat.spent.toFixed(2)} of $${cat.budgeted.toFixed(2)}).`,
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
        alertType: AlertType.THRESHOLD_WARNING,
        severity: AlertSeverity.WARNING,
        title: `${cat.categoryName} reaching budget limit`,
        message: `You have used ${cat.percentUsed.toFixed(1)}% of your ${cat.categoryName} budget ($${cat.spent.toFixed(2)} of $${cat.budgeted.toFixed(2)}).`,
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
  ): AlertCandidate | null {
    const dailyRate = cat.spent / daysElapsed;
    const projectedTotal = dailyRate * totalDays;
    const projectedPercent = (projectedTotal / cat.budgeted) * 100;

    if (projectedPercent > 110 && cat.percentUsed < 100) {
      return {
        budgetId: "",
        budgetCategoryId: cat.budgetCategoryId,
        alertType: AlertType.PROJECTED_OVERSPEND,
        severity: AlertSeverity.WARNING,
        title: `${cat.categoryName} projected to overspend`,
        message: `At your current pace, ${cat.categoryName} is projected to reach $${projectedTotal.toFixed(2)} by the end of the period (budget: $${cat.budgeted.toFixed(2)}).`,
        data: {
          categoryName: cat.categoryName,
          projectedTotal: Math.round(projectedTotal * 100) / 100,
          budgeted: cat.budgeted,
          dailyRate: Math.round(dailyRate * 100) / 100,
          projectedPercent: Math.round(projectedPercent * 10) / 10,
        },
      };
    }

    return null;
  }

  checkFlexGroupAlerts(actuals: CategoryActual[]): AlertCandidate[] {
    const alerts: AlertCandidate[] = [];
    const flexGroups = new Map<
      string,
      { totalBudgeted: number; totalSpent: number }
    >();

    for (const cat of actuals) {
      if (!cat.flexGroup) continue;

      const group = flexGroups.get(cat.flexGroup) || {
        totalBudgeted: 0,
        totalSpent: 0,
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
          alertType: AlertType.FLEX_GROUP_WARNING,
          severity: AlertSeverity.WARNING,
          title: `Flex group "${groupName}" at ${groupPercent.toFixed(0)}%`,
          message: `The "${groupName}" flex group has used $${group.totalSpent.toFixed(2)} of its combined $${group.totalBudgeted.toFixed(2)} budget (${groupPercent.toFixed(1)}%).`,
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
  ): AlertCandidate | null {
    if (periodProgress < 0.5) return null;

    const totalActualIncome = incomeActuals.reduce(
      (sum, cat) => sum + cat.spent,
      0,
    );
    const expectedSoFar = expectedIncome * periodProgress;
    const incomeRatio = totalActualIncome / expectedSoFar;

    if (incomeRatio < 0.8) {
      return {
        budgetId: "",
        budgetCategoryId: null,
        alertType: AlertType.INCOME_SHORTFALL,
        severity: AlertSeverity.CRITICAL,
        title: "Income below expected",
        message: `Your actual income ($${totalActualIncome.toFixed(2)}) is below ${Math.round(incomeRatio * 100)}% of expected income ($${expectedSoFar.toFixed(2)}) at this point in the period.`,
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
  ): AlertCandidate[] {
    if (periodProgress < 0.5 || daysRemaining <= 0) return [];

    const totalBudgeted = actuals.reduce((sum, c) => sum + c.budgeted, 0);
    const totalSpent = actuals.reduce((sum, c) => sum + c.spent, 0);

    if (totalBudgeted <= 0) return [];

    const overallPercent = (totalSpent / totalBudgeted) * 100;

    if (overallPercent < 60) {
      return [
        {
          budgetId: "",
          budgetCategoryId: null,
          alertType: AlertType.POSITIVE_MILESTONE,
          severity: AlertSeverity.SUCCESS,
          title: "Budget on track",
          message: `You are ${Math.round(periodProgress * 100)}% through the period and have only used ${overallPercent.toFixed(1)}% of your total budget. Keep it up!`,
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
    existing: BudgetAlert[],
  ): AlertCandidate[] {
    return candidates.filter((candidate) => {
      return !existing.some(
        (e) =>
          e.alertType === candidate.alertType &&
          e.budgetCategoryId === candidate.budgetCategoryId,
      );
    });
  }

  private async sendImmediateAlertEmail(
    userId: string,
    alerts: BudgetAlert[],
  ): Promise<boolean> {
    if (!this.emailService.getStatus().configured) return false;

    try {
      const prefs = await this.preferencesRepository.findOne({
        where: { userId },
      });
      if (prefs && !prefs.notificationEmail) return false;

      const user = await this.usersRepository.findOne({
        where: { id: userId },
      });
      if (!user || !user.email) return false;

      const appUrl = this.configService.get<string>(
        "PUBLIC_APP_URL",
        "http://localhost:3000",
      );

      const alertData = alerts.map((a) => ({
        title: a.title,
        message: a.message,
        severity: a.severity,
        categoryName: (a.data?.categoryName as string) || "",
      }));

      const html = budgetAlertImmediateTemplate(
        user.firstName || "",
        alertData,
        appUrl,
      );

      const subject =
        alerts.length === 1
          ? `Monize: Alert - ${alerts[0].title}`
          : `Monize: ${alerts.length} alerts need attention`;

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
  ): Promise<boolean> {
    const prefs = await this.preferencesRepository.findOne({
      where: { userId },
    });
    if (prefs && !prefs.notificationEmail) return false;
    if (prefs && prefs.budgetDigestEnabled === false) return false;

    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });
    if (!user || !user.email) return false;

    const { periodStart } = this.getCurrentPeriodDates();

    const recentAlerts = await this.alertsRepository.find({
      where: {
        userId,
        periodStart,
      },
      order: { createdAt: "DESC" },
      take: 20,
    });

    if (recentAlerts.length === 0) return false;

    const appUrl = this.configService.get<string>(
      "PUBLIC_APP_URL",
      "http://localhost:3000",
    );

    const alertData = recentAlerts.map((a) => ({
      title: a.title,
      message: a.message,
      severity: a.severity,
      categoryName: (a.data?.categoryName as string) || "",
    }));

    const budgetNames = budgets.map((b) => b.name);

    const html = budgetWeeklyDigestTemplate(
      user.firstName || "",
      alertData,
      budgetNames,
      appUrl,
    );

    const subject = "Monize: Your weekly budget summary";
    await this.emailService.sendMail(user.email, subject, html);
    return true;
  }

  async checkSeasonalSpikes(
    userId: string,
    budget: Budget,
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
          alertType: AlertType.SEASONAL_SPIKE,
          severity: AlertSeverity.INFO,
          title: `Seasonal spike expected for ${profile.categoryName}`,
          message: `Last ${monthName} you spent ${profile.typicalIncrease.toFixed(1)}x your usual on ${profile.categoryName}. Consider adjusting your budget.`,
          data: {
            categoryName: profile.categoryName,
            highMonth: nextMonthNum,
            highMonthName: monthName,
            typicalMonthlySpend: profile.typicalMonthlySpend,
            typicalIncrease: profile.typicalIncrease,
            suggestedBudget:
              Math.round(
                profile.typicalMonthlySpend * profile.typicalIncrease * 100,
              ) / 100,
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
    const endStr = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, "0")}-${String(new Date(endDate.getFullYear(), endDate.getMonth() + 1, 0).getDate()).padStart(2, "0")}`;

    const directSpending = await this.transactionsRepository
      .createQueryBuilder("t")
      .select("t.category_id", "categoryId")
      .addSelect("EXTRACT(MONTH FROM t.transaction_date)::int", "month")
      .addSelect("COALESCE(SUM(ABS(t.amount)), 0)", "total")
      .where("t.user_id = :userId", { userId })
      .andWhere("t.category_id IN (:...categoryIds)", { categoryIds })
      .andWhere("t.transaction_date >= :startStr", { startStr })
      .andWhere("t.transaction_date <= :endStr", { endStr })
      .andWhere("t.status != :void", { void: "VOID" })
      .andWhere("t.is_split = false")
      .groupBy("t.category_id")
      .addGroupBy("EXTRACT(MONTH FROM t.transaction_date)")
      .getRawMany();

    const splitSpending = await this.splitsRepository
      .createQueryBuilder("s")
      .innerJoin("s.transaction", "t")
      .select("s.category_id", "categoryId")
      .addSelect("EXTRACT(MONTH FROM t.transaction_date)::int", "month")
      .addSelect("COALESCE(SUM(ABS(s.amount)), 0)", "total")
      .where("t.user_id = :userId", { userId })
      .andWhere("s.category_id IN (:...categoryIds)", { categoryIds })
      .andWhere("t.transaction_date >= :startStr", { startStr })
      .andWhere("t.transaction_date <= :endStr", { endStr })
      .andWhere("t.status != :void", { void: "VOID" })
      .groupBy("s.category_id")
      .addGroupBy("EXTRACT(MONTH FROM t.transaction_date)")
      .getRawMany();

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
            ? `${cat.parent.name} > ${cat.name}`
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

      const mean = nonZero.reduce((s, v) => s + v, 0) / nonZero.length;
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
        typicalMonthlySpend: Math.round(mean * 100) / 100,
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

    const categoryIds = budgetCategories
      .filter((bc) => bc.categoryId !== null)
      .map((bc) => bc.categoryId as string);

    const spendingMap = new Map<string, number>();
    const transferSpendingMap = new Map<string, number>();
    const transferBudgetCategories = budgetCategories.filter(
      (bc) => bc.isTransfer && bc.transferAccountId,
    );

    // Run all independent queries in parallel
    const queries: Promise<void>[] = [];

    if (categoryIds.length > 0) {
      queries.push(
        this.transactionsRepository
          .createQueryBuilder("t")
          .select("t.category_id", "categoryId")
          .addSelect("COALESCE(SUM(ABS(t.amount)), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.category_id IN (:...categoryIds)", { categoryIds })
          .andWhere("t.transaction_date >= :periodStart", { periodStart })
          .andWhere("t.transaction_date <= :periodEnd", { periodEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .andWhere("t.is_split = false")
          .groupBy("t.category_id")
          .getRawMany()
          .then((rows) => {
            for (const row of rows) {
              spendingMap.set(row.categoryId, parseFloat(row.total || "0"));
            }
          }),
      );

      queries.push(
        this.splitsRepository
          .createQueryBuilder("s")
          .innerJoin("s.transaction", "t")
          .select("s.category_id", "categoryId")
          .addSelect("COALESCE(SUM(ABS(s.amount)), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("s.category_id IN (:...categoryIds)", { categoryIds })
          .andWhere("t.transaction_date >= :periodStart", { periodStart })
          .andWhere("t.transaction_date <= :periodEnd", { periodEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .groupBy("s.category_id")
          .getRawMany()
          .then((rows) => {
            for (const row of rows) {
              const existing = spendingMap.get(row.categoryId) || 0;
              spendingMap.set(
                row.categoryId,
                existing + parseFloat(row.total || "0"),
              );
            }
          }),
      );
    }

    if (transferBudgetCategories.length > 0) {
      const transferAccountIds = transferBudgetCategories.map(
        (bc) => bc.transferAccountId as string,
      );

      queries.push(
        this.transactionsRepository
          .createQueryBuilder("t")
          .innerJoin("t.linkedTransaction", "lt")
          .select("lt.account_id", "destinationAccountId")
          .addSelect("COALESCE(SUM(ABS(t.amount)), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.is_transfer = true")
          .andWhere("t.amount < 0")
          .andWhere("lt.account_id IN (:...transferAccountIds)", {
            transferAccountIds,
          })
          .andWhere("t.transaction_date >= :periodStart", { periodStart })
          .andWhere("t.transaction_date <= :periodEnd", { periodEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .groupBy("lt.account_id")
          .getRawMany()
          .then((rows) => {
            for (const row of rows) {
              transferSpendingMap.set(
                row.destinationAccountId,
                parseFloat(row.total || "0"),
              );
            }
          }),
      );
    }

    await Promise.all(queries);

    return budgetCategories.map((bc) => {
      const budgeted = Number(bc.amount);
      let spent = 0;
      let categoryName: string;

      if (bc.isTransfer && bc.transferAccountId) {
        spent = transferSpendingMap.get(bc.transferAccountId) || 0;
        categoryName = bc.transferAccount?.name || "Transfer";
      } else {
        spent = bc.categoryId ? spendingMap.get(bc.categoryId) || 0 : 0;
        const cat = bc.category;
        categoryName = cat
          ? cat.parent
            ? `${cat.parent.name} > ${cat.name}`
            : cat.name
          : "Uncategorized";
      }

      const percentUsed =
        budgeted > 0 ? Math.round((spent / budgeted) * 10000) / 100 : 0;

      return {
        budgetCategoryId: bc.id,
        categoryId: bc.categoryId,
        categoryName,
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
