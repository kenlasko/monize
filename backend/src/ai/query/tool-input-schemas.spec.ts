import {
  validateToolInput,
  listTransactionsSchema,
  listAccountsSchema,
  getCategoriesSchema,
  comparePeriodsSchema,
  getPortfolioSummarySchema,
  listInvestmentTransactionsSchema,
  getBudgetStatusSchema,
  getUpcomingBillsSchema,
  calculateSchema,
  renderChartSchema,
  manageInvestmentTransactionsSchema,
  createTransactionsSchema,
} from "./tool-input-schemas";

describe("tool-input-schemas", () => {
  describe("validateToolInput()", () => {
    it("returns success with data for valid list_transactions input", () => {
      const result = validateToolInput("list_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.startDate).toBe("2026-01-01");
        expect(result.data.endDate).toBe("2026-01-31");
      }
    });

    it("returns success for unknown tool names (passthrough)", () => {
      const input = { foo: "bar", baz: 42 };
      const result = validateToolInput("unknown_tool", input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(input);
      }
    });

    it("returns error for invalid date format", () => {
      const result = validateToolInput("list_transactions", {
        startDate: "January 1, 2026",
        endDate: "2026-01-31",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Invalid input");
        expect(result.error).toContain("startDate");
      }
    });

    it("accepts empty input (dates are optional; handler applies defaults)", () => {
      const result = validateToolInput("list_transactions", {});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.startDate).toBeUndefined();
        expect(result.data.endDate).toBeUndefined();
      }
    });

    it("returns error for invalid groupBy value", () => {
      const result = validateToolInput("list_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        groupBy: "invalid_group",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("groupBy");
      }
    });

    it("strips extra fields via Zod parsing", () => {
      const result = validateToolInput("list_transactions", {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        maliciousField: "evil",
      });

      // Zod strips unknown keys by default
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).not.toHaveProperty("maliciousField");
      }
    });
  });

  describe("listTransactionsSchema", () => {
    it("accepts all optional fields", () => {
      const result = listTransactionsSchema.safeParse({
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        categoryNames: ["Groceries", "Dining"],
        accountNames: ["Checking"],
        payeeNames: ["Walmart"],
        searchText: "walmart",
        groupBy: "category",
        direction: "expenses",
        transfersOnly: true,
        includeTransactions: true,
        limit: 25,
      });

      expect(result.success).toBe(true);
    });

    it("accepts the 'none' groupBy value", () => {
      const result = listTransactionsSchema.safeParse({ groupBy: "none" });
      expect(result.success).toBe(true);
    });

    it("accepts empty input (all fields optional)", () => {
      const result = listTransactionsSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("rejects searchText over 200 chars", () => {
      const result = listTransactionsSchema.safeParse({
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        searchText: "a".repeat(201),
      });

      expect(result.success).toBe(false);
    });

    it("rejects truly unknown direction enum value", () => {
      const result = listTransactionsSchema.safeParse({
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        direction: "sideways",
      });

      expect(result.success).toBe(false);
    });

    it("rejects limit over 100", () => {
      const result = listTransactionsSchema.safeParse({ limit: 101 });
      expect(result.success).toBe(false);
    });

    it("normalizes common direction aliases to canonical values", () => {
      const cases: Array<[string, "expenses" | "income" | "both"]> = [
        ["expense", "expenses"],
        ["spending", "expenses"],
        ["debit", "expenses"],
        ["EXPENSES", "expenses"],
        ["earnings", "income"],
        ["revenue", "income"],
        ["credit", "income"],
        ["all", "both"],
        ["any", "both"],
      ];
      for (const [input, expected] of cases) {
        const result = listTransactionsSchema.safeParse({
          startDate: "2026-01-01",
          endDate: "2026-01-31",
          direction: input,
        });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.direction).toBe(expected);
        }
      }
    });
  });

  describe("listAccountsSchema", () => {
    it("accepts empty input", () => {
      const result = listAccountsSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("accepts accountNames filter", () => {
      const result = listAccountsSchema.safeParse({
        accountNames: ["Checking", "Savings"],
      });
      expect(result.success).toBe(true);
    });

    it("accepts accountIds (UUIDs) and nameQuery filters", () => {
      const result = listAccountsSchema.safeParse({
        accountIds: ["11111111-1111-4111-8111-111111111111"],
        nameQuery: "sav",
      });
      expect(result.success).toBe(true);
    });

    it("rejects accountIds that are not UUIDs", () => {
      const result = listAccountsSchema.safeParse({
        accountIds: ["not-a-uuid"],
      });
      expect(result.success).toBe(false);
    });

    it("rejects accountNames with items over 100 chars", () => {
      const result = listAccountsSchema.safeParse({
        accountNames: ["a".repeat(101)],
      });
      expect(result.success).toBe(false);
    });

    it("accepts the three status values", () => {
      for (const status of ["open", "closed", "all"]) {
        const result = listAccountsSchema.safeParse({ status });
        expect(result.success).toBe(true);
      }
    });

    it("rejects unknown status values", () => {
      const result = listAccountsSchema.safeParse({ status: "archived" });
      expect(result.success).toBe(false);
    });

    it("accepts accountTypes filter", () => {
      const result = listAccountsSchema.safeParse({
        accountTypes: ["CHEQUING", "SAVINGS"],
      });
      expect(result.success).toBe(true);
    });

    it("uppercases accountTypes inputs via preprocess", () => {
      const result = listAccountsSchema.safeParse({
        accountTypes: ["chequing", " savings "],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.accountTypes).toEqual(["CHEQUING", "SAVINGS"]);
      }
    });

    it("rejects an unknown account type", () => {
      const result = listAccountsSchema.safeParse({
        accountTypes: ["NOT_REAL"],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("getCategoriesSchema", () => {
    it("accepts empty input", () => {
      const result = getCategoriesSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("accepts all three type values", () => {
      for (const type of ["expense", "income", "all"]) {
        const result = getCategoriesSchema.safeParse({ type });
        expect(result.success).toBe(true);
      }
    });

    it("rejects unknown type values", () => {
      const result = getCategoriesSchema.safeParse({ type: "transfer" });
      expect(result.success).toBe(false);
    });

    it("accepts a search string", () => {
      const result = getCategoriesSchema.safeParse({ search: "food" });
      expect(result.success).toBe(true);
    });

    it("rejects a search string over 100 chars", () => {
      const result = getCategoriesSchema.safeParse({
        search: "a".repeat(101),
      });
      expect(result.success).toBe(false);
    });
  });

  describe("comparePeriodsSchema", () => {
    it("validates all four period dates", () => {
      const result = comparePeriodsSchema.safeParse({
        period1Start: "2025-12-01",
        period1End: "2025-12-31",
        period2Start: "2026-01-01",
        period2End: "2026-01-31",
      });
      expect(result.success).toBe(true);
    });

    it("accepts missing period dates (handler applies defaults)", () => {
      const result = comparePeriodsSchema.safeParse({
        period1Start: "2025-12-01",
        period1End: "2025-12-31",
        // period2Start and period2End omitted; defaulted in the executor
      });
      expect(result.success).toBe(true);
    });

    it("accepts empty input (dates are optional)", () => {
      const result = comparePeriodsSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("accepts optional groupBy and direction", () => {
      const result = comparePeriodsSchema.safeParse({
        period1Start: "2025-12-01",
        period1End: "2025-12-31",
        period2Start: "2026-01-01",
        period2End: "2026-01-31",
        groupBy: "payee",
        direction: "income",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("getPortfolioSummarySchema", () => {
    it("accepts empty input", () => {
      const result = getPortfolioSummarySchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("accepts accountNames filter", () => {
      const result = getPortfolioSummarySchema.safeParse({
        accountNames: ["Brokerage", "TFSA"],
      });
      expect(result.success).toBe(true);
    });

    it("rejects account names over 100 chars", () => {
      const result = getPortfolioSummarySchema.safeParse({
        accountNames: ["a".repeat(101)],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("listInvestmentTransactionsSchema", () => {
    it("accepts empty input (all filters optional)", () => {
      const result = listInvestmentTransactionsSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("accepts all optional filters", () => {
      const result = listInvestmentTransactionsSchema.safeParse({
        startDate: "2026-01-01",
        endDate: "2026-03-31",
        accountNames: ["Brokerage"],
        symbols: ["AAPL", "MSFT"],
        actions: ["BUY", "SELL", "DIVIDEND"],
        groupBy: "security",
      });
      expect(result.success).toBe(true);
    });

    it("uppercases action inputs via preprocess", () => {
      const result = listInvestmentTransactionsSchema.safeParse({
        actions: ["buy", " sell ", "Dividend"],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.actions).toEqual(["BUY", "SELL", "DIVIDEND"]);
      }
    });

    it("rejects an unknown action value", () => {
      const result = listInvestmentTransactionsSchema.safeParse({
        actions: ["NOT_REAL"],
      });
      expect(result.success).toBe(false);
    });

    it("rejects an invalid groupBy value", () => {
      const result = listInvestmentTransactionsSchema.safeParse({
        groupBy: "category",
      });
      expect(result.success).toBe(false);
    });

    it("rejects an invalid date format", () => {
      const result = listInvestmentTransactionsSchema.safeParse({
        startDate: "Jan 1 2026",
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty symbol strings", () => {
      const result = listInvestmentTransactionsSchema.safeParse({
        symbols: [""],
      });
      expect(result.success).toBe(false);
    });

    it("rejects symbols longer than 20 chars", () => {
      const result = listInvestmentTransactionsSchema.safeParse({
        symbols: ["a".repeat(21)],
      });
      expect(result.success).toBe(false);
    });

    it("accepts every groupBy enum value", () => {
      for (const groupBy of ["account", "date", "security", "action"]) {
        const result = listInvestmentTransactionsSchema.safeParse({ groupBy });
        expect(result.success).toBe(true);
      }
    });

    it("routes through validateToolInput", () => {
      const result = validateToolInput("list_investment_transactions", {
        symbols: ["aapl"],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        // symbols not uppercased by schema; preprocessing only applies to actions
        expect(result.data.symbols).toEqual(["aapl"]);
      }
    });
  });

  describe("manageInvestmentTransactionsSchema", () => {
    const createItem = {
      accountName: "Brokerage",
      action: "BUY",
      date: "2026-01-15",
      security: "AAPL",
      quantity: 10,
      price: 150,
      commission: 9.99,
    };

    it("accepts a valid single create", () => {
      const result = manageInvestmentTransactionsSchema.safeParse({
        operation: "create",
        items: [createItem],
      });
      expect(result.success).toBe(true);
    });

    it("accepts a minimal cash-only create (INTEREST)", () => {
      const result = manageInvestmentTransactionsSchema.safeParse({
        operation: "create",
        items: [
          { accountName: "Brokerage", action: "INTEREST", date: "2026-01-15" },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("uppercases the action via preprocess", () => {
      const result = manageInvestmentTransactionsSchema.safeParse({
        operation: "create",
        items: [{ ...createItem, action: " buy " }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.items[0].action).toBe("BUY");
      }
    });

    it("requires accountName/action/date on create rows", () => {
      const missingAccount = manageInvestmentTransactionsSchema.safeParse({
        operation: "create",
        items: [{ action: "BUY", date: "2026-01-15" }],
      });
      expect(missingAccount.success).toBe(false);

      const missingAction = manageInvestmentTransactionsSchema.safeParse({
        operation: "create",
        items: [{ accountName: "Brokerage", date: "2026-01-15" }],
      });
      expect(missingAction.success).toBe(false);

      const missingDate = manageInvestmentTransactionsSchema.safeParse({
        operation: "create",
        items: [{ accountName: "Brokerage", action: "BUY" }],
      });
      expect(missingDate.success).toBe(false);
    });

    it("accepts a valid update with at least one change", () => {
      const result = manageInvestmentTransactionsSchema.safeParse({
        operation: "update",
        items: [
          {
            transactionId: "11111111-1111-4111-8111-111111111111",
            quantity: 20,
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("requires transactionId on update rows", () => {
      const result = manageInvestmentTransactionsSchema.safeParse({
        operation: "update",
        items: [{ quantity: 20 }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects an update row with no fields to change", () => {
      const result = manageInvestmentTransactionsSchema.safeParse({
        operation: "update",
        items: [{ transactionId: "11111111-1111-4111-8111-111111111111" }],
      });
      expect(result.success).toBe(false);
    });

    it("accepts a valid delete with only transactionId", () => {
      const result = manageInvestmentTransactionsSchema.safeParse({
        operation: "delete",
        items: [{ transactionId: "11111111-1111-4111-8111-111111111111" }],
      });
      expect(result.success).toBe(true);
    });

    it("requires transactionId on delete rows", () => {
      const result = manageInvestmentTransactionsSchema.safeParse({
        operation: "delete",
        items: [{}],
      });
      expect(result.success).toBe(false);
    });

    it("rejects an unknown action", () => {
      const result = manageInvestmentTransactionsSchema.safeParse({
        operation: "create",
        items: [{ ...createItem, action: "PURCHASE" }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects a negative quantity", () => {
      const result = manageInvestmentTransactionsSchema.safeParse({
        operation: "create",
        items: [{ ...createItem, quantity: -1 }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects an empty items batch and a batch over 25 rows", () => {
      expect(
        manageInvestmentTransactionsSchema.safeParse({
          operation: "create",
          items: [],
        }).success,
      ).toBe(false);
      const rows26 = Array.from({ length: 26 }, () => ({ ...createItem }));
      expect(
        manageInvestmentTransactionsSchema.safeParse({
          operation: "create",
          items: rows26,
        }).success,
      ).toBe(false);
    });

    it("accepts an optional approvalMode", () => {
      const result = manageInvestmentTransactionsSchema.safeParse({
        operation: "create",
        items: [createItem],
        approvalMode: "individual",
      });
      expect(result.success).toBe(true);
    });

    it("routes through validateToolInput", () => {
      const result = validateToolInput("manage_investment_transactions", {
        operation: "create",
        items: [createItem],
      });
      expect(result.success).toBe(true);
    });
  });

  describe("getBudgetStatusSchema", () => {
    it("accepts empty input", () => {
      const result = getBudgetStatusSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("accepts period and budgetName", () => {
      const result = getBudgetStatusSchema.safeParse({
        period: "2026-01",
        budgetName: "Monthly Budget",
      });
      expect(result.success).toBe(true);
    });

    it("rejects budgetName over 100 chars", () => {
      const result = getBudgetStatusSchema.safeParse({
        budgetName: "a".repeat(101),
      });
      expect(result.success).toBe(false);
    });
  });

  describe("getUpcomingBillsSchema", () => {
    it("accepts empty input (days defaults via executor)", () => {
      const result = getUpcomingBillsSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("accepts days within range", () => {
      const result = getUpcomingBillsSchema.safeParse({ days: 7 });
      expect(result.success).toBe(true);
    });

    it("rejects days over 365", () => {
      const result = getUpcomingBillsSchema.safeParse({ days: 400 });
      expect(result.success).toBe(false);
    });

    it("rejects days of 0", () => {
      const result = getUpcomingBillsSchema.safeParse({ days: 0 });
      expect(result.success).toBe(false);
    });

    it("accepts every valid kind", () => {
      for (const kind of ["bill", "deposit", "transfer", "investment", "all"]) {
        const result = getUpcomingBillsSchema.safeParse({ kind });
        expect(result.success).toBe(true);
      }
    });

    it("normalizes uppercase/whitespace kind via preprocess", () => {
      const result = getUpcomingBillsSchema.safeParse({ kind: " BILL " });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.kind).toBe("bill");
      }
    });

    it("rejects unknown kind", () => {
      const result = getUpcomingBillsSchema.safeParse({ kind: "loan" });
      expect(result.success).toBe(false);
    });

    it("accepts accountNames filter", () => {
      const result = getUpcomingBillsSchema.safeParse({
        accountNames: ["Checking"],
      });
      expect(result.success).toBe(true);
    });
  });

  describe("calculateSchema", () => {
    it("accepts valid percentage input", () => {
      const result = calculateSchema.safeParse({
        operation: "percentage",
        values: [300, 5000],
      });
      expect(result.success).toBe(true);
    });

    it("accepts all operation types", () => {
      for (const op of [
        "percentage",
        "difference",
        "ratio",
        "sum",
        "average",
      ]) {
        const result = calculateSchema.safeParse({
          operation: op,
          values: [1, 2],
        });
        expect(result.success).toBe(true);
      }
    });

    it("accepts optional label", () => {
      const result = calculateSchema.safeParse({
        operation: "sum",
        values: [100, 200],
        label: "total spending",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.label).toBe("total spending");
      }
    });

    it("rejects empty values array", () => {
      const result = calculateSchema.safeParse({
        operation: "sum",
        values: [],
      });
      expect(result.success).toBe(false);
    });

    it("rejects unknown operation", () => {
      const result = calculateSchema.safeParse({
        operation: "modulo",
        values: [10, 3],
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-numeric values", () => {
      const result = calculateSchema.safeParse({
        operation: "sum",
        values: ["abc", "def"],
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing operation", () => {
      const result = calculateSchema.safeParse({
        values: [1, 2],
      });
      expect(result.success).toBe(false);
    });

    it("rejects label over 200 chars", () => {
      const result = calculateSchema.safeParse({
        operation: "sum",
        values: [1, 2],
        label: "a".repeat(201),
      });
      expect(result.success).toBe(false);
    });

    it("validates via validateToolInput", () => {
      const result = validateToolInput("calculate", {
        operation: "percentage",
        values: [500, 5000],
      });
      expect(result.success).toBe(true);
    });
  });

  describe("renderChartSchema", () => {
    const validInput = {
      type: "bar" as const,
      title: "Spending by Category",
      data: [
        { label: "Groceries", value: 500 },
        { label: "Dining", value: 250 },
      ],
    };

    it("accepts a valid bar chart payload", () => {
      const result = renderChartSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it("accepts all four chart types", () => {
      for (const type of ["bar", "pie", "line", "area"] as const) {
        const result = renderChartSchema.safeParse({ ...validInput, type });
        expect(result.success).toBe(true);
      }
    });

    it("rejects an unknown chart type", () => {
      const result = renderChartSchema.safeParse({
        ...validInput,
        type: "scatter",
      });
      expect(result.success).toBe(false);
    });

    it("rejects an empty data array", () => {
      const result = renderChartSchema.safeParse({ ...validInput, data: [] });
      expect(result.success).toBe(false);
    });

    it("rejects more than 20 data points", () => {
      const data = Array.from({ length: 21 }, (_, i) => ({
        label: `Item ${i}`,
        value: i,
      }));
      const result = renderChartSchema.safeParse({ ...validInput, data });
      expect(result.success).toBe(false);
    });

    it("rejects negative values", () => {
      const result = renderChartSchema.safeParse({
        ...validInput,
        data: [{ label: "Groceries", value: -10 }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects NaN values", () => {
      const result = renderChartSchema.safeParse({
        ...validInput,
        data: [{ label: "Groceries", value: Number.NaN }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-finite values (Infinity)", () => {
      const result = renderChartSchema.safeParse({
        ...validInput,
        data: [{ label: "Groceries", value: Number.POSITIVE_INFINITY }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects labels longer than 80 chars", () => {
      const result = renderChartSchema.safeParse({
        ...validInput,
        data: [{ label: "a".repeat(81), value: 10 }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects an empty label", () => {
      const result = renderChartSchema.safeParse({
        ...validInput,
        data: [{ label: "", value: 10 }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects a title longer than 120 chars", () => {
      const result = renderChartSchema.safeParse({
        ...validInput,
        title: "a".repeat(121),
      });
      expect(result.success).toBe(false);
    });

    it("rejects an empty title", () => {
      const result = renderChartSchema.safeParse({ ...validInput, title: "" });
      expect(result.success).toBe(false);
    });

    it("validates via validateToolInput", () => {
      const result = validateToolInput("render_chart", validInput);
      expect(result.success).toBe(true);
    });

    it("returns a useful error via validateToolInput on bad input", () => {
      const result = validateToolInput("render_chart", {
        type: "bogus",
        title: "",
        data: [],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Invalid input");
      }
    });
  });

  describe("bulk schemas", () => {
    const txRow = { accountName: "Checking", amount: -10, date: "2026-01-15" };

    it("accepts 1 to 25 rows", () => {
      expect(
        createTransactionsSchema.safeParse({ rows: [txRow] }).success,
      ).toBe(true);
      const rows25 = Array.from({ length: 25 }, () => ({ ...txRow }));
      expect(createTransactionsSchema.safeParse({ rows: rows25 }).success).toBe(
        true,
      );
    });

    it("rejects an empty batch and a batch over 25 rows", () => {
      expect(createTransactionsSchema.safeParse({ rows: [] }).success).toBe(
        false,
      );
      const rows26 = Array.from({ length: 26 }, () => ({ ...txRow }));
      expect(createTransactionsSchema.safeParse({ rows: rows26 }).success).toBe(
        false,
      );
    });

    it("validates each row against the singular row shape", () => {
      // Missing required amount on a row.
      const result = createTransactionsSchema.safeParse({
        rows: [{ accountName: "Checking", date: "2026-01-15" }],
      });
      expect(result.success).toBe(false);
    });
  });
});
