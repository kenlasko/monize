import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Transaction } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { TransactionsService } from "./transactions.service";
import { TransactionSplitService } from "./transaction-split.service";
import { TransactionTransferService } from "./transaction-transfer.service";
import { TransactionReconciliationService } from "./transaction-reconciliation.service";
import { TransactionAnalyticsService } from "./transaction-analytics.service";
import { TransactionBulkUpdateService } from "./transaction-bulk-update.service";
import { TransactionsController } from "./transactions.controller";
import { AccountsModule } from "../accounts/accounts.module";
import { PayeesModule } from "../payees/payees.module";
import { NetWorthModule } from "../net-worth/net-worth.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Transaction,
      TransactionSplit,
      Category,
      InvestmentTransaction,
    ]),
    forwardRef(() => AccountsModule),
    forwardRef(() => NetWorthModule),
    PayeesModule,
  ],
  providers: [
    TransactionsService,
    TransactionSplitService,
    TransactionTransferService,
    TransactionReconciliationService,
    TransactionAnalyticsService,
    TransactionBulkUpdateService,
  ],
  controllers: [TransactionsController],
  exports: [TransactionsService],
})
export class TransactionsModule {}
