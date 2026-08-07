import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { randomUUID } from "crypto";
import { DataSource, EntityManager, IsNull } from "typeorm";
import { withScopedDb } from "../db/scoped-db";
import { withSystemContext } from "../db/with-context";
import { affectedRowCount, returnedRows } from "../db/query-result";
import { JobClaim } from "./entities/job-claim.entity";

/**
 * The one durable claim mechanism for work that must happen at most once per
 * user, however many backend replicas fire the same cron.
 *
 * The multi-replica jobs in this codebase need three things, and they used to
 * invent a different ad hoc guard for each (audit DR-04-04):
 *
 * - `claimLease` -- an **exclusion**. Only one replica may do this now. Expires,
 *   so a replica killed mid-run does not lock the user out until someone notices;
 *   `releaseLease` returns it early. Returns a **lease token** identifying the
 *   winning attempt, which `markDelivered` and `releaseLease` require: the unique key names the
 *   work, not the holder, so without the token a worker delayed past its own expiry
 *   could delete a lease another replica had retaken, or record a delivery for a
 *   send that replica had not finished (audit DR-RRV4-01).
 *
 * - `markDelivered` / `wasDelivered` -- the **delivery record**. Written after the
 *   side effect succeeded, re-read under the lease to decide whether the work is
 *   still owed. A delivered row is never retaken.
 *
 * - `claimOnce` -- a permanent claim, for work where the claim row itself *is* the
 *   fact and nothing leaves the database: a posted occurrence, an alert
 *   fingerprint. `releasePermanentClaim` hands it back on failure.
 *
 * **A claim is not a record that the work was done**, and reaching for `claimOnce`
 * as though it were is how a delivery gets lost: the claim commits, the process
 * dies, and the permanent row now says a send happened that never did (audit
 * FV4-004, FV4-005, RV4-006). So anything with a crash window between claiming and
 * sending takes the lease *and* keeps a delivery record -- either on this table via
 * `markDelivered`, as the bill and mortgage reminders do, or in a column of its own
 * where the domain already has one (`emergency_access_settings
 * .last_reminder_sent_at`, `emergency_access_contacts.claim_notified_at`).
 *
 * That makes those jobs **at-least-once**: a process killed after the provider
 * accepted but before the record committed re-sends next run. For a reminder that
 * is the right trade, and it is a decision rather than an oversight -- see
 * `docs/cron-jobs.md`, which states the contract per job.
 *
 * Both are a single statement, so the claim is the serialization point: there is
 * no window between deciding and recording. Every call must sit inside an
 * ambient identity context (`withUserContext` / `withSystemContext`) like any
 * other database access.
 */

/** How long claim rows are kept before the sweep removes them. */
export const JOB_CLAIM_RETENTION_DAYS = 30;

/** Claim types in use. Spelled out so a typo is a compile error, not a duplicate email. */
export const JobClaimType = {
  BillReminder: "bill_reminder",
  MortgageReminder: "mortgage_reminder",
  EmergencyAccessReminder: "emergency_access_reminder",
  EmergencyAccessGrantNotify: "emergency_access_grant_notify",
  AiInsightGeneration: "ai_insight_generation",
  UserMaintenance: "user_maintenance",
  DemoReset: "demo_reset",
  DemoIntraday: "demo_intraday",
} as const;

export type JobClaimType = (typeof JobClaimType)[keyof typeof JobClaimType];

@Injectable()
export class JobClaimService {
  private readonly logger = new Logger(JobClaimService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Claim `(type, userId, key)` permanently. True for the one caller that won.
   *
   * `ON CONFLICT DO NOTHING` with `RETURNING` is what makes this safe across
   * replicas: the loser gets an empty result from the database, not a stale
   * "nothing exists yet" from its own read.
   */
  async claimOnce(
    claimType: JobClaimType,
    userId: string,
    claimKey: string,
  ): Promise<boolean> {
    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `INSERT INTO job_claims (claim_type, user_id, claim_key, expires_at)
         VALUES ($1, $2, $3, NULL)
         ON CONFLICT (claim_type, user_id, claim_key) DO NOTHING
         RETURNING id`,
        [claimType, userId, claimKey],
      ),
    );
    return affectedRowCount(rows) > 0;
  }

  /**
   * Claim `(type, userId, key)` for `ttlMs`. Returns the winning attempt's lease
   * token, or `null` for a caller that lost.
   *
   * The `DO UPDATE ... WHERE` arm is the lease: an existing row is only retaken
   * when its own expiry has passed, which is how a worker killed mid-run stops
   * blocking the next one without a human. A live lease returns no row, so the
   * loser knows to stand down rather than doing the work twice.
   *
   * `delivered_at IS NULL` is also in that arm, so a lease whose work is already
   * done is never retaken however long ago it expired. Without it the expiry alone
   * would let a later run re-do delivered work -- the lease is a bound on *doing*,
   * not a statement about what has been done.
   *
   * The token is what makes "the lease" a thing a caller can *hold*. Retaking
   * overwrites it, so a previous holder that comes back after its expiry can no
   * longer write against the row: `release` and `markDelivered` both compare it
   * (audit DR-RRV4-01).
   */
  async claimLease(
    claimType: JobClaimType,
    userId: string,
    claimKey: string,
    ttlMs: number,
  ): Promise<string | null> {
    const leaseToken = randomUUID();
    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `INSERT INTO job_claims (claim_type, user_id, claim_key, expires_at, lease_token)
         VALUES ($1, $2, $3,
                 CURRENT_TIMESTAMP + ($4::text || ' milliseconds')::interval,
                 $5::uuid)
         ON CONFLICT (claim_type, user_id, claim_key) DO UPDATE
            SET claimed_at = CURRENT_TIMESTAMP,
                expires_at = CURRENT_TIMESTAMP + ($4::text || ' milliseconds')::interval,
                lease_token = EXCLUDED.lease_token
          WHERE job_claims.delivered_at IS NULL
            AND job_claims.expires_at IS NOT NULL
            AND job_claims.expires_at < CURRENT_TIMESTAMP
         RETURNING lease_token`,
        [
          claimType,
          userId,
          claimKey,
          String(Math.max(1, Math.round(ttlMs))),
          leaseToken,
        ],
      ),
    );
    return affectedRowCount(rows) > 0 ? leaseToken : null;
  }

  /**
   * Give a lease back, as the attempt that holds it.
   *
   * On the happy path this ends a lease early. After a failure it un-consumes a
   * delivery, so a transient SMTP outage costs a retry rather than the whole
   * day's reminder -- which is the behaviour the pre-claim code had by accident
   * and which claiming first would otherwise take away.
   *
   * `leaseToken` is **required by the signature**: it refuses the delete when the
   * row belongs to a different attempt, because a worker delayed past its own
   * expiry would otherwise remove a live lease and leave the replica actually
   * sending with no exclusion at all (audit DR-RRV4-01). A permanent `claimOnce`
   * row, which has no attempt to identify, goes through
   * `releasePermanentClaim` instead -- two methods, so the compiler decides
   * which contract a call site is under rather than an optional argument
   * silently bypassing the ownership predicate (stack review, DR-04).
   *
   * The token goes both in the statement's `WHERE` and, via `set_config`, into the
   * transaction-local `app.job_claim_lease_token` GUC the migration-141 trigger
   * checks. The `WHERE` protects new code from new code; the GUC is what lets the
   * database refuse a *previous-release* pod's untokenized delete of a live lease
   * this deployment now holds (audit V4R3-004).
   *
   * A delivered row is deliberately **not** protected from this: the only callers
   * that release are the ones that just failed or just declined, and both hold the
   * lease. A caller that has recorded a delivery has nothing to release.
   */
  async releaseLease(
    claimType: JobClaimType,
    userId: string,
    claimKey: string,
    leaseToken: string,
  ): Promise<void> {
    await withScopedDb(this.dataSource, async (manager) => {
      await this.declareLeaseToken(manager, leaseToken);
      await manager.query(
        `DELETE FROM job_claims
          WHERE claim_type = $1 AND user_id = $2 AND claim_key = $3
            AND lease_token = $4::uuid`,
        [claimType, userId, claimKey, leaseToken],
      );
    });
  }

  /**
   * Give back a permanent `claimOnce` claim.
   *
   * Its own method rather than an optional-token arm of `releaseLease`: a lease
   * caller that forgot its token would otherwise compile, silently skip the
   * ownership predicate and the GUC the migration-141 trigger checks, and delete
   * whatever attempt currently holds the row. The compiler now refuses that call
   * shape outright. A permanent claim has no attempt to identify -- the trigger
   * leaves NULL-token rows alone -- so this is the only untokenized delete.
   */
  async releasePermanentClaim(
    claimType: JobClaimType,
    userId: string,
    claimKey: string,
  ): Promise<void> {
    await withScopedDb(this.dataSource, async (manager) => {
      // `IsNull()` is part of the contract, not decoration: it makes this method
      // structurally incapable of deleting a tokenized lease, even if a caller
      // reaches it with a lease's work key by mistake.
      await manager.getRepository(JobClaim).delete({
        claimType,
        userId,
        claimKey,
        leaseToken: IsNull(),
      });
    });
  }

  /**
   * Announce, for this transaction only, which lease this session is acting on.
   *
   * The migration-141 trigger compares it against a live tokenized row's own token
   * and rejects a mismatch, so a previous-release binary -- which never sets it --
   * cannot mutate a lease new code holds. `is_local = true` scopes it to the
   * surrounding `withScopedDb` transaction.
   */
  private async declareLeaseToken(
    manager: EntityManager,
    leaseToken: string,
  ): Promise<void> {
    await manager.query(
      `SELECT set_config('app.job_claim_lease_token', $1, true)`,
      [leaseToken],
    );
  }

  /**
   * Record that the side effect this claim coordinates actually happened.
   *
   * Called **after** the send, and it clears the lease: there is nothing left to
   * protect, and the row's job from here on is to say the work is done. Together
   * with `wasDelivered` this is what makes a claimed-but-unsent window recoverable
   * -- the failure the permanent `claimOnce` could not express (audit RV4-006).
   *
   * `lease_token` is a predicate, so this records a delivery only for the attempt
   * that is still the holder. A worker whose lease was retaken while it was stalled
   * writes nothing and logs it: the send it just made is real but unrecordable, so
   * the work stays owed and the next run re-sends. That is the at-least-once side
   * of the trade, and it is strictly better than the alternative -- stamping
   * `delivered_at` for a send the *current* holder has not finished, which would
   * make a genuine failure there permanent (audit DR-RRV4-01).
   */
  async markDelivered(
    claimType: JobClaimType,
    userId: string,
    claimKey: string,
    leaseToken: string,
  ): Promise<void> {
    const updated = await withScopedDb(this.dataSource, async (manager) => {
      // The GUC lets the trigger admit this write; the WHERE makes it apply only to
      // the row this attempt still holds (audit V4R3-004, DR-RRV4-01).
      await this.declareLeaseToken(manager, leaseToken);
      return manager.query(
        `UPDATE job_claims
            SET delivered_at = CURRENT_TIMESTAMP,
                expires_at = NULL
          WHERE claim_type = $1 AND user_id = $2 AND claim_key = $3
            AND lease_token = $4::uuid`,
        [claimType, userId, claimKey, leaseToken],
      );
    });
    if (affectedRowCount(updated) === 0) {
      this.logger.warn(
        `Delivery of ${claimType}/${claimKey} for user ${userId} could not be ` +
          `recorded: the lease was retaken by another attempt. The work stays owed ` +
          `and will be re-sent.`,
      );
    }
  }

  /**
   * Has this exact work already been delivered?
   *
   * Read under the lease, because that is the only order in which the answer is
   * stable: a claim says somebody intended to send, and only this says somebody
   * did. A lease holder that finds `true` stands down and hands the lease back.
   */
  async wasDelivered(
    claimType: JobClaimType,
    userId: string,
    claimKey: string,
  ): Promise<boolean> {
    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT 1 FROM job_claims
          WHERE claim_type = $1
            AND user_id = $2
            AND claim_key = $3
            AND delivered_at IS NOT NULL`,
        [claimType, userId, claimKey],
      ),
    );
    return returnedRows(rows).length > 0;
  }

  /**
   * Drop claim rows older than the retention window.
   *
   * Idempotent by construction -- the predicate is "already old" -- so two
   * replicas racing the sweep delete the same rows and the loser deletes none.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async sweepOldClaims(): Promise<void> {
    try {
      const removed = await withSystemContext(() =>
        withScopedDb(this.dataSource, async (manager) => {
          const result = await manager.query(
            `DELETE FROM job_claims
              WHERE claimed_at < CURRENT_TIMESTAMP - ($1::text || ' days')::interval`,
            [String(JOB_CLAIM_RETENTION_DAYS)],
          );
          return Array.isArray(result) ? (result[1] as number) : 0;
        }),
      );
      if (removed > 0) {
        this.logger.log(`Swept ${removed} expired job claim(s)`);
      }
    } catch (error) {
      this.logger.warn(
        `Job claim sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
