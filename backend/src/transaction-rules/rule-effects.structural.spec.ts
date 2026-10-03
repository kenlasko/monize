import { RuleAction } from "./rule-action.types";
import { RuleConditionNode } from "./rule-condition.types";
import {
  PlannableRule,
  RulePlanContext,
  planRuleEffects,
} from "./rule-effects";
import { RuleFactsInput, buildRuleFacts } from "./rule-facts";

/**
 * Structural actions in the pure planner (spec section 4): the refusals in
 * their order, the planned structure, and what a later rule sees afterwards.
 */
const OWN = "00000000-0000-4000-8000-000000000001";
const LOAN = "00000000-0000-4000-8000-000000000002";
const SAVINGS = "00000000-0000-4000-8000-000000000003";
const EUR_ACCOUNT = "00000000-0000-4000-8000-000000000004";
const CAT = "00000000-0000-4000-8000-0000000000c1";
const CAT_INTEREST = "00000000-0000-4000-8000-0000000000c2";
const PAYEE = "00000000-0000-4000-8000-0000000000b1";
const TAG = "00000000-0000-4000-8000-0000000000d1";
const PAYEE_PART = "00000000-0000-4000-8000-0000000000b2";

const ACCOUNTS: RulePlanContext["accounts"] = new Map([
  [LOAN, { currencyCode: "PLN" }],
  [SAVINGS, { currencyCode: "PLN" }],
  [EUR_ACCOUNT, { currencyCode: "EUR" }],
  [OWN, { currencyCode: "PLN" }],
]);

const row = (over: Partial<RuleFactsInput> = {}) =>
  buildRuleFacts({
    accountId: OWN,
    currencyCode: "PLN",
    amount: -1500.75,
    isTransfer: false,
    payeeId: null,
    payeeText: "PRINCIPAL: 1200,50 INTEREST: 300,25 REF",
    categoryId: null,
    description: null,
    tagIds: [],
    hasSplits: false,
    transactionDate: "2026-10-05",
    status: "UNRECONCILED",
    ...over,
  });

const MATCHES: RuleConditionNode = {
  all: [
    {
      field: "payeeText",
      op: "matches",
      value: "PRINCIPAL: {principal} INTEREST: {interest} *",
    },
  ],
};

const rule = (
  actions: RuleAction[],
  over: Partial<PlannableRule> = {},
): PlannableRule => ({
  id: "r1",
  enabled: true,
  stopProcessing: false,
  condition: MATCHES,
  actions,
  ...over,
});

/** `from` names the source account instead of the default target (an income). */
const convert = (
  over: Record<string, unknown> = {},
  from?: string,
): RuleAction =>
  ({
    type: "convert_to_transfer",
    ...(from === undefined ? { toAccountId: LOAN } : { fromAccountId: from }),
    clearCategory: true,
    ...over,
  }) as RuleAction;

const split = (
  parts: Array<Record<string, unknown>>,
  over: Record<string, unknown> = {},
): RuleAction => ({ type: "split", parts, ...over }) as unknown as RuleAction;

const SPLIT_PARTS = [
  { amount: "{principal}", transferAccountId: LOAN, payeeId: PAYEE_PART },
  { amount: "{interest}", categoryId: CAT_INTEREST },
];

const plan = (
  actions: RuleAction[],
  input: Partial<RuleFactsInput> = {},
  context: RulePlanContext = { accounts: ACCOUNTS },
) => planRuleEffects(row(input), [rule(actions)], context);

const skippedReasons = (effects: ReturnType<typeof plan>): string[] =>
  effects.trace.flatMap((t) => t.skipped.map((s) => s.reason));

describe("planRuleEffects: convert_to_transfer", () => {
  it("plans a transfer to the target for an expense and clears the category", () => {
    const effects = plan([convert({ payeeId: PAYEE })], {
      amount: -640.15,
      categoryId: CAT,
    });
    expect(effects.changes.structure).toEqual({
      kind: "transfer",
      accountId: LOAN,
      clearCategory: true,
      amount: 640.15,
    });
    expect(effects.changes.categoryId).toBeNull();
    expect(effects.changes.payeeId).toBe(PAYEE);
    expect(effects.trace[0].applied).toEqual([{ type: "convert_to_transfer" }]);
    expect(effects.trace[0].changes.structure).toEqual({
      before: null,
      after: {
        kind: "transfer",
        accountId: LOAN,
        clearCategory: true,
        amount: 640.15,
      },
    });
  });

  it("plans the other leg's source for an income with fromAccountId", () => {
    const effects = plan([convert({}, SAVINGS)], { amount: 250 });
    expect(effects.changes.structure).toEqual({
      kind: "transfer",
      accountId: SAVINGS,
      clearCategory: true,
      amount: -250,
    });
  });

  it("keeps the category when clearCategory is false", () => {
    const effects = plan([convert({ clearCategory: false })], {
      amount: -10,
      categoryId: CAT,
    });
    expect(effects.changes.categoryId).toBeUndefined();
    expect(effects.changes.structure).toEqual({
      kind: "transfer",
      accountId: LOAN,
      clearCategory: false,
      amount: 10,
    });
  });

  it("sets the payee like set_payee: a name set earlier by the rule is dropped", () => {
    const effects = plan([convert({ payeeId: PAYEE })], { amount: -10 });
    expect(effects.changes.payeeId).toBe(PAYEE);
    expect(effects.changes.payeeName).toBeUndefined();
    expect(effects.changes.createPayee).toBeUndefined();
  });

  describe("refusals, each a skipped action that changes nothing", () => {
    const cases: Array<
      [string, RuleAction, Partial<RuleFactsInput>, RulePlanContext?]
    > = [
      [
        "row_is_transfer_leg",
        convert(),
        { isTransfer: true, fromAccountId: OWN, toAccountId: SAVINGS },
      ],
      ["row_has_splits", convert(), { hasSplits: true }],
      ["row_is_void", convert(), { status: "VOID" }],
      ["zero_amount", convert(), { amount: 0 }],
      ["transfer_direction_mismatch", convert(), { amount: 250 }],
      ["transfer_direction_mismatch", convert({}, LOAN), { amount: -250 }],
      ["transfer_same_account", convert({ toAccountId: OWN }), {}],
      ["transfer_account_unavailable", convert(), {}, { accounts: new Map() }],
      ["transfer_account_unavailable", convert(), {}, {}],
      ["transfer_currency_mismatch", convert({ toAccountId: EUR_ACCOUNT }), {}],
    ];
    it.each(cases)(
      "%s",
      (reason, action, input, context = { accounts: ACCOUNTS }) => {
        const effects = plan(
          [action, { type: "set_payee", payeeId: PAYEE, onlyIfEmpty: true }],
          { amount: -100, ...input },
          context,
        );
        expect(skippedReasons(effects)).toContain(reason);
        expect(effects.changes.structure).toBeUndefined();
        expect(effects.trace[0].changes.structure).toBeUndefined();
        expect(effects.trace[0].skipped[0]).toEqual({
          type: "convert_to_transfer",
          reason,
        });
      },
    );
  });

  it("applies the rest of the rule when the structural action is refused, but not its own payee", () => {
    const effects = plan(
      [
        convert({ payeeId: PAYEE, toAccountId: OWN }),
        { type: "add_tags", tagIds: [TAG] } as RuleAction,
      ],
      { amount: -100 },
    );
    expect(effects.changes.payeeId).toBeUndefined();
    expect(effects.changes.addTagIds).toEqual([TAG]);
    expect(skippedReasons(effects)).toEqual(["transfer_same_account"]);
  });

  it("checks the refusals in the order of the spec", () => {
    // A VOID transfer leg is a transfer leg first; a zero VOID row is void first.
    expect(
      skippedReasons(
        plan([convert()], {
          isTransfer: true,
          status: "VOID",
          amount: 0,
          fromAccountId: OWN,
          toAccountId: SAVINGS,
        }),
      ),
    ).toEqual(["row_is_transfer_leg"]);
    expect(
      skippedReasons(plan([convert()], { status: "VOID", amount: 0 })),
    ).toEqual(["row_is_void"]);
    expect(
      skippedReasons(plan([convert({ toAccountId: OWN })], { amount: 250 })),
    ).toEqual(["transfer_direction_mismatch"]);
    expect(
      skippedReasons(
        plan(
          [convert({ toAccountId: EUR_ACCOUNT })],
          {},
          { accounts: new Map() },
        ),
      ),
    ).toEqual(["transfer_account_unavailable"]);
  });
});

describe("planRuleEffects: a later rule sees the structured row", () => {
  const later = (actions: RuleAction[]): PlannableRule => ({
    id: "r2",
    enabled: true,
    stopProcessing: false,
    condition: { all: [] },
    actions,
  });

  it("refuses set_category after a conversion in the same pass", () => {
    const effects = planRuleEffects(
      row({ amount: -640.15 }),
      [
        rule([convert()]),
        later([{ type: "set_category", categoryId: CAT, onlyIfEmpty: false }]),
      ],
      { accounts: ACCOUNTS },
    );
    expect(effects.trace[1].skipped).toEqual([
      { type: "set_category", reason: "row_is_transfer_leg" },
    ]);
    expect(effects.changes.categoryId).toBeUndefined();
  });

  it("refuses a second structural action after a conversion", () => {
    const effects = planRuleEffects(
      row({ amount: -640.15 }),
      [rule([convert()]), later([convert({ toAccountId: SAVINGS })])],
      { accounts: ACCOUNTS },
    );
    expect(effects.trace[1].skipped).toEqual([
      { type: "convert_to_transfer", reason: "row_is_transfer_leg" },
    ]);
    expect(effects.changes.structure).toEqual({
      kind: "transfer",
      accountId: LOAN,
      clearCategory: true,
      amount: 640.15,
    });
  });

  it("lets a later rule's type condition see TRANSFER", () => {
    const effects = planRuleEffects(
      row({ amount: -640.15 }),
      [
        rule([convert()]),
        {
          ...later([{ type: "add_tags", tagIds: [TAG] } as RuleAction]),
          condition: { all: [{ field: "type", op: "eq", value: "TRANSFER" }] },
        },
      ],
      { accounts: ACCOUNTS },
    );
    expect(effects.trace[1].matched).toBe(true);
  });

  it("refuses set_category and a structural action after a split (hasSplits, category empty)", () => {
    const effects = planRuleEffects(
      row(),
      [
        rule([split(SPLIT_PARTS)]),
        {
          ...later([
            { type: "set_category", categoryId: CAT, onlyIfEmpty: false },
          ]),
          condition: { all: [{ field: "hasSplits", op: "eq", value: true }] },
        },
        {
          ...later([convert()]),
          id: "r3",
          condition: { all: [{ field: "hasSplits", op: "eq", value: true }] },
        },
      ],
      { accounts: ACCOUNTS },
    );
    expect(effects.trace[1].skipped).toEqual([
      { type: "set_category", reason: "row_has_splits" },
    ]);
    expect(effects.trace[2].skipped).toEqual([
      { type: "convert_to_transfer", reason: "row_has_splits" },
    ]);
  });

  it("clears the category chain after a split so inSubtree sees none", () => {
    const effects = planRuleEffects(
      row({ categoryId: CAT, categoryAncestorIds: [CAT] }),
      [
        rule([split(SPLIT_PARTS)]),
        {
          ...later([{ type: "add_tags", tagIds: [TAG] } as RuleAction]),
          condition: { all: [{ field: "categoryId", op: "isEmpty" }] },
        },
      ],
      { accounts: ACCOUNTS },
    );
    expect(effects.changes.categoryId).toBeNull();
    expect(effects.trace[1].matched).toBe(true);
  });
});

describe("planRuleEffects: split", () => {
  it("plans signed parts from the captures, with the transfer part's payee and memo", () => {
    const effects = plan([
      split(
        [{ ...SPLIT_PARTS[0], description: "  principal " }, SPLIT_PARTS[1]],
        { payeeId: PAYEE },
      ),
    ]);
    expect(effects.changes.structure).toEqual({
      kind: "split",
      parts: [
        {
          amount: -1200.5,
          categoryId: null,
          transferAccountId: LOAN,
          payeeId: PAYEE_PART,
          memo: "principal",
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
    expect(effects.changes.payeeId).toBe(PAYEE);
    expect(effects.changes.categoryId).toBeUndefined();
    expect(effects.trace[0].changes.structure?.before).toBeNull();
  });

  it("clears an existing category of the parent", () => {
    const effects = plan([split(SPLIT_PARTS)], { categoryId: CAT });
    expect(effects.changes.categoryId).toBeNull();
  });

  it("gives an income's parts a positive sign", () => {
    const effects = plan([split(SPLIT_PARTS)], {
      amount: 1500.75,
      payeeText: "PRINCIPAL: 1200,50 INTEREST: 300,25 REF",
    });
    expect(
      effects.changes.structure?.kind === "split" &&
        effects.changes.structure.parts.map((p) => p.amount),
    ).toEqual([1200.5, 300.25]);
  });

  it("gives the rest part what the others leave", () => {
    const effects = plan([
      split([
        { amount: "{interest}", categoryId: CAT_INTEREST },
        { amount: "rest", transferAccountId: LOAN },
      ]),
    ]);
    expect(
      effects.changes.structure?.kind === "split" &&
        effects.changes.structure.parts.map((p) => p.amount),
    ).toEqual([-300.25, -1200.5]);
  });

  it("works on scaled integers: no float drift on 0.1 + 0.2 shaped amounts", () => {
    const effects = planRuleEffects(
      row({ amount: -0.3, payeeText: "PRINCIPAL: 0,1 INTEREST: 0,2 REF" }),
      [rule([split(SPLIT_PARTS)])],
      { accounts: ACCOUNTS },
    );
    expect(
      effects.changes.structure?.kind === "split" &&
        effects.changes.structure.parts.map((p) => p.amount),
    ).toEqual([-0.1, -0.2]);
  });

  it("drops a zero part and refuses when fewer than two remain", () => {
    const effects = plan([split(SPLIT_PARTS)], {
      amount: -85.4,
      payeeText: "PRINCIPAL: 0,00 INTEREST: 85,40 REF",
    });
    expect(effects.changes.structure).toBeUndefined();
    expect(skippedReasons(effects)).toEqual(["split_too_few_parts"]);
  });

  it("drops a zero part but keeps a split of three with two non-zero", () => {
    const effects = plan(
      [
        split([
          { amount: "{principal}", transferAccountId: LOAN },
          { amount: "{interest}", categoryId: CAT_INTEREST },
          { amount: "rest", categoryId: CAT },
        ]),
      ],
      { amount: -1500.75 },
    );
    expect(
      effects.changes.structure?.kind === "split" &&
        effects.changes.structure.parts.map(
          (p) => p.categoryId ?? p.transferAccountId,
        ),
    ).toEqual([LOAN, CAT_INTEREST]);
  });

  it("refuses when the parts do not add up", () => {
    const effects = plan([split(SPLIT_PARTS, { payeeId: PAYEE })], {
      amount: -1510.75,
    });
    expect(skippedReasons(effects)).toEqual(["split_sum_mismatch"]);
    expect(effects.changes.structure).toBeUndefined();
    expect(effects.changes.payeeId).toBeUndefined();
  });

  it("refuses when the named parts exceed the amount, with a rest part", () => {
    const effects = plan(
      [split([{ amount: "{principal}" }, { amount: "rest" }])],
      { amount: -1000 },
    );
    expect(skippedReasons(effects)).toEqual(["split_sum_mismatch"]);
  });

  it.each([
    ["a capture that does not parse", "PRINCIPAL: 12 PLN INTEREST: 3,00 REF"],
    ["a negative capture", "PRINCIPAL: -12,00 INTEREST: 3,00 REF"],
  ])("refuses %s as split_amount_unparseable", (_name, payeeText) => {
    const effects = plan([split(SPLIT_PARTS)], { payeeText });
    expect(skippedReasons(effects)).toEqual(["split_amount_unparseable"]);
  });

  it("refuses a capture whose pattern did not take part in the match", () => {
    const effects = planRuleEffects(
      row(),
      [
        rule([split([{ amount: "{other}" }, { amount: "rest" }])], {
          condition: {
            any: [
              MATCHES.all![0],
              { field: "description", op: "matches", value: "{other}*" },
            ],
          } as RuleConditionNode,
        }),
      ],
      { accounts: ACCOUNTS },
    );
    expect(effects.trace[0].matched).toBe(true);
    expect(skippedReasons(effects)).toEqual(["split_amount_unparseable"]);
  });

  describe("transfer part targets", () => {
    const toTarget = (transferAccountId: string) => [
      { amount: "{principal}", transferAccountId },
      { amount: "{interest}", categoryId: CAT_INTEREST },
    ];
    it.each([
      ["transfer_same_account", OWN, ACCOUNTS],
      ["transfer_account_unavailable", LOAN, new Map()],
      ["transfer_currency_mismatch", EUR_ACCOUNT, ACCOUNTS],
    ])("%s", (reason, target, accounts) => {
      const effects = plan([split(toTarget(target))], {}, { accounts });
      expect(skippedReasons(effects)).toEqual([reason]);
      expect(effects.changes.structure).toBeUndefined();
    });
  });

  it.each([
    [
      "row_is_transfer_leg",
      { isTransfer: true, fromAccountId: OWN, toAccountId: SAVINGS },
    ],
    ["row_has_splits", { hasSplits: true }],
    ["row_is_void", { status: "VOID" }],
    ["zero_amount", { amount: 0 }],
  ])("refuses a row that is not splittable: %s", (reason, input) => {
    const effects = plan([split(SPLIT_PARTS)], input);
    expect(skippedReasons(effects)).toEqual([reason]);
  });
});

describe("planRuleEffects: structuralNotAllowed (a joint-account member's create)", () => {
  const MEMBER: RulePlanContext = {
    accounts: ACCOUNTS,
    structuralNotAllowed: true,
  };

  it("skips convert_to_transfer with its own reason and plans no structure", () => {
    const effects = plan(
      [convert({ payeeId: PAYEE })],
      { amount: -640.15 },
      MEMBER,
    );
    expect(skippedReasons(effects)).toEqual([
      "structural_not_allowed_for_actor",
    ]);
    expect(effects.changes.structure).toBeUndefined();
    // A refused action is skipped whole: its payeeId is not applied either.
    expect(effects.changes.payeeId).toBeUndefined();
  });

  it("skips split the same way", () => {
    const effects = plan([split(SPLIT_PARTS)], {}, MEMBER);
    expect(skippedReasons(effects)).toEqual([
      "structural_not_allowed_for_actor",
    ]);
    expect(effects.changes.structure).toBeUndefined();
  });

  it("still applies category, payee and tag actions of the same rule and of later rules", () => {
    const effects = planRuleEffects(
      row({ amount: -640.15 }),
      [
        rule([
          convert(),
          {
            type: "set_payee",
            payeeId: PAYEE,
            onlyIfEmpty: false,
          } as RuleAction,
        ]),
        rule(
          [
            {
              type: "set_category",
              categoryId: CAT,
              onlyIfEmpty: false,
            } as RuleAction,
            { type: "add_tags", tagIds: [TAG] } as RuleAction,
          ],
          { id: "r2" },
        ),
      ],
      MEMBER,
    );
    expect(effects.changes.structure).toBeUndefined();
    expect(effects.changes.payeeId).toBe(PAYEE);
    // The row was never converted, so a later set_category is not refused.
    expect(effects.changes.categoryId).toBe(CAT);
    expect(effects.changes.addTagIds).toEqual([TAG]);
  });

  it("an owner's own create (flag absent) is unchanged", () => {
    const effects = plan([convert()], { amount: -640.15 });
    expect(effects.changes.structure).toMatchObject({ kind: "transfer" });
  });
});
