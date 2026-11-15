import fs from "node:fs";
import path from "node:path";
import { isLicenceName, isPrunable } from "./prune.mjs";

/**
 * The conditions Node itself matches when resolving `exports`. Any other one
 * (types, typings, browser, a package's own "@zod/source") is never taken by a
 * plain `node dist/main.js`, so a target behind it is not a runtime entry.
 */
const NODE_CONDITIONS = new Set([
  "node",
  "import",
  "require",
  "default",
  "node-addons",
  "module-sync",
]);

/** Every target a package.json's `exports` declares that Node can load. */
function exportTargets(node, out) {
  if (typeof node === "string") {
    out.push(node);
  } else if (Array.isArray(node)) {
    node.forEach((item) => exportTargets(item, out));
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith(".") || NODE_CONDITIONS.has(key)) {
        exportTargets(value, out);
      }
    }
  }
  return out;
}

/** The runtime entry points one package.json declares, as relative strings. */
export function entryPointsOf(pkg) {
  const targets = [];
  for (const field of ["main", "module"]) {
    if (typeof pkg[field] === "string") targets.push(pkg[field]);
  }
  if (typeof pkg.bin === "string") {
    targets.push(pkg.bin);
  } else if (pkg.bin && typeof pkg.bin === "object") {
    targets.push(
      ...Object.values(pkg.bin).filter((v) => typeof v === "string"),
    );
  }
  exportTargets(pkg.exports, targets);
  return targets.filter((t) => t.length > 0 && !t.startsWith("#"));
}

function holdsKeptFile(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() ? holdsKeptFile(full) : !isPrunable(entry.name)) {
      return true;
    }
  }
  return false;
}

/** Why `target` (relative to `pkgDir`) is broken, or null. Only explicit pruned extensions count. */
function problemWith(pkgDir, target) {
  const rel = target.replace(/^\.\//, "");
  if (rel.includes("*")) {
    const prefix = rel.slice(0, rel.indexOf("*"));
    const dir = path.join(
      pkgDir,
      prefix.endsWith("/") ? prefix : path.dirname(prefix),
    );
    return fs.existsSync(dir) &&
      fs.statSync(dir).isDirectory() &&
      holdsKeptFile(dir)
      ? null
      : "its pattern directory is gone or holds only pruned files";
  }
  const file = path.join(pkgDir, rel);
  if (fs.existsSync(file)) {
    return null;
  }
  return isPrunable(path.basename(rel)) ? "the file was pruned" : null;
}

/** The package.json files under `root`, never following symlinks. */
function packageJsonFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === "package.json")
        found.push(full);
    }
  };
  walk(root);
  return found;
}

/** The directory of the package a path under a node_modules belongs to. */
function packageRootOf(root, file) {
  const parts = path.relative(root, file).split(path.sep);
  const at = parts.lastIndexOf("node_modules");
  const nameLength = parts[at + 1]?.startsWith("@") ? 2 : 1;
  if (parts.length <= at + 1 + nameLength) {
    return null;
  }
  return path.join(root, ...parts.slice(0, at + 1 + nameLength));
}

/** True when `dir` still holds a file that is neither package.json nor a licence. */
function holdsRuntimeFile(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (
        entry.name !== "node_modules" &&
        holdsRuntimeFile(path.join(dir, entry.name))
      ) {
        return true;
      }
    } else if (entry.name !== "package.json" && !isLicenceName(entry.name)) {
      return true;
    }
  }
  return false;
}

/** Declarations, maps and Markdown: files that are never code Node could load. */
const NEVER_CODE = /\.d\.[cm]?ts$|\.map$|\.(md|markdown)$/i;

/**
 * Packages that shipped only declarations, maps and docs (@types/luxon): Node
 * could never load anything from them, so there is no entry point to break.
 */
function typesOnlyPackages(root, removed) {
  const byPackage = new Map();
  for (const file of removed) {
    const dir = packageRootOf(root, file);
    if (dir !== null) {
      byPackage.set(dir, [...(byPackage.get(dir) ?? []), file]);
    }
  }
  return new Set(
    [...byPackage]
      .filter(
        ([dir, files]) =>
          files.every((f) => NEVER_CODE.test(path.basename(f))) &&
          !holdsRuntimeFile(dir),
      )
      .map(([dir]) => dir),
  );
}

/**
 * Proves the prune changed nothing Node loads: every runtime entry point any
 * package declares still resolves, and no package lost its only code. Throws
 * naming the package and the target. `removed` is what pruneTree returned.
 */
export function assertEntryPointsIntact(root, removed = []) {
  const problems = [];
  const typesOnly = typesOnlyPackages(root, removed);
  let packages = 0;
  let targets = 0;
  for (const manifest of packageJsonFiles(root)) {
    const pkgDir = path.dirname(manifest);
    if (typesOnly.has(pkgDir)) continue;
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
    } catch {
      continue;
    }
    if (!pkg || typeof pkg !== "object") continue;
    packages += 1;
    const name = pkg.name ?? path.relative(root, pkgDir);
    for (const target of entryPointsOf(pkg)) {
      targets += 1;
      const why = problemWith(pkgDir, target);
      if (why) problems.push(`${name}: ${target} (${why})`);
    }
  }
  const touched = new Set(
    removed
      .map((file) => packageRootOf(root, file))
      .filter((dir) => dir !== null && !typesOnly.has(dir)),
  );
  for (const dir of touched) {
    if (!fs.existsSync(dir) || !holdsRuntimeFile(dir)) {
      problems.push(
        `${path.relative(root, dir)}: the prune removed every file but package.json and licences`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `the prune of the staged backend dependencies broke ${problems.length} entry point(s):\n${problems.map((p) => `  ${p}`).join("\n")}`,
    );
  }
  return { packages, targets, typesOnly: typesOnly.size };
}
