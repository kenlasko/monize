jest.mock("./rule-accrual", () => ({
  planRuleAccruals: async () => [],
  ruleAccrualFingerprint: (base: string) => base,
  captureRuleAccrualHistory: async () => undefined,
  assertRuleAccrualWrite: async () => false,
  assertAutomaticRuleSources: async () => undefined,
}));
import { DataSource } from "typeorm";
import { ActionHistoryService } from "../action-history/action-history.service";
import { AccountType } from "../accounts/entities/account.entity";
import { loadLoanSettlementFacts } from "../loan-installments/loan-settlement-facts";
import { repriceSettledLoanTemplates } from "../loan-installments/reprice-template";
import { LOAN_SCHEDULE } from "./rule-loan-settlement.test-helpers";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionStatus } from "../transactions/entities/transaction-status.enum";
import { isReconciledLockEnabled } from "../transactions/reconciled-lock.util";
import { RuleAction } from "./rule-action.types";
import { RuleConditionNode } from "./rule-condition.types";
import { loadAttachmentPresence } from "./rule-facts";
import {
  LOAN_ACCOUNT,
  SETTLE_USER,
  SOURCE_ACCOUNT,
  linearLoanFacts,
  loanClaim,
  settleAction,
} from "./rule-loan-settlement.test-helpers";
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
jest.mock("../loan-installments/loan-settlement-facts", () => ({
  ...jest.requireActual("../loan-installments/loan-settlement-facts"),
  loadLoanSettlementFacts: jest.fn(),
}));
jest.mock("../loan-installments/reprice-template", () => ({
  repriceSettledLoanTemplates: jest.fn().mockResolvedValue(undefined),
}));

/**
 * `settle_loan_installment` through the manual run's preview: the planned
 * split and settlement per row, each refusal under its own name with what it
 * names, and one read of the loan's facts for the batch.
 */
const USER = SETTLE_USER;
const RULE_ID = "e0000000-0000-4000-8000-000000000005";

const CONDITION: RuleConditionNode = {
  field: "payeeText",
  op: "contains",
  value: "ING",
};

const storedRule = (
  actions: RuleAction[] = [settleAction()],
): TransactionRule =>
  ({
    id: RULE_ID,
    userId: USER,
    name: "Hypotheek",
    enabled: true,
    position: 0,
    triggers: ["create", "import"],
    condition: CONDITION,
    actions,
    stopProcessing: true,
    activeFrom: null,
    activeTo: null,
    revision: 1,
  }) as TransactionRule;

const row = (id: string, amount: number, transactionDate: string) =>
  ({
    id,
    userId: USER,
    accountId: SOURCE_ACCOUNT,
    currencyCode: "EUR",
    amount,
    transactionDate,
    isTransfer: false,
    linkedTransactionId: null,
    parentTransactionId: null,
    payeeId: null,
    payeeName: "ING HYPOTHEKEN",
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

function setup(units: CandidateUnit[], actions?: RuleAction[]) {
  (loadCandidateUnits as jest.Mock).mockResolvedValue({
    units,
    truncated: false,
  });
  (loadRuleTargetAccounts as jest.Mock).mockResolvedValue(
    new Map([
      [
        LOAN_ACCOUNT,
        {
          currencyCode: "EUR",
          accountType: AccountType.MORTGAGE,
          interestBookingMode: "AUTO",
        },
      ],
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
    accounts: { [LOAN_ACCOUNT]: "Hypotheek" },
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
  return { service, applier };
}

describe("TransactionRulesRunService: settle_loan_installment in the preview", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows the planned split and settlement per row, and each refusal with what it names", async () => {
    // Slot 2024-02-01 is already claimed by a posted bill.
    (loadLoanSettlementFacts as jest.Mock).mockResolvedValue(
      linearLoanFacts({ claims: [loanClaim("2024-02-01")] }),
    );
    const { service } = setup([
      unit(row("settled", -1333.33, "2024-01-03")),
      unit(row("taken", -1333.33, "2024-02-02")),
      unit(row("short", -1300, "2024-03-01")),
      unit(row("income", 1333.33, "2024-04-01")),
    ]);
    const preview = await service.previewRun(USER, RULE_ID, {});

    // One read of the loan for the whole batch, unlocked, with every row id.
    expect(loadLoanSettlementFacts).toHaveBeenCalledTimes(1);
    expect((loadLoanSettlementFacts as jest.Mock).mock.calls[0][2]).toEqual({
      loanAccountId: LOAN_ACCOUNT,
      sourceAccountId: SOURCE_ACCOUNT,
      window: { from: "2023-12-03", to: "2024-05-02" },
      rowIds: ["settled", "taken", "short", "income"],
    });
    expect((loadLoanSettlementFacts as jest.Mock).mock.calls[0][3]).toEqual({
      lock: false,
    });

    expect(preview.matched.map((m) => m.transactionId)).toEqual(["settled"]);
    expect(preview.matched[0].changes.structure).toMatchObject({
      before: null,
      after: { kind: "split", parts: [{ amount: -833.33 }, { amount: -500 }] },
    });
    expect(preview.matched[0].changes.loanSettlement).toMatchObject({
      before: null,
      after: { dueDate: "2024-01-01", installmentNumber: 1 },
    });

    expect(preview.skipped).toEqual([
      {
        transactionId: "taken",
        reason: "occurrence_already_posted",
        detail: { dueDates: ["2024-02-01"] },
      },
      {
        transactionId: "short",
        reason: "installment_amount_shortfall",
        // Priced on the debt the first row's planned settlement leaves
        // (300,000 less 833.33: 833.33 + 498.61, spec section 9.1 row 5),
        // not on the ledger's 300,000 (INV-RULE-005).
        detail: {
          dueDate: "2024-03-01",
          expected: 1331.94,
          paid: 1300,
        },
      },
      { transactionId: "income", reason: "row_is_income" },
    ]);
    expect(preview.conditionMatchedCount).toBe(4);
  });
});

describe("TransactionRulesRunService: settle_loan_installment at the commit", () => {
  beforeEach(() => jest.clearAllMocks());

  it("re-plans under the locks, writes the settlement through the applier and reprices the schedule after the commit", async () => {
    (loadLoanSettlementFacts as jest.Mock).mockResolvedValue(linearLoanFacts());
    const { service, applier } = setup([
      unit(row("settled", -1333.33, "2024-01-03")),
    ]);
    const order: string[] = [];
    const writeEffects = jest
      .spyOn(applier, "writeEffects")
      .mockImplementation(
        async (_m, _u, _id, effects, _s, affected, settled) => {
          order.push("write");
          affected?.add(LOAN_ACCOUNT);
          settled?.add(LOAN_SCHEDULE);
          return effects;
        },
      );
    (repriceSettledLoanTemplates as jest.Mock).mockImplementation(async () => {
      order.push("reprice");
    });

    const preview = await service.previewRun(USER, RULE_ID, {});
    await service.run(USER, RULE_ID, { fingerprint: preview.fingerprint });

    // The preview read unlocked; the commit reads under the schedule row and
    // account locks (spec section 13), and plans once.
    const reads = (loadLoanSettlementFacts as jest.Mock).mock.calls.map(
      (call) => call[3],
    );
    expect(reads).toEqual([{ lock: false }, { lock: true }]);
    expect(writeEffects).toHaveBeenCalledTimes(1);
    expect(writeEffects.mock.calls[0][3].changes.loanSettlement).toMatchObject({
      dueDate: "2024-01-01",
      debtBefore: 300000,
    });
    expect(repriceSettledLoanTemplates).toHaveBeenCalledWith(
      expect.anything(),
      new Set([LOAN_SCHEDULE]),
    );
    expect(order).toEqual(["write", "reprice"]);
  });

  it("refuses the commit as a changed preview when the debt the settlement is priced on moved since the preview", async () => {
    (loadLoanSettlementFacts as jest.Mock)
      .mockResolvedValueOnce(linearLoanFacts())
      // A principal payment landed in between: the slot's debt is lower.
      .mockResolvedValueOnce({
        ...linearLoanFacts(),
        debtByDueDate: new Map(
          [...linearLoanFacts().debtByDueDate.keys()].map((date) => [
            date,
            299000,
          ]),
        ),
      });
    const { service, applier } = setup([
      unit(row("settled", -1333.33, "2024-01-03")),
    ]);
    const writeEffects = jest.spyOn(applier, "writeEffects");

    const preview = await service.previewRun(USER, RULE_ID, {});
    await expect(
      service.run(USER, RULE_ID, { fingerprint: preview.fingerprint }),
    ).rejects.toMatchObject({ response: { errorCode: "PREVIEW_CHANGED" } });
    expect(writeEffects).not.toHaveBeenCalled();
    expect(repriceSettledLoanTemplates).not.toHaveBeenCalled();
  });
});

/**
 * INV-RULE-005 through the manual run (spec sections 7.2 and 9.4): a rule
 * that settles scans oldest first, each row is priced on the ledger debt less
 * the principal planned for the rows before it, the preview and the commit
 * fold through the same code and hash the same, and a payment that lands
 * between two rows after the preview refuses the commit. Fixtures from spec
 * section 9.1: 300,000 at 2 % LINEAR, slot 1 is 833.33 + 500.00, slot 2 on
 * 299,166.67 is 833.33 + 498.61, slot 3 on 298,333.34 is 833.34 + 497.22
 * (priced 1,330.5555, booked 1,330.56 with the principal taking the remainder).
 */
describe("TransactionRulesRunService: the chronological fold (INV-RULE-005)", () => {
  beforeEach(() => jest.clearAllMocks());

  const threeMonths = () => [
    unit(row("jan", -1333.33, "2024-01-03")),
    unit(row("feb", -1331.94, "2024-02-02")),
    unit(row("mar", -1330.56, "2024-03-04")),
  ];

  it("scans oldest first for a rule that settles, and newest first for any other", async () => {
    (loadLoanSettlementFacts as jest.Mock).mockResolvedValue(linearLoanFacts());
    const settling = setup(threeMonths());
    const preview = await settling.service.previewRun(USER, RULE_ID, {});
    expect((loadCandidateUnits as jest.Mock).mock.calls[0][3]).toEqual({
      lock: false,
      direction: "ASC",
    });
    expect(preview.scanOrder).toBe("oldest_first");
    // The next page of "Process history" starts on the last row examined.
    expect(preview.scannedThrough).toBe("2024-03-04");

    (loadCandidateUnits as jest.Mock).mockClear();
    const plain = setup(threeMonths(), [
      {
        type: "set_description",
        template: "Mortgage",
        mode: "replace",
        onlyIfEmpty: false,
      },
    ]);
    const plainPreview = await plain.service.previewRun(USER, RULE_ID, {});
    expect((loadCandidateUnits as jest.Mock).mock.calls[0][3]).toEqual({
      lock: false,
      direction: "DESC",
    });
    expect(plainPreview.scanOrder).toBe("newest_first");
  });

  it("prices each row on the ledger debt less the principal planned for the rows before it, and keeps their slots from it", async () => {
    (loadLoanSettlementFacts as jest.Mock).mockResolvedValue(linearLoanFacts());
    const { service } = setup(threeMonths());

    const preview = await service.previewRun(USER, RULE_ID, {});

    expect(preview.skipped).toEqual([]);
    const settlements = preview.matched.map(
      (m) =>
        m.changes.loanSettlement.after as {
          dueDate: string;
          pricing: {
            debtLedger: string;
            foldedPrincipal: string;
            debtBefore: string;
            lines: { principal: string; interest: string; extra: string };
            outcome: string;
          };
        },
    );
    expect(settlements.map((s) => s.dueDate)).toEqual([
      "2024-01-01",
      "2024-02-01",
      "2024-03-01",
    ]);
    // The ledger holds 300,000 at every slot (nothing is written); the fold
    // subtracts what the earlier rows of this pass will write.
    expect(settlements.map((s) => s.pricing.debtLedger)).toEqual([
      "300000.0000",
      "300000.0000",
      "300000.0000",
    ]);
    expect(settlements.map((s) => s.pricing.foldedPrincipal)).toEqual([
      "0.0000",
      "833.3300",
      "1666.6600",
    ]);
    expect(settlements.map((s) => s.pricing.debtBefore)).toEqual([
      "300000.0000",
      "299166.6700",
      "298333.3400",
    ]);
    expect(settlements.map((s) => s.pricing.lines)).toEqual([
      { principal: "833.33", interest: "500.00", extra: "0.00" },
      { principal: "833.33", interest: "498.61", extra: "0.00" },
      { principal: "833.34", interest: "497.22", extra: "0.00" },
    ]);
    expect(settlements.map((s) => s.pricing.outcome)).toEqual([
      "exact",
      "exact",
      "exact",
    ]);
    // One read of the loan serves the pass; the fold needs no second one.
    expect(loadLoanSettlementFacts).toHaveBeenCalledTimes(1);
  });

  it("commits the preview's fold under the locks: the same fingerprint, and each write priced on the chain", async () => {
    (loadLoanSettlementFacts as jest.Mock).mockResolvedValue(linearLoanFacts());
    const { service, applier } = setup(threeMonths());
    const writeEffects = jest
      .spyOn(applier, "writeEffects")
      .mockImplementation(async (_m, _u, _id, effects) => effects);

    const preview = await service.previewRun(USER, RULE_ID, {});
    const result = await service.run(USER, RULE_ID, {
      fingerprint: preview.fingerprint,
    });

    expect(result).toMatchObject({ changed: 3, skipped: [] });
    expect(
      writeEffects.mock.calls.map((call) => [
        call[2],
        call[3].changes.loanSettlement?.debtBefore,
        call[3].changes.loanSettlement?.foldedPrincipal,
      ]),
    ).toEqual([
      ["jan", 300000, 0],
      ["feb", 299166.67, 833.33],
      ["mar", 298333.34, 1666.66],
    ]);
    const reads = (loadLoanSettlementFacts as jest.Mock).mock.calls.map(
      (call) => call[3],
    );
    expect(reads).toEqual([{ lock: false }, { lock: true }]);
  });

  it("refuses the commit as a changed preview when a payment landed between two of the rows since the preview", async () => {
    const paidDown = (): ReturnType<typeof linearLoanFacts> => {
      const facts = linearLoanFacts();
      return {
        ...facts,
        // A 200.00 principal payment dated between the first and the second
        // row: the debt at every slot from February on is lower.
        debtByDueDate: new Map(
          [...facts.debtByDueDate.keys()].map((date) => [
            date,
            date >= "2024-02-01" ? 299800 : 300000,
          ]),
        ),
      };
    };
    (loadLoanSettlementFacts as jest.Mock)
      .mockResolvedValueOnce(linearLoanFacts())
      .mockResolvedValueOnce(paidDown());
    const { service, applier } = setup(threeMonths());
    const writeEffects = jest.spyOn(applier, "writeEffects");

    const preview = await service.previewRun(USER, RULE_ID, {});
    await expect(
      service.run(USER, RULE_ID, { fingerprint: preview.fingerprint }),
    ).rejects.toMatchObject({ response: { errorCode: "PREVIEW_CHANGED" } });
    expect(writeEffects).not.toHaveBeenCalled();
    expect(repriceSettledLoanTemplates).not.toHaveBeenCalled();
  });
});
