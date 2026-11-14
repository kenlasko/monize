/**
 * What is in a data folder, as far as a move is concerned. Paths here are
 * relative to the data folder and written with `/`, whatever the platform.
 */

/** Chromium's profile: the window's cookies, caches and lock files. */
export const PROFILE_DIR = "shell";

/**
 * The one file of the profile that moves. On Windows Chromium keeps the key
 * that `safeStorage` encrypts with in this file (itself wrapped by DPAPI), so
 * the secrets in `config.json` open only beside the `Local State` they were
 * wrapped under. Chromium rewrites the file whenever it likes, by replacing
 * it, so it is the one file allowed to change while the copy runs.
 */
export const PROFILE_KEY_FILE = `${PROFILE_DIR}/Local State`;

/** Left in a folder whose data was moved away; the shell refuses to start on it. */
export const TOMBSTONE_FILE = "moved-elsewhere.json";

/** In a copy that is not committed yet; holds the id of the move that made it. */
export const STAGING_MARKER = ".monize-move";

/** The shell's and its children's log files. */
export const LOGS_DIR = "logs";

export const CONFIG_FILE = "config.json";
export const PGDATA_DIR = "pgdata";
/** Present exactly while a PostgreSQL server has the cluster open. */
export const POSTMASTER_PID = `${PGDATA_DIR}/postmaster.pid`;

/**
 * Everything Monize itself creates at the top of a data folder. Deleting an
 * old copy removes these and nothing else, so a file the person put there
 * stays. `pgdata.initdb-password` is the PostgreSQL runner's, left only by a
 * first run that was killed.
 */
export const OWNED_TOP_LEVEL = [
  PGDATA_DIR,
  "backups",
  "attachments",
  LOGS_DIR,
  PROFILE_DIR,
  CONFIG_FILE,
  "pgdata.initdb-password",
] as const;

/**
 * Whether an entry is copied. Everything is, except the rest of the Chromium
 * profile (the running shell holds it open, on Windows exclusively, so a copy
 * of it could be neither completed nor verified; the person signs in again)
 * and the two files that describe a move rather than belong to the data.
 */
export function movesWithData(rel: string): boolean {
  if (rel === TOMBSTONE_FILE || rel === STAGING_MARKER) return false;
  if (rel.startsWith(`${PROFILE_DIR}/`)) return rel === PROFILE_KEY_FILE;
  return true;
}

/**
 * Files that may change while the copy runs, because the process doing the
 * copy writes them: Chromium's key file, and the logs (a hidden window, the
 * updater or a late line from a child can append one, and a log that grows
 * may be rotated). They are copied as they read at that moment and the copy
 * is verified against those bytes; one that has been rotated away by then is
 * left out. Everything else must be untouched from the first look to the
 * last, or the move stops.
 */
export function isVolatile(rel: string): boolean {
  return rel === PROFILE_KEY_FILE || rel.startsWith(`${LOGS_DIR}/`);
}
