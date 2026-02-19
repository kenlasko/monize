import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Budget } from "./entities/budget.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { BudgetPeriodService } from "./budget-period.service";

@Injectable()
export class BudgetPeriodCronService {
  private readonly logger = new Logger(BudgetPeriodCronService.name);

  constructor(
    @InjectRepository(Budget)
    private budgetsRepository: Repository<Budget>,
    @InjectRepository(BudgetPeriod)
    private periodsRepository: Repository<BudgetPeriod>,
    private budgetPeriodService: BudgetPeriodService,
  ) {}

  @Cron("0 0 1 * *")
  async closeExpiredPeriods(): Promise<void> {
    this.logger.log("Running budget period close check...");

    try {
      const activeBudgets = await this.budgetsRepository.find({
        where: { isActive: true },
      });

      if (activeBudgets.length === 0) {
        this.logger.log("No active budgets found");
        return;
      }

      let closedCount = 0;
      let errorCount = 0;

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
            await this.budgetPeriodService.closePeriod(
              budget.userId,
              budget.id,
            );
            closedCount++;
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
    } catch (error) {
      this.logger.error(
        "Failed to run budget period close check",
        error instanceof Error ? error.stack : error,
      );
    }
  }
}
