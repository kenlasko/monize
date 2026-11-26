import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * Undo restores amount_is_provisional with the row (design P7,
 * docs/specs/provisional-amounts.md): a deleted provisional row comes
 * back provisional, and a confirmed one comes back confirmed.
 */
describe("Undo of a delete restores amount_is_provisional (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let db: DataSource;
  let transactions: TransactionsService;
  let history: ActionHistoryService;
  let userId: string;
  let accountId: string;

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
    accountId = (
      await createTestAccount(db, userId, {
        name: "EU Checking",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
  });

  /** A row the importer flagged; no request path can set the column. */
  async function createRow(provisional: boolean): Promise<string> {
    const tx = await asUser(() =>
      transactions.create(userId, {
        accountId,
        transactionDate: "2026-08-14",
        amount: 80,
        currencyCode: "USD",
        description: "Transfer from US Checking",
      }),
    );
    if (provisional) {
      await db.query(
        `UPDATE transactions SET amount_is_provisional = true WHERE id = $1`,
        [tx.id],
      );
    }
    return tx.id;
  }

  async function deleteThenUndo(id: string): Promise<Transaction> {
    await asUser(() => transactions.remove(userId, id));
    expect(await db.manager.findOneBy(Transaction, { id })).toBeNull();
    await settlePendingHistoryWrites();
    await asUser(() => history.undo(userId));
    return db.manager.findOneByOrFail(Transaction, { id });
  }

  it("a deleted provisional row comes back provisional", async () => {
    const id = await createRow(true);

    const restored = await deleteThenUndo(id);

    expect(restored.amountIsProvisional).toBe(true);
    expect(Number(restored.amount)).toBe(80);
  });

  it("a deleted confirmed row comes back confirmed", async () => {
    const id = await createRow(false);

    const restored = await deleteThenUndo(id);

    expect(restored.amountIsProvisional).toBe(false);
  });
});
