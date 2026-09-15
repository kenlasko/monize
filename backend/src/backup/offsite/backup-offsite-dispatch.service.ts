import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import { resolve, sep } from "path";
import { DataSource, EntityTarget, ObjectLiteral, Repository } from "typeorm";

import { tokenHashesEqual } from "../../auth/crypto.util";

import { affectedRowCount, returnedRows } from "../../common/db/query-result";
import { withScopedDb } from "../../common/db/scoped-db";
import { withUserContext } from "../../common/db/with-context";
import { resolveUserEmailLocale } from "../../i18n/resolve-user-email-locale";
import {
  NotificationSeverity,
  NotificationType,
} from "../../notification-center/entities/notification.entity";
import { SystemAlertService } from "../../system-alerts/system-alert.service";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { User } from "../../users/entities/user.entity";
import {
  classifyBackupFileName,
  isEncryptedBackupFileName,
} from "../backup-file-names";
import { BackupOffsiteEmailSender } from "./backup-offsite-email.sender";
import { offsiteObjectKey } from "./backup-offsite-keys";
import { BackupOffsiteS3Uploader } from "./backup-offsite-s3.uploader";
import { BackupOffsiteSettingsService } from "./backup-offsite-settings.service";
import {
  BackupOffsiteDestination,
  BackupOffsiteTier,
  BackupOffsiteUploadStatus,
} from "./entities/backup-offsite-upload.entity";

/**
 * How many times one (user, destination, key) copy is attempted before the
 * reaper stops re-attempting it and the administrators are told.
 *
 * Exported because the retry sweep's selection predicate and this module's
 * "give up" bookkeeping are the same number: a sweep that selected rows the
 * recorder had already written off would re-attempt them forever, and a
 * recorder that wrote a smaller number would strand rows the sweep still picks
 * up.
 */
export const MAX_OFFSITE_ATTEMPTS = 5;

/** The longest `last_error` this module stores; the column itself is unbounded. */
const MAX_LAST_ERROR = 1024;

/** One completed local artifact, offered to this user's off-machine destinations. */
export interface BackupOffsiteDispatchInput {
  userId: string;
  /** The user's own backup folder, already containment-checked by its resolver. */
  folder: string;
  filename: string;
  tier: BackupOffsiteTier;
  /** The egress digest: SHA-256 of the exact written bytes, lowercase hex. */
  digest: string;
  sizeBytes: number;
  /** Which backup path produced the artifact; only an automatic one alerts. */
  origin: BackupRunOrigin;
}

/**
 * Which path produced the run being copied. The same distinction
 * `AutoBackupService` draws: a manual run has somebody reading the response, so
 * an admin alert titled "Automatic backup incomplete" would be about a backup
 * that was not automatic.
 */
export type BackupRunOrigin = "automatic" | "manual";

/** One (user, destination, key) copy, claimed and ready to be carried out. */
export interface OffsiteUploadClaim {
  userId: string;
  destination: BackupOffsiteDestination;
  /** S3: the sharded object key without the destination's prefix. Email: the filename. */
  objectKey: string;
  tier: BackupOffsiteTier;
  digest: string;
  sizeBytes: number;
  folder: string;
  filename: string;
  origin: BackupRunOrigin;
}

/** What the conditional claim handed back, or `null` when somebody else holds it. */
interface ClaimedRow {
  id: string;
  /** The digest the row was first written with -- not necessarily this artifact's. */
  digest: string;
  /** Attempts INCLUDING the one this claim just took. */
  attempts: number;
}

/** What one attempt achieved, before it is recorded. */
interface PerformResult {
  status: BackupOffsiteUploadStatus;
  lastError: string | null;
  /** Raise the admin alert whatever the attempt count says. */
  alertNow: boolean;
  /** Nothing further will change the answer: stop re-attempting this row. */
  giveUp: boolean;
}

/**
 * Copies a completed local backup artifact to this user's off-machine
 * destinations (WP4 of `docs/future-plans/backup-off-machine.md`;
 * INV-BACKUP-002, INV-BACKUP-003, INV-BACKUP-005).
 *
 * Four rules shape the whole class, and each of them is a way the naive version
 * of this code would be wrong.
 *
 * **The backup's success is not this class's to revoke.** `dispatchAfterBackup`
 * never throws: it is called on the tail of a run whose artifact is already on
 * disk and already recorded, and an off-machine copy that could turn a written
 * backup into a failed one would be a downgrade of the thing it exists to
 * protect (INV-BACKUP-003). Every failure becomes a durable row instead.
 *
 * **Only an encrypted artifact leaves the machine.** An automatic backup is
 * `.mzbe` only when a usable backup password exists; a `.json.gz` carries
 * third-party API keys in the clear inside it. A plaintext artifact is refused
 * before any destination is reached, recorded as `skipped-unencrypted` on every
 * destination the user has enabled, and alerted once -- so the absence of an
 * off-machine copy is something an operator learns rather than infers
 * (INV-BACKUP-002).
 *
 * **A copy is claimed before it is attempted.** Every replica fires the backup
 * cron, and the retry sweep runs on every replica too, so the durable row is
 * moved `pending`/`failed` -> `uploading` by a conditional `UPDATE ...
 * RETURNING` that re-evaluates its predicate under the row lock. Exactly one
 * caller gets a row back; the others have nothing to do. The same claim serves
 * the first dispatch and the reaper, because two spellings of one claim is two
 * chances to leave a hole.
 *
 * **The external call happens outside every transaction.** The claim is one
 * short transaction, the upload or the send is none, and the terminal outcome is
 * another short one (`docs/external-side-effects.md` sections 1 and 4a). A crash
 * in between leaves the row `uploading`, and the claim is therefore a lease: the
 * reaper hands it back after `OFFSITE_CLAIM_LEASE_MINUTES`
 * (`backup-offsite-retry.service.ts`), because a row nothing ever reclaims is an
 * unverifiable effect nobody finds (EXT-003). Re-sending bytes that may already
 * be off-machine is the S3 path's digest-reconciled no-op and the email path's
 * possible duplicate -- the survivable direction against never delivering the
 * copy at all.
 */
@Injectable()
export class BackupOffsiteDispatchService {
  private readonly logger = new Logger(BackupOffsiteDispatchService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly settings: BackupOffsiteSettingsService,
    private readonly uploader: BackupOffsiteS3Uploader,
    private readonly emailSender: BackupOffsiteEmailSender,
    private readonly systemAlerts: SystemAlertService,
  ) {}

  /**
   * Offer one completed artifact to every destination the user has enabled.
   *
   * Never throws, never rejects: the caller has already written and recorded a
   * backup, and this is the copy of it.
   */
  async dispatchAfterBackup(input: BackupOffsiteDispatchInput): Promise<void> {
    try {
      // The caller may already be inside this user's context (the manual path is
      // a request; the cron's per-user body seeds one). Nested is free and
      // re-seeding is what makes this correct from either.
      await withUserContext(input.userId, () => this.dispatchScoped(input));
    } catch (error) {
      this.logger.error(
        `Off-site dispatch for user ${input.userId} failed after the local ` +
          `backup ${input.filename} was written: ${messageOf(error)}`,
      );
    }
  }

  /**
   * Claim one copy and carry it out: the single implementation the first
   * dispatch and the retry sweep share.
   *
   * Returns whether this caller held the claim. `false` means another replica
   * holds it or the row is already terminal -- both "not ours", neither an
   * error. Never throws; a failure is recorded on the row.
   */
  async claimAndPerform(claim: OffsiteUploadClaim): Promise<boolean> {
    const claimed = await this.claim(claim);
    if (!claimed) {
      this.logger.debug(
        `Off-site copy ${claim.destination}:${claim.objectKey} is held ` +
          "elsewhere or already terminal; nothing to do here",
      );
      return false;
    }

    let result: PerformResult;
    try {
      result = await this.perform(claim, claimed);
    } catch (error) {
      // A throw means the copy did not happen. It is never "probably fine": the
      // row keeps the digest, so the reaper re-attempts the same bytes under the
      // same key.
      const lastError = messageOf(error).slice(0, MAX_LAST_ERROR);
      this.logger.warn(
        `Off-site copy of ${claim.filename} to the ${claim.destination} ` +
          `destination failed for user ${claim.userId}: ${lastError}`,
      );
      result = { status: "failed", lastError, alertNow: false, giveUp: false };
    }

    const exhausted =
      result.status === "failed" &&
      (result.giveUp || claimed.attempts >= MAX_OFFSITE_ATTEMPTS);
    await this.recordOutcome(
      claimed.id,
      result.status,
      result.lastError,
      // Writing the ceiling is how "nothing further will change this" becomes a
      // fact the reaper's own predicate reads, rather than a comment.
      result.giveUp ? MAX_OFFSITE_ATTEMPTS : claimed.attempts,
    );

    if (result.alertNow || (exhausted && !result.giveUp)) {
      await this.raiseOffsiteAlert(claim, {
        message: this.alertMessage(claim, result, exhausted),
        destination: claim.destination,
        filename: claim.filename,
        objectKey: claim.objectKey,
        status: result.status,
        attempts: claimed.attempts,
        ...(result.lastError ? { error: result.lastError } : {}),
      });
    }
    return true;
  }

  /**
   * The destinations, the refusal, and one claim per destination -- under this
   * user's identity.
   */
  private async dispatchScoped(
    input: BackupOffsiteDispatchInput,
  ): Promise<void> {
    const classified = classifyBackupFileName(input.filename);
    if (!classified || classified.tier !== input.tier) {
      // A partial artifact is never a candidate (INV-BACKUP-003), and a name
      // this module did not write has no tier the durable row could carry.
      this.logger.error(
        `Off-site dispatch refused ${JSON.stringify(input.filename)} for user ` +
          `${input.userId}: it is not a published ${input.tier} artifact`,
      );
      return;
    }

    const s3 = await this.settings.resolveS3Target(input.userId);
    const email = await this.settings.resolveEmail(input.userId);
    // "Enabled" is not "usable": a user whose stored credentials no longer
    // decrypt has chosen a destination, and the honest answer for it is a
    // failure row rather than silence (spec section 7).
    const destinations: BackupOffsiteDestination[] = [
      ...(s3.target !== null || s3.reason !== "off"
        ? (["s3"] as const)
        : ([] as const)),
      ...(email ? (["email"] as const) : ([] as const)),
    ];
    if (destinations.length === 0) return;

    const claims = destinations.map((destination) =>
      this.claimFor(input, destination),
    );

    if (!isEncryptedBackupFileName(input.filename)) {
      await this.refuseUnencrypted(input, claims);
      return;
    }

    for (const claim of claims) {
      // Sequential and independent: `claimAndPerform` records its own failure
      // and does not throw, so an S3 outage cannot stop the emailed copy.
      await this.claimAndPerform(claim);
    }
  }

  /** The claim one destination of one artifact is addressed by. */
  private claimFor(
    input: BackupOffsiteDispatchInput,
    destination: BackupOffsiteDestination,
  ): OffsiteUploadClaim {
    return {
      userId: input.userId,
      destination,
      objectKey:
        destination === "s3"
          ? offsiteObjectKey(input.userId, input.filename, input.digest)
          : input.filename,
      tier: input.tier,
      digest: input.digest,
      sizeBytes: input.sizeBytes,
      folder: input.folder,
      filename: input.filename,
      origin: input.origin,
    };
  }

  /**
   * INV-BACKUP-002: the copy is withheld, said so durably on every destination,
   * and said once to the administrators.
   *
   * The row is the point. A deployment with no `ENCRYPTION_KEY` and no backup
   * password is not "off-site backups are working"; it is "off-site backups are
   * deliberately not happening", and the two are indistinguishable without it.
   */
  private async refuseUnencrypted(
    input: BackupOffsiteDispatchInput,
    claims: OffsiteUploadClaim[],
  ): Promise<void> {
    const reason =
      `the artifact ${input.filename} is not encrypted; only an encrypted ` +
      ".mzbe artifact may leave the machine (INV-BACKUP-002)";
    for (const claim of claims) {
      await this.insertTerminal(claim, "skipped-unencrypted", reason);
    }
    this.logger.warn(
      `No off-site copy was made of ${input.filename} for user ` +
        `${input.userId}: ${reason}`,
    );
    await this.raiseOffsiteAlert(claims[0], {
      message:
        `the off-site copy of ${input.filename} was withheld because the ` +
        "artifact is unencrypted. Store a backup password (or configure " +
        "ENCRYPTION_KEY) so future artifacts are encrypted; nothing was " +
        "uploaded and nothing was emailed.",
      destination: claims.map((claim) => claim.destination).join(", "),
      filename: input.filename,
      status: "skipped-unencrypted",
    });
  }

  /**
   * Take the claim: seed the row if it is new, then move it to `uploading` only
   * from a claimable status.
   *
   * Both statements in one short transaction, so the insert a racing replica
   * lost is already visible to the `UPDATE` that decides the winner. The insert
   * carries `RETURNING` because the driver discards `rowCount` for `INSERT`
   * (`common/db/query-result.ts`); the value is unused, the clause is not.
   */
  private async claim(claim: OffsiteUploadClaim): Promise<ClaimedRow | null> {
    return withScopedDb(this.dataSource, async (manager) => {
      await manager.query(
        `INSERT INTO backup_offsite_uploads
           (user_id, destination, object_key, tier, digest, size_bytes, status, attempts)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', 0)
         ON CONFLICT (user_id, destination, object_key) DO NOTHING
         RETURNING id`,
        [
          claim.userId,
          claim.destination,
          claim.objectKey,
          claim.tier,
          claim.digest,
          claim.sizeBytes,
        ],
      );
      const claimed = await manager.query(
        `UPDATE backup_offsite_uploads
            SET status = 'uploading',
                attempts = attempts + 1,
                claimed_at = now(),
                updated_at = now()
          WHERE user_id = $1
            AND destination = $2
            AND object_key = $3
            AND status IN ('pending', 'failed')
          RETURNING id, digest, attempts`,
        [claim.userId, claim.destination, claim.objectKey],
      );
      const rows = returnedRows<{
        id: string;
        digest: string;
        attempts: number | string;
      }>(claimed);
      const row = rows[0];
      return row
        ? { id: row.id, digest: row.digest, attempts: Number(row.attempts) }
        : null;
    });
  }

  /**
   * A terminal row for a copy that was never attempted, written once.
   *
   * `ON CONFLICT DO NOTHING` rather than an upsert: a row that already exists
   * describes an attempt this one knows nothing about, and overwriting an
   * `uploaded` with a refusal would report a copy that is off-machine as absent.
   */
  private async insertTerminal(
    claim: OffsiteUploadClaim,
    status: BackupOffsiteUploadStatus,
    lastError: string,
  ): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `INSERT INTO backup_offsite_uploads
           (user_id, destination, object_key, tier, digest, size_bytes, status, attempts, last_error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8)
         ON CONFLICT (user_id, destination, object_key) DO NOTHING
         RETURNING id`,
        [
          claim.userId,
          claim.destination,
          claim.objectKey,
          claim.tier,
          claim.digest,
          claim.sizeBytes,
          status,
          lastError.slice(0, MAX_LAST_ERROR),
        ],
      ),
    );
  }

  /**
   * Write the outcome of the attempt this caller claimed.
   *
   * `AND status = 'uploading'` is the other half of the claim: a row somebody
   * else has since reclaimed is not this attempt's to describe.
   */
  private async recordOutcome(
    id: string,
    status: BackupOffsiteUploadStatus,
    lastError: string | null,
    attempts: number,
  ): Promise<boolean> {
    const result = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `UPDATE backup_offsite_uploads
            SET status = $1,
                last_error = $2,
                attempts = $3,
                updated_at = now()
          WHERE id = $4
            AND status = 'uploading'
          RETURNING id`,
        [status, lastError?.slice(0, MAX_LAST_ERROR) ?? null, attempts, id],
      ),
    );
    return affectedRowCount(result) > 0;
  }

  /**
   * The external half: read the bytes, prove they are the artifact that was
   * claimed, then hand them to the destination. Outside every transaction.
   */
  private async perform(
    claim: OffsiteUploadClaim,
    claimed: ClaimedRow,
  ): Promise<PerformResult> {
    const bytes = await this.readArtifact(claim);
    if (!bytes) {
      return {
        status: "failed",
        lastError: `artifact no longer on disk: ${claim.filename}`,
        alertNow: true,
        giveUp: true,
      };
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (
      bytes.length !== claim.sizeBytes ||
      !tokenHashesEqual(digest, claim.digest)
    ) {
      // Never upload what was not measured: the destination is told a checksum,
      // the key carries it, and an append-only destination cannot correct an
      // object later.
      return {
        status: "failed",
        lastError:
          `artifact changed on disk: ${claim.filename} is now ${bytes.length} ` +
          `bytes hashing to ${digest}, not the ${claim.sizeBytes} bytes ` +
          `hashing to ${claim.digest} that were recorded`,
        alertNow: false,
        giveUp: false,
      };
    }
    if (!isEncryptedBackupFileName(claim.filename)) {
      // Unreachable from `dispatchScoped`, which refuses earlier -- and asserted
      // here anyway, because a refusal is worth as much as its least-guarded
      // entry point and the reaper is a second one (INV-BACKUP-002).
      return {
        status: "skipped-unencrypted",
        lastError: `${claim.filename} is not an encrypted artifact`,
        alertNow: true,
        giveUp: true,
      };
    }

    return claim.destination === "s3"
      ? this.performS3(claim, claimed, bytes)
      : this.performEmail(claim, bytes);
  }

  /** The append-only put, and the two answers a taken key can have. */
  private async performS3(
    claim: OffsiteUploadClaim,
    claimed: ClaimedRow,
    bytes: Buffer,
  ): Promise<PerformResult> {
    const resolution = await this.settings.resolveS3Target(claim.userId);
    if (resolution.target === null) {
      const off = resolution.reason === "off";
      return {
        status: "failed",
        lastError: `the S3 destination is unavailable: ${resolution.reason}`,
        // A destination the user switched off is their decision, not an
        // operator's problem; anything else is a configuration fault they cannot
        // see, so it is said out loud (spec section 7).
        alertNow: !off,
        giveUp: off || resolution.reason === "deployment-unconfigured",
      };
    }

    const result = await this.uploader.upload(
      resolution.target,
      claim.objectKey,
      bytes,
      claim.digest,
    );
    if (result.outcome === "uploaded") {
      this.logger.log(
        `Off-site copy of ${claim.filename} for user ${claim.userId} is on S3 ` +
          `as ${result.objectKey}`,
      );
      return {
        status: "uploaded",
        lastError: null,
        alertNow: false,
        giveUp: false,
      };
    }
    // The uploader holds no read credential, so it can only say the key is
    // taken. The ledger row is what knows whose bytes are under it.
    if (claimed.digest === claim.digest) {
      this.logger.log(
        `Off-site copy of ${claim.filename} for user ${claim.userId} was ` +
          `already present as ${result.objectKey}; nothing was overwritten`,
      );
      return {
        status: "uploaded",
        lastError: null,
        alertNow: false,
        giveUp: false,
      };
    }
    return {
      status: "conflict",
      lastError:
        `the key ${result.objectKey} already holds an artifact recorded with ` +
        `digest ${claimed.digest}, not ${claim.digest}; nothing was overwritten`,
      alertNow: true,
      giveUp: true,
    };
  }

  /** The bounded attachment, or the notice that says why there is none. */
  private async performEmail(
    claim: OffsiteUploadClaim,
    bytes: Buffer,
  ): Promise<PerformResult> {
    const target = await this.settings.resolveEmail(claim.userId);
    if (!target) {
      return {
        status: "failed",
        lastError: "the email destination is no longer configured",
        alertNow: false,
        giveUp: true,
      };
    }
    const result = await this.emailSender.send({
      to: target.to,
      recipientLang: await this.recipientLang(claim.userId),
      filename: claim.filename,
      body: bytes,
      sizeBytes: claim.sizeBytes,
      digest: claim.digest,
      tier: claim.tier,
      maxBytes: this.settings.emailMaxBytes(),
    });
    return result.outcome === "uploaded"
      ? { status: "uploaded", lastError: null, alertNow: false, giveUp: false }
      : {
          status: "skipped-too-large",
          lastError:
            `${claim.sizeBytes} bytes is over the ` +
            `${this.settings.emailMaxBytes()}-byte email bound; a notice was ` +
            "sent instead and no bytes left the machine by email",
          alertNow: false,
          giveUp: true,
        };
  }

  /**
   * The exact bytes under `<folder>/<filename>`, or `null` when there is no such
   * file.
   *
   * The path opened is a directory entry's, never the claim's own string: the
   * requested name is matched against the user's folder listing and the matching
   * entry is what is joined and read, so the value reaching the filesystem is one
   * this deployment wrote rather than one carried in on a row -- the same CWE-22
   * boundary `AutoBackupService.openStoredBackup` states, and what lets a SAST
   * tool see it. The name is classified before the listing, and the join is
   * containment-checked all the same, because a validated name and an unchecked
   * join is how a check becomes decorative.
   */
  private async readArtifact(
    claim: OffsiteUploadClaim,
  ): Promise<Buffer | null> {
    if (!classifyBackupFileName(claim.filename)) {
      throw new Error(
        `Refusing to read ${JSON.stringify(claim.filename)}: it is not a name ` +
          "this deployment writes backups under",
      );
    }
    let entries: string[];
    try {
      entries = await fs.readdir(claim.folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
    // Only the server's own readdir string is joined; `claim.filename` is used to
    // match, never to build the path.
    const entry = entries.find((name) => name === claim.filename);
    if (entry === undefined) return null;
    const path = resolve(claim.folder, entry);
    if (!path.startsWith(claim.folder + sep)) {
      throw new Error(
        `Refusing to read ${JSON.stringify(entry)}: it resolves outside the ` +
          "user's backup folder",
      );
    }
    try {
      return await fs.readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
  }

  /** The recipient's own stored language -- never the locale of whoever ran the backup. */
  private async recipientLang(userId: string): Promise<string> {
    return this.scoped(UserPreference, (repo) =>
      resolveUserEmailLocale(repo, userId),
    );
  }

  /**
   * One BACKUP_PARTIAL alert about the off-machine copy, deduped per user and
   * day, mirroring `AutoBackupService.raiseBackupPartialAlert`.
   *
   * The reason is `offsite`, so it takes its own dedupe slot rather than
   * silencing the attachment, promotion or retention alerts behind the same
   * day's key.
   */
  private async raiseOffsiteAlert(
    claim: OffsiteUploadClaim,
    detail: { message: string } & Record<string, unknown>,
  ): Promise<void> {
    if (claim.origin !== "automatic") return;
    const { message, ...data } = detail;
    const email = await this.userEmailQuietly(claim.userId);
    const day = utcDateString();
    await this.systemAlerts.raiseAdminAlert({
      type: NotificationType.BACKUP_PARTIAL,
      severity: NotificationSeverity.WARNING,
      title: "Automatic backup incomplete",
      message: `Automatic backup for ${email ?? `user ${claim.userId}`}: ${message}`,
      data: {
        system: true,
        affectedUserId: claim.userId,
        affectedUserEmail: email,
        reason: "offsite",
        ...data,
      },
      // One row per affected user, one email per day: the usual cause is one
      // broken bucket or one broken relay, and a sixty-user install would
      // otherwise send an administrator sixty identical messages about it.
      dedupeKey: `BACKUP_PARTIAL:${claim.userId}:offsite:${day}`,
      emailDedupeKey: `BACKUP_PARTIAL:offsite:${day}`,
    });
  }

  /** The English fallback the stored alert carries; `data` is what localizes. */
  private alertMessage(
    claim: OffsiteUploadClaim,
    result: PerformResult,
    exhausted: boolean,
  ): string {
    if (result.status === "conflict") {
      return (
        `the off-site copy of ${claim.filename} was not made because ` +
        `${result.lastError}. An off-machine copy is never overwritten; ` +
        "check the bucket for the object under that key."
      );
    }
    return (
      `the ${claim.destination} off-site copy of ${claim.filename} could not ` +
      `be made: ${result.lastError}. ` +
      (exhausted
        ? "No further attempts will be made; the local backup is unaffected."
        : "It will be retried; the local backup is unaffected.")
    );
  }

  /**
   * The affected user's email, for the alert's copy -- an address means more to
   * an operator than a UUID. Read under this user's own identity (`users_self`
   * exposes their row), and best-effort: the alert goes out either way.
   */
  private async userEmailQuietly(userId: string): Promise<string | null> {
    try {
      const user = await this.scoped(User, (repo) =>
        repo.findOne({ where: { id: userId }, select: ["id", "email"] }),
      );
      return user?.email ? user.email : null;
    } catch {
      return null;
    }
  }

  /** One repository call in its own short scoped transaction. */
  private scoped<E extends ObjectLiteral, T>(
    entity: EntityTarget<E>,
    fn: (repo: Repository<E>) => Promise<T>,
  ): Promise<T> {
    return withScopedDb(this.dataSource, (manager) =>
      fn(manager.getRepository(entity)),
    );
  }
}

/** The message of whatever was thrown, without assuming it was an Error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The UTC calendar day, as the daily bucket in a system-alert dedupe key. UTC
 * rather than a user's backup timezone: the key only has to be the same on every
 * replica, and replicas share a clock.
 */
function utcDateString(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}
