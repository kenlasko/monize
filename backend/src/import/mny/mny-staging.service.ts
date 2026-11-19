import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { createHash } from "node:crypto";
import { DataSource, EntityManager } from "typeorm";
import { tr } from "../../i18n/translate";
import { returnedRows } from "../../common/db/query-result";
import { withScopedDb } from "../../common/db/scoped-db";
import { withSystemContext } from "../../common/db/with-context";
import { ImportStagedFile } from "./entities/import-staged-file.entity";
import type { ImportSourceFormat } from "./model/import-source";

/**
 * Server-side staging for a binary import file (design ADR-2).
 *
 * The wizard uploads once, previews, and only then starts the import. With more
 * than one backend replica the start call can land on a different pod than the
 * upload, so the bytes have to live somewhere both can reach: the database.
 *
 * What is staged is the **decrypted** file, so the Money password is spent on
 * the parse request and never persisted. The import re-parses these bytes rather
 * than a serialized intermediate representation, which is what makes the preview
 * and the import provably agree.
 */

/** How long a staged file survives an abandoned wizard. */
export const STAGED_FILE_TTL_HOURS = 24;

/**
 * True when a pending or running job still needs the staged file `f`.
 *
 * Written once because every deleter asks it, and each must ask it in a
 * statement that runs *after* it holds the row lock (see
 * `deleteUnlessNeeded`): asked in the same statement as the DELETE, on that
 * statement's snapshot, it cannot see a job whose INSERT committed while the
 * DELETE waited on the INSERT's key-share lock (audit A26-L14).
 */
export const ACTIVE_JOB_NEEDS_FILE = `EXISTS (
           SELECT 1 FROM import_jobs job
            WHERE job.staged_file_id = f.id
              AND job.status IN ('pending', 'running')
         )`;

/** Metadata for a staged file. Never carries the bytes. */
export interface StagedFileInfo {
  readonly id: string;
  readonly filename: string;
  readonly sourceFormat: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly expiresAt: Date;
}

export interface StageFileInput {
  readonly filename: string;
  readonly data: Buffer;
  readonly sourceFormat?: string;
}

function toInfo(row: ImportStagedFile): StagedFileInfo {
  return {
    id: row.id,
    filename: row.filename,
    sourceFormat: row.sourceFormat,
    sizeBytes: Number(row.sizeBytes),
    sha256: row.sha256,
    expiresAt: row.expiresAt,
  };
}

@Injectable()
export class MnyStagingService {
  private readonly logger = new Logger(MnyStagingService.name);

  constructor(private dataSource: DataSource) {}

  /**
   * Stores `data` for this user and returns its metadata.
   *
   * Previous staged files of the same format are dropped in the same
   * transaction unless a job still needs them, so a user who re-uploads after a
   * failed preview does not leave 200 MB rows behind for the sweep to find a day
   * later.
   */
  async stage(userId: string, input: StageFileInput): Promise<StagedFileInfo> {
    const sourceFormat = input.sourceFormat ?? "mny";
    const expiresAt = new Date(
      Date.now() + STAGED_FILE_TTL_HOURS * 60 * 60 * 1000,
    );

    return withScopedDb(this.dataSource, async (manager) => {
      await this.dropSupersededFiles(manager, userId, sourceFormat);

      const repo = manager.getRepository(ImportStagedFile);
      const saved = await repo.save(
        repo.create({
          userId,
          filename: input.filename,
          sourceFormat,
          sizeBytes: input.data.length,
          sha256: createHash("sha256").update(input.data).digest("hex"),
          data: input.data,
          expiresAt,
        }),
      );

      return toInfo(saved);
    });
  }

  /**
   * Metadata only. Null when the file never existed, is another user's, or has
   * already been swept.
   *
   * Deliberately *not* "or has expired": there is no `expires_at` predicate
   * here, so a row past its TTL stays readable until the hourly sweep removes
   * it. That is the intended behaviour -- the TTL is a storage-reclamation
   * policy, and refusing a file mid-import because the clock crossed 24 hours
   * would fail a job that was working. The sweep, not this read, is where TTL is
   * enforced -- and it skips any file an active job still needs (see
   * `sweepExpiredFiles`), deciding that after it holds the row lock, so a job
   * row committed before or during the sweep keeps its bytes (audit P4-016,
   * MR-002, A26-L14). A job INSERT that arrives after the sweep locked the row
   * waits for it and then fails its foreign key, which `create` reports as the
   * file being gone; it never runs without its bytes.
   */
  async findInfo(userId: string, id: string): Promise<StagedFileInfo | null> {
    const row = await withScopedDb(this.dataSource, (manager) =>
      manager
        .getRepository(ImportStagedFile)
        .findOne({ where: { id, userId } }),
    );
    return row ? toInfo(row) : null;
  }

  /**
   * The staged bytes, or null when the row is gone. `data` is `select: false`,
   * so it takes an explicit `addSelect` -- which is the point: every other query
   * in this service stays off the BYTEA column.
   *
   * No `expires_at` predicate, for the same reason as `findInfo`: an import that
   * has already started must be able to load the bytes it was promised, even if
   * the clock crossed the TTL while it ran. The active-job-aware sweep is what
   * keeps those bytes present until the job is done.
   */
  async loadBytes(userId: string, id: string): Promise<Buffer | null> {
    const row = await withScopedDb(this.dataSource, (manager) =>
      manager
        .getRepository(ImportStagedFile)
        .createQueryBuilder("file")
        .addSelect("file.data")
        .where("file.id = :id", { id })
        .andWhere("file.user_id = :userId", { userId })
        .getOne(),
    );

    return row?.data ?? null;
  }

  /**
   * Discards a staged file on the user's request. Returns false when there was
   * nothing to delete -- including a file of the other source format, which is
   * decided by the same locking statement as the delete, so a route never
   * discards another format's file; throws `ConflictException` while a pending or running
   * import still needs the bytes (audit A26-L14).
   *
   * Lock first, decide second. `FOR UPDATE` waits for a job INSERT that holds
   * the row's key-share lock, and the job check is a later statement, so its
   * snapshot sees that job once it committed; a job INSERT that comes after the
   * lock waits for this transaction and then fails its foreign key, which
   * `MnyImportJobService.create` reports as the file being gone.
   */
  async remove(
    userId: string,
    id: string,
    sourceFormat: ImportSourceFormat,
  ): Promise<boolean> {
    return withScopedDb(this.dataSource, async (manager) => {
      const locked = returnedRows<{ id: string; source_format?: string }>(
        await manager.query(
          `SELECT id, source_format FROM import_staged_files
            WHERE id = $1 AND user_id = $2 AND source_format = $3
              FOR UPDATE`,
          [id, userId, sourceFormat],
        ),
      );
      if (locked.length === 0) {
        return false;
      }
      const needed = returnedRows<{ needed: boolean }>(
        await manager.query(
          `SELECT ${ACTIVE_JOB_NEEDS_FILE} AS needed
             FROM import_staged_files f
            WHERE f.id = $1`,
          [id],
        ),
      );
      if (needed[0]?.needed === true) {
        throw new ConflictException(
          locked[0].source_format === "kmy"
            ? tr(
                "errors.import.kmyStagedFileInUse",
                "This KMyMoney file is being imported. Wait for the import to finish before discarding it.",
              )
            : tr(
                "errors.import.mnyStagedFileInUse",
                "This Money file is being imported. Wait for the import to finish before discarding it.",
              ),
        );
      }
      await manager.query(
        `DELETE FROM import_staged_files WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );
      return true;
    });
  }

  /**
   * Deletes the bytes the calling import consumed, once it is done with them.
   *
   * Unconditional, unlike `remove`: the only caller is the job that needs the
   * file, and it is still `running` when it lets go of it.
   */
  async removeConsumed(userId: string, id: string): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(ImportStagedFile).delete({ id, userId }),
    );
  }

  /**
   * Deletes every expired staged file that no active job still needs.
   *
   * Idempotent by construction -- the predicate is "already expired", so two
   * replicas running the sweep at the same time simply race to delete the same
   * rows and the loser deletes nothing. Runs hourly rather than daily so a
   * cluster with one long-lived pod does not sit on a day's worth of uploads.
   *
   * The active-job exclusion mirrors `dropSupersededFiles`. Expiry alone would
   * delete the bytes out from under a pending or running import -- the foreign
   * key is ON DELETE SET NULL, so the job survives and simply fails with a
   * missing-file error partway through a 200 MB import (audit P4-016). An import
   * that outlives its own TTL is exactly the long one worth not restarting.
   * The exclusion is decided after the row lock, through `deleteUnlessNeeded`,
   * so a job whose INSERT is committing as the sweep runs is seen too
   * (audit A26-L14).
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sweepExpiredFiles(): Promise<void> {
    try {
      const removed = await withSystemContext(() =>
        withScopedDb(this.dataSource, (manager) =>
          this.deleteUnlessNeeded(
            manager,
            `SELECT id FROM import_staged_files
              WHERE expires_at < CURRENT_TIMESTAMP`,
            [],
          ),
        ),
      );

      if (removed > 0) {
        this.logger.log(`Swept ${removed} expired staged import file(s)`);
      }
    } catch (error) {
      this.logger.warn(
        `Staged import file sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Removes this user's other staged files of the same format, except any a
   * pending or running job still needs -- deleting one of those would strand an
   * import that is about to read it.
   */
  private async dropSupersededFiles(
    manager: EntityManager,
    userId: string,
    sourceFormat: string,
  ): Promise<void> {
    await this.deleteUnlessNeeded(
      manager,
      `SELECT id FROM import_staged_files
        WHERE user_id = $1 AND source_format = $2`,
      [userId, sourceFormat],
    );
  }

  /**
   * Deletes the staged files `candidates` selects, except any a pending or
   * running job needs. Returns how many it deleted.
   *
   * Two statements, because one cannot be right (audit A26-L14). A job INSERT
   * holds a key-share lock on the staged row until it commits; a single
   * `DELETE ... WHERE NOT EXISTS (job)` evaluates its sub-select on a snapshot
   * taken before that INSERT committed, waits for the lock, and then deletes
   * without looking again. Here the first statement takes the row locks and the
   * second decides on a fresh snapshot.
   *
   * `SKIP LOCKED`: a file whose job is being created at this instant is left
   * for the next pass rather than waited for. Neither caller needs it gone now:
   * the sweep runs hourly, and a superseded file the job did not need falls to
   * the sweep.
   */
  private async deleteUnlessNeeded(
    manager: EntityManager,
    candidates: string,
    params: readonly unknown[],
  ): Promise<number> {
    const locked = returnedRows<{ id: string }>(
      await manager.query(`${candidates} FOR UPDATE SKIP LOCKED`, [...params]),
    );
    if (locked.length === 0) {
      return 0;
    }
    const deleted = returnedRows<{ id: string }>(
      await manager.query(
        `DELETE FROM import_staged_files f
          WHERE f.id = ANY($1::uuid[])
            AND NOT ${ACTIVE_JOB_NEEDS_FILE}
          RETURNING f.id`,
        [locked.map((row) => row.id)],
      ),
    );
    return deleted.length;
  }
}
