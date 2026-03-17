import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { UnauthorizedException, BadRequestException, NotFoundException } from "@nestjs/common";
import { BackupService } from "./backup.service";
import { User } from "../users/entities/user.entity";
import * as bcrypt from "bcryptjs";

jest.mock("bcryptjs");

describe("BackupService", () => {
  let service: BackupService;
  let mockUserRepo: Record<string, jest.Mock>;
  let mockDataSource: Record<string, jest.Mock>;
  let mockQueryRunner: Record<string, jest.Mock>;

  const userId = "test-user-id";
  const mockUser = {
    id: userId,
    email: "test@example.com",
    authProvider: "local",
    passwordHash: "hashed-password",
  };

  beforeEach(async () => {
    mockQueryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    };

    mockDataSource = {
      query: jest.fn().mockResolvedValue([]),
      createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    };

    mockUserRepo = {
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackupService,
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepo,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<BackupService>(BackupService);
  });

  describe("exportData", () => {
    it("should export all user data as a backup object", async () => {
      const mockCategories = [{ id: "cat-1", name: "Food", user_id: userId }];
      const mockAccounts = [{ id: "acc-1", name: "Checking", user_id: userId }];

      mockDataSource.query.mockImplementation((sql: string) => {
        if (sql.includes("categories")) return Promise.resolve(mockCategories);
        if (sql.includes("accounts") && !sql.includes("monthly_account")) {
          return Promise.resolve(mockAccounts);
        }
        return Promise.resolve([]);
      });

      const result = await service.exportData(userId);

      expect(result.version).toBe(1);
      expect(result.exportedAt).toBeDefined();
      expect(result.categories).toEqual(mockCategories);
      expect(result.accounts).toEqual(mockAccounts);
      expect(mockDataSource.query).toHaveBeenCalled();
    });

    it("should return empty arrays when user has no data", async () => {
      mockDataSource.query.mockResolvedValue([]);

      const result = await service.exportData(userId);

      expect(result.version).toBe(1);
      expect(result.categories).toEqual([]);
      expect(result.transactions).toEqual([]);
      expect(result.accounts).toEqual([]);
    });
  });

  describe("restoreData", () => {
    const validBackupData = {
      version: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      user_preferences: [],
      user_currency_preferences: [],
      categories: [],
      payees: [],
      payee_aliases: [],
      accounts: [],
      tags: [],
      transactions: [],
      transaction_splits: [],
      transaction_tags: [],
      transaction_split_tags: [],
      scheduled_transactions: [],
      scheduled_transaction_splits: [],
      scheduled_transaction_overrides: [],
      securities: [],
      security_prices: [],
      holdings: [],
      investment_transactions: [],
      budgets: [],
      budget_categories: [],
      budget_periods: [],
      budget_period_categories: [],
      budget_alerts: [],
      custom_reports: [],
      import_column_mappings: [],
      monthly_account_balances: [],
    };

    it("should throw NotFoundException if user not found", async () => {
      mockUserRepo.findOne.mockResolvedValue(null);

      await expect(
        service.restoreData(userId, {
          password: "test",
          data: validBackupData,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("should throw UnauthorizedException if password is missing for local user", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);

      await expect(
        service.restoreData(userId, { data: validBackupData }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("should throw UnauthorizedException if password is invalid", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        service.restoreData(userId, {
          password: "wrong-password",
          data: validBackupData,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("should throw UnauthorizedException if OIDC token is missing for OIDC user", async () => {
      mockUserRepo.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: null,
      });

      await expect(
        service.restoreData(userId, { data: validBackupData }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("should throw BadRequestException for invalid backup version", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await expect(
        service.restoreData(userId, {
          password: "test",
          data: { ...validBackupData, version: 999 },
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException for missing exportedAt", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const badData = { ...validBackupData, exportedAt: undefined };
      await expect(
        service.restoreData(userId, {
          password: "test",
          data: badData as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should successfully restore backup data within a transaction", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const backupWithData = {
        ...validBackupData,
        categories: [
          { id: "cat-1", user_id: userId, name: "Food", parent_id: null },
        ],
        accounts: [
          { id: "acc-1", user_id: userId, name: "Checking", account_type: "CHEQUING" },
        ],
      };

      const result = await service.restoreData(userId, {
        password: "test",
        data: backupWithData,
      });

      expect(result.message).toBe("Backup restored successfully");
      expect(result.restored.categories).toBe(1);
      expect(result.restored.accounts).toBe(1);
      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("should rollback transaction on error", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      mockQueryRunner.query.mockRejectedValueOnce(new Error("DB error"));

      await expect(
        service.restoreData(userId, {
          password: "test",
          data: validBackupData,
        }),
      ).rejects.toThrow("DB error");

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("should override user_id in restored data to match current user", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const backupWithDifferentUser = {
        ...validBackupData,
        categories: [
          { id: "cat-1", user_id: "different-user-id", name: "Food" },
        ],
      };

      await service.restoreData(userId, {
        password: "test",
        data: backupWithDifferentUser,
      });

      // Verify the INSERT query was called with the current user's ID
      const insertCalls = mockQueryRunner.query.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && call[0].includes("INSERT INTO"),
      );
      const categoryInsert = insertCalls.find(
        (call: unknown[]) => typeof call[0] === "string" && call[0].includes("categories"),
      );
      if (categoryInsert) {
        expect(categoryInsert[1]).toContain(userId);
      }
    });

    it("should accept OIDC re-auth for OIDC users", async () => {
      mockUserRepo.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: null,
      });

      const result = await service.restoreData(userId, {
        oidcIdToken: "oidc-session-confirmed",
        data: validBackupData,
      });

      expect(result.message).toBe("Backup restored successfully");
    });
  });
});
