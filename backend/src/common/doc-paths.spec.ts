import { readFileSync } from "fs";
import { basename, join } from "path";

import {
  buildIndex,
  classifySpan,
  docSpans,
  FileIndex,
  planProblem,
  strictProblem,
} from "./repo-paths.util";
import { findRepoRoot, gitListFiles, requireRepoRoot } from "./repo-tree.util";

/**
 * A doc that names a file is making a claim about the source tree.
 *
 * The rule is already written down in `AGENTS.md` -- rename or delete a
 * file and grep `docs/` and every `CLAUDE.md` in the same commit -- and it was
 * still broken: the cross-owner-transfers plan pointed into
 * `backend/src/ai/query/` for a service that lives at
 * `backend/src/transactions/transaction-tool-prep.service.ts`, so anyone
 * following the path would find nothing and either hunt for it or create a
 * second one. A rule in prose gets read, agreed with, and violated anyway; this
 * is the version the machine checks.
 *
 * The claim grammar (rooted / relative / bare, cross-tree exemptions, line
 * references) lives in `repo-paths.util.ts`, shared with the source-comment
 * guard (`source-comment-paths.spec.ts`) so it is written once. This file owns
 * the *doc* policy on top of it:
 *
 *  - In `docs/future-plans/` a path may name a file that does not exist yet --
 *    that is what a plan is for -- so non-existence alone proves nothing there.
 *    What a plan must not do is name a file that exists *somewhere else*: an
 *    unresolved path whose basename lives at another location is not a planned
 *    file, it is a stale reference to a moved or renamed one (`planProblem`).
 *    The blind spot is deliberate and named: a plan referencing a file that was
 *    *deleted* outright cannot be told from a planned one.
 *  - `docs/release-notes/` and `docs/audits/` are shipped historical records --
 *    editing them to match a later tree would falsify them -- so they are out of
 *    scope. Fenced code blocks are stripped before scanning (`docSpans`): they
 *    are sample code, where a hypothetical path is legitimate; the claim idiom
 *    is the inline span.
 *
 * The same grammar decides the inverse case: a doc asserting that a file is
 * *absent* -- `docs/release-integrity.md`'s gap register says the repository has
 * no branch-protection policy in it -- names it in plain prose rather than in a
 * span, because a span here means "this is here" and that doc is arguing the
 * opposite. Re-backticking such a name fails this suite, which is the intended
 * outcome: the day the file lands, the span is correct again.
 *
 * The inventory comes from `git ls-files`, so the guard sees exactly the tree
 * CI sees and needs no hand-maintained skip list: `node_modules`, build output
 * and local agent scratch are simply not tracked. Docs are collected from the
 * tracked list too, so an untracked draft never gates anything. Existence
 * checks include untracked-but-not-ignored files, so a doc committed alongside
 * a file it names does not fail locally before the file is staged.
 */

// ---------------------------------------------------------------------------
// The grammar, pinned. These are the decisions a reader of a finding will
// question, so each is a test rather than a comment.
// ---------------------------------------------------------------------------

describe("doc path grammar", () => {
  const kinds = (span: string) => classifySpan(span).kind;

  it("classifies the three claim strengths", () => {
    expect(classifySpan("backend/src/app.module.ts")).toEqual({
      kind: "rooted",
      path: "backend/src/app.module.ts",
    });
    expect(classifySpan("map/map-loans.ts")).toEqual({
      kind: "relative",
      path: "map/map-loans.ts",
    });
    expect(classifySpan("schema.sql")).toEqual({
      kind: "bare",
      path: "schema.sql",
    });
    // The bare claim exists so this exact span -- a migration that was never in
    // the tree, cited by a contract -- cannot escape on having no slash.
    expect(kinds("133_currency_global_liveness.sql")).toBe("bare");
  });

  it("roots the desktop and mobile layers", () => {
    expect(classifySpan("desktop/src/version.spec.ts")).toEqual({
      kind: "rooted",
      path: "desktop/src/version.spec.ts",
    });
    expect(kinds("mobile/package.json")).toBe("rooted");
  });

  it("treats a line reference as a claim about its path", () => {
    expect(classifySpan("database/schema.sql:705-795")).toEqual({
      kind: "rooted",
      path: "database/schema.sql",
    });
    expect(classifySpan("delegation/delegation.module.ts:46")).toEqual({
      kind: "relative",
      path: "delegation/delegation.module.ts",
    });
  });

  it("exempts a branch-qualified path explicitly, not by accident", () => {
    // The escape hatch `AGENTS.md` prescribes for paths in other
    // branches. It used to survive only because `:` was missing from a
    // character class; this is the deliberate version.
    expect(
      kinds("poc/import-from-dotmny:migration/ms-money-data-model.md"),
    ).toBe("cross-tree");
    expect(kinds("ghcr.io/kenlasko/monize-backend:latest")).toBe("cross-tree");
  });

  it("does not read prose, globs, templates or placeholders as paths", () => {
    expect(kinds("GET /transactions/:id/linked")).toBe("not-path");
    expect(kinds("src/**/*.ts")).toBe("not-path");
    expect(kinds("messages/{locale}/{namespace}.json")).toBe("not-path");
    expect(kinds("NNN_description.sql")).toBe("not-path");
    expect(kinds("0NN_rls_helpers_and_trigger.sql")).toBe("not-path");
    expect(kinds("YYYYMMDDHHMMSS_description.sql")).toBe("not-path");
    expect(kinds(".../interceptors/request-context.interceptor.ts")).toBe(
      "not-path",
    );
    expect(kinds(".controller.spec.ts")).toBe("not-path"); // an extension, named
    expect(kinds("/app/dist/main.js")).toBe("not-path");
    expect(
      kinds("https://github.com/kenlasko/monize/blob/main/README.md"),
    ).toBe("not-path");
  });

  it("flags a plan claim whose basename lives elsewhere, and only that", () => {
    const index = buildIndex([
      "backend/src/database/seed.service.ts",
      "backend/src/transactions/transaction-tool-prep.service.ts",
    ]);
    // The two references the original guard missed by excluding future-plans:
    // seed.service.ts claimed at a path it moved away from.
    expect(planProblem("database/seed.service.ts", index)).toContain(
      "backend/src/database/seed.service.ts",
    );
    // The guard's own motivating defect, now in scope.
    expect(
      planProblem(
        "backend/src/ai/query/transaction-tool-prep.service.ts",
        index,
      ),
    ).toContain("backend/src/transactions/transaction-tool-prep.service.ts");
    // A genuinely planned file exists nowhere, and passes.
    expect(planProblem("docs/rls.md", index)).toBeNull();
    expect(planProblem("frontend/src/lib/vat.ts", index)).toBeNull();
    // A resolved claim passes under either check.
    expect(
      planProblem("backend/src/database/seed.service.ts", index),
    ).toBeNull();
  });

  it("strictly requires resolution outside future-plans, bare names included", () => {
    const index = buildIndex(["database/schema.sql"]);
    expect(strictProblem("schema.sql", index)).toBeNull();
    expect(strictProblem("133_currency_global_liveness.sql", index)).toContain(
      "does not resolve",
    );
    expect(strictProblem("database/schema.sql:705-795", index)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The tree itself.
// ---------------------------------------------------------------------------

const REPO_ROOT = findRepoRoot(__dirname);

const describeTree = REPO_ROOT || process.env.CI ? describe : describe.skip;

describeTree("docs name files that exist", () => {
  interface TreeData {
    index: FileIndex;
    contractDocs: string[];
    planDocs: string[];
  }
  let cached: TreeData | undefined;

  const load = (): TreeData => {
    if (cached) return cached;
    const root = requireRepoRoot(REPO_ROOT);
    // Existence is generous (tracked plus untracked-but-not-ignored, so a file
    // committed in the same change as the doc that names it passes before
    // staging); the docs that gate are the tracked ones only.
    const index = buildIndex(
      gitListFiles(root, "--cached --others --exclude-standard"),
    );
    const tracked = gitListFiles(root);
    // `docs/frontend/` and `docs/backend/` hold each layer's rules, moved out
    // of the layer's `CLAUDE.md` so that file could stay an index; they bind
    // exactly as a CLAUDE.md does and are scanned at the same strength.
    const contractDocs = tracked.filter(
      (f) =>
        basename(f) === "CLAUDE.md" ||
        basename(f) === "AGENTS.md" ||
        (/^docs\/((frontend|backend)\/)?[^/]+\.md$/.test(f) &&
          basename(f) !== "CLAUDE.md"),
    );
    const planDocs = tracked.filter((f) =>
      /^docs\/future-plans\/[^/]+\.md$/.test(f),
    );
    cached = { index, contractDocs, planDocs };
    return cached;
  };

  const problems = (
    docs: string[],
    check: (span: string, index: FileIndex) => string | null,
  ): string[] => {
    const { index } = load();
    const found: string[] = [];
    for (const doc of docs) {
      const text = readFileSync(join(REPO_ROOT as string, doc), "utf8");
      for (const span of docSpans(text)) {
        const problem = check(span, index);
        if (problem) found.push(`${doc}: ${problem}`);
      }
    }
    return found;
  };

  it("scans the contracts it claims to scan", () => {
    // A broken inventory would make every assertion below vacuous.
    const { index, contractDocs, planDocs } = load();
    expect(contractDocs.some((d) => d.endsWith("/CLAUDE.md"))).toBe(true);
    expect(contractDocs).toContain("docs/financial-calculation-contract.md");
    expect(contractDocs).toContain("docs/frontend/ui-conventions.md");
    expect(contractDocs).toContain("docs/backend/testing.md");
    expect(contractDocs).toContain("AGENTS.md");
    expect(contractDocs.length).toBeGreaterThan(5);
    expect(planDocs.length).toBeGreaterThan(5);
    expect(index.list.length).toBeGreaterThan(500);
  });

  it("resolves every path a binding contract names", () => {
    // A doc describing a file that is not there gets read, believed, and built
    // on -- or sends the reader to create a duplicate at the path it names.
    expect(problems(load().contractDocs, strictProblem)).toEqual([]);
  });

  it("finds no moved or renamed file behind a future-plans path", () => {
    // Weaker than the strict claim on purpose -- a plan names unbuilt files --
    // but exactly strong enough for the failure mode that motivated this
    // guard, which lived in future-plans and the original scope could not see.
    expect(problems(load().planDocs, planProblem)).toEqual([]);
  });
});
