jest.mock("./rule-accrual", () => ({
  planRuleAccruals: async () => [],
  ruleAccrualFingerprint: (base: string) => base,
  captureRuleAccrualHistory: async () => undefined,
  assertRuleAccrualWrite: async () => false,
  assertAutomaticRuleSources: async () => undefined,
}));
import { ConflictException } from "@nestjs/common";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { AiReviewRequestsService } from "../ai-review/ai-review-requests.service";
import { Category } from "../categories/entities/category.entity";
import { claimLoanOccurrence } from "../loan-installments/claim-loan-occurrence";
import { loadLoanSettlementFacts } from "../loan-installments/loan-settlement-facts";
import { Payee } from "../payees/entities/payee.entity";
import { PayeesService } from "../payees/payees.service";
import { Tag } from "../tags/entities/tag.entity";
import { TransactionTag } from "../tags/entities/transaction-tag.entity";
import { TagsService } from "../tags/tags.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionRuleApplication } from "./transaction-rule-application.entity";
import { RuleAction } from "./rule-action.types";
import { RuleConditionNode } from "./rule-condition.types";
import {
  INTEREST_CATEGORY,
  LOAN_ACCOUNT,
  LOAN_SCHEDULE,
  SETTLE_USER,
  SOURCE_ACCOUNT,
  linearLoanFacts,
  loanClaim,
  settleAction,
} from "./rule-loan-settlement.test-helpers";
import { TransactionRule } from "./transaction-rule.entity";
import { TransactionRulesApplierService } from "./transaction-rules-applier.service";

jest.mock("../loan-installments/loan-settlement-facts", () => ({
  ...jest.requireActual("../loan-installments/loan-settlement-facts"),
  loadLoanSettlementFacts: jest.fn(),
}));
jest.mock("../loan-installments/claim-loan-occurrence", () => ({
  ...jest.requireActual("../loan-installments/claim-loan-occurrence"),
  claimLoanOccurrence: jest.fn(),
}));

/**
 * The write path of `settle_loan_installment` through `applyToNew`
 * (`docs/specs/loan-installment-settlement.md` section 12.1): the split
 * through the split writer, then the claim with the written row's id and the
 * planning rule's id, the written effects carrying the claim, the schedule
 * reported for the caller's after-commit reprice, the facts read under the
 * locks, and the backstop: the conflict throws, and the planner's refusal
 * keeps it unreachable on the ordinary path. Fixtures from spec section 9.1.
 */
const USER = SETTLE_USER;
const RULE_ID = "00000000-0000-4000-8000-0000000000b9";
const TX1 = "00000000-0000-4000-8000-0000000000f1";
const TX2 = "00000000-0000-4000-8000-0000000000f2";
const COUNTERPART = "00000000-0000-4000-8000-0000000000c9";
const CLAIM = "00000000-0000-4000-8000-0000000000d1";

const loader = loadLoanSettlementFacts as jest.Mock;
const claim = claimLoanOccurrence as jest.Mock;

const CONDITION: RuleConditionNode = {
  all: [{ field: "payeeText", op: "contains", value: "ING" }],
};

const rule = (actions: RuleAction[] = [settleAction()]): TransactionRule =>
  ({
    id: RULE_ID,
    userId: USER,
    name: "Hypotheek",
    enabled: true,
    position: 0,
    triggers: ["create", "import"],
    condition: CONDITION,
    actions,
    stopProcessing: false,
    revision: 1,
  }) as TransactionRule;

const stored = (
  id: string,
  transactionDate: string,
  over: Partial<Transaction> = {},
): Transaction =>
  ({
    id,
    userId: USER,
    accountId: SOURCE_ACCOUNT,
    currencyCode: "EUR",
    amount: "-1333.3300",
    isTransfer: false,
    linkedTransactionId: null,
    payeeId: null,
    payeeName: "ING HYPOTHEKEN",
    categoryId: null,
    description: null,
    isSplit: false,
    status: "UNRECONCILED",
    transactionDate,
    referenceNumber: null,
    ...over,
  }) as unknown as Transaction;

const cursorChange = {
  before: {
    nextDueDate: "2024-01-01",
    occurrencesRemaining: null,
    isActive: true,
    lastPostedDate: null,
  },
  after: {
    nextDueDate: "2024-02-01",
    occurrencesRemaining: null,
    isActive: true,
    lastPostedDate: "2024-01-03",
  },
  prunedOverrides: [],
};

function harness(rows: Transaction[]) {
  const order: string[] = [];
  const repos = new Map<unknown, unknown>([
    [
      Account,
      {
        find: jest.fn().mockResolvedValue([
          {
            id: LOAN_ACCOUNT,
            currencyCode: "EUR",
            accountType: AccountType.MORTGAGE,
            interestBookingMode: "AUTO",
          },
        ]),
      },
    ],
    [Category, { find: jest.fn().mockResolvedValue([]) }],
    [Payee, { find: jest.fn().mockResolvedValue([]) }],
    [Tag, { find: jest.fn().mockResolvedValue([]) }],
  ]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const m = {
    getRepository: jest.fn((entity: unknown) => repos.get(entity)),
    find: jest.fn(async (entity: unknown) =>
      entity === Transaction ? rows : entity === TransactionTag ? [] : [],
    ),
    findOne: jest.fn(
      async (entity: unknown, options: { where: { id: string } }) =>
        entity === Transaction ? (byId.get(options.where.id) ?? null) : null,
    ),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    insert: jest.fn().mockResolvedValue({}),
  };
  const splits = {
    validateSplits: jest.fn(),
    createSplits: jest.fn(async (...args: unknown[]) => {
      order.push("split");
      (args[8] as Set<string>).add(LOAN_ACCOUNT);
      return [
        { id: "line-principal", linkedTransactionId: COUNTERPART },
        { id: "line-interest", linkedTransactionId: null },
      ];
    }),
  };
  claim.mockImplementation(async () => {
    order.push("claim");
    return {
      claimId: CLAIM,
      scheduledTransactionId: LOAN_SCHEDULE,
      dueDate: "2024-01-01",
      cursorAdvanced: true,
      cursor: cursorChange,
    };
  });
  const service = new TransactionRulesApplierService(
    {
      addTransactionTags: jest.fn(),
      removeTransactionTags: jest.fn(),
    } as unknown as TagsService,
    { enqueue: jest.fn() } as unknown as AiReviewRequestsService,
    {
      resolveByName: jest.fn().mockResolvedValue(null),
    } as unknown as PayeesService,
    {} as never,
    splits as never,
  );
  return { m: m as never, mock: m, splits, service, order };
}

beforeEach(() => {
  loader.mockReset();
  claim.mockReset();
});

describe("TransactionRulesApplierService: writing a settlement", () => {
  it("writes the split, then claims the occurrence with the written row, the planning rule and the row's date, and reports the claim", async () => {
    loader.mockResolvedValue(linearLoanFacts());
    const h = harness([stored(TX1, "2024-01-03")]);

    const [applied] = await h.service.applyToNew(h.m, USER, [TX1], "import", {
      rules: [rule()],
    });

    expect(h.order).toEqual(["split", "claim"]);
    // The split the planner priced: 833.33 principal to the loan, 500.00 interest.
    expect(h.splits.validateSplits).toHaveBeenCalledWith(
      [
        { amount: -833.33, transferAccountId: LOAN_ACCOUNT, memo: "Principal" },
        { amount: -500, categoryId: INTEREST_CATEGORY, memo: "Interest" },
      ],
      -1333.33,
    );
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith(h.m, USER, {
      plan: expect.objectContaining({
        scheduledTransactionId: LOAN_SCHEDULE,
        dueDate: "2024-01-01",
        debtBefore: 300000,
        principal: 833.33,
        interest: 500,
        advancesCursor: true,
      }),
      transactionId: TX1,
      ruleId: RULE_ID,
      postedDate: "2024-01-03",
    });
    expect(applied.affectedAccountIds).toEqual([LOAN_ACCOUNT]);
    expect(applied.settledScheduleIds).toEqual([LOAN_SCHEDULE]);
    expect(applied.effects.changes.settlementClaim).toEqual({
      claimId: CLAIM,
      scheduledTransactionId: LOAN_SCHEDULE,
      dueDate: "2024-01-01",
      cursorAdvanced: true,
      cursor: cursorChange,
    });
    expect(applied.effects.changes.structure).toMatchObject({
      kind: "split",
      counterpartIds: [COUNTERPART],
      lineIds: ["line-principal", "line-interest"],
    });
  });

  it("stores the claim id and the cursor before and after on the trace, beside the planned pricing", async () => {
    loader.mockResolvedValue(linearLoanFacts());
    const h = harness([stored(TX1, "2024-01-03")]);

    const [applied] = await h.service.applyToNew(h.m, USER, [TX1], "import", {
      rules: [rule()],
    });

    const traced = applied.effects.trace[0].changes.loanSettlement;
    expect(traced).toMatchObject({
      before: null,
      after: {
        loanAccountId: LOAN_ACCOUNT,
        scheduledTransactionId: LOAN_SCHEDULE,
        dueDate: "2024-01-01",
        installmentNumber: 1,
        pricing: { debtBefore: "300000.0000", outcome: "exact" },
        claimId: CLAIM,
        cursorAdvanced: true,
        cursor: { before: cursorChange.before, after: cursorChange.after },
      },
    });
    // The stored application row is the trace entry as written.
    expect(h.mock.insert).toHaveBeenCalledWith(TransactionRuleApplication, [
      expect.objectContaining({
        ruleId: RULE_ID,
        transactionId: TX1,
        source: "import",
        changes: expect.objectContaining({
          loanSettlement: expect.objectContaining({
            after: expect.objectContaining({ claimId: CLAIM }),
          }),
        }),
      }),
    ]);
  });

  it("reads the loan's facts under the locks on this write path, with the posting flag refusing a bill's own row", async () => {
    loader.mockResolvedValue(linearLoanFacts());
    const h = harness([stored(TX1, "2024-01-03")]);

    const [applied] = await h.service.applyToNew(h.m, USER, [TX1], "create", {
      rules: [rule()],
      fromScheduledPosting: true,
    });

    expect(loader).toHaveBeenCalledTimes(0);
    // Refused before the facts are needed: the row pays the occurrence
    // post() claimed, so nothing is read, written or claimed.
    expect(applied.effects.trace[0].skipped).toEqual([
      { type: "settle_loan_installment", reason: "row_from_scheduled_posting" },
    ]);
    expect(h.splits.createSplits).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(applied.settledScheduleIds).toEqual([]);
  });

  it("asks the loader to lock on applyToNew", async () => {
    loader.mockResolvedValue(linearLoanFacts());
    const h = harness([stored(TX1, "2024-01-03")]);
    await h.service.applyToNew(h.m, USER, [TX1], "import", { rules: [rule()] });
    expect(loader).toHaveBeenCalledWith(
      h.m,
      USER,
      expect.objectContaining({ loanAccountId: LOAN_ACCOUNT }),
      { lock: true },
    );
  });

  describe("the backstop", () => {
    it("is unreachable on the ordinary path: a slot the facts show claimed is refused by the planner, and nothing is written or claimed", async () => {
      loader.mockResolvedValue(
        linearLoanFacts({ claims: [loanClaim("2024-01-01")] }),
      );
      const h = harness([stored(TX1, "2024-01-03")]);

      const [applied] = await h.service.applyToNew(h.m, USER, [TX1], "import", {
        rules: [rule()],
      });

      expect(applied.effects.trace[0].skipped).toEqual([
        {
          type: "settle_loan_installment",
          reason: "occurrence_already_posted",
          detail: { dueDates: ["2024-01-01"] },
        },
      ]);
      expect(h.splits.createSplits).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(h.mock.insert).not.toHaveBeenCalled();
    });

    it("throws the claim's conflict when the INSERT finds the slot taken, so the caller's transaction rolls the split back", async () => {
      loader.mockResolvedValue(linearLoanFacts());
      const h = harness([stored(TX1, "2024-01-03")]);
      claim.mockRejectedValue(
        new ConflictException({ errorCode: "OCCURRENCE_ALREADY_POSTED" }),
      );

      await expect(
        h.service.applyToNew(h.m, USER, [TX1], "import", { rules: [rule()] }),
      ).rejects.toBeInstanceOf(ConflictException);
      // The split was written first; the throw is what undoes it, with the
      // transaction (nothing here records a refusal it did not plan).
      expect(h.splits.createSplits).toHaveBeenCalledTimes(1);
      expect(h.mock.insert).not.toHaveBeenCalled();
    });

    it("re-reads the loan after a settlement it wrote, so a second row for the same slot is refused by the planner rather than reaching the conflict", async () => {
      // First read: the slot is free. After the first row settles it, the
      // facts are read again and show the claim the write left.
      loader.mockResolvedValueOnce(linearLoanFacts()).mockResolvedValueOnce(
        linearLoanFacts({
          claims: [
            loanClaim("2024-01-01", { source: "rule", transactionId: TX1 }),
          ],
        }),
      );
      const h = harness([stored(TX1, "2024-01-03"), stored(TX2, "2024-01-04")]);

      const applied = await h.service.applyToNew(
        h.m,
        USER,
        [TX1, TX2],
        "import",
        { rules: [rule()] },
      );

      expect(loader).toHaveBeenCalledTimes(2);
      expect(claim).toHaveBeenCalledTimes(1);
      expect(applied[0].settledScheduleIds).toEqual([LOAN_SCHEDULE]);
      expect(applied[1].effects.trace[0].skipped).toEqual([
        {
          type: "settle_loan_installment",
          reason: "occurrence_already_posted",
          detail: { dueDates: ["2024-01-01"] },
        },
      ]);
      expect(applied[1].settledScheduleIds).toEqual([]);
    });
  });

  it("a split rule without a settlement claims nothing and reports no schedule", async () => {
    const h = harness([
      stored(TX1, "2024-01-03", {
        payeeName: "PRINCIPAL: 833,33 INTEREST: 500,00",
      }),
    ]);
    const [applied] = await h.service.applyToNew(h.m, USER, [TX1], "import", {
      rules: [
        {
          ...rule(),
          condition: {
            field: "payeeText",
            op: "matches",
            value: "PRINCIPAL: {principal} INTEREST: {interest}",
          },
          actions: [
            {
              type: "split",
              parts: [
                { amount: "{principal}", transferAccountId: LOAN_ACCOUNT },
                { amount: "{interest}", categoryId: INTEREST_CATEGORY },
              ],
            },
          ],
        } as TransactionRule,
      ],
    });
    expect(h.splits.createSplits).toHaveBeenCalledTimes(1);
    expect(claim).not.toHaveBeenCalled();
    expect(applied.settledScheduleIds).toEqual([]);
    expect(applied.effects.changes.settlementClaim).toBeUndefined();
  });
});

/**
 * INV-RULE-005 on the write path: `applyToNew` plans its rows oldest first
 * whatever order the caller listed them in, writes each settlement before the
 * next row plans, and reads the loan again after the write, so the next row
 * is priced on the ledger the write left and nothing is folded twice (spec
 * section 7.2). Fixtures from spec section 9.1.
 */
describe("TransactionRulesApplierService: the rows of one call, oldest first", () => {
  it("plans the older row first though it was listed second, and prices the next on the ledger the write left, folding nothing twice", async () => {
    // What the loader reads after January is written: its claim, and the
    // counterpart dated 2024-01-03 in the debt of every slot from then on.
    const afterJanuary = (): ReturnType<typeof linearLoanFacts> => {
      const facts = linearLoanFacts({
        claims: [
          loanClaim("2024-01-01", { source: "rule", transactionId: TX1 }),
        ],
      });
      return {
        ...facts,
        debtByDueDate: new Map(
          [...facts.debtByDueDate.keys()].map((date) => [
            date,
            date >= "2024-01-03" ? 299166.67 : 300000,
          ]),
        ),
      };
    };
    loader
      .mockResolvedValueOnce(linearLoanFacts())
      .mockResolvedValueOnce(afterJanuary());
    const h = harness([
      stored(TX2, "2024-02-02", { amount: "-1331.9400" as never }),
      stored(TX1, "2024-01-03"),
    ]);

    const applied = await h.service.applyToNew(
      h.m,
      USER,
      [TX2, TX1],
      "import",
      {
        rules: [rule()],
      },
    );

    expect(applied.map((row) => row.transactionId)).toEqual([TX1, TX2]);
    expect(
      claim.mock.calls.map((call) => [
        call[2].transactionId,
        call[2].plan.dueDate,
        call[2].plan.debtLedger,
        call[2].plan.foldedPrincipal,
        call[2].plan.debtBefore,
        call[2].plan.interest,
      ]),
    ).toEqual([
      [TX1, "2024-01-01", 300000, 0, 300000, 500],
      [TX2, "2024-02-01", 299166.67, 0, 299166.67, 498.61],
    ]);
    // The loan was read again after the first write, under the locks both times.
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader.mock.calls.map((call) => call[3])).toEqual([
      { lock: true },
      { lock: true },
    ]);
  });
});
