import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Account } from "./entities/account.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { AccountsService } from "./accounts.service";
import { AccountExportService } from "./account-export.service";
import { LoanMortgageAccountService } from "./loan-mortgage-account.service";
import { LoanPaymentDetectorService } from "./loan-payment-detector.service";
import { LoanPaymentSetupService } from "./loan-payment-setup.service";
import { AccountsController } from "./accounts.controller";
import { MortgageReminderService } from "./mortgage-reminder.service";
import { CategoriesModule } from "../categories/categories.module";
import { ScheduledTransactionsModule } from "../scheduled-transactions/scheduled-transactions.module";
import { NetWorthModule } from "../net-worth/net-worth.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Account,
      Transaction,
      InvestmentTransaction,
      Category,
    ]),
    forwardRef(() => CategoriesModule),
    forwardRef(() => ScheduledTransactionsModule),
    forwardRef(() => NetWorthModule),
  ],
  providers: [
    AccountsService,
    AccountExportService,
    LoanMortgageAccountService,
    LoanPaymentDetectorService,
    LoanPaymentSetupService,
    MortgageReminderService,
  ],
  controllers: [AccountsController],
  exports: [AccountsService],
})
export class AccountsModule {}
