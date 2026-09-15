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
  // Blob-tombstone sweep: a cron fan-out that reclaims orphaned attachment
  // bytes across every user, and past them -- a tombstone outlives its owner
  // and its user_id is then NULL, so no user context can see it. No request to
  // inherit an identity from either; system context by construction.
  "src/attachments/attachment-orphan-sweeper.service.ts",
  "src/auth/auth.controller.ts",
  "src/auth/auth.service.ts",
  "src/auth/pat.service.ts",
  "src/auth/strategies/jwt.strategy.ts",
  "src/auth/token.service.ts",
  "src/backup/auto-backup.service.ts",
  // The off-machine copy of a completed artifact: dispatched on the tail of a
  // backup run, so it seeds the owner's own withUserContext -- no bypass.
  "src/backup/offsite/backup-offsite-dispatch.service.ts",
  // The off-site retry sweep: a cross-user cron fan-out (withSystemContext)
  // over failed copies, each re-attempted under its owner (withUserContext).
  "src/backup/offsite/backup-offsite-retry.service.ts",
  // `withPreserveTimestamps` (identity inherited, never granted) around the
  // restore's single transaction, so the GUC-aware `updated_at` trigger keeps
  // the backup's own timestamps. It moved here from `backup.service.ts` when
  // issue #1092 split the restore out; the facade no longer touches the module.
  "src/backup/backup-restore.service.ts",
  "src/budgets/budget-alert.service.ts",
  "src/budgets/budget-period-cron.service.ts",
  // Daily portfolio-movement cron: a system-context fan-out over users with a
  // threshold, then a per-user body (withUserContext) that prices the portfolio
  // and dispatches. No request behind it
  // (docs/specs/portfolio-movement-notifications.md).
  "src/notification-center/portfolio-movement-alert.service.ts",
  // Event-driven balance-threshold evaluation: runs on the net-worth recalc's
  // post-commit timer (no request), so it seeds its own withUserContext
  // (docs/specs/balance-threshold-notifications.md).
  "src/notification-center/balance-threshold-alert.service.ts",
  // Per-security price-movement cron, the same two-part shape as the portfolio
  // one above: a system-context keyset scan to enumerate every opted-in
  // security's owner, then a per-user body (withUserContext) that re-reads the
  // opt-in under that owner's own scope before it writes. No request behind it.
  "src/notification-center/security-price-alert.service.ts",
  "src/common/interceptors/request-context.interceptor.ts",
  // The Google Places quota claim for the OPERATOR's key. That counter belongs
  // to the deployment rather than to whoever's lookup spent it -- there is no
  // owner column and the table is RLS-exempt -- so the claim runs under
  // withSystemContext. The per-user counter beside it needs no bypass.
  "src/payees/lookup/google-places/payee-lookup-quota.service.ts",
  // Cross-replica job coordination: claimOnce/claimLease write to a global
  // claims table that belongs to no single user, from cron entry points with no
  // request to inherit an identity from -- system context by construction.
  "src/common/jobs/job-claim.service.ts",
  // Joint category creation: the owner-scoped write window for a grantee who
  // holds the delegation's categories-can-create capability, opened only after
  // JointCategoriesService has decided authorization in full.
  "src/categories/joint-categories.service.ts",
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
  // The nightly purge of notifications the reader is done with: a cross-user
  // sweep from a cron entry point, with no request to inherit an identity
  // from. Every other method here runs under the caller's own context.
  "src/notification-center/notification.service.ts",
  // The reminder firing cron: the dismissed-source sweep and the atomic claim
  // are cross-user (withSystemContext), and each due row's re-emit runs under
  // its own user's context (withUserContext). Moved here from
  // notification-center with the cron; the reminder CRUD it left behind has no
  // context wrapper of its own.
  "src/notifications/notification-reminder-cron.service.ts",
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
  // Background payee contact enrichment: dispatched after the create's
  // transaction committed, on the request's tail, so there is no ambient
  // identity to inherit -- the user's own context is re-seeded for the one
  // conditional UPDATE it makes.
  "src/payees/lookup/payee-contact-enrichment.service.ts",
  "src/mcp/tools/transactions.tool.ts",
  // Joint accounts (N1): refreshing a stale joint account's current-month
  // snapshot runs recalculateAccount under withUserContext(ownerUserId) so
  // the owner-keyed mab rows are written with the correct identity.
  // The stale-snapshot sweep is likewise a cross-user cron fan-out (system
  // context) whose per-account body runs as the owning user -- there is no
  // request to inherit an identity from (DR-04-03).
  "src/net-worth/net-worth.service.ts",
  "src/notifications/bill-reminder.service.ts",
  // Provider outage alerts: a cron sweep over deployment-wide provider_health
  // rows that belong to no user, whose recipients are every administrator --
  // cross-user by construction, with no request to inherit an identity from.
  "src/notifications/provider-outage-alert.service.ts",
  "src/oauth/oauth-interaction.controller.ts",
  "src/oauth/oauth-provider.service.ts",
  // Provider availability bookkeeping: a global provider_health row written
  // from whatever code path happened to call the provider, so there is no
  // caller identity that could own it -- and it is written outside the caller's
  // transaction on purpose, because an outage is not part of whatever request
  // discovered it.
  "src/provider-health/provider-health.service.ts",
  // Two genuinely cross-user pieces of work, and only those: generating the
  // deployment's one VAPID key pair on the bootstrap hook (no request behind
  // it), and counting the devices that key pair serves across every account.
  // Reading the row itself runs under the caller's own identity -- the table is
  // RLS-exempt, so a bypass there would widen the fence for nothing.
  "src/push/push-config.service.ts",
  // Push chart artifacts: ephemeral pre-rendered images authorized by a one-use
  // HMAC bearer token and consumed atomically, with no owner column to policy on
  // (the table is RLS-exempt, and `rls-exempt-tables.ts` carries that reasoning).
  // Both call sites are cross-user by construction -- the expiry sweep is a cron
  // with no request behind it, and the per-issue cap counts every artifact on
  // the instance -- so neither has a caller identity that could own the row.
  "src/push/push-chart-artifact.service.ts",
  // Daily sweep of long-retired push devices: a cross-user cron with no request
  // behind it, and every row it can reach belongs to somebody who can no longer
  // receive on it.
  "src/push/push-subscription.service.ts",
  "src/scheduled-transactions/scheduled-transactions.service.ts",
  "src/securities/holdings.service.ts",
  // The market-index refresh is a deployment-wide cron with no request behind
  // it: the rows it writes are global reference data with no owner, exactly like
  // the exchange-rate refresh above.
  "src/securities/market-index.service.ts",
  "src/securities/securities.controller.ts",
  "src/securities/security-price.service.ts",
  // GEM recommendation-change cron: a deployment-wide fan-out (system context
  // to enumerate every strategy's owner) then a per-user body (withUserContext)
  // that reuses the report materializer and dispatches a notification. No
  // request behind it (docs/specs/gem-signal-change-notifications.md).
  "src/strategies/gem-signal-change-alert.service.ts",
  // System alerts: every caller is a cron catch, a post-claim hook or a
  // bootstrap hook with no request behind it, so the service seeds its own
  // context -- system for the admin fan-out, user for a per-user alert
  // (docs/specs/system-alerts.md).
  "src/system-alerts/system-alert.service.ts",
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
 * selector shape out of this file and then requires `AGENTS.md` and
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
