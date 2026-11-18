import { EntityManager } from "typeorm";
import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import { MappedSplit, MappedTransaction } from "../model/mny-import-model";
import {
  INSERT_CHUNK_SIZE,
  writeAccountBalances,
  writeTransactions,
} from "./write-transactions";

/**
 * The bulk writer's contract, which the integration spec exercises against real
 * Postgres but which is cheapest to pin down here: rows go in as chunked
 * multi-row inserts, transfer links are back-patched after every row exists
 * (the column is a self-referencing FK), and a transfer leg whose far account
 * was excluded degrades to a category leg instead of violating the split table's
 * kind-exclusivity constraint.
 */

function transaction(
  overrides: Partial<MappedTransaction> = {},
): MappedTransaction {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    handle: 1,
    accountKey: "acct-1",
    transactionDate: "2024-03-01",
    amount: -25.5,
    currencyCode: "CAD",
    status: TransactionStatus.CLEARED,
    payeeHandle: null,
    categoryHandle: null,
    description: null,
    referenceNumber: null,
    isTransfer: false,
    linkedTransactionId: null,
    splits: [],
    collapsedTradeHandle: null,
    tagHandles: [],
    ...overrides,
  };
}

let nextSplitId = 0;

function split(overrides: Partial<MappedSplit> = {}): MappedSplit {
  nextSplitId += 1;
  return {
    id: `split-${nextSplitId}`,
    kind: SplitKind.CATEGORY,
    categoryHandle: 10,
    transferAccountKey: null,
    linkedTransactionId: null,
    investmentHandle: null,
    amount: -10,
    memo: null,
    tagHandles: [],
    ...overrides,
  };
}

interface Doubles {
  manager: EntityManager;
  transactions: Record<string, jest.Mock>;
  splits: Record<string, jest.Mock>;
  tagLinks: Record<string, jest.Mock>;
  splitTagLinks: Record<string, jest.Mock>;
  query: jest.Mock;
}

function doubles(): Doubles {
  const transactions = {
    insert: jest.fn().mockResolvedValue(undefined),
  } as unknown as Record<string, jest.Mock>;
  const splits = {
    insert: jest.fn().mockResolvedValue(undefined),
  } as unknown as Record<string, jest.Mock>;
  const tagLinks = {
    insert: jest.fn().mockResolvedValue(undefined),
  } as unknown as Record<string, jest.Mock>;
  const splitTagLinks = {
    insert: jest.fn().mockResolvedValue(undefined),
  } as unknown as Record<string, jest.Mock>;
  const query = jest.fn().mockResolvedValue([[], 0]);

  const manager = {
    getRepository: jest.fn((entity: { name?: string }) => {
      if (entity?.name === "TransactionSplit") return splits;
      if (entity?.name === "TransactionTag") return tagLinks;
      if (entity?.name === "TransactionSplitTag") return splitTagLinks;
      return transactions;
    }),
    query,
  } as unknown as EntityManager;

  return { manager, transactions, splits, tagLinks, splitTagLinks, query };
}

const baseInput = {
  accountIdByKey: new Map([["acct-1", "account-1"]]),
  categoryIdByHandle: new Map([[10, "category-10"]]),
  payeeIdByHandle: new Map([[5, "payee-5"]]),
  payeeNameByHandle: new Map([[5, "Loblaws"]]),
  tagIdByHandle: new Map([[552, "tag-552"]]),
};

describe("writeTransactions", () => {
  it("writes a row per transaction and reports the accounts it touched", async () => {
    const { manager, transactions } = doubles();

    const written = await writeTransactions(manager, "user-1", {
      ...baseInput,
      transactions: [transaction()],
    });

    expect(written.transactionsCreated).toBe(1);
    expect([...written.affectedAccountIds]).toEqual(["account-1"]);
    expect(transactions.insert).toHaveBeenCalledTimes(1);
    expect(transactions.insert.mock.calls[0][0][0]).toMatchObject({
      userId: "user-1",
      accountId: "account-1",
      transactionDate: "2024-03-01",
      amount: -25.5,
      exchangeRate: 1,
      isSplit: false,
      linkedTransactionId: null,
    });
  });

  it("writes the exchange rate and reconciled date a source supplies", async () => {
    const { manager, transactions } = doubles();

    await writeTransactions(manager, "user-1", {
      ...baseInput,
      transactions: [
        transaction({
          exchangeRate: 0.7412345678,
          reconciledDate: "2024-03-05",
        }),
      ],
    });

    expect(transactions.insert.mock.calls[0][0][0]).toMatchObject({
      exchangeRate: 0.7412345678,
      reconciledDate: "2024-03-05",
    });
  });

  it("defaults the exchange rate to 1 and the reconciled date to null", async () => {
    const { manager, transactions } = doubles();

    await writeTransactions(manager, "user-1", {
      ...baseInput,
      transactions: [transaction()],
    });

    expect(transactions.insert.mock.calls[0][0][0]).toMatchObject({
      exchangeRate: 1,
      reconciledDate: null,
    });
  });

  it("carries the reference number into the column the register's Ref # reads", async () => {
    // `transactions.reference_number` is what the register's Ref # column
    // renders, so a value the mapper decoded has to survive this far to be the
    // fix issue #1174 asked for. Nothing between here and the mapper asserted
    // that the field was written at all.
    const { manager, transactions } = doubles();

    await writeTransactions(manager, "user-1", {
      ...baseInput,
      transactions: [transaction({ referenceNumber: "14" })],
    });

    expect(transactions.insert.mock.calls[0][0][0]).toMatchObject({
      referenceNumber: "14",
    });
  });

  it("skips a transaction whose account was excluded from the import", async () => {
    const { manager, transactions } = doubles();

    const written = await writeTransactions(manager, "user-1", {
      ...baseInput,
      transactions: [transaction({ accountKey: "acct-excluded" })],
    });

    expect(written.transactionsCreated).toBe(0);
    expect(transactions.insert).not.toHaveBeenCalled();
  });

  it("resolves payee and category handles, and stores the payee name alongside the id", async () => {
    const { manager, transactions } = doubles();

    await writeTransactions(manager, "user-1", {
      ...baseInput,
      transactions: [transaction({ payeeHandle: 5, categoryHandle: 10 })],
    });

    expect(transactions.insert.mock.calls[0][0][0]).toMatchObject({
      payeeId: "payee-5",
      payeeName: "Loblaws",
      categoryId: "category-10",
    });
  });

  it("leaves an unmapped handle null rather than inventing a reference", async () => {
    const { manager, transactions } = doubles();

    await writeTransactions(manager, "user-1", {
      ...baseInput,
      transactions: [transaction({ payeeHandle: 99, categoryHandle: 99 })],
    });

    expect(transactions.insert.mock.calls[0][0][0]).toMatchObject({
      payeeId: null,
      payeeName: null,
      categoryId: null,
    });
  });

  it("chunks the inserts and reports progress after each chunk", async () => {
    const { manager, transactions } = doubles();
    const total = INSERT_CHUNK_SIZE + 1;
    const onProgress = jest.fn().mockResolvedValue(undefined);

    await writeTransactions(manager, "user-1", {
      ...baseInput,
      transactions: Array.from({ length: total }, (_, index) =>
        transaction({ id: `id-${index}`, handle: index }),
      ),
      onProgress,
    });

    expect(transactions.insert).toHaveBeenCalledTimes(2);
    expect(transactions.insert.mock.calls[0][0]).toHaveLength(
      INSERT_CHUNK_SIZE,
    );
    expect(transactions.insert.mock.calls[1][0]).toHaveLength(1);
    expect(onProgress).toHaveBeenNthCalledWith(1, INSERT_CHUNK_SIZE, total);
    expect(onProgress).toHaveBeenNthCalledWith(2, total, total);
  });

  it("links Money's classification to the transaction and to the split leg that carries it", async () => {
    const { manager, tagLinks, splitTagLinks } = doubles();

    const written = await writeTransactions(manager, "user-1", {
      ...baseInput,
      transactions: [
        transaction({ id: "id-a", tagHandles: [552] }),
        transaction({
          id: "id-b",
          handle: 2,
          splits: [split({ id: "split-1", tagHandles: [552] }), split()],
        }),
      ],
    });

    expect(written.tagLinksApplied).toBe(2);
    expect(tagLinks.insert).toHaveBeenCalledWith([
      { transactionId: "id-a", tagId: "tag-552" },
    ]);
    expect(splitTagLinks.insert).toHaveBeenCalledWith([
      { transactionSplitId: "split-1", tagId: "tag-552" },
    ]);
  });

  it("writes no link for a classification item the tag writer did not resolve", async () => {
    const { manager, tagLinks, splitTagLinks } = doubles();

    const written = await writeTransactions(manager, "user-1", {
      ...baseInput,
      transactions: [transaction({ tagHandles: [999] })],
    });

    expect(written.tagLinksApplied).toBe(0);
    expect(tagLinks.insert).not.toHaveBeenCalled();
    expect(splitTagLinks.insert).not.toHaveBeenCalled();
  });

  it("back-patches a transfer pair once both rows exist", async () => {
    const { manager, query } = doubles();

    const written = await writeTransactions(manager, "user-1", {
      ...baseInput,
      transactions: [
        transaction({ id: "id-a", linkedTransactionId: "id-b" }),
        transaction({ id: "id-b", handle: 2, linkedTransactionId: "id-a" }),
      ],
    });

    expect(written.linksApplied).toBe(2);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain("SET linked_transaction_id = v.linked");
    expect(params).toEqual(["id-a", "id-b", "id-b", "id-a"]);
  });

  it("does not point a transfer at a counterpart that was never inserted", async () => {
    const { manager, query } = doubles();

    const written = await writeTransactions(manager, "user-1", {
      ...baseInput,
      transactions: [transaction({ linkedTransactionId: "id-elsewhere" })],
    });

    expect(written.linksApplied).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("writes split legs with their resolved category and rounded amount", async () => {
    const { manager, splits, transactions } = doubles();

    const written = await writeTransactions(manager, "user-1", {
      ...baseInput,
      transactions: [
        transaction({ splits: [split({ amount: 10.005001, memo: "half" })] }),
      ],
    });

    expect(written.splitsCreated).toBe(1);
    expect(transactions.insert.mock.calls[0][0][0].isSplit).toBe(true);
    expect(splits.insert.mock.calls[0][0][0]).toMatchObject({
      kind: SplitKind.CATEGORY,
      categoryId: "category-10",
      amount: 10.005,
      memo: "half",
    });
  });

  it("keeps a transfer split pointing at its account and counterpart", async () => {
    const { manager, splits } = doubles();

    await writeTransactions(manager, "user-1", {
      ...baseInput,
      transactions: [
        transaction({
          id: "id-a",
          splits: [
            split({
              kind: SplitKind.TRANSFER,
              categoryHandle: null,
              transferAccountKey: "acct-1",
              linkedTransactionId: "id-b",
            }),
          ],
        }),
        transaction({ id: "id-b", handle: 2 }),
      ],
    });

    expect(splits.insert.mock.calls[0][0][0]).toMatchObject({
      kind: SplitKind.TRANSFER,
      transferAccountId: "account-1",
      linkedTransactionId: "id-b",
    });
  });

  it("degrades a transfer split with no target account to a category leg", async () => {
    const { manager, splits } = doubles();

    await writeTransactions(manager, "user-1", {
      ...baseInput,
      transactions: [
        transaction({
          splits: [
            split({
              kind: SplitKind.TRANSFER,
              transferAccountKey: "acct-excluded",
            }),
          ],
        }),
      ],
    });

    // A transfer leg with a null target violates the table's kind-exclusivity
    // constraint, which would fail the whole import transaction.
    expect(splits.insert.mock.calls[0][0][0]).toMatchObject({
      kind: SplitKind.CATEGORY,
      transferAccountId: null,
    });
  });

  it("writes an investment leg with the id its embedded trade already names", async () => {
    // The trade's `transaction_split_id` was resolved from this id before
    // either row was inserted, so minting a fresh one here would leave the
    // embedded investment pointing at a split that does not exist (issue #1211).
    const { manager, splits } = doubles();

    await writeTransactions(manager, "user-1", {
      ...baseInput,
      transactions: [
        transaction({
          splits: [
            split({
              id: "cccccccc-0000-0000-0000-000000000001",
              kind: SplitKind.INVESTMENT,
              categoryHandle: null,
              investmentHandle: 23,
              amount: -2400,
            }),
          ],
        }),
      ],
    });

    const written = splits.insert.mock.calls[0][0][0];
    expect(written).toMatchObject({
      id: "cccccccc-0000-0000-0000-000000000001",
      kind: SplitKind.INVESTMENT,
      // The table's kind-exclusivity constraint requires both to be null.
      categoryId: null,
      transferAccountId: null,
      amount: -2400,
    });
  });

  it("reports the transaction and split ids that reached the database", async () => {
    const { manager } = doubles();

    const written = await writeTransactions(manager, "user-1", {
      ...baseInput,
      transactions: [
        transaction({
          id: "id-a",
          splits: [split({ id: "split-a" }), split({ id: "split-b" })],
        }),
        // An account the import did not write: neither this row nor its leg
        // lands, so the investment writer must not reference either.
        transaction({
          id: "id-gone",
          handle: 3,
          accountKey: "acct-excluded",
          splits: [split({ id: "split-gone" })],
        }),
      ],
    });

    expect([...written.writtenTransactionIds]).toEqual(["id-a"]);
    expect([...written.writtenSplitIds].sort()).toEqual(["split-a", "split-b"]);
  });

  it("drops a split link whose counterpart is outside the import", async () => {
    const { manager, splits } = doubles();

    await writeTransactions(manager, "user-1", {
      ...baseInput,
      transactions: [
        transaction({ splits: [split({ linkedTransactionId: "id-gone" })] }),
      ],
    });

    expect(splits.insert.mock.calls[0][0][0].linkedTransactionId).toBeNull();
  });

  it("writes nothing when there is nothing to write", async () => {
    const { manager, transactions, splits, query } = doubles();

    const written = await writeTransactions(manager, "user-1", {
      ...baseInput,
      transactions: [],
    });

    expect(written).toMatchObject({
      transactionsCreated: 0,
      splitsCreated: 0,
      linksApplied: 0,
    });
    expect(transactions.insert).not.toHaveBeenCalled();
    expect(splits.insert).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});

describe("writeAccountBalances", () => {
  it("writes every balance in one parameterized statement", async () => {
    const { manager, query } = doubles();

    const written = await writeAccountBalances(
      manager,
      new Map([
        ["account-1", 100.00004],
        ["account-2", -50.5],
      ]),
    );

    expect(written).toBe(2);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain("UPDATE accounts SET current_balance");
    expect(String(sql)).toContain("($1::uuid, $2::numeric)");
    expect(params).toEqual(["account-1", 100, "account-2", -50.5]);
  });

  it("chunks a large balance write", async () => {
    const { manager, query } = doubles();
    const balances = new Map(
      Array.from({ length: INSERT_CHUNK_SIZE + 2 }, (_, index) => [
        `account-${index}`,
        index,
      ]),
    );

    expect(await writeAccountBalances(manager, balances)).toBe(
      INSERT_CHUNK_SIZE + 2,
    );
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("issues no statement when nothing needs a balance", async () => {
    const { manager, query } = doubles();

    expect(await writeAccountBalances(manager, new Map())).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});
