import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { copySource } from "./copy.mjs";

const PLATFORM_PACKAGES = {
  "win32-x64": "windows-x64",
  "linux-x64": "linux-x64",
};

/** The `@embedded-postgres/<x>` package name for this platform, or throws. */
export function postgresPackageName(platform, arch) {
  const suffix = PLATFORM_PACKAGES[`${platform}-${arch}`];
  if (!suffix) {
    throw new Error(
      `no embedded PostgreSQL package for ${platform}-${arch}; supported: ${Object.keys(PLATFORM_PACKAGES).join(", ")}`,
    );
  }
  return `@embedded-postgres/${suffix}`;
}

/**
 * Copies the platform package's native/ directory (bin, lib, share) into
 * `dest`. Fails naming the package when it is not installed; run
 * `npm ci` in desktop/ or pass --skip-postgres.
 */
export function stagePostgres({
  desktopRoot,
  dest,
  platform = process.platform,
  arch = process.arch,
}) {
  const name = postgresPackageName(platform, arch);
  const native = path.join(desktopRoot, "node_modules", name, "native");
  if (!fs.existsSync(native)) {
    throw new Error(
      `${name} is not installed in ${path.join(desktopRoot, "node_modules")} (expected ${native}). Run \`npm ci\` in desktop/, or pass --skip-postgres to stage without it.`,
    );
  }
  for (const dir of ["bin", "lib", "share"]) {
    if (!fs.existsSync(path.join(native, dir))) {
      throw new Error(`${native} has no ${dir}/ directory`);
    }
  }
  copySource({ src: native, dest, dereference: true });
}
