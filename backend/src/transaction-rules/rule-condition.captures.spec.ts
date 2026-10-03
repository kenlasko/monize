import {
  evaluateRuleCondition,
  evaluateRuleConditionWithCaptures,
} from "./rule-condition.evaluator";
import { RuleConditionNode, RuleFacts } from "./rule-condition.types";

function facts(over: Partial<RuleFacts> = {}): RuleFacts {
  return Object.freeze({
    accountId: "a1",
    fromAccountId: null,
    toAccountId: null,
    type: "EXPENSE",
    payeeId: null,
    payeeText: "  Przelew. Nazwa odbiorcy: Jan Kowalski Rachunek odbiorcy: 1 ",
    categoryId: null,
    categoryAncestorIds: [],
    description: "Order 77 from Allegro",
    amount: -500000,
    currencyCode: "PLN",
    tagIds: [],
    hasSplits: false,
    referenceNumber: null,
    date: null,
    dayOfMonth: null,
    weekday: null,
    status: null,
    hasAttachment: false,
    ...over,
  });
}

const matches = (field: string, value: string): RuleConditionNode =>
  ({ field, op: "matches", value }) as RuleConditionNode;
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const run = (node: RuleConditionNode, f: RuleFacts = facts()) => {
  const got = evaluateRuleConditionWithCaptures(node, f);
  return { matched: got.matched, captures: plain(got.captures) };
};

describe("evaluateRuleConditionWithCaptures", () => {
  it("captures from a matches leaf, original case, trimmed", () => {
    expect(
      run(matches("payeeText", "*Nazwa odbiorcy: {payee} Rachunek*")),
    ).toEqual({ matched: true, captures: { payee: "Jan Kowalski" } });
  });

  it("captures nothing and does not match when the pattern fails", () => {
    expect(run(matches("payeeText", "*Nazwa: {payee} Konto*"))).toEqual({
      matched: false,
      captures: {},
    });
  });

  it("collects the captures of every leaf of an all group", () => {
    expect(
      run({
        all: [
          matches("payeeText", "*odbiorcy: {payee} Rachunek*"),
          matches("description", "Order {order} from {shop}"),
          { field: "currencyCode", op: "eq", value: "PLN" },
        ],
      }),
    ).toEqual({
      matched: true,
      captures: { payee: "Jan Kowalski", order: "77", shop: "Allegro" },
    });
  });

  it("an all group that fails gives nothing", () => {
    expect(
      run({
        all: [
          matches("description", "Order {order}*"),
          { field: "currencyCode", op: "eq", value: "EUR" },
        ],
      }),
    ).toEqual({ matched: false, captures: {} });
  });

  it("a leaf in a branch of any that did not match captures nothing", () => {
    const node: RuleConditionNode = {
      any: [
        matches("description", "Nothing {gone} here"),
        matches("payeeText", "*odbiorcy: {payee} Rachunek*"),
      ],
    };
    expect(run(node)).toEqual({
      matched: true,
      captures: { payee: "Jan Kowalski" },
    });
  });

  it("a matched branch of any whose sibling leaf failed still gives only its own captures", () => {
    const node: RuleConditionNode = {
      any: [
        {
          all: [
            matches("description", "Order {order}*"),
            { field: "currencyCode", op: "eq", value: "EUR" },
          ],
        },
        matches("payeeText", "*odbiorcy: {payee} Rachunek*"),
      ],
    };
    expect(run(node).captures).toEqual({ payee: "Jan Kowalski" });
  });

  it("captures nothing under not, matched or not", () => {
    expect(
      run({ all: [matches("description", "Order {order}*")], not: true }),
    ).toEqual({ matched: false, captures: {} });
    expect(
      run({ all: [matches("description", "Nope {order}*")], not: true }),
    ).toEqual({ matched: true, captures: {} });
  });

  it("an empty all matches with no captures and an empty any does not match", () => {
    expect(run({ all: [] })).toEqual({ matched: true, captures: {} });
    expect(run({ any: [] })).toEqual({ matched: false, captures: {} });
  });

  it("an unknown text fact is false", () => {
    expect(
      run(matches("description", "{x}"), facts({ description: null })),
    ).toEqual({ matched: false, captures: {} });
  });

  it("returns a frozen result", () => {
    const got = evaluateRuleConditionWithCaptures(
      matches("description", "Order {order}*"),
      facts(),
    );
    expect(Object.isFrozen(got)).toBe(true);
    expect(Object.isFrozen(got.captures)).toBe(true);
  });
});

describe("evaluateRuleConditionWithCaptures agrees with evaluateRuleCondition", () => {
  const leaves: RuleConditionNode[] = [
    matches("payeeText", "*odbiorcy: {payee} Rachunek*"),
    matches("payeeText", "*nothing*"),
    matches("description", "Order*"),
    matches("description", "*{x}"),
    matches("referenceNumber", "*"),
    { field: "referenceNumber", op: "isEmpty" },
    { field: "currencyCode", op: "eq", value: "PLN" },
    { field: "amount", op: "gt", value: 0 },
    { field: "payeeText", op: "contains", value: "kowalski" },
    { field: "hasSplits", op: "eq", value: false },
  ];

  it("gives the same boolean for every combination of two leaves and a group", () => {
    const f = facts();
    const nodes: RuleConditionNode[] = [...leaves];
    for (const a of leaves) {
      for (const b of leaves) {
        for (const not of [false, true]) {
          nodes.push({ all: [a, b], not }, { any: [a, b], not });
          nodes.push({ all: [{ any: [a, b] }, b], not });
        }
      }
    }
    for (const node of nodes) {
      expect(evaluateRuleConditionWithCaptures(node, f).matched).toBe(
        evaluateRuleCondition(node, f),
      );
    }
  });

  it("gives the same boolean on rows whose text facts are absent or empty", () => {
    for (const f of [
      facts({ payeeText: null, description: null }),
      facts({ payeeText: "", description: "" }),
      facts({ payeeText: "   ", description: " x " }),
    ]) {
      for (const node of leaves) {
        expect(evaluateRuleConditionWithCaptures(node, f).matched).toBe(
          evaluateRuleCondition(node, f),
        );
      }
    }
  });
});
