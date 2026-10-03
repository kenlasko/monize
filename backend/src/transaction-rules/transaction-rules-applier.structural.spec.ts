import { In } from "typeorm";
import { Account } from "../accounts/entities/account.entity";
import { AiReviewRequestsService } from "../ai-review/ai-review-requests.service";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { PayeesService } from "../payees/payees.service";
import { Tag } from "../tags/entities/tag.entity";
import { TransactionTag } from "../tags/entities/transaction-tag.entity";
import { TagsService } from "../tags/tags.service";
import { convertRowToTransfer } from "../transactions/convert-to-transfer";
import { Transaction } from "../transactions/entities/transaction.entity";
import { RuleAction } from "./rule-action.types";
import { RuleConditionNode } from "./rule-condition.types";
import {
  loadRuleTargetAccounts,
  structuralTargetIds,
} from "./rule-target-accounts";
import { TransactionRule } from "./transaction-rule.entity";
import { TransactionRulesApplierService } from "./transaction-rules-applier.service";

jest.mock("../transactions/convert-to-transfer", () => ({
  convertRowToTransfer: jest.fn().mockResolvedValue({
    counterpartId: "counterpart-1",
    affectedAccountIds: ["00000000-0000-4000-8000-000000000002"],
  }),
}));

/**
 * The applier hands the planner the owner's accounts a structural action may
 * target (B1: planning only; the write of the structure is a later phase).
 */
const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER = "user-1";
const OWN = uuid(1);
const LOAN = uuid(2);
const CLOSED = uuid(3);
const CAT = uuid(4);
const RULE_ID = uuid(11);
const TX = uuid(21);

const CONDITION: RuleConditionNode = {
  all: [{ field: "payeeText", op: "contains", value: "loan" }],
};
const CONVERT: RuleAction = {
  type: "convert_to_transfer",
  toAccountId: LOAN,
  clearCategory: true,
};

const rule = (actions: RuleAction[]): TransactionRule =>
  ({
    id: RULE_ID,
    userId: USER,
    name: "Loan",
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
    accountId: OWN,
    currencyCode: "PLN",
    amount: "-640.1500",
    isTransfer: false,
    linkedTransactionId: null,
    payeeId: null,
    payeeName: "loan instalment",
    categoryId: null,
    description: null,
    isSplit: false,
    status: "UNRECONCILED",
    transactionDate: "2026-10-05",
    referenceNumber: null,
    ...over,
  }) as Transaction;

function harness(accounts: Array<{ id: string; currencyCode: string }>) {
  const accountFind = jest.fn(
    async (opts: { where: { id: { value: string[] } } }) =>
      accounts.filter((a) => opts.where.id.value.includes(a.id)),
  );
  const names = jest.fn().mockResolvedValue([]);
  const repos = new Map<unknown, unknown>([
    [Account, { find: accountFind }],
    [Category, { find: jest.fn().mockResolvedValue([]) }],
    [Payee, { find: names }],
    [Tag, { find: names }],
  ]);
  const m = {
    getRepository: jest.fn((entity: unknown) => repos.get(entity)),
    find: jest.fn(async (entity: unknown) =>
      entity === Transaction ? [row()] : entity === TransactionTag ? [] : [],
    ),
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    insert: jest.fn().mockResolvedValue({}),
  };
  const service = new TransactionRulesApplierService(
    {
      addTransactionTags: jest.fn(),
      removeTransactionTags: jest.fn(),
    } as unknown as TagsService,
    { enqueue: jest.fn() } as unknown as AiReviewRequestsService,
    { resolveByName: jest.fn() } as unknown as PayeesService,
    {} as never,
    {} as never,
  );
  return { m: m as never, mock: m, accountFind, service };
}

const input = {
  accountId: OWN,
  currencyCode: "PLN",
  amount: -640.15,
  isTransfer: false,
  payeeId: null,
  payeeText: "loan instalment",
  categoryId: null,
  description: null,
  tagIds: [],
  hasSplits: false,
  transactionDate: "2026-10-05",
  status: "UNRECONCILED",
};

describe("loadRuleTargetAccounts", () => {
  it("names every account of both structural actions once and nothing else", () => {
    expect(
      structuralTargetIds([
        { actions: [CONVERT, { type: "add_tags", tagIds: [CAT] }] },
        {
          actions: [
            {
              type: "convert_to_transfer",
              fromAccountId: CLOSED,
              clearCategory: true,
            },
            {
              type: "split",
              parts: [
                { amount: "rest", transferAccountId: LOAN },
                { amount: "rest", categoryId: CAT },
              ],
            },
          ],
        },
      ]),
    ).toEqual([LOAN, CLOSED]);
  });

  it("does not query when no rule has a structural action", async () => {
    const h = harness([]);
    const map = await loadRuleTargetAccounts(h.m, USER, [
      {
        actions: [{ type: "set_category", categoryId: CAT, onlyIfEmpty: true }],
      },
    ]);
    expect(map.size).toBe(0);
    expect(h.accountFind).not.toHaveBeenCalled();
  });

  it("reads the owner's open accounts by id, with their currency", async () => {
    const h = harness([{ id: LOAN, currencyCode: "PLN" }]);
    const map = await loadRuleTargetAccounts(h.m, USER, [
      { actions: [CONVERT] },
    ]);
    expect(map.get(LOAN)).toEqual({ currencyCode: "PLN" });
    expect(h.accountFind).toHaveBeenCalledWith({
      select: { id: true, currencyCode: true },
      where: { id: In([LOAN]), userId: USER, isClosed: false },
    });
  });
});

describe("the applier plans structural actions with the owner's accounts", () => {
  it("applyToNew plans the conversion when the target is the owner's open account", async () => {
    const h = harness([{ id: LOAN, currencyCode: "PLN" }]);
    const [applied] = await h.service.applyToNew(h.m, USER, [TX], "create", {
      rules: [rule([CONVERT])],
    });
    // Planned with the owner's accounts, then written (B2): the structure
    // comes back carrying the counterpart the write created.
    expect(applied.effects.changes.structure).toEqual({
      kind: "transfer",
      accountId: LOAN,
      clearCategory: true,
      amount: 640.15,
      counterpartIds: ["counterpart-1"],
    });
    expect(applied.affectedAccountIds).toEqual([LOAN]);
  });

  it("applyToNew with structuralNotAllowed skips the conversion and writes no counterpart", async () => {
    (convertRowToTransfer as jest.Mock).mockClear();
    const h = harness([{ id: LOAN, currencyCode: "PLN" }]);
    const [applied] = await h.service.applyToNew(h.m, USER, [TX], "create", {
      rules: [rule([CONVERT])],
      structuralNotAllowed: true,
    });
    expect(applied.effects.changes.structure).toBeUndefined();
    expect(applied.effects.trace[0].skipped).toEqual([
      {
        type: "convert_to_transfer",
        reason: "structural_not_allowed_for_actor",
      },
    ]);
    expect(applied.affectedAccountIds).toEqual([]);
    expect(convertRowToTransfer).not.toHaveBeenCalled();
  });

  it("applyToNew refuses an account the owner does not have open", async () => {
    const h = harness([]);
    const [applied] = await h.service.applyToNew(h.m, USER, [TX], "create", {
      rules: [rule([CONVERT])],
    });
    expect(applied.effects.changes.structure).toBeUndefined();
    expect(applied.effects.trace[0].skipped).toEqual([
      { type: "convert_to_transfer", reason: "transfer_account_unavailable" },
    ]);
  });

  it("planForRow (the preview) plans with the same accounts", async () => {
    const h = harness([{ id: LOAN, currencyCode: "PLN" }]);
    const effects = await h.service.planForRow(h.m, USER, input, [
      rule([CONVERT]),
    ]);
    expect(effects.changes.structure).toMatchObject({
      kind: "transfer",
      accountId: LOAN,
    });
    const refused = await harness([
      { id: LOAN, currencyCode: "EUR" },
    ]).service.planForRow(
      harness([{ id: LOAN, currencyCode: "EUR" }]).m,
      USER,
      input,
      [rule([CONVERT])],
    );
    expect(refused.trace[0].skipped[0].reason).toBe(
      "transfer_currency_mismatch",
    );
  });

  it("labelsFor names the accounts, categories and payees of a planned structure", async () => {
    const h = harness([{ id: LOAN, currencyCode: "PLN" }]);
    const labelFind = h.mock.find as jest.Mock;
    labelFind.mockImplementation(async (entity: unknown) =>
      entity === Account
        ? [{ id: LOAN, name: "Loan account" }]
        : entity === Category
          ? [{ id: CAT, name: "Interest" }]
          : [],
    );
    const effects = {
      changes: {
        structure: {
          kind: "split" as const,
          parts: [
            {
              amount: -10,
              categoryId: CAT,
              transferAccountId: null,
              payeeId: null,
              memo: null,
            },
            {
              amount: -20,
              categoryId: null,
              transferAccountId: LOAN,
              payeeId: null,
              memo: null,
            },
          ],
        },
        addTagIds: [],
        removeTagIds: [],
      },
      trace: [],
      aiReviewRequests: [],
    };
    const labels = await h.service.labelsFor(h.m, USER, effects, []);
    expect(labels.accounts).toEqual({ [LOAN]: "Loan account" });
    expect(labels.categories).toEqual({ [CAT]: "Interest" });
  });
});
