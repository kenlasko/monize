import { BadRequestException } from "@nestjs/common";
import { tr } from "../i18n/translate";
import { canonicalUuid } from "./backup-id-remap.util";
import { BackupData, backupTables, BackupTables } from "./backup-format";
import { RESTORE_PLAN } from "./restore-plan";

/**
 * The restore's reference graph: which uploaded columns name another row, and
 * the rule that every one of them names a row the same file carries.
 *
 * Why this exists: a restore forces `user_id` on the tables that have one, and
 * nothing else. Every other identifier came from the uploaded document, and a
 * reference that did not resolve inside it was inserted verbatim -- so a file
 * naming another user's account, transaction, security or schedule wrote rows
 * pointing into that user's ledger (a holding or a price on their security, a
 * split transferring into their account), and the Phase-3 `UPDATE ... WHERE id`
 * rewrote their rows outright when the file spelled a primary key in a UUID
 * form the remap did not recognise (upper case, no hyphens, braces), because the
 * insert of that row then conflicted and was skipped. `RLS_MODE` defaults to
 * `off`, so nothing but this code stood in the way.
 *
 * The rule now: every UUID the file uses as a primary key or a reference is
 * canonicalised first, and every reference must name a row of the referenced
 * table in the same file. Every such row is then remapped to a fresh id, so the
 * whole restored graph is closed over rows this restore inserted. The only
 * references the restore will not refuse over are the two in
 * `SEVERED_WHEN_UNRESOLVED`, which a genuine export can produce and which are
 * dropped (set NULL) rather than followed.
 */

/**
 * Every foreign-key column of every restored table that points at another
 * restored table, as `table -> column -> referenced table`.
 *
 * Complete by test: `restore-references.spec.ts` parses every foreign key out
 * of `database/schema.sql` and fails on one missing from here, one declared
 * here that is not in the schema, and any scalar UUID column of a restored
 * table that is neither `id`, `user_id` nor listed here. References to `users`
 * (forced to the restoring user) and to `currencies` (shared rows keyed by
 * code) are not UUID references to rows of this file and are not listed.
 */
export const RESTORE_REFERENCE_COLUMNS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  categories: { parent_id: "categories" },
  payees: { default_category_id: "categories" },
  payee_aliases: { payee_id: "payees" },
  email_receipt_parsers: { payee_id: "payees" },
  accounts: {
    linked_account_id: "accounts",
    source_account_id: "accounts",
    institution_id: "institutions",
    principal_category_id: "categories",
    interest_category_id: "categories",
    overpayment_category_id: "categories",
    overpayment_payee_id: "payees",
    scheduled_transaction_id: "scheduled_transactions",
    asset_category_id: "categories",
    linked_loan_account_id: "accounts",
  },
  scheduled_transactions: {
    account_id: "accounts",
    payee_id: "payees",
    category_id: "categories",
    transfer_account_id: "accounts",
    investment_security_id: "securities",
    investment_funding_account_id: "accounts",
  },
  scheduled_transaction_splits: {
    scheduled_transaction_id: "scheduled_transactions",
    category_id: "categories",
    transfer_account_id: "accounts",
    investment_security_id: "securities",
  },
  scheduled_transaction_overrides: {
    scheduled_transaction_id: "scheduled_transactions",
    category_id: "categories",
  },
  scheduled_transaction_postings: {
    scheduled_transaction_id: "scheduled_transactions",
  },
  scheduled_transaction_split_tags: {
    scheduled_transaction_split_id: "scheduled_transaction_splits",
    tag_id: "tags",
  },
  security_prices: { security_id: "securities" },
  security_documents: { security_id: "securities" },
  holdings: { account_id: "accounts", security_id: "securities" },
  security_tags: { security_id: "securities", tag_id: "tags" },
  transactions: {
    account_id: "accounts",
    payee_id: "payees",
    category_id: "categories",
    parent_transaction_id: "transactions",
    linked_transaction_id: "transactions",
  },
  transaction_splits: {
    transaction_id: "transactions",
    category_id: "categories",
    transfer_account_id: "accounts",
    linked_transaction_id: "transactions",
  },
  transaction_attachments: {
    transaction_id: "transactions",
    original_of_attachment_id: "transaction_attachments",
  },
  attachment_blobs: { attachment_id: "transaction_attachments" },
  transaction_tags: { transaction_id: "transactions", tag_id: "tags" },
  transaction_split_tags: {
    transaction_split_id: "transaction_splits",
    tag_id: "tags",
  },
  investment_transactions: {
    account_id: "accounts",
    transaction_id: "transactions",
    transaction_split_id: "transaction_splits",
    linked_transaction_id: "investment_transactions",
    security_id: "securities",
    funding_account_id: "accounts",
  },
  loan_rate_changes: { account_id: "accounts" },
  loan_scenarios: { account_id: "accounts" },
  budget_categories: {
    budget_id: "budgets",
    category_id: "categories",
    transfer_account_id: "accounts",
  },
  budget_periods: { budget_id: "budgets" },
  budget_period_categories: {
    budget_period_id: "budget_periods",
    budget_category_id: "budget_categories",
    category_id: "categories",
  },
  notifications: {
    budget_id: "budgets",
    budget_category_id: "budget_categories",
  },
  notification_reminders: { source_notification_id: "notifications" },
  monthly_account_balances: { account_id: "accounts" },
  payee_lookup_settings: { ai_provider_config_id: "ai_provider_configs" },
  monte_carlo_cash_flows: { scenario_id: "monte_carlo_scenarios" },
  gem_strategy_accounts: {
    strategy_id: "gem_strategies",
    account_id: "accounts",
  },
  gem_strategy_assets: {
    strategy_id: "gem_strategies",
    security_id: "securities",
  },
  gem_strategy_signals: {
    strategy_id: "gem_strategies",
    target_security_id: "securities",
  },
};

/**
 * The references a genuine export can carry without the row they name, keyed
 * `table.column`, each with the reason. One of these that does not resolve
 * inside the file is set NULL and logged -- never followed, because the row it
 * names is not this user's to link to -- instead of refusing the restore.
 *
 * The bar for an entry: the exporter itself writes such a value, and the column
 * is nullable with NULL already meaning what severing it means. Anything else
 * unresolved is a crafted or corrupted file and refuses the whole restore.
 */
export const SEVERED_WHEN_UNRESOLVED: ReadonlyMap<string, string> = new Map([
  [
    "transactions.linked_transaction_id",
    "A cross-owner transfer's counterpart leg is another user's transaction, " +
      "so a genuine export names a row it does not contain. The restore " +
      "deletes this user's own leg first (ON DELETE SET NULL already unlinks " +
      "the counterpart's side), so the pair is broken whatever happens; " +
      "re-linking the restored leg to a row the file cannot vouch for is " +
      "exactly the reference a crafted file would use.",
  ],
  [
    "accounts.institution_id",
    "Backups taken before institutions were exported carry the id with no " +
      "institution row. The Phase-3 repair always left it NULL when the " +
      "institution did not exist; it is now NULL whenever the file does not " +
      "carry it, rather than whenever no institution of ANY user has that id.",
  ],
]);

/**
 * Restored tables whose `id` is not a UUID. `security_prices.id` is BIGSERIAL:
 * `insertRows` strips it so the sequence assigns a fresh value, and it is never
 * referenced. Checked against the schema by `restore-references.spec.ts`.
 */
export const NON_UUID_ID_TABLES: ReadonlySet<string> = new Set([
  "security_prices",
]);

/** One severed reference column, for the restore's log line. */
export interface SeveredReference {
  table: string;
  column: string;
  rows: number;
}

export interface ResolvedRestoreReferences {
  /** A new document: every UUID id and reference in canonical form. */
  data: BackupData;
  severed: SeveredReference[];
}

const RESTORED_TABLE_NAMES = RESTORE_PLAN.map((step) => step.table);

/** Long enough to find the row in the file, short enough for an error line. */
function describeValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? String(value)).slice(0, 64);
}

function invalidIdentifier(
  table: string,
  column: string,
  value: unknown,
): BadRequestException {
  const shown = describeValue(value);
  return new BadRequestException(
    tr(
      "errors.backup.invalidRestoreIdentifier",
      `Invalid backup file: ${table}.${column} holds "${shown}", which is not a valid identifier. Restore from an unmodified backup file.`,
      { table, column, value: shown },
    ),
  );
}

function unresolvedReference(
  table: string,
  column: string,
  referencedTable: string,
  value: string,
): BadRequestException {
  return new BadRequestException(
    tr(
      "errors.backup.unresolvedRestoreReference",
      `Invalid backup file: ${table}.${column} refers to ${referencedTable} row ${value}, which the file does not contain. A backup can only restore rows that refer to other rows in the same file; restore from an unmodified backup file.`,
      { table, column, referencedTable, value },
    ),
  );
}

function rowsOf(tables: BackupTables, table: string): unknown[] | null {
  const rows = (tables as Record<string, unknown>)[table];
  return Array.isArray(rows) ? rows : null;
}

function isRow(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Canonicalise every UUID primary key and reference in the restored tables, and
 * refuse the file unless every reference names a row of the referenced table in
 * the same file (or is one of `SEVERED_WHEN_UNRESOLVED`, which is set NULL).
 *
 * Pure, and run before re-authentication and before anything is written: a
 * refusal here costs the user nothing and leaves their data untouched.
 */
export function resolveRestoreReferences(
  data: BackupData,
): ResolvedRestoreReferences {
  const source = backupTables(data);

  // Pass 1: canonical primary keys, and the set each table contributes.
  const idsByTable = new Map<string, Set<string>>();
  const withCanonicalIds = new Map<string, unknown[]>();
  for (const table of RESTORED_TABLE_NAMES) {
    const rows = rowsOf(source, table);
    if (rows === null) continue;
    const ids = new Set<string>();
    const canonicalRows = rows.map((row) => {
      if (!isRow(row) || row.id === null || row.id === undefined) return row;
      if (NON_UUID_ID_TABLES.has(table)) return row;
      const id = canonicalUuid(row.id);
      if (id === null) throw invalidIdentifier(table, "id", row.id);
      ids.add(id);
      return id === row.id ? row : { ...row, id };
    });
    idsByTable.set(table, ids);
    withCanonicalIds.set(table, canonicalRows);
  }

  // Pass 2: every reference resolves inside the file, or is severed, or the
  // restore is refused.
  const severedCounts = new Map<string, number>();
  const result: Record<string, unknown> = { ...source };
  for (const [table, rows] of withCanonicalIds) {
    const references = RESTORE_REFERENCE_COLUMNS[table] ?? {};
    const columns = Object.entries(references);
    result[table] =
      columns.length === 0
        ? rows
        : rows.map((row) => {
            if (!isRow(row)) return row;
            let next = row;
            for (const [column, referencedTable] of columns) {
              const value = row[column];
              if (value === null || value === undefined) continue;
              const canonical = canonicalUuid(value);
              if (canonical === null) {
                throw invalidIdentifier(table, column, value);
              }
              let resolved: string | null = canonical;
              if (!idsByTable.get(referencedTable)?.has(canonical)) {
                const key = `${table}.${column}`;
                if (!SEVERED_WHEN_UNRESOLVED.has(key)) {
                  throw unresolvedReference(
                    table,
                    column,
                    referencedTable,
                    canonical,
                  );
                }
                severedCounts.set(key, (severedCounts.get(key) ?? 0) + 1);
                resolved = null;
              }
              if (resolved !== value) next = { ...next, [column]: resolved };
            }
            return next;
          });
  }

  const severed = [...severedCounts].map(([key, rows]) => {
    const [table, column] = key.split(".");
    return { table, column, rows };
  });
  return { data: result as unknown as BackupData, severed };
}

/**
 * Remap one restored row onto the fresh ids.
 *
 * A top-level value is rewritten when it is exactly an id in the remap -- after
 * `resolveRestoreReferences` that is every primary key and every reference
 * column, all canonical. A string nested inside a JSONB value or an array column
 * (`scheduled_transactions.tag_ids`, override `splits`,
 * `monte_carlo_scenarios.account_ids`, report filters) cannot be classified as a
 * reference or not by column, so any string PostgreSQL would read as a UUID is
 * canonicalised and either remapped or, when it names no row of this file,
 * replaced with a fresh id that names nothing (`unresolved` keeps the
 * replacement consistent across the document). Such a value is at best a stale
 * reference to a deleted row and at worst another user's id, and either way it
 * must not reach the restored data as a working pointer.
 */
export function remapRestoreRow(
  row: unknown,
  remap: ReadonlyMap<string, string>,
  unresolved: Map<string, string>,
  freshId: () => string,
): unknown {
  if (!isRow(row)) return row;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "string"
        ? (remap.get(value) ?? value)
        : remapNested(value, remap, unresolved, freshId),
    ]),
  );
}

function remapNested(
  value: unknown,
  remap: ReadonlyMap<string, string>,
  unresolved: Map<string, string>,
  freshId: () => string,
): unknown {
  if (typeof value === "string") {
    const canonical = canonicalUuid(value);
    if (canonical === null) return value;
    const mapped = remap.get(canonical);
    if (mapped !== undefined) return mapped;
    let replacement = unresolved.get(canonical);
    if (replacement === undefined) {
      replacement = freshId();
      unresolved.set(canonical, replacement);
    }
    return replacement;
  }
  if (Array.isArray(value)) {
    return value.map((item) => remapNested(item, remap, unresolved, freshId));
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [
        key,
        remapNested(val, remap, unresolved, freshId),
      ]),
    );
  }
  return value;
}
