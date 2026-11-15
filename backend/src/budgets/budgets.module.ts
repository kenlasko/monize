import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Budget } from "./entities/budget.entity";
import { BudgetCategory } from "./entities/budget-category.entity";
import { BudgetPeriod } from "./entities/budget-period.entity";
import { BudgetPeriodCategory } from "./entities/budget-period-category.entity";
import { BudgetBucket } from "./entities/budget-bucket.entity";
import { BudgetPeriodBucket } from "./entities/budget-period-bucket.entity";
import { Notification } from "../notification-center/entities/notification.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { Account } from "../accounts/entities/account.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "../scheduled-transactions/entities/scheduled-transaction-override.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { BudgetsService } from "./budgets.service";
import { BudgetPeriodService } from "./budget-period.service";
import { BudgetPeriodCronService } from "./budget-period-cron.service";
import { BudgetGeneratorService } from "./budget-generator.service";
import { BudgetAlertService } from "./budget-alert.service";
import { BudgetBucketsService } from "./budget-buckets.service";
import { BudgetBucketReportsService } from "./budget-bucket-reports.service";
import { BudgetReportsService } from "./budget-reports.service";
import { BudgetTrendReportsService } from "./budget-trend-reports.service";
import { BudgetHealthReportsService } from "./budget-health-reports.service";
import { BudgetActivityReportsService } from "./budget-activity-reports.service";
import { BudgetsController } from "./budgets.controller";
import { NotificationsModule } from "../notifications/notifications.module";
import { ActionHistoryModule } from "../action-history/action-history.module";
import { ScheduledTransactionsModule } from "../scheduled-transactions/scheduled-transactions.module";
import { CurrenciesModule } from "../currencies/currencies.module";
import { NotificationCenterModule } from "../notification-center/notification-center.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Budget,
      BudgetCategory,
      BudgetPeriod,
      BudgetPeriodCategory,
      BudgetBucket,
      BudgetPeriodBucket,
      Notification,
      Transaction,
      TransactionSplit,
      Category,
      Account,
      ScheduledTransaction,
      ScheduledTransactionOverride,
      User,
      UserPreference,
    ]),
    NotificationsModule,
    ActionHistoryModule,
    // For ScheduledEffectiveAmountService: the budget's upcoming-bill figures
    // come from the one server-side effective-amount resolver (issue #1247).
    ScheduledTransactionsModule,
    // For ExchangeRateService: an occurrence's amount is in the occurrence's own
    // currency, which the budget converts into its own before totalling.
    CurrenciesModule,
    // For NotificationService: every notification a budget produces goes
    // through the one write door. Bare, not deferred: the notification centre
    // depends on nothing, so this edge lies on no cycle.
    NotificationCenterModule,
  ],
  providers: [
    BudgetsService,
    BudgetPeriodService,
    BudgetPeriodCronService,
    BudgetGeneratorService,
    BudgetAlertService,
    BudgetTrendReportsService,
    BudgetHealthReportsService,
    BudgetActivityReportsService,
    BudgetReportsService,
    BudgetBucketsService,
    BudgetBucketReportsService,
  ],
  controllers: [BudgetsController],
  exports: [
    BudgetsService,
    BudgetPeriodService,
    BudgetGeneratorService,
    BudgetReportsService,
    BudgetAlertService,
    BudgetBucketsService,
  ],
})
export class BudgetsModule {}
