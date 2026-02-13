import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Account } from "./entities/account.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { AccountsService } from "./accounts.service";
import { LoanMortgageAccountService } from "./loan-mortgage-account.service";
import { AccountsController } from "./accounts.controller";
import { MortgageReminderService } from "./mortgage-reminder.service";
import { CategoriesModule } from "../categories/categories.module";
import { ScheduledTransactionsModule } from "../scheduled-transactions/scheduled-transactions.module";
import { NetWorthModule } from "../net-worth/net-worth.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([Account, Transaction, InvestmentTransaction]),
    forwardRef(() => CategoriesModule),
    forwardRef(() => ScheduledTransactionsModule),
    forwardRef(() => NetWorthModule),
  ],
  providers: [
    AccountsService,
    LoanMortgageAccountService,
    MortgageReminderService,
  ],
  controllers: [AccountsController],
  exports: [AccountsService],
})
export class AccountsModule {}
