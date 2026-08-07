import { ConflictException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  USER_MAINTENANCE_CLAIM_KEY,
  USER_MAINTENANCE_LEASE_MS,
  UserMaintenanceService,
} from "./user-maintenance.service";
import { JobClaimType } from "./job-claim.service";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import {
  createJobClaimMock,
  jobClaimProvider,
  TEST_LEASE_TOKEN,
  type JobClaimMock,
} from "../../test-helpers/job-claim-testing";

jest.mock("../db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

/**
 * Three operations replace a user's whole dataset -- a backup restore, delete my
 * data, and a `.mny` import with "start fresh". Each is internally consistent;
 * two of them overlapping is not, and the import is not one transaction at all,
 * so for its duration the dataset is legitimately empty. The hourly auto-backup
 * fired into that window would save the empty dataset as today's file and then
 * rotate the last good one out to satisfy retention -- unrecoverable, and
 * nothing flags it.
 */
describe("UserMaintenanceService", () => {
  const userId = "11111111-1111-1111-1111-111111111111";

  let service: UserMaintenanceService;
  let scoped: ReturnType<typeof createScopedDbMocks>;
  let jobClaims: JobClaimMock;

  /** No import in flight and no live lease. */
  function quiet() {
    scoped.manager.query.mockResolvedValue([{ present: false }]);
  }

  beforeEach(async () => {
    scoped = createScopedDbMocks([]);
    jobClaims = createJobClaimMock();
    quiet();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserMaintenanceService,
        { provide: DataSource, useValue: scoped.dataSource },
        jobClaimProvider(jobClaims),
      ],
    }).compile();

    service = module.get(UserMaintenanceService);
  });

  describe("isUnderMaintenance", () => {
    it("counts an active import job and a live lease, in one query", async () => {
      scoped.manager.query.mockResolvedValue([{ present: true }]);

      expect(await service.isUnderMaintenance(userId)).toBe(true);

      const [sql, params] = scoped.manager.query.mock.calls[0];
      expect(sql).toContain("FROM import_jobs");
      expect(sql).toContain("status IN ('pending', 'running')");
      expect(sql).toContain("FROM job_claims");
      // An expired lease is not maintenance -- otherwise a replica killed
      // mid-restore would lock the user out of their own backups forever.
      expect(sql).toContain("expires_at > CURRENT_TIMESTAMP");
      expect(params).toEqual([
        userId,
        JobClaimType.UserMaintenance,
        USER_MAINTENANCE_CLAIM_KEY,
      ]);
    });

    it("is false when nothing is replacing the data", async () => {
      expect(await service.isUnderMaintenance(userId)).toBe(false);
    });

    it("does not read a missing row as maintenance", async () => {
      // A read that returned nothing is not "everything is fine": it would make
      // every backup skip forever. `EXISTS` always returns a row, so an empty
      // result means something else went wrong -- and reporting false there
      // matches the failure mode the callers already tolerate (they proceed).
      scoped.manager.query.mockResolvedValue([]);

      expect(await service.isUnderMaintenance(userId)).toBe(false);
    });
  });

  describe("withMaintenanceLease", () => {
    it("holds the lease across the body and gives it back", async () => {
      const order: string[] = [];
      jobClaims.claimLease.mockImplementation(async () => {
        order.push("claim");
        return TEST_LEASE_TOKEN;
      });
      jobClaims.releaseLease.mockImplementation(async () => {
        order.push("release");
      });

      const result = await service.withMaintenanceLease(
        userId,
        "backup restore",
        async () => {
          order.push("body");
          return "done";
        },
      );

      expect(result).toBe("done");
      expect(order).toEqual(["claim", "body", "release"]);
      expect(jobClaims.claimLease).toHaveBeenCalledWith(
        JobClaimType.UserMaintenance,
        userId,
        USER_MAINTENANCE_CLAIM_KEY,
        USER_MAINTENANCE_LEASE_MS,
      );
    });

    it("refuses with a 409 when another operation holds the lease", async () => {
      jobClaims.claimLease.mockResolvedValue(null);
      const body = jest.fn();

      await expect(
        service.withMaintenanceLease(userId, "restore", body),
      ).rejects.toThrow(ConflictException);
      // A refused command must not already have written.
      expect(body).not.toHaveBeenCalled();
    });

    it("refuses while an import is in flight, before taking a lease", async () => {
      // The import holds no lease of its own -- its `import_jobs` row is the
      // fact -- so the check has to be separate, and it has to come first.
      scoped.manager.query.mockResolvedValue([{ present: true }]);
      const body = jest.fn();

      await expect(
        service.withMaintenanceLease(userId, "restore", body),
      ).rejects.toThrow(ConflictException);
      expect(jobClaims.claimLease).not.toHaveBeenCalled();
      expect(body).not.toHaveBeenCalled();
    });

    it("gives the lease back when the body throws", async () => {
      await expect(
        service.withMaintenanceLease(userId, "restore", async () => {
          throw new Error("restore failed");
        }),
      ).rejects.toThrow("restore failed");

      expect(jobClaims.releaseLease).toHaveBeenCalledWith(
        JobClaimType.UserMaintenance,
        userId,
        USER_MAINTENANCE_CLAIM_KEY,
        // With the token: a restore that outran its own lease must not release the
        // lease whoever holds it now is relying on (audit DR-RRV4-01).
        TEST_LEASE_TOKEN,
      );
    });

    it("does not fail a completed operation because the release failed", async () => {
      // The lease expires anyway, so a failed release costs a delay -- turning a
      // finished restore into an error would be the worse outcome.
      jobClaims.releaseLease.mockRejectedValue(new Error("connection reset"));

      await expect(
        service.withMaintenanceLease(userId, "restore", async () => "done"),
      ).resolves.toBe("done");
    });
  });
});
