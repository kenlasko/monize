import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { Cron, CronExpression } from "@nestjs/schedule";
import { DataSource, EntityManager, QueryFailedError } from "typeorm";
import { tr } from "../../i18n/translate";
import {
  runOutsideActiveScopedManager,
  withScopedDb,
} from "../../common/db/scoped-db";
import { returnedRows } from "../../common/db/query-result";
import { acquireAdvisoryLock, LockScope } from "../../common/db/locks";
import { JobClaimType } from "../../common/jobs/job-claim.service";
import { USER_MAINTENANCE_CLAIM_KEY } from "../../common/jobs/user-maintenance.service";
import {
  withSystemContext,
  withUserContext,
} from "../../common/db/with-context";
import {
  COMMITTED_CONTENT_INDEX,
  ImportJob,
  ONE_ACTIVE_JOB_INDEX,
} from "./entities/import-job.entity";
import { MnyAlreadyImportedError, MnyImportError } from "./mny-errors";
import { MnyImportProgress, MnyImportResult } from "./model/mny-import-job";
import { MnyImportOptions } from "./model/mny-import-options";
import type { ImportSourceFormat } from "./model/import-source";

/**
 * Lifecycle of a background `.mny` import (design ADR-3).
 *
 * No queue, no Redis, no second process: `POST /import/mny/start` inserts a
 * `pending` row, exactly one worker claims it with a conditional UPDATE, and the
 * body runs as an unawaited in-process task under `withUserContext`. The wizard
 * polls the row.
 *
 * Four things make that safe on Kubernetes, where every replica runs the same
 * code, and it takes all four -- the first two were once described as sufficient
 * and were not:
 *
 * 1. **The insert is guarded by a partial unique index**, so two *requests*
 *    racing to start an import produce one job.
 * 2. **The claim is atomic**, so two pods racing over that one job produce one
 *    winner.
 * 3. **A running job heartbeats**, so a job whose pod died is reaped into
 *    `failed` instead of appearing to run forever -- retryable only when
 *    `data_committed` says nothing was written.
 * 4. **The claim mints an `attempt_token` and every worker write requires it.**
 *    Reaping alone decides that a worker is dead; it does not *stop* it. The
 *    heartbeat runs on its own connection while the import transaction runs on
 *    another, so a worker can be blocked past the stale threshold, be written
 *    off, and then wake up. Its commit checkpoint is a fenced compare-and-set on
 *    the token, and a zero-row result throws -- rolling the import back rather
 *    than committing the whole file behind the reaper's back, beside a job row
 *    inviting a retry that would import it again (audit RV4-001).
 *
 * Reaping is demand-driven. A stale row is not a tidiness problem -- the partial
 * unique index makes it refuse every future import that user starts, and
 * `discard` cannot touch it once it reached `running` -- so the two requests that
 * care clear it in their own transaction before deciding: `create`, which is
 * about to be refused by it, and `findOne`, which the wizard polls and which
 * would otherwise keep rendering a progress bar for a worker that is gone.
 * `reapStaleJobs` remains as an hourly cross-user backstop for the user who
 * closed the tab and never asked again.
 */

/** A job with no heartbeat for this long is presumed dead. */
export const JOB_STALE_AFTER_MS = 5 * 60 * 1000;

/** How often a running job proves it is alive. */
export const JOB_HEARTBEAT_INTERVAL_MS = 60 * 1000;

/** i18n key for a job the reaper gave up on. */
export const JOB_STALLED_ERROR_KEY = "mnyJobStalled";

/**
 * i18n key for a stalled job whose rows already reached the ledger.
 *
 * A different key because it is a different message *and* a different offer:
 * `mnyJobStalled` tells the user retrying is safe, which is only true while
 * nothing was written. Past `data_committed` the rows are there, the import just
 * did not finish reporting, and retrying would import the file a second time --
 * so this key's copy says so and the job is retired non-retryable.
 */
export const JOB_COMMITTED_STALLED_ERROR_KEY = "mnyJobStalledAfterCommit";

/** i18n key for a failure with no more specific parse error. */
export const JOB_FAILED_ERROR_KEY = "mnyImportFailed";

/**
 * i18n key for a job that failed in-process after its rows reached the ledger
 * (audit A26-H08).
 *
 * The in-process twin of `JOB_COMMITTED_STALLED_ERROR_KEY`. Whatever the caller
 * passes, `fail()` switches to this key once `data_committed` is true: the
 * generic key's copy says nothing was saved, which is false here, and the user
 * who believed it re-imported the file and doubled every balance.
 */
export const JOB_COMMITTED_FAILED_ERROR_KEY = "mnyImportFailedAfterCommit";

/** PostgreSQL SQLSTATE for a unique violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * The condition deciding that a job's worker is gone, in terms of `$1` -- the
 * staleness threshold in milliseconds.
 *
 * Written once because three callers ask the same question and have to agree:
 * the per-user reap inside `create`, the same reap inside the poller's
 * `findOne`, and `hasActiveJob`, which must consider *inactive* exactly what
 * those two would clear. A fourth copy of these clauses, drifted by one, is a
 * user told an import is already running by a row the very next statement would
 * have reaped -- and no test would see it, because each site would still be
 * self-consistent.
 *
 * A `running` row with no heartbeat at all counts as stale. `claim` stamps one
 * in the same UPDATE that sets the status, so it should be unreachable; without
 * the null arm it is the one state nothing can ever clear, because `NULL <
 * timestamp` is NULL and the row matches neither the reap nor its negation.
 */
export const STALE_ACTIVE_JOB_CONDITION = `(
              status = 'running'
          AND (
                heartbeat_at IS NULL
             OR heartbeat_at < CURRENT_TIMESTAMP - ($1::text || ' milliseconds')::interval
              )
            )
            OR (
              status = 'pending'
          AND created_at < CURRENT_TIMESTAMP - ($1::text || ' milliseconds')::interval
            )`;

/**
 * The reap, in terms of `$1` (staleness threshold, ms) and `$2` (the i18n key);
 * `scopedToUser` restricts it to `$3` and is how the per-request reap stays
 * inside the caller's own rows.
 *
 * The `AND` binds tighter than the condition's `OR`, so the parenthesis around
 * it is the whole difference between "this user's stale jobs" and "this user's
 * jobs, plus everybody's stale pending ones". `reapStatement` is exported so a
 * test can assert that grouping rather than trusting the reader to see it.
 *
 * `retryable`, `error_key` and `error_detail` all branch on `data_committed`,
 * and must keep branching the same way migration 140's preflight does. Retryable
 * is a promise that re-running costs nothing; once this job's rows reached the
 * ledger it does not, and offering Retry there imports the file a second time.
 * The committed case gets its own key because the copy has to say something
 * different -- see `JOB_COMMITTED_STALLED_ERROR_KEY`.
 *
 * `attempt_token = NULL` is the revocation half, and it is what makes the
 * decision stick rather than merely record it. Reaping decides a worker is
 * dead; it cannot stop one that is only blocked. The worker's commit checkpoint
 * names its token, so clearing it here makes that worker's import transaction
 * refuse and roll back instead of landing behind the reaper's back
 * (audit RV4-001). Both call sites revoke, because the per-user reap runs on
 * the request path and is the one most likely to race a live worker.
 *
 * Explained here rather than inside the template literal: a `--` comment in SQL
 * runs to end of line, so one embedded in a string anything might later collapse
 * to a single line would comment out the rest of the statement.
 */
export const reapStatement = (scopedToUser: boolean): string => `
    UPDATE import_jobs
        SET status = 'failed',
            error_key = CASE
              WHEN data_committed THEN '${JOB_COMMITTED_STALLED_ERROR_KEY}'
              ELSE $2
            END,
            error_detail = CASE
              WHEN data_committed
                THEN 'Import worker stopped after its data was written; the import is not safe to repeat'
              WHEN status = 'running'
                THEN 'Import worker stopped reporting progress'
              ELSE 'Import was never picked up by a worker'
            END,
            retryable = (data_committed = false),
            progress = NULL,
            attempt_token = NULL,
            completed_at = CURRENT_TIMESTAMP
      WHERE ${scopedToUser ? "user_id = $3 AND " : ""}(
            ${STALE_ACTIVE_JOB_CONDITION}
          )
      RETURNING id, data_committed`;

/**
 * True when this error is the one-active-import-per-user index refusing an
 * INSERT, rather than any other unique constraint on the table.
 *
 * Matching on the constraint name and not merely on the SQLSTATE matters: a
 * different violation means something the caller has no business reporting as
 * "an import is already running".
 */
export function isActiveJobConflict(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driver = error.driverError as
    { code?: string; constraint?: string } | undefined;
  return (
    driver?.code === UNIQUE_VIOLATION &&
    driver?.constraint === ONE_ACTIVE_JOB_INDEX
  );
}

/** PostgreSQL SQLSTATE for a foreign-key violation. */
const FOREIGN_KEY_VIOLATION = "23503";

/**
 * True when a job INSERT was refused because its staged file no longer
 * exists. The INSERT names two foreign keys, the user and the staged file, and
 * the user is the authenticated caller, so a 23503 on `import_jobs` here is the
 * staged file.
 */
export function isStagedFileGone(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driver = error.driverError as
    { code?: string; table?: string } | undefined;
  return (
    driver?.code === FOREIGN_KEY_VIOLATION && driver?.table === "import_jobs"
  );
}

/**
 * True when this error is the committed-content index refusing a second commit
 * of the same bytes for one user (audit A26-H08). Matched on the constraint
 * name for the same reason as `isActiveJobConflict`.
 */
export function isCommittedContentConflict(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driver = error.driverError as
    { code?: string; constraint?: string } | undefined;
  return (
    driver?.code === UNIQUE_VIOLATION &&
    driver?.constraint === COMMITTED_CONTENT_INDEX
  );
}

/**
 * The 409 for a start over bytes this user's ledger already holds.
 *
 * Names the earlier import, by its date and id, so the person can find it, and
 * says the one way to import the file again without duplicating it.
 */
export function alreadyImportedException(
  earlierJobId: string,
  importedOn: string,
): ConflictException {
  return new ConflictException(
    tr(
      "errors.import.mnyAlreadyImported",
      `This file was already imported on ${importedOn} (import ${earlierJobId}), and its records are still in your account. Importing it again would duplicate them. To replace them, start over and choose to replace your existing data.`,
      { date: importedOn, jobId: earlierJobId },
    ),
  );
}

/** The 409 the wizard already renders when a second import is refused. */
export function importAlreadyRunningException(): ConflictException {
  return new ConflictException(
    tr(
      "errors.import.mnyImportAlreadyRunning",
      "An import is already running. Wait for it to finish before starting another.",
    ),
  );
}

/** What a job body can report while it runs. */
export interface JobRunContext {
  readonly jobId: string;
  readonly userId: string;
  /**
   * This attempt's fencing token, minted by `claim()`.
   *
   * The body must present it when it writes the commit checkpoint. It is the
   * only thing that distinguishes "this worker still owns the job" from "the
   * reaper gave the job away while this worker was blocked", and those two have
   * to be told apart *before* the import transaction commits (audit RV4-001).
   */
  readonly attemptToken: string;
  /** Publishes progress the poller can see immediately. */
  reportProgress(progress: MnyImportProgress): Promise<void>;
}

/**
 * The commit checkpoint was refused because this worker no longer owns the job.
 *
 * Thrown from inside the import transaction, so it rolls back: the alternative is
 * a worker the reaper already wrote off committing the whole file anyway, beside a
 * job row advertising a retry that would import it a second time.
 */
export class MnyJobFencedError extends Error {
  constructor(jobId: string) {
    super(
      `Import job ${jobId} is no longer owned by this worker; rolling back its import transaction`,
    );
    this.name = "MnyJobFencedError";
  }
}

export type JobBody = (context: JobRunContext) => Promise<MnyImportResult>;

/**
 * `returnedRows` lives in exactly one place -- `common/db/query-result` -- so
 * the two driver-shape readers this module found the hard way cannot drift
 * apart. Re-exported here because the concurrency spec imports it from this
 * module, and the internal call sites below use it too.
 */
export { returnedRows };

@Injectable()
export class MnyImportJobService {
  private readonly logger = new Logger(MnyImportJobService.name);

  constructor(private dataSource: DataSource) {}

  /**
   * Creates a `pending` job, or throws `ConflictException` when this user
   * already has one active. Returns the row the wizard will poll.
   *
   * The refusal is the INSERT itself, not a preceding count: `hasActiveJob`
   * followed by `create` is two transactions, and two concurrent starts can
   * both read zero before either writes -- which imported the same staged file
   * twice, with fresh transaction UUIDs each time so nothing deduplicated the
   * second run. The partial unique index makes the loser block on the winner
   * and then fail, so the check and the write are one atomic act.
   *
   * The stale reap runs first, in that same transaction, because only a row
   * whose worker is still alive has any business refusing this request. Reaped
   * in a separate transaction it would settle nothing: the answer could change
   * between the two, which is the same defect as counting before inserting.
   */
  async create(
    userId: string,
    stagedFileId: string,
    options: MnyImportOptions,
    sourceFormat: ImportSourceFormat = "mny",
  ): Promise<ImportJob> {
    try {
      return await withScopedDb(this.dataSource, async (manager) => {
        // The other half of the exclusion, and the same lock
        // `UserMaintenanceService.withMaintenanceLease` takes.
        //
        // The partial unique index already makes two concurrent *imports*
        // atomic, but a restore or a "delete my data" records its claim in
        // `job_claims`, not here -- so without a shared object the two protocols
        // never contend and both can believe they own the dataset. Taking
        // `LockScope.UserImport` first, and reading the maintenance lease under
        // it, makes whichever transaction wins the lock decide for both.
        await acquireAdvisoryLock(manager, LockScope.UserImport, userId);

        const claimed = returnedRows<{ present: boolean }>(
          await manager.query(
            `SELECT EXISTS (
               SELECT 1 FROM job_claims
                WHERE claim_type = $1 AND user_id = $2 AND claim_key = $3
                  AND expires_at IS NOT NULL
                  AND expires_at > CURRENT_TIMESTAMP
             ) AS present`,
            [JobClaimType.UserMaintenance, userId, USER_MAINTENANCE_CLAIM_KEY],
          ),
        );
        if (claimed[0]?.present === true) {
          throw new ConflictException(
            tr(
              "errors.maintenance.inProgress",
              "Another operation is currently replacing this account's data. Wait for it to finish and try again.",
            ),
          );
        }

        await this.reapStaleJobsForUser(manager, userId);

        // A26-H08: the same bytes are not imported into one ledger twice --
        // neither by a second start on a staged id a committed job used, nor by
        // a re-upload of the same file under a new id. Decided here, under the
        // `UserImport` lock and before the job row exists, so a refused start
        // has written nothing; `markDataCommitted` repeats the decision on the
        // unique index for anything that slips past. A start that replaces the
        // user's data is exempt: its wipe removes the rows the key vouches for,
        // and `releaseCommittedContent` then clears the key.
        if (!options.wipeExistingData) {
          const earlier = returnedRows<{ id: string; imported_on: string }>(
            await manager.query(
              `SELECT j.id,
                      TO_CHAR(COALESCE(j.completed_at, j.created_at), 'YYYY-MM-DD') AS imported_on
                 FROM import_jobs j
                 JOIN import_staged_files f
                   ON f.id = $2 AND f.user_id = j.user_id
                WHERE j.user_id = $1
                  AND j.content_sha256 = f.sha256
                LIMIT 1`,
              [userId, stagedFileId],
            ),
          );
          if (earlier.length > 0) {
            throw alreadyImportedException(
              earlier[0].id,
              earlier[0].imported_on,
            );
          }
        }

        const repo = manager.getRepository(ImportJob);
        return repo.save(
          repo.create({
            userId,
            stagedFileId,
            sourceFormat,
            status: "pending",
            options,
            retryable: false,
            dataCommitted: false,
          }),
        );
      });
    } catch (error) {
      if (isActiveJobConflict(error)) {
        throw importAlreadyRunningException();
      }
      if (isStagedFileGone(error)) {
        // The staged row was deleted (swept or discarded) while this INSERT
        // waited on its lock: the foreign key refused the job, so nothing was
        // written and the bytes are gone (audit A26-L14).
        throw new NotFoundException(
          tr(
            "errors.import.mnyStagedFileMissing",
            "The uploaded Money file is no longer available. Please upload it again.",
          ),
        );
      }
      throw error;
    }
  }

  /**
   * Deletes a job that never started, releasing this user's import slot.
   *
   * `start` creates the row *before* the optional destructive wipe, so the wipe
   * runs under the same lock the import does -- but a wipe that fails
   * re-authentication must not leave the user holding a slot for a job that
   * will never run. Restricted to `pending`: a claimed job belongs to its
   * worker, which reports its own outcome.
   */
  async discard(userId: string, jobId: string): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `DELETE FROM import_jobs
          WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
        [jobId, userId],
      ),
    );
  }

  /**
   * The job, or null when it never existed or belongs to another user.
   *
   * This is what the wizard polls, every 1.5s, which makes it the first place a
   * dead worker can be noticed. Reaping this user's stale jobs first -- in the
   * transaction that then reads the row, so the caller cannot see the pre-reap
   * state -- is what turns a progress bar frozen at 40% into the retryable
   * failure it has actually been since the pod died. Without it the wizard
   * renders `running` forever, because nothing in the request path ever
   * contradicts the row.
   */
  async findOne(userId: string, jobId: string): Promise<ImportJob | null> {
    return withScopedDb(this.dataSource, async (manager) => {
      await this.reapStaleJobsForUser(manager, userId);
      return manager
        .getRepository(ImportJob)
        .findOne({ where: { id: jobId, userId } });
    });
  }

  /**
   * True when this user has an import in flight *and still alive*.
   *
   * Advisory only: it answers the question a moment before the answer can
   * change, so it buys a friendly 409 without an INSERT attempt and nothing
   * more. The guarantee lives in `create`'s unique index.
   *
   * The staleness exclusion is not an optimization, it is what makes the
   * advisory answer agree with the authoritative one. This runs *before*
   * `create`, so counting a stale row as active would throw the 409 from here
   * and the request would never reach the transaction that was about to reap
   * it -- restoring, through the pre-check, exactly the lockout the reap
   * exists to end. Hence the shared `STALE_ACTIVE_JOB_CONDITION`: negated here,
   * asserted there, one definition.
   */
  async hasActiveJob(userId: string): Promise<boolean> {
    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT id FROM import_jobs
          WHERE user_id = $2
            AND status IN ('pending', 'running')
            AND NOT (${STALE_ACTIVE_JOB_CONDITION})
          LIMIT 1`,
        [String(JOB_STALE_AFTER_MS), userId],
      ),
    );
    return returnedRows<{ id: string }>(rows).length > 0;
  }

  /**
   * Fails this user's stale jobs **inside the caller's transaction**, and
   * returns what it cleared.
   *
   * This is the reap that matters to a person waiting. A stale row locks its
   * user out of importing entirely: the partial unique index refuses the next
   * start, `discard` is restricted to `pending` so a dead `running` job is
   * beyond the client's reach, and no other request path clears it. Running the
   * reap in the transaction that is about to need the answer means the lockout
   * ends the moment the user next asks, instead of whenever the cron happens to
   * fire.
   *
   * Scoped to one user deliberately. It runs under the caller's own identity,
   * so it can only reach rows they own -- no bypass, and no way for one user's
   * request to retire another's live import. The cross-user sweep stays on the
   * cron, under a system context.
   *
   * @param manager the EntityManager of the ACTIVE transaction whose decision
   *   this clears the way for. Reaped in a separate transaction it guarantees
   *   nothing, because the row can be re-read as active before the caller acts.
   */
  async reapStaleJobsForUser(
    manager: EntityManager,
    userId: string,
  ): Promise<string[]> {
    const result = await manager.query(reapStatement(true), [
      String(JOB_STALE_AFTER_MS),
      JOB_STALLED_ERROR_KEY,
      userId,
    ]);
    const rows = returnedRows<{ id: string; data_committed: boolean }>(result);
    if (rows.length > 0) {
      this.logger.warn(
        `Reaped ${rows.length} stalled import job(s) for user ${userId}: ${rows
          .map((row) => row.id)
          .join(", ")}`,
      );
      // Same escalation as the cron sweep, and for the same reason: these rows
      // are in the ledger while the job reports a failure, so the discrepancy is
      // an operator's to reconcile rather than the user's to retry.
      const committed = rows.filter((row) => row.data_committed);
      if (committed.length > 0) {
        this.logger.error(
          `${committed.length} stalled import job(s) for user ${userId} had already committed their data and are NOT retryable: ${committed
            .map((row) => row.id)
            .join(", ")}`,
        );
      }
    }
    return rows.map((row) => row.id);
  }

  /**
   * Moves a job from `pending` to `running`, atomically, and mints this attempt's
   * fencing token. Returns the token, or null when another worker claimed it.
   *
   * The `WHERE status = 'pending'` is the concurrency control between two workers
   * racing to start: whichever statement commits first updates one row, the other
   * updates none. The token is the control over the *rest* of the attempt -- every
   * subsequent write names it, so a worker whose job was reaped mid-run cannot
   * commit, complete, or fail anything (audit RV4-001).
   */
  async claim(jobId: string): Promise<string | null> {
    const attemptToken = randomUUID();
    const result = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `UPDATE import_jobs
            SET status = 'running',
                started_at = CURRENT_TIMESTAMP,
                heartbeat_at = CURRENT_TIMESTAMP,
                attempt_token = $2,
                error_key = NULL,
                error_detail = NULL,
                retryable = false
          WHERE id = $1 AND status = 'pending'
          RETURNING id`,
        [jobId, attemptToken],
      ),
    );
    return returnedRows<{ id: string }>(result).length > 0
      ? attemptToken
      : null;
  }

  /**
   * Publishes progress in its own transaction, so a wizard polling mid-import
   * sees it. A write inside the import's transaction would stay invisible until
   * commit -- a frozen progress bar for the whole run.
   */
  async reportProgress(
    jobId: string,
    attemptToken: string,
    progress: MnyImportProgress,
  ): Promise<void> {
    await runOutsideActiveScopedManager(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `UPDATE import_jobs
              SET progress = $3::jsonb, heartbeat_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND status = 'running' AND attempt_token = $2`,
          [jobId, attemptToken, JSON.stringify(progress)],
        ),
      ),
    );
  }

  /**
   * Proof of life for the reaper, on the same escape hatch as progress.
   *
   * Token-scoped like every other worker write: once the reaper has taken the job
   * away, this worker's heartbeat must not be able to make it look alive again.
   */
  async heartbeat(jobId: string, attemptToken: string): Promise<void> {
    await runOutsideActiveScopedManager(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `UPDATE import_jobs
              SET heartbeat_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND status = 'running' AND attempt_token = $2`,
          [jobId, attemptToken],
        ),
      ),
    );
  }

  /**
   * Record that the import transaction committed its rows.
   *
   * Written **inside** that transaction, so it lands with the data it describes.
   * That is the whole point: `retryable` alone could not tell "failed before
   * writing anything" from "the ledger is written and only the completion
   * metadata is missing", so both were offered as an ordinary retry and the
   * second one imported the file again (audit P4-002).
   *
   * The same statement keys the job on its staged file's digest, so the
   * committed-content unique index refuses a second commit of the same bytes for
   * this user; that refusal also throws, and also rolls the rows back
   * (audit A26-H08).
   */
  async markDataCommitted(
    manager: EntityManager,
    jobId: string,
    attemptToken: string,
  ): Promise<void> {
    let updated: unknown;
    try {
      updated = await manager.query(
        `UPDATE import_jobs
            SET data_committed = true,
                content_sha256 = (
                  SELECT f.sha256 FROM import_staged_files f
                   WHERE f.id = import_jobs.staged_file_id
                     AND f.user_id = import_jobs.user_id
                )
          WHERE id = $1 AND status = 'running' AND attempt_token = $2
          RETURNING id`,
        [jobId, attemptToken],
      );
    } catch (error) {
      if (isCommittedContentConflict(error)) {
        throw new MnyAlreadyImportedError(jobId, error);
      }
      throw error;
    }
    if (returnedRows<{ id: string }>(updated).length === 0) {
      // The fence. The reaper failed this job while this worker was blocked --
      // clearing the token and advertising a retry -- so committing now would put
      // the whole file in the ledger beside an invitation to import it again.
      // Throwing here rolls the import transaction back, which is only possible
      // because this is its last statement.
      throw new MnyJobFencedError(jobId);
    }
  }

  /**
   * Releases this user's committed-content keys, once a "start fresh" wipe has
   * deleted the rows they vouched for (audit A26-H08).
   *
   * Called after `deleteData` returned, never before: released first, a wipe
   * that then failed would leave the rows in place with nothing refusing a
   * second import of them. A failure between the wipe and this call leaves the
   * keys held over rows that are gone, which refuses an import the person could
   * safely run -- the safe direction, and repaired by starting fresh again.
   */
  async releaseCommittedContent(userId: string): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `UPDATE import_jobs
            SET content_sha256 = NULL
          WHERE user_id = $1 AND content_sha256 IS NOT NULL`,
        [userId],
      ),
    );
  }

  /**
   * Move a running job to `completed`. Returns false when it was not running.
   *
   * `status = 'running'` is a compare-and-set, not decoration: a worker that
   * stalled long enough for the reaper to fail its job would otherwise wake up
   * and overwrite that terminal state with `completed`, so the row would claim
   * success for a run nobody supervised. Terminal states are monotonic.
   *
   * `attempt_token` narrows that further to *this* attempt, and the transition
   * clears it: a completed job has no attempt left to fence.
   */
  async complete(
    jobId: string,
    attemptToken: string,
    result: MnyImportResult,
  ): Promise<boolean> {
    const updated = await runOutsideActiveScopedManager(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `UPDATE import_jobs
              SET status = 'completed',
                  result = $3::jsonb,
                  progress = NULL,
                  attempt_token = NULL,
                  completed_at = CURRENT_TIMESTAMP,
                  retryable = false
            WHERE id = $1 AND status = 'running' AND attempt_token = $2
            RETURNING id`,
          [jobId, attemptToken, JSON.stringify(result)],
        ),
      ),
    );
    if (returnedRows<{ id: string }>(updated).length === 0) {
      this.logger.warn(
        `Import job ${jobId} finished but was no longer running; leaving its terminal state alone`,
      );
      return false;
    }
    return true;
  }

  /**
   * Move a job to `failed`. Returns false when it had already left `running`
   * or `pending` -- the same monotonicity rule as `complete`.
   *
   * `retryable` is ANDed with `data_committed = false`: a run whose import
   * transaction committed must never be advertised as retryable, whatever the
   * caller believes, because retrying it inserts every source row a second time
   * under fresh UUIDs. The caller cannot know this -- the checkpoint can be set
   * after the caller's own decision -- so the predicate lives in the statement.
   * `error_key` and `error_detail` branch on the same column, the way the
   * reaper's do: the caller's key describes a run that wrote nothing, and its
   * copy ("Nothing was saved") is false once the rows are in (audit A26-H08).
   *
   * `attemptToken` is optional because two kinds of caller fail a job. A worker
   * inside `runClaimed` passes its token, so a worker whose job the reaper already
   * took cannot rewrite the terminal state it was given. The paths that fail a job
   * *before* any worker claimed it -- staging gone, options rejected -- have no
   * token and omit it, which is the `$5 IS NULL` arm.
   */
  async fail(
    jobId: string,
    errorKey: string,
    errorDetail: string,
    retryable: boolean,
    attemptToken?: string,
  ): Promise<boolean> {
    const updated = await runOutsideActiveScopedManager(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `UPDATE import_jobs
              SET status = 'failed',
                  error_key = CASE
                    WHEN data_committed THEN '${JOB_COMMITTED_FAILED_ERROR_KEY}'
                    ELSE $2
                  END,
                  error_detail = CASE
                    WHEN data_committed
                      THEN 'Import failed after its data was written; the import is not safe to repeat: ' || $3
                    ELSE $3
                  END,
                  retryable = ($4 AND data_committed = false),
                  progress = NULL,
                  attempt_token = NULL,
                  completed_at = CURRENT_TIMESTAMP
            WHERE id = $1
              AND status IN ('pending', 'running')
              AND ($5::uuid IS NULL OR attempt_token = $5::uuid)
            RETURNING id`,
          [jobId, errorKey, errorDetail, retryable, attemptToken ?? null],
        ),
      ),
    );
    return returnedRows<{ id: string }>(updated).length > 0;
  }

  /**
   * Claims the job and runs `body`, keeping the row's status honest whatever
   * happens. Returns false when another worker already had it.
   *
   * A parse failure (bad file, wrong Money version) is not retryable -- retrying
   * the same bytes cannot help. Anything else is, *provided the import
   * transaction never committed*: `fail()` ANDs the caller's `retryable` with
   * `data_committed = false`, so a failure after the ledger was written is
   * reported as non-retryable rather than inviting a second import of the same
   * file. The staged file survives either way, for diagnosis.
   */
  async runClaimed(
    userId: string,
    jobId: string,
    body: JobBody,
  ): Promise<boolean> {
    const attemptToken = await this.claim(jobId);
    if (!attemptToken) {
      return false;
    }

    // unref: a pending heartbeat must never keep the process alive at shutdown.
    const beat = setInterval(() => {
      void withUserContext(userId, () =>
        this.heartbeat(jobId, attemptToken),
      ).catch(() => undefined);
    }, JOB_HEARTBEAT_INTERVAL_MS);
    beat.unref();

    try {
      const result = await body({
        jobId,
        userId,
        attemptToken,
        reportProgress: (progress) =>
          this.reportProgress(jobId, attemptToken, progress),
      });
      // Gated on the compare-and-set, not on reaching this line. `complete`
      // refuses when the reaper already failed this job, and the whole point of
      // that refusal is that the run did *not* finish supervised -- so logging
      // "completed" beside `complete`'s own warning would put the operator's
      // only two lines about this job in direct contradiction, with the false
      // one the more visible.
      if (await this.complete(jobId, attemptToken, result)) {
        this.logger.log(`Import job ${jobId} completed`);
      }
    } catch (error) {
      const isParseFailure = error instanceof MnyImportError;
      const detail = error instanceof Error ? error.message : String(error);
      // The token goes with it: a fenced worker must not be able to rewrite the
      // terminal state the reaper already set, and `fail` refuses on a mismatch
      // rather than silently overwriting it.
      await this.fail(
        jobId,
        isParseFailure ? error.code : JOB_FAILED_ERROR_KEY,
        detail,
        !isParseFailure,
        attemptToken,
      );
      if (error instanceof MnyJobFencedError) {
        // Not the ordinary failure log: the run was abandoned by the reaper and
        // rolled itself back, which an operator reading "import failed" would
        // otherwise have to infer.
        this.logger.error(
          `Import job ${jobId} was reaped while running; its import transaction rolled back and committed nothing`,
        );
      } else {
        this.logger.error(`Import job ${jobId} failed: ${detail}`);
      }
    } finally {
      clearInterval(beat);
    }

    return true;
  }

  /**
   * The cross-user backstop for jobs whose worker stopped heartbeating -- a
   * killed pod, an OOM, a rolling restart mid-import -- and for `pending` rows
   * no worker ever claimed, reaped on the same rule measured from creation.
   *
   * Hourly, because it is no longer what any waiting user depends on.
   * `reapStaleJobsForUser` runs on the two requests that care, so the person
   * whose import died sees it fail on their next poll -- about 1.5 seconds after
   * the job goes stale -- and can start another immediately. Firing this every
   * five minutes bought a worst case of ten minutes for a lockout that the
   * request path now ends by itself; what is left for a schedule is the user who
   * closed the tab and never asked again, whose row would otherwise sit
   * `running` in the table indefinitely and misreport the import history.
   *
   * Marked retryable **only when nothing was committed**. The staged file is
   * untouched, so the wizard can normally offer Retry rather than making the user
   * upload 200 MB again -- but a `running` job that had already set
   * `data_committed` wrote every source row before the process died, and retrying
   * it inserts them all a second time under fresh UUIDs. `fail()` derives
   * retryability from the same column for the same reason; a reaper that hard-coded
   * `retryable = true` would route around that rule at exactly the moment it
   * matters, because dying between the commit and `complete()` is precisely what
   * the reaper exists to clean up (audit FV4-001). A `pending` job never entered
   * the import transaction, so it stays retryable unconditionally.
   *
   * Idempotent across replicas, because the predicate only matches rows still in
   * the state being reaped.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async reapStaleJobs(): Promise<void> {
    try {
      const reaped = await withSystemContext(() =>
        withScopedDb(this.dataSource, async (manager) => {
          const result = await manager.query(reapStatement(false), [
            String(JOB_STALE_AFTER_MS),
            JOB_STALLED_ERROR_KEY,
          ]);
          return returnedRows<{ id: string; data_committed: boolean }>(result);
        }),
      );

      if (reaped.length > 0) {
        const committed = reaped.filter((row) => row.data_committed);
        this.logger.warn(
          `Reaped ${reaped.length} stalled import job(s): ${reaped
            .map((row) => row.id)
            .join(", ")}`,
        );
        if (committed.length > 0) {
          // An operator has to know about these: the rows are in the database but
          // the job never reported its result, so the user sees a failure over
          // data that actually landed.
          this.logger.error(
            `${committed.length} stalled import job(s) had already committed their data and are NOT retryable: ${committed
              .map((row) => row.id)
              .join(", ")}`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `Import job reaper failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
