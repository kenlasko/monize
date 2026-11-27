import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { withUserContext } from "@/common/db/with-context";
import { ImportModule } from "@/import/import.module";
import { ImportService } from "@/import/import.service";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The importer rows of `docs/specs/transfer-categories.md` section 4.5
 * (INV-CATEGORY-001 FIT, INV-CATEGORY-002 ONE) on the QIF path, which the
 * OFX and CSV paths share (`ImportRegularProcessorService.processTransaction`):
 * a transfer gets no payee default, and a category row or split category
 * line whose category maps to a Transfer category is imported uncategorized
 * and counted. The Money mapper's rule is held by its unit specs
 * (`map-transactions.spec.ts`, `fit-mny-category.spec.ts`).
 */
describe("Category fit: importers (integration)", () => {
  jest.setTimeout(120000);

  /**
   * Rows whose behaviour a later step of PR 3 builds. Each runs as
   * `it.failing`; the step that builds a row removes it here. Shrink-only.
   */
  const NOT_YET_BUILT = new Set<string>([]);
  const row = (title: string, fn: () => Promise<void>) =>
    (NOT_YET_BUILT.has(title) ? it.failing : it)(title, fn);

  let module: TestingModule;
  let db: DataSource;
  let importer: ImportService;
  let userId: string;
  let chequingId: string;
  let savingsId: string;
  let transferCat: string;
  let expenseCat: string;

  beforeAll(async () => {
    module = await createIntegrationModule([ImportModule]);
    db = module.get(DataSource);
    importer = module.get(ImportService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "action_history",
      "transaction_tags",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "payee_aliases",
      "payees",
      "categories",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(db)).id;
    chequingId = (
      await createTestAccount(db, userId, {
        name: "Checking",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    savingsId = (await createTestAccount(db, userId, { name: "Savings" })).id;
    const category = async (name: string, type: string) =>
      (
        await db.query(
          `INSERT INTO categories (user_id, name, category_type, is_income)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [userId, name, type, type === "income"],
        )
      )[0].id as string;
    transferCat = await category("Savings contributions", "transfer");
    expenseCat = await category("Groceries", "expense");
  });

  const importQif = (content: string, categoryId?: string) =>
    withUserContext(userId, () =>
      importer.importQifFile(userId, {
        content,
        accountId: chequingId,
        categoryMappings: categoryId
          ? [{ originalName: "Mapped", categoryId }]
          : [],
        accountMappings: [{ originalName: "Savings", accountId: savingsId }],
        dateFormat: "MM/DD/YYYY",
      } as never),
    );
  const rowsOf = (accountId: string) =>
    db.query(
      `SELECT id, category_id, is_transfer, is_split FROM transactions
        WHERE account_id = $1 ORDER BY amount`,
      [accountId],
    ) as Promise<
      {
        id: string;
        category_id: string | null;
        is_transfer: boolean;
        is_split: boolean;
      }[]
    >;

  row("QIF: a transfer gets no payee default, on either leg", async () => {
    await db.query(
      `INSERT INTO payees (user_id, name, default_category_id) VALUES ($1, 'Bank', $2)`,
      [userId, expenseCat],
    );
    await importQif(
      "!Type:Bank\nD03/01/2026\nT-100.00\nPBank\nL[Savings]\n^\n",
    );
    const [leg] = await rowsOf(chequingId);
    expect(leg).toMatchObject({ is_transfer: true, category_id: null });
    const [other] = await rowsOf(savingsId);
    expect(other.category_id).toBeNull();
  });

  row(
    "QIF: an ordinary row whose category maps to a Transfer category is imported uncategorized and counted",
    async () => {
      const result = await importQif(
        "!Type:Bank\nD03/01/2026\nT-25.00\nPStore\nLMapped\n^\n",
        transferCat,
      );
      const [ordinary] = await rowsOf(chequingId);
      expect(ordinary.category_id).toBeNull();
      expect(result.imported).toBe(1);
      expect(result.categoriesNotFitting).toBe(1);
    },
  );

  row(
    "QIF: a split category line whose category maps to a Transfer category is imported uncategorized and counted",
    async () => {
      const result = await importQif(
        "!Type:Bank\nD03/01/2026\nT-50.00\nPStore\nSMapped\n$-30.00\nS[Savings]\n$-20.00\n^\n",
        transferCat,
      );
      const [parent] = await rowsOf(chequingId);
      const lines = await db.query(
        `SELECT category_id, transfer_account_id FROM transaction_splits WHERE transaction_id = $1`,
        [parent.id],
      );
      const categoryLine = lines.find(
        (line: { transfer_account_id: string | null }) =>
          !line.transfer_account_id,
      );
      expect(categoryLine.category_id).toBeNull();
      expect(result.categoriesNotFitting).toBe(1);
    },
  );

  row(
    "QIF: an ordinary row keeps an Income or Expense category, with nothing counted",
    async () => {
      const result = await importQif(
        "!Type:Bank\nD03/01/2026\nT-25.00\nPStore\nLMapped\n^\n",
        expenseCat,
      );
      const [ordinary] = await rowsOf(chequingId);
      expect(ordinary.category_id).toBe(expenseCat);
      expect(result.categoriesNotFitting).toBeUndefined();
    },
  );
});
