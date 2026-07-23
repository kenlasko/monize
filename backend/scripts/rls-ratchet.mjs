#!/usr/bin/env node
/**
 * RLS ratchet: a CI gate on the number of remaining injected-repository and
 * hand-rolled QueryRunner data-access sites under `src/`.
 *
 * Row-Level Security requires every DB operation to run through `tenantTx`
 * (which sets the identity GUC transaction-locally). A leftover
 * `@InjectRepository(...)` repo or a raw `dataSource.createQueryRunner()` runs
 * with NO GUC -- under enforcement that is a silent fail-closed zero-row result.
 * The service refactors (tasks R1-R7) drive these counts to zero; until then
 * this ratchet makes the counts monotonically non-increasing: adding a new site
 * fails CI, and a refactor that removes sites must lower the baseline in the
 * same PR (so the reduction is visible and reviewed). Superseded by an ESLint
 * ban once the counts hit zero (task L1).
 *
 * Counting is by CALL SITE (every occurrence of the token), not by file, so the
 * ratchet has fine-grained resolution as the refactors proceed.
 *
 * Usage:
 *   node scripts/rls-ratchet.mjs           # check against the baseline (CI gate)
 *   node scripts/rls-ratchet.mjs --update  # rewrite the baseline to current counts
 *
 * See docs/future-plans/row-level-security-tasks.md (task F3).
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");
const baselinePath = join(here, "rls-ratchet-baseline.json");
const baselineDisplay = "backend/scripts/rls-ratchet-baseline.json";

/**
 * The tracked patterns. `key` is the baseline JSON field; `label` is shown to
 * humans; `regex` is global so every occurrence on a line is counted.
 */
export const PATTERNS = [
  { key: "injectRepository", label: "@InjectRepository(", regex: /@InjectRepository\(/g },
  { key: "createQueryRunner", label: "createQueryRunner(", regex: /createQueryRunner\(/g },
];

/**
 * Files that legitimately hold these tokens and must never count against the
 * ratchet: tests (mocks/fixtures), type decls, and `tenant-tx.ts` itself (the
 * one sanctioned door to the DB, on the L1 lint allowlist). Paths are `src`-
 * relative with `/` separators.
 */
export function isExcluded(relPath) {
  if (relPath.endsWith(".spec.ts")) return true;
  if (relPath.endsWith(".d.ts")) return true;
  if (relPath === "common/db/tenant-tx.ts") return true;
  // Test-support directories, should any ever live under src/.
  if (/(^|\/)(__tests__|__mocks__|test|test-helpers)\//.test(relPath)) return true;
  return false;
}

/** Count every occurrence of `regex` in `source` (multiple per line included). */
export function countOccurrences(source, regex) {
  const matches = source.match(regex);
  return matches ? matches.length : 0;
}

/** Recursively list `.ts` files under `dir`, as `src`-relative POSIX paths. */
export function collectFiles(dir, root = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...collectFiles(abs, root));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(relative(root, abs).split(sep).join("/"));
    }
  }
  return out;
}

/** Compute current call-site counts for every pattern under `root` (default src). */
export function computeCounts(root = srcDir) {
  const counts = Object.fromEntries(PATTERNS.map((p) => [p.key, 0]));
  for (const relPath of collectFiles(root)) {
    if (isExcluded(relPath)) continue;
    const source = readFileSync(join(root, relPath), "utf8");
    for (const pattern of PATTERNS) {
      // Reset lastIndex is unnecessary with String.match (no /g state kept).
      counts[pattern.key] += countOccurrences(source, pattern.regex);
    }
  }
  return counts;
}

/**
 * Compare current `counts` against `baseline`. Returns a per-pattern verdict:
 *   - "ok"          actual === baseline
 *   - "regression"  actual  >  baseline  (a new banned site was added)
 *   - "stale"       actual  <  baseline  (sites were removed; lower the baseline)
 * plus an overall `ok` flag (true only when every pattern is "ok").
 */
export function evaluate(counts, baseline) {
  const results = PATTERNS.map((pattern) => {
    const actual = counts[pattern.key] ?? 0;
    const expected = baseline[pattern.key];
    let status;
    if (typeof expected !== "number") {
      status = "missing";
    } else if (actual > expected) {
      status = "regression";
    } else if (actual < expected) {
      status = "stale";
    } else {
      status = "ok";
    }
    return { key: pattern.key, label: pattern.label, actual, expected, status };
  });
  return { ok: results.every((r) => r.status === "ok"), results };
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch {
    return null;
  }
}

function writeBaseline(counts) {
  const ordered = Object.fromEntries(PATTERNS.map((p) => [p.key, counts[p.key]]));
  writeFileSync(baselinePath, JSON.stringify(ordered, null, 2) + "\n");
}

function main() {
  const update = process.argv.includes("--update");
  const counts = computeCounts();

  if (update) {
    writeBaseline(counts);
    console.log(`Updated ${baselineDisplay}:`);
    for (const p of PATTERNS) console.log(`  ${p.label.padEnd(22)} ${counts[p.key]}`);
    return;
  }

  const baseline = readBaseline();
  if (!baseline) {
    console.error(
      `RLS ratchet: baseline file missing (${baselineDisplay}).\n` +
        "Create it with: npm run rls:ratchet:update",
    );
    process.exit(1);
  }

  const { ok, results } = evaluate(counts, baseline);
  console.log("RLS data-access ratchet (call sites under src/):");
  for (const r of results) {
    const expected = typeof r.expected === "number" ? r.expected : "(unset)";
    console.log(`  ${r.label.padEnd(22)} actual ${r.actual}  baseline ${expected}  [${r.status}]`);
  }

  if (ok) {
    console.log("OK -- counts match the baseline.");
    return;
  }

  console.error("");
  for (const r of results.filter((x) => x.status !== "ok")) {
    if (r.status === "regression") {
      console.error(
        `FAIL: ${r.label} increased to ${r.actual} (baseline ${r.expected}). ` +
          "New injected repositories / hand-rolled QueryRunners are banned by the RLS ratchet -- " +
          "route DB access through tenantTx(this.dataSource, (m) => ...) instead. See F3.",
      );
    } else if (r.status === "stale") {
      console.error(
        `FAIL: ${r.label} dropped to ${r.actual} (baseline ${r.expected}). ` +
          `Lower it in ${baselineDisplay} in this same PR -- run: npm run rls:ratchet:update`,
      );
    } else if (r.status === "missing") {
      console.error(
        `FAIL: ${r.label} has no baseline entry. Run: npm run rls:ratchet:update`,
      );
    }
  }
  process.exit(1);
}

// Only run when invoked directly (not when imported by the self-test).
if (process.argv[1] && statSync(process.argv[1]).isFile()) {
  const invoked = fileURLToPath(import.meta.url);
  if (process.argv[1] === invoked) main();
}
