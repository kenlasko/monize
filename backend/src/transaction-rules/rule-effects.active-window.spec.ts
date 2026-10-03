import { RuleAction } from "./rule-action.types";
import { RuleConditionNode } from "./rule-condition.types";
import { PlannableRule, planRuleEffects } from "./rule-effects";
import { buildRuleFacts } from "./rule-facts";

/**
 * INV-RULE-004: a rule with an active window is evaluated only for a row whose
 * calendar date is known and inside it, inclusive at both ends.
 */
const CAT = "00000000-0000-4000-8000-000000000004";
const ALWAYS: RuleConditionNode = { all: [] };
const SET_CATEGORY: RuleAction[] = [
  { type: "set_category", categoryId: CAT, onlyIfEmpty: true },
];

const facts = (transactionDate: string | null) =>
  buildRuleFacts({
    accountId: "00000000-0000-4000-8000-000000000001",
    currencyCode: "PLN",
    amount: -102.21,
    isTransfer: false,
    payeeId: null,
    payeeText: "KAPITAL: 0,00 ODSETKI: 102,21",
    categoryId: null,
    description: null,
    tagIds: [],
    hasSplits: false,
    transactionDate,
  });

const rule = (over: Partial<PlannableRule> = {}): PlannableRule => ({
  id: "r1",
  enabled: true,
  stopProcessing: false,
  condition: ALWAYS,
  actions: SET_CATEGORY,
  ...over,
});

const WINDOW = { activeFrom: "2026-10-01", activeTo: "2026-10-31" };

describe("planRuleEffects: the active window", () => {
  it("skips a row dated before activeFrom and changes nothing", () => {
    const effects = planRuleEffects(facts("2026-09-07"), [
      rule({ activeFrom: "2026-10-01" }),
    ]);
    expect(effects.changes.categoryId).toBeUndefined();
    expect(effects.trace).toEqual([
      expect.objectContaining({
        ruleId: "r1",
        matched: false,
        skippedRule: "outside_active_window",
        applied: [],
        stopped: false,
      }),
    ]);
  });

  it.each(["2026-10-01", "2026-10-15", "2026-10-31"])(
    "evaluates a row dated %s, the boundary days included",
    (date) => {
      const effects = planRuleEffects(facts(date), [rule(WINDOW)]);
      expect(effects.changes.categoryId).toBe(CAT);
      expect(effects.trace[0].matched).toBe(true);
      expect(effects.trace[0].skippedRule).toBeUndefined();
    },
  );

  it("skips a row dated after activeTo", () => {
    const effects = planRuleEffects(facts("2026-11-01"), [rule(WINDOW)]);
    expect(effects.changes.categoryId).toBeUndefined();
    expect(effects.trace[0].skippedRule).toBe("outside_active_window");
  });

  it("takes an open side as unbounded", () => {
    expect(
      planRuleEffects(facts("2099-01-01"), [rule({ activeFrom: "2026-10-01" })])
        .changes.categoryId,
    ).toBe(CAT);
    expect(
      planRuleEffects(facts("1999-01-01"), [rule({ activeTo: "2026-10-31" })])
        .changes.categoryId,
    ).toBe(CAT);
    expect(
      planRuleEffects(facts("2026-11-01"), [
        rule({ activeFrom: null, activeTo: "2026-10-31" }),
      ]).trace[0].skippedRule,
    ).toBe("outside_active_window");
  });

  it.each([null, "2026-02-31", ""])(
    "skips a row whose date is unknown (%p) when the rule has a window",
    (date) => {
      for (const window of [
        { activeFrom: "2026-10-01" },
        { activeTo: "2026-10-31" },
        WINDOW,
      ]) {
        const effects = planRuleEffects(facts(date), [rule(window)]);
        expect(effects.changes.categoryId).toBeUndefined();
        expect(effects.trace[0].skippedRule).toBe("outside_active_window");
      }
    },
  );

  it("evaluates a rule without a window for any row, an unknown date included", () => {
    for (const date of [null, "2026-09-07", "2026-10-05"]) {
      expect(planRuleEffects(facts(date), [rule()]).changes.categoryId).toBe(
        CAT,
      );
      expect(
        planRuleEffects(facts(date), [
          rule({ activeFrom: null, activeTo: null }),
        ]).changes.categoryId,
      ).toBe(CAT);
    }
  });

  it("decides before the condition: an outside rule neither matches nor stops the pass", () => {
    const outside = rule({
      id: "outside",
      activeFrom: "2026-10-01",
      stopProcessing: true,
    });
    const inside = rule({ id: "inside" });
    const effects = planRuleEffects(facts("2026-09-07"), [outside, inside]);
    expect(effects.trace.map((t) => [t.ruleId, t.matched, t.stopped])).toEqual([
      ["outside", false, false],
      ["inside", true, false],
    ]);
    expect(effects.changes.categoryId).toBe(CAT);
  });

  it("does not collect an AI review request from a rule outside its window", () => {
    const effects = planRuleEffects(facts("2026-09-07"), [
      rule({
        activeFrom: "2026-10-01",
        actions: [{ type: "request_ai_review", instruction: "look" }],
      }),
    ]);
    expect(effects.aiReviewRequests).toEqual([]);
  });

  it("still reports a disabled or invalid rule as such", () => {
    expect(
      planRuleEffects(facts("2026-09-07"), [
        rule({ enabled: false, activeFrom: "2026-10-01" }),
      ]).trace[0].skippedRule,
    ).toBe("disabled");
    expect(
      planRuleEffects(facts("2026-09-07"), [
        rule({ actions: [], activeFrom: "2026-10-01" }),
      ]).trace[0].skippedRule,
    ).toBe("invalid");
  });
});
