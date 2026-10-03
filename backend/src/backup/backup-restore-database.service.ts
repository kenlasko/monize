import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { resolveCurrencyMetadata } from "../currencies/currency-metadata";
import { tr } from "../i18n/translate";
import { boundRestoredNotification } from "./notification-restore-bounds";
import { BackupData, backupTables } from "./backup-format";
import {
  DEFERRED_FK_COLUMNS,
  DEFERRED_FK_REPAIRS,
  RESTORABLE_TABLES,
} from "./restore-plan";

/**
 * The SQL half of a restore: the FK-ordered teardown of the user's current data,
 * the currency rows the restored tables reference, the row inserts, and the
 * deferred foreign-key repair that follows them.
 *
 * Every method here takes the caller's `EntityManager` and performs no
 * transaction management of its own -- `BackupRestoreService` opens exactly one
 * `withScopedDb` around the whole sequence, so a half-applied restore cannot
 * leave the account in a state that is neither the backup nor what was there
 * before. Split out of `BackupService` (issue #1092).
 */
@Injectable()
export class BackupRestoreDatabaseService {
  private readonly logger = new Logger(BackupRestoreDatabaseService.name);

  async deleteAllUserData(
    userId: string,
    manager: EntityManager,
  ): Promise<void> {
    // Delete in FK-safe order (reverse of insert order)

    // Action history (undo/redo log) -- not included in backups, so wipe it
    // outright; restored data should not be undoable to the prior state.
    await manager.query("DELETE FROM action_history WHERE user_id = $1", [
      userId,
    ]);

    // Transaction rules (their trace rows cascade from the rule and from the
    // transactions deleted below; the trace is not part of a backup).
    await manager.query("DELETE FROM transaction_rules WHERE user_id = $1", [
      userId,
    ]);

    // Email-receipt parsers. The stored receipts and the mailbox are not part of
    // a backup and are left alone; a receipt's parser_id is ON DELETE SET NULL.
    await manager.query(
      "DELETE FROM email_receipt_parsers WHERE user_id = $1",
      [userId],
    );

    // GEM strategies (accounts, assets and signals cascade on strategy delete,
    // but are deleted explicitly first so the order is self-documenting)
    await manager.query("DELETE FROM gem_strategy_signals WHERE user_id = $1", [
      userId,
    ]);
    await manager.query("DELETE FROM gem_strategy_assets WHERE user_id = $1", [
      userId,
    ]);
    await manager.query(
      "DELETE FROM gem_strategy_accounts WHERE user_id = $1",
      [userId],
    );
    await manager.query("DELETE FROM gem_strategies WHERE user_id = $1", [
      userId,
    ]);

    // Monte Carlo scenarios (cash flows cascade on scenario delete)
    await manager.query(
      `DELETE FROM monte_carlo_cash_flows WHERE scenario_id IN
       (SELECT id FROM monte_carlo_scenarios WHERE user_id = $1)`,
      [userId],
    );
    await manager.query(
      "DELETE FROM monte_carlo_scenarios WHERE user_id = $1",
      [userId],
    );

    // AI provider configs
    await manager.query("DELETE FROM ai_provider_configs WHERE user_id = $1", [
      userId,
    ]);

    // Payee lookup settings (Google Places key and cap).
    await manager.query(
      "DELETE FROM payee_lookup_settings WHERE user_id = $1",
      [userId],
    );
    // `payee_lookup_usage` is exported and restored beside it, and is
    // deliberately NOT cleared here. It is a record of what has been spent
    // against a Google key, not user content: with the rows left in place the
    // insert's ON CONFLICT DO NOTHING gives the archive's count to a machine
    // that has none (the migration this exists for) and leaves a live count
    // alone, so no restore can lower one and hand back quota. Deleting first
    // would make an older archive do exactly that.
    //
    // `google_places_instance_usage` is not exported at all: it has no owner,
    // and every user on the deployment spends it.

    // Investment data
    await manager.query(
      "DELETE FROM investment_transactions WHERE user_id = $1",
      [userId],
    );
    // Security tags (join rows cascade from securities/tags, deleted here
    // explicitly before securities so the delete order is self-documenting)
    await manager.query(
      `DELETE FROM security_tags WHERE security_id IN
       (SELECT id FROM securities WHERE user_id = $1)`,
      [userId],
    );
    await manager.query(
      `DELETE FROM holdings WHERE account_id IN
       (SELECT id FROM accounts WHERE user_id = $1)`,
      [userId],
    );
    await manager.query(
      `DELETE FROM security_prices WHERE security_id IN
       (SELECT id FROM securities WHERE user_id = $1)`,
      [userId],
    );
    await manager.query("DELETE FROM security_documents WHERE user_id = $1", [
      userId,
    ]);
    // Scheduled transactions and their splits reference securities via
    // investment_security_id. Clear those FKs before deleting securities; the
    // rows themselves are removed in the scheduled-transactions block below.
    await manager.query(
      `UPDATE scheduled_transaction_splits SET investment_security_id = NULL
       WHERE scheduled_transaction_id IN
       (SELECT id FROM scheduled_transactions WHERE user_id = $1)`,
      [userId],
    );
    await manager.query(
      "UPDATE scheduled_transactions SET investment_security_id = NULL WHERE user_id = $1",
      [userId],
    );
    await manager.query("DELETE FROM securities WHERE user_id = $1", [userId]);

    // Budget data
    // Reminders before notifications is not required (source_notification_id is
    // ON DELETE SET NULL), but both are cleared: the insert path is ON CONFLICT
    // DO NOTHING, so without this pre-clear a restore over an existing account
    // keeps the local reminder rows and drops the backup's.
    await manager.query(
      "DELETE FROM notification_reminders WHERE user_id = $1",
      [userId],
    );
    await manager.query("DELETE FROM notifications WHERE user_id = $1", [
      userId,
    ]);
    // Per-category channel preferences. The insert path is ON CONFLICT DO
    // NOTHING keyed on (user_id, category), so without this pre-clear a restore
    // over an existing account keeps the local preference rows and silently
    // drops the backup's -- every other user-owned restore-plan table clears
    // here for exactly that reason.
    await manager.query(
      "DELETE FROM notification_preferences WHERE user_id = $1",
      [userId],
    );
    // Portfolio-movement baseline + threshold: one row per user, restored by an
    // insert path with the same over-existing-account hazard, so it clears here
    // too.
    await manager.query(
      "DELETE FROM notification_portfolio_state WHERE user_id = $1",
      [userId],
    );
    await manager.query(
      `DELETE FROM budget_period_categories WHERE budget_period_id IN
       (SELECT bp.id FROM budget_periods bp
        JOIN budgets b ON bp.budget_id = b.id
        WHERE b.user_id = $1)`,
      [userId],
    );
    await manager.query(
      `DELETE FROM budget_periods WHERE budget_id IN
       (SELECT id FROM budgets WHERE user_id = $1)`,
      [userId],
    );
    await manager.query(
      `DELETE FROM budget_categories WHERE budget_id IN
       (SELECT id FROM budgets WHERE user_id = $1)`,
      [userId],
    );
    await manager.query("DELETE FROM budgets WHERE user_id = $1", [userId]);

    // Transaction tags
    await manager.query(
      `DELETE FROM transaction_split_tags WHERE transaction_split_id IN
       (SELECT ts.id FROM transaction_splits ts
        JOIN transactions t ON ts.transaction_id = t.id
        WHERE t.user_id = $1)`,
      [userId],
    );
    await manager.query(
      `DELETE FROM transaction_tags WHERE transaction_id IN
       (SELECT id FROM transactions WHERE user_id = $1)`,
      [userId],
    );

    // Transaction splits
    await manager.query(
      `DELETE FROM transaction_splits WHERE transaction_id IN
       (SELECT id FROM transactions WHERE user_id = $1)`,
      [userId],
    );

    // Transaction attachments (bytes first, then metadata). Both would cascade
    // from the transactions delete below, but we clear them explicitly to match
    // the rest of this FK-ordered teardown.
    await manager.query(
      `DELETE FROM attachment_blobs WHERE attachment_id IN
       (SELECT id FROM transaction_attachments WHERE user_id = $1)`,
      [userId],
    );
    await manager.query(
      "DELETE FROM transaction_attachments WHERE user_id = $1",
      [userId],
    );

    // Transactions
    await manager.query("DELETE FROM transactions WHERE user_id = $1", [
      userId,
    ]);

    // Tags
    await manager.query("DELETE FROM tags WHERE user_id = $1", [userId]);

    // Scheduled transactions
    await manager.query(
      `DELETE FROM scheduled_transaction_overrides WHERE scheduled_transaction_id IN
       (SELECT id FROM scheduled_transactions WHERE user_id = $1)`,
      [userId],
    );
    await manager.query(
      `DELETE FROM scheduled_transaction_split_tags WHERE scheduled_transaction_split_id IN
       (SELECT sts.id FROM scheduled_transaction_splits sts
        JOIN scheduled_transactions st ON sts.scheduled_transaction_id = st.id
        WHERE st.user_id = $1)`,
      [userId],
    );
    await manager.query(
      `DELETE FROM scheduled_transaction_splits WHERE scheduled_transaction_id IN
       (SELECT id FROM scheduled_transactions WHERE user_id = $1)`,
      [userId],
    );
    // Clear account FK references to scheduled_transactions before deleting them
    await manager.query(
      "UPDATE accounts SET scheduled_transaction_id = NULL WHERE user_id = $1",
      [userId],
    );
    await manager.query(
      "DELETE FROM scheduled_transactions WHERE user_id = $1",
      [userId],
    );

    // Monthly account balances
    await manager.query(
      "DELETE FROM monthly_account_balances WHERE user_id = $1",
      [userId],
    );

    // Custom reports, import mappings
    await manager.query("DELETE FROM custom_reports WHERE user_id = $1", [
      userId,
    ]);
    await manager.query("DELETE FROM investment_reports WHERE user_id = $1", [
      userId,
    ]);
    await manager.query(
      "DELETE FROM import_column_mappings WHERE user_id = $1",
      [userId],
    );

    // AI data
    await manager.query("DELETE FROM ai_insights WHERE user_id = $1", [userId]);

    // Payees
    await manager.query("DELETE FROM payee_aliases WHERE user_id = $1", [
      userId,
    ]);
    await manager.query("DELETE FROM payees WHERE user_id = $1", [userId]);

    // Loan rate-change history and saved overpayment scenarios (both cascade
    // from accounts, deleted here explicitly before accounts)
    await manager.query("DELETE FROM loan_rate_changes WHERE user_id = $1", [
      userId,
    ]);
    await manager.query("DELETE FROM loan_scenarios WHERE user_id = $1", [
      userId,
    ]);

    // Clear account FK references to categories before deleting accounts
    await manager.query(
      "UPDATE accounts SET principal_category_id = NULL, interest_category_id = NULL, asset_category_id = NULL WHERE user_id = $1",
      [userId],
    );

    // Accounts
    await manager.query("DELETE FROM accounts WHERE user_id = $1", [userId]);

    // Institutions (accounts reference these via institution_id; deleted after
    // accounts so no rows still point at them)
    await manager.query("DELETE FROM institutions WHERE user_id = $1", [
      userId,
    ]);

    // Categories
    await manager.query("DELETE FROM categories WHERE user_id = $1", [userId]);

    // Calendar day notes: no child rows and no foreign key but `users`, so the
    // order relative to the rest does not matter -- only that it is cleared at
    // all, or the insert's ON CONFLICT DO NOTHING would keep the destination's
    // note and silently drop the archive's.
    await manager.query("DELETE FROM calendar_day_notes WHERE user_id = $1", [
      userId,
    ]);

    // User preferences and auto-backup settings
    await manager.query("DELETE FROM auto_backup_settings WHERE user_id = $1", [
      userId,
    ]);
    await manager.query(
      "DELETE FROM user_currency_preferences WHERE user_id = $1",
      [userId],
    );
    await manager.query("DELETE FROM user_preferences WHERE user_id = $1", [
      userId,
    ]);

    // User-created currencies, but only ones nothing else still points at.
    //
    // Columns across most of the financial tables reference `currencies(code)`.
    // Deleting a row any of them still holds aborts the whole restore with
    // "violates foreign key constraint" -- except `user_currency_preferences`,
    // whose FK cascades and would silently remove another user's activation.
    //
    // This user's own accounts/transactions/securities/scheduled/budgets/prefs
    // are already deleted above, so a surviving reference is another user's (or
    // the global `exchange_rates`, which a restore never clears and which gets a
    // row for every currency the FX backfill has ever seen). That is exactly
    // what must block the delete.
    //
    // The `NOT EXISTS` chain this replaced listed every column but ran
    // inside this restore's transaction, where RLS filters every table to the
    // restoring user -- so the clauses looking for *other* users' rows could not
    // see them, and the cascade fired. `currency_code_in_use_globally`
    // (migration 136) is SECURITY DEFINER, so the answer is global, and it runs
    // in this transaction, so it stays atomic with the delete.
    await manager.query(
      `DELETE FROM currencies c
        WHERE c.created_by_user_id = $1
          AND NOT currency_code_in_use_globally(c.code)`,
      [userId],
    );
  }

  async restoreDeferredFkColumns(
    manager: EntityManager,
    data: BackupData,
    userId: string,
  ): Promise<void> {
    const byTable = backupTables(data);

    // These UPDATEs run inside the restore's preserveTimestamps scope
    // (restoreData), so the `updated_at` BEFORE UPDATE triggers see
    // `app.preserve_timestamps = 'on'` and keep the values Phase 2 inserted
    // from the backup instead of stamping. No trigger DDL: the old
    // DISABLE/ENABLE pair required table ownership, which the runtime role
    // does not have under RLS enforcement.
    //
    // Each one is confined to the restoring user's rows ($3). The ids come from
    // the uploaded file; `resolveRestoreReferences` and the remap make every
    // one of them a fresh id this restore inserted, and this predicate is what
    // still holds if that ever stops being true -- an UPDATE keyed only by an
    // uploaded id is an UPDATE of whichever user's row carries it.
    for (const {
      table,
      column,
      requireReferencedTable,
      ownedThrough,
    } of DEFERRED_FK_REPAIRS) {
      const rows = byTable[table];
      if (!rows) continue;
      const owner = ownedThrough
        ? `EXISTS (SELECT 1 FROM "${ownedThrough.table}" o
             WHERE o.id = "${table}"."${ownedThrough.column}" AND o.user_id = $3)`
        : "user_id = $3";
      const referenced = requireReferencedTable
        ? ` AND EXISTS (SELECT 1 FROM "${requireReferencedTable}"
             WHERE id = $1 AND user_id = $3)`
        : "";
      const sql = `UPDATE "${table}" SET "${column}" = $1
           WHERE id = $2 AND ${owner}${referenced}`;
      for (const row of rows) {
        if (row[column] != null && row.id != null) {
          await manager.query(sql, [row[column], row.id, userId]);
        }
      }
    }
  }

  async ensureCurrenciesExist(
    manager: EntityManager,
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
      const currencySchemaResult = await manager.query(
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
        await manager.query(
          `INSERT INTO "currencies" (${columnList}) VALUES (${placeholders})
           ON CONFLICT (code) DO NOTHING`,
          values,
        );
      }
    }

    // Check which codes are still missing from the currencies table
    const codeArray = Array.from(referencedCodes);
    const existing: Array<{ code: string }> = await manager.query(
      `SELECT code FROM currencies WHERE code = ANY($1)`,
      [codeArray],
    );
    const existingSet = new Set(existing.map((r) => r.code));
    const missing = codeArray.filter((c) => !existingSet.has(c));

    // Auto-create entries for any still-missing currencies. System currencies
    // (USD, EUR, ...) are not part of a user backup, so on a fresh instance the
    // codes referenced by restored accounts/transactions land here. Resolve a
    // proper name/symbol/decimal-places from the currency metadata rather than
    // defaulting the symbol to the bare code.
    for (const code of missing) {
      const meta = resolveCurrencyMetadata(code);
      await manager.query(
        `INSERT INTO "currencies" ("code", "name", "symbol", "decimal_places", "is_active", "created_by_user_id")
         VALUES ($1, $2, $3, $4, true, $5)
         ON CONFLICT (code) DO NOTHING`,
        [code, meta.name, meta.symbol, meta.decimalPlaces, userId],
      );
      this.logger.log(
        `Auto-created missing currency ${code} during backup restore`,
      );
    }
  }

  async insertRows(
    manager: EntityManager,
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
    // See restore-plan.ts; restore-plan.spec.ts proves the list covers every
    // such foreign key in database/schema.sql.
    const columnsToDefer = DEFERRED_FK_COLUMNS[table] ?? [];

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
    }> = await manager.query(
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
      const filteredRow =
        table === "notifications"
          ? boundRestoredNotification(row, this.logger)
          : { ...row };

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

      await manager.query(
        `INSERT INTO "${table}" (${columnList}) VALUES (${placeholders})
         ON CONFLICT DO NOTHING`,
        values,
      );
      count++;
    }

    return count;
  }
}
