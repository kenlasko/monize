import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { Account } from "@/accounts/entities/account.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * Undo of a form edit of a split transaction that has a transfer line. The form
 * resends every split, so the edit deletes and re-creates the counterpart legs;
 * the undo must not replay split rows that name legs that no longer exist.
 */
describe("Undo of an edit of a split with a transfer line (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let db: DataSource;
  let transactions: TransactionsService;
  let history: ActionHistoryService;
  let userId: string;
  let accountA: string;
  let accountB: string;
  let categoryId: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    db = module.get(DataSource);
    transactions = module.get(TransactionsService);
    history = module.get(ActionHistoryService, { strict: false });
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "action_history",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "monthly_account_balances",
      "users",
    ]);
    userId = (await createTestUserDirect(db)).id;
    accountA = (
      await createTestAccount(db, userId, {
        name: "A",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    accountB = (
      await createTestAccount(db, userId, {
        name: "B",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    categoryId = (await createTestCategory(db, userId, { name: "Food" })).id;
  });

  const splits = () => [
    { categoryId, amount: -60 },
    { transferAccountId: accountB, amount: -40 },
  ];

  async function createSplit(): Promise<string> {
    const tx = await asUser(() =>
      transactions.create(userId, {
        accountId: accountA,
        transactionDate: "2026-01-15",
        amount: -100,
        currencyCode: "USD",
        description: "before",
        isSplit: true,
        splits: splits(),
      }),
    );
    return tx.id;
  }

  async function balances(): Promise<number[]> {
    const rows = await db.manager.find(Account, {
      where: { userId },
      order: { name: "ASC" },
    });
    return rows.map((a) => Number(a.currentBalance));
  }

  async function settledUndo() {
    await settlePendingHistoryWrites();
    return asUser(() => history.undo(userId));
  }

  async function settledRedo() {
    await settlePendingHistoryWrites();
    return asUser(() => history.redo(userId));
  }

  it("undo of a description-only edit that resent the same splits restores the description and moves no balance", async () => {
    const id = await createSplit();
    await asUser(() =>
      transactions.update(userId, id, {
        description: "after",
        isSplit: true,
        splits: splits(),
      }),
    );
    const settled = await balances();
    expect(settled).toEqual([900, 1040]);

    await settledUndo();

    const row = await db.manager.findOneByOrFail(Transaction, { id });
    expect(row.description).toBe("before");
    expect(await balances()).toEqual(settled);

    await settledRedo();
    const redone = await db.manager.findOneByOrFail(Transaction, { id });
    expect(redone.description).toBe("after");
    expect(await balances()).toEqual(settled);
  });

  it("refuses the undo of an edit that changed a transfer line, before any write", async () => {
    const id = await createSplit();
    await asUser(() =>
      transactions.update(userId, id, {
        isSplit: true,
        splits: [
          { categoryId, amount: -60 },
          { transferAccountId: accountB, amount: -30 },
          { categoryId, amount: -10 },
        ],
      }),
    );
    const settled = await balances();

    await expect(settledUndo()).rejects.toMatchObject({
      response: { errorCode: "UNDO_SPLIT_LEGS_CHANGED" },
    });
    expect(await balances()).toEqual(settled);
  });

  it("refuses the undo of deleting a split with a transfer line, before any write", async () => {
    const id = await createSplit();
    await asUser(() => transactions.remove(userId, id));
    const settled = await balances();

    await expect(settledUndo()).rejects.toMatchObject({
      response: { errorCode: "UNDO_DELETED_SPLIT_HAS_TRANSFER_LINE" },
    });
    expect(await balances()).toEqual(settled);
    expect(await db.manager.countBy(Transaction, { id })).toBe(0);
  });

  it("refuses the undo of deleting one leg of a plain transfer, before any write", async () => {
    await asUser(() =>
      transactions.createTransfer(userId, {
        fromAccountId: accountA,
        toAccountId: accountB,
        transactionDate: "2026-01-15",
        amount: 25,
        fromCurrencyCode: "USD",
      }),
    );
    // The create entry is written fire-and-forget; settle it so the entry
    // recorded below is the newest one undo takes.
    await settlePendingHistoryWrites();
    const [leg] = await db.query(
      `SELECT id, linked_transaction_id AS "linkedTransactionId"
         FROM transactions WHERE account_id = $1`,
      [accountB],
    );
    // A recorded single-leg delete exists only in older history entries, so the
    // row is deleted by SQL and its entry recorded as `remove` once wrote it.
    await db.query(`DELETE FROM transactions WHERE id = $1`, [leg.id]);
    await asUser(() =>
      history.record(userId, {
        entityType: "transaction",
        entityId: leg.id,
        action: "delete",
        beforeData: {
          id: leg.id,
          accountId: accountB,
          transactionDate: "2026-01-15",
          amount: 25,
          currencyCode: "USD",
          isTransfer: true,
          linkedTransactionId: leg.linkedTransactionId,
          splits: [],
          tagIds: [],
        },
        afterData: null,
        description: "Deleted transaction",
      }),
    );
    const settled = await balances();

    await expect(settledUndo()).rejects.toMatchObject({
      response: { errorCode: "UNDO_TRANSFER_LEG_DELETED" },
    });
    expect(await balances()).toEqual(settled);
    expect(await db.manager.countBy(Transaction, { id: leg.id })).toBe(0);
  });

  it("refuses the undo of a VOID that reached the legs, with every balance unchanged", async () => {
    const id = await createSplit();
    await asUser(() =>
      transactions.update(userId, id, { status: TransactionStatus.VOID }),
    );
    const settled = await balances();

    await expect(settledUndo()).rejects.toMatchObject({
      response: { errorCode: "UNDO_VOID_WITH_LEGS" },
    });
    expect(await balances()).toEqual(settled);
    const row = await db.manager.findOneByOrFail(Transaction, { id });
    expect(row.status).toBe("VOID");
  });
});
