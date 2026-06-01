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
import { randomUUID } from "crypto";
import { BackupService, RestoreBackupInput } from "./backup.service";
import { User } from "../users/entities/user.entity";
import { OidcService } from "../auth/oidc/oidc.service";
import { AiEncryptionService } from "../ai/ai-encryption.service";
import { encryptBackup } from "./backup-crypto.util";
import * as bcrypt from "bcryptjs";

jest.mock("bcryptjs");

function compressBackupData(data: Record<string, unknown>): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(data), "utf-8"));
}

// Parses an INSERT call captured by the query mock into a { column: value }
// map, pairing the column list in the SQL with the parameter array. Used to
// read back the (remapped) values the restore actually inserted.
function insertColumnMap(call: unknown[]): Record<string, unknown> {
  const sql = call[0] as string;
  const colMatch = sql.match(/\(([^)]*)\)\s*VALUES/i);
  if (!colMatch) return {};
  const columns = colMatch[1].split(",").map((c) => c.trim().replace(/"/g, ""));
  const values = (call[1] as unknown[]) ?? [];
  return Object.fromEntries(columns.map((col, i) => [col, values[i]]));
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

  // Known columns per table for schema validation mock. When insertRows()
  // queries information_schema.columns, the mock returns these so that
  // column-name validation does not strip legitimate backup data.
  const schemaColumns: Record<string, string[]> = {
    categories: [
      "id",
      "user_id",
      "name",
      "parent_id",
      "type",
      "icon",
      "color",
      "is_active",
      "sort_order",
      "created_at",
      "updated_at",
    ],
    accounts: [
      "id",
      "user_id",
      "name",
      "type",
      "currency_code",
      "current_balance",
      "opening_balance",
      "is_active",
      "institution",
      "account_number",
      "notes",
      "sort_order",
      "linked_account_id",
      "source_account_id",
      "scheduled_transaction_id",
      "principal_category_id",
      "interest_category_id",
      "asset_category_id",
      "interest_rate",
      "loan_amount",
      "original_term_months",
      "loan_start_date",
      "maturity_date",
      "payment_amount",
      "payment_frequency",
      "compounding_frequency",
      "amortization_months",
      "extra_payment",
      "asset_value",
      "asset_date",
      "depreciation_rate",
      "appreciation_rate",
      "created_at",
      "updated_at",
    ],
    payees: [
      "id",
      "user_id",
      "name",
      "default_category_id",
      "created_at",
      "updated_at",
    ],
    tags: ["id", "user_id", "name", "color", "created_at", "updated_at"],
    transactions: [
      "id",
      "user_id",
      "account_id",
      "amount",
      "transaction_date",
      "payee_id",
      "category_id",
      "memo",
      "is_reconciled",
      "check_number",
      "type",
      "linked_transaction_id",
      "parent_transaction_id",
      "is_split",
      "created_at",
      "updated_at",
    ],
    transaction_splits: [
      "id",
      "transaction_id",
      "amount",
      "category_id",
      "memo",
      "transfer_account_id",
      "created_at",
      "updated_at",
    ],
    transaction_tags: ["transaction_id", "tag_id"],
    transaction_split_tags: ["transaction_split_id", "tag_id"],
    securities: [
      "id",
      "user_id",
      "symbol",
      "name",
      "type",
      "exchange",
      "currency_code",
      "sector_weightings",
      "skip_price_updates",
      "data_source",
      "created_at",
      "updated_at",
    ],
    security_prices: ["id", "security_id", "date", "close_price", "created_at"],
    holdings: [
      "id",
      "user_id",
      "account_id",
      "security_id",
      "quantity",
      "cost_basis",
      "created_at",
      "updated_at",
    ],
    investment_transactions: [
      "id",
      "user_id",
      "account_id",
      "security_id",
      "type",
      "quantity",
      "price",
      "amount",
      "commission",
      "transaction_date",
      "memo",
      "created_at",
      "updated_at",
    ],
    user_preferences: [
      "id",
      "user_id",
      "key",
      "value",
      "created_at",
      "updated_at",
    ],
    user_currency_preferences: [
      "id",
      "user_id",
      "currency_code",
      "decimal_places",
      "created_at",
      "updated_at",
    ],
    scheduled_transactions: [
      "id",
      "user_id",
      "account_id",
      "amount",
      "payee_id",
      "category_id",
      "memo",
      "frequency",
      "start_date",
      "end_date",
      "next_due_date",
      "is_active",
      "type",
      "investment_security_id",
      "tag_ids",
      "created_at",
      "updated_at",
    ],
    scheduled_transaction_splits: [
      "id",
      "scheduled_transaction_id",
      "amount",
      "category_id",
      "memo",
      "transfer_account_id",
      "investment_security_id",
      "created_at",
      "updated_at",
    ],
    scheduled_transaction_overrides: [
      "id",
      "scheduled_transaction_id",
      "original_date",
      "new_date",
      "skip",
      "created_at",
      "updated_at",
    ],
    budgets: [
      "id",
      "user_id",
      "name",
      "period_type",
      "currency_code",
      "is_active",
      "created_at",
      "updated_at",
    ],
    budget_categories: [
      "id",
      "budget_id",
      "category_id",
      "amount",
      "created_at",
      "updated_at",
    ],
    budget_periods: [
      "id",
      "budget_id",
      "start_date",
      "end_date",
      "created_at",
      "updated_at",
    ],
    budget_period_categories: [
      "id",
      "budget_period_id",
      "category_id",
      "budgeted",
      "actual",
      "created_at",
      "updated_at",
    ],
    budget_alerts: [
      "id",
      "budget_id",
      "type",
      "threshold",
      "created_at",
      "updated_at",
    ],
    custom_reports: [
      "id",
      "user_id",
      "name",
      "config",
      "created_at",
      "updated_at",
    ],
    investment_reports: [
      "id",
      "user_id",
      "name",
      "description",
      "icon",
      "background_color",
      "group_by",
      "config",
      "is_favourite",
      "sort_order",
      "created_at",
      "updated_at",
    ],
    import_column_mappings: [
      "id",
      "user_id",
      "name",
      "mappings",
      "created_at",
      "updated_at",
    ],
    monthly_account_balances: [
      "id",
      "account_id",
      "year_month",
      "balance",
      "created_at",
      "updated_at",
    ],
    payee_aliases: [
      "id",
      "user_id",
      "payee_id",
      "alias",
      "created_at",
      "updated_at",
    ],
    currencies: [
      "code",
      "name",
      "symbol",
      "decimal_places",
      "is_active",
      "created_by_user_id",
      "created_at",
      "updated_at",
    ],
  };

  function mockQueryHandler(sql: string, params?: unknown[]) {
    if (typeof sql === "string" && sql.includes("information_schema.columns")) {
      // Extract table name from params (insertRows) or from the SQL itself (ensureCurrenciesExist)
      let tableName: string | undefined;
      if (Array.isArray(params) && params.length > 0) {
        tableName = params[0] as string;
      } else if (sql.includes("'currencies'")) {
        tableName = "currencies";
      }
      const cols =
        tableName && schemaColumns[tableName] ? schemaColumns[tableName] : [];
      return Promise.resolve(
        cols.map((col) => ({ column_name: col, data_type: "text" })),
      );
    }
    return Promise.resolve([]);
  }

  beforeEach(async () => {
    mockQueryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      query: jest.fn().mockImplementation(mockQueryHandler),
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
        {
          provide: OidcService,
          useValue: {
            enabled: true,
            verifyIdTokenClaims: jest.fn().mockReturnValue(true),
          },
        },
        {
          provide: AiEncryptionService,
          useValue: {
            isConfigured: jest.fn().mockReturnValue(true),
            encrypt: jest.fn((s: string) => `enc:${s}`),
            decrypt: jest.fn((s: string) =>
              s.startsWith("enc:") ? s.slice(4) : s,
            ),
          },
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

    it("should include investment_reports in the exported payload", async () => {
      const mockInvestmentReports = [
        { id: "ir-1", name: "By Symbol", user_id: userId },
      ];
      mockDataSource.query.mockImplementation((sql: string) => {
        if (sql.includes("investment_reports")) {
          return Promise.resolve(mockInvestmentReports);
        }
        return Promise.resolve([]);
      });

      const mockRes = new PassThrough();
      const resultPromise = collectGzipOutput(mockRes);
      await service.streamExport(userId, mockRes as any);
      const result = await resultPromise;

      expect(result.investment_reports).toEqual(mockInvestmentReports);
    });

    it("writes an encrypted envelope when a password is provided", async () => {
      mockDataSource.query.mockResolvedValue([]);
      const mockCategories = [{ id: "cat-1", name: "Food", user_id: userId }];
      mockDataSource.query.mockImplementation((sql: string) => {
        if (sql.includes("categories")) return Promise.resolve(mockCategories);
        return Promise.resolve([]);
      });

      const chunks: Buffer[] = [];
      const mockRes = {
        write: jest.fn((c: Buffer) => chunks.push(c)),
        end: jest.fn(),
      };
      await service.streamExport(userId, mockRes as any, "secret");

      const written = Buffer.concat(chunks);
      // Magic header check -- the file starts with MZBE
      expect(written.subarray(0, 4).toString("ascii")).toBe("MZBE");
      expect(mockRes.end).toHaveBeenCalled();
    });
  });

  describe("exportToBuffer", () => {
    it("returns gzipped JSON for unencrypted exports", async () => {
      mockDataSource.query.mockResolvedValue([]);
      const buf = await service.exportToBuffer(userId);
      // gzip magic 1f 8b
      expect(buf[0]).toBe(0x1f);
      expect(buf[1]).toBe(0x8b);
    });

    it("returns an encrypted envelope when a password is provided", async () => {
      mockDataSource.query.mockResolvedValue([]);
      const buf = await service.exportToBuffer(userId, "pw");
      expect(buf.subarray(0, 4).toString("ascii")).toBe("MZBE");
    });
  });

  describe("resolveStoredBackupPassword", () => {
    it("returns null when encryption is disabled", () => {
      const user = { ...mockUser, backupEncryptionEnabled: false } as any;
      expect(service.resolveStoredBackupPassword(user)).toBeNull();
    });

    it("returns null when no stored password exists", () => {
      const user = {
        ...mockUser,
        backupEncryptionEnabled: true,
        backupPasswordEnc: null,
      } as any;
      expect(service.resolveStoredBackupPassword(user)).toBeNull();
    });

    it("decrypts the stored password via AiEncryptionService", () => {
      const user = {
        ...mockUser,
        backupEncryptionEnabled: true,
        backupPasswordEnc: "enc:my-password",
      } as any;
      expect(service.resolveStoredBackupPassword(user)).toBe("my-password");
    });

    it("returns null and logs when decryption throws (e.g. master key rotated)", () => {
      // The mock decrypt throws when called -- this also exercises the catch
      // block that maps a thrown error to a null return value.
      const failingService = service as unknown as {
        aiEncryption: { decrypt: jest.Mock };
      };
      failingService.aiEncryption.decrypt = jest.fn(() => {
        throw new Error("bad ciphertext");
      });
      const user = {
        ...mockUser,
        id: "rotated-user",
        backupEncryptionEnabled: true,
        backupPasswordEnc: "enc:rotated",
      } as any;
      expect(service.resolveStoredBackupPassword(user)).toBeNull();
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
      investment_reports: [],
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

    it("should restore investment_reports rows and scope them to the current user", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const backupWithInvestmentReports = {
        ...validBackupData,
        investment_reports: [
          {
            id: "ir-1",
            user_id: "different-user-id",
            name: "By Symbol",
            description: null,
            icon: null,
            background_color: null,
            group_by: "SYMBOL",
            config: { columns: ["symbol"], accountIds: [] },
            is_favourite: false,
            sort_order: 0,
          },
        ],
      };

      const result = await service.restoreData(
        userId,
        makeInput({ password: "test", data: backupWithInvestmentReports }),
      );

      expect(result.restored.investmentReports).toBe(1);

      const insertCalls = mockQueryRunner.query.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "string" &&
          call[0].includes('INSERT INTO "investment_reports"'),
      );
      expect(insertCalls).toHaveLength(1);
      const inserted = insertColumnMap(insertCalls[0]);
      expect(inserted.user_id).toBe(userId);
      expect(inserted.name).toBe("By Symbol");
      expect(inserted.group_by).toBe("SYMBOL");
    });

    it("should delete existing investment_reports during restore wipe", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await service.restoreData(userId, makeInput({ password: "test" }));

      const deleteCalls = mockQueryRunner.query.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "string" &&
          call[0].includes("DELETE FROM investment_reports"),
      );
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0][1]).toEqual([userId]);
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

    it("clears scheduled-transaction references to securities before deleting securities", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await service.restoreData(userId, makeInput({ password: "test" }));

      const sql = mockQueryRunner.query.mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      const splitsFkCleared = sql.findIndex(
        (q) =>
          typeof q === "string" &&
          q.includes("UPDATE scheduled_transaction_splits") &&
          q.includes("investment_security_id = NULL"),
      );
      const schedFkCleared = sql.findIndex(
        (q) =>
          typeof q === "string" &&
          q.includes(
            "UPDATE scheduled_transactions SET investment_security_id = NULL",
          ),
      );
      const securitiesDeleted = sql.findIndex(
        (q) => typeof q === "string" && q.includes("DELETE FROM securities"),
      );

      expect(splitsFkCleared).toBeGreaterThan(-1);
      expect(schedFkCleared).toBeGreaterThan(-1);
      expect(securitiesDeleted).toBeGreaterThan(-1);
      expect(splitsFkCleared).toBeLessThan(securitiesDeleted);
      expect(schedFkCleared).toBeLessThan(securitiesDeleted);
    });

    it("defers scheduled-split investment_security_id until after securities insert", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const securityId = randomUUID();
      const schedId = randomUUID();
      const splitId = randomUUID();
      const accountId = randomUUID();
      const backupWithInvSplit = {
        ...validBackupData,
        securities: [
          { id: securityId, user_id: userId, symbol: "VEA", name: "Vanguard" },
        ],
        scheduled_transactions: [
          {
            id: schedId,
            user_id: userId,
            account_id: accountId,
            investment_security_id: securityId,
          },
        ],
        scheduled_transaction_splits: [
          {
            id: splitId,
            scheduled_transaction_id: schedId,
            amount: -5,
            investment_security_id: securityId,
          },
        ],
      };

      await service.restoreData(
        userId,
        makeInput({ password: "test", data: backupWithInvSplit }),
      );

      const insertCalls = mockQueryRunner.query.mock.calls.filter(
        (c: unknown[]) =>
          typeof c[0] === "string" && c[0].includes("INSERT INTO"),
      );
      const splitInsert = insertCalls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          c[0].includes('"scheduled_transaction_splits"'),
      );
      expect(splitInsert).toBeDefined();
      // The forward FK to securities(id) must be stripped from the INSERT.
      expect(splitInsert![0]).not.toContain("investment_security_id");

      // Primary keys are remapped to fresh UUIDs on restore, so read back the
      // ids the inserts actually used to verify the deferred UPDATE keeps the
      // security -> split relationship intact.
      const securityInsert = insertCalls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" && c[0].includes('"securities"'),
      );
      const newSecurityId = insertColumnMap(securityInsert!).id;
      const newSplitId = insertColumnMap(splitInsert!).id;
      expect(newSecurityId).not.toBe(securityId);
      expect(newSplitId).not.toBe(splitId);

      // ...and restored via a Phase-3 UPDATE keyed by the (remapped) split id.
      const update = mockQueryRunner.query.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          c[0].includes('UPDATE "scheduled_transaction_splits"') &&
          c[0].includes('"investment_security_id"'),
      );
      expect(update).toBeDefined();
      expect(update![1]).toEqual([newSecurityId, newSplitId]);
    });

    it("should defer circular FK columns and update them after all inserts", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const catParentId = randomUUID();
      const catChildId = randomUUID();
      const acc1Id = randomUUID();
      const acc2Id = randomUUID();
      const schedId = randomUUID();
      const txn1Id = randomUUID();
      const txn2Id = randomUUID();
      const backupWithFks = {
        ...validBackupData,
        categories: [
          {
            id: catParentId,
            user_id: userId,
            name: "Parent",
            parent_id: null,
          },
          {
            id: catChildId,
            user_id: userId,
            name: "Child",
            parent_id: catParentId,
          },
        ],
        accounts: [
          {
            id: acc1Id,
            user_id: userId,
            name: "Checking",
            linked_account_id: acc2Id,
            scheduled_transaction_id: schedId,
          },
          {
            id: acc2Id,
            user_id: userId,
            name: "Savings",
            linked_account_id: acc1Id,
          },
        ],
        scheduled_transactions: [
          { id: schedId, user_id: userId, account_id: acc1Id },
        ],
        transactions: [
          {
            id: txn1Id,
            user_id: userId,
            account_id: acc1Id,
            linked_transaction_id: txn2Id,
          },
          {
            id: txn2Id,
            user_id: userId,
            account_id: acc2Id,
            linked_transaction_id: txn1Id,
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
      // Ids are remapped to fresh UUIDs, so the deferred parent_id UPDATE must
      // key off the remapped ids the inserts used -- never the backup ids.
      const catRows = categoryInserts.map(insertColumnMap);
      const parent = catRows.find((r) => r.name === "Parent");
      const child = catRows.find((r) => r.name === "Child");
      expect(parent!.id).not.toBe(catParentId);
      expect(child!.id).not.toBe(catChildId);
      expect(parentIdUpdate![1]).toEqual([parent!.id, child!.id]);

      const linkedAccountUpdate = updateCalls.find(
        (call: unknown[]) =>
          typeof call[0] === "string" &&
          call[0].includes('"accounts"') &&
          call[0].includes('"linked_account_id"'),
      );
      expect(linkedAccountUpdate).toBeDefined();
    });

    it("remaps backup primary keys so a restore never reuses another user's row ids", async () => {
      // Reproduces the multi-user restore bug: UserB restoring UserA's backup
      // must NOT write using UserA's original row ids (which would collide with
      // or mutate UserA's existing rows). Every id must be remapped to a fresh
      // UUID, and all references -- FK columns and ids nested in JSONB -- must
      // be rewritten to match.
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const tagId = randomUUID();
      const catId = randomUUID();
      const acctId = randomUUID();
      const txnId = randomUUID();
      const schedId = randomUUID();
      const backup = {
        ...validBackupData,
        tags: [{ id: tagId, user_id: "other-user", name: "Bills" }],
        categories: [
          { id: catId, user_id: "other-user", name: "Food", parent_id: null },
        ],
        accounts: [{ id: acctId, user_id: "other-user", name: "Checking" }],
        transactions: [
          {
            id: txnId,
            user_id: "other-user",
            account_id: acctId,
            category_id: catId,
          },
        ],
        transaction_tags: [{ transaction_id: txnId, tag_id: tagId }],
        scheduled_transactions: [
          {
            id: schedId,
            user_id: "other-user",
            account_id: acctId,
            tag_ids: [tagId],
          },
        ],
      };

      await service.restoreData(
        userId,
        makeInput({ password: "test", data: backup }),
      );

      const backupIds = [catId, acctId, txnId, tagId, schedId];
      const writeCalls = mockQueryRunner.query.mock.calls.filter(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          (c[0].includes("INSERT INTO") || c[0].startsWith('UPDATE "')),
      );

      // No INSERT/UPDATE may reference any original backup id, even nested in a
      // serialised JSONB value.
      for (const call of writeCalls) {
        const params = (call[1] as unknown[]) ?? [];
        const flat = params.flatMap((p) => (Array.isArray(p) ? p : [p]));
        for (const id of backupIds) {
          expect(flat).not.toContain(id);
        }
        for (const p of params) {
          if (typeof p === "string") {
            for (const id of backupIds) {
              expect(p.includes(id)).toBe(false);
            }
          }
        }
      }

      // References stay internally consistent across the remap.
      const inserts = writeCalls.filter((c: unknown[]) =>
        (c[0] as string).includes("INSERT INTO"),
      );
      const findInsert = (table: string) =>
        insertColumnMap(
          inserts.find((c: unknown[]) =>
            (c[0] as string).includes(`"${table}"`),
          )!,
        );

      const acctRow = findInsert("accounts");
      const txnRow = findInsert("transactions");
      expect(acctRow.id).not.toBe(acctId);
      expect(txnRow.account_id).toBe(acctRow.id);

      const tagRow = findInsert("tags");
      const txnTagRow = findInsert("transaction_tags");
      expect(txnTagRow.tag_id).toBe(tagRow.id);
      expect(txnTagRow.transaction_id).toBe(txnRow.id);

      // The id nested in the scheduled transaction's JSONB tag_ids is remapped.
      const schedRow = findInsert("scheduled_transactions");
      expect(schedRow.tag_ids).toContain(tagRow.id as string);
    });

    it("strips sequence-backed id columns so PG auto-assigns fresh values on restore", async () => {
      // security_prices.id is BIGSERIAL. If we passed the backup's bigint id
      // through, it would either be remapped to a UUID (the original bug --
      // "invalid input syntax for type bigint") or collide on the shared
      // sequence with another user's row and be silently skipped by
      // ON CONFLICT DO NOTHING. Stripping the column lets PG assign a fresh
      // value, mirroring how UUID primary keys get remapped to fresh UUIDs.
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const securityId = randomUUID();
      mockQueryRunner.query.mockImplementation(
        (sql: string, params?: unknown[]) => {
          if (
            typeof sql === "string" &&
            sql.includes("information_schema.columns") &&
            Array.isArray(params) &&
            params[0] === "security_prices"
          ) {
            return Promise.resolve([
              {
                column_name: "id",
                data_type: "bigint",
                column_default: "nextval('security_prices_id_seq'::regclass)",
              },
              {
                column_name: "security_id",
                data_type: "uuid",
                column_default: null,
              },
              {
                column_name: "price_date",
                data_type: "date",
                column_default: null,
              },
              {
                column_name: "close_price",
                data_type: "numeric",
                column_default: null,
              },
            ]);
          }
          return mockQueryHandler(sql, params);
        },
      );

      const backup = {
        ...validBackupData,
        securities: [
          {
            id: securityId,
            user_id: userId,
            symbol: "VEA",
            name: "Vanguard",
          },
        ],
        security_prices: [
          {
            id: "5",
            security_id: securityId,
            price_date: "2024-06-01",
            close_price: 100.5,
          },
          {
            id: "6",
            security_id: securityId,
            price_date: "2024-06-02",
            close_price: 101.25,
          },
        ],
      };

      await service.restoreData(
        userId,
        makeInput({ password: "test", data: backup }),
      );

      const priceInserts = mockQueryRunner.query.mock.calls.filter(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          c[0].includes('INSERT INTO "security_prices"'),
      );
      expect(priceInserts.length).toBe(2);
      for (const call of priceInserts) {
        // id column is stripped entirely so PG assigns from the sequence.
        // Without this, the original bug remapped the bigint id to a UUID
        // and sent it into the bigint column.
        expect(call[0]).not.toContain('"id"');
        // The UUID FK to securities is still remapped to the new security id.
        const row = insertColumnMap(call);
        expect(row.security_id).not.toBe(securityId);
      }
    });

    it("does not remap non-UUID string values that happen to match a bigint id", async () => {
      // The original buildBackupIdRemap matched any string id, so a bigint
      // like "5" would land in the remap and deepRemapIds would rewrite every
      // string "5" in the backup -- including unrelated bigint values -- to
      // a UUID. The UUID-only filter prevents that.
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const acctId = randomUUID();
      const backup = {
        ...validBackupData,
        // A bigserial-style id and a non-id field with the same string value.
        // Neither should be rewritten as a UUID.
        security_prices: [
          { id: "5", security_id: acctId, price_date: "2024-06-01" },
        ],
        accounts: [
          {
            id: acctId,
            user_id: userId,
            name: "Checking",
            account_number: "5",
          },
        ],
      };

      await service.restoreData(
        userId,
        makeInput({ password: "test", data: backup }),
      );

      const acctInsert = mockQueryRunner.query.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" && c[0].includes('INSERT INTO "accounts"'),
      );
      expect(acctInsert).toBeDefined();
      const row = insertColumnMap(acctInsert!);
      // The bigint-shaped string is preserved as-is; only UUID-format ids
      // get remapped.
      expect(row.account_number).toBe("5");
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

    it("should stringify JSONB values (arrays/objects) for PostgreSQL parameters", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const sectorWeightings = [
        { sector: "Technology", weight: 0.25 },
        { sector: "Healthcare", weight: 0.15 },
      ];
      const backupWithJsonb = {
        ...validBackupData,
        securities: [
          {
            id: "sec-1",
            user_id: userId,
            symbol: "VEA",
            name: "Vanguard FTSE",
            security_type: "ETF",
            currency_code: "USD",
            is_active: true,
            sector_weightings: sectorWeightings,
          },
        ],
        scheduled_transactions: [
          {
            id: "sched-1",
            user_id: userId,
            account_id: "acc-1",
            tag_ids: ["tag-1", "tag-2"],
          },
        ],
      };

      await service.restoreData(
        userId,
        makeInput({
          password: "test",
          data: backupWithJsonb,
        }),
      );

      // Find the securities INSERT call
      const insertCalls = mockQueryRunner.query.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "string" && call[0].includes("INSERT INTO"),
      );
      const securitiesInsert = insertCalls.find(
        (call: unknown[]) =>
          typeof call[0] === "string" && call[0].includes('"securities"'),
      );
      expect(securitiesInsert).toBeDefined();
      // The sector_weightings value should be a JSON string, not a raw array
      const params = securitiesInsert![1] as unknown[];
      const jsonParam = params.find(
        (p) => typeof p === "string" && p.includes("Technology"),
      );
      expect(jsonParam).toBe(JSON.stringify(sectorWeightings));
    });

    it("should preserve created_at and updated_at timestamps from backup", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const backupWithTimestamps = {
        ...validBackupData,
        categories: [
          {
            id: "cat-1",
            user_id: userId,
            name: "Food",
            created_at: "2024-06-15T10:30:00.000Z",
          },
        ],
        transactions: [
          {
            id: "txn-1",
            user_id: userId,
            account_id: "acc-1",
            amount: 100,
            created_at: "2024-07-01T08:00:00.000Z",
            updated_at: "2024-07-02T09:00:00.000Z",
          },
        ],
      };

      await service.restoreData(
        userId,
        makeInput({ password: "test", data: backupWithTimestamps }),
      );

      const insertCalls = mockQueryRunner.query.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "string" && call[0].includes("INSERT INTO"),
      );

      // Verify categories INSERT includes created_at
      const categoryInsert = insertCalls.find(
        (call: unknown[]) =>
          typeof call[0] === "string" && call[0].includes('"categories"'),
      );
      expect(categoryInsert).toBeDefined();
      expect(categoryInsert![0]).toContain('"created_at"');
      expect(categoryInsert![1]).toContain("2024-06-15T10:30:00.000Z");

      // Verify transactions INSERT includes both created_at and updated_at
      const txnInsert = insertCalls.find(
        (call: unknown[]) =>
          typeof call[0] === "string" && call[0].includes('"transactions"'),
      );
      expect(txnInsert).toBeDefined();
      expect(txnInsert![0]).toContain('"created_at"');
      expect(txnInsert![0]).toContain('"updated_at"');
      expect(txnInsert![1]).toContain("2024-07-01T08:00:00.000Z");
      expect(txnInsert![1]).toContain("2024-07-02T09:00:00.000Z");
    });

    it("should disable updated_at triggers during deferred FK restoration", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const backupWithFks = {
        ...validBackupData,
        accounts: [
          {
            id: "acc-1",
            user_id: userId,
            name: "Checking",
            linked_account_id: "acc-2",
            updated_at: "2024-06-01T00:00:00.000Z",
          },
          {
            id: "acc-2",
            user_id: userId,
            name: "Savings",
            linked_account_id: "acc-1",
            updated_at: "2024-06-02T00:00:00.000Z",
          },
        ],
      };

      await service.restoreData(
        userId,
        makeInput({ password: "test", data: backupWithFks }),
      );

      const allCalls = mockQueryRunner.query.mock.calls.map(
        (call: unknown[]) => call[0] as string,
      );

      // Verify trigger was disabled before the UPDATE and re-enabled after
      const disableIdx = allCalls.findIndex(
        (sql) =>
          sql.includes("DISABLE TRIGGER") &&
          sql.includes("update_accounts_updated_at"),
      );
      const updateIdx = allCalls.findIndex(
        (sql) =>
          sql.includes("UPDATE") &&
          sql.includes('"accounts"') &&
          sql.includes('"linked_account_id"'),
      );
      const enableIdx = allCalls.findIndex(
        (sql) =>
          sql.includes("ENABLE TRIGGER") &&
          sql.includes("update_accounts_updated_at"),
      );

      expect(disableIdx).toBeGreaterThan(-1);
      expect(updateIdx).toBeGreaterThan(disableIdx);
      expect(enableIdx).toBeGreaterThan(updateIdx);
    });

    it("rejects OIDC users whose ID token does not match the user's oidcSubject", async () => {
      const oidcModule = {
        ...mockUser,
        authProvider: "oidc",
        passwordHash: null,
        oidcSubject: "sub-1",
      };
      mockUserRepo.findOne.mockResolvedValue(oidcModule);
      // Re-resolve OidcService from the testing module and flip verify to false.
      const oidc = (
        service as unknown as {
          oidcService: { verifyIdTokenClaims: jest.Mock };
        }
      ).oidcService;
      oidc.verifyIdTokenClaims = jest.fn().mockReturnValue(false);

      await expect(
        service.restoreData(userId, makeInput({ oidcIdToken: "bad-token" })),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("rejects backup files that decompress to a non-object", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      // Gzip a literal null, which is valid JSON but not an object.
      const nullPayload = compressBackupData(
        null as unknown as Record<string, unknown>,
      );
      await expect(
        service.restoreData(userId, {
          compressedData: nullPayload,
          password: "test",
        }),
      ).rejects.toThrow(/must be an object/);
    });

    it("executes the currency INSERT path when a user-created currency is in the backup", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      // Make the information_schema query for currencies return the column list
      // so columns aren't all stripped. Make the SELECT-existing query empty so
      // the INSERT is reached.
      mockQueryRunner.query.mockImplementation(
        (sql: string, params?: unknown[]) => {
          if (
            typeof sql === "string" &&
            sql.includes("information_schema.columns")
          ) {
            // ensureCurrenciesExist embeds the table name literally; insertRows
            // passes it via $1.
            const isCurrencies =
              sql.includes("'currencies'") ||
              (Array.isArray(params) && params[0] === "currencies");
            const cols = isCurrencies
              ? schemaColumns.currencies
              : (params && schemaColumns[params[0] as string]) || [];
            return Promise.resolve(
              cols.map((col: string) => ({
                column_name: col,
                data_type: "text",
              })),
            );
          }
          return Promise.resolve([]);
        },
      );

      const dataWithCurrency = {
        ...validBackupData,
        currencies: [
          {
            code: "XYZ",
            name: "Test Currency",
            symbol: "X",
            decimal_places: 2,
            is_active: true,
            created_by_user_id: "someone",
          },
        ],
        // ensureCurrenciesExist short-circuits unless at least one row
        // somewhere references a currency code, so add a reference.
        user_currency_preferences: [
          { user_id: userId, currency_code: "XYZ", is_active: true },
        ],
      };
      await service.restoreData(
        userId,
        makeInput({ password: "test", data: dataWithCurrency }),
      );

      const currencyInsertCalls = mockQueryRunner.query.mock.calls.filter(
        (c: unknown[]) =>
          typeof c[0] === "string" && c[0].includes('INSERT INTO "currencies"'),
      );
      expect(currencyInsertCalls.length).toBeGreaterThan(0);
    });

    it("passes native PG array values straight through (not JSON-stringified) for ARRAY columns", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      mockQueryRunner.query.mockImplementation(
        (sql: string, params?: unknown[]) => {
          if (
            typeof sql === "string" &&
            sql.includes("information_schema.columns")
          ) {
            if (
              Array.isArray(params) &&
              params[0] === "monte_carlo_scenarios"
            ) {
              return Promise.resolve([
                { column_name: "id", data_type: "uuid" },
                { column_name: "user_id", data_type: "uuid" },
                { column_name: "name", data_type: "text" },
                { column_name: "account_ids", data_type: "ARRAY" },
              ]);
            }
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        },
      );

      const dataWithMc = {
        ...validBackupData,
        monte_carlo_scenarios: [
          {
            id: "mc-1",
            user_id: userId,
            name: "S1",
            account_ids: ["acc-a", "acc-b"],
          },
        ],
      };
      await service.restoreData(
        userId,
        makeInput({ password: "test", data: dataWithMc }),
      );

      const insertCall = mockQueryRunner.query.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          c[0].includes('INSERT INTO "monte_carlo_scenarios"'),
      );
      expect(insertCall).toBeDefined();
      const values = insertCall![1] as unknown[];
      const accountIdsValue = values.find(
        (v) => Array.isArray(v) && (v as string[]).includes("acc-a"),
      );
      // The value is a JS array (not a JSON string), so the pg driver
      // serialises it as PG array syntax.
      expect(accountIdsValue).toEqual(["acc-a", "acc-b"]);
    });

    it("should accept OIDC re-auth for OIDC users", async () => {
      mockUserRepo.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: null,
        oidcSubject: "oidc-sub-123",
      });

      const result = await service.restoreData(
        userId,
        makeInput({
          oidcIdToken: "oidc-session-confirmed",
        }),
      );

      expect(result.message).toBe("Backup restored successfully");
    });

    describe("encrypted backups", () => {
      function encryptedBlob(data: Record<string, unknown>, password: string) {
        return encryptBackup(compressBackupData(data), password);
      }

      it("decrypts using the auth password when nothing more specific is provided", async () => {
        mockUserRepo.findOne.mockResolvedValue(mockUser);
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        const result = await service.restoreData(userId, {
          compressedData: encryptedBlob(validBackupData, "user-password"),
          password: "user-password",
        });
        expect(result.message).toBe("Backup restored successfully");
      });

      it("prefers the explicit backupPassword over the auth password", async () => {
        mockUserRepo.findOne.mockResolvedValue(mockUser);
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        const result = await service.restoreData(userId, {
          compressedData: encryptedBlob(validBackupData, "old-backup-password"),
          password: "new-login-password",
          backupPassword: "old-backup-password",
        });
        expect(result.message).toBe("Backup restored successfully");
      });

      it("falls back to the stored backup password (for OIDC users without auth password)", async () => {
        mockUserRepo.findOne.mockResolvedValue({
          ...mockUser,
          authProvider: "oidc",
          passwordHash: null,
          oidcSubject: "sub-1",
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:stored-bk-pw",
        });
        const result = await service.restoreData(userId, {
          compressedData: encryptedBlob(validBackupData, "stored-bk-pw"),
          oidcIdToken: "tok",
        });
        expect(result.message).toBe("Backup restored successfully");
      });

      it("throws a BACKUP_PASSWORD_REQUIRED error when no candidate decrypts", async () => {
        mockUserRepo.findOne.mockResolvedValue(mockUser);
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        await expect(
          service.restoreData(userId, {
            compressedData: encryptedBlob(validBackupData, "real-pw"),
            password: "different-pw",
          }),
        ).rejects.toMatchObject({
          response: expect.objectContaining({
            code: "BACKUP_PASSWORD_REQUIRED",
          }),
        });
      });
    });
  });
});
