import fs from "node:fs";
import path from "node:path";

/**
 * Files Node never executes: declarations, source maps, TypeScript sources
 * shipped beside the compiled JavaScript, and Markdown.
 */
const PRUNED_EXTENSIONS = [
  ".d.ts",
  ".d.mts",
  ".d.cts",
  ".map",
  ".ts",
  ".mts",
  ".cts",
  ".md",
  ".markdown",
];

/** Third-party licences must ship with a redistributed app, whatever the extension. */
const KEPT_PREFIX = /^(licen[cs]e|notice|copying|authors)/i;

/** True for a licence, notice, copying or authors file, whatever its extension. */
export function isLicenceName(baseName) {
  return KEPT_PREFIX.test(baseName);
}

/**
 * True when a file with this base name is never loaded by Node and carries no
 * licence: the one rule the prune applies. `package.json` and every extension
 * not listed above (js, json, node, wasm, ...) are kept.
 */
export function isPrunable(baseName) {
  if (baseName === "package.json" || KEPT_PREFIX.test(baseName)) {
    return false;
  }
  const lower = baseName.toLowerCase();
  return PRUNED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Number of non-directory entries under `root` (symlinks counted, not followed). */
export function countFiles(root) {
  let count = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(path.join(root, entry.name)) : 1;
  }
  return count;
}

/**
 * Deletes every prunable regular file under `root` (symlinks are left alone)
 * and the directories that emptied. Returns the removed paths and the file
 * counts before and after.
 */
export function pruneTree(root) {
  const before = countFiles(root);
  const removed = [];
  const walk = (dir) => {
    let removedBelow = false;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        removedBelow = walk(full) || removedBelow;
      } else if (entry.isFile() && isPrunable(entry.name)) {
        fs.rmSync(full);
        removed.push(full);
        removedBelow = true;
      }
    }
    if (removedBelow && dir !== root && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
    return removedBelow;
  };
  walk(root);
  return { removed, before, after: before - removed.length };
}
