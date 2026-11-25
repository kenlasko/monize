import { DataSource } from "typeorm";
import * as fs from "fs";
import * as path from "path";

import { PENDING_IMPORT_NOTE } from "@/import/pending-import";
import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The issue #2389 backfill of transactions.amount_is_provisional from the
 * importer's PENDING IMPORT note (design docs/future-plans/provisional-amounts.md
 * section 6). Only a transfer leg carrying the note is flagged; the note
 * itself stays until task B4 strips it, and a second run changes nothing.
 *
 * The fixture is a real database and the migration is read from disk, since
 * the assertion is about what its SQL concludes from rows the importer wrote.
 */
describe("migration 20261125132236 backfills amount_is_provisional", () => {
  let dataSource: DataSource;
  let userId: string;
  let usdAccountId: string;
  let eurAccountId: string;

  const MIGRATION = path.join(
    __dirname,
    "../../../database/migrations/20261125132236_transactions_amount_is_provisional.sql",
  );

  const applyMigration = () =>
    dataSource.query(fs.readFileSync(MIGRATION, "utf8"));

  const insertRow = async (row: {
    accountId: string;
    amount: number;
    currencyCode: string;
    description: string | null;
    isTransfer: boolean;
  }): Promise<string> => {
    const [{ id }] = (await dataSource.query(
      `INSERT INTO transactions
         (user_id, account_id, transaction_date, amount, currency_code,
          description, is_transfer)
       VALUES ($1, $2, '2026-08-14', $3, $4, $5, $6)
       RETURNING id`,
      [
        userId,
        row.accountId,
        row.amount,
        row.currencyCode,
        row.description,
        row.isTransfer,
      ],
    )) as { id: string }[];
    return id;
  };

  /** Two linked transfer legs, as the importer writes a plain transfer. */
  const seedTransfer = async (
    legDescription: string | null,
  ): Promise<{ sourceId: string; legId: string }> => {
    const sourceId = await insertRow({
      accountId: usdAccountId,
      amount: -100,
      currencyCode: "USD",
      description: null,
      isTransfer: true,
    });
    const legId = await insertRow({
      accountId: eurAccountId,
      amount: 100,
      currencyCode: "EUR",
      description: legDescription,
      isTransfer: true,
    });
    await dataSource.query(
      `UPDATE transactions SET linked_transaction_id = CASE id
         WHEN $1::uuid THEN $2::uuid WHEN $2::uuid THEN $1::uuid END
       WHERE id IN ($1, $2)`,
      [sourceId, legId],
    );
    return { sourceId, legId };
  };

  const rowOf = async (id: string) => {
    const [row] = (await dataSource.query(
      `SELECT amount_is_provisional, description, amount, updated_at
         FROM transactions WHERE id = $1`,
      [id],
    )) as {
      amount_is_provisional: boolean;
      description: string | null;
      amount: string;
      updated_at: Date;
    }[];
    return row;
  };

  beforeAll(async () => {
    if (!fs.existsSync(MIGRATION)) {
      throw new Error(`Migration not found at ${MIGRATION}`);
    }
    dataSource = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSource.initialize();
    await applyRlsPolicies(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "shared_groups",
      "transaction_splits",
      "transactions",
      "accounts",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES
         ('EUR', 'Euro', 'E', 2),
         ('USD', 'US Dollar', '$', 2)
       ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(dataSource)).id;
    usdAccountId = (
      await createTestAccount(dataSource, userId, {
        name: "US Checking",
        currencyCode: "USD",
      })
    ).id;
    eurAccountId = (
      await createTestAccount(dataSource, userId, {
        name: "EU Checking",
        currencyCode: "EUR",
      })
    ).id;
  });

  it("flags a transfer leg carrying the note and leaves its description and amount", async () => {
    const description = `Rent ${PENDING_IMPORT_NOTE}`;
    const { sourceId, legId } = await seedTransfer(description);

    await applyMigration();

    const leg = await rowOf(legId);
    expect(leg.amount_is_provisional).toBe(true);
    expect(leg.description).toBe(description);
    expect(Number(leg.amount)).toBe(100);
    expect((await rowOf(sourceId)).amount_is_provisional).toBe(false);
  });

  it("leaves a non-transfer row carrying the text alone", async () => {
    const id = await insertRow({
      accountId: eurAccountId,
      amount: -25,
      currencyCode: "EUR",
      description: "Note to self: PENDING IMPORT of the March statement",
      isTransfer: false,
    });

    await applyMigration();

    expect((await rowOf(id)).amount_is_provisional).toBe(false);
  });

  it("leaves an unmarked transfer leg alone", async () => {
    const { sourceId, legId } = await seedTransfer("Rent");

    await applyMigration();

    expect((await rowOf(legId)).amount_is_provisional).toBe(false);
    expect((await rowOf(sourceId)).amount_is_provisional).toBe(false);
  });

  it("is a no-op on a second run", async () => {
    const { legId } = await seedTransfer(PENDING_IMPORT_NOTE);
    const unmarked = await seedTransfer(null);

    await applyMigration();
    const afterFirst = await rowOf(legId);
    await applyMigration();
    const afterSecond = await rowOf(legId);

    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond.amount_is_provisional).toBe(true);
    expect((await rowOf(unmarked.legId)).amount_is_provisional).toBe(false);
  });
});
