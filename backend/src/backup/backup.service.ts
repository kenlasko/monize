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
import { User } from "../users/entities/user.entity";
import { RestoreBackupDto } from "./dto/restore-backup.dto";

const BACKUP_VERSION = 1;

interface BackupData {
  version: number;
  exportedAt: string;
  user_preferences: Record<string, unknown>[];
  user_currency_preferences: Record<string, unknown>[];
  categories: Record<string, unknown>[];
  payees: Record<string, unknown>[];
  payee_aliases: Record<string, unknown>[];
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
  budgets: Record<string, unknown>[];
  budget_categories: Record<string, unknown>[];
  budget_periods: Record<string, unknown>[];
  budget_period_categories: Record<string, unknown>[];
  budget_alerts: Record<string, unknown>[];
  custom_reports: Record<string, unknown>[];
  import_column_mappings: Record<string, unknown>[];
  monthly_account_balances: Record<string, unknown>[];
}

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly dataSource: DataSource,
  ) {}

  async exportData(userId: string): Promise<BackupData> {
    this.logger.log(`Starting backup export for user ${userId}`);

    const backup: BackupData = {
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      user_preferences: await this.query(
        "SELECT * FROM user_preferences WHERE user_id = $1",
        [userId],
      ),
      user_currency_preferences: await this.query(
        "SELECT * FROM user_currency_preferences WHERE user_id = $1",
        [userId],
      ),
      categories: await this.query(
        "SELECT * FROM categories WHERE user_id = $1 ORDER BY parent_id NULLS FIRST, name",
        [userId],
      ),
      payees: await this.query(
        "SELECT * FROM payees WHERE user_id = $1 ORDER BY name",
        [userId],
      ),
      payee_aliases: await this.query(
        "SELECT * FROM payee_aliases WHERE user_id = $1",
        [userId],
      ),
      accounts: await this.query(
        "SELECT * FROM accounts WHERE user_id = $1 ORDER BY name",
        [userId],
      ),
      tags: await this.query(
        "SELECT * FROM tags WHERE user_id = $1 ORDER BY name",
        [userId],
      ),
      transactions: await this.query(
        "SELECT * FROM transactions WHERE user_id = $1 ORDER BY transaction_date, created_at",
        [userId],
      ),
      transaction_splits: await this.query(
        `SELECT ts.* FROM transaction_splits ts
         JOIN transactions t ON ts.transaction_id = t.id
         WHERE t.user_id = $1`,
        [userId],
      ),
      transaction_tags: await this.query(
        `SELECT tt.* FROM transaction_tags tt
         JOIN transactions t ON tt.transaction_id = t.id
         WHERE t.user_id = $1`,
        [userId],
      ),
      transaction_split_tags: await this.query(
        `SELECT tst.* FROM transaction_split_tags tst
         JOIN transaction_splits ts ON tst.transaction_split_id = ts.id
         JOIN transactions t ON ts.transaction_id = t.id
         WHERE t.user_id = $1`,
        [userId],
      ),
      scheduled_transactions: await this.query(
        "SELECT * FROM scheduled_transactions WHERE user_id = $1",
        [userId],
      ),
      scheduled_transaction_splits: await this.query(
        `SELECT sts.* FROM scheduled_transaction_splits sts
         JOIN scheduled_transactions st ON sts.scheduled_transaction_id = st.id
         WHERE st.user_id = $1`,
        [userId],
      ),
      scheduled_transaction_overrides: await this.query(
        `SELECT sto.* FROM scheduled_transaction_overrides sto
         JOIN scheduled_transactions st ON sto.scheduled_transaction_id = st.id
         WHERE st.user_id = $1`,
        [userId],
      ),
      securities: await this.query(
        "SELECT * FROM securities WHERE user_id = $1",
        [userId],
      ),
      security_prices: await this.query(
        `SELECT sp.* FROM security_prices sp
         JOIN securities s ON sp.security_id = s.id
         WHERE s.user_id = $1`,
        [userId],
      ),
      holdings: await this.query(
        `SELECT h.* FROM holdings h
         JOIN accounts a ON h.account_id = a.id
         WHERE a.user_id = $1`,
        [userId],
      ),
      investment_transactions: await this.query(
        "SELECT * FROM investment_transactions WHERE user_id = $1",
        [userId],
      ),
      budgets: await this.query(
        "SELECT * FROM budgets WHERE user_id = $1",
        [userId],
      ),
      budget_categories: await this.query(
        `SELECT bc.* FROM budget_categories bc
         JOIN budgets b ON bc.budget_id = b.id
         WHERE b.user_id = $1`,
        [userId],
      ),
      budget_periods: await this.query(
        `SELECT bp.* FROM budget_periods bp
         JOIN budgets b ON bp.budget_id = b.id
         WHERE b.user_id = $1`,
        [userId],
      ),
      budget_period_categories: await this.query(
        `SELECT bpc.* FROM budget_period_categories bpc
         JOIN budget_periods bp ON bpc.budget_period_id = bp.id
         JOIN budgets b ON bp.budget_id = b.id
         WHERE b.user_id = $1`,
        [userId],
      ),
      budget_alerts: await this.query(
        "SELECT * FROM budget_alerts WHERE user_id = $1",
        [userId],
      ),
      custom_reports: await this.query(
        "SELECT * FROM custom_reports WHERE user_id = $1",
        [userId],
      ),
      import_column_mappings: await this.query(
        "SELECT * FROM import_column_mappings WHERE user_id = $1",
        [userId],
      ),
      monthly_account_balances: await this.query(
        "SELECT * FROM monthly_account_balances WHERE user_id = $1",
        [userId],
      ),
    };

    this.logger.log(`Backup export completed for user ${userId}`);
    return backup;
  }

  async restoreData(
    userId: string,
    dto: RestoreBackupDto,
  ): Promise<{ message: string; restored: Record<string, number> }> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException("User not found");
    }

    await this.verifyAuthentication(user, dto);

    const data = dto.data as unknown as BackupData;
    this.validateBackupFormat(data);

    this.logger.log(`Starting backup restore for user ${userId}`);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    const restored: Record<string, number> = {};

    try {
      // Phase 1: Delete all existing user data (same order as deleteData in users.service)
      await this.deleteAllUserData(userId, queryRunner);

      // Phase 2: Insert backup data in FK-safe order
      restored.userPreferences = await this.insertRows(
        queryRunner, "user_preferences", data.user_preferences, userId,
      );
      restored.userCurrencyPreferences = await this.insertRows(
        queryRunner, "user_currency_preferences", data.user_currency_preferences, userId,
      );
      restored.categories = await this.insertRows(
        queryRunner, "categories", data.categories, userId,
      );
      restored.payees = await this.insertRows(
        queryRunner, "payees", data.payees, userId,
      );
      restored.payeeAliases = await this.insertRows(
        queryRunner, "payee_aliases", data.payee_aliases, userId,
      );
      restored.accounts = await this.insertRows(
        queryRunner, "accounts", data.accounts, userId,
      );
      restored.tags = await this.insertRows(
        queryRunner, "tags", data.tags, userId,
      );
      restored.scheduledTransactions = await this.insertRows(
        queryRunner, "scheduled_transactions", data.scheduled_transactions, userId,
      );
      restored.scheduledTransactionSplits = await this.insertRows(
        queryRunner, "scheduled_transaction_splits", data.scheduled_transaction_splits, null,
      );
      restored.scheduledTransactionOverrides = await this.insertRows(
        queryRunner, "scheduled_transaction_overrides", data.scheduled_transaction_overrides, null,
      );
      restored.securities = await this.insertRows(
        queryRunner, "securities", data.securities, userId,
      );
      restored.securityPrices = await this.insertRows(
        queryRunner, "security_prices", data.security_prices, null,
      );
      restored.holdings = await this.insertRows(
        queryRunner, "holdings", data.holdings, null,
      );
      restored.transactions = await this.insertRows(
        queryRunner, "transactions", data.transactions, userId,
      );
      restored.transactionSplits = await this.insertRows(
        queryRunner, "transaction_splits", data.transaction_splits, null,
      );
      restored.transactionTags = await this.insertRows(
        queryRunner, "transaction_tags", data.transaction_tags, null,
      );
      restored.transactionSplitTags = await this.insertRows(
        queryRunner, "transaction_split_tags", data.transaction_split_tags, null,
      );
      restored.investmentTransactions = await this.insertRows(
        queryRunner, "investment_transactions", data.investment_transactions, userId,
      );
      restored.budgets = await this.insertRows(
        queryRunner, "budgets", data.budgets, userId,
      );
      restored.budgetCategories = await this.insertRows(
        queryRunner, "budget_categories", data.budget_categories, null,
      );
      restored.budgetPeriods = await this.insertRows(
        queryRunner, "budget_periods", data.budget_periods, null,
      );
      restored.budgetPeriodCategories = await this.insertRows(
        queryRunner, "budget_period_categories", data.budget_period_categories, null,
      );
      restored.budgetAlerts = await this.insertRows(
        queryRunner, "budget_alerts", data.budget_alerts, userId,
      );
      restored.customReports = await this.insertRows(
        queryRunner, "custom_reports", data.custom_reports, userId,
      );
      restored.importColumnMappings = await this.insertRows(
        queryRunner, "import_column_mappings", data.import_column_mappings, userId,
      );
      restored.monthlyAccountBalances = await this.insertRows(
        queryRunner, "monthly_account_balances", data.monthly_account_balances, userId,
      );

      await queryRunner.commitTransaction();
      this.logger.log(`Backup restore completed for user ${userId}`);
      return { message: "Backup restored successfully", restored };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Backup restore failed for user ${userId}: ${error.message}`);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    return this.dataSource.query(sql, params);
  }

  private async verifyAuthentication(user: User, dto: RestoreBackupDto): Promise<void> {
    if (user.authProvider === "oidc") {
      if (!dto.oidcIdToken) {
        throw new UnauthorizedException(
          "OIDC re-authentication is required to confirm restore",
        );
      }
    } else if (user.passwordHash) {
      if (!dto.password) {
        throw new UnauthorizedException(
          "Password is required to confirm restore",
        );
      }
      const isValid = await bcrypt.compare(dto.password, user.passwordHash);
      if (!isValid) {
        throw new UnauthorizedException("Invalid password");
      }
    }
  }

  private validateBackupFormat(data: BackupData): void {
    if (!data || typeof data !== "object") {
      throw new BadRequestException("Invalid backup format: data must be an object");
    }
    if (data.version !== BACKUP_VERSION) {
      throw new BadRequestException(
        `Unsupported backup version: ${data.version}. Expected ${BACKUP_VERSION}`,
      );
    }
    if (!data.exportedAt) {
      throw new BadRequestException("Invalid backup format: missing exportedAt");
    }
  }

  private async deleteAllUserData(
    userId: string,
    queryRunner: ReturnType<DataSource["createQueryRunner"]>,
  ): Promise<void> {
    // Delete in FK-safe order (reverse of insert order)
    // Investment data
    await queryRunner.query(
      "DELETE FROM investment_transactions WHERE user_id = $1",
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
    await queryRunner.query(
      "DELETE FROM securities WHERE user_id = $1",
      [userId],
    );

    // Budget data
    await queryRunner.query("DELETE FROM budget_alerts WHERE user_id = $1", [userId]);
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
    await queryRunner.query("DELETE FROM transactions WHERE user_id = $1", [userId]);

    // Tags
    await queryRunner.query("DELETE FROM tags WHERE user_id = $1", [userId]);

    // Scheduled transactions
    await queryRunner.query(
      `DELETE FROM scheduled_transaction_overrides WHERE scheduled_transaction_id IN
       (SELECT id FROM scheduled_transactions WHERE user_id = $1)`,
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
    await queryRunner.query("DELETE FROM custom_reports WHERE user_id = $1", [userId]);
    await queryRunner.query("DELETE FROM import_column_mappings WHERE user_id = $1", [userId]);

    // AI data
    await queryRunner.query("DELETE FROM ai_insights WHERE user_id = $1", [userId]);

    // Payees
    await queryRunner.query("DELETE FROM payee_aliases WHERE user_id = $1", [userId]);
    await queryRunner.query("DELETE FROM payees WHERE user_id = $1", [userId]);

    // Clear account FK references to categories before deleting accounts
    await queryRunner.query(
      "UPDATE accounts SET principal_category_id = NULL, interest_category_id = NULL, asset_category_id = NULL WHERE user_id = $1",
      [userId],
    );

    // Accounts
    await queryRunner.query("DELETE FROM accounts WHERE user_id = $1", [userId]);

    // Categories
    await queryRunner.query("DELETE FROM categories WHERE user_id = $1", [userId]);

    // User preferences
    await queryRunner.query("DELETE FROM user_currency_preferences WHERE user_id = $1", [userId]);
    await queryRunner.query("DELETE FROM user_preferences WHERE user_id = $1", [userId]);
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

    // Allowlist of tables that can be restored
    const allowedTables = new Set([
      "user_preferences", "user_currency_preferences", "categories", "payees",
      "payee_aliases", "accounts", "tags", "transactions", "transaction_splits",
      "transaction_tags", "transaction_split_tags", "scheduled_transactions",
      "scheduled_transaction_splits", "scheduled_transaction_overrides",
      "securities", "security_prices", "holdings", "investment_transactions",
      "budgets", "budget_categories", "budget_periods", "budget_period_categories",
      "budget_alerts", "custom_reports", "import_column_mappings",
      "monthly_account_balances",
    ]);

    if (!allowedTables.has(table)) {
      throw new BadRequestException(`Table ${table} is not allowed in backup restore`);
    }

    let count = 0;
    for (const row of rows) {
      const filteredRow = { ...row };

      // Override user_id to ensure data stays scoped to the restoring user
      if (userId !== null && "user_id" in filteredRow) {
        filteredRow.user_id = userId;
      }

      // Remove auto-generated timestamp columns that will be set by DB
      delete filteredRow.created_at;
      delete filteredRow.updated_at;

      const columns = Object.keys(filteredRow);
      const values = Object.values(filteredRow);

      if (columns.length === 0) {
        continue;
      }

      // Use quoted identifiers for column names (safe since they come from DB export)
      const columnList = columns.map((c) => `"${c}"`).join(", ");
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");

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
