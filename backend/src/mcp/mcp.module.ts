import { SharedReviewModule } from "../shared-expenses/shared-review.module";
import { Module, forwardRef } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AuthAttemptCounterModule } from "../auth/auth-attempt-counter.module";
import { AccountsModule } from "../accounts/accounts.module";
import { TransactionsModule } from "../transactions/transactions.module";
import { CategoriesModule } from "../categories/categories.module";
import { PayeesModule } from "../payees/payees.module";
import { ScheduledTransactionsModule } from "../scheduled-transactions/scheduled-transactions.module";
import { NetWorthModule } from "../net-worth/net-worth.module";
import { SecuritiesModule } from "../securities/securities.module";
import { BudgetsModule } from "../budgets/budgets.module";
import { BuiltInReportsModule } from "../built-in-reports/built-in-reports.module";
import { OAuthModule } from "../oauth/oauth.module";
import { AttachmentsModule } from "../attachments/attachments.module";
import { AiRelayModule } from "../ai/relay/ai-relay.module";
import { AiActionBuilderModule } from "../ai/actions/ai-action-builder.module";
import { CurrenciesModule } from "../currencies/currencies.module";
import { AiModule } from "../ai/ai.module";
import { TransactionRulesModule } from "../transaction-rules/transaction-rules.module";
import { AiReviewQueueModule } from "../ai-review/ai-review-queue.module";
import { EmailReceiptParsersModule } from "../email-receipts/parsers/email-receipt-parsers.module";
import { BondsModule } from "../bonds/bonds.module";
import { WarrantiesModule } from "../warranties/warranties.module";

import { McpServerService } from "./mcp-server.service";
import { McpHttpController } from "./mcp-http.controller";
import { McpWriteLimiter } from "./mcp-write-limiter";
import { McpRequestStateCodec } from "./mcp-request-state";

import { McpAccountsTools } from "./tools/accounts.tool";
import { McpTransactionsTools } from "./tools/transactions.tool";
import { McpCategoriesTools } from "./tools/categories.tool";
import { McpPayeesTools } from "./tools/payees.tool";
import { McpReportsTools } from "./tools/reports.tool";
import { McpInvestmentsTools } from "./tools/investments.tool";
import { McpScheduledTools } from "./tools/scheduled.tool";
import { McpCalculateTools } from "./tools/calculate.tool";
import { McpBudgetsTools } from "./tools/budgets.tool";
import { McpRelayTools } from "./tools/relay.tool";
import { McpRulesTools } from "./tools/rules.tool";
import { McpAiReviewTools } from "./tools/ai-review.tool";
import { McpEmailReceiptParserTools } from "./tools/email-receipt-parsers.tool";
import { McpBondSeriesTools } from "./tools/bond-series.tool";
import { McpWarrantiesTools } from "./tools/warranties.tool";

import { McpAccountListResource } from "./resources/account-list.resource";
import { McpCategoryTreeResource } from "./resources/category-tree.resource";
import { McpRecentTransactionsResource } from "./resources/recent-transactions.resource";
import { McpFinancialSummaryResource } from "./resources/financial-summary.resource";
import { McpRelayAttachmentResource } from "./resources/relay-attachment.resource";

import { McpFinancialReviewPrompt } from "./prompts/financial-review.prompt";
import { McpBudgetCheckPrompt } from "./prompts/budget-check.prompt";
import { McpTransactionLookupPrompt } from "./prompts/transaction-lookup.prompt";
import { McpSpendingAnalysisPrompt } from "./prompts/spending-analysis.prompt";

@Module({
  imports: [
    SharedReviewModule,
    AuthModule,
    // The shared counter rows behind the daily MCP write cap (`McpWriteLimiter`).
    // AuthModule re-exports it too; named here so the limiter's dependency does
    // not rest on that re-export.
    AuthAttemptCounterModule,
    forwardRef(() => AccountsModule),
    forwardRef(() => TransactionsModule),
    forwardRef(() => CategoriesModule),
    PayeesModule,
    forwardRef(() => ScheduledTransactionsModule),
    forwardRef(() => NetWorthModule),
    SecuritiesModule,
    forwardRef(() => BudgetsModule),
    BuiltInReportsModule,
    OAuthModule,
    // manage_transactions attachment support (prep + direct-confirm persist).
    AttachmentsModule,
    AiRelayModule,
    AiActionBuilderModule,
    // ExchangeRateService, for the `calculate` tool's currency conversion.
    forwardRef(() => CurrenciesModule),
    // manage_transaction_rules: name resolution and previews (the rules module)
    // and the executor an approved card commits through (the AI module).
    forwardRef(() => TransactionRulesModule),
    forwardRef(() => AiModule),
    // ai_review_requests: the queue's shared tool logic.
    AiReviewQueueModule,
    // email_receipt_parsers: the receipt parser tool's shared logic. A
    // forwardRef: the module reaches `PayeesModule`, which reaches back here.
    forwardRef(() => EmailReceiptParsersModule),
    // fetch_bond_series and enter_bond_series_manually: the catalog's series
    // fetch (BondsModule exports it).
    forwardRef(() => BondsModule),
    // list_warranties: WarrantiesService.getLlmWarranties.
    WarrantiesModule,
  ],
  providers: [
    McpServerService,
    McpWriteLimiter,
    McpRequestStateCodec,
    McpRelayTools,
    McpAccountsTools,
    McpTransactionsTools,
    McpCategoriesTools,
    McpPayeesTools,
    McpReportsTools,
    McpInvestmentsTools,
    McpScheduledTools,
    McpCalculateTools,
    McpBudgetsTools,
    McpRulesTools,
    McpAiReviewTools,
    McpEmailReceiptParserTools,
    McpBondSeriesTools,
    McpWarrantiesTools,
    McpAccountListResource,
    McpCategoryTreeResource,
    McpRecentTransactionsResource,
    McpFinancialSummaryResource,
    McpRelayAttachmentResource,
    McpFinancialReviewPrompt,
    McpBudgetCheckPrompt,
    McpTransactionLookupPrompt,
    McpSpendingAnalysisPrompt,
  ],
  controllers: [McpHttpController],
  exports: [McpServerService],
})
export class McpModule {}
