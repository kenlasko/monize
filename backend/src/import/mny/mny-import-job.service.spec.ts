import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConflictException } from "@nestjs/common";
import { DataSource, EntityManager, QueryFailedError } from "typeorm";
import {
  runOutsideActiveScopedManager,
  withScopedDb,
} from "../../common/db/scoped-db";
import { ImportJob, ONE_ACTIVE_JOB_INDEX } from "./entities/import-job.entity";
import { LockScope } from "../../common/db/locks";
import { MnyNotAMoneyFileError } from "./mny-errors";
import {
  JOB_FAILED_ERROR_KEY,
  JOB_HEARTBEAT_INTERVAL_MS,
  JOB_STALE_AFTER_MS,
  JOB_STALLED_ERROR_KEY,
  JOB_COMMITTED_STALLED_ERROR_KEY,
  MnyImportJobService,
  MnyJobFencedError,
  STALE_ACTIVE_JOB_CONDITION,
  isActiveJobConflict,
  reapStatement,
  returnedRows,
} from "./mny-import-job.service";

import { DEFAULT_MNY_IMPORT_OPTIONS } from "./model/mny-import-options";

jest.mock("../../common/db/scoped-db", () => ({
  withScopedDb: jest.fn(),
  runOutsideActiveScopedManager: jest.fn((fn: () => unknown) => fn()),
}));

jest.mock("../../common/db/with-context", () => ({
  withSystemContext: <T>(fn: () => T): T => fn(),
  withUserContext: <T>(_userId: string, fn: () => T): T => fn(),
}));

const mockedScopedDb = withScopedDb as jest.MockedFunction<typeof withScopedDb>;
const mockedOutside = runOutsideActiveScopedManager as jest.MockedFunction<
  typeof runOutsideActiveScopedManager
>;

/**
 * What `pg` actually raises when the partial unique index refuses an INSERT.
 * The constraint name is the whole signal, so it comes from the same constant
 * the entity declares the index with.
 */
const activeJobViolation = (): QueryFailedError =>
  new QueryFailedError("INSERT", [], {
    code: "23505",
    constraint: ONE_ACTIVE_JOB_INDEX,
  } as unknown as Error);

/**
 * The claim's atomicity and the reaper's interval arithmetic are properties of
 * Postgres and are asserted in `test/integration/mny-import-job.integration.spec.ts`.
 * What is asserted here is the code around them: the statements the service
 * issues, the connection they issue them on, and the status a failed body leaves
 * behind.
 */
describe("returnedRows", () => {
  it("unwraps the [rows, rowCount] tuple a data-modifying query returns", () => {
    expect(returnedRows([[{ id: "job-1" }], 1])).toEqual([{ id: "job-1" }]);
  });

  it("reports no rows when the conditional update matched nothing", () => {
    expect(returnedRows([[], 0])).toEqual([]);
  });

  it("passes bare SELECT rows through", () => {
    expect(returnedRows([{ id: "job-1" }, { id: "job-2" }])).toEqual([
      { id: "job-1" },
      { id: "job-2" },
    ]);
  });

  it("treats an empty result as no rows", () => {
    expect(returnedRows([])).toEqual([]);
  });

  it("treats a non-array result as no rows rather than throwing", () => {
    expect(returnedRows(undefined)).toEqual([]);
    expect(returnedRows(null)).toEqual([]);
    expect(returnedRows({ rowCount: 1 })).toEqual([]);
  });

  it("does not mistake a tuple for two rows", () => {
    // The actual defect: length 2 on the tuple read as "two rows updated".
    expect(returnedRows([[], 0])).toHaveLength(0);
  });
});

/**
 * SQL with its formatting normalized away, including the whitespace either side
 * of a parenthesis -- so an assertion compares grouping and not indentation.
 */
const flat = (statement: string): string =>
  statement
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();

describe("reapStatement", () => {
  it("groups the user restriction against the whole staleness condition", () => {
    // The condition is `(A) OR (B)`, so `user_id = $3 AND (A) OR (B)` reaps
    // this user's stale running jobs *and everybody else's stale pending ones*
    // -- one request retiring another tenant's import. An enclosing paren is
    // the only thing between those two statements, and it is invisible in a
    // template literal. Asserted against the composed clause and not against a
    // `"AND ("` prefix, because the condition opens with a paren of its own and
    // would satisfy that prefix while ungrouped.
    expect(flat(reapStatement(true))).toContain(
      flat(`WHERE user_id = $3 AND (${STALE_ACTIVE_JOB_CONDITION})`),
    );
  });

  it("restricts nothing when it is the cross-user sweep", () => {
    expect(flat(reapStatement(false))).toContain(
      flat(`WHERE (${STALE_ACTIVE_JOB_CONDITION})`),
    );
    expect(reapStatement(false)).not.toContain("user_id");
  });

  it("differs between its two forms only by that restriction", () => {
    // Proof the predicate really is written once: strip the scope clause and
    // the two statements are byte-identical. A hand-maintained second copy
    // would drift here first.
    expect(flat(reapStatement(true)).replace("user_id = $3 AND ", "")).toBe(
      flat(reapStatement(false)),
    );
  });

  it("retires a committed job non-retryable, under its own error key", () => {
    // `retryable` is a promise that re-running costs nothing, and past the
    // commit it does not: the ledger already holds the file, so a Retry imports
    // it twice. The reap and migration 140's preflight decide this the same way,
    // and the key differs because the copy has to say something different.
    expect(flat(reapStatement(true))).toContain(
      `error_key = CASE WHEN data_committed THEN '${JOB_COMMITTED_STALLED_ERROR_KEY}' ELSE $2 END`,
    );
    expect(flat(reapStatement(true))).toContain(
      "retryable = (data_committed = false)",
    );
  });

  it("spells both stalled keys the same way the migration does", () => {
    // The migration's preflight writes these literals directly, and its own
    // comment says a rename here has to change them there. That is a claim a
    // test can hold rather than a reader.
    const migration = readFileSync(
      join(
        __dirname,
        "../../../../database/migrations/140_concurrency_integrity_guards.sql",
      ),
      "utf8",
    );
    expect(migration).toContain(`'${JOB_COMMITTED_STALLED_ERROR_KEY}'`);
    expect(migration).toContain(`'${JOB_STALLED_ERROR_KEY}'`);
  });

  it("treats a running job with no heartbeat at all as stale", () => {
    // `NULL < timestamp` is NULL, so without this arm such a row matches
    // neither the reap nor `hasActiveJob`'s negation of it -- the one state
    // nothing can ever clear.
    expect(flat(STALE_ACTIVE_JOB_CONDITION)).toContain(
      "heartbeat_at IS NULL OR heartbeat_at <",
    );
  });

  it("measures a pending job from creation, since it never heartbeated", () => {
    expect(flat(STALE_ACTIVE_JOB_CONDITION)).toContain(
      "status = 'pending' AND created_at <",
    );
  });
});
/** A stable attempt token, so a spec can assert what the fence compares. */
const TOKEN = "9f1b7c2e-0000-4000-8000-abcdefabcdef";

describe("MnyImportJobService", () => {
  let repo: Record<string, jest.Mock>;
  let query: jest.Mock;
  let service: MnyImportJobService;

  const sql = (call: unknown[]): string => flat(String(call[0]));
  const lastCall = (): unknown[] =>
    query.mock.calls[query.mock.calls.length - 1] as unknown[];
  /** Where the reap landed, so a new statement above it renumbers nothing. */
  const reapCallIndex = (): number => {
    const index = query.mock.calls.findIndex((call) =>
      sql(call as unknown[]).includes("UPDATE import_jobs"),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    return index;
  };

  beforeEach(() => {
    repo = {
      create: jest.fn((entity) => entity),
      save: jest.fn((entity) => Promise.resolve({ id: "job-1", ...entity })),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    };
    query = jest.fn().mockResolvedValue([[], 0]);

    const manager = {
      getRepository: jest.fn(() => repo),
      query,
    } as unknown as EntityManager;

    mockedScopedDb.mockImplementation((_dataSource, fn) => fn(manager));
    mockedOutside.mockImplementation((fn) => fn());

    service = new MnyImportJobService({} as DataSource);
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);
  });

  afterEach(() => jest.clearAllMocks());

  describe("create", () => {
    it("inserts a pending, non-retryable job for the caller", async () => {
      const job = await service.create(
        "user-1",
        "staged-1",
        DEFAULT_MNY_IMPORT_OPTIONS,
      );

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          stagedFileId: "staged-1",
          sourceFormat: "mny",
          status: "pending",
          options: DEFAULT_MNY_IMPORT_OPTIONS,
          retryable: false,
        }),
      );
      expect(job.id).toBe("job-1");
    });

    it("writes the source format when one is passed", async () => {
      await service.create(
        "user-1",
        "staged-1",
        DEFAULT_MNY_IMPORT_OPTIONS,
        "kmy",
      );

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ sourceFormat: "kmy" }),
      );
    });

    it("translates the one-active-job index into the 409 the wizard renders", async () => {
      repo.save.mockRejectedValue(activeJobViolation());

      await expect(
        service.create("user-1", "staged-1", DEFAULT_MNY_IMPORT_OPTIONS),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("rethrows a violation of any other constraint untouched", async () => {
      // "An import is already running" is a specific claim, and a foreign-key
      // failure on the staged file is not evidence for it.
      const other = new QueryFailedError("INSERT", [], {
        code: "23503",
        constraint: "import_jobs_staged_file_id_fkey",
      } as unknown as Error);
      repo.save.mockRejectedValue(other);

      await expect(
        service.create("user-1", "staged-1", DEFAULT_MNY_IMPORT_OPTIONS),
      ).rejects.toBe(other);
    });

    it("rethrows a plain error, which carries no driver code at all", async () => {
      const boom = new Error("connection terminated");
      repo.save.mockRejectedValue(boom);

      await expect(
        service.create("user-1", "staged-1", DEFAULT_MNY_IMPORT_OPTIONS),
      ).rejects.toBe(boom);
    });

    it("reaps this user's stale jobs before attempting the insert", async () => {
      // The regression: with no reap here, a job whose pod died refuses every
      // import the user ever starts again, and `discard` cannot reach it once
      // it is `running`.
      await service.create("user-1", "staged-1", DEFAULT_MNY_IMPORT_OPTIONS);

      // Located by content, not by position: the transaction now opens with the
      // shared advisory lock and the maintenance-lease read, and a positional
      // index would have to be renumbered by whoever adds the next statement.
      expect(query.mock.calls[reapCallIndex()][1]).toEqual([
        String(JOB_STALE_AFTER_MS),
        JOB_STALLED_ERROR_KEY,
        "user-1",
      ]);
    });

    it("takes the shared maintenance lock before deciding anything", async () => {
      // The regression this pins: `import_jobs` and `job_claims` are different
      // tables, so an import and a restore/delete-my-data never contended and
      // both could believe they owned the user's dataset. They now take the same
      // `LockScope.UserImport` advisory lock, and it has to come first -- taken
      // after the reads it protects, it serializes nothing.
      await service.create("user-1", "staged-1", DEFAULT_MNY_IMPORT_OPTIONS);

      expect(sql(query.mock.calls[0])).toContain("pg_advisory_xact_lock");
      expect(query.mock.calls[0][1]).toEqual([LockScope.UserImport, "user-1"]);
      expect(reapCallIndex()).toBeGreaterThan(0);
    });

    it("refuses while a maintenance lease is live", async () => {
      // The other direction of the same exclusion: a restore holding the lease
      // must make an import lose, not merely the reverse.
      query.mockImplementation((text: string) =>
        String(text).includes("job_claims")
          ? Promise.resolve([{ present: true }])
          : Promise.resolve([]),
      );

      await expect(
        service.create("user-1", "staged-1", DEFAULT_MNY_IMPORT_OPTIONS),
      ).rejects.toMatchObject({ status: 409 });

      expect(repo.save).not.toHaveBeenCalled();
    });

    it("reaps in the same transaction the insert runs in", async () => {
      // In a transaction of its own the reap settles nothing: the row could be
      // re-read as active before the INSERT, which is the same defect as
      // counting active jobs in a separate transaction beforehand.
      await service.create("user-1", "staged-1", DEFAULT_MNY_IMPORT_OPTIONS);

      expect(mockedScopedDb).toHaveBeenCalledTimes(1);
      expect(query.mock.invocationCallOrder[0]).toBeLessThan(
        repo.save.mock.invocationCallOrder[0],
      );
    });

    it("reaps only rows belonging to the caller", async () => {
      await service.create("user-1", "staged-1", DEFAULT_MNY_IMPORT_OPTIONS);

      expect(sql(query.mock.calls[reapCallIndex()])).toContain(
        sql([`WHERE user_id = $3 AND (${STALE_ACTIVE_JOB_CONDITION})`]),
      );
    });
  });

  describe("isActiveJobConflict", () => {
    it("recognizes the unique violation the partial index raises", () => {
      expect(isActiveJobConflict(activeJobViolation())).toBe(true);
    });

    it("rejects a unique violation from a different index", () => {
      expect(
        isActiveJobConflict(
          new QueryFailedError("INSERT", [], {
            code: "23505",
            constraint: "some_other_unique_index",
          } as unknown as Error),
        ),
      ).toBe(false);
    });

    it("rejects anything that is not a query failure", () => {
      expect(isActiveJobConflict(new Error("nope"))).toBe(false);
      expect(isActiveJobConflict(undefined)).toBe(false);
    });
  });

  describe("discard", () => {
    it("deletes only this user's job, and only while it is still pending", async () => {
      await service.discard("user-1", "job-1");

      expect(sql(lastCall())).toContain(
        "DELETE FROM import_jobs WHERE id = $1 AND user_id = $2 AND status = 'pending'",
      );
      expect(lastCall()[1]).toEqual(["job-1", "user-1"]);
    });
  });

  describe("findOne", () => {
    it("scopes the lookup to the caller", async () => {
      await service.findOne("user-1", "job-1");

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: "job-1", userId: "user-1" },
      });
    });

    it("returns null for another user's job", async () => {
      expect(await service.findOne("user-1", "job-1")).toBeNull();
    });

    it("reaps before reading, so the poller never sees the stale row", async () => {
      // This endpoint is polled every 1.5s by the wizard. Reading first would
      // hand back `running` for a worker that is gone, and the progress bar
      // would sit there until the hourly cron happened to fire.
      await service.findOne("user-1", "job-1");

      expect(mockedScopedDb).toHaveBeenCalledTimes(1);
      expect(sql(query.mock.calls[0])).toContain("UPDATE import_jobs");
      expect(query.mock.invocationCallOrder[0]).toBeLessThan(
        repo.findOne.mock.invocationCallOrder[0],
      );
    });
  });

  describe("hasActiveJob", () => {
    it("looks for a pending or running job belonging to the caller", async () => {
      expect(await service.hasActiveJob("user-1")).toBe(false);

      const statement = sql(query.mock.calls[0]);
      expect(statement).toContain("FROM import_jobs");
      expect(statement).toContain("status IN ('pending', 'running')");
      expect(query.mock.calls[0][1]).toEqual([
        String(JOB_STALE_AFTER_MS),
        "user-1",
      ]);
    });

    it("is true once a live one exists", async () => {
      query.mockResolvedValue([{ id: "job-1" }]);

      expect(await service.hasActiveJob("user-1")).toBe(true);
    });

    it("does not count a job the very next statement would reap", async () => {
      // The regression this guards is subtle and total: `start` calls this
      // before `create`, so a stale row counted here throws the 409 and the
      // request never reaches the transaction that would have reaped it. The
      // demand-driven reap would be unreachable on its main path.
      await service.hasActiveJob("user-1");

      expect(sql(query.mock.calls[0])).toContain(
        flat(`AND NOT (${STALE_ACTIVE_JOB_CONDITION})`),
      );
    });
  });

  describe("claim", () => {
    it("only claims a job still pending", async () => {
      await service.claim("job-1");

      expect(sql(query.mock.calls[0])).toContain(
        "WHERE id = $1 AND status = 'pending'",
      );
      expect(query.mock.calls[0][1][0]).toBe("job-1");
    });

    it("wins when the conditional update returned the row", async () => {
      query.mockResolvedValue([[{ id: "job-1" }], 1]);

      // The claim mints this attempt's fencing token and hands it back; every
      // subsequent worker write names it (audit RV4-001).
      const token = await service.claim("job-1");
      expect(token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(sql(query.mock.calls[0])).toContain("attempt_token = $2");
      expect(query.mock.calls[0][1][1]).toBe(token);
    });

    it("loses when another worker got there first", async () => {
      query.mockResolvedValue([[], 0]);

      expect(await service.claim("job-1")).toBeNull();
    });
  });

  describe("reportProgress", () => {
    it("publishes on its own connection, outside the import transaction", async () => {
      await service.reportProgress("job-1", TOKEN, {
        phase: "transactions",
        processed: 10,
        total: 100,
      });

      // Progress written inside the import's transaction would stay invisible
      // until commit -- a frozen progress bar for the whole run.
      expect(mockedOutside).toHaveBeenCalledTimes(1);
      expect(sql(query.mock.calls[0])).toContain("SET progress = $3::jsonb");
      expect(query.mock.calls[0][1][2]).toBe(
        JSON.stringify({ phase: "transactions", processed: 10, total: 100 }),
      );
    });

    it("only touches a job that is still running", async () => {
      await service.reportProgress("job-1", TOKEN, {
        phase: "preparing",
        processed: 0,
        total: 0,
      });

      expect(sql(query.mock.calls[0])).toContain(
        "WHERE id = $1 AND status = 'running' AND attempt_token = $2",
      );
    });
  });

  describe("heartbeat", () => {
    it("stamps the heartbeat outside the import transaction", async () => {
      await service.heartbeat("job-1", TOKEN);

      expect(mockedOutside).toHaveBeenCalledTimes(1);
      expect(sql(query.mock.calls[0])).toContain(
        "SET heartbeat_at = CURRENT_TIMESTAMP",
      );
      // Token-scoped: a reaped worker's heartbeat must not make the job look
      // alive again.
      expect(sql(query.mock.calls[0])).toContain("attempt_token = $2");
      expect(query.mock.calls[0][1]).toEqual(["job-1", TOKEN]);
    });
  });

  /**
   * The fence (audit RV4-001).
   *
   * The reaper decides a job is dead from a *separate* connection while the
   * import transaction runs on another, so the worker can be blocked long enough
   * to be written off and then wake up. Before the token, its checkpoint was an
   * unconditional `SET data_committed = true WHERE id = $1`: it committed the
   * whole file behind the reaper's back, beside a job row inviting a retry that
   * would import it again.
   */
  describe("markDataCommitted", () => {
    const manager = (): EntityManager =>
      ({ query }) as unknown as EntityManager;

    it("checkpoints only while this worker still owns the running job", async () => {
      query.mockResolvedValue([[{ id: "job-1" }], 1]);

      await service.markDataCommitted(manager(), "job-1", TOKEN);

      const statement = sql(lastCall());
      expect(statement).toContain("SET data_committed = true");
      expect(statement).toContain(
        "WHERE id = $1 AND status = 'running' AND attempt_token = $2",
      );
      expect(statement).toContain("RETURNING id");
      expect(lastCall()[1]).toEqual(["job-1", TOKEN]);
    });

    it("throws when the reaper has already revoked this attempt", async () => {
      // Zero rows: the job is no longer running, or its token was cleared. This
      // is the last statement in the import transaction, so throwing here is what
      // rolls the whole import back instead of committing it.
      query.mockResolvedValue([[], 0]);

      await expect(
        service.markDataCommitted(manager(), "job-1", TOKEN),
      ).rejects.toBeInstanceOf(MnyJobFencedError);
    });

    it("reads the row count rather than the result's length", async () => {
      // `UPDATE ... RETURNING` comes back as the tuple `[rows, rowCount]`, so
      // `result.length` is 2 whether or not anything was updated -- a length check
      // here would make every fenced worker a winner, which is the exact bug the
      // fence exists to prevent.
      query.mockResolvedValue([[], 0]);

      await expect(
        service.markDataCommitted(manager(), "job-1", TOKEN),
      ).rejects.toBeInstanceOf(MnyJobFencedError);
    });
  });

  describe("complete", () => {
    it("stores the result and clears progress", async () => {
      await service.complete("job-1", TOKEN, {
        accountsCreated: 2,
      } as never);

      const statement = sql(query.mock.calls[0]);
      expect(statement).toContain("SET status = 'completed'");
      expect(statement).toContain("progress = NULL");
      // A completed job has no attempt left to fence.
      expect(statement).toContain("attempt_token = NULL");
      expect(statement).toContain("attempt_token = $2");
      expect(query.mock.calls[0][1][2]).toBe(
        JSON.stringify({ accountsCreated: 2 }),
      );
    });
  });

  describe("fail", () => {
    it("records the key, the detail and whether a retry could help", async () => {
      await service.fail("job-1", "mnyImportFailed", "connection reset", true);

      expect(sql(query.mock.calls[0])).toContain("SET status = 'failed'");
      expect(query.mock.calls[0][1]).toEqual([
        "job-1",
        "mnyImportFailed",
        "connection reset",
        true,
        // No token: this caller failed the job before any worker claimed it, so
        // the statement's `$5 IS NULL` arm applies.
        null,
      ]);
    });
  });

  describe("runClaimed", () => {
    beforeEach(() => {
      jest.useFakeTimers();
      query.mockResolvedValue([[{ id: "job-1" }], 1]);
    });

    afterEach(() => jest.useRealTimers());

    it("does nothing when another worker already claimed the job", async () => {
      query.mockResolvedValue([[], 0]);
      const body = jest.fn();

      expect(await service.runClaimed("user-1", "job-1", body)).toBe(false);
      expect(body).not.toHaveBeenCalled();
    });

    it("runs the body and completes the job", async () => {
      const body = jest.fn().mockResolvedValue({ accountsCreated: 1 });

      expect(await service.runClaimed("user-1", "job-1", body)).toBe(true);
      expect(body).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "job-1", userId: "user-1" }),
      );
      expect(sql(lastCall())).toContain("SET status = 'completed'");
    });

    it("does not log a completion the compare-and-set refused", async () => {
      // The reaper failed this job while the worker was finishing, so
      // `complete`'s `status = 'running' AND attempt_token = $2` matches nothing
      // and the terminal state it already wrote stands. Logging "completed"
      // anyway put the operator's only two lines about this job in direct
      // contradiction -- and the false one is the one that reads as an outcome.
      const log = jest.spyOn(service["logger"], "log");
      const warn = jest.spyOn(service["logger"], "warn");
      query.mockImplementation((statement: string) =>
        /SET status = 'completed'/.test(statement)
          ? Promise.resolve([[], 0])
          : Promise.resolve([[{ id: "job-1" }], 1]),
      );
      const body = jest.fn().mockResolvedValue({ accountsCreated: 1 });

      expect(await service.runClaimed("user-1", "job-1", body)).toBe(true);

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("no longer running"),
      );
      expect(log).not.toHaveBeenCalledWith(
        expect.stringContaining("completed"),
      );
    });

    it("logs the completion when the compare-and-set took", async () => {
      // The other half, so the guard above cannot pass by never logging at all.
      const log = jest.spyOn(service["logger"], "log");
      const body = jest.fn().mockResolvedValue({ accountsCreated: 1 });

      await service.runClaimed("user-1", "job-1", body);

      expect(log).toHaveBeenCalledWith("Import job job-1 completed");
    });

    it("gives the body a progress channel wired to this job", async () => {
      const body = jest.fn(async (context) => {
        await context.reportProgress({
          phase: "reference",
          processed: 1,
          total: 2,
        });
        return { accountsCreated: 0 } as never;
      });

      await service.runClaimed("user-1", "job-1", body);

      const progressCall = query.mock.calls.find((call) =>
        sql(call).includes("SET progress = $3::jsonb"),
      );
      expect(progressCall?.[1][0]).toBe("job-1");
    });

    it("marks a parse failure as not retryable, under its own error code", async () => {
      const body = jest
        .fn()
        .mockRejectedValue(new MnyNotAMoneyFileError("Standard Jet DB"));

      expect(await service.runClaimed("user-1", "job-1", body)).toBe(true);
      const failure = lastCall();
      expect(sql(failure)).toContain("SET status = 'failed'");
      // Retrying the same bytes cannot help.
      expect((failure[1] as unknown[])[1]).toBe("mnyNotAMoneyFile");
      expect((failure[1] as unknown[])[3]).toBe(false);
    });

    it("marks any other failure retryable, since the staged file survives", async () => {
      const body = jest.fn().mockRejectedValue(new Error("connection reset"));

      await service.runClaimed("user-1", "job-1", body);

      const failure = lastCall();
      expect((failure[1] as unknown[])[1]).toBe(JOB_FAILED_ERROR_KEY);
      expect((failure[1] as unknown[])[2]).toBe("connection reset");
      expect((failure[1] as unknown[])[3]).toBe(true);
    });

    it("records a non-Error rejection rather than losing it", async () => {
      const body = jest.fn().mockRejectedValue("something odd");

      await service.runClaimed("user-1", "job-1", body);

      expect((lastCall()[1] as unknown[])[2]).toBe("something odd");
    });

    it("heartbeats while the body runs and stops when it finishes", async () => {
      let release: () => void = () => undefined;
      const body = jest.fn(
        () =>
          new Promise<never>((resolve) => {
            release = () => resolve({ accountsCreated: 0 } as never);
          }),
      );

      const run = service.runClaimed("user-1", "job-1", body);
      // The claim is a few awaits deep; the interval only exists once it wins.
      for (let tick = 0; tick < 10 && body.mock.calls.length === 0; tick++) {
        await Promise.resolve();
      }

      jest.advanceTimersByTime(JOB_HEARTBEAT_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve();
      expect(
        query.mock.calls.filter((call) =>
          sql(call).includes("SET heartbeat_at = CURRENT_TIMESTAMP WHERE"),
        ),
      ).toHaveLength(1);

      release();
      await run;

      const afterCompletion = query.mock.calls.length;
      jest.advanceTimersByTime(JOB_HEARTBEAT_INTERVAL_MS * 3);
      await Promise.resolve();
      await Promise.resolve();
      expect(query.mock.calls).toHaveLength(afterCompletion);
    });

    it("swallows a failed heartbeat rather than killing the import", async () => {
      const body = jest.fn().mockResolvedValue({ accountsCreated: 0 });
      mockedOutside.mockImplementationOnce(() =>
        Promise.reject(new Error("connection reset")),
      );

      await expect(service.runClaimed("user-1", "job-1", body)).resolves.toBe(
        true,
      );
    });
  });

  describe("reapStaleJobs", () => {
    it("revokes the attempt token, so a reaped worker cannot commit", async () => {
      await service.reapStaleJobs();

      // Clearing the token is what makes the reap stick: the worker's own commit
      // checkpoint names it, so once it is gone that worker's import transaction
      // refuses and rolls back rather than landing behind the reaper's back
      // (audit RV4-001). Failing the row alone never stopped the write.
      expect(sql(query.mock.calls[0])).toContain("attempt_token = NULL");
    });

    it("fails running jobs whose heartbeat went stale, retryable only before the commit", async () => {
      await service.reapStaleJobs();

      const statement = sql(query.mock.calls[0]);
      expect(statement).toContain("status = 'running'");
      expect(statement).toContain("heartbeat_at < CURRENT_TIMESTAMP");
      // Was an unconditional `retryable = true`, which promised a free retry to
      // a job whose rows were already in the ledger.
      expect(statement).toContain("retryable = (data_committed = false)");
      // Two parameters, not three: the committed key is interpolated into the
      // shared `reapStatement` so both call sites cannot pass a different one.
      expect(query.mock.calls[0][1]).toEqual([
        String(JOB_STALE_AFTER_MS),
        JOB_STALLED_ERROR_KEY,
      ]);
    });

    it("derives retryability from data_committed, not from being a reap", async () => {
      // The regression this test previously enshrined: it asserted
      // `retryable = true` outright. Dying between the import transaction's
      // commit and `complete()` is exactly what the reaper exists to clean up, so
      // hard-coding retryable there routes around the one rule that stops a
      // retry inserting every imported row a second time (audit FV4-001).
      await service.reapStaleJobs();

      const statement = sql(query.mock.calls[0]);
      expect(statement).toContain("retryable = (data_committed = false)");
      expect(statement).not.toContain("retryable = true");
    });

    it("gives a committed-then-stalled job its own error key", async () => {
      // The two states need different advice: one can be retried and the other
      // must not be, so they cannot share a message.
      await service.reapStaleJobs();

      const statement = sql(query.mock.calls[0]);
      // Interpolated rather than bound, because `reapStatement` is shared by the
      // cron sweep and the per-user reap and they must not be able to pass
      // different keys.
      expect(statement).toContain(
        `WHEN data_committed THEN '${JOB_COMMITTED_STALLED_ERROR_KEY}'`,
      );
      expect(statement).toContain("not safe to repeat");
    });

    it("reports a committed stalled job at error level, naming it", async () => {
      // Its rows are in the database but the job never reported a result, so the
      // user sees a failure over data that actually landed. An operator has to
      // know which job that was.
      query.mockResolvedValue([
        [
          { id: "job-1", data_committed: false },
          { id: "job-2", data_committed: true },
        ],
        2,
      ]);
      const error = jest.spyOn(service["logger"], "error");

      await service.reapStaleJobs();

      expect(error).toHaveBeenCalledWith(expect.stringContaining("job-2"));
      expect(error.mock.calls[0][0]).toContain("NOT retryable");
      expect(error.mock.calls[0][0]).not.toContain("job-1");
    });

    it("fails pending jobs no worker ever claimed, measured from creation", async () => {
      // A row stuck pending is worse than a stuck running one: `hasActiveJob`
      // counts it, so it refuses every future import for that user, forever.
      await service.reapStaleJobs();

      const statement = sql(query.mock.calls[0]);
      expect(statement).toContain("status = 'pending'");
      expect(statement).toContain("created_at < CURRENT_TIMESTAMP");
    });

    it("logs the jobs it reaped", async () => {
      query.mockResolvedValue([
        [
          { id: "job-1", data_committed: false },
          { id: "job-2", data_committed: false },
        ],
        2,
      ]);
      const warn = jest.spyOn(service["logger"], "warn");

      await service.reapStaleJobs();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Reaped 2 stalled import job(s)"),
      );
    });

    it("says nothing when there was nothing to reap", async () => {
      const warn = jest.spyOn(service["logger"], "warn");

      await service.reapStaleJobs();

      expect(warn).not.toHaveBeenCalled();
    });

    it("never throws, so one bad sweep cannot kill the scheduler", async () => {
      query.mockRejectedValue(new Error("connection reset"));

      await expect(service.reapStaleJobs()).resolves.toBeUndefined();
    });

    it("sweeps every user, so it carries no user restriction", async () => {
      await service.reapStaleJobs();

      expect(sql(query.mock.calls[0])).not.toContain("user_id");
    });
  });

  describe("reapStaleJobsForUser", () => {
    const managerOf = (): EntityManager =>
      ({
        query,
        getRepository: jest.fn(() => repo),
      }) as unknown as EntityManager;

    it("runs on the manager it was handed, not on a transaction of its own", async () => {
      // The signature is the safety property: taking an EntityManager forces
      // the reap into the caller's transaction, where its outcome is still
      // true when the caller acts on it.
      await service.reapStaleJobsForUser(managerOf(), "user-1");

      expect(mockedScopedDb).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledTimes(1);
    });

    it("returns the ids it cleared", async () => {
      query.mockResolvedValue([[{ id: "job-1" }, { id: "job-2" }], 2]);

      expect(await service.reapStaleJobsForUser(managerOf(), "user-1")).toEqual(
        ["job-1", "job-2"],
      );
    });

    it("names the user in the log, since it is one tenant's lockout", async () => {
      query.mockResolvedValue([[{ id: "job-1" }], 1]);
      const warn = jest.spyOn(service["logger"], "warn");

      await service.reapStaleJobsForUser(managerOf(), "user-1");

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("for user user-1"),
      );
    });

    it("says nothing and returns nothing when there was nothing to reap", async () => {
      const warn = jest.spyOn(service["logger"], "warn");

      expect(await service.reapStaleJobsForUser(managerOf(), "user-1")).toEqual(
        [],
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it("propagates a failure rather than letting the caller commit regardless", async () => {
      // Unlike the cron, this runs inside a request's transaction. Swallowing
      // the error would let `create` insert against an unreaped slot, or let
      // the poller return the row the reap was meant to correct.
      query.mockRejectedValue(new Error("connection reset"));

      await expect(
        service.reapStaleJobsForUser(managerOf(), "user-1"),
      ).rejects.toThrow("connection reset");
    });
  });

  it("exposes the job entity it operates on", () => {
    // Guards the repository the scoped manager is asked for -- a typo here
    // would silently operate on the wrong table.
    expect(ImportJob.name).toBe("ImportJob");
  });
});
