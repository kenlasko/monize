import { Test, TestingModule } from "@nestjs/testing";
import { gemConfigFingerprint } from "../strategies/gem-signal.service";
import { DataSource } from "typeorm";
import {
  UnauthorizedException,
  BadRequestException,
  Logger,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import { gzipSync, gunzipSync } from "zlib";
import { PassThrough } from "stream";
import { createHash, randomBytes, randomUUID } from "crypto";
import * as jwt from "jsonwebtoken";
import * as fs from "fs";
import * as path from "path";
import { getRequestContext } from "../common/request-context";
import { OidcReauthService } from "../auth/oidc/oidc-reauth.service";
import { BackupService, RestoreBackupInput } from "./backup.service";
import { BackupExportService } from "./backup-export.service";
import { BackupRestoreService } from "./backup-restore.service";
import { BackupAttachmentTransferService } from "./backup-attachment-transfer.service";
import { BackupRestoreDatabaseService } from "./backup-restore-database.service";
import { buildExportTableQueries } from "./export-table-queries";
import { ATTACHMENT_EXPORT_SQL } from "./export-attachments";
import { restoreProcessingGate } from "./restore-processing-gate";
import { User } from "../users/entities/user.entity";
import { AiEncryptionService } from "../ai/ai-encryption.service";
import { encryptBackup } from "./backup-crypto.util";
import * as bcrypt from "bcryptjs";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { emulatePgCursors } from "../test-helpers/pg-cursor-mock";
import {
  ATTACHMENT_STORAGE_PROVIDER,
  AttachmentStorageProvider,
} from "../attachments/storage/attachment-storage.interface";
import {
  createUserMaintenanceMock,
  userMaintenanceProvider,
  type UserMaintenanceMock,
} from "../test-helpers/job-claim-testing";

/**
 * A `PassThrough` standing in for an express `Response`, carrying the header
 * surface the real object always has.
 *
 * A bare `PassThrough` is a stream and nothing else, so a service that sets a
 * response header -- as the export does to mark an incomplete artifact -- blew up
 * on a double that a real Response could never be. Header calls are recorded so a
 * test can assert them.
 */
function responseDouble(): {
  res: import("express").Response;
  chunks: Buffer[];
  headers: Record<string, string>;
} {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  const headers: Record<string, string> = {};
  const res = Object.assign(stream, {
    setHeader: (name: string, value: string | number) => {
      headers[name] = String(value);
      return res;
    },
    getHeader: (name: string) => headers[name],
  }) as unknown as import("express").Response;
  return { res, chunks, headers };
}

/**
 * Every non-test source file in the backup module, for the source guards below.
 *
 * A guard that reads one filename is only a guard while that filename holds the
 * code -- issue #1092 moved the restore's SQL and both attachment readers out of
 * `backup.service.ts`, and a scan still pointed there would have kept passing
 * with nothing left to find. Scanning the directory means the next split cannot
 * disarm them either.
 */
function backupModuleSources(): Array<{ file: string; text: string }> {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")
        ? [full]
        : [];
    });
  return walk(__dirname).map((full) => ({
    file: path.relative(__dirname, full),
    text: fs.readFileSync(full, "utf8"),
  }));
}

/** One module source by its path relative to this directory. */
function sourceOf(
  sources: Array<{ file: string; text: string }>,
  file: string,
): string {
  const found = sources.find((source) => source.file === file);
  if (!found) throw new Error(`${file} is not in the backup module any more`);
  return found.text;
}

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

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
  let maintenance: UserMaintenanceMock;
  let mockDataSource: Record<string, jest.Mock>;
  let mockQueryRunner: Record<string, jest.Mock>;
  // Typed rather than Record<string, jest.Mock>: this is one of our own
  // interfaces, so tsc should reject a return shape the real provider cannot
  // produce (backend/CLAUDE.md, "a mock must return what the real collaborator
  // returns").
  let attachmentStorage: jest.Mocked<AttachmentStorageProvider>;
  let attachmentStorageName: string;

  /**
   * What `transaction_attachments` holds for the restoring user right now.
   *
   * The restore reads this before the destructive delete to decide whether the
   * uploader is entitled to read an external source object -- the uploaded file
   * cannot establish that on its own. Leaving it empty is the "you do not own
   * that object" case, which is the default for every test that does not
   * deliberately seed ownership.
   */
  let ownedAttachments: Array<{
    id: string;
    storage_provider: string;
    byte_size: number;
    sha256: string | null;
  }>;

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
      "institution_id",
      "account_number",
      "notes",
      "sort_order",
      "linked_account_id",
      "linked_loan_account_id",
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
    institutions: [
      "id",
      "user_id",
      "name",
      "website",
      "country",
      "logo_data",
      "logo_content_type",
      "has_logo",
      "logo_fetched_at",
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
    gem_strategies: [
      "id",
      "user_id",
      "name",
      "cadence",
      "lookback_months",
      "created_at",
      "updated_at",
    ],
    gem_strategy_assets: [
      "id",
      "user_id",
      "strategy_id",
      "role",
      "security_id",
      "created_at",
      "updated_at",
    ],
    gem_strategy_signals: [
      "id",
      "user_id",
      "strategy_id",
      "evaluated_on",
      "config_fingerprint",
      "algorithm_version",
      "created_at",
      "updated_at",
    ],
    transaction_attachments: [
      "id",
      "user_id",
      "transaction_id",
      "filename",
      "content_type",
      "byte_size",
      "sha256",
      "storage_provider",
      "storage_key",
      "created_at",
    ],
    attachment_blobs: ["attachment_id", "data"],
  };

  function mockQueryHandler(sql: string, params?: unknown[]) {
    if (
      typeof sql === "string" &&
      sql.includes("FROM transaction_attachments") &&
      sql.includes("storage_provider, byte_size")
    ) {
      // The ownership read. Scoped by user_id in the real query, so the mock
      // answers only for the ids the service asked about.
      const ids = Array.isArray(params) ? ((params[1] as string[]) ?? []) : [];
      return Promise.resolve(
        ownedAttachments.filter((row) => ids.includes(row.id)),
      );
    }
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
        cols.map((col) => ({
          column_name: col,
          data_type: col === "logo_data" ? "bytea" : "text",
        })),
      );
    }
    return Promise.resolve([]);
  }

  // Signing key for the re-authentication artifacts below. The service reads it
  // fresh from the environment, so a spec that mints one has to supply it.
  const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
  const SPEC_JWT_SECRET = "spec-jwt-secret-of-at-least-32-characters";

  beforeAll(() => {
    process.env.JWT_SECRET = SPEC_JWT_SECRET;
  });

  afterAll(() => {
    if (ORIGINAL_JWT_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  });

  /**
   * A genuine artifact for the restore action, minted the way the OIDC callback
   * does. Deliberately not a literal: the defect P2-005 fixed was that any
   * non-empty string was accepted, so a fixture string would keep this spec green
   * if the verification were removed again.
   */
  function oidcArtifact(
    purpose: Parameters<OidcReauthService["issue"]>[1] = "restore-backup",
    forUser = userId,
  ): string {
    return new OidcReauthService().issue(forUser, purpose);
  }

  beforeEach(async () => {
    mockUserRepo = {
      findOne: jest.fn(),
    };
    ownedAttachments = [];

    // Export reads and the restore transaction now both run through
    // `withScopedDb`, so the former QueryRunner is the transaction's
    // EntityManager -- `mockQueryRunner.query` and `mockDataSource.query` are
    // the same jest.fn the manager exposes, keeping the assertions below
    // pointed at the same statements.
    maintenance = createUserMaintenanceMock();
    const scoped = createScopedDbMocks([[User, mockUserRepo as never]]);
    scoped.manager.query.mockImplementation(mockQueryHandler);
    // The export reads large tables through a database cursor, so what reaches
    // the manager is `DECLARE ... CURSOR FOR <the query>` followed by `FETCH`
    // (issue #1070). The emulation unwraps that and hands the inner SELECT to
    // the same jest.fn every spec below configures and asserts against -- so a
    // test that mocks `sql.includes("FROM accounts")` still answers, and
    // `mock.calls` still records the query rather than the cursor plumbing.
    const select = scoped.manager.query;
    scoped.manager.query = jest.fn(
      emulatePgCursors((sql, params) => select(sql, params)),
    ) as jest.Mock;
    scoped.dataSource.query = select;
    mockQueryRunner = { query: select };
    mockDataSource = scoped.dataSource as unknown as Record<string, jest.Mock>;

    // `name` is readonly on the real provider (it is persisted into
    // transaction_attachments.storage_provider), so the double exposes it as a
    // getter over a mutable local rather than a writable field -- tsc rejects
    // the assignment, which is the point of typing the mock.
    attachmentStorageName = "database";
    attachmentStorage = {
      get name() {
        return attachmentStorageName;
      },
      save: jest.fn().mockResolvedValue(undefined),
      load: jest.fn().mockRejectedValue(new Error("no such object")),
      delete: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AttachmentStorageProvider>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        // Real components, not doubles. `BackupService` is a facade over the
        // four issue #1092 split it into, and a double for any of them would
        // make every assertion below an assertion about the double. What is
        // mocked stays what it always was: the DataSource and the object store.
        BackupService,
        BackupExportService,
        BackupRestoreService,
        BackupAttachmentTransferService,
        BackupRestoreDatabaseService,
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
        // Real instance, not a double: its whole job is cryptographic
        // verification, and a mock that always accepts would make every
        // re-authentication assertion vacuous -- which is how the sentinel
        // survived (P2-005).
        OidcReauthService,
        userMaintenanceProvider(maintenance),
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
        {
          provide: ATTACHMENT_STORAGE_PROVIDER,
          useValue: attachmentStorage,
        },
      ],
    }).compile();

    service = module.get<BackupService>(BackupService);
  });

  /**
   * A backup has to be one snapshot of the database. Each table query used to
   * open its own short transaction, so the export observed a different committed
   * state per table: create an account and a transaction for it between the
   * `accounts` query and the `transactions` query and the artifact holds the
   * transaction without its account -- valid gzip, valid envelope, and a restore
   * that fails on `transactions.account_id`.
   */
  describe("export snapshot", () => {
    it.each([
      [
        "streamExport",
        async (s: BackupService) => {
          const res = new PassThrough();
          res.resume();
          await s.streamExport(
            userId,
            res as unknown as import("express").Response,
          );
        },
      ],
      [
        "exportToBuffer",
        async (s: BackupService) => {
          await s.exportToBuffer(userId);
        },
      ],
      [
        "collectRawExport",
        async (s: BackupService) => {
          await s.collectRawExport(userId);
        },
      ],
    ])(
      "reads every table in one REPEATABLE READ transaction (%s)",
      async (_name, run) => {
        mockDataSource.transaction.mockClear();

        await run(service);

        const isolationLevels = mockDataSource.transaction.mock.calls.map(
          ([first]) => (typeof first === "string" ? first : undefined),
        );
        // Exactly one transaction, and it fixes its snapshot up front. READ
        // COMMITTED would not do even as a single transaction: it takes a fresh
        // snapshot per statement, which is the same defect with fewer transactions.
        expect(isolationLevels).toEqual(["REPEATABLE READ"]);
      },
    );
  });

  /**
   * Currencies are shared: any user may activate a code another user defined.
   * Selecting them by `created_by_user_id` exported the references without the
   * definition, so restoring onto a fresh instance invented name, symbol and
   * decimal places -- `PTS / Family Points / * / 0 decimals` came back as
   * `PTS / PTS / PTS / 2 decimals`, and a balance of 7 rendered `PTS 7.00`
   * instead of `*7`. Same stored amount, different meaning.
   */
  describe("currency export selection", () => {
    it("selects by what the user's data references, not by who created it", () => {
      // The list is module-level data now (issue #1092), so this reads it
      // directly instead of reaching through a cast into a private method.
      const sql = buildExportTableQueries(async function* () {}).find(
        (q) => q.key === "currencies",
      )!.sql;

      expect(sql).toContain("currency_codes_referenced_by_user($1)");
      // Rows the user created are still exported even when nothing references
      // them yet, so a currency defined and not yet used survives a round trip.
      expect(sql).toContain("created_by_user_id = $1");
      // The referencing columns must not be spelled out here: that list has
      // drifted twice already (currencies/currency-references.spec.ts).
      expect(sql).not.toMatch(/FROM accounts/);
    });
  });

  /**
   * The export half of F3R5-001. Only `database`-provider bytes used to travel;
   * `local` and `s3` metadata went out with the bytes left behind in a volume or
   * a bucket, which the restore could only read while the target database still
   * held the matching row. Now every provider's bytes are in the artifact.
   */
  describe("external attachment bytes in the artifact", () => {
    const A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const A_BYTES = Buffer.from("receipt-a");
    const B_BYTES = Buffer.from("receipt-b-longer");

    /** Answers the metadata sweep the augmentation runs, and nothing else. */
    function storeHolds(
      rows: Array<{ id: string; provider: string }>,
      objects: Record<string, Buffer>,
    ) {
      mockDataSource.query.mockImplementation((sql: string) => {
        if (
          String(sql).includes("FROM transaction_attachments") &&
          String(sql).includes("storage_provider, byte_size")
        ) {
          return Promise.resolve(
            rows.map((row) => ({
              id: row.id,
              storage_provider: row.provider,
              byte_size: (objects[row.id]?.length ?? 0).toString(),
              sha256: "",
            })),
          );
        }
        return mockQueryHandler(sql);
      });
      attachmentStorage.load.mockImplementation(async (key: string) => {
        const bytes = objects[key];
        if (!bytes) throw new Error(`no such object: ${key}`);
        return bytes;
      });
    }

    async function exported(): Promise<Record<string, unknown>> {
      const { buffer } = await service.exportToBuffer(userId);
      return JSON.parse(gunzipSync(buffer).toString("utf-8"));
    }

    it("carries every external object it can read", async () => {
      attachmentStorageName = "local";
      storeHolds(
        [
          { id: A_ID, provider: "local" },
          { id: B_ID, provider: "local" },
        ],
        { [A_ID]: A_BYTES, [B_ID]: B_BYTES },
      );

      const result = await exported();

      expect(result.attachment_blobs).toEqual([
        { attachment_id: A_ID, data: A_BYTES.toString("base64") },
        { attachment_id: B_ID, data: B_BYTES.toString("base64") },
      ]);
    });

    it("reads nothing from the store on a database-provider deployment", async () => {
      // Those bytes are already in `attachment_blobs`; there is no object store.
      attachmentStorageName = "database";
      storeHolds([{ id: A_ID, provider: "database" }], { [A_ID]: A_BYTES });

      await exported();

      expect(attachmentStorage.load).not.toHaveBeenCalled();
    });

    it("skips a row written by a provider this runtime cannot address", async () => {
      attachmentStorageName = "local";
      storeHolds([{ id: A_ID, provider: "s3" }], { [A_ID]: A_BYTES });

      const result = await exported();

      expect(attachmentStorage.load).not.toHaveBeenCalled();
      expect(result.attachment_blobs).toEqual([]);
    });

    it("finishes the export when one object cannot be read", async () => {
      // The ledger is the point of a backup. Refusing the whole file over an
      // unreadable receipt would leave the user with nothing at all.
      attachmentStorageName = "local";
      storeHolds(
        [
          { id: A_ID, provider: "local" },
          { id: B_ID, provider: "local" },
        ],
        { [B_ID]: B_BYTES },
      );

      const result = await exported();

      expect(result.attachment_blobs).toEqual([
        { attachment_id: B_ID, data: B_BYTES.toString("base64") },
      ]);
    });

    /**
     * F3R6-002: the object must match the size and hash the server recorded, or
     * the export is packaging bytes it knows the restore will refuse. Export is
     * the last moment to see the discrepancy -- afterwards the user believes the
     * receipt is safe in the artifact.
     */
    function storeHoldsWithMetadata(
      rows: Array<{
        id: string;
        provider: string;
        byte_size: number;
        sha256: string;
      }>,
      objects: Record<string, Buffer>,
    ) {
      const metadataRows = () =>
        rows.map((row) => ({
          id: row.id,
          user_id: userId,
          storage_provider: row.provider,
          byte_size: String(row.byte_size),
          sha256: row.sha256,
        }));
      mockDataSource.query.mockImplementation((sql: string) => {
        // Both the augment's metadata sweep and the `transaction_attachments`
        // table query resolve to the same rows in production; the completeness
        // check reads the table query, so answer both here.
        if (
          String(sql).includes("FROM transaction_attachments") &&
          !String(sql).includes("attachment_blobs")
        ) {
          return Promise.resolve(metadataRows());
        }
        return mockQueryHandler(sql);
      });
      attachmentStorage.load.mockImplementation(async (key: string) => {
        const bytes = objects[key];
        if (!bytes) throw new Error(`no such object: ${key}`);
        return bytes;
      });
    }

    it("omits an object whose stored bytes are the wrong size", async () => {
      attachmentStorageName = "local";
      const good = Buffer.from("intact-object");
      storeHoldsWithMetadata(
        [
          // A_ID's recorded size is a byte longer than the object on disk: the
          // source was truncated out from under its row.
          {
            id: A_ID,
            provider: "local",
            byte_size: A_BYTES.length + 1,
            sha256: "",
          },
          {
            id: B_ID,
            provider: "local",
            byte_size: good.length,
            sha256: createHash("sha256").update(good).digest("hex"),
          },
        ],
        { [A_ID]: A_BYTES, [B_ID]: good },
      );

      const result = await exported();

      // The corrupt one is dropped; the intact one still travels.
      expect(result.attachment_blobs).toEqual([
        { attachment_id: B_ID, data: good.toString("base64") },
      ]);
    });

    it("omits an object whose stored bytes fail their recorded checksum", async () => {
      attachmentStorageName = "local";
      storeHoldsWithMetadata(
        [
          {
            id: A_ID,
            provider: "local",
            byte_size: A_BYTES.length,
            // Right size, wrong hash: the bytes were replaced, not truncated.
            sha256: createHash("sha256")
              .update(Buffer.from("something else entirely!"))
              .digest("hex"),
          },
        ],
        { [A_ID]: A_BYTES },
      );

      const result = await exported();

      expect(result.attachment_blobs).toEqual([]);
    });

    it("carries an object that matches its recorded size and hash", async () => {
      // The discriminating half: the same wiring, honest metadata, and it travels.
      attachmentStorageName = "local";
      storeHoldsWithMetadata(
        [
          {
            id: A_ID,
            provider: "local",
            byte_size: A_BYTES.length,
            sha256: createHash("sha256").update(A_BYTES).digest("hex"),
          },
        ],
        { [A_ID]: A_BYTES },
      );

      const result = await exported();

      expect(result.attachment_blobs).toEqual([
        { attachment_id: A_ID, data: A_BYTES.toString("base64") },
      ]);
    });

    /**
     * F3R7-001: omitting an attachment's bytes does not silently produce a
     * "successful" backup. The buffer is still written -- the ledger is captured
     * -- but the completeness report says it is not a complete backup of those
     * attachments, and the auto-backup path uses that to refuse promotion and
     * retention.
     */
    describe("completeness report", () => {
      it("reports complete when every object is present and consistent", async () => {
        attachmentStorageName = "local";
        storeHoldsWithMetadata(
          [
            {
              id: A_ID,
              provider: "local",
              byte_size: A_BYTES.length,
              sha256: createHash("sha256").update(A_BYTES).digest("hex"),
            },
          ],
          { [A_ID]: A_BYTES },
        );

        const { report } = await service.exportToBuffer(userId);

        expect(report.complete).toBe(true);
        expect(report.expectedAttachments).toBe(1);
        expect(report.includedAttachments).toBe(1);
        expect(report.missingAttachments).toBe(0);
      });

      it("reports incomplete when an external object cannot be read", async () => {
        attachmentStorageName = "local";
        storeHoldsWithMetadata(
          [{ id: A_ID, provider: "local", byte_size: 9, sha256: "" }],
          {}, // the object is not in the store
        );

        const { report } = await service.exportToBuffer(userId);

        expect(report.complete).toBe(false);
        expect(report.expectedAttachments).toBe(1);
        expect(report.includedAttachments).toBe(0);
        expect(report.missingAttachments).toBe(1);
      });

      it("reports incomplete when an external object fails its checksum", async () => {
        attachmentStorageName = "local";
        storeHoldsWithMetadata(
          [
            {
              id: A_ID,
              provider: "local",
              byte_size: A_BYTES.length,
              sha256: createHash("sha256")
                .update(Buffer.from("different"))
                .digest("hex"),
            },
          ],
          { [A_ID]: A_BYTES },
        );

        const { report } = await service.exportToBuffer(userId);

        expect(report.complete).toBe(false);
        expect(report.missingAttachments).toBe(1);
      });

      /**
       * F3RB-001 (issue #1069): the claim has to be inside the document, not
       * only in the settings row of the instance that wrote it. A settings row
       * does not travel with a copied artifact, does not survive a restart on
       * another machine, and says nothing at all about a file found in a
       * directory rescan.
       */
      it("records its own completeness inside the artifact when incomplete", async () => {
        attachmentStorageName = "local";
        storeHoldsWithMetadata(
          [{ id: A_ID, provider: "local", byte_size: 9, sha256: "" }],
          {},
        );

        const result = await exported();

        expect(result.completeness).toEqual({
          complete: false,
          expectedAttachments: 1,
          includedAttachments: 0,
          missingAttachments: 1,
          inconsistentAttachments: 0,
        });
      });

      it("records its own completeness inside the artifact when complete", async () => {
        // "This file says it is complete" and "this file says nothing" are
        // different facts about a recovered artifact, so the claim is written
        // either way.
        attachmentStorageName = "local";
        storeHoldsWithMetadata(
          [
            {
              id: A_ID,
              provider: "local",
              byte_size: A_BYTES.length,
              sha256: createHash("sha256").update(A_BYTES).digest("hex"),
            },
          ],
          { [A_ID]: A_BYTES },
        );

        const result = await exported();

        expect(result.completeness).toEqual(
          expect.objectContaining({ complete: true, includedAttachments: 1 }),
        );
      });

      it("records completeness in the streamed artifact too", async () => {
        // The streaming path assembles its own JSON, so it is a second writer of
        // the envelope and can lose the field on its own.
        attachmentStorageName = "local";
        storeHoldsWithMetadata(
          [{ id: A_ID, provider: "local", byte_size: 9, sha256: "" }],
          {},
        );
        // `responseDouble` rather than a bare PassThrough: an incomplete export
        // sets headers before the first byte, so a double without `setHeader`
        // would fail for a reason that has nothing to do with the envelope.
        const { res, chunks } = responseDouble();
        const ended = new Promise<void>((resolve) =>
          (res as unknown as PassThrough).once("end", () => resolve()),
        );

        await service.streamExport(userId, res);
        await ended;

        const streamed = JSON.parse(
          gunzipSync(Buffer.concat(chunks)).toString("utf-8"),
        );
        expect(streamed.completeness).toEqual(
          expect.objectContaining({
            complete: false,
            missingAttachments: 1,
          }),
        );
      });

      it("marks an incomplete plain download in the response, before any bytes (F3RB-004)", async () => {
        // The backend knew the artifact could not restore everything it names and
        // still sent an ordinary 200 with the ordinary filename, so the UI showed
        // an ordinary success -- and a user could delete the source system on the
        // strength of it. The streaming path is the hard half: the answer has to
        // be known before the first byte, because nothing can be added after.
        attachmentStorageName = "local";
        storeHoldsWithMetadata(
          [
            {
              id: A_ID,
              provider: "local",
              byte_size: A_BYTES.length,
              sha256: createHash("sha256").update(A_BYTES).digest("hex"),
            },
          ],
          {},
        );
        const { res, headers, chunks } = responseDouble();
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="monize-backup-2026-08-05.json.gz"',
        );

        await service.streamExport(userId, res);

        expect(headers["X-Backup-Complete"]).toBe("false");
        expect(headers["X-Backup-Attachments-Expected"]).toBe("1");
        expect(headers["X-Backup-Attachments-Missing"]).toBe("1");
        // The filename carries the warning too: a header is invisible six months
        // later on a disk, a filename is not.
        expect(headers["Content-Disposition"]).toContain("-INCOMPLETE.json.gz");
        // The bytes are still sent: a partial artifact beats no artifact.
        expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
      });

      it("marks an incomplete encrypted download in the response (F3RB-004)", async () => {
        attachmentStorageName = "local";
        storeHoldsWithMetadata(
          [
            {
              id: A_ID,
              provider: "local",
              byte_size: A_BYTES.length,
              sha256: createHash("sha256").update(A_BYTES).digest("hex"),
            },
          ],
          {},
        );
        const { res, headers } = responseDouble();
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="monize-backup-2026-08-05.mzbe"',
        );

        await service.streamExport(userId, res, "backup-secret");

        expect(headers["X-Backup-Complete"]).toBe("false");
        expect(headers["Content-Disposition"]).toContain("-INCOMPLETE.mzbe");
      });

      it("leaves a complete download's response untouched", async () => {
        attachmentStorageName = "local";
        storeHoldsWithMetadata(
          [
            {
              id: A_ID,
              provider: "local",
              byte_size: A_BYTES.length,
              sha256: createHash("sha256").update(A_BYTES).digest("hex"),
            },
          ],
          { [A_ID]: A_BYTES },
        );
        const { res, headers } = responseDouble();
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="monize-backup-2026-08-05.json.gz"',
        );

        await service.streamExport(userId, res);

        expect(headers["X-Backup-Complete"]).toBeUndefined();
        expect(headers["Content-Disposition"]).not.toContain("INCOMPLETE");
      });

      /**
       * The database provider's completeness is now judged from a digest
       * Postgres computes (`octet_length` + `sha256` over the column) rather
       * than from the base64 the artifact carries -- the verdict has to exist
       * before the first byte of a download, and pulling every blob onto the
       * heap to reach it is the memory defect issue #1070 closed. So the double
       * answers two queries: the metadata sweep, and the digest sweep.
       */
      function databaseProviderHolds(
        metadata: Record<string, unknown>,
        digest: Record<string, unknown> | null,
      ) {
        mockDataSource.query.mockImplementation((sql: string) => {
          const text = String(sql);
          if (
            text.includes("FROM transaction_attachments") &&
            !text.includes("attachment_blobs")
          ) {
            return Promise.resolve([metadata]);
          }
          if (text.includes("FROM attachment_blobs")) {
            return Promise.resolve(digest === null ? [] : [digest]);
          }
          return mockQueryHandler(sql);
        });
      }

      const A_METADATA = {
        id: A_ID,
        user_id: userId,
        storage_provider: "database",
        byte_size: A_BYTES.length,
        sha256: createHash("sha256").update(A_BYTES).digest("hex"),
      };

      it("reports incomplete when a database blob is missing (F3R7-001 scenario B)", async () => {
        // The database provider was previously not checked at export at all.
        attachmentStorageName = "database";
        // The metadata row exists, but nothing in `attachment_blobs` answers for it.
        databaseProviderHolds(A_METADATA, null);

        const { report } = await service.exportToBuffer(userId);

        expect(report.complete).toBe(false);
        expect(report.missingAttachments).toBe(1);
        // And nothing reached for an object store: on a database deployment
        // there is none, and a missing blob is a missing blob.
        expect(attachmentStorage.load).not.toHaveBeenCalled();
      });

      it("reports incomplete when a database blob contradicts its metadata", async () => {
        attachmentStorageName = "database";
        const wrong = Buffer.from("wrong bytes");
        databaseProviderHolds(A_METADATA, {
          attachment_id: A_ID,
          byte_size: wrong.length,
          sha256: createHash("sha256").update(wrong).digest("hex"),
        });

        const { report } = await service.exportToBuffer(userId);

        expect(report.complete).toBe(false);
        expect(report.inconsistentAttachments).toBe(1);
      });

      it("counts a blob whose digest matches as included", async () => {
        // The negative case for the digest comparison above: without it, a
        // report that says "incomplete" for every database-provider attachment
        // would pass both tests before this one.
        attachmentStorageName = "database";
        databaseProviderHolds(A_METADATA, {
          attachment_id: A_ID,
          byte_size: A_BYTES.length,
          sha256: createHash("sha256").update(A_BYTES).digest("hex"),
        });

        const { report } = await service.exportToBuffer(userId);

        expect(report).toMatchObject({
          complete: true,
          expectedAttachments: 1,
          includedAttachments: 1,
        });
      });
    });

    it("carries them in the streaming export too", async () => {
      // Three export paths read the same table list, and an artifact missing the
      // bytes is indistinguishable from one that has them until a restore.
      attachmentStorageName = "local";
      storeHolds([{ id: A_ID, provider: "local" }], { [A_ID]: A_BYTES });

      const mockRes = new PassThrough();
      const chunks: Buffer[] = [];
      const collected = (async () => {
        for await (const chunk of mockRes) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      })();
      await service.streamExport(userId, mockRes as any);
      await collected;
      const result = JSON.parse(
        gunzipSync(Buffer.concat(chunks)).toString("utf-8"),
      );

      expect(result.attachment_blobs).toEqual([
        { attachment_id: A_ID, data: A_BYTES.toString("base64") },
      ]);
    });

    it("carries them in the raw export the support backup reads", async () => {
      attachmentStorageName = "local";
      storeHolds([{ id: A_ID, provider: "local" }], { [A_ID]: A_BYTES });

      const raw = await service.collectRawExport(userId);

      expect(raw.tables.attachment_blobs).toEqual([
        { attachment_id: A_ID, data: A_BYTES.toString("base64") },
      ]);
    });

    it("does not read the store for a table the caller is skipping", async () => {
      // The support backup always discards `attachment_blobs`. Reading every
      // receipt off disk to throw it away is the same defect as loading the table
      // to discard it (F3RR-004), one layer out.
      attachmentStorageName = "local";
      storeHolds([{ id: A_ID, provider: "local" }], { [A_ID]: A_BYTES });

      await service.collectRawExport(userId, {
        skipTables: new Set(["attachment_blobs"]),
      });

      expect(attachmentStorage.load).not.toHaveBeenCalled();
    });
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

    it("reads every table inside one REPEATABLE READ transaction", async () => {
      // The regression: each table used to be read in its own autocommit
      // transaction, so a concurrent write could land between two reads and the
      // file could hold a split whose parent transaction is missing. The
      // restore inserts with ON CONFLICT DO NOTHING, so that orphan is dropped
      // silently rather than failing -- a backup that is quietly incomplete.
      mockDataSource.query.mockResolvedValue([]);

      const mockRes = new PassThrough();
      const resultPromise = collectGzipOutput(mockRes);
      await service.streamExport(userId, mockRes as any);
      await resultPromise;

      const isolations = mockDataSource.transaction.mock.calls
        .map((call) => call[0])
        .filter((arg) => typeof arg === "string");
      expect(isolations).toEqual(["REPEATABLE READ"]);
      // One transaction for the whole export, not one per table.
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it("bounds how long the snapshot may sit idle waiting on the client", async () => {
      // The cost of holding one snapshot across a streamed download is that a
      // client which stops draining keeps a REPEATABLE READ transaction open,
      // and that blocks vacuum database-wide. The timeout turns that into a
      // failed download instead.
      mockDataSource.query.mockResolvedValue([]);

      const mockRes = new PassThrough();
      const resultPromise = collectGzipOutput(mockRes);
      await service.streamExport(userId, mockRes as any);
      await resultPromise;

      const idleGuard = mockDataSource.query.mock.calls.find((call) =>
        String(call[0]).includes("idle_in_transaction_session_timeout"),
      );
      expect(idleGuard).toBeDefined();
      // Transaction-local (`set_config(..., true)`), so it cannot leak onto the
      // pooled connection and shorten an unrelated request's allowance.
      expect(idleGuard![1]).toEqual([expect.any(String)]);
      expect(String(idleGuard![0])).toContain("true");
    });

    it("writes an encrypted envelope when a password is provided", async () => {
      mockDataSource.query.mockResolvedValue([]);
      const mockCategories = [{ id: "cat-1", name: "Food", user_id: userId }];
      mockDataSource.query.mockImplementation((sql: string) => {
        if (sql.includes("categories")) return Promise.resolve(mockCategories);
        return Promise.resolve([]);
      });

      // A real Writable, not a `{ write, end }` pair: the encrypted export is a
      // pipeline now rather than one `res.write(buffer)`, because AES-GCM's
      // single auth tag was what forced the whole artifact into memory (issue
      // #1070). A double that cannot be piped to cannot exercise it.
      const { res, chunks } = responseDouble();
      await service.streamExport(userId, res, "secret");

      const written = Buffer.concat(chunks);
      // Magic header check -- the file starts with MZBE, and it is the framed
      // container version.
      expect(written.subarray(0, 4).toString("ascii")).toBe("MZBE");
      expect(written[4]).toBe(2);
      expect(res.writableEnded).toBe(true);
    });

    it("rejects instead of hanging when the response closes mid-export (PR1077-REV-004)", async () => {
      // The plain export writes JSON through gzip inside the REPEATABLE READ
      // snapshot. The old write helper waited on a `drain` that a cancelled
      // client never emits, so the callback never returned and the snapshot
      // transaction and its pooled connection were pinned for the process
      // lifetime. Closing the response mid-export must settle the promise.
      const { res } = responseDouble();

      let releaseAttachments: (rows: unknown[]) => void = () => {};
      const attachmentsRead = new Promise<unknown[]>((resolve) => {
        releaseAttachments = resolve;
      });
      mockDataSource.query.mockImplementation((sql: string) => {
        if (String(sql).includes("FROM transaction_attachments")) {
          return attachmentsRead;
        }
        return Promise.resolve([]);
      });

      const exportPromise = service.streamExport(userId, res);
      // Let the export park on the pending attachment read inside the snapshot.
      await new Promise((r) => setImmediate(r));
      // The client goes away; then the read the snapshot was blocked on returns.
      res.emit("close");
      releaseAttachments([]);

      // The invariant is that this settles at all -- a hang fails the test by
      // timing out rather than by assertion.
      await expect(exportPromise).rejects.toThrow(
        /response closed before completion/,
      );
    });
  });

  describe("exportToBuffer", () => {
    it("returns gzipped JSON for unencrypted exports", async () => {
      mockDataSource.query.mockResolvedValue([]);
      const { buffer: buf } = await service.exportToBuffer(userId);
      // gzip magic 1f 8b
      expect(buf[0]).toBe(0x1f);
      expect(buf[1]).toBe(0x8b);
    });

    it("returns an encrypted envelope when a password is provided", async () => {
      mockDataSource.query.mockResolvedValue([]);
      const { buffer: buf } = await service.exportToBuffer(userId, "pw");
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
      institutions: [],
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

    /**
     * The envelope's completeness claim is the half of F3RB-001 (issue #1069)
     * that outlives the filename: a file that has been renamed, copied to
     * another machine or re-uploaded still says what it is. A restore of an
     * artifact known to be missing attachment bytes must not be silent about it
     * -- and one that makes no claim at all (written before the field existed)
     * must not be reported as incomplete, because absence is "not known".
     */
    describe("an artifact's own completeness claim", () => {
      const incomplete = {
        complete: false,
        expectedAttachments: 3,
        includedAttachments: 2,
        missingAttachments: 1,
        inconsistentAttachments: 0,
      };

      function warnings(): string[] {
        return warnSpy.mock.calls.map(([message]) => String(message));
      }

      let warnSpy: jest.SpyInstance;

      beforeEach(() => {
        mockUserRepo.findOne.mockResolvedValue(mockUser);
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation();
      });

      afterEach(() => warnSpy.mockRestore());

      it("says so when restoring an artifact the export recorded as incomplete", async () => {
        await service.restoreData(
          userId,
          makeInput({
            password: "test",
            data: { ...validBackupData, completeness: incomplete },
          }),
        );

        expect(warnings()).toContainEqual(
          expect.stringMatching(/incomplete.*1 attachment/is),
        );
      });

      it("restores it anyway -- a partial artifact beats no artifact", async () => {
        const result = await service.restoreData(
          userId,
          makeInput({
            password: "test",
            data: { ...validBackupData, completeness: incomplete },
          }),
        );

        expect(result.message).toBe("Backup restored successfully");
      });

      it("says nothing for an artifact that claims to be complete", async () => {
        await service.restoreData(
          userId,
          makeInput({
            password: "test",
            data: {
              ...validBackupData,
              completeness: { ...incomplete, complete: true },
            },
          }),
        );

        expect(warnings()).not.toContainEqual(
          expect.stringMatching(/incomplete/i),
        );
      });

      it("says nothing for an artifact written before the field existed", async () => {
        // Absence is not a claim of incompleteness, and treating it as one would
        // put a scary warning on every older backup.
        await service.restoreData(userId, makeInput({ password: "test" }));

        expect(warnings()).not.toContainEqual(
          expect.stringMatching(/incomplete/i),
        );
      });

      it("ignores a malformed claim rather than half-reading it", async () => {
        await service.restoreData(
          userId,
          makeInput({
            password: "test",
            data: {
              ...validBackupData,
              completeness: { complete: "no", missingAttachments: "several" },
            },
          }),
        );

        expect(warnings()).not.toContainEqual(
          expect.stringMatching(/incomplete/i),
        );
      });

      it("does not mistake the claim for a table", async () => {
        // Every walker over `BackupData` iterates its entries; a non-array value
        // has to fall through the id remap and the insert plan untouched.
        const result = await service.restoreData(
          userId,
          makeInput({
            password: "test",
            data: { ...validBackupData, completeness: incomplete },
          }),
        );

        expect(result.restored).toEqual(
          expect.not.objectContaining({ completeness: expect.anything() }),
        );
      });
    });

    it("should throw NotFoundException if user not found", async () => {
      mockUserRepo.findOne.mockResolvedValue(null);

      await expect(
        service.restoreData(userId, makeInput({ password: "test" })),
      ).rejects.toThrow(NotFoundException);
    });

    /**
     * Express caps the compressed upload; it says nothing about what comes out
     * of gzip. `gunzipSync` with no `maxOutputLength` allocated the whole
     * expansion before the version check, the format check, or anything that
     * could refuse the request -- and it did so on the event loop, so one upload
     * froze every other request in the process.
     */
    describe("decompression ceiling", () => {
      const previousLimit = process.env.BACKUP_RESTORE_EXPANDED_LIMIT;

      afterEach(() => {
        if (previousLimit === undefined) {
          delete process.env.BACKUP_RESTORE_EXPANDED_LIMIT;
        } else {
          process.env.BACKUP_RESTORE_EXPANDED_LIMIT = previousLimit;
        }
      });

      /** A small gzip that expands to far more than it weighs. */
      function gzipBomb(expandedBytes: number): Buffer {
        const filler = "A".repeat(expandedBytes);
        return gzipSync(
          Buffer.from(
            JSON.stringify({
              version: 1,
              exportedAt: "2026-01-01T00:00:00.000Z",
              filler,
            }),
            "utf-8",
          ),
        );
      }

      it("rejects a payload that expands past the limit, before touching data", async () => {
        mockUserRepo.findOne.mockResolvedValue(mockUser);
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        process.env.BACKUP_RESTORE_EXPANDED_LIMIT = "64kb";

        const bomb = gzipBomb(512 * 1024);
        // The compressed form is a rounding error next to what it expands to --
        // which is exactly why bounding the upload bounds nothing.
        expect(bomb.length).toBeLessThan(8 * 1024);

        await expect(
          service.restoreData(userId, {
            compressedData: bomb,
            password: "test",
          }),
        ).rejects.toThrow(BadRequestException);

        // The ceiling is hit before the destructive phase. (A transaction *is*
        // opened before this point -- the user lookup runs in one -- so the
        // claim worth asserting is that no data was deleted.)
        const deletes = mockQueryRunner.query.mock.calls.filter(
          ([sql]) => typeof sql === "string" && sql.includes("DELETE FROM"),
        );
        expect(deletes).toEqual([]);
      });

      it("says the backup is too large, not that it is corrupt", async () => {
        mockUserRepo.findOne.mockResolvedValue(mockUser);
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        process.env.BACKUP_RESTORE_EXPANDED_LIMIT = "64kb";

        // "Not valid gzip" would send the user hunting for a corrupt file.
        await expect(
          service.restoreData(userId, {
            compressedData: gzipBomb(512 * 1024),
            password: "test",
          }),
        ).rejects.toThrow(/too large/i);
      });

      it("accepts a payload inside the limit", async () => {
        mockUserRepo.findOne.mockResolvedValue(mockUser);
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        process.env.BACKUP_RESTORE_EXPANDED_LIMIT = "1mb";

        const result = await service.restoreData(
          userId,
          makeInput({ password: "test" }),
        );
        expect(result.message).toBe("Backup restored successfully");
      });
    });

    describe("buffered export ceiling", () => {
      const previousLimit = process.env.BACKUP_EXPORT_BUFFER_LIMIT;

      afterEach(() => {
        if (previousLimit === undefined) {
          delete process.env.BACKUP_EXPORT_BUFFER_LIMIT;
        } else {
          process.env.BACKUP_EXPORT_BUFFER_LIMIT = previousLimit;
        }
      });

      /**
       * Incompressible padding, deliberately.
       *
       * The ceiling used to count the uncompressed JSON, because that JSON was
       * genuinely accumulated -- per-table strings, a concatenated buffer and
       * gzip's output all live at the peak. The export streams through gzip now
       * (issue #1070), so the only thing this path still holds is the compressed
       * artifact, and that is what the limit counts. A row of `"x".repeat(400)`
       * would gzip to almost nothing and prove only that the assertion had
       * stopped meaning anything.
       */
      const incompressible = (bytes: number) =>
        randomBytes(bytes).toString("base64");

      it("refuses to assemble a buffered export past the limit", async () => {
        process.env.BACKUP_EXPORT_BUFFER_LIMIT = "1kb";
        mockQueryRunner.query.mockImplementation((sql: string, params) => {
          if (String(sql).includes("SELECT * FROM")) {
            return Promise.resolve([
              { id: randomUUID(), padding: incompressible(400) },
            ]);
          }
          return mockQueryHandler(sql, params as unknown[]);
        });

        // The pod dying mid-write leaves no artifact and no message; an error
        // naming the limit and the table it was reached at is recoverable.
        await expect(service.exportToBuffer(userId)).rejects.toThrow(
          /too large to produce/i,
        );
      });

      it("names the table the buffered export gave up at", async () => {
        process.env.BACKUP_EXPORT_BUFFER_LIMIT = "1kb";
        mockQueryRunner.query.mockImplementation((sql: string, params) => {
          // One table large enough that the writer flushes a chunk while it is
          // still inside it, so the name in the message is the table the
          // document had actually reached rather than the last one overall.
          if (String(sql).includes("FROM transactions ")) {
            return Promise.resolve(
              Array.from({ length: 800 }, () => ({
                id: randomUUID(),
                padding: incompressible(600),
              })),
            );
          }
          return mockQueryHandler(sql, params as unknown[]);
        });

        await expect(service.exportToBuffer(userId)).rejects.toThrow(
          /"transactions"/,
        );
      });

      it("leaves the streaming export unbounded", async () => {
        process.env.BACKUP_EXPORT_BUFFER_LIMIT = "1kb";
        mockQueryRunner.query.mockImplementation((sql: string, params) => {
          if (String(sql).includes("SELECT * FROM")) {
            return Promise.resolve([
              { id: randomUUID(), padding: incompressible(400) },
            ]);
          }
          return mockQueryHandler(sql, params as unknown[]);
        });

        // The HTTP export streams and holds no total, so the buffered ceiling
        // must not apply to it.
        const { res, chunks } = responseDouble();
        await service.streamExport(userId, res);
        expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
      });

      it("leaves the encrypted streaming export unbounded too", async () => {
        // This is the behaviour change issue #1070 bought: the encrypted
        // download used to be assembled in memory to compute one AES-GCM auth
        // tag, so a large dataset met this ceiling and was refused outright.
        // With a framed container it streams like the plain one.
        process.env.BACKUP_EXPORT_BUFFER_LIMIT = "1kb";
        mockQueryRunner.query.mockImplementation((sql: string, params) => {
          if (String(sql).includes("SELECT * FROM")) {
            return Promise.resolve([
              { id: randomUUID(), padding: incompressible(400) },
            ]);
          }
          return mockQueryHandler(sql, params as unknown[]);
        });

        const { res, chunks } = responseDouble();
        await service.streamExport(userId, res, "secret");
        expect(Buffer.concat(chunks).length).toBeGreaterThan(1024);
      });
    });

    /**
     * Attachment bytes only travel inside a backup for the `database` provider.
     * For `local` and `s3` the metadata carries a `storage_key` equal to the
     * attachment's UUID, and the restore mints a new UUID for every row -- so
     * the restore has to move the bytes to the new key or admit it did not.
     *
     * These cases are the ones the suite was missing: it had no external-
     * provider attachment anywhere, so changing what the restore does with them
     * broke nothing.
     */
    describe("external attachment bytes", () => {
      const BYTES = Buffer.from("receipt-pdf-bytes");
      const SHA256 = createHash("sha256").update(BYTES).digest("hex");
      const OLD_ID = "11111111-1111-4111-8111-111111111111";
      const TX_ID = "22222222-2222-4222-8222-222222222222";

      function backupWithLocalAttachment(
        overrides: Record<string, unknown> = {},
      ) {
        return {
          ...validBackupData,
          transaction_attachments: [
            {
              id: OLD_ID,
              user_id: userId,
              transaction_id: TX_ID,
              filename: "receipt.pdf",
              content_type: "application/pdf",
              byte_size: BYTES.length,
              sha256: SHA256,
              storage_provider: "local",
              storage_key: OLD_ID,
              ...overrides,
            },
          ],
        };
      }

      beforeEach(() => {
        mockUserRepo.findOne.mockResolvedValue(mockUser);
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        attachmentStorageName = "local";
        // The ordinary case is a user restoring their own backup, so the server
        // still holds the row the file describes. Tests about a crafted file
        // clear or contradict this.
        ownedAttachments = [
          {
            id: OLD_ID,
            storage_provider: "local",
            byte_size: BYTES.length,
            sha256: SHA256,
          },
        ];
      });

      it("runs the whole restore inside the processing gate (F3R6-004)", async () => {
        // The gate caps concurrent decompression/parsing, which the compressed
        // upload budget cannot. Prove restoreData routes its expensive region
        // through it -- the gate's own concurrency behaviour is covered in
        // restore-processing-gate.spec.ts.
        attachmentStorage.load.mockResolvedValue(BYTES);
        const runSpy = jest.spyOn(restoreProcessingGate, "run");

        await service.restoreData(
          userId,
          makeInput({ password: "test", data: backupWithLocalAttachment() }),
        );

        expect(runSpy).toHaveBeenCalledTimes(1);
        runSpy.mockRestore();
      });

      it("copies the bytes to the remapped key before restoring the metadata", async () => {
        attachmentStorage.load.mockResolvedValue(BYTES);

        const result = await service.restoreData(
          userId,
          makeInput({ password: "test", data: backupWithLocalAttachment() }),
        );

        // Read at the key the object actually sits under...
        expect(attachmentStorage.load).toHaveBeenCalledWith(OLD_ID);
        // ...and written under the fresh id the restored row will name.
        expect(attachmentStorage.save).toHaveBeenCalledTimes(1);
        const [writtenKey, writtenBytes] = attachmentStorage.save.mock.calls[0];
        expect(writtenKey).not.toBe(OLD_ID);
        expect(writtenBytes).toEqual(BYTES);

        const insertedKey = mockQueryRunner.query.mock.calls
          .filter(([sql]) =>
            String(sql).includes('INSERT INTO "transaction_attachments"'),
          )
          .flatMap(([, params]) => params as unknown[])
          .find((value) => value === writtenKey);
        expect(insertedKey).toBe(writtenKey);
        expect(result.restored.transactionAttachments).toBe(1);
        expect(result.skippedAttachments).toBeUndefined();
      });

      it("drops the metadata and reports it when the object is missing", async () => {
        attachmentStorage.load.mockRejectedValue(new Error("ENOENT"));

        const result = await service.restoreData(
          userId,
          makeInput({ password: "test", data: backupWithLocalAttachment() }),
        );

        expect(attachmentStorage.save).not.toHaveBeenCalled();
        expect(result.restored.transactionAttachments).toBe(0);
        expect(result.skippedAttachments).toBe(1);
        // The count of rows deliberately not written must not be inside
        // `restored` -- the client sums those values into a row total.
        expect(
          Object.keys(result.restored).includes("skippedAttachments"),
        ).toBe(false);
      });

      it("drops the metadata when the stored bytes fail their checksum", async () => {
        attachmentStorage.load.mockResolvedValue(Buffer.from("tampered"));

        const result = await service.restoreData(
          userId,
          makeInput({ password: "test", data: backupWithLocalAttachment() }),
        );

        expect(attachmentStorage.save).not.toHaveBeenCalled();
        expect(result.skippedAttachments).toBe(1);
      });

      it("drops the metadata when the backup used a different storage provider", async () => {
        attachmentStorage.load.mockResolvedValue(BYTES);

        const result = await service.restoreData(
          userId,
          makeInput({
            password: "test",
            data: backupWithLocalAttachment({ storage_provider: "s3" }),
          }),
        );

        // No point reading: this runtime has one provider and no cross-provider
        // migration path.
        expect(attachmentStorage.load).not.toHaveBeenCalled();
        expect(result.skippedAttachments).toBe(1);
      });

      it("drops a database-provider attachment whose blob did not travel", async () => {
        attachmentStorageName = "database";

        const result = await service.restoreData(
          userId,
          makeInput({
            password: "test",
            data: backupWithLocalAttachment({ storage_provider: "database" }),
          }),
        );

        // Metadata with no bytes anywhere is a download that 404s, which the
        // user cannot tell from a working attachment.
        expect(result.restored.transactionAttachments).toBe(0);
        expect(result.skippedAttachments).toBe(1);
      });

      /**
       * The other half of the bytes-live-outside-the-database problem (F3R-006).
       *
       * A destructive restore deletes every `transaction_attachments` row the
       * user had. For `local` and `s3` the bytes are not in those rows, so they
       * used to stay in the volume or the bucket forever, referenced by nothing:
       * a receipt or a medical document surviving the replacement of the account
       * it belonged to, still present in whatever backs that storage up, and now
       * impossible to find again because the metadata that named it is gone.
       */
      describe("objects the restore displaced", () => {
        const EXISTING_KEY = "99999999-9999-4999-8999-999999999999";

        /** The target user's current external attachments, read before the delete. */
        const targetHolds = (...keys: string[]) => {
          mockQueryRunner.query.mockImplementation(
            (sql: string, params?: unknown[]) => {
              if (
                String(sql).includes(
                  "SELECT storage_key FROM transaction_attachments",
                )
              ) {
                return Promise.resolve(keys.map((k) => ({ storage_key: k })));
              }
              return mockQueryHandler(sql, params);
            },
          );
        };

        it("deletes the user's old external objects after a successful restore", async () => {
          attachmentStorage.load.mockResolvedValue(BYTES);
          targetHolds(EXISTING_KEY);

          await service.restoreData(
            userId,
            makeInput({ password: "test", data: backupWithLocalAttachment() }),
          );

          expect(attachmentStorage.delete).toHaveBeenCalledWith(EXISTING_KEY);
        });

        it("leaves them alone when the restore fails", async () => {
          attachmentStorage.load.mockResolvedValue(BYTES);
          mockQueryRunner.query.mockImplementation(
            (sql: string, params?: unknown[]) => {
              if (
                String(sql).includes(
                  "SELECT storage_key FROM transaction_attachments",
                )
              ) {
                return Promise.resolve([{ storage_key: EXISTING_KEY }]);
              }
              if (
                String(sql).includes('INSERT INTO "transaction_attachments"')
              ) {
                return Promise.reject(new Error("constraint violation"));
              }
              return mockQueryHandler(sql, params);
            },
          );

          await expect(
            service.restoreData(
              userId,
              makeInput({
                password: "test",
                data: backupWithLocalAttachment(),
              }),
            ),
          ).rejects.toThrow();

          // The metadata rolled back, so those bytes are still referenced.
          // Deleting them would leave a row promising a download that is gone --
          // which the user cannot tell from a working attachment.
          expect(attachmentStorage.delete).not.toHaveBeenCalledWith(
            EXISTING_KEY,
          );
        });

        it("never deletes a key the restore just staged", async () => {
          // Restoring a backup taken from this same account re-uses ids, so a
          // displaced key and a newly written key can be the same string.
          attachmentStorage.load.mockResolvedValue(BYTES);
          let stagedKey: string | undefined;
          attachmentStorage.save.mockImplementation(async (key: string) => {
            stagedKey = key;
          });
          // The target's current key set includes whatever gets staged, which is
          // only knowable after the fact -- so claim both and assert on the one
          // that matters.
          mockQueryRunner.query.mockImplementation(
            (sql: string, params?: unknown[]) => {
              if (
                String(sql).includes(
                  "SELECT storage_key FROM transaction_attachments",
                )
              ) {
                return Promise.resolve(
                  [OLD_ID, EXISTING_KEY].map((k) => ({ storage_key: k })),
                );
              }
              return mockQueryHandler(sql, params);
            },
          );

          await service.restoreData(
            userId,
            makeInput({ password: "test", data: backupWithLocalAttachment() }),
          );

          expect(stagedKey).toBeDefined();
          expect(attachmentStorage.delete).not.toHaveBeenCalledWith(stagedKey);
          // The genuinely displaced one still goes.
          expect(attachmentStorage.delete).toHaveBeenCalledWith(EXISTING_KEY);
        });

        it("does not read or delete anything for the database provider", async () => {
          // Those bytes are in `attachment_blobs` and go with the rows, inside
          // the transaction. There is nothing outside to clean up.
          attachmentStorageName = "database";
          const keyQueries = () =>
            mockQueryRunner.query.mock.calls.filter(([sql]) =>
              String(sql).includes(
                "SELECT storage_key FROM transaction_attachments",
              ),
            );

          await service.restoreData(
            userId,
            makeInput({
              password: "test",
              data: backupWithLocalAttachment({ storage_provider: "database" }),
            }),
          );

          expect(keyQueries()).toHaveLength(0);
          expect(attachmentStorage.delete).not.toHaveBeenCalled();
        });

        it("completes the restore even when the cleanup cannot delete", async () => {
          attachmentStorage.load.mockResolvedValue(BYTES);
          targetHolds(EXISTING_KEY);
          attachmentStorage.delete.mockRejectedValue(new Error("EACCES"));

          // The database is already the backup's. Turning a committed restore
          // into a failure over an orphaned object would be the wrong trade.
          await expect(
            service.restoreData(
              userId,
              makeInput({
                password: "test",
                data: backupWithLocalAttachment(),
              }),
            ),
          ).resolves.toMatchObject({ message: "Backup restored successfully" });
        });
      });

      /**
       * The key in the uploaded file is attacker-controlled (F3RR-001).
       *
       * The destination used to come from `row.storage_key`, and a key the restore
       * did not recognise as a remapped id was treated as "legacy or
       * operator-chosen" -- skip the load, skip the checksum, skip the copy, on
       * the grounds that the object already sat where the metadata pointed. So a
       * crafted backup could name any syntactically valid key, including another
       * tenant's, and the row was inserted under the uploader's `user_id` without
       * a byte being read. `assertSafeStorageKey` proves a key is a safe *string*;
       * nothing proved it was *theirs*.
       */
      describe("a storage_key the backup did not earn", () => {
        const VICTIM_KEY = "cafe1234-0000-4000-8000-00000000cafe";

        it("stages the row instead of trusting the key and skipping", async () => {
          attachmentStorage.load.mockResolvedValue(BYTES);

          await service.restoreData(
            userId,
            makeInput({
              password: "test",
              // A key that is not this backup's attachment id and not in its id
              // remap -- i.e. somebody else's object.
              data: backupWithLocalAttachment({ storage_key: VICTIM_KEY }),
            }),
          );

          // The old code's shortcut was the vulnerability: an unrecognised key
          // meant "the object is already where the metadata points", so it wrote
          // nothing and read nothing and inserted the key. A crafted row now goes
          // through the same staging as any other -- read the source the backup
          // names, write the destination the restore derives.
          expect(attachmentStorage.load).toHaveBeenCalledWith(OLD_ID);
          expect(attachmentStorage.save).toHaveBeenCalledTimes(1);
          const [writtenKey] = attachmentStorage.save.mock.calls[0];
          expect(writtenKey).not.toBe(VICTIM_KEY);
        });

        it("never writes it into the restored metadata", async () => {
          attachmentStorage.load.mockResolvedValue(BYTES);

          await service.restoreData(
            userId,
            makeInput({
              password: "test",
              data: backupWithLocalAttachment({ storage_key: VICTIM_KEY }),
            }),
          );

          const inserted = mockQueryRunner.query.mock.calls
            .filter(([sql]) =>
              String(sql).includes('INSERT INTO "transaction_attachments"'),
            )
            .flatMap(([, params]) => (params ?? []) as unknown[]);
          // The crafted key must not survive anywhere in the insert -- otherwise
          // the uploader owns a row addressing another tenant's object.
          expect(inserted).not.toContain(VICTIM_KEY);
        });

        it("addresses the object by the remapped attachment id", async () => {
          attachmentStorage.load.mockResolvedValue(BYTES);

          await service.restoreData(
            userId,
            makeInput({ password: "test", data: backupWithLocalAttachment() }),
          );

          // Source is the id the backup was written with; destination is the id
          // the restore minted. Both come from the remap, so neither is the
          // file's to choose.
          expect(attachmentStorage.load).toHaveBeenCalledWith(OLD_ID);
          const [writtenKey] = attachmentStorage.save.mock.calls[0];
          expect(writtenKey).not.toBe(OLD_ID);
          const inserted = mockQueryRunner.query.mock.calls
            .filter(([sql]) =>
              String(sql).includes('INSERT INTO "transaction_attachments"'),
            )
            .flatMap(([, params]) => (params ?? []) as unknown[]);
          expect(inserted).toContain(writtenKey);
        });
      });

      /**
       * The *id* in the uploaded file is attacker-controlled too (F3RRR-001).
       *
       * The F3RR-001 fix stopped deriving the source from `row.storage_key` and
       * derived it from the id remap instead, on the reasoning that "a row whose
       * id is not in the remap did not come from this backup's graph". But the
       * graph is the uploaded graph: `collectRowIdRemap` admits every UUID-shaped
       * `row.id` in the file, so for any well-formed crafted row the guard could
       * not fire. Putting the victim's attachment id in `transaction_attachments.id`
       * -- with the byte size and SHA-256 that a standard backup publishes beside
       * it -- made the restore read the victim's object and copy it under the
       * attacker's ownership.
       *
       * So the entitlement now comes from `transaction_attachments` as the server
       * holds it, read before the destructive delete. Nothing in the file can
       * establish it.
       */
      describe("an attachment id the uploader does not own", () => {
        const VICTIM_ID = "deadbeef-0000-4000-8000-00000000beef";

        /** The victim's row, exactly as a standard backup would publish it. */
        const craftedFromVictim = () =>
          backupWithLocalAttachment({
            id: VICTIM_ID,
            // Both fields are honest -- they describe the victim's object. That
            // is the point: agreeing with the stored values is not ownership.
            byte_size: BYTES.length,
            sha256: SHA256,
          });

        it("never reads the object when the server holds no such row for this user", async () => {
          attachmentStorage.load.mockResolvedValue(BYTES);
          // The uploader owns nothing: a fresh account, or simply not this row.
          ownedAttachments = [];

          const result = await service.restoreData(
            userId,
            makeInput({ password: "test", data: craftedFromVictim() }),
          );

          // The disclosure was the read. It must not happen at all -- not fail a
          // checksum afterwards, not be copied and then rolled back.
          expect(attachmentStorage.load).not.toHaveBeenCalled();
          expect(attachmentStorage.save).not.toHaveBeenCalled();
          expect(result.restored.transactionAttachments).toBe(0);
          expect(result.skippedAttachments).toBe(1);
        });

        it("does not let the uploader's own attachment vouch for someone else's", async () => {
          attachmentStorage.load.mockResolvedValue(BYTES);
          // This user genuinely owns OLD_ID, so the ownership read returns a row
          // -- just not the one the crafted id names.
          const data = {
            ...backupWithLocalAttachment(),
            transaction_attachments: [
              ...backupWithLocalAttachment().transaction_attachments,
              ...craftedFromVictim().transaction_attachments,
            ],
          };

          const result = await service.restoreData(
            userId,
            makeInput({ password: "test", data }),
          );

          // Their own row restores; the crafted one is dropped, and its source
          // object is never opened.
          expect(attachmentStorage.load).toHaveBeenCalledWith(OLD_ID);
          expect(attachmentStorage.load).not.toHaveBeenCalledWith(VICTIM_ID);
          expect(result.restored.transactionAttachments).toBe(1);
          expect(result.skippedAttachments).toBe(1);
        });

        it("never writes the victim's bytes anywhere the uploader can reach", async () => {
          // If the read did somehow happen, the copy must not: a staged object
          // plus a restored metadata row is a working download of another
          // tenant's file.
          attachmentStorage.load.mockResolvedValue(BYTES);
          ownedAttachments = [];

          await service.restoreData(
            userId,
            makeInput({ password: "test", data: craftedFromVictim() }),
          );

          expect(attachmentStorage.save).not.toHaveBeenCalled();
          const inserted = mockQueryRunner.query.mock.calls
            .filter(([sql]) =>
              String(sql).includes('INSERT INTO "transaction_attachments"'),
            )
            .flatMap(([, params]) => (params ?? []) as unknown[]);
          expect(inserted).not.toContain(VICTIM_ID);
        });

        it("drops the row when the stored attachment is on another provider", async () => {
          // Same id, but the object it names lives in a backend this runtime
          // cannot address -- so there is nothing here to be entitled to.
          attachmentStorage.load.mockResolvedValue(BYTES);
          ownedAttachments = [
            {
              id: OLD_ID,
              storage_provider: "s3",
              byte_size: BYTES.length,
              sha256: SHA256,
            },
          ];

          const result = await service.restoreData(
            userId,
            makeInput({ password: "test", data: backupWithLocalAttachment() }),
          );

          expect(attachmentStorage.load).not.toHaveBeenCalled();
          expect(result.skippedAttachments).toBe(1);
        });

        /**
         * The behavioural tests above prove the restore's read path checks
         * ownership. They cannot prove a *second* read path will not be added
         * beside it, and this defect has now appeared three times in this file --
         * so the half of the rule a scan can hold, it holds.
         *
         * There are exactly two places in the module that open an external
         * object, and the distinction between them is the whole point:
         *
         *  - `readAttachmentObject` (export) reads objects the *server* named,
         *    from a `user_id`-scoped query against its own database. There is no
         *    uploaded document involved, so there is nothing to authorize.
         *  - `stageAttachmentObjects` (restore) reads an object an *uploaded* file
         *    named, which is the case that needs the database's ownership record
         *    first -- and it is the legacy path now, used only for an artifact
         *    that does not carry its own bytes.
         *
         * A scan cannot tell an uploaded identifier from a derived one, so this is
         * not the whole rule. It is the part that catches the next reader wherever
         * it appears, and makes whoever adds a third one say which kind it is.
         */
        it("opens an external object in exactly two places, and the restore's is ownership-gated (source guard)", () => {
          // Scans the whole module, not one file. Issue #1092 split the two
          // readers into two classes, and a guard that had stayed pointed at
          // `backup.service.ts` would have gone on passing while counting zero
          // readers -- a scan that can only see one file is a scan a refactor
          // silently disarms.
          const sources = backupModuleSources();
          const reads = sources.flatMap(({ file, text }) =>
            [...text.matchAll(/this\.attachmentStorage\.load\(/g)].map(
              (match) => ({ file, at: match.index as number }),
            ),
          );
          expect(reads).toHaveLength(2);

          /** The slice from a method's signature to the start of the next member. */
          const methodBody = (file: string, signature: string) => {
            const text = sourceOf(sources, file);
            const start = text.indexOf(signature);
            expect(start).toBeGreaterThan(-1);
            const rest = text.slice(start + 1);
            const next = rest.search(/\n {2}(private |async |get |\/\*\*)/);
            return {
              text,
              start,
              end: next === -1 ? text.length : start + 1 + next,
            };
          };

          const exporting = methodBody(
            "backup-export.service.ts",
            "private async readAttachmentObject(",
          );
          const staging = methodBody(
            "backup-attachment-transfer.service.ts",
            "async stageAttachmentObjects(",
          );

          const inExport = reads.filter(
            (read) =>
              read.file === "backup-export.service.ts" &&
              read.at > exporting.start &&
              read.at < exporting.end,
          );
          const inStaging = reads.filter(
            (read) =>
              read.file === "backup-attachment-transfer.service.ts" &&
              read.at > staging.start &&
              read.at < staging.end,
          );
          // One each, so a new reader anywhere else in the module fails this.
          expect(inExport).toHaveLength(1);
          expect(inStaging).toHaveLength(1);

          // The restore's read is preceded by loading and consulting the
          // database's ownership record.
          const beforeRestoreRead = staging.text.slice(
            staging.start,
            inStaging[0].at,
          );
          expect(beforeRestoreRead).toContain("loadOwnedAttachmentSources(");
          expect(beforeRestoreRead).toContain("ownedSources.get(");

          // The export never sees an uploaded document at all: the only ids it
          // is ever handed come from its own `user_id`-scoped sweep, which is
          // the single query in `export-attachments.ts` that produces them.
          const exportBody = exporting.text.slice(
            exporting.start,
            exporting.end,
          );
          expect(exportBody).not.toContain("BackupData");
          const attachmentSql = sourceOf(sources, "export-attachments.ts");
          expect(ATTACHMENT_EXPORT_SQL.metadata).toContain(
            "WHERE user_id = $1",
          );
          // ...and that sweep is the only place the export names an attachment
          // id, so there is no second, unscoped route to one.
          expect([
            ...attachmentSql.matchAll(/FROM transaction_attachments\b/g),
          ]).toHaveLength(1);
        });

        it("drops the row when the file's metadata contradicts the stored row", async () => {
          // An uploaded field that has to equal a stored field is no longer a
          // field the uploader controls -- and a row whose size or hash disagrees
          // does not describe the object sitting under that id, so restoring its
          // metadata would publish a checksum the bytes do not satisfy.
          attachmentStorage.load.mockResolvedValue(BYTES);

          const result = await service.restoreData(
            userId,
            makeInput({
              password: "test",
              data: backupWithLocalAttachment({ byte_size: BYTES.length + 1 }),
            }),
          );

          expect(attachmentStorage.load).not.toHaveBeenCalled();
          expect(result.skippedAttachments).toBe(1);
        });
      });

      /**
       * A backup that can only be restored once is not a backup (F3RR-002).
       *
       * The post-commit cleanup added for F3R-006 deleted every displaced key --
       * and for a backup taken from this same account, its *source* objects are
       * the account's displaced objects. So the first restore worked and deleted
       * the artifact's source bytes; a second restore of the same file skipped
       * every attachment and then deleted the copy the first restore had made,
       * losing the content while still reporting success.
       *
       * `stageAttachmentObjects` said "old-key objects are deliberately left
       * alone: the same backup may be restored more than once" the whole time.
       * Two pieces of the same change, with opposite intentions about the same
       * object.
       */
      /**
       * The recovery half of P3-002, and the cost of the ownership fix (F3R5-001).
       *
       * Making the database the authority for reading an external object closed
       * the disclosure, and made a current metadata row a *prerequisite* for
       * recovery. So the two situations backups exist for both broke: a fresh
       * instance has no such row, and an account whose attachment was deleted has
       * no such row either. The restore reported success and counted the
       * attachment as skipped, with the sidecar volume sitting there intact.
       *
       * No better ownership check fixes that. An identifier, a size and a hash in
       * an uploaded document cannot establish a right to read an object, however
       * they are combined. The only thing that can is the bytes being *in* the
       * artifact -- so now they are, for every provider.
       */
      describe("bytes carried in the artifact", () => {
        /** A backup that carries its external attachment's bytes, as the export now does. */
        const selfContained = (
          overrides: Record<string, unknown> = {},
          blobOverrides: Record<string, unknown> = {},
        ) => {
          const base = backupWithLocalAttachment(overrides);
          return {
            ...base,
            attachment_blobs: [
              {
                attachment_id: OLD_ID,
                data: BYTES.toString("base64"),
                ...blobOverrides,
              },
            ],
          };
        };

        it("restores an attachment on an instance that has never seen it", async () => {
          // The disaster-recovery case: fresh database, no metadata for anything.
          ownedAttachments = [];

          const result = await service.restoreData(
            userId,
            makeInput({ password: "test", data: selfContained() }),
          );

          // Nothing outside the artifact is consulted -- there is nothing there.
          expect(attachmentStorage.load).not.toHaveBeenCalled();
          expect(attachmentStorage.save).toHaveBeenCalledTimes(1);
          const [writtenKey, writtenBytes] =
            attachmentStorage.save.mock.calls[0];
          expect(writtenBytes).toEqual(BYTES);
          expect(result.restored.transactionAttachments).toBe(1);
          expect(result.skippedAttachments).toBeUndefined();

          // The restored row addresses the object that was just written.
          const inserted = mockQueryRunner.query.mock.calls
            .filter(([sql]) =>
              String(sql).includes('INSERT INTO "transaction_attachments"'),
            )
            .flatMap(([, params]) => (params ?? []) as unknown[]);
          expect(inserted).toContain(writtenKey);
        });

        it("restores an attachment whose metadata was deleted from the live account", async () => {
          // Same shape as the fresh instance, different cause: the user deleted
          // the attachment and wants it back from the backup.
          ownedAttachments = [];

          const result = await service.restoreData(
            userId,
            makeInput({ password: "test", data: selfContained() }),
          );

          expect(result.restored.transactionAttachments).toBe(1);
          expect(result.skippedAttachments).toBeUndefined();
        });

        it("does not insert a blob row for bytes it put in the object store", async () => {
          // `attachment_blobs` is the database provider's storage. A row there for
          // an externally stored attachment is a second copy of the same bytes
          // that nothing ever reads.
          ownedAttachments = [];

          const result = await service.restoreData(
            userId,
            makeInput({ password: "test", data: selfContained() }),
          );

          const blobInserts = mockQueryRunner.query.mock.calls.filter(([sql]) =>
            String(sql).includes('INSERT INTO "attachment_blobs"'),
          );
          expect(blobInserts).toHaveLength(0);
          expect(result.restored.attachmentBlobs).toBe(0);
          // Paired with the positive half, or this passes for the wrong reason:
          // before the bytes travelled, the attachment was skipped entirely and
          // there was no blob row to insert either.
          expect(attachmentStorage.save).toHaveBeenCalledTimes(1);
          expect(result.restored.transactionAttachments).toBe(1);
        });

        it("puts the bytes where this runtime keeps them, not where the source did", async () => {
          // A backup taken under `local` restoring onto a `database` deployment
          // used to be skipped outright. The bytes travelled, so the only question
          // left is where they land -- and that is this runtime's decision.
          attachmentStorageName = "database";
          ownedAttachments = [];

          const result = await service.restoreData(
            userId,
            makeInput({ password: "test", data: selfContained() }),
          );

          expect(attachmentStorage.save).not.toHaveBeenCalled();
          expect(result.restored.transactionAttachments).toBe(1);
          expect(result.restored.attachmentBlobs).toBe(1);
          // And the row says database, not the `local` the file claimed.
          const providers = mockQueryRunner.query.mock.calls
            .filter(([sql]) =>
              String(sql).includes('INSERT INTO "transaction_attachments"'),
            )
            .flatMap(([, params]) => (params ?? []) as unknown[]);
          expect(providers).toContain("database");
          expect(providers).not.toContain("local");
        });

        it("restores a database-provider backup onto an external deployment", async () => {
          // The mirror image, which was also a skip.
          const result = await service.restoreData(
            userId,
            makeInput({
              password: "test",
              data: selfContained({ storage_provider: "database" }),
            }),
          );

          expect(attachmentStorage.save).toHaveBeenCalledTimes(1);
          expect(attachmentStorage.save.mock.calls[0][1]).toEqual(BYTES);
          expect(result.restored.transactionAttachments).toBe(1);
          expect(result.restored.attachmentBlobs).toBe(0);
        });

        it("drops the row when the carried bytes do not match their own checksum", async () => {
          // Both sides come from the same file, so this proves consistency rather
          // than authority. What it catches is a corrupt or truncated artifact:
          // restoring a row whose sha256 does not describe its own bytes publishes
          // a checksum the download cannot satisfy.
          ownedAttachments = [];

          const result = await service.restoreData(
            userId,
            makeInput({
              password: "test",
              data: selfContained(
                {},
                { data: Buffer.from("tampered").toString("base64") },
              ),
            }),
          );

          expect(attachmentStorage.save).not.toHaveBeenCalled();
          expect(result.restored.transactionAttachments).toBe(0);
          expect(result.skippedAttachments).toBe(1);

          // The discriminating half: the identical backup with intact bytes does
          // restore. Without this, the assertions above also hold for code that
          // skips every external attachment, which is what they used to do.
          jest.clearAllMocks();
          mockUserRepo.findOne.mockResolvedValue(mockUser);
          (bcrypt.compare as jest.Mock).mockResolvedValue(true);
          mockQueryRunner.query.mockImplementation(mockQueryHandler);
          const intact = await service.restoreData(
            userId,
            makeInput({ password: "test", data: selfContained() }),
          );
          expect(intact.restored.transactionAttachments).toBe(1);
          expect(intact.skippedAttachments).toBeUndefined();
        });

        it("drops the row when the carried bytes are the wrong length", async () => {
          ownedAttachments = [];
          const shorter = BYTES.subarray(0, BYTES.length - 1);

          const result = await service.restoreData(
            userId,
            makeInput({
              password: "test",
              data: selfContained(
                { sha256: createHash("sha256").update(shorter).digest("hex") },
                { data: shorter.toString("base64") },
              ),
            }),
          );

          // The hash agrees with the bytes; the declared size does not.
          expect(attachmentStorage.save).not.toHaveBeenCalled();
          expect(result.skippedAttachments).toBe(1);
        });

        it("still refuses a crafted id when the artifact carries no bytes", async () => {
          // The legacy path has to stay ownership-gated: carrying bytes is what
          // removes the need for authority, and a file that carries none has none.
          ownedAttachments = [];

          const result = await service.restoreData(
            userId,
            makeInput({ password: "test", data: backupWithLocalAttachment() }),
          );

          expect(attachmentStorage.load).not.toHaveBeenCalled();
          expect(attachmentStorage.save).not.toHaveBeenCalled();
          expect(result.skippedAttachments).toBe(1);
        });
      });

      /**
       * The legacy ownership preload is sized by legacy attachment rows, not by
       * every UUID in the uploaded graph (PR1077-REV-005).
       *
       * The read used to receive `[...idRemap.keys()]` -- every remapped row in
       * the artifact, transactions and splits and prices included -- to authorize
       * a handful of legacy external attachments. A current-format artifact that
       * carries its own bytes needs no authority outside itself, so it must issue
       * no ownership query at all; a mixed artifact must query only the original
       * ids of the legacy rows that actually read a source object.
       */
      describe("legacy ownership query scope", () => {
        const ownershipQueryCalls = () =>
          mockQueryRunner.query.mock.calls.filter(([sql]) =>
            String(sql).includes("id = ANY($2::uuid[])"),
          );

        const attachmentRow = (id: string) => ({
          id,
          user_id: userId,
          transaction_id: TX_ID,
          filename: "receipt.pdf",
          content_type: "application/pdf",
          byte_size: BYTES.length,
          sha256: SHA256,
          storage_provider: "local",
          storage_key: id,
        });

        it("issues no ownership query when every attachment carries its own bytes", async () => {
          // Carried bytes, and a graph of unrelated rows the old code would have
          // copied into the query parameter. The read must not happen.
          ownedAttachments = [];
          const data = {
            ...validBackupData,
            transactions: Array.from({ length: 40 }, () => ({
              id: randomUUID(),
            })),
            transaction_attachments: [attachmentRow(OLD_ID)],
            attachment_blobs: [
              { attachment_id: OLD_ID, data: BYTES.toString("base64") },
            ],
          };

          const result = await service.restoreData(
            userId,
            makeInput({ password: "test", data }),
          );

          expect(ownershipQueryCalls()).toHaveLength(0);
          expect(attachmentStorage.load).not.toHaveBeenCalled();
          expect(result.restored.transactionAttachments).toBe(1);
        });

        it("queries only the original ids of the legacy attachments, deduplicated", async () => {
          const CARRIED = "aaaaaaaa-0000-4000-8000-000000000001";
          const LEGACY_A = "bbbbbbbb-0000-4000-8000-000000000002";
          const LEGACY_B = "cccccccc-0000-4000-8000-000000000003";
          attachmentStorage.load.mockResolvedValue(BYTES);
          // The server holds the two legacy rows; the ownership read authorizes
          // them and nothing else.
          ownedAttachments = [
            {
              id: LEGACY_A,
              storage_provider: "local",
              byte_size: BYTES.length,
              sha256: SHA256,
            },
            {
              id: LEGACY_B,
              storage_provider: "local",
              byte_size: BYTES.length,
              sha256: SHA256,
            },
          ];
          const data = {
            ...validBackupData,
            transactions: Array.from({ length: 30 }, () => ({
              id: randomUUID(),
            })),
            transaction_attachments: [
              attachmentRow(CARRIED),
              attachmentRow(LEGACY_A),
              attachmentRow(LEGACY_B),
            ],
            attachment_blobs: [
              { attachment_id: CARRIED, data: BYTES.toString("base64") },
            ],
          };

          await service.restoreData(
            userId,
            makeInput({ password: "test", data }),
          );

          const calls = ownershipQueryCalls();
          expect(calls).toHaveLength(1);
          const queriedIds = [
            ...((calls[0][1] as unknown[])[1] as string[]),
          ].sort();
          expect(queriedIds).toEqual([LEGACY_A, LEGACY_B].sort());
        });
      });

      /**
       * Duplicate blob rows for one id (F3R6-003).
       *
       * Staging validates the *last* row for a duplicated id (Map last-wins), but
       * `attachment_blobs.attachment_id` is a primary key and Phase-2 inserts with
       * `ON CONFLICT DO NOTHING`, so a raw uploaded array would commit the *first*.
       * A crafted backup could pair valid bytes (checked, accepted) with corrupt
       * bytes (inserted). The restore rebuilds `attachment_blobs` from the
       * validated bytes, one row per id, so the row inserted is the row checked --
       * and the outcome does not depend on the duplicate order.
       */
      describe("duplicate blob rows", () => {
        const GOOD = BYTES;
        const BAD = Buffer.from("corrupted-different-length-bytes");

        const twoBlobs = (first: Buffer, second: Buffer) => ({
          ...backupWithLocalAttachment({ storage_provider: "database" }),
          attachment_blobs: [
            { attachment_id: OLD_ID, data: first.toString("base64") },
            { attachment_id: OLD_ID, data: second.toString("base64") },
          ],
        });

        const insertedBlobParams = () =>
          mockQueryRunner.query.mock.calls
            .filter(([sql]) =>
              String(sql).includes('INSERT INTO "attachment_blobs"'),
            )
            .flatMap(([, params]) => (params ?? []) as unknown[]);

        beforeEach(() => {
          attachmentStorageName = "database";
        });

        it("inserts the validated bytes, not the first duplicate (bad-first, good-last)", async () => {
          // Map keeps GOOD (last), validation passes, rebuild inserts GOOD.
          const result = await service.restoreData(
            userId,
            makeInput({ password: "test", data: twoBlobs(BAD, GOOD) }),
          );

          const params = insertedBlobParams();
          expect(params).toContain(GOOD.toString("base64"));
          expect(params).not.toContain(BAD.toString("base64"));
          expect(result.restored.transactionAttachments).toBe(1);
          expect(result.restored.attachmentBlobs).toBe(1);
        });

        it("drops the attachment rather than committing unverified bytes (good-first, bad-last)", async () => {
          // Map keeps BAD (last), which fails the metadata check, so the whole
          // attachment is unrestorable -- never a committed corrupt blob.
          const result = await service.restoreData(
            userId,
            makeInput({ password: "test", data: twoBlobs(GOOD, BAD) }),
          );

          const params = insertedBlobParams();
          expect(params).not.toContain(BAD.toString("base64"));
          expect(params).not.toContain(GOOD.toString("base64"));
          expect(result.skippedAttachments).toBe(1);
          expect(result.restored.attachmentBlobs ?? 0).toBe(0);
        });

        it("collapses duplicates to a single row even when both are valid", async () => {
          // No integrity issue -- just two identical rows. The primary key would
          // reject the second anyway; the rebuild means only one is offered.
          const result = await service.restoreData(
            userId,
            makeInput({ password: "test", data: twoBlobs(GOOD, GOOD) }),
          );

          const inserts = mockQueryRunner.query.mock.calls.filter(([sql]) =>
            String(sql).includes('INSERT INTO "attachment_blobs"'),
          );
          const idParams = inserts
            .flatMap(([, params]) => (params ?? []) as unknown[])
            .filter((v) => v === GOOD.toString("base64"));
          expect(idParams).toHaveLength(1);
          expect(result.restored.attachmentBlobs).toBe(1);
        });
      });

      describe("restoring the same backup twice", () => {
        /** An in-memory object store, so the second restore sees the first's effects. */
        function statefulStore(seed: Record<string, Buffer>) {
          const objects = new Map(Object.entries(seed));
          attachmentStorage.load.mockImplementation(async (key: string) => {
            const bytes = objects.get(key);
            if (!bytes) throw new Error(`no such object: ${key}`);
            return bytes;
          });
          attachmentStorage.save.mockImplementation(
            async (key: string, bytes: Buffer) => {
              objects.set(key, bytes);
            },
          );
          attachmentStorage.delete.mockImplementation(async (key: string) => {
            objects.delete(key);
          });
          return objects;
        }

        /**
         * The target's current external keys, tracked from what the restore
         * inserted -- so the second call sees the row the first one wrote rather
         * than a fixture frozen before either.
         */
        function trackingQueries(initialKeys: string[]) {
          let current = [...initialKeys];
          mockQueryRunner.query.mockImplementation(
            (sql: string, params?: unknown[]) => {
              const text = String(sql);
              if (
                text.includes("SELECT storage_key FROM transaction_attachments")
              ) {
                return Promise.resolve(
                  current.map((storage_key) => ({ storage_key })),
                );
              }
              if (text.includes('INSERT INTO "transaction_attachments"')) {
                const written = (params ?? []).filter(
                  (v): v is string =>
                    typeof v === "string" &&
                    /^[0-9a-f-]{36}$/i.test(v) &&
                    v !== userId,
                );
                // The storage_key is among the row's UUID-shaped params; the
                // restore normalises it to the attachment id, so either is right.
                current = written.slice(-2);
              }
              return mockQueryHandler(sql, params);
            },
          );
        }

        it("restores the attachment both times", async () => {
          const objects = statefulStore({ [OLD_ID]: BYTES });
          trackingQueries([OLD_ID]);

          const first = await service.restoreData(
            userId,
            makeInput({ password: "test", data: backupWithLocalAttachment() }),
          );
          expect(first.restored.transactionAttachments).toBe(1);
          expect(first.skippedAttachments).toBeUndefined();

          // The artifact still names OLD_ID, so OLD_ID must still exist.
          expect(objects.has(OLD_ID)).toBe(true);

          const second = await service.restoreData(
            userId,
            makeInput({ password: "test", data: backupWithLocalAttachment() }),
          );
          // The failure this pins: the second restore used to skip the
          // attachment and delete the first restore's copy, so the bytes were
          // gone from every reachable key while the restore reported success.
          expect(second.restored.transactionAttachments).toBe(1);
          expect(second.skippedAttachments).toBeUndefined();
          expect(objects.has(OLD_ID)).toBe(true);
        });

        it("keeps some copy of the bytes reachable after both restores", async () => {
          const objects = statefulStore({ [OLD_ID]: BYTES });
          trackingQueries([OLD_ID]);

          await service.restoreData(
            userId,
            makeInput({ password: "test", data: backupWithLocalAttachment() }),
          );
          await service.restoreData(
            userId,
            makeInput({ password: "test", data: backupWithLocalAttachment() }),
          );

          // Whatever the keys ended up being, the receipt still exists.
          const remaining = [...objects.values()];
          expect(remaining.length).toBeGreaterThan(0);
          expect(remaining.some((b) => b.equals(BYTES))).toBe(true);
        });
      });

      it("removes staged objects when the restore transaction fails", async () => {
        attachmentStorage.load.mockResolvedValue(BYTES);
        mockQueryRunner.query.mockImplementation((sql: string, params) => {
          if (String(sql).includes('INSERT INTO "transaction_attachments"')) {
            return Promise.reject(new Error("constraint violation"));
          }
          return mockQueryHandler(sql, params as unknown[]);
        });

        await expect(
          service.restoreData(
            userId,
            makeInput({ password: "test", data: backupWithLocalAttachment() }),
          ),
        ).rejects.toThrow("constraint violation");

        const stagedKey = attachmentStorage.save.mock.calls[0][0];
        // The database rolled back; the object write did not, so it must not be
        // left behind with nothing referencing it.
        expect(attachmentStorage.delete).toHaveBeenCalledWith(stagedKey);
      });
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

      // Same obligation the OIDC forgery table carries: the backup file itself is
      // valid, so the refusal is the only thing between this request and an
      // erased account. The local path is where re-authentication has always
      // worked, which is exactly why a reordering would be noticed here last.
      const deletes = mockQueryRunner.query.mock.calls.filter(
        ([sql]: [unknown]) =>
          typeof sql === "string" && sql.includes("DELETE FROM"),
      );
      expect(deletes).toEqual([]);
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
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockDataSource.transaction).toHaveBeenCalled();
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

    it("should delete existing action_history during restore wipe", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await service.restoreData(userId, makeInput({ password: "test" }));

      const deleteCalls = mockQueryRunner.query.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === "string" &&
          call[0].includes("DELETE FROM action_history"),
      );
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0][1]).toEqual([userId]);
    });

    // Regression: the wipe used to guard the user-created-currency delete with
    // only user_currency_preferences and accounts. `currencies.code` is
    // referenced by nine columns across eight tables, and the one that actually
    // bit was `exchange_rates` -- global, never cleared by a restore, and
    // populated for every currency the FX backfill has seen. Any user who added
    // a custom currency and let the daily rate refresh run got
    // "violates foreign key constraint exchange_rates_to_currency_fkey" and
    // could not restore at all.
    it("guards the user-created-currency delete with the shared global check", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await service.restoreData(userId, makeInput({ password: "test" }));

      const [sql] = mockQueryRunner.query.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === "string" &&
          call[0].includes("DELETE FROM currencies"),
      ) as [string];

      // The `NOT EXISTS` chain this replaced listed every referencing column,
      // and was still wrong: running inside the restoring user's transaction, it
      // could not see the other users' rows those clauses were looking for, and
      // the ON DELETE CASCADE on user_currency_preferences fired.
      //
      // Whether the shared function consults every FK is asserted against the
      // schema in currencies/currency-references.spec.ts, which a new migration
      // cannot leave behind.
      expect(sql).toContain("NOT currency_code_in_use_globally(c.code)");
      expect(sql).not.toContain("NOT EXISTS");
    });

    it("should rollback transaction on error", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      mockQueryRunner.query.mockRejectedValueOnce(new Error("DB error"));

      await expect(
        service.restoreData(userId, makeInput({ password: "test" })),
      ).rejects.toThrow("DB error");

      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("runs the restore under the maintenance lease", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await service.restoreData(userId, makeInput({ password: "test" }));

      expect(maintenance.withMaintenanceLease).toHaveBeenCalledWith(
        userId,
        expect.stringContaining("restore"),
        expect.any(Function),
      );
    });

    it("deletes nothing when another operation is already replacing the data", async () => {
      // A restore landing mid-`.mny`-import wipes the rows that import's worker
      // is still writing, and the worker then writes the rest into the restored
      // dataset. The lease refuses before the delete phase, so the account is
      // left exactly as the other operation will leave it (DR-04-02).
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      maintenance.withMaintenanceLease.mockRejectedValue(
        new ConflictException("busy"),
      );

      await expect(
        service.restoreData(userId, makeInput({ password: "test" })),
      ).rejects.toThrow(ConflictException);

      const deletes = mockQueryRunner.query.mock.calls.filter(
        (call: string[]) => String(call[0]).includes("DELETE FROM"),
      );
      expect(deletes).toHaveLength(0);
    });

    it("takes the lease only after authentication succeeds", async () => {
      // A wrong password must not consume the lease and lock the real restore
      // out for the length of its TTL.
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        service.restoreData(userId, makeInput({ password: "wrong" })),
      ).rejects.toThrow();

      expect(maintenance.withMaintenanceLease).not.toHaveBeenCalled();
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

    it("restores institutions before accounts and defers institution_id", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const institutionId = randomUUID();
      const accountId = randomUUID();
      const backup = {
        ...validBackupData,
        institutions: [
          {
            id: institutionId,
            user_id: userId,
            name: "TD Canada Trust",
            website: "https://www.td.com",
            country: "CA",
            logo_data: null,
            has_logo: false,
          },
        ],
        accounts: [
          {
            id: accountId,
            user_id: userId,
            name: "Checking",
            institution_id: institutionId,
          },
        ],
      };

      await service.restoreData(
        userId,
        makeInput({ password: "test", data: backup }),
      );

      const insertCalls = mockQueryRunner.query.mock.calls.filter(
        (c: unknown[]) =>
          typeof c[0] === "string" && c[0].includes("INSERT INTO"),
      );

      // Institutions must be inserted before the accounts that reference them.
      const instIdx = insertCalls.findIndex((c: unknown[]) =>
        (c[0] as string).includes('"institutions"'),
      );
      const acctIdx = insertCalls.findIndex((c: unknown[]) =>
        (c[0] as string).includes('"accounts"'),
      );
      expect(instIdx).toBeGreaterThanOrEqual(0);
      expect(acctIdx).toBeGreaterThan(instIdx);

      // institution_id is a deferred FK column, stripped from the account INSERT.
      const accountInsert = insertCalls[acctIdx];
      expect(accountInsert[0]).not.toContain("institution_id");

      // ...and re-applied in Phase 3 via a guarded UPDATE keyed on remapped ids.
      const instRow = insertColumnMap(insertCalls[instIdx]);
      const acctRow = insertColumnMap(accountInsert);
      expect(instRow.id).not.toBe(institutionId);
      expect(acctRow.id).not.toBe(accountId);

      const institutionUpdate = mockQueryRunner.query.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          c[0].includes('UPDATE "accounts"') &&
          c[0].includes('"institution_id"'),
      );
      expect(institutionUpdate).toBeDefined();
      // The guard only sets the FK when the referenced institution exists.
      expect(institutionUpdate![0]).toContain(
        'EXISTS (SELECT 1 FROM "institutions"',
      );
      expect(institutionUpdate![1]).toEqual([instRow.id, acctRow.id]);
    });

    it("restores a legacy backup whose accounts reference institutions not in the backup", async () => {
      // Backups taken before institutions were added to the export still carry
      // accounts.institution_id. With no matching institution row, a naive
      // restore violates fk_accounts_institution. The deferral + EXISTS guard
      // must drop the dangling reference instead of failing the restore.
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const accountId = randomUUID();
      const danglingInstitutionId = randomUUID();
      const legacyBackup = {
        ...validBackupData,
        // No institutions key at all (legacy shape).
        institutions: undefined,
        accounts: [
          {
            id: accountId,
            user_id: userId,
            name: "Checking",
            institution_id: danglingInstitutionId,
          },
        ],
      };

      await expect(
        service.restoreData(
          userId,
          makeInput({ password: "test", data: legacyBackup as any }),
        ),
      ).resolves.toBeDefined();

      const accountInsert = mockQueryRunner.query.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          c[0].includes("INSERT INTO") &&
          c[0].includes('"accounts"'),
      );
      // institution_id must not be inserted directly.
      expect(accountInsert![0]).not.toContain("institution_id");

      // The Phase-3 UPDATE is still guarded; with no institution it sets nothing.
      const institutionUpdate = mockQueryRunner.query.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          c[0].includes('UPDATE "accounts"') &&
          c[0].includes('"institution_id"'),
      );
      expect(institutionUpdate).toBeDefined();
      expect(institutionUpdate![0]).toContain(
        'EXISTS (SELECT 1 FROM "institutions"',
      );
      // The dangling original id is never reused (no remap target existed).
      expect(institutionUpdate![1]).toEqual([
        danglingInstitutionId,
        insertColumnMap(accountInsert!).id,
      ]);
    });

    it("base64-decodes institution logo_data (bytea) on restore", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const institutionId = randomUUID();
      const logoBase64 = Buffer.from("fake-png-bytes").toString("base64");
      const backup = {
        ...validBackupData,
        institutions: [
          {
            id: institutionId,
            user_id: userId,
            name: "RBC",
            website: "https://www.rbc.com",
            logo_data: logoBase64,
            logo_content_type: "image/png",
            has_logo: true,
          },
        ],
      };

      await service.restoreData(
        userId,
        makeInput({ password: "test", data: backup }),
      );

      const institutionInsert = mockQueryRunner.query.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          c[0].includes("INSERT INTO") &&
          c[0].includes('"institutions"'),
      );
      expect(institutionInsert).toBeDefined();
      // The bytea placeholder is wrapped in decode(..., 'base64').
      expect(institutionInsert![0]).toContain("decode(");
      expect(institutionInsert![0]).toContain("'base64'");
      // The base64 string is passed through unchanged as the bound parameter.
      expect(institutionInsert![1]).toContain(logoBase64);
    });

    it("exports institutions with base64-encoded logo_data", async () => {
      const mockInstitutions = [
        { id: "inst-1", name: "TD", user_id: userId, logo_data: "YWJj" },
      ];
      const issuedSql: string[] = [];
      mockDataSource.query.mockImplementation((sql: string) => {
        issuedSql.push(sql);
        if (sql.includes("FROM institutions")) {
          return Promise.resolve(mockInstitutions);
        }
        return Promise.resolve([]);
      });

      const { buffer: buf } = await service.exportToBuffer(userId);
      const json = JSON.parse(gunzipSync(buf).toString("utf-8"));

      expect(json.institutions).toEqual(mockInstitutions);
      expect(
        issuedSql.some((s) => s.includes("encode(logo_data, 'base64')")),
      ).toBe(true);
    });

    it("deletes existing institutions during restore wipe", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await service.restoreData(userId, makeInput({ password: "test" }));

      const deletedInstitutions = mockQueryRunner.query.mock.calls.some(
        (c: unknown[]) =>
          typeof c[0] === "string" && c[0].includes("DELETE FROM institutions"),
      );
      expect(deletedInstitutions).toBe(true);
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

    /**
     * Invariant: a restore must not make a user's own GEM history look like it
     * belongs to a configuration they never had.
     * Canonical adversarial input: identifiers rewritten underneath derived
     * data (testing contract, ownership).
     * Minimal mutation: drop the `rehashGemSignalFingerprints` call.
     * Test that fails under it: the first below -- the signal keeps a hash of
     * the pre-restore security ids and the report treats it as stale.
     */
    describe("GEM signal fingerprints", () => {
      const securityId = randomUUID();
      const strategyId = randomUUID();

      /** The hash the strategy's configuration had before the restore. */
      const fingerprintFor = (secId: string) =>
        gemConfigFingerprint(
          { cadence: "MONTHLY", lookbackMonths: 12 } as never,
          [{ role: "US_EQUITY", securityId: secId }] as never,
        );

      const backupWith = (signalFingerprint: string) => ({
        ...validBackupData,
        securities: [{ id: securityId, user_id: userId, symbol: "SPY" }],
        gem_strategies: [
          {
            id: strategyId,
            user_id: userId,
            name: "GEM",
            cadence: "MONTHLY",
            lookback_months: 12,
          },
        ],
        gem_strategy_assets: [
          {
            id: randomUUID(),
            user_id: userId,
            strategy_id: strategyId,
            role: "US_EQUITY",
            security_id: securityId,
          },
        ],
        gem_strategy_signals: [
          {
            id: randomUUID(),
            user_id: userId,
            strategy_id: strategyId,
            evaluated_on: "2025-07-31",
            config_fingerprint: signalFingerprint,
            algorithm_version: 2,
          },
        ],
      });

      const restoredSignal = async (data: Record<string, unknown>) => {
        mockUserRepo.findOne.mockResolvedValue(mockUser);
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        await service.restoreData(
          userId,
          makeInput({ password: "test", data }),
        );
        const insert = mockQueryRunner.query.mock.calls.find(
          (c: unknown[]) =>
            typeof c[0] === "string" &&
            c[0].includes('INSERT INTO "gem_strategy_signals"'),
        );
        expect(insert).toBeDefined();
        return insertColumnMap(insert!);
      };

      it("re-hashes a current signal onto the remapped security ids", async () => {
        const row = await restoredSignal(
          backupWith(fingerprintFor(securityId)),
        );

        // The security got a new UUID, so the hash of the *same* configuration
        // is a different string -- and it must be that string, or the first
        // report after the restore recomputes or hides the user's own history.
        expect(row.config_fingerprint).not.toBe(fingerprintFor(securityId));
        expect(typeof row.config_fingerprint).toBe("string");
        expect((row.config_fingerprint as string).length).toBe(64);
      });

      it("leaves a signal that was already stale alone", async () => {
        // It answered a different configuration before the backup and still
        // does. Re-stamping it would promote retired history into the current
        // run, with its `executed` flags.
        const stale = "0".repeat(64);
        const row = await restoredSignal(backupWith(stale));

        expect(row.config_fingerprint).toBe(stale);
      });
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

    it("auto-creates a missing referenced currency with its real symbol, not the code", async () => {
      mockUserRepo.findOne.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      // USD is missing from the target instance (no bulk seed) and is not part
      // of a user backup, so it lands in the auto-create path.
      mockQueryRunner.query.mockImplementation((sql: string) => {
        if (
          typeof sql === "string" &&
          sql.includes("SELECT code FROM currencies")
        ) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const backupWithSystemCurrency = {
        ...validBackupData,
        currencies: [],
        accounts: [
          {
            id: "acc-1",
            user_id: userId,
            name: "USD Account",
            currency_code: "USD",
          },
        ],
      };

      await service.restoreData(
        userId,
        makeInput({ password: "test", data: backupWithSystemCurrency }),
      );

      const autoCreate = mockQueryRunner.query.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === "string" &&
          call[0].includes('INSERT INTO "currencies"') &&
          Array.isArray(call[1]) &&
          call[1][0] === "USD",
      );
      expect(autoCreate).toBeDefined();
      // params: [code, name, symbol, decimalPlaces, userId]
      expect(autoCreate![1]).toEqual(["USD", "US Dollar", "$", 2, userId]);
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

    it("runs the restore transaction under preserveTimestamps and issues no trigger DDL", async () => {
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

      // Capture the ambient preserveTimestamps flag at each transaction open --
      // that flag is what the real withScopedDb turns into the
      // app.preserve_timestamps GUC the updated_at trigger honours.
      const flagsSeen: (boolean | undefined)[] = [];
      const originalTransaction =
        mockDataSource.transaction.getMockImplementation()!;
      mockDataSource.transaction.mockImplementation((...args: unknown[]) => {
        flagsSeen.push(getRequestContext()?.preserveTimestamps);
        return originalTransaction(...(args as [never]));
      });

      await service.restoreData(
        userId,
        makeInput({ password: "test", data: backupWithFks }),
      );

      // The user lookup runs under the caller's plain context; the restore
      // transaction itself carries the flag.
      expect(flagsSeen[0]).toBeUndefined();
      expect(flagsSeen[flagsSeen.length - 1]).toBe(true);

      const allCalls = mockQueryRunner.query.mock.calls.map(
        (call: unknown[]) => call[0] as string,
      );

      // The deferred-FK UPDATE still runs -- with no trigger DDL around it.
      // The old DISABLE/ENABLE pair required table ownership, which the
      // runtime role does not have under RLS enforcement.
      const updateIdx = allCalls.findIndex(
        (sql) =>
          sql.includes("UPDATE") &&
          sql.includes('"accounts"') &&
          sql.includes('"linked_account_id"'),
      );
      expect(updateIdx).toBeGreaterThan(-1);
      expect(
        allCalls.some(
          (sql) =>
            sql.includes("DISABLE TRIGGER") || sql.includes("ENABLE TRIGGER"),
        ),
      ).toBe(false);
    });

    it("keeps trigger DDL out of the restore path (source guard)", () => {
      // Regression guard for task C5: the mechanism for preserving restored
      // timestamps is the app.preserve_timestamps GUC, never ALTER TABLE
      // trigger DDL -- any reappearance is a bug wherever it is. Scanned across
      // the module rather than one file, because after issue #1092 the restore's
      // SQL lives in `backup-restore-database.service.ts` and a guard aimed only
      // at `backup.service.ts` would assert nothing.
      for (const { file, text } of backupModuleSources()) {
        expect(`${file}: ${text}`).not.toMatch(/DISABLE TRIGGER/);
        expect(`${file}: ${text}`).not.toMatch(/ENABLE TRIGGER/);
      }
    });

    it("accepts a genuine re-authentication artifact for OIDC users", async () => {
      // The one shape that may restore an OIDC account: signed with JWT_SECRET,
      // minted for this user and for "restore-backup", unspent, unexpired. Every
      // rejection below is a near miss of this, so this case is what proves they
      // fail for the reason claimed rather than because the path is broken.
      const oidcModule = {
        ...mockUser,
        authProvider: "oidc",
        passwordHash: null,
        oidcSubject: "sub-1",
      };
      mockUserRepo.findOne.mockResolvedValue(oidcModule);

      const result = await service.restoreData(
        userId,
        makeInput({ oidcIdToken: oidcArtifact() }),
      );

      expect(result.message).toBe("Backup restored successfully");
    });

    // P2-005 / F3RB-007. Restore is the most destructive action in the product:
    // it deletes everything the user has and writes the file's contents in its
    // place. Every one of these used to be accepted, because the check was only
    // whether the field was non-empty -- and the first entry is the exact string
    // the shipped frontend sent, so it is the one a regression reaches first.
    //
    // Each case is a *near miss* of the artifact the test above accepts: one
    // property wrong and nothing else. That is what makes them evidence about
    // the individual checks rather than about the path being broken.
    //
    // Minted lazily. Signing at table-construction time would run before the
    // beforeAll that installs JWT_SECRET.
    const REAUTH_FORGERIES: ReadonlyArray<readonly [string, () => string]> = [
      ["the sentinel the client used to send", () => "oidc-session-confirmed"],
      ["any non-empty string", () => "x"],
      ["an unsigned JWT-shaped value", () => "a.b.c"],
      [
        "an alg=none token carrying every correct claim",
        () =>
          jwt.sign(
            {
              sub: userId,
              type: "oidc_reauth",
              purpose: "restore-backup",
              jti: randomUUID(),
            },
            "",
            { algorithm: "none" },
          ),
      ],
      [
        "a correct payload signed with a foreign key",
        () =>
          jwt.sign(
            {
              sub: userId,
              type: "oidc_reauth",
              purpose: "restore-backup",
              jti: randomUUID(),
            },
            "a-different-secret-of-at-least-32-characters",
            { algorithm: "HS256", expiresIn: 300 },
          ),
      ],
      [
        "an artifact that has expired",
        () =>
          jwt.sign(
            {
              sub: userId,
              type: "oidc_reauth",
              purpose: "restore-backup",
              jti: randomUUID(),
            },
            SPEC_JWT_SECRET,
            { algorithm: "HS256", expiresIn: -10 },
          ),
      ],
      [
        // A session token is the factor the artifact exists to be independent
        // of. Accepting one collapses the second proof into the first, which is
        // precisely the defect.
        "an ordinary access token for the same user",
        () =>
          jwt.sign({ sub: userId, type: "access" }, SPEC_JWT_SECRET, {
            algorithm: "HS256",
            expiresIn: 900,
          }),
      ],
      [
        // Signed by us, bound to this user and this purpose -- but minted by the
        // step-up service, which for an OIDC account issues on the strength of a
        // re-auth artifact. Spending one here would let a single round trip be
        // laundered into a second authorization.
        "a step-up token for the same user and purpose",
        () =>
          jwt.sign(
            { sub: userId, type: "step_up", purpose: "restore-backup" },
            SPEC_JWT_SECRET,
            { algorithm: "HS256", expiresIn: 300 },
          ),
      ],
    ];

    it.each(REAUTH_FORGERIES)(
      "refuses %s as re-authentication for restore",
      async (_label, mint) => {
        mockUserRepo.findOne.mockResolvedValue({
          ...mockUser,
          authProvider: "oidc",
          passwordHash: null,
          oidcSubject: "sub-1",
        });

        await expect(
          service.restoreData(userId, makeInput({ oidcIdToken: mint() })),
        ).rejects.toThrow(UnauthorizedException);

        // The half that matters more than the status code. The file here is a
        // perfectly valid backup, so everything ahead of the check succeeds and
        // the only thing standing between this request and an erased account is
        // `verifyAuthentication`. A 401 the client sees cannot un-delete a row,
        // so assert the database was never touched -- not merely that the call
        // threw. (A transaction *is* open by this point; the user lookup runs in
        // one. The claim is that no data was destroyed.)
        const deletes = mockQueryRunner.query.mock.calls.filter(
          ([sql]) => typeof sql === "string" && sql.includes("DELETE FROM"),
        );
        expect(deletes).toEqual([]);
      },
    );

    it("refuses an artifact minted to delete data rather than restore", async () => {
      mockUserRepo.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: null,
        oidcSubject: "sub-1",
      });

      await expect(
        service.restoreData(
          userId,
          makeInput({ oidcIdToken: oidcArtifact("delete-data") }),
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("refuses an artifact minted for a different user", async () => {
      mockUserRepo.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: null,
        oidcSubject: "sub-1",
      });

      await expect(
        service.restoreData(
          userId,
          makeInput({
            oidcIdToken: oidcArtifact("restore-backup", "another-user"),
          }),
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("spends the artifact, so a replayed restore is refused", async () => {
      mockUserRepo.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: null,
        oidcSubject: "sub-1",
      });
      const artifact = oidcArtifact();

      await service.restoreData(userId, makeInput({ oidcIdToken: artifact }));
      await expect(
        service.restoreData(userId, makeInput({ oidcIdToken: artifact })),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("does not spend the re-authentication when the file is unusable", async () => {
      // The artifact is single-use and the round trip that mints it loses the
      // file selection, so a wrong backup password or a non-Monize file must not
      // cost one. Nothing is written either way.
      mockUserRepo.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
        passwordHash: null,
        oidcSubject: "sub-1",
      });
      const artifact = oidcArtifact();

      await expect(
        service.restoreData(userId, {
          compressedData: Buffer.from("not gzip at all"),
          oidcIdToken: artifact,
        }),
      ).rejects.toThrow(BadRequestException);

      // Still good: the user fixes the file and retries without another round trip.
      await expect(
        service.restoreData(userId, makeInput({ oidcIdToken: artifact })),
      ).resolves.toMatchObject({ message: "Backup restored successfully" });
    });

    it("refuses a local account with no password to check", async () => {
      // This branch fell off the end of the else-if chain and required no proof.
      mockUserRepo.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "local",
        passwordHash: null,
      });

      await expect(service.restoreData(userId, makeInput({}))).rejects.toThrow(
        UnauthorizedException,
      );
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
          oidcIdToken: oidcArtifact(),
        }),
      );

      expect(result.message).toBe("Backup restored successfully");
    });

    describe("encrypted backups", () => {
      function encryptedBlob(data: Record<string, unknown>, password: string) {
        return encryptBackup(compressBackupData(data), password);
      }

      it("restores what the streaming export actually writes (framed container)", async () => {
        // The two halves are separated by the file format, so a change to one
        // that misses the other produces a download nobody can restore. This
        // takes the bytes the export emits -- a v2 framed envelope since issue
        // #1070 -- and feeds them back in rather than re-encrypting a fixture.
        const { res, chunks } = responseDouble();
        await service.streamExport(userId, res, "round-trip-password");
        const artifact = Buffer.concat(chunks);
        expect(artifact[4]).toBe(2);

        mockUserRepo.findOne.mockResolvedValue(mockUser);
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        const result = await service.restoreData(userId, {
          compressedData: artifact,
          password: "login-password",
          backupPassword: "round-trip-password",
        });

        expect(result.message).toBe("Backup restored successfully");
      });

      it("decrypts using the auth password when nothing more specific is provided", async () => {
        mockUserRepo.findOne.mockResolvedValue(mockUser);
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        const result = await service.restoreData(userId, {
          compressedData: await encryptedBlob(validBackupData, "user-password"),
          password: "user-password",
        });
        expect(result.message).toBe("Backup restored successfully");
      });

      it("prefers the explicit backupPassword over the auth password", async () => {
        mockUserRepo.findOne.mockResolvedValue(mockUser);
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        const result = await service.restoreData(userId, {
          compressedData: await encryptedBlob(
            validBackupData,
            "old-backup-password",
          ),
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
          compressedData: await encryptedBlob(validBackupData, "stored-bk-pw"),
          oidcIdToken: oidcArtifact(),
        });
        expect(result.message).toBe("Backup restored successfully");
      });

      it("throws a BACKUP_PASSWORD_REQUIRED error when no candidate decrypts", async () => {
        mockUserRepo.findOne.mockResolvedValue(mockUser);
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        await expect(
          service.restoreData(userId, {
            compressedData: await encryptedBlob(validBackupData, "real-pw"),
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
