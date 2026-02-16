export interface DemoReport {
  name: string;
  description: string;
  icon: string;
  backgroundColor: string;
  viewType: string;
  timeframeType: string;
  groupBy: string;
  filters: Record<string, unknown>;
  config: Record<string, unknown>;
  isFavourite: boolean;
  sortOrder: number;
}

export const demoReports: DemoReport[] = [
  {
    name: "Monthly Spending by Category",
    description: "Breakdown of spending across all expense categories",
    icon: "chart-bar",
    backgroundColor: "#3B82F6",
    viewType: "BAR_CHART",
    timeframeType: "LAST_6_MONTHS",
    groupBy: "CATEGORY",
    filters: {},
    config: {
      metric: "TOTAL_AMOUNT",
      includeTransfers: false,
      direction: "EXPENSES_ONLY",
    },
    isFavourite: true,
    sortOrder: 0,
  },
  {
    name: "Income vs Expenses",
    description: "Monthly income compared to expenses over the past year",
    icon: "scale",
    backgroundColor: "#10B981",
    viewType: "LINE_CHART",
    timeframeType: "LAST_12_MONTHS",
    groupBy: "MONTH",
    filters: {},
    config: {
      metric: "TOTAL_AMOUNT",
      includeTransfers: false,
      direction: "BOTH",
    },
    isFavourite: true,
    sortOrder: 1,
  },
  {
    name: "Top Payees",
    description: "Where the most money is being spent",
    icon: "users",
    backgroundColor: "#8B5CF6",
    viewType: "PIE_CHART",
    timeframeType: "LAST_3_MONTHS",
    groupBy: "PAYEE",
    filters: {},
    config: {
      metric: "TOTAL_AMOUNT",
      includeTransfers: false,
      direction: "EXPENSES_ONLY",
    },
    isFavourite: false,
    sortOrder: 2,
  },
  {
    name: "Dining & Entertainment",
    description: "All food and entertainment spending",
    icon: "cake",
    backgroundColor: "#F59E0B",
    viewType: "TABLE",
    timeframeType: "LAST_3_MONTHS",
    groupBy: "NONE",
    filters: {},
    config: {
      metric: "NONE",
      includeTransfers: false,
      direction: "EXPENSES_ONLY",
      tableColumns: [
        "DATE",
        "PAYEE",
        "DESCRIPTION",
        "CATEGORY",
        "ACCOUNT",
        "VALUE",
      ],
      sortBy: "DATE",
      sortDirection: "DESC",
    },
    isFavourite: false,
    sortOrder: 3,
  },
];
