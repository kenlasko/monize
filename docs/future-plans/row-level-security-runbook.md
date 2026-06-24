# Row-Level Security (RLS) Runbook

> **Status: planned / not yet enforced.** This runbook documents the operational model for the
> database-enforced Row-Level Security feature described in
> [`docs/future-plans/row-level-security.md`](./future-plans/row-level-security.md). It is the
> operator reference for enabling, verifying, and rolling back RLS once the implementation lands.
> Until the runtime is switched to the `monize_app` role (see Rollout), RLS policies are inert even
> if present, because the app connects as the cluster superuser, which bypasses RLS.

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

## Configuration

| Env var | Purpose | Default |
|---------|---------|---------|
| `DATABASE_USER` / `DATABASE_PASSWORD` | Owner role (init, migrate, seed) | `monize_user` |
| `DATABASE_APP_USER` / `DATABASE_APP_PASSWORD` | Unprivileged runtime role | unset (falls back to owner) |
| `RLS_ENABLED` | Emit `set_config('app.current_user_id', ...)` per request/job | `false` |
| `RLS_ENFORCE` | API connects as `DATABASE_APP_USER` instead of `DATABASE_USER` | `false` |

`monize_app` is created idempotently by `db-init` from `DATABASE_APP_PASSWORD`; its grants are applied by
the RLS migration. The image is safe to deploy before the role exists: with `RLS_ENFORCE=false` the API
falls back to the owner role.

## Session variables (GUCs)

| GUC | Type | Meaning | Set by |
|-----|------|---------|--------|
| `app.current_user_id` | uuid (as text) | The effective tenant for this connection | `RlsContextInterceptor` (HTTP); `withUserContext()` (jobs) |
| `app.bypass_rls` | `'on'` / unset | Privileged: see across all users | `withSystemContext()` only |

Both are read with the `missing_ok` form (`current_setting('app.current_user_id', true)`), so an unset
value yields `NULL`/false and policies **deny** (fail closed). The helper `app_current_user_id()` returns
`NULL` when unset/empty; `app_bypass_rls()` returns `true` only when `app.bypass_rls = 'on'`.

## How context is set per code path

| Code path | How the GUC gets set |
|-----------|----------------------|
| Authenticated HTTP request | `RlsContextInterceptor` pins a connection, sets `app.current_user_id` to `req.user.id`, exposes its `EntityManager` via AsyncLocalStorage; resets on release. |
| Cron job, per-user work | `withUserContext(userId, fn)` |
| Cron job, cross-user fan-out (e.g. "all users in timezone X") | `withSystemContext(fn)` |
| Seeders / demo reset | `withSystemContext(fn)` |
| Admin (cross-user) | `withSystemContext(fn)` (or a dedicated owner DataSource if hardened) |
| Auth bootstrap (login-by-email / OIDC before a session exists) | `withSystemContext(fn)` |
| `db-init` / `db-migrate` | None needed — they run as the owner and bypass RLS. |

## Rollout (enabling RLS safely)

Each step is independently revertible. Do not skip the soak phases.

1. **Plumbing as a no-op** — deploy with `RLS_ENABLED=false`, `RLS_ENFORCE=false`. The interceptor and
   `withSystemContext`/`withUserContext` helpers exist but emit nothing. No behavior change.
2. **Create policies** — apply the RLS migrations. The runtime still connects as the superuser, so
   policies exist but are bypassed. Pure latent safety margin. Soak in production.
3. **Monitor on staging/demo** — set `RLS_ENABLED=true` and point the runtime at `monize_app`
   (`RLS_ENFORCE=true`) on `docker-compose.demo.yml` only. Enable Postgres `log_statement`. Run the full
   e2e + integration suites. Watch for: endpoints returning zero rows (a missing `withSystemContext` on a
   job or auth path) and latency on bulk readers (investment reports, backup export).
4. **Enforce in production** — set `RLS_ENABLED=true` and `RLS_ENFORCE=true`. The runtime now connects as
   `monize_app`; RLS is live.

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

- **Emergency (instant, no DB change):** set `RLS_ENFORCE=false` and redeploy. The API reconnects as the
  owner role and bypasses RLS immediately. Policies remain in place but inert.
- **Full removal (DB change):** the migration runner is forward-only, so apply the down-SQL manually as the
  owner. Reverse order: drop policies and disable RLS per table, drop helpers, revoke grants, drop the role.

```sql
-- For each RLS-enabled table:
DROP POLICY IF EXISTS accounts_isolation ON accounts;
ALTER TABLE accounts DISABLE ROW LEVEL SECURITY;
-- ... repeat for every table ...

DROP FUNCTION IF EXISTS app_current_user_id();
DROP FUNCTION IF EXISTS app_bypass_rls();

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
| Every read returns 0 rows after enforcement | The request's connection has no `app.current_user_id` (context not set / wrong connection) | Confirm `RlsContextInterceptor` runs for the route and that services resolve their manager from the ALS context, not an injected repo. |
| A cron job suddenly processes nothing | The job runs context-less under `monize_app` | Wrap its cross-user query in `withSystemContext` and per-user work in `withUserContext`. |
| `ERROR: new row violates row-level security policy` on a legitimate write | The row's `user_id` does not match `app.current_user_id`, or the write runs without context | Ensure the writing path sets the GUC to the owning user; for system writes use `withSystemContext`. |
| Login fails after enforcement | Auth's by-email/OIDC lookup hits the `users` policy before a session exists | Wrap auth bootstrap reads in `withSystemContext`. |
| `permission denied for table ...` (not a row error) | Missing GRANT to `monize_app` | Re-run the grants migration / `ALTER DEFAULT PRIVILEGES`; new tables created outside the owner won't be auto-granted. |
| Bulk report/export got slow | Per-row `EXISTS` on an indirect-table policy over a large scan | Confirm the FK index exists; run that specific export under `withSystemContext`. |
| Suspected cross-request data bleed | A pooled connection retained a prior `app.current_user_id` | Verify set-on-pin + reset-on-release in the interceptor's `finally`; the `rls-enforcement` test asserts "unset GUC => 0 rows". |

## Adding a new table later

When a migration adds a user-owned table, in the same migration (and mirrored into `database/schema.sql`):

1. `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;`
2. Create the isolation policy — direct (`user_id = app_current_user_id() OR app_bypass_rls()`) or, if the
   table has no `user_id`, an `EXISTS` against its owning parent.
3. Grants are automatic via `ALTER DEFAULT PRIVILEGES` **only** if the owner role created the table; verify
   `monize_app` has DML on it otherwise.
4. Add the table to `rls-enforcement.integration.spec.ts` (isolation + fail-closed assertions).

Reference tables with no per-user owner (e.g. `currencies`, `exchange_rates`) are intentionally left
RLS-disabled; document that choice in the migration comment.
