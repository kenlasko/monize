import { Injectable } from "@nestjs/common";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UserContextResolver } from "./mcp-context";
import { AiRelayService } from "../ai/relay/ai-relay.service";
import { installRelayToolActivity } from "./mcp-relay-tool-activity";
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
import { McpAccountListResource } from "./resources/account-list.resource";
import { McpCategoryTreeResource } from "./resources/category-tree.resource";
import { McpRecentTransactionsResource } from "./resources/recent-transactions.resource";
import { McpFinancialSummaryResource } from "./resources/financial-summary.resource";
import { McpFinancialReviewPrompt } from "./prompts/financial-review.prompt";
import { McpBudgetCheckPrompt } from "./prompts/budget-check.prompt";
import { McpTransactionLookupPrompt } from "./prompts/transaction-lookup.prompt";
import { McpSpendingAnalysisPrompt } from "./prompts/spending-analysis.prompt";

// Version comes from the backend package.json at build/run time so the MCP
// server advertises the same version as the published image. Using require
// keeps the read synchronous and avoids ESM import-assertion issues.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const backendPkg = require("../../package.json") as { version: string };

@Injectable()
export class McpServerService {
  constructor(
    private readonly accountsTools: McpAccountsTools,
    private readonly transactionsTools: McpTransactionsTools,
    private readonly categoriesTools: McpCategoriesTools,
    private readonly payeesTools: McpPayeesTools,
    private readonly reportsTools: McpReportsTools,
    private readonly investmentsTools: McpInvestmentsTools,
    private readonly scheduledTools: McpScheduledTools,
    private readonly calculateTools: McpCalculateTools,
    private readonly budgetsTools: McpBudgetsTools,
    private readonly relayTools: McpRelayTools,
    private readonly relayService: AiRelayService,
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
    // Surface today's date so the model can resolve relative ranges ("this
    // month", "last 30 days") into YYYY-MM-DD without an extra round trip. The
    // server is built per session, so this reflects the connection date.
    const today = new Date().toISOString().substring(0, 10);
    const server = new McpServer(
      { name: "monize", version: backendPkg.version },
      {
        instructions: [
          "Monize is a personal finance management service. You can query accounts, transactions, investments, and generate financial reports.",
          "",
          `Today's date is ${today}. Compute relative date ranges (for example 'this month' or 'last 30 days') from this date and pass them as YYYY-MM-DD.`,
          "",
          "## General guidelines",
          "- Prefer summary and report tools over listing raw transactions. Use list_accounts, generate_report, and get_portfolio_summary to answer questions when possible.",
          "- list_transactions returns summary data by default; only set includeTransactions: true when the user asks about specific transactions (e.g. 'show me my Amazon purchases').",
          "- Amounts are signed: positive = income/deposit, negative = expense/withdrawal.",
          "- All dates use YYYY-MM-DD format. Report months use YYYY-MM.",
          "- Most tools accept names (account/category/payee) and resolve them internally, including list_transactions, list_accounts, the investment query tools (get_portfolio_summary, list_investment_transactions, list_capital_gains), and the manage_* tools. Only fall back to list_accounts or list_categories first when a tool explicitly asks for a UUID.",
          "- To create, update, categorize, transfer, or delete transactions, use the single manage_transactions tool. It accepts NAMES for account/category/payee and resolves them internally, so you do NOT need to call get_accounts/list_categories first for writes. operation = create/update/delete; items = 1-25 rows; approvalMode defaults to one bulk confirmation at 6 or more items and one per item below that, and individual forces one per item at any count. Set dryRun=true to preview without saving.",
          "",
          "## Answering common questions",
          "- 'How much did I spend on X?' → generate_report with type spending_by_category or spending_by_payee, or list_transactions (summary only), not list_transactions with includeTransactions.",
          "- 'How am I doing this month?' → generate_report with type month_comparison, or the financial-review prompt.",
          "- 'What's my net worth?' → list_accounts for current balances and the assets/liabilities/net-worth summary, generate_report (type net_worth_history) for trends.",
          "- 'Any unusual spending?' → generate_report with type spending_anomalies rather than manually scanning transactions.",
          "- 'What bills are coming up?' → list_upcoming_bills.",
          "- 'How are my investments doing?' → get_portfolio_summary; it returns both the overall portfolio and a per-account holdings breakdown (holdingsByAccount), so use it for specific-account holdings questions too.",
          "",
          "## Resources",
          "- monize://financial-summary provides a quick snapshot (net worth, current month income/expenses) without needing any tool calls.",
          "- monize://accounts and monize://categories are useful for resolving names to IDs.",
          "- monize://recent-transactions is a summarized view of the last 30 days.",
          "",
          "## Math accuracy",
          "- Never perform arithmetic yourself (addition, subtraction, multiplication, division, percentages). Use the calculate tool instead.",
          "- When tool results already include a computed value (e.g., percentage, netCashFlow), present it as-is rather than recomputing it.",
          "- If you need to derive a value not in the tool results (e.g., 'What percentage of income goes to rent?'), call the calculate tool with the relevant numbers.",
          "",
          "## Tips",
          "- Combine generate_report (type net_worth_history) + generate_report (type month_comparison) for a comprehensive financial overview in fewer calls.",
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

    // Stream the agent's tool calls to the web chat as live progress when this
    // session is serving a relayed prompt. Must run before the tools register.
    installRelayToolActivity(server, resolve, this.relayService);

    this.accountsTools.register(server, resolve);
    this.transactionsTools.register(server, resolve);
    this.categoriesTools.register(server, resolve);
    this.payeesTools.register(server, resolve);
    this.reportsTools.register(server, resolve);
    this.investmentsTools.register(server, resolve);
    this.scheduledTools.register(server, resolve);
    this.calculateTools.register(server);
    this.budgetsTools.register(server, resolve);
    this.relayTools.register(server, resolve);

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
