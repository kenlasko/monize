import { RULE_CONDITION_FIELDS, RULE_FIELDS } from "./rule-condition.types";
import {
  MAX_RULE_CONDITION_DEPTH,
  MAX_RULE_CONDITION_LEAVES,
  MAX_RULE_CONDITION_NODES,
  MAX_RULE_TEXT_LENGTH,
  MAX_RULE_VALUE_LIST,
  RuleValidationCode,
  validateRuleDefinition,
} from "./rule-validation";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";
const U4 = "44444444-4444-4444-8444-444444444444";

const OK_ACTIONS = [{ type: "add_tags", tagIds: [U1] }];

const check = (condition: unknown, actions: unknown = OK_ACTIONS) =>
  validateRuleDefinition({ condition, actions }, { authoring: true });

const leaf = (field: string, op: string, value?: unknown) =>
  value === undefined ? { field, op } : { field, op, value };

const codes = (
  condition: unknown,
  actions: unknown = OK_ACTIONS,
): RuleValidationCode[] => check(condition, actions).map((e) => e.code);

/** A group nested `levels` deep with one leaf at the bottom. */
function nested(levels: number): unknown {
  let node: unknown = leaf("hasSplits", "eq", true);
  for (let i = 0; i < levels; i++) node = { all: [node] };
  return node;
}

describe("validateRuleDefinition: accepted definitions", () => {
  it("accepts the design example", () => {
    const tree = {
      all: [
        leaf("type", "eq", "TRANSFER"),
        leaf("fromAccountId", "eq", U1),
        {
          any: [
            leaf("payeeText", "matches", "*BIEDRONKA*"),
            leaf("amount", "between", [-500, -100]),
          ],
          not: false,
        },
      ],
    };
    expect(check(tree)).toEqual([]);
  });

  it("accepts an empty group, a bare leaf and every action type", () => {
    expect(check({ all: [] })).toEqual([]);
    expect(check(leaf("referenceNumber", "isEmpty"))).toEqual([]);
    expect(
      check({ any: [] }, [
        { type: "add_tags", tagIds: [U1] },
        { type: "remove_tags", tagIds: [U2] },
        { type: "set_category", categoryId: U3, onlyIfEmpty: true },
        { type: "set_payee", payeeId: U4, onlyIfEmpty: false },
      ]),
    ).toEqual([]);
  });

  it("accepts a valid leaf for every operator of every field", () => {
    const sample = (field: keyof typeof RULE_CONDITION_FIELDS, op: string) => {
      const spec = RULE_CONDITION_FIELDS[field];
      const one =
        spec.kind === "money"
          ? 1.5
          : spec.kind === "boolean"
            ? true
            : spec.kind === "currency"
              ? "PLN"
              : spec.kind === "enum"
                ? (spec.enumValues as readonly string[])[0]
                : spec.kind === "dayOfMonth"
                  ? 15
                  : spec.kind === "date"
                    ? "2026-10-05"
                    : spec.kind === "text"
                      ? "abc"
                      : U1;
      if (op === "isEmpty") return leaf(field, op);
      if (op === "matches") return leaf(field, op, "*abc*");
      if (op === "between") return leaf(field, op, [one, one]);
      if (["in", "notIn", "hasAny", "hasAll", "hasNone"].includes(op)) {
        return leaf(field, op, [one]);
      }
      return leaf(field, op, one);
    };
    for (const field of RULE_FIELDS) {
      for (const op of RULE_CONDITION_FIELDS[field].operators) {
        expect(check(sample(field, op))).toEqual([]);
      }
    }
  });

  it("does not throw on hostile input", () => {
    for (const bad of [null, undefined, 1, "x", [], { toString: 1 }]) {
      expect(() =>
        validateRuleDefinition({ condition: bad, actions: bad }),
      ).not.toThrow();
    }
  });
});

describe("validateRuleDefinition: shape errors", () => {
  it("INVALID_SHAPE for non-object nodes and unrecognised objects", () => {
    expect(check(null)).toEqual([{ path: "condition", code: "INVALID_SHAPE" }]);
    expect(check([])).toEqual([{ path: "condition", code: "INVALID_SHAPE" }]);
    expect(check({})).toEqual([{ path: "condition", code: "INVALID_SHAPE" }]);
    expect(check({ all: [null] })).toEqual([
      { path: "condition.all[0]", code: "INVALID_SHAPE" },
    ]);
  });

  it("INVALID_SHAPE when a group has both all and any, or a non-array", () => {
    expect(codes({ all: [], any: [] })).toEqual(["INVALID_SHAPE"]);
    expect(check({ any: "x" })).toEqual([
      { path: "condition.any", code: "INVALID_SHAPE" },
    ]);
  });

  it("UNKNOWN_KEY for extra keys on groups, leaves and actions", () => {
    expect(check({ all: [], extra: 1 })).toEqual([
      { path: "condition.extra", code: "UNKNOWN_KEY" },
    ]);
    expect(
      check(
        leaf("hasSplits", "eq", true) && {
          ...leaf("hasSplits", "eq", true),
          x: 1,
        },
      ),
    ).toEqual([{ path: "condition.x", code: "UNKNOWN_KEY" }]);
    expect(
      check({ all: [] }, [{ type: "add_tags", tagIds: [U1], z: 1 }]),
    ).toEqual([{ path: "actions[0].z", code: "UNKNOWN_KEY" }]);
    expect(
      check({ all: [] }, [
        { type: "set_payee", payeeId: U1, onlyIfEmpty: true, categoryId: U2 },
      ]),
    ).toEqual([{ path: "actions[0].categoryId", code: "UNKNOWN_KEY" }]);
  });

  it("VALUE_TYPE when not is not a boolean", () => {
    expect(check({ all: [], not: "yes" })).toEqual([
      { path: "condition.not", code: "VALUE_TYPE" },
    ]);
  });

  it("does not treat inherited keys as fields", () => {
    expect(codes(leaf("constructor", "eq", 1))).toEqual(["UNKNOWN_FIELD"]);
    expect(codes(leaf("toString", "eq", 1))).toEqual(["UNKNOWN_FIELD"]);
  });
});

describe("validateRuleDefinition: fields and operators", () => {
  it("UNKNOWN_FIELD", () => {
    expect(check(leaf("nope", "eq", 1))).toEqual([
      { path: "condition.field", code: "UNKNOWN_FIELD" },
    ]);
    expect(codes({ field: 5, op: "eq", value: 1 })).toEqual(["UNKNOWN_FIELD"]);
  });

  it("OPERATOR_NOT_ALLOWED for an operator outside the field's list", () => {
    expect(check(leaf("amount", "contains", "x"))).toEqual([
      { path: "condition.op", code: "OPERATOR_NOT_ALLOWED" },
    ]);
    expect(codes(leaf("absAmount", "eq", 1))).toEqual(["OPERATOR_NOT_ALLOWED"]);
    expect(codes(leaf("tagIds", "eq", U1))).toEqual(["OPERATOR_NOT_ALLOWED"]);
    expect(codes(leaf("type", "isEmpty"))).toEqual(["OPERATOR_NOT_ALLOWED"]);
    expect(codes({ field: "type", op: 3 })).toEqual(["OPERATOR_NOT_ALLOWED"]);
    expect(codes({ field: "type", op: "regex", value: "x" })).toEqual([
      "OPERATOR_NOT_ALLOWED",
    ]);
  });

  it("VALUE_REQUIRED and VALUE_NOT_ALLOWED", () => {
    expect(check(leaf("referenceNumber", "eq"))).toEqual([
      { path: "condition.value", code: "VALUE_REQUIRED" },
    ]);
    expect(check(leaf("referenceNumber", "isEmpty", "x"))).toEqual([
      { path: "condition.value", code: "VALUE_NOT_ALLOWED" },
    ]);
    expect(
      codes({ field: "referenceNumber", op: "isEmpty", value: undefined }),
    ).toEqual(["VALUE_NOT_ALLOWED"]);
  });
});

describe("validateRuleDefinition: value checks", () => {
  it("VALUE_TYPE per kind", () => {
    expect(codes(leaf("hasSplits", "eq", "true"))).toEqual(["VALUE_TYPE"]);
    expect(codes(leaf("amount", "gt", "5"))).toEqual(["VALUE_TYPE"]);
    expect(codes(leaf("referenceNumber", "eq", 5))).toEqual(["VALUE_TYPE"]);
    expect(codes(leaf("type", "eq", 1))).toEqual(["VALUE_TYPE"]);
    expect(codes(leaf("currencyCode", "eq", 1))).toEqual(["VALUE_TYPE"]);
    expect(codes(leaf("accountId", "eq", 1))).toEqual(["VALUE_TYPE"]);
    expect(codes(leaf("accountId", "in", U1))).toEqual(["VALUE_TYPE"]);
    expect(codes(leaf("amount", "between", 5))).toEqual(["VALUE_TYPE"]);
    expect(codes(leaf("amount", "between", [1]))).toEqual(["VALUE_TYPE"]);
    expect(codes(leaf("amount", "between", [1, 2, 3]))).toEqual(["VALUE_TYPE"]);
  });

  it("VALUE_OUT_OF_RANGE for non-finite or unsafe money", () => {
    expect(codes(leaf("amount", "eq", Number.NaN))).toEqual([
      "VALUE_OUT_OF_RANGE",
    ]);
    expect(codes(leaf("amount", "eq", Infinity))).toEqual([
      "VALUE_OUT_OF_RANGE",
    ]);
    expect(codes(leaf("amount", "eq", 1e15))).toEqual(["VALUE_OUT_OF_RANGE"]);
    expect(codes(leaf("amount", "eq", 900000000000))).toEqual([]);
  });

  it("VALUE_TOO_LONG exactly above the text limit", () => {
    expect(
      codes(
        leaf("referenceNumber", "contains", "a".repeat(MAX_RULE_TEXT_LENGTH)),
      ),
    ).toEqual([]);
    expect(
      check(
        leaf(
          "referenceNumber",
          "contains",
          "a".repeat(MAX_RULE_TEXT_LENGTH + 1),
        ),
      ),
    ).toEqual([{ path: "condition.value", code: "VALUE_TOO_LONG" }]);
  });

  it("INVALID_ENUM and INVALID_CURRENCY", () => {
    expect(codes(leaf("type", "eq", "expense"))).toEqual(["INVALID_ENUM"]);
    expect(codes(leaf("type", "in", ["INCOME", "OTHER"]))).toEqual([
      "INVALID_ENUM",
    ]);
    expect(codes(leaf("currencyCode", "eq", "PLNX"))).toEqual([
      "INVALID_CURRENCY",
    ]);
    expect(codes(leaf("currencyCode", "in", ["pln", "E1R"]))).toEqual([
      "INVALID_CURRENCY",
    ]);
  });

  it("INVALID_UUID with the path of the bad list entry", () => {
    expect(check(leaf("payeeId", "eq", "not-a-uuid"))).toEqual([
      { path: "condition.value", code: "INVALID_UUID" },
    ]);
    expect(check(leaf("tagIds", "hasAny", [U1, "x"]))).toEqual([
      { path: "condition.value[1]", code: "INVALID_UUID" },
    ]);
    expect(codes(leaf("categoryId", "inSubtree", "x"))).toEqual([
      "INVALID_UUID",
    ]);
  });

  it("ARRAY_EMPTY and ARRAY_TOO_LARGE at the list limit", () => {
    const ids = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      );
    expect(codes(leaf("accountId", "in", []))).toEqual(["ARRAY_EMPTY"]);
    expect(codes(leaf("accountId", "in", ids(MAX_RULE_VALUE_LIST)))).toEqual(
      [],
    );
    expect(
      check(leaf("accountId", "in", ids(MAX_RULE_VALUE_LIST + 1))),
    ).toEqual([{ path: "condition.value", code: "ARRAY_TOO_LARGE" }]);
  });

  it("RANGE_ORDER when min > max, not when equal or when an end is invalid", () => {
    expect(check(leaf("amount", "between", [5, 1]))).toEqual([
      { path: "condition.value", code: "RANGE_ORDER" },
    ]);
    expect(codes(leaf("amount", "between", [5, 5]))).toEqual([]);
    expect(codes(leaf("amount", "between", [5, "x"]))).toEqual(["VALUE_TYPE"]);
    expect(check(leaf("amount", "between", ["x", 1]))).toEqual([
      { path: "condition.value[0]", code: "VALUE_TYPE" },
    ]);
  });
});

describe("validateRuleDefinition: condition bounds", () => {
  it("depth: at the limit passes, one above fails", () => {
    expect(check(nested(MAX_RULE_CONDITION_DEPTH))).toEqual([]);
    const errors = check(nested(MAX_RULE_CONDITION_DEPTH + 1));
    expect(errors.map((e) => e.code)).toEqual(["MAX_DEPTH"]);
  });

  it("does not recurse without bound on a very deep tree", () => {
    expect(codes(nested(5000))).toEqual(["MAX_DEPTH"]);
  });

  it("leaves: at the limit passes, one above fails once", () => {
    const leaves = (n: number) =>
      Array.from({ length: n }, () => leaf("hasSplits", "eq", true));
    expect(check({ all: leaves(MAX_RULE_CONDITION_LEAVES) })).toEqual([]);
    expect(check({ all: leaves(MAX_RULE_CONDITION_LEAVES + 1) })).toEqual([
      {
        path: `condition.all[${MAX_RULE_CONDITION_LEAVES}]`,
        code: "MAX_LEAVES",
      },
    ]);
    expect(codes({ all: leaves(MAX_RULE_CONDITION_LEAVES + 20) })).toEqual([
      "MAX_LEAVES",
    ]);
  });

  it("nodes: many empty groups are refused once", () => {
    const groups = (n: number) =>
      Array.from({ length: n }, () => ({ any: [] }));
    expect(check({ all: groups(MAX_RULE_CONDITION_NODES - 1) })).toEqual([]);
    expect(codes({ all: groups(MAX_RULE_CONDITION_NODES) })).toEqual([
      "MAX_NODES",
    ]);
    expect(codes({ all: groups(MAX_RULE_CONDITION_NODES + 50) })).toEqual([
      "MAX_NODES",
    ]);
  });
});

describe("validateRuleDefinition: glob traps in matches", () => {
  const matches = (pattern: string) => leaf("description", "matches", pattern);

  it.each([
    "dofinansowanie|rycza[lł]t",
    "rycza[łl]t",
    "a[bc]",
    "a|b",
    "a\\b",
    "back\\slash",
    "*a|b*",
  ])("refuses the regex %s with LOOKS_LIKE_REGEX", (pattern) => {
    expect(check(matches(pattern))).toEqual([
      { path: "condition.value", code: "LOOKS_LIKE_REGEX" },
    ]);
  });

  it.each(["wynag", "nagroda", "two words", "a+b", "ASSECO"])(
    "refuses the bare word %s with PATTERN_WITHOUT_WILDCARD",
    (pattern) => {
      expect(check(matches(pattern))).toEqual([
        { path: "condition.value", code: "PATTERN_WITHOUT_WILDCARD" },
      ]);
    },
  );

  it.each([
    "*wynag*",
    "nagroda*",
    "*nagroda",
    "a*b",
    "*",
    "{who}",
    "Order {n}",
    "*[PENDING]*",
    "^ABC*",
    "*end$",
    "(?i)abc*",
    "*SP. Z O.O.*",
    "*S.A.*",
    "*Inc.*",
    "x.*y",
    ".*abc",
  ])("accepts the glob %s", (pattern) => {
    expect(check(matches(pattern))).toEqual([]);
  });

  it("skips the glob traps when the definition is not being authored", () => {
    const def = {
      condition: matches("NETFLIX.COM"),
      actions: OK_ACTIONS,
    };
    expect(validateRuleDefinition(def).map((e) => e.code)).toEqual([]);
    expect(
      validateRuleDefinition(def, { authoring: true }).map((e) => e.code),
    ).toEqual(["PATTERN_WITHOUT_WILDCARD"]);
  });

  it("does not report an empty pattern as a bare word", () => {
    expect(check(matches(""))).toEqual([]);
  });

  it("reports a malformed capture as INVALID_CAPTURE, not as a missing wildcard", () => {
    expect(codes(matches("{Bad}"))).toEqual(["INVALID_CAPTURE"]);
  });

  it("leaves eq, contains and startsWith alone", () => {
    for (const op of ["eq", "contains", "startsWith"]) {
      expect(check(leaf("description", op, "a|b"))).toEqual([]);
      expect(check(leaf("description", op, "nagroda"))).toEqual([]);
    }
  });
});

describe("validateRuleDefinition: there is no memo field", () => {
  it("refuses a memo leaf with UNKNOWN_FIELD", () => {
    expect(check(leaf("memo", "contains", "ASSECO"))).toEqual([
      { path: "condition.field", code: "UNKNOWN_FIELD" },
    ]);
    expect(RULE_FIELDS).not.toContain("memo");
  });
});
