import { Test, TestingModule } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { DataSource } from "typeorm";
import { createHash, randomUUID } from "crypto";
import { gunzipSync } from "zlib";
import {
  BackupService,
  BackupPasswordRequiredError,
  RESTORABLE_TABLES,
} from "@/backup/backup.service";
import { BackupExportService } from "@/backup/backup-export.service";
import { BackupRestoreService } from "@/backup/backup-restore.service";
import { BackupAttachmentTransferService } from "@/backup/backup-attachment-transfer.service";
import { BackupRestoreDatabaseService } from "@/backup/backup-restore-database.service";
import { User } from "@/users/entities/user.entity";
import { OidcReauthService } from "@/auth/oidc/oidc-reauth.service";
import { AiEncryptionService } from "@/ai/ai-encryption.service";
import { DatabaseStorageProvider } from "@/attachments/storage/database-storage.provider";
import { ATTACHMENT_STORAGE_PROVIDER } from "@/attachments/storage/attachment-storage.interface";
import { JobClaimService } from "@/common/jobs/job-claim.service";
import { UserMaintenanceService } from "@/common/jobs/user-maintenance.service";
import { createTestUserDirect } from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";
import { withUserContext } from "@/common/db/with-context";

/**
 * Full backup -> restore round-trip against a real PostgreSQL database.
 *
 * The unit suite (src/backup/backup.service.spec.ts) mocks the QueryRunner and
 * asserts the SQL it emits. This integration test instead exercises the whole
 * pipeline end to end: it seeds a realistic dataset for user A, exports it to a
 * gzipped buffer, then restores that buffer into a separate user B on the SAME
 * database and verifies the data survives intact. That round-trip catches
 * things mocks cannot -- FK-safe insert ordering, deferred-FK (Phase 3) UPDATEs,
 * primary-key remapping, user_id rescoping, and timestamp preservation through
 * the `app.preserve_timestamps` GUC (task C5): the restore holds no trigger DDL
 * any more, so the GUC-aware `updated_at` trigger from migration M1 is the only
 * thing keeping restored timestamps -- at RLS_MODE=off included, which is what
 * this suite runs under.
 */
describe("Backup export/restore round-trip (integration)", () => {
  let module: TestingModule;
  let service: BackupService;
  let dataSource: DataSource;

  // The shared login password createTestUserDirect bakes into every user; the
  // restore flow re-verifies it before touching any data.
  const PASSWORD = "TestPassword123!";

  interface SeededIds {
    parentCategoryId: string;
    childCategoryId: string;
    payeeId: string;
    institutionId: string;
    accountId: string;
    savingsAccountId: string;
    tagId: string;
    securityId: string;
    loanRateChangeId: string;
    loanScenarioId: string;
    expenseTxId: string;
    splitParentTxId: string;
    transferOutTxId: string;
    transferInTxId: string;
    invTransferOutId: string;
    invTransferInId: string;
  }

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        TypeOrmModule.forRoot({
          type: "postgres",
          host: process.env.DATABASE_HOST || "localhost",
          port: parseInt(process.env.DATABASE_PORT || "5432"),
          username: process.env.DATABASE_USER || "monize_user",
          password: process.env.DATABASE_PASSWORD || "monize_password",
          database: process.env.DATABASE_NAME || "monize_test",
          entities: [__dirname + "/../../src/**/*.entity{.ts,.js}"],
          synchronize: true,
          dropSchema: true,
        }),
        TypeOrmModule.forFeature([User]),
      ],
      providers: [
        BackupService,
        // The four components issue #1092 split BackupService into. Real, like
        // everything else here: the point of an integration suite is that the
        // wiring is the thing under test.
        BackupExportService,
        BackupRestoreService,
        BackupAttachmentTransferService,
        BackupRestoreDatabaseService,
        // The REAL re-authentication service, not a double: it is the thing that
        // refuses a restore without a valid artifact, and a mock here would let a
        // future change remove that check with this suite still green. Local-auth
        // users prove identity with their password, so these tests never mint one.
        OidcReauthService,
        // Real, not doubles: the restore takes a maintenance lease against the
        // real `job_claims` table, so a broken lease shows up here rather than
        // only in production.
        JobClaimService,
        UserMaintenanceService,
        // Only consulted for backups encrypted with a stored password; the
        // round-trip tests supply the password explicitly instead.
        { provide: AiEncryptionService, useValue: { decrypt: () => "" } },
        // The real database-backed provider, which the completeness cases below
        // need: their whole point is that Postgres computes the digest the
        // export judges, and a double would answer for it. It also needs no
        // extra config, unlike local/S3.
        DatabaseStorageProvider,
        {
          provide: ATTACHMENT_STORAGE_PROVIDER,
          useExisting: DatabaseStorageProvider,
        },
      ],
    }).compile();

    service = module.get(BackupService);
    dataSource = module.get(DataSource);

    // synchronize:true builds the schema from entity metadata, which includes
    // neither the updated_at triggers nor the GUC-aware trigger function from
    // migration M1. The restore preserves backup timestamps solely through the
    // app.preserve_timestamps GUC that function honours, so apply the real RLS
    // migrations (T1's harness) rather than a hand-rolled trigger -- a local
    // copy of the pre-M1 function here would make every timestamp assertion
    // test a function that no longer ships.
    await applyRlsPolicies(dataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await dataSource.query(`
      TRUNCATE transaction_tags, transaction_splits, transactions, tags,
        payees, accounts, institutions, categories, user_preferences,
        currencies, users CASCADE
    `);
  });

  /**
   * Seeds a representative cross-section of a user's data: a user-created
   * currency, preferences, a parent/child category pair, a payee with a default
   * category, an institution, two accounts (one referencing the institution), a
   * tag, a plain expense, a split transaction with two splits, and a linked
   * transfer pair. Together these exercise every deferred-FK column the restore
   * defers to Phase 3.
   */
  async function seedUserData(userId: string): Promise<SeededIds> {
    const ids: SeededIds = {
      parentCategoryId: randomUUID(),
      childCategoryId: randomUUID(),
      payeeId: randomUUID(),
      institutionId: randomUUID(),
      accountId: randomUUID(),
      savingsAccountId: randomUUID(),
      tagId: randomUUID(),
      securityId: randomUUID(),
      loanRateChangeId: randomUUID(),
      loanScenarioId: randomUUID(),
      expenseTxId: randomUUID(),
      splitParentTxId: randomUUID(),
      transferOutTxId: randomUUID(),
      transferInTxId: randomUUID(),
      invTransferOutId: randomUUID(),
      invTransferInId: randomUUID(),
    };

    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, created_by_user_id)
       VALUES ('USD', 'US Dollar', '$', $1)`,
      [userId],
    );
    await dataSource.query(
      `INSERT INTO user_preferences (user_id, default_currency, language)
       VALUES ($1, 'USD', 'en')`,
      [userId],
    );

    await dataSource.query(
      `INSERT INTO categories (id, user_id, name, is_income) VALUES ($1, $2, 'Food', false)`,
      [ids.parentCategoryId, userId],
    );
    await dataSource.query(
      `INSERT INTO categories (id, user_id, parent_id, name, is_income)
       VALUES ($1, $2, $3, 'Groceries', false)`,
      [ids.childCategoryId, userId, ids.parentCategoryId],
    );

    await dataSource.query(
      `INSERT INTO payees (id, user_id, name, default_category_id, website)
       VALUES ($1, $2, 'Corner Store', $3, 'https://corner.example')`,
      [ids.payeeId, userId, ids.childCategoryId],
    );

    await dataSource.query(
      `INSERT INTO institutions (id, user_id, name, website, has_logo)
       VALUES ($1, $2, 'My Bank', 'https://mybank.example', false)`,
      [ids.institutionId, userId],
    );

    await dataSource.query(
      `INSERT INTO accounts (id, user_id, account_type, name, currency_code,
                             institution_id, current_balance, opening_balance)
       VALUES ($1, $2, 'CHEQUING', 'Checking', 'USD', $3, 850, 1000)`,
      [ids.accountId, userId, ids.institutionId],
    );
    await dataSource.query(
      `INSERT INTO accounts (id, user_id, account_type, name, currency_code,
                             current_balance, opening_balance)
       VALUES ($1, $2, 'SAVINGS', 'Savings', 'USD', 100, 0)`,
      [ids.savingsAccountId, userId],
    );

    await dataSource.query(
      `INSERT INTO tags (id, user_id, name) VALUES ($1, $2, 'essential')`,
      [ids.tagId, userId],
    );

    // A security tagged with the user's tag -- exercises the security_tags
    // join table (composite PK, no id/user_id column of its own).
    await dataSource.query(
      `INSERT INTO securities (id, user_id, symbol, name, currency_code)
       VALUES ($1, $2, 'ACME', 'Acme Corp', 'USD')`,
      [ids.securityId, userId],
    );
    await dataSource.query(
      `INSERT INTO security_tags (security_id, tag_id) VALUES ($1, $2)`,
      [ids.securityId, ids.tagId],
    );

    // Loan rate-change history and a saved overpayment scenario on the
    // chequing account -- both reference accounts via account_id.
    await dataSource.query(
      `INSERT INTO loan_rate_changes (id, user_id, account_id, effective_date,
                                      annual_rate, new_payment_amount, source, note)
       VALUES ($1, $2, $3, '2026-01-01', 5.25, 1500, 'initial', 'Origination rate')`,
      [ids.loanRateChangeId, userId, ids.accountId],
    );
    await dataSource.query(
      `INSERT INTO loan_scenarios (id, user_id, account_id, name,
                                   recurring_extra_amount, lump_sums)
       VALUES ($1, $2, $3, 'Pay extra 200', 200,
               '[{"date":"2026-06-01","amount":5000}]')`,
      [ids.loanScenarioId, userId, ids.accountId],
    );

    await dataSource.query(
      `INSERT INTO transactions (id, user_id, account_id, transaction_date,
                                 payee_id, category_id, amount, currency_code, description)
       VALUES ($1, $2, $3, '2026-01-15', $4, $5, -50, 'USD', 'Weekly shop')`,
      [
        ids.expenseTxId,
        userId,
        ids.accountId,
        ids.payeeId,
        ids.childCategoryId,
      ],
    );
    await dataSource.query(
      `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2)`,
      [ids.expenseTxId, ids.tagId],
    );

    // Split transaction: parent has no category, two splits sum to the amount.
    await dataSource.query(
      `INSERT INTO transactions (id, user_id, account_id, transaction_date,
                                 amount, currency_code, is_split)
       VALUES ($1, $2, $3, '2026-01-16', -100, 'USD', true)`,
      [ids.splitParentTxId, userId, ids.accountId],
    );
    await dataSource.query(
      `INSERT INTO transaction_splits (id, transaction_id, kind, category_id, amount)
       VALUES ($1, $2, 'category', $3, -60)`,
      [randomUUID(), ids.splitParentTxId, ids.childCategoryId],
    );
    await dataSource.query(
      `INSERT INTO transaction_splits (id, transaction_id, kind, category_id, amount)
       VALUES ($1, $2, 'category', $3, -40)`,
      [randomUUID(), ids.splitParentTxId, ids.parentCategoryId],
    );

    // Linked transfer pair (each points at the other via linked_transaction_id).
    // Insert both first, then link them mutually -- a forward reference would
    // violate the self-referential FK on the first insert.
    await dataSource.query(
      `INSERT INTO transactions (id, user_id, account_id, transaction_date,
                                 amount, currency_code, is_transfer)
       VALUES ($1, $2, $3, '2026-01-17', -100, 'USD', true)`,
      [ids.transferOutTxId, userId, ids.accountId],
    );
    await dataSource.query(
      `INSERT INTO transactions (id, user_id, account_id, transaction_date,
                                 amount, currency_code, is_transfer)
       VALUES ($1, $2, $3, '2026-01-17', 100, 'USD', true)`,
      [ids.transferInTxId, userId, ids.savingsAccountId],
    );
    await dataSource.query(
      `UPDATE transactions SET linked_transaction_id = $2 WHERE id = $1`,
      [ids.transferOutTxId, ids.transferInTxId],
    );
    await dataSource.query(
      `UPDATE transactions SET linked_transaction_id = $2 WHERE id = $1`,
      [ids.transferInTxId, ids.transferOutTxId],
    );

    // Linked investment transfer pair (the two legs of a security transfer),
    // each pointing at the other via the self-referential linked_transaction_id.
    // Whichever leg is inserted first is a forward reference to the other, so
    // this exercises the deferred-FK handling for investment_transactions.
    await dataSource.query(
      `INSERT INTO investment_transactions (id, user_id, account_id, security_id,
                                            action, transaction_date, quantity, price, total_amount)
       VALUES ($1, $2, $3, $4, 'TRANSFER_OUT', '2026-01-18', 1300, 80.965331, 0)`,
      [ids.invTransferOutId, userId, ids.accountId, ids.securityId],
    );
    await dataSource.query(
      `INSERT INTO investment_transactions (id, user_id, account_id, security_id,
                                            action, transaction_date, quantity, price, total_amount)
       VALUES ($1, $2, $3, $4, 'TRANSFER_IN', '2026-01-18', 1300, 80.965331, 0)`,
      [ids.invTransferInId, userId, ids.savingsAccountId, ids.securityId],
    );
    await dataSource.query(
      `UPDATE investment_transactions SET linked_transaction_id = $2 WHERE id = $1`,
      [ids.invTransferOutId, ids.invTransferInId],
    );
    await dataSource.query(
      `UPDATE investment_transactions SET linked_transaction_id = $2 WHERE id = $1`,
      [ids.invTransferInId, ids.invTransferOutId],
    );

    return ids;
  }

  async function countRows(table: string, userId: string): Promise<number> {
    const rows = await dataSource.query(
      `SELECT COUNT(*)::int AS n FROM ${table} WHERE user_id = $1`,
      [userId],
    );
    return rows[0].n;
  }

  it("restores a full dataset into a separate user with intact relationships", async () => {
    const userA = await createTestUserDirect(dataSource, {
      email: "a@example.com",
    });
    const userB = await createTestUserDirect(dataSource, {
      email: "b@example.com",
    });
    const seeded = await seedUserData(userA.id);

    // Backdate the Checking account's updated_at so preservation is
    // distinguishable from re-stamping: its institution_id is restored by a
    // Phase-3 UPDATE, which fires the updated_at trigger -- only the
    // app.preserve_timestamps GUC the restore transaction emits keeps this
    // value (there is no trigger DDL left to fall back on).
    const BACKDATED = "2020-03-04 05:06:07";
    await dataSource.transaction(async (m) => {
      await m.query("SELECT set_config('app.preserve_timestamps', 'on', true)");
      await m.query(`UPDATE accounts SET updated_at = $1 WHERE id = $2`, [
        BACKDATED,
        seeded.accountId,
      ]);
    });

    const { buffer } = await withUserContext(userA.id, () =>
      service.exportToBuffer(userA.id),
    );

    // The export is gzipped JSON with a version header.
    const parsed = JSON.parse(gunzipSync(buffer).toString("utf-8"));
    expect(parsed.version).toBe(1);
    expect(parsed.exportedAt).toBeDefined();
    // ...and its own completeness claim, so the artifact still says what it is
    // after it has been copied off this machine (F3RB-001, issue #1069). The
    // restore below is the other half: a non-array envelope member must fall
    // through the id remap and the insert plan untouched against a real schema.
    expect(parsed.completeness).toEqual(
      expect.objectContaining({ complete: true }),
    );
    expect(parsed.transactions).toHaveLength(4);
    // Recently-added tables must be present in the export payload.
    expect(parsed.security_tags).toHaveLength(1);
    expect(parsed.loan_rate_changes).toHaveLength(1);
    expect(parsed.loan_scenarios).toHaveLength(1);

    const result = await withUserContext(userB.id, () =>
      service.restoreData(userB.id, {
        compressedData: buffer,
        password: PASSWORD,
      }),
    );

    expect(result.message).toContain("restored");
    expect(result.restored.categories).toBe(2);
    expect(result.restored.accounts).toBe(2);
    expect(result.restored.transactions).toBe(4);
    expect(result.restored.transactionSplits).toBe(2);

    // Row counts under B match what was seeded under A.
    expect(await countRows("categories", userB.id)).toBe(2);
    expect(await countRows("payees", userB.id)).toBe(1);
    expect(await countRows("institutions", userB.id)).toBe(1);
    expect(await countRows("accounts", userB.id)).toBe(2);
    expect(await countRows("tags", userB.id)).toBe(1);
    expect(await countRows("transactions", userB.id)).toBe(4);

    // Primary keys were remapped to fresh UUIDs (restore behaves as if the
    // backup came from a separate system), so none of B's rows reuse A's ids.
    const bAccountIds = (
      await dataSource.query(`SELECT id FROM accounts WHERE user_id = $1`, [
        userB.id,
      ])
    ).map((r: { id: string }) => r.id);
    expect(bAccountIds).not.toContain(seeded.accountId);
    expect(bAccountIds).not.toContain(seeded.savingsAccountId);

    // Deferred FK: the child category's parent_id was rewritten to B's parent
    // category, not left pointing at A's row.
    const childCat = (
      await dataSource.query(
        `SELECT c.parent_id, p.user_id AS parent_user_id, p.name AS parent_name
         FROM categories c JOIN categories p ON c.parent_id = p.id
         WHERE c.user_id = $1 AND c.name = 'Groceries'`,
        [userB.id],
      )
    )[0];
    expect(childCat.parent_user_id).toBe(userB.id);
    expect(childCat.parent_name).toBe("Food");

    // Deferred FK: payee.default_category_id resolves to B's Groceries category.
    const payee = (
      await dataSource.query(
        `SELECT cat.user_id AS cat_user_id, cat.name AS cat_name, pay.website
         FROM payees pay JOIN categories cat ON pay.default_category_id = cat.id
         WHERE pay.user_id = $1`,
        [userB.id],
      )
    )[0];
    expect(payee.cat_user_id).toBe(userB.id);
    expect(payee.cat_name).toBe("Groceries");
    // The regular backup is a full fidelity copy, so a scalar added to the
    // table has to survive the round trip. It does so only because the export
    // is SELECT * and the restore validates columns against the live schema --
    // neither enumerates payee columns, and a test that never sets the column
    // would not notice if one day one of them did.
    expect(payee.website).toBe("https://corner.example");

    // Deferred FK: account.institution_id resolves to B's institution.
    const account = (
      await dataSource.query(
        `SELECT inst.user_id AS inst_user_id, inst.name AS inst_name
         FROM accounts acc JOIN institutions inst ON acc.institution_id = inst.id
         WHERE acc.user_id = $1 AND acc.name = 'Checking'`,
        [userB.id],
      )
    )[0];
    expect(account.inst_user_id).toBe(userB.id);
    expect(account.inst_name).toBe("My Bank");

    // Timestamp preservation (task C5): B's restored Checking account keeps
    // A's backdated updated_at even though the Phase-3 institution_id UPDATE
    // ran through the updated_at trigger. At RLS_MODE=off -- this suite -- the
    // preserve GUC is the only mechanism doing this.
    const [restoredChecking] = await dataSource.query(
      `SELECT to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS ts
       FROM accounts WHERE user_id = $1 AND name = 'Checking'`,
      [userB.id],
    );
    expect(restoredChecking.ts).toBe(BACKDATED);

    // Deferred FK: the transfer pair's linked_transaction_id points at the
    // paired transaction, both owned by B.
    const transfers = await dataSource.query(
      `SELECT t.amount, linked.user_id AS linked_user_id, linked.amount AS linked_amount
       FROM transactions t JOIN transactions linked ON t.linked_transaction_id = linked.id
       WHERE t.user_id = $1 ORDER BY t.amount`,
      [userB.id],
    );
    expect(transfers).toHaveLength(2);
    expect(transfers[0].linked_user_id).toBe(userB.id);
    expect(Number(transfers[0].amount)).toBe(-100);
    expect(Number(transfers[0].linked_amount)).toBe(100);

    // Deferred FK: the investment transfer pair's self-referential
    // linked_transaction_id is restored in Phase 3 and each leg points at its
    // paired leg, both owned by B. (A forward reference here used to violate
    // investment_transactions_linked_transaction_id_fkey during insert.)
    expect(await countRows("investment_transactions", userB.id)).toBe(2);
    const invTransfers = await dataSource.query(
      `SELECT it.action, linked.user_id AS linked_user_id, linked.action AS linked_action
       FROM investment_transactions it
       JOIN investment_transactions linked ON it.linked_transaction_id = linked.id
       WHERE it.user_id = $1 ORDER BY it.action`,
      [userB.id],
    );
    expect(invTransfers).toHaveLength(2);
    expect(invTransfers[0].action).toBe("TRANSFER_IN");
    expect(invTransfers[0].linked_user_id).toBe(userB.id);
    expect(invTransfers[0].linked_action).toBe("TRANSFER_OUT");
    expect(invTransfers[1].action).toBe("TRANSFER_OUT");
    expect(invTransfers[1].linked_action).toBe("TRANSFER_IN");

    // Split transaction restored with both split rows summing to the parent.
    const splits = await dataSource.query(
      `SELECT ts.amount FROM transaction_splits ts
       JOIN transactions t ON ts.transaction_id = t.id
       WHERE t.user_id = $1 ORDER BY ts.amount`,
      [userB.id],
    );
    expect(splits.map((s: { amount: string }) => Number(s.amount))).toEqual([
      -60, -40,
    ]);

    // transaction_tag restored and links B's tag to B's transaction.
    const taggedCount = (
      await dataSource.query(
        `SELECT COUNT(*)::int AS n FROM transaction_tags tt
         JOIN transactions t ON tt.transaction_id = t.id
         JOIN tags g ON tt.tag_id = g.id
         WHERE t.user_id = $1 AND g.user_id = $1`,
        [userB.id],
      )
    )[0].n;
    expect(taggedCount).toBe(1);

    // security_tags round-trips: B's security is linked to B's tag, both
    // rescoped to B (the composite PK has no id/user_id of its own -- the
    // link survives purely via the remapped security_id/tag_id).
    expect(await countRows("securities", userB.id)).toBe(1);
    const securityTagCount = (
      await dataSource.query(
        `SELECT COUNT(*)::int AS n FROM security_tags st
         JOIN securities s ON st.security_id = s.id
         JOIN tags g ON st.tag_id = g.id
         WHERE s.user_id = $1 AND g.user_id = $1`,
        [userB.id],
      )
    )[0].n;
    expect(securityTagCount).toBe(1);

    // loan_rate_changes round-trips and its account_id resolves to B's account.
    expect(await countRows("loan_rate_changes", userB.id)).toBe(1);
    const rateChange = (
      await dataSource.query(
        `SELECT lrc.annual_rate, lrc.source,
                a.user_id AS acct_user_id, a.name AS acct_name
         FROM loan_rate_changes lrc JOIN accounts a ON lrc.account_id = a.id
         WHERE lrc.user_id = $1`,
        [userB.id],
      )
    )[0];
    expect(rateChange.acct_user_id).toBe(userB.id);
    expect(rateChange.acct_name).toBe("Checking");
    expect(Number(rateChange.annual_rate)).toBe(5.25);
    expect(rateChange.source).toBe("initial");

    // loan_scenarios round-trips with its JSONB lump_sums intact.
    expect(await countRows("loan_scenarios", userB.id)).toBe(1);
    const scenario = (
      await dataSource.query(
        `SELECT name, lump_sums FROM loan_scenarios WHERE user_id = $1`,
        [userB.id],
      )
    )[0];
    expect(scenario.name).toBe("Pay extra 200");
    expect(scenario.lump_sums).toEqual([{ date: "2026-06-01", amount: 5000 }]);

    // The restore must NOT touch user A's data.
    expect(await countRows("accounts", userA.id)).toBe(2);
    expect(await countRows("transactions", userA.id)).toBe(4);
    const aChecking = (
      await dataSource.query(
        `SELECT institution_id FROM accounts WHERE id = $1`,
        [seeded.accountId],
      )
    )[0];
    expect(aChecking.institution_id).toBe(seeded.institutionId);
  });

  it("round-trips an encrypted backup when the backup password is supplied", async () => {
    const userA = await createTestUserDirect(dataSource, {
      email: "enc-a@example.com",
    });
    const userB = await createTestUserDirect(dataSource, {
      email: "enc-b@example.com",
    });
    await seedUserData(userA.id);

    const { buffer: encrypted } = await withUserContext(userA.id, () =>
      service.exportToBuffer(userA.id, "backup-secret"),
    );

    const result = await withUserContext(userB.id, () =>
      service.restoreData(userB.id, {
        compressedData: encrypted,
        password: PASSWORD,
        backupPassword: "backup-secret",
      }),
    );

    expect(result.restored.accounts).toBe(2);
    expect(await countRows("transactions", userB.id)).toBe(4);
  });

  it("rejects an encrypted backup when no decryption password works", async () => {
    const userA = await createTestUserDirect(dataSource, {
      email: "bad-a@example.com",
    });
    const userB = await createTestUserDirect(dataSource, {
      email: "bad-b@example.com",
    });
    await seedUserData(userA.id);

    const { buffer: encrypted } = await withUserContext(userA.id, () =>
      service.exportToBuffer(userA.id, "backup-secret"),
    );

    await expect(
      withUserContext(userB.id, () =>
        service.restoreData(userB.id, {
          compressedData: encrypted,
          password: PASSWORD,
          backupPassword: "wrong-password",
        }),
      ),
    ).rejects.toBeInstanceOf(BackupPasswordRequiredError);

    // A failed restore leaves the target user empty.
    expect(await countRows("accounts", userB.id)).toBe(0);
  });

  /**
   * `accounts.linked_loan_account_id` is an immediate self-referential FK, so a
   * restore that inserts the asset before the loan it points at aborts the whole
   * transaction. The export orders accounts `ORDER BY name`, so the failing
   * order is not exotic -- it is whatever the user happened to call the two
   * accounts. Both directions are exercised because only one of them puts the
   * reference before its target, and a fix that deferred nothing would still
   * pass the other.
   */
  describe.each([
    { assetName: "A Home", loanName: "Z Mortgage", label: "asset first" },
    { assetName: "Z Cottage", loanName: "A Loan", label: "loan first" },
  ])(
    "asset linked to its financing loan ($label)",
    ({ assetName, loanName }) => {
      it("restores the link", async () => {
        const userA = await createTestUserDirect(dataSource, {
          email: `loan-${assetName.replace(/\W/g, "")}-a@example.com`,
        });
        const userB = await createTestUserDirect(dataSource, {
          email: `loan-${assetName.replace(/\W/g, "")}-b@example.com`,
        });

        const assetId = randomUUID();
        const loanId = randomUUID();
        await dataSource.query(
          `INSERT INTO accounts (id, user_id, account_type, name, currency_code,
                               current_balance, opening_balance)
         VALUES ($1, $2, 'LOAN', $3, 'USD', -200000, -220000)`,
          [loanId, userA.id, loanName],
        );
        await dataSource.query(
          `INSERT INTO accounts (id, user_id, account_type, name, currency_code,
                               current_balance, opening_balance, linked_loan_account_id)
         VALUES ($1, $2, 'ASSET', $3, 'USD', 500000, 480000, $4)`,
          [assetId, userA.id, assetName, loanId],
        );

        const { buffer: backup } = await withUserContext(userA.id, () =>
          service.exportToBuffer(userA.id),
        );

        const result = await withUserContext(userB.id, () =>
          service.restoreData(userB.id, {
            compressedData: backup,
            password: PASSWORD,
          }),
        );
        expect(result.restored.accounts).toBe(2);

        // The link must point at B's copy of the loan -- not at A's row, and not
        // at null. A restore that dropped the column silently would still report
        // two accounts restored.
        const [restoredAsset] = await dataSource.query(
          `SELECT a.linked_loan_account_id, loan.name AS loan_name, loan.user_id AS loan_user
           FROM accounts a
           JOIN accounts loan ON loan.id = a.linked_loan_account_id
          WHERE a.user_id = $1 AND a.name = $2`,
          [userB.id, assetName],
        );
        expect(restoredAsset).toBeDefined();
        expect(restoredAsset.loan_name).toBe(loanName);
        expect(restoredAsset.loan_user).toBe(userB.id);
        expect(restoredAsset.linked_loan_account_id).not.toBe(loanId);
      });
    },
  );
  /**
   * Currencies are shared: user A defines `PTS`, user B activates it and prices
   * an account in it. B's backup used to select currencies by
   * `created_by_user_id`, so it carried the references without the definition,
   * and a restore onto an instance that had never seen `PTS` synthesised the
   * metadata from a fallback -- name and symbol became the bare code and decimal
   * places became 2. The balance was still 7; it just rendered as `PTS 7.00`
   * rather than `*7`.
   */
  it("carries the definition of a custom currency another user created", async () => {
    const userA = await createTestUserDirect(dataSource, {
      email: "cur-a@example.com",
    });
    const userB = await createTestUserDirect(dataSource, {
      email: "cur-b@example.com",
    });
    const userC = await createTestUserDirect(dataSource, {
      email: "cur-c@example.com",
    });

    // A defines it; B is the one who uses it.
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active, created_by_user_id)
       VALUES ('PTS', 'Family Points', '*', 0, true, $1)
       ON CONFLICT (code) DO NOTHING`,
      [userA.id],
    );
    await dataSource.query(
      `INSERT INTO user_currency_preferences (user_id, currency_code, is_active)
       VALUES ($1, 'PTS', true) ON CONFLICT DO NOTHING`,
      [userB.id],
    );
    await dataSource.query(
      `INSERT INTO accounts (id, user_id, account_type, name, currency_code,
                             current_balance, opening_balance)
       VALUES ($1, $2, 'SAVINGS', 'Points Jar', 'PTS', 7, 7)`,
      [randomUUID(), userB.id],
    );

    const { buffer: backup } = await withUserContext(userB.id, () =>
      service.exportToBuffer(userB.id),
    );

    // The definition has to travel in the artifact, not be reconstructed later.
    const exported = JSON.parse(gunzipSync(backup).toString("utf-8"));
    const exportedPts = exported.currencies.find(
      (c: { code: string }) => c.code === "PTS",
    );
    expect(exportedPts).toMatchObject({
      code: "PTS",
      name: "Family Points",
      symbol: "*",
      decimal_places: 0,
    });

    // Simulate a fresh instance for the code: drop it, then restore into C.
    await dataSource.query(
      "DELETE FROM user_currency_preferences WHERE currency_code = 'PTS'",
    );
    await dataSource.query("DELETE FROM accounts WHERE user_id = $1", [
      userB.id,
    ]);
    await dataSource.query("DELETE FROM currencies WHERE code = 'PTS'");

    await withUserContext(userC.id, () =>
      service.restoreData(userC.id, {
        compressedData: backup,
        password: PASSWORD,
      }),
    );

    const [restored] = await dataSource.query(
      "SELECT name, symbol, decimal_places FROM currencies WHERE code = 'PTS'",
    );
    expect(restored).toEqual({
      name: "Family Points",
      symbol: "*",
      decimal_places: 0,
    });
  });

  it("rejects a restore when the confirmation password is invalid", async () => {
    const userA = await createTestUserDirect(dataSource, {
      email: "auth-a@example.com",
    });
    const userB = await createTestUserDirect(dataSource, {
      email: "auth-b@example.com",
    });
    await seedUserData(userA.id);
    const { buffer } = await withUserContext(userA.id, () =>
      service.exportToBuffer(userA.id),
    );

    await expect(
      withUserContext(userB.id, () =>
        service.restoreData(userB.id, {
          compressedData: buffer,
          password: "not-the-password",
        }),
      ),
    ).rejects.toThrow("Invalid password");

    expect(await countRows("accounts", userB.id)).toBe(0);
  });

  // Guard against the class of bug this change fixed: a new entity/table added
  // to the schema but never wired into the backup, so its data is silently lost
  // on restore. The synchronize:true test DB is built from entity metadata, so
  // it contains every @Entity table -- exactly where new tables come from.
  /**
   * The completeness verdict against a real database.
   *
   * The export decides, before the first byte of a download, whether every
   * attachment it names will have its bytes -- and since issue #1070 it decides
   * that for the `database` provider from a digest Postgres computes over the
   * column (`octet_length`, `sha256`), because pulling every blob onto the heap
   * to hash it was the memory defect being closed. A unit spec cannot show that
   * works: its `manager.query` is a mock, so the SQL is never parsed and the
   * digest is whatever the double says it is. Only a real server can.
   */
  describe("attachment completeness (database provider)", () => {
    const BYTES = Buffer.from("a receipt, as bytes");

    async function seedAttachment(
      userId: string,
      transactionId: string,
      options: { blob: Buffer | null; declaredSha?: string },
    ): Promise<string> {
      const id = randomUUID();
      await dataSource.query(
        `INSERT INTO transaction_attachments
           (id, user_id, transaction_id, filename, content_type, byte_size,
            sha256, storage_provider, storage_key)
         VALUES ($1, $2, $3, 'receipt.txt', 'text/plain', $4, $5, 'database', $6)`,
        [
          id,
          userId,
          transactionId,
          BYTES.length,
          options.declaredSha ??
            createHash("sha256").update(BYTES).digest("hex"),
          // `storage_key` equals the attachment's id for the database provider,
          // but as text rather than as the same uuid parameter -- Postgres
          // refuses to deduce two types for one placeholder.
          id,
        ],
      );
      if (options.blob) {
        await dataSource.query(
          `INSERT INTO attachment_blobs (attachment_id, data) VALUES ($1, $2)`,
          [id, options.blob],
        );
      }
      return id;
    }

    async function reportFor(userId: string): Promise<{
      report: Awaited<ReturnType<typeof service.exportToBuffer>>["report"];
      blobs: unknown[];
    }> {
      const { buffer, report } = await withUserContext(userId, () =>
        service.exportToBuffer(userId),
      );
      const parsed = JSON.parse(gunzipSync(buffer).toString("utf-8"));
      return { report, blobs: parsed.attachment_blobs };
    }

    it("counts a blob whose bytes match its metadata as included", async () => {
      const user = await createTestUserDirect(dataSource, {
        email: "att-ok@example.com",
      });
      const seeded = await seedUserData(user.id);
      await seedAttachment(user.id, seeded.expenseTxId, { blob: BYTES });

      const { report, blobs } = await reportFor(user.id);

      expect(report).toMatchObject({
        complete: true,
        expectedAttachments: 1,
        includedAttachments: 1,
      });
      // And the bytes travel, base64-encoded, so the artifact can restore them.
      expect(blobs).toHaveLength(1);
    });

    it("reports a blob that contradicts its recorded checksum as inconsistent", async () => {
      const user = await createTestUserDirect(dataSource, {
        email: "att-bad@example.com",
      });
      const seeded = await seedUserData(user.id);
      await seedAttachment(user.id, seeded.expenseTxId, {
        blob: Buffer.from("different bytes entirely"),
      });

      const { report } = await reportFor(user.id);

      expect(report).toMatchObject({
        complete: false,
        expectedAttachments: 1,
        inconsistentAttachments: 1,
      });
    });

    it("reports a metadata row with no blob as missing", async () => {
      const user = await createTestUserDirect(dataSource, {
        email: "att-missing@example.com",
      });
      const seeded = await seedUserData(user.id);
      await seedAttachment(user.id, seeded.expenseTxId, { blob: null });

      const { report } = await reportFor(user.id);

      expect(report).toMatchObject({
        complete: false,
        expectedAttachments: 1,
        missingAttachments: 1,
      });
    });
  });

  describe("schema coverage guard", () => {
    async function listPublicTables(): Promise<string[]> {
      const rows: Array<{ table_name: string }> = await dataSource.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      );
      return rows.map((r) => r.table_name);
    }

    it("backs up or explicitly excludes every table in the database", async () => {
      const dbTables = await listPublicTables();
      const covered = new Set(service.getBackedUpTableNames());
      const excluded = new Set(service.getIntentionallyExcludedTableNames());

      const unclassified = dbTables.filter(
        (t) => !covered.has(t) && !excluded.has(t),
      );

      // If this fails, a new table was added without deciding whether it belongs
      // in a backup. Add it to buildExportTableQueries()/RESTORABLE_TABLES (and the
      // restore inserts) to back it up, or to INTENTIONALLY_EXCLUDED_TABLES with
      // a reason if it should never be exported.
      expect(unclassified).toEqual([]);
    });

    it("keeps the backed-up and excluded sets disjoint and real", async () => {
      const dbTables = new Set(await listPublicTables());
      const covered = service.getBackedUpTableNames();
      const excluded = service.getIntentionallyExcludedTableNames();

      // No table is both backed up and excluded.
      const overlap = covered.filter((t) => new Set(excluded).has(t));
      expect(overlap).toEqual([]);

      // Every backed-up table actually exists (catch typos / renamed tables).
      const missing = covered.filter((t) => !dbTables.has(t));
      expect(missing).toEqual([]);
    });

    it("keeps the export coverage and restore allowlist in lockstep", () => {
      // The restore repopulates exactly what the export writes. currencies is the
      // one deliberate difference: it is restored via ensureCurrenciesExist, not
      // through insertRows/RESTORABLE_TABLES.
      const covered = new Set(service.getBackedUpTableNames());
      const expected = new Set([...RESTORABLE_TABLES, "currencies"]);
      expect([...covered].sort()).toEqual([...expected].sort());
    });
  });
});
