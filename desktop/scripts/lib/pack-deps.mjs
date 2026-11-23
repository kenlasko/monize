import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

const ASAR_PACKAGE = "@electron/asar";

/**
 * The path of @electron/asar's CLI, read from its own `bin` field. The package
 * exports only its main entry, so no subpath of it resolves, and the CLI's
 * file name has changed between major versions.
 */
export function asarCliPath() {
  let dir = path.dirname(require.resolve(ASAR_PACKAGE));
  for (;;) {
    const manifest = path.join(dir, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (pkg.name === ASAR_PACKAGE) {
        const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.asar;
        if (!bin) throw new Error(`${ASAR_PACKAGE} declares no asar CLI`);
        return path.resolve(dir, bin);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`${ASAR_PACKAGE}'s package.json was not found`);
    }
    dir = parent;
  }
}

/**
 * Packs the directory `root` into `archive` with @electron/asar's CLI, run on
 * this Node so that staging stays synchronous. Throws when the CLI fails.
 */
export function packArchive({ root, archive, run = spawnSync }) {
  const cli = asarCliPath();
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
