import { DataSource } from "typeorm";
import { ActionHistoryService } from "../action-history/action-history.service";
import { lockAccountsForBalanceWrite } from "../common/db/locks";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionStatus } from "../transactions/entities/transaction-status.enum";
import { isReconciledLockEnabled } from "../transactions/reconciled-lock.util";
import { RuleAction } from "./rule-action.types";
import { RuleConditionNode } from "./rule-condition.types";
import { RuleEffects } from "./rule-effects";
import { loadAttachmentPresence } from "./rule-facts";
import { CandidateUnit, loadCandidateUnits } from "./rule-run-candidates";
import { loadRuleTargetAccounts } from "./rule-target-accounts";
import { TransactionRule } from "./transaction-rule.entity";
import { toRuleResponses } from "./transaction-rule-view";
import { TransactionRulesApplierService } from "./transaction-rules-applier.service";
import { TransactionRulesRunService } from "./transaction-rules-run.service";
import { TransactionRulesService } from "./transaction-rules.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
jest.mock("../common/db/locks", () => ({
  ...jest.requireActual("../common/db/locks"),
  lockAccountsForBalanceWrite: jest.fn(),
}));
jest.mock("./rule-run-candidates", () => ({
  ...jest.requireActual("./rule-run-candidates"),
  loadCandidateUnits: jest.fn(),
}));
jest.mock("./rule-facts", () => ({
  ...jest.requireActual("./rule-facts"),
  loadAttachmentPresence: jest.fn(),
}));
jest.mock("./rule-target-accounts", () => ({
  loadRuleTargetAccounts: jest.fn(),
}));
jest.mock("./transaction-rule-view", () => ({ toRuleResponses: jest.fn() }));
jest.mock("../transactions/reconciled-lock.util", () => ({
  isReconciledLockEnabled: jest.fn(),
}));

/**
 * The commit of a manual run that restructures a row: what the undo entry
 * records, and that the net-worth recompute waits for the commit
 * (INV-CACHE-001). Anonymized data.
 */
const USER = "user-1";
const RULE_ID = "e0000000-0000-4000-8000-000000000005";
const OWN = "a0000000-0000-4000-8000-000000000001";
const LOAN = "a0000000-0000-4000-8000-000000000002";
const CAT = "c0000000-0000-4000-8000-000000000003";
const OTHER_CAT = "c0000000-0000-4000-8000-000000000004";
const SAVINGS = "a0000000-0000-4000-8000-000000000006";
const COUNTERPART = "d0000000-0000-4000-8000-000000000009";

const CONDITION: RuleConditionNode = {
  field: "payeeText",
  op: "matches",
  value: "PRINCIPAL: {principal} INTEREST: {interest}",
};
const SPLIT: RuleAction[] = [
  {
    type: "split",
    parts: [
      { amount: "{principal}", transferAccountId: LOAN },
      { amount: "{interest}", categoryId: CAT },
    ],
  },
];
const CONVERT: RuleAction[] = [
  { type: "convert_to_transfer", toAccountId: LOAN, clearCategory: true },
];

const storedRule = (actions: RuleAction[]): TransactionRule =>
  ({
    id: RULE_ID,
    userId: USER,
    name: "Loan",
    enabled: true,
    position: 0,
    triggers: ["create"],
    condition: CONDITION,
    actions,
    stopProcessing: false,
    activeFrom: null,
    activeTo: null,
    revision: 1,
  }) as TransactionRule;

const row = (id: string, amount: number, over: Partial<Transaction> = {}) =>
  ({
    id,
    userId: USER,
    accountId: OWN,
    currencyCode: "PLN",
    amount,
    transactionDate: "2020-01-15",
    isTransfer: false,
    linkedTransactionId: null,
    parentTransactionId: null,
    payeeId: null,
    payeeName: "PRINCIPAL: 1200,50 INTEREST: 300,25",
    categoryId: CAT,
    description: null,
    isSplit: false,
    status: TransactionStatus.UNRECONCILED,
    ...over,
  }) as Transaction;

const unit = (r: Transaction): CandidateUnit => ({
  primary: r,
  legs: [r],
  isTransfer: false,
  fromAccountId: null,
  toAccountId: null,
  crossOwnerTransferLeg: false,
});

function setup(units: CandidateUnit[], actions: RuleAction[]) {
  (loadCandidateUnits as jest.Mock).mockResolvedValue({
    units,
    truncated: false,
  });
  (loadRuleTargetAccounts as jest.Mock).mockResolvedValue(
    new Map([
      [LOAN, { currencyCode: "PLN" }],
      [SAVINGS, { currencyCode: "PLN" }],
    ]),
  );
  (toRuleResponses as jest.Mock).mockResolvedValue([
    { invalid: false, invalidReasons: [] },
  ]);
  (isReconciledLockEnabled as jest.Mock).mockResolvedValue(false);
  (loadAttachmentPresence as jest.Mock).mockResolvedValue(new Set<string>());
  const applier = new TransactionRulesApplierService(
    { addTransactionTags: jest.fn() } as never,
    { enqueue: jest.fn() } as never,
    { resolveByName: jest.fn(), findOrCreate: jest.fn() } as never,
    {} as never,
    {} as never,
  );
  jest
    .spyOn(applier, "loadTagIds")
    .mockResolvedValue(new Map<string, string[]>());
  jest.spyOn(applier, "chainsFor").mockResolvedValue(new Map());
  jest.spyOn(applier, "labelsFor").mockResolvedValue({
    accounts: {},
    categories: {},
    payees: {},
    tags: {},
    rules: {},
  });
  const order: string[] = [];
  (lockAccountsForBalanceWrite as jest.Mock).mockImplementation(async () => {
    order.push("lock");
  });
  const writeEffects = jest
    .spyOn(applier, "writeEffects")
    .mockImplementation(async (_m, _u, _id, effects, _s, affected) => {
      order.push("write");
      const structure = effects.changes.structure;
      if (!structure) return effects;
      affected?.add(LOAN);
      // What the real write returns: the plan plus the counterpart ids.
      const written = { ...structure, counterpartIds: [COUNTERPART] };
      return {
        ...effects,
        changes: { ...effects.changes, structure: written },
      } as RuleEffects;
    });
  const record = jest.fn().mockImplementation(async () => {
    order.push("record");
    return { id: "hist-1" };
  });
  const triggerDebouncedRecalc = jest.fn().mockImplementation(() => {
    order.push("recalc");
  });
  const { dataSource } = createScopedDbMocks([]);
  const service = new TransactionRulesRunService(
    dataSource as unknown as DataSource,
    {
      getOwnedRule: jest.fn().mockResolvedValue(storedRule(actions)),
    } as unknown as TransactionRulesService,
    applier,
    { record } as unknown as ActionHistoryService,
    { triggerDebouncedRecalc } as never,
  );
  return { service, writeEffects, record, triggerDebouncedRecalc, order };
}

describe("TransactionRulesRunService: committing a structural run", () => {
  beforeEach(() => jest.clearAllMocks());

  it("recalculates the accounts the write moved, once each, after the write", async () => {
    const { service, triggerDebouncedRecalc, order } = setup(
      [unit(row("a", -1500.75)), unit(row("b", -1500.75))],
      SPLIT,
    );
    const preview = await service.previewRun(USER, RULE_ID, {});
    await service.run(USER, RULE_ID, { fingerprint: preview.fingerprint });

    expect(triggerDebouncedRecalc).toHaveBeenCalledTimes(1);
    expect(triggerDebouncedRecalc).toHaveBeenCalledWith(LOAN, USER);
    expect(order.indexOf("recalc")).toBeGreaterThan(order.lastIndexOf("write"));
  });

  it("locks every account the writes will credit, in one call, after the plan and before the first write", async () => {
    const twoTargets: RuleAction[] = [
      {
        type: "split",
        parts: [
          { amount: "{principal}", transferAccountId: LOAN },
          { amount: "{interest}", transferAccountId: SAVINGS },
        ],
      },
    ];
    const { service, order } = setup(
      [unit(row("a", -1500.75)), unit(row("b", -1500.75))],
      twoTargets,
    );
    const preview = await service.previewRun(USER, RULE_ID, {});
    await service.run(USER, RULE_ID, { fingerprint: preview.fingerprint });

    // One statement for the whole run, over both rows' targets (the helper
    // sorts and dedups: ascending id, `common/db/locks.ts`), never one lock
    // per row as each write went.
    expect(lockAccountsForBalanceWrite).toHaveBeenCalledTimes(1);
    const [, ids, userId] = (lockAccountsForBalanceWrite as jest.Mock).mock
      .calls[0];
    expect([...new Set(ids)].sort()).toEqual([LOAN, SAVINGS].sort());
    expect(userId).toBe(USER);
    expect(order[0]).toBe("lock");
    expect(order.indexOf("lock")).toBeLessThan(order.indexOf("write"));
  });

  it("takes no account lock for a run that restructures nothing", async () => {
    const { service } = setup(
      [unit(row("a", -100, { payeeName: "PRINCIPAL: 1 INTEREST: 2" }))],
      [{ type: "set_category", categoryId: OTHER_CAT, onlyIfEmpty: false }],
    );
    const preview = await service.previewRun(USER, RULE_ID, {});
    await service.run(USER, RULE_ID, { fingerprint: preview.fingerprint });
    expect(
      (lockAccountsForBalanceWrite as jest.Mock).mock.calls.every(
        ([, ids]: [unknown, string[]]) => ids.length === 0,
      ),
    ).toBe(true);
  });

  it("refuses with PREVIEW_CHANGED when a converted row's amount changed since the preview", async () => {
    const converted = row("a", -640.15);
    const { service, writeEffects } = setup([unit(converted)], CONVERT);
    const preview = await service.previewRun(USER, RULE_ID, {});
    // Another tab edits the amount between the preview and the commit.
    (converted as { amount: number }).amount = -650;
    await expect(
      service.run(USER, RULE_ID, { fingerprint: preview.fingerprint }),
    ).rejects.toMatchObject({ response: { errorCode: "PREVIEW_CHANGED" } });
    expect(writeEffects).not.toHaveBeenCalled();
  });

  it("dispatches nothing when the write is refused before it (stale preview)", async () => {
    const { service, triggerDebouncedRecalc, writeEffects } = setup(
      [unit(row("a", -1500.75))],
      SPLIT,
    );
    await expect(
      service.run(USER, RULE_ID, { fingerprint: "stale" }),
    ).rejects.toMatchObject({ response: { errorCode: "PREVIEW_CHANGED" } });
    expect(writeEffects).not.toHaveBeenCalled();
    expect(triggerDebouncedRecalc).not.toHaveBeenCalled();
  });

  it("dispatches nothing for a run that moves no balance", async () => {
    const { service, triggerDebouncedRecalc } = setup(
      [unit(row("a", -100, { payeeName: "PRINCIPAL: 1 INTEREST: 2" }))],
      [{ type: "set_category", categoryId: OTHER_CAT, onlyIfEmpty: false }],
    );
    const preview = await service.previewRun(USER, RULE_ID, {});
    await service.run(USER, RULE_ID, { fingerprint: preview.fingerprint });
    expect(triggerDebouncedRecalc).not.toHaveBeenCalled();
  });

  it("records the kind, the counterpart ids and the structural fields of a conversion", async () => {
    const { service, record } = setup([unit(row("a", -640.15))], CONVERT);
    const preview = await service.previewRun(USER, RULE_ID, {});
    await service.run(USER, RULE_ID, { fingerprint: preview.fingerprint });

    const entry = record.mock.calls[0][1];
    expect(entry.beforeData.transactions).toEqual([
      {
        id: "a",
        categoryId: CAT,
        isTransfer: false,
        isSplit: false,
        linkedTransactionId: null,
        structure: { kind: "transfer", counterpartIds: [COUNTERPART] },
      },
    ]);
    expect(entry.afterData.transactions).toEqual([
      {
        id: "a",
        categoryId: null,
        isTransfer: true,
        isSplit: false,
        linkedTransactionId: COUNTERPART,
        structure: { kind: "transfer", counterpartIds: [COUNTERPART] },
      },
    ]);
  });

  it("records a split's kind and counterpart ids with the category it clears", async () => {
    const { service, record } = setup([unit(row("a", -1500.75))], SPLIT);
    const preview = await service.previewRun(USER, RULE_ID, {});
    await service.run(USER, RULE_ID, { fingerprint: preview.fingerprint });

    const [before] = record.mock.calls[0][1].beforeData.transactions;
    const [after] = record.mock.calls[0][1].afterData.transactions;
    expect(before).toMatchObject({
      id: "a",
      categoryId: CAT,
      isSplit: false,
      structure: { kind: "split", counterpartIds: [COUNTERPART] },
    });
    expect(after).toMatchObject({
      categoryId: null,
      isSplit: true,
      isTransfer: false,
      linkedTransactionId: null,
    });
  });

  const MANY = 1500;
  const manyRows = () =>
    Array.from({ length: MANY }, (_v, i) =>
      unit(row(`row-${i}-${"x".repeat(30)}`, -640.15)),
    );

  it("counts the structural data against the undo entry's size limit", async () => {
    // Each row carries its structure and counterpart ids on both sides, so
    // this many conversions no longer fit the undo entry...
    const { service, writeEffects } = setup(manyRows(), CONVERT);
    const preview = await service.previewRun(USER, RULE_ID, {});
    await expect(
      service.run(USER, RULE_ID, { fingerprint: preview.fingerprint }),
    ).rejects.toMatchObject({ response: { errorCode: "RUN_TOO_LARGE" } });
    expect(writeEffects).not.toHaveBeenCalled();
  });

  it("...while the same number of plain field changes fits", async () => {
    const { service, writeEffects } = setup(manyRows(), [
      { type: "set_category", categoryId: OTHER_CAT, onlyIfEmpty: false },
    ]);
    const preview = await service.previewRun(USER, RULE_ID, {});
    const result = await service.run(USER, RULE_ID, {
      fingerprint: preview.fingerprint,
    });
    expect(result.changed).toBe(MANY);
    expect(writeEffects).toHaveBeenCalledTimes(MANY);
  });
});
