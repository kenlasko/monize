import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { resolveCurrencyMetadata } from "../currencies/currency-metadata";
import {
  CurrencyKind,
  DEFAULT_CURRENCY_KIND,
} from "../currencies/entities/currency.entity";
import { quoteSymbolRefusal } from "../currencies/currency-kind.util";
import { sanitizeHtmlString } from "../common/decorators/sanitize-html.decorator";
import { MONEY_SCALE } from "../common/round.util";
import { tr } from "../i18n/translate";
import { boundRestoredNotification } from "./notification-restore-bounds";
import { withResolvedMortgageTypeColumn } from "../accounts/legacy-mortgage-type.util";
import { deleteAllUserData } from "./restore-wipe";
import {
  BackupData,
  backupTables,
  SeveredCatalogLinks,
  SeveredRow,
} from "./backup-format";
import {
  CATALOG_CURRENCY_MATCHED_COLUMNS,
  CATALOG_ON_SEVERED,
  CATALOG_REFERENCE_COLUMNS,
} from "./restore-references";
import {
  CONFLICT_ARBITER_COLUMNS,
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
    await deleteAllUserData(userId, manager);
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
      { rows: backupTables(data).shared_groups, column: "currency_code" },
      {
        rows: backupTables(data).shared_entries,
        column: "original_currency_code",
      },
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
        // `currencies` is shared by every user, so a restored row is held to
        // what the create DTO accepts: a code, a clean name and symbol within
        // the column lengths, and decimal places from 0 to MONEY_SCALE (8),
        // the range `currencies_decimal_places_check` holds.
        if (typeof row.code !== "string" || !/^[A-Z]{3}$/.test(row.code)) {
          continue;
        }
        if (typeof row.name !== "string" || typeof row.symbol !== "string") {
          continue;
        }
        const name = sanitizeHtmlString(row.name).slice(0, 100);
        const symbol = sanitizeHtmlString(row.symbol).slice(0, 10);
        if (name.trim() === "" || symbol.trim() === "") continue;

        const filteredRow: Record<string, unknown> = { ...row, name, symbol };
        filteredRow.created_by_user_id = userId;
        filteredRow.decimal_places =
          typeof row.decimal_places === "number" &&
          Number.isFinite(row.decimal_places)
            ? Math.min(MONEY_SCALE, Math.max(0, Math.trunc(row.decimal_places)))
            : 2;
        // A backup written before currencies had a kind is all fiat; a kind
        // outside the two is not trusted either. A price symbol travels only
        // on a coin and only when it is a `<COIN>-<FIAT>` pair, the rule
        // `CurrenciesService` holds (and the CHECK beneath it), so one bad
        // row cannot fail the whole restore.
        const kind: CurrencyKind =
          row.kind === "CRYPTO" ? "CRYPTO" : DEFAULT_CURRENCY_KIND;
        const quoteSymbol =
          typeof row.quote_symbol === "string" &&
          row.quote_symbol.trim().length <= 20
            ? row.quote_symbol.trim().toUpperCase()
            : null;
        filteredRow.kind = kind;
        filteredRow.quote_symbol =
          quoteSymbol && quoteSymbolRefusal(kind, quoteSymbol) === null
            ? quoteSymbol
            : null;

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

  /**
   * Write NULL over every reference to catalog data the target deployment cannot
   * honour, for each entry of `CATALOG_REFERENCE_COLUMNS` (so a column added
   * there is checked here, not just declared).
   *
   * A catalog table (`bond_programs`, `bond_instruments`) is reference data
   * held per deployment and not part of a backup, so a reference survives a
   * restore only where the same row exists here (a catalog id is derived from
   * its codes, so it is the same id on every deployment). The series a backup
   * references are fetched before this runs (`BackupBondSeriesRecoveryService`),
   * so what is severed here is what this deployment could not obtain.
   * What else a severed link costs the row is `CATALOG_ON_SEVERED`. A reference to a row this
   * catalog lacks -- a series a newer release seeds, an adapter this build does
   * not install -- is restored as NULL rather than failing the restore on the
   * foreign key. A column in `CATALOG_CURRENCY_MATCHED_COLUMNS` is also dropped
   * when the referenced row is in another currency than the referencing row: that
   * pair would price the row in the wrong currency (INV-PRICE-001), and a crafted
   * file is the only way to produce one.
   *
   * A security whose bond link was dropped keeps none of the engine's price rows
   * from the file: they were computed from an instrument it is no longer linked
   * to, nothing would ever recompute or remove them, and a security priced by a
   * stale engine looks like a valid price (INV-BOND-005).
   *
   * Replaces `data[table]` with new rows. Returns how many references were
   * dropped per `table.column`, each also in the log, and which rows lost one;
   * the caller tells the user (a quietly unpriced bond is a surprise).
   */
  async severUnavailableCatalogLinks(
    manager: EntityManager,
    data: BackupData,
    columns: Readonly<
      Record<string, Readonly<Record<string, string>>>
    > = CATALOG_REFERENCE_COLUMNS,
  ): Promise<SeveredCatalogLinks> {
    const counts: Record<string, number> = {};
    const severed: Record<string, SeveredRow[]> = {};
    for (const [table, references] of Object.entries(columns)) {
      for (const [column, referenced] of Object.entries(references)) {
        if (!/^[a-z_]+$/.test(referenced)) {
          // The names come from a constant, never from the file; refuse a typo
          // loudly rather than interpolate it.
          throw new Error(`Invalid catalog table name "${referenced}"`);
        }
        const key = `${table}.${column}`;
        const rows = (data as unknown as Record<string, unknown>)[table] as
          Array<Record<string, unknown>> | undefined;
        if (!rows) continue;
        const { count: dropped, rows: severedRows } =
          await this.severOneCatalogColumn(
            manager,
            data,
            table,
            column,
            referenced,
            rows,
            CATALOG_CURRENCY_MATCHED_COLUMNS.has(key),
          );
        if (dropped > 0) {
          counts[key] = dropped;
          severed[key] = severedRows;
        }
      }
    }
    return { counts, severed };
  }

  private async severOneCatalogColumn(
    manager: EntityManager,
    data: BackupData,
    table: string,
    column: string,
    referenced: string,
    rows: Array<Record<string, unknown>>,
    mustMatchCurrency: boolean,
  ): Promise<{ count: number; rows: SeveredRow[] }> {
    const wanted = [
      ...new Set(
        rows
          .map((row) => row[column])
          .filter((id): id is string => typeof id === "string"),
      ),
    ];
    if (wanted.length === 0) return { count: 0, rows: [] };

    const found: Array<{ id: string; currency_code?: string }> =
      await manager.query(
        `SELECT id${mustMatchCurrency ? ", currency_code" : ""} FROM ${referenced} WHERE id = ANY($1::uuid[])`,
        [wanted],
      );
    const present = new Map(found.map((r) => [r.id, r.currency_code]));

    let absent = 0;
    let foreignCurrency = 0;
    const severedRows: SeveredRow[] = [];
    const next = rows.map((row) => {
      const id = row[column];
      if (typeof id !== "string") return row;
      if (!present.has(id)) {
        absent += 1;
      } else if (!mustMatchCurrency || present.get(id) === row.currency_code) {
        return row;
      } else {
        foreignCurrency += 1;
      }
      if (typeof row.id === "string") {
        const symbol = typeof row.symbol === "string" ? row.symbol : null;
        severedRows.push({ id: row.id, symbol });
      }
      return { ...row, [column]: null };
    });
    (data as unknown as Record<string, unknown>)[table] = next;

    if (absent > 0) {
      this.logger.warn(
        `Backup restore: ${absent} ${table}.${column} reference(s) to ${referenced} this ` +
          "deployment's catalog does not carry were restored as NULL.",
      );
    }
    if (foreignCurrency > 0) {
      this.logger.warn(
        `Backup restore: ${foreignCurrency} ${table}.${column} reference(s) to ${referenced} ` +
          "in another currency than the row were restored as NULL.",
      );
    }

    CATALOG_ON_SEVERED.get(`${table}.${column}`)?.(
      data,
      new Set(severedRows.map((row) => row.id)),
    );
    return { count: absent + foreignCurrency, rows: severedRows };
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

    // A table with a DEFERRABLE unique constraint cannot take a bare ON
    // CONFLICT; it names its arbiter (restore-plan.ts). Constant identifiers,
    // never from the uploaded file.
    const arbiter = CONFLICT_ARBITER_COLUMNS[table];
    const conflictTarget = arbiter
      ? `(${arbiter.map((c) => `"${c}"`).join(", ")}) `
      : "";

    let count = 0;
    for (const row of rows) {
      // An `accounts` row from a backup taken before the mortgage type was
      // required carries the legacy flags and a null or missing type; nothing
      // reads the flags now, so it is given the type the default migration
      // would have given it, and the flags are left out.
      const filteredRow =
        table === "notifications"
          ? boundRestoredNotification(row, this.logger)
          : table === "accounts"
            ? withResolvedMortgageTypeColumn(row)
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
         ON CONFLICT ${conflictTarget}DO NOTHING`,
        values,
      );
      count++;
    }

    return count;
  }

  /**
   * The restored rows that break INV-CRYPTO-001 or decision 11 of
   * `docs/specs/crypto-accounts.md`, read after the accounts, securities and
   * preferences are written, inside the restore's transaction:
   *
   * - a `CRYPTO` account whose currency is not a CRYPTO currency, or a
   *   non-CRYPTO account in a CRYPTO currency (the account kind check);
   * - a security priced in a CRYPTO currency (a security is priced in fiat);
   * - a reporting currency that is a CRYPTO currency.
   *
   * Reported, not refused. `currencies` is global, so the kind of a code is
   * this deployment's, not the backup's: a file whose `BTC` was a coin,
   * restored where `BTC` is a fiat row (`ensureCurrenciesExist` never
   * overwrites one), mismatches through no fault in the file. The restore
   * refuses only what would let one user's rows reach another's (the
   * reference check); every other repairable difference -- a severed bond
   * link, an unusable AI key -- is restored and reported, and so is this. The
   * person repairs it on the Accounts, Securities or Preferences page.
   */
  async findCurrencyKindMismatches(
    manager: EntityManager,
    userId: string,
  ): Promise<CurrencyKindMismatches> {
    const accounts: Array<{ name: string }> = await manager.query(
      `SELECT a.name FROM accounts a
         JOIN currencies c ON c.code = a.currency_code
        WHERE a.user_id = $1
          AND (a.account_type = 'CRYPTO') <> (c.kind = 'CRYPTO')
        ORDER BY a.name`,
      [userId],
    );
    const securities: Array<{ symbol: string }> = await manager.query(
      `SELECT s.symbol FROM securities s
         JOIN currencies c ON c.code = s.currency_code
        WHERE s.user_id = $1 AND c.kind = 'CRYPTO'
        ORDER BY s.symbol`,
      [userId],
    );
    const preferences: Array<{ code: string }> = await manager.query(
      `SELECT up.default_currency AS code FROM user_preferences up
         JOIN currencies c ON c.code = up.default_currency
        WHERE up.user_id = $1 AND c.kind = 'CRYPTO'`,
      [userId],
    );
    const found: CurrencyKindMismatches = {
      accounts: accounts.map((row) => row.name),
      securities: securities.map((row) => row.symbol),
      defaultCurrency: preferences[0]?.code ?? null,
    };
    if (
      found.accounts.length > 0 ||
      found.securities.length > 0 ||
      found.defaultCurrency !== null
    ) {
      this.logger.warn(
        `Backup restore for user ${userId} wrote rows whose currency kind disagrees: ` +
          `${found.accounts.length} account(s), ${found.securities.length} security(ies)` +
          (found.defaultCurrency !== null
            ? `, reporting currency ${found.defaultCurrency} is a cryptocurrency`
            : ""),
      );
    }
    return found;
  }
}

/** What `findCurrencyKindMismatches` found; empty lists and `null` when nothing. */
export interface CurrencyKindMismatches {
  /** Names of accounts whose type and currency kind disagree (INV-CRYPTO-001). */
  accounts: string[];
  /** Symbols of securities priced in a CRYPTO currency. */
  securities: string[];
  /** The reporting currency, when it is a CRYPTO currency; else `null`. */
  defaultCurrency: string | null;
}
