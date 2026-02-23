import { Injectable } from "@nestjs/common";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UserContextResolver } from "./mcp-context";
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

@Injectable()
export class McpServerService {
  constructor(
    private readonly accountsTools: McpAccountsTools,
    private readonly transactionsTools: McpTransactionsTools,
    private readonly categoriesTools: McpCategoriesTools,
    private readonly payeesTools: McpPayeesTools,
    private readonly reportsTools: McpReportsTools,
    private readonly investmentsTools: McpInvestmentsTools,
    private readonly netWorthTools: McpNetWorthTools,
    private readonly scheduledTools: McpScheduledTools,
    private readonly accountListResource: McpAccountListResource,
    private readonly categoryTreeResource: McpCategoryTreeResource,
    private readonly recentTransactionsResource: McpRecentTransactionsResource,
    private readonly financialSummaryResource: McpFinancialSummaryResource,
    private readonly financialReviewPrompt: McpFinancialReviewPrompt,
    private readonly budgetCheckPrompt: McpBudgetCheckPrompt,
    private readonly transactionLookupPrompt: McpTransactionLookupPrompt,
    private readonly spendingAnalysisPrompt: McpSpendingAnalysisPrompt,
  ) {}

  createServer(resolve: UserContextResolver): McpServer {
    const server = new McpServer(
      { name: "monize", version: "1.0.0" },
      {
        capabilities: {
          logging: {},
          tools: {},
          resources: {},
          prompts: {},
        },
      },
    );

    this.accountsTools.register(server, resolve);
    this.transactionsTools.register(server, resolve);
    this.categoriesTools.register(server, resolve);
    this.payeesTools.register(server, resolve);
    this.reportsTools.register(server, resolve);
    this.investmentsTools.register(server, resolve);
    this.netWorthTools.register(server, resolve);
    this.scheduledTools.register(server, resolve);

    this.accountListResource.register(server, resolve);
    this.categoryTreeResource.register(server, resolve);
    this.recentTransactionsResource.register(server, resolve);
    this.financialSummaryResource.register(server, resolve);

    this.financialReviewPrompt.register(server);
    this.budgetCheckPrompt.register(server);
    this.transactionLookupPrompt.register(server);
    this.spendingAnalysisPrompt.register(server);

    return server;
  }
}
