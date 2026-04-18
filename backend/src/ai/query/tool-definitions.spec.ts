import { FINANCIAL_TOOLS } from "./tool-definitions";

describe("FINANCIAL_TOOLS", () => {
  it("defines exactly 12 tools", () => {
    expect(FINANCIAL_TOOLS).toHaveLength(12);
  });

  it("has unique tool names", () => {
    const names = FINANCIAL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  const expectedTools = [
    "query_transactions",
    "get_account_balances",
    "get_spending_by_category",
    "get_income_summary",
    "get_net_worth_history",
    "compare_periods",
    "get_portfolio_summary",
    "query_investment_transactions",
    "get_transfers",
    "get_budget_status",
    "calculate",
    "render_chart",
  ];

  it.each(expectedTools)("includes the %s tool", (toolName) => {
    const tool = FINANCIAL_TOOLS.find((t) => t.name === toolName);
    expect(tool).toBeDefined();
    expect(tool!.description).toBeTruthy();
    expect(tool!.inputSchema).toBeDefined();
    expect(tool!.inputSchema.type).toBe("object");
  });

  describe("query_transactions", () => {
    it("requires startDate and endDate", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "query_transactions",
      )!;
      expect(tool.inputSchema.required).toEqual(["startDate", "endDate"]);
    });

    it("supports groupBy with valid enum values", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "query_transactions",
      )!;
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
      ]);
    });

    it("supports direction filtering", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "query_transactions",
      )!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.direction.enum).toEqual(["expenses", "income", "both"]);
    });
  });

  describe("get_account_balances", () => {
    it("has no required fields", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "get_account_balances",
      )!;
      expect(tool.inputSchema.required).toBeUndefined();
    });
  });

  describe("get_spending_by_category", () => {
    it("requires startDate and endDate", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "get_spending_by_category",
      )!;
      expect(tool.inputSchema.required).toEqual(["startDate", "endDate"]);
    });

    it("supports topN parameter", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "get_spending_by_category",
      )!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.topN.type).toBe("integer");
    });
  });

  describe("get_income_summary", () => {
    it("supports groupBy with category, payee, and month", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "get_income_summary",
      )!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.groupBy.enum).toEqual(["category", "payee", "month"]);
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
    it("requires all four period boundary dates", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "compare_periods")!;
      expect(tool.inputSchema.required).toEqual([
        "period1Start",
        "period1End",
        "period2Start",
        "period2End",
      ]);
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

  describe("query_investment_transactions", () => {
    it("has no required fields", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "query_investment_transactions",
      )!;
      expect(tool.inputSchema.required).toBeUndefined();
    });

    it("supports groupBy with account, date, security, and action", () => {
      const tool = FINANCIAL_TOOLS.find(
        (t) => t.name === "query_investment_transactions",
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
        (t) => t.name === "query_investment_transactions",
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
        (t) => t.name === "query_investment_transactions",
      )!;
      const props = tool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.accountNames.type).toBe("array");
      expect(props.symbols.type).toBe("array");
    });
  });

  describe("get_transfers", () => {
    it("requires startDate and endDate", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "get_transfers")!;
      expect(tool.inputSchema.required).toEqual(["startDate", "endDate"]);
    });

    it("supports optional accountNames filter", () => {
      const tool = FINANCIAL_TOOLS.find((t) => t.name === "get_transfers")!;
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
