import { ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { Account } from "../accounts/entities/account.entity";
import { lockTransactionRow } from "../common/db/locks";
import { TransactionTag } from "../tags/entities/transaction-tag.entity";
import { convertRowToTransfer } from "./convert-to-transfer";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";

jest.mock("../common/db/locks", () => ({
  lockTransactionRow: jest.fn(),
}));

const USER = "user-1";
const ROW = "row-1";
const COUNTERPART = "counterpart-1";
const CHECKING = "acct-checking";
const LOAN = "acct-loan";

function row(over: Partial<Transaction> = {}): Transaction {
  return {
    id: ROW,
    userId: USER,
    accountId: CHECKING,
    transactionDate: "2020-01-15",
    amount: -640.15,
    currencyCode: "PLN",
    description: "Instalment",
    referenceNumber: "REF-1",
    status: TransactionStatus.CLEARED,
    isTransfer: false,
    isSplit: false,
    linkedTransactionId: null,
    payeeId: "payee-1",
    payeeName: "Loan repayment",
    categoryId: "cat-1",
    ...over,
  } as Transaction;
}

function harness(
  rowOver: Partial<Transaction> = {},
  tags: string[] = [],
  target: Partial<Account> | null = { id: LOAN, currencyCode: "PLN" },
) {
  const insertExecute = jest.fn().mockResolvedValue({});
  const values = jest.fn().mockReturnValue({
    orIgnore: () => ({ execute: insertExecute }),
  });
  const into = jest.fn().mockReturnValue({ values });
  const m = {
    findOne: jest.fn(async (entity: unknown) => {
      if (entity === Transaction) return row(rowOver);
      if (entity === Account) return target;
      return null;
    }),
    find: jest.fn(async (entity: unknown) =>
      entity === TransactionTag
        ? tags.map((tagId) => ({ transactionId: ROW, tagId }))
        : [],
    ),
    create: jest.fn((_entity: unknown, data: object) => ({ ...data })),
    save: jest.fn(async (data: object) => ({ ...data, id: COUNTERPART })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn().mockReturnValue({
      insert: () => ({ into }),
    }),
  };
  const accounts = {
    updateBalance: jest.fn().mockResolvedValue(undefined),
    recalculateCurrentBalance: jest.fn().mockResolvedValue(undefined),
  };
  return { m, em: m as unknown as EntityManager, accounts, values };
}

const convert = (
  h: ReturnType<typeof harness>,
  clearCategory = true,
): ReturnType<typeof convertRowToTransfer> =>
  convertRowToTransfer(h.em, h.accounts as never, USER, ROW, LOAN, {
    clearCategory,
  });

describe("convertRowToTransfer", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (lockTransactionRow as jest.Mock).mockResolvedValue({ id: ROW });
  });

  it("creates the receiving leg the way writeTransferLegs does", async () => {
    const h = harness();
    const result = await convert(h);

    expect(h.m.create).toHaveBeenCalledWith(Transaction, {
      userId: USER,
      accountId: LOAN,
      transactionDate: "2020-01-15",
      amount: 640.15,
      currencyCode: "PLN",
      exchangeRate: 1,
      description: "Instalment",
      referenceNumber: "REF-1",
      status: TransactionStatus.CLEARED,
      isTransfer: true,
      payeeId: "payee-1",
      payeeName: "Loan repayment",
      categoryId: null,
    });
    expect(result).toEqual({
      counterpartId: COUNTERPART,
      affectedAccountIds: [LOAN],
    });
  });

  it("links both legs and marks the row, clearing the category when asked", async () => {
    const h = harness();
    await convert(h, true);
    expect(h.m.update).toHaveBeenCalledWith(
      Transaction,
      { id: COUNTERPART, userId: USER },
      { linkedTransactionId: ROW },
    );
    expect(h.m.update).toHaveBeenCalledWith(
      Transaction,
      { id: ROW, userId: USER },
      { linkedTransactionId: COUNTERPART, isTransfer: true, categoryId: null },
    );
  });

  it("keeps the category when clearCategory is false", async () => {
    const h = harness();
    await convert(h, false);
    expect(h.m.update).toHaveBeenCalledWith(
      Transaction,
      { id: ROW, userId: USER },
      { linkedTransactionId: COUNTERPART, isTransfer: true },
    );
  });

  it("mirrors the row's tags onto the counterpart", async () => {
    const h = harness({}, ["t1", "t2"]);
    await convert(h);
    expect(h.values).toHaveBeenCalledWith([
      { transactionId: COUNTERPART, tagId: "t1" },
      { transactionId: COUNTERPART, tagId: "t2" },
    ]);
  });

  it("writes no tag rows for an untagged row", async () => {
    const h = harness();
    await convert(h);
    expect(h.m.createQueryBuilder).not.toHaveBeenCalled();
  });

  it("moves only the target's balance, by the counterpart's amount (expense)", async () => {
    const h = harness();
    await convert(h);
    expect(h.accounts.updateBalance).toHaveBeenCalledTimes(1);
    expect(h.accounts.updateBalance).toHaveBeenCalledWith(LOAN, 640.15);
    expect(h.accounts.recalculateCurrentBalance).not.toHaveBeenCalled();
  });

  it("moves the target by the negative of an income", async () => {
    const h = harness({ amount: 250 });
    await convert(h);
    expect(h.accounts.updateBalance).toHaveBeenCalledWith(LOAN, -250);
  });

  it("recalculates the target for a future-dated row, with no delta", async () => {
    const h = harness({ transactionDate: "2999-01-01" });
    await convert(h);
    expect(h.accounts.recalculateCurrentBalance).toHaveBeenCalledWith(
      USER,
      LOAN,
    );
    expect(h.accounts.updateBalance).not.toHaveBeenCalled();
  });

  it.each([
    ["gone", null, {}, undefined],
    ["a transfer leg", { id: ROW }, { isTransfer: true }, undefined],
    ["linked", { id: ROW }, { linkedTransactionId: "x" }, undefined],
    ["a split", { id: ROW }, { isSplit: true }, undefined],
    ["void", { id: ROW }, { status: TransactionStatus.VOID }, undefined],
    ["its own account", { id: ROW }, { accountId: LOAN }, undefined],
    ["a missing target", { id: ROW }, {}, null],
    ["another currency", { id: ROW }, {}, { id: LOAN, currencyCode: "EUR" }],
  ])(
    "refuses before writing when the row is %s",
    async (_name, locked, rowOver, target) => {
      const h = harness(rowOver as Partial<Transaction>, [], target);
      (lockTransactionRow as jest.Mock).mockResolvedValue(locked);
      if (locked === null) {
        // lock found nothing
      }
      await expect(convert(h)).rejects.toBeInstanceOf(ConflictException);
      expect(h.m.save).not.toHaveBeenCalled();
      expect(h.m.update).not.toHaveBeenCalled();
      expect(h.accounts.updateBalance).not.toHaveBeenCalled();
    },
  );

  it("writes nothing when the row's amount is no longer the planned one", async () => {
    // The plan (and a run's fingerprint) said 640.15; the locked row now says 650.
    const h = harness({ amount: -650 });
    await expect(
      convertRowToTransfer(h.em, h.accounts as never, USER, ROW, LOAN, {
        clearCategory: true,
        expectedCounterpartAmount: 640.15,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: "CONVERT_TO_TRANSFER_REFUSED",
      }),
    });
    expect(h.m.save).not.toHaveBeenCalled();
    expect(h.accounts.updateBalance).not.toHaveBeenCalled();
  });

  it("converts when the planned amount is still the row's", async () => {
    const h = harness();
    await convertRowToTransfer(h.em, h.accounts as never, USER, ROW, LOAN, {
      clearCategory: true,
      expectedCounterpartAmount: 640.15,
    });
    expect(h.accounts.updateBalance).toHaveBeenCalledWith(LOAN, 640.15);
  });

  it("refuses when the row is gone after the lock", async () => {
    const h = harness();
    h.m.findOne.mockResolvedValueOnce(null as never);
    await expect(convert(h)).rejects.toBeInstanceOf(ConflictException);
  });
});
