import { ConflictException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { AccountsService } from "@/accounts/accounts.service";
import { AccountType } from "@/accounts/entities/account.entity";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { CategoriesModule } from "@/categories/categories.module";
import { CategoriesService } from "@/categories/categories.service";
import { withUserContext } from "@/common/db/with-context";
import { ScheduledTransactionsService } from "@/scheduled-transactions/scheduled-transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * Kenlasko/monize#2368: a refused delete writes nothing, undo of a delete that
 * moved rows moves them back, and undo of a create that rows now use is refused.
 */
describe("Record in use (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let db: DataSource;
  let categories: CategoriesService;
  let accounts: AccountsService;
  let scheduled: ScheduledTransactionsService;
  let history: ActionHistoryService;
  let userId: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);

  beforeAll(async () => {
    module = await createIntegrationModule([
      CategoriesModule,
      TransactionsModule,
      AccountsModule,
    ]);
    db = module.get(DataSource);
    categories = module.get(CategoriesService, { strict: false });
    accounts = module.get(AccountsService, { strict: false });
    scheduled = module.get(ScheduledTransactionsService, { strict: false });
    history = module.get(ActionHistoryService, { strict: false });
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "action_history",
      "transaction_rules",
      "scheduled_transaction_overrides",
      "scheduled_transaction_splits",
      "scheduled_transactions",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "users",
    ]);
    userId = (await createTestUserDirect(db)).id;
  });

  const undo = async () => {
    await settlePendingHistoryWrites();
    return asUser(() => history.undo(userId));
  };
  const redo = async () => {
    await settlePendingHistoryWrites();
    return asUser(() => history.redo(userId));
  };

  const insertTransaction = async (
    accountId: string,
    categoryId: string | null,
  ): Promise<string> => {
    const [{ id }] = await db.query(
      `INSERT INTO transactions (user_id, account_id, transaction_date, amount,
                                 currency_code, status, category_id)
       VALUES ($1, $2, CURRENT_DATE, -10, 'USD', 'UNRECONCILED', $3)
       RETURNING id`,
      [userId, accountId, categoryId],
    );
    return id;
  };
  const categoryOfTransaction = async (id: string) =>
    (
      await db.query(`SELECT category_id FROM transactions WHERE id = $1`, [id])
    )[0].category_id;
  const count = async (table: string, id: string) =>
    (
      await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id = $1`, [
        id,
      ])
    )[0].n;

  it("a refused delete with reassignTo=uncategorized rolls the move back", async () => {
    const account = (await createTestAccount(db, userId)).id;
    const food = (await createTestCategory(db, userId, { name: "Food" })).id;
    const txn = await insertTransaction(account, food);
    // A rule's JSON names the category: a reference the move does not clear.
    await db.query(
      `INSERT INTO transaction_rules (user_id, name, position, actions)
       VALUES ($1, 'Food rule', 0, $2::jsonb)`,
      [userId, JSON.stringify([{ type: "setCategory", categoryId: food }])],
    );

    const deletion = asUser(() =>
      categories.remove(userId, food, "uncategorized"),
    );
    await expect(deletion).rejects.toBeInstanceOf(ConflictException);
    await expect(deletion).rejects.toMatchObject({
      response: { errorCode: "RECORD_IN_USE" },
    });

    expect(await categoryOfTransaction(txn)).toBe(food);
    expect(await count("categories", food)).toBe(1);
  });

  it("undo of a delete that moved rows moves them back, and redo moves them again", async () => {
    const account = (await createTestAccount(db, userId)).id;
    const food = (await createTestCategory(db, userId, { name: "Food" })).id;
    const other = (await createTestCategory(db, userId, { name: "Other" })).id;
    const txn = await insertTransaction(account, food);
    const [{ id: schedule }] = await db.query(
      `INSERT INTO scheduled_transactions (user_id, account_id, name, amount,
         currency_code, frequency, next_due_date, start_date, is_split)
       VALUES ($1, $2, 'Rent', -500, 'USD', 'MONTHLY', '2026-12-01',
               '2026-12-01', true)
       RETURNING id`,
      [userId, account],
    );
    const [{ id: override }] = await db.query(
      `INSERT INTO scheduled_transaction_overrides
         (scheduled_transaction_id, original_date, override_date, amount,
          is_split, splits)
       VALUES ($1, '2027-01-01', '2027-01-01', -500, true, $2::jsonb)
       RETURNING id`,
      [
        schedule,
        JSON.stringify([
          { categoryId: food, amount: -200 },
          { categoryId: null, amount: -300 },
        ]),
      ],
    );
    const overrideSplits = async () =>
      JSON.stringify(
        (
          await db.query(
            `SELECT splits FROM scheduled_transaction_overrides WHERE id = $1`,
            [override],
          )
        )[0].splits,
      );

    await asUser(() => categories.remove(userId, food, other));
    expect(await categoryOfTransaction(txn)).toBe(other);
    expect(await overrideSplits()).toContain(other);
    expect(await count("categories", food)).toBe(0);

    await undo();
    expect(await count("categories", food)).toBe(1);
    expect(await categoryOfTransaction(txn)).toBe(food);
    expect(await overrideSplits()).toContain(food);
    expect(await overrideSplits()).not.toContain(other);

    await redo();
    expect(await categoryOfTransaction(txn)).toBe(other);
    expect(await overrideSplits()).toContain(other);
    expect(await overrideSplits()).not.toContain(food);
    expect(await count("categories", food)).toBe(0);
  });

  it("refuses to undo the create of an account a transaction now uses", async () => {
    const created = (await asUser(() =>
      accounts.create(userId, {
        accountType: AccountType.CHEQUING,
        name: "Imported",
        currencyCode: "USD",
      } as never),
    )) as { id: string };
    // An import records no history, so the create is still the latest entry.
    const txn = await insertTransaction(created.id, null);

    const undoing = undo();
    await expect(undoing).rejects.toBeInstanceOf(ConflictException);
    await expect(undoing).rejects.toMatchObject({
      response: { errorCode: "RECORD_IN_USE" },
    });

    expect(await count("accounts", created.id)).toBe(1);
    expect(await count("transactions", txn)).toBe(1);
  });

  it("removing a loan's payment schedule clears the loan's link to it", async () => {
    const payFrom = (await createTestAccount(db, userId, { name: "Chequing" }))
      .id;
    const loan = (
      await createTestAccount(db, userId, {
        name: "Car loan",
        accountType: AccountType.LOAN,
      })
    ).id;
    const [{ id: payment }] = await db.query(
      `INSERT INTO scheduled_transactions (user_id, account_id, name, amount,
         currency_code, frequency, next_due_date, start_date, is_transfer,
         transfer_account_id)
       VALUES ($1, $2, 'Loan payment', -500, 'USD', 'MONTHLY', '2026-12-01',
               '2026-12-01', true, $3)
       RETURNING id`,
      [userId, payFrom, loan],
    );
    await db.query(
      `UPDATE accounts SET scheduled_transaction_id = $1 WHERE id = $2`,
      [payment, loan],
    );

    await asUser(() => scheduled.remove(userId, payment));

    expect(await count("scheduled_transactions", payment)).toBe(0);
    const [row] = await db.query(
      `SELECT scheduled_transaction_id FROM accounts WHERE id = $1`,
      [loan],
    );
    expect(row.scheduled_transaction_id).toBeNull();
  });
});
