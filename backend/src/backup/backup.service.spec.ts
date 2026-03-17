import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import {
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { gzipSync, gunzipSync } from "zlib";
import { PassThrough } from "stream";
import { BackupService, RestoreBackupInput } from "./backup.service";
import { User } from "../users/entities/user.entity";
import * as bcrypt from "bcryptjs";

jest.mock("bcryptjs");

function compressBackupData(data: Record<string, unknown>): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(data), "utf-8"));
}

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

  describe("streamExport", () => {
    async function collectGzipOutput(
      mockRes: PassThrough,
    ): Promise<Record<string, unknown>> {
      const chunks: Buffer[] = [];
      for await (const chunk of mockRes) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const compressed = Buffer.concat(chunks);
      const json = gunzipSync(compressed).toString("utf-8");
      return JSON.parse(json);
    }

    it("should stream gzip-compressed JSON to the response", async () => {
      const mockCategories = [{ id: "cat-1", name: "Food", user_id: userId }];
      const mockAccounts = [{ id: "acc-1", name: "Checking", user_id: userId }];

      mockDataSource.query.mockImplementation((sql: string) => {
        if (sql.includes("categories")) return Promise.resolve(mockCategories);
        if (sql.includes("accounts") && !sql.includes("monthly_account")) {
          return Promise.resolve(mockAccounts);
        }
        return Promise.resolve([]);
      });

      const mockRes = new PassThrough();
      const resultPromise = collectGzipOutput(mockRes);
      await service.streamExport(userId, mockRes as any);
      const result = await resultPromise;

      expect(result.version).toBe(1);
      expect(result.exportedAt).toBeDefined();
      expect(result.categories).toEqual(mockCategories);
      expect(result.accounts).toEqual(mockAccounts);
      expect(mockDataSource.query).toHaveBeenCalled();
    });

    it("should stream empty arrays when user has no data", async () => {
      mockDataSource.query.mockResolvedValue([]);

      const mockRes = new PassThrough();
      const resultPromise = collectGzipOutput(mockRes);
      await service.streamExport(userId, mockRes as any);
      const result = await resultPromise;

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
      currencies: [],
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

    function makeInput(
      overrides: Partial<RestoreBackupInput> & {
        data?: Record<string, unknown>;
      } = {},
    ): RestoreBackupInput {
      const { data, ...rest } = overrides;
      return {
        compressedData: compressBackupData(data ?? validBackupData),
        ...rest,
      };
    }

    it("should throw NotFoundException if user not found", async () => {
      mockUserRepo.findOne.mockResolvedValue(null);

      await expect(
        service.restoreData(userId, makeInput({ password: "test" })),
      ).rejects.toThrow(NotFoundException);
    });

    it("should throw UnauthorizedException if password is missing for local user", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);

      await expect(service.restoreData(userId, makeInput())).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("should throw UnauthorizedException if password is invalid", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        service.restoreData(userId, makeInput({ password: "wrong-password" })),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("should throw UnauthorizedException if OIDC token is missing for OIDC user", async () => {
      mockUserRepo.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: null,
      });

      await expect(service.restoreData(userId, makeInput())).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("should throw BadRequestException for invalid backup version", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await expect(
        service.restoreData(
          userId,
          makeInput({
            password: "test",
            data: { ...validBackupData, version: 999 },
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException for missing exportedAt", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const badData = { ...validBackupData, exportedAt: undefined };
      await expect(
        service.restoreData(
          userId,
          makeInput({
            password: "test",
            data: badData as any,
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException for invalid gzip data", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await expect(
        service.restoreData(userId, {
          compressedData: Buffer.from("not-gzip-data"),
          password: "test",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException for gzip of non-JSON content", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await expect(
        service.restoreData(userId, {
          compressedData: gzipSync(Buffer.from("not json")),
          password: "test",
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
          {
            id: "acc-1",
            user_id: userId,
            name: "Checking",
            account_type: "CHEQUING",
          },
        ],
      };

      const result = await service.restoreData(
        userId,
        makeInput({
          password: "test",
          data: backupWithData,
        }),
      );

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
        service.restoreData(userId, makeInput({ password: "test" })),
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

      await service.restoreData(
        userId,
        makeInput({
          password: "test",
          data: backupWithDifferentUser,
        }),
      );

      // Verify the INSERT query was called with the current user's ID
      const insertCalls = mockQueryRunner.query.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "string" && call[0].includes("INSERT INTO"),
      );
      const categoryInsert = insertCalls.find(
        (call: unknown[]) =>
          typeof call[0] === "string" && call[0].includes("categories"),
      );
      if (categoryInsert) {
        expect(categoryInsert[1]).toContain(userId);
      }
    });

    it("should defer circular FK columns and update them after all inserts", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const backupWithFks = {
        ...validBackupData,
        categories: [
          {
            id: "cat-parent",
            user_id: userId,
            name: "Parent",
            parent_id: null,
          },
          {
            id: "cat-child",
            user_id: userId,
            name: "Child",
            parent_id: "cat-parent",
          },
        ],
        accounts: [
          {
            id: "acc-1",
            user_id: userId,
            name: "Checking",
            linked_account_id: "acc-2",
            scheduled_transaction_id: "sched-1",
          },
          {
            id: "acc-2",
            user_id: userId,
            name: "Savings",
            linked_account_id: "acc-1",
          },
        ],
        scheduled_transactions: [
          { id: "sched-1", user_id: userId, account_id: "acc-1" },
        ],
        transactions: [
          {
            id: "txn-1",
            user_id: userId,
            account_id: "acc-1",
            linked_transaction_id: "txn-2",
          },
          {
            id: "txn-2",
            user_id: userId,
            account_id: "acc-2",
            linked_transaction_id: "txn-1",
          },
        ],
      };

      await service.restoreData(
        userId,
        makeInput({ password: "test", data: backupWithFks }),
      );

      // Verify INSERTs do NOT contain deferred FK columns
      const insertCalls = mockQueryRunner.query.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "string" && call[0].includes("INSERT INTO"),
      );
      const categoryInserts = insertCalls.filter(
        (call: unknown[]) =>
          typeof call[0] === "string" && call[0].includes('"categories"'),
      );
      for (const call of categoryInserts) {
        expect(call[0]).not.toContain("parent_id");
      }

      // Verify UPDATEs restore the deferred FK columns
      const updateCalls = mockQueryRunner.query.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "string" && call[0].includes("UPDATE"),
      );
      const parentIdUpdate = updateCalls.find(
        (call: unknown[]) =>
          typeof call[0] === "string" &&
          call[0].includes('"categories"') &&
          call[0].includes('"parent_id"'),
      );
      expect(parentIdUpdate).toBeDefined();
      expect(parentIdUpdate![1]).toEqual(["cat-parent", "cat-child"]);

      const linkedAccountUpdate = updateCalls.find(
        (call: unknown[]) =>
          typeof call[0] === "string" &&
          call[0].includes('"accounts"') &&
          call[0].includes('"linked_account_id"'),
      );
      expect(linkedAccountUpdate).toBeDefined();
    });

    it("should ensure referenced currencies exist before restoring data", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      // First call to SELECT code FROM currencies returns empty (missing)
      mockQueryRunner.query.mockImplementation(
        (sql: string, _params?: unknown[]) => {
          if (
            typeof sql === "string" &&
            sql.includes("SELECT code FROM currencies")
          ) {
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        },
      );

      const backupWithCurrencies = {
        ...validBackupData,
        currencies: [
          {
            code: "MYR",
            name: "Malaysian Ringgit",
            symbol: "RM",
            decimal_places: 2,
            is_active: true,
            created_by_user_id: "other-user",
          },
        ],
        user_currency_preferences: [
          { user_id: userId, currency_code: "MYR", is_active: false },
        ],
        accounts: [
          {
            id: "acc-1",
            user_id: userId,
            name: "MYR Account",
            currency_code: "MYR",
          },
        ],
      };

      await service.restoreData(
        userId,
        makeInput({ password: "test", data: backupWithCurrencies }),
      );

      // Verify currencies INSERT was called with user-created currency
      const insertCalls = mockQueryRunner.query.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "string" &&
          call[0].includes('INSERT INTO "currencies"'),
      );
      expect(insertCalls.length).toBeGreaterThan(0);

      // Verify the created_by_user_id was overridden to current user
      const currencyInsert = insertCalls[0];
      expect(currencyInsert[1]).toContain(userId);
    });

    it("should accept OIDC re-auth for OIDC users", async () => {
      mockUserRepo.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: null,
      });

      const result = await service.restoreData(
        userId,
        makeInput({
          oidcIdToken: "oidc-session-confirmed",
        }),
      );

      expect(result.message).toBe("Backup restored successfully");
    });
  });
});
