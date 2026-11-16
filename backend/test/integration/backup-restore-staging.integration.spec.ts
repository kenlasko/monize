import { Test, TestingModule } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { DataSource } from "typeorm";
import { createHash, randomUUID } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BackupService } from "@/backup/backup.service";
import { BackupExportService } from "@/backup/backup-export.service";
import { BackupRestoreService } from "@/backup/backup-restore.service";
import { BackupAttachmentTransferService } from "@/backup/backup-attachment-transfer.service";
import { BackupRestoreDatabaseService } from "@/backup/backup-restore-database.service";
import { BackupBondSeriesRecoveryService } from "@/backup/backup-bond-series-recovery.service";
import { BondPriceService } from "@/bonds/bond-price.service";
import { NetWorthService } from "@/net-worth/net-worth.service";
import { RateHistoryCatchUpService } from "@/currencies/rate-history-catch-up.service";
import { OidcReauthService } from "@/auth/oidc/oidc-reauth.service";
import { EncryptionService } from "../../src/common/encryption/encryption.service";
import { JobClaimService } from "@/common/jobs/job-claim.service";
import { UserMaintenanceService } from "@/common/jobs/user-maintenance.service";
import { User } from "@/users/entities/user.entity";
import { LocalStorageProvider } from "@/attachments/storage/local-storage.provider";
import { AttachmentStorageRegistry } from "@/attachments/storage/attachment-storage.registry";
import { AttachmentOrphanSweeper } from "@/attachments/attachment-orphan-sweeper.service";
import { withSystemContext, withUserContext } from "@/common/db/with-context";
import {
  attachmentStorageProviders,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";

/**
 * Restore staging writes external attachment objects BEFORE the commit, so the
 * objects outlive a process that dies in between (A26-S06-03). The create path
 * records an upload intent first, which gives the orphan sweeper a row to find;
 * the restore must do the same.
 *
 * Runs on the `local` provider over a real temporary directory, because the
 * `database` provider takes no intent at all (its bytes roll back with the
 * transaction) and a mocked store cannot show what is durable.
 *
 * A process death is modelled by making a step inside the restore transaction
 * throw and by suppressing the discard that the failure handler would run.
 */
describe("Backup restore staging of external attachment objects (integration)", () => {
  let module: TestingModule;
  let service: BackupService;
  let dataSource: DataSource;
  let local: LocalStorageProvider;
  let sweeper: AttachmentOrphanSweeper;
  let baseDir: string;
  const previousDir = process.env.ATTACHMENT_CONTAINER_DIR;

  const PASSWORD = "TestPassword123!";

  beforeAll(async () => {
    baseDir = mkdtempSync(join(tmpdir(), "monize-restore-staging-"));
    process.env.ATTACHMENT_CONTAINER_DIR = baseDir;
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
        BackupExportService,
        BackupRestoreService,
        BackupAttachmentTransferService,
        BackupRestoreDatabaseService,
        // Not the subject: a file with no bond catalog needs no recovery, and the
        // restore only asks the price service about linked securities.
        {
          provide: BackupBondSeriesRecoveryService,
          useValue: {
            recover: async (_userId: string, data: unknown) => ({
              data,
              unrecovered: [],
            }),
          },
        },
        {
          provide: BondPriceService,
          useValue: { recomputeLinkedSecurities: async () => undefined },
        },
        // Not the subject: the post-restore rate history fill reaches the FX
        // provider (rate-history-catch-up.service.ts).
        {
          provide: RateHistoryCatchUpService,
          useValue: { start: () => undefined },
        },
        {
          provide: NetWorthService,
          useValue: { recalculateAccount: async () => undefined },
        },
        { provide: OidcReauthService, useValue: { consume: async () => {} } },
        // Real: the restore takes a maintenance lease on the real `job_claims`.
        JobClaimService,
        UserMaintenanceService,
        { provide: EncryptionService, useValue: { decrypt: () => "" } },
        // The real local provider over the temporary directory above.
        ...attachmentStorageProviders({ provider: LocalStorageProvider }),
      ],
    }).compile();

    service = module.get(BackupService);
    dataSource = module.get(DataSource);
    local = module.get(LocalStorageProvider);
    sweeper = new AttachmentOrphanSweeper(
      dataSource,
      module.get(AttachmentStorageRegistry),
    );
    await applyRlsPolicies(dataSource);
  });

  afterAll(async () => {
    await module.close();
    if (previousDir === undefined) delete process.env.ATTACHMENT_CONTAINER_DIR;
    else process.env.ATTACHMENT_CONTAINER_DIR = previousDir;
    rmSync(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await dataSource.query(`
      TRUNCATE attachment_blob_tombstones, transaction_attachments,
        transactions, accounts, user_preferences, currencies, users CASCADE
    `);
  });

  /** A user with one account, one transaction and `count` local attachments. */
  async function seedLocalAttachments(
    userId: string,
    count: number,
  ): Promise<string[]> {
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, created_by_user_id)
       VALUES ('USD', 'US Dollar', '$', $1)`,
      [userId],
    );
    const accountId = randomUUID();
    await dataSource.query(
      `INSERT INTO accounts (id, user_id, account_type, name, currency_code,
                             current_balance, opening_balance)
       VALUES ($1, $2, 'CHEQUING', 'Checking', 'USD', 0, 0)`,
      [accountId, userId],
    );
    const transactionId = randomUUID();
    await dataSource.query(
      `INSERT INTO transactions (id, user_id, account_id, transaction_date,
                                 amount, currency_code)
       VALUES ($1, $2, $3, '2026-01-15', -5, 'USD')`,
      [transactionId, userId, accountId],
    );
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = randomUUID();
      const bytes = Buffer.from(`receipt number ${i}`);
      await local.save(id, bytes);
      await dataSource.query(
        `INSERT INTO transaction_attachments
           (id, user_id, transaction_id, filename, content_type, byte_size,
            sha256, storage_provider, storage_key)
         VALUES ($1, $2, $3, $4, 'text/plain', $5, $6, 'local', $7)`,
        [
          id,
          userId,
          transactionId,
          `receipt-${i}.txt`,
          bytes.length,
          createHash("sha256").update(bytes).digest("hex"),
          id,
        ],
      );
      ids.push(id);
    }
    return ids;
  }

  const tombstones = async (): Promise<
    Array<{ storage_key: string; swept_at: Date | null }>
  > =>
    dataSource.query(
      `SELECT storage_key, swept_at FROM attachment_blob_tombstones
        WHERE storage_provider = 'local' ORDER BY storage_key`,
    );

  const hasBytes = (key: string): Promise<boolean> =>
    local.load(key).then(
      () => true,
      () => false,
    );

  /** The keys the restore staged for `userId`: its attachment rows' keys. */
  const stagedKeysOf = async (userId: string): Promise<string[]> =>
    (
      await dataSource.query(
        `SELECT storage_key FROM transaction_attachments WHERE user_id = $1`,
        [userId],
      )
    ).map((r: { storage_key: string }) => r.storage_key);

  it("leaves a sweepable intent for every staged object when the process dies before the commit", async () => {
    const userA = await createTestUserDirect(dataSource, {
      email: "stage-a@example.com",
    });
    const userB = await createTestUserDirect(dataSource, {
      email: "stage-b@example.com",
    });
    await seedLocalAttachments(userA.id, 2);
    const { buffer } = await withUserContext(userA.id, () =>
      service.exportToBuffer(userA.id),
    );

    // The step that fails runs inside the restore transaction, after staging.
    jest
      .spyOn(BackupRestoreDatabaseService.prototype, "restoreDeferredFkColumns")
      .mockRejectedValue(new Error("injected failure inside the transaction"));
    // Process death: the failure handler's discard never runs.
    const discard = jest
      .spyOn(
        BackupAttachmentTransferService.prototype,
        "discardStagedAttachmentObjects",
      )
      .mockResolvedValue(undefined);

    const before = (await tombstones()).length;
    await expect(
      withUserContext(userB.id, () =>
        service.restoreData(userB.id, {
          compressedData: buffer,
          password: PASSWORD,
        }),
      ),
    ).rejects.toThrow("injected failure");
    expect(discard).toHaveBeenCalledTimes(1);
    const staged: string[] = discard.mock.calls[0][0];
    expect(staged).toHaveLength(2);

    // The bytes are on disk and no metadata row names them...
    for (const key of staged) expect(await hasBytes(key)).toBe(true);
    expect(await stagedKeysOf(userB.id)).toEqual([]);
    // ...so only an intent can lead the sweeper to them.
    const after = await tombstones();
    expect(after.length).toBe(before + staged.length);
    expect(after.map((t) => t.storage_key).sort()).toEqual([...staged].sort());

    // Leases are still live, so a sweep leaves a restore in progress alone.
    expect(await withSystemContext(() => sweeper.sweep(local))).toBe(0);
    for (const key of staged) expect(await hasBytes(key)).toBe(true);

    // Once the leases have expired, one sweep pass removes the objects.
    await dataSource.query(
      `UPDATE attachment_blob_tombstones
          SET upload_lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
        WHERE storage_provider = 'local' AND storage_key = ANY($1::text[])`,
      [staged],
    );
    await withSystemContext(() => sweeper.sweep(local));
    for (const key of staged) expect(await hasBytes(key)).toBe(false);
  });

  it("keeps the intent when the discard cannot delete, so the sweeper still finds the bytes", async () => {
    const userA = await createTestUserDirect(dataSource, {
      email: "discard-a@example.com",
    });
    const userB = await createTestUserDirect(dataSource, {
      email: "discard-b@example.com",
    });
    await seedLocalAttachments(userA.id, 1);
    const { buffer } = await withUserContext(userA.id, () =>
      service.exportToBuffer(userA.id),
    );
    jest
      .spyOn(BackupRestoreDatabaseService.prototype, "restoreDeferredFkColumns")
      .mockRejectedValue(new Error("injected failure inside the transaction"));
    const deleteSpy = jest
      .spyOn(local, "delete")
      .mockRejectedValue(new Error("object store unavailable"));

    await expect(
      withUserContext(userB.id, () =>
        service.restoreData(userB.id, {
          compressedData: buffer,
          password: PASSWORD,
        }),
      ),
    ).rejects.toThrow("injected failure");
    expect(deleteSpy).toHaveBeenCalled();
    expect(await tombstones()).toHaveLength(1);
  });

  it("drops the intent together with the bytes when the discard succeeds", async () => {
    const userA = await createTestUserDirect(dataSource, {
      email: "clean-a@example.com",
    });
    const userB = await createTestUserDirect(dataSource, {
      email: "clean-b@example.com",
    });
    await seedLocalAttachments(userA.id, 2);
    const { buffer } = await withUserContext(userA.id, () =>
      service.exportToBuffer(userA.id),
    );
    jest
      .spyOn(BackupRestoreDatabaseService.prototype, "restoreDeferredFkColumns")
      .mockRejectedValue(new Error("injected failure inside the transaction"));
    const stage = jest.spyOn(
      BackupAttachmentTransferService.prototype,
      "discardStagedAttachmentObjects",
    );

    await expect(
      withUserContext(userB.id, () =>
        service.restoreData(userB.id, {
          compressedData: buffer,
          password: PASSWORD,
        }),
      ),
    ).rejects.toThrow("injected failure");
    const staged: string[] = stage.mock.calls[0][0];
    for (const key of staged) expect(await hasBytes(key)).toBe(false);
    expect(await tombstones()).toEqual([]);
  });

  it("leaves no intent behind for the staged keys of a restore that commits", async () => {
    const userA = await createTestUserDirect(dataSource, {
      email: "ok-a@example.com",
    });
    const userB = await createTestUserDirect(dataSource, {
      email: "ok-b@example.com",
    });
    await seedLocalAttachments(userA.id, 2);
    const { buffer } = await withUserContext(userA.id, () =>
      service.exportToBuffer(userA.id),
    );

    await withUserContext(userB.id, () =>
      service.restoreData(userB.id, {
        compressedData: buffer,
        password: PASSWORD,
      }),
    );

    const keys = await stagedKeysOf(userB.id);
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(await hasBytes(key)).toBe(true);
    expect(await tombstones()).toEqual([]);
  });
});
