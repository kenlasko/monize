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
          description: "Start date in YYYY-MM-DD format",
        },
        endDate: {
          type: "string",
          description: "End date in YYYY-MM-DD format",
        },
        categoryNames: {
          type: "array",
          items: { type: "string" },
          description:
            'Filter by category names (e.g., ["Groceries", "Dining Out"]). Use exact names from the user\'s category list.',
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
      required: ["startDate", "endDate"],
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
          description: "Start date (YYYY-MM-DD)",
        },
        endDate: {
          type: "string",
          description: "End date (YYYY-MM-DD)",
        },
        topN: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description:
            'Optional integer between 1 and 50 to limit to the top N categories by amount. MUST be a number like 10 (not a string like "10" or "all"). Omit this field entirely to get all categories.',
        },
      },
      required: ["startDate", "endDate"],
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
          description: "Start date (YYYY-MM-DD)",
        },
        endDate: {
          type: "string",
          description: "End date (YYYY-MM-DD)",
        },
        groupBy: {
          type: "string",
          enum: ["category", "payee", "month"],
          description: "How to group income (default: category)",
        },
      },
      required: ["startDate", "endDate"],
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
      "Compare spending or income between two time periods. Returns a side-by-side comparison showing absolute and percentage changes. Use for questions like 'compare this month vs last month'.",
    inputSchema: {
      type: "object",
      properties: {
        period1Start: {
          type: "string",
          description: "First period start date (YYYY-MM-DD)",
        },
        period1End: {
          type: "string",
          description: "First period end date (YYYY-MM-DD)",
        },
        period2Start: {
          type: "string",
          description: "Second period start date (YYYY-MM-DD)",
        },
        period2End: {
          type: "string",
          description: "Second period end date (YYYY-MM-DD)",
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
      required: ["period1Start", "period1End", "period2Start", "period2End"],
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
            "Optional: group the results by account name, transaction date, security symbol, or action type.",
        },
      },
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
          description: "Start date (YYYY-MM-DD)",
        },
        endDate: {
          type: "string",
          description: "End date (YYYY-MM-DD)",
        },
        accountNames: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: filter to specific account names. Use exact names from the user's account list.",
        },
      },
      required: ["startDate", "endDate"],
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
];
