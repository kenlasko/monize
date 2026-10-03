import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { ActionHistoryService } from "../action-history/action-history.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionStatus } from "../transactions/entities/transaction-status.enum";
import { isReconciledLockEnabled } from "../transactions/reconciled-lock.util";
import { RuleAction } from "./rule-action.types";
import { RuleConditionNode } from "./rule-condition.types";
import { loadAttachmentPresence } from "./rule-facts";
import { CandidateUnit, loadCandidateUnits } from "./rule-run-candidates";
import { TransactionRuleApplication } from "./transaction-rule-application.entity";
import { TransactionRule } from "./transaction-rule.entity";
import { toRuleResponses } from "./transaction-rule-view";
import { TransactionRulesApplierService } from "./transaction-rules-applier.service";
import { TransactionRulesRunService } from "./transaction-rules-run.service";
import { TransactionRulesService } from "./transaction-rules.service";
import { thrown } from "./transaction-rules.test-helpers";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
jest.mock("./rule-run-candidates", () => ({
  ...jest.requireActual("./rule-run-candidates"),
  loadCandidateUnits: jest.fn(),
}));
jest.mock("./rule-facts", () => ({
  ...jest.requireActual("./rule-facts"),
  loadAttachmentPresence: jest.fn(),
}));
jest.mock("./transaction-rule-view", () => ({ toRuleResponses: jest.fn() }));
jest.mock("../transactions/reconciled-lock.util", () => ({
  isReconciledLockEnabled: jest.fn(),
}));

const USER = "user-1";
const RULE_ID = "e0000000-0000-4000-8000-000000000005";
const CAT = "c0000000-0000-4000-8000-000000000003";
const TAG = "d0000000-0000-4000-8000-000000000004";
const PAYEE = "b0000000-0000-4000-8000-000000000002";
const TAG_OLD = "d0000000-0000-4000-8000-000000000006";
const TAG_KEEP = "d0000000-0000-4000-8000-000000000007";

const CONDITION: RuleConditionNode = {
  field: "payeeText",
  op: "contains",
  value: "shop",
};
const ACTIONS: RuleAction[] = [
  { type: "set_category", categoryId: CAT, onlyIfEmpty: true },
  { type: "add_tags", tagIds: [TAG] },
];

const storedRule = (over: Partial<TransactionRule> = {}): TransactionRule =>
  ({
    id: RULE_ID,
    userId: USER,
    name: "Shop",
    enabled: true,
    position: 0,
    triggers: ["create"],
    condition: CONDITION,
    actions: ACTIONS,
    stopProcessing: false,
    revision: 4,
    ...over,
  }) as TransactionRule;

const row = (id: string, over: Partial<Transaction> = {}): Transaction =>
  ({
    id,
    userId: USER,
    accountId: "acc-1",
    currencyCode: "PLN",
    amount: -12.5,
    transactionDate: "2026-03-10",
    isTransfer: false,
    linkedTransactionId: null,
    parentTransactionId: null,
    payeeId: null,
    payeeName: "SHOP 1",
    categoryId: null,
    description: null,
    isSplit: false,
    status: TransactionStatus.UNRECONCILED,
    ...over,
  }) as Transaction;

const plainUnit = (r: Transaction): CandidateUnit => ({
  primary: r,
  legs: [r],
  isTransfer: false,
  fromAccountId: null,
  toAccountId: null,
  crossOwnerTransferLeg: false,
});

function setup(
  units: CandidateUnit[],
  truncated = false,
  stored: TransactionRule = storedRule(),
) {
  (loadCandidateUnits as jest.Mock).mockResolvedValue({ units, truncated });
  (toRuleResponses as jest.Mock).mockResolvedValue([
    { invalid: false, invalidReasons: [] },
  ]);
  (isReconciledLockEnabled as jest.Mock).mockResolvedValue(false);
  (loadAttachmentPresence as jest.Mock).mockResolvedValue(new Set<string>());

  const applierDeps = { addTransactionTags: jest.fn() };
  const enqueue = jest
    .fn()
    .mockResolvedValue({ queued: [], alreadyQueued: [] });
  const payees = {
    resolveByName: jest.fn().mockResolvedValue(null),
    findOrCreate: jest.fn(),
  };
  const applier = new TransactionRulesApplierService(
    applierDeps as never,
    { enqueue } as never,
    payees as never,
    {} as never,
    {} as never,
  );
  const loadTagIds = jest
    .spyOn(applier, "loadTagIds")
    .mockResolvedValue(new Map<string, string[]>());
  jest.spyOn(applier, "chainsFor").mockResolvedValue(new Map());
  jest.spyOn(applier, "labelsFor").mockResolvedValue({
    accounts: {},
    categories: { [CAT]: "Groceries" },
    payees: { [PAYEE]: "Shop payee" },
    tags: {},
    rules: {},
  });
  const writeEffects = jest
    .spyOn(applier, "writeEffects")
    .mockImplementation(async (_m, _u, _id, effects) => effects);

  const rulesService = {
    getOwnedRule: jest.fn().mockResolvedValue(stored),
    checkedDefinition: jest
      .fn()
      .mockImplementation(async (_m, _u, condition, actions) => ({
        condition,
        actions,
      })),
  };
  const record = jest.fn().mockResolvedValue({ id: "hist-1" });
  const { manager, dataSource } = createScopedDbMocks([
    [
      TransactionRuleApplication,
      {
        createQueryBuilder: jest.fn(),
      },
    ],
  ]);
  const service = new TransactionRulesRunService(
    dataSource as unknown as DataSource,
    rulesService as unknown as TransactionRulesService,
    applier,
    { record } as unknown as ActionHistoryService,
    { triggerDebouncedRecalc: jest.fn() } as never,
  );
  return {
    service,
    manager,
    dataSource,
    rulesService,
    writeEffects,
    enqueue,
    record,
    loadTagIds,
    payees,
  };
}

describe("TransactionRulesRunService", () => {
  beforeEach(() => jest.clearAllMocks());

  describe("the X3 fields (design 10.3) on existing rows", () => {
    const NEW_FIELDS: RuleConditionNode = {
      all: [
        { field: "referenceNumber", op: "startsWith", value: "chk" },
        { field: "dayOfMonth", op: "between", value: [28, 31] },
        { field: "weekday", op: "eq", value: "SAT" },
        { field: "status", op: "neq", value: "VOID" },
        { field: "hasAttachment", op: "eq", value: true },
      ],
    };
    // 2026-01-31 is a Saturday.
    const hit = (id: string, over: Partial<Transaction> = {}) =>
      row(id, {
        referenceNumber: "CHK-1",
        transactionDate: "2026-01-31",
        status: TransactionStatus.CLEARED,
        ...over,
      });

    it("reads reference, date, status and attachment presence from the stored rows, presence in one query", async () => {
      const rows = [
        hit("t1"),
        hit("t2"),
        hit("t3", { referenceNumber: null }),
        hit("t4", { transactionDate: "2026-01-30" }),
        hit("t5", { status: TransactionStatus.VOID }),
        hit("t6", { transactionDate: "2026-02-28" }),
      ];
      const { service } = setup(
        rows.map(plainUnit),
        false,
        storedRule({ condition: NEW_FIELDS }),
      );
      (loadAttachmentPresence as jest.Mock).mockResolvedValue(
        new Set(["t1", "t3", "t4", "t5", "t6"]),
      );

      const preview = await service.previewRun(USER, RULE_ID, { limit: 50 });

      expect(loadAttachmentPresence).toHaveBeenCalledTimes(1);
      expect(loadAttachmentPresence).toHaveBeenCalledWith(
        expect.anything(),
        USER,
        ["t1", "t2", "t3", "t4", "t5", "t6"],
      );
      // t2 has no attachment, t3 no reference, t4 is the 30th (a Friday), t5
      // is void; t6 is Saturday 2026-02-28, the 28th, so t1 and t6 pass.
      expect(preview.matched.map((r) => r.transactionId)).toEqual(["t1", "t6"]);
    });

    it("a row without an attachment matches hasAttachment false, and only that", async () => {
      const { service } = setup(
        [plainUnit(hit("t1")), plainUnit(hit("t2"))],
        false,
        storedRule({
          condition: { field: "hasAttachment", op: "eq", value: false },
        }),
      );
      (loadAttachmentPresence as jest.Mock).mockResolvedValue(new Set(["t1"]));
      const preview = await service.previewRun(USER, RULE_ID, {});
      expect(preview.matched.map((r) => r.transactionId)).toEqual(["t2"]);
    });

    it("a transfer is evaluated on its outgoing leg's facts", async () => {
      const out = hit("out", { isTransfer: true, amount: -5 });
      const inn = hit("in", {
        isTransfer: true,
        amount: 5,
        referenceNumber: "OTHER",
      });
      const { service } = setup(
        [
          {
            primary: out,
            legs: [out, inn],
            isTransfer: true,
            fromAccountId: "acc-1",
            toAccountId: "acc-2",
            crossOwnerTransferLeg: false,
          },
        ],
        false,
        storedRule({
          condition: { field: "referenceNumber", op: "eq", value: "chk-1" },
        }),
      );
      const preview = await service.previewRun(USER, RULE_ID, {});
      expect(loadAttachmentPresence).toHaveBeenCalledWith(
        expect.anything(),
        USER,
        ["out"],
      );
      expect(preview.matched.map((r) => r.transactionId)).toEqual(["out"]);
    });

    it("previews a draft on the same facts", async () => {
      const { service } = setup([plainUnit(hit("t1"))]);
      (loadAttachmentPresence as jest.Mock).mockResolvedValue(new Set(["t1"]));
      const preview = await service.previewDraft(USER, {
        condition: NEW_FIELDS as unknown as Record<string, unknown>,
        actions: [{ type: "add_tags", tagIds: [TAG] }],
        filters: {},
      });
      expect(preview.matched.map((r) => r.transactionId)).toEqual(["t1"]);
    });
  });

  describe("previewRun", () => {
    it("plans the rule over the candidates: what changes, what was left alone, what was scanned", async () => {
      const t1 = row("t1");
      const t2 = row("t2", { categoryId: "other" });
      const t3 = row("t3", { payeeName: "LIDL" });
      const split = row("t4", { isSplit: true });
      const { service, writeEffects, record } = setup(
        [t1, t2, t3, split].map(plainUnit),
      );

      const preview = await service.previewRun(USER, RULE_ID, { limit: 50 });

      expect(preview.scanned).toBe(4);
      // The condition matched t1, t2 and the split t4; LIDL (t3) did not.
      expect(preview.conditionMatchedCount).toBe(3);
      expect(preview.truncated).toBe(false);
      expect(preview.matched).toEqual([
        {
          transactionId: "t1",
          date: "2026-03-10",
          payeeName: "SHOP 1",
          amount: -12.5,
          currencyCode: "PLN",
          changes: {
            categoryId: { before: null, after: CAT },
            tagIds: { before: [], after: [TAG] },
          },
        },
        expect.objectContaining({
          transactionId: "t2",
          changes: { tagIds: { before: [], after: [TAG] } },
        }),
        // The split parent still gets the tag; only its category is refused.
        expect.objectContaining({ transactionId: "t4" }),
      ]);
      expect(preview.skipped).toEqual([
        { transactionId: "t4", reason: "split_category" },
      ]);
      expect(preview.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(preview.labels.categories[CAT]).toBe("Groceries");
      // A preview reads: no write, no history.
      expect(writeEffects).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(loadCandidateUnits).toHaveBeenCalledWith(
        expect.anything(),
        USER,
        expect.objectContaining({ limit: 50 }),
        { lock: false },
      );
    });

    it("counts a row whose condition matched though nothing would change it, and none that did not match", async () => {
      // Already categorized: onlyIfEmpty leaves it alone, the condition still matched.
      const done = row("t1", { categoryId: CAT });
      const miss = row("t2", { payeeName: "LIDL" });
      const { service } = setup(
        [done, miss].map(plainUnit),
        false,
        storedRule({
          actions: [
            { type: "set_category", categoryId: CAT, onlyIfEmpty: true },
          ],
        }),
      );
      const preview = await service.previewRun(USER, RULE_ID, { limit: 50 });
      expect(preview.scanned).toBe(2);
      expect(preview.matched).toEqual([]);
      expect(preview.conditionMatchedCount).toBe(1);

      const none = setup([plainUnit(row("t3", { payeeName: "LIDL" }))]);
      expect(
        (await none.service.previewRun(USER, RULE_ID, { limit: 50 }))
          .conditionMatchedCount,
      ).toBe(0);
    });

    it("says truncated when the candidate set was cut", async () => {
      const { service } = setup([plainUnit(row("t1"))], true);
      expect((await service.previewRun(USER, RULE_ID, {})).truncated).toBe(
        true,
      );
    });

    it("runs a disabled rule: a manual run is the user's explicit choice", async () => {
      const { service, rulesService } = setup([plainUnit(row("t1"))]);
      rulesService.getOwnedRule.mockResolvedValue(
        storedRule({ enabled: false }),
      );
      expect(
        (await service.previewRun(USER, RULE_ID, {})).matched,
      ).toHaveLength(1);
    });

    it("refuses a rule that no longer validates, with its reasons", async () => {
      const { service, writeEffects } = setup([plainUnit(row("t1"))]);
      (toRuleResponses as jest.Mock).mockResolvedValue([
        {
          invalid: true,
          invalidReasons: [{ path: "actions[0]", code: "REFERENCE_NOT_FOUND" }],
        },
      ]);
      const error = await thrown(service.previewRun(USER, RULE_ID, {}));
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({ errorCode: "INVALID_RULE" });
      expect(writeEffects).not.toHaveBeenCalled();
    });

    it("404s a rule that is not the caller's", async () => {
      const { service, rulesService } = setup([]);
      rulesService.getOwnedRule.mockRejectedValue(new NotFoundException("x"));
      await expect(
        service.previewRun(USER, RULE_ID, {}),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(loadCandidateUnits).not.toHaveBeenCalled();
    });

    it("refuses an inverted date range before opening a transaction", async () => {
      const { service, dataSource } = setup([]);
      const error = await thrown(
        service.previewRun(USER, RULE_ID, {
          startDate: "2026-05-01",
          endDate: "2026-04-01",
        }),
      );
      expect(error.getResponse()).toMatchObject({
        errorCode: "DATE_RANGE_INVALID",
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it("accepts a one-day range", async () => {
      const { service } = setup([]);
      await expect(
        service.previewRun(USER, RULE_ID, {
          startDate: "2026-04-01",
          endDate: "2026-04-01",
        }),
      ).resolves.toMatchObject({ scanned: 0, matched: [] });
    });

    it("an empty plan still has a fingerprint", async () => {
      const { service } = setup([]);
      const preview = await service.previewRun(USER, RULE_ID, {});
      expect(preview.matched).toEqual([]);
      expect(preview.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it("reports the reasons a cross-owner leg and a transfer leg keep a change back", async () => {
      const transferLeg: CandidateUnit = {
        primary: row("tr", { isTransfer: true, amount: -5 }),
        legs: [row("tr", { isTransfer: true, amount: -5 })],
        isTransfer: true,
        fromAccountId: "a",
        toAccountId: "b",
        crossOwnerTransferLeg: false,
      };
      const crossOwner: CandidateUnit = {
        ...transferLeg,
        primary: row("co", { isTransfer: true, amount: 5 }),
        legs: [row("co", { isTransfer: true, amount: 5 })],
        crossOwnerTransferLeg: true,
      };
      const { service, rulesService } = setup([transferLeg, crossOwner]);
      rulesService.getOwnedRule.mockResolvedValue(
        storedRule({
          condition: { field: "type", op: "eq", value: "TRANSFER" },
          actions: [
            { type: "set_category", categoryId: CAT, onlyIfEmpty: false },
            { type: "set_payee", payeeId: PAYEE, onlyIfEmpty: false },
          ],
        }),
      );

      const preview = await service.previewRun(USER, RULE_ID, {});

      expect(preview.skipped).toEqual(
        expect.arrayContaining([
          { transactionId: "tr", reason: "transfer_leg_category" },
          { transactionId: "co", reason: "transfer_leg_category" },
          { transactionId: "co", reason: "cross_owner_transfer_payee" },
        ]),
      );
      // The same-owner transfer takes the payee; the cross-owner leg does not.
      expect(preview.matched.map((m) => m.transactionId)).toEqual(["tr"]);
    });
  });

  describe("previewDraft", () => {
    it("validates like a create, plans the unsaved rule and writes nothing", async () => {
      const { service, rulesService, writeEffects, record, manager } = setup([
        plainUnit(row("t1")),
      ]);

      const preview = await service.previewDraft(USER, {
        condition: CONDITION as unknown as Record<string, unknown>,
        actions: [{ type: "add_tags", tagIds: [TAG] }],
        filters: { accountIds: ["acc-1"], limit: 10 },
      });

      expect(rulesService.checkedDefinition).toHaveBeenCalledWith(
        manager,
        USER,
        CONDITION,
        [{ type: "add_tags", tagIds: [TAG] }],
        true,
      );
      expect(rulesService.getOwnedRule).not.toHaveBeenCalled();
      expect(preview.matched).toHaveLength(1);
      expect(preview.matched[0].changes).toEqual({
        tagIds: { before: [], after: [TAG] },
      });
      expect(loadCandidateUnits).toHaveBeenCalledWith(
        expect.anything(),
        USER,
        expect.objectContaining({ accountIds: ["acc-1"], limit: 10 }),
        { lock: false },
      );
      expect(writeEffects).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("passes the caller's authoring decision to the validation", async () => {
      const { service, rulesService, manager } = setup([plainUnit(row("t1"))]);
      await service.previewDraft(
        USER,
        {
          condition: CONDITION as unknown as Record<string, unknown>,
          actions: [{ type: "add_tags", tagIds: [TAG] }],
        },
        { authoring: false },
      );
      expect(rulesService.checkedDefinition).toHaveBeenCalledWith(
        manager,
        USER,
        CONDITION,
        [{ type: "add_tags", tagIds: [TAG] }],
        false,
      );
    });

    describe("with a ruleId", () => {
      const NETFLIX = {
        field: "payeeText",
        op: "matches",
        value: "NETFLIX.COM",
      };
      const draft = (condition: Record<string, unknown>) => ({
        ruleId: RULE_ID,
        condition,
        actions: [{ type: "add_tags", tagIds: [TAG] }],
      });

      it("skips the authoring advice when the condition equals the stored one", async () => {
        const { service, rulesService, manager } = setup(
          [plainUnit(row("t1", { payeeName: "NETFLIX.COM" }))],
          false,
          storedRule({ condition: NETFLIX as unknown as RuleConditionNode }),
        );
        const preview = await service.previewDraft(USER, draft({ ...NETFLIX }));
        expect(rulesService.getOwnedRule).toHaveBeenCalledWith(
          manager,
          USER,
          RULE_ID,
        );
        expect(rulesService.checkedDefinition).toHaveBeenCalledWith(
          manager,
          USER,
          NETFLIX,
          [{ type: "add_tags", tagIds: [TAG] }],
          false,
        );
        expect(preview.matched).toHaveLength(1);
      });

      it("keeps the advice when the condition differs from the stored one", async () => {
        const { service, rulesService, manager } = setup(
          [plainUnit(row("t1"))],
          false,
          storedRule({ condition: NETFLIX as unknown as RuleConditionNode }),
        );
        const changed = { ...NETFLIX, value: "NETFLIX.NL" };
        await service.previewDraft(USER, draft(changed));
        expect(rulesService.checkedDefinition).toHaveBeenCalledWith(
          manager,
          USER,
          changed,
          [{ type: "add_tags", tagIds: [TAG] }],
          true,
        );
      });

      it("answers 404 for a missing or foreign rule, before validating or reading", async () => {
        const { service, rulesService } = setup([plainUnit(row("t1"))]);
        rulesService.getOwnedRule.mockRejectedValue(new NotFoundException());
        await expect(
          service.previewDraft(USER, draft({ ...NETFLIX })),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(rulesService.checkedDefinition).not.toHaveBeenCalled();
        expect(loadCandidateUnits).not.toHaveBeenCalled();
      });

      it("lets an explicit authoring option win over the comparison", async () => {
        const { service, rulesService, manager } = setup([
          plainUnit(row("t1")),
        ]);
        await service.previewDraft(USER, draft({ ...NETFLIX }), {
          authoring: true,
        });
        expect(rulesService.getOwnedRule).not.toHaveBeenCalled();
        expect(rulesService.checkedDefinition).toHaveBeenCalledWith(
          manager,
          USER,
          NETFLIX,
          expect.anything(),
          true,
        );
      });
    });

    it("applies the onlyIfEmpty default to the draft", async () => {
      const { service } = setup([plainUnit(row("t1", { categoryId: "kept" }))]);
      const preview = await service.previewDraft(USER, {
        condition: CONDITION as unknown as Record<string, unknown>,
        actions: [{ type: "set_category", categoryId: CAT }],
      });
      expect(preview.matched).toEqual([]);
    });

    it("propagates the validation error and reads no transaction", async () => {
      const { service, rulesService } = setup([plainUnit(row("t1"))]);
      rulesService.checkedDefinition.mockRejectedValue(
        new BadRequestException({ errorCode: "INVALID_RULE" }),
      );
      await expect(
        service.previewDraft(USER, { condition: {}, actions: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(loadCandidateUnits).not.toHaveBeenCalled();
    });

    it("refuses an inverted range", async () => {
      const { service } = setup([]);
      await expect(
        service.previewDraft(USER, {
          condition: {},
          actions: [],
          filters: { startDate: "2026-05-01", endDate: "2026-04-01" },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("run", () => {
    const filters = { limit: 100 };

    async function previewFingerprint(
      s: ReturnType<typeof setup>,
    ): Promise<string> {
      return (await s.service.previewRun(USER, RULE_ID, filters)).fingerprint;
    }

    it("re-plans with the rows locked, writes through the applier as manual, records one entry", async () => {
      const s = setup([plainUnit(row("t1")), plainUnit(row("t2"))]);
      const fingerprint = await previewFingerprint(s);

      const result = await s.service.run(USER, RULE_ID, {
        ...filters,
        fingerprint,
      });

      expect(result).toEqual({ changed: 2, skipped: [], historyId: "hist-1" });
      expect(loadCandidateUnits).toHaveBeenLastCalledWith(
        expect.anything(),
        USER,
        expect.anything(),
        { lock: true },
      );
      expect(s.rulesService.getOwnedRule).toHaveBeenLastCalledWith(
        expect.anything(),
        USER,
        RULE_ID,
        { share: true },
      );
      expect(s.writeEffects).toHaveBeenCalledTimes(2);
      expect(s.writeEffects).toHaveBeenCalledWith(
        s.manager,
        USER,
        "t1",
        expect.objectContaining({
          changes: expect.objectContaining({ categoryId: CAT }),
        }),
        "manual",
        expect.any(Set),
      );
      expect(s.record).toHaveBeenCalledTimes(1);
      const entry = s.record.mock.calls[0][1];
      expect(entry).toMatchObject({
        entityType: "transaction_rule_run",
        entityId: RULE_ID,
        action: "bulk_update",
        descriptionKey: "ranTransactionRule",
        descriptionParams: { name: "Shop", count: 2 },
      });
      expect(entry.beforeData.transactions).toEqual([
        { id: "t1", categoryId: null, tagIds: [] },
        { id: "t2", categoryId: null, tagIds: [] },
      ]);
      expect(entry.afterData.transactions).toEqual([
        { id: "t1", categoryId: CAT, tagIds: [TAG] },
        { id: "t2", categoryId: CAT, tagIds: [TAG] },
      ]);
    });

    it("records the payee with its name, and the tag set after removals and additions", async () => {
      const t1 = row("t1", {
        payeeId: "p-old",
        payeeName: "SHOP Old",
        categoryId: "c-old",
      });
      const s = setup([plainUnit(t1)]);
      s.rulesService.getOwnedRule.mockResolvedValue(
        storedRule({
          actions: [
            { type: "set_payee", payeeId: PAYEE, onlyIfEmpty: false },
            { type: "add_tags", tagIds: [TAG] },
            { type: "remove_tags", tagIds: [TAG_OLD] },
          ],
        }),
      );
      s.loadTagIds.mockResolvedValue(new Map([["t1", [TAG_OLD, TAG_KEEP]]]));
      const fingerprint = await previewFingerprint(s);

      await s.service.run(USER, RULE_ID, { ...filters, fingerprint });

      const entry = s.record.mock.calls[0][1];
      expect(entry.beforeData.transactions).toEqual([
        {
          id: "t1",
          payeeId: "p-old",
          payeeName: "SHOP Old",
          tagIds: [TAG_OLD, TAG_KEEP],
        },
      ]);
      expect(entry.afterData.transactions).toEqual([
        {
          id: "t1",
          payeeId: PAYEE,
          payeeName: "Shop payee",
          tagIds: [TAG_KEEP, TAG],
        },
      ]);
    });

    it("writes both legs of a same-owner transfer and counts both", async () => {
      const out = row("out", { isTransfer: true, amount: -5 });
      const inn = row("in", { isTransfer: true, amount: 5 });
      const s = setup([
        {
          primary: out,
          legs: [out, inn],
          isTransfer: true,
          fromAccountId: "a",
          toAccountId: "b",
          crossOwnerTransferLeg: false,
        },
      ]);
      s.rulesService.getOwnedRule.mockResolvedValue(
        storedRule({
          condition: { field: "type", op: "eq", value: "TRANSFER" },
          actions: [{ type: "add_tags", tagIds: [TAG] }],
        }),
      );
      const fingerprint = await previewFingerprint(s);

      const result = await s.service.run(USER, RULE_ID, {
        ...filters,
        fingerprint,
      });

      expect(result.changed).toBe(2);
      expect(s.writeEffects.mock.calls.map((c) => c[2])).toEqual(["out", "in"]);
      expect(
        s.record.mock.calls[0][1].beforeData.transactions.map(
          (r: { id: string }) => r.id,
        ),
      ).toEqual(["out", "in"]);
    });

    it("queues an AI review on commit only, on the primary leg, even when the rule changes no ledger field", async () => {
      const asking = storedRule({
        actions: [{ type: "request_ai_review", instruction: "split it" }],
      });
      const s = setup([plainUnit(row("t1"))], false, asking);
      const preview = await s.service.previewRun(USER, RULE_ID, filters);
      expect(preview.matched).toEqual([]);
      // Nothing changes in the ledger, yet the condition matched the row.
      expect(preview.conditionMatchedCount).toBe(1);
      expect(preview.aiReviewRequests).toBe(1);
      expect(s.enqueue).not.toHaveBeenCalled();

      const result = await s.service.run(USER, RULE_ID, {
        ...filters,
        fingerprint: preview.fingerprint,
      });

      expect(result.changed).toBe(0);
      expect(s.writeEffects).not.toHaveBeenCalled();
      expect(s.enqueue).toHaveBeenCalledTimes(1);
      expect(s.enqueue).toHaveBeenCalledWith(s.manager, USER, [
        { transactionId: "t1", ruleId: RULE_ID, instruction: "split it" },
      ]);
    });

    it("does not queue when the fingerprint is stale", async () => {
      const asking = storedRule({
        actions: [{ type: "request_ai_review", instruction: "split it" }],
      });
      const s = setup([plainUnit(row("t1"))], false, asking);
      await expect(
        s.service.run(USER, RULE_ID, { ...filters, fingerprint: "stale" }),
      ).rejects.toThrow();
      expect(s.enqueue).not.toHaveBeenCalled();
    });

    it("refuses a stale fingerprint with 409 before any write or history entry", async () => {
      const s = setup([plainUnit(row("t1"))]);
      const fingerprint = await previewFingerprint(s);
      // The row was categorised meanwhile: the plan is no longer the previewed one.
      (loadCandidateUnits as jest.Mock).mockResolvedValue({
        units: [plainUnit(row("t1", { categoryId: "changed" }))],
        truncated: false,
      });

      const error = await thrown(
        s.service.run(USER, RULE_ID, { ...filters, fingerprint }),
      );

      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).toMatchObject({
        errorCode: "PREVIEW_CHANGED",
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(s.writeEffects).not.toHaveBeenCalled();
      expect(s.record).not.toHaveBeenCalled();
    });

    it("refuses when the rule was edited since the preview (revision is part of the fingerprint)", async () => {
      const s = setup([plainUnit(row("t1"))]);
      const fingerprint = await previewFingerprint(s);
      s.rulesService.getOwnedRule.mockResolvedValue(
        storedRule({ revision: 5 }),
      );
      await expect(
        s.service.run(USER, RULE_ID, { ...filters, fingerprint }),
      ).rejects.toMatchObject({ status: 409 });
      expect(s.writeEffects).not.toHaveBeenCalled();
    });

    it("skips a reconciled row under the strict lock, reports it and leaves it out of the fingerprint", async () => {
      const reconciled = row("r1", { status: TransactionStatus.RECONCILED });
      const s = setup([plainUnit(reconciled), plainUnit(row("t2"))]);
      (isReconciledLockEnabled as jest.Mock).mockResolvedValue(true);
      const preview = await s.service.previewRun(USER, RULE_ID, filters);
      expect(preview.skipped).toEqual([
        { transactionId: "r1", reason: "reconciled_locked" },
      ]);
      expect(preview.matched.map((m) => m.transactionId)).toEqual(["t2"]);

      const result = await s.service.run(USER, RULE_ID, {
        ...filters,
        fingerprint: preview.fingerprint,
      });

      expect(result.changed).toBe(1);
      expect(result.skipped).toEqual(preview.skipped);
      expect(s.writeEffects.mock.calls.map((c) => c[2])).toEqual(["t2"]);
    });

    it("skips a transfer whose other leg is reconciled: it cannot be half written", async () => {
      const out = row("out", { isTransfer: true, amount: -5 });
      const inn = row("in", {
        isTransfer: true,
        amount: 5,
        status: TransactionStatus.RECONCILED,
      });
      const s = setup([
        {
          primary: out,
          legs: [out, inn],
          isTransfer: true,
          fromAccountId: "a",
          toAccountId: "b",
          crossOwnerTransferLeg: false,
        },
      ]);
      s.rulesService.getOwnedRule.mockResolvedValue(
        storedRule({
          condition: { field: "type", op: "eq", value: "TRANSFER" },
          actions: [{ type: "add_tags", tagIds: [TAG] }],
        }),
      );
      (isReconciledLockEnabled as jest.Mock).mockResolvedValue(true);
      const preview = await s.service.previewRun(USER, RULE_ID, filters);

      const result = await s.service.run(USER, RULE_ID, {
        ...filters,
        fingerprint: preview.fingerprint,
      });

      expect(result.changed).toBe(0);
      expect(result.skipped).toEqual([
        { transactionId: "out", reason: "reconciled_locked" },
      ]);
      expect(s.writeEffects).not.toHaveBeenCalled();
      expect(s.record).not.toHaveBeenCalled();
    });

    it("runs on a reconciled row when the strict lock is off, and reads the preference only when it matters", async () => {
      const s = setup([
        plainUnit(row("r1", { status: TransactionStatus.RECONCILED })),
      ]);
      const preview = await s.service.previewRun(USER, RULE_ID, filters);
      expect(preview.skipped).toEqual([]);
      expect(preview.matched).toHaveLength(1);
      (isReconciledLockEnabled as jest.Mock).mockClear();

      const plain = setup([plainUnit(row("t1"))]);
      await plain.service.previewRun(USER, RULE_ID, filters);
      expect(isReconciledLockEnabled).not.toHaveBeenCalled();
    });

    it("writes and records nothing when the plan changes nothing", async () => {
      const s = setup([plainUnit(row("t1", { payeeName: "LIDL" }))]);
      const fingerprint = await previewFingerprint(s);
      const result = await s.service.run(USER, RULE_ID, {
        ...filters,
        fingerprint,
      });
      expect(result).toEqual({ changed: 0, skipped: [], historyId: null });
      expect(s.writeEffects).not.toHaveBeenCalled();
      expect(s.record).not.toHaveBeenCalled();
    });

    it("returns a null historyId when the entry could not be recorded", async () => {
      const s = setup([plainUnit(row("t1"))]);
      s.record.mockResolvedValue(null);
      const fingerprint = await previewFingerprint(s);
      const result = await s.service.run(USER, RULE_ID, {
        ...filters,
        fingerprint,
      });
      expect(result.changed).toBe(1);
      expect(result.historyId).toBeNull();
    });

    it("records after the transaction has committed", async () => {
      const s = setup([plainUnit(row("t1"))]);
      const order: string[] = [];
      s.writeEffects.mockImplementation(async (_m, _u, _id, effects) => {
        order.push("write");
        return effects;
      });
      s.record.mockImplementation(async () => {
        order.push("record");
        return { id: "h" };
      });
      s.dataSource.transaction.mockImplementation(async (fn: never) => {
        const out = await (fn as (m: unknown) => Promise<unknown>)(s.manager);
        order.push("commit");
        return out;
      });
      const fingerprint = await previewFingerprint(s);
      order.length = 0;
      await s.service.run(USER, RULE_ID, { ...filters, fingerprint });
      expect(order).toEqual(["write", "commit", "record"]);
    });

    it("refuses a run its undo entry could not hold, before the first write", async () => {
      const units = Array.from({ length: 6000 }, (_, i) =>
        plainUnit(
          row(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`),
        ),
      );
      const s = setup(units);
      const fingerprint = await previewFingerprint(s);

      const error = await thrown(
        s.service.run(USER, RULE_ID, { ...filters, fingerprint }),
      );

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({ errorCode: "RUN_TOO_LARGE" });
      expect(s.writeEffects).not.toHaveBeenCalled();
      expect(s.record).not.toHaveBeenCalled();
    });

    it("404s another user's rule without planning", async () => {
      const s = setup([plainUnit(row("t1"))]);
      s.rulesService.getOwnedRule.mockRejectedValue(new NotFoundException("x"));
      await expect(
        s.service.run(USER, RULE_ID, {
          ...filters,
          fingerprint: "0".repeat(64),
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(loadCandidateUnits).not.toHaveBeenCalled();
      expect(s.writeEffects).not.toHaveBeenCalled();
    });

    it("refuses an inverted range before opening a transaction", async () => {
      const s = setup([]);
      await expect(
        s.service.run(USER, RULE_ID, {
          startDate: "2026-05-01",
          endDate: "2026-04-01",
          fingerprint: "0".repeat(64),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(s.dataSource.transaction).not.toHaveBeenCalled();
    });
  });
  describe("the text actions (design 10.2)", () => {
    const NEW_PAYEE = "b0000000-0000-4000-8000-0000000000aa";
    const OLD_PAYEE = "b0000000-0000-4000-8000-0000000000bb";
    const filters = { limit: 100 };
    const textRule = (over: object = {}) =>
      storedRule({
        condition: { field: "payeeText", op: "matches", value: "SHOP {n}" },
        actions: [
          {
            type: "set_payee_from_text",
            template: "Shop {n}",
            createIfMissing: true,
            onlyIfEmpty: true,
          },
          {
            type: "set_description",
            template: "Bought at {n}",
            mode: "replace",
            onlyIfEmpty: false,
          },
        ] as RuleAction[],
        ...over,
      });

    it("previews the new fields, says the payee will be created, and creates nothing", async () => {
      const s = setup([plainUnit(row("t1", { description: "old" }))]);
      s.rulesService.getOwnedRule.mockResolvedValue(textRule());

      const preview = await s.service.previewRun(USER, RULE_ID, filters);

      expect(preview.matched[0].changes).toEqual({
        payeeName: { before: "SHOP 1", after: "Shop 1" },
        payeeCreated: true,
        description: { before: "old", after: "Bought at 1" },
      });
      expect(s.payees.resolveByName).toHaveBeenCalledWith(USER, "Shop 1");
      expect(s.payees.findOrCreate).not.toHaveBeenCalled();
      expect(s.writeEffects).not.toHaveBeenCalled();
    });

    it("names the rows a text action could not act on", async () => {
      const s = setup([
        plainUnit(row("t1", { payeeName: "SHOP  !" })),
        plainUnit(row("t2", { payeeName: "SHOP 2!" })),
      ]);
      s.rulesService.getOwnedRule.mockResolvedValue(
        textRule({
          condition: { field: "payeeText", op: "matches", value: "SHOP {n}!" },
          actions: [
            {
              type: "set_payee_from_text",
              template: "{n}",
              createIfMissing: false,
              onlyIfEmpty: true,
            },
          ] as RuleAction[],
        }),
      );

      const preview = await s.service.previewRun(USER, RULE_ID, filters);

      expect(preview.skipped).toEqual([
        { transactionId: "t1", reason: "empty_render" },
        { transactionId: "t2", reason: "payee_not_found" },
      ]);
      expect(preview.matched).toEqual([]);
    });

    it("commits with the created payee's id in the undo snapshots, and writes the resolved plan", async () => {
      const s = setup([plainUnit(row("t1", { description: "old" }))]);
      s.rulesService.getOwnedRule.mockResolvedValue(textRule());
      s.payees.findOrCreate.mockResolvedValue({
        id: NEW_PAYEE,
        name: "Shop 1",
      });
      const fingerprint = (await s.service.previewRun(USER, RULE_ID, filters))
        .fingerprint;

      const result = await s.service.run(USER, RULE_ID, {
        ...filters,
        fingerprint,
      });

      expect(result.changed).toBe(1);
      expect(s.payees.findOrCreate).toHaveBeenCalledTimes(1);
      expect(s.payees.findOrCreate).toHaveBeenCalledWith(USER, "Shop 1");
      expect(s.writeEffects).toHaveBeenCalledWith(
        s.manager,
        USER,
        "t1",
        expect.objectContaining({
          changes: expect.objectContaining({
            payeeId: NEW_PAYEE,
            payeeName: "Shop 1",
            description: "Bought at 1",
          }),
        }),
        "manual",
        expect.any(Set),
      );
      const entry = s.record.mock.calls[0][1];
      expect(entry.beforeData.transactions).toEqual([
        {
          id: "t1",
          payeeId: null,
          payeeName: "SHOP 1",
          description: "old",
        },
      ]);
      expect(entry.afterData.transactions).toEqual([
        {
          id: "t1",
          payeeId: NEW_PAYEE,
          payeeName: "Shop 1",
          description: "Bought at 1",
        },
      ]);
    });

    it("creates the payee once for both legs of a same-owner transfer", async () => {
      const out = row("out", { isTransfer: true, linkedTransactionId: "in" });
      const inn = row("in", { isTransfer: true, linkedTransactionId: "out" });
      const s = setup([
        {
          primary: out,
          legs: [out, inn],
          isTransfer: true,
          fromAccountId: "acc-1",
          toAccountId: "acc-2",
          crossOwnerTransferLeg: false,
        },
      ]);
      s.rulesService.getOwnedRule.mockResolvedValue(textRule());
      s.payees.findOrCreate.mockResolvedValue({
        id: NEW_PAYEE,
        name: "Shop 1",
      });
      const fingerprint = (await s.service.previewRun(USER, RULE_ID, filters))
        .fingerprint;

      await s.service.run(USER, RULE_ID, { ...filters, fingerprint });

      expect(s.payees.findOrCreate).toHaveBeenCalledTimes(1);
      expect(s.writeEffects.mock.calls.map((c) => c[2])).toEqual(["out", "in"]);
      const entry = s.record.mock.calls[0][1];
      expect(
        entry.afterData.transactions.map((t: { id: string }) => t.id),
      ).toEqual(["out", "in"]);
    });

    it("refuses a commit whose payee appeared since the preview (the plan no longer hashes the same)", async () => {
      const s = setup([plainUnit(row("t1"))]);
      s.rulesService.getOwnedRule.mockResolvedValue(textRule());
      const fingerprint = (await s.service.previewRun(USER, RULE_ID, filters))
        .fingerprint;
      s.payees.resolveByName.mockResolvedValue({
        id: OLD_PAYEE,
        name: "Shop 1",
      });

      const error = await thrown(
        s.service.run(USER, RULE_ID, { ...filters, fingerprint }),
      );

      expect(error.getResponse()).toMatchObject({
        errorCode: "PREVIEW_CHANGED",
      });
      expect(s.writeEffects).not.toHaveBeenCalled();
      expect(s.payees.findOrCreate).not.toHaveBeenCalled();
    });
  });
});
