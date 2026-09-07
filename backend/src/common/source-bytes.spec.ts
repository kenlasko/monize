import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";

/**
 * A raw control byte in a source file makes every text tool treat that file as
 * binary. `grep` prints "binary file matches" and no line, `file` reports
 * "data", `git diff` shows "Binary files differ", and a source-scanning guard
 * test that reads the file as UTF-8 gets a string it can still match -- but a
 * human reviewing the diff, or grepping for the pattern, sees nothing.
 *
 * This is not hypothetical. `support-backup-integrity.ts` carried a literal NUL
 * as the separator joining unique-key group columns. The choice of a NUL was
 * correct (a printable separator would fold ("a", "b") and ("a b", "") into one
 * group and suffix a name that never collided); writing it as the byte rather
 * than as a `\u0000` escape was not, and it hid the whole file from review for as long
 * as it was there.
 *
 * The rule is therefore mechanical: express a control character as an escape.
 * Tab, LF and CR are exempt -- they are ordinary whitespace in source.
 */
describe("source files contain no raw control bytes", () => {
  const REPO_ROOT = resolve(__dirname, "..", "..", "..");

  const SKIP_DIRS = new Set([
    ".git",
    // Local agent workspace: untracked scratch worktrees and drafts, not
    // repository content -- CI never has it, a contributor's clone may.
    ".claude",
    "node_modules",
    "dist",
    "coverage",
    ".next",
    "test-results",
    "playwright-report",
    ".turbo",
    // Third-party build artefacts copied in at build time, not repository
    // content: `frontend/public/vendor/opencv/opencv.js` is a 13 MB
    // WebAssembly build whose payload is legitimately full of control bytes.
    // Same situation as `.claude` above, inverted -- a contributor who has
    // built the frontend has it, a fresh checkout does not.
    "vendor",
  ]);

  const SCANNED_EXTENSIONS = [
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".cjs",
    ".json",
    ".sql",
    ".md",
    ".yaml",
    ".yml",
    ".sh",
  ];

  /** Tab, LF and CR are legitimate whitespace; every other C0 byte is not. */
  const isForbidden = (byte: number): boolean =>
    byte === 0x7f ||
    (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d);

  const collect = (dir: string, out: string[]): string[] => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (!SKIP_DIRS.has(entry)) collect(full, out);
        continue;
      }
      if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
    }
    return out;
  };

  it("scans a plausible number of files, so a broken walk cannot pass vacuously", () => {
    // A guard that silently scanned nothing would be green forever.
    expect(collect(REPO_ROOT, []).length).toBeGreaterThan(500);
  });

  it("finds no file carrying one", () => {
    const offenders: string[] = [];
    for (const file of collect(REPO_ROOT, [])) {
      const bytes = readFileSync(file);
      const found = new Set<number>();
      for (const byte of bytes) if (isForbidden(byte)) found.add(byte);
      if (found.size > 0) {
        const codes = [...found]
          .map((b) => `0x${b.toString(16).padStart(2, "0")}`)
          .join(", ");
        offenders.push(`${relative(REPO_ROOT, file)} (${codes})`);
      }
    }
    // Named in the failure so the fix is "write it as an escape", not a hunt.
    expect(offenders).toEqual([]);
  });
});
