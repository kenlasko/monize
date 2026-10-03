import { RULE_ACTION_TYPES, isLedgerAction } from "./rule-action.types";
import {
  MAX_RULE_ACTIONS,
  MAX_RULE_AI_INSTRUCTION_LENGTH,
  MAX_RULE_TAG_IDS,
  RULE_VALIDATION_CODES,
  RuleDefinition,
  collectReferencedIds,
  validateRuleDefinition,
} from "./rule-validation";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";
const U4 = "44444444-4444-4444-8444-444444444444";
const U5 = "55555555-5555-4555-8555-555555555555";

const OK_ACTIONS = [{ type: "add_tags", tagIds: [U1] }];

const check = (condition: unknown, actions: unknown = OK_ACTIONS) =>
  validateRuleDefinition({ condition, actions }, { authoring: true });

const leaf = (field: string, op: string, value?: unknown) =>
  value === undefined ? { field, op } : { field, op, value };

/** A group nested `levels` deep with one leaf at the bottom. */
function nested(levels: number): unknown {
  let node: unknown = leaf("hasSplits", "eq", true);
  for (let i = 0; i < levels; i++) node = { all: [node] };
  return node;
}

describe("validateRuleDefinition: actions", () => {
  const cond = { all: [] };

  it("INVALID_SHAPE / NO_ACTIONS for a missing or empty list", () => {
    expect(check(cond, null)).toEqual([
      { path: "actions", code: "INVALID_SHAPE" },
    ]);
    expect(check(cond, {})).toEqual([
      { path: "actions", code: "INVALID_SHAPE" },
    ]);
    expect(check(cond, [])).toEqual([{ path: "actions", code: "NO_ACTIONS" }]);
  });

  it("TOO_MANY_ACTIONS: at the limit passes, one above fails", () => {
    const actions = (n: number) =>
      Array.from({ length: n }, () => ({ type: "add_tags", tagIds: [U1] }));
    expect(check(cond, actions(MAX_RULE_ACTIONS))).toEqual([]);
    expect(check(cond, actions(MAX_RULE_ACTIONS + 1))).toEqual([
      { path: "actions", code: "TOO_MANY_ACTIONS" },
    ]);
  });

  it("does not validate entries beyond the action limit", () => {
    const actions = Array.from({ length: MAX_RULE_ACTIONS + 5 }, () => 7);
    const errors = check(cond, actions);
    expect(errors.filter((e) => e.code === "TOO_MANY_ACTIONS")).toHaveLength(1);
    expect(errors).toHaveLength(MAX_RULE_ACTIONS + 1);
  });

  it("INVALID_SHAPE for a non-object action", () => {
    expect(check(cond, ["add_tags"])).toEqual([
      { path: "actions[0]", code: "INVALID_SHAPE" },
    ]);
  });

  it("UNKNOWN_ACTION for anything outside the closed list", () => {
    for (const type of [
      "set_amount",
      "set_account",
      "delete",
      "__proto__",
      4,
    ]) {
      expect(check(cond, [{ type }])).toEqual([
        { path: "actions[0].type", code: "UNKNOWN_ACTION" },
      ]);
    }
    expect(check(cond, [{}])).toEqual([
      { path: "actions[0].type", code: "UNKNOWN_ACTION" },
    ]);
    expect([...RULE_ACTION_TYPES]).toEqual([
      "add_tags",
      "remove_tags",
      "set_category",
      "set_payee",
      "request_ai_review",
      "set_payee_from_text",
      "set_description",
      "convert_to_transfer",
      "split",
    ]);
  });

  it("tagIds: 1..20 uuids, both tag actions", () => {
    const tags = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      );
    for (const type of ["add_tags", "remove_tags"]) {
      expect(check(cond, [{ type, tagIds: tags(1) }])).toEqual([]);
      expect(check(cond, [{ type, tagIds: tags(MAX_RULE_TAG_IDS) }])).toEqual(
        [],
      );
      expect(check(cond, [{ type, tagIds: [] }])).toEqual([
        { path: "actions[0].tagIds", code: "ARRAY_EMPTY" },
      ]);
      expect(
        check(cond, [{ type, tagIds: tags(MAX_RULE_TAG_IDS + 1) }]),
      ).toEqual([{ path: "actions[0].tagIds", code: "ARRAY_TOO_LARGE" }]);
      expect(check(cond, [{ type, tagIds: U1 }])).toEqual([
        { path: "actions[0].tagIds", code: "VALUE_TYPE" },
      ]);
      expect(check(cond, [{ type, tagIds: ["x"] }])).toEqual([
        { path: "actions[0].tagIds[0]", code: "INVALID_UUID" },
      ]);
      expect(check(cond, [{ type }])).toEqual([
        { path: "actions[0].tagIds", code: "VALUE_TYPE" },
      ]);
    }
  });

  it("set_category / set_payee need an id and a boolean onlyIfEmpty", () => {
    expect(
      check(cond, [{ type: "set_category", categoryId: "x", onlyIfEmpty: 1 }]),
    ).toEqual([
      { path: "actions[0].categoryId", code: "INVALID_UUID" },
      { path: "actions[0].onlyIfEmpty", code: "VALUE_TYPE" },
    ]);
    expect(check(cond, [{ type: "set_payee", payeeId: U1 }])).toEqual([
      { path: "actions[0].onlyIfEmpty", code: "VALUE_TYPE" },
    ]);
    expect(check(cond, [{ type: "set_payee", onlyIfEmpty: true }])).toEqual([
      { path: "actions[0].payeeId", code: "VALUE_TYPE" },
    ]);
  });
});

describe("validateRuleDefinition: request_ai_review", () => {
  const cond = { all: [] };
  const review = (instruction: unknown) => ({
    type: "request_ai_review",
    instruction,
  });

  it("accepts a trimmed instruction of 1..1000 characters", () => {
    expect(check(cond, [review("split by receipt")])).toEqual([]);
    expect(check(cond, [review("x")])).toEqual([]);
    expect(
      check(cond, [review("x".repeat(MAX_RULE_AI_INSTRUCTION_LENGTH))]),
    ).toEqual([]);
    expect(
      check(cond, [
        review(`  ${"x".repeat(MAX_RULE_AI_INSTRUCTION_LENGTH)}  `),
      ]),
    ).toEqual([]);
  });

  it("VALUE_EMPTY for a blank instruction, VALUE_TOO_LONG one above the limit", () => {
    expect(check(cond, [review("")])).toEqual([
      { path: "actions[0].instruction", code: "VALUE_EMPTY" },
    ]);
    expect(check(cond, [review("   \n ")])).toEqual([
      { path: "actions[0].instruction", code: "VALUE_EMPTY" },
    ]);
    expect(
      check(cond, [review("x".repeat(MAX_RULE_AI_INSTRUCTION_LENGTH + 1))]),
    ).toEqual([{ path: "actions[0].instruction", code: "VALUE_TOO_LONG" }]);
  });

  it("VALUE_TYPE for a missing or non-string instruction; UNKNOWN_KEY for extras", () => {
    expect(check(cond, [{ type: "request_ai_review" }])).toEqual([
      { path: "actions[0].instruction", code: "VALUE_TYPE" },
    ]);
    expect(check(cond, [review(5)])).toEqual([
      { path: "actions[0].instruction", code: "VALUE_TYPE" },
    ]);
    expect(check(cond, [{ ...review("x"), tagIds: [U1] }])).toEqual([
      { path: "actions[0].tagIds", code: "UNKNOWN_KEY" },
    ]);
  });

  it("at most one per rule; other actions do not count", () => {
    expect(
      check(cond, [review("a"), OK_ACTIONS[0], review("b"), review("c")]),
    ).toEqual([
      { path: "actions[2]", code: "DUPLICATE_ACTION" },
      { path: "actions[3]", code: "DUPLICATE_ACTION" },
    ]);
    expect(check(cond, [OK_ACTIONS[0], review("a")])).toEqual([]);
  });

  it("names no id and is not a ledger action", () => {
    const definition = {
      condition: cond,
      actions: [review("a")],
    } as unknown as RuleDefinition;
    expect(collectReferencedIds(definition).tagIds).toEqual([]);
    expect(
      isLedgerAction({ type: "request_ai_review", instruction: "a" }),
    ).toBe(false);
    for (const action of [
      { type: "add_tags", tagIds: [U1] },
      { type: "remove_tags", tagIds: [U1] },
      { type: "set_category", categoryId: U1, onlyIfEmpty: true },
      { type: "set_payee", payeeId: U1, onlyIfEmpty: true },
      {
        type: "set_payee_from_text",
        template: "x",
        createIfMissing: false,
        onlyIfEmpty: true,
      },
      {
        type: "set_description",
        template: "x",
        mode: "replace",
        onlyIfEmpty: false,
      },
    ] as const) {
      expect(isLedgerAction(action)).toBe(true);
    }
  });
});

describe("validateRuleDefinition: error codes", () => {
  it("every declared code is produced by at least one input above", () => {
    const seen = new Set<string>();
    const inputs: Array<[unknown, unknown]> = [
      [null, OK_ACTIONS],
      [{ all: [], x: 1 }, OK_ACTIONS],
      [leaf("nope", "eq", 1), OK_ACTIONS],
      [{ all: [] }, [{ type: "zzz" }]],
      [leaf("amount", "contains", "x"), OK_ACTIONS],
      [leaf("referenceNumber", "eq"), OK_ACTIONS],
      [leaf("referenceNumber", "isEmpty", "x"), OK_ACTIONS],
      [leaf("referenceNumber", "eq", 1), OK_ACTIONS],
      [leaf("amount", "eq", Infinity), OK_ACTIONS],
      [leaf("referenceNumber", "eq", "a".repeat(501)), OK_ACTIONS],
      [leaf("payeeId", "eq", "x"), OK_ACTIONS],
      [leaf("type", "eq", "x"), OK_ACTIONS],
      [leaf("currencyCode", "eq", "x"), OK_ACTIONS],
      [leaf("accountId", "in", []), OK_ACTIONS],
      [leaf("accountId", "in", Array(51).fill(U1)), OK_ACTIONS],
      [leaf("amount", "between", [2, 1]), OK_ACTIONS],
      [nested(5), OK_ACTIONS],
      [{ all: Array(51).fill(leaf("hasSplits", "eq", true)) }, OK_ACTIONS],
      [{ all: Array(100).fill({ any: [] }) }, OK_ACTIONS],
      [{ all: [] }, [{ type: "request_ai_review", instruction: " " }]],
      [
        { all: [] },
        Array(2).fill({ type: "request_ai_review", instruction: "a" }),
      ],
      [{ all: [] }, []],
      [{ all: [] }, Array(11).fill(OK_ACTIONS[0])],
      [
        { all: [] },
        [
          { type: "convert_to_transfer", toAccountId: U1, clearCategory: true },
          { type: "set_category", categoryId: U1, onlyIfEmpty: true },
        ],
      ],
      [leaf("referenceNumber", "matches", "a|b*"), OK_ACTIONS],
      [leaf("referenceNumber", "matches", "nagroda"), OK_ACTIONS],
      [leaf("referenceNumber", "matches", "{Bad}"), OK_ACTIONS],
      [leaf("referenceNumber", "matches", "{a}{b}{c}{d}{e}{f}"), OK_ACTIONS],
      [leaf("referenceNumber", "matches", "{a}x{a}"), OK_ACTIONS],
      [
        { all: [] },
        [
          {
            type: "set_description",
            template: "{nobody}",
            mode: "replace",
            onlyIfEmpty: false,
          },
        ],
      ],
    ];
    for (const [c, a] of inputs) {
      for (const e of check(c, a)) seen.add(e.code);
    }
    expect([...seen].sort()).toEqual([...RULE_VALIDATION_CODES].sort());
  });
});

describe("collectReferencedIds", () => {
  it("collects each id once, by entity type", () => {
    const definition = {
      condition: {
        all: [
          leaf("accountId", "in", [U1, U2]),
          leaf("fromAccountId", "eq", U1),
          leaf("toAccountId", "isEmpty"),
          {
            any: [
              leaf("payeeId", "eq", U3),
              leaf("categoryId", "inSubtree", U4),
              leaf("tagIds", "hasAny", [U5]),
              leaf("referenceNumber", "eq", "not an id"),
              leaf("type", "eq", "EXPENSE"),
            ],
            not: true,
          },
        ],
      },
      actions: [
        { type: "add_tags", tagIds: [U5, U1] },
        { type: "remove_tags", tagIds: [U2] },
        { type: "set_category", categoryId: U4, onlyIfEmpty: true },
        { type: "set_payee", payeeId: U3, onlyIfEmpty: false },
      ],
    } as unknown as RuleDefinition;
    expect(collectReferencedIds(definition)).toEqual({
      accountIds: [U1, U2],
      payeeIds: [U3],
      categoryIds: [U4],
      tagIds: [U5, U1, U2],
    });
  });

  it("returns empty lists for a definition that names no id", () => {
    const definition = {
      condition: { any: [leaf("hasSplits", "eq", true)] },
      actions: [],
    } as unknown as RuleDefinition;
    expect(collectReferencedIds(definition)).toEqual({
      accountIds: [],
      payeeIds: [],
      categoryIds: [],
      tagIds: [],
    });
  });

  it("handles a bare leaf root and a leaf without a value", () => {
    const definition = {
      condition: leaf("categoryId", "eq", U4),
      actions: [],
    } as unknown as RuleDefinition;
    expect(collectReferencedIds(definition).categoryIds).toEqual([U4]);
  });
});
