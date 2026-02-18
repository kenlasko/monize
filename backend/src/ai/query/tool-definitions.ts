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
          description: "Filter by account names. Use exact names from the user's account list.",
        },
        searchText: {
          type: "string",
          description: "Search payee names or transaction descriptions",
        },
        groupBy: {
          type: "string",
          enum: ["category", "payee", "month", "week"],
          description: "How to group results for breakdown",
        },
        direction: {
          type: "string",
          enum: ["expenses", "income", "both"],
          description:
            "Filter by direction: 'expenses' for negative amounts, 'income' for positive, 'both' for all. Default: both.",
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
          type: "number",
          description: "Limit to top N categories by amount (default: all)",
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
          description:
            "How to group comparison (default: category)",
        },
        direction: {
          type: "string",
          enum: ["expenses", "income", "both"],
          description:
            "Filter by direction (default: expenses)",
        },
      },
      required: ["period1Start", "period1End", "period2Start", "period2End"],
    },
  },
];
