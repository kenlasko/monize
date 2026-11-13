import { ConflictException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import { ScheduledTransaction } from "@/scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "@/scheduled-transactions/entities/scheduled-transaction-override.entity";
import { ScheduledTransactionSplit } from "@/scheduled-transactions/entities/scheduled-transaction-split.entity";
import { ScheduledTransactionsModule } from "@/scheduled-transactions/scheduled-transactions.module";
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
 * Issue #2165: a posted scheduled occurrence is one history entry, and its
 * undo puts back everything the posting did -- the money and its balance, the
 * occurrence claim, and the schedule's cursor (or, for a one-time bill, the
 * schedule the posting deleted). Before, the posting left at best a
 * "Created transaction" entry whose undo deleted the row and left the
 * schedule advanced past an occurrence nobody had paid.
 */
describe("Undo of a scheduled posting (integration)", () => {
  jest.setTimeout(60000);

  const OPENING = 1000;
  const FIRST_DUE = "2025-01-15";
  const SECOND_DUE = "2025-02-15";

  let module: TestingModule;
  let db: DataSource;
  let scheduled: ScheduledTransactionsService;
  let history: ActionHistoryService;
  let userId: string;
  let accountId: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);

  beforeAll(async () => {
    module = await createIntegrationModule([
      AccountsModule,
      TransactionsModule,
      ScheduledTransactionsModule,
    ]);
    db = module.get(DataSource);
    scheduled = module.get(ScheduledTransactionsService);
    history = module.get(ActionHistoryService, { strict: false });
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "action_history",
      "scheduled_transaction_postings",
      "scheduled_transaction_overrides",
      "scheduled_transaction_split_tags",
      "scheduled_transaction_splits",
      "scheduled_transactions",
      "transaction_tags",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "payees",
      "monthly_account_balances",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2)
       ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(db)).id;
    accountId = (
      await createTestAccount(db, userId, {
        name: "Chequing",
        openingBalance: OPENING,
        currentBalance: OPENING,
      })
    ).id;
  });

  async function makeSchedule(
    fields: Partial<ScheduledTransaction>,
  ): Promise<string> {
    const row = await db.manager.save(
      db.manager.create(ScheduledTransaction, {
        userId,
        accountId,
        name: "Gym",
        amount: -42.5,
        currencyCode: "USD",
        frequency: "MONTHLY",
        nextDueDate: FIRST_DUE,
        startDate: FIRST_DUE,
        isActive: true,
        autoPost: false,
        ...fields,
      } as Partial<ScheduledTransaction>),
    );
    return row.id;
  }

  const post = (id: string) => asUser(() => scheduled.post(userId, id));

  async function undo() {
    await settlePendingHistoryWrites();
    return asUser(() => history.undo(userId));
  }

  async function historyRows() {
    await settlePendingHistoryWrites();
    return db.query(
      `SELECT entity_type, action, description_key, is_undone
         FROM action_history WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
  }

  async function balanceOf(id: string): Promise<number> {
    const [row] = await db.query(
      `SELECT current_balance FROM accounts WHERE id = $1`,
      [id],
    );
    return Number(row.current_balance);
  }

  async function ledgerRows(id: string): Promise<number> {
    const [row] = await db.query(
      `SELECT count(*)::int AS c FROM transactions WHERE account_id = $1`,
      [id],
    );
    return row.c;
  }

  async function claims(id: string): Promise<string[]> {
    const rows: { d: string }[] = await db.query(
      `SELECT TO_CHAR(original_due_date, 'YYYY-MM-DD') AS d
         FROM scheduled_transaction_postings
        WHERE scheduled_transaction_id = $1 ORDER BY 1`,
      [id],
    );
    return rows.map((r) => r.d);
  }

  async function cursorOf(id: string) {
    const [row] = await db.query(
      `SELECT TO_CHAR(next_due_date, 'YYYY-MM-DD') AS next_due_date,
              TO_CHAR(last_posted_date, 'YYYY-MM-DD') AS last_posted_date,
              occurrences_remaining, is_active
         FROM scheduled_transactions WHERE id = $1`,
      [id],
    );
    return row;
  }

  it("records one posting entry, not a transaction create", async () => {
    const id = await makeSchedule({});
    await post(id);

    expect(await historyRows()).toEqual([
      {
        entity_type: "scheduled_posting",
        action: "post",
        description_key: "postedScheduledTransaction",
        is_undone: false,
      },
    ]);
  });

  it("undo removes the payment, releases the claim and rewinds the cursor", async () => {
    const id = await makeSchedule({ occurrencesRemaining: 1 });
    await post(id);
    expect(await ledgerRows(accountId)).toBe(1);
    expect(await balanceOf(accountId)).toBe(OPENING - 42.5);
    expect(await cursorOf(id)).toMatchObject({
      next_due_date: SECOND_DUE,
      occurrences_remaining: 0,
      is_active: false,
    });

    await undo();

    expect(await ledgerRows(accountId)).toBe(0);
    expect(await balanceOf(accountId)).toBe(OPENING);
    expect(await claims(id)).toEqual([]);
    expect(await cursorOf(id)).toEqual({
      next_due_date: FIRST_DUE,
      last_posted_date: null,
      occurrences_remaining: 1,
      is_active: true,
    });

    // The occurrence is due again and posts as it did the first time.
    await post(id);
    expect(await claims(id)).toEqual([FIRST_DUE]);
    expect(await balanceOf(accountId)).toBe(OPENING - 42.5);
  });

  it("undo puts back the override the posting consumed", async () => {
    const id = await makeSchedule({});
    await db.manager.save(
      db.manager.create(ScheduledTransactionOverride, {
        scheduledTransactionId: id,
        originalDate: FIRST_DUE,
        overrideDate: FIRST_DUE,
        amount: -60,
      } as Partial<ScheduledTransactionOverride>),
    );
    await post(id);
    expect(await balanceOf(accountId)).toBe(OPENING - 60);

    await undo();

    const overrides = await db.query(
      `SELECT TO_CHAR(original_date, 'YYYY-MM-DD') AS d, amount::float8 AS amount
         FROM scheduled_transaction_overrides
        WHERE scheduled_transaction_id = $1`,
      [id],
    );
    expect(overrides).toEqual([{ d: FIRST_DUE, amount: -60 }]);
    expect(await balanceOf(accountId)).toBe(OPENING);
  });

  it("undo of a one-time split bill brings the schedule back with its lines", async () => {
    const food = await createTestCategory(db, userId, { name: "Food" });
    const fuel = await createTestCategory(db, userId, { name: "Fuel" });
    const id = await makeSchedule({
      name: "Road trip",
      amount: -100,
      frequency: "ONCE",
      isSplit: true,
    });
    for (const [categoryId, amount] of [
      [food.id, -70],
      [fuel.id, -30],
    ] as const) {
      await db.manager.save(
        db.manager.create(ScheduledTransactionSplit, {
          scheduledTransactionId: id,
          categoryId,
          amount,
        } as Partial<ScheduledTransactionSplit>),
      );
    }

    expect(await post(id)).toBeNull();
    expect(
      await db.query(`SELECT id FROM scheduled_transactions WHERE id = $1`, [
        id,
      ]),
    ).toEqual([]);
    expect(await balanceOf(accountId)).toBe(OPENING - 100);

    await undo();

    expect(await ledgerRows(accountId)).toBe(0);
    expect(await balanceOf(accountId)).toBe(OPENING);
    const restored = await asUser(() => scheduled.findOne(userId, id));
    expect(restored).toMatchObject({
      name: "Road trip",
      frequency: "ONCE",
      isSplit: true,
      nextDueDate: FIRST_DUE,
    });
    expect(
      restored.splits.map((s) => [s.categoryId, Number(s.amount)]).sort(),
    ).toEqual(
      [
        [food.id, -70],
        [fuel.id, -30],
      ].sort(),
    );

    // It posts again.
    expect(await post(id)).toBeNull();
    expect(await balanceOf(accountId)).toBe(OPENING - 100);
  });

  it("undo of a scheduled transfer removes both legs and rewinds", async () => {
    const savingsId = (
      await createTestAccount(db, userId, {
        name: "Savings",
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
    const id = await makeSchedule({
      name: "Save",
      amount: -200,
      isTransfer: true,
      transferAccountId: savingsId,
    });
    await post(id);
    expect(await balanceOf(accountId)).toBe(OPENING - 200);
    expect(await balanceOf(savingsId)).toBe(200);
    expect((await historyRows()).map((r: any) => r.entity_type)).toEqual([
      "scheduled_posting",
    ]);

    await undo();

    expect(await ledgerRows(accountId)).toBe(0);
    expect(await ledgerRows(savingsId)).toBe(0);
    expect(await balanceOf(accountId)).toBe(OPENING);
    expect(await balanceOf(savingsId)).toBe(0);
    expect(await claims(id)).toEqual([]);
    expect((await cursorOf(id)).next_due_date).toBe(FIRST_DUE);
  });

  it("refuses, writing nothing, while a later occurrence holds a claim", async () => {
    const id = await makeSchedule({});
    await post(id);
    // A later slot claimed outside this entry (a rule's settlement, say).
    await db.query(
      `INSERT INTO scheduled_transaction_postings
         (scheduled_transaction_id, original_due_date, posted_date)
       VALUES ($1, $2, $2)`,
      [id, "2025-03-15"],
    );

    await expect(undo()).rejects.toThrow(ConflictException);

    expect(await ledgerRows(accountId)).toBe(1);
    expect(await balanceOf(accountId)).toBe(OPENING - 42.5);
    expect(await claims(id)).toEqual([FIRST_DUE, "2025-03-15"]);
    expect((await cursorOf(id)).next_due_date).toBe(SECOND_DUE);
    expect((await historyRows())[0].is_undone).toBe(false);
  });

  it("a later slot already claimed when it posted does not block the undo", async () => {
    const id = await makeSchedule({});
    // A rule settled February ahead of the cursor; posting January steps
    // the cursor over it to March.
    await db.query(
      `INSERT INTO scheduled_transaction_postings
         (scheduled_transaction_id, original_due_date, posted_date)
       VALUES ($1, $2, $2)`,
      [id, SECOND_DUE],
    );
    await post(id);
    expect((await cursorOf(id)).next_due_date).toBe("2025-03-15");

    await undo();

    expect(await ledgerRows(accountId)).toBe(0);
    expect(await claims(id)).toEqual([SECOND_DUE]);
    expect((await cursorOf(id)).next_due_date).toBe(FIRST_DUE);
  });

  it("refuses, writing nothing, when the next occurrence was skipped since", async () => {
    const id = await makeSchedule({});
    await post(id);
    await asUser(() => scheduled.skip(userId, id));
    expect((await cursorOf(id)).next_due_date).toBe("2025-03-15");

    await expect(undo()).rejects.toThrow(ConflictException);

    expect(await ledgerRows(accountId)).toBe(1);
    expect(await claims(id)).toEqual([FIRST_DUE]);
    expect((await cursorOf(id)).next_due_date).toBe("2025-03-15");
  });

  it("a one-time bill whose category was deleted since comes back without it", async () => {
    const gifts = await createTestCategory(db, userId, { name: "Gifts" });
    const id = await makeSchedule({
      name: "Present",
      frequency: "ONCE",
      categoryId: gifts.id,
    });
    await post(id);
    await db.query(`UPDATE transactions SET category_id = NULL`);
    await db.query(`DELETE FROM categories WHERE id = $1`, [gifts.id]);

    await undo();

    const [row] = await db.query(
      `SELECT name, category_id FROM scheduled_transactions WHERE id = $1`,
      [id],
    );
    expect(row).toEqual({ name: "Present", category_id: null });
    expect(await balanceOf(accountId)).toBe(OPENING);
  });

  it("is not redoable: the person posts the occurrence again", async () => {
    const id = await makeSchedule({});
    await post(id);
    await undo();

    await expect(asUser(() => history.redo(userId))).rejects.toThrow(
      ConflictException,
    );
    expect(await ledgerRows(accountId)).toBe(0);
    expect((await cursorOf(id)).next_due_date).toBe(FIRST_DUE);
  });
});
