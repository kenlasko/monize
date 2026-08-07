import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";

/**
 * RLS task L1: files allowed to import `common/db/with-context`.
 *
 * `withSystemContext` bypasses row-level security, so a new importer is a
 * reviewed decision, not a drive-by fix: add the file here, in the same PR,
 * with a justification in the PR description. The list was derived from the
 * real tree when the R1-R7 refactors finished (guards/strategies, cron
 * entry points, seeders, bootstrap hooks, admin, backup, the MCP transport,
 * and the interceptor that seeds request scope) -- every entry wraps an
 * out-of-request call path or a genuinely cross-user sweep documented in
 * docs/future-plans/row-level-security-tasks.md (C1-C4, C6, R6/R7).
 */
const WITH_CONTEXT_ALLOWLIST = [
  "src/accounts/accounts.service.ts",
  "src/accounts/mortgage-reminder.service.ts",
  "src/action-history/action-history.service.ts",
  "src/admin/admin.service.ts",
  "src/ai/ai-usage.service.ts",
  "src/ai/insights/ai-insights.service.ts",
  "src/auth/auth.controller.ts",
  "src/auth/auth.service.ts",
  "src/auth/pat.service.ts",
  "src/auth/strategies/jwt.strategy.ts",
  "src/auth/token.service.ts",
  "src/backup/auto-backup.service.ts",
  // `withPreserveTimestamps` (identity inherited, never granted) around the
  // restore's single transaction, so the GUC-aware `updated_at` trigger keeps
  // the backup's own timestamps. It moved here from `backup.service.ts` when
  // issue #1092 split the restore out; the facade no longer touches the module.
  "src/backup/backup-restore.service.ts",
  "src/budgets/budget-alert.service.ts",
  "src/budgets/budget-period-cron.service.ts",
  "src/common/interceptors/request-context.interceptor.ts",
  // Cross-replica job coordination: claimOnce/claimLease write to a global
  // claims table that belongs to no single user, from cron entry points with no
  // request to inherit an identity from -- system context by construction.
  "src/common/jobs/job-claim.service.ts",
  "src/currencies/currencies.service.ts",
  "src/currencies/exchange-rate.service.ts",
  "src/database/demo-reset.service.ts",
  "src/database/demo-seed.service.ts",
  "src/database/seed.service.ts",
  "src/delegation/cross-owner-access.service.ts",
  // Owner <-> delegate management. `users_self` exposes only the caller's own
  // row, so an owner cannot see the login they provisioned and a delegate
  // cannot see the owner they act for -- both halves of Shared Access are
  // cross-user by construction. Delegate-side reads of the owner take
  // withDelegateContext (no bypass); the owner-side management of another
  // person's login takes withSystemContext, always after the delegation row
  // has been read under the owner's own scope. See DelegationService.
  "src/delegation/delegation.service.ts",
  "src/delegation/guards/account-delegate.guard.ts",
  // Joint accounts: one system-context read, the owner-label lookup (the
  // grantee's session cannot see the owner's users row under enforcement;
  // only the display label leaves the method).
  "src/delegation/joint-accounts.service.ts",
  // Joint register writes: authorization-decision row load plus the
  // owner-scoped mutation window, both fully decided by jointAccessFor
  // before the bypass opens (joint-accounts spec W1).
  "src/transactions/joint-register.service.ts",
  "src/emergency-access/emergency-access-claim.controller.ts",
  "src/emergency-access/emergency-access-monitor.service.ts",
  "src/import/mny/mny-import-job.service.ts",
  "src/import/mny/mny-import.service.ts",
  "src/import/mny/mny-staging.service.ts",
  "src/mcp/mcp-http.controller.ts",
  "src/mcp/tools/transactions.tool.ts",
  // Joint accounts (N1): refreshing a stale joint account's current-month
  // snapshot runs recalculateAccount under withUserContext(ownerUserId) so
  // the owner-keyed mab rows are written with the correct identity.
  // The stale-snapshot sweep is likewise a cross-user cron fan-out (system
  // context) whose per-account body runs as the owning user -- there is no
  // request to inherit an identity from (DR-04-03).
  "src/net-worth/net-worth.service.ts",
  "src/notifications/bill-reminder.service.ts",
  "src/oauth/oauth-interaction.controller.ts",
  "src/oauth/oauth-provider.service.ts",
  "src/scheduled-transactions/scheduled-transactions.service.ts",
  "src/securities/holdings.service.ts",
  // The market-index refresh is a deployment-wide cron with no request behind
  // it: the rows it writes are global reference data with no owner, exactly like
  // the exchange-rate refresh above.
  "src/securities/market-index.service.ts",
  "src/securities/securities.controller.ts",
  "src/securities/security-price.service.ts",
  "src/transactions/transaction-transfer.service.ts",
];

/**
 * `no-restricted-imports` entry banning repository injection. Shared by the
 * general block and the allowlist override below -- flat config replaces a
 * rule's whole options object per block, so the override must restate this ban
 * or silently drop it.
 */
const BAN_INJECT_REPOSITORY = {
  name: "@nestjs/typeorm",
  importNames: ["InjectRepository"],
  message:
    "All data access goes through withScopedDb (src/common/db/scoped-db.ts) -- " +
    "get repositories from the transaction's EntityManager instead of injecting them (RLS task L1).",
};

const BAN_WITH_CONTEXT = {
  group: ["**/db/with-context", "./with-context"],
  message:
    "common/db/with-context is import-restricted: withSystemContext bypasses row-level " +
    "security, so a new importer must be added to WITH_CONTEXT_ALLOWLIST in eslint.config.mjs " +
    "as a reviewed decision (RLS task L1).",
};

/**
 * DR-03: files allowed to import the `OAuthPayload` entity.
 *
 * `oauth_payloads` is the one *application* table reached without
 * `withScopedDb` -- `node-oidc-provider` is mounted as raw Express middleware
 * (`main.ts`), outside the Nest request pipeline, so its adapter holds a bare
 * `DataSource` and runs with no ambient identity at all. That is safe only
 * because the table is RLS-exempt, has no owner column, and is keyed by opaque
 * provider ids; it is **not** precedent for any user-owned table. The boundary,
 * the review triggers and the two permitted access paths are
 * `docs/row-level-security-contract.md`.
 *
 * The ban is on the *import*, not on `getRepository`: `m.getRepository(X)` off a
 * scoped `EntityManager` is the correct pattern everywhere in this codebase, so
 * a `no-restricted-syntax` selector for it would fire on hundreds of correct
 * call sites -- and `src/common/db/lint-bans.spec.ts` scrapes exactly that
 * selector shape out of this file and then requires `CLAUDE.md` and
 * `CONTRIBUTING.md` to name the banned call, which would put false guidance in
 * the instruction files. `src/oauth/oauth-payload-access.spec.ts` covers what
 * an import ban cannot: a re-export laundering the entity, or raw SQL naming
 * the table.
 */
const OAUTH_PAYLOAD_ALLOWLIST = [
  "src/oauth/entities/oauth-payload.entity.ts",
  "src/oauth/oauth.module.ts",
  // The `oidc-provider` Adapter implementation -- the reason the exception
  // exists. Every method is keyed by an opaque provider id.
  "src/oauth/postgres.adapter.ts",
  // `revokeAllForUser`, the second access path, and the one the exemption's
  // original rationale claimed did not exist ("never queried per end-user").
  // It deletes by `payload ->> 'accountId'`, so it IS keyed by an application
  // user id -- admin-initiated only, id server-derived, never request-supplied.
  // Documented as a bounded exception in the contract; a third such query is a
  // deliberate edit here, not an unnoticed one.
  "src/oauth/oauth-provider.service.ts",
];

const BAN_OAUTH_PAYLOAD_ENTITY = {
  group: [
    "**/oauth/entities/oauth-payload.entity",
    "**/entities/oauth-payload.entity",
    "./entities/oauth-payload.entity",
    "./oauth-payload.entity",
  ],
  message:
    "OAuthPayload is import-restricted: oauth_payloads is RLS-exempt and reached without " +
    "withScopedDb, so a new production reader must be added to OAUTH_PAYLOAD_ALLOWLIST in " +
    "eslint.config.mjs as a reviewed decision. This exception does not extend to user-owned " +
    "tables -- see docs/row-level-security-contract.md (DR-03).",
};

/**
 * `no-restricted-imports` options for a block, given the pattern bans that
 * block deliberately lifts.
 *
 * Flat config replaces a rule's whole options object per block, so an override
 * must restate every ban it does *not* mean to lift -- the trap the comment on
 * BAN_INJECT_REPOSITORY names. Two allowlists now overlap
 * (`src/oauth/oauth-provider.service.ts` is in both), so which bans survive is
 * computed per file group rather than written out four times. Writing a list
 * out four times is exactly what produced the drifted RLS exemption arrays;
 * see `src/common/db/rls-exempt-tables.ts`.
 *
 * `BAN_INJECT_REPOSITORY` is never lifted by any override.
 */
const importRule = (lifted = []) => {
  const patterns = [BAN_WITH_CONTEXT, BAN_OAUTH_PAYLOAD_ENTITY].filter(
    (ban) => !lifted.includes(ban),
  );
  return [
    "error",
    patterns.length
      ? { paths: [BAN_INJECT_REPOSITORY], patterns }
      : { paths: [BAN_INJECT_REPOSITORY] },
  ];
};

const inBothAllowlists = OAUTH_PAYLOAD_ALLOWLIST.filter((file) =>
  WITH_CONTEXT_ALLOWLIST.includes(file),
);
const withContextOnly = WITH_CONTEXT_ALLOWLIST.filter(
  (file) => !OAUTH_PAYLOAD_ALLOWLIST.includes(file),
);
const oauthPayloadOnly = OAUTH_PAYLOAD_ALLOWLIST.filter(
  (file) => !WITH_CONTEXT_ALLOWLIST.includes(file),
);

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintPluginPrettier,
  {
    languageOptions: {
      sourceType: "module",
    },
    rules: {
      "no-new-func": "error",
      "@typescript-eslint/interface-name-prefix": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // RLS task L1: production src/ never injects repositories, never opens a
    // manual QueryRunner, and imports the context helpers only from the
    // allowlist. Specs and the test harness stay exempt (they mock these), as
    // does scoped-db.ts -- the one sanctioned door to the database.
    files: ["src/**/*.ts"],
    ignores: [
      "src/**/*.spec.ts",
      "src/test-helpers/**",
      "src/common/db/scoped-db.ts",
    ],
    rules: {
      // Every line the server writes goes through the NestJS Logger, so the
      // whole log carries the same `[Nest] pid - date LEVEL [Context] message`
      // shape. `Logger` works outside an application context, so the pre-boot
      // scripts (db-init, db-migrate, seed) use it too. The one sanctioned
      // exception is the oidc-provider log bridge, which has to hold the real
      // console methods to forward everything that is not a provider notice.
      "no-console": "error",
      "no-restricted-imports": importRule(),
      "no-restricted-syntax": [
        "error",
        {
          selector: 'CallExpression[callee.property.name="createQueryRunner"]',
          message:
            "Manual QueryRunners bypass withScopedDb's transaction + identity GUCs -- use " +
            "withScopedDb(this.dataSource, async (m) => { ... }) instead (RLS task L1).",
        },
        {
          // The `createQueryRunner` ban never covered this, and contributor
          // guidance recommended it: `dataSource.transaction(fn)` opens a
          // transaction that is unaware of the ambient scoped manager. Under
          // RLS_MODE=enforce it carries no identity GUCs and fails closed; at
          // `off` it loses defence in depth; and nested inside a caller's
          // withScopedDb it commits independently, so the outer rollback cannot
          // take it back. scoped-db.ts is the one place that may call it.
          selector: 'CallExpression[callee.property.name="transaction"]',
          message:
            "DataSource.transaction() opens a transaction outside the active scoped manager -- " +
            "no identity GUCs, and it commits independently of the caller's rollback. Use " +
            "withScopedDb(this.dataSource, async (m) => { ... }), which joins the ambient " +
            "transaction when there is one (RLS task L1).",
        },
      ],
    },
  },
  {
    // The allowlisted with-context importers keep every other ban -- including
    // the OAuthPayload one, which is why this block is not simply the whole
    // WITH_CONTEXT_ALLOWLIST any more.
    files: withContextOnly,
    rules: {
      "no-restricted-imports": importRule([BAN_WITH_CONTEXT]),
    },
  },
  {
    // The allowlisted OAuthPayload importers keep every other ban.
    files: oauthPayloadOnly,
    rules: {
      "no-restricted-imports": importRule([BAN_OAUTH_PAYLOAD_ENTITY]),
    },
  },
  {
    // Files on both allowlists. Without this block the later of the two
    // overrides above would silently reinstate the ban the earlier one lifted:
    // `src/oauth/oauth-provider.service.ts` legitimately imports both
    // `with-context` and the entity.
    files: inBothAllowlists,
    rules: {
      "no-restricted-imports": importRule([
        BAN_WITH_CONTEXT,
        BAN_OAUTH_PAYLOAD_ENTITY,
      ]),
    },
  },
  {
    ignores: ["dist/", "node_modules/", "coverage/"],
  },
);
