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
        instructions: [
          "Monize is a personal finance management service. You can query accounts, transactions, investments, and generate financial reports.",
          "",
          "## General guidelines",
          "- Prefer summary and report tools over listing raw transactions. Use get_account_summary, generate_report, monthly_comparison, and get_portfolio_summary to answer questions when possible.",
          "- Only use search_transactions when the user asks about specific transactions (e.g. 'show me my Amazon purchases').",
          "- Amounts are signed: positive = income/deposit, negative = expense/withdrawal.",
          "- All dates use YYYY-MM-DD format. Report months use YYYY-MM.",
          "- Account IDs and category IDs are UUIDs. Use get_accounts or get_categories first to resolve names to IDs before calling other tools.",
          "",
          "## Answering common questions",
          "- 'How much did I spend on X?' → generate_report with type spending_by_category or spending_by_payee, not search_transactions.",
          "- 'How am I doing this month?' → monthly_comparison for the current month, or the financial-review prompt.",
          "- 'What's my net worth?' → get_net_worth for current breakdown, get_net_worth_history for trends.",
          "- 'Any unusual spending?' → get_anomalies rather than manually scanning transactions.",
          "- 'What bills are coming up?' → get_upcoming_bills.",
          "- 'How are my investments doing?' → get_portfolio_summary for the overview, get_holding_details only if they ask about a specific account.",
          "",
          "## Resources",
          "- monize://financial-summary provides a quick snapshot (net worth, current month income/expenses) without needing any tool calls.",
          "- monize://accounts and monize://categories are useful for resolving names to IDs.",
          "- monize://recent-transactions is a summarized view of the last 30 days.",
          "",
          "## Tips",
          "- Combine get_account_summary + monthly_comparison for a comprehensive financial overview in fewer calls.",
          "- When the user asks about trends, prefer generate_report with type monthly_trend over fetching transactions for each month.",
          "- Keep transaction searches focused: use date ranges, category/payee filters, and reasonable limits to avoid large result sets.",
          "- Use the available prompts (financial-review, budget-check, spending-analysis, transaction-lookup) as guides for multi-step workflows.",
        ].join("\n"),
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
