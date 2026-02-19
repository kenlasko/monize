import { Injectable, OnModuleInit } from "@nestjs/common";
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
export class McpServerService implements OnModuleInit {
  private server: McpServer;
  private userContextResolver: UserContextResolver = () => undefined;

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

  onModuleInit() {
    this.server = new McpServer(
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

    this.registerTools();
    this.registerResources();
    this.registerPrompts();
  }

  getServer(): McpServer {
    return this.server;
  }

  setUserContextResolver(resolver: UserContextResolver) {
    this.userContextResolver = resolver;
  }

  private registerTools() {
    const resolverFn: UserContextResolver = (sessionId) =>
      this.userContextResolver(sessionId);

    this.accountsTools.register(this.server, resolverFn);
    this.transactionsTools.register(this.server, resolverFn);
    this.categoriesTools.register(this.server, resolverFn);
    this.payeesTools.register(this.server, resolverFn);
    this.reportsTools.register(this.server, resolverFn);
    this.investmentsTools.register(this.server, resolverFn);
    this.netWorthTools.register(this.server, resolverFn);
    this.scheduledTools.register(this.server, resolverFn);
  }

  private registerResources() {
    const resolverFn: UserContextResolver = (sessionId) =>
      this.userContextResolver(sessionId);

    this.accountListResource.register(this.server, resolverFn);
    this.categoryTreeResource.register(this.server, resolverFn);
    this.recentTransactionsResource.register(this.server, resolverFn);
    this.financialSummaryResource.register(this.server, resolverFn);
  }

  private registerPrompts() {
    this.financialReviewPrompt.register(this.server);
    this.budgetCheckPrompt.register(this.server);
    this.transactionLookupPrompt.register(this.server);
    this.spendingAnalysisPrompt.register(this.server);
  }
}
