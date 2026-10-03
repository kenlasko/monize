import "reflect-metadata";
import {
  listTransactionRulesSchema,
  manageTransactionRulesSchema,
  validateToolInput,
} from "./tool-input-schemas";

const RULE = "e0000000-0000-4000-8000-000000000005";
const condition = { field: "payeeId", op: "eq", value: "Netflix" };
const actions = [{ type: "set_category", categoryName: "Streaming" }];

describe("transaction rule tool schemas", () => {
  describe("list_transaction_rules", () => {
    it("accepts no input, a search, a ruleId and a numeric-string limit", () => {
      expect(listTransactionRulesSchema.safeParse({}).success).toBe(true);
      const parsed = listTransactionRulesSchema.parse({
        search: "stream",
        ruleId: RULE,
        limit: "25",
      });
      expect(parsed.limit).toBe(25);
    });

    it.each([{ limit: 0 }, { limit: 201 }, { ruleId: "nope" }, { limit: "" }])(
      "rejects %j",
      (input) => {
        expect(listTransactionRulesSchema.safeParse(input).success).toBe(false);
      },
    );
  });

  describe("manage_transaction_rules: JSON strings", () => {
    it("parses condition and actions sent as JSON strings", () => {
      const parsed = manageTransactionRulesSchema.parse({
        operation: "create",
        name: "x",
        condition: JSON.stringify(condition),
        actions: JSON.stringify(actions),
      });
      expect(parsed.condition).toEqual(condition);
      expect(parsed.actions).toEqual(actions);
    });

    it("parses actions sent as an array of JSON strings", () => {
      const parsed = manageTransactionRulesSchema.parse({
        operation: "test",
        condition,
        actions: actions.map((a) => JSON.stringify(a)),
      });
      expect(parsed.actions).toEqual(actions);
    });

    it.each([
      ["not JSON", "description contains ASSECO"],
      ["a JSON array", "[1,2]"],
      ["a JSON number", "5"],
    ])("refuses a condition string that is %s", (_name, text) => {
      expect(
        manageTransactionRulesSchema.safeParse({
          operation: "test",
          condition: text,
          actions,
        }).success,
      ).toBe(false);
    });

    it("does not parse a string over the length bound", () => {
      const big = JSON.stringify({
        field: "description",
        pad: "x".repeat(20000),
      });
      expect(
        manageTransactionRulesSchema.safeParse({
          operation: "test",
          condition: big,
          actions,
        }).success,
      ).toBe(false);
    });
  });

  describe("manage_transaction_rules", () => {
    it.each([
      [{ operation: "create", name: "Streaming", condition, actions }],
      [{ operation: "update", ruleId: RULE, name: "New" }],
      [{ operation: "update", ruleId: RULE, enabled: "false" }],
      [{ operation: "delete", ruleId: RULE }],
      [{ operation: "run", ruleId: RULE, accountNames: ["Checking"] }],
      [{ operation: "test", ruleId: RULE }],
      [{ operation: "test", condition, actions }],
    ])("accepts %j", (input) => {
      expect(manageTransactionRulesSchema.safeParse(input).success).toBe(true);
    });

    it.each([
      ["create without a name", { operation: "create", condition, actions }],
      [
        "create without a condition",
        { operation: "create", name: "x", actions },
      ],
      ["create without actions", { operation: "create", name: "x", condition }],
      ["update without a ruleId", { operation: "update", name: "x" }],
      ["update with nothing to change", { operation: "update", ruleId: RULE }],
      ["delete without a ruleId", { operation: "delete" }],
      ["run without a ruleId", { operation: "run" }],
      ["test with neither", { operation: "test" }],
      ["test with half a draft", { operation: "test", condition }],
      ["an unknown operation", { operation: "merge", ruleId: RULE }],
      ["a ruleId that is not a UUID", { operation: "delete", ruleId: "nope" }],
      [
        "a trigger that does not exist",
        { operation: "update", ruleId: RULE, triggers: ["nightly"] },
      ],
      [
        "an empty trigger list",
        { operation: "update", ruleId: RULE, triggers: [] },
      ],
      [
        "an empty action list",
        { operation: "update", ruleId: RULE, actions: [] },
      ],
      [
        "more than 10 actions",
        {
          operation: "update",
          ruleId: RULE,
          actions: Array.from({ length: 11 }, () => ({ type: "add_tags" })),
        },
      ],
      [
        "a limit over the run ceiling",
        { operation: "run", ruleId: RULE, limit: 1001 },
      ],
      [
        "a date that is not YYYY-MM-DD",
        { operation: "run", ruleId: RULE, startDate: "1 Jan" },
      ],
      [
        "more than 100 accounts",
        {
          operation: "run",
          ruleId: RULE,
          accountNames: Array.from({ length: 101 }, () => "A"),
        },
      ],
      [
        "a condition that is not an object",
        { operation: "test", condition: "all", actions },
      ],
      [
        "an oversized condition",
        { operation: "test", condition: { all: "x".repeat(20001) }, actions },
      ],
    ])("rejects %s", (_name, input) => {
      expect(manageTransactionRulesSchema.safeParse(input).success).toBe(false);
    });

    it("reads a string limit and a string boolean the way the other tools do", () => {
      const parsed = manageTransactionRulesSchema.parse({
        operation: "run",
        ruleId: RULE,
        limit: "50",
      });
      expect(parsed.limit).toBe(50);
      const disabled = manageTransactionRulesSchema.parse({
        operation: "update",
        ruleId: RULE,
        enabled: "false",
      });
      expect(disabled.enabled).toBe(false);
    });

    it("takes the active window as real dates, with an empty string to clear", () => {
      const parsed = manageTransactionRulesSchema.parse({
        operation: "create",
        name: "x",
        condition,
        actions,
        activeFrom: "2026-10-01",
        activeTo: "",
      });
      expect(parsed.activeFrom).toBe("2026-10-01");
      expect(parsed.activeTo).toBe("");
      expect(
        manageTransactionRulesSchema.safeParse({
          operation: "test",
          ruleId: RULE,
          activeFrom: "2026-10-01",
        }).success,
      ).toBe(true);
    });

    it("reads null as a cleared side", () => {
      const parsed = manageTransactionRulesSchema.parse({
        operation: "update",
        ruleId: RULE,
        activeFrom: null,
      });
      expect(parsed.activeFrom).toBe("");
    });

    it.each(["2026-02-31", "2026-10-1", "01.10.2026", 20261001])(
      "refuses the window side %j",
      (bad) => {
        for (const field of ["activeFrom", "activeTo"]) {
          expect(
            manageTransactionRulesSchema.safeParse({
              operation: "create",
              name: "x",
              condition,
              actions,
              [field]: bad,
            }).success,
          ).toBe(false);
        }
      },
    );

    it("counts a window as a change for update", () => {
      expect(
        manageTransactionRulesSchema.safeParse({
          operation: "update",
          ruleId: RULE,
          activeTo: "2026-12-31",
        }).success,
      ).toBe(true);
      expect(
        manageTransactionRulesSchema.safeParse({
          operation: "update",
          ruleId: RULE,
        }).success,
      ).toBe(false);
    });

    it("is what validateToolInput applies to both tools", () => {
      expect(
        validateToolInput("manage_transaction_rules", { operation: "delete" })
          .success,
      ).toBe(false);
      expect(
        validateToolInput("list_transaction_rules", { limit: "3" }),
      ).toEqual({ success: true, data: { limit: 3 } });
    });
  });
});
