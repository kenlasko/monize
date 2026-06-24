# Plan: Database-Enforced Row-Level Security (RLS)

## Goal

Add PostgreSQL Row-Level Security as a database-enforced safety net **beneath** Monize's existing
application-level multi-tenancy. Today every service takes `userId` (from JWT `req.user.id`) as its
first argument and filters each query with `WHERE user_id = ?`; this is correct and is covered by
`backend/test/integration/security-cross-user-isolation.integration.spec.ts`. RLS is defense in depth:
a single forgotten `WHERE user_id` clause anywhere -- a new endpoint, a refactor, a raw query -- must
not be able to leak one user's financial data to another. The app-level filtering stays in place; RLS
is a second wall the database itself enforces.

This plan targets the **robust, fully-enforced** end state:

- **Full query coverage:** RLS applies to every read and write, including the many simple reads that
  currently run on injected repositories -- not just the multi-table QueryRunner transactions.
- **Full enforcement:** a dedicated non-privileged DB role for the runtime, with every out-of-request
  code path (admin, auth bootstrap, cron jobs, seeders) given explicit context, and policies enforced.

---

## Why this is non-trivial here (current state)

| Fact | Source | Consequence |
|------|--------|-------------|
| The runtime connects as `${POSTGRES_USER}`, which the official `postgres` image creates as a **cluster superuser** | `docker-compose.prod.yml`, `docker-compose.dev.yml` | Superusers (and `BYPASSRLS` roles) bypass RLS **unconditionally**, even with `FORCE`. RLS is inert today. A separate non-privileged runtime role is **mandatory**, not optional. |
| Services inject `@InjectRepository(X)` repositories bound to the default pool **and** create ad-hoc `dataSource.createQueryRunner()` transactions | `backend/src/accounts/accounts.service.ts` and ~40 peers | Simple reads land on an arbitrary pooled connection. To make RLS cover them, every query in a request must run on one connection carrying the user's identity. |
| An AsyncLocalStorage request context already exists (`{ userId, timezone }`), entered around `next.handle()` | `backend/src/common/request-context.ts`, `.../interceptors/request-context.interceptor.ts` | The natural hook to also pin a connection and set the DB session variable per request. |
| Delegation rewrites `req.user.id` to the **owner's** id when a delegate acts | `backend/src/auth/strategies/jwt.strategy.ts` | `req.user.id` is exactly the value to put in the RLS variable -- delegation maps cleanly. |
| ~50 tables; most carry `user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE` + `idx_*_user`; UUID PKs | `database/schema.sql` | Direct tables get a trivial policy. |
| Several tables are scoped **indirectly** (no `user_id`): `holdings`->accounts, `transaction_splits`->transactions, `scheduled_transaction_splits`, `security_prices`->securities, `monte_carlo_cash_flows`, and junctions (`transaction_tags`, `transaction_split_tags`, `security_tags`, ...) | entities / schema | These need join-based (`EXISTS`) policies. |
| Global reference tables have no owner: `currencies`, `exchange_rates` | schema | Must stay world-readable -- RLS left disabled. |
| Migrations are raw numbered SQL (`NNN_*.sql`), run on startup by `db-migrate.ts` as the owner, tracked in `schema_migrations`; every migration must also update `database/schema.sql` | `database/CLAUDE.md` | RLS ships as ordinary migrations + parallel `schema.sql` edits. db-init/db-migrate run as owner -> inherently exempt. |
| ~17 `@Cron` jobs (e.g. `processAutoPostTransactions` does a cross-user `IN (...)` then loops per user) run with **no** request context; neither compose file starts a separate scheduler, so they likely run **in the API process** | `backend/CLAUDE.md`, `scheduled-transactions.service.ts` | Under enforcement these would inherit the app role and see **zero rows** unless given explicit context. Biggest operational risk. |
| Integration tests build schema via TypeORM `synchronize` and connect as the superuser | `backend/test/helpers/integration-setup.ts` | `synchronize` cannot create policies and the superuser bypasses them -- tests must explicitly apply policies and drop to the app role. |

---

## Design: six pillars

1. **Two roles.** Keep `monize_user` (superuser/owner) for DDL, migrations, seed, and privileged work.
   Add `monize_app` (LOGIN, **not** superuser, **not** owner, **no** `BYPASSRLS`) as the runtime role.
   Privilege and row-visibility are orthogonal in Postgres -- `monize_app` gets table DML grants but RLS
   still filters its rows.
2. **One session variable, fail-closed.** A custom GUC `app.current_user_id` carries the effective user.
   A helper `app_current_user_id()` returns `NULL` when it is unset/empty, so every policy predicate is
   false -> **zero rows** (deny), never allow.
3. **Request-pinned connection + ambient EntityManager (the robust mechanism).** An interceptor pins one
   connection per authenticated request, sets the GUC on it, and stashes that connection's
   `EntityManager` in the existing ALS. Services resolve their manager/repository from ALS, so all reads
   and writes for a request run on the one connection carrying the identity.
4. **Privileged escape hatch via a second GUC.** `app.bypass_rls = 'on'`, set only by an explicit,
   greppable `withSystemContext()` helper, lets admin / auth-bootstrap / cross-user jobs / seeders see
   across users. Policies OR it in. (A stronger owner-DataSource alternative for admin is noted below.)
5. **Policies for every owned table**, direct (`user_id = app_current_user_id()`) and indirect (`EXISTS`
   against the parent), shipped as numbered migrations mirrored into `schema.sql`. Reference tables left
   RLS-disabled.
6. **Phased, flag-gated rollout** ending in the one-switch flip of the runtime role to `monize_app`, with
   instant revert by switching back.

---

## Implementation Phases

### Phase 1: DB roles, ownership, grants, env

Create the runtime role with its password from env (it cannot live in committed SQL) in
`backend/src/db-init.ts`, which runs as owner at startup before the app connects:

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'monize_app') THEN
    EXECUTE format('CREATE ROLE monize_app LOGIN PASSWORD %L', current_setting('monize.app_password'));
  END IF;
END $$;
```

Grants live in the first RLS migration (run by `db-migrate` as owner):

```sql
GRANT USAGE ON SCHEMA public TO monize_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO monize_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO monize_app;
-- future migration-created tables are auto-granted:
ALTER DEFAULT PRIVILEGES FOR ROLE monize_user IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO monize_app;
ALTER DEFAULT PRIVILEGES FOR ROLE monize_user IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO monize_app;
```

Env / compose:
- New `DATABASE_APP_USER` / `DATABASE_APP_PASSWORD` in `.env.example` and all `docker-compose*.yml`.
- `backend/src/app.module.ts` TypeORM factory reads `DATABASE_APP_USER/PASSWORD` when `RLS_ENFORCE=true`,
  else falls back to `DATABASE_USER` (image is safe to deploy before the role exists; revert is one flag).
- `db-init.ts`, `db-migrate.ts`, and the seed entrypoint keep using `DATABASE_USER` (owner). The split is
  **by process**: startup scripts = owner; long-running API = `monize_app`.

`FORCE ROW LEVEL SECURITY` is intentionally **not** used: migrations and privileged jobs run as the
owner and rely on the owner's natural RLS exemption. The net is enforced by the runtime role being a
non-owner, which is sufficient.

### Phase 2: Per-request tenant context (the robust mechanism)

This is the heart of the work and the larger refactor.

**a) Extend the ALS context** (`backend/src/common/request-context.ts`):
```ts
export interface RequestContext { userId?: string; timezone?: string; manager?: EntityManager; }
```

**b) New `RlsContextInterceptor`** (ordered before `RequestContextInterceptor`) for authenticated HTTP
requests -- pin a connection, set the GUC, expose its manager, reset+release at the end:
```ts
const qr = this.dataSource.createQueryRunner();
await qr.connect();
await qr.query("SELECT set_config('app.current_user_id', $1, false)", [userId]); // this connection only
try {
  return await runWithContext({ userId, timezone, manager: qr.manager }, () => next.handle());
} finally {
  await qr.query("SELECT set_config('app.current_user_id', '', false)"); // reset before returning to pool
  await qr.release();
}
```
Set-on-pin + reset-on-release (in `finally`) bounds the cross-request leak risk: a connection never
carries a prior request's id into a new one. (A request-wide `BEGIN/SET LOCAL/COMMIT` is the textbook
alternative but turns the whole request into one transaction -- an atomicity change avoided by pinning
the connection without a forced outer transaction.)

**c) Tenant manager accessor** (`backend/src/common/db/tenant-manager.ts`):
```ts
export function tenantManager(fallback: DataSource): EntityManager {
  return getRequestContext()?.manager ?? fallback.manager; // fallback only outside a request scope
}
```

**d) Refactor services to resolve data access from ALS** instead of injected repos. The change in each of
~40 services is mechanical and **fail-loud** -- a missed site returns zero rows / errors in tests, never
a silent leak:
- Reads: `this.accountsRepository.findOne(...)` -> `tenantManager(this.dataSource).getRepository(Account).findOne(...)`.
- Multi-table writes: replace the manual `createQueryRunner()`/`startTransaction()`/`release()` block with
  `tenantManager(this.dataSource).transaction(async (m) => { ... })`. Because the ambient manager belongs
  to the pinned QueryRunner, `.transaction()` reuses that same connection -- the GUC is already present,
  and per-operation atomicity is preserved exactly as today (no request-wide transaction).

**e) Fire-and-forget writes** that intentionally outlive the request (`touchLastActivity`, timezone-cache
persistence in `request-context.interceptor.ts`) must **not** use the ambient manager (they run after the
connection is released). Route them through `withSystemContext()` (Phase 4) so they are not tied to the
request lifecycle.

> Alternative considered and rejected for this codebase: the `typeorm-transactional` library would
> auto-bind injected repos to an ALS transaction with far less churn, but it monkey-patches TypeORM's
> Repository prototype globally -- too much hidden magic for a security-critical financial app whose
> conventions favor explicitness. The homegrown accessor keeps every connection's identity explicit.

### Phase 3: RLS helper functions and policies

Helpers (migration + `schema.sql`):
```sql
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION app_bypass_rls() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.bypass_rls', true) = 'on'
$$;
```

Direct `user_id` tables (the bulk -- `accounts, transactions, categories, payees, tags, securities,
budgets, budget_*, scheduled_transactions, investment_transactions, custom_reports, ai_*,
personal_access_tokens, action_history, monthly_account_balances, monte_carlo_scenarios,
user_preferences, user_currency_preferences, refresh_tokens, trusted_devices, account_delegates,
emergency_access_*, import_column_mappings, auto_backup_settings, oauth_payloads`, ...):
```sql
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS accounts_isolation ON accounts;       -- idempotent
CREATE POLICY accounts_isolation ON accounts
  USING (user_id = app_current_user_id() OR app_bypass_rls())
  WITH CHECK (user_id = app_current_user_id() OR app_bypass_rls());
```

Indirect / join-scoped tables (resolve ownership through the parent; existing FK indexes make this an
index probe):
```sql
ALTER TABLE holdings ENABLE ROW LEVEL SECURITY;
CREATE POLICY holdings_isolation ON holdings
  USING (app_bypass_rls() OR EXISTS (
    SELECT 1 FROM accounts a WHERE a.id = holdings.account_id AND a.user_id = app_current_user_id()))
  WITH CHECK (app_bypass_rls() OR EXISTS (
    SELECT 1 FROM accounts a WHERE a.id = holdings.account_id AND a.user_id = app_current_user_id()));
```
Same shape for `transaction_splits`->transactions, `scheduled_transaction_splits`->scheduled_transactions,
`security_prices`->securities, `monte_carlo_cash_flows`->scenarios, and the junction tables (check the
owning entity side).

`users` table -- self-access only; cross-user reads (admin, login-by-email/oidc before a session exists)
go through `app.bypass_rls`:
```sql
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_self ON users
  USING (id = app_current_user_id() OR app_bypass_rls())
  WITH CHECK (id = app_current_user_id() OR app_bypass_rls());
```

Global reference tables -- leave RLS **disabled** on `currencies` and `exchange_rates` (reference data;
writes already go through controlled/owner paths). Document the deliberate choice.

Migration sequencing (continue from the current max prefix -- verify with `ls database/migrations`):
- `0NN_rls_role_grants_and_helpers.sql` -- grants, default privileges, helper functions. Behaviorally inert.
- `0NN+1_rls_direct_tables.sql` -- enable + policies for all direct `user_id` tables.
- `0NN+2_rls_indirect_tables.sql` -- `EXISTS` policies for join-scoped + junction tables.
- `0NN+3_rls_users_and_reference.sql` -- `users` policy; document reference tables left disabled.

Each is idempotent (`DROP POLICY IF EXISTS` then `CREATE`; `ENABLE` is idempotent) and **mirrored into
`database/schema.sql`** so a fresh `db-init` equals a migrated DB.

> Performance note: indirect policies run the `EXISTS` per candidate row. With existing FK indexes this is
> a cheap index probe, and because app-level filtering already narrows the result set, the predicate is
> almost always validating an already-correct, already-small set. Watch the heaviest bulk readers
> (investment reports, full backup export over `security_prices`/`transaction_splits`) during the
> monitoring phase; if any regress, run those specific export paths under `withSystemContext`.

### Phase 4: Privileged / out-of-request contexts

`withSystemContext(fn)` and `withUserContext(userId, fn)` (`backend/src/common/db/with-context.ts`) pin a
connection, `set_config('app.bypass_rls','on', false)` (system) or `set_config('app.current_user_id',
userId, false)` (specific user), stash the manager in ALS, run `fn`, reset+release. They mirror the
interceptor for code with no HTTP request. Apply them:

- **Admin** (`backend/src/admin/`, RolesGuard + `@Roles('admin')`): wrap cross-user service calls in
  `withSystemContext`. *Hardening option:* if the maintainer wants the app role to have **no** self-bypass
  path at all, give the admin module a second TypeORM DataSource connecting as the owner instead of the
  `app.bypass_rls` GUC -- strictly more auditable, at the cost of a second connection identity. Default
  recommendation is the GUC for uniformity.
- **Auth bootstrap** (`AuthService` login/register/refresh, `jwt.strategy` validate): the by-email /
  by-oidc-subject lookups happen before a session `userId` exists -> wrap in `withSystemContext`.
- **Cron jobs (~17 handlers):** cross-user fan-out queries (e.g. `getUsersByEffectiveTimezone`,
  `processAutoPostTransactions`'s `IN (...)`) run under `withSystemContext`; the per-user body
  (`this.post(scheduled.userId, ...)`) runs under `withUserContext(userId)` so it still gets the RLS net.
- **Seeders** (`database/seed.service.ts`, `demo-seed.service.ts`, daily demo reset): wrap the whole seed
  in `withSystemContext` (its raw `DELETE ... WHERE user_id = $1` / cross-user inserts keep working).
- **db-init / db-migrate:** unchanged -- already run as owner, inherently exempt.

Wire `withSystemContext`/`withUserContext` in during Phase 2 (while RLS is still latent), so they are
no-ops until enforcement and there is no flag-day where jobs suddenly break.

### Phase 5: Tests

- **Apply policies in the integration harness.** In `backend/test/helpers/integration-setup.ts`, after the
  `synchronize` schema is built, run a shared `applyRlsPolicies(dataSource)` that executes the RLS
  migration SQL and creates `monize_app` in the test DB. Keeps test schema in lockstep with prod.
- **New `backend/test/integration/rls-enforcement.integration.spec.ts`** -- the headline proof. Inside a
  transaction, `SET LOCAL ROLE monize_app` (drops the superuser test connection to the unprivileged role),
  then:
  - GUC = userA -> raw `SELECT * FROM accounts` (no app-level `WHERE`) returns **only** userA's rows; GUC =
    userB -> only userB's.
  - GUC unset/empty/bogus -> **zero rows** for a direct table (`accounts`) and an indirect table
    (`transaction_splits` / `holdings`). The fail-closed assertion.
  - `WITH CHECK`: `INSERT INTO accounts(user_id, ...)` with another user's id while GUC = userA -> fails.
  - `app.bypass_rls = 'on'` -> cross-user `SELECT` returns both users (proves jobs/admin work).
- **Keep the existing isolation suite green:** `security-cross-user-isolation.integration.spec.ts` must
  still pass after the ALS manager is wired into the test DataSource.
- **Unit tests** for `tenantManager`, `withUserContext`, `withSystemContext` (assert exact `set_config` SQL
  and reset-on-release), to protect the 95%/85% coverage thresholds.

### Phase 6: Rollout, flags, docs

Phased and independently revertible:
1. **Plumbing as no-op** (`RLS_ENABLED=false`): ship Phase 2 helpers/interceptor/accessor + the
   `withSystemContext`/`withUserContext` call sites. No DB change, no behavior change.
2. **Policies created, runtime unchanged:** land the Phase 3 migrations. Runtime still connects as
   superuser -> policies exist but are bypassed. Pure latent safety margin; soak here.
3. **Monitoring on staging/demo:** point `docker-compose.demo.yml` runtime at `monize_app`, enable Postgres
   statement/policy logging, run full e2e + integration. Hunt for "zero rows" surprises (a missed
   `withSystemContext` on a job) and bulk-endpoint latency.
4. **Enforce in prod:** flip prod runtime to `DATABASE_APP_USER` (`monize_app`). One switch turns the net
   on; switching back to `DATABASE_USER` is the instant emergency revert (no DB change).

Flags: `RLS_ENABLED` (gates GUC emission); `DATABASE_APP_USER/PASSWORD` presence + `RLS_ENFORCE` selects
the unprivileged runtime role. Document in root `CLAUDE.md`, `database/CLAUDE.md`, `.env.example`, and a new
`docs/rls.md` runbook (including the manual down-SQL, since the migration runner is forward-only).

i18n: RLS is backend/DB only. A `WITH CHECK` violation surfaces as a Postgres error; ensure
`GlobalExceptionFilter` maps "new row violates row-level security policy" to a generic 403/404 (these
should never reach users, because app-level filtering prevents hitting them) -- any new user-facing string
there must be internationalized per project rules.

---

## Database Migration (representative)

```sql
-- 0NN_rls_role_grants_and_helpers.sql  (run as owner; role itself created in db-init from env password)
GRANT USAGE ON SCHEMA public TO monize_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO monize_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO monize_app;
ALTER DEFAULT PRIVILEGES FOR ROLE monize_user IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO monize_app;
ALTER DEFAULT PRIVILEGES FOR ROLE monize_user IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO monize_app;

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_bypass_rls() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.bypass_rls', true) = 'on' $$;

-- 0NN+1 / +2 / +3: per-table  ENABLE ROW LEVEL SECURITY + DROP/CREATE POLICY  (direct, indirect, users)
-- Each change mirrored into database/schema.sql.
```

---

## Security Analysis

| Threat | Protected? | Notes |
|---|---|---|
| App bug: a new/refactored query forgets `WHERE user_id` | Yes | RLS returns only the current user's rows regardless of the missing app-level filter. This is the core reason for the feature. |
| Raw SQL path forgets to scope by user | Yes | Same -- the policy applies to every statement the `monize_app` role runs. |
| Cross-user write (insert/update a row to another user's id) | Yes | `WITH CHECK` rejects it. |
| GUC unset (e.g. a code path with no context) | Yes (fail-closed) | `app_current_user_id()` is NULL -> zero rows / write rejected, never an open door. |
| GUC leaks across pooled requests | Mitigated | Set-on-pin + reset-on-release in `finally`; proven by the concurrent-traffic + bogus-GUC tests. |
| Compromised app process sets `app.bypass_rls` | Partial | The GUC is only set by greppable helpers, never from user input (all queries parameterized). The owner-DataSource hardening removes even this path for admin. |
| DB superuser / owner access (DBA, migrations) | By design exempt | Owner bypass is what lets migrations/seed/jobs operate; not a tenant-isolation threat. |
| Stolen DB backup at rest | No | RLS is access-time, not at-rest. (Encryption-at-rest / the user-encryption plan addresses this.) |

---

## Risks and Complexities

1. **Background jobs breaking (highest likelihood).** ~17 crons + seeders run context-less -> zero rows
   under enforcement. Mitigation: wire `withSystemContext`/`withUserContext` in during Phase 1 (no-op until
   enforcement); the staging soak (Phase 6.3) surfaces any missed handler before prod.
2. **GUC leak across pooled requests (highest severity).** Mitigation: set-on-pin + reset-on-release in a
   `finally`; the "bogus/empty GUC => zero rows" test plus a concurrent multi-user soak prove it.
3. **The ~40-service refactor.** Mechanical but broad. Mitigation: it is fail-loud (a missed site errors or
   returns empty in tests), and it can land incrementally behind `RLS_ENABLED=false`.
4. **Connection-pool pressure.** Pinning a connection per request, and long requests (QIF import, backup
   export) holding it, can stress the default ~10-connection pool. Mitigation: raise `extra.max`; consider
   exempting specific streaming endpoints.
5. **Performance on indirect/junction policies for bulk reads.** Mitigation: existing FK indexes; the
   predicate is redundant over an already-narrow set; run specific heavy exports under system context.
6. **App-role self-bypass via `app.bypass_rls`.** Mitigation: helper-only, never user-controlled; optional
   owner-DataSource for admin removes the path entirely.
7. **Schema drift** between `schema.sql` and migrations. Mitigation: mirror every policy into `schema.sql`
   in the same PR; add a CI assertion that a fresh-init DB and a migrated DB have identical `pg_policies`.

---

## Verification (end to end)

1. `cd backend && npm run build && npm run lint` -- clean.
2. `npm run test:unit`, then the integration suites incl. the new `rls-enforcement` spec and the existing
   `security-cross-user-isolation` spec -- all green.
3. `docker compose -f docker-compose.dev.yml up`: register two users; confirm normal app behavior (accounts,
   transactions, reports, budgets) with the runtime on `monize_app`.
4. Manual DB proof: `psql` as `monize_app`, `SET app.current_user_id = '<userA>'; SELECT count(*) FROM
   transactions;` -> only userA's count; set to userB -> userB's; `RESET app.current_user_id; SELECT count(*)
   FROM transactions;` -> `0`.
5. Trigger a cron path (scheduled-transaction auto-post) and the demo reset under enforcement -> confirm they
   still process across users (system context working).
6. `npm run i18n:check` -- pseudo-locale fresh (only relevant if any exception copy was added).

---

## Estimated Scope

- **New files (~6):** `RlsContextInterceptor`, `tenant-manager.ts`, `with-context.ts`, 4 RLS migrations,
  `rls-enforcement.integration.spec.ts`, `docs/rls.md` runbook.
- **Modified files (~50+):** ~40 domain services (resolve manager from ALS), `app.module.ts`, `db-init.ts`,
  `request-context.ts` + interceptor, admin/auth/cron/seeder paths, `database/schema.sql`,
  `integration-setup.ts`, `.env.example`, all `docker-compose*.yml`, root + `database` CLAUDE.md.
- **No new npm dependency** (homegrown ALS accessor; `typeorm-transactional` deliberately avoided).
- **DB objects:** 1 new role, ~45 tables x (enable + policy), 2 helper functions, grants + default
  privileges.
- **Rollout:** behavior-neutral until the runtime role is switched; one-flag revert.

**Net assessment:** the defense-in-depth framing is what makes this tractable -- because app-level filtering
stays, RLS almost always validates an already-correct query, so the failure modes that matter are
*operational* (jobs, pooling, auth bootstrap) rather than *functional*, and every one of those fails loudly
(empty results / login failure) rather than silently leaking. The dominant cost is the ~40-service context
refactor; the dominant risk is missed out-of-request paths, which the phased rollout is designed to catch.
