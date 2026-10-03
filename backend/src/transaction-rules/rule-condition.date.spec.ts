import {
  evaluateRuleCondition,
  evaluateRuleConditionWithCaptures,
} from "./rule-condition.evaluator";
import {
  RULE_CONDITION_FIELDS,
  RuleConditionLeaf,
  RuleFacts,
} from "./rule-condition.types";
import { buildRuleFacts } from "./rule-facts";
import { validateRuleDefinition } from "./rule-validation";

/**
 * The `date` field (spec docs/specs/transaction-rules-structural-actions.md
 * section 3.2): the transaction's own calendar date, compared as a string.
 */
const BASE = {
  accountId: "acc-1",
  currencyCode: "PLN",
  amount: -10,
  isTransfer: false,
  payeeId: null,
  payeeText: null,
  categoryId: null,
  description: null,
  tagIds: [] as string[],
  hasSplits: false,
};

const facts = (transactionDate?: string | null): RuleFacts =>
  buildRuleFacts({ ...BASE, transactionDate });

const leaf = (
  op: RuleConditionLeaf["op"],
  value?: RuleConditionLeaf["value"],
): RuleConditionLeaf => ({ field: "date", op, value });

const ACTIONS = [
  { type: "add_tags", tagIds: ["11111111-1111-4111-8111-111111111111"] },
];
const problems = (condition: unknown) =>
  validateRuleDefinition({ condition, actions: ACTIONS }).map(
    (e) => `${e.path}:${e.code}`,
  );

describe("the date field in the field table", () => {
  it("is a date with the six comparison operators", () => {
    expect(RULE_CONDITION_FIELDS.date.kind).toBe("date");
    expect(RULE_CONDITION_FIELDS.date.operators).toEqual([
      "eq",
      "lt",
      "lte",
      "gt",
      "gte",
      "between",
    ]);
  });
});

describe("buildRuleFacts date", () => {
  it("carries the calendar date when it is a real one", () => {
    expect(facts("2026-10-05").date).toBe("2026-10-05");
  });

  it.each([
    undefined,
    null,
    "",
    "2026-02-31",
    "2026-10-05T00:00:00Z",
    "05-10-2026",
  ])("is unknown for %p", (bad) => {
    expect(facts(bad).date).toBeNull();
  });
});

describe("evaluating the date field", () => {
  const f = facts("2026-10-05");

  it.each([
    ["eq", "2026-10-05", true],
    ["eq", "2026-10-06", false],
    ["lt", "2026-10-06", true],
    ["lt", "2026-10-05", false],
    ["lte", "2026-10-05", true],
    ["lte", "2026-10-04", false],
    ["gt", "2026-10-04", true],
    ["gt", "2026-10-05", false],
    ["gte", "2026-10-05", true],
    ["gte", "2026-10-06", false],
    ["gt", "2025-12-31", true],
    ["lt", "2027-01-01", true],
  ] as const)("%s %s is %s", (op, value, expected) => {
    expect(evaluateRuleCondition(leaf(op, value), f)).toBe(expected);
  });

  it("between is inclusive on both ends", () => {
    expect(
      evaluateRuleCondition(leaf("between", ["2026-10-05", "2026-10-31"]), f),
    ).toBe(true);
    expect(
      evaluateRuleCondition(leaf("between", ["2026-10-01", "2026-10-05"]), f),
    ).toBe(true);
    expect(
      evaluateRuleCondition(leaf("between", ["2026-10-06", "2026-10-31"]), f),
    ).toBe(false);
    expect(
      evaluateRuleCondition(leaf("between", ["2026-09-01", "2026-10-04"]), f),
    ).toBe(false);
  });

  it("is false for every operator when the date is unknown", () => {
    const unknown = facts(null);
    for (const op of RULE_CONDITION_FIELDS.date.operators) {
      const value =
        op === "between" ? ["2000-01-01", "2999-12-31"] : "2026-10-05";
      expect(evaluateRuleCondition(leaf(op, value), unknown)).toBe(false);
    }
  });

  it("compares the digits, not a Date: month and year boundaries order correctly", () => {
    expect(
      evaluateRuleCondition(leaf("lt", "2026-10-01"), facts("2026-09-30")),
    ).toBe(true);
    expect(
      evaluateRuleCondition(leaf("gt", "2025-12-31"), facts("2026-01-01")),
    ).toBe(true);
  });

  it("matches evaluateRuleCondition in the capture path, under all, any and not", () => {
    const nodes = [
      leaf("gte", "2026-10-01"),
      { all: [leaf("gte", "2026-10-01"), leaf("lt", "2026-11-01")] },
      { any: [leaf("eq", "2026-09-07"), leaf("eq", "2026-10-05")] },
      { all: [leaf("lt", "2026-10-01")], not: true },
    ];
    for (const date of ["2026-09-07", "2026-10-05", "2026-11-01", null]) {
      for (const node of nodes) {
        expect(
          evaluateRuleConditionWithCaptures(node, facts(date)).matched,
        ).toBe(evaluateRuleCondition(node, facts(date)));
      }
    }
  });
});

describe("validating the date field", () => {
  it("accepts a real date for each scalar operator and an ordered range", () => {
    for (const op of ["eq", "lt", "lte", "gt", "gte"] as const) {
      expect(problems(leaf(op, "2026-10-01"))).toEqual([]);
    }
    expect(problems(leaf("between", ["2026-10-01", "2026-10-01"]))).toEqual([]);
    expect(problems(leaf("between", ["2026-10-01", "2026-12-31"]))).toEqual([]);
    expect(problems(leaf("eq", "2024-02-29"))).toEqual([]);
  });

  it.each(["2026-02-31", "2026-13-01", "2025-02-29", "0000-00-00"])(
    "refuses the non-existent day %s",
    (bad) => {
      expect(problems(leaf("eq", bad))).toEqual([
        "condition.value:VALUE_OUT_OF_RANGE",
      ]);
    },
  );

  it.each(["2026-1-1", "10/05/2026", "2026-10-05T00:00:00Z", " 2026-10-05"])(
    "refuses the wrong shape %p",
    (bad) => {
      expect(problems(leaf("eq", bad))).toEqual([
        "condition.value:VALUE_OUT_OF_RANGE",
      ]);
    },
  );

  it("refuses a non-string value", () => {
    expect(problems(leaf("eq", 20261005))).toEqual([
      "condition.value:VALUE_TYPE",
    ]);
    expect(problems(leaf("eq", true))).toEqual(["condition.value:VALUE_TYPE"]);
  });

  it("refuses a range whose start is after its end", () => {
    expect(problems(leaf("between", ["2026-10-31", "2026-10-01"]))).toEqual([
      "condition.value:RANGE_ORDER",
    ]);
  });

  it("checks each end of a range and does not report the order of a bad end", () => {
    expect(problems(leaf("between", ["2026-02-31", "2026-10-01"]))).toEqual([
      "condition.value[0]:VALUE_OUT_OF_RANGE",
    ]);
    expect(problems(leaf("between", ["2026-10-01"]))).toEqual([
      "condition.value:VALUE_TYPE",
    ]);
  });

  it("refuses an operator the field does not take", () => {
    expect(problems(leaf("in", ["2026-10-01"]))).toEqual([
      "condition.op:OPERATOR_NOT_ALLOWED",
    ]);
    expect(problems(leaf("contains", "2026"))).toEqual([
      "condition.op:OPERATOR_NOT_ALLOWED",
    ]);
  });

  it("still orders numeric ranges", () => {
    expect(
      problems({ field: "amount", op: "between", value: [10, 1] }),
    ).toEqual(["condition.value:RANGE_ORDER"]);
  });
});
