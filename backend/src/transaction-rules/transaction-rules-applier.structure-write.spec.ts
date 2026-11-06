import { Account } from "../accounts/entities/account.entity";
import { AiReviewRequestsService } from "../ai-review/ai-review-requests.service";
import { Currency } from "../currencies/entities/currency.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { PayeesService } from "../payees/payees.service";
import { Tag } from "../tags/entities/tag.entity";
import { TransactionTag } from "../tags/entities/transaction-tag.entity";
import { TagsService } from "../tags/tags.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { RuleAction } from "./rule-action.types";
import { RuleConditionNode } from "./rule-condition.types";
import { TransactionRule } from "./transaction-rule.entity";
import { TransactionSplitService } from "../transactions/transaction-split.service";
import { TransactionRulesApplierService } from "./transaction-rules-applier.service";

jest.mock("../common/db/locks", () => ({
  lockTransactionRow: jest.fn().mockResolvedValue({ id: "row" }),
}));

/**
 * B2: the applier writes the planned structure on the caller's manager and
 * reports the accounts it moved. Anonymized data throughout.
 */
const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER = "user-1";
const OWN = uuid(1);
const LOAN = uuid(2);
const CAT = uuid(4);
const PAYEE_OVER = uuid(5);
const RULE_ID = uuid(11);
const TX = uuid(21);
const COUNTERPART = uuid(31);
const COUNTERPART_2 = uuid(32);

const condition = (pattern: string): RuleConditionNode => ({
  all: [{ field: "payeeText", op: "matches", value: pattern }],
});

const rule = (pattern: string, actions: RuleAction[]): TransactionRule =>
  ({
    id: RULE_ID,
    userId: USER,
    name: "Loan",
    enabled: true,
    position: 0,
    triggers: ["create", "import"],
    condition: condition(pattern),
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
    amount: "-1500.7500",
    isTransfer: false,
    linkedTransactionId: null,
    payeeId: null,
    payeeName: "PRINCIPAL: 1200,50 INTEREST: 300,25PENALTY: 0,00",
    categoryId: null,
    description: null,
    isSplit: false,
    status: "UNRECONCILED",
    transactionDate: "2020-01-15",
    referenceNumber: null,
    ...over,
  }) as Transaction;

function harness(
  rowOver: Partial<Transaction> = {},
  currencyRows: Array<{ code: string; decimalPlaces: number }> = [],
  realValidation = false,
) {
  const repos = new Map<unknown, unknown>([
    [
      Account,
      {
        find: jest.fn().mockResolvedValue([{ id: LOAN, currencyCode: "PLN" }]),
      },
    ],
    // `convertRowToTransfer` reads the currency's decimal places.
    [
      Currency,
      {
        query: jest.fn().mockResolvedValue(
          currencyRows.map((row) => ({
            code: row.code,
            decimal_places: row.decimalPlaces,
          })),
        ),
      },
    ],
    [Category, { find: jest.fn().mockResolvedValue([]) }],
    [Payee, { find: jest.fn().mockResolvedValue([]) }],
    [Tag, { find: jest.fn().mockResolvedValue([]) }],
  ]);
  const m = {
    getRepository: jest.fn((entity: unknown) => repos.get(entity)),
    find: jest.fn(async (entity: unknown) =>
      entity === Transaction
        ? [row(rowOver)]
        : entity === Payee
          ? [{ id: PAYEE_OVER, name: "Loan overpayment" }]
          : entity === TransactionTag
            ? []
            : [],
    ),
    findOne: jest.fn(async (entity: unknown) =>
      entity === Transaction
        ? row(rowOver)
        : entity === Account
          ? { id: LOAN, currencyCode: "PLN" }
          : null,
    ),
    create: jest.fn((_e: unknown, data: object) => ({ ...data })),
    save: jest.fn(async (data: object) => ({ ...data, id: COUNTERPART })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    insert: jest.fn().mockResolvedValue({}),
  };
  const accounts = {
    updateBalance: jest.fn().mockResolvedValue(undefined),
    recalculateCurrentBalance: jest.fn().mockResolvedValue(undefined),
  };
  const splits = {
    validateSplits: jest.fn(),
    createSplits: jest.fn(),
  };
  if (realValidation) {
    // The real validation (it reads no instance state), so a refusal is the
    // split service's own.
    splits.validateSplits.mockImplementation(
      (...args: Parameters<TransactionSplitService["validateSplits"]>) =>
        TransactionSplitService.prototype.validateSplits.apply(
          {} as TransactionSplitService,
          args,
        ),
    );
  }
  const service = new TransactionRulesApplierService(
    {
      addTransactionTags: jest.fn(),
      removeTransactionTags: jest.fn(),
    } as unknown as TagsService,
    { enqueue: jest.fn() } as unknown as AiReviewRequestsService,
    { resolveByName: jest.fn() } as unknown as PayeesService,
    accounts as never,
    splits as never,
  );
  return { m: m as never, mock: m, accounts, splits, service };
}

const SPLIT: RuleAction = {
  type: "split",
  parts: [
    {
      amount: "{principal}",
      transferAccountId: LOAN,
      payeeId: PAYEE_OVER,
    },
    { amount: "{interest}", categoryId: CAT, description: "interest" },
  ],
};
const SPLIT_PATTERN = "PRINCIPAL: {principal} INTEREST: {interest}PENALTY*";

/** Plan with the real planner, then write. */
async function run(h: ReturnType<typeof harness>, r: TransactionRule) {
  const affected = new Set<string>();
  const [applied] = await h.service.applyToNew(h.m, USER, [TX], "create", {
    rules: [r],
  });
  return { applied, affected };
}

describe("TransactionRulesApplierService structure writes", () => {
  beforeEach(() => jest.clearAllMocks());

  describe("convert_to_transfer", () => {
    const convert = rule("PRINCIPAL: *", [
      { type: "convert_to_transfer", toAccountId: LOAN, clearCategory: true },
    ]);

    it("creates the counterpart, moves only the target, and reports it", async () => {
      const h = harness({ amount: "-640.1500" as never });
      const { applied } = await run(h, convert);

      expect(h.accounts.updateBalance).toHaveBeenCalledTimes(1);
      expect(h.accounts.updateBalance).toHaveBeenCalledWith(LOAN, 640.15);
      expect(applied.affectedAccountIds).toEqual([LOAN]);
      expect(h.mock.create).toHaveBeenCalledWith(
        Transaction,
        expect.objectContaining({
          accountId: LOAN,
          amount: 640.15,
          isTransfer: true,
        }),
      );
    });

    it("records the counterpart id on the stored trace and the returned effects", async () => {
      const h = harness({ amount: "-640.1500" as never });
      const { applied } = await run(h, convert);

      const expected = {
        kind: "transfer",
        accountId: LOAN,
        clearCategory: true,
        amount: 640.15,
        counterpartIds: [COUNTERPART],
      };
      expect(applied.effects.changes.structure).toEqual(expected);
      const stored = h.mock.insert.mock.calls
        .map((call) => call[1] as Array<{ changes: unknown }>)
        .flat();
      expect(stored).toEqual([
        expect.objectContaining({
          changes: expect.objectContaining({
            structure: { before: null, after: expected },
          }),
        }),
      ]);
    });
  });

  describe("split", () => {
    const split = rule(SPLIT_PATTERN, [SPLIT]);

    it("validates and creates the mapped parts, then flags the row", async () => {
      const h = harness();
      h.splits.createSplits.mockResolvedValue([
        { id: "s1", linkedTransactionId: COUNTERPART },
        { id: "s2", linkedTransactionId: null },
      ]);
      h.splits.createSplits.mockImplementation(async (...args: unknown[]) => {
        (args[8] as Set<string>).add(LOAN);
        return [
          { id: "s1", linkedTransactionId: COUNTERPART },
          { id: "s2", linkedTransactionId: null },
        ];
      });
      const { applied } = await run(h, split);

      const parts = [
        { amount: -1200.5, transferAccountId: LOAN },
        { amount: -300.25, categoryId: CAT, memo: "interest" },
      ];
      expect(h.splits.validateSplits).toHaveBeenCalledWith(parts, -1500.75, {
        code: "PLN",
        decimalPlaces: null,
      });
      expect(h.splits.createSplits).toHaveBeenCalledWith(
        TX,
        parts,
        USER,
        OWN,
        new Date("2020-01-15"),
        row().payeeName,
        null,
        { parentStatus: "UNRECONCILED" },
        expect.any(Set),
      );
      expect(h.mock.update).toHaveBeenCalledWith(
        Transaction,
        { id: TX, userId: USER },
        { isSplit: true, categoryId: null },
      );
      expect(applied.affectedAccountIds).toEqual([LOAN]);
      expect(applied.effects.changes.structure).toMatchObject({
        kind: "split",
        counterpartIds: [COUNTERPART],
      });
    });

    it("writes a transfer part's payee on its counterpart leg, owner-scoped", async () => {
      const h = harness();
      h.splits.createSplits.mockResolvedValue([
        { id: "s1", linkedTransactionId: COUNTERPART },
        { id: "s2", linkedTransactionId: null },
      ]);
      await run(h, split);

      expect(h.mock.update).toHaveBeenCalledWith(
        Transaction,
        { id: COUNTERPART, userId: USER },
        { payeeId: PAYEE_OVER, payeeName: "Loan overpayment" },
      );
    });

    it("leaves a counterpart's payee alone when its part names none", async () => {
      const h = harness();
      h.splits.createSplits.mockResolvedValue([
        { id: "s1", linkedTransactionId: COUNTERPART },
        { id: "s2", linkedTransactionId: COUNTERPART_2 },
      ]);
      const noPayee = rule(SPLIT_PATTERN, [
        {
          type: "split",
          parts: [
            { amount: "{principal}", transferAccountId: LOAN },
            { amount: "{interest}", categoryId: CAT },
          ],
        },
      ]);
      const { applied } = await run(h, noPayee);
      expect(
        h.mock.update.mock.calls.filter(
          (call) =>
            (call[1] as { id: string }).id === COUNTERPART &&
            "payeeId" in (call[2] as object),
        ),
      ).toEqual([]);
      expect(applied.effects.changes.structure).toMatchObject({
        counterpartIds: [COUNTERPART],
      });
    });

    it("hands the split service the row's own payee and status", async () => {
      const h = harness({ payeeId: "payee-set" });
      h.splits.createSplits.mockResolvedValue([
        { id: "s1", linkedTransactionId: COUNTERPART },
        { id: "s2", linkedTransactionId: null },
      ]);
      await run(h, split);
      expect(h.splits.createSplits).toHaveBeenCalledWith(
        TX,
        expect.anything(),
        USER,
        OWN,
        expect.any(Date),
        row().payeeName,
        "payee-set",
        expect.anything(),
        expect.any(Set),
      );
    });
  });

  describe("split on several rows of one account", () => {
    it("reads the account's currency places once for the whole apply run", async () => {
      const ids = [TX, uuid(22), uuid(23)];
      const h = harness();
      h.mock.find.mockImplementation(async (entity: unknown) =>
        entity === Transaction ? ids.map((id) => row({ id })) : [],
      );
      h.mock.findOne.mockImplementation(
        async (entity: unknown, options?: { where?: { id?: string } }) =>
          entity === Transaction ? row({ id: options?.where?.id ?? TX }) : null,
      );
      h.splits.createSplits.mockResolvedValue([
        { id: "s1", linkedTransactionId: COUNTERPART },
        { id: "s2", linkedTransactionId: null },
      ]);
      const places = (
        h.m as unknown as {
          getRepository: (e: unknown) => { query: jest.Mock };
        }
      ).getRepository(Currency).query;
      places.mockClear();

      const applied = await h.service.applyToNew(h.m, USER, ids, "create", {
        rules: [rule(SPLIT_PATTERN, [SPLIT])],
      });

      expect(applied).toHaveLength(3);
      expect(h.splits.createSplits).toHaveBeenCalledTimes(3);
      expect(h.splits.validateSplits).toHaveBeenCalledTimes(3);
      expect(places).toHaveBeenCalledTimes(1);
    });
  });

  describe("split on a coin account", () => {
    const BTC = [{ code: "BTC", decimalPlaces: 8 }];
    const split = rule(SPLIT_PATTERN, [
      {
        type: "split",
        parts: [
          { amount: "{principal}", categoryId: CAT },
          { amount: "{interest}", categoryId: CAT, description: "interest" },
        ],
      },
    ]);

    it("validates an eight-place line against the parent currency's places", async () => {
      const h = harness(
        {
          currencyCode: "BTC",
          amount: "-0.00000008" as never,
          payeeName: "PRINCIPAL: 0,00000005 INTEREST: 0,00000003PENALTY: 0,00",
        },
        BTC,
        true,
      );
      h.splits.createSplits.mockResolvedValue([
        { id: "s1", linkedTransactionId: null },
        { id: "s2", linkedTransactionId: null },
      ]);
      await run(h, split);

      expect(h.splits.validateSplits).toHaveBeenCalledWith(
        [
          { amount: -0.00000005, categoryId: CAT },
          { amount: -0.00000003, categoryId: CAT, memo: "interest" },
        ],
        -0.00000008,
        { code: "BTC", decimalPlaces: 8 },
      );
      expect(h.splits.validateSplits).toHaveReturned();
      expect(h.splits.createSplits).toHaveBeenCalledTimes(1);
    });

    it("refuses a nine-place line before anything is written", async () => {
      const h = harness(
        { currencyCode: "BTC", amount: "-0.00000008" as never },
        BTC,
        true,
      );
      const plan = {
        kind: "split" as const,
        parts: [
          {
            amount: -0.000000051,
            categoryId: CAT,
            transferAccountId: null,
            memo: null,
            payeeId: null,
          },
          {
            amount: -0.000000029,
            categoryId: CAT,
            transferAccountId: null,
            memo: null,
            payeeId: null,
          },
        ],
      };

      await expect(
        (
          h.service as unknown as {
            writeSplit: (
              m: unknown,
              userId: string,
              id: string,
              plan: unknown,
            ) => Promise<unknown>;
          }
        ).writeSplit(h.m, USER, TX, plan),
      ).rejects.toThrow(/splits\[0\]\.amount.*more decimal places than BTC/);
      expect(h.splits.createSplits).not.toHaveBeenCalled();
      expect(h.mock.update).not.toHaveBeenCalled();
    });
  });

  it("a rule without a structural action writes no structure and reports no account", async () => {
    const h = harness();
    const [applied] = await h.service.applyToNew(h.m, USER, [TX], "create", {
      rules: [
        rule("PRINCIPAL*", [
          { type: "set_category", categoryId: CAT, onlyIfEmpty: false },
        ]),
      ],
    });
    expect(applied.affectedAccountIds).toEqual([]);
    expect(h.accounts.updateBalance).not.toHaveBeenCalled();
    expect(h.splits.createSplits).not.toHaveBeenCalled();
  });

  it("applyToNewTransfer never writes a structure (refused on a transfer leg)", async () => {
    const h = harness({ isTransfer: true, linkedTransactionId: "other" });
    const loaded = jest.spyOn(h.service, "loadRulesFor").mockResolvedValue([
      rule("*", [
        {
          type: "convert_to_transfer",
          toAccountId: LOAN,
          clearCategory: true,
        },
      ]),
    ]);
    const applied = await h.service.applyToNewTransfer(h.m, {
      fromLegId: TX,
      toLegId: uuid(22),
      fromOwnerId: USER,
      toOwnerId: USER,
    });
    expect(loaded).toHaveBeenCalled();
    expect(applied.every((a) => a.affectedAccountIds.length === 0)).toBe(true);
    expect(h.accounts.updateBalance).not.toHaveBeenCalled();
    expect(h.splits.createSplits).not.toHaveBeenCalled();
    expect(h.mock.create).not.toHaveBeenCalled();
  });
});
