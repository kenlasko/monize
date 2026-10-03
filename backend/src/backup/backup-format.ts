import { BadRequestException } from "@nestjs/common";

/**
 * The backup file format: the envelope version, the shape of a parsed artifact,
 * and the two result types the export and restore paths hand back.
 *
 * These live apart from any service because four of them now share the format --
 * `BackupExportService` writes it, `BackupRestoreService` reads it,
 * `BackupAttachmentTransferService` rewrites its attachment tables, and
 * `BackupRestoreDatabaseService` inserts from it. A format described in the class
 * that happens to be biggest is a format the next class re-describes.
 */
export const BACKUP_VERSION = 1;

export interface RestoreBackupInput {
  compressedData: Buffer;
  password?: string;
  oidcIdToken?: string;
  // Password used to encrypt the backup file. For local users this is usually
  // the same as `password`; if the user rotated their login password since the
  // backup was made, the frontend re-prompts and sends the old one here.
  backupPassword?: string;
  /**
   * Fires when the caller disconnects, and governs **only** the wait for a
   * processing slot (DR-F3RB-002).
   *
   * Named for the queue rather than for the request so the scope is visible at
   * every call site: a queued restore has done nothing and may be dropped, while
   * a restore that holds a slot is part-way through replacing the user's data and
   * must never be cancelled by a socket event. `RestoreProcessingGate` stops
   * listening the moment the slot is granted.
   */
  queueAbortSignal?: AbortSignal;
}

export interface RestoreResult {
  message: string;
  /** Rows written, keyed by `RestoreStep.countKey`. The client sums these. */
  restored: Record<string, number>;
  /**
   * Attachments whose metadata was deliberately not written because their bytes
   * could not be made reachable -- absent from the sidecar store, failing their
   * recorded checksum, or exported from an instance using a different storage
   * provider. Kept out of `restored` so it is never added into a row total.
   * Omitted when nothing was skipped, so "no field" and "zero" agree.
   */
  skippedAttachments?: number;
  /**
   * AI provider configurations restored without a usable API key.
   *
   * Keys travel decrypted and are re-encrypted under the receiving instance's
   * `ENCRYPTION_KEY` (`ai-provider-key-transport.ts`), so the ordinary
   * cross-instance restore has nothing to report. Two cases remain: an artifact
   * written before keys travelled that way, carrying ciphertext under an
   * `ENCRYPTION_KEY` this server does not hold, and a server with no
   * `ENCRYPTION_KEY` configured, which has nothing to store a key under.
   *
   * Both leave a provider row that looks configured and fails on every call --
   * the column is either populated-and-unreadable or empty, and nothing else on
   * screen says which -- so the restore has to say so.
   *
   * Counted beside `restored` rather than deducted from it, for the same reason
   * `skippedAttachments` is: these rows *were* written. It is the key inside
   * them that did not survive, and the user has to be told so they can re-enter
   * it. Omitted when zero.
   */
  unusableAiProviderKeys?: number;
}

export class BackupPasswordRequiredError extends BadRequestException {
  constructor(message: string) {
    super({ message, code: "BACKUP_PASSWORD_REQUIRED" });
  }
}

/**
 * Whether a produced artifact backs up every attachment it names.
 *
 * A backup that carries an attachment's metadata row but not its bytes is not a
 * backup of that attachment (`docs/backup-restore-contract.md` §4). External
 * bytes can be unreadable or inconsistent at export time (a truncated or replaced
 * object), and a database-provider blob can be missing or wrong for its metadata.
 * The export omits those bytes rather than packaging a lie -- but then the
 * *artifact* is incomplete, and the caller has to know, because an incomplete
 * backup must never be promoted or retained as if it were a complete one.
 */
export interface BackupCompletenessReport {
  complete: boolean;
  /** Attachment metadata rows in the artifact. */
  expectedAttachments: number;
  /** Rows whose bytes are present and consistent. */
  includedAttachments: number;
  /** Rows whose bytes could not be included at all. */
  missingAttachments: number;
  /** Rows whose (database-provider) bytes contradict their own metadata. */
  inconsistentAttachments: number;
}

/**
 * The envelope's completeness claim, or `null` when the artifact makes none.
 *
 * The same report the export returns, read back from inside the file. It travels
 * in the document because completeness used to live only in
 * `auto_backup_settings.lastBackupStatus`, which does not survive the artifact:
 * copy it to another machine, restart the server, or find it in a directory
 * rescan, and a partial artifact was indistinguishable from a complete one
 * (F3RB-001, issue #1069). The *filename* is what retention reads -- an
 * encrypted artifact's envelope is inside the ciphertext -- and this is the copy
 * a rename cannot lose.
 *
 * `null` is "this file predates the field", not "complete" and not "partial" --
 * see the missing-data rule in `AGENTS.md`. Every count has to be a
 * finite number and the flag a boolean, or the claim is malformed and is treated
 * as absent rather than half-read.
 */
export function parseArtifactCompleteness(
  value: unknown,
): BackupCompletenessReport | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.complete !== "boolean") return null;
  const counts = [
    "expectedAttachments",
    "includedAttachments",
    "missingAttachments",
    "inconsistentAttachments",
  ] as const;
  for (const key of counts) {
    if (typeof raw[key] !== "number" || !Number.isFinite(raw[key])) return null;
  }
  return {
    complete: raw.complete,
    expectedAttachments: raw.expectedAttachments as number,
    includedAttachments: raw.includedAttachments as number,
    missingAttachments: raw.missingAttachments as number,
    inconsistentAttachments: raw.inconsistentAttachments as number,
  };
}

export interface BackupData {
  version: number;
  exportedAt: string;
  /**
   * Whether this artifact backs up every attachment it names. Absent from
   * artifacts written before the field existed -- see
   * `parseArtifactCompleteness`. Not a table: every walker over `BackupData`
   * skips non-array values, the way it already does for `supportBackup`.
   */
  completeness?: BackupCompletenessReport;
  currencies: Record<string, unknown>[];
  user_preferences: Record<string, unknown>[];
  user_currency_preferences: Record<string, unknown>[];
  categories: Record<string, unknown>[];
  payees: Record<string, unknown>[];
  payee_aliases: Record<string, unknown>[];
  institutions: Record<string, unknown>[];
  accounts: Record<string, unknown>[];
  tags: Record<string, unknown>[];
  transaction_rules: Record<string, unknown>[];
  email_receipt_parsers: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
  transaction_splits: Record<string, unknown>[];
  transaction_attachments: Record<string, unknown>[];
  attachment_blobs: Record<string, unknown>[];
  transaction_tags: Record<string, unknown>[];
  transaction_split_tags: Record<string, unknown>[];
  scheduled_transactions: Record<string, unknown>[];
  scheduled_transaction_splits: Record<string, unknown>[];
  scheduled_transaction_overrides: Record<string, unknown>[];
  securities: Record<string, unknown>[];
  security_prices: Record<string, unknown>[];
  security_documents: Record<string, unknown>[];
  holdings: Record<string, unknown>[];
  investment_transactions: Record<string, unknown>[];
  loan_rate_changes: Record<string, unknown>[];
  loan_scenarios: Record<string, unknown>[];
  security_tags: Record<string, unknown>[];
  budgets: Record<string, unknown>[];
  budget_categories: Record<string, unknown>[];
  budget_periods: Record<string, unknown>[];
  budget_period_categories: Record<string, unknown>[];
  notifications: Record<string, unknown>[];
  custom_reports: Record<string, unknown>[];
  investment_reports: Record<string, unknown>[];
  import_column_mappings: Record<string, unknown>[];
  monthly_account_balances: Record<string, unknown>[];
  auto_backup_settings: Record<string, unknown>[];
  scheduled_transaction_split_tags: Record<string, unknown>[];
  monte_carlo_scenarios: Record<string, unknown>[];
  monte_carlo_cash_flows: Record<string, unknown>[];
  ai_provider_configs: Record<string, unknown>[];
  payee_lookup_settings: Record<string, unknown>[];
  payee_lookup_usage: Record<string, unknown>[];
  gem_strategies: Record<string, unknown>[];
  gem_strategy_accounts: Record<string, unknown>[];
  gem_strategy_assets: Record<string, unknown>[];
  gem_strategy_signals: Record<string, unknown>[];
}

/** A backup's tables addressed by name, for the paths that walk them generically. */
export type BackupTables = Record<
  string,
  Record<string, unknown>[] | undefined
>;

/** `data` viewed as plain table -> rows, without an `as unknown as` at each site. */
export function backupTables(data: BackupData): BackupTables {
  return data as unknown as BackupTables;
}

/**
 * Tables that used to be exported under a different name, as
 * `currentName -> the names older artifacts wrote it under`.
 *
 * A backup keys its tables by SQL table name, so renaming a table renames the
 * key every artifact written before the rename does *not* carry. Nothing about
 * that is loud: `insertRows` is handed `undefined` for the new key, restores
 * zero rows, and reports zero -- a silent data loss inside an operation whose
 * whole promise is that nothing is lost. The version cannot carry the fix
 * either: `validateBackupFormat` compares it for equality, so bumping it would
 * reject every existing artifact instead of reading one.
 *
 * `budget_alerts` became `notifications` in migration 179.
 */
export const LEGACY_TABLE_KEYS: Readonly<Record<string, readonly string[]>> = {
  notifications: ["budget_alerts"],
};

/**
 * Move any legacy table key onto the name the rest of the restore uses, in
 * place, and report which ones moved.
 *
 * Called once, on the parsed artifact, before anything else looks at it -- id
 * remapping, attachment staging, currency pre-creation and the insert loop all
 * walk the document by table name, and a rule applied at only one of them is a
 * rule that holds for one of them. An artifact carrying both names keeps the
 * current one: it was written by an instance that already knew the new name.
 *
 * That decision DISCARDS the legacy rows, so it is reported rather than made
 * silently -- an artifact holding 40 `budget_alerts` beside an empty
 * `notifications` restored as a success with nothing said about the 40. A count
 * of rows that did not come back never belongs only in a comment; the caller
 * logs it, for the same reason `skippedAttachments` is its own field.
 */
export interface LegacyTableRename {
  /** `legacy -> current`, for the log line. */
  readonly renamed: string[];
  /** Legacy tables whose rows were dropped because the current name won. */
  readonly discarded: { table: string; supersededBy: string; rows: number }[];
}

export function renameLegacyTableKeys(
  data: BackupData,
): LegacyTableRename & { data: BackupData } {
  const renamed: string[] = [];
  const discarded: LegacyTableRename["discarded"] = [];
  // Built as a new object, never by deleting keys on the caller's document
  // ("immutability always"): the caller keeps the parsed artifact it was handed
  // and continues with the returned one, so nothing changes shape under it.
  let tables: BackupTables = { ...backupTables(data) };
  for (const [current, legacyNames] of Object.entries(LEGACY_TABLE_KEYS)) {
    for (const legacy of legacyNames) {
      if (!(legacy in tables)) continue;
      const { [legacy]: rows, ...withoutLegacy } = tables;
      tables = withoutLegacy;
      // Only a row array is moved. A malformed artifact carrying a scalar or an
      // object under the legacy key would otherwise arrive under the current
      // one, turning an absent table (which every later phase handles) into a
      // present malformed one.
      if (!Array.isArray(rows)) continue;
      if (tables[current] !== undefined) {
        if (rows.length > 0) {
          discarded.push({
            table: legacy,
            supersededBy: current,
            rows: rows.length,
          });
        }
        continue;
      }
      tables = { ...tables, [current]: rows };
      renamed.push(`${legacy} -> ${current}`);
    }
  }
  return { data: tables as unknown as BackupData, renamed, discarded };
}
