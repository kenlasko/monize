import { Test, TestingModule } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { DataSource } from "typeorm";
import { createHash, randomUUID } from "crypto";
import { gunzipSync, gzipSync } from "zlib";
import {
  BackupService,
  BackupPasswordRequiredError,
  RESTORABLE_TABLES,
} from "@/backup/backup.service";
import { BondPriceService } from "@/bonds/bond-price.service";
import { BondSeriesService } from "@/bonds/bond-series.service";
import { BenchmarkRefreshService } from "@/bonds/benchmark-refresh.service";
import { BondFetch } from "@/bonds/bond-adapter";
import { SeriesHttp } from "@/bonds/series-http";
import {
  fakeFetch,
  fakePdfText,
  SLUGS,
  seriesRoutes,
} from "@/bonds/adapters/pl/series/fixture-helpers";
import { extractPdfText } from "@/common/pdf-text";
import { AuthAttemptCounterService } from "@/auth/auth-attempt-counter.service";
import { CurrenciesService } from "@/currencies/currencies.service";
import { FxProviderChain } from "@/currencies/providers/fx-provider-chain";
import { ExchangeRateHistoryService } from "@/currencies/exchange-rate-history.service";
import {
  RateHistoryCatchUpService,
  settlePendingRateHistoryFills,
} from "@/currencies/rate-history-catch-up.service";
import { ProviderHealthService } from "@/provider-health/provider-health.service";
import { BackupBondSeriesRecoveryService } from "@/backup/backup-bond-series-recovery.service";
import { BondValuationService } from "@/bonds/bond-valuation.service";
import { FetchSyncService } from "@/common/jobs/fetch-sync.service";
import { BondCatalogService } from "@/bonds/bond-catalog.service";
import { bondInstrumentId, bondProgramId } from "@/bonds/bond-instrument-id";
import { BackupExportService } from "@/backup/backup-export.service";
import { BackupRestoreService } from "@/backup/backup-restore.service";
import { BackupAttachmentTransferService } from "@/backup/backup-attachment-transfer.service";
import { BackupRestoreDatabaseService } from "@/backup/backup-restore-database.service";
import { NetWorthService } from "@/net-worth/net-worth.service";
import { User } from "@/users/entities/user.entity";
import { OidcReauthService } from "@/auth/oidc/oidc-reauth.service";
import { EncryptionService } from "../../src/common/encryption/encryption.service";
import { JobClaimService } from "@/common/jobs/job-claim.service";
import { UserMaintenanceService } from "@/common/jobs/user-maintenance.service";
import {
  attachmentStorageProviders,
  createTestUserDirect,
  storeFixtureSeries,
} from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";
import { withUserContext } from "@/common/db/with-context";

// The issuer's letter is read as text: the fake PDF is the magic plus the saved
// letter text, so the real adapter parses the real fixture without pdfjs.
jest.mock("@/common/pdf-text", () => ({
  extractPdfText: jest.fn(),
}));

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
  let netWorth: NetWorthService;
  let dataSource: DataSource;
  // The one network door the restore's series recovery reaches: a fake over the
  // saved issuer pages and letters, swapped per test. Never the network.
  let door: jest.MockedFunction<BondFetch>;

  // The provider door of the post-restore rate history fill; the discovery of
  // the restored currencies in front of it is the real one.
  const fillRateGaps = jest.fn(async () => ({
    stored: 0,
    windowsFetched: 0,
    windowsUnanswered: 0,
    windowsRemaining: 0,
  }));

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
        // Real, depends only on DataSource: the R6 case proves restore does not
        // reinstate a pre-#1242 derived snapshot and that the lazy rebuild
        // (ensurePopulated) recomputes it under the corrected algorithm.
        NetWorthService,
        // Real: the restore recomputes the engine prices of a restored bond link
        // (R33), and the case below proves the engine's price replaces the file's.
        BondPriceService,
        BondValuationService,
        FetchSyncService,
        // Real: the restore fetches the bond series its file references and this
        // catalog lacks, through the real service and the real Polish adapter.
        // Only the HTTP door is faked, so what is stored is what an adapter
        // parsed, and the catalog's own store, lock and immutability run.
        BackupBondSeriesRecoveryService,
        BondSeriesService,
        BondCatalogService,
        CurrenciesService,
        // The bond catalog only ensures a currency row; it never asks the FX chain.
        { provide: FxProviderChain, useValue: {} },
        // Real: which currencies a restore pulls the history of is read from
        // the restored rows (issue #2226). Only the provider fill is faked.
        RateHistoryCatchUpService,
        { provide: ExchangeRateHistoryService, useValue: { fillRateGaps } },
        ProviderHealthService,
        {
          provide: SeriesHttp,
          useValue: {
            gated:
              () =>
              (...args: Parameters<BondFetch>) =>
                door(...args),
          },
        },
        // The first-fetch benchmark refresh and the explicit-fetch allowance are
        // their own suites' subjects.
        {
          provide: BenchmarkRefreshService,
          useValue: { refreshNeverFetched: async () => undefined },
        },
        {
          provide: AuthAttemptCounterService,
          useValue: { increment: async () => ({ count: 1 }) },
        },
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
        { provide: EncryptionService, useValue: { decrypt: () => "" } },
        // The real database-backed provider, which the completeness cases below
        // need: their whole point is that Postgres computes the digest the
        // export judges, and a double would answer for it. It also needs no
        // extra config, unlike local/S3.
        ...attachmentStorageProviders(),
      ],
    }).compile();

    service = module.get(BackupService);
    netWorth = module.get(NetWorthService);
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
    (extractPdfText as jest.Mock).mockImplementation(async (b: Uint8Array) =>
      fakePdfText(b),
    );
    door = fakeFetch({});
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
      `INSERT INTO categories (id, user_id, name, category_type) VALUES ($1, $2, 'Food', 'expense')`,
      [ids.parentCategoryId, userId],
    );
    await dataSource.query(
      `INSERT INTO categories (id, user_id, parent_id, name, category_type)
       VALUES ($1, $2, $3, 'Groceries', 'expense')`,
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
   * A scan pair (`docs/specs/document-scanner.md`): the enhanced image a
   * user sees, and the original photo it came from, linked by
   * `transaction_attachments.original_of_attachment_id` -- an immediate
   * self-referential FK, like `accounts.linked_loan_account_id` before it.
   *
   * This table's export carries no `ORDER BY`, so its row order is whatever the
   * heap gives, and any update to the visible row after the pair was written
   * moves it behind the original that points at it. The `UPDATE` below produces
   * exactly that order, so the restore meets the reference before its target --
   * the case `DEFERRED_FK_COLUMNS` exists for. Without the deferral the whole
   * restore aborts, so this fails loudly rather than silently dropping a link.
   */
  it("restores a scanned attachment and the original it came from", async () => {
    const userA = await createTestUserDirect(dataSource, {
      email: "scan-pair-a@example.com",
    });
    const userB = await createTestUserDirect(dataSource, {
      email: "scan-pair-b@example.com",
    });
    const seeded = await seedUserData(userA.id);

    const enhancedBytes = Buffer.from("the enhanced scan, as bytes");
    const originalBytes = Buffer.from("the original photo, as bytes");
    const enhancedId = randomUUID();
    const originalId = randomUUID();

    const insertAttachment = async (
      id: string,
      filename: string,
      bytes: Buffer,
      originalOf: string | null,
    ) => {
      await dataSource.query(
        `INSERT INTO transaction_attachments
           (id, user_id, transaction_id, filename, content_type, byte_size,
            sha256, storage_provider, storage_key, original_of_attachment_id)
         VALUES ($1, $2, $3, $4, 'image/jpeg', $5, $6, 'database', $7, $8)`,
        [
          id,
          userA.id,
          seeded.expenseTxId,
          filename,
          bytes.length,
          createHash("sha256").update(bytes).digest("hex"),
          id,
          originalOf,
        ],
      );
      await dataSource.query(
        `INSERT INTO attachment_blobs (attachment_id, data) VALUES ($1, $2)`,
        [id, bytes],
      );
    };

    // The visible row must exist before the original can reference it.
    await insertAttachment(enhancedId, "receipt-scan.jpg", enhancedBytes, null);
    await insertAttachment(
      originalId,
      "receipt.jpg",
      originalBytes,
      enhancedId,
    );

    // Rewrite the visible row so the heap puts it *after* the original. A
    // Postgres UPDATE writes a new tuple at the end of the relation, which is
    // what makes the export order hostile without contriving anything the
    // application could not produce.
    await dataSource.query(
      `UPDATE transaction_attachments SET filename = $2 WHERE id = $1`,
      [enhancedId, "receipt-scan.jpg"],
    );
    const exportOrder: Array<{ id: string }> = await dataSource.query(
      `SELECT id FROM transaction_attachments WHERE user_id = $1`,
      [userA.id],
    );
    // If this ever stops holding, the test still passes for the wrong reason --
    // it would be exercising the easy order.
    expect(exportOrder.map((row) => row.id)).toEqual([originalId, enhancedId]);

    const { buffer: backup, report } = await withUserContext(userA.id, () =>
      service.exportToBuffer(userA.id),
    );
    // Both halves are one attachment each as far as the archive is concerned.
    expect(report).toMatchObject({
      complete: true,
      expectedAttachments: 2,
      includedAttachments: 2,
    });

    const result = await withUserContext(userB.id, () =>
      service.restoreData(userB.id, {
        compressedData: backup,
        password: PASSWORD,
      }),
    );
    expect(result.restored.transactionAttachments).toBe(2);

    // The link survives, points at B's own copy of the visible row, and is not
    // merely null -- which is what a restore that dropped the column would give.
    const [restoredOriginal] = await dataSource.query(
      `SELECT o.id,
              o.original_of_attachment_id,
              v.filename AS visible_filename,
              v.user_id  AS visible_user
         FROM transaction_attachments o
         JOIN transaction_attachments v ON v.id = o.original_of_attachment_id
        WHERE o.user_id = $1 AND o.filename = 'receipt.jpg'`,
      [userB.id],
    );
    expect(restoredOriginal).toBeDefined();
    expect(restoredOriginal.visible_filename).toBe("receipt-scan.jpg");
    expect(restoredOriginal.visible_user).toBe(userB.id);
    expect(restoredOriginal.original_of_attachment_id).not.toBe(enhancedId);

    // And the two sets of bytes stay attached to their own rows.
    const blobs: Array<{ filename: string; data: Buffer }> =
      await dataSource.query(
        `SELECT ta.filename, ab.data
           FROM attachment_blobs ab
           JOIN transaction_attachments ta ON ta.id = ab.attachment_id
          WHERE ta.user_id = $1
          ORDER BY ta.filename`,
        [userB.id],
      );
    expect(blobs.map((b) => [b.filename, b.data.toString("utf-8")])).toEqual([
      ["receipt-scan.jpg", enhancedBytes.toString("utf-8")],
      ["receipt.jpg", originalBytes.toString("utf-8")],
    ]);
  });

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

  it("pulls the rate history of every foreign currency the restored accounts use, after the commit (#2226)", async () => {
    const userA = await createTestUserDirect(dataSource, {
      email: "fx-a@example.com",
    });
    const userB = await createTestUserDirect(dataSource, {
      email: "fx-b@example.com",
    });
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('CAD', 'Canadian Dollar', '$', 2, true),
              ('EUR', 'Euro', 'E', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
    await dataSource.query(
      `INSERT INTO user_preferences (user_id, default_currency, language)
       VALUES ($1, 'CAD', 'en')`,
      [userA.id],
    );
    await dataSource.query(
      `INSERT INTO accounts (user_id, account_type, name, currency_code,
                             current_balance, opening_balance)
       VALUES ($1, 'CHEQUING', 'Euro chequing', 'EUR', 0, 0),
              ($1, 'CHEQUING', 'Chequing', 'CAD', 0, 0)`,
      [userA.id],
    );

    const { buffer: backup } = await withUserContext(userA.id, () =>
      service.exportToBuffer(userA.id),
    );
    fillRateGaps.mockClear();

    await withUserContext(userB.id, () =>
      service.restoreData(userB.id, {
        compressedData: backup,
        password: PASSWORD,
      }),
    );
    await settlePendingRateHistoryFills();

    // `exchange_rates` is not in the backup, so nothing but this fill gives
    // the restored rows the years they reach back to. The reporting currency
    // has no rate history and is not asked about.
    expect(fillRateGaps.mock.calls).toEqual([[userB.id, "EUR"]]);
  });

  it("carries a calendar day note through an export and restore", async () => {
    const userA = await createTestUserDirect(dataSource, {
      email: "note-a@example.com",
    });
    const userB = await createTestUserDirect(dataSource, {
      email: "note-b@example.com",
    });

    // A note covering a RUN of days, so the round trip is asked about both
    // ends: a backup that carried only `note_date` would restore a five-day
    // vacation as a single day and nothing else would notice.
    await dataSource.query(
      `INSERT INTO calendar_day_notes (id, user_id, note_date, end_date, body)
       VALUES ($1, $2, '2026-06-14', '2026-06-18', 'Rent moved to the 15th')`,
      [randomUUID(), userA.id],
    );

    const { buffer: backup } = await withUserContext(userA.id, () =>
      service.exportToBuffer(userA.id),
    );

    const exported = JSON.parse(gunzipSync(backup).toString("utf-8"));
    expect(exported.calendar_day_notes).toHaveLength(1);
    expect(exported.calendar_day_notes[0]).toMatchObject({
      body: "Rent moved to the 15th",
    });

    await withUserContext(userB.id, () =>
      service.restoreData(userB.id, {
        compressedData: backup,
        password: PASSWORD,
      }),
    );

    const restored = await dataSource.query(
      `SELECT note_date::TEXT AS note_date, end_date::TEXT AS end_date, body
         FROM calendar_day_notes WHERE user_id = $1`,
      [userB.id],
    );
    // Both ends are calendar dates, so both must land on the same day whatever
    // zone the restoring server is in.
    expect(restored).toEqual([
      {
        note_date: "2026-06-14",
        end_date: "2026-06-18",
        body: "Rent moved to the 15th",
      },
    ]);
  });

  it("keeps a security's bond link where this deployment's catalog has the program and restores it unlinked elsewhere, with the series of its transactions", async () => {
    // bond_programs and bond_instruments are reference data a backup does not
    // carry, so a link survives only where the target's catalog holds the same
    // program or series (their ids are derived from the codes, hence the same
    // on every deployment), and a restore never fails on the foreign key for
    // one it lacks.
    const userA = await createTestUserDirect(dataSource, {
      email: "bond-a@example.com",
    });
    const userB = await createTestUserDirect(dataSource, {
      email: "bond-b@example.com",
    });
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('PLN', 'Zloty', 'zl', 2, true) ON CONFLICT (code) DO NOTHING`,
    );
    const programId = bondProgramId("PL", "PL_MF", "TOS");
    const instrumentId = bondInstrumentId("PL", "PL_MF", "TOS1029");
    await dataSource.query(
      `INSERT INTO bond_programs (id, issuer_country_code, issuer_code, program_code, currency_code)
       VALUES ($1, 'PL', 'PL_MF', 'TOS', 'PLN') ON CONFLICT DO NOTHING`,
      [programId],
    );
    await dataSource.query(
      `INSERT INTO bond_instruments (id, issuer_country_code, issuer_code, program_code, bond_program_id, series_code, currency_code, marketability)
       VALUES ($1, 'PL', 'PL_MF', 'TOS', $2, 'TOS1029', 'PLN', 'RETAIL_REDEEMABLE')`,
      [instrumentId, programId],
    );
    const insert = (symbol: string, currency: string) =>
      dataSource.query(
        `INSERT INTO securities (user_id, symbol, name, security_type, currency_code, bond_program_id)
         VALUES ($1, $2, $2, 'BOND', $3, $4)`,
        [userA.id, symbol, currency, programId],
      );
    await insert("LINKED", "PLN");
    await insert("UNKNOWN-SERIES", "PLN");
    await insert("WRONG-CCY", "PLN");
    // The series of each transaction rides along: LINKED's purchase names a
    // series this catalog holds and one it does not; the others name the series
    // of a program they are restored unlinked from.
    const [{ id: brokerage }] = await dataSource.query(
      `INSERT INTO accounts (user_id, account_type, account_sub_type, name,
                             currency_code, current_balance, opening_balance)
       VALUES ($1, 'INVESTMENT', 'INVESTMENT_BROKERAGE', 'Brokerage', 'PLN', 0, 0)
       RETURNING id`,
      [userA.id],
    );
    const trade = (symbol: string, date: string) =>
      dataSource.query(
        `INSERT INTO investment_transactions
           (user_id, account_id, security_id, bond_instrument_id, action, transaction_date, quantity, price, total_amount, status)
         SELECT $1, $2, id, $4, 'BUY', $5::date, 10, 100, 1000, 'UNRECONCILED'
           FROM securities WHERE user_id = $1 AND symbol = $3`,
        [userA.id, brokerage, symbol, instrumentId, date],
      );
    await trade("LINKED", "2026-10-05");
    await trade("LINKED", "2026-10-06");
    await trade("UNKNOWN-SERIES", "2026-10-05");
    // The engine's price rows ride along in the file; one is also a manual price.
    await dataSource.query(
      `INSERT INTO security_prices (security_id, price_date, close_price, source)
       SELECT id, DATE '2026-09-01', 100, 'bond_engine' FROM securities WHERE user_id = $1
       UNION ALL
       SELECT id, DATE '2026-09-02', 101, 'manual' FROM securities WHERE user_id = $1 AND symbol = 'UNKNOWN-SERIES'`,
      [userA.id],
    );

    const { buffer } = await withUserContext(userA.id, () =>
      service.exportToBuffer(userA.id),
    );
    const exported = JSON.parse(gunzipSync(buffer).toString("utf-8"));
    expect(
      exported.securities.map(
        (r: { symbol: string; bond_program_id: string }) => [
          r.symbol,
          r.bond_program_id,
        ],
      ),
    ).toEqual(
      expect.arrayContaining([
        ["LINKED", programId],
        ["UNKNOWN-SERIES", programId],
      ]),
    );

    // The file as another deployment's export would read: one program and one
    // series this catalog has never seeded, and one pair a crafted file could hold.
    const absent = randomUUID();
    for (const row of exported.securities) {
      if (row.symbol === "UNKNOWN-SERIES") row.bond_program_id = absent;
      if (row.symbol === "WRONG-CCY") row.currency_code = "USD";
    }
    const linkedId = exported.securities.find(
      (r: { symbol: string }) => r.symbol === "LINKED",
    ).id;
    const absentSeries = randomUUID();
    const linkedTrades = exported.investment_transactions.filter(
      (r: { security_id: string }) => r.security_id === linkedId,
    );
    expect(linkedTrades).toHaveLength(2);
    linkedTrades[1].bond_instrument_id = absentSeries;
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('USD', 'US Dollar', '$', 2, true) ON CONFLICT (code) DO NOTHING`,
    );
    const edited = gzipSync(Buffer.from(JSON.stringify(exported)));

    const result = await withUserContext(userB.id, () =>
      service.restoreData(userB.id, {
        compressedData: edited,
        password: PASSWORD,
      }),
    );
    // The restore succeeds and says how many bond links it had to drop, and which.
    expect(result.unlinkedBondSecurities?.count).toBe(2);
    expect([...(result.unlinkedBondSecurities?.symbols ?? [])].sort()).toEqual([
      "UNKNOWN-SERIES",
      "WRONG-CCY",
    ]);
    // One of LINKED's purchases named a series this catalog lacks.
    expect(result.unlinkedBondSeries?.count).toBe(1);
    expect(Object.keys(result.restored)).not.toContain(
      "unlinkedBondSecurities",
    );
    expect(Object.keys(result.restored)).not.toContain("unlinkedBondSeries");

    const restored = await dataSource.query(
      `SELECT symbol, bond_program_id, bond_auto_fetch FROM securities WHERE user_id = $1 ORDER BY symbol`,
      [userB.id],
    );
    expect(restored).toEqual([
      { symbol: "LINKED", bond_program_id: programId, bond_auto_fetch: false },
      {
        symbol: "UNKNOWN-SERIES",
        bond_program_id: null,
        bond_auto_fetch: false,
      },
      { symbol: "WRONG-CCY", bond_program_id: null, bond_auto_fetch: false },
    ]);
    // A transaction keeps the series only of its own security's program: the
    // catalog's series survives for LINKED, the missing one and every series of
    // an unlinked security are NULL (INV-BOND-007).
    const series = await dataSource.query(
      `SELECT s.symbol, TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS d, t.bond_instrument_id
         FROM investment_transactions t JOIN securities s ON s.id = t.security_id
        WHERE t.user_id = $1 ORDER BY s.symbol, t.transaction_date`,
      [userB.id],
    );
    expect(series).toEqual([
      { symbol: "LINKED", d: "2026-10-05", bond_instrument_id: instrumentId },
      { symbol: "LINKED", d: "2026-10-06", bond_instrument_id: null },
      { symbol: "UNKNOWN-SERIES", d: "2026-10-05", bond_instrument_id: null },
    ]);

    // An unlinked security keeps no engine price (nothing would ever refresh or
    // remove it); its manual price and the linked security's engine price stay.
    const prices = await dataSource.query(
      `SELECT s.symbol, p.source FROM security_prices p
         JOIN securities s ON s.id = p.security_id
        WHERE s.user_id = $1 ORDER BY s.symbol, p.source`,
      [userB.id],
    );
    expect(prices).toEqual([
      { symbol: "LINKED", source: "bond_engine" },
      { symbol: "UNKNOWN-SERIES", source: "manual" },
    ]);
  });

  describe("bond series recovery (INV-BOND-008: a restore of the person's own backup)", () => {
    const CODE = "EDO1036";
    const SERIES_ID = bondInstrumentId("PL", "PL_MF", CODE);
    const PROGRAM_ID = bondProgramId("PL", "PL_MF", "EDO");

    /**
     * User A holds an EDO security linked to its program and two purchases of
     * `EDO1036`, on a deployment whose catalog holds the series; the backup is
     * taken, then the catalog is emptied the way a fresh deployment's is
     * (INV-BOND-008: nothing is stored until a person asks), so the restore into
     * user B meets a catalog that lacks the series.
     */
    async function backupThenEmptyCatalog(email: string) {
      const userA = await createTestUserDirect(dataSource, { email });
      const userB = await createTestUserDirect(dataSource, {
        email: `restore-${email}`,
      });
      await dataSource.query(
        `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
         VALUES ('PLN', 'Zloty', 'zl', 2, true) ON CONFLICT (code) DO NOTHING`,
      );
      await dataSource.query(
        `INSERT INTO bond_programs (id, issuer_country_code, issuer_code, program_code, currency_code)
         VALUES ($1, 'PL', 'PL_MF', 'EDO', 'PLN')`,
        [PROGRAM_ID],
      );
      await dataSource.query(
        `INSERT INTO bond_instruments (id, issuer_country_code, issuer_code, program_code, bond_program_id, series_code, currency_code, marketability)
         VALUES ($1, 'PL', 'PL_MF', 'EDO', $2, $3, 'PLN', 'RETAIL_REDEEMABLE')`,
        [SERIES_ID, PROGRAM_ID, CODE],
      );
      const [{ id: accountId }] = await dataSource.query(
        `INSERT INTO accounts (user_id, account_type, account_sub_type, name,
                               currency_code, current_balance, opening_balance)
         VALUES ($1, 'INVESTMENT', 'INVESTMENT_BROKERAGE', 'Brokerage', 'PLN', 0, 0)
         RETURNING id`,
        [userA.id],
      );
      const [{ id: securityId }] = await dataSource.query(
        `INSERT INTO securities (user_id, symbol, name, security_type, currency_code, bond_program_id)
         VALUES ($1, 'EDO', 'EDO', 'BOND', 'PLN', $2) RETURNING id`,
        [userA.id, PROGRAM_ID],
      );
      for (const [action, date] of [
        ["BUY", "2026-10-05"],
        ["ADD_SHARES", "2026-10-06"],
      ]) {
        await dataSource.query(
          `INSERT INTO investment_transactions
             (user_id, account_id, security_id, bond_instrument_id, action, transaction_date, quantity, price, total_amount, status)
           VALUES ($1, $2, $3, $4, $5, $6::date, 10, 100, 1000, 'UNRECONCILED')`,
          [userA.id, accountId, securityId, SERIES_ID, action, date],
        );
      }

      const { buffer } = await withUserContext(userA.id, () =>
        service.exportToBuffer(userA.id),
      );
      // The catalog of a fresh deployment: the programs the adapter seeds at
      // boot, and no series (INV-BOND-008). (CASCADE also removes user A's rows
      // that referenced the series, which the backup holds.)
      await dataSource.query(
        `TRUNCATE bond_instruments, benchmark_series CASCADE`,
      );
      return { userB, buffer };
    }

    const restoredSeries = (userId: string) =>
      dataSource.query(
        `SELECT t.action, t.bond_instrument_id
           FROM investment_transactions t WHERE t.user_id = $1
          ORDER BY t.transaction_date`,
        [userId],
      );

    it("carries the identity of the referenced series in the backup, and no terms", async () => {
      const { buffer } = await backupThenEmptyCatalog("identity-a@example.com");
      const exported = JSON.parse(gunzipSync(buffer).toString("utf-8"));
      expect(exported.bondCatalog).toEqual({
        series: [
          {
            bondInstrumentId: SERIES_ID,
            issuerCountryCode: "PL",
            issuerCode: "PL_MF",
            programCode: "EDO",
            seriesCode: CODE,
          },
        ],
      });
      expect(JSON.stringify(exported.bondCatalog)).not.toMatch(
        /rate|margin|terms/i,
      );
    });

    it("fetches the series the catalog lacks, once, and gives the rows their series back", async () => {
      const { userB, buffer } = await backupThenEmptyCatalog(
        "recover-a@example.com",
      );
      door = fakeFetch(seriesRoutes(CODE, SLUGS.EDO));

      const result = await withUserContext(userB.id, () =>
        service.restoreData(userB.id, {
          compressedData: buffer,
          password: PASSWORD,
        }),
      );

      expect(result.unrecoveredBondSeries).toBeUndefined();
      expect(result.unlinkedBondSeries).toBeUndefined();
      expect(result.unlinkedBondSecurities).toBeUndefined();
      // Two rows, one series: the issuer's documents were each read once.
      const urls = door.mock.calls.map(([url]) => url);
      expect(urls.length).toBeGreaterThan(0);
      expect(new Set(urls).size).toBe(urls.length);
      // The series is in the catalog now, from the official source.
      const stored = await dataSource.query(
        `SELECT i.id, v.terms -> 'source' ->> 'provider' AS provider
           FROM bond_instruments i JOIN bond_terms_versions v ON v.bond_instrument_id = i.id`,
      );
      expect(stored).toEqual([
        { id: SERIES_ID, provider: "obligacjeskarbowe.pl" },
      ]);
      // Including an ADD_SHARES row, whose series nothing could re-infer.
      expect(await restoredSeries(userB.id)).toEqual([
        { action: "BUY", bond_instrument_id: SERIES_ID },
        { action: "ADD_SHARES", bond_instrument_id: SERIES_ID },
      ]);
      const linked = await dataSource.query(
        `SELECT bond_program_id FROM securities WHERE user_id = $1`,
        [userB.id],
      );
      expect(linked).toEqual([{ bond_program_id: PROGRAM_ID }]);
    });

    it("restores the rows without the series and reports it when the official source cannot supply it", async () => {
      const { userB, buffer } = await backupThenEmptyCatalog(
        "refused-a@example.com",
      );
      // Nothing is served: every request the adapter makes fails.
      door = fakeFetch({});

      const result = await withUserContext(userB.id, () =>
        service.restoreData(userB.id, {
          compressedData: buffer,
          password: PASSWORD,
        }),
      );

      expect(result.unrecoveredBondSeries?.count).toBe(1);
      expect(result.unrecoveredBondSeries?.series[0]).toMatchObject({
        issuerCountryCode: "PL",
        seriesCode: CODE,
      });
      expect(result.unlinkedBondSeries?.count).toBe(2);
      expect(await restoredSeries(userB.id)).toEqual([
        { action: "BUY", bond_instrument_id: null },
        { action: "ADD_SHARES", bond_instrument_id: null },
      ]);
      // The restore itself succeeded and nothing was stored.
      expect(
        await dataSource.query(`SELECT 1 FROM bond_instruments`),
      ).toHaveLength(0);
    });

    it("restores a backup without the catalog-identity member exactly as before, fetching nothing", async () => {
      const { userB, buffer } = await backupThenEmptyCatalog(
        "legacy-a@example.com",
      );
      const legacy = JSON.parse(gunzipSync(buffer).toString("utf-8"));
      delete legacy.bondCatalog;
      door = fakeFetch(seriesRoutes(CODE, SLUGS.EDO));

      const result = await withUserContext(userB.id, () =>
        service.restoreData(userB.id, {
          compressedData: gzipSync(Buffer.from(JSON.stringify(legacy))),
          password: PASSWORD,
        }),
      );

      expect(door).not.toHaveBeenCalled();
      expect(result.unrecoveredBondSeries).toBeUndefined();
      expect(result.unlinkedBondSeries?.count).toBe(2);
      expect(await restoredSeries(userB.id)).toEqual([
        { action: "BUY", bond_instrument_id: null },
        { action: "ADD_SHARES", bond_instrument_id: null },
      ]);
    });
  });

  it("recomputes the engine prices of a security whose bond link survived, replacing the file's rows (R33)", async () => {
    const userA = await createTestUserDirect(dataSource, {
      email: "bond-recompute-a@example.com",
    });
    const userB = await createTestUserDirect(dataSource, {
      email: "bond-recompute-b@example.com",
    });
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('PLN', 'Zloty', 'zl', 2, true) ON CONFLICT (code) DO NOTHING`,
    );
    // The series a person had fetched: instruments, terms and benchmark series.
    await storeFixtureSeries(
      dataSource,
      new BondCatalogService(dataSource, {
        ensureCatalogCurrency: async () => undefined,
      }),
    );
    const [{ id: accountId }] = await dataSource.query(
      `INSERT INTO accounts (user_id, account_type, account_sub_type, name,
                             currency_code, current_balance, opening_balance)
       VALUES ($1, 'INVESTMENT', 'INVESTMENT_BROKERAGE', 'Brokerage', 'PLN', 0, 0)
       RETURNING id`,
      [userA.id],
    );
    const [{ id: securityId }] = await dataSource.query(
      `INSERT INTO securities (user_id, symbol, name, security_type, currency_code, bond_program_id)
       VALUES ($1, 'TOS1029', 'TOS1029', 'BOND', 'PLN', $2) RETURNING id`,
      [userA.id, bondProgramId("PL", "PL_MF", "TOS")],
    );
    await dataSource.query(
      `INSERT INTO investment_transactions
         (user_id, account_id, security_id, bond_instrument_id, action, transaction_date, quantity, price, total_amount, status)
       VALUES ($1, $2, $3, $4, 'BUY', '2026-10-05', 10, 100, 1000, 'UNRECONCILED')`,
      [
        userA.id,
        accountId,
        securityId,
        bondInstrumentId("PL", "PL_MF", "TOS1029"),
      ],
    );
    // A price another deployment's engine wrote, nowhere near what this one computes.
    await dataSource.query(
      `INSERT INTO security_prices (security_id, price_date, close_price, source)
       VALUES ($1, DATE '2026-10-06', 123.45, 'bond_engine')`,
      [securityId],
    );

    const { buffer } = await withUserContext(userA.id, () =>
      service.exportToBuffer(userA.id),
    );
    const result = await withUserContext(userB.id, () =>
      service.restoreData(userB.id, {
        compressedData: buffer,
        password: PASSWORD,
      }),
    );
    expect(result.unlinkedBondSecurities).toBeUndefined();

    const rows: Array<{ d: string; p: number; source: string }> =
      await dataSource.query(
        `SELECT TO_CHAR(p.price_date, 'YYYY-MM-DD') AS d, p.close_price::float AS p, p.source
           FROM security_prices p JOIN securities s ON s.id = p.security_id
          WHERE s.user_id = $1 ORDER BY p.price_date`,
        [userB.id],
      );
    const sixth = rows.find((r) => r.d === "2026-10-06");
    expect(sixth?.source).toBe("bond_engine");
    expect(sixth!.p).toBeGreaterThan(100);
    expect(sixth!.p).toBeLessThan(101);
    // Priced from the purchase day, not only on the file's one day.
    expect(rows.some((r) => r.d === "2026-10-05")).toBe(true);
  });

  it("round-trips a rule's settlement claim with its references remapped", async () => {
    // docs/specs/loan-installment-settlement.md section 5.2: a `rule` claim names
    // the transaction it settled and the rule that settled it, and the loan
    // names its payment-matching rule (5.4). All three are references into the
    // file, so a restore must point them at the rows it inserted, never at the
    // exporting user's.
    const userA = await createTestUserDirect(dataSource, {
      email: "claim-a@example.com",
    });
    const userB = await createTestUserDirect(dataSource, {
      email: "claim-b@example.com",
    });
    const ids = await seedUserData(userA.id);

    const ruleId = randomUUID();
    const scheduleId = randomUUID();
    await dataSource.query(
      `INSERT INTO transaction_rules (id, user_id, name, position)
       VALUES ($1, $2, 'Settle the mortgage', 0)`,
      [ruleId, userA.id],
    );
    await dataSource.query(
      `UPDATE accounts SET payment_matching_rule_id = $1 WHERE id = $2`,
      [ruleId, ids.accountId],
    );
    await dataSource.query(
      `INSERT INTO scheduled_transactions (id, user_id, account_id, name, amount,
         currency_code, frequency, next_due_date, start_date)
       VALUES ($1, $2, $3, 'Mortgage', -50, 'USD', 'MONTHLY',
               '2026-02-15', '2026-01-15')`,
      [scheduleId, userA.id, ids.accountId],
    );
    const pricing = { version: 1, dueDate: "2026-01-15", paid: "50.00" };
    await dataSource.query(
      `INSERT INTO scheduled_transaction_postings
         (scheduled_transaction_id, original_due_date, posted_date,
          transaction_id, source, rule_id, pricing)
       VALUES ($1, '2026-01-15', '2026-01-15', $2, 'rule', $3, $4)`,
      [scheduleId, ids.expenseTxId, ruleId, JSON.stringify(pricing)],
    );

    const { buffer: backup } = await withUserContext(userA.id, () =>
      service.exportToBuffer(userA.id),
    );
    await withUserContext(userB.id, () =>
      service.restoreData(userB.id, {
        compressedData: backup,
        password: PASSWORD,
      }),
    );

    const claims: Array<{
      source: string;
      transaction_id: string;
      transaction_user: string;
      description: string;
      rule_id: string;
      rule_user: string;
      rule_name: string;
      pricing: unknown;
    }> = await dataSource.query(
      `SELECT stp.source, stp.transaction_id, t.user_id AS transaction_user,
              t.description, stp.rule_id, r.user_id AS rule_user,
              r.name AS rule_name, stp.pricing
         FROM scheduled_transaction_postings stp
         JOIN scheduled_transactions st ON st.id = stp.scheduled_transaction_id
         LEFT JOIN transactions t ON t.id = stp.transaction_id
         LEFT JOIN transaction_rules r ON r.id = stp.rule_id
        WHERE st.user_id = $1`,
      [userB.id],
    );
    expect(claims).toHaveLength(1);
    const [claim] = claims;
    expect(claim).toMatchObject({
      source: "rule",
      transaction_user: userB.id,
      description: "Weekly shop",
      rule_user: userB.id,
      rule_name: "Settle the mortgage",
      pricing,
    });
    expect(claim.transaction_id).not.toBe(ids.expenseTxId);
    expect(claim.rule_id).not.toBe(ruleId);

    const [loan]: Array<{ payment_matching_rule_id: string }> =
      await dataSource.query(
        `SELECT payment_matching_rule_id FROM accounts
          WHERE user_id = $1 AND name = 'Checking'`,
        [userB.id],
      );
    expect(loan.payment_matching_rule_id).toBe(claim.rule_id);

    // The exporting user's rows are untouched.
    const [original]: Array<{ transaction_id: string; rule_id: string }> =
      await dataSource.query(
        `SELECT transaction_id, rule_id FROM scheduled_transaction_postings
          WHERE scheduled_transaction_id = $1`,
        [scheduleId],
      );
    expect(original).toEqual({
      transaction_id: ids.expenseTxId,
      rule_id: ruleId,
    });
  });

  it("restores every mortgage of a backup taken before the type was required with its type", async () => {
    // docs/specs/mortgage-types.md, task P3-B1. A backup taken before Phase 1
    // carries is_canadian_mortgage / is_variable_rate and no mortgage_type; one
    // taken in Phases 1 and 2 carries a mortgage_type that is null on every
    // non-mortgage row and on a mortgage a pre-Phase-1 pod wrote. No code
    // reads the flags now, so the restore resolves the type the default
    // migration would have given each row: the column default, or a null read
    // as it, would turn a Canadian fixed-rate mortgage into ANNUITY.
    const userA = await createTestUserDirect(dataSource, {
      email: "legacy-type-a@example.com",
    });
    const userB = await createTestUserDirect(dataSource, {
      email: "legacy-type-b@example.com",
    });
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, created_by_user_id)
       VALUES ('CAD', 'Canadian Dollar', '$', $1)`,
      [userA.id],
    );
    const names = [
      "Pre-Phase-1 Canadian fixed",
      "Pre-Phase-1 Canadian variable",
      "Phase 1 untyped Canadian fixed",
      "Stored interest-only",
    ];
    for (const name of names) {
      await dataSource.query(
        `INSERT INTO accounts (id, user_id, account_type, name, currency_code,
                               current_balance, opening_balance)
         VALUES ($1, $2, 'MORTGAGE', $3, 'CAD', -300000, -300000)`,
        [randomUUID(), userA.id, name],
      );
    }
    await dataSource.query(
      `INSERT INTO accounts (id, user_id, account_type, name, currency_code,
                             current_balance, opening_balance)
       VALUES ($1, $2, 'CHEQUING', 'Phase 1 chequing', 'CAD', 0, 0)`,
      [randomUUID(), userA.id],
    );

    const { buffer } = await withUserContext(userA.id, () =>
      service.exportToBuffer(userA.id),
    );
    const doc = JSON.parse(gunzipSync(buffer).toString("utf8")) as {
      accounts: Record<string, unknown>[];
    };
    const legacyShape: Record<string, Record<string, unknown>> = {
      "Pre-Phase-1 Canadian fixed": {
        is_canadian_mortgage: true,
        is_variable_rate: false,
      },
      "Pre-Phase-1 Canadian variable": {
        is_canadian_mortgage: true,
        is_variable_rate: true,
      },
      "Phase 1 untyped Canadian fixed": {
        mortgage_type: null,
        is_canadian_mortgage: true,
        is_variable_rate: false,
      },
      "Stored interest-only": {
        mortgage_type: "INTEREST_ONLY",
        is_canadian_mortgage: true,
        is_variable_rate: false,
      },
      "Phase 1 chequing": {
        mortgage_type: null,
        is_canadian_mortgage: false,
        is_variable_rate: false,
      },
    };
    const legacy = {
      ...doc,
      accounts: doc.accounts.map((row) => {
        // The pre-Phase-1 shapes name no mortgage_type, so the key is absent.
        const { mortgage_type: _dropped, ...rest } = row;
        return { ...rest, ...legacyShape[row.name as string] };
      }),
    };

    await withUserContext(userB.id, () =>
      service.restoreData(userB.id, {
        compressedData: gzipSync(Buffer.from(JSON.stringify(legacy))),
        password: PASSWORD,
      }),
    );

    const restored = (await dataSource.query(
      `SELECT name, mortgage_type FROM accounts WHERE user_id = $1`,
      [userB.id],
    )) as { name: string; mortgage_type: string }[];
    expect(
      Object.fromEntries(restored.map((r) => [r.name, r.mortgage_type])),
    ).toEqual({
      "Pre-Phase-1 Canadian fixed": "CANADIAN_FIXED",
      "Pre-Phase-1 Canadian variable": "ANNUITY",
      "Phase 1 untyped Canadian fixed": "CANADIAN_FIXED",
      "Stored interest-only": "INTEREST_ONLY",
      "Phase 1 chequing": "ANNUITY",
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

  /**
   * INV-BACKUP-009: the uploaded file is untrusted, and this suite runs at
   * RLS_MODE=off -- the default -- where the restore code is the only barrier
   * between a crafted file and another user's rows.
   */
  describe("a crafted file naming another user's rows", () => {
    type Doc = Record<string, unknown> & {
      accounts: Record<string, unknown>[];
    };

    async function exportDoc(userId: string): Promise<Doc> {
      const { buffer } = await withUserContext(userId, () =>
        service.exportToBuffer(userId),
      );
      return JSON.parse(gunzipSync(buffer).toString("utf8")) as Doc;
    }

    async function accountSnapshot(userId: string): Promise<unknown[]> {
      return dataSource.query(
        `SELECT id, name, linked_account_id, current_balance
           FROM accounts WHERE user_id = $1 ORDER BY id`,
        [userId],
      );
    }

    it("refuses a reference to a row the file does not contain", async () => {
      const victim = await createTestUserDirect(dataSource, {
        email: "ref-victim@example.com",
      });
      const intruder = await createTestUserDirect(dataSource, {
        email: "ref-intruder@example.com",
      });
      const seeded = await seedUserData(victim.id);
      const before = await accountSnapshot(victim.id);

      // The transfer's inbound leg, the investment transfer's inbound leg and
      // nothing else now point at an account the file no longer carries: the
      // victim's own savings account, by its real id.
      const doc = await exportDoc(victim.id);
      const crafted = {
        ...doc,
        accounts: doc.accounts.filter(
          (row) => row.id !== seeded.savingsAccountId,
        ),
      };

      await expect(
        withUserContext(intruder.id, () =>
          service.restoreData(intruder.id, {
            compressedData: gzipSync(Buffer.from(JSON.stringify(crafted))),
            password: PASSWORD,
          }),
        ),
      ).rejects.toThrow(seeded.savingsAccountId);

      // Refused before anything was written, on either side.
      expect(await countRows("accounts", intruder.id)).toBe(0);
      expect(await countRows("transactions", intruder.id)).toBe(0);
      expect(await accountSnapshot(victim.id)).toEqual(before);
      const [{ n }] = await dataSource.query(
        `SELECT COUNT(*)::int AS n FROM transactions WHERE account_id = $1`,
        [seeded.savingsAccountId],
      );
      // The victim's own transfer-in leg, and nobody else's.
      expect(n).toBe(1);
    });

    it("does not let a primary key spelled without hyphens redirect the Phase-3 repair", async () => {
      const victim = await createTestUserDirect(dataSource, {
        email: "pk-victim@example.com",
      });
      const intruder = await createTestUserDirect(dataSource, {
        email: "pk-intruder@example.com",
      });
      const seeded = await seedUserData(victim.id);
      const before = await accountSnapshot(victim.id);

      // PostgreSQL reads this as the victim's checking account id. The remap
      // used to test ids with the hyphenated pattern only, so it passed through
      // unremapped, its insert conflicted and was skipped, and the deferred
      // UPDATE ... WHERE id = $2 then linked the VICTIM's account to the
      // intruder's.
      const spelled = seeded.accountId.replace(/-/g, "").toUpperCase();
      const doc = await exportDoc(victim.id);
      const template = doc.accounts.find((row) => row.id === seeded.accountId)!;
      const ownId = randomUUID();
      const crafted = {
        version: doc.version,
        exportedAt: doc.exportedAt,
        accounts: [
          {
            ...template,
            id: spelled,
            name: "Intruder A",
            institution_id: null,
            linked_account_id: ownId,
          },
          {
            ...template,
            id: ownId,
            name: "Intruder B",
            institution_id: null,
            linked_account_id: null,
          },
        ],
      };

      const result = await withUserContext(intruder.id, () =>
        service.restoreData(intruder.id, {
          compressedData: gzipSync(Buffer.from(JSON.stringify(crafted))),
          password: PASSWORD,
        }),
      );

      expect(result.restored.accounts).toBe(2);
      expect(await accountSnapshot(victim.id)).toEqual(before);
      // Both rows came back as the intruder's own, under fresh ids, linked to
      // each other.
      const restored: {
        id: string;
        name: string;
        linked_account_id: string | null;
      }[] = await dataSource.query(
        `SELECT id, name, linked_account_id FROM accounts
          WHERE user_id = $1 ORDER BY name`,
        [intruder.id],
      );
      expect(restored.map((row) => row.name)).toEqual([
        "Intruder A",
        "Intruder B",
      ]);
      expect(restored[0].id).not.toBe(seeded.accountId);
      expect(restored[0].linked_account_id).toBe(restored[1].id);
    });
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

  // MZ-1242-R6: monthly_account_balances is a derived cache. A backup taken
  // before the #1242 fix carries a wrong investment market_value; trusting it
  // on restore would reintroduce the bug on a fixed instance, and migration 164
  // (one-time) cannot catch a backup restored after it ran. Restore therefore
  // skips the table and the next net-worth read rebuilds it under the corrected
  // algorithm. A mocked repository cannot prove the round trip, so this is a
  // real export -> restore -> lazy-rebuild test.
  it("does not restore pre-#1242 monthly investment snapshots as authoritative", async () => {
    const userA = await createTestUserDirect(dataSource, {
      email: "r6-source@example.com",
    });
    const userB = await createTestUserDirect(dataSource, {
      email: "r6-dest@example.com",
    });

    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, created_by_user_id)
       VALUES ('USD', 'US Dollar', '$', $1)`,
      [userA.id],
    );
    await dataSource.query(
      `INSERT INTO user_preferences (user_id, default_currency, language)
       VALUES ($1, 'USD', 'en')`,
      [userA.id],
    );

    const [{ id: accountId }] = await dataSource.query(
      `INSERT INTO accounts (user_id, account_type, account_sub_type, name,
                             currency_code, current_balance, opening_balance)
       VALUES ($1, 'INVESTMENT', 'INVESTMENT_BROKERAGE', 'Sample Retirement Plan',
               'USD', 0, 0)
       RETURNING id`,
      [userA.id],
    );
    const [{ id: securityId }] = await dataSource.query(
      `INSERT INTO securities (user_id, symbol, name, currency_code,
                              skip_price_updates)
       VALUES ($1, 'BMT-DEMO', 'Broad Market Tracker', 'USD', true)
       RETURNING id`,
      [userA.id],
    );
    await dataSource.query(
      `INSERT INTO investment_transactions
         (user_id, account_id, security_id, action, transaction_date, quantity,
          price, total_amount, status)
       VALUES ($1, $2, $3, 'BUY', DATE '2024-01-15', 120, 61, 7320, 'UNRECONCILED')`,
      [userA.id, accountId, securityId],
    );
    await dataSource.query(
      `INSERT INTO security_prices (security_id, price_date, close_price, source)
       VALUES ($1, CURRENT_DATE, 120, 'manual')`,
      [securityId],
    );
    // The deliberately stale derived snapshot the backup carries.
    await dataSource.query(
      `INSERT INTO monthly_account_balances
         (user_id, account_id, month, balance, market_value)
       VALUES ($1, $2, DATE_TRUNC('month', CURRENT_DATE)::date, 0, 7320)`,
      [userA.id, accountId],
    );

    const { buffer } = await withUserContext(userA.id, () =>
      service.exportToBuffer(userA.id),
    );
    // The export still carries the derived row -- the skip is on the restore
    // side, not the export side.
    const parsed = JSON.parse(gunzipSync(buffer).toString("utf-8"));
    expect(parsed.monthly_account_balances).toHaveLength(1);

    const result = await withUserContext(userB.id, () =>
      service.restoreData(userB.id, {
        compressedData: buffer,
        password: PASSWORD,
      }),
    );
    // Source data restored; the derived cache deliberately not.
    expect(result.restored.investmentTransactions).toBe(1);
    expect(result.restored.securityPrices).toBe(1);
    expect(result.restored.monthlyAccountBalances).toBe(0);

    const beforeRead = await dataSource.query(
      `SELECT COUNT(*)::int AS n FROM monthly_account_balances WHERE user_id = $1`,
      [userB.id],
    );
    expect(beforeRead[0].n).toBe(0);

    // The supported lazy rebuild: ensurePopulated sees zero rows and rebuilds
    // every account from the restored source data under the corrected valuation.
    const today = new Date().toISOString().slice(0, 10);
    const history = await withUserContext(userB.id, () =>
      netWorth.getMonthlyNetWorth(userB.id, "2024-01-01", today),
    );
    // 120 shares * $120 accepted close = $14,400, not the stale $7,320.
    const latest = history[history.length - 1];
    expect(latest?.assets).toBe(14400);
  });

  /**
   * Issue #2400: a backup taken before the importer's PENDING IMPORT note was
   * retired brings the note back in, and one taken before
   * transactions.amount_is_provisional existed carries the state only in the
   * text. The restore flags the marked transfer legs of the second, strips the
   * note from the transfer legs of both, and leaves a non-transfer row's text
   * and a confirmed leg's flag alone (restore-legacy-normalizations.ts).
   */
  describe("the retired PENDING IMPORT note in an older artifact", () => {
    const NOTE =
      "\u26a0\ufe0f PENDING IMPORT: Amount may need adjustment when importing the other account.";
    const AFTER_IMPORTER_WROTE_THE_COLUMN =
      "20261125150107_transactions_amount_is_provisional_backfill_repeat.sql";

    /** Exports a user whose transfer legs carry the note, unflagged. */
    async function exportedWithNotes(): Promise<Record<string, unknown>> {
      const user = await createTestUserDirect(dataSource, {
        email: `pending-note-${randomUUID()}@example.com`,
      });
      const ids = await seedUserData(user.id);
      const setDescription = (id: string, description: string) =>
        dataSource.query(
          `UPDATE transactions SET description = $2 WHERE id = $1`,
          [id, description],
        );
      await setDescription(ids.transferInTxId, `Rent ${NOTE}`);
      await setDescription(ids.transferOutTxId, NOTE);
      await setDescription(ids.expenseTxId, NOTE);
      const { buffer } = await withUserContext(user.id, () =>
        service.exportToBuffer(user.id),
      );
      return JSON.parse(gunzipSync(buffer).toString("utf-8"));
    }

    /** Restores `doc` into a new user and reads back the three rows. */
    async function restoredRows(doc: Record<string, unknown>) {
      const target = await createTestUserDirect(dataSource, {
        email: `pending-note-target-${randomUUID()}@example.com`,
      });
      await withUserContext(target.id, () =>
        service.restoreData(target.id, {
          compressedData: gzipSync(Buffer.from(JSON.stringify(doc))),
          password: PASSWORD,
        }),
      );
      const rows: Array<{
        transaction_date: string;
        amount: string;
        description: string | null;
        amount_is_provisional: boolean;
      }> = await dataSource.query(
        `SELECT TO_CHAR(transaction_date, 'YYYY-MM-DD') AS transaction_date,
                amount, description, amount_is_provisional
           FROM transactions
          WHERE user_id = $1
            AND transaction_date IN ('2026-01-15', '2026-01-17')`,
        [target.id],
      );
      const pick = (date: string, sign: number) => {
        const row = rows.find(
          (r) =>
            r.transaction_date === date && Math.sign(Number(r.amount)) === sign,
        );
        if (!row) throw new Error(`no restored row on ${date}`);
        return {
          description: row.description,
          provisional: row.amount_is_provisional,
        };
      };
      return {
        transferIn: pick("2026-01-17", 1),
        transferOut: pick("2026-01-17", -1),
        expense: pick("2026-01-15", -1),
      };
    }

    it("restores a pre-column artifact's marked legs flagged and without the note", async () => {
      const doc = await exportedWithNotes();
      const { producedBy: _p, ...markerless } = doc;
      const preColumn = {
        ...markerless,
        transactions: (doc.transactions as Record<string, unknown>[]).map(
          ({ amount_is_provisional: _f, ...row }) => row,
        ),
      };

      const rows = await restoredRows(preColumn);

      expect(rows.transferIn).toEqual({
        description: "Rent",
        provisional: true,
      });
      expect(rows.transferOut).toEqual({
        description: null,
        provisional: true,
      });
      // Not a transfer leg: the reader's own text, never the importer's state.
      expect(rows.expense).toEqual({ description: NOTE, provisional: false });
    });

    it("strips the note from a later artifact's confirmed legs and leaves them confirmed", async () => {
      // From this schema on a reader could confirm a leg, which clears the
      // flag and keeps the note; flagging by the text would undo that.
      const doc = await exportedWithNotes();
      const rows = await restoredRows({
        ...doc,
        producedBy: { schemaMigration: AFTER_IMPORTER_WROTE_THE_COLUMN },
      });

      expect(rows.transferIn).toEqual({
        description: "Rent",
        provisional: false,
      });
      expect(rows.transferOut).toEqual({
        description: null,
        provisional: false,
      });
      expect(rows.expense).toEqual({ description: NOTE, provisional: false });
    });

    it("leaves an artifact with the column and no marker as stored", async () => {
      // No positive evidence that it predates the strip.
      const doc = await exportedWithNotes();
      const { producedBy: _p, ...markerless } = doc;

      const rows = await restoredRows(markerless);

      expect(rows.transferIn).toEqual({
        description: `Rent ${NOTE}`,
        provisional: false,
      });
      expect(rows.transferOut).toEqual({
        description: NOTE,
        provisional: false,
      });
    });
  });

  /**
   * A26-S06-04: a migration that changes what a stored value means backfills the
   * rows it finds once; a restore of an older artifact brings the old meaning
   * back in. `skip_price_updates` used to be overridden by a provider and is now
   * the user's own switch (20261012131846), so a pre-1.19 `true` on a security
   * that has a provider would never refresh again.
   */
  describe("semantic backfills for rows from an older artifact", () => {
    const AT_MIGRATION =
      "20261012131846_securities_skip_price_updates_user_switch.sql";

    /** Exports user A with four securities and returns the parsed document. */
    async function exportedDocument(userId: string): Promise<{
      doc: Record<string, unknown>;
      symbols: Record<string, string>;
    }> {
      await seedUserData(userId);
      const add = async (
        symbol: string,
        skip: boolean,
        provider: string | null,
        msn: string | null,
      ) => {
        await dataSource.query(
          `INSERT INTO securities (user_id, symbol, name, currency_code,
                                   skip_price_updates, quote_provider,
                                   msn_instrument_id)
           VALUES ($1, $2, $2, 'USD', $3, $4, $5)`,
          [userId, symbol, skip, provider, msn],
        );
      };
      await add("SKIPPROV", true, "yahoo", null);
      await add("SKIPMSN", true, null, "msn-1");
      await add("SKIPNONE", true, null, null);
      await add("LIVEPROV", false, "yahoo", null);
      const { buffer } = await withUserContext(userId, () =>
        service.exportToBuffer(userId),
      );
      return {
        doc: JSON.parse(gunzipSync(buffer).toString("utf-8")),
        symbols: {},
      };
    }

    /** Restores `doc` into a new user and answers symbol -> skip_price_updates. */
    async function restoredFlags(
      doc: Record<string, unknown>,
    ): Promise<Record<string, boolean>> {
      const target = await createTestUserDirect(dataSource, {
        email: `backfill-${randomUUID()}@example.com`,
      });
      await withUserContext(target.id, () =>
        service.restoreData(target.id, {
          compressedData: gzipSync(Buffer.from(JSON.stringify(doc))),
          password: PASSWORD,
        }),
      );
      const rows: Array<{ symbol: string; skip_price_updates: boolean }> =
        await dataSource.query(
          `SELECT symbol, skip_price_updates FROM securities WHERE user_id = $1`,
          [target.id],
        );
      return Object.fromEntries(
        rows.map((r) => [r.symbol, r.skip_price_updates]),
      );
    }

    /** The artifact as a pre-1.19 release wrote it: no marker, no new column. */
    const asPreMarker = (doc: Record<string, unknown>) => {
      const { producedBy: _producedBy, ...rest } = doc;
      return {
        ...rest,
        user_preferences: (
          doc.user_preferences as Record<string, unknown>[]
        ).map(({ hidden_table_columns: _h, ...row }) => row),
      };
    };

    it("clears the old meaning on a marker-less artifact without hidden_table_columns", async () => {
      const user = await createTestUserDirect(dataSource, {
        email: "backfill-source@example.com",
      });
      const { doc } = await exportedDocument(user.id);
      const old = asPreMarker(doc);
      expect(
        (old.user_preferences as Record<string, unknown>[])[0],
      ).not.toHaveProperty("hidden_table_columns");

      const flags = await restoredFlags(old);

      // A provider or an MSN id used to override the flag: the row refreshed, so
      // it must still refresh. A flag with neither was always a real "skip".
      expect(flags.SKIPPROV).toBe(false);
      expect(flags.SKIPMSN).toBe(false);
      expect(flags.SKIPNONE).toBe(true);
      expect(flags.LIVEPROV).toBe(false);
    });

    it.each([
      ["at the migration", AT_MIGRATION],
      [
        "after the migration",
        "20261012133629_user_preferences_hidden_table_columns.sql",
      ],
    ])(
      "keeps a deliberate switch when the marker is %s",
      async (_l, marker) => {
        const user = await createTestUserDirect(dataSource, {
          email: "backfill-marker@example.com",
        });
        const { doc } = await exportedDocument(user.id);
        // Even with the evidence column removed: the marker decides.
        const flags = await restoredFlags({
          ...asPreMarker(doc),
          producedBy: { schemaMigration: marker },
        });

        expect(flags.SKIPPROV).toBe(true);
        expect(flags.SKIPMSN).toBe(true);
        expect(flags.SKIPNONE).toBe(true);
        expect(flags.LIVEPROV).toBe(false);
      },
    );

    it("clears the old meaning when the marker is before the migration", async () => {
      const user = await createTestUserDirect(dataSource, {
        email: "backfill-before@example.com",
      });
      const { doc } = await exportedDocument(user.id);
      const flags = await restoredFlags({
        ...doc,
        producedBy: { schemaMigration: "20261012131845_before.sql" },
      });
      expect(flags.SKIPPROV).toBe(false);
      expect(flags.SKIPNONE).toBe(true);
    });

    it("keeps the flag on a marker-less artifact that carries hidden_table_columns (1.19.0)", async () => {
      const user = await createTestUserDirect(dataSource, {
        email: "backfill-119@example.com",
      });
      const { doc } = await exportedDocument(user.id);
      const { producedBy: _p, ...markerless } = doc;
      expect(
        (markerless.user_preferences as Record<string, unknown>[])[0],
      ).toHaveProperty("hidden_table_columns");

      const flags = await restoredFlags(markerless);

      expect(flags.SKIPPROV).toBe(true);
      expect(flags.SKIPMSN).toBe(true);
      expect(flags.SKIPNONE).toBe(true);
    });

    it("does not normalize a marker-less artifact with no preference rows", async () => {
      const user = await createTestUserDirect(dataSource, {
        email: "backfill-nopref@example.com",
      });
      const { doc } = await exportedDocument(user.id);
      const { producedBy: _p, ...markerless } = doc;
      const flags = await restoredFlags({
        ...markerless,
        user_preferences: [],
      });

      expect(flags.SKIPPROV).toBe(true);
      expect(flags.SKIPNONE).toBe(true);
    });

    it("writes the newest applied migration into the artifact, and restores one without it", async () => {
      // The entity-built schema has no ledger; create one the way the migration
      // runner does. Dropped again so no other case sees it.
      await dataSource.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           filename VARCHAR(255) PRIMARY KEY,
           applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
         )`,
      );
      try {
        await dataSource.query(
          `INSERT INTO schema_migrations (filename) VALUES
             ('191_payee_lookup_ai_enabled.sql'),
             ($1),
             ('20261012133629_user_preferences_hidden_table_columns.sql')`,
          [AT_MIGRATION],
        );
        const user = await createTestUserDirect(dataSource, {
          email: "backfill-marker-written@example.com",
        });
        const { doc } = await exportedDocument(user.id);
        expect(doc.producedBy).toEqual({
          schemaMigration:
            "20261012133629_user_preferences_hidden_table_columns.sql",
        });
        // And a restore of a marked artifact is unaffected by the extra member.
        const flags = await restoredFlags(doc);
        expect(flags.SKIPPROV).toBe(true);
      } finally {
        await dataSource.query(`DROP TABLE IF EXISTS schema_migrations`);
      }
    });

    it("writes a null marker when the ledger does not exist", async () => {
      const user = await createTestUserDirect(dataSource, {
        email: "backfill-no-ledger@example.com",
      });
      const { doc } = await exportedDocument(user.id);
      expect(doc.producedBy).toEqual({ schemaMigration: null });
    });
  });

  describe("delegations across a replace restore", () => {
    // synchronize:true builds these tables without the account foreign key that
    // database/schema.sql declares (ON DELETE CASCADE), and the cascade is what
    // the replace restore's wipe trips over. Declare it as the schema does.
    beforeAll(async () => {
      for (const table of [
        "account_delegate_grants",
        "delegate_account_favourites",
        "delegate_net_worth_exclusions",
      ]) {
        await dataSource.query(
          `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_account_cascade`,
        );
        await dataSource.query(
          `ALTER TABLE ${table} ADD CONSTRAINT ${table}_account_cascade
             FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE`,
        );
      }
    });

    it("keeps a delegate's grant, favourite and exclusion on the restored account", async () => {
      const owner = await createTestUserDirect(dataSource, {
        email: "deleg-owner@example.com",
      });
      const delegate = await createTestUserDirect(dataSource, {
        email: "deleg-delegate@example.com",
      });
      const seeded = await seedUserData(owner.id);
      const [{ id: delegationId }] = await dataSource.query(
        `INSERT INTO account_delegates (owner_user_id, delegate_user_id, status)
         VALUES ($1, $2, 'active') RETURNING id`,
        [owner.id, delegate.id],
      );
      await dataSource.query(
        `INSERT INTO account_delegate_grants (delegation_id, account_id, can_read, is_joint)
         VALUES ($1, $2, true, true)`,
        [delegationId, seeded.accountId],
      );
      await dataSource.query(
        `INSERT INTO delegate_account_favourites (delegate_user_id, account_id, sort_order)
         VALUES ($1, $2, 4)`,
        [delegate.id, seeded.accountId],
      );
      await dataSource.query(
        `INSERT INTO delegate_net_worth_exclusions (delegate_user_id, account_id)
         VALUES ($1, $2)`,
        [delegate.id, seeded.accountId],
      );

      const { buffer } = await withUserContext(owner.id, () =>
        service.exportToBuffer(owner.id),
      );
      const result = await withUserContext(owner.id, () =>
        service.restoreData(owner.id, {
          compressedData: buffer,
          password: PASSWORD,
        }),
      );

      // The restore mints fresh account ids; the rows follow the account.
      const [{ id: newAccountId }] = await dataSource.query(
        `SELECT id FROM accounts WHERE user_id = $1 AND name = 'Checking'`,
        [owner.id],
      );
      expect(newAccountId).not.toBe(seeded.accountId);
      const grants = await dataSource.query(
        `SELECT is_joint FROM account_delegate_grants
          WHERE delegation_id = $1 AND account_id = $2`,
        [delegationId, newAccountId],
      );
      expect(grants).toEqual([{ is_joint: true }]);
      const favourites = await dataSource.query(
        `SELECT sort_order FROM delegate_account_favourites
          WHERE delegate_user_id = $1 AND account_id = $2`,
        [delegate.id, newAccountId],
      );
      expect(favourites).toEqual([{ sort_order: 4 }]);
      const exclusions = await dataSource.query(
        `SELECT 1 FROM delegate_net_worth_exclusions
          WHERE delegate_user_id = $1 AND account_id = $2`,
        [delegate.id, newAccountId],
      );
      expect(exclusions).toHaveLength(1);
      expect(result.delegationRows).toEqual({ kept: 3, notRestored: 0 });
    });

    it("reports the delegation rows of an account the file does not contain", async () => {
      const owner = await createTestUserDirect(dataSource, {
        email: "deleg-owner2@example.com",
      });
      const delegate = await createTestUserDirect(dataSource, {
        email: "deleg-delegate2@example.com",
      });
      await seedUserData(owner.id);
      const { buffer } = await withUserContext(owner.id, () =>
        service.exportToBuffer(owner.id),
      );
      // An account created after the backup was taken, shared with the delegate.
      const lateId = randomUUID();
      await dataSource.query(
        `INSERT INTO accounts (id, user_id, account_type, name, currency_code,
                               current_balance, opening_balance)
         VALUES ($1, $2, 'SAVINGS', 'Late', 'USD', 0, 0)`,
        [lateId, owner.id],
      );
      const [{ id: delegationId }] = await dataSource.query(
        `INSERT INTO account_delegates (owner_user_id, delegate_user_id, status)
         VALUES ($1, $2, 'active') RETURNING id`,
        [owner.id, delegate.id],
      );
      await dataSource.query(
        `INSERT INTO account_delegate_grants (delegation_id, account_id)
         VALUES ($1, $2)`,
        [delegationId, lateId],
      );

      const result = await withUserContext(owner.id, () =>
        service.restoreData(owner.id, {
          compressedData: buffer,
          password: PASSWORD,
        }),
      );

      expect(result.delegationRows).toEqual({ kept: 0, notRestored: 1 });
      expect(
        await dataSource.query(`SELECT 1 FROM account_delegate_grants`),
      ).toHaveLength(0);
    });
  });
});
