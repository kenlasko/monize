# Row-Level Security (RLS) Runbook

> **Status: planned / not yet enforced.** This runbook documents the operational model for the
> database-enforced Row-Level Security feature described in
> [`row-level-security.md`](./row-level-security.md). It is the operator reference for enabling,
> verifying, and rolling back RLS once the implementation lands. When the feature ships, move this file
> to `docs/rls.md`. Until the runtime is switched to the `monize_app` role (see Rollout), RLS policies
> are inert even if present, because the app connects as the cluster superuser, which bypasses RLS.

## What RLS does here

Monize enforces multi-tenancy in application code: every service filters by `userId` derived from the
JWT. RLS adds a **second wall inside PostgreSQL** so that, even if a query forgets its `WHERE user_id`
clause, the database returns only the current user's rows. It is defense in depth, not a replacement for
the app-level filtering.

The mechanism: every database connection that serves a user request carries a session variable
(`app.current_user_id`); table policies compare each row's owner against it. Privileged work (migrations,
admin, cron jobs, seeders, auth bootstrap) runs either as the owner role (which bypasses RLS) or with an
explicit `app.bypass_rls = 'on'` marker.

## Roles and connections

| Role | Privilege | Used by | Subject to RLS? |
|------|-----------|---------|-----------------|
| `monize_user` (`POSTGRES_USER`) | Superuser + schema owner | `db-init`, `db-migrate`, seed scripts | No (superuser/owner bypass) |
| `monize_app` | LOGIN, non-superuser, non-owner, no `BYPASSRLS`, table DML grants only | The long-running API process (`main`) | **Yes** |

The split is **by process**: startup scripts connect as the owner; the API runtime connects as
`monize_app`. This is what makes RLS effective — the runtime role cannot bypass policies.

### Deployment constraint: session-mode pooling only

The design relies on session-scoped GUCs set on a pinned physical connection. A transaction-mode
pooler (e.g. pgBouncer in `transaction` mode) breaks this silently: statements from one request
interleave onto shared server connections, so the GUC evaporates (fail-closed, zero rows) or bleeds
between requests. **Do not put a transaction-mode pooler between the API and Postgres.** If one ever
becomes necessary, the mechanism must first be redesigned around `SET LOCAL` inside per-request
transactions.

## Configuration

| Env var | Purpose | Default |
|---------|---------|---------|
| `DATABASE_USER` / `DATABASE_PASSWORD` | Owner role (init, migrate, seed) | `monize_user` |
| `DATABASE_APP_USER` / `DATABASE_APP_PASSWORD` | Unprivileged runtime role (required for `enforce`) | unset (falls back to owner) |
| `RLS_MODE` | `off` \| `shadow` \| `enforce` — one enum controls both GUC emission and the runtime role | `off` |

| `RLS_MODE` | GUCs emitted | Runtime role | Effect |
|------------|--------------|--------------|--------|
| `off` | no | owner | Identical to pre-RLS behavior. |
| `shadow` | yes | owner | Connection pinning + GUCs live; policies bypassed (owner). Safe soak; pool pressure shows up early. |
| `enforce` | yes | `monize_app` | Policies live **on tables where RLS is enabled**. Before the enable migration ships (flip B), this only drops privileges (flip A) and row visibility is unchanged. |

The single enum replaces an earlier two-boolean design in which "unprivileged role but no GUC emission"
(zero rows everywhere) was representable. The only startup validation needed: `RLS_MODE=enforce` without
`DATABASE_APP_PASSWORD` refuses to boot.

`monize_app` is created idempotently by `db-init` from `DATABASE_APP_PASSWORD`; its grants are applied by
the RLS migration. If `DATABASE_APP_PASSWORD` is unset, `db-init` skips role creation with a warning —
existing deployments upgrade with no new required env vars and no behavior change. The compose files
reference the new vars with empty defaults (`${DATABASE_APP_PASSWORD:-}`) so old `.env` files neither
warn nor break.

### Rotating the app-role password

`db-init` re-applies the password on **every** startup (`ALTER ROLE monize_app PASSWORD ...`, passed via
a parameterized `set_config`, never string interpolation). To rotate: change `DATABASE_APP_PASSWORD` in
the environment and restart the stack. No manual SQL needed.

## Session variables (GUCs)

| GUC | Type | Meaning | Set by |
|-----|------|---------|--------|
| `app.current_user_id` | uuid (as text) | The effective tenant for this connection | Lazy pin on first `tenantManager()` touch, inside a request scope or a `withUserContext()` scope |
| `app.bypass_rls` | `'on'` / unset | Privileged: see across all users | Lazy pin inside a `withSystemContext()` scope only (import lint-allowlisted; invocations logged with call site) |
| `app.preserve_timestamps` | `'on'` / unset | Backup restore: the `update_updated_at_column()` trigger leaves `updated_at` untouched | Backup restore path only; reset alongside connection release |

All are read with the `missing_ok` form (`current_setting('app.current_user_id', true)`), so an unset
value yields `NULL`/false and policies **deny** (fail closed). The helper `app_current_user_id()` returns
`NULL` when unset/empty; `app_bypass_rls()` returns `true` only when `app.bypass_rls = 'on'`.

Connection hygiene: the GUC is set when a connection is pinned and reset before the connection returns
to the pool. If the reset itself fails (dead connection), the connection is **destroyed**, never pooled
— a pooled connection can never carry a previous request's identity.

Fail-loud accessor: `tenantManager()` **throws** (`DB access outside request/user/system context`) when
called with no ambient scope, in every `RLS_MODE` including `off`. There is deliberately no silent
fallback — under enforcement a fallback would mean a connection with no GUC, i.e. zero rows that look
like empty data. A context gap is therefore a thrown error in dev/CI, not a production mystery.

## How context is set per code path

| Code path | How the GUC gets set |
|-----------|----------------------|
| Authenticated HTTP request | `RlsContextInterceptor` seeds AsyncLocalStorage; the **first DB touch** (`tenantManager()`) lazily pins a connection and sets `app.current_user_id` to `req.user.id`. Released (reset + return to pool) when the response — including SSE/streaming — completes. Requests that never touch the DB never hold a connection. |
| PAT-authenticated request (incl. all MCP traffic) | Same as above once authenticated; the PAT **lookup itself** (token-hash scan across users) runs in `withSystemContext()`. |
| Auth bootstrap (login-by-email / OIDC callback / register / refresh, before a session exists) | `withSystemContext(fn)` |
| Password reset / email verification token lookups | `withSystemContext(fn)` |
| MCP-connector OAuth flow (`oauth_payloads` during authorize, pre-session) | `withSystemContext(fn)` |
| Emergency-access claim (grantee or claim token acting on the **grantor's** rows) | `withSystemContext(fn)` |
| Cron job, per-user work | `withUserContext(userId, fn)` |
| Cron job, cross-user fan-out (e.g. "all users in timezone X") | `withSystemContext(fn)` |
| Seeders / demo reset | `withSystemContext(fn)` |
| Admin (cross-user) | `withSystemContext(fn)` (or a dedicated owner DataSource if hardened) |
| Backup restore | Normal user context + `app.preserve_timestamps = 'on'` on the pinned connection (replaces the old `ALTER TABLE ... DISABLE TRIGGER` DDL, which `monize_app` cannot run). |
| Unauthenticated health check | None — direct DataSource ping, reads no user data. |
| `db-init` / `db-migrate` | None needed — they run as the owner and bypass RLS. |

This table is descriptive, not exhaustive-by-construction: the implementation includes an audit of every
route reachable without `req.user`. If you add such a route later, it needs explicit context.

**Do not "fix" a zero-rows or context-error bug by adding `withSystemContext`.** That widens the RLS
bypass. ESLint restricts importing `with-context.ts` to an allowlist of modules (admin, auth bootstrap,
emergency access, jobs, seeders, backup); if the lint blocks you, the almost-always-correct fix is
propagating the *user* context (`withUserContext` or the request scope), and widening the allowlist is a
deliberate, reviewed decision. `withSystemContext` invocations are logged with their call site so bypass
usage stays auditable in production.

## Rollout (enabling RLS safely)

Each step is independently revertible. Do not skip the soak phases. The structure separates the two
failure classes: **flip A drops privileges** (only `permission denied`-class bugs possible), **flip B
enables RLS** (only zero-row/context-class bugs possible) — they can never surface in the same step.

1. **Plumbing as a no-op** — deploy with `RLS_MODE=off`. The interceptor and
   `withSystemContext`/`withUserContext` helpers exist but emit nothing. Because `tenantManager()`
   throws on context-less DB access even at `off`, most context gaps already surface in dev/CI here. No
   behavior change.
2. **Shadow soak** — `RLS_MODE=shadow` in production. GUCs emitted, lazy pinning live, runtime still the
   owner (policies bypassed). Land the helper/grant + policy migrations — policies without
   `ENABLE ROW LEVEL SECURITY` are inert. Soak for **weeks, not days**: the new connection lifecycle and
   pool behavior prove themselves while RLS itself is still off.
3. **Staging/demo, fully enforced** — `docker-compose.demo.yml` runs `RLS_MODE=enforce` *with* the
   enable migration deployed. Enable Postgres `log_statement`. Run the full e2e + integration suites,
   plus the three paths most likely to break: a backup **restore**, an emergency-access **claim**, and
   an MCP request authenticated by PAT. Watch the monitoring signals below.
4. **Production flip A: privilege drop** — set `RLS_MODE=enforce` while the enable migration is **not**
   yet deployed to prod. The runtime becomes `monize_app`; no table has RLS enabled, so row visibility
   is unchanged. Only privilege bugs can surface (loud `permission denied` errors, e.g. a missed grant
   or a DDL path). Soak. Revert: `RLS_MODE=shadow`.
5. **Production flip B: enable RLS** — deploy the release containing the enable migration
   (`0NN+4_rls_enable.sql`). RLS is now live; only context bugs can surface. Keep watching the signals
   through at least one daily-cron cycle (scheduled-transaction auto-post, demo reset). Emergency
   revert is unchanged and instant: `RLS_MODE=shadow` — the owner role bypasses RLS even on enabled
   tables.

### Monitoring signals during soak and after enforcement

- **RLS violations in the Postgres log** — should be zero in steady state:
  `grep 'violates row-level security' <pg log>`; each hit is a write path with wrong/missing context.
- **Permission errors** — `grep 'permission denied for' <pg log>`; a hit means a missing GRANT or a
  privileged operation (DDL) attempted as `monize_app`.
- **Context errors in the API log** — `DB access outside request/user/system context` means a call path
  reached the DB with no ambient scope; wrap it in `withUserContext`/`withSystemContext`. (Without the
  throwing accessor this would have been a silent zero-row result.)
- **Zero-row anomalies** — endpoints or crons that suddenly return/process nothing (a missing
  `withSystemContext`/`withUserContext`). Compare cron summary logs before/after the flip.
- **Pool saturation** — `SELECT usename, state, count(*) FROM pg_stat_activity GROUP BY 1, 2;`
  A sustained `monize_app` active count near the pool's `extra.max` means streaming endpoints are
  pinning too long; raise the pool or investigate the endpoint.

## Verifying enforcement

As the unprivileged role, the GUC alone should gate visibility (bypassing the app's `WHERE user_id`):

```sql
-- Connect as monize_app (or: SET LOCAL ROLE monize_app inside a transaction as a superuser)
SET app.current_user_id = '<userA-uuid>';
SELECT count(*) FROM transactions;            -- expect: only userA's count
SET app.current_user_id = '<userB-uuid>';
SELECT count(*) FROM transactions;            -- expect: only userB's count

RESET app.current_user_id;
SELECT count(*) FROM transactions;            -- expect: 0  (fail-closed)

SET app.current_user_id = '<userA-uuid>';
INSERT INTO accounts (user_id, name, ...) VALUES ('<userB-uuid>', 'x', ...);
                                              -- expect: ERROR, new row violates row-level security policy

SET app.bypass_rls = 'on';
SELECT count(DISTINCT user_id) FROM transactions;  -- expect: all users (system/admin path works)
```

List active policies:

```sql
SELECT schemaname, tablename, policyname FROM pg_policies ORDER BY tablename;
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class WHERE relkind = 'r' AND relrowsecurity ORDER BY relname;
```

## Rolling back

- **Emergency (instant, no DB change):** set `RLS_MODE=shadow` (or `off`) and redeploy. The API
  reconnects as the owner role and bypasses RLS immediately — even on tables where RLS is enabled.
  Policies remain in place but inert.
- **Full removal (DB change):** the migration runner is forward-only, so apply the down-SQL manually as
  the owner, **in this order** — `DROP ROLE` fails while sessions for the role exist:

1. Redeploy the API with `RLS_MODE=shadow` or `off` so nothing reconnects as `monize_app`.
2. Terminate any straggling sessions:
   ```sql
   SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'monize_app';
   ```
3. Run the down-SQL as the owner:
   ```sql
   -- For each RLS-enabled table:
   DROP POLICY IF EXISTS accounts_isolation ON accounts;
   ALTER TABLE accounts DISABLE ROW LEVEL SECURITY;
   -- ... repeat for every table ...

   DROP FUNCTION IF EXISTS app_current_user_id();
   DROP FUNCTION IF EXISTS app_bypass_rls();
   -- Note: update_updated_at_column() stays (its GUC check is harmless without RLS).

   REVOKE ALL ON ALL TABLES IN SCHEMA public FROM monize_app;
   REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM monize_app;
   REVOKE USAGE ON SCHEMA public FROM monize_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE monize_user IN SCHEMA public REVOKE ALL ON TABLES FROM monize_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE monize_user IN SCHEMA public REVOKE ALL ON SEQUENCES FROM monize_app;
   DROP ROLE IF EXISTS monize_app;
   ```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| API throws `DB access outside request/user/system context` | A service/cron/one-off path reached the DB with no ambient scope — previously this would have been silent zero rows | Wrap the call path in `withUserContext` (almost always right) or `withSystemContext` (only if genuinely cross-user; lint-allowlisted). |
| Every read returns 0 rows after enforcement, no errors anywhere | The request's connection has no `app.current_user_id` (interceptor not running for the route, or data access outside the request scope) | Confirm `RlsContextInterceptor` covers the route and the service resolves its manager via `tenantManager()`, not an injected repo. |
| A cron job suddenly processes nothing | The job runs context-less under `monize_app` | Wrap its cross-user query in `withSystemContext` and per-user work in `withUserContext`. |
| `ERROR: new row violates row-level security policy` on a legitimate write | The row's `user_id` does not match `app.current_user_id`, or the write runs without context | Ensure the writing path sets the GUC to the owning user; for system writes use `withSystemContext`. |
| Login fails after enforcement | Auth's by-email/OIDC lookup hits the `users` policy before a session exists | Wrap auth bootstrap reads in `withSystemContext`. |
| All MCP requests fail auth (401) or return empty after enforcement | PAT validation scans `personal_access_tokens` across users pre-session | Wrap the PAT lookup in `withSystemContext`. |
| Backup restore fails with `ERROR: must be owner of table ...` | Restore still uses the old `ALTER TABLE ... DISABLE TRIGGER` DDL, which `monize_app` cannot run | Use the `app.preserve_timestamps` GUC path (the trigger function honors it); no DDL at restore time. |
| Emergency-access claim appears to succeed but changes nothing (or errors) | The claim flow touches the grantor's rows with the grantee's (wrong) context | Wrap the claim flow in `withSystemContext`. |
| `permission denied for table ...` (not a row error) | Missing GRANT to `monize_app` | Re-run the grants migration / `ALTER DEFAULT PRIVILEGES`; new tables created outside the owner won't be auto-granted. |
| Bulk report/export got slow | Per-row `EXISTS` on an indirect-table policy over a large scan | Confirm the FK index exists and the policy uses the `(SELECT app_current_user_id())` initplan form; as a last resort run that specific export under `withSystemContext`. |
| Requests queue / time out under load; `pg_stat_activity` shows `monize_app` at the pool cap | Streaming endpoints pinning connections for their full duration, or `extra.max` left at the default 10 | Verify lazy pinning is active (connections acquired on first DB touch, released in `finalize`); raise `extra.max`. |
| Suspected cross-request data bleed | A pooled connection retained a prior `app.current_user_id` | Verify set-on-pin + reset-on-release, and that a failed reset destroys the connection instead of pooling it; the `rls-enforcement` test asserts "unset GUC => 0 rows". |

## Adding a new table later

When a migration adds a user-owned table, in the same migration (and mirrored into `database/schema.sql`):

1. `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;` (post-flip-B, new tables enable immediately — the
   staged enable was only for the initial rollout).
2. Create the isolation policy — direct
   (`user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls())`) or, if the table has no
   `user_id`, an `EXISTS` against its owning parent. Keep the `(SELECT ...)` initplan form.
3. Grants are automatic via `ALTER DEFAULT PRIVILEGES` **only** if the owner role created the table; verify
   `monize_app` has DML on it otherwise.
4. Test coverage is automatic: the catalog-driven `rls-enforcement.integration.spec.ts` enumerates
   tables from the schema and `pg_policies`, and **fails** if a table is neither direct-owned
   (`user_id` column), in the indirect-ownership map, nor in the reference-table exemption list. For an
   indirect or exempt table, update that map/list in the spec — that is the only manual step; forgetting
   it is a test failure, not a silent gap.

Similarly, any new route reachable without `req.user` (public endpoint, new auth strategy) must wrap its
user-table access in `withSystemContext` — see "How context is set per code path".

Reference tables with no per-user owner (e.g. `currencies`, `exchange_rates`) are intentionally left
RLS-disabled; document that choice in the migration comment.
