import { readFileSync } from "fs";
import { join } from "path";

import {
  findRepoRoot,
  gitListFiles,
  requireRepoRoot,
} from "../common/repo-tree.util";

/**
 * Every production path that reaches `oauth_payloads` is named here.
 *
 * `oauth_payloads` is the one *application* table read and written without
 * `withScopedDb`. `node-oidc-provider` is mounted as raw Express middleware
 * (`backend/src/main.ts`), outside the Nest request pipeline, so
 * `PostgresAdapter` holds a bare `DataSource` and runs with no ambient identity
 * at all -- not `withSystemContext`, as migration 114, the foot of
 * `database/schema.sql`, the RLS runbook and the C1 task record each claimed
 * for over a year. Nothing checked, so nothing noticed.
 *
 * That is safe only because the table is RLS-exempt, has no owner column, and
 * is keyed by opaque provider ids. It is **not** precedent for a user-owned
 * table, and the risk this guard exists for is a future service quietly
 * treating it as one. `docs/row-level-security-contract.md` is the boundary,
 * the rejected alternatives and the review triggers.
 *
 * Two layers, because neither alone is enough. `eslint.config.mjs` bans the
 * *import* outside `OAUTH_PAYLOAD_ALLOWLIST`; this spec covers what an import
 * ban cannot see -- a barrel or re-export laundering the entity (there is no
 * `index.ts` under `src/oauth/` today, and this fails if one appears), and raw
 * SQL naming the table directly, which involves no import at all.
 *
 * The inventory comes from `git ls-files`, not a hardcoded file list, so a file
 * split or rename cannot disarm it -- the failure mode `docs/backend/backup.md`
 * describes, where four guards went on passing while scanning code that had
 * moved out from under them.
 *
 * It lists untracked-but-not-ignored files too (`--others --exclude-standard`),
 * because the file this guard most wants to see is the one being added right
 * now. A tracked-only inventory passed cleanly against a barrel re-exporting
 * the entity purely because the barrel had not been `git add`ed yet -- green
 * locally, red in CI, which is the wrong way round for a guard whose job is to
 * make the author stop and think.
 */

/** Production files permitted to name the entity or the table. */
const ALLOWED: Record<string, string> = {
  "backend/src/oauth/entities/oauth-payload.entity.ts":
    "The entity definition itself.",
  "backend/src/oauth/oauth.module.ts":
    "Module wiring (TypeOrmModule.forFeature).",
  "backend/src/oauth/postgres.adapter.ts":
    "The oidc-provider Adapter implementation -- the reason the exception exists. " +
    "Every method is keyed by an opaque provider id (id/model/grantId/userCode/uid), " +
    "except sweepOAuthPayloads, the daily expiry sweep, keyed by expires_at alone.",
  "backend/src/oauth/oauth-provider.service.ts":
    "Constructs the adapter factory, and revokeAllForUser -- the second access " +
    "path, keyed by an application user id. Admin-initiated, id server-derived, " +
    "never request-supplied. Bounded exception, see the contract.",
  "backend/src/common/db/rls-exempt-tables.ts":
    "Declares the table exempt from RLS. Names it in order to exempt it; reaches " +
    "nothing.",
  "backend/src/backup/export-table-queries.ts":
    "Names the table in INTENTIONALLY_EXCLUDED_TABLES so a backup never carries " +
    "transient OIDC state. Excludes rather than reads.",
  "backend/src/admin/admin.service.ts":
    "Comment only: explains why deactivation revokes OIDC artifacts before " +
    "deleting the user, to avoid orphan rows.",
};

/** Anything naming the entity type or the table. */
const MENTIONS = /\bOAuthPayload\b|\boauth_payloads\b/;

const REPO_ROOT = findRepoRoot(__dirname);
const describeTree = REPO_ROOT || process.env.CI ? describe : describe.skip;

describeTree("oauth_payloads access is confined to the OAuth module", () => {
  const load = () => {
    const root = requireRepoRoot(REPO_ROOT);
    const production = gitListFiles(
      root,
      "--cached --others --exclude-standard",
    ).filter(
      (file) =>
        file.startsWith("backend/src/") &&
        file.endsWith(".ts") &&
        !file.endsWith(".spec.ts"),
    );
    const mentioning = production.filter((file) =>
      MENTIONS.test(readFileSync(join(root, file), "utf8")),
    );
    return { production, mentioning };
  };

  it("scans the tree it claims to scan", () => {
    // Anti-vacuity. A broken inventory or a regex matching nothing would make
    // the allowlist assertion below pass while checking no files at all.
    const { production, mentioning } = load();
    expect(production.length).toBeGreaterThan(300);
    expect(mentioning).toContain("backend/src/oauth/postgres.adapter.ts");
    expect(mentioning).toContain("backend/src/oauth/oauth-provider.service.ts");
  });

  it("names no production file outside the allowlist", () => {
    // A new entry here is a deliberate decision that needs a contract entry --
    // not a drive-by import. The eslint ban catches the import; this catches a
    // re-export and raw SQL, which the import ban cannot see.
    const unexpected = load().mentioning.filter((file) => !(file in ALLOWED));
    expect(unexpected).toEqual([]);
  });

  it("keeps the allowlist honest about the tree", () => {
    // The other direction: an allowlist entry for a file that no longer
    // mentions the table is a stale permission, and an entry for a file that no
    // longer exists is how an allowlist outlives the thing it described.
    const { mentioning } = load();
    const stale = Object.keys(ALLOWED).filter(
      (file) => !mentioning.includes(file),
    );
    expect(stale).toEqual([]);
  });

  it("gives every allowlist entry a reason", () => {
    const unjustified = Object.entries(ALLOWED)
      .filter(([, reason]) => reason.trim().length < 20)
      .map(([file]) => file);
    expect(unjustified).toEqual([]);
  });

  it("points the adapter at the contract", () => {
    // The file had no comment at all explaining why it bypasses withScopedDb,
    // which is how the rationale came to live only in SQL comments that were
    // wrong. A reader arriving at the bare DataSource must find the boundary.
    const adapter = readFileSync(
      join(requireRepoRoot(REPO_ROOT), "backend/src/oauth/postgres.adapter.ts"),
      "utf8",
    );
    expect(adapter).toContain("docs/row-level-security-contract.md");
  });
});
