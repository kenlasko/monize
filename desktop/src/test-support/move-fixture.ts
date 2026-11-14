import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import * as hostPath from "path";
import { join, posix } from "path";

import { locationFileFor } from "../move/location";
import { MoveDeps } from "../move/move";
import { nodeMoveFs } from "../move/move-fs";
import { MoveFs, MoveProgress } from "../move/move-types";
import { journalFileFor } from "../move/records";

/**
 * A data folder on the real disk for the move's specs: the move is about
 * what ends up on disk, so the specs look at a disk, and inject a failure by
 * replacing one capability of the real filesystem.
 */

export interface MoveFixture {
  readonly root: string;
  /** The default data folder, holding a small but complete data folder. */
  readonly source: string;
  readonly target: string;
  readonly locationFile: string;
  readonly journalFile: string;
  readonly logs: string[];
  readonly progress: MoveProgress[];
  deps(fs?: MoveFs, overrides?: Partial<MoveDeps>): MoveDeps;
  cleanup(): void;
}

const FILES: Readonly<Record<string, string>> = {
  "config.json": '{"version":1}',
  "pgdata/PG_VERSION": "16\n",
  "pgdata/monize.initialized": "2026-11-13T00:00:00.000Z\n",
  "pgdata/base/1/1259": "x".repeat(8192),
  "pgdata/base/1/2619": "y".repeat(300),
  "pgdata/global/pg_control": "control",
  "backups/user-1/monize-backup-daily-2026-11-12.json.gz": "backup",
  "logs/main.log": "a line\n",
  "shell/Local State": '{"os_crypt":{"encrypted_key":"abc"}}',
  "shell/Network/Cookies": "cookies",
};
const EMPTY_DIRS = ["pgdata/pg_notify", "pgdata/pg_tblspc", "attachments"];

export function writeDataFolder(dir: string): void {
  for (const [rel, content] of Object.entries(FILES)) {
    mkdirSync(join(dir, posix.dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  for (const rel of EMPTY_DIRS) mkdirSync(join(dir, rel), { recursive: true });
  chmodSync(join(dir, "pgdata"), 0o700);
  // What a running Chromium leaves in its profile on Linux.
  symlinkSync("host-1234", join(dir, "shell", "SingletonLock"));
}

/** Every file under `dir` with its content, and every folder, sorted. */
export function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        result[`${child}/`] = "";
        walk(child);
      } else if (entry.isFile()) {
        result[child] = readFileSync(join(dir, child), "utf8");
      } else {
        result[child] = "<link>";
      }
    }
  };
  walk("");
  return result;
}

/**
 * What a copy of `dir` must hold: everything, except the Chromium profile
 * bar its key file, and except the note a finished move leaves in `dir`.
 */
export function movedSnapshot(dir: string): Record<string, string> {
  const keep = (rel: string): boolean =>
    rel !== "moved-elsewhere.json" &&
    (!rel.startsWith("shell/") ||
      rel === "shell/" ||
      rel === "shell/Local State");
  return Object.fromEntries(
    Object.entries(snapshot(dir)).filter(([rel]) => keep(rel)),
  );
}

export function createMoveFixture(): MoveFixture {
  // Resolved, so the root is spelled as the move's link-resolving checks see
  // it: the Windows runner's temp folder is an 8.3 short name (RUNNER~1).
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "monize-move-")));
  const source = join(root, "local", "Monize");
  const target = join(root, "disk two", "Monize data");
  mkdirSync(join(root, "disk two"), { recursive: true });
  writeDataFolder(source);
  const logs: string[] = [];
  const progress: MoveProgress[] = [];
  const locationFile = locationFileFor(source);
  const journalFile = journalFileFor(source);
  return {
    root,
    source,
    target,
    locationFile,
    journalFile,
    logs,
    progress,
    deps: (fs = nodeMoveFs, overrides = {}) => ({
      fs,
      // The host's: these tests run the move against real temp folders, which
      // are C:\ paths on the Windows CI runner.
      path: hostPath,
      platform: process.platform,
      locationFile,
      journalFile,
      signal: { cancelled: false },
      onProgress: (item) => progress.push(item),
      log: (line) => logs.push(line),
      ...overrides,
    }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function exists(path: string): boolean {
  return existsSync(path);
}
