import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Budget } from "./entities/budget.entity";
import { BudgetCategory } from "./entities/budget-category.entity";
import { BudgetPeriod } from "./entities/budget-period.entity";
import { BudgetPeriodCategory } from "./entities/budget-period-category.entity";
import { BudgetAlert } from "./entities/budget-alert.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { Account } from "../accounts/entities/account.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { BudgetsService } from "./budgets.service";
import { BudgetPeriodService } from "./budget-period.service";
import { BudgetPeriodCronService } from "./budget-period-cron.service";
import { BudgetGeneratorService } from "./budget-generator.service";
import { BudgetAlertService } from "./budget-alert.service";
import { BudgetReportsService } from "./budget-reports.service";
import { BudgetsController } from "./budgets.controller";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Budget,
      BudgetCategory,
      BudgetPeriod,
      BudgetPeriodCategory,
      BudgetAlert,
      Transaction,
      TransactionSplit,
      Category,
      Account,
      User,
      UserPreference,
    ]),
    NotificationsModule,
  ],
  providers: [
    BudgetsService,
    BudgetPeriodService,
    BudgetPeriodCronService,
    BudgetGeneratorService,
    BudgetAlertService,
    BudgetReportsService,
  ],
  controllers: [BudgetsController],
  exports: [
    BudgetsService,
    BudgetPeriodService,
    BudgetGeneratorService,
    BudgetReportsService,
    BudgetAlertService,
  ],
})
export class BudgetsModule {}
