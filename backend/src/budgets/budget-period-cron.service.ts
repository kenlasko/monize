import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { Budget } from "./entities/budget.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { BudgetPeriodService } from "./budget-period.service";
import { BudgetReportsService } from "./budget-reports.service";
import { EmailService } from "../notifications/email.service";
import { budgetMonthlySummaryTemplate } from "../notifications/email-templates";

interface ClosedPeriodInfo {
  budget: Budget;
  period: BudgetPeriod;
}

@Injectable()
export class BudgetPeriodCronService {
  private readonly logger = new Logger(BudgetPeriodCronService.name);

  constructor(
    @InjectRepository(Budget)
    private budgetsRepository: Repository<Budget>,
    @InjectRepository(BudgetPeriod)
    private periodsRepository: Repository<BudgetPeriod>,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(UserPreference)
    private preferencesRepository: Repository<UserPreference>,
    private budgetPeriodService: BudgetPeriodService,
    private budgetReportsService: BudgetReportsService,
    private emailService: EmailService,
    private configService: ConfigService,
  ) {}

  @Cron("0 0 1 * *")
  async closeExpiredPeriods(): Promise<void> {
    this.logger.log("Running budget period close check...");

    try {
      const activeBudgets = await this.budgetsRepository.find({
        where: { isActive: true },
        relations: ["categories", "categories.category", "categories.transferAccount"],
      });

      if (activeBudgets.length === 0) {
        this.logger.log("No active budgets found");
        return;
      }

      let closedCount = 0;
      let errorCount = 0;
      const closedPeriods: ClosedPeriodInfo[] = [];

      for (const budget of activeBudgets) {
        try {
          const openPeriod = await this.periodsRepository.findOne({
            where: { budgetId: budget.id, status: PeriodStatus.OPEN },
          });

          if (!openPeriod) {
            continue;
          }

          const periodEnd = new Date(openPeriod.periodEnd + "T23:59:59");
          const now = new Date();

          if (now > periodEnd) {
            const closedPeriod = await this.budgetPeriodService.closePeriod(
              budget.userId,
              budget.id,
            );
            closedCount++;
            closedPeriods.push({ budget, period: closedPeriod });
            this.logger.log(
              `Closed period for budget "${budget.name}" (${budget.id})`,
            );
          }
        } catch (error) {
          errorCount++;
          this.logger.error(
            `Failed to close period for budget ${budget.id}`,
            error instanceof Error ? error.stack : error,
          );
        }
      }

      this.logger.log(
        `Budget period close complete: ${closedCount} closed, ${errorCount} errors`,
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
        const sent = await this.sendMonthlySummaryForUser(userId, userPeriods);
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
    const prefs = await this.preferencesRepository.findOne({
      where: { userId },
    });
    if (prefs && !prefs.notificationEmail) return false;
    if (prefs && prefs.budgetDigestEnabled === false) return false;

    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });
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

        const periodCategories = period.periodCategories || [];

        const categoryData = expenseCategories.map((bc) => {
          const pc = periodCategories.find((p) => p.budgetCategoryId === bc.id);
          return {
            categoryName: bc.category?.name || "Uncategorized",
            budgeted: Number(pc?.budgetedAmount ?? bc.amount),
            actual: Number(pc?.actualAmount ?? 0),
            percentUsed:
              Number(pc?.budgetedAmount ?? bc.amount) > 0
                ? Math.round(
                    (Number(pc?.actualAmount ?? 0) /
                      Number(pc?.budgetedAmount ?? bc.amount)) *
                      10000,
                  ) / 100
                : 0,
          };
        });

        const overBudgetCategories = categoryData.filter(
          (c) => c.percentUsed > 100,
        );

        const topCategories = [...categoryData]
          .sort((a, b) => b.actual - a.actual)
          .slice(0, 5);

        const totalBudgeted = Number(period.totalBudgeted);
        const totalSpent = Number(period.actualExpenses);
        const totalIncome = Number(period.actualIncome);
        const remaining = totalBudgeted - totalSpent;
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

    const html = budgetMonthlySummaryTemplate(
      user.firstName || "",
      summaries,
      appUrl,
    );

    const subject =
      summaries.length === 1
        ? `Monize: Monthly budget summary - ${summaries[0].periodLabel}`
        : `Monize: Monthly budget summary for ${summaries.length} budgets`;

    await this.emailService.sendMail(user.email, subject, html);
    return true;
  }
}
