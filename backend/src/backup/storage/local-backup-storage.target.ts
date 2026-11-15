import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createReadStream, promises as fs } from "fs";
import { randomUUID } from "crypto";
import * as path from "path";
import {
  cleanStaleTempFiles,
  copyFileAtomic,
  isTempBackupName,
  writeFileAtomic,
} from "../atomic-file";
import {
  assertWithinAllowedRoots,
  BackupPathNotAllowedError,
  BackupPathUnusableError,
  PathApi,
  resolveAllowedRoots,
} from "../backup-paths";
import { isShardableId, shardedSegments } from "../../common/shard-path.util";
import { tr } from "../../i18n/translate";
import {
  BackupStorageTarget,
  BackupStoreCapability,
  BackupStoreLocation,
  OpenedArtifact,
  StoredArtifactEntry,
} from "./backup-storage.interface";

/**
 * Folder automatic backups are written to when BACKUP_CONTAINER_DIR is unset.
 * Monize runs in a container, so this is a container path: mount a host folder
 * there (see .env.example and the docker-compose files).
 */
export const DEFAULT_BACKUP_CONTAINER_DIR = "/data/backups";

/**
 * A per-user backup directory name: the user's UUID. Used to keep those
 * directories out of the folder picker -- listing them would turn it into user
 * enumeration, and offering one as a destination would nest a second level
 * inside it.
 */
const USER_DIRECTORY_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `local` handle: the user's own directory, and the flat base a version
 * before per-user folders wrote into.
 *
 * Both travel together because the listing reports both: the legacy directory
 * is a shared history nobody can attribute, so it is listed (marked `legacy`)
 * but never opened or removed, and it is the one part of this layout an object
 * store cannot represent.
 */
interface LocalBackupStoreLocation extends BackupStoreLocation {
  readonly folder: string;
  readonly legacyBase: string;
}

/**
 * Automatic backups on a container directory. Chosen by
 * `BACKUP_STORAGE_PROVIDER=local`, which is the default.
 *
 * This is the behaviour `AutoBackupService` performed inline before the storage
 * target was extracted, moved rather than rewritten: the same containment model,
 * the same atomic write, the same probe, the same legacy listing. The proof that
 * the extraction changed nothing is that the service's existing spec suite runs
 * against this target unchanged.
 *
 * **Layout.** Each user's backups live in their own folder under the configured
 * base, fanned out by user id exactly the way attachment bytes are:
 * `<BACKUP_CONTAINER_DIR>/<ab>/<cd>/<userId>/monize-backup-daily-<date>.json.gz`
 * (`common/shard-path.util.ts`). The filenames carry only a tier and a date, so
 * a flat shared folder gave every user the same name for the same day --
 * whoever ran last overwrote the others, and one user's retention pass deleted
 * another's files. The per-user folder is what makes a backup belong to
 * somebody, and `backup-paths.ts` says why the destination is confined to
 * operator-approved roots, canonically rather than lexically.
 */
@Injectable()
export class LocalBackupStorageTarget implements BackupStorageTarget {
  readonly name = "local";

  /** A directory is a place an operator can choose and an admin can browse. */
  readonly locationSelectable = true;

  private readonly logger = new Logger(LocalBackupStorageTarget.name);

  /** Deployment-wide backup folder (BACKUP_CONTAINER_DIR), used whenever a user
   *  has not chosen one of their own. */
  readonly defaultBase: string;

  /**
   * Roots a backup may be written under. Everything the user can influence is
   * checked against these, canonically -- see backup-paths.ts for why lexical
   * checks were not enough and why the destination is no longer the user's to
   * choose freely.
   */
  private readonly allowedRoots: string[];

  constructor(config: ConfigService) {
    this.defaultBase = this.resolveConfiguredFolderPath(
      config.get<string>("BACKUP_CONTAINER_DIR"),
    );
    this.allowedRoots = resolveAllowedRoots(
      config.get<string>("BACKUP_ALLOWED_ROOTS"),
      this.defaultBase,
    );
  }

  resolveBase(configured: string | null | undefined): string {
    const trimmed = configured?.trim();
    return trimmed ? trimmed : this.defaultBase;
  }

  acceptBase(folderPath: string): string {
    return this.validateFolderPath(folderPath);
  }

  describeLocation(
    userId: string,
    configured: string | null | undefined,
  ): string | undefined {
    try {
      return this.userFolderPath(this.resolveBase(configured), userId);
    } catch {
      // A base path the operator has since made invalid must not break the
      // settings screen; the folder validation on save reports it properly.
      return undefined;
    }
  }

  async resolveLocation(
    userId: string,
    configured: string | null | undefined,
    opts: { create: boolean },
  ): Promise<LocalBackupStoreLocation> {
    const root = await this.assertAllowedRoot(this.resolveBase(configured));
    if (opts.create) {
      // The root itself must exist and be writable (the deployment default is
      // created on first use; anything else has to be mounted deliberately, so a
      // typo surfaces as an error rather than as a new empty directory).
      await this.assertFolderWritable(root);
    }

    // The per-user directory, by contrast, is server-computed and already
    // inside a permitted root, so creating it needs no further decision.
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
    if (opts.create) {
      await this.assertFolderWritable(folder, { createIfMissing: true });
    }
    return { target: this.name, display: folder, folder, legacyBase: root };
  }

  async describeStore(
    userId: string,
    configured: string | null | undefined,
  ): Promise<BackupStoreCapability> {
    const base = this.resolveBase(configured);
    try {
      // Containment BEFORE the write probe, and through the same predicate the
      // real write uses (F3RB-R1-001). `updateSettings` only validates a stored
      // folder's syntax unless the same call enables the schedule, and a
      // deployment upgraded from before confinement can already hold an
      // arbitrary path -- so a stored root may be outside BACKUP_ALLOWED_ROOTS.
      // Probing it first would create and delete a `.monize-write-test-*` file
      // outside the approved volume and then report a configuration available
      // that `resolveLocation` refuses.
      const root = await this.assertAllowedRoot(base);
      await this.assertFolderWritable(root);
      return {
        available: true,
        location: root,
        locationSelectable: this.locationSelectable,
        artifactCount: await this.countArtifacts(userId, configured),
      };
    } catch (error) {
      return {
        available: false,
        location: base,
        locationSelectable: this.locationSelectable,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * How many artifacts this store is already holding for one user, or
   * `undefined` when it cannot say.
   *
   * Only the user's own namespace is counted, not the legacy flat base: the
   * question this answers on the settings screen is "does the store I am
   * configured for hold my recovery points", and a shared history nobody can
   * attribute is not an answer to it.
   */
  private async countArtifacts(
    userId: string,
    configured: string | null | undefined,
  ): Promise<number | undefined> {
    try {
      const location = await this.resolveLocation(userId, configured, {
        create: false,
      });
      const entries = await this.list(location);
      return entries.filter((entry) => !entry.legacy).length;
    } catch {
      return undefined;
    }
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

  /**
   * Temp file, fsync, rename (`atomic-file.ts`): `fs.writeFile` truncated the
   * final name first, so a kill or an ENOSPC mid-write left a partial artifact
   * with a valid extension that sorted newest and that retention counted.
   * `rename(2)` within a filesystem is atomic, so the final name never refers to
   * a partial file (INV-BACKUP-006).
   */
  async publish(
    location: BackupStoreLocation,
    filename: string,
    bytes: Buffer,
  ): Promise<void> {
    const { folder } = this.own(location);
    await writeFileAtomic(this.safePath(folder, filename), bytes);
  }

  /**
   * Through a temp name for the same reason as the publish: a copy straight onto
   * the final name truncates last week's artifact first, so an interrupted
   * promotion destroyed a good backup and left a partial one named as though it
   * had replaced it.
   */
  async promote(
    location: BackupStoreLocation,
    fromFilename: string,
    toFilename: string,
  ): Promise<void> {
    const { folder } = this.own(location);
    await copyFileAtomic(
      this.safePath(folder, fromFilename),
      this.safePath(folder, toFilename),
    );
  }

  async list(location: BackupStoreLocation): Promise<StoredArtifactEntry[]> {
    const { folder, legacyBase } = this.own(location);
    return [
      ...(await this.listDirectory(folder, false)),
      ...(await this.listDirectory(legacyBase, true)),
    ];
  }

  /**
   * The artifacts directly in one directory.
   *
   * A directory that does not exist is an empty list, not an error: a user
   * enrolled on the deployment defaults has one only after their first run.
   * Temporary files are excluded here rather than by each caller -- a partial
   * write is not an artifact of the store, it is `sweepIncomplete`'s, and
   * counting one towards "keep 7 daily" would quietly shorten the window.
   */
  private async listDirectory(
    directory: string,
    legacy: boolean,
  ): Promise<StoredArtifactEntry[]> {
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch {
      return [];
    }
    const entries: StoredArtifactEntry[] = [];
    for (const name of names) {
      if (isTempBackupName(name)) continue;
      try {
        const stat = await fs.stat(this.safePath(directory, name));
        if (!stat.isFile()) continue;
        entries.push({
          name,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime,
          legacy,
        });
      } catch {
        // Retention can delete a file between the readdir and the stat. An
        // artifact that is already gone is not one the store holds.
        continue;
      }
    }
    return entries;
  }

  /**
   * **The path opened is the directory entry's, never the caller's string**: the
   * requested name is compared against this location's own listing and the
   * matching entry is what gets joined, so the value reaching the filesystem is
   * one this deployment wrote rather than one a request carried in (CWE-22, and
   * what lets a SAST tool see the boundary). The join is still
   * containment-checked, because a validated name and an unvalidated join is how
   * a check becomes decorative.
   *
   * Only the user's own folder is read. The legacy flat base is deliberately
   * skipped: those filenames carry no user id, so nothing there can be
   * attributed to anybody, and serving one would hand a user another user's
   * ledger.
   */
  async open(
    location: BackupStoreLocation,
    filename: string,
  ): Promise<OpenedArtifact | null> {
    const { folder } = this.own(location);
    let names: string[];
    try {
      names = await fs.readdir(folder);
    } catch {
      return null;
    }
    // The requested name is only ever compared here; `entry` is the server's own
    // string from `readdir`, and it is `entry` that is joined and opened.
    const entry = names.find((name) => name === filename);
    if (entry === undefined) return null;

    const path = this.safePath(folder, entry);
    try {
      const stat = await fs.stat(path);
      if (!stat.isFile()) return null;
      return {
        filename: entry,
        sizeBytes: stat.size,
        stream: createReadStream(path),
      };
    } catch {
      return null;
    }
  }

  async remove(
    location: BackupStoreLocation,
    entry: StoredArtifactEntry,
  ): Promise<void> {
    // A legacy artifact names no owner, so no user's pass may delete it
    // (INV-BACKUP-001); `open()` refuses it for the same reason.
    if (entry.legacy) {
      throw new Error(
        `Refusing to remove legacy artifact ${entry.name}: it names no owner`,
      );
    }
    const { folder } = this.own(location);
    await fs.unlink(this.safePath(folder, entry.name));
  }

  async sweepIncomplete(
    location: BackupStoreLocation,
    now: number,
  ): Promise<number> {
    const { folder } = this.own(location);
    return cleanStaleTempFiles(folder, now);
  }

  /**
   * Narrow a handle to one this target produced.
   *
   * The handle is opaque by contract, so interpreting somebody else's would be
   * reading a field that happens to be there. Only one target is bound per
   * deployment, so this cannot fire in a running system -- it fires in a test
   * that wires two, which is exactly when a silent misinterpretation would be
   * hardest to see.
   */
  private own(location: BackupStoreLocation): LocalBackupStoreLocation {
    if (location.target !== this.name) {
      throw new Error(
        `Backup location belongs to the "${location.target}" target, not "${this.name}"`,
      );
    }
    return location as LocalBackupStoreLocation;
  }

  /**
   * BACKUP_CONTAINER_DIR is operator-supplied, so it goes through the same
   * CWE-22 validation as a user-supplied path. An unusable value falls back to
   * the built-in default with a loud log rather than taking the whole app down.
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

  /**
   * Safely join a folder path with a filename, ensuring the result
   * stays within the base folder (prevents path traversal CWE-22).
   */
  private safePath(basePath: string, filename: string): string {
    return safeBackupPath(basePath, filename);
  }

  /**
   * Validate a user-supplied folder path and return the normalized form.
   * All filesystem operations must use the returned value (not the original
   * input) so CodeQL/SAST tools can see the explicit sanitization boundary
   * (CWE-22: Path traversal).
   */
  private validateFolderPath(folderPath: string): string {
    return validateBackupFolderPath(folderPath);
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
      if (!createIfMissing && safePath !== this.defaultBase) {
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
 * Join `filename` onto `basePath` and refuse a result outside the base
 * (CWE-22). The boundary is the platform's separator, so on Windows a drive
 * change (`D:\x`), a UNC path or `..\..\Windows` resolves outside
 * `C:\Monize\backups` and is refused exactly as `../../etc` is on POSIX.
 *
 * `pathApi` exists so the win32 semantics can be proven on a Linux runner with
 * `path.win32` (the pattern `common/jest-config.guard.spec.ts` follows); every
 * production caller takes the default, the host's own `path`.
 */
export function safeBackupPath(
  basePath: string,
  filename: string,
  pathApi: PathApi = path,
): string {
  const full = pathApi.resolve(basePath, filename);
  if (!full.startsWith(basePath + pathApi.sep) && full !== basePath) {
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
 * Validate a user- or operator-supplied folder path and return its normalized
 * form: absolute on the host platform (`/data/backups` on POSIX,
 * `C:\Monize\backups` on Windows), no `..`, no null bytes, and already in the
 * form `resolve` would give it. `pathApi` is injectable for the same reason
 * as in `safeBackupPath`.
 */
export function validateBackupFolderPath(
  folderPath: string,
  pathApi: PathApi = path,
): string {
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
  if (!pathApi.isAbsolute(folderPath)) {
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
  // Trim trailing separators without a greedy regex (avoids ReDoS on runs of
  // them), never past the root: `/` on POSIX, `C:\` on Windows.
  const rootLength = pathApi.parse(folderPath).root.length;
  let trimmed = folderPath;
  while (trimmed.length > rootLength && trimmed.endsWith(pathApi.sep)) {
    trimmed = trimmed.slice(0, -1);
  }
  // Ensure the resolved path matches the input (no symlink-like tricks via //,
  // no drive-relative or forward-slash spelling on Windows).
  const normalized = pathApi.normalize(pathApi.resolve(trimmed));
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
