import { RuleAction } from "./rule-action.types";
import { RuleConditionNode, RuleFacts } from "./rule-condition.types";
import {
  PlannableRule,
  hasRuleEffects,
  planRuleEffects,
  recordAiReviewAlreadyQueued,
  recordAiReviewQueued,
  ruleConditionMatches,
} from "./rule-effects";
import { RuleFactsInput, buildRuleFacts } from "./rule-facts";

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ACCOUNT = uuid(1);
const PAYEE = uuid(2);
const OTHER_PAYEE = uuid(3);
const CAT = uuid(4);
const OTHER_CAT = uuid(5);
const PARENT_CAT = uuid(6);
const TAG_A = uuid(7);
const TAG_B = uuid(8);
const TAG_C = uuid(9);

const ALWAYS: RuleConditionNode = { all: [] };

function facts(over: Partial<RuleFactsInput> = {}): RuleFacts {
  return buildRuleFacts({
    accountId: ACCOUNT,
    currencyCode: "PLN",
    amount: -50,
    isTransfer: false,
    payeeId: null,
    payeeText: "Biedronka 12",
    categoryId: null,
    description: null,
    tagIds: [],
    hasSplits: false,
    ...over,
  });
}

let counter = 0;
function rule(
  actions: RuleAction[],
  over: Partial<PlannableRule> = {},
): PlannableRule {
  counter += 1;
  return {
    id: uuid(100 + counter),
    enabled: true,
    stopProcessing: false,
    condition: ALWAYS,
    actions,
    ...over,
  };
}

const setCategory = (categoryId: string, onlyIfEmpty = true): RuleAction => ({
  type: "set_category",
  categoryId,
  onlyIfEmpty,
});
const setPayee = (payeeId: string, onlyIfEmpty = true): RuleAction => ({
  type: "set_payee",
  payeeId,
  onlyIfEmpty,
});
const addTags = (...tagIds: string[]): RuleAction => ({
  type: "add_tags",
  tagIds,
});
const removeTags = (...tagIds: string[]): RuleAction => ({
  type: "remove_tags",
  tagIds,
});

describe("planRuleEffects: actions", () => {
  it("plans nothing for no rules", () => {
    const plan = planRuleEffects(facts(), []);
    expect(plan).toEqual({
      changes: { addTagIds: [], removeTagIds: [] },
      trace: [],
      aiReviewRequests: [],
    });
    expect(hasRuleEffects(plan)).toBe(false);
  });

  it("add_tags adds only the tags the row lacks", () => {
    const r = rule([addTags(TAG_A, TAG_B)]);
    const plan = planRuleEffects(facts({ tagIds: [TAG_A] }), [r]);
    expect(plan.changes.addTagIds).toEqual([TAG_B]);
    expect(plan.trace[0].changes.tagIds).toEqual({
      before: [TAG_A],
      after: [TAG_A, TAG_B].sort(),
    });
  });

  it("add_tags is idempotent: tags already present are skipped as no_change", () => {
    const r = rule([addTags(TAG_A)]);
    const plan = planRuleEffects(facts({ tagIds: [TAG_A] }), [r]);
    expect(plan.changes.addTagIds).toEqual([]);
    expect(plan.trace[0].skipped).toEqual([
      { type: "add_tags", reason: "no_change" },
    ]);
    expect(plan.trace[0].changes).toEqual({});
  });

  it("remove_tags removes present tags and leaves the others", () => {
    const plan = planRuleEffects(facts({ tagIds: [TAG_A, TAG_B] }), [
      rule([removeTags(TAG_A, TAG_C)]),
    ]);
    expect(plan.changes.removeTagIds).toEqual([TAG_A]);
    expect(plan.changes.addTagIds).toEqual([]);
  });

  it("remove_tags of an absent tag is a no_change skip", () => {
    const plan = planRuleEffects(facts(), [rule([removeTags(TAG_A)])]);
    expect(plan.trace[0].skipped).toEqual([
      { type: "remove_tags", reason: "no_change" },
    ]);
  });

  it("set_category sets an empty category", () => {
    const plan = planRuleEffects(facts(), [rule([setCategory(CAT)])]);
    expect(plan.changes.categoryId).toBe(CAT);
    expect(plan.trace[0].changes.categoryId).toEqual({
      before: null,
      after: CAT,
    });
  });

  it("set_category onlyIfEmpty keeps a category that is already set", () => {
    const plan = planRuleEffects(facts({ categoryId: OTHER_CAT }), [
      rule([setCategory(CAT, true)]),
    ]);
    expect("categoryId" in plan.changes).toBe(false);
    expect(plan.trace[0].skipped).toEqual([
      { type: "set_category", reason: "already_set" },
    ]);
  });

  it("set_category with onlyIfEmpty false replaces the category", () => {
    const plan = planRuleEffects(facts({ categoryId: OTHER_CAT }), [
      rule([setCategory(CAT, false)]),
    ]);
    expect(plan.changes.categoryId).toBe(CAT);
  });

  it("set_category to the category the row already has is a no_change skip", () => {
    const plan = planRuleEffects(facts({ categoryId: CAT }), [
      rule([setCategory(CAT, false)]),
    ]);
    expect("categoryId" in plan.changes).toBe(false);
    expect(plan.trace[0].skipped[0].reason).toBe("no_change");
  });

  it("set_category is refused on a row with splits and the rest of the rule still runs", () => {
    const plan = planRuleEffects(facts({ hasSplits: true }), [
      rule([setCategory(CAT), addTags(TAG_A)]),
    ]);
    expect("categoryId" in plan.changes).toBe(false);
    expect(plan.trace[0].skipped).toEqual([
      { type: "set_category", reason: "row_has_splits" },
    ]);
    expect(plan.changes.addTagIds).toEqual([TAG_A]);
  });

  it("set_category applies to a transfer leg, a Transfer category included (INV-CATEGORY-001)", () => {
    const transfer = facts({
      isTransfer: true,
      fromAccountId: ACCOUNT,
      toAccountId: uuid(50),
    });
    const plan = planRuleEffects(transfer, [rule([setCategory(CAT, false)])], {
      transferCategoryIds: new Set([CAT]),
    });
    expect(plan.changes.categoryId).toBe(CAT);
    expect(plan.trace[0].skipped).toEqual([]);
  });

  it("set_category skips a Transfer category on a row that is not a transfer, naming why", () => {
    const plan = planRuleEffects(facts(), [rule([setCategory(CAT, false)])], {
      transferCategoryIds: new Set([CAT]),
    });
    expect("categoryId" in plan.changes).toBe(false);
    expect(plan.trace[0].skipped).toEqual([
      { type: "set_category", reason: "category_does_not_fit" },
    ]);
    // An Income or Expense category still applies.
    expect(
      planRuleEffects(facts(), [rule([setCategory(CAT, false)])], {
        transferCategoryIds: new Set(),
      }).changes.categoryId,
    ).toBe(CAT);
  });

  it("set_payee sets an empty payee, keeps a set one under onlyIfEmpty, replaces it otherwise", () => {
    expect(
      planRuleEffects(facts(), [rule([setPayee(PAYEE)])]).changes.payeeId,
    ).toBe(PAYEE);
    const kept = planRuleEffects(facts({ payeeId: OTHER_PAYEE }), [
      rule([setPayee(PAYEE, true)]),
    ]);
    expect("payeeId" in kept.changes).toBe(false);
    expect(kept.trace[0].skipped[0].reason).toBe("already_set");
    const replaced = planRuleEffects(facts({ payeeId: OTHER_PAYEE }), [
      rule([setPayee(PAYEE, false)]),
    ]);
    expect(replaced.changes.payeeId).toBe(PAYEE);
  });

  it("set_payee is refused on a leg of a cross-owner transfer, allowed on a same-owner leg", () => {
    const leg = facts({ isTransfer: true });
    const refused = planRuleEffects(leg, [rule([setPayee(PAYEE)])], {
      crossOwnerTransferLeg: true,
    });
    expect("payeeId" in refused.changes).toBe(false);
    expect(refused.trace[0].skipped).toEqual([
      { type: "set_payee", reason: "cross_owner_transfer_leg" },
    ]);
    const allowed = planRuleEffects(leg, [rule([setPayee(PAYEE)])]);
    expect(allowed.changes.payeeId).toBe(PAYEE);
  });

  it("changes only category, payee and tags: never amount, account, date, status or a link (I1)", () => {
    const plan = planRuleEffects(facts(), [
      rule([setCategory(CAT), setPayee(PAYEE), addTags(TAG_A)]),
    ]);
    expect(Object.keys(plan.changes).sort()).toEqual([
      "addTagIds",
      "categoryId",
      "payeeId",
      "removeTagIds",
    ]);
    expect(Object.keys(plan.trace[0].changes).sort()).toEqual([
      "categoryId",
      "payeeId",
      "tagIds",
    ]);
  });
});

describe("planRuleEffects: payee default category against a rule (design 6.4)", () => {
  // create() applies the explicit value, then the payee default, then the
  // rules; the facts a rule sees already hold steps 1 and 2.
  it.each([
    ["no explicit value, no payee default", null, true, CAT],
    ["no explicit value, no payee default", null, false, CAT],
    ["payee default present", OTHER_CAT, true, OTHER_CAT],
    ["payee default present", OTHER_CAT, false, CAT],
    ["explicit category in the request", OTHER_CAT, true, OTHER_CAT],
    ["explicit category in the request", OTHER_CAT, false, CAT],
  ])(
    "%s, onlyIfEmpty=%s: final category is right",
    (_label, current, onlyIfEmpty, expected) => {
      const plan = planRuleEffects(facts({ categoryId: current }), [
        rule([setCategory(CAT, onlyIfEmpty)]),
      ]);
      const final =
        "categoryId" in plan.changes ? plan.changes.categoryId : current;
      expect(final).toBe(expected);
    },
  );
});

describe("planRuleEffects: order", () => {
  it("runs rules in the order given and a later rule sees an earlier rule's result", () => {
    const first = rule([setCategory(CAT)]);
    const second = rule([addTags(TAG_A)], {
      condition: { field: "categoryId", op: "eq", value: CAT },
    });
    const plan = planRuleEffects(facts(), [first, second]);
    expect(plan.trace.map((t) => t.matched)).toEqual([true, true]);
    expect(plan.changes.addTagIds).toEqual([TAG_A]);
  });

  it("does not match a later rule whose condition needs a value an earlier rule has not set", () => {
    const first = rule([addTags(TAG_A)], {
      condition: { field: "categoryId", op: "eq", value: CAT },
    });
    const second = rule([setCategory(CAT)]);
    const plan = planRuleEffects(facts(), [first, second]);
    expect(plan.trace.map((t) => t.matched)).toEqual([false, true]);
    expect(plan.changes.addTagIds).toEqual([]);
  });

  it("a later rule sees tags and payee set earlier", () => {
    const first = rule([addTags(TAG_A), setPayee(PAYEE)]);
    const second = rule([addTags(TAG_B)], {
      condition: {
        all: [
          { field: "tagIds", op: "hasAll", value: [TAG_A] },
          { field: "payeeId", op: "eq", value: PAYEE },
        ],
      },
    });
    const plan = planRuleEffects(facts(), [first, second]);
    expect(plan.changes.addTagIds).toEqual([TAG_A, TAG_B]);
  });

  it("a later rule's inSubtree sees the ancestors of a category an earlier rule set", () => {
    const first = rule([setCategory(CAT)]);
    const second = rule([addTags(TAG_A)], {
      condition: { field: "categoryId", op: "inSubtree", value: PARENT_CAT },
    });
    const chains = new Map([[CAT, [CAT, PARENT_CAT]]]);
    const plan = planRuleEffects(facts(), [first, second], {
      categoryChains: chains,
    });
    expect(plan.changes.addTagIds).toEqual([TAG_A]);
    const without = planRuleEffects(facts(), [first, second]);
    expect(without.trace[1].matched).toBe(false);
  });

  it("nets a tag one rule added and a later rule removed to no change, and traces both", () => {
    const plan = planRuleEffects(facts(), [
      rule([addTags(TAG_A)]),
      rule([removeTags(TAG_A)]),
    ]);
    expect(plan.changes.addTagIds).toEqual([]);
    expect(plan.changes.removeTagIds).toEqual([]);
    expect(plan.trace.map((t) => Object.keys(t.changes))).toEqual([
      ["tagIds"],
      ["tagIds"],
    ]);
  });

  it("two rules and stopProcessing: the matched stopping rule ends the pass", () => {
    const first = rule([addTags(TAG_A)], { stopProcessing: true });
    const second = rule([addTags(TAG_B)]);
    const plan = planRuleEffects(facts(), [first, second]);
    expect(plan.changes.addTagIds).toEqual([TAG_A]);
    expect(plan.trace).toHaveLength(1);
    expect(plan.trace[0].stopped).toBe(true);
  });

  it("stopProcessing on a rule that did not match does not end the pass", () => {
    const first = rule([addTags(TAG_A)], {
      stopProcessing: true,
      condition: { field: "payeeId", op: "eq", value: PAYEE },
    });
    const second = rule([addTags(TAG_B)]);
    const plan = planRuleEffects(facts(), [first, second]);
    expect(plan.trace.map((t) => t.matched)).toEqual([false, true]);
    expect(plan.changes.addTagIds).toEqual([TAG_B]);
  });

  it("stopProcessing ends the pass even when every action of the matched rule was skipped", () => {
    const first = rule([setCategory(CAT)], { stopProcessing: true });
    const second = rule([addTags(TAG_B)]);
    const plan = planRuleEffects(facts({ categoryId: OTHER_CAT }), [
      first,
      second,
    ]);
    expect(plan.trace).toHaveLength(1);
    expect(plan.changes.addTagIds).toEqual([]);
  });

  it("makes one pass: an action never starts the rules again", () => {
    // Rule 1 needs the tag rule 2 adds; there is no second pass to satisfy it.
    const first = rule([setCategory(CAT)], {
      condition: { field: "tagIds", op: "hasAny", value: [TAG_A] },
    });
    const second = rule([addTags(TAG_A)]);
    const plan = planRuleEffects(facts(), [first, second]);
    expect(plan.trace.map((t) => t.matched)).toEqual([false, true]);
    expect("categoryId" in plan.changes).toBe(false);
  });
});

describe("planRuleEffects: disabled, invalid, AI review", () => {
  it("skips a disabled rule and says so in the trace", () => {
    const off = rule([addTags(TAG_A)], { enabled: false });
    const plan = planRuleEffects(facts(), [off]);
    expect(plan.trace).toEqual([
      expect.objectContaining({
        ruleId: off.id,
        matched: false,
        skippedRule: "disabled",
      }),
    ]);
    expect(plan.changes.addTagIds).toEqual([]);
  });

  it("skips an invalid rule (shape) and still runs the next", () => {
    const broken = rule([], {}); // no actions
    const bad = rule([addTags(TAG_A)], { condition: {} as never });
    const good = rule([addTags(TAG_B)]);
    const plan = planRuleEffects(facts(), [broken, bad, good]);
    expect(plan.trace.map((t) => t.skippedRule)).toEqual([
      "invalid",
      "invalid",
      undefined,
    ]);
    expect(plan.changes.addTagIds).toEqual([TAG_B]);
  });

  it("a disabled stopProcessing rule does not stop the pass", () => {
    const off = rule([addTags(TAG_A)], {
      enabled: false,
      stopProcessing: true,
    });
    const on = rule([addTags(TAG_B)]);
    expect(planRuleEffects(facts(), [off, on]).changes.addTagIds).toEqual([
      TAG_B,
    ]);
  });

  it("collects request_ai_review and never applies it as a ledger change", () => {
    const r = rule([
      { type: "request_ai_review", instruction: "split by receipt" },
      addTags(TAG_A),
    ]);
    const plan = planRuleEffects(facts(), [r]);
    expect(plan.aiReviewRequests).toEqual([
      { ruleId: r.id, instruction: "split by receipt" },
    ]);
    expect(plan.changes).toEqual({ addTagIds: [TAG_A], removeTagIds: [] });
    expect(plan.trace[0].applied).toEqual([{ type: "add_tags" }]);
  });

  it("a rule with only request_ai_review changes no ledger field", () => {
    const r = rule([{ type: "request_ai_review", instruction: "look" }]);
    const plan = planRuleEffects(facts(), [r]);
    expect(plan.changes).toEqual({ addTagIds: [], removeTagIds: [] });
    expect(hasRuleEffects(plan)).toBe(true);
  });

  it("recordAiReviewQueued traces the asking rule's request as queued, not skipped", () => {
    const r = rule([{ type: "request_ai_review", instruction: "look" }]);
    const other = rule([addTags(TAG_A)]);
    const plan = recordAiReviewQueued(planRuleEffects(facts(), [r, other]));
    expect(plan.trace[0].applied).toEqual([
      { type: "request_ai_review", outcome: "queued" },
    ]);
    expect(plan.trace[0].skipped).toEqual([]);
    expect(plan.trace[1].applied).toEqual([{ type: "add_tags" }]);
    expect(plan.aiReviewRequests).toHaveLength(1);
  });

  it("recordAiReviewQueued returns the same plan when nothing asked", () => {
    const plan = planRuleEffects(facts(), [rule([addTags(TAG_A)])]);
    expect(recordAiReviewQueued(plan)).toBe(plan);
  });

  it("recordAiReviewAlreadyQueued relabels only the rules named", () => {
    const a = rule([{ type: "request_ai_review", instruction: "one" }]);
    const b = rule([{ type: "request_ai_review", instruction: "two" }]);
    const queued = recordAiReviewQueued(planRuleEffects(facts(), [a, b]));
    const plan = recordAiReviewAlreadyQueued(queued, new Set([b.id]));
    expect(plan.trace[0].applied).toEqual([
      { type: "request_ai_review", outcome: "queued" },
    ]);
    expect(plan.trace[1].applied).toEqual([
      { type: "request_ai_review", outcome: "already_queued" },
    ]);
    expect(recordAiReviewAlreadyQueued(queued, new Set())).toBe(queued);
  });
});

describe("planRuleEffects: purity", () => {
  it("does not mutate the facts or the rules", () => {
    const f = facts({ tagIds: [TAG_A] });
    const r = rule([addTags(TAG_B), setCategory(CAT)]);
    const frozenRule = Object.freeze({
      ...r,
      actions: Object.freeze([...r.actions]),
    });
    const before = JSON.stringify([f, frozenRule]);
    planRuleEffects(f, [frozenRule]);
    expect(JSON.stringify([f, frozenRule])).toBe(before);
  });

  it("is deterministic: the same input gives the same plan", () => {
    const rules = [rule([addTags(TAG_A), setCategory(CAT)])];
    expect(planRuleEffects(facts(), rules)).toEqual(
      planRuleEffects(facts(), rules),
    );
  });
});

describe("planRuleEffects: onEvaluate", () => {
  const observe = (rules: PlannableRule[], f = facts()) => {
    const seen: Array<{ ruleId: string; facts: RuleFacts }> = [];
    const plan = planRuleEffects(f, rules, {
      onEvaluate: (ruleId, evaluated) =>
        seen.push({ ruleId, facts: evaluated }),
    });
    return { seen, plan };
  };

  it("reports each rule reached, in order, with the facts it was evaluated against", () => {
    const first = rule([setCategory(CAT), addTags(TAG_A)]);
    const second = rule([addTags(TAG_B)]);
    const { seen } = observe([first, second]);

    expect(seen.map((s) => s.ruleId)).toEqual([first.id, second.id]);
    expect(seen[0].facts.categoryId).toBeNull();
    // The second rule sees what the first one changed.
    expect(seen[1].facts.categoryId).toBe(CAT);
    expect(seen[1].facts.tagIds).toEqual([TAG_A]);
  });

  it("does not report a disabled or invalid rule, nor a rule after a stop", () => {
    const disabled = rule([addTags(TAG_A)], { enabled: false });
    const invalid = rule([], {});
    const stop = rule([addTags(TAG_B)], { stopProcessing: true });
    const after = rule([addTags(TAG_C)]);
    const { seen } = observe([disabled, invalid, stop, after]);

    expect(seen.map((s) => s.ruleId)).toEqual([stop.id]);
  });

  it("reports a rule whose condition does not hold, and changes nothing about the plan", () => {
    const misses = rule([addTags(TAG_A)], {
      condition: { field: "type", op: "eq", value: "INCOME" },
    });
    const { seen, plan } = observe([misses]);
    expect(seen.map((s) => s.ruleId)).toEqual([misses.id]);
    expect(plan).toEqual(planRuleEffects(facts(), [misses]));
  });
});

describe("ruleConditionMatches", () => {
  const coffee: RuleConditionNode = {
    field: "payeeText",
    op: "contains",
    value: "biedronka",
  };
  const dated = (transactionDate: string | null) => facts({ transactionDate });

  it("answers the condition alone, with no action to plan", () => {
    expect(ruleConditionMatches({ condition: coffee }, facts())).toBe(true);
    expect(
      ruleConditionMatches(
        { condition: { ...coffee, value: "lidl" } },
        facts(),
      ),
    ).toBe(false);
  });

  it("agrees with the planner's trace on the same rule and row", () => {
    for (const condition of [coffee, { ...coffee, value: "lidl" }]) {
      const planned = rule([addTags(TAG_A)], { condition });
      expect(ruleConditionMatches(planned, facts())).toBe(
        planRuleEffects(facts(), [planned]).trace[0].matched,
      );
    }
  });

  it("is false outside the active window, inclusive at both ends, and for an unknown date", () => {
    const windowed = {
      condition: coffee,
      activeFrom: "2026-10-01",
      activeTo: "2026-10-31",
    };
    expect(ruleConditionMatches(windowed, dated("2026-09-30"))).toBe(false);
    expect(ruleConditionMatches(windowed, dated("2026-10-01"))).toBe(true);
    expect(ruleConditionMatches(windowed, dated("2026-10-31"))).toBe(true);
    expect(ruleConditionMatches(windowed, dated("2026-11-01"))).toBe(false);
    expect(ruleConditionMatches(windowed, dated(null))).toBe(false);
  });
});
