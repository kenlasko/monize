import { EntityManager } from "typeorm";
import { compareMigrationFilenames } from "../common/db/migration-filename";
import {
  BackupData,
  backupTables,
  parseProducedBySchemaMigration,
} from "./backup-format";

/**
 * Semantic backfills for rows that arrive from an artifact older than the
 * migration that changed what a stored value means.
 *
 * A migration that redefines a column backfills the rows the database holds
 * when it runs, once. A restore inserts rows exactly as the file stores them, so
 * an artifact written before the migration brings the old meaning back in
 * (A26-S06-04). Each entry here is that migration's backfill, replayed on the
 * restored rows of one user inside the restore transaction, keyed by the
 * migration that introduced the change. A new semantic migration adds an entry;
 * nothing else in the restore needs to know.
 */
export interface LegacyNormalization {
  /** The migration whose meaning change this repeats. */
  readonly migration: string;
  /**
   * Whether an artifact with no usable `producedBy` marker is OLDER than
   * `migration`. Positive evidence only: `false` means "not known to be old",
   * and the rows are then left as stored.
   */
  readonly markerlessArtifactIsOlder: (data: BackupData) => boolean;
  /** The migration's backfill, scoped to the restoring user's rows. */
  readonly apply: (manager: EntityManager, userId: string) => Promise<void>;
}

/**
 * The evidence rule for an artifact without a marker, shared by the entries
 * whose migration shipped in 1.19.0 together with `hidden_table_columns`.
 *
 * `user_preferences.hidden_table_columns` was added by
 * `20261012133629_user_preferences_hidden_table_columns.sql`. Both it and the
 * `skip_price_updates` migration first shipped in release 1.19.0 and neither in
 * 1.18.0, and the export writes every column of `user_preferences` (a
 * `SELECT *`, so a null value is still a key). A marker-less artifact whose
 * preference rows lack the key was therefore written before 1.19.0 and carries
 * the old meaning; one that has the key was written by 1.19.0, where `true` is a
 * deliberate user switch that must be kept. With no preference rows there is no
 * evidence either way, so nothing is normalized.
 */
function lacksHiddenTableColumns(data: BackupData): boolean {
  const rows = backupTables(data).user_preferences;
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return rows.every(
    (row) =>
      typeof row === "object" &&
      row !== null &&
      !("hidden_table_columns" in row),
  );
}

/**
 * Evidence that a marker-less artifact predates
 * `transactions.amount_is_provisional`
 * (`20261125132236_transactions_amount_is_provisional.sql`): the export writes
 * every column of `transactions`, so rows lacking the key were written before
 * the column existed. With no transaction rows there is no evidence, and with
 * the key present the file is not known to be old.
 */
function lacksAmountIsProvisional(data: BackupData): boolean {
  const rows = backupTables(data).transactions;
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return rows.every(
    (row) =>
      typeof row === "object" &&
      row !== null &&
      !("amount_is_provisional" in row),
  );
}

/**
 * The note the QIF importer appended to a provisional transfer leg's
 * description until issue #2400 retired it. This file is the only code that
 * still knows the text (`import/pending-import-note.guard.spec.ts`): it strips
 * it from a backup taken before the migration that stripped the database.
 */
export const LEGACY_PENDING_IMPORT_NOTE =
  "\u26a0\ufe0f PENDING IMPORT: Amount may need adjustment when importing the other account.";

/**
 * A transfer leg outside the shared-expense ledger, as the two backfills and
 * the strip select it: the importer never wrote a ledger row, so no note there
 * is its, and shared_protect_ledger_transaction refuses the flag change on any
 * of them and even a description edit on a settlement-account row or a VOID
 * posting.
 */
const IMPORTED_TRANSFER_LEG_SQL = `is_transfer = true
            AND shared_expense_posting_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM accounts a
              WHERE a.id = transactions.account_id
                AND a.shared_expense_group_id IS NOT NULL
            )`;

export const LEGACY_NORMALIZATIONS: readonly LegacyNormalization[] = [
  {
    // `skip_price_updates` became the user's own "disable price updates" switch:
    // refresh honours the flag alone, where a provider override or an MSN
    // instrument id used to override it. The WHERE mirrors the migration's.
    migration: "20261012131846_securities_skip_price_updates_user_switch.sql",
    markerlessArtifactIsOlder: lacksHiddenTableColumns,
    apply: async (manager, userId) => {
      await manager.query(
        `UPDATE securities
            SET skip_price_updates = false
          WHERE user_id = $1
            AND skip_price_updates = true
            AND (quote_provider IS NOT NULL OR msn_instrument_id IS NOT NULL)`,
        [userId],
      );
    },
  },
  {
    // The provisional flag from the importer's note (issues #2389 and #2390,
    // design docs/future-plans/provisional-amounts.md section 11): an artifact
    // written before the importer set the column carries the state only in
    // the text. Keyed on the second pass, the last schema before the
    // importer wrote the column, and never on anything later: from then on a
    // reader can confirm a leg, which clears the flag and leaves the note, so
    // flagging by the text again would undo the confirmation (issue #2400).
    migration:
      "20261125150107_transactions_amount_is_provisional_backfill_repeat.sql",
    markerlessArtifactIsOlder: lacksAmountIsProvisional,
    apply: async (manager, userId) => {
      await manager.query(
        `UPDATE transactions
            SET amount_is_provisional = true
          WHERE user_id = $1
            AND amount_is_provisional = false
            AND description LIKE '%PENDING IMPORT%'
            AND ${IMPORTED_TRANSFER_LEG_SQL}`,
        [userId],
      );
    },
  },
  {
    // The note itself, cut out of every imported transfer leg that still
    // holds it verbatim, flagged or confirmed; the rest is trimmed and an
    // empty description is NULL (issue #2400). Runs after the backfill above,
    // which reads the text.
    migration: "20261126115405_transactions_strip_pending_import_note.sql",
    markerlessArtifactIsOlder: lacksAmountIsProvisional,
    apply: async (manager, userId) => {
      await manager.query(
        `UPDATE transactions
            SET description = NULLIF(btrim(replace(description, $2, '')), '')
          WHERE user_id = $1
            AND strpos(description, $2) > 0
            AND ${IMPORTED_TRANSFER_LEG_SQL}`,
        [userId, LEGACY_PENDING_IMPORT_NOTE],
      );
    },
  },
];

/**
 * Whether the artifact predates `entry.migration`: by its marker when it has a
 * usable one (strictly older), by the entry's evidence rule when it has none.
 */
export function artifactPredates(
  entry: LegacyNormalization,
  data: BackupData,
): boolean {
  const marker = parseProducedBySchemaMigration(data.producedBy);
  if (marker !== null) {
    return compareMigrationFilenames(marker, entry.migration) < 0;
  }
  return entry.markerlessArtifactIsOlder(data);
}

/** The normalizations this artifact's rows need, in registry order. */
export function legacyNormalizationsFor(
  data: BackupData,
  registry: readonly LegacyNormalization[] = LEGACY_NORMALIZATIONS,
): LegacyNormalization[] {
  return registry.filter((entry) => artifactPredates(entry, data));
}

/** Run them on the restored rows, one statement after another. */
export async function applyLegacyNormalizations(
  manager: EntityManager,
  userId: string,
  data: BackupData,
): Promise<void> {
  for (const entry of legacyNormalizationsFor(data)) {
    await entry.apply(manager, userId);
  }
}
