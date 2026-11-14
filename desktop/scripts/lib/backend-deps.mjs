import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * Installs the backend's production dependencies the way the Dockerfile's deps
 * stage does: `npm ci --omit=dev` from backend/package.json and the lockfile
 * alone, in a temp directory, so nothing in backend/node_modules (a dev
 * install, or a symlink to one) leaks in. No --libc=musl: the target is
 * Windows. The backend has no patches and no postinstall of its own; the only
 * install script of note is @scarf/scarf's telemetry, switched off by
 * SCARF_ANALYTICS=false. Moves the result to `dest`.
 */
export function installBackendDeps({
  backendDir,
  dest,
  run = spawnSync,
  tmpRoot = os.tmpdir(),
  env = process.env,
}) {
  const work = fs.mkdtempSync(path.join(tmpRoot, "monize-backend-deps-"));
  try {
    for (const name of ["package.json", "package-lock.json"]) {
      fs.copyFileSync(path.join(backendDir, name), path.join(work, name));
    }
    const win = process.platform === "win32";
    const result = run(
      win ? "npm.cmd" : "npm",
      ["ci", "--omit=dev", "--no-audit", "--no-fund"],
      {
        cwd: work,
        stdio: "inherit",
        shell: win,
        env: { ...env, SCARF_ANALYTICS: "false" },
      },
    );
    if (result.error || result.status !== 0) {
      throw new Error(
        `npm ci --omit=dev failed in a temp copy of backend/ (${result.error ? result.error.message : `exit ${result.status}`})`,
      );
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(path.join(work, "node_modules"), dest, { recursive: true });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
