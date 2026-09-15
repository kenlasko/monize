import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DataSource,
  EntityTarget,
  In,
  LessThanOrEqual,
  Not,
  ObjectLiteral,
  Repository,
} from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { affectedRowCount } from "../common/db/query-result";
import { Cron } from "@nestjs/schedule";
import { promises as fs, readdirSync, unlinkSync } from "fs";
import { createHash, randomUUID } from "crypto";
import { resolve } from "path";
import {
  cleanStaleTempFiles,
  copyFileAtomic,
  isTempBackupName,
  writeFileAtomic,
} from "./atomic-file";
import {
  assertWithinAllowedRoots,
  BackupPathNotAllowedError,
  BackupPathUnusableError,
  resolveAllowedRoots,
} from "./backup-paths";
import { AutoBackupSettings } from "./entities/auto-backup-settings.entity";
import { BackupService, BackupCompletenessReport } from "./backup.service";
import { BackupEncryptionService } from "./backup-encryption.service";
import { User } from "../users/entities/user.entity";
import { DemoModeService } from "../common/demo-mode.service";
import { isShardableId, shardedSegments } from "../common/shard-path.util";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import { UserMaintenanceService } from "../common/jobs/user-maintenance.service";
import { SystemAlertService } from "../system-alerts/system-alert.service";
import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import {
  UpdateAutoBackupSettingsDto,
  AutoBackupFrequency,
} from "./dto/update-auto-backup-settings.dto";
import {
  BACKUP_FILE_PREFIX,
  BackupTier,
  classifyBackupFileName,
  isEncryptedBackupFileName,
  PARTIAL_TIER_NAME,
} from "./backup-file-names";
import { BackupOffsiteDispatchService } from "./offsite/backup-offsite-dispatch.service";
import { offsiteArtifactFileName } from "./offsite/backup-offsite-keys";
import {
  BackupOffsiteTier,
  BackupOffsiteUpload,
  BackupOffsiteUploadStatus,
} from "./offsite/entities/backup-offsite-upload.entity";
import { tr } from "../i18n/translate";

/**
 * Role that may see and change automatic backup settings. Everyone else is
 * enrolled on the deployment defaults by `enrollManagedUsers` and never sees
 * the feature -- see the class comment.
 */
const BACKUP_ADMIN_ROLE = "admin";

/**
 * Folder automatic backups are written to when BACKUP_CONTAINER_DIR is unset.
 * Monize runs in a container, so this is a container path: mount a host folder
 * there (see .env.example and the docker-compose files).
 */
export const DEFAULT_BACKUP_CONTAINER_DIR = "/data/backups";

/**
 * Which path produced a backup run, because the admin alerts belong to only
 * one of them.
 *
 * An automatic run has nobody watching: its failure is the whole reason the
 * alerts exist. A **manual** run is somebody pressing "Back up now" and
 * reading the result in the response -- alerting on it filed an admin notice
 * titled "Automatic backup incomplete" about a backup that was not automatic,
 * let a manual partial run take that day's dedupe key and silence the real
 * automatic failure behind it, and made the HTTP request wait on a per-
 * administrator SMTP fan-out after the backup had already succeeded.
 */
type BackupRunOrigin = "automatic" | "manual";

/**
 * Days of the month on which a daily artifact is also promoted to weekly, and
 * the one on which it is promoted to monthly.
 *
 * Exported because they are the suite's calendar as much as the service's. A
 * test that writes a backup and then counts the files in the folder gets a
 * different answer on these five days, so `auto-backup.service.spec.ts` pins
 * its clock to a day that is in neither list and asserts that fact against
 * these constants. Widening either one without exporting it would silently
 * make ten assertions depend on the date the suite happened to run.
 */
export const WEEKLY_DAYS = [7, 14, 21, 28];

/** The day of the month a daily artifact is also promoted to monthly. */
export const MONTHLY_DAY = 1;

/**
 * How many of this user's off-site ledger rows one stored-backups listing reads,
 * newest first, to attach each artifact's copy status.
 *
 * Generous by design and never a correctness bound: only a published `daily`
 * artifact is dispatched off-machine (`dispatchOffsiteCopy`), the currently
 * stored dailies are the newest recovery points, and their ledger rows are
 * therefore the newest rows -- so the artifacts a listing can show a status for
 * always sit at the top of this window, well inside it for any realistic
 * retention. The cap only keeps an append-only table's whole history out of one
 * read.
 */
const OFFSITE_STATUS_SCAN_LIMIT = 500;

/**
 * A per-user backup directory name: the user's UUID. Used to keep those
 * directories out of the folder picker -- listing them would turn it into user
 * enumeration, and offering one as a destination would nest a second level
 * inside it.
 */
const USER_DIRECTORY_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FREQUENCY_HOURS: Record<AutoBackupFrequency, number> = {
  every6hours: 6,
  every12hours: 12,
  daily: 24,
  weekly: 168,
};

/**
 * One stored automatic backup, as its owner sees it on the Settings page.
 *
 * `modifiedAt` is the file's mtime rather than the date in its name: the name
 * says which recovery point the artifact is (and which retention tier it is
 * kept under), the mtime says when these bytes were written, and a promoted
 * weekly or monthly copy has the two disagree. What a reader is choosing
 * between here is files, so the file's own timestamp is the honest column.
 */
export interface StoredBackup {
  filename: string;
  /** Last modification time of the file on the server, ISO-8601. */
  modifiedAt: string;
  /** Size in bytes. */
  size: number;
  /** True for an encrypted Monize envelope, which needs its password to restore. */
  encrypted: boolean;
  /**
   * The newest off-machine copy status per destination for this artifact, as an
   * icon on its row. Present only when at least one off-site ledger row names
   * the artifact: a weekly or monthly promotion, a partial, or a file that was
   * never dispatched has no rows and no `offsite`
   * (`docs/specs/backup-off-machine.md`).
   */
  offsite?: {
    s3?: BackupOffsiteUploadStatus;
    email?: BackupOffsiteUploadStatus;
  };
}

/**
 * What the owner of a backup folder is told about it.
 *
 * `enabled` is this user's own schedule, which is what decides whether the
 * Settings screen offers the section at all: a deployment that has not armed
 * automatic backups has nothing to say there. It travels with the listing
 * rather than on the settings endpoint because that one is admin-only, and the
 * people who most need this answer are exactly the ones who cannot read it.
 */
export interface StoredBackupsReport {
  enabled: boolean;
  backups: StoredBackup[];
}

/**
 * What one written artifact is, to anything downstream of the write.
 *
 * `digest` is the **egress digest** (`docs/specs/backup-off-machine.md` section
 * 3): the SHA-256 of the exact bytes handed to `writeFileAtomic`, computed once
 * over the buffer that was written rather than re-read from the file, so the
 * value is the identity of the artifact this run produced and not of whatever
 * happens to sit under that name later. It is the checksum an off-machine copy
 * declares (INV-BACKUP-005), the disambiguator in its object key, and the
 * durable identity its state row carries -- one digest, computed once.
 *
 * `sizeBytes` travels with it because the two are one claim about the same
 * bytes: a size that disagrees with the file on disk means the digest describes
 * something the reader is not holding.
 */
interface WrittenArtifact {
  filename: string;
  report: BackupCompletenessReport;
  /** SHA-256 of the written bytes, lowercase hex. */
  digest: string;
  /** Length of the written bytes. */
  sizeBytes: number;
}

interface BackupFile {
  name: string;
  /** Directory the file was found in -- the user's folder, or the legacy flat base. */
  dir: string;
  /** True for a file written by a version that wrote flat into the base folder. */
  legacy: boolean;
  date: Date;
  tier: BackupTier;
}

/**
 * Automatic backups: scheduling, retention, and where the files land.
 *
 * **Layout.** Each user's backups live in their own folder under the configured
 * base, fanned out by user id exactly the way attachment bytes are:
 * `<BACKUP_CONTAINER_DIR>/<ab>/<cd>/<userId>/monize-backup-daily-<date>.json.gz`
 * (see `common/shard-path.util.ts`). The filenames carry only a tier and a
 * date, so a flat shared folder gave every user the same name for the same day
 * -- whoever ran last overwrote the others, and one user's retention pass
 * deleted another's files. The per-user folder is what makes a backup belong to
 * somebody.
 *
 * **Who configures it.** Only an administrator sees the settings (the endpoints
 * live on `AutoBackupController`, behind `@Roles("admin")`). Every other user is
 * enrolled automatically on the deployment defaults by `enrollManagedUsers`, so
 * their data is protected without them having to ask -- and without them being
 * able to point backups at a folder the operator did not mount.
 */
@Injectable()
export class AutoBackupService {
  private readonly logger = new Logger(AutoBackupService.name);

  /** Deployment-wide backup folder (BACKUP_CONTAINER_DIR), used whenever a user has not
   *  chosen one of their own. */
  private readonly defaultFolderPath: string;

  /**
   * Roots a backup may be written under. Everything the user can influence is
   * checked against these, canonically -- see backup-paths.ts for why lexical
   * checks were not enough and why the destination is no longer the user's to
   * choose freely.
   */
  private readonly allowedRoots: string[];

  constructor(
    private readonly dataSource: DataSource,
    private readonly backupService: BackupService,
    private readonly backupEncryption: BackupEncryptionService,
    private readonly demoMode: DemoModeService,
    private readonly maintenance: UserMaintenanceService,
    private readonly systemAlerts: SystemAlertService,
    // The off-machine copy of a completed artifact. Dispatched on the tail of a
    // run, after the local outcome is durable and outside the export
    // transaction (INV-BACKUP-003); it never throws, so it cannot turn a written
    // backup into a failed one.
    private readonly offsiteDispatch: BackupOffsiteDispatchService,
    config: ConfigService,
  ) {
    this.defaultFolderPath = this.resolveConfiguredFolderPath(
      config.get<string>("BACKUP_CONTAINER_DIR"),
    );
    this.allowedRoots = resolveAllowedRoots(
      config.get<string>("BACKUP_ALLOWED_ROOTS"),
      this.defaultFolderPath,
    );
  }

  /**
   * The directory this user's backups go in: a server-computed subdirectory of
   * the chosen (and permitted) root.
   *
   * Every user keeping the default used to share one folder with one set of
   * date-based filenames, so a second user's job overwrote the first's artifact
   * and then applied its own retention counts to whatever was left. Splitting by
   * user is what makes naming, promotion, listing and retention a per-tenant
   * question again.
   */
  private async resolveUserFolder(
    userId: string,
    folderPath: string | null | undefined,
  ): Promise<string> {
    const root = await this.assertAllowedRoot(
      this.resolveFolderPath(folderPath),
    );
    // The root itself must exist and be writable (the deployment default is
    // created on first use; anything else has to be mounted deliberately, so a
    // typo surfaces as an error rather than as a new empty directory).
    await this.assertFolderWritable(root);

    // The per-user directory, by contrast, is server-computed and already
    // inside a permitted root, so creating it needs no further decision. It is
    // sharded the same way attachment bytes are (`<root>/<ab>/<cd>/<userId>`),
    // per the repository-wide rule in `AGENTS.md`.
    //
    // Canonicalise the FINAL path before creating anything, not only the root:
    // the sharded segments are appended lexically after the root check, so a
    // pre-existing symlink at `<root>/<ab>`, `<root>/<ab>/<cd>` or the user
    // directory itself would otherwise redirect every write outside the approved
    // roots while the base still looked clean (F3RB-002). Checking before the
    // `mkdir` matters too: creating first and rejecting afterwards still left a
    // directory inside the symlink's target.
    const folder = await this.assertAllowedRoot(
      this.userFolderPath(root, userId),
    );
    await this.assertFolderWritable(folder, { createIfMissing: true });
    return folder;
  }

  /**
   * The directory this user's backups are in, for a caller that only reads.
   *
   * `resolveUserFolder` is the write path: it creates the per-user directory
   * and probes the root for writability, so a deployment whose storage has gone
   * read-only refuses there. That is right for a backup about to be written and
   * wrong for reading the backups already on disk -- which is exactly the
   * moment somebody needs to find them. This runs the same containment checks
   * (canonical, inside a permitted root, server-computed per-user segment) and
   * creates nothing.
   */
  private async resolveUserFolderForRead(
    userId: string,
    folderPath: string | null | undefined,
  ): Promise<string> {
    const root = await this.assertAllowedRoot(
      this.resolveFolderPath(folderPath),
    );
    return this.assertAllowedRoot(this.userFolderPath(root, userId));
  }

  /**
   * The folder one user's stored artifacts are read back from, for a caller
   * outside this class -- the off-site retry sweep, which holds a durable row
   * describing a copy and has to find the artifact again hours later.
   *
   * It resolves from the user's *current* settings rather than from anything
   * remembered, because an operator may have moved the backup root since the
   * artifact was written, and it runs the same containment checks every other
   * read does (`resolveUserFolderForRead`): a public entry point that skipped
   * them would be the one hole in a fence this class otherwise keeps whole.
   */
  async resolveStoredBackupFolder(userId: string): Promise<string> {
    const settings = await this.scoped(AutoBackupSettings, (repo) =>
      repo.findOne({ where: { userId } }),
    );
    return this.resolveUserFolderForRead(userId, settings?.folderPath);
  }

  /**
   * The automatic backups this deployment is holding for one user.
   *
   * Only the caller's own sharded folder is read. The flat base folder a
   * version before per-user folders wrote into is deliberately skipped: those
   * filenames carry no user id, so nothing there can be attributed to anybody,
   * and offering one for download would hand a user another user's ledger.
   * Retention still sweeps them (`enforceRetention`), which is where that
   * shared history ages out.
   *
   * A folder that does not exist yet is an empty list, not an error: a user
   * enrolled on the deployment defaults has one only after their first run.
   */
  async listStoredBackups(userId: string): Promise<StoredBackupsReport> {
    const settings = await this.scoped(AutoBackupSettings, (repo) =>
      repo.findOne({ where: { userId } }),
    );
    const enabled = settings?.enabled === true;
    const folder = await this.resolveUserFolderForRead(
      userId,
      settings?.folderPath,
    );

    let entries: string[];
    try {
      entries = await fs.readdir(folder);
    } catch {
      return { enabled, backups: [] };
    }

    // Each artifact's off-machine copy status, keyed by the local filename its
    // ledger row round-trips to. One scoped read for the whole listing, matched
    // in memory -- there is no per-file query.
    const offsiteByFilename = await this.offsiteStatusByFilename(userId);

    const backups: StoredBackup[] = [];
    for (const name of entries) {
      if (isTempBackupName(name)) continue;
      if (!classifyBackupFileName(name)) continue;
      try {
        const stat = await fs.stat(this.safePath(folder, name));
        if (!stat.isFile()) continue;
        const offsite = offsiteByFilename.get(name);
        backups.push({
          filename: name,
          modifiedAt: stat.mtime.toISOString(),
          size: stat.size,
          encrypted: isEncryptedBackupFileName(name),
          // Only when a ledger row names this artifact; a promotion, a partial
          // or an un-dispatched file simply has none.
          ...(offsite ? { offsite } : {}),
        });
      } catch {
        // Retention can delete a file between the listing and the stat. A row
        // for a file that is already gone is worse than one fewer row: every
        // action offered on it would fail.
        continue;
      }
    }
    // Newest first: the artifact somebody reaches for in a crisis is the last
    // one written.
    backups.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return { enabled, backups };
  }

  /**
   * The newest off-machine copy status per destination, for every artifact of
   * this user's that a ledger row names -- the icon each stored-backup row
   * shows.
   *
   * Read under the caller's own scope like the rest of this listing, newest
   * first, and grouped by the LOCAL filename each row round-trips to through
   * `offsiteArtifactFileName` (the inverse of the key the dispatcher wrote), so
   * the two directions cannot drift and no object key is hand-parsed here. Rows
   * arrive newest first, so the first status seen for a (filename, destination)
   * pair -- for example a same-day re-export that produced a second row -- is
   * the current one. A filename with no row is absent from the map, and its
   * `offsite` stays undefined.
   */
  private async offsiteStatusByFilename(
    userId: string,
  ): Promise<Map<string, NonNullable<StoredBackup["offsite"]>>> {
    const rows = await this.scoped(BackupOffsiteUpload, (repo) =>
      repo.find({
        where: { userId },
        order: { createdAt: "DESC" },
        take: OFFSITE_STATUS_SCAN_LIMIT,
      }),
    );
    const byFilename = new Map<string, NonNullable<StoredBackup["offsite"]>>();
    for (const row of rows) {
      const filename = offsiteArtifactFileName(
        row.destination,
        row.objectKey,
        row.digest,
      );
      const group = byFilename.get(filename) ?? {};
      // Newest first, so the first status seen for a destination wins.
      if (group[row.destination] === undefined) {
        group[row.destination] = row.status;
      }
      byFilename.set(filename, group);
    }
    return byFilename;
  }

  /**
   * Locate one of this user's stored backups so the caller can stream it.
   *
   * Three checks, each of which would be enough on its own and none of which is
   * therefore load-bearing alone. The name is accepted only when
   * `classifyBackupFileName` recognises it -- the patterns admit a fixed
   * prefix, a tier, a date and one of two extensions, and nothing with a
   * separator in it. **The path that is opened is the directory entry's, never
   * the caller's string**: the requested name is compared against this user's
   * own folder listing and the matching entry is what gets joined, so the value
   * reaching the filesystem is one this deployment wrote rather than one a
   * request carried in (the same CWE-22 boundary `validateFolderPath` states
   * for operator-supplied paths, and what lets a SAST tool see it). The join is
   * still containment-checked (`safePath`), because a validated name and an
   * unvalidated join is how a check becomes decorative.
   *
   * An unrecognised name and an absent file answer the same 404 on purpose: the
   * difference between "no such artifact" and "not a name we write" tells a
   * caller nothing they may act on.
   */
  async openStoredBackup(
    userId: string,
    filename: string,
  ): Promise<{ path: string; size: number; filename: string }> {
    if (!classifyBackupFileName(filename)) {
      throw new NotFoundException(
        tr("errors.backup.storedBackupNotFound", "Backup file not found"),
      );
    }
    const settings = await this.scoped(AutoBackupSettings, (repo) =>
      repo.findOne({ where: { userId } }),
    );
    const folder = await this.resolveUserFolderForRead(
      userId,
      settings?.folderPath,
    );

    let entries: string[];
    try {
      entries = await fs.readdir(folder);
    } catch {
      // No folder yet is the same answer as no such artifact: a user enrolled
      // on the deployment defaults has one only after their first run.
      throw new NotFoundException(
        tr("errors.backup.storedBackupNotFound", "Backup file not found"),
      );
    }
    // The requested name is only ever compared here; `entry` is the server's
    // own string from `readdir`, and it is `entry` that is joined and opened.
    const entry = entries.find((name) => name === filename);
    if (entry === undefined) {
      throw new NotFoundException(
        tr("errors.backup.storedBackupNotFound", "Backup file not found"),
      );
    }

    const path = this.safePath(folder, entry);
    try {
      const stat = await fs.stat(path);
      if (!stat.isFile()) throw new Error("not a file");
      return { path, size: stat.size, filename: entry };
    } catch {
      throw new NotFoundException(
        tr("errors.backup.storedBackupNotFound", "Backup file not found"),
      );
    }
  }

  /**
   * One repository call in its own short scoped transaction -- the RLS-era
   * replacement for the injected repositories this class used to hold, with the
   * same autocommit boundary each of those calls had.
   */
  private scoped<E extends ObjectLiteral, T>(
    entity: EntityTarget<E>,
    fn: (repo: Repository<E>) => Promise<T>,
  ): Promise<T> {
    return withScopedDb(this.dataSource, (manager) =>
      fn(manager.getRepository(entity)),
    );
  }

  /**
   * BACKUP_CONTAINER_DIR is operator-supplied, so it goes through the same CWE-22
   * validation as a user-supplied path. An unusable value falls back to the
   * built-in default with a loud log rather than taking the whole app down.
   */
  private resolveConfiguredFolderPath(configured: string | undefined): string {
    const trimmed = configured?.trim();
    if (!trimmed) return DEFAULT_BACKUP_CONTAINER_DIR;
    try {
      return this.validateFolderPath(trimmed);
    } catch (error) {
      this.logger.error(
        `Invalid BACKUP_CONTAINER_DIR "${trimmed}": ${error.message}. Falling back to ${DEFAULT_BACKUP_CONTAINER_DIR}`,
      );
      return DEFAULT_BACKUP_CONTAINER_DIR;
    }
  }

  /**
   * The base folder backups are filed under: the configured choice when there
   * is one, otherwise the deployment-wide default. This is never the folder
   * written to -- see `userFolderPath`.
   */
  private resolveFolderPath(folderPath: string | null | undefined): string {
    const trimmed = folderPath?.trim();
    return trimmed ? trimmed : this.defaultFolderPath;
  }

  /**
   * The folder one user's backup files live in: `<base>/<ab>/<cd>/<userId>`.
   *
   * User ids are server-generated UUIDs, but they are validated before they
   * reach the filesystem all the same, and the resolved path is asserted to be
   * inside the base folder (CWE-22).
   */
  private userFolderPath(basePath: string, userId: string): string {
    if (!isShardableId(userId)) {
      throw new BadRequestException(
        tr(
          "errors.backup.pathTraversal",
          `Path traversal detected: ${userId}`,
          {
            filename: userId,
          },
        ),
      );
    }
    return this.safePath(basePath, shardedSegments(userId).join("/"));
  }

  /**
   * Canonicalise a user-supplied folder and confirm it is inside a permitted
   * root, translating the containment failure into the API's error shape.
   */
  private async assertAllowedRoot(folderPath: string): Promise<string> {
    try {
      return await assertWithinAllowedRoots(
        this.validateFolderPath(folderPath),
        this.allowedRoots,
      );
    } catch (error) {
      if (error instanceof BackupPathNotAllowedError) {
        throw new BadRequestException(
          tr("errors.backup.folderOutsideAllowedRoots", error.message, {
            path: folderPath,
            roots: this.allowedRoots.join(", "),
          }),
        );
      }
      // A path that cannot be a directory is a bad request, not a server fault.
      // These used to escape as a 500 carrying the resolved filesystem path.
      if (error instanceof BackupPathUnusableError) {
        throw new BadRequestException(
          tr(
            "errors.backup.folderUnusable",
            `Folder "${folderPath}" cannot be used as a directory (${error.code}).`,
            { path: folderPath, reason: error.code },
          ),
        );
      }
      throw error;
    }
  }

  /** Settings for a user with no persisted row yet (not saved by this method). */
  private defaultSettingsFor(userId: string): AutoBackupSettings {
    const defaults = new AutoBackupSettings();
    defaults.userId = userId;
    defaults.enabled = false;
    defaults.folderPath = this.defaultFolderPath;
    defaults.frequency = "daily";
    defaults.backupTime = "02:00";
    defaults.timezone = "UTC";
    defaults.retentionDaily = 7;
    defaults.retentionWeekly = 4;
    defaults.retentionMonthly = 6;
    defaults.lastBackupAt = null;
    defaults.lastBackupStatus = null;
    defaults.lastBackupError = null;
    defaults.nextBackupAt = null;
    return defaults;
  }

  /**
   * Attach the read-only `resolvedFolderPath` -- the per-user folder the files
   * actually land in -- so the settings screen can show where to look. Computed
   * on every read rather than stored: the layout is derived from the base
   * folder and the user id, and a persisted copy could disagree with both.
   */
  private withResolvedFolder(settings: AutoBackupSettings): AutoBackupSettings {
    const basePath = this.resolveFolderPath(settings.folderPath);
    let resolvedFolderPath: string | undefined;
    try {
      resolvedFolderPath = this.userFolderPath(basePath, settings.userId);
    } catch {
      // A base path the operator has since made invalid must not break the
      // settings screen; the folder validation on save reports it properly.
      resolvedFolderPath = undefined;
    }
    return Object.assign(new AutoBackupSettings(), settings, {
      folderPath: basePath,
      resolvedFolderPath,
    });
  }

  async getSettings(userId: string): Promise<AutoBackupSettings> {
    const existing = await this.scoped(AutoBackupSettings, (repo) =>
      repo.findOne({
        where: { userId },
      }),
    );
    // Report the folder backups are actually written to, so a stored row that
    // never had one chosen shows the deployment default instead of a blank.
    return this.withResolvedFolder(existing ?? this.defaultSettingsFor(userId));
  }

  /**
   * Whether this deployment can write an automatic backup anywhere.
   *
   * Enabling a schedule already fails when it cannot -- `resolveUserFolder`
   * creates the directory and `assertFolderWritable` probes it, so a read-only
   * root filesystem with no mount is refused rather than stored. But it is
   * refused only *after* the user has configured a frequency, a time and a
   * retention policy and pressed save, and the answer does not depend on
   * anything they chose. A surface that can say "this deployment has no backup
   * storage" up front is telling them something true earlier.
   *
   * Cheap and side-effect-free: it probes the resolved root, creating nothing.
   * The per-user subdirectory is server-computed inside that root, so a writable
   * root is the whole of the question.
   */
  async describeCapability(userId: string): Promise<{
    available: boolean;
    folderPath: string;
    reason?: string;
  }> {
    // Probe the root this admin's schedule would actually write under -- the
    // stored folder when one is set, the deployment default otherwise. Probing
    // only the default reported "no storage" while a configured secondary root
    // from BACKUP_ALLOWED_ROOTS was mounted and writable, and the banner then
    // blocked re-arming a schedule that would have worked (F3RB-003).
    const settings = await this.scoped(AutoBackupSettings, (repo) =>
      repo.findOne({ where: { userId } }),
    );
    const configured = this.resolveFolderPath(settings?.folderPath);
    try {
      // Containment BEFORE the write probe, and through the same predicate the
      // real write uses (F3RB-R1-001). `updateSettings` only validates a stored
      // folder's syntax unless the same call enables the schedule, and a
      // deployment upgraded from before confinement can already hold an
      // arbitrary path -- so a stored root may be outside BACKUP_ALLOWED_ROOTS.
      // Probing it first would create and delete a `.monize-write-test-*` file
      // outside the approved volume and then report a configuration available
      // that `resolveUserFolder` refuses.
      const root = await this.assertAllowedRoot(configured);
      await this.assertFolderWritable(root);
      return { available: true, folderPath: root };
    } catch (error) {
      return {
        available: false,
        folderPath: configured,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async updateSettings(
    userId: string,
    dto: UpdateAutoBackupSettingsDto,
  ): Promise<AutoBackupSettings> {
    let settings = await this.scoped(AutoBackupSettings, (repo) =>
      repo.findOne({
        where: { userId },
      }),
    );

    if (!settings) {
      // Seed the row with the same defaults getSettings reports, so an update
      // that only touches one field still lands on a complete row.
      settings = this.defaultSettingsFor(userId);
    }

    if (dto.folderPath !== undefined) {
      settings.folderPath = this.validateFolderPath(dto.folderPath);
    }
    if (dto.frequency !== undefined) {
      settings.frequency = dto.frequency;
    }
    if (dto.backupTime !== undefined) {
      settings.backupTime = dto.backupTime;
    }
    if (dto.timezone !== undefined) {
      settings.timezone = dto.timezone;
    }
    if (dto.retentionDaily !== undefined) {
      settings.retentionDaily = dto.retentionDaily;
    }
    if (dto.retentionWeekly !== undefined) {
      settings.retentionWeekly = dto.retentionWeekly;
    }
    if (dto.retentionMonthly !== undefined) {
      settings.retentionMonthly = dto.retentionMonthly;
    }

    if (dto.enabled !== undefined) {
      settings.enabled = dto.enabled;
      if (dto.enabled) {
        // Persist the resolved root so the stored row always records where
        // backups actually go, even when the user never picked one. What gets
        // checked for writability is the per-user subdirectory, which is where
        // the file will land.
        settings.folderPath = this.resolveFolderPath(settings.folderPath);
        // Create and check the user's own folder now, so a base folder that is
        // readable but not writable is reported at save time rather than at
        // 02:00 as a failed backup.
        await this.resolveUserFolder(userId, settings.folderPath);
        settings.nextBackupAt = this.calculateNextBackupAt(
          settings.frequency as AutoBackupFrequency,
          settings.backupTime,
          settings.timezone,
          new Date(),
        );
      } else {
        settings.nextBackupAt = null;
      }
    }

    const saved = await this.scoped(AutoBackupSettings, (repo) =>
      repo.save(settings),
    );
    return this.withResolvedFolder(saved);
  }

  async validateFolder(
    folderPath: string,
  ): Promise<{ valid: boolean; error?: string }> {
    try {
      // Containment first: a path outside the permitted roots is not "valid but
      // unwritable", it is not a destination at all, and reporting on its
      // writability would confirm what lives there.
      const safePath = await assertWithinAllowedRoots(
        this.validateFolderPath(folderPath),
        this.allowedRoots,
      );
      await this.assertFolderWritable(safePath);
      return { valid: true };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  /**
   * List subdirectories of a permitted backup root.
   *
   * This endpoint requires authentication and no role, and it used to accept any
   * absolute path -- so any user could walk `/`, `/tmp`, mounted secrets and
   * other tenants' directories, then select what they found as a backup
   * destination. It is now confined to the operator-approved roots, canonically,
   * so a symlink inside a permitted directory cannot lead out of one either.
   */
  async browseFolders(
    folderPath: string,
  ): Promise<{ current: string; directories: string[] }> {
    const safePath = await this.assertAllowedRoot(folderPath);

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(safePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new BadRequestException(
          tr(
            "errors.backup.folderNotExist",
            `Folder does not exist: ${safePath}`,
            { safePath },
          ),
        );
      }
      throw new BadRequestException(
        tr(
          "errors.backup.folderAccessError",
          `Cannot access folder: ${safePath}`,
          { safePath },
        ),
      );
    }

    if (!stat.isDirectory()) {
      throw new BadRequestException(
        tr(
          "errors.backup.pathNotDirectory",
          `Path is not a directory: ${safePath}`,
          { safePath },
        ),
      );
    }

    const entries = await fs.readdir(safePath, { withFileTypes: true });
    const directories = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      // The per-user directories are server-computed and named by user id.
      // Listing them would turn a folder picker into user enumeration, and
      // offering one as a destination would nest a second level inside it.
      .filter(
        (e) =>
          !USER_DIRECTORY_NAME.test(e.name) &&
          // ...and the two-hex-char shard levels above them, for the same
          // reason: offering one as a destination nests a second layout level.
          !/^[0-9a-f]{2}$/i.test(e.name),
      )
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    return { current: safePath, directories };
  }

  async runManualBackup(
    userId: string,
  ): Promise<{ message: string; filename: string }> {
    // The cron defers in this state; a manual run has a user watching, so it says
    // so instead. Writing the file anyway would produce an empty backup and then
    // rotate the last good one out to keep the retention count.
    if (await this.maintenance.isUnderMaintenance(userId)) {
      throw new ConflictException(
        tr(
          "errors.maintenance.inProgress",
          "Another operation is currently replacing this account's data. Wait for it to finish and try again.",
        ),
      );
    }

    // A user who has never opened the auto-backup settings still gets a working
    // manual run: the row is seeded with defaults here and persisted by the
    // save at the end of this method.
    const settings =
      (await this.scoped(AutoBackupSettings, (repo) =>
        repo.findOne({ where: { userId } }),
      )) ?? this.defaultSettingsFor(userId);
    settings.folderPath = this.resolveFolderPath(settings.folderPath);

    const userFolder = await this.resolveUserFolder(
      userId,
      settings.folderPath,
    );
    const timezone = settings.timezone || "UTC";
    const artifact = await this.exportToFile(userId, userFolder, timezone);
    const { filename, report } = artifact;
    // A partial artifact is published under its own `partial-<date>` name and
    // its own retention tier, so it cannot replace this day's complete artifact
    // and no later retention pass counts it as one (F3RB-001, issue #1069). It
    // is never promoted, and the only deletion its run may make is of older
    // partial artifacts.
    await this.applyBackupOutcome(
      settings,
      userFolder,
      filename,
      report,
      timezone,
      "manual",
    );

    settings.lastBackupAt = new Date();
    if (settings.enabled) {
      settings.nextBackupAt = this.calculateNextBackupAt(
        settings.frequency as AutoBackupFrequency,
        settings.backupTime,
        settings.timezone,
        new Date(),
      );
    }
    await this.scoped(AutoBackupSettings, (repo) => repo.save(settings));

    // After the local artifact exists and this run's own bookkeeping is durable,
    // and outside every transaction above (INV-BACKUP-003).
    await this.dispatchOffsiteCopy(userId, userFolder, artifact, "manual");

    return {
      message: report.complete
        ? "Backup completed successfully"
        : "Backup written, but some attachments could not be included; it was saved as a partial artifact, was not promoted, and did not replace or age out any complete backup",
      filename,
    };
  }

  /**
   * Records the backup's outcome and runs promotion + retention only when the
   * artifact is complete.
   *
   * `success` promotes weekly/monthly copies and enforces retention across every
   * tier. `partial` promotes nothing and never deletes a complete artifact: the
   * incomplete artifact stays on disk under its own `partial-` name so the
   * ledger is backed up, and the only deletion that run may make is of *older
   * partial artifacts*, which is what keeps a storage outage from filling the
   * volume with them. A later complete backup resumes normal promotion and
   * retention. This is the invariant that a backup shown as successful is a
   * backup that can be restored in full (F3R7-001), and that a partial one can
   * neither replace nor age out a complete copy (F3RB-001, issue #1069).
   */
  private async applyBackupOutcome(
    settings: AutoBackupSettings,
    folder: string,
    filename: string,
    report: BackupCompletenessReport,
    timezone: string,
    origin: BackupRunOrigin,
  ): Promise<void> {
    if (report.complete) {
      const weeklyError = await this.copyToWeeklyIfNeeded(
        folder,
        filename,
        timezone,
      );
      const monthlyError = await this.copyToMonthlyIfNeeded(
        folder,
        filename,
        timezone,
      );
      const retentionErrors = this.enforceRetention(
        folder,
        settings.folderPath,
        settings,
      );
      settings.lastBackupStatus = "success";
      settings.lastBackupError = null;
      // Promotion and retention failures used to be a `logger.warn` and
      // nothing else -- the artifact is complete, so the status column
      // rightly stays "success", and the alert row is the only durable state
      // these paths have. The daily backup exists; what the admin is told is
      // that the weekly/monthly copy or the cleanup did not happen.
      await this.raiseBackupSideEffectAlerts(
        settings.userId,
        filename,
        origin,
        {
          weeklyError,
          monthlyError,
          retentionErrors,
        },
      );
      return;
    }
    const retentionErrors = this.enforceRetention(
      folder,
      settings.folderPath,
      settings,
      [PARTIAL_TIER_NAME],
    );
    settings.lastBackupStatus = "partial";
    settings.lastBackupError =
      `${report.missingAttachments} attachment(s) could not be included and ` +
      `${report.inconsistentAttachments} did not match their metadata, of ` +
      `${report.expectedAttachments} total. This artifact was written as ` +
      `${filename} and not promoted, and no complete backup was deleted for ` +
      `it, so complete backups are preserved.`;
    this.logger.warn(
      `Auto-backup for user ${settings.userId} is partial: ${settings.lastBackupError}`,
    );
    await this.raiseBackupPartialAlert(settings.userId, "attachments", origin, {
      message: `The backup was written, but ${settings.lastBackupError}`,
      missingAttachments: report.missingAttachments,
      inconsistentAttachments: report.inconsistentAttachments,
      expectedAttachments: report.expectedAttachments,
      filename,
    });
    await this.raiseBackupSideEffectAlerts(settings.userId, filename, origin, {
      weeklyError: null,
      monthlyError: null,
      retentionErrors,
    });
  }

  /**
   * Raise BACKUP_PARTIAL admin alerts for a run whose artifact is fine but
   * whose promotion copies or retention cleanup failed -- the two paths that
   * otherwise leave no durable state at all (`lastBackupStatus` stays
   * "success", correctly: the daily artifact is complete).
   */
  private async raiseBackupSideEffectAlerts(
    userId: string,
    filename: string,
    origin: BackupRunOrigin,
    outcome: {
      weeklyError: string | null;
      monthlyError: string | null;
      retentionErrors: string[];
    },
  ): Promise<void> {
    const promotionErrors = [outcome.weeklyError, outcome.monthlyError].filter(
      (e): e is string => e !== null,
    );
    if (promotionErrors.length > 0) {
      await this.raiseBackupPartialAlert(userId, "promotion", origin, {
        message:
          `The daily backup ${filename} succeeded, but its weekly/monthly ` +
          `copy could not be written: ${promotionErrors.join("; ")}`,
        error: promotionErrors.join("; "),
        filename,
      });
    }
    if (outcome.retentionErrors.length > 0) {
      await this.raiseBackupPartialAlert(userId, "retention", origin, {
        message:
          `The backup succeeded, but ${outcome.retentionErrors.length} old ` +
          `backup file(s) could not be cleaned up: ` +
          outcome.retentionErrors.join("; "),
        error: outcome.retentionErrors.join("; "),
        filename,
      });
    }
  }

  /**
   * One BACKUP_PARTIAL alert to the administrators, deduped per affected
   * user, reason and day. `data` carries the facts for client-side
   * localization; the stored message is the English fallback.
   */
  private async raiseBackupPartialAlert(
    userId: string,
    reason: "attachments" | "promotion" | "retention",
    origin: BackupRunOrigin,
    detail: { message: string } & Record<string, unknown>,
  ): Promise<void> {
    if (origin !== "automatic") return;
    const { message, ...data } = detail;
    const email = await this.userEmailQuietly(userId);
    await this.systemAlerts.raiseAdminAlert({
      type: NotificationType.BACKUP_PARTIAL,
      severity: NotificationSeverity.WARNING,
      title: "Automatic backup incomplete",
      message: `Automatic backup for ${email ?? `user ${userId}`}: ${message}`,
      data: {
        system: true,
        affectedUserId: userId,
        affectedUserEmail: email,
        reason,
        ...data,
      },
      dedupeKey: `BACKUP_PARTIAL:${userId}:${reason}:${utcDateString()}`,
      // One row per affected user (an administrator has to know WHICH users
      // lost a backup), but one email per reason per day: the usual cause is
      // one broken volume, and a sixty-user install would otherwise send an
      // administrator sixty identical messages about it.
      emailDedupeKey: `BACKUP_PARTIAL:${reason}:${utcDateString()}`,
    });
  }

  /** One BACKUP_FAILED alert to the administrators, deduped per user and day. */
  private async raiseBackupFailedAlert(
    userId: string,
    cause: unknown,
    at: Date,
  ): Promise<void> {
    const error = String((cause as Error)?.message ?? cause).slice(0, 300);
    const email = await this.userEmailQuietly(userId);
    await this.systemAlerts.raiseAdminAlert({
      type: NotificationType.BACKUP_FAILED,
      severity: NotificationSeverity.CRITICAL,
      title: "Automatic backup failed",
      message:
        `The automatic backup for ${email ?? `user ${userId}`} failed: ` +
        `${error}. No new backup was written this window; the next attempt ` +
        "is the next scheduled one.",
      data: {
        system: true,
        affectedUserId: userId,
        affectedUserEmail: email,
        error,
        date: utcDateString(at),
      },
      dedupeKey: `BACKUP_FAILED:${userId}:${utcDateString(at)}`,
      // As above: the rows stay per user, the mail is said once a day.
      emailDedupeKey: `BACKUP_FAILED:${utcDateString(at)}`,
    });
  }

  /**
   * The affected user's email, for the admin alert's copy -- an address means
   * more to an operator than a UUID. Best-effort: the alert goes out either
   * way, and this lookup runs from failure paths where the database may be
   * the problem.
   */
  private async userEmailQuietly(userId: string): Promise<string | null> {
    try {
      const user = await withSystemContext(() =>
        this.scoped(User, (repo) =>
          repo.findOne({ where: { id: userId }, select: ["id", "email"] }),
        ),
      );
      return user?.email && user.email !== "" ? user.email : null;
    } catch {
      return null;
    }
  }

  /**
   * Claim one due backup by advancing its own schedule.
   *
   * Every replica fires this cron, so without a claim a two-replica cluster
   * writes every user's backup twice -- and worse, one replica's
   * `enforceRetention` can delete the file the other is still writing.
   *
   * The claim is the schedule advance itself: `next_backup_at` is a column this
   * job owns, so `UPDATE ... WHERE next_backup_at <= now RETURNING` re-evaluates
   * the predicate after taking the row lock and exactly one replica gets a row
   * back. No claim table and no lease to expire -- the row already carries the
   * fact. Advancing *before* the export also means a crash mid-backup skips this
   * window rather than retrying forever, which is the behaviour the failure path
   * already had.
   *
   * `RETURNING user_id` because that column is this table's primary key -- there
   * is no `id`. `RETURNING id` parses fine in a mocked-`query` unit test and
   * fails at runtime with `column "id" does not exist` (42703), which took the
   * claim, and therefore every automatic backup, down for every user. The
   * columns any raw SQL in `src/` names are now checked against
   * `database/schema.sql` by `backend/src/common/db/raw-sql-columns.spec.ts`.
   */
  private async claimDueBackup(
    settings: AutoBackupSettings,
    now: Date,
    nextBackupAt: Date,
  ): Promise<boolean> {
    const rows = await withUserContext(settings.userId, () =>
      withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `UPDATE auto_backup_settings
              SET next_backup_at = $1
            WHERE user_id = $2
              AND enabled = true
              AND next_backup_at IS NOT NULL
              AND next_backup_at <= $3
            RETURNING user_id`,
          [nextBackupAt, settings.userId, now],
        ),
      ),
    );
    return affectedRowCount(rows) > 0;
  }

  /**
   * Write only the columns describing how the run went.
   *
   * `repo.save(settings)` would write back every column of the snapshot this
   * sweep read at the top, so a user who changed their folder, frequency or
   * retention through the UI while the sweep was running would find those edits
   * reverted. The outcome columns are the only ones this job is entitled to
   * write; `next_backup_at` was already set by the claim.
   */
  private async recordBackupOutcome(
    userId: string,
    at: Date,
    status: "success" | "partial" | "failed",
    error: string | null,
  ): Promise<void> {
    await withUserContext(userId, () =>
      this.scoped(AutoBackupSettings, (repo) =>
        repo
          .createQueryBuilder()
          .update(AutoBackupSettings)
          .set({
            lastBackupAt: at,
            lastBackupStatus: status,
            lastBackupError: error,
          })
          .where("user_id = :userId", { userId })
          .execute(),
      ),
    );
  }

  @Cron("0 * * * *")
  async handleAutoBackupCron(): Promise<void> {
    const now = new Date();
    await this.enrollManagedUsers(now);
    // RLS (task C2): cross-user fan-out over every user's due backup settings.
    const dueSettings = await withSystemContext(() =>
      this.scoped(AutoBackupSettings, (repo) =>
        repo.find({
          where: {
            enabled: true,
            nextBackupAt: LessThanOrEqual(now),
          },
        }),
      ),
    );

    if (dueSettings.length === 0) return;

    this.logger.log(`Auto-backup cron: ${dueSettings.length} backup(s) due`);

    for (const settings of dueSettings) {
      // Everything about one user, including the steps *before* the claim,
      // happens inside this try. It used to start below the claim, so an error
      // raised while deciding whether to run -- the maintenance pre-check, or
      // the claim's own UPDATE -- escaped the loop and ended the sweep for
      // every user after this one, with nothing recorded as failed either. That
      // is precisely how `RETURNING id` against a table with no `id` column
      // turned one bad statement into "no automatic backups at all". The same
      // rule is already written out in `enrollManagedUsers` below: one user's
      // row failing must not stop the others.
      try {
        await this.runDueBackup(settings, now);
      } catch (error) {
        this.logger.error(
          `Auto-backup failed for user ${settings.userId}: ${error.message}`,
        );
        await this.recordFailureQuietly(settings.userId, now, error);
        // The alert is the notification the failure row never was (the status
        // sat on auto_backup_settings and nobody looked). Backups are an
        // operator setting, so the audience is the administrators.
        // `raiseAdminAlert` never throws -- one user's alert failing must not
        // end the sweep any more than the backup failing may.
        await this.raiseBackupFailedAlert(settings.userId, error, now);
      }
    }
  }

  /**
   * One user's window: decide whether to run it, claim it, export it, record it.
   *
   * Throws rather than swallowing, so `handleAutoBackupCron` -- which owns the
   * "one user must not take out the sweep" rule -- is the only place that
   * decides what a failure means.
   */
  private async runDueBackup(
    settings: AutoBackupSettings,
    now: Date,
  ): Promise<void> {
    const nextBackupAt = this.calculateNextBackupAt(
      settings.frequency as AutoBackupFrequency,
      settings.backupTime,
      settings.timezone,
      now,
    );

    // Do not start a backup of a dataset that is already mid-replacement. A
    // `.mny` import with "start fresh" commits its wipe and then writes rows
    // for minutes, so an hourly backup landing in that window would export the
    // empty dataset, save it as today's file, and enforce retention --
    // rotating the last good backup out to make room for one containing
    // nothing. Skipping without claiming leaves `next_backup_at` in the past,
    // so the next hour retries (audit DR-04-02).
    //
    // This is a pre-check and only a pre-check: `isUnderMaintenance` is
    // documented as a hint, and maintenance can still begin between this read
    // and the export snapshot below. It narrows the window rather than closing
    // it; closing it needs backup admission and maintenance acquisition to
    // share one lease, which is the outstanding HIGH item in the PR
    // description.
    //
    // Runs under the user's context like the claim and the outcome write: it
    // reaches `import_jobs` and `job_claims` through `withScopedDb`, which
    // throws without an ambient identity. The `withSystemContext` fan-out
    // above covers only the cross-user settings read.
    const underMaintenance = await withUserContext(settings.userId, () =>
      this.maintenance.isUnderMaintenance(settings.userId),
    );
    if (underMaintenance) {
      this.logger.log(
        `Auto-backup deferred for user ${settings.userId}: their data is being replaced`,
      );
      return;
    }

    const claimed = await this.claimDueBackup(settings, now, nextBackupAt);
    if (!claimed) {
      // Either another replica took this window, or the user disabled or
      // rescheduled the backup after this sweep read its snapshot. Both mean
      // "not ours to run".
      return;
    }

    settings.folderPath = this.resolveFolderPath(settings.folderPath);
    const userFolder = await this.resolveUserFolder(
      settings.userId,
      settings.folderPath,
    );
    const timezone = settings.timezone || "UTC";
    // RLS (task C2): the export reads this user's entire dataset, and the
    // settings write below is that user's row -- both under a user context.
    const artifact = await withUserContext(settings.userId, () =>
      this.exportToFile(settings.userId, userFolder, timezone),
    );
    const { filename, report } = artifact;
    // Promotion and retention run only for a complete artifact; a partial is
    // written but never allowed to displace a complete copy (F3R7-001).
    await this.applyBackupOutcome(
      settings,
      userFolder,
      filename,
      report,
      timezone,
      "automatic",
    );

    // applyBackupOutcome set lastBackupStatus/Error to reflect a complete
    // ("success") or incomplete ("partial") artifact; record exactly that,
    // never a hardcoded success, so a partial backup is not persisted as a
    // full one (F3R7-001). The write is the targeted outcome UPDATE, not a
    // whole-row save, so it cannot revert a concurrent settings edit.
    await this.recordBackupOutcome(
      settings.userId,
      now,
      report.complete ? "success" : "partial",
      settings.lastBackupError,
    );

    // Last, and only now: the local copy is written and the run is recorded, so
    // the off-machine copy can neither precede it nor take it down with it
    // (INV-BACKUP-003, and the push-after-commit shape of
    // `docs/external-side-effects.md` section 4a).
    await this.dispatchOffsiteCopy(
      settings.userId,
      userFolder,
      artifact,
      "automatic",
    );

    this.logger.log(
      `Auto-backup ${report.complete ? "completed" : "written (partial)"} for user ${settings.userId}: ${filename}`,
    );
  }

  /**
   * Offer one written artifact to the user's off-machine destinations.
   *
   * Two gates, and both are invariants rather than tidiness. **Only a complete
   * artifact is a candidate** (INV-BACKUP-003): a partial one is published under
   * its own `partial-` tier precisely because it is not this day's recovery
   * point, and copying it off-machine would put a backup that cannot be restored
   * in full where an operator reaches for it in a crisis. **The tier comes out
   * of the filename**, the same source retention and the owner-facing listing
   * read it from, so the durable off-site row cannot disagree with the artifact
   * it names.
   *
   * `dispatchAfterBackup` never throws, and this method catches anyway. The
   * containment has to be a property of *this* class: the cron's per-user catch
   * records a failed window, so a rejection escaping here would turn a backup
   * that is complete and on disk into one recorded as failed -- and the manual
   * path would answer a 500 for a backup it had already written.
   */
  private async dispatchOffsiteCopy(
    userId: string,
    userFolder: string,
    artifact: WrittenArtifact,
    origin: BackupRunOrigin,
  ): Promise<void> {
    if (!artifact.report.complete) return;
    const tier = publishedOffsiteTier(artifact.filename);
    if (!tier) return;
    try {
      await this.offsiteDispatch.dispatchAfterBackup({
        userId,
        folder: userFolder,
        filename: artifact.filename,
        tier,
        digest: artifact.digest,
        sizeBytes: artifact.sizeBytes,
        origin,
      });
    } catch (error) {
      this.logger.error(
        `Off-site dispatch of ${artifact.filename} for user ${userId} could ` +
          `not be started: ${error instanceof Error ? error.message : String(error)}. ` +
          "The local backup is unaffected.",
      );
    }
  }

  /**
   * Record a failed window without letting the recording become the failure.
   *
   * The outcome write is itself a database call, so the errors most likely to
   * bring the export down -- the connection, the pool, a broken statement --
   * are exactly the ones that can also break the write recording them. Throwing
   * here would put the sweep back where it started: one user's failure ending
   * everybody else's backups.
   */
  private async recordFailureQuietly(
    userId: string,
    at: Date,
    cause: unknown,
  ): Promise<void> {
    const message = String((cause as Error)?.message ?? cause).slice(0, 1024);
    try {
      await this.recordBackupOutcome(userId, at, "failed", message);
    } catch (error) {
      this.logger.error(
        `Auto-backup could not record the failure for user ${userId}: ${error.message}`,
      );
    }
  }

  /**
   * Put every non-admin user on the deployment's default backup schedule.
   *
   * Automatic backups are not a per-user preference: only an administrator can
   * see or change the settings, so anybody else would silently have no backups
   * at all unless something enrolled them. This runs at the top of the hourly
   * cron rather than at registration so that users who already existed -- and
   * anyone demoted out of the admin role later -- are covered too, with no
   * migration to write and nothing to re-run by hand.
   *
   * The row is fully managed: it is written back to the defaults whenever it
   * has drifted, which is also how a row left over from when the feature was
   * user-configurable gets brought into line. `lastBackup*` and `nextBackupAt`
   * are the schedule's own bookkeeping and are never reset, so an enrolled user
   * is not re-backed-up every hour.
   */
  private async enrollManagedUsers(now: Date): Promise<void> {
    // Demo data is regenerated daily and every visitor is a separate user, so
    // enrolling them would write throwaway exports for accounts that are about
    // to be deleted.
    if (this.demoMode.isDemo) return;

    // RLS: reading every user and writing rows that are not the caller's is
    // cross-user work by definition.
    const managedUserIds = await withSystemContext(async () => {
      const users = await this.scoped(User, (repo) =>
        repo.find({
          select: { id: true },
          where: { role: Not(BACKUP_ADMIN_ROLE), isActive: true },
        }),
      );
      return users.map((u) => u.id);
    });
    if (managedUserIds.length === 0) return;

    const existing = await withSystemContext(() =>
      this.scoped(AutoBackupSettings, (repo) =>
        repo.find({ where: { userId: In(managedUserIds) } }),
      ),
    );
    const byUserId = new Map(existing.map((s) => [s.userId, s]));

    for (const userId of managedUserIds) {
      const current = byUserId.get(userId);
      const managed = this.applyManagedDefaults(current, userId, now);
      if (!managed) continue;
      try {
        await withUserContext(userId, () =>
          this.scoped(AutoBackupSettings, (repo) => repo.save(managed)),
        );
        this.logger.log(
          `Enrolled user ${userId} in automatic backups on the deployment defaults`,
        );
      } catch (error) {
        // One user's row failing must not stop the others from being enrolled,
        // nor the backups that are already due from running.
        this.logger.error(
          `Failed to enroll user ${userId} in automatic backups: ${error.message}`,
        );
      }
    }
  }

  /**
   * The managed form of `current` when it differs from the deployment defaults,
   * or `null` when it is already correct -- so a settled deployment writes
   * nothing on the hourly tick.
   */
  private applyManagedDefaults(
    current: AutoBackupSettings | undefined,
    userId: string,
    now: Date,
  ): AutoBackupSettings | null {
    const defaults = this.defaultSettingsFor(userId);
    const managed = Object.assign(
      new AutoBackupSettings(),
      current ?? defaults,
      {
        enabled: true,
        folderPath: defaults.folderPath,
        frequency: defaults.frequency,
        backupTime: defaults.backupTime,
        timezone: defaults.timezone,
        retentionDaily: defaults.retentionDaily,
        retentionWeekly: defaults.retentionWeekly,
        retentionMonthly: defaults.retentionMonthly,
      },
    );
    // A managed row with no next run would never be picked up by the cron.
    if (!managed.nextBackupAt) {
      managed.nextBackupAt = this.calculateNextBackupAt(
        managed.frequency as AutoBackupFrequency,
        managed.backupTime,
        managed.timezone,
        now,
      );
    }
    if (!current) return managed;
    const changed = (
      [
        "enabled",
        "folderPath",
        "frequency",
        "backupTime",
        "timezone",
        "retentionDaily",
        "retentionWeekly",
        "retentionMonthly",
        "nextBackupAt",
      ] as const
    ).some((key) => current[key] !== managed[key]);
    return changed ? managed : null;
  }

  /**
   * Write one export into `userFolder` and describe what was written: the
   * filename, the completeness report the name was chosen from, and the egress
   * digest and size of the exact bytes (`WrittenArtifact`).
   */
  private async exportToFile(
    userId: string,
    userFolder: string,
    timezone: string,
  ): Promise<WrittenArtifact> {
    const user = await this.scoped(User, (repo) =>
      repo.findOne({ where: { id: userId } }),
    );
    if (!user) {
      throw new BadRequestException(
        tr("errors.backup.userNotFound", `User ${userId} not found`, {
          userId,
        }),
      );
    }

    // Backups are encrypted with the user's own password whenever the server
    // holds a usable copy of it -- there is nothing for them to switch on.
    const resolution = await this.backupEncryption.resolveBackupPassword(user);
    if (resolution.status === "unrecoverable") {
      // A password is stored but cannot be decrypted (typically
      // ENCRYPTION_KEY was rotated). Their previous backups are encrypted,
      // so quietly writing this one in plaintext would be a downgrade nobody
      // sees. Fail loud instead.
      throw new BadRequestException(
        tr(
          "errors.backup.encryptedPasswordDecryptFailed",
          "Encrypted backups are enabled but the stored password could not be decrypted. Re-enable encryption in Security settings.",
        ),
      );
    }
    if (resolution.status === "none") {
      // Plaintext is a legitimate outcome -- an OIDC account that set no backup
      // password, or a local account whose password has not been captured yet --
      // but it is never a silent one. Issue #1269 was a deployment writing
      // plaintext for months while every surface said backups were encrypted by
      // default, and a line per backup is what makes that answerable from the
      // logs instead of from the file extension.
      this.logger.warn(
        `Backup for user ${userId} is being written unencrypted: no backup password is stored` +
          (user.authProvider === "local"
            ? " (it is captured when they next sign in, or from Settings -> Backup & Restore)"
            : " (set one in Settings -> Backup & Restore)"),
      );
    }
    const encryptionPassword =
      resolution.status === "password" ? resolution.password : undefined;

    const dateStr = this.getLocalDateString(new Date(), timezone);
    const ext = encryptionPassword ? "mzbe" : "json.gz";

    // Leftovers from an interrupted write, cleared before this one rather than
    // by retention: a partial file is not a backup, so counting it towards
    // "keep 7 daily" would quietly shorten the retention window.
    const removed = await cleanStaleTempFiles(userFolder, Date.now());
    if (removed > 0) {
      this.logger.warn(
        `Removed ${removed} stale partial backup file(s) in ${userFolder}`,
      );
    }

    const { buffer, report } = await this.backupService.exportToBuffer(
      userId,
      encryptionPassword,
    );
    // The name is chosen AFTER the export, from what the export found. Choosing
    // it first published an incomplete artifact over that day's complete one and
    // only then noticed -- and `writeFileAtomic` replaces the final name by
    // design, so there was nothing left to preserve by the time
    // `applyBackupOutcome` recorded `partial` (F3RB-001, issue #1069).
    const tier = report.complete ? "daily" : PARTIAL_TIER_NAME;
    const filename = `${BACKUP_FILE_PREFIX}${tier}-${dateStr}.${ext}`;
    const filepath = this.safePath(userFolder, filename);
    // Temp file, fsync, rename: `fs.writeFile` truncated the final name first,
    // so a kill or an ENOSPC mid-write left a partial artifact with a valid
    // extension that sorted newest and that retention counted.
    await writeFileAtomic(filepath, buffer);

    // Over `buffer`, the bytes `writeFileAtomic` just published, and not over a
    // re-read of `filepath`: a hash of the file answers "what is under this name
    // now", which a concurrent same-day run can already have changed, while the
    // egress digest has to name the artifact this run wrote. `writeFileAtomic`
    // has already refused to publish a file whose length disagrees with the
    // buffer, so the two are the same bytes at the moment of the rename.
    const digest = createHash("sha256").update(buffer).digest("hex");

    this.logger.log(
      `Backup written to ${filepath}${encryptionPassword ? " (encrypted)" : ""} ` +
        `(sha256 ${digest}, ${buffer.length} bytes)`,
    );
    return { filename, report, digest, sizeBytes: buffer.length };
  }

  /** Returns the copy error's message when the promotion failed, else null. */
  private async copyToWeeklyIfNeeded(
    folderPath: string,
    dailyFilename: string,
    timezone: string,
  ): Promise<string | null> {
    const dayOfMonth = this.getLocalDayOfMonth(new Date(), timezone);
    if (!WEEKLY_DAYS.includes(dayOfMonth)) return null;

    const ext = dailyFilename.endsWith(".mzbe") ? "mzbe" : "json.gz";
    const dateStr = this.getLocalDateString(new Date(), timezone);
    const weeklyFilename = `${BACKUP_FILE_PREFIX}weekly-${dateStr}.${ext}`;
    try {
      // Through a temp name for the same reason as the daily write: a copy
      // straight onto the final name truncates last week's artifact first, so an
      // interrupted promotion destroyed a good backup and left a partial one
      // named as though it had replaced it.
      await copyFileAtomic(
        this.safePath(folderPath, dailyFilename),
        this.safePath(folderPath, weeklyFilename),
      );
      this.logger.log(`Copied daily backup to weekly: ${weeklyFilename}`);
    } catch (err) {
      this.logger.warn(`Failed to copy daily to weekly: ${err.message}`);
      return `weekly: ${err.message}`;
    }
    return null;
  }

  /** Returns the copy error's message when the promotion failed, else null. */
  private async copyToMonthlyIfNeeded(
    folderPath: string,
    dailyFilename: string,
    timezone: string,
  ): Promise<string | null> {
    const dayOfMonth = this.getLocalDayOfMonth(new Date(), timezone);
    if (dayOfMonth !== MONTHLY_DAY) return null;

    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "2-digit",
      month: "2-digit",
    });
    const parts = formatter.formatToParts(now);
    const year = parts.find((p) => p.type === "year")!.value;
    const month = parts.find((p) => p.type === "month")!.value;
    const ext = dailyFilename.endsWith(".mzbe") ? "mzbe" : "json.gz";
    const monthlyFilename = `${BACKUP_FILE_PREFIX}monthly-${year}-${month}.${ext}`;

    try {
      await copyFileAtomic(
        this.safePath(folderPath, dailyFilename),
        this.safePath(folderPath, monthlyFilename),
      );
      this.logger.log(`Copied daily backup to monthly: ${monthlyFilename}`);
    } catch (err) {
      this.logger.warn(`Failed to copy daily to monthly: ${err.message}`);
      return `monthly: ${err.message}`;
    }
    return null;
  }

  /** Backup files found directly in `dir`, tagged with where they came from. */
  private collectBackupFiles(dir: string, legacy: boolean): BackupFile[] {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }

    const files: BackupFile[] = [];
    for (const name of entries) {
      // A partial write is not a backup. The temp names cannot be classified
      // anyway (they are dot-prefixed), but skipping them here states the rule
      // where retention is decided rather than leaving it to a regex
      // coincidence.
      if (isTempBackupName(name)) continue;
      // Tier and date come out of the name, never out of the mtime or a
      // settings row -- `backup-file-names.ts` says why, and the owner-facing
      // listing asks it the same way.
      const classified = classifyBackupFileName(name);
      if (classified) {
        files.push({ name, dir, legacy, ...classified });
      }
    }
    return files;
  }

  /**
   * Delete backups past the retention limit of their tier, newest kept.
   *
   * Two directories are swept: the user's own folder, and the flat base folder
   * where a version before per-user folders wrote. Those legacy filenames carry
   * no user id, so they were already shared -- every user's pass has always
   * deleted whatever it found there -- and sweeping them alongside the new
   * layout ages them out as sharded backups accumulate, rather than stranding
   * them under a limit that no longer looks at them. On an equal date the
   * legacy copy is the one deleted, so the file that is definitely this user's
   * is the one kept.
   *
   * `tiers` restricts which tiers may be swept. A partial run passes
   * `["partial"]`: it must bound its own artifacts without being able to delete
   * a complete one, and a tier list is the form of that rule a caller cannot get
   * half right (F3RB-001, issue #1069).
   */
  private enforceRetention(
    userFolder: string,
    basePath: string,
    settings: AutoBackupSettings,
    tiers: readonly BackupTier[] = ["daily", "weekly", "monthly", "partial"],
  ): string[] {
    const files = [
      ...this.collectBackupFiles(userFolder, false),
      ...this.collectBackupFiles(basePath, true),
    ];
    // Returned to the caller so a delete failure can become an admin alert --
    // it has no durable state of its own and the run's status stays "success".
    const failures: string[] = [];

    // Sort each tier newest first and delete beyond retention limit
    const deleteExcess = (tier: BackupTier, limit: number) => {
      if (!tiers.includes(tier)) return;
      const sorted = files
        .filter((f) => f.tier === tier)
        .sort(
          (a, b) =>
            b.date.getTime() - a.date.getTime() ||
            Number(a.legacy) - Number(b.legacy),
        );
      for (let i = limit; i < sorted.length; i++) {
        try {
          unlinkSync(this.safePath(sorted[i].dir, sorted[i].name));
          this.logger.log(`Retention: deleted old backup ${sorted[i].name}`);
        } catch (err) {
          this.logger.warn(
            `Retention: failed to delete ${sorted[i].name}: ${err.message}`,
          );
          failures.push(`${sorted[i].name}: ${err.message}`);
        }
      }
    };

    deleteExcess("daily", settings.retentionDaily);
    deleteExcess("weekly", settings.retentionWeekly);
    deleteExcess("monthly", settings.retentionMonthly);
    // Partial artifacts are kept to the same depth as complete dailies, in their
    // own tier: they arrive on the same cadence, so the daily count is already
    // the user's answer to "how many recovery points of that age do I want", and
    // a separate setting would be a migration and a fourth number in the UI for a
    // question nobody has asked. What matters is that the two counts are
    // *independent* -- a partial can neither take a complete artifact's slot nor
    // accumulate without bound while storage is broken.
    deleteExcess(PARTIAL_TIER_NAME, settings.retentionDaily);
    return failures;
  }

  private getLocalDateString(date: Date, timezone: string): string {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(date);
  }

  private getLocalDayOfMonth(date: Date, timezone: string): number {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      day: "numeric",
    });
    return Number(formatter.format(date));
  }

  private calculateNextBackupAt(
    frequency: AutoBackupFrequency,
    backupTime: string,
    timezone: string,
    fromDate: Date,
  ): Date {
    const [hours] = backupTime.split(":").map(Number);
    const intervalHours = FREQUENCY_HOURS[frequency] ?? 24;

    // Snap minutes to 0 -- the cron fires at minute 0 of each hour,
    // so non-zero minutes would cause the backup to run an hour late.
    const todayInTz = this.localTimeToUtc(fromDate, hours, 0, timezone);

    if (frequency === "daily" || frequency === "weekly") {
      const next = new Date(todayInTz);

      // If the target time is in the past for today, move forward by one interval
      if (next.getTime() <= fromDate.getTime()) {
        next.setTime(next.getTime() + intervalHours * 60 * 60 * 1000);
      }
      return next;
    }

    // Sub-daily frequencies (every6hours, every12hours):
    // Align to the configured time, then add interval increments
    let next = new Date(todayInTz);
    while (next.getTime() <= fromDate.getTime()) {
      next = new Date(next.getTime() + intervalHours * 60 * 60 * 1000);
    }
    return next;
  }

  /**
   * Convert a local time (hours:minutes) in the given timezone to a UTC Date
   * for the same calendar day as `referenceDate`.
   */
  private localTimeToUtc(
    referenceDate: Date,
    hours: number,
    minutes: number,
    timezone: string,
  ): Date {
    // Get the current date parts in the target timezone
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = formatter.formatToParts(referenceDate);
    const year = parts.find((p) => p.type === "year")!.value;
    const month = parts.find((p) => p.type === "month")!.value;
    const day = parts.find((p) => p.type === "day")!.value;

    // Build an ISO string representing the local time in the timezone,
    // then compute the UTC equivalent by finding the offset
    const localIso = `${year}-${month}-${day}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;

    // Use the timezone offset at that specific moment to convert to UTC
    const offsetMs = this.getTimezoneOffsetMs(localIso, timezone);
    return new Date(new Date(localIso + "Z").getTime() - offsetMs);
  }

  /**
   * Get the UTC offset in milliseconds for a given local datetime in a timezone.
   */
  private getTimezoneOffsetMs(localIso: string, timezone: string): number {
    const utcDate = new Date(localIso + "Z");
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(utcDate);
    const get = (type: string) => parts.find((p) => p.type === type)!.value;
    const localAtUtc = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`;
    return new Date(localAtUtc).getTime() - utcDate.getTime();
  }

  /**
   * Safely join a folder path with a filename, ensuring the result
   * stays within the base folder (prevents path traversal CWE-22).
   */
  private safePath(basePath: string, filename: string): string {
    const full = resolve(basePath, filename);
    if (!full.startsWith(basePath + "/") && full !== basePath) {
      throw new BadRequestException(
        tr(
          "errors.backup.pathTraversal",
          `Path traversal detected: ${filename}`,
          { filename },
        ),
      );
    }
    return full;
  }

  /**
   * Validate a user-supplied folder path and return the normalized form.
   * All filesystem operations must use the returned value (not the original
   * input) so CodeQL/SAST tools can see the explicit sanitization boundary
   * (CWE-22: Path traversal).
   */
  private validateFolderPath(folderPath: string): string {
    if (typeof folderPath !== "string") {
      throw new BadRequestException(
        tr(
          "errors.backup.folderPathMustBeString",
          "Folder path must be a string",
        ),
      );
    }
    if (folderPath.length > 4096) {
      throw new BadRequestException(
        tr("errors.backup.folderPathTooLong", "Folder path is too long"),
      );
    }
    if (!folderPath.startsWith("/")) {
      throw new BadRequestException(
        tr(
          "errors.backup.folderPathMustBeAbsolute",
          "Folder path must be an absolute path",
        ),
      );
    }
    if (folderPath.includes("..")) {
      throw new BadRequestException(
        tr(
          "errors.backup.folderPathNoDotDot",
          "Folder path must not contain '..' segments",
        ),
      );
    }
    if (folderPath.includes("\0")) {
      throw new BadRequestException(
        tr(
          "errors.backup.folderPathNoNullBytes",
          "Folder path must not contain null bytes",
        ),
      );
    }
    // Trim trailing slashes without a greedy regex (avoids ReDoS on '/' runs).
    let trimmed = folderPath;
    while (trimmed.length > 1 && trimmed.endsWith("/")) {
      trimmed = trimmed.slice(0, -1);
    }
    // Ensure the resolved path matches the input (no symlink-like tricks via //)
    const normalized = resolve(trimmed);
    if (normalized !== trimmed) {
      throw new BadRequestException(
        tr(
          "errors.backup.folderPathMustBeNormalized",
          "Folder path must be a normalized absolute path",
        ),
      );
    }
    return normalized;
  }

  /**
   * Ensure `safePath` is an existing directory. The configured default folder
   * is created on first use so a deployment only has to mount the volume, and
   * so are the per-user folders underneath a base that already checks out
   * (`createIfMissing`); any other chosen folder must already exist, since
   * creating arbitrary paths on demand would mask typos.
   */
  private async assertDirectoryExists(
    safePath: string,
    createIfMissing = false,
  ): Promise<void> {
    try {
      const stat = await fs.stat(safePath);
      if (!stat.isDirectory()) {
        throw new BadRequestException(
          tr(
            "errors.backup.pathNotDirectory",
            `Path is not a directory: ${safePath}`,
            { safePath },
          ),
        );
      }
      return;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      if (error.code !== "ENOENT") {
        throw new BadRequestException(
          tr(
            "errors.backup.folderAccessErrorDetail",
            `Cannot access folder: ${safePath} - ${error.message}`,
            { safePath, message: error.message },
          ),
        );
      }
      if (!createIfMissing && safePath !== this.defaultFolderPath) {
        throw new BadRequestException(
          tr(
            "errors.backup.folderNotExistVolume",
            `Folder does not exist: ${safePath}. Ensure the path is mapped as a Docker volume.`,
            { safePath },
          ),
        );
      }
    }

    try {
      await fs.mkdir(safePath, { recursive: true });
      this.logger.log(`Created backup folder ${safePath}`);
    } catch (error) {
      this.logger.error(
        `Failed to create backup folder ${safePath}: ${error.message}`,
      );
      // The deployment default could not even be created, which is a different
      // problem from a path the user mistyped: there is nowhere on this
      // deployment for a backup to go, and no path they can type will change
      // that. It used to report "Ensure the path is mapped as a Docker volume",
      // which is one of the two mechanisms and the wrong one on Kubernetes -- an
      // operator following it goes looking for a volume mount in a chart that
      // expresses the same thing as a persistence value. The code cannot tell
      // which platform it is on, so the message names both and says plainly that
      // the destination is the deployment's to fix.
      throw new BadRequestException(
        tr(
          "errors.backup.noBackupStorage",
          `This deployment has no writable backup storage: ${safePath} does not exist ` +
            `and cannot be created (${error.code ?? error.message}). Mount a volume there ` +
            `(Docker: a bind mount or named volume; Kubernetes: set ` +
            `backend.persistence.backups in the Helm chart) and try again.`,
          { safePath, reason: error.code ?? error.message },
        ),
      );
    }
  }

  private async assertFolderWritable(
    folderPath: string,
    { createIfMissing = false }: { createIfMissing?: boolean } = {},
  ): Promise<void> {
    // Re-validate defensively: this method is also invoked with folder paths
    // read back from the database (originally user-supplied), so CWE-22
    // sanitization must run every time before we touch the filesystem.
    const safePath = this.validateFolderPath(folderPath);
    await this.assertDirectoryExists(safePath, createIfMissing);

    // Test write access by creating and removing a temporary file.
    //
    // The name is a UUID, not a timestamp. `validateFolder` probes the *shared*
    // root, so every user who validates the same folder writes here -- and the
    // cron probes a per-user folder that every replica fires for. Two probes
    // landing in the same millisecond used to pick the same name: both writes
    // succeed, the first unlink removes the file, and the second gets ENOENT and
    // reports "Folder is not writable ... Check container permissions" for a
    // folder that is perfectly writable. On the settings screen that blocks
    // enabling backups; in the cron it aborts that user's backup.
    const testFile = this.safePath(
      safePath,
      `.monize-write-test-${randomUUID()}`,
    );
    try {
      await fs.writeFile(testFile, "");
    } catch {
      throw new BadRequestException(
        tr(
          "errors.backup.folderNotWritable",
          `Folder is not writable: ${safePath}. Check container permissions.`,
          { safePath },
        ),
      );
    }
    // The write is the answer. Failing to remove the probe is litter -- one empty
    // dot-file that no retention pattern matches -- and reporting it as "not
    // writable" would contradict the write that just succeeded.
    try {
      await fs.unlink(testFile);
    } catch (error) {
      this.logger.warn(
        `Could not remove write-test file ${testFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * The UTC calendar day, as the daily bucket in a system-alert dedupe key. UTC
 * rather than the user's backup timezone on purpose: the key only has to be
 * the same on every replica, and replicas share a clock, not a user timezone
 * lookup.
 */
function utcDateString(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The retention tier a *published* artifact's name declares, or `null` for a
 * `partial-` one and for anything this module did not write.
 *
 * `BackupOffsiteTier` is the narrower of the two vocabularies -- the off-site
 * table's CHECK constraint admits only the three published tiers -- so this is
 * where the wider one is narrowed, once, rather than at each call site.
 */
function publishedOffsiteTier(filename: string): BackupOffsiteTier | null {
  const classified = classifyBackupFileName(filename);
  if (!classified || classified.tier === PARTIAL_TIER_NAME) return null;
  return classified.tier;
}
