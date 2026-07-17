import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import * as bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { createGzip, gunzipSync, gzipSync } from "zlib";
import { User } from "../users/entities/user.entity";
import { AiEncryptionService } from "../ai/ai-encryption.service";
import {
  encryptBackup,
  decryptBackup,
  isEncryptedBackup,
  BackupDecryptionError,
} from "./backup-crypto.util";
import { tr } from "../i18n/translate";

export interface RestoreBackupInput {
  compressedData: Buffer;
  password?: string;
  oidcIdToken?: string;
  // Password used to encrypt the backup file. For local users this is usually
  // the same as `password`; if the user rotated their login password since the
  // backup was made, the frontend re-prompts and sends the old one here.
  backupPassword?: string;
}

export class BackupPasswordRequiredError extends BadRequestException {
  constructor(message: string) {
    super({ message, code: "BACKUP_PASSWORD_REQUIRED" });
  }
}

const BACKUP_VERSION = 1;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tables that `insertRows` is permitted to write during a restore. This is the
 * single source of truth for the restore allowlist -- the export side derives
 * its coverage from `getTableQueries()`, and the two are kept in lockstep by the
 * coverage guard test (backup-restore.integration.spec.ts).
 *
 * `currencies` is intentionally absent: it is restored separately via
 * `ensureCurrenciesExist` (shared, code-keyed rows), not through `insertRows`.
 */
export const RESTORABLE_TABLES: ReadonlySet<string> = new Set([
  "user_preferences",
  "user_currency_preferences",
  "categories",
  "payees",
  "payee_aliases",
  "institutions",
  "accounts",
  "tags",
  "transactions",
  "transaction_splits",
  "transaction_tags",
  "transaction_split_tags",
  "scheduled_transactions",
  "scheduled_transaction_splits",
  "scheduled_transaction_overrides",
  "scheduled_transaction_split_tags",
  "securities",
  "security_prices",
  "holdings",
  "security_tags",
  "investment_transactions",
  "loan_rate_changes",
  "loan_scenarios",
  "budgets",
  "budget_categories",
  "budget_periods",
  "budget_period_categories",
  "budget_alerts",
  "custom_reports",
  "investment_reports",
  "import_column_mappings",
  "monthly_account_balances",
  "auto_backup_settings",
  "ai_provider_configs",
  "monte_carlo_scenarios",
  "monte_carlo_cash_flows",
]);

/**
 * User-owned tables that are deliberately NOT part of a backup, each with the
 * reason. The coverage guard test asserts every table in the database is either
 * exported (see `getBackedUpTableNames`) or listed here, so adding a new entity
 * forces an explicit decision instead of silently dropping data on restore.
 */
const INTENTIONALLY_EXCLUDED_TABLES: ReadonlySet<string> = new Set([
  "users", // the account row itself; a restore targets an existing user
  "action_history", // undo/redo log, wiped on restore (not undoable to prior state)
  "ai_insights", // regenerable AI cache
  "ai_usage_logs", // usage telemetry, not user content
  "exchange_rates", // global shared reference data, not per-user
  "account_delegates", // cross-user sharing relationship
  "account_delegate_grants", // cross-user sharing relationship
  "delegate_account_favourites", // cross-user sharing state
  "emergency_access_contacts", // cross-user emergency-access config
  "emergency_access_settings", // cross-user emergency-access config
  "oauth_payloads", // transient OIDC state
  "personal_access_tokens", // auth credentials -- never exported
  "refresh_tokens", // auth session tokens -- never exported
  "trusted_devices", // 2FA device registrations -- never exported
  "schema_migrations", // migration bookkeeping (no entity; system table)
]);

interface BackupData {
  version: number;
  exportedAt: string;
  currencies: Record<string, unknown>[];
  user_preferences: Record<string, unknown>[];
  user_currency_preferences: Record<string, unknown>[];
  categories: Record<string, unknown>[];
  payees: Record<string, unknown>[];
  payee_aliases: Record<string, unknown>[];
  institutions: Record<string, unknown>[];
  accounts: Record<string, unknown>[];
  tags: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
  transaction_splits: Record<string, unknown>[];
  transaction_tags: Record<string, unknown>[];
  transaction_split_tags: Record<string, unknown>[];
  scheduled_transactions: Record<string, unknown>[];
  scheduled_transaction_splits: Record<string, unknown>[];
  scheduled_transaction_overrides: Record<string, unknown>[];
  securities: Record<string, unknown>[];
  security_prices: Record<string, unknown>[];
  holdings: Record<string, unknown>[];
  investment_transactions: Record<string, unknown>[];
  loan_rate_changes: Record<string, unknown>[];
  loan_scenarios: Record<string, unknown>[];
  security_tags: Record<string, unknown>[];
  budgets: Record<string, unknown>[];
  budget_categories: Record<string, unknown>[];
  budget_periods: Record<string, unknown>[];
  budget_period_categories: Record<string, unknown>[];
  budget_alerts: Record<string, unknown>[];
  custom_reports: Record<string, unknown>[];
  investment_reports: Record<string, unknown>[];
  import_column_mappings: Record<string, unknown>[];
  monthly_account_balances: Record<string, unknown>[];
  auto_backup_settings: Record<string, unknown>[];
  scheduled_transaction_split_tags: Record<string, unknown>[];
  monte_carlo_scenarios: Record<string, unknown>[];
  monte_carlo_cash_flows: Record<string, unknown>[];
  ai_provider_configs: Record<string, unknown>[];
}

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly aiEncryption: AiEncryptionService,
  ) {}

  /**
   * Resolves the password the auto-backup cron should use for encryption.
   * Returns null when encryption is disabled or no password is stored.
   */
  resolveStoredBackupPassword(user: User): string | null {
    if (!user.backupEncryptionEnabled || !user.backupPasswordEnc) {
      return null;
    }
    try {
      return this.aiEncryption.decrypt(user.backupPasswordEnc);
    } catch (err) {
      this.logger.error(
        `Failed to decrypt stored backup password for user ${user.id}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Produces the full backup file as a Buffer -- gzipped JSON, optionally
   * encrypted. Used by the auto-backup cron which needs to write to disk.
   */
  async exportToBuffer(
    userId: string,
    encryptionPassword?: string,
  ): Promise<Buffer> {
    const gzipped = await this.collectGzippedExport(userId);
    return encryptionPassword
      ? encryptBackup(gzipped, encryptionPassword)
      : gzipped;
  }

  async streamExport(
    userId: string,
    res: import("express").Response,
    encryptionPassword?: string,
  ): Promise<void> {
    this.logger.log(
      `Starting backup export for user ${userId}${encryptionPassword ? " (encrypted)" : ""}`,
    );

    // Encrypted exports require the full payload up-front to compute the GCM
    // auth tag, so we buffer JSON in memory before encrypting. Plain exports
    // stream straight through gzip to avoid OOM on very large datasets.
    if (encryptionPassword) {
      const gzipped = await this.collectGzippedExport(userId);
      const encrypted = encryptBackup(gzipped, encryptionPassword);
      res.write(encrypted);
      res.end();
      this.logger.log(`Backup export completed for user ${userId} (encrypted)`);
      return;
    }

    const tableQueries = this.getTableQueries();

    // Stream JSON through gzip to the response, one table at a time, to
    // avoid OOM and produce a smaller download.
    const gzip = createGzip();
    gzip.pipe(res);

    const write = (chunk: string): Promise<void> =>
      new Promise((resolve, _reject) => {
        if (!gzip.write(chunk)) {
          gzip.once("drain", resolve);
        } else {
          resolve();
        }
      });

    await write(
      `{"version":${BACKUP_VERSION},"exportedAt":"${new Date().toISOString()}"`,
    );

    for (const { key, sql } of tableQueries) {
      const rows = await this.query(sql, [userId]);
      await write(`,"${key}":${JSON.stringify(rows)}`);
    }

    await write("}");

    await new Promise<void>((resolve, reject) => {
      gzip.once("error", reject);
      gzip.end(resolve);
    });

    this.logger.log(`Backup export completed for user ${userId}`);
  }

  /**
   * The set of tables the export writes (and the restore repopulates). Exposed
   * so the coverage guard test can assert every database table is either backed
   * up or explicitly excluded (see INTENTIONALLY_EXCLUDED_TABLES).
   */
  getBackedUpTableNames(): string[] {
    return this.getTableQueries().map((q) => q.key);
  }

  /** The tables deliberately omitted from backups, exposed for the guard test. */
  getIntentionallyExcludedTableNames(): string[] {
    return Array.from(INTENTIONALLY_EXCLUDED_TABLES);
  }

  /**
   * Collects the full export as an in-memory map of table -> rows, using the
   * same queries as the streamed/gzipped export. Consumed by the support
   * (de-identified) backup, which must hold every table at once to reconcile
   * scaled balances before serializing. Returns the same version/exportedAt
   * envelope fields the file format uses.
   */
  async collectRawExport(userId: string): Promise<{
    version: number;
    exportedAt: string;
    tables: Record<string, Record<string, unknown>[]>;
  }> {
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const { key, sql } of this.getTableQueries()) {
      tables[key] = await this.query(sql, [userId]);
    }
    return {
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      tables,
    };
  }

  private getTableQueries(): Array<{ key: string; sql: string }> {
    return [
      {
        key: "currencies",
        sql: "SELECT * FROM currencies WHERE created_by_user_id = $1",
      },
      {
        key: "user_preferences",
        sql: "SELECT * FROM user_preferences WHERE user_id = $1",
      },
      {
        key: "user_currency_preferences",
        sql: "SELECT * FROM user_currency_preferences WHERE user_id = $1",
      },
      {
        key: "categories",
        sql: "SELECT * FROM categories WHERE user_id = $1 ORDER BY parent_id NULLS FIRST, name",
      },
      {
        key: "payees",
        sql: "SELECT * FROM payees WHERE user_id = $1 ORDER BY name",
      },
      {
        key: "payee_aliases",
        sql: "SELECT * FROM payee_aliases WHERE user_id = $1",
      },
      {
        // Institutions must be exported (and restored) before accounts because
        // accounts.institution_id has an FK to institutions(id). The logo_data
        // BYTEA column is base64-encoded so it survives JSON serialization;
        // insertRows decodes it back to bytea on restore.
        key: "institutions",
        sql: `SELECT id, user_id, name, website, country,
                     encode(logo_data, 'base64') AS logo_data,
                     logo_content_type, has_logo, logo_fetched_at,
                     created_at, updated_at
              FROM institutions WHERE user_id = $1 ORDER BY name`,
      },
      {
        key: "accounts",
        sql: "SELECT * FROM accounts WHERE user_id = $1 ORDER BY name",
      },
      {
        key: "tags",
        sql: "SELECT * FROM tags WHERE user_id = $1 ORDER BY name",
      },
      {
        key: "transactions",
        sql: "SELECT * FROM transactions WHERE user_id = $1 ORDER BY transaction_date, created_at",
      },
      {
        key: "transaction_splits",
        sql: `SELECT ts.* FROM transaction_splits ts
              JOIN transactions t ON ts.transaction_id = t.id
              WHERE t.user_id = $1`,
      },
      {
        key: "transaction_tags",
        sql: `SELECT tt.* FROM transaction_tags tt
              JOIN transactions t ON tt.transaction_id = t.id
              WHERE t.user_id = $1`,
      },
      {
        key: "transaction_split_tags",
        sql: `SELECT tst.* FROM transaction_split_tags tst
              JOIN transaction_splits ts ON tst.transaction_split_id = ts.id
              JOIN transactions t ON ts.transaction_id = t.id
              WHERE t.user_id = $1`,
      },
      {
        key: "scheduled_transactions",
        sql: "SELECT * FROM scheduled_transactions WHERE user_id = $1",
      },
      {
        key: "scheduled_transaction_splits",
        sql: `SELECT sts.* FROM scheduled_transaction_splits sts
              JOIN scheduled_transactions st ON sts.scheduled_transaction_id = st.id
              WHERE st.user_id = $1`,
      },
      {
        key: "scheduled_transaction_overrides",
        sql: `SELECT sto.* FROM scheduled_transaction_overrides sto
              JOIN scheduled_transactions st ON sto.scheduled_transaction_id = st.id
              WHERE st.user_id = $1`,
      },
      {
        key: "scheduled_transaction_split_tags",
        sql: `SELECT stst.* FROM scheduled_transaction_split_tags stst
              JOIN scheduled_transaction_splits sts ON stst.scheduled_transaction_split_id = sts.id
              JOIN scheduled_transactions st ON sts.scheduled_transaction_id = st.id
              WHERE st.user_id = $1`,
      },
      { key: "securities", sql: "SELECT * FROM securities WHERE user_id = $1" },
      {
        key: "security_prices",
        sql: `SELECT sp.* FROM security_prices sp
              JOIN securities s ON sp.security_id = s.id
              WHERE s.user_id = $1`,
      },
      {
        key: "holdings",
        sql: `SELECT h.* FROM holdings h
              JOIN accounts a ON h.account_id = a.id
              WHERE a.user_id = $1`,
      },
      {
        key: "investment_transactions",
        sql: "SELECT * FROM investment_transactions WHERE user_id = $1",
      },
      {
        // Join tags between securities and tags. Owned transitively via the
        // securities/tags rows, so scope by the security's owner.
        key: "security_tags",
        sql: `SELECT st.* FROM security_tags st
              JOIN securities s ON st.security_id = s.id
              WHERE s.user_id = $1`,
      },
      {
        key: "loan_rate_changes",
        sql: "SELECT * FROM loan_rate_changes WHERE user_id = $1",
      },
      {
        key: "loan_scenarios",
        sql: "SELECT * FROM loan_scenarios WHERE user_id = $1",
      },
      { key: "budgets", sql: "SELECT * FROM budgets WHERE user_id = $1" },
      {
        key: "budget_categories",
        sql: `SELECT bc.* FROM budget_categories bc
              JOIN budgets b ON bc.budget_id = b.id
              WHERE b.user_id = $1`,
      },
      {
        key: "budget_periods",
        sql: `SELECT bp.* FROM budget_periods bp
              JOIN budgets b ON bp.budget_id = b.id
              WHERE b.user_id = $1`,
      },
      {
        key: "budget_period_categories",
        sql: `SELECT bpc.* FROM budget_period_categories bpc
              JOIN budget_periods bp ON bpc.budget_period_id = bp.id
              JOIN budgets b ON bp.budget_id = b.id
              WHERE b.user_id = $1`,
      },
      {
        key: "budget_alerts",
        sql: "SELECT * FROM budget_alerts WHERE user_id = $1",
      },
      {
        key: "custom_reports",
        sql: "SELECT * FROM custom_reports WHERE user_id = $1",
      },
      {
        key: "investment_reports",
        sql: "SELECT * FROM investment_reports WHERE user_id = $1",
      },
      {
        key: "import_column_mappings",
        sql: "SELECT * FROM import_column_mappings WHERE user_id = $1",
      },
      {
        key: "monthly_account_balances",
        sql: "SELECT * FROM monthly_account_balances WHERE user_id = $1",
      },
      {
        key: "auto_backup_settings",
        sql: "SELECT * FROM auto_backup_settings WHERE user_id = $1",
      },
      {
        key: "ai_provider_configs",
        sql: "SELECT * FROM ai_provider_configs WHERE user_id = $1",
      },
      {
        key: "monte_carlo_scenarios",
        sql: "SELECT * FROM monte_carlo_scenarios WHERE user_id = $1",
      },
      {
        key: "monte_carlo_cash_flows",
        sql: `SELECT mccf.* FROM monte_carlo_cash_flows mccf
              JOIN monte_carlo_scenarios mcs ON mccf.scenario_id = mcs.id
              WHERE mcs.user_id = $1`,
      },
    ];
  }

  /**
   * Builds the gzipped JSON backup payload as a single Buffer in memory.
   * Used by the encryption path (which needs the whole payload to compute
   * the GCM auth tag) and the auto-backup writer.
   */
  private async collectGzippedExport(userId: string): Promise<Buffer> {
    const tableQueries = this.getTableQueries();
    const parts: string[] = [
      `{"version":${BACKUP_VERSION},"exportedAt":"${new Date().toISOString()}"`,
    ];
    for (const { key, sql } of tableQueries) {
      const rows = await this.query(sql, [userId]);
      parts.push(`,"${key}":${JSON.stringify(rows)}`);
    }
    parts.push("}");
    return gzipSync(Buffer.from(parts.join(""), "utf-8"));
  }

  async restoreData(
    userId: string,
    input: RestoreBackupInput,
  ): Promise<{ message: string; restored: Record<string, number> }> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(
        tr("errors.backup.userNotFoundRestore", "User not found"),
      );
    }

    await this.verifyAuthentication(user, input);

    const gzippedPayload = this.maybeDecrypt(input, user);
    const rawData = this.decompressAndParse(gzippedPayload);
    this.validateBackupFormat(rawData);

    // Remap every primary key in the backup to a fresh UUID (and rewrite all
    // references to those keys, including ids embedded in JSONB columns) so the
    // restore behaves as if the backup came from an entirely separate system.
    // Without this, restoring one user's backup into another user's account on
    // the SAME system would collide on the original UUIDs: the inserts would be
    // silently skipped by ON CONFLICT DO NOTHING, and the Phase-3 deferred-FK
    // UPDATEs (keyed only by id) would mutate the OTHER user's rows.
    const idRemap = this.buildBackupIdRemap(rawData);
    const data = this.remapBackupIds(rawData, idRemap);

    this.logger.log(`Starting backup restore for user ${userId}`);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    const restored: Record<string, number> = {};

    try {
      // Phase 1: Delete all existing user data (same order as deleteData in users.service)
      await this.deleteAllUserData(userId, queryRunner);

      // Phase 2: Insert backup data in FK-safe order.
      // Columns that create circular or forward FK references are stripped
      // during insert and restored in Phase 3 via UPDATE.

      // Ensure all referenced currency codes exist before restoring tables
      // that have FK references to currencies(code).
      await this.ensureCurrenciesExist(queryRunner, data, userId);

      restored.userPreferences = await this.insertRows(
        queryRunner,
        "user_preferences",
        data.user_preferences,
        userId,
      );
      restored.userCurrencyPreferences = await this.insertRows(
        queryRunner,
        "user_currency_preferences",
        data.user_currency_preferences,
        userId,
      );
      restored.categories = await this.insertRows(
        queryRunner,
        "categories",
        data.categories,
        userId,
      );
      restored.payees = await this.insertRows(
        queryRunner,
        "payees",
        data.payees,
        userId,
      );
      restored.payeeAliases = await this.insertRows(
        queryRunner,
        "payee_aliases",
        data.payee_aliases,
        userId,
      );
      restored.institutions = await this.insertRows(
        queryRunner,
        "institutions",
        data.institutions,
        userId,
      );
      restored.accounts = await this.insertRows(
        queryRunner,
        "accounts",
        data.accounts,
        userId,
      );
      restored.tags = await this.insertRows(
        queryRunner,
        "tags",
        data.tags,
        userId,
      );
      restored.scheduledTransactions = await this.insertRows(
        queryRunner,
        "scheduled_transactions",
        data.scheduled_transactions,
        userId,
      );
      restored.scheduledTransactionSplits = await this.insertRows(
        queryRunner,
        "scheduled_transaction_splits",
        data.scheduled_transaction_splits,
        null,
      );
      restored.scheduledTransactionOverrides = await this.insertRows(
        queryRunner,
        "scheduled_transaction_overrides",
        data.scheduled_transaction_overrides,
        null,
      );
      restored.scheduledTransactionSplitTags = await this.insertRows(
        queryRunner,
        "scheduled_transaction_split_tags",
        data.scheduled_transaction_split_tags,
        null,
      );
      restored.securities = await this.insertRows(
        queryRunner,
        "securities",
        data.securities,
        userId,
      );
      restored.securityPrices = await this.insertRows(
        queryRunner,
        "security_prices",
        data.security_prices,
        null,
      );
      restored.holdings = await this.insertRows(
        queryRunner,
        "holdings",
        data.holdings,
        null,
      );
      restored.securityTags = await this.insertRows(
        queryRunner,
        "security_tags",
        data.security_tags,
        null,
      );
      restored.transactions = await this.insertRows(
        queryRunner,
        "transactions",
        data.transactions,
        userId,
      );
      restored.transactionSplits = await this.insertRows(
        queryRunner,
        "transaction_splits",
        data.transaction_splits,
        null,
      );
      restored.transactionTags = await this.insertRows(
        queryRunner,
        "transaction_tags",
        data.transaction_tags,
        null,
      );
      restored.transactionSplitTags = await this.insertRows(
        queryRunner,
        "transaction_split_tags",
        data.transaction_split_tags,
        null,
      );
      restored.investmentTransactions = await this.insertRows(
        queryRunner,
        "investment_transactions",
        data.investment_transactions,
        userId,
      );
      restored.loanRateChanges = await this.insertRows(
        queryRunner,
        "loan_rate_changes",
        data.loan_rate_changes,
        userId,
      );
      restored.loanScenarios = await this.insertRows(
        queryRunner,
        "loan_scenarios",
        data.loan_scenarios,
        userId,
      );
      restored.budgets = await this.insertRows(
        queryRunner,
        "budgets",
        data.budgets,
        userId,
      );
      restored.budgetCategories = await this.insertRows(
        queryRunner,
        "budget_categories",
        data.budget_categories,
        null,
      );
      restored.budgetPeriods = await this.insertRows(
        queryRunner,
        "budget_periods",
        data.budget_periods,
        null,
      );
      restored.budgetPeriodCategories = await this.insertRows(
        queryRunner,
        "budget_period_categories",
        data.budget_period_categories,
        null,
      );
      restored.budgetAlerts = await this.insertRows(
        queryRunner,
        "budget_alerts",
        data.budget_alerts,
        userId,
      );
      restored.customReports = await this.insertRows(
        queryRunner,
        "custom_reports",
        data.custom_reports,
        userId,
      );
      restored.investmentReports = await this.insertRows(
        queryRunner,
        "investment_reports",
        data.investment_reports,
        userId,
      );
      restored.importColumnMappings = await this.insertRows(
        queryRunner,
        "import_column_mappings",
        data.import_column_mappings,
        userId,
      );
      restored.monthlyAccountBalances = await this.insertRows(
        queryRunner,
        "monthly_account_balances",
        data.monthly_account_balances,
        userId,
      );
      restored.autoBackupSettings = await this.insertRows(
        queryRunner,
        "auto_backup_settings",
        data.auto_backup_settings,
        userId,
      );
      restored.aiProviderConfigs = await this.insertRows(
        queryRunner,
        "ai_provider_configs",
        data.ai_provider_configs,
        userId,
      );
      restored.monteCarloScenarios = await this.insertRows(
        queryRunner,
        "monte_carlo_scenarios",
        data.monte_carlo_scenarios,
        userId,
      );
      restored.monteCarloCashFlows = await this.insertRows(
        queryRunner,
        "monte_carlo_cash_flows",
        data.monte_carlo_cash_flows,
        null,
      );

      // Phase 3: Restore deferred FK columns that were stripped during insert
      // to avoid circular/forward reference violations.
      await this.restoreDeferredFkColumns(queryRunner, data);

      await queryRunner.commitTransaction();
      this.logger.log(`Backup restore completed for user ${userId}`);
      return { message: "Backup restored successfully", restored };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Backup restore failed for user ${userId}: ${error.message}`,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async query(
    sql: string,
    params: unknown[],
  ): Promise<Record<string, unknown>[]> {
    return this.dataSource.query(sql, params);
  }

  /**
   * If the upload is encrypted, decrypt it using (in order of preference):
   * 1) the explicit backupPassword the frontend sent for this restore,
   * 2) the user's auth password (most backups encrypt with this),
   * 3) the user's currently stored backup password.
   *
   * Returns the inner gzipped JSON payload, or the input unchanged if it's
   * not encrypted. Throws BackupPasswordRequiredError when we know it's
   * encrypted but every available password failed -- the frontend uses that
   * to prompt the user for the password the backup was made with.
   */
  private maybeDecrypt(input: RestoreBackupInput, user: User): Buffer {
    if (!isEncryptedBackup(input.compressedData)) {
      return input.compressedData;
    }

    const candidates: string[] = [];
    if (input.backupPassword) candidates.push(input.backupPassword);
    if (input.password) candidates.push(input.password);
    const stored = this.resolveStoredBackupPassword(user);
    if (stored) candidates.push(stored);

    for (const pw of candidates) {
      try {
        return decryptBackup(input.compressedData, pw);
      } catch (err) {
        if (!(err instanceof BackupDecryptionError)) throw err;
        // try next candidate
      }
    }

    throw new BackupPasswordRequiredError(
      input.backupPassword
        ? tr(
            "errors.backup.backupPasswordWrong",
            "The password you entered cannot decrypt this backup. Try the password that was set when the backup was created.",
          )
        : tr(
            "errors.backup.backupPasswordRequired",
            "This backup is encrypted. Provide the password that was used when the backup was created.",
          ),
    );
  }

  private decompressAndParse(compressedData: Buffer): BackupData {
    let json: string;
    try {
      const decompressed = gunzipSync(compressedData);
      json = decompressed.toString("utf-8");
    } catch {
      throw new BadRequestException(
        tr(
          "errors.backup.decompressFailed",
          "Failed to decompress backup file. Ensure the file is gzip-compressed.",
        ),
      );
    }

    try {
      return JSON.parse(json) as BackupData;
    } catch {
      throw new BadRequestException(
        tr(
          "errors.backup.invalidJsonBackup",
          "Invalid backup file: decompressed content is not valid JSON",
        ),
      );
    }
  }

  private async verifyAuthentication(
    user: User,
    input: RestoreBackupInput,
  ): Promise<void> {
    if (user.authProvider === "oidc") {
      // Re-confirm via the authenticated session, mirroring account deletion
      // (users.service.deleteAccount). The request already passed the JWT
      // AuthGuard, so a live OIDC session IS the re-authentication. OIDC users
      // have no local password and cannot mint a fresh signed ID token in the
      // browser (the login id_token lives only in backend httpOnly cookies), so
      // the client sends a "session confirmed" sentinel. Cryptographically
      // verifying that sentinel as an ID token here made OIDC restore impossible.
      if (!input.oidcIdToken) {
        throw new UnauthorizedException(
          tr(
            "errors.backup.oidcReauthRequired",
            "OIDC re-authentication is required to confirm restore",
          ),
        );
      }
    } else if (user.passwordHash) {
      if (!input.password) {
        throw new UnauthorizedException(
          tr(
            "errors.backup.passwordRequiredForRestore",
            "Password is required to confirm restore",
          ),
        );
      }
      const isValid = await bcrypt.compare(input.password, user.passwordHash);
      if (!isValid) {
        throw new UnauthorizedException(
          tr("errors.backup.invalidPassword", "Invalid password"),
        );
      }
    }
  }

  private validateBackupFormat(data: BackupData): void {
    if (!data || typeof data !== "object") {
      throw new BadRequestException(
        tr(
          "errors.backup.invalidBackupFormat",
          "Invalid backup format: data must be an object",
        ),
      );
    }
    if (data.version !== BACKUP_VERSION) {
      throw new BadRequestException(
        tr(
          "errors.backup.unsupportedBackupVersion",
          `Unsupported backup version: ${data.version}. Expected ${BACKUP_VERSION}`,
          { version: data.version, expected: BACKUP_VERSION },
        ),
      );
    }
    if (!data.exportedAt) {
      throw new BadRequestException(
        tr(
          "errors.backup.missingExportedAt",
          "Invalid backup format: missing exportedAt",
        ),
      );
    }
  }

  /**
   * Builds a map from every primary-key UUID in the backup to a freshly
   * generated UUID. Currencies are intentionally excluded: they are shared,
   * global rows keyed by `code` (not by a per-user UUID) and are referenced by
   * code, so they must keep their original identifiers. Non-UUID ids (e.g.
   * `security_prices.id` is BIGSERIAL) are also excluded -- they get a fresh
   * value assigned by the DB on insert (see insertRows), and remapping them
   * to UUIDs here would (a) corrupt them and (b) clobber unrelated bigint
   * values in other columns that happen to share the same string form.
   */
  private buildBackupIdRemap(data: BackupData): Map<string, string> {
    const remap = new Map<string, string>();
    for (const [table, rows] of Object.entries(data)) {
      if (table === "currencies" || !Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const id = (row as Record<string, unknown>).id;
        if (typeof id === "string" && UUID_REGEX.test(id) && !remap.has(id)) {
          remap.set(id, randomUUID());
        }
      }
    }
    return remap;
  }

  /**
   * Returns a deep copy of the backup with every id and every reference to an
   * id (FK columns plus ids embedded in JSONB values such as scheduled
   * transaction `tag_ids` or override `splits`) rewritten via the remap. The
   * `user_id` columns are never remapped here -- they are not backup row ids,
   * and insertRows() forces them to the restoring user. Currencies are passed
   * through unchanged.
   */
  private remapBackupIds(
    data: BackupData,
    remap: Map<string, string>,
  ): BackupData {
    if (remap.size === 0) return data;
    const result: Record<string, unknown> = { ...data };
    for (const [table, rows] of Object.entries(data)) {
      if (table === "currencies" || !Array.isArray(rows)) continue;
      result[table] = rows.map((row) => this.deepRemapIds(row, remap));
    }
    return result as unknown as BackupData;
  }

  /**
   * Recursively rewrites any string that matches a remapped id. Recurses into
   * arrays and plain objects (e.g. JSONB columns) so ids nested inside JSON are
   * remapped too. Because the remap only contains genuine backup primary keys
   * (random UUIDs), non-id strings such as names or memos are left untouched.
   */
  private deepRemapIds(value: unknown, remap: Map<string, string>): unknown {
    if (typeof value === "string") {
      return remap.get(value) ?? value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.deepRemapIds(item, remap));
    }
    if (
      value !== null &&
      typeof value === "object" &&
      !(value instanceof Date)
    ) {
      return Object.fromEntries(
        Object.entries(value).map(([key, val]) => [
          key,
          this.deepRemapIds(val, remap),
        ]),
      );
    }
    return value;
  }

  private async deleteAllUserData(
    userId: string,
    queryRunner: ReturnType<DataSource["createQueryRunner"]>,
  ): Promise<void> {
    // Delete in FK-safe order (reverse of insert order)

    // Action history (undo/redo log) -- not included in backups, so wipe it
    // outright; restored data should not be undoable to the prior state.
    await queryRunner.query("DELETE FROM action_history WHERE user_id = $1", [
      userId,
    ]);

    // Monte Carlo scenarios (cash flows cascade on scenario delete)
    await queryRunner.query(
      `DELETE FROM monte_carlo_cash_flows WHERE scenario_id IN
       (SELECT id FROM monte_carlo_scenarios WHERE user_id = $1)`,
      [userId],
    );
    await queryRunner.query(
      "DELETE FROM monte_carlo_scenarios WHERE user_id = $1",
      [userId],
    );

    // AI provider configs
    await queryRunner.query(
      "DELETE FROM ai_provider_configs WHERE user_id = $1",
      [userId],
    );

    // Investment data
    await queryRunner.query(
      "DELETE FROM investment_transactions WHERE user_id = $1",
      [userId],
    );
    // Security tags (join rows cascade from securities/tags, deleted here
    // explicitly before securities so the delete order is self-documenting)
    await queryRunner.query(
      `DELETE FROM security_tags WHERE security_id IN
       (SELECT id FROM securities WHERE user_id = $1)`,
      [userId],
    );
    await queryRunner.query(
      `DELETE FROM holdings WHERE account_id IN
       (SELECT id FROM accounts WHERE user_id = $1)`,
      [userId],
    );
    await queryRunner.query(
      `DELETE FROM security_prices WHERE security_id IN
       (SELECT id FROM securities WHERE user_id = $1)`,
      [userId],
    );
    // Scheduled transactions and their splits reference securities via
    // investment_security_id. Clear those FKs before deleting securities; the
    // rows themselves are removed in the scheduled-transactions block below.
    await queryRunner.query(
      `UPDATE scheduled_transaction_splits SET investment_security_id = NULL
       WHERE scheduled_transaction_id IN
       (SELECT id FROM scheduled_transactions WHERE user_id = $1)`,
      [userId],
    );
    await queryRunner.query(
      "UPDATE scheduled_transactions SET investment_security_id = NULL WHERE user_id = $1",
      [userId],
    );
    await queryRunner.query("DELETE FROM securities WHERE user_id = $1", [
      userId,
    ]);

    // Budget data
    await queryRunner.query("DELETE FROM budget_alerts WHERE user_id = $1", [
      userId,
    ]);
    await queryRunner.query(
      `DELETE FROM budget_period_categories WHERE budget_period_id IN
       (SELECT bp.id FROM budget_periods bp
        JOIN budgets b ON bp.budget_id = b.id
        WHERE b.user_id = $1)`,
      [userId],
    );
    await queryRunner.query(
      `DELETE FROM budget_periods WHERE budget_id IN
       (SELECT id FROM budgets WHERE user_id = $1)`,
      [userId],
    );
    await queryRunner.query(
      `DELETE FROM budget_categories WHERE budget_id IN
       (SELECT id FROM budgets WHERE user_id = $1)`,
      [userId],
    );
    await queryRunner.query("DELETE FROM budgets WHERE user_id = $1", [userId]);

    // Transaction tags
    await queryRunner.query(
      `DELETE FROM transaction_split_tags WHERE transaction_split_id IN
       (SELECT ts.id FROM transaction_splits ts
        JOIN transactions t ON ts.transaction_id = t.id
        WHERE t.user_id = $1)`,
      [userId],
    );
    await queryRunner.query(
      `DELETE FROM transaction_tags WHERE transaction_id IN
       (SELECT id FROM transactions WHERE user_id = $1)`,
      [userId],
    );

    // Transaction splits
    await queryRunner.query(
      `DELETE FROM transaction_splits WHERE transaction_id IN
       (SELECT id FROM transactions WHERE user_id = $1)`,
      [userId],
    );

    // Transactions
    await queryRunner.query("DELETE FROM transactions WHERE user_id = $1", [
      userId,
    ]);

    // Tags
    await queryRunner.query("DELETE FROM tags WHERE user_id = $1", [userId]);

    // Scheduled transactions
    await queryRunner.query(
      `DELETE FROM scheduled_transaction_overrides WHERE scheduled_transaction_id IN
       (SELECT id FROM scheduled_transactions WHERE user_id = $1)`,
      [userId],
    );
    await queryRunner.query(
      `DELETE FROM scheduled_transaction_split_tags WHERE scheduled_transaction_split_id IN
       (SELECT sts.id FROM scheduled_transaction_splits sts
        JOIN scheduled_transactions st ON sts.scheduled_transaction_id = st.id
        WHERE st.user_id = $1)`,
      [userId],
    );
    await queryRunner.query(
      `DELETE FROM scheduled_transaction_splits WHERE scheduled_transaction_id IN
       (SELECT id FROM scheduled_transactions WHERE user_id = $1)`,
      [userId],
    );
    // Clear account FK references to scheduled_transactions before deleting them
    await queryRunner.query(
      "UPDATE accounts SET scheduled_transaction_id = NULL WHERE user_id = $1",
      [userId],
    );
    await queryRunner.query(
      "DELETE FROM scheduled_transactions WHERE user_id = $1",
      [userId],
    );

    // Monthly account balances
    await queryRunner.query(
      "DELETE FROM monthly_account_balances WHERE user_id = $1",
      [userId],
    );

    // Custom reports, import mappings
    await queryRunner.query("DELETE FROM custom_reports WHERE user_id = $1", [
      userId,
    ]);
    await queryRunner.query(
      "DELETE FROM investment_reports WHERE user_id = $1",
      [userId],
    );
    await queryRunner.query(
      "DELETE FROM import_column_mappings WHERE user_id = $1",
      [userId],
    );

    // AI data
    await queryRunner.query("DELETE FROM ai_insights WHERE user_id = $1", [
      userId,
    ]);

    // Payees
    await queryRunner.query("DELETE FROM payee_aliases WHERE user_id = $1", [
      userId,
    ]);
    await queryRunner.query("DELETE FROM payees WHERE user_id = $1", [userId]);

    // Loan rate-change history and saved overpayment scenarios (both cascade
    // from accounts, deleted here explicitly before accounts)
    await queryRunner.query(
      "DELETE FROM loan_rate_changes WHERE user_id = $1",
      [userId],
    );
    await queryRunner.query("DELETE FROM loan_scenarios WHERE user_id = $1", [
      userId,
    ]);

    // Clear account FK references to categories before deleting accounts
    await queryRunner.query(
      "UPDATE accounts SET principal_category_id = NULL, interest_category_id = NULL, asset_category_id = NULL WHERE user_id = $1",
      [userId],
    );

    // Accounts
    await queryRunner.query("DELETE FROM accounts WHERE user_id = $1", [
      userId,
    ]);

    // Institutions (accounts reference these via institution_id; deleted after
    // accounts so no rows still point at them)
    await queryRunner.query("DELETE FROM institutions WHERE user_id = $1", [
      userId,
    ]);

    // Categories
    await queryRunner.query("DELETE FROM categories WHERE user_id = $1", [
      userId,
    ]);

    // User preferences and auto-backup settings
    await queryRunner.query(
      "DELETE FROM auto_backup_settings WHERE user_id = $1",
      [userId],
    );
    await queryRunner.query(
      "DELETE FROM user_currency_preferences WHERE user_id = $1",
      [userId],
    );
    await queryRunner.query("DELETE FROM user_preferences WHERE user_id = $1", [
      userId,
    ]);

    // User-created currencies (only those not referenced by other users)
    await queryRunner.query(
      `DELETE FROM currencies WHERE created_by_user_id = $1
       AND code NOT IN (
         SELECT DISTINCT currency_code FROM user_currency_preferences WHERE user_id != $1
         UNION SELECT DISTINCT currency_code FROM accounts WHERE user_id != $1
       )`,
      [userId],
    );
  }

  private async restoreDeferredFkColumns(
    queryRunner: ReturnType<DataSource["createQueryRunner"]>,
    data: BackupData,
  ): Promise<void> {
    // Each entry: [table, rows, column] -- update rows that have a non-null
    // value for the deferred FK column.
    const deferredUpdates: Array<{
      table: string;
      rows: Record<string, unknown>[];
      column: string;
      // When set, the UPDATE only applies if a row with the referenced id
      // exists in this table. Used for institution_id so legacy backups that
      // predate institution export leave the column NULL instead of failing.
      requireReferencedTable?: string;
    }> = [
      { table: "categories", rows: data.categories, column: "parent_id" },
      {
        table: "accounts",
        rows: data.accounts,
        column: "institution_id",
        requireReferencedTable: "institutions",
      },
      {
        table: "accounts",
        rows: data.accounts,
        column: "linked_account_id",
      },
      {
        table: "accounts",
        rows: data.accounts,
        column: "source_account_id",
      },
      {
        table: "accounts",
        rows: data.accounts,
        column: "scheduled_transaction_id",
      },
      {
        table: "accounts",
        rows: data.accounts,
        column: "principal_category_id",
      },
      {
        table: "accounts",
        rows: data.accounts,
        column: "interest_category_id",
      },
      {
        table: "accounts",
        rows: data.accounts,
        column: "asset_category_id",
      },
      {
        table: "transactions",
        rows: data.transactions,
        column: "linked_transaction_id",
      },
      {
        table: "transactions",
        rows: data.transactions,
        column: "parent_transaction_id",
      },
      {
        table: "investment_transactions",
        rows: data.investment_transactions,
        column: "linked_transaction_id",
      },
      {
        table: "payees",
        rows: data.payees,
        column: "default_category_id",
      },
      {
        table: "scheduled_transactions",
        rows: data.scheduled_transactions,
        column: "investment_security_id",
      },
      {
        table: "scheduled_transaction_splits",
        rows: data.scheduled_transaction_splits,
        column: "investment_security_id",
      },
    ];

    // Tables that have a BEFORE UPDATE trigger which auto-sets updated_at.
    // We must disable these triggers during deferred FK restoration to
    // preserve the original timestamps from the backup.
    const tablesWithUpdatedAtTrigger = new Set([
      "accounts",
      "transactions",
      "scheduled_transactions",
      "investment_transactions",
    ]);

    // Collect tables that will actually be updated AND have the trigger
    const triggersToDisable = new Set<string>();
    for (const { table, rows, column } of deferredUpdates) {
      if (!rows || !tablesWithUpdatedAtTrigger.has(table)) continue;
      if (rows.some((row) => row[column] != null && row.id != null)) {
        triggersToDisable.add(table);
      }
    }

    // Disable updated_at triggers on affected tables before running updates
    for (const table of triggersToDisable) {
      await queryRunner.query(
        `ALTER TABLE "${table}" DISABLE TRIGGER "update_${table}_updated_at"`,
      );
    }

    try {
      for (const {
        table,
        rows,
        column,
        requireReferencedTable,
      } of deferredUpdates) {
        if (!rows) continue;
        const sql = requireReferencedTable
          ? `UPDATE "${table}" SET "${column}" = $1 WHERE id = $2
             AND EXISTS (SELECT 1 FROM "${requireReferencedTable}" WHERE id = $1)`
          : `UPDATE "${table}" SET "${column}" = $1 WHERE id = $2`;
        for (const row of rows) {
          if (row[column] != null && row.id != null) {
            await queryRunner.query(sql, [row[column], row.id]);
          }
        }
      }
    } finally {
      // Re-enable the triggers regardless of whether the updates succeeded
      for (const table of triggersToDisable) {
        await queryRunner.query(
          `ALTER TABLE "${table}" ENABLE TRIGGER "update_${table}_updated_at"`,
        );
      }
    }
  }

  private async ensureCurrenciesExist(
    queryRunner: ReturnType<DataSource["createQueryRunner"]>,
    data: BackupData,
    userId: string,
  ): Promise<void> {
    // Collect all currency codes referenced across backup tables
    const referencedCodes = new Set<string>();
    const tablesWithCurrency: Array<{
      rows: Record<string, unknown>[] | undefined;
      column: string;
    }> = [
      { rows: data.user_currency_preferences, column: "currency_code" },
      { rows: data.user_preferences, column: "default_currency" },
      { rows: data.accounts, column: "currency_code" },
      { rows: data.transactions, column: "currency_code" },
      { rows: data.scheduled_transactions, column: "currency_code" },
      { rows: data.securities, column: "currency_code" },
      { rows: data.budgets, column: "currency_code" },
    ];

    for (const { rows, column } of tablesWithCurrency) {
      if (!rows) continue;
      for (const row of rows) {
        const code = row[column];
        if (typeof code === "string" && code.length > 0) {
          referencedCodes.add(code);
        }
      }
    }

    if (referencedCodes.size === 0) return;

    // First, restore user-created currencies from the backup (ON CONFLICT DO NOTHING)
    if (data.currencies) {
      // Validate column names against the actual currencies table schema to
      // prevent SQL injection via crafted backup data with malicious keys.
      const currencySchemaResult = await queryRunner.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'currencies' AND table_schema = 'public'`,
      );
      const validCurrencyColumns = new Set<string>(
        currencySchemaResult.map((r: { column_name: string }) => r.column_name),
      );

      for (const row of data.currencies) {
        const filteredRow = { ...row };
        filteredRow.created_by_user_id = userId;

        // Strip column names not in the actual table schema
        for (const key of Object.keys(filteredRow)) {
          if (!validCurrencyColumns.has(key)) {
            delete filteredRow[key];
          }
        }

        const columns = Object.keys(filteredRow);
        const values = Object.values(filteredRow).map((v) =>
          v !== null && typeof v === "object" && !(v instanceof Date)
            ? JSON.stringify(v)
            : v,
        );
        if (columns.length === 0) continue;

        const columnList = columns.map((c) => `"${c}"`).join(", ");
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
        await queryRunner.query(
          `INSERT INTO "currencies" (${columnList}) VALUES (${placeholders})
           ON CONFLICT (code) DO NOTHING`,
          values,
        );
      }
    }

    // Check which codes are still missing from the currencies table
    const codeArray = Array.from(referencedCodes);
    const existing: Array<{ code: string }> = await queryRunner.query(
      `SELECT code FROM currencies WHERE code = ANY($1)`,
      [codeArray],
    );
    const existingSet = new Set(existing.map((r) => r.code));
    const missing = codeArray.filter((c) => !existingSet.has(c));

    // Auto-create minimal entries for any still-missing currencies
    for (const code of missing) {
      await queryRunner.query(
        `INSERT INTO "currencies" ("code", "name", "symbol", "decimal_places", "is_active", "created_by_user_id")
         VALUES ($1, $2, $3, 2, true, $4)
         ON CONFLICT (code) DO NOTHING`,
        [code, code, code, userId],
      );
      this.logger.log(
        `Auto-created missing currency ${code} during backup restore`,
      );
    }
  }

  private async insertRows(
    queryRunner: ReturnType<DataSource["createQueryRunner"]>,
    table: string,
    rows: Record<string, unknown>[] | undefined,
    userId: string | null,
  ): Promise<number> {
    if (!rows || rows.length === 0) {
      return 0;
    }

    // Allowlist of tables that can be restored (single source of truth defined
    // at module scope and cross-checked by the coverage guard test).
    if (!RESTORABLE_TABLES.has(table)) {
      throw new BadRequestException(
        tr(
          "errors.backup.tableNotAllowed",
          `Table ${table} is not allowed in backup restore`,
          { table },
        ),
      );
    }

    // Columns that create circular or forward FK references and must be
    // deferred until all tables are populated (restored via UPDATE in Phase 3).
    const deferredFkColumns: Record<string, string[]> = {
      categories: ["parent_id"],
      accounts: [
        "linked_account_id",
        "source_account_id",
        "scheduled_transaction_id",
        "principal_category_id",
        "interest_category_id",
        "asset_category_id",
        // Deferred so that legacy backups (taken before institutions were
        // included in the export) restore without violating fk_accounts_institution.
        // Phase 3 only re-applies it when the referenced institution exists.
        "institution_id",
      ],
      transactions: ["linked_transaction_id", "parent_transaction_id"],
      payees: ["default_category_id"],
      // Scheduled transactions/splits are inserted before securities, so their
      // forward reference to securities(id) is deferred to Phase 3.
      scheduled_transactions: ["investment_security_id"],
      scheduled_transaction_splits: ["investment_security_id"],
      // Self-referential FK linking the two legs of a security transfer
      // (TRANSFER_OUT <-> TRANSFER_IN). A row may reference another
      // investment_transactions row that appears later in the insert batch, so
      // defer it to Phase 3 once every row exists.
      investment_transactions: ["linked_transaction_id"],
    };
    const columnsToDefer = deferredFkColumns[table] ?? [];

    // Fetch all valid column names for this table from the schema. This serves
    // three purposes: (1) detect native PostgreSQL array columns so we can pass
    // JS arrays directly to the pg driver, (2) validate that column names from
    // the user-uploaded backup are real columns, preventing SQL injection via
    // crafted column names with embedded double-quote characters, and (3)
    // detect sequence-backed columns (e.g. BIGSERIAL `id`) that must be stripped
    // from the INSERT so PostgreSQL assigns a fresh value -- otherwise the
    // backup's bigint ids would collide with other users' rows on the shared
    // sequence and be silently skipped by ON CONFLICT DO NOTHING.
    const schemaColResult: Array<{
      column_name: string;
      data_type: string;
      column_default: string | null;
    }> = await queryRunner.query(
      `SELECT column_name, data_type, column_default FROM information_schema.columns
       WHERE table_name = $1 AND table_schema = 'public'`,
      [table],
    );
    const validColumns = new Set<string>(
      schemaColResult.map((r) => r.column_name),
    );
    const pgArrayColumns = new Set<string>(
      schemaColResult
        .filter((r) => r.data_type === "ARRAY")
        .map((r) => r.column_name),
    );
    const sequenceBackedColumns = new Set<string>(
      schemaColResult
        .filter(
          (r) =>
            typeof r.column_default === "string" &&
            r.column_default.includes("nextval"),
        )
        .map((r) => r.column_name),
    );
    // BYTEA columns (e.g. institutions.logo_data) are base64-encoded in the
    // backup; their placeholders are wrapped in decode(..., 'base64') so the
    // bytes are restored correctly.
    const byteaColumns = new Set<string>(
      schemaColResult
        .filter((r) => r.data_type === "bytea")
        .map((r) => r.column_name),
    );

    let count = 0;
    for (const row of rows) {
      const filteredRow = { ...row };

      // Override user_id to ensure data stays scoped to the restoring user
      if (userId !== null && "user_id" in filteredRow) {
        filteredRow.user_id = userId;
      }

      // Preserve created_at and updated_at from the backup so that
      // restored records retain their original timestamps.

      // Strip deferred FK columns to avoid circular reference violations
      for (const col of columnsToDefer) {
        delete filteredRow[col];
      }

      // Strip sequence-backed columns (e.g. BIGSERIAL `id`) so the DB assigns
      // a fresh value. Reusing the backup's value would collide with other
      // users' rows on the shared sequence and be silently dropped by
      // ON CONFLICT DO NOTHING.
      for (const col of sequenceBackedColumns) {
        delete filteredRow[col];
      }

      // Strip any column names not present in the actual table schema to
      // prevent SQL injection via crafted backup data with malicious keys.
      for (const key of Object.keys(filteredRow)) {
        if (!validColumns.has(key)) {
          delete filteredRow[key];
        }
      }

      const columns = Object.keys(filteredRow);
      // Stringify object/array values for JSONB columns -- PostgreSQL requires
      // JSON text, not native JS objects, in parameterised queries. Native
      // PostgreSQL array columns (TEXT[], etc.) are left as JS arrays so the
      // pg driver serialises them in the correct {val1,val2} format.
      const values = Object.values(filteredRow).map((v, idx) =>
        v !== null && typeof v === "object" && !(v instanceof Date)
          ? Array.isArray(v) && pgArrayColumns.has(columns[idx])
            ? v
            : JSON.stringify(v)
          : v,
      );

      if (columns.length === 0) {
        continue;
      }

      const columnList = columns.map((c) => `"${c}"`).join(", ");
      const placeholders = columns
        .map((c, i) =>
          byteaColumns.has(c) ? `decode($${i + 1}, 'base64')` : `$${i + 1}`,
        )
        .join(", ");

      await queryRunner.query(
        `INSERT INTO "${table}" (${columnList}) VALUES (${placeholders})
         ON CONFLICT DO NOTHING`,
        values,
      );
      count++;
    }

    return count;
  }
}
