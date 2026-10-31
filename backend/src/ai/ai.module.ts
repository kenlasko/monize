import { SharedReviewModule } from "../shared-expenses/shared-review.module";
import { Module, forwardRef } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AiService } from "./ai.service";
import { AiUsageService } from "./ai-usage.service";
import { EncryptionModule } from "../common/encryption/encryption.module";
import { AiProviderFactory } from "./ai-provider.factory";
import { AiStartupValidator } from "./ai-startup.validator";
import { AiController } from "./ai.controller";
import { FinancialContextBuilder } from "./context/financial-context.builder";
import { AiQueryService } from "./query/ai-query.service";
import { AiQueryController } from "./query/ai-query.controller";
import { ToolExecutorService } from "./query/tool-executor.service";
import { AiInsightsService } from "./insights/ai-insights.service";
import { AiInsightsController } from "./insights/ai-insights.controller";
import { InsightsAggregatorService } from "./insights/insights-aggregator.service";
import { AiForecastService } from "./forecast/ai-forecast.service";
import { AiForecastController } from "./forecast/ai-forecast.controller";
import { ForecastAggregatorService } from "./forecast/forecast-aggregator.service";
import { AiActionsController } from "./actions/ai-actions.controller";
import { AiActionsService } from "./actions/ai-actions.service";
import { SingleUseTokenModule } from "../auth/single-use-token.module";
import { AuthAttemptCounterModule } from "../auth/auth-attempt-counter.module";
import { AiActionBuilderModule } from "./actions/ai-action-builder.module";
import { AiWriteLimiter } from "./actions/ai-write-limiter";
import { AccountsModule } from "../accounts/accounts.module";
import { CategoriesModule } from "../categories/categories.module";
import { TransactionsModule } from "../transactions/transactions.module";
import { PayeesModule } from "../payees/payees.module";
import { NetWorthModule } from "../net-worth/net-worth.module";
import { BudgetsModule } from "../budgets/budgets.module";
import { SecuritiesModule } from "../securities/securities.module";
import { ScheduledTransactionsModule } from "../scheduled-transactions/scheduled-transactions.module";
import { BuiltInReportsModule } from "../built-in-reports/built-in-reports.module";
import { AttachmentsModule } from "../attachments/attachments.module";
import { AiRelayModule } from "./relay/ai-relay.module";
import { CurrenciesModule } from "../currencies/currencies.module";
import { TransactionRulesModule } from "../transaction-rules/transaction-rules.module";
import { AiReviewModule } from "../ai-review/ai-review.module";
import { AiReviewQueueModule } from "../ai-review/ai-review-queue.module";
import { AiReviewApprovalController } from "../ai-review/ai-review-approval.controller";
import { AiReviewApprovalService } from "../ai-review/ai-review-approval.service";
import { EmailReceiptParsersModule } from "../email-receipts/parsers/email-receipt-parsers.module";
import { BondsModule } from "../bonds/bonds.module";
import { WarrantiesModule } from "../warranties/warranties.module";

@Module({
  imports: [
    SharedReviewModule,
    ConfigModule,
    EncryptionModule,
    forwardRef(() => AccountsModule),
    forwardRef(() => CategoriesModule),
    forwardRef(() => TransactionsModule),
    forwardRef(() => PayeesModule),
    forwardRef(() => NetWorthModule),
    forwardRef(() => BudgetsModule),
    SecuritiesModule,
    forwardRef(() => ScheduledTransactionsModule),
    forwardRef(() => BuiltInReportsModule),
    // Attachment persistence for confirmed create/update actions that carry
    // chat-supplied files (attachments module has no dependency back on ai).
    AttachmentsModule,
    AiActionBuilderModule,
    // The one `single_use_tokens` door, for the confirm path's anti-replay
    // claim. A module holding only that service, so this does not pull the auth
    // layer in to reach a class whose sole dependency is DataSource.
    SingleUseTokenModule,
    // The shared counter rows behind the daily AI write cap (`AiWriteLimiter`),
    // for the same reason: the counter service alone, not the auth layer.
    AuthAttemptCounterModule,
    // AiService routes non-chat completions (insights, forecast) through the
    // reverse MCP relay when the user's provider list reaches an mcp_relay
    // config.
    AiRelayModule,
    // ExchangeRateService, for the `calculate` tool's currency conversion.
    forwardRef(() => CurrenciesModule),
    // Commit and name-resolve the rule actions and tools.
    forwardRef(() => TransactionRulesModule),
    // Marks an AI review request applied in the confirm transaction, and lets
    // the assistant work the queue.
    AiReviewModule,
    AiReviewQueueModule,
    // The `email_receipt_parsers` tool's logic. A forwardRef: the module reaches
    // `PayeesModule`, which reaches back here through the payee lookup.
    forwardRef(() => EmailReceiptParsersModule),
    // The `fetch_bond_series` tool's logic (BondsModule exports it).
    forwardRef(() => BondsModule),
    // The `list_warranties` tool's logic (WarrantiesModule exports it).
    WarrantiesModule,
  ],
  providers: [
    AiService,
    AiUsageService,
    AiProviderFactory,
    AiStartupValidator,
    FinancialContextBuilder,
    AiQueryService,
    ToolExecutorService,
    AiInsightsService,
    InsightsAggregatorService,
    AiForecastService,
    ForecastAggregatorService,
    AiActionsService,
    AiWriteLimiter,
    AiReviewApprovalService,
  ],
  controllers: [
    AiController,
    AiQueryController,
    AiInsightsController,
    AiForecastController,
    AiActionsController,
    AiReviewApprovalController,
  ],
  // AiActionsService: the MCP rule tools commit a descriptor a client's own
  // dialog approved through the same executors `/ai/actions/confirm` uses.
  exports: [
    AiService,
    AiUsageService,
    EncryptionModule,
    AiActionsService,
    // The profile wizard runs the assistant synchronously
    // (`EmailReceiptParserGenerateService`).
    AiQueryService,
  ],
})
export class AiModule {}
