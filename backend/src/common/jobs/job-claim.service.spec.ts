import { DataSource, IsNull } from "typeorm";
import {
  JOB_CLAIM_RETENTION_DAYS,
  JobClaimService,
  JobClaimType,
} from "./job-claim.service";
import { JobClaim } from "./entities/job-claim.entity";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../../test-helpers/scoped-db-testing";

jest.mock("../db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

jest.mock("../db/with-context", () => ({
  withSystemContext: jest.fn((fn: () => unknown) => fn()),
}));

/**
 * The claim's whole value is that the *database* decides who won, so these specs
 * pin down the statements and how their results are read.
 *
 * The result-reading is not incidental. A data-modifying `query` with `RETURNING`
 * comes back as `[rows, rowCount]`, and on that tuple `result.length > 0` is
 * always true -- so a naive reading makes every replica a winner and every
 * replica sends. That is precisely the bug the claim exists to prevent, which is
 * why the tuple shape is exercised here rather than assumed.
 */
describe("JobClaimService", () => {
  let service: JobClaimService;
  let manager: Record<string, jest.Mock>;
  let dataSource: DataSourceMock;
  let claimsRepo: Record<string, jest.Mock>;

  const USER = "11111111-1111-4111-8111-111111111111";
  /** A lease token as `claimLease` would have returned it. */
  const LEASE = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    claimsRepo = { delete: jest.fn().mockResolvedValue({ affected: 1 }) };
    const mocks = createScopedDbMocks([[JobClaim, claimsRepo]]);
    manager = mocks.manager;
    dataSource = mocks.dataSource;
    service = new JobClaimService(dataSource as unknown as DataSource);
  });

  describe("claimOnce", () => {
    it("inserts with ON CONFLICT DO NOTHING and no expiry", async () => {
      manager.query.mockResolvedValue([[{ id: "claim-1" }], 1]);

      const won = await service.claimOnce(
        JobClaimType.BillReminder,
        USER,
        "2026-08-03#abc",
      );

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("INSERT INTO job_claims");
      expect(sql).toContain("ON CONFLICT (claim_type, user_id, claim_key)");
      expect(sql).toContain("DO NOTHING");
      expect(sql).toContain("RETURNING id");
      expect(params).toEqual(["bill_reminder", USER, "2026-08-03#abc"]);
      expect(won).toBe(true);
    });

    it("reports the loser correctly through the RETURNING tuple", async () => {
      // `[[], 0]` -- the shape the driver hands back when nothing was inserted.
      // Read as a bare array its length is 2, i.e. "won", which is the failure
      // this assertion exists to prevent.
      manager.query.mockResolvedValue([[], 0]);

      expect(
        await service.claimOnce(JobClaimType.BillReminder, USER, "k"),
      ).toBe(false);
    });

    it("reports the winner when the driver returns bare rows", async () => {
      manager.query.mockResolvedValue([{ id: "claim-1" }]);

      expect(
        await service.claimOnce(JobClaimType.BillReminder, USER, "k"),
      ).toBe(true);
    });
  });

  describe("claimLease", () => {
    it("retakes a lease only once its own expiry has passed", async () => {
      manager.query.mockResolvedValue([[{ id: "claim-1" }], 1]);

      const won = await service.claimLease(
        JobClaimType.AiInsightGeneration,
        USER,
        "generation",
        60_000,
      );

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("DO UPDATE");
      // Both halves matter: a live lease must not be retaken, and a lease with no
      // expiry (a permanent delivery claim) must never be retaken at all.
      expect(sql).toContain("job_claims.expires_at IS NOT NULL");
      expect(sql).toContain("job_claims.expires_at < CURRENT_TIMESTAMP");
      expect(params.slice(0, 4)).toEqual([
        "ai_insight_generation",
        USER,
        "generation",
        "60000",
      ]);
      // The fifth parameter is the attempt's lease token, and it is what comes
      // back: `release` and `markDelivered` compare it, so a worker delayed past
      // its own expiry cannot write against a lease another replica retook
      // (audit DR-RRV4-01).
      expect(params[4]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(sql).toContain("lease_token = EXCLUDED.lease_token");
      expect(won).toBe(params[4]);
    });

    it("mints a distinct token per attempt", async () => {
      manager.query.mockResolvedValue([[{ lease_token: "x" }], 1]);

      const first = await service.claimLease(
        JobClaimType.BillReminder,
        USER,
        "k",
        60_000,
      );
      const second = await service.claimLease(
        JobClaimType.BillReminder,
        USER,
        "k",
        60_000,
      );

      // Two attempts on the same work are two holders, so the tokens have to
      // differ -- a shared constant would let either write against the other's
      // lease and the column would prove nothing.
      expect(first).not.toBe(second);
    });

    it("stands down when a live lease exists", async () => {
      manager.query.mockResolvedValue([[], 0]);

      expect(
        await service.claimLease(
          JobClaimType.AiInsightGeneration,
          USER,
          "generation",
          60_000,
        ),
      ).toBeNull();
    });

    it("never asks for a non-positive lease", async () => {
      manager.query.mockResolvedValue([[{ id: "c" }], 1]);

      await service.claimLease(JobClaimType.AiInsightGeneration, USER, "g", 0);

      expect(manager.query.mock.calls[0][1][3]).toBe("1");
    });

    it("never retakes a lease whose work was already delivered", async () => {
      manager.query.mockResolvedValue([[{ id: "c" }], 1]);

      await service.claimLease(JobClaimType.BillReminder, USER, "k", 60_000);

      // The expiry bounds *doing* the work; it says nothing about what has been
      // done. Without this clause a lease that expired long ago would let a later
      // run re-send something already delivered (audit RV4-006).
      expect(manager.query.mock.calls[0][0]).toContain(
        "job_claims.delivered_at IS NULL",
      );
    });
  });

  /**
   * A claim answers "may I do this now"; the delivery record answers "has this
   * been done". The second has to outlive the process that asked the first, which
   * is exactly what a pre-send `claimOnce` could not express (audit RV4-006).
   */
  describe("markDelivered", () => {
    it("records the delivery and ends the lease", async () => {
      manager.query.mockResolvedValue([[], 1]);

      await service.markDelivered(JobClaimType.BillReminder, USER, "k", LEASE);

      // The lease token is declared into the transaction GUC first, so the
      // migration-141 trigger admits this write and a previous binary's cannot.
      const [declareSql, declareParams] = manager.query.mock.calls[0];
      expect(declareSql).toContain("set_config('app.job_claim_lease_token'");
      expect(declareParams).toEqual([LEASE]);
      const [sql, params] = manager.query.mock.calls[1];
      expect(sql).toContain("SET delivered_at = CURRENT_TIMESTAMP");
      // Nothing left to protect: from here the row's job is to say the work is
      // done, and `claimLease` refuses to retake a delivered row.
      expect(sql).toContain("expires_at = NULL");
      // And it is this attempt's row, not merely this work's.
      expect(sql).toContain("lease_token = $4::uuid");
      expect(params).toEqual(["bill_reminder", USER, "k", LEASE]);
    });

    it("records nothing and says so when the lease was retaken", async () => {
      // The DR-RRV4-01 interleaving: this attempt stalled past its expiry, another
      // replica retook the lease, and this one has just finished sending. Stamping
      // `delivered_at` here would claim a delivery for the *new* holder's send, so
      // a genuine failure there would never be retried. The work stays owed
      // instead, and the log is what makes the re-send explicable.
      manager.query.mockResolvedValue([[], 0]);
      const warn = jest
        .spyOn(service["logger"], "warn")
        .mockImplementation(() => undefined);

      await service.markDelivered(JobClaimType.BillReminder, USER, "k", LEASE);

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("lease was retaken"),
      );
    });
  });

  describe("wasDelivered", () => {
    it("is true only for a row carrying a delivery timestamp", async () => {
      manager.query.mockResolvedValue([{ "1": 1 }]);

      expect(
        await service.wasDelivered(JobClaimType.BillReminder, USER, "k"),
      ).toBe(true);
      expect(manager.query.mock.calls[0][0]).toContain(
        "delivered_at IS NOT NULL",
      );
    });

    it("is false for a claimed-but-unsent window", async () => {
      // The state the fix exists for: a replica claimed and died before sending.
      // The row is there, the delivery is not, so the work is still owed.
      manager.query.mockResolvedValue([]);

      expect(
        await service.wasDelivered(JobClaimType.BillReminder, USER, "k"),
      ).toBe(false);
    });
  });

  describe("release", () => {
    it("deletes a permanent claim so a failed send can be retried", async () => {
      // No token: a `claimOnce` caller's claim *is* the fact, so there is no
      // attempt to identify and the row is addressed by the work alone -- and
      // the IS NULL predicate keeps this method off tokenized leases entirely.
      await service.releasePermanentClaim(
        JobClaimType.MortgageReminder,
        USER,
        "k",
      );

      expect(claimsRepo.delete).toHaveBeenCalledWith({
        claimType: "mortgage_reminder",
        userId: USER,
        claimKey: "k",
        leaseToken: IsNull(),
      });
    });

    it("releases only its own lease when the caller holds a token", async () => {
      await service.releaseLease(
        JobClaimType.MortgageReminder,
        USER,
        "k",
        LEASE,
      );

      // A stalled attempt releasing by work alone would free the lease the
      // replica now sending holds, leaving it with no exclusion at all
      // (audit DR-RRV4-01).
      expect(claimsRepo.delete).not.toHaveBeenCalled();
      // The token is declared into the GUC first (migration-141 trigger), then the
      // delete filters on it too.
      const [declareSql, declareParams] = manager.query.mock.calls[0];
      expect(declareSql).toContain("set_config('app.job_claim_lease_token'");
      expect(declareParams).toEqual([LEASE]);
      const [sql, params] = manager.query.mock.calls[1];
      expect(sql).toContain("DELETE FROM job_claims");
      expect(sql).toContain("lease_token = $4::uuid");
      expect(params).toEqual(["mortgage_reminder", USER, "k", LEASE]);
    });
  });

  describe("sweepOldClaims", () => {
    it("deletes only claims past the retention window", async () => {
      manager.query.mockResolvedValue([[], 3]);

      await service.sweepOldClaims();

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("DELETE FROM job_claims");
      expect(sql).toContain("claimed_at <");
      expect(params).toEqual([String(JOB_CLAIM_RETENTION_DAYS)]);
    });

    it("logs and swallows a sweep failure rather than crashing the cron", async () => {
      manager.query.mockRejectedValue(new Error("connection reset"));
      const warn = jest
        .spyOn(service["logger"], "warn")
        .mockImplementation(() => undefined);

      await expect(service.sweepOldClaims()).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("connection reset"),
      );
    });
  });
});
