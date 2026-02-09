import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "./entities/scheduled-transaction-split.entity";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import { Account } from "../accounts/entities/account.entity";
import { ScheduledTransactionsService } from "./scheduled-transactions.service";
import { ScheduledTransactionsController } from "./scheduled-transactions.controller";
import { AccountsModule } from "../accounts/accounts.module";
import { TransactionsModule } from "../transactions/transactions.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ScheduledTransaction,
      ScheduledTransactionSplit,
      ScheduledTransactionOverride,
      Account,
    ]),
    forwardRef(() => AccountsModule),
    TransactionsModule,
  ],
  providers: [ScheduledTransactionsService],
  controllers: [ScheduledTransactionsController],
  exports: [ScheduledTransactionsService],
})
export class ScheduledTransactionsModule {}
