import { Logger } from "@nestjs/common";

import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import type { AutoBackupService } from "../auto-backup.service";
import type { BackupOffsiteDispatchService } from "./backup-offsite-dispatch.service";
import { MAX_OFFSITE_ATTEMPTS } from "./backup-offsite-dispatch.service";
import {
  BackupOffsiteRetryService,
  OFFSITE_CLAIM_LEASE_MINUTES,
} from "./backup-offsite-retry.service";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

/**
 * The hourly re-attempt of off-machine copies that failed (WP6 of
 * `docs/future-plans/backup-off-machine.md`).
 *
 * What this suite can prove and what it cannot is worth stating, because the
 * difference is the reason there is an integration spec beside it. It proves the
 * sweep's *shape*: which rows it asks for, that each one is re-attempted under
 * its own owner through the one shared claim, and that a row that blows up takes
 * only itself down. It cannot prove the backoff arithmetic or the single-winner
 * claim -- both are properties of PostgreSQL, and a mocked `query` would record
 * the string and resolve (`docs/verification-contract.md`).
 * `test/integration/backup-offsite-claim.integration.spec.ts` owns those.
 */

const USER_A = "33333333-3333-4333-8333-333333333333";
const USER_B = "44444444-4444-4444-8444-444444444444";
const DIGEST = "b".repeat(64);

/** One row as the driver hands it back: snake_case, BIGINT as a string. */
const dueRow = (overrides: Record<string, unknown> = {}) => ({
  id: "row-1",
  user_id: USER_A,
  destination: "s3",
  object_key: `33/33/${USER_A}/monize-backup-daily-2026-09-14-${DIGEST.slice(0, 12)}.mzbe`,
  tier: "daily",
  digest: DIGEST,
  size_bytes: "4096",
  ...overrides,
});

describe("BackupOffsiteRetryService", () => {
  let query: jest.Mock;
  let service: BackupOffsiteRetryService;
  let claimAndPerform: jest.MockedFunction<
    BackupOffsiteDispatchService["claimAndPerform"]
  >;
  let resolveStoredBackupFolder: jest.MockedFunction<
    AutoBackupService["resolveStoredBackupFolder"]
  >;

  beforeEach(() => {
    const scoped = createScopedDbMocks();
    query = scoped.manager.query;
    query.mockResolvedValue([]);
    claimAndPerform = jest.fn().mockResolvedValue(true) as never;
    resolveStoredBackupFolder = jest
      .fn()
      .mockImplementation(
        async (userId: string) => `/data/backups/${userId}`,
      ) as never;

    service = new BackupOffsiteRetryService(
      scoped.dataSource as never,
      { claimAndPerform } as never,
      { resolveStoredBackupFolder } as never,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
    // The Logger spies below are installed per test; leaving one in place would
    // silence the next spec file's logging as well.
    jest.restoreAllMocks();
  });

  /** The sweep's statements, in the order it issued them. */
  const statements = (): { sql: string; params: unknown[] }[] =>
    query.mock.calls.map(([sql, params]) => ({
      sql: String(sql),
      params: (params ?? []) as unknown[],
    }));

  /** The one statement that selects retry candidates. */
  const selectStatement = (): { sql: string; params: unknown[] } => {
    const found = statements().find((statement) =>
      statement.sql.includes("SELECT"),
    );
    if (!found) throw new Error("the sweep issued no SELECT");
    return found;
  };

  /**
   * A `query` that answers per statement, so the expiry can return rows while
   * the selection returns none (or the other way round).
   */
  const answerBySql = (answers: {
    expire?: unknown[] | Error;
    select?: unknown[];
  }): void => {
    query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("status = 'uploading'")) {
        if (answers.expire instanceof Error) throw answers.expire;
        return answers.expire ?? [];
      }
      return answers.select ?? [];
    });
  };

  /**
   * The lease that makes a dead replica's claim reclaimable (INV-BACKUP-005's
   * crash half).
   *
   * What a mocked `query` can prove is the statement and its ordering; whether
   * PostgreSQL hands the row to exactly one of two sweeping replicas is the
   * integration spec's (`test/integration/backup-offsite-claim.integration.spec.ts`,
   * `docs/verification-contract.md`). The "below the lease" case is likewise the
   * statement's own predicate: the rows it does not match are the rows it does
   * not touch, so what is asserted here is that the predicate is the claim's age
   * against the lease and nothing wider.
   */
  describe("expiring a stale claim", () => {
    it("expires stale claims before it selects any candidate", async () => {
      await service.handleRetrySweep();

      const issued = statements();
      const [first] = issued;
      expect(first.sql).toContain("UPDATE backup_offsite_uploads");
      expect(first.sql).toContain("SET status = 'failed'");
      expect(first.sql).toContain("WHERE status = 'uploading'");
      // The claim's own age, not the row's last update: a row re-claimed inside
      // the hour has a fresh `claimed_at` and is a live upload.
      expect(first.sql).toContain("claimed_at <= now() - (INTERVAL '1 minute'");
      expect(first.params[1]).toBe(OFFSITE_CLAIM_LEASE_MINUTES);
      // The claim it is handing back never completed an attempt, so it gives the
      // attempt back too: without this, restarts during the upload window would
      // exhaust the retry budget of a destination that never actually refused.
      expect(first.sql).toContain("attempts = GREATEST(attempts - 1, 0)");
      // The selection is the statement after it, not before or instead of it.
      expect(issued[1].sql).toContain("FROM backup_offsite_uploads");
      expect(issued[1].sql).toContain("SELECT");
    });

    it("records why the row failed, in the row", async () => {
      await service.handleRetrySweep();

      expect(String(statements()[0].params[0])).toContain("claim expired");
    });

    it("leases for longer than an attempt can honestly take", async () => {
      // 5 minutes of S3 total deadline times 3 SDK attempts is the longest one
      // request may run; a lease under that would reclaim a live upload.
      expect(OFFSITE_CLAIM_LEASE_MINUTES).toBeGreaterThan(5 * 3);
    });

    it("logs how many claims it reclaimed", async () => {
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
      answerBySql({ expire: [{ id: "row-9" }, { id: "row-10" }] });

      await service.handleRetrySweep();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`reclaimed 2 copy(s)`),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`${OFFSITE_CLAIM_LEASE_MINUTES} minutes`),
      );
    });

    it("says nothing when no claim is over the lease", async () => {
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
      answerBySql({ expire: [] });

      await service.handleRetrySweep();

      expect(warn).not.toHaveBeenCalled();
      // And the sweep carried on to its own work rather than stopping there.
      expect(selectStatement().sql).toContain("FROM backup_offsite_uploads");
    });

    it("still sweeps when the expiry statement fails", async () => {
      answerBySql({ expire: new Error("db down"), select: [dueRow()] });

      await expect(service.handleRetrySweep()).resolves.toBeUndefined();

      expect(claimAndPerform).toHaveBeenCalledTimes(1);
    });
  });

  describe("which rows it asks for", () => {
    it("selects failed copies under the attempt ceiling whose backoff has elapsed", async () => {
      await service.handleRetrySweep();

      const { sql, params } = selectStatement();
      expect(sql).toContain("FROM backup_offsite_uploads");
      expect(sql).toContain("status = 'failed'");
      expect(sql).toContain("attempts < $1");
      // Doubling from one hour: 1, 2, 4, 8. Asserted as the statement, because
      // the arithmetic is the database's -- the integration spec evaluates it.
      expect(sql).toContain(
        "INTERVAL '1 hour' * power(2, GREATEST(attempts - 1, 0))",
      );
      expect(sql).toContain("ORDER BY updated_at ASC");
      expect(params[0]).toBe(MAX_OFFSITE_ATTEMPTS);
      expect(params[1]).toBeGreaterThan(0);
    });

    it("does nothing when nothing is due", async () => {
      await service.handleRetrySweep();

      expect(resolveStoredBackupFolder).not.toHaveBeenCalled();
      expect(claimAndPerform).not.toHaveBeenCalled();
    });

    it("survives a sweep whose own query fails", async () => {
      query.mockRejectedValue(new Error("db down"));

      await expect(service.handleRetrySweep()).resolves.toBeUndefined();
      expect(claimAndPerform).not.toHaveBeenCalled();
    });
  });

  describe("what it does with each row", () => {
    it("re-attempts the same bytes under the same key, through the shared claim", async () => {
      query.mockResolvedValue([dueRow()]);

      await service.handleRetrySweep();

      expect(claimAndPerform).toHaveBeenCalledTimes(1);
      expect(claimAndPerform).toHaveBeenCalledWith({
        userId: USER_A,
        destination: "s3",
        objectKey: dueRow().object_key,
        tier: "daily",
        digest: DIGEST,
        // BIGINT arrives as a string and is compared numerically downstream.
        sizeBytes: 4096,
        folder: `/data/backups/${USER_A}`,
        // Derived from the key: the row describes a copy, not a run.
        filename: "monize-backup-daily-2026-09-14.mzbe",
        origin: "automatic",
      });
    });

    it("reads the artifact from the user's current folder, not a remembered one", async () => {
      query.mockResolvedValue([dueRow()]);
      resolveStoredBackupFolder.mockResolvedValue("/mnt/moved/33/33/user");

      await service.handleRetrySweep();

      expect(resolveStoredBackupFolder).toHaveBeenCalledWith(USER_A);
      expect(claimAndPerform.mock.calls[0][0].folder).toBe(
        "/mnt/moved/33/33/user",
      );
    });

    it("takes the email destination's key as the filename unchanged", async () => {
      query.mockResolvedValue([
        dueRow({
          destination: "email",
          object_key: "monize-backup-weekly-2026-09-14.mzbe",
          tier: "weekly",
        }),
      ]);

      await service.handleRetrySweep();

      expect(claimAndPerform.mock.calls[0][0]).toMatchObject({
        destination: "email",
        filename: "monize-backup-weekly-2026-09-14.mzbe",
        tier: "weekly",
      });
    });
  });

  describe("one row's failure is one row's failure", () => {
    it("carries on after a folder that cannot be resolved", async () => {
      query.mockResolvedValue([
        dueRow({ id: "row-1", user_id: USER_A }),
        dueRow({ id: "row-2", user_id: USER_B }),
      ]);
      resolveStoredBackupFolder.mockImplementation(async (userId: string) => {
        if (userId === USER_A) throw new Error("folder outside allowed roots");
        return `/data/backups/${userId}`;
      });

      await expect(service.handleRetrySweep()).resolves.toBeUndefined();

      expect(claimAndPerform).toHaveBeenCalledTimes(1);
      expect(claimAndPerform.mock.calls[0][0].userId).toBe(USER_B);
    });

    it("carries on after a re-attempt that throws", async () => {
      query.mockResolvedValue([
        dueRow({ id: "row-1", user_id: USER_A }),
        dueRow({ id: "row-2", user_id: USER_B }),
      ]);
      claimAndPerform.mockRejectedValueOnce(new Error("pool exhausted"));

      await expect(service.handleRetrySweep()).resolves.toBeUndefined();

      expect(claimAndPerform).toHaveBeenCalledTimes(2);
    });
  });
});
