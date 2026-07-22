# Row-Level Security (RLS) Runbook

> **Status: planned / not yet enforced.** This runbook documents the operational model for the database-enforced Row-Level Security feature described in [`row-level-security.md`](./row-level-security.md). It is the operator reference for enabling, verifying, and rolling back RLS once the implementation lands. When the feature ships, move this file to `docs/rls.md`. Until the runtime is switched to the `monize_app` role (see Rollout), RLS policies are inert even if present, because the app connects as the cluster superuser, which bypasses RLS.

## What RLS does here

Monize enforces multi-tenancy in application code: every service filters by `userId` derived from the JWT. RLS adds a **second wall inside PostgreSQL** so that, even if a query forgets its `WHERE user_id` clause, the database returns only the current user's rows. It is defense in depth, not a replacement for the app-level filtering.

The mechanism: every database operation runs inside a transaction (opened by the `tenantTx()` helper) whose first statement sets a **transaction-local** variable (`app.current_user_id`, via `set_config(..., true)` = `SET LOCAL` semantics); table policies compare each row's owner against it. Postgres reverts the variable at COMMIT/ROLLBACK, so it can never leak onto a pooled connection. Privileged work (migrations, admin, cron jobs, seeders, auth bootstrap) runs either as the owner role (which bypasses RLS) or with an explicit transaction-local `app.bypass_rls = 'on'` marker.

## Roles and connections

| Role | Privilege | Used by | Subject to RLS? |
|------|-----------|---------|-----------------|
| `monize_user` (`POSTGRES_USER`) | Superuser + schema owner | `db-init`, `db-migrate`, seed scripts | No (superuser/owner bypass) |
| `monize_app` | LOGIN, non-superuser, non-owner, no `BYPASSRLS`, table DML grants only | The long-running API process (`main`) | **Yes** |

The split is **by process**: startup scripts connect as the owner; the API runtime connects as `monize_app`. This is what makes RLS effective — the runtime role cannot bypass policies.

### Pooler compatibility

The GUC is transaction-local and the transaction is the unit every pooler preserves, so the design is **safe under transaction-mode poolers** (e.g. pgBouncer in `transaction` mode) as well as session-mode pooling and the app's own pg pool. The standing constraint this buys: **no cross-transaction session state** anywhere in the backend -- no session-scoped advisory locks (`pg_advisory_lock`; use `pg_advisory_xact_lock`), no LISTEN/NOTIFY, no temp tables, no named prepared statements. None are used today (verified); adding one later is a deliberate, reviewed decision that re-imposes session-mode-only pooling.

## Configuration

| Env var | Purpose | Default |
|---------|---------|---------|
| `DATABASE_USER` / `DATABASE_PASSWORD` | Owner role (init, migrate, seed) | `monize_user` |
| `DATABASE_APP_USER` / `DATABASE_APP_PASSWORD` | Unprivileged runtime role (required for `enforce`) | unset (falls back to owner) |
| `RLS_MODE` | `off` \| `shadow` \| `enforce` — one enum controls both GUC emission and the runtime role | `off` |

| `RLS_MODE` | GUCs emitted | Runtime role | Effect |
|------------|--------------|--------------|--------|
| `off` | no | owner | Identical to pre-RLS behavior. |
| `shadow` | yes | owner | Tenant transactions + GUCs live; policies bypassed (owner). Safe soak; transaction-wrapping latency shows up early. |
| `enforce` | yes | `monize_app` | Policies live **on tables where RLS is enabled**. Before the enable migration ships (flip B), this only drops privileges (flip A) and row visibility is unchanged. |

The single enum replaces an earlier two-boolean design in which "unprivileged role but no GUC emission" (zero rows everywhere) was representable. The only startup validation needed: `RLS_MODE=enforce` without `DATABASE_APP_PASSWORD` refuses to boot.

`monize_app` is created idempotently by `db-init` from `DATABASE_APP_PASSWORD`; its grants are applied by the RLS migration. If `DATABASE_APP_PASSWORD` is unset, `db-init` skips role creation with a warning — existing deployments upgrade with no new required env vars and no behavior change. The compose files reference the new vars with empty defaults (`${DATABASE_APP_PASSWORD:-}`) so old `.env` files neither warn nor break.

### Rotating the app-role password

`db-init` re-applies the password on **every** startup (`ALTER ROLE monize_app PASSWORD ...`, passed via a parameterized `set_config`, never string interpolation). To rotate: change `DATABASE_APP_PASSWORD` in the environment and restart the stack. No manual SQL needed.

## Session variables (GUCs)

| GUC | Type | Meaning | Set by |
|-----|------|---------|--------|
| `app.current_user_id` | uuid (as text) | The effective tenant for this transaction | `tenantTx()`, transaction-locally, inside a request scope or a `withUserContext()` scope |
| `app.bypass_rls` | `'on'` / unset | Privileged: see across all users | `tenantTx()`, transaction-locally, inside a `withSystemContext()` scope only (import lint-allowlisted; invocations logged with call site) |
| `app.preserve_timestamps` | `'on'` / unset | Backup restore: the `update_updated_at_column()` trigger leaves `updated_at` untouched | `tenantTx()` when the context carries `preserveTimestamps: true` (backup restore path only); dies with each COMMIT. Emitted in **every** `RLS_MODE` including `off` — it replaces the old `DISABLE TRIGGER` DDL and is not an RLS feature |

All are read with the `missing_ok` form (`current_setting('app.current_user_id', true)`), so an unset value yields `NULL`/false and policies **deny** (fail closed). The helper `app_current_user_id()` returns `NULL` when unset/empty; `app_bypass_rls()` returns `true` only when `app.bypass_rls = 'on'`.

Connection hygiene: none required. The GUCs are transaction-local — Postgres reverts them at COMMIT/ROLLBACK, before the connection can serve anything else. There is no reset code, no release hook, and no "destroy on failed reset" path; a pooled connection **cannot** carry a previous request's identity, by construction.

Fail-loud helper: `tenantTx()` **throws** (`DB access outside request/user/system context`) when called with no ambient scope, in every `RLS_MODE` including `off`. There is deliberately no silent fallback — under enforcement a fallback would mean a query with no GUC, i.e. zero rows that look like empty data. A context gap is therefore a thrown error in dev/CI, not a production mystery.

## How context is set per code path

| Code path | How the GUC gets set |
|-----------|----------------------|
| Authenticated HTTP request | The existing `RequestContextInterceptor` seeds AsyncLocalStorage with `req.user.id`; **every `tenantTx()`** sets `app.current_user_id` for its own transaction. No connection is held between queries — SSE/streaming endpoints and requests that never touch the DB hold nothing. |
| PAT-authenticated request (incl. all MCP traffic) | Same as above once authenticated; the PAT **lookup itself** (token-hash scan across users) runs in `withSystemContext()`. |
| Auth bootstrap (login-by-email / OIDC callback / register / refresh, before a session exists) | `withSystemContext(fn)` |
| Password reset / email verification token lookups | `withSystemContext(fn)` |
| MCP-connector OAuth flow (`oauth_payloads` during authorize, pre-session) | `withSystemContext(fn)` |
| Emergency-access claim (grantee or claim token acting on the **grantor's** rows) | `withSystemContext(fn)` |
| Cron job, per-user work | `withUserContext(userId, fn)` |
| Cron job, cross-user fan-out (e.g. "all users in timezone X") | `withSystemContext(fn)` |
| Seeders / demo reset | `withSystemContext(fn)` |
| Admin (cross-user) | `withSystemContext(fn)` (or a dedicated owner DataSource if hardened) |
| Backup restore | Normal user context + `preserveTimestamps: true` context flag; `tenantTx()` adds `app.preserve_timestamps = 'on'` to each restore transaction (replaces the old `ALTER TABLE ... DISABLE TRIGGER` DDL, which `monize_app` cannot run). |
| Unauthenticated health check | None — direct DataSource ping, reads no user data. |
| `db-init` / `db-migrate` | None needed — they run as the owner and bypass RLS. |

This table is descriptive, not exhaustive-by-construction: the implementation includes an audit of every route reachable without `req.user`. If you add such a route later, it needs explicit context.

**Do not "fix" a zero-rows or context-error bug by adding `withSystemContext`.** That widens the RLS bypass. ESLint restricts importing `with-context.ts` to an allowlist of modules (admin, auth bootstrap, emergency access, jobs, seeders, backup); if the lint blocks you, the almost-always-correct fix is propagating the *user* context (`withUserContext` or the request scope), and widening the allowlist is a deliberate, reviewed decision. `withSystemContext` invocations are logged with their call site so bypass usage stays auditable in production.

## Rollout (enabling RLS safely)

Each step is independently revertible. Do not skip the soak phases. The structure separates the two failure classes: **flip A drops privileges** (only `permission denied`-class bugs possible), **flip B enables RLS** (only zero-row/context-class bugs possible) — they can never surface in the same step.

1. **Plumbing as a no-op** — deploy with `RLS_MODE=off`. `tenantTx` and the `withSystemContext`/`withUserContext` helpers exist but emit no GUCs. Because `tenantTx()` throws on context-less DB access even at `off`, most context gaps already surface in dev/CI here. No behavior change.
2. **Shadow soak** — `RLS_MODE=shadow` in production. GUCs emitted per transaction, runtime still the owner (policies bypassed). Land the helper/grant + policy migrations — policies without `ENABLE ROW LEVEL SECURITY` are inert. Soak for **weeks, not days**: the transaction wrapping proves itself (endpoint latency, error rates) while RLS itself is still off.
3. **Staging/demo, fully enforced** — `docker-compose.demo.yml` runs `RLS_MODE=enforce` *with* the enable migration deployed. Enable Postgres `log_statement`. Run the full e2e + integration suites, plus the three paths most likely to break: a backup **restore**, an emergency-access **claim**, and an MCP request authenticated by PAT. Watch the monitoring signals below.
4. **Production flip A: privilege drop** — set `RLS_MODE=enforce` while the enable migration is **not** yet deployed to prod. The runtime becomes `monize_app`; no table has RLS enabled, so row visibility is unchanged. Only privilege bugs can surface (loud `permission denied` errors, e.g. a missed grant or a DDL path). Soak. Revert: `RLS_MODE=shadow`.
5. **Production flip B: enable RLS** — deploy the release containing the enable migration (`0NN+4_rls_enable.sql`). RLS is now live; only context bugs can surface. Keep watching the signals through at least one daily-cron cycle (scheduled-transaction auto-post, demo reset). Emergency revert is unchanged and instant: `RLS_MODE=shadow` — the owner role bypasses RLS even on enabled tables.

### Monitoring signals during soak and after enforcement

- **RLS violations in the Postgres log** — should be zero in steady state: `grep 'violates row-level security' <pg log>`; each hit is a write path with wrong/missing context.
- **Permission errors** — `grep 'permission denied for' <pg log>`; a hit means a missing GRANT or a privileged operation (DDL) attempted as `monize_app`.
- **Context errors in the API log** — `DB access outside request/user/system context` means a call path reached the DB with no ambient scope; wrap it in `withUserContext`/`withSystemContext`. (Without the throwing accessor this would have been a silent zero-row result.)
- **Zero-row anomalies** — endpoints or crons that suddenly return/process nothing (a missing `withSystemContext`/`withUserContext`). Compare cron summary logs before/after the flip.
- **Long transactions** — `SELECT pid, now() - xact_start AS xact_age, query FROM pg_stat_activity WHERE xact_start IS NOT NULL ORDER BY xact_age DESC;` A `tenantTx` should live milliseconds. A long-lived one means slow non-DB work (an LLM call, an external fetch) was wrapped inside the transaction — move it out so the transaction stays tight.
- **Latency** — compare endpoint p95 before/after the shadow flip; each simple read gained a BEGIN/COMMIT round-trip pair. Regressions localize to hot read paths that should batch into one `tenantTx`.

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

- **Emergency (instant, no DB change):** set `RLS_MODE=shadow` (or `off`) and redeploy. The API reconnects as the owner role and bypasses RLS immediately — even on tables where RLS is enabled. Policies remain in place but inert.
- **Full removal (DB change):** the migration runner is forward-only, so apply the down-SQL manually as the owner, **in this order** — `DROP ROLE` fails while sessions for the role exist:

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
| Every read returns 0 rows after enforcement, no errors anywhere | The query ran outside `tenantTx` (hand-rolled QueryRunner or leftover injected repo), so no GUC was set for its transaction | Route the data access through `tenantTx()`; confirm the lint ban on `@InjectRepository`/`createQueryRunner` covers the module. |
| A cron job suddenly processes nothing | The job runs context-less under `monize_app` | Wrap its cross-user query in `withSystemContext` and per-user work in `withUserContext`. |
| `ERROR: new row violates row-level security policy` on a legitimate write | The row's `user_id` does not match `app.current_user_id`, or the write runs without context | Ensure the writing path sets the GUC to the owning user; for system writes use `withSystemContext`. |
| Login fails after enforcement | Auth's by-email/OIDC lookup hits the `users` policy before a session exists | Wrap auth bootstrap reads in `withSystemContext`. |
| All MCP requests fail auth (401) or return empty after enforcement | PAT validation scans `personal_access_tokens` across users pre-session | Wrap the PAT lookup in `withSystemContext`. |
| Backup restore fails with `ERROR: must be owner of table ...` | Restore still uses the old `ALTER TABLE ... DISABLE TRIGGER` DDL, which `monize_app` cannot run | Use the `app.preserve_timestamps` GUC path (the trigger function honors it); no DDL at restore time. |
| Emergency-access claim appears to succeed but changes nothing (or errors) | The claim flow touches the grantor's rows with the grantee's (wrong) context | Wrap the claim flow in `withSystemContext`. |
| `permission denied for table ...` (not a row error) | Missing GRANT to `monize_app` | Re-run the grants migration / `ALTER DEFAULT PRIVILEGES`; new tables created outside the owner won't be auto-granted. |
| Bulk report/export got slow | Per-row `EXISTS` on an indirect-table policy over a large scan | Confirm the FK index exists and the policy uses the `(SELECT app_current_user_id())` initplan form; as a last resort run that specific export under `withSystemContext`. |
| Requests queue / time out under load; `pg_stat_activity` shows `monize_app` at the pool cap | A long-lived transaction is holding connections — almost always slow non-DB work (LLM call, external fetch) wrapped inside a `tenantTx` | Find it via the long-transaction query above; move the slow work outside the transaction so each `tenantTx` stays milliseconds-short. |
| Suspected cross-request data bleed | Should be impossible: the GUC is transaction-local and Postgres reverts it at COMMIT/ROLLBACK | Grep for session-scoped `set_config(..., false)` calls outside `tenant-tx.ts` — any hit is the bug; the `rls-enforcement` GUC-scope test asserts the revert. |

## Adding a new table later

When a migration adds a user-owned table, in the same migration (and mirrored into `database/schema.sql`):

1. `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;` (post-flip-B, new tables enable immediately — the staged enable was only for the initial rollout).
2. Create the isolation policy — direct (`user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls())`) or, if the table has no `user_id`, an `EXISTS` against its owning parent. Keep the `(SELECT ...)` initplan form.
3. Grants are automatic via `ALTER DEFAULT PRIVILEGES` **only** if the owner role created the table; verify `monize_app` has DML on it otherwise.
4. Test coverage is automatic: the catalog-driven `rls-enforcement.integration.spec.ts` enumerates tables from the schema and `pg_policies`, and **fails** if a table is neither direct-owned (`user_id` column), in the indirect-ownership map, nor in the reference-table exemption list. For an indirect or exempt table, update that map/list in the spec — that is the only manual step; forgetting it is a test failure, not a silent gap.

Similarly, any new route reachable without `req.user` (public endpoint, new auth strategy) must wrap its user-table access in `withSystemContext` — see "How context is set per code path".

Reference tables with no per-user owner (e.g. `currencies`, `exchange_rates`) are intentionally left RLS-disabled; document that choice in the migration comment.
