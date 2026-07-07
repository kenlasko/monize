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
import { McpRelayAttachmentResource } from "./resources/relay-attachment.resource";
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
    private readonly relayAttachmentResource: McpRelayAttachmentResource,
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
          "## Entity links in web-chat responses",
          "When (and only when) you are answering via the web-chat relay (post_response / report_progress), you can make entity mentions clickable: the Monize web chat renders markdown links with these exact URI forms as in-app deep links.",
          "- [Account Name](monize://account/<id>), [Payee Name](monize://payee/<id>), [Category Name](monize://category/<id>), [short description](monize://transaction/<id>), [Security](monize://security/<securityId>), [Bill or Deposit](monize://scheduled/<id>)",
          "- For securities use the securityId field from get_portfolio_summary holdings (not the ticker); for scheduled bills/deposits use the id from list_upcoming_bills items.",
          "- These are singular entity-link URIs carrying a UUID; they are distinct from the plural resource URIs above (monize://accounts etc.), which are for read_resource only and never belong in a reply.",
          "- Only use ids copied verbatim from tool results in this conversation; never construct or guess an id. If a row has no id (e.g. 'Other (aggregated)', 'Uncategorized', free-text payees), mention it as plain text.",
          "- Do not link brokerage/investment accounts, and never print a raw monize:// URI -- always give the link a human-readable label.",
          "- In a normal MCP client (outside the web-chat relay) these links do not render; use plain text there.",
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
          "",
          "## Long-running tasks over the web-chat relay (get_next_prompt)",
          "When you are answering a prompt obtained from get_next_prompt, the web chat needs a steady sign of life: it shows the user a 'your assistant went quiet' message if it hears nothing from you for a few minutes. The quiet gap that triggers this is your own thinking/composition time, during which nothing reaches the chat. Avoid it:",
          "- Send report_progress IMMEDIATELY after claiming a prompt, before you read attachments or plan. Make this first update a brief PLAN with a rough estimate, e.g. 'Got the CSV -- 84 rows. I'll import them in ~8 batches of 25, roughly 2-3 minutes. Starting now.'",
          "- Never go silent for long. Send a report_progress at least every minute or two while you read, plan, or compose. You cannot see a countdown or know exactly when the timeout is -- you have no clock during your turn -- so do not try to time it; just keep a steady cadence, one update per batch or step.",
          "- CRITICAL -- do not reason silently for long. The relay sees ONLY your tool calls, report_progress updates, and final post_response; it CANNOT see your internal reasoning/extended thinking. A long silent think (even a few minutes, let alone many) is indistinguishable from a dead agent: nothing reaches the web chat, the turn times out, and the answer you eventually produce is dropped because the prompt no longer exists. So on a relayed prompt, think BRIEFLY then act -- do not spend minutes deliberating before your first tool call or before answering. Externalise the work: break analysis into small tool calls (each is a liveness signal), narrate decisions with report_progress instead of thinking them through silently, and deliver your answer within a minute or two. If a question genuinely needs deep analysis, do it in steps with progress between them, or post your findings so far with post_response and continue -- never one long silent reasoning block.",
          "- Make each update INFORMATIVE, not just a heartbeat: say what you just did, what is left, and a rough ETA. E.g. 'Booked batch 3 of 8 (2023 deposits done); 5 batches / ~90s left.' This doubles as the 'I'm still on it, here's progress, I'll report when done' message the user wants.",
          "- Split big work into small batches and report before each. For an import of many rows, do NOT compose one massive manage_transactions/manage_investment_transactions call: send batches of about 25 items, with a report_progress before each. The smaller calls compose faster and each one is a fresh sign of life.",
          "- A status-only side channel is NOT possible: a tool call cannot be sent while you are still composing another, so frequent small informative calls -- not a parallel heartbeat -- are how you stay connected.",
          "- If report_progress or post_response ever returns delivered:false, do NOT abandon the task. Keep going: confirmation cards and your final post_response are buffered and shown to the user the moment the chat reconnects. Always finish and call post_response with a closing summary.",
          "- ALWAYS send a final post_response after the LAST confirmation card, even when every batch was already shown as a card. A card is a pending approval, not a reply -- without a closing message the user is left staring at cards with no idea whether more are coming. The closing message must explicitly say (a) that all batches have now been sent (e.g. 'That's all 4 batches -- 84 rows total'), (b) ask them to review and approve each card, and (c) tell them to let you know once they have approved them (or that you'll wait), so they have a clear 'done sending, your turn' signal. Send it as one post_response once the last card is out; do not stay silent after the final card.",
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
    this.relayAttachmentResource.register(server, resolve);

    this.financialReviewPrompt.register(server);
    this.budgetCheckPrompt.register(server);
    this.transactionLookupPrompt.register(server);
    this.spendingAnalysisPrompt.register(server);

    return server;
  }
}
