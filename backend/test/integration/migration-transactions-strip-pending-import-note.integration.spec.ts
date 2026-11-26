import { DataSource } from "typeorm";
import * as fs from "fs";
import * as path from "path";

import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";
import { createTestAccount } from "../helpers/test-factories";

/** The note the importer wrote before issue #2400 retired it. */
const NOTE =
  "⚠️ PENDING IMPORT: Amount may need adjustment when importing the other account.";

/**
 * The issue #2400 strip of the importer's PENDING IMPORT note from transfer
 * leg descriptions (design docs/future-plans/provisional-amounts.md, decision
 * 1 and section 11). The exact note goes from every imported transfer leg,
 * flagged or confirmed; the rest is trimmed and an empty result is NULL; the
 * flag is never touched, so a leg the reader confirmed stays confirmed; a
 * non-transfer row's text and a note the reader edited stay; a second run
 * changes nothing.
 *
 * A real database and the migration read from disk, since the assertion is
 * about what its SQL does to the rows.
 */
describe("migration 20261126115405_transactions_strip_pending_import_note.sql", () => {
  let dataSource: DataSource;
  let userId: string;
  let usdAccountId: string;
  let eurAccountId: string;

  const MIGRATION = path.join(
    __dirname,
    "../../../database/migrations",
    "20261126115405_transactions_strip_pending_import_note.sql",
  );

  const applyMigration = () =>
    dataSource.query(fs.readFileSync(MIGRATION, "utf8"));

  const insertRow = async (row: {
    accountId: string;
    amount: number;
    currencyCode: string;
    description: string | null;
    isTransfer: boolean;
    provisional?: boolean;
  }): Promise<string> => {
    const [{ id }] = (await dataSource.query(
      `INSERT INTO transactions
         (user_id, account_id, transaction_date, amount, currency_code,
          description, is_transfer, amount_is_provisional)
       VALUES ($1, $2, '2026-08-14', $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        userId,
        row.accountId,
        row.amount,
        row.currencyCode,
        row.description,
        row.isTransfer,
        row.provisional ?? false,
      ],
    )) as { id: string }[];
    return id;
  };

  /** A EUR transfer leg as the importer wrote it, with its USD source. */
  const seedLeg = async (
    description: string | null,
    provisional: boolean,
  ): Promise<string> => {
    const sourceId = await insertRow({
      accountId: usdAccountId,
      amount: -100,
      currencyCode: "USD",
      description: null,
      isTransfer: true,
    });
    const legId = await insertRow({
      accountId: eurAccountId,
      amount: 80,
      currencyCode: "EUR",
      description,
      isTransfer: true,
      provisional,
    });
    await dataSource.query(
      `UPDATE transactions SET linked_transaction_id = CASE id
         WHEN $1::uuid THEN $2::uuid WHEN $2::uuid THEN $1::uuid END
       WHERE id IN ($1, $2)`,
      [sourceId, legId],
    );
    return legId;
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

  it("strips a note-only, a memo-plus-note and an already-stripped description, twice, keeping each flag", async () => {
    const noteOnly = await seedLeg(NOTE, true);
    const memoPlusNote = await seedLeg(`Rent ${NOTE}`, true);
    const stripped = await seedLeg("Rent", true);

    await applyMigration();
    const first = {
      noteOnly: await rowOf(noteOnly),
      memoPlusNote: await rowOf(memoPlusNote),
      stripped: await rowOf(stripped),
    };

    expect(first.noteOnly.description).toBeNull();
    expect(first.memoPlusNote.description).toBe("Rent");
    expect(first.stripped.description).toBe("Rent");
    for (const row of Object.values(first)) {
      expect(row.amount_is_provisional).toBe(true);
      expect(Number(row.amount)).toBe(80);
    }

    await applyMigration();

    expect(await rowOf(noteOnly)).toEqual(first.noteOnly);
    expect(await rowOf(memoPlusNote)).toEqual(first.memoPlusNote);
    // Never touched at all, so not even its updated_at moved.
    expect(await rowOf(stripped)).toEqual(first.stripped);
  });

  it("strips a confirmed leg's note and leaves it confirmed", async () => {
    // Confirm amount and a transfer edit clear the flag and keep the note; the
    // migration does not flag by the text again (decided on issue #2400).
    const confirmed = await seedLeg(`Rent ${NOTE}`, false);

    await applyMigration();

    const row = await rowOf(confirmed);
    expect(row.description).toBe("Rent");
    expect(row.amount_is_provisional).toBe(false);
  });

  it("leaves a non-transfer row holding the whole note alone", async () => {
    const id = await insertRow({
      accountId: eurAccountId,
      amount: -25,
      currencyCode: "EUR",
      description: `Copied ${NOTE}`,
      isTransfer: false,
    });
    const before = await rowOf(id);

    await applyMigration();

    expect(await rowOf(id)).toEqual(before);
  });

  it("leaves a note the reader edited, which no longer holds the exact text", async () => {
    const edited = await seedLeg(
      "Rent PENDING IMPORT: Amount may need adjustment",
      true,
    );
    const before = await rowOf(edited);

    await applyMigration();

    expect(await rowOf(edited)).toEqual(before);
  });

  it("skips shared-expense ledger rows, which the protect trigger guards", async () => {
    // Seeded the way a restore writes them (app.preserve_timestamps), in one
    // implicit transaction so SET LOCAL holds for every statement.
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
           'EUR', '${NOTE}', true, '${posting}'),
          ('${onSettlement}', '${userId}', '${settlement}', '2026-08-14', 100,
           'EUR', '${NOTE}', true, NULL);
    `);

    await expect(applyMigration()).resolves.not.toThrow();

    expect((await rowOf(posted)).description).toBe(NOTE);
    expect((await rowOf(onSettlement)).description).toBe(NOTE);
  });
});
