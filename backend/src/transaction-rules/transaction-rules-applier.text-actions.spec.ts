import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { PayeesService } from "../payees/payees.service";
import { Account } from "../accounts/entities/account.entity";
import { Tag } from "../tags/entities/tag.entity";
import { TransactionTag } from "../tags/entities/transaction-tag.entity";
import { AiReviewRequestsService } from "../ai-review/ai-review-requests.service";
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
const OTHER_ACCOUNT = uuid(2);
const EXISTING = uuid(3);
const CREATED = uuid(4);
const RULE_ID = uuid(11);
const TX = uuid(21);
const TX_2 = uuid(22);

const BANK_TEXT = "Przelew. Nazwa odbiorcy: Jan Kowalski Rachunek odbiorcy: 1";
const CONDITION: RuleConditionNode = {
  all: [
    {
      field: "payeeText",
      op: "matches",
      value: "*Nazwa odbiorcy: {payee} Rachunek*",
    },
  ],
};

const fromText = (over: object = {}): RuleAction =>
  ({
    type: "set_payee_from_text",
    template: "{payee}",
    createIfMissing: false,
    onlyIfEmpty: true,
    ...over,
  }) as RuleAction;
const describeAs = (over: object = {}): RuleAction =>
  ({
    type: "set_description",
    template: "{payee}",
    mode: "replace",
    onlyIfEmpty: false,
    ...over,
  }) as RuleAction;

const rule = (actions: RuleAction[]): TransactionRule =>
  ({
    id: RULE_ID,
    userId: USER,
    name: "Bank transfers",
    enabled: true,
    position: 0,
    triggers: ["create", "import"],
    condition: CONDITION,
    actions,
    stopProcessing: false,
    revision: 1,
  }) as TransactionRule;

const row = (over: Partial<Transaction> = {}): Transaction =>
  ({
    id: TX,
    userId: USER,
    accountId: ACCOUNT,
    currencyCode: "PLN",
    amount: "-50.0000",
    isTransfer: false,
    linkedTransactionId: null,
    payeeId: null,
    payeeName: BANK_TEXT,
    categoryId: null,
    description: "card payment",
    isSplit: false,
    ...over,
  }) as Transaction;

function harness(
  rows: Transaction[],
  rules: TransactionRule[],
  partner: Transaction | null = null,
) {
  const known = new Set([ACCOUNT, OTHER_ACCOUNT]);
  const referenceFind = jest.fn(
    async (opts: { where: { id: { value: string[] } } }) =>
      opts.where.id.value.filter((id) => known.has(id)).map((id) => ({ id })),
  );
  const repos = new Map<unknown, unknown>([
    [TransactionRule, { find: jest.fn().mockResolvedValue(rules) }],
    [Category, { find: jest.fn().mockResolvedValue([]) }],
    [Account, { find: referenceFind }],
    [Payee, { find: referenceFind }],
    [Tag, { find: referenceFind }],
  ]);
  const m = {
    getRepository: jest.fn((entity: unknown) => repos.get(entity)),
    find: jest.fn(async (entity: unknown) => {
      if (entity === Transaction) return rows;
      if (entity === TransactionTag) return [];
      return [];
    }),
    findOne: jest.fn(async (entity: unknown) =>
      entity === Transaction ? partner : null,
    ),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    insert: jest.fn().mockResolvedValue({}),
  };
  const payees = {
    resolveByName: jest.fn().mockResolvedValue(null),
    findOrCreate: jest
      .fn()
      .mockImplementation(async (_u: string, name: string) => ({
        id: CREATED,
        name,
      })),
  };
  const service = new TransactionRulesApplierService(
    {
      addTransactionTags: jest.fn(),
      removeTransactionTags: jest.fn(),
    } as unknown as TagsService,
    { enqueue: jest.fn() } as unknown as AiReviewRequestsService,
    payees as unknown as PayeesService,
    {} as never,
    {} as never,
  );
  return { m: m as never, mock: m, payees, service };
}

const traceRows = (h: ReturnType<typeof harness>) =>
  h.mock.insert.mock.calls.flatMap(
    ([entity, rows]) =>
      (entity === TransactionRuleApplication ? rows : []) as Array<{
        transactionId: string;
        changes: Record<string, unknown>;
      }>,
  );

describe("the text actions in the applier", () => {
  it("resolves the rendered name through the payee service and writes payee and name", async () => {
    const h = harness([row()], [rule([fromText()])]);
    h.payees.resolveByName.mockResolvedValue({
      id: EXISTING,
      name: "Jan Kowalski",
    });

    const [applied] = await h.service.applyToNew(h.m, USER, [TX], "import");

    expect(h.payees.resolveByName).toHaveBeenCalledWith(USER, "Jan Kowalski");
    expect(h.payees.findOrCreate).not.toHaveBeenCalled();
    expect(h.mock.update).toHaveBeenCalledWith(
      Transaction,
      { id: TX, userId: USER },
      { payeeId: EXISTING, payeeName: "Jan Kowalski" },
    );
    expect(traceRows(h)).toEqual([
      {
        userId: USER,
        ruleId: RULE_ID,
        transactionId: TX,
        source: "import",
        changes: {
          payeeId: { before: null, after: EXISTING },
          payeeName: { before: BANK_TEXT, after: "Jan Kowalski" },
        },
      },
    ]);
    expect(applied.effects.changes.payeeId).toBe(EXISTING);
  });

  it("does nothing to the payee when nobody has the name and createIfMissing is off", async () => {
    const h = harness([row()], [rule([fromText()])]);
    await h.service.applyToNew(h.m, USER, [TX], "create");
    expect(h.payees.findOrCreate).not.toHaveBeenCalled();
    expect(h.mock.update).not.toHaveBeenCalled();
    expect(traceRows(h)).toEqual([]);
  });

  it("creates the missing payee through findOrCreate, once, and traces the created id", async () => {
    const h = harness([row()], [rule([fromText({ createIfMissing: true })])]);

    const [applied] = await h.service.applyToNew(h.m, USER, [TX], "create");

    expect(h.payees.findOrCreate).toHaveBeenCalledTimes(1);
    expect(h.payees.findOrCreate).toHaveBeenCalledWith(USER, "Jan Kowalski");
    expect(h.mock.update).toHaveBeenCalledWith(
      Transaction,
      { id: TX, userId: USER },
      { payeeId: CREATED, payeeName: "Jan Kowalski" },
    );
    expect(traceRows(h)[0].changes).toEqual({
      payeeId: { before: null, after: CREATED },
      payeeName: { before: BANK_TEXT, after: "Jan Kowalski" },
      payeeCreated: true,
    });
    expect(applied.effects.changes).toMatchObject({ payeeId: CREATED });
    expect(applied.effects.changes.createPayee).toBeUndefined();
  });

  it("uses a payee that appeared since the plan instead of creating a second one", async () => {
    const h = harness([row()], [rule([fromText({ createIfMissing: true })])]);
    h.payees.resolveByName
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: EXISTING, name: "Jan Kowalski" });

    await h.service.applyToNew(h.m, USER, [TX], "create");

    expect(h.payees.findOrCreate).not.toHaveBeenCalled();
    expect(traceRows(h)[0].changes).toEqual({
      payeeId: { before: null, after: EXISTING },
      payeeName: { before: BANK_TEXT, after: "Jan Kowalski" },
    });
  });

  it("looks a name up once per call and lets a payee created by one row serve the next", async () => {
    const h = harness(
      [row(), row({ id: TX_2 })],
      [rule([fromText({ createIfMissing: true })])],
    );
    h.payees.resolveByName.mockImplementation(async () =>
      h.payees.findOrCreate.mock.calls.length > 0
        ? { id: CREATED, name: "Jan Kowalski" }
        : null,
    );

    await h.service.applyToNew(h.m, USER, [TX, TX_2], "import");

    expect(h.payees.findOrCreate).toHaveBeenCalledTimes(1);
    expect(h.mock.update).toHaveBeenCalledTimes(2);
    for (const call of h.mock.update.mock.calls) {
      expect(call[2]).toEqual({ payeeId: CREATED, payeeName: "Jan Kowalski" });
    }
  });

  it("writes the description and traces before and after", async () => {
    const h = harness(
      [row()],
      [rule([describeAs({ mode: "append", template: " | {payee}" })])],
    );

    await h.service.applyToNew(h.m, USER, [TX], "create");

    expect(h.payees.resolveByName).not.toHaveBeenCalled();
    expect(h.mock.update).toHaveBeenCalledWith(
      Transaction,
      { id: TX, userId: USER },
      { description: "card payment | Jan Kowalski" },
    );
    expect(traceRows(h)[0].changes).toEqual({
      description: {
        before: "card payment",
        after: "card payment | Jan Kowalski",
      },
    });
  });

  it("refuses the payee on the leg of a cross-owner transfer and the description without looking anything up, so the legs never diverge", async () => {
    const h = harness(
      [row({ isTransfer: true, linkedTransactionId: uuid(77) })],
      [rule([fromText({ createIfMissing: true }), describeAs()])],
      null,
    );

    await h.service.applyToNew(h.m, USER, [TX], "create");

    expect(h.payees.resolveByName).not.toHaveBeenCalled();
    expect(h.payees.findOrCreate).not.toHaveBeenCalled();
    expect(h.mock.update).not.toHaveBeenCalled();
  });

  it("creates a payee once for both legs of a same-owner transfer", async () => {
    const from = row({
      id: TX,
      isTransfer: true,
      linkedTransactionId: TX_2,
      amount: -50,
    });
    const to = row({
      id: TX_2,
      accountId: OTHER_ACCOUNT,
      isTransfer: true,
      linkedTransactionId: TX,
      amount: 50,
    });
    const h = harness(
      [from, to],
      [rule([fromText({ createIfMissing: true })])],
    );

    await h.service.applyToNewTransfer(h.m, {
      fromLegId: TX,
      toLegId: TX_2,
      fromOwnerId: USER,
      toOwnerId: USER,
    });

    expect(h.payees.findOrCreate).toHaveBeenCalledTimes(1);
    for (const id of [TX, TX_2]) {
      expect(h.mock.update).toHaveBeenCalledWith(
        Transaction,
        { id, userId: USER },
        { payeeId: CREATED, payeeName: "Jan Kowalski" },
      );
    }
  });

  it("previews without creating anything and says the payee will be created; the commit differs only by that note", async () => {
    const rules = [rule([fromText({ createIfMissing: true }), describeAs()])];
    const h = harness([row()], rules);
    const input = {
      accountId: ACCOUNT,
      currencyCode: "PLN",
      amount: -50,
      isTransfer: false,
      payeeId: null,
      payeeText: BANK_TEXT,
      categoryId: null,
      description: "card payment",
      tagIds: [],
      hasSplits: false,
    };

    const preview = await h.service.previewForRow(h.m, USER, input);

    expect(h.payees.findOrCreate).not.toHaveBeenCalled();
    expect(h.mock.update).not.toHaveBeenCalled();
    expect(h.mock.insert).not.toHaveBeenCalled();
    expect(preview?.changes.createPayee).toBe("Jan Kowalski");
    expect(preview?.trace[0].changes.payeeCreated).toBe(true);
    expect(preview?.trace[0].changes.description?.after).toBe("Jan Kowalski");

    const [applied] = await h.service.applyToNew(h.m, USER, [TX], "create");
    const { createPayee: _planned, ...previewChanges } = preview!.changes;
    const { payeeId, ...committedChanges } = applied.effects.changes;
    expect(payeeId).toBe(CREATED);
    expect(committedChanges).toEqual(previewChanges);
    const previewTrace = preview!.trace[0].changes;
    const committedTrace = applied.effects.trace[0].changes;
    expect(committedTrace.payeeCreated).toBe(true);
    expect({ ...committedTrace, payeeId: undefined }).toEqual({
      ...previewTrace,
      payeeId: undefined,
    });
    expect(committedTrace.payeeId).toEqual({ before: null, after: CREATED });
  });
});
