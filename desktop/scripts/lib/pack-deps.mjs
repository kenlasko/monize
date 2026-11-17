import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);

/**
 * Where the backend's production dependencies are staged: one archive whose
 * root holds a `node_modules` directory. resources/backend-deps.cjs, the
 * backend's preload, finds it at the same path and src/packaging.spec.ts holds
 * the two equal.
 */
export const BACKEND_DEPS_ARCHIVE = "backend/node_modules.asar";

/**
 * Native addons stay outside the archive, in `<archive>.unpacked/` at the same
 * relative path: the operating system loads a DLL only from a real file, and
 * Electron redirects a load from inside the archive there.
 */
export const UNPACKED_PATTERN = "*.node";

/**
 * Packs the directory `root` into `archive` with @electron/asar's CLI, run on
 * this Node so that staging stays synchronous. Throws when the CLI fails.
 */
export function packArchive({ root, archive, run = spawnSync }) {
  const cli = require.resolve("@electron/asar/bin/asar.js");
  const result = run(
    process.execPath,
    [cli, "pack", root, archive, "--unpack", UNPACKED_PATTERN],
    { stdio: "inherit" },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `asar pack ${root} failed (${result.error ? result.error.message : `exit ${result.status}`})`,
    );
  }
}
