import {
  evaluateRuleCondition,
  scaleRuleMoney,
} from "./rule-condition.evaluator";
import {
  RuleConditionLeaf,
  RuleConditionNode,
  RuleFacts,
} from "./rule-condition.types";

const A1 = "11111111-1111-4111-8111-111111111111";
const A2 = "22222222-2222-4222-8222-222222222222";
const P1 = "33333333-3333-4333-8333-333333333333";
const C_ROOT = "44444444-4444-4444-8444-444444444444";
const C_LEAF = "55555555-5555-4555-8555-555555555555";
const T1 = "66666666-6666-4666-8666-666666666666";
const T2 = "77777777-7777-4777-8777-777777777777";
const T3 = "88888888-8888-4888-8888-888888888888";

function facts(overrides: Partial<RuleFacts> = {}): RuleFacts {
  return Object.freeze({
    accountId: A1,
    fromAccountId: null,
    toAccountId: null,
    type: "EXPENSE",
    payeeId: P1,
    payeeText: "  Biedronka Sklep 123 ",
    categoryId: C_LEAF,
    categoryAncestorIds: [C_LEAF, C_ROOT],
    description: "Zakupy",
    amount: -1000000,
    currencyCode: "PLN",
    tagIds: [T1, T2],
    hasSplits: false,
    referenceNumber: null,
    date: null,
    dayOfMonth: null,
    weekday: null,
    status: null,
    hasAttachment: false,
    ...overrides,
  });
}

const leaf = (
  field: RuleConditionLeaf["field"],
  op: RuleConditionLeaf["op"],
  value?: RuleConditionLeaf["value"],
): RuleConditionLeaf =>
  value === undefined ? { field, op } : { field, op, value };

const ev = (node: RuleConditionNode, f: RuleFacts = facts()): boolean =>
  evaluateRuleCondition(node, f);

describe("evaluateRuleCondition: groups", () => {
  it("all of nothing is true and any of nothing is false", () => {
    expect(ev({ all: [] })).toBe(true);
    expect(ev({ any: [] })).toBe(false);
  });

  it("not negates the group result", () => {
    expect(ev({ all: [], not: true })).toBe(false);
    expect(ev({ any: [], not: true })).toBe(true);
    expect(ev({ all: [leaf("hasSplits", "eq", true)], not: true })).toBe(true);
    expect(ev({ any: [leaf("hasSplits", "eq", false)], not: false })).toBe(
      true,
    );
  });

  it("all needs every child, any needs one", () => {
    const yes = leaf("type", "eq", "EXPENSE");
    const no = leaf("type", "eq", "INCOME");
    expect(ev({ all: [yes, yes] })).toBe(true);
    expect(ev({ all: [yes, no] })).toBe(false);
    expect(ev({ any: [no, yes] })).toBe(true);
    expect(ev({ any: [no, no] })).toBe(false);
  });

  it("evaluates nested all / any / not", () => {
    const tree: RuleConditionNode = {
      all: [
        leaf("type", "eq", "EXPENSE"),
        {
          any: [
            leaf("payeeText", "matches", "*BIEDRONKA*"),
            leaf("amount", "between", [-500, -100]),
          ],
        },
        { all: [leaf("tagIds", "hasAny", [T3])], not: true },
      ],
    };
    expect(ev(tree)).toBe(true);
    expect(ev(tree, facts({ payeeText: "Lidl", amount: -1 }))).toBe(false);
    expect(ev(tree, facts({ tagIds: [T3] }))).toBe(false);
  });

  it("returns false for a leaf whose field is not in the table", () => {
    const bad = { field: "amountX", op: "eq", value: 1 } as never;
    expect(ev(bad)).toBe(false);
  });

  it("returns false for an operator the field does not allow", () => {
    expect(ev({ field: "hasSplits", op: "gt", value: 1 } as never)).toBe(false);
  });
});

describe("evaluateRuleCondition: id fields", () => {
  it("eq / neq / in / notIn", () => {
    expect(ev(leaf("accountId", "eq", A1))).toBe(true);
    expect(ev(leaf("accountId", "eq", A2))).toBe(false);
    expect(ev(leaf("accountId", "neq", A2))).toBe(true);
    expect(ev(leaf("accountId", "neq", A1))).toBe(false);
    expect(ev(leaf("accountId", "in", [A2, A1]))).toBe(true);
    expect(ev(leaf("accountId", "in", [A2]))).toBe(false);
    expect(ev(leaf("accountId", "notIn", [A2]))).toBe(true);
    expect(ev(leaf("accountId", "notIn", [A1]))).toBe(false);
  });

  it("reads from/to account and payee facts", () => {
    const transfer = facts({
      type: "TRANSFER",
      fromAccountId: A1,
      toAccountId: A2,
    });
    expect(ev(leaf("fromAccountId", "eq", A1), transfer)).toBe(true);
    expect(ev(leaf("toAccountId", "in", [A2]), transfer)).toBe(true);
    expect(ev(leaf("fromAccountId", "isEmpty"), transfer)).toBe(false);
    expect(ev(leaf("payeeId", "eq", P1))).toBe(true);
  });

  it("an unknown id fact is false for everything except isEmpty", () => {
    for (const field of ["fromAccountId", "toAccountId"] as const) {
      expect(ev(leaf(field, "eq", A1))).toBe(false);
      expect(ev(leaf(field, "neq", A1))).toBe(false);
      expect(ev(leaf(field, "in", [A1]))).toBe(false);
      expect(ev(leaf(field, "notIn", [A1]))).toBe(false);
      expect(ev(leaf(field, "isEmpty"))).toBe(true);
    }
    const bare = facts({ payeeId: null, categoryId: null });
    expect(ev(leaf("payeeId", "isEmpty"), bare)).toBe(true);
    expect(ev(leaf("categoryId", "inSubtree", C_ROOT), bare)).toBe(false);
  });

  it("isEmpty is false when the id is set; unsupported op is false", () => {
    expect(ev(leaf("payeeId", "isEmpty"))).toBe(false);
    expect(ev({ field: "payeeId", op: "eq", value: P1 } as never)).toBe(true);
    // in-table for categoryId but not handled for ids: falls to default
    expect(ev({ field: "accountId", op: "lt", value: A1 } as never)).toBe(
      false,
    );
  });

  it("in / notIn with a non-array value match nothing / everything", () => {
    expect(ev({ field: "accountId", op: "in", value: A1 } as never)).toBe(
      false,
    );
    expect(ev({ field: "accountId", op: "notIn", value: A1 } as never)).toBe(
      true,
    );
  });

  it("inSubtree matches the category and its ancestors", () => {
    expect(ev(leaf("categoryId", "inSubtree", C_ROOT))).toBe(true);
    expect(ev(leaf("categoryId", "inSubtree", C_LEAF))).toBe(true);
    expect(ev(leaf("categoryId", "inSubtree", A1))).toBe(false);
    expect(ev(leaf("categoryId", "eq", C_ROOT))).toBe(false);
  });
});

describe("evaluateRuleCondition: text fields", () => {
  it("eq is case-insensitive and trimmed on both sides", () => {
    const f = facts({ description: "  ZaKupy " });
    expect(ev(leaf("description", "eq", " zakupy"), f)).toBe(true);
    expect(ev(leaf("description", "eq", "zakup"), f)).toBe(false);
  });

  it("contains and startsWith", () => {
    expect(ev(leaf("payeeText", "contains", "SKLEP"))).toBe(true);
    expect(ev(leaf("payeeText", "contains", "lidl"))).toBe(false);
    expect(ev(leaf("payeeText", "startsWith", "biedronka"))).toBe(true);
    expect(ev(leaf("payeeText", "startsWith", "sklep"))).toBe(false);
  });

  it("matches is a glob shared with the alias matcher", () => {
    expect(ev(leaf("payeeText", "matches", "*BIEDRONKA*"))).toBe(true);
    expect(ev(leaf("payeeText", "matches", "biedronka*123"))).toBe(true);
    expect(ev(leaf("payeeText", "matches", "*123"))).toBe(true);
    expect(ev(leaf("payeeText", "matches", "*sklep*biedronka*"))).toBe(false);
    expect(ev(leaf("payeeText", "matches", "biedronka"))).toBe(false);
    expect(ev(leaf("payeeText", "matches", "bie**ka***123"))).toBe(true);
    expect(ev(leaf("payeeText", "matches", "*"))).toBe(true);
    // regex metacharacters are literals
    expect(ev(leaf("payeeText", "matches", ".*"))).toBe(false);
    expect(ev(leaf("description", "matches", "zak.pv"))).toBe(false);
  });

  it("matches is false beyond the alias matcher length limit", () => {
    const long = "a".repeat(501);
    expect(
      ev(
        leaf("referenceNumber", "matches", "*"),
        facts({ referenceNumber: long }),
      ),
    ).toBe(false);
    expect(
      ev(
        leaf("referenceNumber", "matches", long),
        facts({ referenceNumber: "a" }),
      ),
    ).toBe(false);
  });

  it("isEmpty is true for null and blank, false for text", () => {
    expect(ev(leaf("referenceNumber", "isEmpty"))).toBe(true);
    expect(
      ev(leaf("referenceNumber", "isEmpty"), facts({ referenceNumber: "   " })),
    ).toBe(true);
    expect(
      ev(leaf("referenceNumber", "isEmpty"), facts({ referenceNumber: "x" })),
    ).toBe(false);
  });

  it("an unknown text fact is false for every operator except isEmpty", () => {
    for (const op of ["eq", "contains", "startsWith", "matches"] as const) {
      expect(ev(leaf("referenceNumber", op, "x"))).toBe(false);
      expect(ev(leaf("referenceNumber", op, "*"))).toBe(false);
    }
  });

  it("a non-string value or an unsupported op matches nothing", () => {
    expect(
      ev(
        { field: "referenceNumber", op: "eq", value: 5 } as never,
        facts({ referenceNumber: "5" }),
      ),
    ).toBe(false);
    expect(
      ev(
        { field: "referenceNumber", op: "lt", value: "x" } as never,
        facts({ referenceNumber: "a" }),
      ),
    ).toBe(false);
  });
});

describe("evaluateRuleCondition: money fields", () => {
  const at = (amount: number | null) => facts({ amount });

  it("eq compares scaled integers", () => {
    expect(ev(leaf("amount", "eq", -100), at(-1000000))).toBe(true);
    expect(ev(leaf("amount", "eq", -100.0001), at(-1000000))).toBe(false);
    expect(ev(leaf("amount", "eq", -100.0001), at(-1000001))).toBe(true);
  });

  it("lt / lte / gt / gte at and around the boundary", () => {
    expect(ev(leaf("amount", "lt", -100), at(-1000001))).toBe(true);
    expect(ev(leaf("amount", "lt", -100), at(-1000000))).toBe(false);
    expect(ev(leaf("amount", "lte", -100), at(-1000000))).toBe(true);
    expect(ev(leaf("amount", "lte", -100), at(-999999))).toBe(false);
    expect(ev(leaf("amount", "gt", -100), at(-999999))).toBe(true);
    expect(ev(leaf("amount", "gt", -100), at(-1000000))).toBe(false);
    expect(ev(leaf("amount", "gte", -100), at(-1000000))).toBe(true);
    expect(ev(leaf("amount", "gte", -100), at(-1000001))).toBe(false);
  });

  it("a literal beyond four decimals rounds like the stored scale", () => {
    // -100.00004 rounds to -100.0000; -100.00006 rounds to -100.0001
    expect(ev(leaf("amount", "eq", -100.00004), at(-1000000))).toBe(true);
    expect(ev(leaf("amount", "eq", -100.00006), at(-1000001))).toBe(true);
    expect(scaleRuleMoney(-100.00005)).toBe(Math.round(-100.00005 * 10000));
    expect(scaleRuleMoney("12.5")).toBe(125000);
  });

  it("between is inclusive on both ends", () => {
    const rule = leaf("amount", "between", [-500, -100]);
    expect(ev(rule, at(-5000000))).toBe(true);
    expect(ev(rule, at(-1000000))).toBe(true);
    expect(ev(rule, at(-5000001))).toBe(false);
    expect(ev(rule, at(-999999))).toBe(false);
  });

  it("between with a malformed value matches nothing", () => {
    expect(ev({ field: "amount", op: "between", value: 5 } as never)).toBe(
      false,
    );
  });

  it("absAmount ignores the sign", () => {
    expect(ev(leaf("absAmount", "gt", 99), at(-1000000))).toBe(true);
    expect(ev(leaf("absAmount", "gt", 99), at(1000000))).toBe(true);
    expect(ev(leaf("absAmount", "gt", 100), at(-1000000))).toBe(false);
    expect(ev(leaf("absAmount", "between", [100, 200]), at(-1000000))).toBe(
      true,
    );
    expect(ev(leaf("absAmount", "lte", 100), at(1000000))).toBe(true);
  });

  it("an unknown amount is false for every operator", () => {
    expect(ev(leaf("amount", "eq", 0), at(null))).toBe(false);
    expect(ev(leaf("amount", "between", [-1, 1]), at(null))).toBe(false);
    expect(ev(leaf("absAmount", "gte", 0), at(null))).toBe(false);
  });

  it("an operator outside the money set matches nothing", () => {
    expect(ev({ field: "amount", op: "in", value: [1] } as never)).toBe(false);
    expect(ev({ field: "absAmount", op: "eq", value: 100 } as never)).toBe(
      false,
    );
  });
});

describe("evaluateRuleCondition: enum, currency, boolean", () => {
  it("type eq / neq / in", () => {
    expect(ev(leaf("type", "eq", "EXPENSE"))).toBe(true);
    expect(ev(leaf("type", "eq", "INCOME"))).toBe(false);
    expect(ev(leaf("type", "neq", "INCOME"))).toBe(true);
    expect(ev(leaf("type", "neq", "EXPENSE"))).toBe(false);
    expect(ev(leaf("type", "in", ["INCOME", "EXPENSE"]))).toBe(true);
    expect(ev(leaf("type", "in", ["INCOME"]))).toBe(false);
  });

  it("currency compares case-insensitively", () => {
    expect(ev(leaf("currencyCode", "eq", "pln"))).toBe(true);
    expect(ev(leaf("currencyCode", "eq", "EUR"))).toBe(false);
    expect(ev(leaf("currencyCode", "in", ["eur", "PLN"]))).toBe(true);
    expect(ev(leaf("currencyCode", "in", ["eur"]))).toBe(false);
  });

  it("an unknown currency is false; a bad value or op is false", () => {
    const none = facts({ currencyCode: null });
    expect(ev(leaf("currencyCode", "eq", "PLN"), none)).toBe(false);
    expect(ev(leaf("currencyCode", "in", ["PLN"]), none)).toBe(false);
    expect(ev({ field: "currencyCode", op: "eq", value: 1 } as never)).toBe(
      false,
    );
    expect(ev({ field: "type", op: "lt", value: "X" } as never)).toBe(false);
    expect(ev({ field: "type", op: "in", value: "EXPENSE" } as never)).toBe(
      false,
    );
  });

  it("hasSplits eq", () => {
    expect(ev(leaf("hasSplits", "eq", false))).toBe(true);
    expect(ev(leaf("hasSplits", "eq", true))).toBe(false);
    expect(ev(leaf("hasSplits", "eq", true), facts({ hasSplits: true }))).toBe(
      true,
    );
  });
});

describe("evaluateRuleCondition: tags", () => {
  it("hasAny / hasAll / hasNone", () => {
    expect(ev(leaf("tagIds", "hasAny", [T2, T3]))).toBe(true);
    expect(ev(leaf("tagIds", "hasAny", [T3]))).toBe(false);
    expect(ev(leaf("tagIds", "hasAll", [T1, T2]))).toBe(true);
    expect(ev(leaf("tagIds", "hasAll", [T1, T3]))).toBe(false);
    expect(ev(leaf("tagIds", "hasNone", [T3]))).toBe(true);
    expect(ev(leaf("tagIds", "hasNone", [T1, T3]))).toBe(false);
  });

  it("a row without tags", () => {
    const untagged = facts({ tagIds: [] });
    expect(ev(leaf("tagIds", "hasAny", [T1]), untagged)).toBe(false);
    expect(ev(leaf("tagIds", "hasAll", [T1]), untagged)).toBe(false);
    expect(ev(leaf("tagIds", "hasNone", [T1]), untagged)).toBe(true);
  });

  it("an unsupported operator or a non-array value matches nothing", () => {
    expect(ev({ field: "tagIds", op: "eq", value: [T1] } as never)).toBe(false);
    expect(ev({ field: "tagIds", op: "hasAny", value: T1 } as never)).toBe(
      false,
    );
  });
});
