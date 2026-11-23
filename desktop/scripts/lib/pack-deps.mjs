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

/**
 * The @electron/asar command-line script, named by the package's own `bin`
 * field. A hard-coded subpath stops resolving when a release moves it or
 * closes it off: 4.x ships `bin/asar.mjs` and an `exports` map that exposes
 * only the entry point, so `@electron/asar/bin/asar.js` no longer resolves.
 * The entry point always does, and the package root is above it.
 */
export function asarCli() {
  const entry = require.resolve("@electron/asar");
  for (let dir = path.dirname(entry); ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (pkg.name === "@electron/asar") {
        const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.asar;
        if (!bin) {
          throw new Error(
            `@electron/asar ${pkg.version} declares no asar command`,
          );
        }
        return path.join(dir, bin);
      }
    }
    if (path.dirname(dir) === dir) {
      throw new Error(`no @electron/asar package.json above ${entry}`);
    }
  }
}

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
