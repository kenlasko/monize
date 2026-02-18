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
  let dataSource: { createQueryRunner: jest.Mock };
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
