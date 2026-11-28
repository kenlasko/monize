import { BadRequestException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { CategoriesModule } from "@/categories/categories.module";
import { TransactionsModule } from "@/transactions/transactions.module";
import { CategoriesService } from "@/categories/categories.service";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

// docs/specs/transfer-categories.md sections 4.6, 4.7 and 13: the category
// service's type rules against a real database and the triggers beneath it.
describe("Category type, through the service (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let db: DataSource;
  let service: CategoriesService;
  let history: ActionHistoryService;
  let userId: string;
  let accountId: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);
  const create = (dto: Parameters<CategoriesService["create"]>[1]) =>
    asUser(() => service.create(userId, dto));
  const update = (
    id: string,
    dto: Parameters<CategoriesService["update"]>[2],
  ) => asUser(() => service.update(userId, id, dto));
  const typeOf = async (id: string) =>
    (
      await db.query(
        `SELECT category_type AS "type" FROM categories WHERE id = $1`,
        [id],
      )
    )[0];
  const post = (categoryId: string, isTransfer: boolean) =>
    db.query(
      `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, category_id, is_transfer)
       VALUES ($1, $2, '2026-03-01', -10, 'USD', $3, $4)`,
      [userId, accountId, categoryId, isTransfer],
    );

  beforeAll(async () => {
    module = await createIntegrationModule([
      CategoriesModule,
      TransactionsModule,
    ]);
    db = module.get(DataSource);
    service = module.get(CategoriesService);
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
      "payees",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(db)).id;
    accountId = (await createTestAccount(db, userId)).id;
  });

  it("creates, lists, edits and deletes a Transfer category", async () => {
    const savings = await create({ name: "Savings", type: "transfer" });
    expect(savings.categoryType).toBe("transfer");
    expect(savings).not.toHaveProperty("isIncome");

    const listed = await asUser(() =>
      service.findByCategoryType(userId, "transfer"),
    );
    expect(listed.map((c) => c.id)).toEqual([savings.id]);
    expect(await asUser(() => service.getStats(userId))).toMatchObject({
      transferCategories: 1,
      expenseCategories: 0,
      incomeCategories: 0,
    });
    // "Expense" is the expense type: a Transfer category is not in it.
    expect(await asUser(() => service.findByType(userId, false))).toEqual([]);

    const renamed = await update(savings.id, { name: "Savings plan" });
    expect(renamed.name).toBe("Savings plan");
    expect(renamed.categoryType).toBe("transfer");

    await asUser(() => service.remove(userId, savings.id));
    expect(
      await db.query(`SELECT 1 FROM categories WHERE id = $1`, [savings.id]),
    ).toEqual([]);
  });

  it("gives a subcategory its parent's type and refuses another", async () => {
    const parent = await create({ name: "Transfers", type: "transfer" });
    const child = await create({ name: "Brokerage", parentId: parent.id });
    expect(await typeOf(child.id)).toEqual({ type: "transfer" });

    await expect(
      create({ name: "Odd", parentId: parent.id, type: "income" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a type change while a category row holds the category, naming nothing written", async () => {
    const food = await create({ name: "Food", type: "expense" });
    await post(food.id, false);

    await expect(update(food.id, { type: "transfer" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect((await typeOf(food.id)).type).toBe("expense");
  });

  it("allows a type change when only transfer rows hold the category, and the way back", async () => {
    const food = await create({ name: "Food", type: "expense" });
    await post(food.id, true);

    await update(food.id, { type: "transfer" });
    expect((await typeOf(food.id)).type).toBe("transfer");
    await update(food.id, { type: "expense" });
    expect((await typeOf(food.id)).type).toBe("expense");
  });

  it("refuses the change when a descendant is held, and re-types a subtree it allows", async () => {
    const top = await create({ name: "Top", type: "expense" });
    const leaf = await create({ name: "Leaf", parentId: top.id });
    await post(leaf.id, false);
    await expect(update(top.id, { type: "transfer" })).rejects.toBeInstanceOf(
      BadRequestException,
    );

    await update(top.id, { type: "income" });
    expect(await typeOf(leaf.id)).toEqual({ type: "income" });
  });

  it("re-types the moved category's subtree when it moves under another type", async () => {
    const transfers = await create({ name: "Transfers", type: "transfer" });
    const moved = await create({ name: "Moved", type: "expense" });
    const leaf = await create({ name: "Leaf", parentId: moved.id });

    await update(moved.id, { parentId: transfers.id });

    expect((await typeOf(moved.id)).type).toBe("transfer");
    expect((await typeOf(leaf.id)).type).toBe("transfer");
  });

  it("refuses a move under a Transfer parent while the moved category is held", async () => {
    const transfers = await create({ name: "Transfers", type: "transfer" });
    const food = await create({ name: "Food", type: "expense" });
    await post(food.id, false);

    await expect(
      update(food.id, { parentId: transfers.id }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect((await typeOf(food.id)).type).toBe("expense");
  });

  it("undo of a type change restores the type, and refuses a type a holder no longer fits", async () => {
    const food = await create({ name: "Food", type: "expense" });
    await update(food.id, { type: "transfer" });
    await settlePendingHistoryWrites();
    await asUser(() => history.undo(userId));
    expect(await typeOf(food.id)).toEqual({ type: "expense" });

    // Redo to Transfer, then an ordinary row takes the category's place in the
    // way: undoing the next change back to Transfer is refused.
    await asUser(() => history.redo(userId));
    expect((await typeOf(food.id)).type).toBe("transfer");
    await update(food.id, { type: "expense" });
    await post(food.id, false);
    await settlePendingHistoryWrites();
    await expect(asUser(() => history.undo(userId))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect((await typeOf(food.id)).type).toBe("expense");
  });

  it("seeds the default Transfer set under one parent", async () => {
    await asUser(() => service.importDefaults(userId, {}));

    const rows = await db.query(
      `SELECT c.name, c.category_type AS "type", p.name AS "parent"
         FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
        WHERE c.user_id = $1 AND c.category_type = 'transfer'
        ORDER BY c.name`,
      [userId],
    );
    expect(rows.map((r: { name: string }) => r.name)).toEqual([
      "Between Own Accounts",
      "Cash Withdrawals",
      "Credit Card Payments",
      "Investment Contributions",
      "Savings Contributions",
      "Transfers",
    ]);
    expect(
      rows
        .filter((r: { parent: string | null }) => r.parent)
        .every((r: { parent: string }) => r.parent === "Transfers"),
    ).toBe(true);
  });
});
