import {
  collectRegisterExportRows,
  toTransactionExportRow,
} from "./register-export";
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
  it("reads the register once and keeps its order", async () => {
    const fetchRows = jest.fn().mockResolvedValue([tx("a"), tx("b"), tx("c")]);
    const readableAccountIds = jest.fn();

    const rows = await collectRegisterExportRows({
      fetchRows,
      readableAccountIds,
      isActing: false,
    });

    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
    // One read for the whole file: no page walk, so no per-page count,
    // running-balance seed or reporting-rate pass.
    expect(fetchRows).toHaveBeenCalledTimes(1);
    // Same-owner rows never pay the grants query.
    expect(readableAccountIds).not.toHaveBeenCalled();
  });

  it("answers no rows without asking for the readable set", async () => {
    const readableAccountIds = jest.fn();

    const rows = await collectRegisterExportRows({
      fetchRows: jest.fn().mockResolvedValue([]),
      readableAccountIds,
      isActing: true,
    });

    expect(rows).toEqual([]);
    expect(readableAccountIds).not.toHaveBeenCalled();
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
    const readableAccountIds = jest.fn().mockResolvedValue(new Set(["acc-1"]));

    const rows = await collectRegisterExportRows({
      fetchRows: jest
        .fn()
        .mockResolvedValue([crossOwner("a"), crossOwner("b")]),
      readableAccountIds,
      isActing: false,
    });

    expect(readableAccountIds).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.linkedTransaction).toEqual({
        account: { name: "Hidden account" },
      });
      expect(row.payeeName).toBe("Transfer to Hidden account");
    }
  });

  it("leaves a counterpart the reader can read as it is", async () => {
    const rows = await collectRegisterExportRows({
      fetchRows: jest.fn().mockResolvedValue([
        tx("a", {
          isTransfer: true,
          linkedTransaction: {
            userId: "user-1",
            accountId: "acc-2",
            account: { id: "acc-2", name: "Savings" },
          },
        }),
      ]),
      readableAccountIds: jest.fn().mockResolvedValue(new Set(["acc-2"])),
      isActing: true,
    });

    expect(rows[0].linkedTransaction).toEqual({
      account: { name: "Savings" },
    });
  });
});
