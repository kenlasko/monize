import { BadRequestException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { withUserContext } from "@/common/db/with-context";
import { TransactionToolPrepService } from "@/transactions/transaction-tool-prep.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The assistant and MCP rows of `docs/specs/transfer-categories.md` section
 * 4.4 (INV-CATEGORY-001), through the shared tool preparation both adapters
 * call (`TransactionToolPrepService`): a category a model names resolves among
 * the categories that fit the row it lands on, a Transfer category first on a
 * transfer, and a Transfer category named for an ordinary row or a split's
 * category line is refused with the reason, before any card is built.
 */
describe("Category fit: assistant and MCP write tools (integration)", () => {
  jest.setTimeout(90000);

  let module: TestingModule;
  let db: DataSource;
  let prep: TransactionToolPrepService;
  let transactions: TransactionsService;
  let userId: string;
  let savingsTransfer: string;
  let savingsExpense: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    db = module.get(DataSource);
    prep = module.get(TransactionToolPrepService);
    transactions = module.get(TransactionsService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "action_history",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "payees",
      "categories",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(db)).id;
    await createTestAccount(db, userId, { name: "Checking" });
    await createTestAccount(db, userId, { name: "Brokerage" });
    const category = async (name: string, type: string, parent?: string) =>
      (
        await db.query(
          `INSERT INTO categories (user_id, name, category_type, parent_id)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [userId, name, type, parent ?? null],
        )
      )[0].id as string;
    // Two categories of one name, one of each kind: the row decides.
    savingsTransfer = await category("Savings", "transfer");
    savingsExpense = await category(
      "Savings",
      "expense",
      await category("Household", "expense"),
    );
    await category("Investments", "transfer");
  });

  it("refuses a Transfer category named for an ordinary row, saying why", async () => {
    const refusal = asUser(() =>
      prep.prepareCreateSingle(userId, {
        accountName: "Checking",
        amount: -25,
        date: "2026-03-02",
        categoryName: "Investments",
      }),
    );
    await expect(refusal).rejects.toBeInstanceOf(BadRequestException);
    await expect(refusal).rejects.toThrow(/Transfer category/);
  });

  it("refuses a Transfer category named for a split's category line", async () => {
    await expect(
      asUser(() =>
        prep.prepareCreateSingle(userId, {
          accountName: "Checking",
          amount: -25,
          date: "2026-03-02",
          splits: [
            { categoryName: "Investments", amount: -20 },
            { categoryName: "Household", amount: -5 },
          ],
        } as never),
      ),
    ).rejects.toThrow(/Transfer category/);
  });

  it("resolves a shared name to the category that fits: Expense on an ordinary row, Transfer on a transfer", async () => {
    const ordinary = await asUser(() =>
      prep.prepareCreateSingle(userId, {
        accountName: "Checking",
        amount: -25,
        date: "2026-03-02",
        categoryName: "Savings",
      }),
    );
    expect(ordinary.preview.categoryId).toBe(savingsExpense);

    const transfer = await asUser(() =>
      prep.prepareCreateTransferSingle(userId, {
        fromAccountName: "Checking",
        toAccountName: "Brokerage",
        amount: 100,
        date: "2026-03-02",
        categoryName: "Savings",
      }),
    );
    expect(transfer.categoryId).toBe(savingsTransfer);
  });

  it("refuses a Transfer category on an update of an ordinary row, and lets a transfer take one", async () => {
    const [chequing] = await db.query(
      `SELECT id FROM accounts WHERE user_id = $1 AND name = 'Checking'`,
      [userId],
    );
    const row = await asUser(() =>
      transactions.create(userId, {
        accountId: chequing.id,
        transactionDate: "2026-03-02",
        amount: -25,
        currencyCode: "USD",
      } as never),
    );
    await expect(
      asUser(() =>
        prep.prepareUpdate(userId, {
          transactionId: row.id,
          categoryName: "Investments",
        }),
      ),
    ).rejects.toThrow(/Transfer category/);

    const [brokerage] = await db.query(
      `SELECT id FROM accounts WHERE user_id = $1 AND name = 'Brokerage'`,
      [userId],
    );
    const pair = await asUser(() =>
      transactions.createTransfer(userId, {
        fromAccountId: chequing.id,
        toAccountId: brokerage.id,
        transactionDate: "2026-03-03",
        amount: 100,
      } as never),
    );
    const edit = await asUser(() =>
      prep.prepareUpdate(userId, {
        transactionId: pair.fromTransaction.id,
        categoryName: "Investments",
      }),
    );
    expect(edit.kind).toBe("transfer");
  });
});
