import { Module, forwardRef } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AccountsModule } from "../accounts/accounts.module";
import { TransactionsModule } from "../transactions/transactions.module";
import { CategoriesModule } from "../categories/categories.module";
import { PayeesModule } from "../payees/payees.module";
import { ScheduledTransactionsModule } from "../scheduled-transactions/scheduled-transactions.module";
import { NetWorthModule } from "../net-worth/net-worth.module";
import { SecuritiesModule } from "../securities/securities.module";
import { BuiltInReportsModule } from "../built-in-reports/built-in-reports.module";

import { McpServerService } from "./mcp-server.service";
import { McpHttpController } from "./mcp-http.controller";

import { McpAccountsTools } from "./tools/accounts.tool";
import { McpTransactionsTools } from "./tools/transactions.tool";
import { McpCategoriesTools } from "./tools/categories.tool";
import { McpPayeesTools } from "./tools/payees.tool";
import { McpReportsTools } from "./tools/reports.tool";
import { McpInvestmentsTools } from "./tools/investments.tool";
import { McpNetWorthTools } from "./tools/net-worth.tool";
import { McpScheduledTools } from "./tools/scheduled.tool";

import { McpAccountListResource } from "./resources/account-list.resource";
import { McpCategoryTreeResource } from "./resources/category-tree.resource";
import { McpRecentTransactionsResource } from "./resources/recent-transactions.resource";
import { McpFinancialSummaryResource } from "./resources/financial-summary.resource";

import { McpFinancialReviewPrompt } from "./prompts/financial-review.prompt";
import { McpBudgetCheckPrompt } from "./prompts/budget-check.prompt";
import { McpTransactionLookupPrompt } from "./prompts/transaction-lookup.prompt";
import { McpSpendingAnalysisPrompt } from "./prompts/spending-analysis.prompt";

@Module({
  imports: [
    AuthModule,
    forwardRef(() => AccountsModule),
    forwardRef(() => TransactionsModule),
    forwardRef(() => CategoriesModule),
    PayeesModule,
    forwardRef(() => ScheduledTransactionsModule),
    forwardRef(() => NetWorthModule),
    SecuritiesModule,
    BuiltInReportsModule,
  ],
  providers: [
    McpServerService,
    McpAccountsTools,
    McpTransactionsTools,
    McpCategoriesTools,
    McpPayeesTools,
    McpReportsTools,
    McpInvestmentsTools,
    McpNetWorthTools,
    McpScheduledTools,
    McpAccountListResource,
    McpCategoryTreeResource,
    McpRecentTransactionsResource,
    McpFinancialSummaryResource,
    McpFinancialReviewPrompt,
    McpBudgetCheckPrompt,
    McpTransactionLookupPrompt,
    McpSpendingAnalysisPrompt,
  ],
  controllers: [McpHttpController],
  exports: [McpServerService],
})
export class McpModule {}
