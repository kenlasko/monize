jest.mock("./rule-accrual", () => ({
  planRuleAccruals: async () => [],
  ruleAccrualFingerprint: (base: string) => base,
  captureRuleAccrualHistory: async () => undefined,
  assertRuleAccrualWrite: async () => false,
  assertAutomaticRuleSources: async () => undefined,
}));
import { Account, AccountType } from "../accounts/entities/account.entity";
import { AiReviewRequestsService } from "../ai-review/ai-review-requests.service";
import { Category } from "../categories/entities/category.entity";
import { loadLoanSettlementFacts } from "../loan-installments/loan-settlement-facts";
import { Payee } from "../payees/entities/payee.entity";
import { PayeesService } from "../payees/payees.service";
import { Tag } from "../tags/entities/tag.entity";
import { TransactionTag } from "../tags/entities/transaction-tag.entity";
import { TagsService } from "../tags/tags.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { RuleAction } from "./rule-action.types";
import { RuleConditionNode } from "./rule-condition.types";
import { answerLoanFactsLookups, newLoanFactsSource } from "./rule-loan-facts";
import {
  LOAN_ACCOUNT,
  SETTLE_USER,
  SOURCE_ACCOUNT,
  linearLoanFacts,
  settleAction,
} from "./rule-loan-settlement.test-helpers";
import { TransactionRule } from "./transaction-rule.entity";
import {
  MAX_LOAN_FACTS_ROUNDS,
  TransactionRulesApplierService,
} from "./transaction-rules-applier.service";

jest.mock("../loan-installments/loan-settlement-facts", () => ({
  ...jest.requireActual("../loan-installments/loan-settlement-facts"),
  loadLoanSettlementFacts: jest.fn(),
}));
jest.mock("./rule-loan-facts", () => {
  const actual = jest.requireActual("./rule-loan-facts");
  return {
    ...actual,
    answerLoanFactsLookups: jest.fn(actual.answerLoanFactsLookups),
  };
});

/**
 * The applier's loan-facts round (`docs/specs/loan-installment-settlement.md`
 * section 7.1): the plan asks, the applier reads the loan's facts through the
 * loan core in the caller's transaction, unlocked, and plans again; one read
 * per loan serves every row of a call, and the rounds are bounded.
 */
const USER = SETTLE_USER;
const TX1 = "00000000-0000-4000-8000-0000000000f1";
const TX2 = "00000000-0000-4000-8000-0000000000f2";
const RULE_ID = "00000000-0000-4000-8000-0000000000b9";

const loader = loadLoanSettlementFacts as jest.Mock;
const answer = answerLoanFactsLookups as jest.Mock;
const { answerLoanFactsLookups: actualAnswer } =
  jest.requireActual<typeof import("./rule-loan-facts")>("./rule-loan-facts");

const CONDITION: RuleConditionNode = {
  all: [{ field: "payeeText", op: "contains", value: "ING" }],
};

const rule = (actions: RuleAction[]): TransactionRule =>
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

const stored = (id: string, transactionDate: string): Transaction =>
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
  }) as unknown as Transaction;

const input = {
  accountId: SOURCE_ACCOUNT,
  currencyCode: "EUR",
  amount: -1333.33,
  isTransfer: false,
  payeeId: null,
  payeeText: "ING HYPOTHEKEN",
  categoryId: null,
  description: null,
  tagIds: [],
  hasSplits: false,
  transactionDate: "2024-01-03",
  status: "UNRECONCILED",
};

function harness(rows: Transaction[] = []) {
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
  const m = {
    getRepository: jest.fn((entity: unknown) => repos.get(entity)),
    find: jest.fn(async (entity: unknown) =>
      entity === Transaction ? rows : entity === TransactionTag ? [] : [],
    ),
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    insert: jest.fn().mockResolvedValue({}),
  };
  const resolveByName = jest.fn().mockResolvedValue(null);
  const service = new TransactionRulesApplierService(
    {
      addTransactionTags: jest.fn(),
      removeTransactionTags: jest.fn(),
    } as unknown as TagsService,
    { enqueue: jest.fn() } as unknown as AiReviewRequestsService,
    { resolveByName } as unknown as PayeesService,
    {} as never,
    {} as never,
  );
  return { m: m as never, mock: m, service, resolveByName };
}

beforeEach(() => {
  loader.mockReset();
  answer.mockReset();
  answer.mockImplementation(actualAnswer);
});

describe("TransactionRulesApplierService: the loan-facts round", () => {
  it("planForRow reads the loan's facts once, unlocked, over the row's date widened by the largest window, and plans the split", async () => {
    loader.mockResolvedValue(linearLoanFacts());
    const h = harness();
    const effects = await h.service.planForRow(h.m, USER, input, [
      rule([settleAction()]),
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith(
      h.m,
      USER,
      {
        loanAccountId: LOAN_ACCOUNT,
        sourceAccountId: SOURCE_ACCOUNT,
        // 2024-01-03 plus and minus 31 days.
        window: { from: "2023-12-03", to: "2024-02-03" },
        rowIds: [],
      },
      { lock: false },
    );
    expect(effects.loanFactsLookups).toBeUndefined();
    expect(effects.changes.structure).toMatchObject({
      kind: "split",
      parts: [{ amount: -833.33 }, { amount: -500 }],
    });
    expect(effects.changes.loanSettlement?.dueDate).toBe("2024-01-01");
  });

  it("applyToNew reads each loan once for every row of the call, with every row id", async () => {
    // A loan without a scheduled payment: each row is refused by name, so
    // nothing is written while the write path is not there yet (B5).
    loader.mockResolvedValue(linearLoanFacts({ schedule: null }));
    const h = harness([stored(TX1, "2024-01-03"), stored(TX2, "2024-02-02")]);
    const applied = await h.service.applyToNew(
      h.m,
      USER,
      [TX1, TX2],
      "import",
      {
        rules: [rule([settleAction()])],
      },
    );
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader.mock.calls[0][2]).toEqual({
      loanAccountId: LOAN_ACCOUNT,
      sourceAccountId: SOURCE_ACCOUNT,
      window: { from: "2023-12-03", to: "2024-03-04" },
      rowIds: [TX1, TX2],
    });
    expect(applied.map((a) => a.effects.trace[0].skipped)).toEqual([
      [
        {
          type: "settle_loan_installment",
          reason: "loan_not_configured",
          detail: { missing: ["scheduledPayment"] },
        },
      ],
      [
        {
          type: "settle_loan_installment",
          reason: "loan_not_configured",
          detail: { missing: ["scheduledPayment"] },
        },
      ],
    ]);
    expect(applied.every((a) => a.affectedAccountIds.length === 0)).toBe(true);
    expect(h.mock.insert).not.toHaveBeenCalled();
  });

  it("answers a payee lookup and a loan lookup of the same plan", async () => {
    loader.mockResolvedValue(linearLoanFacts());
    const h = harness();
    const effects = await h.service.planForRow(h.m, USER, input, [
      rule([
        {
          type: "set_payee_from_text",
          template: "ING Bank",
          createIfMissing: false,
          onlyIfEmpty: true,
        },
        settleAction(),
      ]),
    ]);
    expect(h.resolveByName).toHaveBeenCalledWith(USER, "ING Bank");
    expect(loader).toHaveBeenCalledTimes(1);
    expect(effects.trace[0].skipped).toEqual([
      { type: "set_payee_from_text", reason: "payee_not_found" },
    ]);
    expect(effects.changes.loanSettlement?.dueDate).toBe("2024-01-01");
  });

  it(`stops after ${MAX_LOAN_FACTS_ROUNDS} rounds when the plan keeps asking`, async () => {
    // A read that reports progress but never answers the lookup.
    answer.mockResolvedValue(true);
    const h = harness();
    const effects = await h.service.planForRow(h.m, USER, input, [
      rule([settleAction()]),
    ]);
    expect(answer).toHaveBeenCalledTimes(MAX_LOAN_FACTS_ROUNDS);
    expect(effects.trace[0].skipped).toEqual([
      { type: "settle_loan_installment", reason: "loan_facts_unresolved" },
    ]);
  });

  it("without a loan source the plan waits rather than guessing", async () => {
    const h = harness();
    const effects = await h.service.planResolved(
      USER,
      input,
      [rule([settleAction()])],
      new Map(),
      {
        accounts: new Map([[LOAN_ACCOUNT, { currencyCode: "EUR" }]]),
      },
    );
    expect(loader).not.toHaveBeenCalled();
    expect(effects.loanFactsLookups).toHaveLength(1);
    expect(effects.changes.structure).toBeUndefined();
  });
});

describe("answerLoanFactsLookups", () => {
  const lookup = (from: string, to: string, transactionId?: string) => ({
    loanAccountId: LOAN_ACCOUNT,
    sourceAccountId: SOURCE_ACCOUNT,
    window: { from, to },
    ...(transactionId === undefined ? {} : { transactionId }),
  });

  it("without a pass reads exactly the row's window, and a covered lookup reads nothing", async () => {
    loader.mockResolvedValue(linearLoanFacts());
    const source = newLoanFactsSource({} as never, USER);
    expect(source.passWindow).toBeNull();
    expect(
      await answerLoanFactsLookups(source, [
        lookup("2024-01-01", "2024-01-10"),
      ]),
    ).toBe(true);
    expect(loader.mock.calls[0][2].window).toEqual({
      from: "2024-01-01",
      to: "2024-01-10",
    });
    expect(
      await answerLoanFactsLookups(source, [
        lookup("2024-01-02", "2024-01-09"),
      ]),
    ).toBe(false);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("widens a read that misses a row: the union of the windows and of the row ids", async () => {
    loader.mockResolvedValue(linearLoanFacts());
    const source = newLoanFactsSource({} as never, USER, {
      rowIds: [TX1, TX1],
      dates: ["2024-01-03", null, "not a date"],
    });
    expect(source.rowIds).toEqual([TX1]);
    await answerLoanFactsLookups(source, [
      lookup("2024-03-01", "2024-03-10", TX2),
    ]);
    expect(loader.mock.calls[0][2]).toMatchObject({
      window: { from: "2023-12-03", to: "2024-03-10" },
      rowIds: [TX1, TX2],
    });
    expect(source.entries.get(LOAN_ACCOUNT)?.rowIds).toEqual(
      new Set([TX1, TX2]),
    );
  });
});
