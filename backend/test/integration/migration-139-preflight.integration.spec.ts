import { DataSource } from "typeorm";
import * as fs from "fs";
import * as path from "path";

import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";

/**
 * Migration 139's repair phases, against a database already in the state the
 * migration's own guards forbid.
 *
 * Two of the six guards are constraints over data that already exists, and both
 * constrain a state the pre-133 code could reach: more than one active import per
 * user (the racy `hasActiveJob()` count, P4-001) and duplicate budget alerts (the
 * application-level `deduplicateAlerts()`, P4-015). `CREATE UNIQUE INDEX` over a
 * table already in that state **fails**, and a failed migration is not a failed
 * check: `db-migrate` runs at container start, so the backend never boots and the
 * deploy reports only "backend exited (1)" (audit FV4-006).
 *
 * A unit test cannot see any of this -- the failure is PostgreSQL refusing an
 * index -- so the fixture is a real database put into the legacy state, with the
 * migration read **from disk** so the assertions cannot drift from what ships.
 *
 * The spec also re-applies the file a second time, because that is what a
 * half-applied migration does on the next boot: a repair that is not
 * re-runnable trades a startup crash for a different startup crash.
 */
describe("migration 139 preflight over legacy data", () => {
  let dataSource: DataSource;
  let userA: string;
  let userB: string;

  const MIGRATION = path.join(
    __dirname,
    "../../../database/migrations/139_concurrency_integrity_guards.sql",
  );

  /** The keys the stale-job reaper uses; the migration reuses them deliberately. */
  const STALLED = "mnyJobStalled";
  const STALLED_AFTER_COMMIT = "mnyJobStalledAfterCommit";

  const applyMigration = () =>
    dataSource.query(fs.readFileSync(MIGRATION, "utf8"));

  /**
   * Put the database back the way it looked before 133: no status CHECK, no
   * active-job uniqueness, no alert fingerprint. `applyRlsPolicies` applies 133
   * (it references the identity helpers, so the harness picks it up by content),
   * which is why these have to be dropped rather than merely not created.
   */
  const removeGuards = async () => {
    await dataSource.query(
      `ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_status_check`,
    );
    await dataSource.query(
      `DROP INDEX IF EXISTS idx_import_jobs_one_active_per_user`,
    );
    await dataSource.query(
      `DROP INDEX IF EXISTS idx_budget_alerts_fingerprint`,
    );
  };

  const indexExists = async (name: string): Promise<boolean> => {
    const rows = await dataSource.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
      [name],
    );
    return rows.length > 0;
  };

  const constraintExists = async (name: string): Promise<boolean> => {
    const rows = await dataSource.query(
      `SELECT 1 FROM pg_constraint WHERE conname = $1`,
      [name],
    );
    return rows.length > 0;
  };

  interface JobRow {
    id: string;
    status: string;
    error_key: string | null;
    retryable: boolean;
    data_committed: boolean;
    progress: unknown;
  }

  const job = async (id: string): Promise<JobRow> => {
    const rows: JobRow[] = await dataSource.query(
      `SELECT id, status, error_key, retryable, data_committed, progress
         FROM import_jobs WHERE id = $1`,
      [id],
    );
    return rows[0];
  };

  /**
   * Insert an import job directly, bypassing the service. The point of this spec
   * is a row the current code cannot create, so it cannot come from the service.
   */
  const seedJob = async (
    id: string,
    userId: string,
    fields: {
      status: string;
      dataCommitted?: boolean;
      heartbeatAt?: string | null;
      createdAt?: string;
    },
  ): Promise<void> => {
    await dataSource.query(
      `INSERT INTO import_jobs
         (id, user_id, source_format, status, options, data_committed,
          heartbeat_at, created_at, retryable)
       VALUES ($1, $2, 'mny', $3, '{}'::jsonb, $4, $5, $6, false)`,
      [
        id,
        userId,
        fields.status,
        fields.dataCommitted ?? false,
        fields.heartbeatAt ?? null,
        fields.createdAt ?? "2026-01-01 00:00:00",
      ],
    );
  };

  beforeAll(async () => {
    if (!fs.existsSync(MIGRATION)) {
      throw new Error(`Migration 139 not found at ${MIGRATION}`);
    }
    dataSource = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSource.initialize();
    // Brings the synchronize-built schema up to the real one's shape, which
    // includes applying 133 itself.
    await applyRlsPolicies(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    await cleanTables(dataSource, ["import_jobs", "budget_alerts", "users"]);
    userA = (
      await createTestUserDirect(dataSource, { email: "pre133-a@example.com" })
    ).id;
    userB = (
      await createTestUserDirect(dataSource, { email: "pre133-b@example.com" })
    ).id;
    await removeGuards();
  });

  describe("import_jobs", () => {
    it("keeps the committed job and fails the rest, without offering it as a retry", async () => {
      const committed = "aaaaaaaa-0000-4000-8000-000000000001";
      const running = "aaaaaaaa-0000-4000-8000-000000000002";
      const pending = "aaaaaaaa-0000-4000-8000-000000000003";
      // Newest first, so "keep the newest" alone would keep the wrong one --
      // the ordering has to prefer data_committed.
      await seedJob(committed, userA, {
        status: "running",
        dataCommitted: true,
        heartbeatAt: "2026-01-01 00:00:00",
        createdAt: "2026-01-01 00:00:00",
      });
      await seedJob(running, userA, {
        status: "running",
        heartbeatAt: "2026-01-03 00:00:00",
        createdAt: "2026-01-03 00:00:00",
      });
      await seedJob(pending, userA, {
        status: "pending",
        createdAt: "2026-01-04 00:00:00",
      });

      await applyMigration();

      expect(await indexExists("idx_import_jobs_one_active_per_user")).toBe(
        true,
      );
      expect((await job(committed)).status).toBe("running");

      // The two losers: failed, and each one's retryability derived from its own
      // data_committed rather than from having lost.
      for (const id of [running, pending]) {
        const row = await job(id);
        expect(row.status).toBe("failed");
        expect(row.error_key).toBe(STALLED);
        expect(row.retryable).toBe(true);
        expect(row.progress).toBeNull();
      }
    });

    it("never offers a superseded job whose data is already in the ledger", async () => {
      const keep = "bbbbbbbb-0000-4000-8000-000000000001";
      const loserWithData = "bbbbbbbb-0000-4000-8000-000000000002";
      // Both committed, so the tie-break drops one of them -- and the one
      // dropped must not be retryable, or the retry re-imports the file.
      await seedJob(keep, userA, {
        status: "running",
        dataCommitted: true,
        heartbeatAt: "2026-02-02 00:00:00",
        createdAt: "2026-02-02 00:00:00",
      });
      await seedJob(loserWithData, userA, {
        status: "pending",
        dataCommitted: true,
        createdAt: "2026-02-01 00:00:00",
      });

      await applyMigration();

      expect((await job(keep)).status).toBe("running");
      const loser = await job(loserWithData);
      expect(loser.status).toBe("failed");
      expect(loser.error_key).toBe(STALLED_AFTER_COMMIT);
      expect(loser.retryable).toBe(false);
    });

    it("leaves one user's active job alone while repairing another's", async () => {
      const aOnly = "cccccccc-0000-4000-8000-000000000001";
      const bOne = "cccccccc-0000-4000-8000-000000000002";
      const bTwo = "cccccccc-0000-4000-8000-000000000003";
      await seedJob(aOnly, userA, { status: "running" });
      await seedJob(bOne, userB, {
        status: "running",
        heartbeatAt: "2026-03-02 00:00:00",
      });
      await seedJob(bTwo, userB, { status: "pending" });

      await applyMigration();

      expect((await job(aOnly)).status).toBe("running");
      expect((await job(bOne)).status).toBe("running");
      expect((await job(bTwo)).status).toBe("failed");
    });

    it("normalizes a status the new CHECK would refuse", async () => {
      const odd = "dddddddd-0000-4000-8000-000000000001";
      await seedJob(odd, userA, { status: "aborted" });

      await applyMigration();

      expect(await constraintExists("import_jobs_status_check")).toBe(true);
      const row = await job(odd);
      expect(row.status).toBe("failed");
      expect(row.error_key).toBe(STALLED);
      expect(row.retryable).toBe(true);
    });

    it("completed and failed jobs are not active, so several may coexist", async () => {
      await seedJob("eeeeeeee-0000-4000-8000-000000000001", userA, {
        status: "completed",
      });
      await seedJob("eeeeeeee-0000-4000-8000-000000000002", userA, {
        status: "completed",
      });
      await seedJob("eeeeeeee-0000-4000-8000-000000000003", userA, {
        status: "failed",
      });

      await applyMigration();

      const [{ count }] = await dataSource.query(
        `SELECT COUNT(*)::int AS count FROM import_jobs WHERE user_id = $1`,
        [userA],
      );
      expect(count).toBe(3);
    });
  });

  describe("budget_alerts", () => {
    const seedAlert = async (
      id: string,
      userId: string,
      fields: {
        alertType: string;
        severity: string;
        categoryId?: string | null;
        isRead?: boolean;
        isEmailSent?: boolean;
        dismissed?: boolean;
        createdAt?: string;
      },
    ): Promise<void> => {
      await dataSource.query(
        `INSERT INTO budget_alerts
           (id, user_id, budget_id, budget_category_id, alert_type, severity,
            title, message, is_read, is_email_sent, period_start, created_at,
            dismissed_at)
         VALUES ($1, $2, NULL, $3, $4, $5, 'title', 'message', $6, $7,
                 DATE '2026-01-01', $8, $9)`,
        [
          id,
          userId,
          fields.categoryId ?? null,
          fields.alertType,
          fields.severity,
          fields.isRead ?? false,
          fields.isEmailSent ?? false,
          fields.createdAt ?? "2026-01-05 00:00:00",
          fields.dismissed ? "2026-01-06 00:00:00" : null,
        ],
      );
    };

    const alertIds = async (userId: string): Promise<string[]> => {
      const rows: { id: string }[] = await dataSource.query(
        `SELECT id FROM budget_alerts WHERE user_id = $1 ORDER BY id`,
        [userId],
      );
      return rows.map((r) => r.id);
    };

    it("collapses a duplicate set and keeps the row the user acted on", async () => {
      const pristine = "f0000000-0000-4000-8000-000000000001";
      const dismissed = "f0000000-0000-4000-8000-000000000002";
      const read = "f0000000-0000-4000-8000-000000000003";
      // The dismissed one is the newest, so "keep the oldest" alone would throw
      // away the acknowledgement.
      await seedAlert(pristine, userA, {
        alertType: "overspend",
        severity: "warning",
        createdAt: "2026-01-02 00:00:00",
      });
      await seedAlert(read, userA, {
        alertType: "overspend",
        severity: "warning",
        isRead: true,
        createdAt: "2026-01-03 00:00:00",
      });
      await seedAlert(dismissed, userA, {
        alertType: "overspend",
        severity: "warning",
        isRead: true,
        dismissed: true,
        createdAt: "2026-01-04 00:00:00",
      });

      await applyMigration();

      expect(await indexExists("idx_budget_alerts_fingerprint")).toBe(true);
      expect(await alertIds(userA)).toEqual([dismissed]);
    });

    it("keeps a budget-wide duplicate set too, where the category is NULL", async () => {
      // The COALESCE in the index is what makes NULL-category alerts part of the
      // key at all; without it these three would be the only unguarded ones, and
      // the repair would leave them behind.
      const first = "f1000000-0000-4000-8000-000000000001";
      await seedAlert(first, userA, {
        alertType: "income_shortfall",
        severity: "info",
        categoryId: null,
        createdAt: "2026-01-01 00:00:00",
      });
      await seedAlert("f1000000-0000-4000-8000-000000000002", userA, {
        alertType: "income_shortfall",
        severity: "info",
        categoryId: null,
        createdAt: "2026-01-02 00:00:00",
      });

      await applyMigration();

      expect(await alertIds(userA)).toEqual([first]);
    });

    it("a higher severity is a different alert, so an escalation survives", async () => {
      const warning = "f2000000-0000-4000-8000-000000000001";
      const critical = "f2000000-0000-4000-8000-000000000002";
      await seedAlert(warning, userA, {
        alertType: "overspend",
        severity: "warning",
      });
      await seedAlert(critical, userA, {
        alertType: "overspend",
        severity: "critical",
      });

      await applyMigration();

      expect((await alertIds(userA)).sort()).toEqual(
        [warning, critical].sort(),
      );
    });
  });

  /**
   * The reason both repairs are written as select-then-act over a window
   * function rather than as one-shot cleanups: a migration whose tracker INSERT
   * did not commit runs again on the next boot, and a repair that only works on
   * a dirty database would turn one startup crash into another.
   */
  it("is re-runnable: a second apply changes nothing", async () => {
    await seedJob("f3000000-0000-4000-8000-000000000001", userA, {
      status: "running",
      heartbeatAt: "2026-04-02 00:00:00",
    });
    await seedJob("f3000000-0000-4000-8000-000000000002", userA, {
      status: "pending",
    });

    await applyMigration();
    const afterFirst = await dataSource.query(
      `SELECT id, status, error_key, retryable FROM import_jobs ORDER BY id`,
    );

    await applyMigration();
    const afterSecond = await dataSource.query(
      `SELECT id, status, error_key, retryable FROM import_jobs ORDER BY id`,
    );

    expect(afterSecond).toEqual(afterFirst);
    expect(await indexExists("idx_import_jobs_one_active_per_user")).toBe(true);
    expect(await indexExists("idx_budget_alerts_fingerprint")).toBe(true);
  });
});
