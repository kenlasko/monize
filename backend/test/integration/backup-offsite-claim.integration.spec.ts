import { Test, TestingModule } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { createHash } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { AutoBackupService } from "@/backup/auto-backup.service";
import {
  BackupOffsiteDispatchService,
  MAX_OFFSITE_ATTEMPTS,
} from "@/backup/offsite/backup-offsite-dispatch.service";
import { offsiteObjectKey } from "@/backup/offsite/backup-offsite-keys";
import { BackupOffsiteEmailSender } from "@/backup/offsite/backup-offsite-email.sender";
import { BackupOffsiteRetryService } from "@/backup/offsite/backup-offsite-retry.service";
import { BackupOffsiteS3Uploader } from "@/backup/offsite/backup-offsite-s3.uploader";
import { BackupOffsiteSettingsService } from "@/backup/offsite/backup-offsite-settings.service";
import { OffsiteS3Target } from "@/backup/offsite/backup-offsite.types";
import { SystemAlertService } from "@/system-alerts/system-alert.service";
import { withUserContext } from "@/common/db/with-context";

import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";

/**
 * The off-site claim against a real database, because every property here is a
 * property of PostgreSQL rather than of the service.
 *
 * Every replica fires the backup cron and the retry sweep, so two of them reach
 * the same (user, destination, key) at the same moment. What makes exactly one
 * of them upload is the unique key arbitrating the insert and the conditional
 * `UPDATE ... WHERE status IN ('pending','failed') RETURNING` re-evaluating its
 * predicate under the row lock -- and a mocked `query` can express that and
 * prove none of it: the loser's statement has to actually block on the winner
 * and then come back empty (`docs/verification-contract.md`).
 *
 * The same argument covers the reaper's backoff: `INTERVAL '1 hour' * power(2,
 * attempts - 1)` is arithmetic the database does, so the rows it selects are
 * asserted here rather than in the unit spec, which can only assert the string.
 *
 * The destination itself is a double. What leaves the machine is
 * `BackupOffsiteS3Uploader`'s subject and is covered against a local fake S3
 * endpoint in its own spec; what is claimed before anything leaves is this
 * suite's.
 */
describe("off-site upload claim (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let dispatch: BackupOffsiteDispatchService;
  let userId: string;
  let folder: string;
  let bytes: Buffer;
  let digest: string;

  const FILENAME = "monize-backup-daily-2026-09-14.mzbe";

  /** Calls the doubled uploader has seen, so "uploaded once" is checkable. */
  let uploads: string[];
  let uploadOutcome: "uploaded" | "already-present";

  const target = (): OffsiteS3Target => ({
    bucket: "monize-offsite-test",
    region: "us-east-1",
    forcePathStyle: false,
    deadlineMs: 300000,
    multipartPartBytes: 16 * 1024 * 1024,
  });

  const objectKey = (): string => offsiteObjectKey(userId, FILENAME, digest);

  const claimInput = () => ({
    userId,
    destination: "s3" as const,
    objectKey: objectKey(),
    tier: "daily" as const,
    digest,
    sizeBytes: bytes.length,
    folder,
    filename: FILENAME,
    origin: "automatic" as const,
  });

  /** The one row this suite writes, read back through the owner's own scope. */
  const storedRow = async (): Promise<{
    status: string;
    attempts: number;
    last_error: string | null;
  } | null> => {
    const rows = await dataSource.query(
      `SELECT status, attempts, last_error
         FROM backup_offsite_uploads
        WHERE user_id = $1 AND destination = 's3' AND object_key = $2`,
      [userId, objectKey()],
    );
    return rows[0] ?? null;
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        TypeOrmModule.forRoot(INTEGRATION_TYPEORM_OPTIONS),
      ],
      providers: [
        BackupOffsiteDispatchService,
        {
          provide: BackupOffsiteSettingsService,
          useValue: {
            resolveS3Target: async () => ({ target: target() }),
            resolveEmail: async () => null,
            emailMaxBytes: () => 20 * 1024 * 1024,
          },
        },
        {
          provide: BackupOffsiteS3Uploader,
          useValue: {
            upload: async (
              _target: OffsiteS3Target,
              key: string,
            ): Promise<{ outcome: string; objectKey: string }> => {
              uploads.push(key);
              // A real put is not instantaneous, and the race this suite is
              // about is decided while one of the two callers is inside it.
              await new Promise((done) => setTimeout(done, 25));
              return { outcome: uploadOutcome, objectKey: key };
            },
          },
        },
        {
          provide: BackupOffsiteEmailSender,
          useValue: { send: async () => ({ outcome: "uploaded" }) },
        },
        {
          provide: SystemAlertService,
          useValue: {
            raiseAdminAlert: async () => ({ created: 0, emailed: 0 }),
          },
        },
      ],
    }).compile();

    dataSource = module.get(DataSource);
    dispatch = module.get(BackupOffsiteDispatchService);
    userId = (await createTestUserDirect(dataSource)).id;
  });

  afterAll(async () => {
    await module?.close();
    rmSync(folder, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cleanTables(dataSource, ["backup_offsite_uploads"]);
    folder = mkdtempSync(join(tmpdir(), "monize-offsite-int-"));
    bytes = Buffer.from("encrypted-monize-envelope-bytes");
    digest = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(folder, FILENAME), bytes);
    uploads = [];
    uploadOutcome = "uploaded";
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  describe("two replicas, one row", () => {
    it("has exactly one winner", async () => {
      const results = await Promise.all([
        withUserContext(userId, () => dispatch.claimAndPerform(claimInput())),
        withUserContext(userId, () => dispatch.claimAndPerform(claimInput())),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      // And the loser did not upload: the claim is what gates the effect, not
      // a check the effect happens to repeat.
      expect(uploads).toEqual([objectKey()]);
      expect(await storedRow()).toMatchObject({
        status: "uploaded",
        attempts: 1,
      });
    });

    it("has exactly one winner across four concurrent attempts", async () => {
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          withUserContext(userId, () => dispatch.claimAndPerform(claimInput())),
        ),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(uploads).toHaveLength(1);
    });
  });

  describe("a row that is already terminal", () => {
    it("is not claimed again once it is uploaded", async () => {
      await withUserContext(userId, () =>
        dispatch.claimAndPerform(claimInput()),
      );
      expect(uploads).toHaveLength(1);

      const claimed = await withUserContext(userId, () =>
        dispatch.claimAndPerform(claimInput()),
      );

      expect(claimed).toBe(false);
      // Nothing was sent a second time, and the row still describes the first
      // attempt rather than a second that never happened.
      expect(uploads).toHaveLength(1);
      expect(await storedRow()).toMatchObject({
        status: "uploaded",
        attempts: 1,
      });
    });

    it("is claimed again once it is failed", async () => {
      await dataSource.query(
        `INSERT INTO backup_offsite_uploads
           (user_id, destination, object_key, tier, digest, size_bytes, status, attempts, last_error)
         VALUES ($1, 's3', $2, 'daily', $3, $4, 'failed', 1, 'connect ETIMEDOUT')`,
        [userId, objectKey(), digest, bytes.length],
      );

      const claimed = await withUserContext(userId, () =>
        dispatch.claimAndPerform(claimInput()),
      );

      expect(claimed).toBe(true);
      expect(await storedRow()).toMatchObject({
        status: "uploaded",
        // The claim increments rather than resets: the attempt ceiling is what
        // stops a permanently broken destination being called forever.
        attempts: 2,
      });
    });
  });

  describe("the retry sweep's own selection", () => {
    let retry: BackupOffsiteRetryService;
    let claimAndPerform: jest.Mock;

    /** A failed row of this user's, aged by hand. */
    const failedRow = async (
      key: string,
      attempts: number,
      hoursAgo: number,
    ): Promise<void> => {
      await dataSource.query(
        `INSERT INTO backup_offsite_uploads
           (user_id, destination, object_key, tier, digest, size_bytes, status, attempts, updated_at)
         VALUES ($1, 's3', $2, 'daily', $3, 10, 'failed', $4, now() - ($5 || ' hours')::interval)`,
        [userId, key, digest, attempts, String(hoursAgo)],
      );
    };

    beforeEach(() => {
      claimAndPerform = jest.fn().mockResolvedValue(true);
      retry = new BackupOffsiteRetryService(
        dataSource,
        { claimAndPerform } as unknown as BackupOffsiteDispatchService,
        {
          resolveStoredBackupFolder: async () => folder,
        } as unknown as AutoBackupService,
      );
    });

    const sweptKeys = (): string[] =>
      claimAndPerform.mock.calls.map((call) => call[0].objectKey);

    it("doubles the wait with each attempt", async () => {
      // Due: one attempt an hour ago, two attempts three hours ago (needs two).
      await failedRow("due/one-attempt.mzbe", 1, 2);
      await failedRow("due/two-attempts.mzbe", 2, 3);
      // Not due: two attempts one hour ago (needs two), four attempts four
      // hours ago (needs eight).
      await failedRow("early/two-attempts.mzbe", 2, 1);
      await failedRow("early/four-attempts.mzbe", 4, 4);

      await retry.handleRetrySweep();

      expect(sweptKeys().sort()).toEqual([
        "due/one-attempt.mzbe",
        "due/two-attempts.mzbe",
      ]);
    });

    it("stops re-attempting a copy at the ceiling", async () => {
      await failedRow("exhausted.mzbe", MAX_OFFSITE_ATTEMPTS, 72);
      await failedRow("still-due.mzbe", 1, 48);

      await retry.handleRetrySweep();

      expect(sweptKeys()).toEqual(["still-due.mzbe"]);
    });

    it("leaves every non-failed status alone", async () => {
      for (const status of [
        "pending",
        "uploading",
        "uploaded",
        "conflict",
        "skipped-unencrypted",
        "skipped-too-large",
      ]) {
        await dataSource.query(
          `INSERT INTO backup_offsite_uploads
             (user_id, destination, object_key, tier, digest, size_bytes, status, attempts, updated_at)
           VALUES ($1, 's3', $2, 'daily', $3, 10, $4, 1, now() - INTERVAL '48 hours')`,
          [userId, `${status}.mzbe`, digest, status],
        );
      }

      await retry.handleRetrySweep();

      // `uploading` included: a row another replica is holding is not the
      // selection's to take. A claim that is never finished is reclaimed by the
      // lease instead -- a separate statement, on `claimed_at`, which none of
      // these rows carries.
      expect(claimAndPerform).not.toHaveBeenCalled();
    });
  });
});
