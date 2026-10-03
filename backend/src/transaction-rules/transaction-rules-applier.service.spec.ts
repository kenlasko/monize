import { Account } from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { Tag } from "../tags/entities/tag.entity";
import { TransactionTag } from "../tags/entities/transaction-tag.entity";
import {
  AiReviewEnqueueInput,
  AiReviewEnqueueResult,
  AiReviewRequestsService,
} from "../ai-review/ai-review-requests.service";
import { PayeesService } from "../payees/payees.service";
import { TagsService } from "../tags/tags.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { RuleAction } from "./rule-action.types";
import { RuleConditionNode } from "./rule-condition.types";
import { TransactionRuleApplication } from "./transaction-rule-application.entity";
import { TransactionRule } from "./transaction-rule.entity";
import { TransactionRulesApplierService } from "./transaction-rules-applier.service";

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER = "user-1";
const ACCOUNT = uuid(1);
const PAYEE = uuid(2);
const PAYEE2 = uuid(9);
const CAT = uuid(3);
const PARENT = uuid(4);
const TAG_A = uuid(5);
const TAG_B = uuid(6);
const RULE_1 = uuid(11);
const RULE_2 = uuid(12);
const TX = uuid(21);

function rule(
  id: string,
  actions: RuleAction[],
  over: Partial<TransactionRule> = {},
  condition: RuleConditionNode = { all: [] },
): TransactionRule {
  return {
    id,
    userId: USER,
    name: `rule ${id.slice(-2)}`,
    enabled: true,
    position: 0,
    triggers: ["create", "import"],
    condition,
    actions,
    stopProcessing: false,
    revision: 1,
    ...over,
  } as TransactionRule;
}

function row(over: Partial<Transaction> = {}): Transaction {
  return {
    id: TX,
    userId: USER,
    accountId: ACCOUNT,
    currencyCode: "PLN",
    amount: "-50.0000",
    isTransfer: false,
    linkedTransactionId: null,
    payeeId: null,
    payeeName: null,
    categoryId: null,
    description: "milk",
    isSplit: false,
    ...over,
  } as Transaction;
}

interface Fixture {
  rules?: TransactionRule[];
  rows?: Transaction[];
  links?: Array<{ transactionId: string; tagId: string }>;
  categories?: Array<{ id: string; parentId: string | null }>;
  /** ids that exist for the user across the referenced tables */
  known?: string[];
  partner?: Transaction | null;
}

function harness(fx: Fixture = {}) {
  const known = new Set(
    fx.known ?? [ACCOUNT, PAYEE, CAT, PARENT, TAG_A, TAG_B],
  );
  const referenceFind = jest.fn(
    async (opts: { where: { id: { value: string[] } } }) =>
      opts.where.id.value.filter((id) => known.has(id)).map((id) => ({ id })),
  );
  const ruleRepo = { find: jest.fn().mockResolvedValue(fx.rules ?? []) };
  const categoryRepo = {
    find: jest.fn(async (opts: { select?: unknown }) =>
      opts.select
        ? (fx.categories ?? [
            { id: CAT, parentId: PARENT },
            { id: PARENT, parentId: null },
          ])
        : referenceFind(opts as never),
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
    find: jest.fn(async (entity: unknown, _opts?: unknown) => {
      if (entity === Transaction) return fx.rows ?? [];
      if (entity === TransactionTag) return fx.links ?? [];
      if (entity === Payee) return [{ id: PAYEE, name: "Biedronka" }];
      if (entity === Category) return [{ id: CAT, name: "Groceries" }];
      if (entity === Tag) return [{ id: TAG_A, name: "food" }];
      return [];
    }),
    findOne: jest.fn(async (entity: unknown) => {
      if (entity === Payee) return { id: PAYEE, name: "Biedronka" };
      if (entity === Transaction) return fx.partner ?? null;
      return null;
    }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    insert: jest.fn().mockResolvedValue({}),
  };
  const tags = {
    addTransactionTags: jest.fn().mockResolvedValue(undefined),
    removeTransactionTags: jest.fn().mockResolvedValue(undefined),
  };
  const enqueue = jest.fn(
    async (
      _m: unknown,
      _userId: string,
      requests: readonly AiReviewEnqueueInput[],
    ): Promise<AiReviewEnqueueResult> => ({
      queued: requests.map(({ transactionId, ruleId }) => ({
        transactionId,
        ruleId,
      })),
      alreadyQueued: [],
    }),
  );
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
    ...tags.addTransactionTags.mock.calls,
    ...tags.removeTransactionTags.mock.calls,
  ];
  return {
    m: m as never,
    mock: m,
    tags,
    service,
    ruleRepo,
    writes,
    enqueue,
    payees,
  };
}

describe("TransactionRulesApplierService.loadRulesFor", () => {
  it("asks for the user's enabled rules for the trigger in position order", async () => {
    const h = harness({ rules: [] });
    await h.service.loadRulesFor(h.m, USER, "import");
    const opts = h.ruleRepo.find.mock.calls[0][0];
    expect(opts.order).toEqual({ position: "ASC" });
    expect(opts.where).toEqual(
      expect.objectContaining({ userId: USER, enabled: true }),
    );
  });

  it("filters out a rule that no longer validates or names a deleted id, keeping the order", async () => {
    const good = rule(RULE_1, [{ type: "add_tags", tagIds: [TAG_A] }]);
    const gone = rule(RULE_2, [{ type: "add_tags", tagIds: [uuid(99)] }]);
    const broken = rule(uuid(13), [], {});
    const h = harness({ rules: [good, gone, broken] });
    const loaded = await h.service.loadRulesFor(h.m, USER, "create");
    expect(loaded.map((r) => r.id)).toEqual([RULE_1]);
  });
});

describe("TransactionRulesApplierService.applyToNew", () => {
  it("with no rules reads nothing else and writes nothing", async () => {
    const h = harness({ rules: [], rows: [row()] });
    const result = await h.service.applyToNew(h.m, USER, [TX], "create");
    expect(result).toEqual([]);
    expect(h.writes()).toEqual([]);
    expect(h.mock.find).not.toHaveBeenCalled();
  });

  it("does nothing for no ids", async () => {
    const h = harness({ rules: [rule(RULE_1, [])] });
    expect(await h.service.applyToNew(h.m, USER, [], "create")).toEqual([]);
    expect(h.ruleRepo.find).not.toHaveBeenCalled();
  });

  it("writes category, payee and tags on the caller's manager and one trace row per changing rule", async () => {
    const r1 = rule(RULE_1, [
      { type: "set_category", categoryId: CAT, onlyIfEmpty: true },
      { type: "set_payee", payeeId: PAYEE, onlyIfEmpty: true },
    ]);
    const r2 = rule(RULE_2, [{ type: "add_tags", tagIds: [TAG_A] }], {
      position: 1,
    });
    const h = harness({ rules: [r1, r2], rows: [row()] });

    const result = await h.service.applyToNew(h.m, USER, [TX], "create");

    // Only category and payee (with its name) are updated; nothing else.
    expect(h.mock.update).toHaveBeenCalledTimes(1);
    expect(h.mock.update).toHaveBeenCalledWith(
      Transaction,
      { id: TX, userId: USER },
      { categoryId: CAT, payeeId: PAYEE, payeeName: "Biedronka" },
    );
    expect(h.tags.addTransactionTags).toHaveBeenCalledWith(
      h.m,
      USER,
      [TX],
      [TAG_A],
    );
    expect(h.tags.removeTransactionTags).not.toHaveBeenCalled();
    expect(h.mock.insert).toHaveBeenCalledTimes(1);
    const [entity, rows] = h.mock.insert.mock.calls[0];
    expect(entity).toBe(TransactionRuleApplication);
    expect(rows).toEqual([
      {
        userId: USER,
        ruleId: RULE_1,
        transactionId: TX,
        source: "create",
        changes: {
          categoryId: { before: null, after: CAT },
          payeeId: { before: null, after: PAYEE },
        },
      },
      {
        userId: USER,
        ruleId: RULE_2,
        transactionId: TX,
        source: "create",
        changes: { tagIds: { before: [], after: [TAG_A] } },
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].transactionId).toBe(TX);
    expect(result[0].effects.changes.categoryId).toBe(CAT);
  });

  it("never updates amount, account, date, status or links", async () => {
    const h = harness({
      rules: [
        rule(RULE_1, [
          { type: "set_category", categoryId: CAT, onlyIfEmpty: false },
        ]),
      ],
      rows: [row()],
    });
    await h.service.applyToNew(h.m, USER, [TX], "create");
    const patch = h.mock.update.mock.calls[0][2];
    expect(Object.keys(patch)).toEqual(["categoryId"]);
  });

  it("writes only category, payee, payee name and description for every ledger action, never amount, account, date, status or links", async () => {
    const h = harness({
      rules: [
        rule(RULE_1, [
          { type: "set_category", categoryId: CAT, onlyIfEmpty: false },
          { type: "set_payee", payeeId: PAYEE, onlyIfEmpty: false },
          {
            type: "set_payee_from_text",
            template: "Biedronka",
            createIfMissing: true,
            onlyIfEmpty: false,
          },
          {
            type: "set_description",
            template: "Groceries: {payeeText}",
            mode: "replace",
            onlyIfEmpty: false,
          },
          { type: "add_tags", tagIds: [TAG_A] },
        ]),
      ],
      rows: [row({ payeeName: "raw text" })],
    });
    h.payees.resolveByName.mockResolvedValue({ id: PAYEE2, name: "Biedronka" });
    await h.service.applyToNew(h.m, USER, [TX], "create");
    const patch = h.mock.update.mock.calls[0][2];
    expect(Object.keys(patch).sort()).toEqual([
      "categoryId",
      "description",
      "payeeId",
      "payeeName",
    ]);
    for (const forbidden of [
      "amount",
      "accountId",
      "transactionDate",
      "status",
      "linkedTransactionId",
      "isTransfer",
      "isSplit",
      "currencyCode",
    ]) {
      expect(patch).not.toHaveProperty(forbidden);
    }
    expect(patch).toMatchObject({
      payeeId: PAYEE2,
      payeeName: "Biedronka",
      description: "Groceries: raw text",
    });
  });

  it("records no trace row for a rule that matched but changed nothing", async () => {
    const h = harness({
      rules: [
        rule(RULE_1, [
          { type: "set_category", categoryId: CAT, onlyIfEmpty: true },
        ]),
      ],
      rows: [row({ categoryId: PARENT })],
    });
    const result = await h.service.applyToNew(h.m, USER, [TX], "create");
    expect(h.writes()).toEqual([]);
    expect(result[0].effects.trace[0].skipped[0].reason).toBe("already_set");
  });

  it("removes tags the row has and reads the row's existing tag links", async () => {
    const h = harness({
      rules: [rule(RULE_1, [{ type: "remove_tags", tagIds: [TAG_A] }])],
      rows: [row()],
      links: [{ transactionId: TX, tagId: TAG_A }],
    });
    await h.service.applyToNew(h.m, USER, [TX], "create");
    expect(h.tags.removeTransactionTags).toHaveBeenCalledWith(
      h.m,
      USER,
      [TX],
      [TAG_A],
    );
  });

  it("hands the rules the raw payee text of the source, falling back to the stored name", async () => {
    const byText = rule(
      RULE_1,
      [{ type: "add_tags", tagIds: [TAG_A] }],
      {},
      { field: "payeeText", op: "contains", value: "raw text" },
    );
    const withHint = harness({ rules: [byText], rows: [row()] });
    await withHint.service.applyToNew(withHint.m, USER, [TX], "import", {
      payeeTextById: new Map([[TX, "the RAW TEXT from file"]]),
    });
    expect(withHint.tags.addTransactionTags).toHaveBeenCalled();

    const fallback = harness({
      rules: [byText],
      rows: [row({ payeeName: "raw text shop" })],
    });
    await fallback.service.applyToNew(fallback.m, USER, [TX], "import");
    expect(fallback.tags.addTransactionTags).toHaveBeenCalled();

    const none = harness({ rules: [byText], rows: [row()] });
    await none.service.applyToNew(none.m, USER, [TX], "import");
    expect(none.tags.addTransactionTags).not.toHaveBeenCalled();
  });

  it("gives a rule the ancestors of the row's category (inSubtree) from one category query", async () => {
    const h = harness({
      rules: [
        rule(
          RULE_1,
          [{ type: "add_tags", tagIds: [TAG_B] }],
          {},
          { field: "categoryId", op: "inSubtree", value: PARENT },
        ),
      ],
      rows: [row({ categoryId: CAT })],
    });
    await h.service.applyToNew(h.m, USER, [TX], "create");
    expect(h.tags.addTransactionTags).toHaveBeenCalled();
  });

  it("queues request_ai_review in the caller's manager and traces it as queued", async () => {
    const h = harness({
      rules: [
        rule(RULE_1, [{ type: "request_ai_review", instruction: "look" }]),
      ],
      rows: [row()],
    });
    const result = await h.service.applyToNew(h.m, USER, [TX], "create");
    expect(result[0].effects.aiReviewRequests).toEqual([
      { ruleId: RULE_1, instruction: "look" },
    ]);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue).toHaveBeenCalledWith(h.m, USER, [
      { transactionId: TX, ruleId: RULE_1, instruction: "look" },
    ]);
    expect(result[0].effects.trace[0].applied).toEqual([
      { type: "request_ai_review", outcome: "queued" },
    ]);
    expect(result[0].effects.trace[0].skipped).toEqual([]);
    expect(h.writes()).toEqual([]);
  });

  it("traces a request the queue already held as already_queued", async () => {
    const h = harness({
      rules: [
        rule(RULE_1, [{ type: "request_ai_review", instruction: "look" }]),
      ],
      rows: [row()],
    });
    h.enqueue.mockResolvedValueOnce({
      queued: [],
      alreadyQueued: [{ transactionId: TX, ruleId: RULE_1 }],
    });
    const result = await h.service.applyToNew(h.m, USER, [TX], "import");
    expect(result[0].effects.trace[0].applied).toEqual([
      { type: "request_ai_review", outcome: "already_queued" },
    ]);
  });

  it("enqueues nothing when no rule asked for a review", async () => {
    const h = harness({
      rules: [rule(RULE_1, [{ type: "add_tags", tagIds: [TAG_A] }])],
      rows: [row()],
    });
    await h.service.applyToNew(h.m, USER, [TX], "create");
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("uses the rules it is given instead of loading them (an import loads once per file)", async () => {
    const h = harness({ rows: [row()] });
    await h.service.applyToNew(h.m, USER, [TX], "import", {
      rules: [rule(RULE_1, [{ type: "add_tags", tagIds: [TAG_A] }])],
    });
    expect(h.ruleRepo.find).not.toHaveBeenCalled();
    expect(h.tags.addTransactionTags).toHaveBeenCalled();
  });

  it("treats a transfer leg whose partner the scope cannot read as cross-owner: set_payee is refused", async () => {
    const h = harness({
      rules: [
        rule(RULE_1, [
          { type: "set_payee", payeeId: PAYEE, onlyIfEmpty: false },
        ]),
      ],
      rows: [row({ isTransfer: true, linkedTransactionId: uuid(77) })],
      partner: null,
    });
    const result = await h.service.applyToNew(h.m, USER, [TX], "create");
    expect(result[0].effects.trace[0].skipped[0].reason).toBe(
      "cross_owner_transfer_leg",
    );
    expect(h.mock.update).not.toHaveBeenCalled();
  });

  it("reads which way a same-owner transfer went from the partner leg", async () => {
    const other = uuid(88);
    const h = harness({
      known: [ACCOUNT, other, TAG_A],
      rules: [
        rule(
          RULE_1,
          [{ type: "add_tags", tagIds: [TAG_A] }],
          {},
          {
            all: [
              { field: "type", op: "eq", value: "TRANSFER" },
              { field: "fromAccountId", op: "eq", value: ACCOUNT },
              { field: "toAccountId", op: "eq", value: other },
            ],
          },
        ),
      ],
      rows: [row({ isTransfer: true, linkedTransactionId: uuid(77) })],
      partner: row({ id: uuid(77), accountId: other, amount: 50 }),
    });
    await h.service.applyToNew(h.m, USER, [TX], "create");
    expect(h.tags.addTransactionTags).toHaveBeenCalled();
  });
});

describe("TransactionRulesApplierService.applyToNewTransfer", () => {
  const OTHER = uuid(88);
  const OWNER_2 = "user-2";
  const FROM_TX = uuid(31);
  const TO_TX = uuid(32);
  const fromLeg = (over: Partial<Transaction> = {}) =>
    row({
      id: FROM_TX,
      isTransfer: true,
      linkedTransactionId: TO_TX,
      amount: -50,
      ...over,
    });
  const toLeg = (over: Partial<Transaction> = {}) =>
    row({
      id: TO_TX,
      accountId: OTHER,
      isTransfer: true,
      linkedTransactionId: FROM_TX,
      amount: 50,
      ...over,
    });
  const sameOwner = {
    fromLegId: FROM_TX,
    toLegId: TO_TX,
    fromOwnerId: USER,
    toOwnerId: USER,
  };

  it("queues one AI review per transfer, on the outgoing leg, and traces both legs as queued", async () => {
    const h = harness({
      known: [ACCOUNT, OTHER],
      rules: [
        rule(RULE_1, [{ type: "request_ai_review", instruction: "look" }]),
      ],
      rows: [fromLeg(), toLeg()],
    });
    const applied = await h.service.applyToNewTransfer(h.m, sameOwner);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue).toHaveBeenCalledWith(h.m, USER, [
      { transactionId: FROM_TX, ruleId: RULE_1, instruction: "look" },
    ]);
    expect(applied).toHaveLength(2);
    for (const { effects } of applied) {
      expect(effects.trace[0].applied).toEqual([
        { type: "request_ai_review", outcome: "queued" },
      ]);
    }
  });

  it("with no rules reads nothing else and writes nothing (neutral)", async () => {
    const h = harness({ rules: [], rows: [fromLeg(), toLeg()] });
    expect(await h.service.applyToNewTransfer(h.m, sameOwner)).toEqual([]);
    expect(h.mock.find).not.toHaveBeenCalled();
    expect(h.writes()).toEqual([]);
  });

  it("evaluates a same-owner transfer once, over the outgoing leg, and mirrors tags and payee onto both legs", async () => {
    const h = harness({
      known: [ACCOUNT, OTHER, PAYEE, TAG_A, TAG_B],
      rules: [
        rule(
          RULE_1,
          [
            { type: "add_tags", tagIds: [TAG_A] },
            { type: "set_payee", payeeId: PAYEE, onlyIfEmpty: false },
          ],
          {},
          {
            all: [
              { field: "type", op: "eq", value: "TRANSFER" },
              { field: "accountId", op: "eq", value: ACCOUNT },
              { field: "fromAccountId", op: "eq", value: ACCOUNT },
              { field: "toAccountId", op: "eq", value: OTHER },
              { field: "amount", op: "lt", value: 0 },
            ],
          },
        ),
      ],
      rows: [fromLeg(), toLeg()],
    });
    const applied = await h.service.applyToNewTransfer(h.m, sameOwner);

    expect(h.ruleRepo.find).toHaveBeenCalledTimes(1);
    expect(applied.map((a) => a.transactionId).sort()).toEqual(
      [FROM_TX, TO_TX].sort(),
    );
    expect(applied[0].effects).toBe(applied[1].effects);
    for (const id of [FROM_TX, TO_TX]) {
      expect(h.tags.addTransactionTags).toHaveBeenCalledWith(
        h.m,
        USER,
        [id],
        [TAG_A],
      );
      expect(h.mock.update).toHaveBeenCalledWith(
        Transaction,
        { id, userId: USER },
        { payeeId: PAYEE, payeeName: "Biedronka" },
      );
    }
    const traced = h.mock.insert.mock.calls.flatMap(([, rows]) =>
      (rows as Array<{ transactionId: string; source: string }>).map(
        (r) => `${r.transactionId}:${r.source}`,
      ),
    );
    expect(traced.sort()).toEqual(
      [`${FROM_TX}:create`, `${TO_TX}:create`].sort(),
    );
  });

  it("removes rule-removed tags from both legs", async () => {
    const h = harness({
      rules: [rule(RULE_1, [{ type: "remove_tags", tagIds: [TAG_A] }])],
      rows: [fromLeg(), toLeg()],
      links: [{ transactionId: FROM_TX, tagId: TAG_A }],
    });
    await h.service.applyToNewTransfer(h.m, sameOwner);
    expect(h.tags.removeTransactionTags).toHaveBeenCalledWith(
      h.m,
      USER,
      [FROM_TX],
      [TAG_A],
    );
    expect(h.tags.removeTransactionTags).toHaveBeenCalledWith(
      h.m,
      USER,
      [TO_TX],
      [TAG_A],
    );
  });

  it("refuses set_category on the legs, traces it as skipped and writes no category", async () => {
    const h = harness({
      rules: [
        rule(RULE_1, [
          { type: "set_category", categoryId: CAT, onlyIfEmpty: false },
          { type: "add_tags", tagIds: [TAG_A] },
        ]),
      ],
      rows: [fromLeg(), toLeg()],
    });
    const applied = await h.service.applyToNewTransfer(h.m, sameOwner);
    expect(applied[0].effects.trace[0].skipped).toEqual([
      { type: "set_category", reason: "row_is_transfer_leg" },
    ]);
    expect(applied[0].effects.changes.categoryId).toBeUndefined();
    expect(h.mock.update).not.toHaveBeenCalled();
    expect(h.tags.addTransactionTags).toHaveBeenCalledTimes(2);
  });

  describe("cross-owner", () => {
    const cross = { ...sameOwner, toOwnerId: OWNER_2 };
    const crossHarness = (setPayee: boolean) => {
      const h = harness({ known: [ACCOUNT, OTHER, PAYEE, TAG_A, TAG_B] });
      const actions: RuleAction[] = [
        { type: "add_tags", tagIds: [TAG_A] },
        ...(setPayee
          ? [{ type: "set_payee", payeeId: PAYEE, onlyIfEmpty: false } as const]
          : []),
      ];
      h.ruleRepo.find.mockImplementation(
        async (opts: { where: { userId: string } }) => [
          rule(opts.where.userId === USER ? RULE_1 : RULE_2, actions, {
            userId: opts.where.userId,
          }),
        ],
      );
      h.mock.find.mockImplementation(
        async (entity: unknown, rawOpts?: unknown) => {
          if (entity !== Transaction) return [];
          const opts = rawOpts as {
            where: { id: { value: string[] }; userId: string };
          };
          const mine = opts.where.userId === USER ? fromLeg() : toLeg();
          return opts.where.id.value.includes(mine.id) ? [mine] : [];
        },
      );
      return h;
    };

    it("runs each owner's rules on that owner's leg only", async () => {
      const h = crossHarness(false);
      const applied = await h.service.applyToNewTransfer(h.m, cross);

      expect(h.ruleRepo.find.mock.calls.map((c) => c[0].where.userId)).toEqual([
        USER,
        OWNER_2,
      ]);
      expect(applied.map((a) => a.transactionId)).toEqual([FROM_TX, TO_TX]);
      expect(h.tags.addTransactionTags).toHaveBeenCalledTimes(2);
      expect(h.tags.addTransactionTags).toHaveBeenCalledWith(
        h.m,
        USER,
        [FROM_TX],
        [TAG_A],
      );
      expect(h.tags.addTransactionTags).toHaveBeenCalledWith(
        h.m,
        OWNER_2,
        [TO_TX],
        [TAG_A],
      );
      // Each read of the rows is scoped to the owner of the requested leg.
      for (const call of h.mock.find.mock.calls.filter(
        ([entity]) => entity === Transaction,
      )) {
        const { id, userId } = (
          call[1] as { where: { id: { value: string[] }; userId: string } }
        ).where;
        expect(id.value).toEqual([userId === USER ? FROM_TX : TO_TX]);
      }
    });

    it("refuses set_payee on a cross-owner leg and never writes the other owner's leg", async () => {
      const h = crossHarness(true);
      const applied = await h.service.applyToNewTransfer(h.m, cross);

      for (const a of applied) {
        expect(a.effects.trace[0].skipped).toEqual([
          { type: "set_payee", reason: "cross_owner_transfer_leg" },
        ]);
      }
      expect(h.mock.update).not.toHaveBeenCalled();
      const written = h.tags.addTransactionTags.mock.calls.map(
        ([, owner, ids]) => `${owner}:${ids.join()}`,
      );
      expect(written.sort()).toEqual(
        [`${USER}:${FROM_TX}`, `${OWNER_2}:${TO_TX}`].sort(),
      );
    });

    it("does not put the other owner's account in the facts", async () => {
      const h = crossHarness(false);
      h.ruleRepo.find.mockImplementation(
        async (opts: { where: { userId: string } }) => [
          rule(
            opts.where.userId === USER ? RULE_1 : RULE_2,
            [{ type: "add_tags", tagIds: [TAG_A] }],
            { userId: opts.where.userId },
            { field: "toAccountId", op: "eq", value: OTHER },
          ),
        ],
      );
      await h.service.applyToNewTransfer(h.m, cross);
      // The from owner cannot see the destination account; the to owner's own
      // leg is the destination, so only that owner's rule matches.
      expect(h.tags.addTransactionTags).toHaveBeenCalledTimes(1);
      expect(h.tags.addTransactionTags).toHaveBeenCalledWith(
        h.m,
        OWNER_2,
        [TO_TX],
        [TAG_A],
      );
    });
  });
});

describe("TransactionRulesApplierService.previewForRow", () => {
  const input = {
    accountId: ACCOUNT,
    currencyCode: "PLN",
    amount: -50,
    isTransfer: false,
    payeeId: null,
    payeeText: "Biedronka",
    categoryId: null,
    description: "milk",
    tagIds: [],
    hasSplits: false,
  };

  it("is null without rules and reads no other table", async () => {
    const h = harness({ rules: [] });
    expect(await h.service.previewForRow(h.m, USER, input)).toBeNull();
    expect(h.mock.find).not.toHaveBeenCalled();
  });

  it("is null when no rule matched", async () => {
    const h = harness({
      rules: [
        rule(
          RULE_1,
          [{ type: "add_tags", tagIds: [TAG_A] }],
          {},
          { field: "payeeText", op: "eq", value: "nobody" },
        ),
      ],
    });
    expect(await h.service.previewForRow(h.m, USER, input)).toBeNull();
  });

  it("returns exactly the plan applyToNew writes for the same facts (I3), with names, and writes nothing", async () => {
    const rules = [
      rule(RULE_1, [
        { type: "set_category", categoryId: CAT, onlyIfEmpty: true },
        { type: "set_payee", payeeId: PAYEE, onlyIfEmpty: true },
        { type: "add_tags", tagIds: [TAG_A] },
      ]),
    ];
    const h = harness({
      rules,
      rows: [row({ description: "milk", payeeName: "Biedronka" })],
    });
    const preview = await h.service.previewForRow(h.m, USER, input);
    expect(h.writes()).toEqual([]);
    const applied = await h.service.applyToNew(h.m, USER, [TX], "create");

    expect(preview).not.toBeNull();
    const { labels, ...plan } = preview!;
    expect(plan).toEqual(applied[0].effects);
    expect(labels.categories).toEqual({ [CAT]: "Groceries" });
    expect(labels.payees).toEqual({ [PAYEE]: "Biedronka" });
    expect(labels.tags).toEqual({ [TAG_A]: "food" });
    expect(labels.rules).toEqual({ [RULE_1]: "rule 11" });
  });
});

describe("the X3 fields (design 10.3) on the write paths", () => {
  // 2026-03-01 is a Sunday.
  const CONDITION_X3: RuleConditionNode = {
    all: [
      { field: "referenceNumber", op: "eq", value: "chk-42" },
      { field: "dayOfMonth", op: "eq", value: 1 },
      { field: "weekday", op: "eq", value: "SUN" },
      { field: "status", op: "eq", value: "CLEARED" },
      { field: "hasAttachment", op: "eq", value: false },
    ],
  };
  const tagRule = (condition: RuleConditionNode) =>
    rule(RULE_1, [{ type: "add_tags", tagIds: [TAG_A] }], {}, condition);
  const stored = (over: Partial<Transaction> = {}) =>
    row({
      referenceNumber: "CHK-42",
      transactionDate: "2026-03-01",
      status: "CLEARED" as Transaction["status"],
      ...over,
    });

  it("create and import: reference, calendar date and status come from the stored row; a new row has no attachment", async () => {
    for (const source of ["create", "import"] as const) {
      const h = harness({
        rules: [tagRule(CONDITION_X3)],
        rows: [stored()],
      });
      await h.service.applyToNew(h.m, USER, [TX], source);
      expect(h.tags.addTransactionTags).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ["another reference", { referenceNumber: "CHK-43" }],
    ["no reference", { referenceNumber: null }],
    ["another day", { transactionDate: "2026-03-02" }],
    ["another status", { status: "VOID" as Transaction["status"] }],
  ])("create: %s does not match", async (_name, over) => {
    const h = harness({
      rules: [tagRule(CONDITION_X3)],
      rows: [stored(over)],
    });
    await h.service.applyToNew(h.m, USER, [TX], "create");
    expect(h.tags.addTransactionTags).not.toHaveBeenCalled();
  });

  it("create: a row that is not stored yet cannot have an attachment (hasAttachment true never matches)", async () => {
    const h = harness({
      rules: [tagRule({ field: "hasAttachment", op: "eq", value: true })],
      rows: [stored()],
    });
    await h.service.applyToNew(h.m, USER, [TX], "create");
    expect(h.tags.addTransactionTags).not.toHaveBeenCalled();
  });

  it("the preview builds the same facts from the row input, and an input that omits them reads them as unknown", async () => {
    const h = harness({ rules: [tagRule(CONDITION_X3)] });
    const input = {
      accountId: ACCOUNT,
      currencyCode: "PLN",
      amount: -50,
      isTransfer: false,
      payeeId: null,
      payeeText: null,
      categoryId: null,
      description: null,
      tagIds: [],
      hasSplits: false,
    };
    const full = await h.service.planForRow(
      h.m,
      USER,
      {
        ...input,
        referenceNumber: "CHK-42",
        transactionDate: "2026-03-01",
        status: "CLEARED",
        hasAttachment: false,
      },
      [tagRule(CONDITION_X3)],
    );
    expect(full.changes.addTagIds).toEqual([TAG_A]);
    const omitted = await h.service.planForRow(h.m, USER, input, [
      tagRule(CONDITION_X3),
    ]);
    expect(omitted.changes.addTagIds).toEqual([]);
    const emptyRef = await h.service.planForRow(h.m, USER, input, [
      tagRule({ field: "referenceNumber", op: "isEmpty" }),
    ]);
    expect(emptyRef.changes.addTagIds).toEqual([TAG_A]);
  });

  describe("transfers", () => {
    const OTHER = uuid(88);
    const FROM_TX = uuid(31);
    const TO_TX = uuid(32);
    const legs = {
      fromLegId: FROM_TX,
      toLegId: TO_TX,
      fromOwnerId: USER,
      toOwnerId: USER,
    };
    const from = (over: Partial<Transaction> = {}) =>
      stored({
        id: FROM_TX,
        isTransfer: true,
        linkedTransactionId: TO_TX,
        amount: -50,
        ...over,
      });
    const to = (over: Partial<Transaction> = {}) =>
      stored({
        id: TO_TX,
        accountId: OTHER,
        isTransfer: true,
        linkedTransactionId: FROM_TX,
        amount: 50,
        referenceNumber: "OTHER-LEG",
        status: "UNRECONCILED" as Transaction["status"],
        ...over,
      });

    it("are evaluated on the outgoing leg's reference, date and status", async () => {
      const h = harness({
        known: [ACCOUNT, OTHER, TAG_A],
        rules: [tagRule(CONDITION_X3)],
        rows: [from(), to()],
      });
      await h.service.applyToNewTransfer(h.m, legs);
      // Written to both legs: the incoming leg's own reference and status are not read.
      expect(h.tags.addTransactionTags).toHaveBeenCalledTimes(2);
    });

    it("do not match on the incoming leg's values", async () => {
      const h = harness({
        known: [ACCOUNT, OTHER, TAG_A],
        rules: [
          tagRule({ field: "referenceNumber", op: "eq", value: "other-leg" }),
        ],
        rows: [from(), to()],
      });
      await h.service.applyToNewTransfer(h.m, legs);
      expect(h.tags.addTransactionTags).not.toHaveBeenCalled();
    });
  });
});

describe("the active window (INV-RULE-004) on the write paths", () => {
  const windowed = rule(
    RULE_1,
    [{ type: "set_category", categoryId: CAT, onlyIfEmpty: true }],
    { activeFrom: "2026-10-01" },
  );
  const preview = (transactionDate: string) => ({
    accountId: ACCOUNT,
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

  it("create and import leave a row dated before activeFrom unchanged and write nothing", async () => {
    const h = harness({
      rules: [windowed],
      rows: [row({ transactionDate: "2026-09-07" })],
    });
    const applied = await h.service.applyToNew(h.m, USER, [TX], "import");
    expect(h.writes()).toEqual([]);
    expect(
      applied.every((a) => a.effects.changes.categoryId === undefined),
    ).toBe(true);
  });

  it("changes a row dated on activeFrom", async () => {
    const h = harness({
      rules: [windowed],
      rows: [row({ transactionDate: "2026-10-01" })],
    });
    await h.service.applyToNew(h.m, USER, [TX], "create");
    expect(h.mock.update).toHaveBeenCalledWith(
      Transaction,
      expect.anything(),
      expect.objectContaining({ categoryId: CAT }),
    );
  });

  it("the card preview and the commit agree for a row outside and a row inside", async () => {
    const h = harness({ rules: [windowed] });
    expect(
      await h.service.previewForRow(h.m, USER, preview("2026-09-07")),
    ).toBeNull();
    expect(
      await h.service.previewForRow(h.m, USER, preview("2026-10-05")),
    ).not.toBeNull();
  });
});
