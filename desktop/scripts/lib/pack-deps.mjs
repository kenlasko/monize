import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
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
  const cli = asarCli();
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

/**
 * The path of @electron/asar's CLI, from the package's own `bin` field. The
 * package's `exports` hide every other file (from 4.x, whose CLI is
 * `bin/asar.mjs`), so the root is found from the one entry it exports.
 */
export function asarCli(resolve = require.resolve, read = readFileSync) {
  let dir = path.dirname(resolve("@electron/asar"));
  for (;;) {
    const manifest = path.join(dir, "package.json");
    let pkg;
    try {
      pkg = JSON.parse(read(manifest, "utf8"));
    } catch {
      pkg = undefined;
    }
    if (pkg?.name === "@electron/asar") {
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.asar;
      if (!bin) throw new Error(`${manifest} names no asar CLI in "bin"`);
      return path.join(dir, bin);
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error("@electron/asar's package.json was not found");
    }
    dir = parent;
  }
}
