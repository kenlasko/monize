import {
  collectRegisterExportRows,
  toTransactionExportRow,
} from "./register-export";
import type { PaginatedTransactions } from "./transactions.service";
import type { Transaction } from "./entities/transaction.entity";

const tx = (id: string, extra: Record<string, unknown> = {}): Transaction =>
  ({
    id,
    userId: "user-1",
    transactionDate: "2026-02-01",
    amount: "-25.5000",
    currencyCode: "CAD",
    status: "CLEARED",
    description: "Lunch",
    payeeName: null,
    isSplit: false,
    isTransfer: false,
    account: { id: "acc-1", name: "Chequing", currentBalance: 900 },
    payee: { id: "payee-1", name: "Cafe" },
    category: { id: "cat-1", name: "Dining" },
    tags: [{ id: "tag-1", name: "work" }],
    linkedTransaction: null,
    splits: [],
    ...extra,
  }) as unknown as Transaction;

const page = (data: Transaction[], hasMore: boolean) =>
  ({ data, pagination: { hasMore } }) as unknown as PaginatedTransactions;

describe("toTransactionExportRow", () => {
  it("keeps the names the file shows and drops the rest of each relation", () => {
    const row = toTransactionExportRow(
      tx("tx-1", {
        isSplit: true,
        splits: [
          {
            amount: "-20.0000",
            category: { id: "cat-2", name: "Groceries" },
            transferAccount: null,
            memo: "kept out",
          },
          {
            amount: "-5.5000",
            category: null,
            transferAccount: {
              id: "acc-2",
              name: "Savings",
              currentBalance: 1,
            },
          },
        ],
      }),
    );

    expect(row).toEqual({
      id: "tx-1",
      transactionDate: "2026-02-01",
      amount: "-25.5000",
      currencyCode: "CAD",
      status: "CLEARED",
      description: "Lunch",
      payeeName: null,
      isSplit: true,
      isTransfer: false,
      account: { name: "Chequing" },
      payee: { name: "Cafe" },
      category: { name: "Dining" },
      tags: [{ name: "work" }],
      linkedTransaction: null,
      splits: [
        {
          amount: "-20.0000",
          category: { name: "Groceries" },
          transferAccount: null,
        },
        {
          amount: "-5.5000",
          category: null,
          transferAccount: { name: "Savings" },
        },
      ],
    });
  });

  it("keeps a transfer's counterpart account name", () => {
    const row = toTransactionExportRow(
      tx("tx-1", {
        isTransfer: true,
        linkedTransaction: {
          id: "tx-2",
          accountId: "acc-2",
          account: { id: "acc-2", name: "Savings", currentBalance: 1 },
        },
      }),
    );

    expect(row.linkedTransaction).toEqual({ account: { name: "Savings" } });
  });
});

describe("collectRegisterExportRows", () => {
  it("walks pages until the register says there are no more", async () => {
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce(page([tx("a"), tx("b")], true))
      .mockResolvedValueOnce(page([tx("c")], false));
    const readableAccountIds = jest.fn();

    const rows = await collectRegisterExportRows({
      fetchPage,
      readableAccountIds,
      isActing: false,
    });

    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(fetchPage.mock.calls).toEqual([
      [1, 200],
      [2, 200],
    ]);
    // Same-owner rows never pay the grants query.
    expect(readableAccountIds).not.toHaveBeenCalled();
  });

  it("stops at an empty page even when it claims there is more", async () => {
    const fetchPage = jest.fn().mockResolvedValue(page([], true));

    const rows = await collectRegisterExportRows({
      fetchPage,
      readableAccountIds: jest.fn(),
      isActing: false,
    });

    expect(rows).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("masks a cross-owner counterpart the reader cannot read, fetching the readable set once", async () => {
    const crossOwner = (id: string) =>
      tx(id, {
        isTransfer: true,
        payeeName: "Transfer to Their Savings",
        linkedTransaction: {
          userId: "user-2",
          accountId: "acc-9",
          account: { id: "acc-9", name: "Their Savings" },
        },
      });
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce(page([crossOwner("a")], true))
      .mockResolvedValueOnce(page([crossOwner("b")], false));
    const readableAccountIds = jest.fn().mockResolvedValue(new Set(["acc-1"]));

    const rows = await collectRegisterExportRows({
      fetchPage,
      readableAccountIds,
      isActing: false,
    });

    expect(readableAccountIds).toHaveBeenCalledTimes(1);
    for (const row of rows) {
      expect(row.linkedTransaction).toEqual({
        account: { name: "Hidden account" },
      });
      expect(row.payeeName).toBe("Transfer to Hidden account");
    }
  });

  it("leaves a counterpart the reader can read as it is", async () => {
    const fetchPage = jest.fn().mockResolvedValueOnce(
      page(
        [
          tx("a", {
            isTransfer: true,
            linkedTransaction: {
              userId: "user-1",
              accountId: "acc-2",
              account: { id: "acc-2", name: "Savings" },
            },
          }),
        ],
        false,
      ),
    );

    const rows = await collectRegisterExportRows({
      fetchPage,
      readableAccountIds: jest.fn().mockResolvedValue(new Set(["acc-2"])),
      isActing: true,
    });

    expect(rows[0].linkedTransaction).toEqual({
      account: { name: "Savings" },
    });
  });
});
