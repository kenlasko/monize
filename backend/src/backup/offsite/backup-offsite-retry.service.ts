import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";

import { returnedRows } from "../../common/db/query-result";
import { withScopedDb } from "../../common/db/scoped-db";
import {
  withSystemContext,
  withUserContext,
} from "../../common/db/with-context";
import { AutoBackupService } from "../auto-backup.service";
import {
  BackupOffsiteDispatchService,
  MAX_OFFSITE_ATTEMPTS,
} from "./backup-offsite-dispatch.service";
import { offsiteArtifactFileName } from "./backup-offsite-keys";
import {
  BackupOffsiteDestination,
  BackupOffsiteTier,
} from "./entities/backup-offsite-upload.entity";

/**
 * How many rows one sweep re-attempts.
 *
 * A bound rather than "everything that is due": a destination that has been
 * unreachable for a day leaves one row per user per artifact, and an unbounded
 * sweep would hold the hour open uploading backups while the next one fires. The
 * oldest are taken first, so nothing starves -- the remainder is next hour's.
 */
const SWEEP_LIMIT = 200;

/**
 * How long a replica may hold a claim before another one may take the copy back.
 *
 * The number has to exceed the longest an honest attempt can run, or the sweep
 * would reclaim a copy that is still being uploaded and two replicas would send
 * the same bytes at once. The bound on an attempt is the transport's:
 * `S3_REQUEST_TIMEOUT_MS` (5 minutes) is the aborting total deadline of one S3
 * request and `S3_MAX_ATTEMPTS` (3) SDK attempts fit *inside* it, so one request
 * can take 5 minutes and a multipart upload is a sequence of them, each with its
 * own deadline. Five minutes times three attempts is 15 minutes; an hour is four
 * times that, which leaves room for a multipart artifact's create, parts and
 * completion without ever reclaiming a live upload.
 *
 * Exported so the statement below and the spec that pins it read one number.
 */
export const OFFSITE_CLAIM_LEASE_MINUTES = 60;

/**
 * What an expired claim records, so an operator reading the row learns that the
 * replica holding it never came back rather than that the destination refused.
 */
const CLAIM_EXPIRED_ERROR =
  "claim expired: the replica that held it did not record an outcome";

/** One `failed` row the sweep has decided is due. */
interface DueUpload {
  id: string;
  userId: string;
  destination: BackupOffsiteDestination;
  objectKey: string;
  tier: BackupOffsiteTier;
  digest: string;
  sizeBytes: number;
}

/**
 * Re-attempts off-machine copies that failed, under the same claim and the same
 * key (WP6 of `docs/future-plans/backup-off-machine.md`; INV-BACKUP-005's retry
 * half).
 *
 * **Why a reaper at all.** A transient S3 outage or a refused SMTP connection
 * leaves the artifact on the local volume and the copy undone. Without this, the
 * next recovery point off-machine would be tomorrow's -- and the row saying so
 * would sit in a table nobody reads. The durable `failed` state plus this sweep
 * is what makes "it will be retried" a mechanism rather than a hope.
 *
 * **What stops a second replica repeating the effect.** Every replica fires this
 * cron. The sweep itself is only a selection; the arbiter is the same
 * conditional claim the first dispatch takes -- `status IN ('pending','failed')
 * -> 'uploading' ... RETURNING` -- so of two replicas that both selected a row,
 * exactly one gets it back and the other does nothing. Nothing is claimed here
 * that `BackupOffsiteDispatchService` does not claim identically, because the
 * claim and the perform are one implementation shared by both entry points.
 *
 * **Backoff and a floor under it.** A row is due after `1h << (attempts - 1)` --
 * one hour, then two, four, eight -- and is dropped after
 * `MAX_OFFSITE_ATTEMPTS`. A destination that is misconfigured rather than
 * flapping therefore stops being called, and the administrators are told once by
 * the final attempt's alert instead of hourly forever.
 *
 * **One user's failure is one user's failure.** Each row runs inside its own
 * `try`, the shape `handleAutoBackupCron` already holds: a sweep that ended at
 * the first bad row would leave every later user's copy undone with nothing
 * recorded.
 *
 * **A claim is a lease, and the trade that makes it is stated rather than
 * hidden.** A replica killed between the claim and the outcome write leaves the
 * row `uploading`, which no predicate here would ever select again: the copy
 * would be stuck forever in a state nobody reconciles, which is precisely the
 * unverifiable effect EXT-003 forbids. So every sweep first expires claims older
 * than `OFFSITE_CLAIM_LEASE_MINUTES` back to `failed`, and the ordinary backoff
 * then re-attempts them. What that buys and what it costs, per destination: for
 * S3 a re-attempt of bytes whose first put did land is a digest-reconciled no-op
 * (the key carries the digest, the conditional put refuses, and the recorded
 * digest matches, so the row is recorded `uploaded` -- section 6 of
 * `docs/specs/backup-off-machine.md`); for email it can deliver the same
 * encrypted artifact to the same mailbox twice, because SMTP acceptance is all
 * the verification that medium offers. A duplicate copy off-machine is the
 * survivable direction against no copy at all, and the duplicate is the same
 * bytes under the same name.
 */
@Injectable()
export class BackupOffsiteRetryService {
  private readonly logger = new Logger(BackupOffsiteRetryService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly dispatch: BackupOffsiteDispatchService,
    // For the folder the artifact is read back from: the same resolver the
    // owner-facing listing uses, so the containment checks are not spelled a
    // second way here.
    private readonly autoBackup: AutoBackupService,
  ) {}

  /**
   * Hourly at :30, deliberately away from the backup sweep's :00 -- a retry that
   * fired while every user's export was running would contend with it for the
   * same disk and the same pool.
   */
  @Cron("30 * * * *")
  async handleRetrySweep(): Promise<void> {
    // Before anything is selected: a copy whose replica died mid-upload is not a
    // copy in progress, and only this statement can tell the sweep so.
    await this.expireStaleClaims();

    let due: DueUpload[];
    try {
      due = await this.selectDue();
    } catch (error) {
      this.logger.error(
        `Off-site retry sweep could not select due copies: ${messageOf(error)}`,
      );
      return;
    }
    if (due.length === 0) return;

    this.logger.log(`Off-site retry sweep: ${due.length} copy(s) due`);
    for (const row of due) {
      try {
        await withUserContext(row.userId, () => this.retryOne(row));
      } catch (error) {
        this.logger.error(
          `Off-site retry failed for user ${row.userId}, ` +
            `${row.destination}:${row.objectKey}: ${messageOf(error)}`,
        );
      }
    }
  }

  /**
   * Hand every expired claim back, in one statement, before the selection runs.
   *
   * One `UPDATE`, not a read followed by a write: the predicate is re-evaluated
   * under each row's lock, so two replicas sweeping at the same minute expire
   * each row once and the loser's statement matches nothing. `RETURNING id` is
   * what makes the count real -- the driver discards `rowCount` for some
   * statements (`common/db/query-result.ts`) -- and the count is logged because a
   * replica that died mid-upload is the only thing that produces one.
   *
   * Cross-user by construction, like the selection below it, so it runs under
   * the system context.
   *
   * A failure here is logged and the sweep carries on: the rows it could not
   * reclaim are next hour's, and refusing to retry every *other* due copy
   * because of it would be the larger harm.
   */
  private async expireStaleClaims(): Promise<number> {
    try {
      const expired = await withSystemContext(() =>
        withScopedDb(this.dataSource, (manager) =>
          manager.query(
            // `attempts` is decremented, not left as the claim raised it. The
            // claim increments on the way in and `recordOutcome` keeps that
            // value, so `attempts` is meant to count *completed* attempts -- and
            // a claim the lease is reclaiming never completed one: its replica
            // died before recording an outcome. Leaving it counted would let
            // deploy churn during the upload window spend the whole
            // MAX_OFFSITE_ATTEMPTS budget of a destination that never actually
            // refused, writing the copy off and alerting it as unrecoverable
            // over five restarts that had nothing to do with the destination.
            // A stale row was claimed exactly once since its last outcome, so
            // `- 1` undoes precisely that claim; GREATEST floors it at zero.
            `UPDATE backup_offsite_uploads
                SET status = 'failed',
                    last_error = $1,
                    attempts = GREATEST(attempts - 1, 0),
                    updated_at = now()
              WHERE status = 'uploading'
                AND claimed_at <= now() - (INTERVAL '1 minute' * $2)
              RETURNING id`,
            [CLAIM_EXPIRED_ERROR, OFFSITE_CLAIM_LEASE_MINUTES],
          ),
        ),
      );
      const count = returnedRows<{ id: string }>(expired).length;
      if (count > 0) {
        this.logger.warn(
          `Off-site retry sweep reclaimed ${count} copy(s) whose claim had ` +
            `expired after ${OFFSITE_CLAIM_LEASE_MINUTES} minutes; they are ` +
            "failed and will be re-attempted",
        );
      }
      return count;
    } catch (error) {
      this.logger.error(
        `Off-site retry sweep could not expire stale claims: ${messageOf(error)}`,
      );
      return 0;
    }
  }

  /**
   * The `failed` rows whose backoff has elapsed, oldest first.
   *
   * Cross-user by construction -- it enumerates every user's outstanding copies
   * from a cron with no request behind it -- so it runs under the system context
   * and every per-row body below re-seeds its owner's.
   *
   * The backoff is computed in SQL rather than in a predicate here: the sweep
   * would otherwise have to read every failed row in the deployment to decide
   * which of them are due.
   */
  private async selectDue(): Promise<DueUpload[]> {
    const rows = await withSystemContext(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `SELECT id,
                  user_id,
                  destination,
                  object_key,
                  tier,
                  digest,
                  size_bytes
             FROM backup_offsite_uploads
            WHERE status = 'failed'
              AND attempts < $1
              AND updated_at <=
                  now() - (INTERVAL '1 hour' * power(2, GREATEST(attempts - 1, 0)))
            ORDER BY updated_at ASC
            LIMIT $2`,
          [MAX_OFFSITE_ATTEMPTS, SWEEP_LIMIT],
        ),
      ),
    );
    return returnedRows<{
      id: string;
      user_id: string;
      destination: BackupOffsiteDestination;
      object_key: string;
      tier: BackupOffsiteTier;
      digest: string;
      size_bytes: string | number;
    }>(rows).map((row) => ({
      id: row.id,
      userId: row.user_id,
      destination: row.destination,
      objectKey: row.object_key,
      tier: row.tier,
      digest: row.digest,
      // BIGINT arrives from the driver as a string; the email bound and the
      // length check downstream are numeric comparisons.
      sizeBytes: Number(row.size_bytes),
    }));
  }

  /**
   * One row: find the artifact again, then take the same claim and the same
   * perform the first dispatch takes.
   *
   * The folder is resolved from the user's *current* settings rather than
   * remembered, because an operator may have moved the backup root since the
   * artifact was written -- and the row carries the copy's identity, not the
   * deployment's layout.
   *
   * `origin` is `automatic` whatever produced the original run. By the time a
   * retry gives up, nobody is reading a "Back up now" response any more; the
   * only way the lost off-machine copy is learned about is the alert.
   */
  private async retryOne(row: DueUpload): Promise<void> {
    const folder = await this.autoBackup.resolveStoredBackupFolder(row.userId);
    await this.dispatch.claimAndPerform({
      userId: row.userId,
      destination: row.destination,
      objectKey: row.objectKey,
      tier: row.tier,
      digest: row.digest,
      sizeBytes: row.sizeBytes,
      folder,
      filename: offsiteArtifactFileName(
        row.destination,
        row.objectKey,
        row.digest,
      ),
      origin: "automatic",
    });
  }
}

/** The message of whatever was thrown, without assuming it was an Error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
