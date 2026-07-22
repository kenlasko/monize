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
| Backup **restore** runs DDL -- `ALTER TABLE ... DISABLE TRIGGER "update_*_updated_at"` -- to preserve restored `updated_at` values | `backend/src/backup/backup.service.ts` (~line 1317) | `ALTER TABLE` requires table **ownership**; neither `app.bypass_rls` nor DML grants help. Restore breaks under `monize_app` unless the trigger function is made GUC-aware (Phase 3) or restore gets an owner DataSource (Phase 4). |
| The emergency-access **claim** flow operates on the grantor's rows while the requester is the grantee (or a bare claim token): reads `users`, deletes trusted devices, revokes refresh tokens | `backend/src/emergency-access/emergency-access-claim.controller.ts` | A cross-user HTTP path running with the *wrong* user context -- worse than none: silent zero-row no-ops under RLS. Must run under `withSystemContext` (Phase 4). |

---

## Design: six pillars

1. **Two roles.** Keep `monize_user` (superuser/owner) for DDL, migrations, seed, and privileged work.
   Add `monize_app` (LOGIN, **not** superuser, **not** owner, **no** `BYPASSRLS`) as the runtime role.
   Privilege and row-visibility are orthogonal in Postgres -- `monize_app` gets table DML grants but RLS
   still filters its rows.
2. **One session variable, fail-closed.** A custom GUC `app.current_user_id` carries the effective user.
   A helper `app_current_user_id()` returns `NULL` when it is unset/empty, so every policy predicate is
   false -> **zero rows** (deny), never allow.
3. **Lazily request-pinned connection + ambient EntityManager (the robust mechanism).** The first DB
   touch of an authenticated request pins one connection, sets the GUC on it, and caches it in the
   existing ALS; the interceptor releases it when the response -- including streamed responses --
   completes. Services resolve their manager/repository from ALS, so all reads and writes for a request
   run on the one connection carrying the identity, and requests that never touch the DB never hold a
   connection.
4. **Privileged escape hatch via a second GUC.** `app.bypass_rls = 'on'`, set only by an explicit,
   greppable `withSystemContext()` helper, lets admin / auth-bootstrap / cross-user jobs / seeders see
   across users. Policies OR it in. (A stronger owner-DataSource alternative for admin is noted below.)
5. **Policies for every owned table**, direct (`user_id = app_current_user_id()`) and indirect (`EXISTS`
   against the parent), shipped as numbered migrations mirrored into `schema.sql`. Reference tables left
   RLS-disabled.
6. **Phased rollout with one mode flag and two independent flips.** A single `RLS_MODE=off|shadow|enforce`
   enum (no boolean pair, so no invalid combination is representable). Flip A switches the runtime role to
   `monize_app` while **no table has RLS enabled** -- only privilege bugs (`permission denied`, DDL) can
   surface, visibility unchanged. Flip B ships the enable migration -- only context bugs (zero rows) can
   surface. Each flip reverts instantly by setting `RLS_MODE=shadow` (the owner role bypasses RLS even on
   enabled tables).

---

## Implementation Phases

### Phase 1: DB roles, ownership, grants, env

Create the runtime role with its password from env (it cannot live in committed SQL) in
`backend/src/db-init.ts`, which runs as owner at startup before the app connects. The password reaches
SQL via a **parameterized** `set_config` -- never string interpolation -- and the role's password is
re-applied on every startup so rotating `DATABASE_APP_PASSWORD` in env is sufficient (an
`IF NOT EXISTS`-only create would silently ignore rotation forever):

```sql
-- db-init first runs, parameterized: SELECT set_config('monize.app_password', $1, false)
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'monize_app') THEN
    EXECUTE format('CREATE ROLE monize_app LOGIN PASSWORD %L', current_setting('monize.app_password'));
  ELSE
    EXECUTE format('ALTER ROLE monize_app PASSWORD %L', current_setting('monize.app_password'));
  END IF;
END $$;
```

If `DATABASE_APP_PASSWORD` is unset, `db-init` skips role creation with a logged warning -- existing
deployments upgrade with zero new required env vars and zero behavior change; RLS simply cannot be
enforced until the password is provided.

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
- New `DATABASE_APP_USER` / `DATABASE_APP_PASSWORD` in `.env.example` and all `docker-compose*.yml`,
  referenced with empty defaults (`${DATABASE_APP_PASSWORD:-}`) so existing `.env` files without the new
  keys neither warn nor break on upgrade.
- **One mode flag, not two booleans:** `RLS_MODE=off|shadow|enforce` (default `off`). `off` = no GUC
  emission, owner role -- identical to pre-RLS behavior. `shadow` = GUCs emitted and connections pinned,
  but runtime still the owner (policies bypassed) -- exercises the whole mechanism safely. `enforce` =
  GUCs emitted and runtime connects as `monize_app`. The dangerous state a two-boolean design allows
  (unprivileged role with no GUC emission -> zero rows everywhere) is **unrepresentable** by
  construction; startup validation reduces to one rule: `enforce` requires `DATABASE_APP_PASSWORD`.
- `backend/src/app.module.ts` TypeORM factory reads `DATABASE_APP_USER/PASSWORD` when
  `RLS_MODE=enforce`, else falls back to `DATABASE_USER` (image is safe to deploy before the role
  exists; revert is one flag). The factory also sets an explicit, raised pool size (`extra.max`) --
  today it silently uses the pg default of 10, too small once requests pin connections (see Phase 2).
- `db-init.ts`, `db-migrate.ts`, and the seed entrypoint keep using `DATABASE_USER` (owner). The split is
  **by process**: startup scripts = owner; long-running API = `monize_app`.

`FORCE ROW LEVEL SECURITY` is intentionally **not** used: migrations and privileged jobs run as the
owner and rely on the owner's natural RLS exemption. The net is enforced by the runtime role being a
non-owner, which is sufficient.

### Phase 2: Per-request tenant context (the robust mechanism)

This is the heart of the work and the larger refactor.

**a) Extend the ALS context** (`backend/src/common/request-context.ts`):
```ts
export interface RequestContext { userId?: string; timezone?: string; system?: boolean; qr?: QueryRunner; }
```

**b) New `RlsContextInterceptor`** (ordered before `RequestContextInterceptor`) for authenticated HTTP
requests -- **lazy pinning, release on stream completion**. The interceptor does *not* acquire a
connection up front; it only seeds the ALS context and guarantees release. Two reasons this shape is
required, not optional:

- **Pool pressure.** The pool defaults to 10 connections, and several endpoints stream for a long time
  (AI relay/query SSE waiting on LLM roundtrips, MCP HTTP, backup export). Eager pinning holds a
  connection for the whole stream -- roughly ten concurrent AI chats would exhaust the pool for the
  entire app. Lazy pinning holds a connection only from the first DB touch, and endpoints that never
  touch the DB never pin one.
- **Correct release for streams.** `try/finally` around `next.handle()` is wrong for observables: the
  handler returns the observable immediately, so `finally` would fire before the response has streamed.
  Release must happen in RxJS `finalize`, which fires on completion *or* error, including SSE.

```ts
intercept(ctx: ExecutionContext, next: CallHandler) {
  const { userId, timezone } = ...; // from req.user (delegation already resolved by jwt.strategy)
  const store: RequestContext = { userId, timezone };
  return runWithContext(store, () =>
    next.handle().pipe(finalize(() => void releasePinned(store))),
  );
}

async function releasePinned(store: RequestContext) {
  if (!store.qr) return;
  try {
    await store.qr.query("SELECT set_config('app.current_user_id', '', false)"); // reset before pooling
    await store.qr.release();
  } catch {
    // Reset failed (connection dead or in an unknown state): destroy the underlying client
    // instead of returning it to the pool -- never pool a connection that may still carry a user id.
    await destroyQueryRunner(store.qr);
  }
}
```
Set-on-pin + reset-on-release bounds the cross-request leak risk: a connection never carries a prior
request's id into a new one, and a connection whose reset fails is destroyed, never pooled. (A
request-wide `BEGIN/SET LOCAL/COMMIT` is the textbook alternative but turns the whole request into one
transaction -- an atomicity change avoided by pinning the connection without a forced outer
transaction.)

**c) Tenant manager accessor** (`backend/src/common/db/tenant-manager.ts`) -- pins on first touch, and
**throws when no context exists**. A silent fallback to `dataSource.manager` would mean "connection with
no GUC" under enforcement: zero rows that look exactly like empty data. Refusing instead moves that
whole failure class to dev time -- a context-less call path throws in unit tests and local dev at
`RLS_MODE=off`, long before enforcement:
```ts
export async function tenantManager(dataSource: DataSource): Promise<EntityManager> {
  const ctx = getRequestContext();
  if (!ctx || (!ctx.userId && !ctx.system)) {
    throw new Error(
      "DB access outside request/user/system context -- wrap the call path in withUserContext/withSystemContext",
    );
  }
  if (!ctx.qr) {
    const qr = dataSource.createQueryRunner();
    await qr.connect();
    if (ctx.system) {
      await qr.query("SELECT set_config('app.bypass_rls', 'on', false)"); // this connection only
    } else {
      await qr.query("SELECT set_config('app.current_user_id', $1, false)", [ctx.userId]); // this connection only
    }
    ctx.qr = qr; // subsequent touches in this scope reuse the pinned connection
  }
  return ctx.qr.manager;
}
```
The unauthenticated health check keeps its direct DataSource ping (it reads no user data and must not
depend on the context machinery); anything else touching the DB outside a request must be inside
`withUserContext`/`withSystemContext` (Phase 4), which seed this same ALS scope.

**d) Refactor services to resolve data access from ALS** instead of injected repos. The change in each of
~40 services is mechanical and **fail-loud** -- a call path with no ambient context throws immediately
(see (c)), never a silent leak or a silent zero-row result:
- Reads: `this.accountsRepository.findOne(...)` ->
  `(await tenantManager(this.dataSource)).getRepository(Account).findOne(...)`.
- Multi-table writes: replace the manual `createQueryRunner()`/`startTransaction()`/`release()` block with
  `(await tenantManager(this.dataSource)).transaction(async (m) => { ... })`. Because the ambient manager
  belongs to the pinned QueryRunner, `.transaction()` reuses that same connection -- the GUC is already
  present, and per-operation atomicity is preserved exactly as today (no request-wide transaction).
- Land the refactor **module-by-module behind `RLS_MODE=off`**, never as one long-lived branch. Add a CI
  ratchet on the count of remaining `@InjectRepository` sites (the number may only decrease); when it
  hits zero, ban the decorator outside test helpers via lint. Progress stays visible and drift is
  impossible.

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

Same migration: make the shared `updated_at` trigger GUC-aware, so backup **restore** no longer needs
DDL. Today restore runs `ALTER TABLE ... DISABLE TRIGGER "update_*_updated_at"` to preserve restored
timestamps (`backup.service.ts` ~1317) -- `ALTER TABLE` requires table *ownership*, which `monize_app`
must not have. Behaviorally inert while the GUC is unset:
```sql
CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.preserve_timestamps', true) = 'on' THEN
    RETURN NEW; -- restore path: keep the restored updated_at values
  END IF;
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

Direct `user_id` tables (the bulk -- `accounts, transactions, categories, payees, tags, securities,
budgets, budget_*, scheduled_transactions, investment_transactions, custom_reports, ai_*,
personal_access_tokens, action_history, monthly_account_balances, monte_carlo_scenarios,
user_preferences, user_currency_preferences, refresh_tokens, trusted_devices, account_delegates,
emergency_access_*, import_column_mappings, auto_backup_settings, oauth_payloads`, ...):
```sql
-- Note: no ENABLE here. A policy on a table without ENABLE ROW LEVEL SECURITY is inert;
-- the ENABLE statements ship together in the final migration (flip B of the rollout).
DROP POLICY IF EXISTS accounts_isolation ON accounts;       -- idempotent
CREATE POLICY accounts_isolation ON accounts
  USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
  WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
```

The scalar-subquery form `(SELECT app_current_user_id())` is deliberate: the planner turns it into an
InitPlan evaluated **once per statement** instead of per row. A bare function call relies on SQL-function
inlining, which is fragile across minor planner changes; the initplan form is the standard RLS idiom and
matters on sequential scans (backup export, bulk reports).

Indirect / join-scoped tables (resolve ownership through the parent; existing FK indexes make this an
index probe):
```sql
CREATE POLICY holdings_isolation ON holdings
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = holdings.account_id AND a.user_id = (SELECT app_current_user_id())))
  WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = holdings.account_id AND a.user_id = (SELECT app_current_user_id())));
```
Same shape for `transaction_splits`->transactions, `scheduled_transaction_splits`->scheduled_transactions,
`security_prices`->securities, `monte_carlo_cash_flows`->scenarios, and the junction tables (check the
owning entity side).

`users` table -- self-access only; cross-user reads (admin, login-by-email/oidc before a session exists)
go through `app.bypass_rls`:
```sql
CREATE POLICY users_self ON users
  USING (id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
  WITH CHECK (id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
```

Global reference tables -- leave RLS **disabled** on `currencies` and `exchange_rates` (reference data;
writes already go through controlled/owner paths). Document the deliberate choice.

Migration sequencing (continue from the current max prefix -- verify with `ls database/migrations`).
`CREATE POLICY` on a table that has not run `ENABLE ROW LEVEL SECURITY` is inert, so all policies ship
early and the enable ships **last, in its own release** -- it is the only behavior-changing migration
and it is flip B of the rollout:
- `0NN_rls_role_grants_and_helpers.sql` -- grants, default privileges, helper functions, GUC-aware
  `update_updated_at_column()` replacement. Inert.
- `0NN+1_rls_policies_direct.sql` -- policies for all direct `user_id` tables (no enable). Inert.
- `0NN+2_rls_policies_indirect.sql` -- `EXISTS` policies for join-scoped + junction tables. Inert.
- `0NN+3_rls_policies_users.sql` -- `users` policy; document reference tables left disabled. Inert.
- `0NN+4_rls_enable.sql` -- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` for every policied table.
  Ships in the flip-B release only after flip A (privilege drop) has soaked in prod.

Each is idempotent (`DROP POLICY IF EXISTS` then `CREATE`; `ENABLE` is idempotent) and **mirrored into
`database/schema.sql`** so a fresh `db-init` equals a migrated DB.

> Performance note: indirect policies run the `EXISTS` per candidate row. With existing FK indexes this is
> a cheap index probe, and because app-level filtering already narrows the result set, the predicate is
> almost always validating an already-correct, already-small set. Watch the heaviest bulk readers
> (investment reports, full backup export over `security_prices`/`transaction_splits`) during the
> monitoring phase; if any regress, run those specific export paths under `withSystemContext`.

### Phase 4: Privileged / out-of-request contexts

`withSystemContext(fn)` and `withUserContext(userId, fn)` (`backend/src/common/db/with-context.ts`) seed
the same ALS scope the interceptor does (`{ system: true }` or `{ userId }`); the first `tenantManager()`
touch inside `fn` lazily pins a connection and sets the matching GUC (`app.bypass_rls = 'on'` or
`app.current_user_id`), and the helper resets + releases in its `finally` (destroying the connection on a
failed reset, same as the interceptor). They mirror the interceptor for code with no HTTP request. Apply
them:

- **Admin** (`backend/src/admin/`, RolesGuard + `@Roles('admin')`): wrap cross-user service calls in
  `withSystemContext`. *Hardening option:* if the maintainer wants the app role to have **no** self-bypass
  path at all, give the admin module a second TypeORM DataSource connecting as the owner instead of the
  `app.bypass_rls` GUC -- strictly more auditable, at the cost of a second connection identity. Default
  recommendation is the GUC for uniformity.
- **Auth bootstrap -- every pre-session path.** Anything that reads or writes a user-scoped table before
  `req.user` exists must be wrapped in `withSystemContext`:
  - `AuthService` login/register/refresh; `jwt.strategy` validate (user + delegation lookups).
  - **PAT validation**: the `personal_access_tokens` lookup by token hash scans across users. The MCP
    server authenticates with PAT bearer, so a miss here breaks every MCP request at the auth step.
  - **Password reset and email verification** token lookups.
  - **OIDC/OAuth callback** and the MCP-connector OAuth flow's `oauth_payloads` reads/writes, which
    happen during authorize before a session exists.
  - Do not trust this hand-enumerated list. As an implementation step, **audit every route reachable
    without `req.user`** (guard-less controllers, public decorators, every Passport strategy) and wrap
    each one -- the staging soak only catches paths the test suites actually exercise.
- **Emergency access:** the claim flow (`emergency-access-claim.controller.ts`) reads and writes the
  *grantor's* rows (`users`, `trusted_devices`, `refresh_tokens`, emergency-access tables) while the
  requester is the grantee or a bare claim token -- it runs with the *wrong* user context, which fails
  silently as zero-row no-ops. Wrap the claim flow (and the expiry monitor's cross-user sweep) in
  `withSystemContext`.
- **Cron jobs (~17 handlers):** cross-user fan-out queries (e.g. `getUsersByEffectiveTimezone`,
  `processAutoPostTransactions`'s `IN (...)`) run under `withSystemContext`; the per-user body
  (`this.post(scheduled.userId, ...)`) runs under `withUserContext(userId)` so it still gets the RLS net.
- **Seeders** (`database/seed.service.ts`, `demo-seed.service.ts`, daily demo reset): wrap the whole seed
  in `withSystemContext` (its raw `DELETE ... WHERE user_id = $1` / cross-user inserts keep working).
- **Backup restore:** replace the `ALTER TABLE ... DISABLE TRIGGER` / `ENABLE TRIGGER` pair in
  `backup.service.ts` with `set_config('app.preserve_timestamps', 'on', false)` on the restore's pinned
  connection -- the Phase 3 trigger function honors it, no DDL needed, and restore runs as `monize_app`
  under the requesting user's normal RLS context. (Alternative: an owner DataSource for the restore
  path, same shape as the admin hardening option.) Reset the GUC in the same `finally` as the release.
- **Unauthenticated health check:** keeps its direct DataSource ping -- it reads no user data and must
  not depend on the context machinery.
- **db-init / db-migrate:** unchanged -- already run as owner, inherently exempt.

Wire `withSystemContext`/`withUserContext` in during Phase 2 (while RLS is still latent), so they are
no-ops until enforcement and there is no flag-day where jobs suddenly break.

**Fence the bypass so it cannot metastasize.** After launch, the path of least resistance for any
"returns zero rows" bug is to wrap it in `withSystemContext` -- each such fix silently widens the bypass.
Two guards, shipped with the helpers themselves:
- An ESLint `no-restricted-imports` rule allows importing `with-context.ts` only from an explicit module
  allowlist (admin, auth bootstrap, emergency access, cron/jobs, seeders, backup). Anywhere else, the
  lint fails -- widening the allowlist is a visible, reviewed decision, not a drive-by fix.
- `withSystemContext` logs each invocation with its call site (rate-limited), so bypass usage in prod is
  observable and auditable.

### Phase 5: Tests

- **Apply policies in the integration harness.** In `backend/test/helpers/integration-setup.ts`, after the
  `synchronize` schema is built, run a shared `applyRlsPolicies(dataSource)` that executes the **actual
  migration files** (`database/migrations/0NN_rls_*.sql`, read from disk -- not a duplicated copy of
  their SQL) and creates `monize_app` in the test DB. One source of truth; the harness cannot drift from
  prod.
- **New `backend/test/integration/rls-enforcement.integration.spec.ts` -- catalog-driven, not
  hand-listed.** The spec enumerates coverage from the DB itself: every table must fall into exactly one
  of three buckets -- (1) has a `user_id` column (direct policy expected), (2) appears in an explicit
  indirect-ownership map (child table -> owning-parent join path), or (3) appears in an explicit
  exemption list (`currencies`, `exchange_rates`, `schema_migrations`). A table in no bucket, or a
  bucketed table missing its policy in `pg_policies`, **fails the suite** -- a future table cannot be
  forgotten, because forgetting is a test failure, not a review miss. For each covered table, inside a
  transaction, `SET LOCAL ROLE monize_app` (drops the superuser test connection to the unprivileged
  role), then generically:
  - GUC = userA -> raw `SELECT * FROM accounts` (no app-level `WHERE`) returns **only** userA's rows; GUC =
    userB -> only userB's.
  - GUC unset/empty/bogus -> **zero rows** for a direct table (`accounts`) and an indirect table
    (`transaction_splits` / `holdings`). The fail-closed assertion.
  - `WITH CHECK`: `INSERT INTO accounts(user_id, ...)` with another user's id while GUC = userA -> fails.
  - `app.bypass_rls = 'on'` -> cross-user `SELECT` returns both users (proves jobs/admin work).
  - `app.preserve_timestamps = 'on'` -> an `UPDATE` keeps the supplied `updated_at` (proves the restore
    path's trigger bypass); unset -> the trigger stamps `CURRENT_TIMESTAMP` as today.
- **Keep the existing isolation suite green:** `security-cross-user-isolation.integration.spec.ts` must
  still pass after the ALS manager is wired into the test DataSource.
- **Unit tests** for `tenantManager`, `withUserContext`, `withSystemContext` (assert exact `set_config` SQL
  and reset-on-release), to protect the 95%/85% coverage thresholds.

### Phase 6: Rollout, flags, docs

Phased and independently revertible. The key structural choice: **privileges drop before RLS turns on**,
so the two failure classes -- `permission denied` (grants, DDL, ownership) and zero rows (missing
context) -- can never surface in the same step:

1. **Plumbing as no-op** (`RLS_MODE=off`): ship the Phase 2 interceptor/accessor + the
   `withSystemContext`/`withUserContext` call sites, module-by-module. Because `tenantManager()` throws
   on context-less DB access, most context gaps surface right here, in dev and CI -- not under
   enforcement. No DB change.
2. **Shadow soak** (`RLS_MODE=shadow`, prod): GUCs emitted, lazy pinning live, runtime still the owner.
   Land the helper/grant + policy migrations (inert without enable). Soak for **weeks, not days** -- the
   new connection lifecycle and pool behavior prove themselves while RLS itself is still off.
3. **Staging/demo, fully enforced:** `docker-compose.demo.yml` runs `RLS_MODE=enforce` *with* the enable
   migration deployed. Postgres statement/policy logging on; full e2e + integration; explicitly exercise
   backup restore, emergency-access claim, and MCP-via-PAT. Hunt zero-row surprises and bulk-endpoint
   latency.
4. **Prod flip A -- privilege drop** (`RLS_MODE=enforce`; enable migration *not* yet deployed to prod):
   runtime becomes `monize_app`, but no table has RLS enabled, so row visibility is unchanged. The only
   bugs that can surface are privilege-class (`permission denied`, DDL) -- loud, greppable, and
   low-stakes. Revert: `RLS_MODE=shadow`.
5. **Prod flip B -- enable RLS:** deploy the release containing `0NN+4_rls_enable.sql`. The only bugs
   that can surface now are context-class (zero rows). Emergency revert is unchanged and instant:
   `RLS_MODE=shadow` -- the owner role bypasses RLS even on enabled tables. Full policy removal remains
   available via the runbook's down-SQL.

Flags: `RLS_MODE=off|shadow|enforce` selects GUC emission + runtime role in one enum;
`DATABASE_APP_USER/PASSWORD` supply the unprivileged role (required for `enforce`, validated at
startup). Document in root `CLAUDE.md`, `database/CLAUDE.md`, `.env.example`, and the runbook
`docs/future-plans/row-level-security-runbook.md` (move it to `docs/rls.md` when the feature ships; it
includes the manual down-SQL, since the migration runner is forward-only).

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

-- 0NN+1 / +2 / +3: per-table  DROP/CREATE POLICY  (direct, indirect, users) -- inert without enable
-- 0NN+4: per-table  ALTER TABLE ... ENABLE ROW LEVEL SECURITY  -- the flip-B release
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
| GUC leaks across pooled requests | Mitigated | Set-on-pin + reset-on-release in `finalize`; a connection whose reset fails is destroyed, never pooled; proven by the concurrent-traffic + bogus-GUC tests. |
| Compromised app process sets `app.bypass_rls` | Partial | The GUC is only set by greppable helpers whose import is lint-allowlisted per module, never from user input (all queries parameterized). Invocations are logged with call site. The owner-DataSource hardening removes even this path for admin. |
| DB superuser / owner access (DBA, migrations) | By design exempt | Owner bypass is what lets migrations/seed/jobs operate; not a tenant-isolation threat. |
| Stolen DB backup at rest | No | RLS is access-time, not at-rest. (Encryption-at-rest / the user-encryption plan addresses this.) |

---

## Risks and Complexities

1. **Out-of-request and pre-session paths breaking (highest likelihood).** ~17 crons + seeders run
   context-less; PAT validation (all MCP traffic), password-reset / OIDC / OAuth bootstrap, the
   emergency-access claim, and backup restore touch user-scoped tables without (or with the *wrong*)
   user context -> zero rows, silent no-ops, or permission errors under enforcement. Mitigation:
   `tenantManager()` **throws** on context-less access, so missed paths fail in dev/CI at `RLS_MODE=off`
   rather than as silent zero rows in prod; wire `withSystemContext`/`withUserContext` in during Phase 2;
   audit every route reachable without `req.user` (Phase 4); the two-flip rollout isolates the remaining
   privilege-class bugs (flip A) from context-class bugs (flip B); the staging soak (Phase 6.3) surfaces
   any missed path before prod.
2. **GUC leak across pooled requests (highest severity).** Mitigation: set-on-pin + reset-on-release in
   `finalize`; a connection whose reset fails is destroyed rather than pooled; the "bogus/empty GUC =>
   zero rows" test plus a concurrent multi-user soak prove it.
3. **The ~40-service refactor.** Mechanical but broad. Mitigation: it is fail-loud (a missed site throws
   at call time), it lands module-by-module behind `RLS_MODE=off` -- never one long-lived branch -- and a
   CI ratchet on remaining `@InjectRepository` sites makes regression impossible and progress visible.
4. **Connection-pool pressure.** The pool defaults to 10 connections and several endpoints stream for
   minutes (AI relay/query SSE waiting on LLM roundtrips, MCP HTTP, backup export, QIF import).
   Mitigation: lazy pinning (a connection is held only from the first DB touch and released in
   `finalize` on stream completion), an explicit raised `extra.max`, and pool-saturation monitoring
   during the soak.
5. **Performance on indirect/junction policies for bulk reads.** Mitigation: existing FK indexes; the
   predicate is redundant over an already-narrow set; run specific heavy exports under system context.
6. **App-role self-bypass via `app.bypass_rls`, and bypass creep over time.** The launch-day surface is
   controlled (helper-only, never user-controlled), but the long-term risk is developers wrapping future
   "zero rows" bugs in `withSystemContext` instead of fixing context -- each one widens the bypass.
   Mitigation: ESLint import allowlist makes widening a reviewed decision; call-site logging keeps prod
   usage auditable; optional owner-DataSource for admin removes the GUC path entirely.
7. **Schema drift** between `schema.sql` and migrations. Mitigation: mirror every policy into `schema.sql`
   in the same PR; add a CI assertion that a fresh-init DB and a migrated DB have identical `pg_policies`.
8. **Connection-pooler incompatibility.** The design depends on session-scoped GUCs on a pinned physical
   connection. A transaction-mode pooler (e.g. pgBouncer in `transaction` mode, common in Kubernetes)
   silently breaks it: statements from one request interleave onto shared server connections, so the GUC
   evaporates (fail-closed zero rows) or, worse, bleeds between requests. Hard constraint, recorded in
   the runbook: **session-mode pooling only**; revisit with a `SET LOCAL`-per-transaction design if a
   transaction-mode pooler ever becomes necessary.

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
6. Under enforcement, exercise the three paths most likely to break: run a backup **restore** (timestamps
   preserved, no `must be owner of table` error), complete an emergency-access **claim**, and make an MCP
   request authenticated by PAT.
7. `npm run i18n:check` -- pseudo-locale fresh (only relevant if any exception copy was added).

---

## Estimated Scope

- **New files (~8):** `RlsContextInterceptor`, `tenant-manager.ts`, `with-context.ts`, 5 RLS migrations
  (policies split from the enable), the catalog-driven `rls-enforcement.integration.spec.ts`, an ESLint
  restriction for `with-context.ts` imports, `docs/rls.md` runbook.
- **Modified files (~55+):** ~40 domain services (resolve manager from ALS), `app.module.ts` (role
  selection, explicit pool size, flag validation), `db-init.ts`, `request-context.ts` + interceptor,
  admin/auth/cron/seeder paths, PAT + password-reset + OAuth bootstrap paths,
  `emergency-access-claim.controller.ts`, `backup.service.ts` (trigger-GUC swap replacing the
  `DISABLE TRIGGER` DDL), `database/schema.sql`, `integration-setup.ts`, `.env.example`, all
  `docker-compose*.yml`, root + `database` CLAUDE.md.
- **No new npm dependency** (homegrown ALS accessor; `typeorm-transactional` deliberately avoided).
- **DB objects:** 1 new role, ~45 tables x (enable + policy), 2 helper functions + a GUC-aware
  replacement of `update_updated_at_column()`, grants + default privileges.
- **Rollout:** behavior-neutral until flip A; two independent flips (privilege drop, then RLS enable),
  each with an instant `RLS_MODE=shadow` revert.

**Net assessment:** the defense-in-depth framing is what makes this tractable -- because app-level filtering
stays, RLS almost always validates an already-correct query, so the failure modes that matter are
*operational* (jobs, pooling, auth bootstrap) rather than *functional*, and every one of those fails loudly
(thrown context errors in dev, `permission denied` at flip A, login failure) rather than silently leaking
or silently returning empty. The dominant cost is the ~40-service context refactor; the dominant risk is
missed out-of-request paths, which the throwing accessor catches at dev time and the two-flip rollout
isolates by failure class.
