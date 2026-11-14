import { promises as fs } from "fs";
import * as defaultPathApi from "path";

/** The host `path`, or `path.win32` / `path.posix` in a spec. */
export type PathApi = typeof defaultPathApi;

/**
 * Where a user's automatic backups may be written, and where they may not.
 *
 * Two problems lived in this area, and they compound.
 *
 * **The namespace was shared.** The default folder is deployment-wide and the
 * filenames carried frequency and date and nothing else. Two users keeping the
 * default therefore wrote `monize-backup-daily-2026-08-01.json.gz` to the same
 * path on the same day -- the second replaced the first -- and retention
 * enumerated the whole folder with global patterns and applied whichever user's
 * counts it was running for. A user with a 2-day window deleted a user with a
 * 30-day window's history. One replica and two users is enough; the encryption
 * extension avoided one same-day collision and no part of the retention problem,
 * because both `.json.gz` and `.mzbe` are enumerated.
 *
 * **The destination was unrestricted.** The folder endpoints require
 * authentication and nothing else -- no admin role -- and validation asked only
 * for an absolute, normalised, writable directory. So any user could enumerate
 * the container filesystem through `browse-folders` and point their backups at
 * any writable path in it: `/tmp`, a mounted secret, another tenant's directory.
 * The lexical `safePath` guard protected the generated *filename* against
 * traversal, never the chosen directory. And because nothing canonicalised the
 * path, a symlink inside an otherwise-acceptable directory redirected the write
 * outside it.
 *
 * So a destination now has to satisfy both: it is contained in an
 * operator-approved root, canonically and not just lexically, and the file goes
 * in a server-computed per-user subdirectory of it that the user cannot name.
 */

/**
 * Roots a backup may be written under, from `BACKUP_ALLOWED_ROOTS`
 * (separated by the platform's path-list delimiter, in the style of `PATH`:
 * `:` on POSIX, `;` on Windows, where `:` is part of every drive letter).
 * An entry that is not absolute on the platform is ignored.
 *
 * Defaults to the deployment's backup folder alone. That is a deliberate
 * tightening: a deployment where users had chosen folders elsewhere must list
 * them here, and until it does those backups are refused with an error naming
 * the variable. Refusing loudly is the right failure -- the alternative is
 * keeping a hole open because closing it is inconvenient, and the hole is
 * "any authenticated user can write anywhere the process can".
 *
 * `pathApi` is the host's `path` in production; the specs pass `path.win32`
 * to prove the Windows semantics on a Linux runner.
 */
export function resolveAllowedRoots(
  configured: string | undefined,
  defaultRoot: string,
  pathApi: PathApi = defaultPathApi,
): string[] {
  const extra = (configured ?? "")
    .split(pathApi.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => pathApi.isAbsolute(entry))
    .map((entry) => pathApi.resolve(entry));
  // The default root is always allowed: it is the operator's own choice of
  // where backups go, and excluding it would break the out-of-the-box setup.
  return [...new Set([pathApi.resolve(defaultRoot), ...extra])];
}

/** True when `candidate` is `root` or sits beneath it. */
function isWithin(candidate: string, root: string, pathApi: PathApi): boolean {
  return candidate === root || candidate.startsWith(root + pathApi.sep);
}

/**
 * The deepest existing ancestor of `path`, resolved through symlinks, paired
 * with the segments that do not exist yet.
 *
 * A plain `realpath` of the whole path fails for a directory that has not been
 * created, and skipping canonicalisation entirely is what let a symlink escape:
 * `/data/backups/mine -> /etc` passes every lexical check there is.
 */
async function realpathOfExistingAncestor(
  path: string,
  pathApi: PathApi,
): Promise<{ real: string; missing: string[] }> {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return { real: await fs.realpath(current), missing: missing.reverse() };
    } catch (error) {
      const code = (error as { code?: string }).code;
      // Only ENOENT means "not created yet", which is the case this walk exists
      // to handle. Everything else means the path cannot be a directory at all:
      // ENOTDIR because a component is a file, ELOOP because a symlink cycles,
      // EACCES because a parent cannot be traversed, ENAMETOOLONG because it is
      // not a usable path.
      //
      // Those used to be rethrown raw, so a user-supplied folder containing a
      // file component reached the client as a 500 carrying
      // `ENOTDIR: not a directory, realpath '/data/backups/notes.txt/sub'` --
      // the wrong status for a bad request, the resolved filesystem path leaked
      // into the response, and nothing the user could act on. A typed error lets
      // the caller answer with a 400 that says what is wrong.
      if (code !== "ENOENT") {
        throw new BackupPathUnusableError(path, code ?? String(error));
      }
      const parent = pathApi.dirname(current);
      if (parent === current) {
        // Reached `/` without finding anything that exists, which cannot happen
        // on a running system but must not loop if it does.
        return { real: current, missing: missing.reverse() };
      }
      // A root parent (`/`, `C:\`) already ends in the separator; any other
      // parent is followed by one.
      missing.push(
        current.slice(
          parent.endsWith(pathApi.sep) ? parent.length : parent.length + 1,
        ),
      );
      current = parent;
    }
  }
}

/**
 * The path cannot be a directory, whatever the permitted roots say. Distinct from
 * `BackupPathNotAllowedError`, which is about *where* a usable path points.
 */
export class BackupPathUnusableError extends Error {
  constructor(
    readonly path: string,
    readonly code: string,
  ) {
    super(`Backup folder "${path}" cannot be used as a directory (${code}).`);
    this.name = "BackupPathUnusableError";
  }
}

export class BackupPathNotAllowedError extends Error {
  constructor(path: string, allowedRoots: string[]) {
    super(
      `Backup folder "${path}" is outside the permitted roots ` +
        `(${allowedRoots.join(", ")}). Set BACKUP_ALLOWED_ROOTS to permit it.`,
    );
    this.name = "BackupPathNotAllowedError";
  }
}

/**
 * Canonicalise `path` and confirm it resolves inside one of `allowedRoots`.
 *
 * Returns the canonical form, which is what callers must use for every
 * filesystem operation afterwards: validating one path and then operating on
 * another is how a check becomes decorative.
 *
 * `pathApi` is injectable for the same reason as in `resolveAllowedRoots`.
 */
export async function assertWithinAllowedRoots(
  path: string,
  allowedRoots: string[],
  pathApi: PathApi = defaultPathApi,
): Promise<string> {
  const { real, missing } = await realpathOfExistingAncestor(
    pathApi.resolve(path),
    pathApi,
  );
  const canonical =
    missing.length > 0 ? pathApi.resolve(real, ...missing) : real;

  const realRoots = await Promise.all(
    allowedRoots.map(async (root) => {
      try {
        return await fs.realpath(root);
      } catch {
        // A root that does not exist yet still constrains: compare lexically.
        return root;
      }
    }),
  );

  if (!realRoots.some((root) => isWithin(canonical, root, pathApi))) {
    throw new BackupPathNotAllowedError(path, allowedRoots);
  }
  return canonical;
}
