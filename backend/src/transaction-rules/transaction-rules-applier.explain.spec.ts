jest.mock("./rule-accrual", () => ({
  planRuleAccruals: async () => [],
  ruleAccrualFingerprint: (base: string) => base,
  captureRuleAccrualHistory: async () => undefined,
  assertRuleAccrualWrite: async () => false,
  assertAutomaticRuleSources: async () => undefined,
}));
import { Account } from "../accounts/entities/account.entity";
import { AiReviewRequestsService } from "../ai-review/ai-review-requests.service";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { PayeesService } from "../payees/payees.service";
import { Tag } from "../tags/entities/tag.entity";
import { TagsService } from "../tags/tags.service";
import { evaluateRuleCondition } from "./rule-condition.evaluator";
import { RuleAction } from "./rule-action.types";
import { RuleConditionNode } from "./rule-condition.types";
import { buildRuleFacts } from "./rule-facts";
import { TransactionRule } from "./transaction-rule.entity";
import {
  RuleRowInput,
  TransactionRulesApplierService,
} from "./transaction-rules-applier.service";

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER = "user-1";
const ACCOUNT = uuid(1);
const PAYEE = uuid(2);
const CAT = uuid(3);
const PARENT = uuid(4);
const TAG_A = uuid(5);
const TAG_B = uuid(6);
const RULE_1 = uuid(11);
const RULE_2 = uuid(12);
const RULE_3 = uuid(13);
const RULE_4 = uuid(14);

const INPUT: RuleRowInput = {
  accountId: ACCOUNT,
  currencyCode: "PLN",
  amount: "-50.0000",
  isTransfer: false,
  payeeId: null,
  payeeText: "Sklep Alfa nr 7",
  payeeName: "Sklep Alfa nr 7",
  categoryId: null,
  description: "milk",
  tagIds: [],
  hasSplits: false,
  referenceNumber: "REF-1",
  transactionDate: "2026-03-01",
  status: "CLEARED",
  hasAttachment: false,
};

function rule(
  id: string,
  condition: RuleConditionNode,
  actions: RuleAction[],
  over: Partial<TransactionRule> = {},
): TransactionRule {
  return {
    id,
    userId: USER,
    name: `rule ${id.slice(-2)}`,
    enabled: true,
    position: 0,
    triggers: ["import"],
    condition,
    actions,
    stopProcessing: false,
    revision: 1,
    ...over,
  } as TransactionRule;
}

function harness(rules: TransactionRule[], known?: string[]) {
  const present = new Set(known ?? [ACCOUNT, PAYEE, CAT, PARENT, TAG_A, TAG_B]);
  const referenceFind = jest.fn(
    async (opts: { where: { id: { value: string[] } } }) =>
      opts.where.id.value.filter((id) => present.has(id)).map((id) => ({ id })),
  );
  const ruleRepo = { find: jest.fn().mockResolvedValue(rules) };
  const categories = [
    { id: CAT, name: "Groceries", parentId: PARENT },
    { id: PARENT, name: "Food", parentId: null },
  ];
  const categoryRepo = {
    find: jest.fn(async (opts: { select?: unknown }) =>
      opts.select ? categories : referenceFind(opts as never),
    ),
  };
  const repos = new Map<unknown, unknown>([
    [TransactionRule, ruleRepo],
    [Category, categoryRepo],
    [Account, { find: referenceFind }],
    [Payee, { find: referenceFind }],
    [Tag, { find: referenceFind }],
  ]);
  const m = {
    getRepository: jest.fn((entity: unknown) => repos.get(entity)),
    find: jest.fn(async (entity: unknown) => {
      if (entity === Payee) return [{ id: PAYEE, name: "Biedronka" }];
      if (entity === Category) return [{ id: CAT, name: "Groceries" }];
      if (entity === Tag) return [{ id: TAG_A, name: "food" }];
      if (entity === Account) return [{ id: ACCOUNT, name: "Checking" }];
      return [];
    }),
    findOne: jest.fn(),
    update: jest.fn(),
    insert: jest.fn(),
    save: jest.fn(),
    query: jest.fn(),
    delete: jest.fn(),
  };
  const tags = {
    addTransactionTags: jest.fn(),
    removeTransactionTags: jest.fn(),
  };
  const enqueue = jest.fn();
  const payees = {
    resolveByName: jest.fn().mockResolvedValue(null),
    findOrCreate: jest.fn(),
  };
  const service = new TransactionRulesApplierService(
    tags as unknown as TagsService,
    { enqueue } as unknown as AiReviewRequestsService,
    payees as unknown as PayeesService,
    {} as never,
    {} as never,
  );
  const writes = (): unknown[] => [
    ...m.update.mock.calls,
    ...m.insert.mock.calls,
    ...m.save.mock.calls,
    ...m.query.mock.calls,
    ...m.delete.mock.calls,
    ...tags.addTransactionTags.mock.calls,
    ...tags.removeTransactionTags.mock.calls,
    ...enqueue.mock.calls,
    ...payees.findOrCreate.mock.calls,
  ];
  return { m: m as never, service, ruleRepo, writes, payees };
}

const NAME_MATCH: RuleConditionNode = {
  field: "payeeText",
  op: "matches",
  value: "sklep {shop} nr *",
};

describe("TransactionRulesApplierService.explainRow", () => {
  it("lists every rule of the trigger in position order, with the condition explained and the effects the planner traced", async () => {
    const h = harness([
      rule(
        RULE_1,
        { all: [NAME_MATCH, { field: "amount", op: "lt", value: 0 }] },
        [
          { type: "set_category", categoryId: CAT, onlyIfEmpty: true },
          { type: "add_tags", tagIds: [TAG_A] },
        ],
        { position: 1 },
      ),
      rule(
        RULE_2,
        { field: "description", op: "contains", value: "bread" },
        [{ type: "add_tags", tagIds: [TAG_B] }],
        { position: 2 },
      ),
    ]);

    const explained = await h.service.explainRow(h.m, USER, INPUT, "import");

    expect(explained.rules.map((r) => [r.ruleId, r.position])).toEqual([
      [RULE_1, 1],
      [RULE_2, 2],
    ]);
    const [first, second] = explained.rules;
    expect(first).toMatchObject({
      ruleName: "rule 11",
      enabled: true,
      evaluated: true,
      matched: true,
      stopped: false,
      condition: {
        kind: "all",
        result: true,
        captures: { shop: "Alfa" },
        children: [
          { kind: "leaf", field: "payeeText", result: true },
          {
            kind: "leaf",
            field: "amount",
            operator: "lt",
            expected: 0,
            actual: "-50.0000",
            result: true,
          },
        ],
      },
      effects: {
        ruleId: RULE_1,
        matched: true,
        applied: [{ type: "set_category" }, { type: "add_tags" }],
        skipped: [],
        changes: {
          categoryId: { before: null, after: CAT },
          tagIds: { before: [], after: [TAG_A] },
        },
      },
    });
    expect(second).toMatchObject({
      evaluated: true,
      matched: false,
      condition: {
        kind: "leaf",
        field: "description",
        expected: "bread",
        actual: "milk",
        result: false,
      },
      effects: { matched: false, applied: [], skipped: [], changes: {} },
    });
  });

  it("explains each condition over the row as the rules before it left it", async () => {
    const h = harness([
      rule(RULE_1, { all: [] }, [
        { type: "set_category", categoryId: CAT, onlyIfEmpty: true },
      ]),
      rule(
        RULE_2,
        { field: "categoryId", op: "inSubtree", value: PARENT },
        [{ type: "add_tags", tagIds: [TAG_A] }],
        { position: 1 },
      ),
    ]);

    const explained = await h.service.explainRow(h.m, USER, INPUT, "import");

    expect(explained.rules[1]).toMatchObject({
      matched: true,
      condition: { kind: "leaf", actual: CAT, result: true },
    });
  });

  it("uses planForRow's own effects: the trace equals the writer's plan for the same input", async () => {
    const rules = [
      rule(RULE_1, NAME_MATCH, [
        { type: "set_category", categoryId: CAT, onlyIfEmpty: true },
        { type: "set_payee", payeeId: PAYEE, onlyIfEmpty: true },
        { type: "request_ai_review", instruction: "check it" },
      ]),
      rule(RULE_2, { all: [] }, [{ type: "add_tags", tagIds: [TAG_A] }], {
        position: 1,
      }),
    ];
    const h = harness(rules);

    const planned = await h.service.planForRow(h.m, USER, INPUT, rules);
    const explained = await h.service.explainRow(h.m, USER, INPUT, "import");

    expect(explained.rules.map((r) => r.effects)).toEqual([...planned.trace]);
    for (const entry of explained.rules) {
      expect(entry.matched).toBe(entry.effects?.matched);
      // The explained condition and the planner agree on every rule.
      expect(entry.condition?.result).toBe(entry.matched);
    }
  });

  it("lists a rule after a stop as not evaluated, with no condition and no effects", async () => {
    const h = harness([
      rule(RULE_1, { all: [] }, [{ type: "add_tags", tagIds: [TAG_A] }], {
        stopProcessing: true,
      }),
      rule(RULE_2, { all: [] }, [{ type: "add_tags", tagIds: [TAG_B] }], {
        position: 1,
      }),
    ]);

    const explained = await h.service.explainRow(h.m, USER, INPUT, "import");

    expect(explained.rules[0]).toMatchObject({ matched: true, stopped: true });
    expect(explained.rules[1]).toEqual({
      ruleId: RULE_2,
      ruleName: "rule 12",
      enabled: true,
      position: 1,
      evaluated: false,
      matched: false,
      condition: null,
      effects: null,
      stopped: false,
    });
  });

  it("lists a disabled rule and an invalid one with their reason, and the rules around them are explained as the writer would run them", async () => {
    const h = harness([
      rule(RULE_1, { all: [] }, [{ type: "add_tags", tagIds: [TAG_A] }], {
        enabled: false,
      }),
      // Names a tag that is gone: the writer's loadRulesFor leaves it out.
      rule(RULE_2, { all: [] }, [{ type: "add_tags", tagIds: [uuid(99)] }], {
        position: 1,
      }),
      // A stored definition that no longer validates.
      rule(RULE_3, {} as RuleConditionNode, [], { position: 2 }),
      rule(RULE_4, { all: [] }, [{ type: "add_tags", tagIds: [TAG_B] }], {
        position: 3,
      }),
    ]);

    const explained = await h.service.explainRow(h.m, USER, INPUT, "import");

    expect(
      explained.rules.map((r) => [r.ruleId, r.skippedRule, r.evaluated]),
    ).toEqual([
      [RULE_1, "disabled", false],
      [RULE_2, "invalid", false],
      [RULE_3, "invalid", false],
      [RULE_4, undefined, true],
    ]);
    expect(explained.rules[0]).toMatchObject({
      enabled: false,
      matched: false,
      condition: null,
      effects: null,
    });
    expect(explained.rules[3]).toMatchObject({
      matched: true,
      effects: { changes: { tagIds: { before: [], after: [TAG_B] } } },
    });
  });

  it("asks only for the rules of the trigger, enabled or not", async () => {
    const h = harness([]);
    await h.service.explainRow(h.m, USER, INPUT, "create");
    const opts = h.ruleRepo.find.mock.calls[0][0];
    expect(opts.order).toEqual({ position: "ASC" });
    expect(opts.where.userId).toBe(USER);
    expect(opts.where.enabled).toBeUndefined();
    expect(opts.where.triggers).toBeDefined();
  });

  it("with no rule at all answers an empty list", async () => {
    const h = harness([]);
    const explained = await h.service.explainRow(h.m, USER, INPUT, "import");
    expect(explained.rules).toEqual([]);
  });

  it("names every id the explanation mentions, the qualified category name winning", async () => {
    const h = harness([
      rule(RULE_1, { field: "accountId", op: "eq", value: ACCOUNT }, [
        { type: "set_category", categoryId: CAT, onlyIfEmpty: true },
        { type: "set_payee", payeeId: PAYEE, onlyIfEmpty: true },
        { type: "add_tags", tagIds: [TAG_A] },
      ]),
      rule(
        RULE_2,
        { field: "categoryId", op: "inSubtree", value: PARENT },
        [{ type: "add_tags", tagIds: [TAG_B] }],
        { position: 1 },
      ),
    ]);

    const { labels } = await h.service.explainRow(h.m, USER, INPUT, "import");

    expect(labels.accounts).toEqual({ [ACCOUNT]: "Checking" });
    expect(labels.categories[CAT]).toBe("Food: Groceries");
    expect(labels.categories[PARENT]).toBe("Food");
    expect(labels.payees).toEqual({ [PAYEE]: "Biedronka" });
    expect(labels.tags).toEqual({ [TAG_A]: "food" });
  });

  it("names an account carried only by a structural plan in a trace change, scoped by the user", async () => {
    const SPLIT_ACCOUNT = uuid(7);
    const h = harness([
      rule(RULE_1, { field: "accountId", op: "eq", value: ACCOUNT }, [
        { type: "add_tags", tagIds: [TAG_A] },
      ]),
    ]);
    const realPlan = h.service.planForRow.bind(h.service);
    const planned = jest
      .spyOn(h.service, "planForRow")
      .mockImplementation(async (...args) => {
        const real = await realPlan(...args);
        return {
          ...real,
          trace: real.trace.map((entry) => ({
            ...entry,
            changes: {
              ...entry.changes,
              structure: {
                kind: "split",
                parts: [{ transferAccountId: SPLIT_ACCOUNT }],
              },
            },
          })) as unknown as typeof real.trace,
        };
      });
    jest.spyOn(h.m as never, "find").mockImplementation((async (
      entity: unknown,
      opts: { where: { id: { value: string[] }; userId: string } },
    ) => {
      if (entity !== Account) return [];
      expect(opts.where.userId).toBe(USER);
      return opts.where.id.value.includes(SPLIT_ACCOUNT)
        ? [{ id: SPLIT_ACCOUNT, name: "Savings" }]
        : [];
    }) as never);

    const { labels } = await h.service.explainRow(h.m, USER, INPUT, "import");

    expect(planned).toHaveBeenCalled();
    expect(labels.accounts[SPLIT_ACCOUNT]).toBe("Savings");
  });

  it("is read-only: it writes nothing, queues no review and creates no payee", async () => {
    const h = harness([
      rule(
        RULE_1,
        NAME_MATCH,
        [
          { type: "set_category", categoryId: CAT, onlyIfEmpty: false },
          { type: "add_tags", tagIds: [TAG_A] },
          { type: "request_ai_review", instruction: "check" },
          {
            type: "set_payee_from_text",
            template: "{shop}",
            createIfMissing: true,
            onlyIfEmpty: false,
          },
        ],
        { stopProcessing: true },
      ),
    ]);

    const explained = await h.service.explainRow(h.m, USER, INPUT, "import");

    expect(explained.rules[0].effects?.changes.payeeCreated).toBe(true);
    expect(h.writes()).toEqual([]);
  });

  it("explains a rule's condition against the facts of the final planning pass when a payee lookup re-plans", async () => {
    const h = harness([
      rule(RULE_1, NAME_MATCH, [
        {
          type: "set_payee_from_text",
          template: "{shop}",
          createIfMissing: false,
          onlyIfEmpty: false,
        },
      ]),
      rule(
        RULE_2,
        { field: "payeeId", op: "isEmpty" },
        [{ type: "add_tags", tagIds: [TAG_A] }],
        { position: 1 },
      ),
    ]);
    h.payees.resolveByName.mockResolvedValue({ id: PAYEE, name: "Alfa" });

    const explained = await h.service.explainRow(h.m, USER, INPUT, "import");

    expect(h.payees.resolveByName).toHaveBeenCalled();
    expect(explained.rules[0].effects?.changes.payeeId).toEqual({
      before: null,
      after: PAYEE,
    });
    // The payee the first rule set is what the second rule's condition read.
    expect(explained.rules[1]).toMatchObject({
      matched: false,
      condition: { kind: "leaf", actual: PAYEE, result: false },
    });
  });

  it("agrees with the evaluator on the facts it was handed", async () => {
    const condition: RuleConditionNode = {
      any: [
        { field: "amount", op: "gt", value: 0 },
        { all: [NAME_MATCH], not: true },
      ],
    };
    const h = harness([
      rule(RULE_1, condition, [{ type: "add_tags", tagIds: [TAG_A] }]),
    ]);
    const explained = await h.service.explainRow(h.m, USER, INPUT, "import");
    const facts = buildRuleFacts(INPUT);
    expect(explained.rules[0].condition?.result).toBe(
      evaluateRuleCondition(condition, facts),
    );
  });
});
