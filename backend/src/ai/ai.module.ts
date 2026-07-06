import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { AiProviderConfig } from "./entities/ai-provider-config.entity";
import { AiUsageLog } from "./entities/ai-usage-log.entity";
import { AiInsight } from "./entities/ai-insight.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { AiService } from "./ai.service";
import { AiUsageService } from "./ai-usage.service";
import { AiEncryptionService } from "./ai-encryption.service";
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
import { AiRelayModule } from "./relay/ai-relay.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AiProviderConfig,
      AiUsageLog,
      AiInsight,
      UserPreference,
      Transaction,
      Category,
      ScheduledTransaction,
    ]),
    ConfigModule,
    forwardRef(() => AccountsModule),
    forwardRef(() => CategoriesModule),
    forwardRef(() => TransactionsModule),
    forwardRef(() => PayeesModule),
    forwardRef(() => NetWorthModule),
    forwardRef(() => BudgetsModule),
    SecuritiesModule,
    forwardRef(() => ScheduledTransactionsModule),
    forwardRef(() => BuiltInReportsModule),
    AiActionBuilderModule,
    // AiService routes non-chat completions (insights, forecast) through the
    // reverse MCP relay when the user's provider list reaches an mcp_relay
    // config.
    AiRelayModule,
  ],
  providers: [
    AiService,
    AiUsageService,
    AiEncryptionService,
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
  ],
  controllers: [
    AiController,
    AiQueryController,
    AiInsightsController,
    AiForecastController,
    AiActionsController,
  ],
  exports: [AiService, AiUsageService, AiEncryptionService],
})
export class AiModule {}
