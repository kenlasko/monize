import { BadRequestException } from "@nestjs/common";
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
import { TransactionRule } from "./transaction-rule.entity";
import { toRuleResponses } from "./transaction-rule-view";
import { TransactionRulesApplierService } from "./transaction-rules-applier.service";
import { TransactionRulesRunService } from "./transaction-rules-run.service";
import { TransactionRulesService } from "./transaction-rules.service";

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

/**
 * INV-RULE-004 on the manual run and the test: the planner skips a row outside
 * the rule's active window, and the window narrows what is scanned.
 */
const USER = "user-1";
const RULE_ID = "e0000000-0000-4000-8000-000000000005";
const CAT = "c0000000-0000-4000-8000-000000000003";

const CONDITION: RuleConditionNode = {
  field: "payeeText",
  op: "contains",
  value: "kapital",
};
const ACTIONS: RuleAction[] = [
  { type: "set_category", categoryId: CAT, onlyIfEmpty: true },
];

const storedRule = (over: Partial<TransactionRule> = {}): TransactionRule =>
  ({
    id: RULE_ID,
    userId: USER,
    name: "Mortgage",
    enabled: true,
    position: 0,
    triggers: ["create"],
    condition: CONDITION,
    actions: ACTIONS,
    stopProcessing: false,
    activeFrom: "2026-10-01",
    activeTo: null,
    revision: 4,
    ...over,
  }) as TransactionRule;

const row = (id: string, transactionDate: string): Transaction =>
  ({
    id,
    userId: USER,
    accountId: "acc-1",
    currencyCode: "PLN",
    amount: -102.21,
    transactionDate,
    isTransfer: false,
    linkedTransactionId: null,
    parentTransactionId: null,
    payeeId: null,
    payeeName: "KAPITAL: 0,00 ODSETKI: 102,21",
    categoryId: null,
    description: null,
    isSplit: false,
    status: TransactionStatus.UNRECONCILED,
  }) as Transaction;

const unit = (r: Transaction): CandidateUnit => ({
  primary: r,
  legs: [r],
  isTransfer: false,
  fromAccountId: null,
  toAccountId: null,
  crossOwnerTransferLeg: false,
});

function setup(units: CandidateUnit[], stored = storedRule()) {
  (loadCandidateUnits as jest.Mock).mockResolvedValue({
    units,
    truncated: false,
  });
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
    categories: { [CAT]: "Loans" },
    payees: {},
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
    activeWindowInvalid: () => new BadRequestException("window"),
  };
  const { dataSource } = createScopedDbMocks([]);
  const service = new TransactionRulesRunService(
    dataSource as unknown as DataSource,
    rulesService as unknown as TransactionRulesService,
    applier,
    {
      record: jest.fn().mockResolvedValue({ id: "hist-1" }),
    } as unknown as ActionHistoryService,
    { triggerDebouncedRecalc: jest.fn() } as never,
  );
  return { service, writeEffects };
}

const scanFilters = () => {
  const calls = (loadCandidateUnits as jest.Mock).mock.calls;
  return calls[calls.length - 1][2] as {
    startDate?: string;
    endDate?: string;
  };
};

describe("TransactionRulesRunService: the active window", () => {
  beforeEach(() => jest.clearAllMocks());

  it("leaves a row dated before activeFrom unchanged even when it is handed to the planner", async () => {
    const { service } = setup([
      unit(row("before", "2026-09-07")),
      unit(row("inside", "2026-10-05")),
    ]);
    const preview = await service.previewRun(USER, RULE_ID, {});
    expect(preview.scanned).toBe(2);
    expect(preview.conditionMatchedCount).toBe(1);
    expect(preview.matched.map((m) => m.transactionId)).toEqual(["inside"]);
  });

  it("writes nothing for a row outside the window on a commit", async () => {
    const { service, writeEffects } = setup([
      unit(row("before", "2026-09-07")),
    ]);
    const preview = await service.previewRun(USER, RULE_ID, {});
    expect(preview.matched).toEqual([]);
    const result = await service.run(USER, RULE_ID, {
      fingerprint: preview.fingerprint,
    });
    expect(result.changed).toBe(0);
    expect(writeEffects).not.toHaveBeenCalled();
  });

  it("narrows the scan to the window: the later start and the earlier end win", async () => {
    const { service } = setup([], storedRule({ activeTo: "2026-12-31" }));
    await service.previewRun(USER, RULE_ID, {});
    expect(scanFilters()).toMatchObject({
      startDate: "2026-10-01",
      endDate: "2026-12-31",
    });

    await service.previewRun(USER, RULE_ID, {
      startDate: "2026-11-01",
      endDate: "2027-06-30",
    });
    expect(scanFilters()).toMatchObject({
      startDate: "2026-11-01",
      endDate: "2026-12-31",
    });

    await service.previewRun(USER, RULE_ID, {
      startDate: "2026-01-01",
      endDate: "2026-11-30",
    });
    expect(scanFilters()).toMatchObject({
      startDate: "2026-10-01",
      endDate: "2026-11-30",
    });
  });

  it("never widens the window: a run filter is only an intersection", async () => {
    const { service } = setup([], storedRule({ activeFrom: null }));
    await service.previewRun(USER, RULE_ID, { startDate: "2026-03-01" });
    expect(scanFilters()).toMatchObject({ startDate: "2026-03-01" });
    expect(scanFilters().endDate).toBeUndefined();
  });

  it("scans nothing, and is not an error, when the filters miss the window", async () => {
    const { service } = setup(
      [unit(row("inside", "2026-10-05"))],
      storedRule({ activeFrom: "2026-10-01", activeTo: "2026-12-31" }),
    );
    const preview = await service.previewRun(USER, RULE_ID, {
      startDate: "2026-01-01",
      endDate: "2026-09-30",
    });
    expect(loadCandidateUnits).not.toHaveBeenCalled();
    expect(preview).toMatchObject({
      matched: [],
      skipped: [],
      scanned: 0,
      conditionMatchedCount: 0,
      truncated: false,
    });
    expect(preview.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the fingerprint when the window changes, through the rule revision", async () => {
    const rows = [unit(row("inside", "2026-10-05"))];
    const a = await setup(rows, storedRule({ revision: 4 })).service.previewRun(
      USER,
      RULE_ID,
      {},
    );
    const b = await setup(
      rows,
      storedRule({ revision: 5, activeFrom: "2026-09-01" }),
    ).service.previewRun(USER, RULE_ID, {});
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  describe("a draft", () => {
    const draft = (over: object = {}) => ({
      condition: CONDITION as unknown as Record<string, unknown>,
      actions: ACTIONS as unknown as Record<string, unknown>[],
      ...over,
    });

    it("honours the window it carries, as a saved rule does", async () => {
      const { service } = setup([
        unit(row("before", "2026-09-07")),
        unit(row("inside", "2026-10-05")),
      ]);
      const preview = await service.previewDraft(
        USER,
        draft({ activeFrom: "2026-10-01" }),
      );
      expect(preview.matched.map((m) => m.transactionId)).toEqual(["inside"]);
      expect(scanFilters()).toMatchObject({ startDate: "2026-10-01" });
    });

    it("has no window when none is given, and reads a blank side as open", async () => {
      const { service } = setup([unit(row("before", "2026-09-07"))]);
      const open = await service.previewDraft(USER, draft());
      expect(open.matched.map((m) => m.transactionId)).toEqual(["before"]);
      const blank = await service.previewDraft(
        USER,
        draft({ activeFrom: "", activeTo: null }),
      );
      expect(blank.matched.map((m) => m.transactionId)).toEqual(["before"]);
    });

    it("refuses a window whose first day is after its last, before scanning", async () => {
      const { service } = setup([]);
      await expect(
        service.previewDraft(
          USER,
          draft({ activeFrom: "2026-12-31", activeTo: "2026-10-01" }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(loadCandidateUnits).not.toHaveBeenCalled();
    });
  });
});
