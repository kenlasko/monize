import { FINANCIAL_TOOLS } from "./tool-definitions";

describe("FINANCIAL_TOOLS", () => {
  it("defines exactly 6 tools", () => {
    expect(FINANCIAL_TOOLS).toHaveLength(6);
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
      expect(props.topN.type).toBe("number");
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
