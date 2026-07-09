import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Account } from "./entities/account.entity";
import { Institution } from "../institutions/entities/institution.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { AccountsService } from "./accounts.service";
import { AccountExportService } from "./account-export.service";
import { LoanMortgageAccountService } from "./loan-mortgage-account.service";
import { LoanPaymentDetectorService } from "./loan-payment-detector.service";
import { LoanPaymentSetupService } from "./loan-payment-setup.service";
import { AccountsController } from "./accounts.controller";
import { MortgageReminderService } from "./mortgage-reminder.service";
import { StatementCycleService } from "./statement-cycle.service";
import { BalanceForecastService } from "./balance-forecast.service";
import { CategoriesModule } from "../categories/categories.module";
import { ScheduledTransactionsModule } from "../scheduled-transactions/scheduled-transactions.module";
import { NetWorthModule } from "../net-worth/net-worth.module";
import { SecuritiesModule } from "../securities/securities.module";
import { ActionHistoryModule } from "../action-history/action-history.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { DelegationModule } from "../delegation/delegation.module";
import { LoanRateChangesModule } from "../loan-rate-changes/loan-rate-changes.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Account,
      Institution,
      Transaction,
      InvestmentTransaction,
      Category,
      User,
      UserPreference,
      ScheduledTransaction,
    ]),
    forwardRef(() => CategoriesModule),
    forwardRef(() => ScheduledTransactionsModule),
    forwardRef(() => NetWorthModule),
    forwardRef(() => SecuritiesModule),
    ActionHistoryModule,
    NotificationsModule,
    DelegationModule,
    forwardRef(() => LoanRateChangesModule),
  ],
  providers: [
    AccountsService,
    AccountExportService,
    LoanMortgageAccountService,
    LoanPaymentDetectorService,
    LoanPaymentSetupService,
    MortgageReminderService,
    StatementCycleService,
    BalanceForecastService,
  ],
  controllers: [AccountsController],
  exports: [AccountsService, StatementCycleService, BalanceForecastService],
})
export class AccountsModule {}
