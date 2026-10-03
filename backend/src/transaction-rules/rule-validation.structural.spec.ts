import { isLedgerAction, isStructuralAction } from "./rule-action.types";
import { referenceErrors, withActionDefaults } from "./rule-references";
import {
  collectReferencedIds,
  validateRuleDefinition,
} from "./rule-validation";
import { RuleAction } from "./rule-action.types";
import { RuleConditionNode } from "./rule-condition.types";

const ACC1 = "11111111-1111-4111-8111-111111111111";
const ACC2 = "22222222-2222-4222-8222-222222222222";
const CAT = "33333333-3333-4333-8333-333333333333";
const PAY1 = "44444444-4444-4444-8444-444444444444";
const PAY2 = "55555555-5555-4555-8555-555555555555";

const CONDITION: RuleConditionNode = {
  all: [
    {
      field: "payeeText",
      op: "matches",
      value: "PRINCIPAL: {principal} INTEREST: {interest}*",
    },
  ],
};

const check = (actions: unknown, condition: unknown = CONDITION) =>
  validateRuleDefinition({ condition, actions }, { authoring: true });

const convert = {
  type: "convert_to_transfer",
  toAccountId: ACC1,
  clearCategory: true,
};
const parts = [
  { amount: "{principal}", transferAccountId: ACC1, payeeId: PAY1 },
  { amount: "{interest}", categoryId: CAT },
];
const split = { type: "split", payeeId: PAY2, parts };

describe("convert_to_transfer validation", () => {
  it("accepts to, from, a payee and a boolean clearCategory", () => {
    expect(check([convert])).toEqual([]);
    expect(
      check([
        {
          type: "convert_to_transfer",
          fromAccountId: ACC2,
          clearCategory: false,
          payeeId: PAY1,
        },
      ]),
    ).toEqual([]);
  });

  it("requires exactly one of toAccountId and fromAccountId", () => {
    expect(
      check([{ type: "convert_to_transfer", clearCategory: true }]),
    ).toEqual([{ path: "actions[0].toAccountId", code: "VALUE_REQUIRED" }]);
    expect(check([{ ...convert, fromAccountId: ACC2 }])).toEqual([
      { path: "actions[0]", code: "CONFLICTING_ACTIONS" },
    ]);
  });

  it("requires a boolean clearCategory and uuid ids and refuses unknown keys", () => {
    expect(check([{ type: "convert_to_transfer", toAccountId: ACC1 }])).toEqual(
      [{ path: "actions[0].clearCategory", code: "VALUE_TYPE" }],
    );
    expect(
      check([
        {
          ...convert,
          clearCategory: "yes",
          toAccountId: "x",
          payeeId: 4,
          extra: 1,
        },
      ]),
    ).toEqual([
      { path: "actions[0].extra", code: "UNKNOWN_KEY" },
      { path: "actions[0].toAccountId", code: "INVALID_UUID" },
      { path: "actions[0].payeeId", code: "VALUE_TYPE" },
      { path: "actions[0].clearCategory", code: "VALUE_TYPE" },
    ]);
  });

  it("is filled with clearCategory true by the action defaults, so a stored rule may omit it", () => {
    const named = [{ type: "convert_to_transfer", toAccountId: ACC1 }];
    expect(check(named)).not.toEqual([]);
    const filled = withActionDefaults(named);
    expect(filled).toEqual([{ ...named[0], clearCategory: true }]);
    expect(check(filled)).toEqual([]);
    expect(withActionDefaults([{ ...named[0], clearCategory: false }])).toEqual(
      [{ ...named[0], clearCategory: false }],
    );
  });
});

describe("split validation", () => {
  it("accepts captures, rest and every optional key", () => {
    expect(check([split])).toEqual([]);
    expect(
      check([
        {
          type: "split",
          parts: [
            {
              amount: "{principal}",
              categoryId: CAT,
              description: " interest ",
            },
            { amount: "rest" },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("needs 2 to 10 parts", () => {
    expect(check([{ type: "split", parts: [parts[0]] }])).toEqual([
      { path: "actions[0].parts", code: "ARRAY_EMPTY" },
    ]);
    expect(check([{ type: "split", parts: [] }])).toEqual([
      { path: "actions[0].parts", code: "ARRAY_EMPTY" },
    ]);
    expect(
      check([{ type: "split", parts: Array(11).fill({ amount: "rest" }) }]),
    ).toEqual([{ path: "actions[0].parts", code: "ARRAY_TOO_LARGE" }]);
    expect(check([{ type: "split", parts: "x" }])).toEqual([
      { path: "actions[0].parts", code: "INVALID_SHAPE" },
    ]);
    expect(check([{ type: "split" }])).toEqual([
      { path: "actions[0].parts", code: "INVALID_SHAPE" },
    ]);
    expect(
      check([
        {
          type: "split",
          parts: Array.from({ length: 10 }, (_, i) =>
            i === 0 ? { amount: "rest" } : { amount: "{principal}" },
          ),
        },
      ]),
    ).toEqual([]);
  });

  it("checks the shape of each part amount", () => {
    const amountOf = (amount: unknown) =>
      check([{ type: "split", parts: [{ amount }, { amount: "rest" }] }]);
    expect(amountOf(12)).toEqual([
      { path: "actions[0].parts[0].amount", code: "VALUE_TYPE" },
    ]);
    expect(amountOf(undefined)).toEqual([
      { path: "actions[0].parts[0].amount", code: "VALUE_TYPE" },
    ]);
    for (const bad of [
      "12,00",
      "principal",
      "{Principal}",
      "{principal} ",
      "{ principal}",
      "REST",
      "{}",
    ]) {
      expect(amountOf(bad)).toEqual([
        { path: "actions[0].parts[0].amount", code: "INVALID_SHAPE" },
      ]);
    }
  });

  it("names a capture some matches leaf of the rule defines", () => {
    expect(
      check([
        { type: "split", parts: [{ amount: "{nobody}" }, { amount: "rest" }] },
      ]),
    ).toEqual([
      { path: "actions[0].parts[0].amount", code: "UNKNOWN_CAPTURE" },
    ]);
    // The built-in names of a template are not captures.
    expect(
      check([
        {
          type: "split",
          parts: [{ amount: "{description}" }, { amount: "rest" }],
        },
      ]),
    ).toEqual([
      { path: "actions[0].parts[0].amount", code: "UNKNOWN_CAPTURE" },
    ]);
    expect(
      check(
        [
          {
            type: "split",
            parts: [{ amount: "{principal}" }, { amount: "rest" }],
          },
        ],
        { all: [{ field: "description", op: "contains", value: "x" }] },
      ),
    ).toEqual([
      { path: "actions[0].parts[0].amount", code: "UNKNOWN_CAPTURE" },
    ]);
  });

  it("allows at most one rest", () => {
    expect(
      check([
        { type: "split", parts: [{ amount: "rest" }, { amount: "rest" }] },
      ]),
    ).toEqual([
      { path: "actions[0].parts[1].amount", code: "DUPLICATE_ACTION" },
    ]);
  });

  it("allows a category or a transfer account, not both; a payee only with a transfer account", () => {
    expect(
      check([
        {
          type: "split",
          parts: [
            { amount: "{principal}", categoryId: CAT, transferAccountId: ACC1 },
            { amount: "rest" },
          ],
        },
      ]),
    ).toEqual([{ path: "actions[0].parts[0]", code: "CONFLICTING_ACTIONS" }]);
    expect(
      check([
        {
          type: "split",
          parts: [
            { amount: "{principal}", categoryId: CAT, payeeId: PAY1 },
            { amount: "rest" },
          ],
        },
      ]),
    ).toEqual([
      { path: "actions[0].parts[0].payeeId", code: "CONFLICTING_ACTIONS" },
    ]);
    // Neither is fine: an uncategorised line.
    expect(
      check([
        {
          type: "split",
          parts: [{ amount: "{principal}" }, { amount: "rest" }],
        },
      ]),
    ).toEqual([]);
  });

  it("bounds the memo to 1..200 trimmed characters", () => {
    const memo = (description: unknown) =>
      check([
        {
          type: "split",
          parts: [{ amount: "{principal}", description }, { amount: "rest" }],
        },
      ]);
    expect(memo("a")).toEqual([]);
    expect(memo("a".repeat(200))).toEqual([]);
    expect(memo(`  ${"a".repeat(200)}  `)).toEqual([]);
    expect(memo("   ")).toEqual([
      { path: "actions[0].parts[0].description", code: "VALUE_EMPTY" },
    ]);
    expect(memo("a".repeat(201))).toEqual([
      { path: "actions[0].parts[0].description", code: "VALUE_TOO_LONG" },
    ]);
    expect(memo(5)).toEqual([
      { path: "actions[0].parts[0].description", code: "VALUE_TYPE" },
    ]);
  });

  it("refuses unknown keys on the action and on a part, and bad ids", () => {
    expect(
      check([
        {
          type: "split",
          bogus: 1,
          payeeId: "x",
          parts: [
            { amount: "{principal}", bogus: 1, categoryId: "y" },
            { amount: "rest" },
            "not an object",
          ],
        },
      ]),
    ).toEqual([
      { path: "actions[0].bogus", code: "UNKNOWN_KEY" },
      { path: "actions[0].payeeId", code: "INVALID_UUID" },
      { path: "actions[0].parts[0].bogus", code: "UNKNOWN_KEY" },
      { path: "actions[0].parts[0].categoryId", code: "INVALID_UUID" },
      { path: "actions[0].parts[2]", code: "INVALID_SHAPE" },
    ]);
  });
});

describe("combining structural actions in one rule", () => {
  it("allows one structural action beside tags, a payee and a description", () => {
    expect(
      check([
        split,
        { type: "add_tags", tagIds: [ACC1] },
        { type: "set_payee", payeeId: PAY1, onlyIfEmpty: true },
        {
          type: "set_description",
          template: "x",
          mode: "replace",
          onlyIfEmpty: false,
        },
      ]),
    ).toEqual([]);
  });

  it("refuses a second structural action", () => {
    expect(check([convert, split])).toEqual([
      { path: "actions[1]", code: "DUPLICATE_ACTION" },
    ]);
    expect(check([convert, convert])).toEqual([
      { path: "actions[1]", code: "DUPLICATE_ACTION" },
    ]);
  });

  it("refuses a structural action together with set_category, in either order", () => {
    const setCategory = {
      type: "set_category",
      categoryId: CAT,
      onlyIfEmpty: true,
    };
    expect(check([convert, setCategory])).toEqual([
      { path: "actions[0]", code: "CONFLICTING_ACTIONS" },
    ]);
    expect(check([setCategory, split])).toEqual([
      { path: "actions[1]", code: "CONFLICTING_ACTIONS" },
    ]);
  });
});

describe("structural actions and the action kinds", () => {
  it("are ledger actions, and only these two are structural", () => {
    const actions = [
      convert,
      split,
      { type: "add_tags", tagIds: [ACC1] },
      { type: "request_ai_review", instruction: "x" },
    ] as unknown as RuleAction[];
    expect(actions.map(isStructuralAction)).toEqual([true, true, false, false]);
    expect(actions.map(isLedgerAction)).toEqual([true, true, true, false]);
  });
});

describe("references of structural actions", () => {
  const definition = {
    condition: CONDITION,
    actions: [split] as unknown as RuleAction[],
  };

  it("collects accounts, payees and categories of both actions", () => {
    expect(collectReferencedIds(definition)).toEqual({
      accountIds: [ACC1],
      payeeIds: [PAY2, PAY1],
      categoryIds: [CAT],
      tagIds: [],
    });
    expect(
      collectReferencedIds({
        condition: CONDITION,
        actions: [
          {
            ...convert,
            toAccountId: undefined,
            fromAccountId: ACC2,
            payeeId: PAY1,
          },
        ] as unknown as RuleAction[],
      }),
    ).toEqual({
      accountIds: [ACC2],
      payeeIds: [PAY1],
      categoryIds: [],
      tagIds: [],
    });
  });

  it("reports a missing id once per card, at the part for a part's ids", () => {
    const none = { accountIds: [], payeeIds: [], categoryIds: [], tagIds: [] };
    expect(
      referenceErrors(definition, { ...none, accountIds: [ACC1] }),
    ).toEqual([{ path: "actions[0].parts[0]", code: "REFERENCE_NOT_FOUND" }]);
    expect(
      referenceErrors(definition, { ...none, categoryIds: [CAT] }),
    ).toEqual([{ path: "actions[0].parts[1]", code: "REFERENCE_NOT_FOUND" }]);
    expect(referenceErrors(definition, { ...none, payeeIds: [PAY2] })).toEqual([
      { path: "actions[0]", code: "REFERENCE_NOT_FOUND" },
    ]);
    expect(
      referenceErrors(
        { condition: CONDITION, actions: [convert] as unknown as RuleAction[] },
        { ...none, accountIds: [ACC1], payeeIds: [PAY1] },
      ),
    ).toEqual([{ path: "actions[0]", code: "REFERENCE_NOT_FOUND" }]);
  });
});
