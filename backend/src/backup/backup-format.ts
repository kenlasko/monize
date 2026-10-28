import { BadRequestException } from "@nestjs/common";
import { parseMigrationPrefix } from "../common/db/migration-filename";

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
  /**
   * Securities restored unlinked from their bond instrument, because this
   * deployment's catalog does not carry it (or carries it in another currency).
   * The rows *were* written; what changed is that the bond engine no longer
   * prices them, so the user has to re-link them (spec 12.1). The engine's price
   * rows in the file for those securities are not restored. Counted beside
   * `restored` like the two above, and omitted when zero. `symbols` names them
   * (at most {@link MAX_UNLINKED_BOND_SYMBOLS}) so the user knows which to
   * re-link; `count` is the full number.
   */
  unlinkedBondSecurities?: { count: number; symbols: string[] };
  /**
   * Investment transactions restored without the bond series they named,
   * because this deployment's catalog does not carry it. The rows *were*
   * written; their lots are read from the transaction date instead of the
   * stored series, and the series can be chosen again on the transaction.
   * Counted beside `restored`, omitted when zero.
   */
  unlinkedBondSeries?: { count: number };
  /**
   * Bond series the backup names that the restore could not obtain from the
   * official source, so the rows that referenced them were restored without a
   * series (`unlinkedBondSeries` counts those rows). A restore fetches every
   * series the file references and this catalog lacks, before its transaction
   * (INV-BOND-008: the person's own restore is the person's action); this lists
   * the ones that did not come back and why, so the person can fetch them later.
   * `count` is the full number; `series` names at most
   * {@link MAX_UNRECOVERED_BOND_SERIES}. Counted beside `restored`, omitted at
   * zero.
   */
  unrecoveredBondSeries?: {
    count: number;
    series: UnrecoveredBondSeries[];
  };
}

/** Why a series a backup references could not be fetched during the restore. */
export type UnrecoveredBondSeriesReason =
  /** The official source does not publish it (a product not sold that month). */
  | "not-published"
  /** The source could not be read right now; fetching it later may work. */
  | "source-unavailable"
  /** No installed adapter fetches this country's series. */
  | "no-adapter"
  /** The source answered and the answer was refused (format, bounds, conflict). */
  | "refused"
  /** The per-user limit on explicit series fetches was reached; try again in a minute. */
  | "rate-limited"
  /** Past the restore's cap on fetches; none was attempted. */
  | "not-attempted";

export interface UnrecoveredBondSeries {
  issuerCountryCode: string;
  seriesCode: string;
  reason: UnrecoveredBondSeriesReason;
}

/** The most unrecovered series a restore result names; `count` is the full number. */
export const MAX_UNRECOVERED_BOND_SERIES = 50;

/**
 * The most distinct series one restore asks the official source for. A person's
 * own backup references a few dozen at most; the cap bounds what a crafted file
 * could make the server fetch. The rest are reported `not-attempted`.
 */
export const MAX_BOND_SERIES_FETCHES_PER_RESTORE = 200;

/**
 * The identity of a bond series a backup's rows reference, and nothing else:
 * never terms, rates or dates. Terms enter the catalog only from the official
 * source or an administrator (INV-BOND-006), so the file can say which series
 * the person held and never what it pays.
 */
export interface BackupBondSeriesIdentity {
  bondInstrumentId: string;
  issuerCountryCode: string;
  issuerCode: string;
  programCode: string;
  seriesCode: string;
}

/**
 * The backup's catalog-identity member, `bondCatalog`: a document member beside
 * `completeness`, not a table (every walker over the document skips a
 * non-array value). Absent from a backup written before it existed, which
 * restores exactly as it did.
 */
export interface BackupBondCatalog {
  series: BackupBondSeriesIdentity[];
}

/**
 * Which schema produced an artifact: the newest migration its database had
 * applied when it was exported, or `null` when that could not be read (the
 * ledger was absent). A document member beside `completeness`, not a table, and
 * optional: an artifact written before it existed simply lacks it, and a
 * restore treats absent and `null` alike as "not known" -- never as "old" and
 * never as "current" (`restore-legacy-normalizations.ts`).
 */
export interface BackupProducedBy {
  schemaMigration: string | null;
}

/**
 * The producing migration an artifact declares, or `null` when it declares
 * none. The document is untrusted: anything that is not a migration filename
 * `compareMigrationFilenames` can order is treated as absent rather than
 * half-read, because that comparison throws on a name it cannot parse.
 */
export function parseProducedBySchemaMigration(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const name = (value as { schemaMigration?: unknown }).schemaMigration;
  if (typeof name !== "string") return null;
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(name)) return null;
  return parseMigrationPrefix(name) === null ? null : name;
}

const IDENTITY_CODE = /^[A-Za-z0-9._-]{1,40}$/;
const COUNTRY_CODE = /^[A-Za-z]{2}$/;

/**
 * The series identities a file carries, read defensively: the document is
 * untrusted, so an entry that is not exactly five well-formed strings is
 * dropped (its rows then restore as a file without the member does), and the
 * country and the codes are normalised to the upper case the catalog keys on.
 * The ids are not trusted either way: the restore keys on the identity.
 */
export function parseBondCatalogIdentity(
  value: unknown,
): BackupBondSeriesIdentity[] {
  if (typeof value !== "object" || value === null) return [];
  const series = (value as { series?: unknown }).series;
  if (!Array.isArray(series)) return [];
  const identities: BackupBondSeriesIdentity[] = [];
  for (const entry of series) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const { bondInstrumentId, issuerCountryCode, issuerCode } = raw;
    const { programCode, seriesCode } = raw;
    if (
      typeof bondInstrumentId !== "string" ||
      typeof issuerCountryCode !== "string" ||
      typeof issuerCode !== "string" ||
      typeof programCode !== "string" ||
      typeof seriesCode !== "string" ||
      !COUNTRY_CODE.test(issuerCountryCode) ||
      !IDENTITY_CODE.test(issuerCode) ||
      !IDENTITY_CODE.test(programCode) ||
      !IDENTITY_CODE.test(seriesCode)
    ) {
      continue;
    }
    identities.push({
      bondInstrumentId,
      issuerCountryCode: issuerCountryCode.toUpperCase(),
      issuerCode,
      programCode,
      seriesCode: seriesCode.toUpperCase(),
    });
  }
  return identities;
}

/** The most symbols a restore result names for its unlinked bond securities. */
export const MAX_UNLINKED_BOND_SYMBOLS = 50;

/** A row whose catalog reference a restore dropped. */
export interface SeveredRow {
  id: string;
  symbol: string | null;
}

/** What `severUnavailableCatalogLinks` dropped, per `table.column`. */
export interface SeveredCatalogLinks {
  counts: Record<string, number>;
  severed: Record<string, SeveredRow[]>;
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
  /**
   * The identity of every bond series the user's rows reference, so a restore
   * onto a deployment whose catalog lacks one can fetch it from the official
   * source (see `BackupBondCatalog`). Absent from artifacts written before the
   * member existed. Not a table, and not a version bump: `validateBackupFormat`
   * compares the version for equality, so a new member is added the way
   * `completeness` was.
   */
  bondCatalog?: BackupBondCatalog;
  /**
   * The newest migration the exporting database had applied (see
   * `BackupProducedBy`). Absent from artifacts written before the member
   * existed. Not a table, and not a version bump: an optional member, like
   * `bondCatalog`.
   */
  producedBy?: BackupProducedBy;
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
  warranties: Record<string, unknown>[];
  warranty_claims: Record<string, unknown>[];
  /** Added by accrual support; absent in older backup artifacts. */
  accrual_system_accounts?: Record<string, unknown>[];
  accrual_schedules?: Record<string, unknown>[];
  accrual_allocations?: Record<string, unknown>[];
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
  payroll_deduction_rules?: Record<string, unknown>[];
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
