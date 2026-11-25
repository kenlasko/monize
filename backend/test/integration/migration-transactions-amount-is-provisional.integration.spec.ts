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
 * section 6), and its repeat in issue #2390 for the rows a release without
 * the importer change wrote after the first pass (design section 11). Only a
 * transfer leg carrying the note is flagged; the note itself stays until task
 * B4 strips it, and a second run changes nothing.
 *
 * The fixture is a real database and the migration is read from disk, since
 * the assertion is about what its SQL concludes from rows the importer wrote.
 */
const BACKFILL_MIGRATIONS = [
  "20261125132236_transactions_amount_is_provisional.sql",
  "20261125150107_transactions_amount_is_provisional_backfill_repeat.sql",
];

describe.each(BACKFILL_MIGRATIONS)(
  "migration %s backfills amount_is_provisional",
  (migrationFile) => {
    let dataSource: DataSource;
    let userId: string;
    let usdAccountId: string;
    let eurAccountId: string;

    const MIGRATION = path.join(
      __dirname,
      "../../../database/migrations",
      migrationFile,
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

    it("flags a marked transfer leg whose other side is gone", async () => {
      // The importer's pending lookups match an unlinked marked leg; after B4
      // strips the note only the column can find it.
      const id = await insertRow({
        accountId: eurAccountId,
        amount: 100,
        currencyCode: "EUR",
        description: PENDING_IMPORT_NOTE,
        isTransfer: true,
      });

      await applyMigration();

      expect((await rowOf(id)).amount_is_provisional).toBe(true);
    });

    it("skips shared-expense ledger rows, which the protect trigger would refuse", async () => {
      // shared_protect_ledger_transaction raises PSE01 on any change to such a
      // row's financial columns, so the update would abort the migration and
      // crash-loop the deployment. Seeded the way a restore writes it
      // (app.preserve_timestamps), in one implicit transaction so SET LOCAL
      // holds for every statement.
      const group = "70000000-0000-4000-8000-000000000001";
      const payer = "70000000-0000-4000-8000-000000000002";
      const payee = "70000000-0000-4000-8000-000000000003";
      const entry = "70000000-0000-4000-8000-000000000004";
      const integration = "70000000-0000-4000-8000-000000000005";
      const posting = "70000000-0000-4000-8000-000000000006";
      const settlement = "70000000-0000-4000-8000-000000000007";
      const posted = "70000000-0000-4000-8000-000000000008";
      const onSettlement = "70000000-0000-4000-8000-000000000009";
      await dataSource.query(`
      SET LOCAL app.preserve_timestamps = 'on';
      INSERT INTO shared_groups (id, owner_user_id, name, currency_code)
        VALUES ('${group}', '${userId}', 'Trip', 'EUR');
      INSERT INTO shared_participants (id, group_id, name)
        VALUES ('${payer}', '${group}', 'Me'), ('${payee}', '${group}', 'Friend');
      INSERT INTO shared_entries
          (id, group_id, type, title, entry_date, original_amount,
           original_currency_code, group_amount, fx_rate, rounding_seed,
           from_participant_id, to_participant_id)
        VALUES ('${entry}', '${group}', 'REPAYMENT', 'Settle up', '2026-08-14',
                100, 'EUR', 100, 1, 'seed', '${payer}', '${payee}');
      INSERT INTO shared_integrations (id, user_id, group_id, participant_id, account_id)
        VALUES ('${integration}', '${userId}', '${group}', '${payer}', '${eurAccountId}');
      INSERT INTO shared_postings
          (id, user_id, group_id, entry_id, integration_id, accepted_revision,
           input_fingerprint, accepted_snapshot)
        VALUES ('${posting}', '${userId}', '${group}', '${entry}',
                '${integration}', 1, 'fp', '{}');
      INSERT INTO accounts
          (id, user_id, account_type, name, currency_code, opening_balance,
           managed_purpose, shared_expense_group_id)
        VALUES ('${settlement}', '${userId}', 'OTHER', 'Trip settlement', 'EUR', 0,
                'SHARED_SETTLEMENT', '${group}');
      INSERT INTO transactions
          (id, user_id, account_id, transaction_date, amount, currency_code,
           description, is_transfer, shared_expense_posting_id)
        VALUES
          ('${posted}', '${userId}', '${eurAccountId}', '2026-08-14', 100,
           'EUR', '${PENDING_IMPORT_NOTE}', true, '${posting}'),
          ('${onSettlement}', '${userId}', '${settlement}', '2026-08-14', 100,
           'EUR', '${PENDING_IMPORT_NOTE}', true, NULL);
    `);

      await expect(applyMigration()).resolves.not.toThrow();

      expect((await rowOf(posted)).amount_is_provisional).toBe(false);
      expect((await rowOf(onSettlement)).amount_is_provisional).toBe(false);
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
  },
);
