import fs from "node:fs";
import path from "node:path";

/** Matches one path segment against a pattern whose only wildcard is `*`. */
export function globToRegExp(pattern) {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/\\\\]*");
  return new RegExp(`^${escaped}$`);
}

/** True when `name` matches any of the `*` patterns. */
export function matchesAny(name, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(name));
}

/**
 * Copies one source into `dest`. `src` is a file, a directory, or a path whose
 * last segment holds a `*` glob (files only, no recursion). A directory is
 * copied into `dest` itself (its contents, not the directory); a file is
 * copied to `dest` when `dest` does not exist as a directory, otherwise into
 * it; a glob's matches go into the directory `dest`. Symlinks are followed
 * when `dereference` is set, because Windows packaging cannot carry them.
 * Names matching `exclude` (by basename, at any depth) are skipped.
 * Returns the number of files copied.
 */
export function copySource({ src, dest, exclude = [], dereference = false }) {
  const base = path.basename(src);
  if (base.includes("*")) {
    const dir = path.dirname(src);
    const re = globToRegExp(base);
    const names = fs
      .readdirSync(dir)
      .filter((name) => re.test(name) && !matchesAny(name, exclude))
      .filter((name) => fs.statSync(path.join(dir, name)).isFile());
    if (names.length === 0) {
      throw new Error(`nothing matches ${src}`);
    }
    fs.mkdirSync(dest, { recursive: true });
    for (const name of names) {
      fs.copyFileSync(path.join(dir, name), path.join(dest, name));
    }
    return names.length;
  }

  if (!fs.existsSync(src)) {
    throw new Error(`missing source ${src}`);
  }
  let copied = 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    dereference,
    filter: (from) => {
      if (matchesAny(path.basename(from), exclude)) {
        return false;
      }
      if (fs.statSync(from).isFile()) {
        copied += 1;
      }
      return true;
    },
  });
  return copied;
}

/** Total size in bytes of a file or directory tree (symlinks counted as links). */
export function sizeOf(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory()) {
    return stat.size;
  }
  let total = 0;
  for (const name of fs.readdirSync(target)) {
    total += sizeOf(path.join(target, name));
  }
  return total;
}

export function formatSize(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}
