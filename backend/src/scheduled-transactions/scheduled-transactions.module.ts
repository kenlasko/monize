import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "./entities/scheduled-transaction-split.entity";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import { Account } from "../accounts/entities/account.entity";
import { Tag } from "../tags/entities/tag.entity";
import { ScheduledTransactionsService } from "./scheduled-transactions.service";
import { ScheduledEffectiveAmountService } from "./scheduled-effective-amount.service";
import { ScheduledOccurrenceService } from "./scheduled-occurrence.service";
import { ScheduledAmountEstimateService } from "./scheduled-amount-estimate.service";
import { ScheduledTransactionOverrideService } from "./scheduled-transaction-override.service";
import { ScheduledTransactionLoanService } from "./scheduled-transaction-loan.service";
import { ScheduledTransactionsController } from "./scheduled-transactions.controller";
import { AccountsModule } from "../accounts/accounts.module";
import { TransactionsModule } from "../transactions/transactions.module";
import { SecuritiesModule } from "../securities/securities.module";
import { CurrenciesModule } from "../currencies/currencies.module";
import { ActionHistoryModule } from "../action-history/action-history.module";
import { DelegationModule } from "../delegation/delegation.module";
import { SystemAlertsModule } from "../system-alerts/system-alerts.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ScheduledTransaction,
      ScheduledTransactionSplit,
      ScheduledTransactionOverride,
      Account,
      Tag,
    ]),
    forwardRef(() => AccountsModule),
    // forwardRef on both: each lies on a require cycle, so a bare reference is
    // `undefined` here under some load orders -- see `src/module-graph.spec.ts`.
    forwardRef(() => TransactionsModule),
    forwardRef(() => SecuritiesModule),
    forwardRef(() => CurrenciesModule),
    ActionHistoryModule,
    forwardRef(() => DelegationModule),
    // SCHEDULED_POST_FAILED user alerts. forwardRef: SystemAlertsModule
    // reaches NotificationsModule, which imports this module back.
    forwardRef(() => SystemAlertsModule),
  ],
  providers: [
    ScheduledTransactionsService,
    ScheduledEffectiveAmountService,
    ScheduledOccurrenceService,
    ScheduledAmountEstimateService,
    ScheduledTransactionOverrideService,
    ScheduledTransactionLoanService,
  ],
  controllers: [ScheduledTransactionsController],
  // Both read-side services are exported so a consumer that holds schedule rows
  // of its own (BudgetsService, the account balance forecast) asks them rather
  // than re-deriving the #1167 FX rules or re-implementing occurrence selection
  // (issue #1247).
  exports: [
    ScheduledTransactionsService,
    ScheduledEffectiveAmountService,
    ScheduledOccurrenceService,
    ScheduledAmountEstimateService,
  ],
})
export class ScheduledTransactionsModule {}
