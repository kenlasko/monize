import { RuleAction } from "./rule-action.types";
import { RuleConditionNode } from "./rule-condition.types";
import {
  PlannableRule,
  RulePlanContext,
  hasRuleEffects,
  planRuleEffects,
} from "./rule-effects";
import { buildRuleFacts } from "./rule-facts";
import { validateRuleDefinition } from "./rule-validation";

/**
 * The acceptance case of docs/specs/transaction-rules-structural-actions.md
 * section 7, on anonymized data: a loan instalment whose statement line
 * carries the principal and the interest in one text. Three rules in order,
 * all inside the window that starts 2026-10-01, each ending the pass.
 */
const CHECKING = "10000000-0000-4000-8000-000000000001";
const LOAN_ACCOUNT = "10000000-0000-4000-8000-000000000002";
const CAT_INTEREST = "20000000-0000-4000-8000-000000000001";
const PAYEE_REPAYMENT = "30000000-0000-4000-8000-000000000001";
const PAYEE_OVERPAYMENT = "30000000-0000-4000-8000-000000000002";
const LOAN_REFERENCE = "LOAN-0000-EXAMPLE";

const context: RulePlanContext = {
  accounts: new Map([
    [CHECKING, { currencyCode: "PLN" }],
    [LOAN_ACCOUNT, { currencyCode: "PLN" }],
  ]),
};

const loanCondition = (pattern: string): RuleConditionNode => ({
  all: [
    {
      any: [
        { field: "payeeText", op: "contains", value: LOAN_REFERENCE },
        { field: "description", op: "contains", value: LOAN_REFERENCE },
      ],
    },
    { field: "payeeText", op: "matches", value: pattern },
  ],
});

const rule = (
  id: string,
  pattern: string,
  actions: RuleAction[],
): PlannableRule => ({
  id,
  enabled: true,
  stopProcessing: true,
  activeFrom: "2026-10-01",
  condition: loanCondition(pattern),
  actions,
});

const RULES: PlannableRule[] = [
  rule("interest-only", "PRINCIPAL: 0,00 INTEREST: *", [
    { type: "set_category", categoryId: CAT_INTEREST, onlyIfEmpty: false },
    { type: "set_payee", payeeId: PAYEE_REPAYMENT, onlyIfEmpty: false },
  ]),
  rule("principal-only", "PRINCIPAL: * INTEREST: 0,00PENALTY*", [
    {
      type: "convert_to_transfer",
      toAccountId: LOAN_ACCOUNT,
      clearCategory: true,
      payeeId: PAYEE_REPAYMENT,
    },
  ]),
  rule(
    "principal-and-interest",
    "PRINCIPAL: {principal} INTEREST: {interest}PENALTY*",
    [
      {
        type: "split",
        payeeId: PAYEE_REPAYMENT,
        parts: [
          {
            amount: "{principal}",
            transferAccountId: LOAN_ACCOUNT,
            payeeId: PAYEE_OVERPAYMENT,
          },
          { amount: "{interest}", categoryId: CAT_INTEREST },
        ],
      },
    ],
  ),
];

const plan = (payeeText: string, amount: number, transactionDate: string) =>
  planRuleEffects(
    buildRuleFacts({
      accountId: CHECKING,
      currencyCode: "PLN",
      amount,
      isTransfer: false,
      payeeId: null,
      payeeText,
      categoryId: null,
      description: null,
      tagIds: [],
      hasSplits: false,
      transactionDate,
      status: "UNRECONCILED",
    }),
    RULES,
    context,
  );

const INTEREST_ONLY = `PRINCIPAL: 0,00 INTEREST: 85,40PENALTY: 0,00${LOAN_REFERENCE}`;
const PRINCIPAL_ONLY = `PRINCIPAL: 640,15 INTEREST: 0,00PENALTY: 0,00${LOAN_REFERENCE}`;
const BOTH = `PRINCIPAL: 1200,50 INTEREST: 300,25PENALTY: 0,00${LOAN_REFERENCE}`;

describe("structural rules: the loan instalment acceptance case", () => {
  it("accepts all three rules as valid definitions", () => {
    for (const r of RULES) {
      expect(
        validateRuleDefinition(
          { condition: r.condition, actions: r.actions },
          { authoring: true },
        ),
      ).toEqual([]);
    }
  });

  it("an interest-only line gets the category and the payee, and no structure", () => {
    const effects = plan(INTEREST_ONLY, -85.4, "2026-10-05");
    expect(effects.changes).toEqual({
      categoryId: CAT_INTEREST,
      payeeId: PAYEE_REPAYMENT,
      addTagIds: [],
      removeTagIds: [],
    });
    expect(effects.changes.structure).toBeUndefined();
    // The matching rule ends the pass, so the later rules are not traced.
    expect(effects.trace.map((t) => t.matched)).toEqual([true]);
  });

  it("a principal-only line becomes a transfer to the loan account", () => {
    const effects = plan(PRINCIPAL_ONLY, -640.15, "2026-10-05");
    expect(effects.changes.structure).toEqual({
      kind: "transfer",
      accountId: LOAN_ACCOUNT,
      clearCategory: true,
      amount: 640.15,
    });
    expect(effects.changes.payeeId).toBe(PAYEE_REPAYMENT);
    expect(effects.changes.categoryId).toBeUndefined();
    expect(effects.trace.map((t) => t.matched)).toEqual([false, true]);
  });

  it("a principal-and-interest line is split into the transfer and the interest", () => {
    const effects = plan(BOTH, -1500.75, "2026-10-05");
    expect(effects.changes.structure).toEqual({
      kind: "split",
      parts: [
        {
          amount: -1200.5,
          categoryId: null,
          transferAccountId: LOAN_ACCOUNT,
          payeeId: PAYEE_OVERPAYMENT,
          memo: null,
        },
        {
          amount: -300.25,
          categoryId: CAT_INTEREST,
          transferAccountId: null,
          payeeId: null,
          memo: null,
        },
      ],
    });
    expect(effects.changes.payeeId).toBe(PAYEE_REPAYMENT);
    expect(effects.trace.map((t) => t.matched)).toEqual([false, false, true]);
    expect(effects.trace[2].changes.structure?.before).toBeNull();
  });

  it("the same text with an amount that does not add up is refused and changes nothing", () => {
    const effects = plan(BOTH, -1510.75, "2026-10-05");
    expect(effects.trace[2].matched).toBe(true);
    expect(effects.trace[2].skipped).toEqual([
      { type: "split", reason: "split_sum_mismatch" },
    ]);
    expect(effects.changes).toEqual({ addTagIds: [], removeTagIds: [] });
    expect(effects.trace[2].changes).toEqual({});
    // The rule matched, so the plan is not empty, but it writes nothing.
    expect(effects.changes.structure).toBeUndefined();
    expect(effects.changes.payeeId).toBeUndefined();
    expect(hasRuleEffects(effects)).toBe(true);
  });

  it.each([
    ["interest only", INTEREST_ONLY, -85.4],
    ["principal only", PRINCIPAL_ONLY, -640.15],
    ["principal and interest", BOTH, -1500.75],
  ])(
    "%s dated before the window is left alone by every rule",
    (_n, text, amount) => {
      const effects = plan(text, amount, "2026-09-07");
      expect(effects.trace.map((t) => t.skippedRule)).toEqual([
        "outside_active_window",
        "outside_active_window",
        "outside_active_window",
      ]);
      expect(effects.changes).toEqual({ addTagIds: [], removeTagIds: [] });
      expect(effects.aiReviewRequests).toEqual([]);
      expect(hasRuleEffects(effects)).toBe(false);
    },
  );
});
