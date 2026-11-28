import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionStatus } from "@/transactions/entities/transaction.entity";
import { Account } from "@/accounts/entities/account.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * A transfer edit, status change and delete write an action-history entry, so
 * Undo stops at it (refused, 409) instead of reverting the transfer's creation
 * and deleting both legs.
 */
describe("Undo after a transfer change (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let db: DataSource;
  let transactions: TransactionsService;
  let history: ActionHistoryService;
  let userId: string;
  let accountA: string;
  let accountB: string;

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
  });

  async function balances(): Promise<number[]> {
    const rows = await db.manager.find(Account, {
      where: { userId },
      order: { name: "ASC" },
    });
    return rows.map((a) => Number(a.currentBalance));
  }

  const legCount = async (): Promise<number> =>
    Number((await db.query(`SELECT COUNT(*) AS n FROM transactions`))[0].n);

  async function createTransfer(): Promise<string> {
    const result = await asUser(() =>
      transactions.createTransfer(userId, {
        fromAccountId: accountA,
        toAccountId: accountB,
        transactionDate: "2026-01-15",
        amount: 25,
        fromCurrencyCode: "USD",
      }),
    );
    await settlePendingHistoryWrites();
    return result.fromTransaction.id;
  }

  async function expectUndoRefusedAndTransferKept(settled: number[]) {
    await settlePendingHistoryWrites();
    await expect(asUser(() => history.undo(userId))).rejects.toMatchObject({
      response: { errorCode: "UNDO_TRANSFER_CHANGE_NOT_SUPPORTED" },
    });
    expect(await balances()).toEqual(settled);
  }

  it("refuses the undo after a transfer edit and keeps the transfer", async () => {
    const fromId = await createTransfer();
    await asUser(() =>
      transactions.updateTransfer(userId, fromId, { amount: 40 }),
    );
    const settled = await balances();
    expect(settled).toEqual([960, 1040]);
    await expectUndoRefusedAndTransferKept(settled);
    expect(await legCount()).toBe(2);
  });

  it("refuses the undo after a transfer is voided and keeps the transfer", async () => {
    const fromId = await createTransfer();
    await asUser(() =>
      transactions.updateStatus(userId, fromId, TransactionStatus.VOID),
    );
    const settled = await balances();
    await expectUndoRefusedAndTransferKept(settled);
    expect(await legCount()).toBe(2);
  });

  it("refuses the undo after an edit of only the created-at time", async () => {
    const fromId = await createTransfer();
    await asUser(() =>
      transactions.updateTransfer(userId, fromId, {
        createdAt: "2026-01-16T10:00:00.000Z",
      }),
    );
    const settled = await balances();
    await expectUndoRefusedAndTransferKept(settled);
    expect(await legCount()).toBe(2);
  });

  it("refuses the undo after a leg is reconciled and keeps the transfer", async () => {
    const fromId = await createTransfer();
    await asUser(() => transactions.reconcile(userId, fromId));
    const settled = await balances();
    await expectUndoRefusedAndTransferKept(settled);
    expect(await legCount()).toBe(2);
  });

  it("refuses the undo after a bulk reconcile of a transfer leg", async () => {
    const fromId = await createTransfer();
    await asUser(() =>
      transactions.bulkReconcile(userId, accountA, [fromId], "2026-01-31"),
    );
    const settled = await balances();
    await expectUndoRefusedAndTransferKept(settled);
    expect(await legCount()).toBe(2);
  });

  it("records nothing for a tags-only save, so Undo still reaches the create", async () => {
    const fromId = await createTransfer();
    await asUser(() =>
      transactions.updateTransfer(userId, fromId, { tagIds: [] }),
    );
    await settlePendingHistoryWrites();
    await asUser(() => history.undo(userId));
    expect(await legCount()).toBe(0);
  });

  it("refuses the undo after a transfer is deleted", async () => {
    const fromId = await createTransfer();
    await asUser(() => transactions.removeTransfer(userId, fromId));
    const settled = await balances();
    expect(settled).toEqual([1000, 1000]);
    await expectUndoRefusedAndTransferKept(settled);
    expect(await legCount()).toBe(0);
  });
});
