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
import { AiController } from "./ai.controller";
import { FinancialContextBuilder } from "./context/financial-context.builder";
import { AiQueryService } from "./query/ai-query.service";
import { AiQueryController } from "./query/ai-query.controller";
import { ToolExecutorService } from "./query/tool-executor.service";
import { AiInsightsService } from "./insights/ai-insights.service";
import { AiInsightsController } from "./insights/ai-insights.controller";
import { InsightsAggregatorService } from "./insights/insights-aggregator.service";
import { AccountsModule } from "../accounts/accounts.module";
import { CategoriesModule } from "../categories/categories.module";
import { TransactionsModule } from "../transactions/transactions.module";
import { NetWorthModule } from "../net-worth/net-worth.module";

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
    forwardRef(() => NetWorthModule),
  ],
  providers: [
    AiService,
    AiUsageService,
    AiEncryptionService,
    AiProviderFactory,
    FinancialContextBuilder,
    AiQueryService,
    ToolExecutorService,
    AiInsightsService,
    InsightsAggregatorService,
  ],
  controllers: [AiController, AiQueryController, AiInsightsController],
  exports: [AiService, AiUsageService],
})
export class AiModule {}
