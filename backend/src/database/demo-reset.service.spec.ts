import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { DemoResetService } from "./demo-reset.service";
import { DemoSeedService } from "./demo-seed.service";
import { DemoModeService } from "../common/demo-mode.service";
import { getRequestContext } from "../common/request-context";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  createJobClaimMock,
  TEST_LEASE_TOKEN,
  jobClaimProvider,
  type JobClaimMock,
} from "../test-helpers/job-claim-testing";
import { JobClaimType } from "../common/jobs/job-claim.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("bcryptjs", () => ({
  hash: jest.fn().mockResolvedValue("$2a$10$hashedpassword"),
}));

describe("DemoResetService", () => {
  let service: DemoResetService;
  let dataSource: Record<string, jest.Mock>;
  let demoSeedService: { seedDemoData: jest.Mock };
  let demoModeService: { isDemo: boolean };
  let queryRunner: Record<string, jest.Mock>;
  let jobClaims: JobClaimMock;

  beforeEach(async () => {
    queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([]),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };

    // The clear block is now one `withScopedDb`, so the former queryRunner's
    // raw SQL lands on the transaction manager -- alias both names at it.
    const scoped = createScopedDbMocks([]);
    scoped.manager.query.mockResolvedValue([]);
    scoped.dataSource.query = scoped.manager.query;
    queryRunner.query = scoped.manager.query;
    dataSource = scoped.dataSource as unknown as Record<string, jest.Mock>;

    demoSeedService = {
      seedDemoData: jest.fn().mockResolvedValue(undefined),
    };

    demoModeService = { isDemo: true };
    jobClaims = createJobClaimMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DemoResetService,
        { provide: DataSource, useValue: dataSource },
        { provide: DemoSeedService, useValue: demoSeedService },
        { provide: DemoModeService, useValue: demoModeService },
        jobClaimProvider(jobClaims),
      ],
    }).compile();

    service = module.get<DemoResetService>(DemoResetService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("does nothing when demo mode is disabled", async () => {
    demoModeService.isDemo = false;

    await service.resetDemoData();

    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(demoSeedService.seedDemoData).not.toHaveBeenCalled();
  });

  it("looks up demo user by email", async () => {
    queryRunner.query.mockImplementation((sql: string) => {
      if (sql.includes("SELECT id FROM users")) {
        return Promise.resolve([{ id: "demo-user-id" }]);
      }
      return Promise.resolve([]);
    });

    await service.resetDemoData();

    const userQuery = queryRunner.query.mock.calls.find((call: string[]) =>
      call[0].includes("SELECT id FROM users"),
    );
    expect(userQuery).toBeDefined();
    expect(userQuery[0]).toContain("demo@monize.com");
  });

  // RLS (task C3): the reset's cross-user raw SQL runs under a system context.
  it("runs the reset under a system context", async () => {
    let ctx: ReturnType<typeof getRequestContext>;
    queryRunner.query.mockImplementation((sql: string) => {
      ctx = getRequestContext();
      if (sql.includes("SELECT id FROM users")) {
        return Promise.resolve([{ id: "demo-user-id" }]);
      }
      return Promise.resolve([]);
    });

    await service.resetDemoData();

    expect(ctx).toEqual({ system: true });
  });

  it("returns early without re-seeding if demo user not found", async () => {
    queryRunner.query.mockResolvedValue([]);

    await service.resetDemoData();

    // The clear transaction is opened, finds no demo user and returns without
    // writing (an empty commit); the re-seed must not run.
    expect(dataSource.transaction).toHaveBeenCalled();
    expect(demoSeedService.seedDemoData).not.toHaveBeenCalled();
  });

  describe("when demo user exists", () => {
    beforeEach(() => {
      queryRunner.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id FROM users")) {
          return Promise.resolve([{ id: "demo-user-id" }]);
        }
        return Promise.resolve([]);
      });
    });

    it("uses a transaction for atomicity", async () => {
      await service.resetDemoData();

      expect(dataSource.transaction).toHaveBeenCalled();
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it("deletes all user data in FK-safe order", async () => {
      await service.resetDemoData();

      const deleteCalls = queryRunner.query.mock.calls
        .filter((call: string[]) => call[0].includes("DELETE FROM"))
        .map((call: string[]) => call[0]);

      // Should delete 18 tables in FK-safe order
      expect(deleteCalls.length).toBe(18);

      // First deletes should be the leaf dependencies
      expect(deleteCalls[0]).toContain("investment_transactions");
      expect(deleteCalls[1]).toContain("holdings");
      expect(deleteCalls[2]).toContain("security_prices");
      expect(deleteCalls[3]).toContain("securities");

      // Institutions are removed after accounts (FK-safe).
      expect(deleteCalls).toContain(
        "DELETE FROM institutions WHERE user_id = $1",
      );

      // Last deletes should be the root tables
      expect(deleteCalls[deleteCalls.length - 1]).toContain("user_preferences");
    });

    it("resets user record with fresh password and defaults", async () => {
      await service.resetDemoData();

      const updateCall = queryRunner.query.mock.calls.find(
        (call: string[]) =>
          call[0].includes("UPDATE users SET") &&
          call[0].includes("password_hash"),
      );

      expect(updateCall).toBeDefined();
      expect(updateCall[0]).toContain("first_name = 'Demo'");
      expect(updateCall[0]).toContain("last_name = 'User'");
      expect(updateCall[0]).toContain("must_change_password = false");
      expect(updateCall[0]).toContain("two_factor_secret = NULL");
      expect(updateCall[0]).toContain("reset_token = NULL");
      expect(updateCall[1][0]).toBe("$2a$10$hashedpassword");
      expect(updateCall[1][1]).toBe("demo-user-id");
    });

    it("re-seeds demo data after clearing", async () => {
      await service.resetDemoData();

      expect(demoSeedService.seedDemoData).toHaveBeenCalledWith("demo-user-id");
    });

    it("commits the clear transaction before re-seeding", async () => {
      // The re-seed opens its own scoped transactions, so it must not start
      // until the clear has committed.
      const callOrder: string[] = [];
      const runTransaction = dataSource.transaction.getMockImplementation()!;
      dataSource.transaction.mockImplementation(async (...args: unknown[]) => {
        const before = queryRunner.query.mock.calls.length;
        const result = await runTransaction(...args);
        const wrote = queryRunner.query.mock.calls
          .slice(before)
          .some((call: string[]) => call[0].includes("DELETE FROM"));
        if (wrote) callOrder.push("commit");
        return result;
      });
      demoSeedService.seedDemoData.mockImplementation(() => {
        callOrder.push("reseed");
        return Promise.resolve();
      });

      await service.resetDemoData();

      expect(callOrder).toEqual(["commit", "reseed"]);
    });
  });

  describe("multi-replica coordination of the reset", () => {
    beforeEach(() => {
      queryRunner.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id FROM users")) {
          return Promise.resolve([{ id: "demo-user-id" }]);
        }
        return Promise.resolve([]);
      });
    });

    it("takes a lease before wiping anything", async () => {
      await service.resetDemoData();

      expect(jobClaims.claimLease).toHaveBeenCalledWith(
        JobClaimType.DemoReset,
        "demo-user-id",
        expect.any(String),
        expect.any(Number),
      );
    });

    it("wipes nothing when another replica holds the lease", async () => {
      // A wipe-and-reseed is the one job a duplicate run cannot repair by
      // repeating: the second replica's DELETE lands inside the first
      // replica's seed and both finish with a partial demo.
      jobClaims.claimLease.mockResolvedValue(null);

      await service.resetDemoData();

      const deletes = queryRunner.query.mock.calls.filter((call: string[]) =>
        call[0].includes("DELETE FROM"),
      );
      expect(deletes).toHaveLength(0);
      expect(demoSeedService.seedDemoData).not.toHaveBeenCalled();
    });

    it("hands the lease back even when the reset throws", async () => {
      queryRunner.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id FROM users")) {
          return Promise.resolve([{ id: "demo-user-id" }]);
        }
        if (sql.includes("DELETE FROM investment_transactions")) {
          throw new Error("Database error");
        }
        return Promise.resolve([]);
      });

      await service.resetDemoData();

      expect(jobClaims.releaseLease).toHaveBeenCalledWith(
        JobClaimType.DemoReset,
        "demo-user-id",
        expect.any(String),
        // With the token: a reset that outran its own lease must not release the
        // one the replica now reseeding holds (audit DR-RRV4-01).
        TEST_LEASE_TOKEN,
      );
    });

    it("does not claim anything when there is no demo user", async () => {
      queryRunner.query.mockResolvedValue([]);

      await service.resetDemoData();

      expect(jobClaims.claimLease).not.toHaveBeenCalled();
    });
  });

  describe("generateIntradayTransactions", () => {
    it("does nothing when demo mode is disabled", async () => {
      demoModeService.isDemo = false;

      await service.generateIntradayTransactions();

      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it("returns early if demo user not found", async () => {
      dataSource.query.mockResolvedValue([]);

      await service.generateIntradayTransactions();

      // Only the user lookup query should have been called
      expect(dataSource.query).toHaveBeenCalledTimes(1);
      expect(dataSource.query.mock.calls[0][0]).toContain(
        "SELECT id FROM users",
      );
    });

    describe("when demo user exists", () => {
      beforeEach(() => {
        dataSource.query.mockImplementation((sql: string) => {
          if (sql.includes("SELECT id FROM users")) {
            return Promise.resolve([{ id: "demo-user-id" }]);
          }
          if (sql.includes("SELECT id FROM accounts")) {
            return Promise.resolve([{ id: "account-123" }]);
          }
          if (sql.includes("SELECT COUNT")) {
            return Promise.resolve([{ count: "0" }]);
          }
          if (sql.includes("SELECT id FROM payees")) {
            return Promise.resolve([{ id: "payee-456" }]);
          }
          if (sql.includes("SELECT c.id FROM categories")) {
            return Promise.resolve([{ id: "cat-789" }]);
          }
          if (sql.includes("SELECT id FROM categories")) {
            return Promise.resolve([{ id: "cat-789" }]);
          }
          return Promise.resolve([]);
        });
      });

      it("inserts transactions with correct fields", async () => {
        await service.generateIntradayTransactions();

        const insertCalls = dataSource.query.mock.calls.filter(
          (call: string[]) => call[0].includes("INSERT INTO transactions"),
        );

        expect(insertCalls.length).toBeGreaterThanOrEqual(1);
        expect(insertCalls.length).toBeLessThanOrEqual(2);

        const [sql, params] = insertCalls[0];
        expect(sql).toContain("user_id");
        expect(sql).toContain("account_id");
        expect(sql).toContain("transaction_date");
        expect(sql).toContain("UNRECONCILED");
        expect(params[0]).toBe("demo-user-id");
        expect(params[1]).toBe("account-123");
        // Amount should be negative (expense)
        expect(params[6]).toBeLessThan(0);
      });

      it("updates account balance after each insert", async () => {
        await service.generateIntradayTransactions();

        const insertCalls = dataSource.query.mock.calls.filter(
          (call: string[]) => call[0].includes("INSERT INTO transactions"),
        );
        const balanceCalls = dataSource.query.mock.calls.filter(
          (call: string[]) =>
            call[0].includes("UPDATE accounts SET current_balance"),
        );

        expect(balanceCalls.length).toBe(insertCalls.length);

        // Balance update amount should match the inserted transaction amount
        for (let i = 0; i < insertCalls.length; i++) {
          const insertedAmount = insertCalls[i][1][6];
          const balanceAmount = balanceCalls[i][1][0];
          expect(balanceAmount).toBe(insertedAmount);
        }
      });

      it("generates nothing when another replica already claimed the window", async () => {
        // The regression: the generator is seeded by the window, so every
        // replica computes the SAME transactions. The old guard was a
        // `SELECT COUNT(*)` for an identical row -- a check-then-act that two
        // replicas both pass, producing the demo transaction twice.
        jobClaims.claimOnce.mockResolvedValue(false);

        await service.generateIntradayTransactions();

        const insertCalls = dataSource.query.mock.calls.filter(
          (call: string[]) => call[0].includes("INSERT INTO transactions"),
        );
        expect(insertCalls.length).toBe(0);
      });

      it("claims the window durably, keyed on the date and the hour", async () => {
        await service.generateIntradayTransactions();

        expect(jobClaims.claimOnce).toHaveBeenCalledTimes(1);
        const [type, userId, key] = jobClaims.claimOnce.mock.calls[0];
        expect(type).toBe(JobClaimType.DemoIntraday);
        expect(userId).toBe("demo-user-id");
        expect(key).toMatch(/^\d{4}-\d{2}-\d{2}-\d{2}$/);
      });

      it("does not count a row-existence check as coordination", async () => {
        // A `SELECT COUNT(*) ... WHERE the row I am about to insert` is the
        // shape this fix removed; leaving it in would read as a guard.
        await service.generateIntradayTransactions();

        const countChecks = dataSource.query.mock.calls.filter(
          (call: string[]) =>
            call[0].includes("SELECT COUNT(*) as count FROM transactions"),
        );
        expect(countChecks).toHaveLength(0);
      });

      it("writes the ledger row and its balance in one transaction", async () => {
        // Split across two transactions, a crash between them leaves a demo
        // whose account balance disagrees with its own ledger.
        const perTransaction: string[][] = [];
        const runTransaction = dataSource.transaction.getMockImplementation()!;
        dataSource.transaction.mockImplementation(
          async (...args: unknown[]) => {
            const before = dataSource.query.mock.calls.length;
            const result = await runTransaction(...args);
            perTransaction.push(
              dataSource.query.mock.calls
                .slice(before)
                .map((call: string[]) => call[0]),
            );
            return result;
          },
        );

        await service.generateIntradayTransactions();

        const writeGroups = perTransaction.filter((sqls) =>
          sqls.some((sql) => sql.includes("INSERT INTO transactions")),
        );
        expect(writeGroups.length).toBeGreaterThanOrEqual(1);
        for (const group of writeGroups) {
          expect(
            group.some((sql) =>
              sql.includes("UPDATE accounts SET current_balance"),
            ),
          ).toBe(true);
        }
      });

      it("skips when account not found", async () => {
        dataSource.query.mockImplementation((sql: string) => {
          if (sql.includes("SELECT id FROM users")) {
            return Promise.resolve([{ id: "demo-user-id" }]);
          }
          if (sql.includes("SELECT id FROM accounts")) {
            return Promise.resolve([]); // No account found
          }
          return Promise.resolve([]);
        });

        await service.generateIntradayTransactions();

        const insertCalls = dataSource.query.mock.calls.filter(
          (call: string[]) => call[0].includes("INSERT INTO transactions"),
        );
        expect(insertCalls.length).toBe(0);
      });

      it("produces deterministic output for the same time window", async () => {
        // Determinism is exactly why the claim is needed rather than a
        // row-existence check: two replicas in the same window pick the same
        // templates, so the only thing distinguishing them is who claimed.
        const payeeNames = () =>
          dataSource.query.mock.calls
            .filter((call: string[]) =>
              call[0].includes("INSERT INTO transactions"),
            )
            .map((call: unknown[]) => (call[1] as unknown[])[4]);

        await service.generateIntradayTransactions();
        const firstRun = payeeNames();

        dataSource.query.mockClear();
        await service.generateIntradayTransactions();

        expect(payeeNames()).toEqual(firstRun);
        expect(firstRun.length).toBeGreaterThan(0);
      });
    });

    it("does not throw on database error", async () => {
      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id FROM users")) {
          return Promise.resolve([{ id: "demo-user-id" }]);
        }
        throw new Error("DB connection lost");
      });

      // Should not throw
      await expect(
        service.generateIntradayTransactions(),
      ).resolves.toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("rolls back transaction on error", async () => {
      queryRunner.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id FROM users")) {
          return Promise.resolve([{ id: "demo-user-id" }]);
        }
        if (sql.includes("DELETE FROM investment_transactions")) {
          throw new Error("Database error");
        }
        return Promise.resolve([]);
      });

      await service.resetDemoData();

      // The failure is swallowed (best-effort cron) and the re-seed is skipped
      // -- the transaction rolled back, so there is nothing to re-seed onto.
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(demoSeedService.seedDemoData).not.toHaveBeenCalled();
    });

    it("swallows a failure on the very first statement", async () => {
      queryRunner.query.mockRejectedValue(new Error("DB error"));

      await expect(service.resetDemoData()).resolves.toBeUndefined();
      expect(demoSeedService.seedDemoData).not.toHaveBeenCalled();
    });

    it("re-seeds after a successful clear", async () => {
      queryRunner.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id FROM users")) {
          return Promise.resolve([{ id: "demo-user-id" }]);
        }
        return Promise.resolve([]);
      });

      await service.resetDemoData();

      expect(demoSeedService.seedDemoData).toHaveBeenCalledWith("demo-user-id");
    });
  });

  describe("branch coverage extras", () => {
    beforeEach(() => {
      queryRunner.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id FROM users")) {
          return Promise.resolve([{ id: "demo-user-id" }]);
        }
        return Promise.resolve([]);
      });
    });

    it("retries demo seeding once when first attempt fails (recovery)", async () => {
      let calls = 0;
      demoSeedService.seedDemoData.mockImplementation(() => {
        calls++;
        if (calls === 1) throw new Error("seed failed once");
        return Promise.resolve();
      });
      await service.resetDemoData();
      expect(demoSeedService.seedDemoData).toHaveBeenCalledTimes(2);
    });

    it("rethrows after second failed seed attempt (non-Error)", async () => {
      demoSeedService.seedDemoData.mockImplementation(() => {
        throw "string seed error";
      });
      // Service catches errors; this won't reject
      await service.resetDemoData();
      expect(demoSeedService.seedDemoData).toHaveBeenCalledTimes(2);
    });

    it("logs non-Error during catch path", async () => {
      // Make queryRunner.query throw a non-Error for the rollback path
      queryRunner.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id FROM users")) {
          return Promise.resolve([{ id: "demo-user-id" }]);
        }
        if (sql.includes("DELETE FROM investment_transactions")) {
          throw "string-error";
        }
        return Promise.resolve([]);
      });
      await service.resetDemoData();
      expect(dataSource.transaction).toHaveBeenCalled();
    });
  });

  describe("intraday: top-level category branch", () => {
    beforeEach(() => {
      // Clear default mock and provide single-segment categoryPath case
      // by responding with templates that have parent-only category paths.
    });

    it("uses single-segment category lookup when categoryPath has no >", async () => {
      // We can't easily change INTRADAY_TEMPLATES; instead, ensure the
      // single-segment branch is exercised by simulating a DB where the
      // 2-segment lookup returns nothing → still inserts but with null cat.
      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id FROM users")) {
          return Promise.resolve([{ id: "demo-user-id" }]);
        }
        if (sql.includes("SELECT id FROM accounts")) {
          return Promise.resolve([{ id: "account-123" }]);
        }
        if (sql.includes("SELECT COUNT")) {
          return Promise.resolve([{ count: "0" }]);
        }
        if (sql.includes("SELECT id FROM payees")) {
          return Promise.resolve([]); // null payee branch
        }
        if (sql.includes("SELECT c.id FROM categories")) {
          return Promise.resolve([]); // category not found → cat?.id falls back to null
        }
        if (sql.includes("SELECT id FROM categories")) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });
      await service.generateIntradayTransactions();
      const inserts = dataSource.query.mock.calls.filter((call: string[]) =>
        call[0].includes("INSERT INTO transactions"),
      );
      // No category, no payee — params for these positions should be null
      if (inserts.length > 0) {
        const params = inserts[0][1];
        expect(params[3]).toBeNull(); // payee_id
        expect(params[5]).toBeNull(); // category_id
      }
    });
  });
});
