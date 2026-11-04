import { lstatSync, readFileSync, readlinkSync, statSync } from "fs";
import { basename, dirname, join, resolve } from "path";

import { findRepoRoot, gitListFiles, requireRepoRoot } from "./repo-tree.util";

/**
 * The instruction files are read on every task, so their size is a cost every
 * task pays. `frontend/CLAUDE.md` was compacted once (PR 1245) and grew back to
 * 188 KB, because each rule brought the defect it came from, the reasoning and
 * the guard along with it; the fix was to make the layer files indexes over
 * `docs/frontend/` and `docs/backend/`, where a rule is read only when the work
 * touches its subject, and to give the root file the same treatment.
 * `AGENTS.md` is the canonical, tool-agnostic entry point and says how the files
 * are organised; the root `CLAUDE.md` imports it and adds only Claude Code
 * specifics. Prose about file size is exactly the kind of rule that gets read,
 * agreed with and violated one paragraph at a time, so this is the version the
 * machine checks:
 *
 *  - every instruction file stays under its ceiling: `INSTRUCTION_FILE_MAX_BYTES`
 *    for the root and layer `CLAUDE.md` files, `AGENTS_FILE_MAX_BYTES` for
 *    `AGENTS.md`, which also carries the commands and the gate. Lower a ceiling
 *    as a file shrinks; never raise one to admit a paragraph;
 *  - every document under `docs/frontend/` and `docs/backend/` is named in both
 *    of its indexes, the layer `CLAUDE.md` an agent arrives from and the
 *    `docs/<layer>/README.md` a person browses, so a rule cannot be filed
 *    where no reader is sent and the two hand-written indexes cannot drift;
 *  - the adversarial review protocol exists once: Claude Code's copy is a
 *    symlink to the Codex skill, never a second file that can drift;
 *  - no instruction file carries an issue or PR number: that is the marker of a
 *    defect history, which belongs in the `docs/` entry beside the rule.
 *
 * The inventory comes from `git ls-files`, so a new document under either
 * directory is covered once it is staged.
 */

export const INSTRUCTION_FILE_MAX_BYTES = 16 * 1024;
/**
 * Codex concatenates every AGENTS.md it finds under a combined default cap of
 * 32 KiB (`project_doc_max_bytes`) and truncates past it, so the root file
 * leaves room for a global or nested one.
 */
export const AGENTS_FILE_MAX_BYTES = 26 * 1024;

/** Every file an agent reads before it starts, with the ceiling each is held to. */
const INSTRUCTION_FILES: ReadonlyArray<readonly [string, number]> = [
  ["AGENTS.md", AGENTS_FILE_MAX_BYTES],
  ["CLAUDE.md", INSTRUCTION_FILE_MAX_BYTES],
  ["frontend/CLAUDE.md", INSTRUCTION_FILE_MAX_BYTES],
  ["backend/CLAUDE.md", INSTRUCTION_FILE_MAX_BYTES],
  ["database/CLAUDE.md", INSTRUCTION_FILE_MAX_BYTES],
  ["e2e/CLAUDE.md", INSTRUCTION_FILE_MAX_BYTES],
  ["backend/src/mcp/CLAUDE.md", INSTRUCTION_FILE_MAX_BYTES],
];

/** The layers whose CLAUDE.md is an index over `docs/<layer>/`. */
const INDEXED_LAYERS = ["frontend", "backend"];

/**
 * One document loaded from two paths because each tool has its own skill
 * directory: Claude Code reads `.claude/commands/`, Codex reads
 * `.agents/skills/`. The first is a symlink to the second, so there is one
 * file to edit; replacing the link with a copy is how two versions would start.
 */
const SYMLINKED_FILES: ReadonlyArray<readonly [string, string]> = [
  [".claude/commands/audit.md", ".agents/skills/audit/SKILL.md"],
];

const ISSUE_NUMBER = /(?:^|[^\w`/])#\d{3,}\b/;

const REPO_ROOT = findRepoRoot(__dirname);
const describeTree = REPO_ROOT || process.env.CI ? describe : describe.skip;

describeTree("instruction files keep the shape `AGENTS.md` describes", () => {
  const root = () => requireRepoRoot(REPO_ROOT);
  const read = (relative: string) =>
    readFileSync(join(root(), relative), "utf8");
  const size = (relative: string) => statSync(join(root(), relative)).size;

  it.each(INSTRUCTION_FILES)(
    "%s stays under its ceiling of %d bytes",
    (relative, ceiling) => {
      expect(size(relative)).toBeLessThanOrEqual(ceiling);
    },
  );

  it.each(INDEXED_LAYERS)(
    "every docs/%s document is reachable from its layer index",
    (layer) => {
      const docs = gitListFiles(root(), `-- docs/${layer}`).filter(
        (f) => f.endsWith(".md") && basename(f) !== "README.md",
      );
      // A guard over an empty directory would prove nothing.
      expect(docs.length).toBeGreaterThan(3);
      const index = read(`${layer}/CLAUDE.md`);
      const readme = read(`docs/${layer}/README.md`);
      const unreachable = docs.filter((doc) => !index.includes(`\`${doc}\``));
      const unlisted = docs.filter(
        (doc) => !readme.includes(`\`${basename(doc)}\``),
      );
      expect({
        [`not named in ${layer}/CLAUDE.md`]: unreachable,
        [`not named in docs/${layer}/README.md`]: unlisted,
      }).toEqual({
        [`not named in ${layer}/CLAUDE.md`]: [],
        [`not named in docs/${layer}/README.md`]: [],
      });
    },
  );

  it.each(SYMLINKED_FILES)("%s is a symlink to %s", (link, target) => {
    const linkPath = join(root(), link);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(resolve(dirname(linkPath), readlinkSync(linkPath))).toBe(
      join(root(), target),
    );
  });

  it.each(INSTRUCTION_FILES.map(([relative]) => relative))(
    "%s carries no issue or PR number",
    (relative) => {
      const offending = read(relative)
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => ISSUE_NUMBER.test(line))
        .map(({ line, n }) => `${relative}:${n}: ${line.trim()}`);
      expect(offending).toEqual([]);
    },
  );
});

describe("the issue-number marker", () => {
  it("matches a defect citation and not a colour or an anchor", () => {
    expect(ISSUE_NUMBER.test("the panel is issue #1229")).toBe(true);
    expect(ISSUE_NUMBER.test("(#1247, INV-OCCURRENCE-003)")).toBe(true);
    expect(ISSUE_NUMBER.test("colour `#ffffff` on the card")).toBe(false);
    expect(ISSUE_NUMBER.test("a `#12` heading")).toBe(false);
    expect(ISSUE_NUMBER.test("/reports#1234-section")).toBe(false);
  });
});
