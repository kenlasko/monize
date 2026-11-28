import { TestingModule } from "@nestjs/testing";
import { DataSource, QueryRunner } from "typeorm";

import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import { ImportModule } from "@/import/import.module";
import { ImportService } from "@/import/import.service";
import { writeCategories } from "@/import/mny/writers/write-reference";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import { createTestCategory } from "../helpers/test-factories";

/**
 * INV-IMPORT-003 on the MNY and QIF writers (audit A26-L15): a category the
 * import needs, created concurrently by the same user, must not abort the
 * import.
 *
 * Each case holds a second connection's INSERT of subcategory "Fuel" under
 * "Auto" open, starts the import that also needs it, gives the import time to
 * block on the unique index, commits the other connection, and asserts the
 * import adopted the winner's row instead of failing on 23505 -- which, inside
 * an import's single transaction, used to lose the whole import. The CSV path
 * (`ImportEntityCreatorService`) was fixed earlier and is not repeated here.
 */
describe("A category created during an import (integration)", () => {
  jest.setTimeout(120000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let importer: ImportService;
  let aliceId: string;
  let autoId: string;
  let runner: QueryRunner | null = null;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);

  /** Lets an import that is going to block on the unique index reach it. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

  /** Opens a transaction inserting "Auto:Fuel" and leaves it uncommitted. */
  async function holdFuelInsert(): Promise<{
    runner: QueryRunner;
    fuelId: string;
  }> {
    const opened = db.createQueryRunner();
    await opened.connect();
    await opened.startTransaction();
    const inserted = (await opened.query(
      `INSERT INTO categories (user_id, name, parent_id, category_type)
       VALUES ($1, 'Fuel', $2, 'expense') RETURNING id`,
      [aliceId, autoId],
    )) as Array<{ id: string }>;
    runner = opened;
    return { runner: opened, fuelId: inserted[0].id };
  }

  const fuelRows = async (): Promise<string[]> =>
    (
      (await db.query(
        `SELECT id FROM categories WHERE user_id = $1 AND name = 'Fuel' AND parent_id = $2`,
        [aliceId, autoId],
      )) as Array<{ id: string }>
    ).map((row) => row.id);

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([ImportModule]);
    module = harness.module;
    db = harness.owner;
    importer = module.get(ImportService);
    // The schema here is synchronized from the entities, and `Category`
    // declares no unique constraint, so without this the collision under test
    // would not exist: a second "Fuel" would simply be inserted beside the
    // first. `database/schema.sql` declares exactly this constraint; the
    // entity's missing `@Unique` is drift outside this suite.
    await db.query(
      `DO $$ BEGIN
         ALTER TABLE categories
           ADD CONSTRAINT categories_user_id_name_parent_id_key
           UNIQUE (user_id, name, parent_id);
       EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
       END $$`,
    );
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    autoId = (await createTestCategory(db, aliceId, { name: "Auto" })).id;
  });

  afterEach(async () => {
    if (runner?.isTransactionActive) {
      await runner.rollbackTransaction();
    }
    await runner?.release();
    runner = null;
  });

  it("MNY: adopts a subcategory created while the import was writing", async () => {
    const { runner: open, fuelId } = await holdFuelInsert();

    const written = asAlice(() =>
      withScopedDb(db, (manager) =>
        writeCategories(manager, aliceId, [
          {
            handle: 1,
            name: "Auto",
            fullName: "Auto",
            parentName: null,
            isIncome: false,
          },
          {
            handle: 2,
            name: "Fuel",
            fullName: "Auto:Fuel",
            parentName: "Auto",
            isIncome: false,
          },
        ]),
      ),
    );
    const outcome = written.then(
      (result) => result,
      (error: unknown) => error,
    );
    await settle();
    await open.commitTransaction();

    const result = await outcome;
    expect(result).not.toBeInstanceOf(Error);
    const categories = result as Awaited<ReturnType<typeof writeCategories>>;
    expect(categories.idByFullName.get("Auto:Fuel")).toBe(fuelId);
    expect(categories.idByFullName.get("Auto")).toBe(autoId);
    expect(categories.created).toBe(0);
    expect(await fuelRows()).toEqual([fuelId]);
  });

  it("QIF: adopts a subcategory created while the import was writing", async () => {
    const { runner: open, fuelId } = await holdFuelInsert();

    // The multi-account path is the one that creates categories from a
    // `!Type:Cat` block (`createCategoriesFromDefs`, then the L-lines).
    const imported = asAlice(() =>
      importer.importQifMultiAccountFile(aliceId, {
        content:
          "!Type:Cat\nNAuto\nE\n^\nNAuto:Fuel\nE\n^\n" +
          "!Account\nNCar Card\nTBank\n^\n" +
          "!Type:Bank\nD01/15/2025\nT-50.00\nPShell\nLAuto:Fuel\n^\n",
        currencyCode: "USD",
        dateFormat: "MM/DD/YYYY",
      } as never),
    );
    const outcome = imported.then(
      (result) => result,
      (error: unknown) => error,
    );
    await settle();
    await open.commitTransaction();

    const result = await outcome;
    expect(result).not.toBeInstanceOf(Error);
    expect(await fuelRows()).toEqual([fuelId]);
    const rows = (await db.query(
      `SELECT t.category_id FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE a.user_id = $1 AND a.name = 'Car Card'`,
      [aliceId],
    )) as Array<{ category_id: string | null }>;
    expect(rows).toEqual([{ category_id: fuelId }]);
  });
});
