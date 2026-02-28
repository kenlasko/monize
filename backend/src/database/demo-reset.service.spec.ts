import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { DemoResetService } from "./demo-reset.service";
import { DemoSeedService } from "./demo-seed.service";
import { DemoModeService } from "../common/demo-mode.service";

jest.mock("bcryptjs", () => ({
  hash: jest.fn().mockResolvedValue("$2a$10$hashedpassword"),
}));

describe("DemoResetService", () => {
  let service: DemoResetService;
  let dataSource: { createQueryRunner: jest.Mock; query: jest.Mock };
  let demoSeedService: { seedDemoData: jest.Mock };
  let demoModeService: { isDemo: boolean };
  let queryRunner: Record<string, jest.Mock>;

  beforeEach(async () => {
    queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([]),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };

    dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
      query: jest.fn().mockResolvedValue([]),
    };

    demoSeedService = {
      seedDemoData: jest.fn().mockResolvedValue(undefined),
    };

    demoModeService = { isDemo: true };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DemoResetService,
        { provide: DataSource, useValue: dataSource },
        { provide: DemoSeedService, useValue: demoSeedService },
        { provide: DemoModeService, useValue: demoModeService },
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

    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
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

  it("rolls back and returns early if demo user not found", async () => {
    queryRunner.query.mockResolvedValue([]);

    await service.resetDemoData();

    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
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

      expect(queryRunner.connect).toHaveBeenCalled();
      expect(queryRunner.startTransaction).toHaveBeenCalled();
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
    });

    it("deletes all user data in FK-safe order", async () => {
      await service.resetDemoData();

      const deleteCalls = queryRunner.query.mock.calls
        .filter((call: string[]) => call[0].includes("DELETE FROM"))
        .map((call: string[]) => call[0]);

      // Should delete 17 tables in FK-safe order
      expect(deleteCalls.length).toBe(17);

      // First deletes should be the leaf dependencies
      expect(deleteCalls[0]).toContain("investment_transactions");
      expect(deleteCalls[1]).toContain("holdings");
      expect(deleteCalls[2]).toContain("security_prices");
      expect(deleteCalls[3]).toContain("securities");

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

    it("commits transaction before re-seeding", async () => {
      const callOrder: string[] = [];
      queryRunner.commitTransaction.mockImplementation(() => {
        callOrder.push("commit");
        return Promise.resolve();
      });
      demoSeedService.seedDemoData.mockImplementation(() => {
        callOrder.push("reseed");
        return Promise.resolve();
      });

      await service.resetDemoData();

      expect(callOrder).toEqual(["commit", "reseed"]);
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

      it("skips duplicate transactions", async () => {
        dataSource.query.mockImplementation((sql: string) => {
          if (sql.includes("SELECT id FROM users")) {
            return Promise.resolve([{ id: "demo-user-id" }]);
          }
          if (sql.includes("SELECT id FROM accounts")) {
            return Promise.resolve([{ id: "account-123" }]);
          }
          if (sql.includes("SELECT COUNT")) {
            // Simulate existing transaction
            return Promise.resolve([{ count: "1" }]);
          }
          return Promise.resolve([]);
        });

        await service.generateIntradayTransactions();

        const insertCalls = dataSource.query.mock.calls.filter(
          (call: string[]) => call[0].includes("INSERT INTO transactions"),
        );
        expect(insertCalls.length).toBe(0);
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
        await service.generateIntradayTransactions();
        const firstRunInserts = dataSource.query.mock.calls
          .filter((call: string[]) =>
            call[0].includes("INSERT INTO transactions"),
          )
          .map((call: unknown[]) => (call[1] as unknown[])[4]); // payee_name

        // Reset and run again — dedup will skip, but the template selection is the same
        // Verify by checking the dedup queries use the same payee names
        dataSource.query.mockClear();
        dataSource.query.mockImplementation((sql: string) => {
          if (sql.includes("SELECT id FROM users")) {
            return Promise.resolve([{ id: "demo-user-id" }]);
          }
          if (sql.includes("SELECT id FROM accounts")) {
            return Promise.resolve([{ id: "account-123" }]);
          }
          if (sql.includes("SELECT COUNT")) {
            return Promise.resolve([{ count: "1" }]); // Already exists
          }
          return Promise.resolve([]);
        });

        await service.generateIntradayTransactions();

        const dedupPayees = dataSource.query.mock.calls
          .filter((call: string[]) => call[0].includes("SELECT COUNT"))
          .map((call: unknown[]) => (call[1] as unknown[])[2]); // payee_name

        // Same templates should be selected both times
        expect(dedupPayees).toEqual(firstRunInserts);
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

      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    });

    it("always releases the query runner", async () => {
      queryRunner.query.mockRejectedValue(new Error("DB error"));

      await service.resetDemoData();

      expect(queryRunner.release).toHaveBeenCalled();
    });

    it("releases query runner even on success", async () => {
      queryRunner.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id FROM users")) {
          return Promise.resolve([{ id: "demo-user-id" }]);
        }
        return Promise.resolve([]);
      });

      await service.resetDemoData();

      expect(queryRunner.release).toHaveBeenCalled();
    });
  });
});
