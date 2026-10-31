import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { gunzipSync } from "zlib";
import { ConfigModule } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource } from "typeorm";

import { AttachmentOrphanSweeper } from "@/attachments/attachment-orphan-sweeper.service";
import {
  AttachmentsService,
  UploadedAttachmentFile,
} from "@/attachments/attachments.service";
import type { AttachmentStorageProvider } from "@/attachments/storage/attachment-storage.interface";
import { AttachmentStorageRegistry } from "@/attachments/storage/attachment-storage.registry";
import { OidcReauthService } from "@/auth/oidc/oidc-reauth.service";
import { BackupAttachmentTransferService } from "@/backup/backup-attachment-transfer.service";
import { BackupBondSeriesRecoveryService } from "@/backup/backup-bond-series-recovery.service";
import { BackupExportService } from "@/backup/backup-export.service";
import { BackupRestoreDatabaseService } from "@/backup/backup-restore-database.service";
import { BackupRestoreService } from "@/backup/backup-restore.service";
import { BackupService } from "@/backup/backup.service";
import { BondPriceService } from "@/bonds/bond-price.service";
import { withScopedDb } from "@/common/db/scoped-db";
import { withSystemContext, withUserContext } from "@/common/db/with-context";
import { EncryptionService } from "@/common/encryption/encryption.service";
import { JobClaimService } from "@/common/jobs/job-claim.service";
import { UserMaintenanceService } from "@/common/jobs/user-maintenance.service";
import { NetWorthService } from "@/net-worth/net-worth.service";
import { loadAttachmentPresence } from "@/transaction-rules/rule-facts";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import { User } from "@/users/entities/user.entity";
import { WarrantiesModule } from "@/warranties/warranties.module";
import { WarrantiesService } from "@/warranties/warranties.service";

import {
  attachmentStorageProviders,
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
  INTEGRATION_TYPEORM_OPTIONS,
} from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";

/**
 * A warranty's documents against a real PostgreSQL
 * (docs/specs/warranty-tracker.md section 6.3 and section 11:
 * Attachments, Backup; WTY-003).
 *
 * `chk_attachment_one_parent` is declared in SQL only, so a schema
 * synchronized from the entities does not have it. Each harness here applies
 * the shipped migration file itself, which is the constraint production runs,
 * rather than a copy of its predicate.
 */
const MIGRATIONS_DIR = join(__dirname, "../../../database/migrations");

async function applyAttachmentParentMigration(db: DataSource): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) =>
    f.endsWith("_attachment_parent.sql"),
  );
  expect(files).toHaveLength(1);
  // Every statement is idempotent, so it runs cleanly over the columns the
  // entities already created and adds the two CHECKs and the index.
  await db.query(readFileSync(join(MIGRATIONS_DIR, files[0]), "utf8"));
}

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

const upload = (name: string, buffer: Buffer): UploadedAttachmentFile => ({
  originalname: name,
  buffer,
  size: buffer.length,
});

describe("A warranty's documents under RLS enforcement (WTY-003)", () => {
  jest.setTimeout(240000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  /** The table owner: seeds and inspects. Never the connection under test. */
  let db: DataSource;
  let attachments: AttachmentsService;
  let sweeper: AttachmentOrphanSweeper;
  let warranties: WarrantiesService;
  let objects: Map<string, Buffer>;

  let aliceId: string;
  let accountId: string;
  /** The purchase the warranty links to; it has no attachment of its own. */
  let linkedTxId: string;
  /** An unrelated purchase with a receipt: the positive control. */
  let otherTxId: string;
  let warrantyId: string;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);

  const rowsOf = (column: "warranty_id" | "transaction_id", id: string) =>
    db.query(
      `SELECT id, transaction_id, warranty_id, document_kind,
              original_of_attachment_id
         FROM transaction_attachments WHERE ${column} = $1 ORDER BY id`,
      [id],
    ) as Promise<
      Array<{
        id: string;
        transaction_id: string | null;
        warranty_id: string | null;
        document_kind: string;
        original_of_attachment_id: string | null;
      }>
    >;

  /** One attachment row by raw SQL, as the system context. */
  const insertRaw = (parents: {
    transactionId: string | null;
    warrantyId: string | null;
  }) =>
    withSystemContext(() =>
      withScopedDb(harness.app, (m) =>
        m.query(
          `INSERT INTO transaction_attachments
             (user_id, transaction_id, warranty_id, filename, content_type,
              byte_size, sha256, storage_provider, storage_key)
           VALUES ($1, $2, $3, 'raw.png', 'image/png', 10, $4, 's3',
                   gen_random_uuid()::text)
           RETURNING id`,
          [aliceId, parents.transactionId, parents.warrantyId, "a".repeat(64)],
        ),
      ),
    );

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([
      TransactionsModule,
      WarrantiesModule,
    ]);
    module = harness.module;
    db = harness.owner;
    await applyAttachmentParentMigration(db);
    warranties = module.get(WarrantiesService);

    // An external provider, so a deletion writes tombstones: the database
    // provider's bytes go with their rows through attachment_blobs' own
    // foreign key, and the trigger skips them.
    const storage: AttachmentStorageProvider = {
      name: "s3",
      addressable: true,
      save: async (key: string, data: Buffer) => {
        objects.set(key, data);
      },
      load: async (key: string) => {
        const found = objects.get(key);
        if (!found) throw new Error(`no object at ${key}`);
        return found;
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
    };
    const registry = new AttachmentStorageRegistry(storage, [storage]);
    sweeper = new AttachmentOrphanSweeper(harness.app, registry);
    attachments = new AttachmentsService(harness.app, registry, sweeper);

    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    await db.query(
      `INSERT INTO currencies (code, name, symbol) VALUES ('USD', 'US Dollar', '$')
       ON CONFLICT DO NOTHING`,
    );
    const [account] = await db.query(
      `INSERT INTO accounts (user_id, name, account_type, currency_code,
                             current_balance, opening_balance)
       VALUES ($1, 'Chequing', 'CHEQUING', 'USD', 0, 0) RETURNING id`,
      [aliceId],
    );
    accountId = account.id;
    const seedTx = async (payee: string) =>
      (
        await db.query(
          `INSERT INTO transactions (user_id, account_id, amount, transaction_date,
                                     currency_code, payee_name)
           VALUES ($1, $2, -499, '2026-10-01', 'USD', $3) RETURNING id`,
          [aliceId, accountId, payee],
        )
      )[0].id as string;
    linkedTxId = await seedTx("Appliance World");
    otherTxId = await seedTx("Grocer");
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "attachment_blob_tombstones",
      "transaction_attachments",
      "warranties",
    ]);
    objects = new Map();
    const [row] = await db.query(
      `INSERT INTO warranties (user_id, name, purchase_date, expires_on, transaction_id)
       VALUES ($1, 'Dishwasher', '2026-10-01', '2028-10-01', $2) RETURNING id`,
      [aliceId, linkedTxId],
    );
    warrantyId = row.id;
  });

  it("the harness enforces RLS and carries the shipped CHECK", async () => {
    const [check] = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'chk_attachment_one_parent'
          AND conrelid = 'transaction_attachments'::regclass`,
    );
    expect(check?.def).toMatch(
      /num_nonnulls\(transaction_id, warranty_id, shared_group_id, shared_entry_id\) = 1/,
    );
    expect(
      await harness.app.query(`SELECT id FROM transaction_attachments`),
    ).toEqual([]);
  });

  describe("chk_attachment_one_parent", () => {
    it("refuses a row with no parent and a row with two", async () => {
      await expect(
        insertRaw({ transactionId: null, warrantyId: null }),
      ).rejects.toThrow(/chk_attachment_one_parent/);
      await expect(
        insertRaw({ transactionId: linkedTxId, warrantyId }),
      ).rejects.toThrow(/chk_attachment_one_parent/);
      expect(await db.query(`SELECT id FROM transaction_attachments`)).toEqual(
        [],
      );
    });

    it("admits exactly one parent of either kind, and refuses a second one added later", async () => {
      // The positive controls: the refusals above are the CHECK, not a row
      // the table would refuse anyway.
      const [onTransaction] = await insertRaw({
        transactionId: otherTxId,
        warrantyId: null,
      });
      await insertRaw({ transactionId: null, warrantyId });
      await expect(
        db.query(
          `UPDATE transaction_attachments SET warranty_id = $2 WHERE id = $1`,
          [onTransaction.id, warrantyId],
        ),
      ).rejects.toThrow(/chk_attachment_one_parent/);
    });
  });

  /**
   * The maintainer's ruling (2026-10-22): a document uploaded to a warranty
   * that is linked to a transaction is one of that transaction's attachments.
   * The row still has one parent, the warranty; the transaction reaches it
   * through `warranties.transaction_id` (`attachment-parent.ts`).
   */
  describe("a linked warranty's document is one of the transaction's attachments", () => {
    async function uploadWarrantyScanPair(): Promise<string> {
      const visible = await asAlice(() =>
        attachments.create(
          aliceId,
          { kind: "warranty", id: warrantyId },
          upload("receipt-scan.png", PNG),
          upload("receipt.jpg", JPEG),
          "receipt",
        ),
      );
      return visible.id;
    }

    async function register(search: string) {
      const page = await asAlice(() =>
        module
          .get(TransactionsService)
          .findAll(
            aliceId,
            [accountId],
            undefined,
            undefined,
            undefined,
            undefined,
            1,
            50,
            false,
            search,
          ),
      );
      return page.data;
    }

    /** A warranty with no purchase; nothing reaches its documents. */
    async function seedUnlinkedWarrantyWithDocument(): Promise<string> {
      const [row] = await db.query(
        `INSERT INTO warranties (user_id, name, purchase_date, expires_on)
         VALUES ($1, 'Kettle', '2026-09-01', '2027-09-01') RETURNING id`,
        [aliceId],
      );
      await asAlice(() =>
        attachments.create(
          aliceId,
          { kind: "warranty", id: row.id },
          upload("kettle.png", PNG),
          undefined,
          "photo",
        ),
      );
      return row.id;
    }

    it("stores both halves of a scan pair under the warranty alone, and the transaction lists the document", async () => {
      const visibleId = await uploadWarrantyScanPair();

      const rows = await rowsOf("warranty_id", warrantyId);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatchObject({
          transaction_id: null,
          warranty_id: warrantyId,
          document_kind: "receipt",
        });
      }
      expect(rows.map((r) => r.original_of_attachment_id).sort()).toEqual(
        [visibleId, null].sort(),
      );

      const listed = await asAlice(() =>
        attachments.findAllFor(aliceId, { kind: "warranty", id: warrantyId }),
      );
      expect(listed.map((a) => a.id)).toEqual([visibleId]);
      const view = await asAlice(() =>
        warranties.findOne(aliceId, warrantyId, { today: "2026-10-21" }),
      );
      expect(view.documentCount).toBe(1);

      // The purchase reaches the document through its warranty: the row
      // stays the warranty's, and the list names the warranty.
      const own = await asAlice(() =>
        attachments.create(
          aliceId,
          { kind: "transaction", id: linkedTxId },
          upload("invoice.png", PNG),
        ),
      );
      const forTransaction = await asAlice(() =>
        attachments.findAllFor(aliceId, {
          kind: "transaction",
          id: linkedTxId,
        }),
      );
      expect(
        forTransaction.map((a) => ({
          id: a.id,
          transactionId: a.transactionId,
          warrantyId: a.warrantyId,
          warrantyName: a.warrantyName,
          documentKind: a.documentKind,
          originalAttachmentId: a.originalAttachmentId,
        })),
      ).toEqual([
        {
          id: own.id,
          transactionId: linkedTxId,
          warrantyId: null,
          warrantyName: null,
          documentKind: "other",
          originalAttachmentId: null,
        },
        {
          id: visibleId,
          transactionId: null,
          warrantyId,
          warrantyName: "Dishwasher",
          documentKind: "receipt",
          originalAttachmentId: expect.any(String),
        },
      ]);
      // The other purchase reaches nothing.
      expect(
        await asAlice(() =>
          attachments.findAllFor(aliceId, {
            kind: "transaction",
            id: otherTxId,
          }),
        ),
      ).toEqual([]);
    });

    it("is counted by attachmentCount, has:attachment and the rule facts' presence, archived or not", async () => {
      await uploadWarrantyScanPair();
      await asAlice(() =>
        attachments.create(
          aliceId,
          { kind: "transaction", id: otherTxId },
          upload("grocer.png", PNG),
        ),
      );
      await seedUnlinkedWarrantyWithDocument();
      // The linked purchase has no attachment of its own: what it counts is
      // reached through the warranty.
      expect(await rowsOf("transaction_id", linkedTxId)).toEqual([]);

      // Statistics, as autovacuum would have them. Without them the planner
      // costs the register's policy-laden join over default row estimates,
      // crosses jit_above_cost, and JIT-compiles some 2,600 functions: about
      // 17 seconds per call on two rows, which is time and not evidence.
      await db.query(`ANALYZE`);
      const page = await register("");
      const byId = new Map(page.map((row) => [row.id, row]));
      expect(byId.get(linkedTxId)).toMatchObject({
        attachmentCount: 1,
        warrantyCount: 1,
      });
      expect(byId.get(otherTxId)).toMatchObject({
        attachmentCount: 1,
        warrantyCount: 0,
      });

      expect(
        (await register("has:attachment")).map((r) => r.id).sort(),
      ).toEqual([linkedTxId, otherTxId].sort());
      expect(await register("-has:attachment")).toEqual([]);

      const present = await asAlice(() =>
        withScopedDb(harness.app, (m) =>
          loadAttachmentPresence(m, aliceId, [linkedTxId, otherTxId]),
        ),
      );
      expect([...present].sort()).toEqual([linkedTxId, otherTxId].sort());

      // A receipt is a fact about the purchase: putting the warranty away
      // drops it from the warranty badge, not from the attachments.
      await db.query(
        `UPDATE warranties SET archived_at = now() WHERE id = $1`,
        [warrantyId],
      );
      const archived = new Map(
        (await register("")).map((row) => [row.id, row]),
      );
      expect(archived.get(linkedTxId)).toMatchObject({
        attachmentCount: 1,
        warrantyCount: 0,
      });
      expect(
        (await register("has:attachment")).map((r) => r.id).sort(),
      ).toEqual([linkedTxId, otherTxId].sort());
    });

    it("changes a document's kind on both halves of its scan pair, never on a transaction's attachment", async () => {
      const visibleId = await uploadWarrantyScanPair();
      const own = await asAlice(() =>
        attachments.create(
          aliceId,
          { kind: "transaction", id: linkedTxId },
          upload("invoice.png", PNG),
        ),
      );

      const updated = await asAlice(() =>
        attachments.updateDocumentKind(aliceId, visibleId, "manual"),
      );
      expect(updated).toMatchObject({
        id: visibleId,
        documentKind: "manual",
        warrantyName: "Dishwasher",
        originalAttachmentId: expect.any(String),
      });
      const kinds = (await rowsOf("warranty_id", warrantyId)).map(
        (r) => r.document_kind,
      );
      expect(kinds).toEqual(["manual", "manual"]);

      // The warranty certificate is a kind the database accepts too
      // (chk_attachment_document_kind).
      await asAlice(() =>
        attachments.updateDocumentKind(aliceId, visibleId, "warranty"),
      );
      expect(
        (await rowsOf("warranty_id", warrantyId)).map((r) => r.document_kind),
      ).toEqual(["warranty", "warranty"]);

      await expect(
        asAlice(() =>
          attachments.updateDocumentKind(aliceId, own.id, "receipt"),
        ),
      ).rejects.toThrow(/document kind applies only to a warranty/);
      expect(
        (await rowsOf("transaction_id", linkedTxId)).map(
          (r) => r.document_kind,
        ),
      ).toEqual(["other"]);
    });
  });

  it("deleting the warranty cascades its documents and tombstones their bytes", async () => {
    const pair = await asAlice(() =>
      attachments.create(
        aliceId,
        { kind: "warranty", id: warrantyId },
        upload("manual-scan.png", PNG),
        upload("manual.jpg", JPEG),
        "manual",
      ),
    );
    const receipt = await asAlice(() =>
      attachments.create(
        aliceId,
        { kind: "transaction", id: otherTxId },
        upload("grocer.png", PNG),
      ),
    );
    const documentKeys = (await rowsOf("warranty_id", warrantyId))
      .map((r) => r.id)
      .sort();
    expect(documentKeys).toContain(pair.id);
    expect(objects.size).toBe(3);

    await asAlice(() => warranties.remove(aliceId, warrantyId));

    // The cascade is the mechanism: no application code names the documents.
    expect(await rowsOf("warranty_id", warrantyId)).toEqual([]);
    const tombstones = await db.query(
      `SELECT user_id, storage_provider, storage_key
         FROM attachment_blob_tombstones ORDER BY storage_key`,
    );
    expect(tombstones).toEqual(
      documentKeys.map((key) => ({
        user_id: aliceId,
        storage_provider: "s3",
        storage_key: key,
      })),
    );
    // The transaction's receipt is untouched and tombstones nothing.
    expect(
      (await rowsOf("transaction_id", otherTxId)).map((r) => r.id),
    ).toEqual([receipt.id]);
    // The purchase reached the manual only through the warranty, so it is
    // out of the purchase's count with it.
    await db.query(`ANALYZE`);
    const page = await asAlice(() =>
      module
        .get(TransactionsService)
        .findAll(
          aliceId,
          [accountId],
          undefined,
          undefined,
          undefined,
          undefined,
          1,
          50,
        ),
    );
    const byId = new Map(page.data.map((row) => [row.id, row]));
    expect(byId.get(linkedTxId)).toMatchObject({
      attachmentCount: 0,
      warrantyCount: 0,
    });
    expect(byId.get(otherTxId)).toMatchObject({ attachmentCount: 1 });

    // The sweep that reads the tombstones removes exactly those bytes.
    await withSystemContext(() => sweeper.sweep());
    expect([...objects.keys()]).toEqual([receipt.id]);
    expect(
      await db.query(`SELECT storage_key FROM attachment_blob_tombstones`),
    ).toEqual([]);
  });
});

/**
 * A warranty, its claim and its document survive the round trip that is the
 * user's only way to move their data. Its own module because a restore is
 * owner work (calendar-day-notes.integration.spec.ts has the same shape), and
 * the database provider because its bytes are the ones the archive carries.
 */
describe("A warranty survives a backup round trip", () => {
  jest.setTimeout(180000);

  const PASSWORD = "TestPassword123!";
  const BYTES = Buffer.from("the dishwasher's manual, as bytes");
  let module: TestingModule;
  let backups: BackupService;
  let dataSource: DataSource;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        TypeOrmModule.forRoot(INTEGRATION_TYPEORM_OPTIONS),
        TypeOrmModule.forFeature([User]),
      ],
      providers: [
        BackupService,
        BackupExportService,
        BackupRestoreService,
        // The restore's bond price recompute is not under test here.
        {
          provide: BondPriceService,
          useValue: {
            recomputeSecurity: async () => ({}),
            recomputeLinkedSecurities: async () => undefined,
          },
        },
        // The restore's bond series recovery finds nothing to recover here.
        {
          provide: BackupBondSeriesRecoveryService,
          useValue: {
            recover: async (_userId: string, data: unknown) => ({
              data,
              unrecovered: [],
            }),
          },
        },
        BackupAttachmentTransferService,
        BackupRestoreDatabaseService,
        NetWorthService,
        OidcReauthService,
        JobClaimService,
        UserMaintenanceService,
        { provide: EncryptionService, useValue: { decrypt: () => "" } },
        ...attachmentStorageProviders(),
      ],
    }).compile();

    backups = module.get(BackupService);
    dataSource = module.get(DataSource);
    // The updated_at triggers the restore's timestamp preservation rides on,
    // and the one-parent CHECK the restored document must satisfy.
    await applyRlsPolicies(dataSource);
    await applyAttachmentParentMigration(dataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  it("carries the warranty, its claim and its document's bytes into another user", async () => {
    const source = await createTestUserDirect(dataSource, {
      firstName: "Source",
    });
    const target = await createTestUserDirect(dataSource, {
      firstName: "Target",
    });
    const q = (sql: string, params?: unknown[]) =>
      dataSource.query(sql, params);

    await q(
      `INSERT INTO currencies (code, name, symbol) VALUES ('USD', 'US Dollar', '$')
       ON CONFLICT DO NOTHING`,
    );
    const [account] = await q(
      `INSERT INTO accounts (user_id, name, account_type, currency_code,
                             current_balance, opening_balance)
       VALUES ($1, 'Chequing', 'CHEQUING', 'USD', 0, 0) RETURNING id`,
      [source.id],
    );
    const [payee] = await q(
      `INSERT INTO payees (user_id, name) VALUES ($1, 'Appliance World') RETURNING id`,
      [source.id],
    );
    const [txn] = await q(
      `INSERT INTO transactions (user_id, account_id, payee_id, amount,
                                 transaction_date, currency_code)
       VALUES ($1, $2, $3, -1299.99, '2026-10-01', 'USD') RETURNING id`,
      [source.id, account.id, payee.id],
    );
    const [warranty] = await q(
      `INSERT INTO warranties (user_id, name, purchase_date, expires_on,
                               transaction_id, payee_id, serial_numbers,
                               purchase_price, currency_code)
       VALUES ($1, 'Dishwasher', '2026-10-01', '2028-10-01', $2, $3,
               ARRAY['SN-1', 'SN-2'], 1299.99, 'USD') RETURNING id`,
      [source.id, txn.id, payee.id],
    );
    await q(
      `INSERT INTO warranty_claims (user_id, warranty_id, claim_date, status, description)
       VALUES ($1, $2, '2026-12-01', 'open', 'Leaks')`,
      [source.id, warranty.id],
    );
    // The database provider's storage key is the attachment's own id.
    const [document] = await q(
      `INSERT INTO transaction_attachments
         (user_id, warranty_id, document_kind, filename, content_type,
          byte_size, sha256, storage_provider, storage_key)
       VALUES ($1, $2, 'manual', 'manual.pdf', 'application/pdf', $3, $4,
               'database', 'pending')
       RETURNING id`,
      [
        source.id,
        warranty.id,
        BYTES.length,
        createHash("sha256").update(BYTES).digest("hex"),
      ],
    );
    await q(
      `UPDATE transaction_attachments SET storage_key = id::text WHERE id = $1`,
      [document.id],
    );
    await q(
      `INSERT INTO attachment_blobs (attachment_id, data) VALUES ($1, $2)`,
      [document.id, BYTES],
    );

    const { buffer, report } = await withUserContext(source.id, () =>
      backups.exportToBuffer(source.id),
    );
    expect(report).toMatchObject({
      complete: true,
      expectedAttachments: 1,
      includedAttachments: 1,
    });
    const parsed = JSON.parse(gunzipSync(buffer).toString("utf-8"));
    expect(parsed.warranties).toHaveLength(1);
    expect(parsed.warranty_claims).toHaveLength(1);
    expect(parsed.transaction_attachments).toEqual([
      expect.objectContaining({
        warranty_id: warranty.id,
        transaction_id: null,
        document_kind: "manual",
      }),
    ]);

    const result = await withUserContext(target.id, () =>
      backups.restoreData(target.id, {
        compressedData: buffer,
        password: PASSWORD,
      }),
    );
    expect(result.restored).toMatchObject({
      warranties: 1,
      warrantyClaims: 1,
      transactionAttachments: 1,
    });

    // Every reference lands on the target's own copy, never on the source's.
    const [restored] = await q(
      `SELECT w.id, w.name, w.serial_numbers, w.purchase_price::TEXT AS price,
              TO_CHAR(w.expires_on, 'YYYY-MM-DD') AS expires_on,
              t.user_id AS txn_user, p.user_id AS payee_user,
              t.amount::TEXT AS txn_amount
         FROM warranties w
         JOIN transactions t ON t.id = w.transaction_id
         JOIN payees p ON p.id = w.payee_id
        WHERE w.user_id = $1`,
      [target.id],
    );
    expect(restored).toMatchObject({
      name: "Dishwasher",
      serial_numbers: ["SN-1", "SN-2"],
      price: "1299.9900",
      expires_on: "2028-10-01",
      txn_user: target.id,
      payee_user: target.id,
      txn_amount: "-1299.9900",
    });
    expect(restored.id).not.toBe(warranty.id);

    const restoredClaims = await q(
      `SELECT warranty_id, status, description FROM warranty_claims WHERE user_id = $1`,
      [target.id],
    );
    expect(restoredClaims).toEqual([
      { warranty_id: restored.id, status: "open", description: "Leaks" },
    ]);

    const restoredDocuments = await q(
      `SELECT ta.transaction_id, ta.warranty_id, ta.document_kind, ta.filename,
              ab.data
         FROM transaction_attachments ta
         JOIN attachment_blobs ab ON ab.attachment_id = ta.id
        WHERE ta.user_id = $1`,
      [target.id],
    );
    expect(restoredDocuments).toEqual([
      {
        transaction_id: null,
        warranty_id: restored.id,
        document_kind: "manual",
        filename: "manual.pdf",
        data: BYTES,
      },
    ]);

    // The source's rows are where they were.
    const [sourceCounts] = await q(
      `SELECT (SELECT COUNT(*) FROM warranties WHERE user_id = $1) AS w,
              (SELECT COUNT(*) FROM transaction_attachments WHERE warranty_id = $2) AS a`,
      [source.id, warranty.id],
    );
    expect(sourceCounts).toEqual({ w: "1", a: "1" });
  });
});
