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
import { RuleTargetAccounts } from "./rule-structure";
import { loadRuleTargetAccounts } from "./rule-target-accounts";
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
jest.mock("./rule-target-accounts", () => ({
  loadRuleTargetAccounts: jest.fn(),
}));
jest.mock("./transaction-rule-view", () => ({ toRuleResponses: jest.fn() }));
jest.mock("../transactions/reconciled-lock.util", () => ({
  isReconciledLockEnabled: jest.fn(),
}));

/**
 * Structural actions through the manual run and the test (INV-RULE-003): the
 * preview shows the planned parts, every refusal is reported under the
 * planner's own name, and the fingerprint covers the parts.
 */
const USER = "user-1";
const RULE_ID = "e0000000-0000-4000-8000-000000000005";
const OWN = "a0000000-0000-4000-8000-000000000001";
const LOAN = "a0000000-0000-4000-8000-000000000002";
const CAT = "c0000000-0000-4000-8000-000000000003";

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

const row = (
  id: string,
  amount: number,
  over: Partial<Transaction> = {},
): Transaction =>
  ({
    id,
    userId: USER,
    accountId: OWN,
    currencyCode: "PLN",
    amount,
    transactionDate: "2026-10-05",
    isTransfer: false,
    linkedTransactionId: null,
    parentTransactionId: null,
    payeeId: null,
    payeeName: "PRINCIPAL: 1200,50 INTEREST: 300,25",
    categoryId: null,
    description: null,
    isSplit: false,
    status: TransactionStatus.UNRECONCILED,
    ...over,
  }) as Transaction;

const unit = (r: Transaction, isTransfer = false): CandidateUnit => ({
  primary: r,
  legs: [r],
  isTransfer,
  fromAccountId: isTransfer ? OWN : null,
  toAccountId: isTransfer ? LOAN : null,
  crossOwnerTransferLeg: false,
});

function setup(
  units: CandidateUnit[],
  actions: RuleAction[],
  accounts: RuleTargetAccounts = new Map([[LOAN, { currencyCode: "PLN" }]]),
) {
  (loadCandidateUnits as jest.Mock).mockResolvedValue({
    units,
    truncated: false,
  });
  (loadRuleTargetAccounts as jest.Mock).mockResolvedValue(accounts);
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
    accounts: { [LOAN]: "Loan account" },
    categories: {},
    payees: {},
    tags: {},
    rules: {},
  });
  const { dataSource } = createScopedDbMocks([]);
  const service = new TransactionRulesRunService(
    dataSource as unknown as DataSource,
    {
      getOwnedRule: jest.fn().mockResolvedValue(storedRule(actions)),
    } as unknown as TransactionRulesService,
    applier,
    { record: jest.fn() } as unknown as ActionHistoryService,
    { triggerDebouncedRecalc: jest.fn() } as never,
  );
  return { service };
}

describe("TransactionRulesRunService: structural actions", () => {
  beforeEach(() => jest.clearAllMocks());

  it("loads the target accounts once for the rule and plans with them", async () => {
    const { service } = setup(
      [unit(row("a", -1500.75)), unit(row("b", -1500.75))],
      SPLIT,
    );
    await service.previewRun(USER, RULE_ID, {});
    expect(loadRuleTargetAccounts).toHaveBeenCalledTimes(1);
    expect((loadRuleTargetAccounts as jest.Mock).mock.calls[0][1]).toBe(USER);
    expect(
      (loadRuleTargetAccounts as jest.Mock).mock.calls[0][2][0].actions,
    ).toEqual(SPLIT);
  });

  it("shows the planned parts of a split in the preview, with names in the labels", async () => {
    const { service } = setup([unit(row("a", -1500.75))], SPLIT);
    const preview = await service.previewRun(USER, RULE_ID, {});
    expect(preview.matched).toHaveLength(1);
    expect(preview.matched[0].changes.structure).toEqual({
      before: null,
      after: {
        kind: "split",
        parts: [
          {
            amount: -1200.5,
            categoryId: null,
            transferAccountId: LOAN,
            payeeId: null,
            memo: null,
          },
          {
            amount: -300.25,
            categoryId: CAT,
            transferAccountId: null,
            payeeId: null,
            memo: null,
          },
        ],
      },
    });
    expect(preview.labels.accounts[LOAN]).toBe("Loan account");
    expect(preview.skipped).toEqual([]);
  });

  it("shows a conversion as a transfer to the target", async () => {
    const { service } = setup([unit(row("a", -640.15))], CONVERT);
    const preview = await service.previewRun(USER, RULE_ID, {});
    expect(preview.matched[0].changes.structure).toEqual({
      before: null,
      after: {
        kind: "transfer",
        accountId: LOAN,
        clearCategory: true,
        amount: 640.15,
      },
    });
  });

  it("changes the fingerprint with the parts the plan would write", async () => {
    const a = await setup([unit(row("a", -1500.75))], SPLIT).service.previewRun(
      USER,
      RULE_ID,
      {},
    );
    const b = await setup(
      [
        unit(
          row("a", -1500.75, {
            payeeName: "PRINCIPAL: 1000,50 INTEREST: 500,25",
          }),
        ),
      ],
      SPLIT,
    ).service.previewRun(USER, RULE_ID, {});
    const again = await setup(
      [unit(row("a", -1500.75))],
      SPLIT,
    ).service.previewRun(USER, RULE_ID, {});
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.fingerprint).toBe(again.fingerprint);
  });

  it.each([
    ["split_sum_mismatch", SPLIT, row("a", -1510.75)],
    ["zero_amount", SPLIT, row("a", 0)],
    ["row_is_void", CONVERT, row("a", -10, { status: TransactionStatus.VOID })],
    ["row_has_splits", SPLIT, row("a", -1500.75, { isSplit: true })],
    ["transfer_direction_mismatch", CONVERT, row("a", 10)],
    [
      "split_amount_unparseable",
      SPLIT,
      row("a", -1500.75, { payeeName: "PRINCIPAL: 12 PLN INTEREST: 3,00" }),
    ],
    [
      "split_too_few_parts",
      SPLIT,
      row("a", -85.4, { payeeName: "PRINCIPAL: 0,00 INTEREST: 85,40" }),
    ],
  ])(
    "reports %s under the planner's name and writes nothing",
    async (reason, actions, r) => {
      const { service } = setup([unit(r)], actions);
      const preview = await service.previewRun(USER, RULE_ID, {});
      expect(preview.skipped).toEqual([{ transactionId: "a", reason }]);
      expect(preview.matched).toEqual([]);
      expect(preview.conditionMatchedCount).toBe(1);
    },
  );

  it("reports a transfer leg refused by a structural action as row_is_transfer_leg", async () => {
    const { service } = setup([unit(row("a", -640.15), true)], CONVERT);
    const preview = await service.previewRun(USER, RULE_ID, {});
    expect(preview.skipped).toEqual([
      { transactionId: "a", reason: "row_is_transfer_leg" },
    ]);
  });

  it("reports an account the owner has no open copy of as transfer_account_unavailable", async () => {
    const { service } = setup([unit(row("a", -640.15))], CONVERT, new Map());
    const preview = await service.previewRun(USER, RULE_ID, {});
    expect(preview.skipped).toEqual([
      { transactionId: "a", reason: "transfer_account_unavailable" },
    ]);
  });

  it("reports a currency mismatch", async () => {
    const { service } = setup(
      [unit(row("a", -640.15))],
      CONVERT,
      new Map([[LOAN, { currencyCode: "EUR" }]]),
    );
    const preview = await service.previewRun(USER, RULE_ID, {});
    expect(preview.skipped).toEqual([
      { transactionId: "a", reason: "transfer_currency_mismatch" },
    ]);
  });
});
