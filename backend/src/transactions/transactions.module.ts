import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Transaction } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { TransactionsService } from "./transactions.service";
import { TransactionSplitService } from "./transaction-split.service";
import { TransactionTransferService } from "./transaction-transfer.service";
import { TransactionReconciliationService } from "./transaction-reconciliation.service";
import { TransactionAnalyticsService } from "./transaction-analytics.service";
import { TransactionBulkUpdateService } from "./transaction-bulk-update.service";
import { TransactionToolPrepService } from "./transaction-tool-prep.service";
import { JointRegisterService } from "./joint-register.service";
import { TransactionsController } from "./transactions.controller";
import { AccountsModule } from "../accounts/accounts.module";
import { PayeesModule } from "../payees/payees.module";
import { TagsModule } from "../tags/tags.module";
import { NetWorthModule } from "../net-worth/net-worth.module";
import { ActionHistoryModule } from "../action-history/action-history.module";
import { SecuritiesModule } from "../securities/securities.module";
import { DelegationModule } from "../delegation/delegation.module";
import { TransactionRulesModule } from "../transaction-rules/transaction-rules.module";
import { CurrenciesModule } from "../currencies/currencies.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Transaction,
      TransactionSplit,
      Category,
      Payee,
      InvestmentTransaction,
      UserPreference,
    ]),
    forwardRef(() => AccountsModule),
    forwardRef(() => NetWorthModule),
    forwardRef(() => SecuritiesModule),
    // PayeesModule reaches DelegationModule (the payee detail page's delegate
    // scope), which reaches back here -- see `src/module-graph.spec.ts`.
    forwardRef(() => PayeesModule),
    TagsModule,
    // The rules step of create() and previewCreate().
    // forwardRef: the rules module reaches TransactionsModule back through the
    // assistant's rule tools (AccountsModule, PayeesModule).
    forwardRef(() => TransactionRulesModule),
    ActionHistoryModule,
    // forwardRef on both: each lies on a require cycle, so a bare reference is
    // `undefined` here under some load orders -- see `src/module-graph.spec.ts`.
    forwardRef(() => DelegationModule),
    // Transfers resolve a cross-currency rate server-side rather than posting
    // at 1:1 when the request omits one (audit P5-002).
    forwardRef(() => CurrenciesModule),
  ],
  providers: [
    TransactionsService,
    TransactionSplitService,
    TransactionTransferService,
    TransactionReconciliationService,
    TransactionAnalyticsService,
    TransactionBulkUpdateService,
    TransactionToolPrepService,
    JointRegisterService,
  ],
  controllers: [TransactionsController],
  exports: [
    TransactionsService,
    TransactionSplitService,
    TransactionAnalyticsService,
    TransactionTransferService,
    TransactionToolPrepService,
  ],
})
export class TransactionsModule {}
