import {
  evaluateRuleCondition,
  evaluateRuleConditionWithCaptures,
} from "./rule-condition.evaluator";
import {
  RuleConditionExplanation,
  explainRuleCondition,
} from "./rule-condition.explain";
import {
  RULE_CONDITION_FIELDS,
  RULE_OPERATORS,
  RULE_TRANSACTION_STATUSES,
  RuleConditionLeaf,
  RuleConditionNode,
  RuleFacts,
  RuleField,
  RuleLeafValue,
} from "./rule-condition.types";
import { buildRuleFacts } from "./rule-facts";
import {
  MAX_RULE_CONDITION_DEPTH,
  MAX_RULE_CONDITION_NODES,
} from "./rule-validation";

const A1 = "11111111-1111-4111-8111-111111111111";
const A2 = "22222222-2222-4222-8222-222222222222";
const P1 = "33333333-3333-4333-8333-333333333333";
const C_ROOT = "44444444-4444-4444-8444-444444444444";
const C_LEAF = "55555555-5555-4555-8555-555555555555";
const T1 = "66666666-6666-4666-8666-666666666666";
const T2 = "77777777-7777-4777-8777-777777777777";
const T3 = "88888888-8888-4888-8888-888888888888";

const BASE = {
  accountId: A1,
  currencyCode: "PLN",
  amount: "-100.5000",
  isTransfer: false,
  payeeId: P1,
  payeeText: "  Sklep Alfa nr 123 ",
  categoryId: C_LEAF,
  categoryAncestorIds: [C_LEAF, C_ROOT],
  description: "Zakupy spozywcze",
  tagIds: [T1, T2],
  hasSplits: false,
  referenceNumber: "REF-42",
  transactionDate: "2026-03-01",
  status: "CLEARED",
  hasAttachment: true,
};

/** Facts of several rows: a typical expense, an empty row, a transfer, an income. */
const FACTS: Record<string, RuleFacts> = {
  expense: buildRuleFacts(BASE),
  empty: buildRuleFacts({
    accountId: A1,
    currencyCode: null,
    amount: null,
    isTransfer: false,
    payeeId: null,
    payeeText: null,
    categoryId: null,
    description: null,
    tagIds: [],
    hasSplits: false,
  }),
  transfer: buildRuleFacts({
    ...BASE,
    isTransfer: true,
    fromAccountId: A1,
    toAccountId: A2,
    payeeText: "",
    categoryId: null,
    transactionDate: "2026-02-28",
  }),
  income: buildRuleFacts({
    ...BASE,
    amount: 2500,
    hasSplits: true,
    status: "VOID",
    transactionDate: "2026-12-31",
    tagIds: [T3],
  }),
  zero: buildRuleFacts({ ...BASE, amount: "0.0000", description: "" }),
};

/** Values worth trying for each kind of field: some that hold, some that do not. */
const VALUES: Record<string, Record<string, RuleLeafValue[]>> = {
  scalar: {
    accountId: [A1, A2],
    payeeId: [P1, A2],
    categoryId: [C_LEAF, C_ROOT, A2],
    text: ["sklep alfa nr 123", "ALFA", "sklep", "zakupy", "", "REF-42"],
    money: [-100.5, 0, 2500, "-100.5"],
    enum: ["EXPENSE", "INCOME", "TRANSFER", "SUN", "MON", "CLEARED", "VOID"],
    currency: ["pln", "EUR"],
    boolean: [true, false],
    dayOfMonth: [1, 28, 31],
    date: ["2026-03-01", "2026-02-28", "2026-03-02"],
  },
  list: {
    accountId: [[A1, A2], [A2]],
    payeeId: [[P1], [A1, A2]],
    categoryId: [[C_LEAF], [A2]],
    enum: [["EXPENSE", "INCOME"], ["SUN", "SAT"], ["CLEARED"], ["TRANSFER"]],
    currency: [["PLN", "EUR"], ["USD"]],
    tagIds: [[T1], [T1, T2], [T3], [T1, T3]],
    dayOfMonth: [[1, 31], [15]],
  },
  range: {
    money: [
      [-200, -100],
      [-50, 50],
      [0, 3000],
    ],
    dayOfMonth: [
      [1, 15],
      [20, 31],
    ],
    date: [
      ["2026-01-01", "2026-03-31"],
      ["2026-04-01", "2026-04-30"],
    ],
  },
};

/** Every field with every operator its table admits, over several values. */
function everyLeaf(): RuleConditionLeaf[] {
  const out: RuleConditionLeaf[] = [];
  for (const field of Object.keys(RULE_CONDITION_FIELDS) as RuleField[]) {
    const spec = RULE_CONDITION_FIELDS[field];
    for (const op of spec.operators) {
      const shape =
        op === "isEmpty"
          ? "none"
          : op === "between"
            ? "range"
            : ["in", "notIn", "hasAny", "hasAll", "hasNone"].includes(op)
              ? "list"
              : "scalar";
      if (shape === "none") {
        out.push({ field, op });
        continue;
      }
      const values = VALUES[shape][spec.kind] ?? [];
      for (const value of values) out.push({ field, op, value });
    }
  }
  // `matches` over the text fields, with and without captures.
  for (const field of [
    "payeeText",
    "description",
    "referenceNumber",
  ] as const) {
    for (const value of [
      "*alfa*",
      "sklep {shop} nr {num}",
      "{all}",
      "zakupy {what}",
      "ref-{n}",
      "nothing {x} here",
      "*",
      "",
    ]) {
      out.push({ field, op: "matches", value });
    }
  }
  out.push({ field: "categoryId", op: "inSubtree", value: C_ROOT });
  out.push({ field: "categoryId", op: "inSubtree", value: A2 });
  return out;
}

/** Leaves the table does not admit: a stored rule that no longer fits matches nothing. */
const OFF_TABLE: RuleConditionLeaf[] = [
  { field: "payeeText", op: "between", value: [1, 2] as never },
  { field: "amount", op: "contains", value: "x" },
  { field: "hasSplits", op: "neq", value: true },
  { field: "memo" as RuleField, op: "eq", value: "x" },
];

const leaf = (
  field: RuleField,
  op: RuleConditionLeaf["op"],
  value?: RuleLeafValue,
): RuleConditionLeaf =>
  value === undefined ? { field, op } : { field, op, value };

const YES = leaf("type", "eq", "EXPENSE");
const NO = leaf("type", "eq", "INCOME");
const CAP = leaf("payeeText", "matches", "sklep {shop} nr {num}");
const CAP2 = leaf("description", "matches", "zakupy {what}");

/** Groups: nesting, negation, empty groups, captures under any / not. */
const GROUPS: RuleConditionNode[] = [
  { all: [] },
  { any: [] },
  { all: [], not: true },
  { any: [], not: true },
  { all: [YES, NO] },
  { any: [YES, NO] },
  { all: [YES, YES], not: true },
  { any: [NO, NO], not: true },
  { all: [YES, { any: [NO, CAP] }] },
  { all: [CAP, CAP2] },
  { any: [CAP, CAP2] },
  { any: [NO, CAP2, CAP] },
  { all: [CAP, { all: [CAP2], not: true }] },
  { all: [{ any: [CAP], not: true }, YES] },
  {
    all: [YES, { any: [NO, { all: [CAP, { any: [CAP2, NO] }], not: false }] }],
  },
  {
    all: [{ any: [{ all: [{ any: [YES, NO], not: true }, CAP] }, CAP2] }],
  },
];

/** Every fixture the property runs over, named for the failure message. */
function fixtures(): Array<[string, RuleConditionNode]> {
  return [
    ...everyLeaf(),
    ...OFF_TABLE,
    ...GROUPS,
    // Every leaf, once, inside one `all` and one `any`.
    { all: everyLeaf() },
    { any: everyLeaf() },
  ].map((node) => [JSON.stringify(node).slice(0, 120), node]);
}

function childrenOf(
  explanation: RuleConditionExplanation,
): readonly RuleConditionExplanation[] {
  if (
    explanation.kind === "all" ||
    explanation.kind === "any" ||
    explanation.kind === "not"
  ) {
    return explanation.children;
  }
  throw new Error(`a ${explanation.kind} has no children`);
}

function countLeaves(explanation: RuleConditionExplanation): number {
  if (explanation.kind === "leaf") return 1;
  if (explanation.kind === "omitted") return 0;
  return explanation.children.reduce((sum, c) => sum + countLeaves(c), 0);
}

function depthOf(explanation: RuleConditionExplanation): number {
  if (explanation.kind === "leaf" || explanation.kind === "omitted") return 1;
  return 1 + Math.max(0, ...explanation.children.map(depthOf));
}

function leavesOf(node: RuleConditionNode): number {
  if ("all" in node) return node.all.reduce((s, c) => s + leavesOf(c), 0);
  if ("any" in node) return node.any.reduce((s, c) => s + leavesOf(c), 0);
  return 1;
}

describe("explainRuleCondition: the evaluator's answer, explained", () => {
  const table = fixtures();

  it("covers every field and operator of the table and every group shape", () => {
    const seen = new Set(everyLeaf().map((l) => `${l.field}:${l.op}`));
    for (const field of Object.keys(RULE_CONDITION_FIELDS) as RuleField[]) {
      for (const op of RULE_CONDITION_FIELDS[field].operators) {
        expect(seen).toContain(`${field}:${op}`);
      }
    }
    // Every operator is used by some field.
    for (const op of RULE_OPERATORS) {
      expect([...seen].some((key) => key.endsWith(`:${op}`))).toBe(true);
    }
    expect(table.length).toBeGreaterThan(250);
  });

  it.each(Object.keys(FACTS))(
    "result and root captures equal the evaluator's for every fixture over the %s row",
    (name) => {
      const facts = FACTS[name];
      for (const [label, node] of table) {
        const explained = explainRuleCondition(node, facts);
        const evaluated = evaluateRuleCondition(node, facts);
        const withCaptures = evaluateRuleConditionWithCaptures(node, facts);
        if (explained.result !== evaluated) {
          throw new Error(`result differs for ${label}`);
        }
        if (explained.result !== withCaptures.matched) {
          throw new Error(`matched differs for ${label}`);
        }
        const captures = withCaptures.matched ? withCaptures.captures : {};
        expect({ ...(explained.captures ?? {}) }).toEqual({ ...captures });
      }
    },
  );

  it("explains every child, so a failing leaf is shown even after the group is decided", () => {
    const explained = explainRuleCondition(
      {
        all: [
          NO,
          leaf("status", "eq", "CLEARED"),
          leaf("hasSplits", "eq", false),
        ],
      },
      FACTS.expense,
    );
    expect(explained).toMatchObject({
      kind: "all",
      result: false,
      children: [
        { kind: "leaf", field: "type", result: false },
        { kind: "leaf", field: "status", result: true },
        { kind: "leaf", field: "hasSplits", result: true },
      ],
    });
  });

  it("mirrors the tree: not wraps the group it negates", () => {
    const explained = explainRuleCondition(
      { any: [YES, NO], not: true },
      FACTS.expense,
    );
    expect(explained).toMatchObject({
      kind: "not",
      result: false,
      children: [{ kind: "any", result: true }],
    });
    expect(
      explainRuleCondition({ all: [], not: true }, FACTS.expense),
    ).toMatchObject({
      kind: "not",
      result: false,
      children: [{ kind: "all", result: true, children: [] }],
    });
  });

  it("keeps the leaves of the condition, none dropped and none added", () => {
    for (const [, node] of table) {
      // The two fixtures that hold every leaf at once exceed the node limit,
      // where the explanation omits subtrees (see "bounds").
      if (leavesOf(node) >= MAX_RULE_CONDITION_NODES - 2) continue;
      const explained = explainRuleCondition(node, FACTS.expense);
      expect(countLeaves(explained)).toBe(leavesOf(node));
    }
  });

  describe("what a leaf reports", () => {
    const only = (node: RuleConditionLeaf, facts = FACTS.expense) =>
      explainRuleCondition(node, facts) as Extract<
        RuleConditionExplanation,
        { kind: "leaf" }
      >;

    it("reports money as a decimal string at four decimals, signed for amount and absolute for absAmount", () => {
      expect(only(leaf("amount", "lt", -50))).toMatchObject({
        field: "amount",
        operator: "lt",
        expected: -50,
        actual: "-100.5000",
        result: true,
      });
      expect(only(leaf("absAmount", "gt", 100))).toMatchObject({
        actual: "100.5000",
        result: true,
      });
      expect(only(leaf("amount", "eq", 0), FACTS.empty)).toMatchObject({
        actual: null,
        result: false,
      });
    });

    it("reports a four-decimal amount without float drift", () => {
      const facts = buildRuleFacts({ ...BASE, amount: "0.0001" });
      expect(only(leaf("amount", "gt", 0), facts).actual).toBe("0.0001");
      const small = buildRuleFacts({ ...BASE, amount: "-0.0005" });
      expect(only(leaf("absAmount", "lt", 1), small).actual).toBe("0.0005");
    });

    it("reports a coin amount at its own places, and the rule 'amount equals 0.00002500' matches it", () => {
      const coin = buildRuleFacts({ ...BASE, amount: "-0.00002500" });
      expect(only(leaf("amount", "eq", -0.000025), coin)).toMatchObject({
        actual: "-0.000025",
        result: true,
      });
      expect(only(leaf("absAmount", "gt", 0.00001), coin).actual).toBe(
        "0.000025",
      );
    });

    it("reports the day of the month and the weekday the row's own date gives", () => {
      expect(only(leaf("dayOfMonth", "eq", 1))).toMatchObject({
        actual: 1,
        result: true,
      });
      // 2026-03-01 is a Sunday.
      expect(only(leaf("weekday", "eq", "SUN"))).toMatchObject({
        actual: "SUN",
        result: true,
      });
      expect(only(leaf("dayOfMonth", "eq", 1), FACTS.empty)).toMatchObject({
        actual: null,
        result: false,
      });
    });

    it("reports ids, the tag set, text as the row holds it, and booleans", () => {
      expect(only(leaf("accountId", "eq", A1)).actual).toBe(A1);
      expect(only(leaf("fromAccountId", "isEmpty"))).toMatchObject({
        actual: null,
        expected: null,
        result: true,
      });
      expect(only(leaf("tagIds", "hasAll", [T1, T3]))).toMatchObject({
        actual: [T1, T2],
        expected: [T1, T3],
        result: false,
      });
      expect(only(leaf("payeeText", "contains", "alfa")).actual).toBe(
        "  Sklep Alfa nr 123 ",
      );
      expect(only(leaf("hasAttachment", "eq", true)).actual).toBe(true);
      expect(only(leaf("status", "eq", "CLEARED")).actual).toBe("CLEARED");
      expect(RULE_TRANSACTION_STATUSES).toContain("CLEARED");
    });

    it("keeps the value as authored and reports a leaf the table no longer admits as false with no fact", () => {
      expect(only(leaf("payeeText", "eq", "  MiXeD "))).toMatchObject({
        expected: "  MiXeD ",
        result: false,
      });
      expect(
        only({ field: "memo" as RuleField, op: "eq", value: "x" }),
      ).toMatchObject({ actual: null, result: false });
      expect(only(leaf("amount", "contains", "x"))).toMatchObject({
        result: false,
      });
    });

    it("hands back a copy of the tag set, not the facts' own array", () => {
      const explained = only(leaf("tagIds", "hasAny", [T1]));
      expect(explained.actual).not.toBe(FACTS.expense.tagIds);
    });
  });

  describe("captures", () => {
    it("a matching leaf carries what it captured, and the root carries the merge of the holding children", () => {
      const explained = explainRuleCondition(
        { all: [CAP, leaf("description", "matches", "nothing {x}")] },
        FACTS.expense,
      );
      expect(explained.result).toBe(false);
      expect(explained.captures).toBeUndefined();

      const both = explainRuleCondition(
        {
          all: [CAP, leaf("description", "matches", "zakupy {what}")],
        },
        FACTS.expense,
      );
      expect(both.result).toBe(true);
      expect({ ...both.captures }).toEqual({
        shop: "Alfa",
        num: "123",
        what: "spozywcze",
      });
      expect(childrenOf(both)[0]).toMatchObject({
        kind: "leaf",
        captures: { shop: "Alfa", num: "123" },
      });
    });

    it("a leaf of a branch that did not hold, or under not, captures nothing", () => {
      const anyOf = explainRuleCondition(
        { any: [leaf("payeeText", "matches", "nothing {x}"), CAP] },
        FACTS.expense,
      );
      expect({ ...anyOf.captures }).toEqual({ shop: "Alfa", num: "123" });
      const negated = explainRuleCondition(
        { all: [leaf("payeeText", "matches", "zzz {x}")], not: true },
        FACTS.expense,
      );
      expect(negated.result).toBe(true);
      expect(negated.captures).toBeUndefined();
    });

    it("a pattern without a capture reports none", () => {
      const explained = explainRuleCondition(
        leaf("payeeText", "matches", "*alfa*"),
        FACTS.expense,
      );
      expect(explained).toMatchObject({ result: true });
      expect(explained.captures).toBeUndefined();
    });
  });

  describe("bounds", () => {
    const chain = (depth: number): RuleConditionNode =>
      depth === 0 ? YES : { all: [chain(depth - 1)] };

    it("explains a condition at the validator's depth in full", () => {
      // Groups down to the limit, and the leaf one level below the last.
      const explained = explainRuleCondition(
        chain(MAX_RULE_CONDITION_DEPTH),
        FACTS.expense,
      );
      expect(depthOf(explained)).toBe(MAX_RULE_CONDITION_DEPTH + 1);
      expect(countLeaves(explained)).toBe(1);
    });

    it("omits a subtree below the depth limit but keeps its answer and its captures", () => {
      const deep = chain(MAX_RULE_CONDITION_DEPTH + 3);
      const explained = explainRuleCondition(deep, FACTS.expense);
      expect(depthOf(explained)).toBeLessThanOrEqual(
        MAX_RULE_CONDITION_DEPTH + 1,
      );
      expect(explained.result).toBe(evaluateRuleCondition(deep, FACTS.expense));
      const deepCapture: RuleConditionNode = {
        all: [{ all: [{ all: [{ all: [{ all: [CAP] }] }] }] }],
      };
      const captured = explainRuleCondition(deepCapture, FACTS.expense);
      expect({ ...captured.captures }).toEqual({ shop: "Alfa", num: "123" });
    });

    it("stops listing nodes beyond the validator's node limit, and the answer stays the evaluator's", () => {
      const wide: RuleConditionNode = {
        any: Array.from({ length: MAX_RULE_CONDITION_NODES + 50 }, () => NO),
      };
      const explained = explainRuleCondition(wide, FACTS.expense);
      expect(explained.kind).toBe("any");
      const kids = childrenOf(explained);
      expect(kids.filter((c) => c.kind === "leaf")).toHaveLength(
        MAX_RULE_CONDITION_NODES - 1,
      );
      expect(kids.filter((c) => c.kind === "omitted")).toHaveLength(51);
      expect(explained.result).toBe(false);
    });
  });
});
