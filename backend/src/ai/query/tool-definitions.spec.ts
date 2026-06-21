import { FINANCIAL_TOOLS } from "./tool-definitions";

describe("FINANCIAL_TOOLS", () => {
  it("defines exactly 22 tools", () => {
    expect(FINANCIAL_TOOLS).toHaveLength(22);
  });

  it("has unique tool names", () => {
    const names = FINANCIAL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  const expectedTools = [
    "list_transactions",
    "list_accounts",
    "list_categories",
    "get_net_worth_history",
    "compare_periods",
    "get_portfolio_summary",
    "list_investment_transactions",
    "list_capital_gains",
    "list_upcoming_bills",
    "get_budget_status",
    "calculate",
    "render_chart",
    "manage_transactions",
    "manage_payees",
    "lookup_securities",
    "manage_securities",
    "manage_investment_transactions",
    "list_payees",
    "list_holding_details",
    "generate_report",
    "list_anomalies",
    "monthly_comparison",
  ];

  it("matches the expected tool set exactly", () => {
    expect(FINANCIAL_TOOLS.map((t) => t.name).sort()).toEqual(
      [...expectedTools].sort(),
    );
  });

  it.each(expectedTools)("includes the %s tool", (toolName) => {
    const tool = FINANCIAL_TOOLS.find((t) => t.name === toolName);
    expect(tool).toBeDefined();
    expect(tool!.description).toBeTruthy();
    expect(tool!.inputSchema).toBeDefined();
    expect(tool!.inputSchema.type).toBe("object");
  });

  describe("list_transactions", () => {
    it("has no required fields (dates default to last 30 days)", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "list_transactions")!;
      expect(tool.inputSchema.required).toBeUndefined();
    });

    it("supports groupBy with valid enum values including none", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "list_transactions")!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.groupBy.enum).toEqual([
        "category",
        "payee",
        "year",
        "month",
        "week",
        "none",
      ]);
    });

    it("supports direction filtering", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "list_transactions")!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.direction.enum).toEqual(["expenses", "income", "both"]);
    });

    it("exposes includeTransactions and transfersOnly flags", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "list_transactions")!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.includeTransactions.type).toBe("boolean");
      expect(props.transfersOnly.type).toBe("boolean");
    });
  });

  describe("list_accounts", () => {
    it("has no required fields", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "list_accounts")!;
      expect(tool.inputSchema.required).toBeUndefined();
    });

    it("supports status filter with open/closed/all", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "list_accounts")!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.status.enum).toEqual(["open", "closed", "all"]);
    });

    it("supports accountIds and nameQuery filters", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "list_accounts")!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.accountIds.type).toBe("array");
      expect(props.nameQuery.type).toBe("string");
    });

    it("exposes every AccountType in the accountTypes enum", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "list_accounts")!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      const items = props.accountTypes.items as Record<string, unknown>;
      expect(items.enum).toEqual([
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
      ]);
    });
  });

  describe("list_categories", () => {
    it("has no required fields (type defaults to all)", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "list_categories")!;
      expect(tool.inputSchema.required).toBeUndefined();
    });

    it("supports type filter with expense/income/all", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "list_categories")!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.type.enum).toEqual(["expense", "income", "all"]);
    });

    it("exposes an optional search parameter", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "list_categories")!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.search).toBeDefined();
      expect(props.search.type).toBe("string");
    });
  });

  describe("get_net_worth_history", () => {
    it("has no required fields (defaults to 12 months)", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "get_net_worth_history",
      )!;
      expect(tool.inputSchema.required).toBeUndefined();
    });
  });

  describe("compare_periods", () => {
    it("has no required fields (defaults to previous month vs current month-to-date)", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "compare_periods")!;
      expect(tool.inputSchema.required).toBeUndefined();
    });

    it("supports groupBy with category and payee", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "compare_periods")!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.groupBy.enum).toEqual(["category", "payee"]);
    });
  });

  describe("get_portfolio_summary", () => {
    it("has no required fields", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "get_portfolio_summary",
      )!;
      expect(tool.inputSchema.required).toBeUndefined();
    });

    it("supports optional accountNames filter", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "get_portfolio_summary",
      )!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.accountNames).toBeDefined();
      expect(props.accountNames.type).toBe("array");
    });
  });

  describe("list_investment_transactions", () => {
    it("has no required fields", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "list_investment_transactions",
      )!;
      expect(tool.inputSchema.required).toBeUndefined();
    });

    it("supports groupBy with account, date, security, and action", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "list_investment_transactions",
      )!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.groupBy.enum).toEqual([
        "account",
        "date",
        "security",
        "action",
      ]);
    });

    it("exposes the full set of investment actions in the actions enum", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "list_investment_transactions",
      )!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      const items = props.actions.items as Record<string, unknown>;
      expect(items.enum).toEqual([
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
      ]);
    });

    it("supports optional accountNames and symbols array filters", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "list_investment_transactions",
      )!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.accountNames.type).toBe("array");
      expect(props.symbols.type).toBe("array");
    });
  });

  describe("list_upcoming_bills", () => {
    it("has no required fields (days defaults to 30)", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "list_upcoming_bills",
      )!;
      expect(tool.inputSchema.required).toBeUndefined();
    });

    it("supports kind with bill/deposit/transfer/investment/all", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "list_upcoming_bills",
      )!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.kind.enum).toEqual([
        "bill",
        "deposit",
        "transfer",
        "investment",
        "all",
      ]);
    });

    it("supports optional accountNames filter", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "list_upcoming_bills",
      )!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.accountNames).toBeDefined();
      expect(props.accountNames.type).toBe("array");
    });
  });

  describe("get_budget_status", () => {
    it("has no required fields", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "get_budget_status")!;
      expect(tool.inputSchema.required).toBeUndefined();
    });

    it("supports period and budgetName parameters", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "get_budget_status")!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.period).toBeDefined();
      expect(props.budgetName).toBeDefined();
    });
  });

  describe("calculate", () => {
    it("requires operation and values", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "calculate")!;
      expect(tool.inputSchema.required).toEqual(["operation", "values"]);
    });

    it("supports all arithmetic operations", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "calculate")!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.operation.enum).toEqual([
        "percentage",
        "difference",
        "ratio",
        "sum",
        "average",
      ]);
    });

    it("has optional label parameter", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "calculate")!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.label).toBeDefined();
      expect(props.label.type).toBe("string");
    });
  });

  describe("render_chart", () => {
    it("requires type, title, and data", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "render_chart")!;
      expect(tool.inputSchema.required).toEqual(["type", "title", "data"]);
    });

    it("supports the four recharts-compatible chart types", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "render_chart")!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.type.enum).toEqual(["bar", "pie", "line", "area"]);
    });

    it("caps data at 20 points with labeled objects", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "render_chart")!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.data.type).toBe("array");
      expect(props.data.maxItems).toBe(20);
      expect(props.data.minItems).toBe(1);
      const items = props.data.items as Record<string, unknown>;
      expect(items.type).toBe("object");
      expect(items.required).toEqual(["label", "value"]);
    });
  });

  describe("manage_investment_transactions", () => {
    it("requires operation and items", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "manage_investment_transactions",
      )!;
      expect(tool.inputSchema.required).toEqual(["operation", "items"]);
    });

    it("supports the create/update/delete operation enum", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "manage_investment_transactions",
      )!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.operation.enum).toEqual(["create", "update", "delete"]);
    });

    it("exposes an items array and approvalMode enum", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "manage_investment_transactions",
      )!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.items.type).toBe("array");
      expect(props.items.maxItems).toBe(25);
      expect(props.approvalMode.enum).toEqual(["bulk", "individual"]);
    });
  });

  it("every tool has all required AiToolDefinition fields", () => {
    for (const tool of FINANCIAL_TOOLS) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.inputSchema).toBe("object");
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });
});
