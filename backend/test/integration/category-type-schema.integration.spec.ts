import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { CategoriesModule } from "@/categories/categories.module";
import { TransactionsModule } from "@/transactions/transactions.module";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

// docs/specs/transfer-categories.md sections 11 to 13: the category type, its
// mirror of the legacy `is_income` flag (INV-CATEGORY-003), and the database
// backstop that keeps a Transfer category off a category row
// (INV-CATEGORY-001). These are raw-SQL tests of the triggers themselves, so a
// pod of the previous release, which writes the flag alone, is covered too.
describe("Category type schema (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let userId: string;
  let accountId: string;

  const category = async (
    name: string,
    cols: {
      type?: string;
      isIncome?: boolean;
      parentId?: string | null;
    } = {},
  ): Promise<string> => {
    const rows = await dataSource.query(
      `INSERT INTO categories (user_id, name, parent_id, is_income, category_type)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'expense')) RETURNING id`,
      [
        userId,
        name,
        cols.parentId ?? null,
        cols.isIncome ?? false,
        cols.type ?? null,
      ],
    );
    return rows[0].id;
  };

  const typeOf = async (id: string) =>
    (
      await dataSource.query(
        `SELECT category_type AS "type", is_income AS "isIncome" FROM categories WHERE id = $1`,
        [id],
      )
    )[0];

  const txn = (categoryId: string, isTransfer: boolean) =>
    dataSource.query(
      `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, category_id, is_transfer)
       VALUES ($1, $2, '2026-03-01', -10, 'USD', $3, $4) RETURNING id`,
      [userId, accountId, categoryId, isTransfer],
    );

  const refusedAs = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      return (err as { driverError?: { constraint?: string } }).driverError
        ?.constraint;
    }
    return "accepted";
  };

  beforeAll(async () => {
    module = await createIntegrationModule([
      CategoriesModule,
      TransactionsModule,
    ]);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "transaction_splits",
      "transactions",
      "scheduled_transaction_splits",
      "scheduled_transaction_overrides",
      "scheduled_transactions",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(dataSource)).id;
    accountId = (await createTestAccount(dataSource, userId)).id;
  });

  describe("type and is_income stay in step", () => {
    it("a write of the flag alone sets the type (previous release)", async () => {
      const salary = await category("Salary", { isIncome: true });
      expect(await typeOf(salary)).toEqual({ type: "income", isIncome: true });

      const food = await category("Food");
      await dataSource.query(
        `UPDATE categories SET is_income = true WHERE id = $1`,
        [food],
      );
      expect(await typeOf(food)).toEqual({ type: "income", isIncome: true });
      await dataSource.query(
        `UPDATE categories SET is_income = false WHERE id = $1`,
        [food],
      );
      expect(await typeOf(food)).toEqual({ type: "expense", isIncome: false });
    });

    it("a write of the type sets the flag, and a Transfer category is not income", async () => {
      const id = await category("Savings", { type: "transfer" });
      expect(await typeOf(id)).toEqual({ type: "transfer", isIncome: false });
      // The previous release clearing the flag leaves a Transfer category alone.
      await dataSource.query(
        `UPDATE categories SET is_income = false, name = 'Savings 2' WHERE id = $1`,
        [id],
      );
      expect(await typeOf(id)).toEqual({ type: "transfer", isIncome: false });
      await dataSource.query(
        `UPDATE categories SET category_type = 'income' WHERE id = $1`,
        [id],
      );
      expect(await typeOf(id)).toEqual({ type: "income", isIncome: true });
    });

    it("a child takes its parent's type on insert and on a move, whatever the write said", async () => {
      const transferParent = await category("Transfers", { type: "transfer" });
      const child = await category("Brokerage", {
        parentId: transferParent,
        isIncome: true,
      });
      expect((await typeOf(child)).type).toBe("transfer");

      const incomeParent = await category("Work", { type: "income" });
      const moved = await category("Bonus");
      const grandchild = await category("Q4", { parentId: moved });
      await dataSource.query(
        `UPDATE categories SET parent_id = $2 WHERE id = $1`,
        [moved, incomeParent],
      );
      // The moved category and its whole subtree take the new parent's type.
      expect(await typeOf(moved)).toEqual({ type: "income", isIncome: true });
      expect(await typeOf(grandchild)).toEqual({
        type: "income",
        isIncome: true,
      });
    });

    it("a type change cascades to the subtree, existing mismatches included", async () => {
      const top = await category("Top", { type: "expense" });
      const mid = await category("Mid", { parentId: top });
      // A child whose own flag differs from its parent's exists in real data.
      await dataSource.query(
        `UPDATE categories SET category_type = 'income' WHERE id = $1`,
        [mid],
      );
      const leaf = await category("Leaf", { parentId: mid });
      await dataSource.query(
        `UPDATE categories SET category_type = 'transfer' WHERE id = $1`,
        [top],
      );
      for (const id of [mid, leaf]) {
        expect(await typeOf(id)).toEqual({ type: "transfer", isIncome: false });
      }
    });

    it("an update that leaves the parent alone leaves an existing mismatch as stored", async () => {
      const top = await category("Top");
      const child = await category("Child", { parentId: top });
      await dataSource.query(
        `UPDATE categories SET category_type = 'income' WHERE id = $1`,
        [child],
      );
      await dataSource.query(
        `UPDATE categories SET color = '#112233' WHERE id = $1`,
        [child],
      );
      expect((await typeOf(child)).type).toBe("income");
    });
  });

  describe("a Transfer category goes only on a transfer row (backstop)", () => {
    it("refuses it on an ordinary row and accepts it on a transfer row", async () => {
      const savings = await category("Savings", { type: "transfer" });
      expect(await refusedAs(txn(savings, false))).toBe("category_fits_row");
      expect(await refusedAs(txn(savings, true))).toBe("accepted");
    });

    it("accepts an Income or Expense category on either kind of row", async () => {
      const food = await category("Food");
      expect(await refusedAs(txn(food, false))).toBe("accepted");
      expect(await refusedAs(txn(food, true))).toBe("accepted");
    });

    it("refuses converting a transfer that holds one to an ordinary row, and fires on no other update", async () => {
      const savings = await category("Savings", { type: "transfer" });
      const [{ id }] = await txn(savings, true);
      expect(
        await refusedAs(
          dataSource.query(
            `UPDATE transactions SET description = 'x' WHERE id = $1`,
            [id],
          ),
        ),
      ).toBe("accepted");
      expect(
        await refusedAs(
          dataSource.query(
            `UPDATE transactions SET is_transfer = false WHERE id = $1`,
            [id],
          ),
        ),
      ).toBe("category_fits_row");
      expect(
        await refusedAs(
          dataSource.query(
            `UPDATE transactions SET is_transfer = false, category_id = NULL WHERE id = $1`,
            [id],
          ),
        ),
      ).toBe("accepted");
    });

    it("holds a split's lines: a transfer line may hold a category, a category line may not hold a Transfer one", async () => {
      const savings = await category("Savings", { type: "transfer" });
      const food = await category("Food");
      const other = (
        await createTestAccount(dataSource, userId, { name: "Other" })
      ).id;
      const [{ id: parent }] = await dataSource.query(
        `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, is_split)
         VALUES ($1, $2, '2026-03-01', -30, 'USD', true) RETURNING id`,
        [userId, accountId],
      );
      const split = (kind: string, cat: string, account: string | null) =>
        dataSource.query(
          `INSERT INTO transaction_splits (transaction_id, kind, category_id, transfer_account_id, amount)
           VALUES ($1, $2, $3, $4, -10)`,
          [parent, kind, cat, account],
        );
      // The relaxed constraint: a transfer line holds a category of any type.
      expect(await refusedAs(split("transfer", savings, other))).toBe(
        "accepted",
      );
      expect(await refusedAs(split("transfer", food, other))).toBe("accepted");
      expect(await refusedAs(split("category", food, null))).toBe("accepted");
      expect(await refusedAs(split("category", savings, null))).toBe(
        "category_fits_row",
      );
      // Another CHECK still names itself, so the service can tell the two apart.
      expect(await refusedAs(split("category", food, other))).toBe(
        "chk_split_kind_exclusive",
      );
    });

    it("holds a schedule, its split lines and its overrides", async () => {
      const savings = await category("Savings", { type: "transfer" });
      const schedule = (isTransfer: boolean, cat: string | null) =>
        dataSource.query(
          `INSERT INTO scheduled_transactions (user_id, account_id, name, amount, currency_code, frequency, start_date, next_due_date, is_transfer, category_id)
           VALUES ($1, $2, 'S', -10, 'USD', 'MONTHLY', '2026-03-01', '2026-03-01', $3, $4) RETURNING id`,
          [userId, accountId, isTransfer, cat],
        );
      expect(await refusedAs(schedule(false, savings))).toBe(
        "category_fits_row",
      );
      const [{ id: transferSchedule }] = await schedule(true, savings);
      const [{ id: plainSchedule }] = await schedule(false, null);
      const override = (scheduleId: string) =>
        dataSource.query(
          `INSERT INTO scheduled_transaction_overrides (scheduled_transaction_id, original_date, override_date, category_id)
           VALUES ($1, '2026-04-01', '2026-04-01', $2)`,
          [scheduleId, savings],
        );
      expect(await refusedAs(override(plainSchedule))).toBe(
        "category_fits_row",
      );
      expect(await refusedAs(override(transferSchedule))).toBe("accepted");
    });
  });

  describe("a type change refuses while a category row holds the category", () => {
    it("refuses it on the category, on a move under a Transfer parent, and allows the way back", async () => {
      const food = await category("Food");
      await txn(food, false);
      expect(
        await refusedAs(
          dataSource.query(
            `UPDATE categories SET category_type = 'transfer' WHERE id = $1`,
            [food],
          ),
        ),
      ).toBe("category_type_held");
      const parent = await category("Transfers", { type: "transfer" });
      expect(
        await refusedAs(
          dataSource.query(
            `UPDATE categories SET parent_id = $2 WHERE id = $1`,
            [food, parent],
          ),
        ),
      ).toBe("category_type_held");

      // Only transfer rows hold it: the way back to Expense is allowed.
      const savings = await category("Savings", { type: "transfer" });
      await txn(savings, true);
      expect(
        await refusedAs(
          dataSource.query(
            `UPDATE categories SET category_type = 'expense' WHERE id = $1`,
            [savings],
          ),
        ),
      ).toBe("accepted");
    });

    it("counts a payee default as a holder", async () => {
      const food = await category("Food");
      await dataSource.query(
        `INSERT INTO payees (user_id, name, default_category_id) VALUES ($1, 'P', $2)`,
        [userId, food],
      );
      expect(
        await refusedAs(
          dataSource.query(
            `UPDATE categories SET category_type = 'transfer' WHERE id = $1`,
            [food],
          ),
        ),
      ).toBe("category_type_held");
    });
  });

  describe("serialization against a type change (two connections)", () => {
    it("a row write waits for a pending type change and is then refused", async () => {
      const food = await category("Food");
      const a = dataSource.createQueryRunner();
      const b = dataSource.createQueryRunner();
      await a.connect();
      await b.connect();
      try {
        await a.startTransaction();
        await a.query(
          `UPDATE categories SET category_type = 'transfer' WHERE id = $1`,
          [food],
        );
        await b.startTransaction();
        const blocked = b
          .query(
            `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, category_id)
             VALUES ($1, $2, '2026-03-01', -10, 'USD', $3)`,
            [userId, accountId, food],
          )
          .then(
            () => "accepted",
            (e: { driverError?: { constraint?: string } }) =>
              e.driverError?.constraint,
          );
        await new Promise((r) => setTimeout(r, 500));
        await a.commitTransaction();
        expect(await blocked).toBe("category_fits_row");
        await b.rollbackTransaction();
      } finally {
        await a.release();
        await b.release();
      }
    });

    it("a type change waits for an open write of the owner and then sees its row", async () => {
      const food = await category("Food");
      const a = dataSource.createQueryRunner();
      const b = dataSource.createQueryRunner();
      await a.connect();
      await b.connect();
      try {
        await a.startTransaction();
        await a.query(
          `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, category_id)
           VALUES ($1, $2, '2026-03-01', -10, 'USD', $3)`,
          [userId, accountId, food],
        );
        await b.startTransaction();
        const blocked = b
          .query(
            `UPDATE categories SET category_type = 'transfer' WHERE id = $1`,
            [food],
          )
          .then(
            () => "accepted",
            (e: { driverError?: { constraint?: string } }) =>
              e.driverError?.constraint,
          );
        await new Promise((r) => setTimeout(r, 500));
        await a.commitTransaction();
        expect(await blocked).toBe("category_type_held");
        await b.rollbackTransaction();
      } finally {
        await a.release();
        await b.release();
      }
    });

    it("a colour edit does not wait for an open write that uses the category", async () => {
      const food = await category("Food");
      const a = dataSource.createQueryRunner();
      await a.connect();
      try {
        await a.startTransaction();
        await a.query(
          `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, category_id)
           VALUES ($1, $2, '2026-03-01', -10, 'USD', $3)`,
          [userId, accountId, food],
        );
        const started = Date.now();
        await dataSource.query(
          `UPDATE categories SET color = '#abcdef' WHERE id = $1`,
          [food],
        );
        expect(Date.now() - started).toBeLessThan(2000);
        await a.commitTransaction();
      } finally {
        await a.release();
      }
    });
  });
});
