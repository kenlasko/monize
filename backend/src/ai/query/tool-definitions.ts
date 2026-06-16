import { AiToolDefinition } from "../providers/ai-provider.interface";

export const FINANCIAL_TOOLS: AiToolDefinition[] = [
  {
    name: "query_transactions",
    description:
      "Search and aggregate transaction data. Returns totals, counts, and breakdowns — never individual transaction details. Use this for questions about spending, income, or transaction patterns.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: {
          type: "string",
          description:
            "Start date in YYYY-MM-DD format. Omit to default to 30 days ago.",
        },
        endDate: {
          type: "string",
          description:
            "End date in YYYY-MM-DD format. Omit to default to today.",
        },
        categoryNames: {
          type: "array",
          items: { type: "string" },
          description:
            'Filter by category names (e.g., ["Groceries", "Dining Out"]). Use exact names from the user\'s category list. To target a subcategory unambiguously, use "Parent: Child" notation (e.g., "Food: Dining Out"). If any name cannot be resolved the tool returns an error -- call get_categories first if unsure.',
        },
        accountNames: {
          type: "array",
          items: { type: "string" },
          description:
            "Filter by account names. Use exact names from the user's account list.",
        },
        searchText: {
          type: "string",
          description: "Search payee names or transaction descriptions",
        },
        groupBy: {
          type: "string",
          enum: ["category", "payee", "year", "month", "week"],
          description: "How to group results for breakdown",
        },
        direction: {
          type: "string",
          enum: ["expenses", "income", "both"],
          description:
            "Filter by direction. Must be EXACTLY one of: 'expenses' (outflows/spending), 'income' (inflows/earnings), or 'both' (default). Do not use 'expense', 'all', 'debit', or any variation.",
        },
      },
    },
  },
  {
    name: "get_account_balances",
    description:
      "Get current account balances, total assets, total liabilities, and net worth. Use this for questions about how much money the user has.",
    inputSchema: {
      type: "object",
      properties: {
        accountNames: {
          type: "array",
          items: { type: "string" },
          description: "Optional: filter to specific account names",
        },
        status: {
          type: "string",
          enum: ["open", "closed", "all"],
          description:
            "Which accounts to include by status. 'open' returns only active accounts, 'closed' returns only closed accounts, 'all' returns both. Defaults to 'open'.",
        },
        accountTypes: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "CHEQUING",
              "SAVINGS",
              "CREDIT_CARD",
              "LOAN",
              "MORTGAGE",
              "INVESTMENT",
              "CASH",
              "LINE_OF_CREDIT",
              "ASSET",
              "OTHER",
            ],
          },
          description:
            "Optional: filter to specific account types. Values must be UPPER_SNAKE_CASE exactly as listed. Omit to include all account types.",
        },
      },
    },
  },
  {
    name: "get_categories",
    description:
      "List the user's categories with their hierarchy (parent names) and transaction counts. Use this for questions like 'what categories do I have', 'list my income categories', or 'do I have a category for groceries'. Returns a flat list with each category's parent name so hierarchy is visible without nested JSON. Do not use this to query spending amounts -- use get_spending_by_category for that.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["expense", "income", "all"],
          description:
            "Filter by category type. 'expense' returns only expense categories, 'income' returns only income categories, 'all' returns both. Defaults to 'all'.",
        },
        search: {
          type: "string",
          description:
            "Optional case-insensitive substring match on category name. If a matching category is a subcategory, its parent is included so the hierarchy stays visible.",
        },
      },
    },
  },
  {
    name: "get_spending_by_category",
    description:
      "Get a breakdown of spending (expenses) by category for a given date range. Returns each category with its total amount, percentage of total spending, and transaction count. Sorted by amount descending.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: {
          type: "string",
          description:
            "Start date (YYYY-MM-DD). Omit to default to 30 days ago.",
        },
        endDate: {
          type: "string",
          description: "End date (YYYY-MM-DD). Omit to default to today.",
        },
        topN: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description:
            'Integer between 1 and 50 to limit to the top N categories by amount. MUST be a number like 10 (not a string like "10" or "all"). Omit to default to 10.',
        },
      },
    },
  },
  {
    name: "get_income_summary",
    description:
      "Get income summary for a date range, broken down by category, payee (source), or month.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: {
          type: "string",
          description:
            "Start date (YYYY-MM-DD). Omit to default to 30 days ago.",
        },
        endDate: {
          type: "string",
          description: "End date (YYYY-MM-DD). Omit to default to today.",
        },
        groupBy: {
          type: "string",
          enum: ["category", "payee", "month"],
          description: "How to group income (default: category)",
        },
      },
    },
  },
  {
    name: "get_net_worth_history",
    description:
      "Get monthly net worth history showing assets, liabilities, and net worth over time. Use for trend questions about overall financial health.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: {
          type: "string",
          description: "Start date (YYYY-MM-DD). Defaults to 12 months ago.",
        },
        endDate: {
          type: "string",
          description: "End date (YYYY-MM-DD). Defaults to today.",
        },
      },
    },
  },
  {
    name: "compare_periods",
    description:
      "Compare spending or income between two time periods. Returns a side-by-side comparison showing absolute and percentage changes. Use for questions like 'compare this month vs last month'. If any of the four date fields are omitted, defaults to the previous full month (period1) vs the current month-to-date (period2).",
    inputSchema: {
      type: "object",
      properties: {
        period1Start: {
          type: "string",
          description:
            "First period start date (YYYY-MM-DD). Omit to default to the start of last month.",
        },
        period1End: {
          type: "string",
          description:
            "First period end date (YYYY-MM-DD). Omit to default to the last day of last month.",
        },
        period2Start: {
          type: "string",
          description:
            "Second period start date (YYYY-MM-DD). Omit to default to the start of the current month.",
        },
        period2End: {
          type: "string",
          description:
            "Second period end date (YYYY-MM-DD). Omit to default to today.",
        },
        groupBy: {
          type: "string",
          enum: ["category", "payee"],
          description: "How to group comparison (default: category)",
        },
        direction: {
          type: "string",
          enum: ["expenses", "income", "both"],
          description:
            "Filter by direction. Must be EXACTLY one of: 'expenses' (default), 'income', or 'both'. Do not use 'expense', 'all', or any variation.",
        },
      },
    },
  },
  {
    name: "get_portfolio_summary",
    description:
      "Get the user's investment holdings and portfolio performance. Returns each held security (symbol, name, security type, quantity, cost basis, current market value, unrealized gain/loss, and percent return) plus portfolio-wide totals (total holdings value, total cost basis, total portfolio value, total unrealized gain/loss, time-weighted return, CAGR) and asset allocation percentages. Holdings are sorted by market value descending. Use this for questions like 'what stocks do I own', 'how is my portfolio performing', 'what's my asset allocation', or 'how much have I made on <symbol>'. Market values come from the latest stored security prices -- they may be a day or two stale if price updates haven't run.",
    inputSchema: {
      type: "object",
      properties: {
        accountNames: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: filter to specific investment account names. Use exact names from the user's account list. Omit to cover all investment accounts.",
        },
      },
    },
  },
  {
    name: "query_investment_transactions",
    description:
      "Query the user's brokerage investment-account transactions (buys, sells, dividends, interest, capital gains, splits, transfers, reinvestments, share adjustments). Returns aggregate totals (count, total amount, total commission, action breakdown) and a capped list of matching transactions. Optionally group the results by account, date, security (symbol), or transaction type (action). Use this for questions like 'what did I buy last month', 'show my AAPL trades', 'how much did I pay in commissions', or 'what dividends did I receive'. Do not use for the current portfolio holdings or unrealized gains — use get_portfolio_summary for that.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: {
          type: "string",
          description: "Optional start date (YYYY-MM-DD).",
        },
        endDate: {
          type: "string",
          description: "Optional end date (YYYY-MM-DD).",
        },
        accountNames: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: filter to specific investment account names. Use exact names from the user's account list.",
        },
        symbols: {
          type: "array",
          items: { type: "string" },
          description:
            'Optional: filter to specific security ticker symbols (e.g., ["AAPL", "MSFT"]). Case insensitive.',
        },
        actions: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "BUY",
              "SELL",
              "DIVIDEND",
              "INTEREST",
              "CAPITAL_GAIN",
              "SPLIT",
              "TRANSFER_IN",
              "TRANSFER_OUT",
              "REINVEST",
              "ADD_SHARES",
              "REMOVE_SHARES",
            ],
          },
          description:
            "Optional: filter to specific transaction types. Values must be UPPER_SNAKE_CASE exactly as listed.",
        },
        groupBy: {
          type: "string",
          enum: ["account", "date", "security", "action"],
          description:
            "Group the results by account name, transaction date, security symbol, or action type. Defaults to 'security' when omitted.",
        },
      },
    },
  },
  {
    name: "get_capital_gains",
    description:
      "Get per-period capital gains (realized + unrealized) for the user's investment accounts. Replays transaction history against historical close prices, so the result includes mark-to-market movement on currently-held positions in addition to realized gains from SELLs. Useful for 'how did my portfolio do last year', 'did I have any unrealized losses last month', or 'which securities drove my gains this quarter'. Returns period totals plus a breakdown grouped by month, security, or account. Requires startDate and endDate. All monetary values are in the holding account's currency; when a bucket spans accounts with different currencies its 'currency' field is null and sums are mixed.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: {
          type: "string",
          description: "Start date of the window (YYYY-MM-DD). Required.",
        },
        endDate: {
          type: "string",
          description: "End date of the window (YYYY-MM-DD). Required.",
        },
        accountNames: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: filter to specific investment account names. Use exact names from the user's account list.",
        },
        symbols: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: filter to specific security ticker symbols (case insensitive).",
        },
        groupBy: {
          type: "string",
          enum: ["month", "security", "account"],
          description:
            "Bucket the breakdown by month, security (symbol), or account. Defaults to 'month' when omitted.",
        },
      },
      required: ["startDate", "endDate"],
    },
  },
  {
    name: "get_transfers",
    description:
      "Get transfer activity between the user's own accounts for a date range. Returns per-account inbound (money received from another account), outbound (money sent to another account), net movement, and transfer count. Transfers are deliberately excluded from spending and income tools because they net to zero across accounts; use this tool for questions like 'how much did I move into my savings', 'what went out of chequing to other accounts', or 'what are my transfers between accounts'.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: {
          type: "string",
          description:
            "Start date (YYYY-MM-DD). Omit to default to 30 days ago.",
        },
        endDate: {
          type: "string",
          description: "End date (YYYY-MM-DD). Omit to default to today.",
        },
        accountNames: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: filter to specific account names. Use exact names from the user's account list.",
        },
      },
    },
  },
  {
    name: "get_upcoming_bills",
    description:
      "Get upcoming scheduled bills and deposits due within a date window. Each item is classified as bill (scheduled outflow), deposit (scheduled inflow), transfer, or investment, and includes a daysUntilDue value (negative when overdue). Returns rollup totals for upcoming bills and deposits plus the per-item list. Use for questions like 'what bills are coming up', 'when is rent due', or 'what deposits am I expecting this month'.",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "integer",
          minimum: 1,
          maximum: 365,
          description:
            "Number of days to look ahead from today. Defaults to 30. Includes overdue items (daysUntilDue < 0) that have not been posted yet.",
        },
        kind: {
          type: "string",
          enum: ["bill", "deposit", "transfer", "investment", "all"],
          description:
            "Narrow to a single kind: 'bill' (scheduled outflow), 'deposit' (scheduled inflow), 'transfer' (between own accounts), or 'investment'. Omit or pass 'all' to include everything.",
        },
        accountNames: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: filter to specific account names. Use exact names from the user's account list.",
        },
      },
    },
  },
  {
    name: "get_scheduled_transactions",
    description:
      "List all scheduled/recurring transactions (bills, deposits, transfers, investments), regardless of whether they're due soon. Returns rollup counts plus a curated per-item payload with kind, frequency, next due date, account, and amount. Use for questions like 'what recurring bills do I have', 'list all my scheduled deposits', or 'which schedules are paused'.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["bill", "deposit", "transfer", "investment", "all"],
          description:
            "Narrow to a single kind: 'bill' (scheduled outflow), 'deposit' (scheduled inflow), 'transfer' (between own accounts), or 'investment'. Omit or pass 'all' to include everything.",
        },
        accountNames: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: filter to specific account names. Use exact names from the user's account list.",
        },
        isActive: {
          type: "boolean",
          description:
            "Filter by active status. true = only active schedules, false = only paused. Omit to include both.",
        },
      },
    },
  },
  {
    name: "get_budget_status",
    description:
      "Get budget status for a specific period. Returns total budgeted vs actual spending, per-category breakdowns, spending velocity, safe daily spend, and health score. Use for questions like 'how am I doing on my budget?', 'which categories am I overspending in?', or 'how much can I still spend this month?'.",
    inputSchema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          description:
            "Which period to check: 'CURRENT' for the current month, 'PREVIOUS' for last month, or a specific month in YYYY-MM format. Default: CURRENT.",
        },
        budgetName: {
          type: "string",
          description:
            "Optional: filter to a specific budget by name. If omitted, uses the first active budget.",
        },
      },
    },
  },
  {
    name: "calculate",
    description:
      "Perform accurate server-side arithmetic on numbers from previous tool results. Use this instead of doing math yourself. Supports: percentage (part/whole*100), difference (a-b), ratio (a/b), sum, and average. Always use this tool for any calculation rather than computing values yourself.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["percentage", "difference", "ratio", "sum", "average"],
          description:
            "The arithmetic operation to perform. 'percentage' computes (values[0] / values[1]) * 100. 'difference' computes values[0] - values[1]. 'ratio' computes values[0] / values[1]. 'sum' adds all values. 'average' computes the arithmetic mean.",
        },
        values: {
          type: "array",
          items: { type: "number" },
          minItems: 1,
          description:
            "The numbers to calculate with. For percentage, difference, and ratio: [a, b]. For sum and average: any number of values.",
        },
        label: {
          type: "string",
          description:
            "Optional label describing what this calculation represents (e.g., 'savings rate', 'monthly average spending').",
        },
      },
      required: ["operation", "values"],
    },
  },
  {
    name: "render_chart",
    description:
      "Render a chart in the chat so the user can see the data visually. Call this AFTER gathering numbers with another tool (query_transactions, get_spending_by_category, get_net_worth_history, compare_periods, etc.). Choose the chart type that fits the data: 'pie' for category breakdowns with 6 or fewer slices, 'bar' for larger breakdowns or period comparisons, 'line' or 'area' for time series (months or weeks). Pass a compact subset of the data (at most 10-15 data points) and aggregate the long tail into an 'Other' bucket. Values must be positive numbers (use absolute values for expenses). Do not narrate the chart's existence in your reply; just render it and summarize the findings.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["bar", "pie", "line", "area"],
          description:
            "Chart type. 'bar' and 'pie' for categorical breakdowns; 'line' and 'area' for time series.",
        },
        title: {
          type: "string",
          description:
            "Short, human-readable chart title (for example, 'Spending by Category — March 2026'). Max 120 characters.",
        },
        data: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              label: {
                type: "string",
                description:
                  "Data point label (category name, month, period, etc.). Max 80 characters.",
              },
              value: {
                type: "number",
                description:
                  "Non-negative numeric value for this data point. Use absolute values for expenses.",
              },
            },
            required: ["label", "value"],
          },
          description:
            "Data points to chart. Keep to 10-15 entries for readability; aggregate the tail into an 'Other' bucket.",
        },
      },
      required: ["type", "title", "data"],
    },
  },
  {
    name: "search_transactions",
    description:
      "Find individual transactions and return their IDs along with date, payee, amount, category, and account. Use this ONLY when you need a specific transaction's ID to act on it (for example before categorize_transaction), or when the user explicitly asks to see specific transactions. For totals, breakdowns, and spending questions use query_transactions instead. Returns a small capped list.",
    inputSchema: {
      type: "object",
      properties: {
        searchText: {
          type: "string",
          description: "Match payee names or transaction descriptions.",
        },
        startDate: {
          type: "string",
          description: "Start date (YYYY-MM-DD).",
        },
        endDate: {
          type: "string",
          description: "End date (YYYY-MM-DD).",
        },
        accountName: {
          type: "string",
          description:
            "Filter to a single account. Use an exact name from the user's account list.",
        },
        categoryName: {
          type: "string",
          description:
            'Filter to a single category. Use an exact name from the user\'s category list ("Parent: Child" for a subcategory).',
        },
        minAmount: {
          type: "number",
          description: "Minimum signed amount (negative for expenses).",
        },
        maxAmount: {
          type: "number",
          description: "Maximum signed amount.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 25,
          description:
            "Maximum number of rows to return (1-25). Defaults to 25.",
        },
      },
    },
  },
  {
    name: "create_transaction",
    description:
      "Propose creating a new transaction. This does NOT create anything immediately: it shows the user a confirmation card they must explicitly approve before the transaction is saved. Use it only when the user clearly asks to add or record a transaction in their latest message. Amount is positive for income and negative for expenses. The payee name is automatically matched to an existing payee and linked; if the tool result reports that no payee matched, offer to create a reusable payee with create_payee. After calling this tool, briefly tell the user to review and approve the card; never claim the transaction was created.",
    inputSchema: {
      type: "object",
      properties: {
        accountName: {
          type: "string",
          description:
            "Account for the transaction. Use an exact name from the user's account list.",
        },
        amount: {
          type: "number",
          description:
            "Signed amount: positive for income/inflow, negative for an expense/outflow. Up to 4 decimal places.",
        },
        date: {
          type: "string",
          description: "Transaction date (YYYY-MM-DD).",
        },
        payeeName: {
          type: "string",
          description:
            "Optional payee name. Matched to an existing payee when one exists; otherwise recorded as a new free-text name.",
        },
        categoryName: {
          type: "string",
          description:
            'Optional category. Use an exact name from the user\'s category list ("Parent: Child" for a subcategory).',
        },
        description: {
          type: "string",
          description: "Optional description or memo.",
        },
      },
      required: ["accountName", "amount", "date"],
    },
  },
  {
    name: "categorize_transaction",
    description:
      "Propose assigning a category to an existing transaction. This does NOT change anything immediately: it shows the user a confirmation card they must approve. First call search_transactions to obtain the transactionId. After calling this tool, briefly tell the user to review and approve the card; never claim the change was applied.",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: {
          type: "string",
          description:
            "ID of the transaction to categorize, obtained from search_transactions.",
        },
        categoryName: {
          type: "string",
          description:
            'Category to assign. Use an exact name from the user\'s category list ("Parent: Child" for a subcategory).',
        },
      },
      required: ["transactionId", "categoryName"],
    },
  },
  {
    name: "create_payee",
    description:
      "Propose creating a new payee. This does NOT create anything immediately: it shows the user a confirmation card they must approve. Use it only when the user clearly asks to add a payee. After calling this tool, briefly tell the user to review and approve the card; never claim the payee was created.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Payee name.",
        },
        defaultCategoryName: {
          type: "string",
          description:
            "Optional default category for this payee. Use an exact name from the user's category list.",
        },
      },
      required: ["name"],
    },
  },
];
