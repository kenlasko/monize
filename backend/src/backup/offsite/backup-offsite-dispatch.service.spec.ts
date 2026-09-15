import { createHash } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import { SystemAlertService } from "../../system-alerts/system-alert.service";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { User } from "../../users/entities/user.entity";
import { BackupOffsiteEmailSender } from "./backup-offsite-email.sender";
import {
  BackupOffsiteDispatchInput,
  BackupOffsiteDispatchService,
  MAX_OFFSITE_ATTEMPTS,
} from "./backup-offsite-dispatch.service";
import { offsiteObjectKey } from "./backup-offsite-keys";
import { BackupOffsiteS3Uploader } from "./backup-offsite-s3.uploader";
import { BackupOffsiteSettingsService } from "./backup-offsite-settings.service";
import {
  BackupOffsiteDestination,
  BackupOffsiteUploadStatus,
} from "./entities/backup-offsite-upload.entity";
import { OffsiteS3Target } from "./backup-offsite.types";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

/**
 * The off-machine copy of a completed artifact: what is attempted, what is
 * refused, and what each outcome leaves behind
 * (`docs/specs/backup-off-machine.md` sections 5 and 7).
 *
 * Two things are real here rather than mocked, because the properties under test
 * are properties of them.
 *
 * **The artifact is a real file with a real digest.** The rules are "never
 * upload what was not measured" and "never upload a plaintext artifact"; a
 * mocked `readFile` would record that the code read something, which was never
 * the question. The bytes are written to a temporary directory and the digest is
 * computed the same way `exportToFile` computes it.
 *
 * **The ledger is a small stateful double of the table**, not a `query` that
 * resolves. The claim is a conditional `UPDATE` whose whole purpose is to answer
 * differently the second time, so a double that always returned a row would make
 * the "another replica holds it" branch untestable, tested and dead --
 * `docs/backend/testing.md`.
 */

const USER_ID = "22222222-2222-4222-8222-222222222222";
const MIB = 1024 * 1024;
const FILENAME = "monize-backup-daily-2026-09-14.mzbe";
const PLAINTEXT_FILENAME = "monize-backup-daily-2026-09-14.json.gz";

/** One row of the stateful ledger double. */
interface LedgerRow {
  id: string;
  destination: BackupOffsiteDestination;
  objectKey: string;
  digest: string;
  status: BackupOffsiteUploadStatus;
  attempts: number;
  lastError: string | null;
}

const rowKey = (destination: string, objectKey: string): string =>
  `${destination}::${objectKey}`;

/**
 * Teach `manager.query` to behave like `backup_offsite_uploads`: an insert that
 * loses to the unique key writes nothing, a claim takes the row only from a
 * claimable status, and an outcome lands only on the attempt that holds it.
 *
 * The result shapes are the driver's own (`common/db/query-result.ts`): bare
 * rows for `INSERT`, the `[rows, rowCount]` tuple for `UPDATE`.
 */
function installLedger(
  query: jest.Mock,
  seed: LedgerRow[] = [],
): Map<string, LedgerRow> {
  const rows = new Map<string, LedgerRow>(
    seed.map((row) => [rowKey(row.destination, row.objectKey), row]),
  );
  let nextId = seed.length;
  query.mockImplementation(async (sql: unknown, params: unknown[] = []) => {
    const text = String(sql);
    if (/^\s*INSERT INTO backup_offsite_uploads/.test(text)) {
      const [, destination, objectKey, , digest, , status, lastError] =
        params as string[];
      const key = rowKey(destination, objectKey);
      if (rows.has(key)) return [];
      const id = `row-${++nextId}`;
      rows.set(key, {
        id,
        destination: destination as BackupOffsiteDestination,
        objectKey,
        digest,
        status: (status ?? "pending") as BackupOffsiteUploadStatus,
        attempts: 0,
        lastError: lastError ?? null,
      });
      return [{ id }];
    }
    if (/SET\s+status = 'uploading'/.test(text)) {
      const [, destination, objectKey] = params as string[];
      const row = rows.get(rowKey(destination, objectKey));
      if (!row || (row.status !== "pending" && row.status !== "failed")) {
        return [[], 0];
      }
      row.status = "uploading";
      row.attempts += 1;
      return [[{ id: row.id, digest: row.digest, attempts: row.attempts }], 1];
    }
    if (/SET\s+status = \$1/.test(text)) {
      const [status, lastError, attempts, id] = params as [
        BackupOffsiteUploadStatus,
        string | null,
        number,
        string,
      ];
      const row = [...rows.values()].find(
        (candidate) => candidate.id === id && candidate.status === "uploading",
      );
      if (!row) return [[], 0];
      row.status = status;
      row.lastError = lastError;
      row.attempts = attempts;
      return [[{ id }], 1];
    }
    throw new Error(`unexpected statement in this suite: ${text}`);
  });
  return rows;
}

const s3Target = (): OffsiteS3Target => ({
  bucket: "monize-offsite",
  region: "us-east-1",
  forcePathStyle: false,
  deadlineMs: 300000,
  multipartPartBytes: 16 * MIB,
});

describe("BackupOffsiteDispatchService", () => {
  let folder: string;
  let bytes: Buffer;
  let digest: string;
  let service: BackupOffsiteDispatchService;
  let ledger: Map<string, LedgerRow>;
  let upload: jest.MockedFunction<BackupOffsiteS3Uploader["upload"]>;
  let send: jest.MockedFunction<BackupOffsiteEmailSender["send"]>;
  let resolveS3Target: jest.MockedFunction<
    BackupOffsiteSettingsService["resolveS3Target"]
  >;
  let resolveEmail: jest.MockedFunction<
    BackupOffsiteSettingsService["resolveEmail"]
  >;
  let raiseAdminAlert: jest.MockedFunction<
    SystemAlertService["raiseAdminAlert"]
  >;
  let usersRepo: Record<string, jest.Mock>;

  const build = (seed: LedgerRow[] = []): void => {
    usersRepo = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: USER_ID, email: "owner@example.com" }),
    };
    const scoped = createScopedDbMocks([
      [
        UserPreference,
        {
          findOne: jest
            .fn()
            .mockResolvedValue({ userId: USER_ID, language: "pl" }),
        },
      ],
      [User, usersRepo],
    ]);
    ledger = installLedger(scoped.manager.query, seed);

    upload = jest.fn() as never;
    send = jest.fn() as never;
    resolveS3Target = jest
      .fn()
      .mockResolvedValue({ target: null, reason: "off" }) as never;
    resolveEmail = jest.fn().mockResolvedValue(null) as never;
    raiseAdminAlert = jest
      .fn()
      .mockResolvedValue({ created: 1, emailed: 0 }) as never;

    service = new BackupOffsiteDispatchService(
      scoped.dataSource as never,
      {
        resolveS3Target,
        resolveEmail,
        emailMaxBytes: () => 20 * MIB,
      } as never,
      { upload } as never,
      { send } as never,
      { raiseAdminAlert } as never,
    );
  };

  const withS3 = (): void => {
    resolveS3Target.mockResolvedValue({ target: s3Target() });
  };
  const withEmail = (): void => {
    resolveEmail.mockResolvedValue({ to: "owner@example.com" });
  };

  const input = (
    overrides: Partial<BackupOffsiteDispatchInput> = {},
  ): BackupOffsiteDispatchInput => ({
    userId: USER_ID,
    folder,
    filename: FILENAME,
    tier: "daily",
    digest,
    sizeBytes: bytes.length,
    origin: "automatic",
    ...overrides,
  });

  const row = (destination: BackupOffsiteDestination): LedgerRow | undefined =>
    [...ledger.values()].find((r) => r.destination === destination);

  const key = (): string => offsiteObjectKey(USER_ID, FILENAME, digest);

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "monize-offsite-spec-"));
    bytes = Buffer.from("encrypted-monize-envelope-bytes");
    digest = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(folder, FILENAME), bytes);
    build();
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  describe("a plaintext artifact (INV-BACKUP-002)", () => {
    beforeEach(() => {
      withS3();
      withEmail();
      writeFileSync(join(folder, PLAINTEXT_FILENAME), bytes);
    });

    it("is never handed to a destination, and says so on each of them", async () => {
      await service.dispatchAfterBackup(
        input({ filename: PLAINTEXT_FILENAME }),
      );

      expect(upload).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(row("s3")?.status).toBe("skipped-unencrypted");
      expect(row("email")?.status).toBe("skipped-unencrypted");
      expect(row("s3")?.lastError).toContain("not encrypted");
    });

    it("raises exactly one admin alert naming the user and the reason", async () => {
      await service.dispatchAfterBackup(
        input({ filename: PLAINTEXT_FILENAME }),
      );

      expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
      const alert = raiseAdminAlert.mock.calls[0][0];
      expect(alert.title).toBe("Automatic backup incomplete");
      expect(alert.message).toContain("owner@example.com");
      expect(alert.message).toContain("unencrypted");
      expect(alert.data).toMatchObject({
        system: true,
        affectedUserId: USER_ID,
        affectedUserEmail: "owner@example.com",
        reason: "offsite",
        filename: PLAINTEXT_FILENAME,
      });
      expect(alert.dedupeKey).toMatch(
        new RegExp(`^BACKUP_PARTIAL:${USER_ID}:offsite:\\d{4}-\\d{2}-\\d{2}$`),
      );
      expect(alert.emailDedupeKey).toMatch(
        /^BACKUP_PARTIAL:offsite:\d{4}-\d{2}-\d{2}$/,
      );
    });

    it("says nothing to the administrators about a manual run", async () => {
      await service.dispatchAfterBackup(
        input({ filename: PLAINTEXT_FILENAME, origin: "manual" }),
      );

      // The rows are still written -- they are the durable state -- but an alert
      // titled "Automatic backup incomplete" about a run somebody pressed a
      // button for would take that day's dedupe key from the real one.
      expect(row("s3")?.status).toBe("skipped-unencrypted");
      expect(raiseAdminAlert).not.toHaveBeenCalled();
    });
  });

  describe("the S3 destination", () => {
    beforeEach(() => withS3());

    it("claims, uploads the measured bytes, and records uploaded", async () => {
      upload.mockResolvedValue({ outcome: "uploaded", objectKey: key() });

      await service.dispatchAfterBackup(input());

      expect(upload).toHaveBeenCalledWith(s3Target(), key(), bytes, digest);
      expect(row("s3")).toMatchObject({ status: "uploaded", attempts: 1 });
      expect(raiseAdminAlert).not.toHaveBeenCalled();
    });

    it("treats an already-present key with the recorded digest as done", async () => {
      upload.mockResolvedValue({
        outcome: "already-present",
        objectKey: key(),
      });

      await service.dispatchAfterBackup(input());

      expect(row("s3")?.status).toBe("uploaded");
      expect(raiseAdminAlert).not.toHaveBeenCalled();
    });

    it("records a conflict, and never overwrites, when the key holds other bytes", async () => {
      // A row already claiming this key with a different digest: whatever is
      // under it is not this artifact, and an append-only destination cannot be
      // corrected afterwards.
      build([
        {
          id: "row-1",
          destination: "s3",
          objectKey: key(),
          digest: "a".repeat(64),
          status: "failed",
          attempts: 1,
          lastError: "timeout",
        },
      ]);
      withS3();
      upload.mockResolvedValue({
        outcome: "already-present",
        objectKey: key(),
      });

      await service.dispatchAfterBackup(input());

      expect(row("s3")?.status).toBe("conflict");
      expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
      expect(raiseAdminAlert.mock.calls[0][0].data).toMatchObject({
        status: "conflict",
        destination: "s3",
      });
    });

    it("records failed without alerting when the destination throws", async () => {
      upload.mockRejectedValue(new Error("connect ETIMEDOUT"));

      await expect(
        service.dispatchAfterBackup(input()),
      ).resolves.toBeUndefined();

      expect(row("s3")).toMatchObject({ status: "failed", attempts: 1 });
      expect(row("s3")?.lastError).toContain("ETIMEDOUT");
      // The reaper retries it; an alert per transient failure would train the
      // administrators to ignore the one that matters.
      expect(raiseAdminAlert).not.toHaveBeenCalled();
    });

    it("alerts once the attempt ceiling is reached", async () => {
      build([
        {
          id: "row-1",
          destination: "s3",
          objectKey: key(),
          digest,
          status: "failed",
          attempts: MAX_OFFSITE_ATTEMPTS - 1,
          lastError: "timeout",
        },
      ]);
      withS3();
      upload.mockRejectedValue(new Error("connect ETIMEDOUT"));

      await service.dispatchAfterBackup(input());

      expect(row("s3")).toMatchObject({
        status: "failed",
        attempts: MAX_OFFSITE_ATTEMPTS,
      });
      expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
      expect(raiseAdminAlert.mock.calls[0][0].message).toContain(
        "No further attempts",
      );
    });

    it("records the resolution failure and alerts when credentials will not decrypt", async () => {
      resolveS3Target.mockResolvedValue({
        target: null,
        reason: "credentials-unreadable",
      });

      await service.dispatchAfterBackup(input());

      expect(upload).not.toHaveBeenCalled();
      expect(row("s3")?.status).toBe("failed");
      expect(row("s3")?.lastError).toContain("credentials-unreadable");
      expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    });

    it("does nothing at all for a user with no destination", async () => {
      resolveS3Target.mockResolvedValue({ target: null, reason: "off" });

      await service.dispatchAfterBackup(input());

      expect(ledger.size).toBe(0);
      expect(upload).not.toHaveBeenCalled();
      expect(raiseAdminAlert).not.toHaveBeenCalled();
    });

    it("does not upload an artifact whose bytes changed under it", async () => {
      writeFileSync(join(folder, FILENAME), Buffer.from("different bytes"));

      await service.dispatchAfterBackup(input());

      expect(upload).not.toHaveBeenCalled();
      expect(row("s3")?.status).toBe("failed");
      expect(row("s3")?.lastError).toContain("artifact changed on disk");
    });

    it("writes the copy off when the artifact is gone from disk", async () => {
      rmSync(join(folder, FILENAME));

      await service.dispatchAfterBackup(input());

      expect(upload).not.toHaveBeenCalled();
      expect(row("s3")).toMatchObject({
        status: "failed",
        // The ceiling, written by the give-up path: the bytes cannot come back,
        // so re-attempting them hourly for four more hours reports nothing new.
        attempts: MAX_OFFSITE_ATTEMPTS,
      });
      expect(row("s3")?.lastError).toContain("no longer on disk");
      expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    });

    it("skips a copy another replica already holds", async () => {
      build([
        {
          id: "row-1",
          destination: "s3",
          objectKey: key(),
          digest,
          status: "uploading",
          attempts: 1,
          lastError: null,
        },
      ]);
      withS3();

      await service.dispatchAfterBackup(input());

      expect(upload).not.toHaveBeenCalled();
      expect(row("s3")).toMatchObject({ status: "uploading", attempts: 1 });
    });

    it("skips a copy that is already off-machine", async () => {
      build([
        {
          id: "row-1",
          destination: "s3",
          objectKey: key(),
          digest,
          status: "uploaded",
          attempts: 1,
          lastError: null,
        },
      ]);
      withS3();

      await service.dispatchAfterBackup(input());

      expect(upload).not.toHaveBeenCalled();
      expect(row("s3")?.attempts).toBe(1);
    });
  });

  describe("the email destination", () => {
    beforeEach(() => withEmail());

    it("sends the measured bytes in the recipient's own language", async () => {
      send.mockResolvedValue({ outcome: "uploaded" });

      await service.dispatchAfterBackup(input());

      expect(send).toHaveBeenCalledWith({
        to: "owner@example.com",
        recipientLang: "pl",
        filename: FILENAME,
        body: bytes,
        sizeBytes: bytes.length,
        digest,
        tier: "daily",
        maxBytes: 20 * MIB,
      });
      expect(row("email")).toMatchObject({
        status: "uploaded",
        objectKey: FILENAME,
      });
    });

    it("records skipped-too-large when the sender sent a notice instead", async () => {
      send.mockResolvedValue({ outcome: "skipped-too-large" });

      await service.dispatchAfterBackup(input());

      expect(row("email")?.status).toBe("skipped-too-large");
      expect(row("email")?.lastError).toContain("email bound");
      // Not a failure: the notice was delivered, and the reaper has nothing to
      // re-attempt because the artifact will not get smaller.
      expect(raiseAdminAlert).not.toHaveBeenCalled();
    });

    it("records failed when the relay refuses the message", async () => {
      send.mockRejectedValue(new Error("SMTP 451 temporary failure"));

      await expect(
        service.dispatchAfterBackup(input()),
      ).resolves.toBeUndefined();

      expect(row("email")).toMatchObject({ status: "failed", attempts: 1 });
      expect(row("email")?.lastError).toContain("SMTP 451");
    });
  });

  describe("both destinations at once (3-2-1)", () => {
    beforeEach(() => {
      withS3();
      withEmail();
    });

    it("writes one row per destination", async () => {
      upload.mockResolvedValue({ outcome: "uploaded", objectKey: key() });
      send.mockResolvedValue({ outcome: "uploaded" });

      await service.dispatchAfterBackup(input());

      expect(ledger.size).toBe(2);
      expect(row("s3")?.status).toBe("uploaded");
      expect(row("email")?.status).toBe("uploaded");
    });

    it("does not let an S3 failure stop the emailed copy", async () => {
      upload.mockRejectedValue(new Error("connect ETIMEDOUT"));
      send.mockResolvedValue({ outcome: "uploaded" });

      await service.dispatchAfterBackup(input());

      expect(send).toHaveBeenCalledTimes(1);
      expect(row("s3")?.status).toBe("failed");
      expect(row("email")?.status).toBe("uploaded");
    });
  });

  describe("what never reaches the caller", () => {
    it("swallows a failure of the ledger itself", async () => {
      // The database being the problem is exactly when the backup that has
      // already been written must not be reported as failed (INV-BACKUP-003).
      withS3();
      resolveS3Target.mockRejectedValue(new Error("db down"));

      await expect(
        service.dispatchAfterBackup(input()),
      ).resolves.toBeUndefined();
      expect(upload).not.toHaveBeenCalled();
    });

    it("refuses an artifact whose name is not a published tier", async () => {
      withS3();
      const partial = "monize-backup-partial-2026-09-14.mzbe";
      writeFileSync(join(folder, partial), bytes);

      await service.dispatchAfterBackup(input({ filename: partial }));

      expect(ledger.size).toBe(0);
      expect(upload).not.toHaveBeenCalled();
    });
  });

  /**
   * `claimAndPerform` is the reaper's door, hours after the run. It is a second
   * entry point to the same effects, so the refusals are re-asserted through it
   * rather than assumed from the dispatch path's -- a refusal is worth as much
   * as its least-guarded entry point.
   */
  describe("the retry sweep's entry point", () => {
    const claim = (overrides: Record<string, unknown> = {}) => ({
      userId: USER_ID,
      destination: "s3" as BackupOffsiteDestination,
      objectKey: offsiteObjectKey(USER_ID, FILENAME, digest),
      tier: "daily" as const,
      digest,
      sizeBytes: bytes.length,
      folder,
      filename: FILENAME,
      origin: "automatic" as const,
      ...overrides,
    });

    it("refuses a plaintext artifact here too (INV-BACKUP-002)", async () => {
      withS3();
      writeFileSync(join(folder, PLAINTEXT_FILENAME), bytes);

      const held = await service.claimAndPerform(
        claim({
          filename: PLAINTEXT_FILENAME,
          objectKey: offsiteObjectKey(USER_ID, PLAINTEXT_FILENAME, digest),
        }),
      );

      expect(held).toBe(true);
      expect(upload).not.toHaveBeenCalled();
      expect(row("s3")?.status).toBe("skipped-unencrypted");
      expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    });

    it("records a failure rather than reading a name this deployment never wrote", async () => {
      withS3();

      await service.claimAndPerform(claim({ filename: "../../etc/passwd" }));

      expect(upload).not.toHaveBeenCalled();
      expect(row("s3")?.status).toBe("failed");
      expect(row("s3")?.lastError).toContain("not a name");
    });

    it("writes an email copy off once the address is gone", async () => {
      const held = await service.claimAndPerform(
        claim({ destination: "email", objectKey: FILENAME }),
      );

      expect(held).toBe(true);
      expect(send).not.toHaveBeenCalled();
      expect(row("email")).toMatchObject({
        status: "failed",
        attempts: MAX_OFFSITE_ATTEMPTS,
      });
      expect(row("email")?.lastError).toContain("no longer configured");
    });

    it("still alerts when the affected user's address cannot be read", async () => {
      // The alert is what an operator sees; a lookup failure must not be able
      // to swallow it, so the copy falls back to the user id.
      build([
        {
          id: "row-1",
          destination: "s3",
          objectKey: offsiteObjectKey(USER_ID, FILENAME, digest),
          digest: "a".repeat(64),
          status: "failed",
          attempts: 1,
          lastError: "timeout",
        },
      ]);
      usersRepo.findOne.mockRejectedValue(new Error("db down"));
      withS3();
      upload.mockResolvedValue({
        outcome: "already-present",
        objectKey: offsiteObjectKey(USER_ID, FILENAME, digest),
      });

      await service.claimAndPerform(claim());

      expect(row("s3")?.status).toBe("conflict");
      expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
      expect(raiseAdminAlert.mock.calls[0][0].message).toContain(USER_ID);
      expect(raiseAdminAlert.mock.calls[0][0].data).toMatchObject({
        affectedUserEmail: null,
      });
    });
  });
});
