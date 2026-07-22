# Plan: Database-Enforced Row-Level Security (RLS)

## Goal

Add PostgreSQL Row-Level Security as a database-enforced safety net **beneath** Monize's existing application-level multi-tenancy. Today every service takes `userId` (from JWT `req.user.id`) as its first argument and filters each query with `WHERE user_id = ?`; this is correct and is covered by `backend/test/integration/security-cross-user-isolation.integration.spec.ts`. RLS is defense in depth: a single forgotten `WHERE user_id` clause anywhere -- a new endpoint, a refactor, a raw query -- must not be able to leak one user's financial data to another. The app-level filtering stays in place; RLS is a second wall the database itself enforces.

This plan targets the **robust, fully-enforced** end state:

- **Full query coverage:** RLS applies to every read and write, including the many simple reads that currently run on injected repositories -- not just the multi-table QueryRunner transactions.
- **Full enforcement:** a dedicated non-privileged DB role for the runtime, with every out-of-request code path (admin, auth bootstrap, cron jobs, seeders) given explicit context, and policies enforced.

---

## Why this is non-trivial here (current state)

| Fact | Source | Consequence |
|------|--------|-------------|
| The runtime connects as `${POSTGRES_USER}`, which the official `postgres` image creates as a **cluster superuser** | `docker-compose.prod.yml`, `docker-compose.dev.yml` | Superusers (and `BYPASSRLS` roles) bypass RLS **unconditionally**, even with `FORCE`. RLS is inert today. A separate non-privileged runtime role is **mandatory**, not optional. |
| Services inject `@InjectRepository(X)` repositories bound to the default pool **and** create ad-hoc `dataSource.createQueryRunner()` transactions | `backend/src/accounts/accounts.service.ts` and ~40 peers | Simple reads land on an arbitrary pooled connection carrying no tenant identity. To make RLS cover them, every query must run inside a transaction that sets the user's identity transaction-locally (`SET LOCAL`), so simple reads move into short tenant transactions. |
| An AsyncLocalStorage request context already exists (`{ userId, timezone }`), entered around `next.handle()` | `backend/src/common/request-context.ts`, `.../interceptors/request-context.interceptor.ts` | Already carries the effective user; the tenant-transaction helper reads it to set the DB variable at the start of each transaction. No new interceptor needed. |
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

1. **Two roles.** Keep `monize_user` (superuser/owner) for DDL, migrations, seed, and privileged work. Add `monize_app` (LOGIN, **not** superuser, **not** owner, **no** `BYPASSRLS`) as the runtime role. Privilege and row-visibility are orthogonal in Postgres -- `monize_app` gets table DML grants but RLS still filters its rows.
2. **One transaction-scoped variable, fail-closed.** A custom GUC `app.current_user_id` carries the effective user, set with `set_config(..., true)` (`SET LOCAL` semantics) so it exists only inside the transaction that set it and Postgres reverts it automatically at COMMIT/ROLLBACK. A helper `app_current_user_id()` returns `NULL` when it is unset/empty, so every policy predicate is false -> **zero rows** (deny), never allow.
3. **Per-operation tenant transaction (the robust mechanism).** Every database operation runs inside a transaction opened by one helper, `tenantTx()`, whose first statement sets the GUC transaction-locally from the identity in the existing ALS request context. Because the GUC dies with the transaction, no connection ever returns to the pool carrying an identity -- there is no pinning, no reset, and no release bookkeeping. And because the transaction is the unit a transaction-mode pooler (pgBouncer et al.) routes to a single server connection, the design is pooler-safe by construction.
4. **Privileged escape hatch via a second GUC.** `app.bypass_rls = 'on'`, set transaction-locally by `tenantTx()` only inside an explicit, greppable `withSystemContext()` scope, lets admin / auth-bootstrap / cross-user jobs / seeders see across users. Policies OR it in. (A stronger owner-DataSource alternative for admin is noted below.)
5. **Policies for every owned table**, direct (`user_id = app_current_user_id()`) and indirect (`EXISTS` against the parent), shipped as numbered migrations mirrored into `schema.sql`. Reference tables left RLS-disabled.
6. **Phased rollout with one mode flag and two independent flips.** A single `RLS_MODE=off|shadow|enforce` enum (no boolean pair, so no invalid combination is representable). Flip A switches the runtime role to `monize_app` while **no table has RLS enabled** -- only privilege bugs (`permission denied`, DDL) can surface, visibility unchanged. Flip B ships the enable migration -- only context bugs (zero rows) can surface. Each flip reverts instantly by setting `RLS_MODE=shadow` (the owner role bypasses RLS even on enabled tables).

---

## Implementation Phases

### Phase 1: DB roles, ownership, grants, env

Create the runtime role with its password from env (it cannot live in committed SQL) in `backend/src/db-init.ts`, which runs as owner at startup before the app connects. The password reaches SQL via a **parameterized** `set_config` -- never string interpolation -- and the role's password is re-applied on every startup so rotating `DATABASE_APP_PASSWORD` in env is sufficient (an `IF NOT EXISTS`-only create would silently ignore rotation forever):

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

If `DATABASE_APP_PASSWORD` is unset, `db-init` skips role creation with a logged warning -- existing deployments upgrade with zero new required env vars and zero behavior change; RLS simply cannot be enforced until the password is provided.

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
- New `DATABASE_APP_USER` / `DATABASE_APP_PASSWORD` in `.env.example` and all `docker-compose*.yml`, referenced with empty defaults (`${DATABASE_APP_PASSWORD:-}`) so existing `.env` files without the new keys neither warn nor break on upgrade.
- **One mode flag, not two booleans:** `RLS_MODE=off|shadow|enforce` (default `off`). `off` = no GUC emission, owner role -- identical to pre-RLS behavior. `shadow` = tenant transactions live and GUCs emitted per transaction, but runtime still the owner (policies bypassed) -- exercises the whole mechanism safely. `enforce` = GUCs emitted and runtime connects as `monize_app`. The dangerous state a two-boolean design allows (unprivileged role with no GUC emission -> zero rows everywhere) is **unrepresentable** by construction; startup validation reduces to one rule: `enforce` requires `DATABASE_APP_PASSWORD`.
- `backend/src/app.module.ts` TypeORM factory reads `DATABASE_APP_USER/PASSWORD` when `RLS_MODE=enforce`, else falls back to `DATABASE_USER` (image is safe to deploy before the role exists; revert is one flag). No pool-size change is needed: connections are held only for the duration of each transaction, so the pg default pool stays adequate -- streaming/SSE endpoints hold no connection between queries.
- `db-init.ts`, `db-migrate.ts`, and the seed entrypoint keep using `DATABASE_USER` (owner). The split is **by process**: startup scripts = owner; long-running API = `monize_app`.

`FORCE ROW LEVEL SECURITY` is intentionally **not** used: migrations and privileged jobs run as the owner and rely on the owner's natural RLS exemption. The net is enforced by the runtime role being a non-owner, which is sufficient.

### Phase 2: Per-operation tenant transactions (the robust mechanism)

This is the heart of the work and the larger refactor.

**a) Extend the ALS context** (`backend/src/common/request-context.ts`):
```ts
export interface RequestContext { userId?: string; timezone?: string; system?: boolean; preserveTimestamps?: boolean; }
```
The existing `RequestContextInterceptor` already seeds `{ userId, timezone }` around `next.handle()` for authenticated requests (delegation already resolved by `jwt.strategy`), so **no new interceptor is needed** and there is no connection lifecycle to manage: nothing is acquired per request, so nothing must be released. Streaming/SSE endpoints hold no connection between queries, and requests that never touch the DB never take one from the pool.

**b) Tenant transaction helper** (`backend/src/common/db/tenant-tx.ts`) -- the single sanctioned door to the database. It opens a transaction, sets the GUC **transaction-locally** (`set_config(..., true)`, i.e. `SET LOCAL` semantics), and **throws when no context exists**. A silent fallback to `dataSource.manager` would mean "query with no GUC" under enforcement: zero rows that look exactly like empty data. Refusing instead moves that whole failure class to dev time -- a context-less call path throws in unit tests and local dev at `RLS_MODE=off`, long before enforcement:
```ts
export async function tenantTx<T>(
  dataSource: DataSource,
  fn: (m: EntityManager) => Promise<T>,
): Promise<T> {
  const ctx = getRequestContext();
  if (!ctx || (!ctx.userId && !ctx.system)) {
    throw new Error(
      "DB access outside request/user/system context -- wrap the call path in withUserContext/withSystemContext",
    );
  }
  return dataSource.transaction(async (m) => {
    if (rlsMode !== 'off') {
      if (ctx.system) {
        await m.query("SELECT set_config('app.bypass_rls', 'on', true)"); // this transaction only
      } else {
        await m.query("SELECT set_config('app.current_user_id', $1, true)", [ctx.userId]); // this transaction only
      }
    }
    if (ctx.preserveTimestamps) {
      // NOT gated on rlsMode: this replaces the restore path's DISABLE TRIGGER DDL and must
      // work in every mode once the GUC-aware trigger migration has shipped.
      await m.query("SELECT set_config('app.preserve_timestamps', 'on', true)"); // backup restore only
    }
    return fn(m);
  });
}
```
Postgres reverts a transaction-local GUC at COMMIT/ROLLBACK unconditionally, so a pooled connection **cannot** carry a prior request's identity -- by construction, not by bookkeeping. There is no reset code, no release hook, and no "destroy on failed reset" path to get wrong. Fail-closed holds at every layer: a query outside `tenantTx` runs with no GUC (zero rows), and `SET LOCAL` outside a transaction is a no-op warning (still zero rows). Because the transaction is exactly the unit a transaction-mode pooler (pgBouncer) routes to one server connection, the mechanism is pooler-safe with no session state to break. At `RLS_MODE=off` the helper still validates context and wraps the transaction but skips the identity GUCs -- behavior identical to pre-RLS. The one mode-independent emission is `app.preserve_timestamps`: it is a functional replacement for the restore path's old `DISABLE TRIGGER` DDL, not an RLS feature, so it must fire in every mode (the GUC-aware trigger migration ships before the restore swap lands).

The unauthenticated health check keeps its direct DataSource ping (it reads no user data and must not depend on the context machinery); anything else touching the DB outside a request must be inside `withUserContext`/`withSystemContext` (Phase 4), which seed this same ALS scope.

**c) Refactor services to run data access through `tenantTx`** instead of injected repos and hand-rolled QueryRunners. The change in each of ~40 services is mechanical and **fail-loud** -- a call path with no ambient context throws immediately (see (b)), never a silent leak or a silent zero-row result:
- Reads: `this.accountsRepository.findOne(...)` -> `tenantTx(this.dataSource, (m) => m.getRepository(Account).findOne(...))`. A single-statement read-only transaction is semantically identical to today's autocommit read; the cost is one extra BEGIN/COMMIT round-trip pair on the app-DB link.
- Multi-table writes: replace the manual `createQueryRunner()`/`startTransaction()`/`release()` block with `tenantTx(this.dataSource, async (m) => { ... })` -- same transaction boundary, same atomicity, GUC set as its first statement. Helpers that today take a `QueryRunner` parameter take the `EntityManager` instead.
- Scope each `tenantTx` to the unit the code transacts today: one read, or one read-modify-write block. Do not wrap whole request handlers -- per-operation transactions preserve today's atomicity exactly (no request-wide transaction).
- Land the refactor **module-by-module behind `RLS_MODE=off`**, never as one long-lived branch. Add a CI ratchet on the counts of remaining `@InjectRepository` and `createQueryRunner` sites (the numbers may only decrease); when they hit zero, ban both outside `tenant-tx.ts` and test helpers via lint. A hand-rolled QueryRunner is the one way to run a query with no GUC under enforcement -- the lint ban makes "forgot the set_config" unrepresentable.

**d) Fire-and-forget writes** that intentionally outlive the request (`touchLastActivity`, timezone-cache persistence in `request-context.interceptor.ts`) are no longer a lifecycle hazard -- there is no pinned connection to outlive. They still need context: on the request's ALS scope they can call `tenantTx` directly; if a path detaches from it (timers, queues), wrap it in `withUserContext`/`withSystemContext` (Phase 4).

> Alternative considered and rejected for this codebase: the `typeorm-transactional` library would auto-bind injected repos to an ALS transaction with far less churn, but it monkey-patches TypeORM's Repository prototype globally -- too much hidden magic for a security-critical financial app whose conventions favor explicitness. The homegrown helper keeps every transaction's identity explicit.
>
> A previous draft of this plan pinned one connection per request and set **session**-scoped GUCs on it (`set_config(..., false)`). It was dropped: it needed reset-on-release / destroy-on-failed-reset bookkeeping to prevent cross-request GUC bleed, held a connection for the full duration of streaming responses (pool pressure), and silently broke under transaction-mode poolers. Per-operation `SET LOCAL` transactions delete all three problems structurally.

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

Same migration: make the shared `updated_at` trigger GUC-aware, so backup **restore** no longer needs DDL. Today restore runs `ALTER TABLE ... DISABLE TRIGGER "update_*_updated_at"` to preserve restored timestamps (`backup.service.ts` ~1317) -- `ALTER TABLE` requires table *ownership*, which `monize_app` must not have. Behaviorally inert while the GUC is unset:
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

Direct `user_id` tables (the bulk -- `accounts, transactions, categories, payees, tags, securities, budgets, budget_*, scheduled_transactions, investment_transactions, custom_reports, ai_*, personal_access_tokens, action_history, monthly_account_balances, monte_carlo_scenarios, user_preferences, user_currency_preferences, refresh_tokens, trusted_devices, account_delegates, emergency_access_*, import_column_mappings, auto_backup_settings, oauth_payloads`, ...):
```sql
-- Note: no ENABLE here. A policy on a table without ENABLE ROW LEVEL SECURITY is inert;
-- the ENABLE statements ship together in the final migration (flip B of the rollout).
DROP POLICY IF EXISTS accounts_isolation ON accounts;       -- idempotent
CREATE POLICY accounts_isolation ON accounts
  USING (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
  WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
```

The scalar-subquery form `(SELECT app_current_user_id())` is deliberate: the planner turns it into an InitPlan evaluated **once per statement** instead of per row. A bare function call relies on SQL-function inlining, which is fragile across minor planner changes; the initplan form is the standard RLS idiom and matters on sequential scans (backup export, bulk reports).

Indirect / join-scoped tables (resolve ownership through the parent; existing FK indexes make this an index probe):
```sql
CREATE POLICY holdings_isolation ON holdings
  USING ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = holdings.account_id AND a.user_id = (SELECT app_current_user_id())))
  WITH CHECK ((SELECT app_bypass_rls()) OR EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.id = holdings.account_id AND a.user_id = (SELECT app_current_user_id())));
```
Same shape for `transaction_splits`->transactions, `scheduled_transaction_splits`->scheduled_transactions, `security_prices`->securities, `monte_carlo_cash_flows`->scenarios, and the junction tables (check the owning entity side).

`users` table -- self-access only; cross-user reads (admin, login-by-email/oidc before a session exists) go through `app.bypass_rls`:
```sql
CREATE POLICY users_self ON users
  USING (id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
  WITH CHECK (id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
```

Global reference tables -- leave RLS **disabled** on `currencies` and `exchange_rates` (reference data; writes already go through controlled/owner paths). Document the deliberate choice.

Migration sequencing (continue from the current max prefix -- verify with `ls database/migrations`). `CREATE POLICY` on a table that has not run `ENABLE ROW LEVEL SECURITY` is inert, so all policies ship early and the enable ships **last, in its own release** -- it is the only behavior-changing migration and it is flip B of the rollout:
- `0NN_rls_role_grants_and_helpers.sql` -- grants, default privileges, helper functions, GUC-aware `update_updated_at_column()` replacement. Inert.
- `0NN+1_rls_policies_direct.sql` -- policies for all direct `user_id` tables (no enable). Inert.
- `0NN+2_rls_policies_indirect.sql` -- `EXISTS` policies for join-scoped + junction tables. Inert.
- `0NN+3_rls_policies_users.sql` -- `users` policy; document reference tables left disabled. Inert.
- `0NN+4_rls_enable.sql` -- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` for every policied table. Ships in the flip-B release only after flip A (privilege drop) has soaked in prod.

Each is idempotent (`DROP POLICY IF EXISTS` then `CREATE`; `ENABLE` is idempotent) and **mirrored into `database/schema.sql`** so a fresh `db-init` equals a migrated DB.

> Performance note: indirect policies run the `EXISTS` per candidate row. With existing FK indexes this is a cheap index probe, and because app-level filtering already narrows the result set, the predicate is almost always validating an already-correct, already-small set. Watch the heaviest bulk readers (investment reports, full backup export over `security_prices`/`transaction_splits`) during the monitoring phase; if any regress, run those specific export paths under `withSystemContext`.

### Phase 4: Privileged / out-of-request contexts

`withSystemContext(fn)` and `withUserContext(userId, fn)` (`backend/src/common/db/with-context.ts`) seed the same ALS scope the request interceptor does (`{ system: true }` or `{ userId }`); every `tenantTx()` inside `fn` then sets the matching GUC (`app.bypass_rls = 'on'` or `app.current_user_id`) transaction-locally. The helpers hold no connection and need no cleanup -- they only establish ambient identity for code with no HTTP request. Apply them:

- **Admin** (`backend/src/admin/`, RolesGuard + `@Roles('admin')`): wrap cross-user service calls in `withSystemContext`. *Hardening option:* if the maintainer wants the app role to have **no** self-bypass path at all, give the admin module a second TypeORM DataSource connecting as the owner instead of the `app.bypass_rls` GUC -- strictly more auditable, at the cost of a second connection identity. Default recommendation is the GUC for uniformity.
- **Auth bootstrap -- every pre-session path.** Anything that reads or writes a user-scoped table before `req.user` exists must be wrapped in `withSystemContext`:
  - `AuthService` login/register/refresh; `jwt.strategy` validate (user + delegation lookups).
  - **PAT validation**: the `personal_access_tokens` lookup by token hash scans across users. The MCP server authenticates with PAT bearer, so a miss here breaks every MCP request at the auth step.
  - **Password reset and email verification** token lookups.
  - **OIDC/OAuth callback** and the MCP-connector OAuth flow's `oauth_payloads` reads/writes, which happen during authorize before a session exists.
  - Do not trust this hand-enumerated list. As an implementation step, **audit every route reachable without `req.user`** (guard-less controllers, public decorators, every Passport strategy) and wrap each one -- the staging soak only catches paths the test suites actually exercise.
- **Emergency access:** the claim flow (`emergency-access-claim.controller.ts`) reads and writes the *grantor's* rows (`users`, `trusted_devices`, `refresh_tokens`, emergency-access tables) while the requester is the grantee or a bare claim token -- it runs with the *wrong* user context, which fails silently as zero-row no-ops. Wrap the claim flow (and the expiry monitor's cross-user sweep) in `withSystemContext`.
- **Cron jobs (~17 handlers):** cross-user fan-out queries (e.g. `getUsersByEffectiveTimezone`, `processAutoPostTransactions`'s `IN (...)`) run under `withSystemContext`; the per-user body (`this.post(scheduled.userId, ...)`) runs under `withUserContext(userId)` so it still gets the RLS net.
- **Seeders** (`database/seed.service.ts`, `demo-seed.service.ts`, daily demo reset): wrap the whole seed in `withSystemContext` (its raw `DELETE ... WHERE user_id = $1` / cross-user inserts keep working).
- **Backup restore:** replace the `ALTER TABLE ... DISABLE TRIGGER` / `ENABLE TRIGGER` pair in `backup.service.ts` with the `preserveTimestamps` context flag: the restore path runs under the requesting user's normal RLS context with `{ preserveTimestamps: true }`, and `tenantTx` adds `set_config('app.preserve_timestamps', 'on', true)` to each restore transaction -- the Phase 3 trigger function honors it, no DDL needed, and the flag dies with each COMMIT, so no reset code exists. (Alternative: an owner DataSource for the restore path, same shape as the admin hardening option.)
- **Unauthenticated health check:** keeps its direct DataSource ping -- it reads no user data and must not depend on the context machinery.
- **db-init / db-migrate:** unchanged -- already run as owner, inherently exempt.

Wire `withSystemContext`/`withUserContext` in during Phase 2 (while RLS is still latent), so they are no-ops until enforcement and there is no flag-day where jobs suddenly break.

**Fence the bypass so it cannot metastasize.** After launch, the path of least resistance for any "returns zero rows" bug is to wrap it in `withSystemContext` -- each such fix silently widens the bypass. Two guards, shipped with the helpers themselves:
- An ESLint `no-restricted-imports` rule allows importing `with-context.ts` only from an explicit module allowlist (admin, auth bootstrap, emergency access, cron/jobs, seeders, backup). Anywhere else, the lint fails -- widening the allowlist is a visible, reviewed decision, not a drive-by fix.
- `withSystemContext` logs each invocation with its call site (rate-limited), so bypass usage in prod is observable and auditable.

### Phase 5: Tests

- **Apply policies in the integration harness.** In `backend/test/helpers/integration-setup.ts`, after the `synchronize` schema is built, run a shared `applyRlsPolicies(dataSource)` that executes the **actual migration files** (`database/migrations/0NN_rls_*.sql`, read from disk -- not a duplicated copy of their SQL) and creates `monize_app` in the test DB. One source of truth; the harness cannot drift from prod.
- **New `backend/test/integration/rls-enforcement.integration.spec.ts` -- catalog-driven, not hand-listed.** The spec enumerates coverage from the DB itself: every table must fall into exactly one of three buckets -- (1) has a `user_id` column (direct policy expected), (2) appears in an explicit indirect-ownership map (child table -> owning-parent join path), or (3) appears in an explicit exemption list (`currencies`, `exchange_rates`, `schema_migrations`). A table in no bucket, or a bucketed table missing its policy in `pg_policies`, **fails the suite** -- a future table cannot be forgotten, because forgetting is a test failure, not a review miss. For each covered table, inside a transaction, `SET LOCAL ROLE monize_app` (drops the superuser test connection to the unprivileged role), then generically:
  - GUC = userA -> raw `SELECT * FROM accounts` (no app-level `WHERE`) returns **only** userA's rows; GUC = userB -> only userB's.
  - GUC unset/empty/bogus -> **zero rows** for a direct table (`accounts`) and an indirect table (`transaction_splits` / `holdings`). The fail-closed assertion.
  - `WITH CHECK`: `INSERT INTO accounts(user_id, ...)` with another user's id while GUC = userA -> fails.
  - `app.bypass_rls = 'on'` -> cross-user `SELECT` returns both users (proves jobs/admin work).
  - `app.preserve_timestamps = 'on'` -> an `UPDATE` keeps the supplied `updated_at` (proves the restore path's trigger bypass); unset -> the trigger stamps `CURRENT_TIMESTAMP` as today.
- **GUC scope test:** run a `tenantTx`, let it COMMIT, then assert on the same physical connection that `current_setting('app.current_user_id', true)` is empty and a follow-up raw `SELECT` returns zero rows -- proves the transaction-local revert that replaces all reset/release bookkeeping.
- **Keep the existing isolation suite green:** `security-cross-user-isolation.integration.spec.ts` must still pass after data access is routed through `tenantTx` in the test DataSource.
- **Unit tests** for `tenantTx`, `withUserContext`, `withSystemContext` (assert the exact `set_config(..., true)` SQL, the throw on missing context, no identity-GUC emission at `RLS_MODE=off`, and `preserveTimestamps` emission in **every** mode including `off`), to protect the 95%/85% coverage thresholds.

### Phase 6: Rollout, flags, docs

Phased and independently revertible. The key structural choice: **privileges drop before RLS turns on**, so the two failure classes -- `permission denied` (grants, DDL, ownership) and zero rows (missing context) -- can never surface in the same step:

1. **Plumbing as no-op** (`RLS_MODE=off`): ship the Phase 2 `tenantTx` refactor + the `withSystemContext`/`withUserContext` call sites, module-by-module. Because `tenantTx()` throws on context-less DB access, most context gaps surface right here, in dev and CI -- not under enforcement. No DB change.
2. **Shadow soak** (`RLS_MODE=shadow`, prod): GUCs emitted per transaction, runtime still the owner. Land the helper/grant + policy migrations (inert without enable). Soak for **weeks, not days** -- the transaction wrapping proves itself (endpoint latency, error rates) while RLS itself is still off.
3. **Staging/demo, fully enforced:** `docker-compose.demo.yml` runs `RLS_MODE=enforce` *with* the enable migration deployed. Postgres statement/policy logging on; full e2e + integration; explicitly exercise backup restore, emergency-access claim, and MCP-via-PAT. Hunt zero-row surprises and bulk-endpoint latency.
4. **Prod flip A -- privilege drop** (`RLS_MODE=enforce`; enable migration *not* yet deployed to prod): runtime becomes `monize_app`, but no table has RLS enabled, so row visibility is unchanged. The only bugs that can surface are privilege-class (`permission denied`, DDL) -- loud, greppable, and low-stakes. Revert: `RLS_MODE=shadow`.
5. **Prod flip B -- enable RLS:** deploy the release containing `0NN+4_rls_enable.sql`. The only bugs that can surface now are context-class (zero rows). Emergency revert is unchanged and instant: `RLS_MODE=shadow` -- the owner role bypasses RLS even on enabled tables. Full policy removal remains available via the runbook's down-SQL.

Flags: `RLS_MODE=off|shadow|enforce` selects GUC emission + runtime role in one enum; `DATABASE_APP_USER/PASSWORD` supply the unprivileged role (required for `enforce`, validated at startup). Document in root `CLAUDE.md`, `database/CLAUDE.md`, `.env.example`, and the runbook `docs/future-plans/row-level-security-runbook.md` (move it to `docs/rls.md` when the feature ships; it includes the manual down-SQL, since the migration runner is forward-only).

i18n: RLS is backend/DB only. A `WITH CHECK` violation surfaces as a Postgres error; ensure `GlobalExceptionFilter` maps "new row violates row-level security policy" to a generic 403/404 (these should never reach users, because app-level filtering prevents hitting them) -- any new user-facing string there must be internationalized per project rules.

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
| GUC leaks across pooled requests | Yes (by construction) | The GUC is transaction-local (`SET LOCAL`): Postgres reverts it at COMMIT/ROLLBACK before the connection can serve anything else. No reset code exists to get wrong. |
| Compromised app process sets `app.bypass_rls` | Partial | The GUC is only set by greppable helpers whose import is lint-allowlisted per module, never from user input (all queries parameterized). Invocations are logged with call site. The owner-DataSource hardening removes even this path for admin. |
| DB superuser / owner access (DBA, migrations) | By design exempt | Owner bypass is what lets migrations/seed/jobs operate; not a tenant-isolation threat. |
| Stolen DB backup at rest | No | RLS is access-time, not at-rest. (Encryption-at-rest / the user-encryption plan addresses this.) |

---

## Risks and Complexities

1. **Out-of-request and pre-session paths breaking (highest likelihood).** ~17 crons + seeders run context-less; PAT validation (all MCP traffic), password-reset / OIDC / OAuth bootstrap, the emergency-access claim, and backup restore touch user-scoped tables without (or with the *wrong*) user context -> zero rows, silent no-ops, or permission errors under enforcement. Mitigation: `tenantTx()` **throws** on context-less access, so missed paths fail in dev/CI at `RLS_MODE=off` rather than as silent zero rows in prod; wire `withSystemContext`/`withUserContext` in during Phase 2; audit every route reachable without `req.user` (Phase 4); the two-flip rollout isolates the remaining privilege-class bugs (flip A) from context-class bugs (flip B); the staging soak (Phase 6.3) surfaces any missed path before prod.
2. **A query path that never enters `tenantTx`.** A hand-rolled QueryRunner or a leftover injected repo runs with no GUC -- fail-closed zero rows under enforcement, invisible before it. Mitigation: the CI ratchet, then lint ban, on `@InjectRepository`/`createQueryRunner` outside `tenant-tx.ts` and test helpers; the throwing helper is the only sanctioned door to the DB.
3. **The ~40-service refactor.** Mechanical but broad. Mitigation: it is fail-loud (a missed site throws at call time), it lands module-by-module behind `RLS_MODE=off` -- never one long-lived branch -- and the CI ratchet on remaining `@InjectRepository`/`createQueryRunner` sites makes regression impossible and progress visible.
4. **Per-operation transaction overhead.** Every simple read gains a BEGIN + `set_config` + COMMIT (~2 extra round-trips) on the app-DB link. Negligible on the Docker-local network; watch endpoint p95 during the shadow soak, and batch any read path that proves hot into one `tenantTx`.
5. **Performance on indirect/junction policies for bulk reads.** Mitigation: existing FK indexes; the predicate is redundant over an already-narrow set; run specific heavy exports under system context.
6. **App-role self-bypass via `app.bypass_rls`, and bypass creep over time.** The launch-day surface is controlled (helper-only, never user-controlled), but the long-term risk is developers wrapping future "zero rows" bugs in `withSystemContext` instead of fixing context -- each one widens the bypass. Mitigation: ESLint import allowlist makes widening a reviewed decision; call-site logging keeps prod usage auditable; optional owner-DataSource for admin removes the GUC path entirely.
7. **Schema drift** between `schema.sql` and migrations. Mitigation: mirror every policy into `schema.sql` in the same PR; add a CI assertion that a fresh-init DB and a migrated DB have identical `pg_policies`.
8. **Session-state features are off the table.** The transaction-as-unit design -- and any future transaction-mode pooler -- assumes no cross-transaction session state: session-scoped advisory locks (`pg_advisory_lock`), LISTEN/NOTIFY, temp tables, named prepared statements. The codebase uses none today (verified by grep). If one is ever needed, use the transaction-scoped variant (`pg_advisory_xact_lock`) or revisit this constraint deliberately. Recorded in the runbook. In exchange, the design is fully compatible with transaction-mode poolers (pgBouncer) -- the former hard constraint "session-mode pooling only" is gone.

---

## Verification (end to end)

1. `cd backend && npm run build && npm run lint` -- clean.
2. `npm run test:unit`, then the integration suites incl. the new `rls-enforcement` spec and the existing `security-cross-user-isolation` spec -- all green.
3. `docker compose -f docker-compose.dev.yml up`: register two users; confirm normal app behavior (accounts, transactions, reports, budgets) with the runtime on `monize_app`.
4. Manual DB proof: `psql` as `monize_app`, `SET app.current_user_id = '<userA>'; SELECT count(*) FROM transactions;` -> only userA's count; set to userB -> userB's; `RESET app.current_user_id; SELECT count(*) FROM transactions;` -> `0`.
5. Trigger a cron path (scheduled-transaction auto-post) and the demo reset under enforcement -> confirm they still process across users (system context working).
6. Under enforcement, exercise the three paths most likely to break: run a backup **restore** (timestamps preserved, no `must be owner of table` error), complete an emergency-access **claim**, and make an MCP request authenticated by PAT.
7. `npm run i18n:check` -- pseudo-locale fresh (only relevant if any exception copy was added).

---

## Estimated Scope

- **New files (~7):** `tenant-tx.ts`, `with-context.ts`, 5 RLS migrations (policies split from the enable), the catalog-driven `rls-enforcement.integration.spec.ts`, ESLint restrictions (`with-context.ts` import allowlist; `@InjectRepository`/`createQueryRunner` ban), `docs/rls.md` runbook. No new interceptor -- the existing `RequestContextInterceptor` ALS scope is reused.
- **Modified files (~55+):** ~40 domain services (data access through `tenantTx`), `app.module.ts` (role selection, flag validation), `db-init.ts`, `request-context.ts` (context interface extension), admin/auth/cron/seeder paths, PAT + password-reset + OAuth bootstrap paths, `emergency-access-claim.controller.ts`, `backup.service.ts` (trigger-GUC swap replacing the `DISABLE TRIGGER` DDL), `database/schema.sql`, `integration-setup.ts`, `.env.example`, all `docker-compose*.yml`, root + `database` CLAUDE.md.
- **No new npm dependency** (homegrown transaction helper; `typeorm-transactional` deliberately avoided).
- **DB objects:** 1 new role, ~45 tables x (enable + policy), 2 helper functions + a GUC-aware replacement of `update_updated_at_column()`, grants + default privileges.
- **Rollout:** behavior-neutral until flip A; two independent flips (privilege drop, then RLS enable), each with an instant `RLS_MODE=shadow` revert.

**Net assessment:** the defense-in-depth framing is what makes this tractable -- because app-level filtering stays, RLS almost always validates an already-correct query, so the failure modes that matter are *operational* (crons, auth bootstrap, restore) rather than *functional*, and every one of those fails loudly (thrown context errors in dev, `permission denied` at flip A, login failure) rather than silently leaking or silently returning empty. The transaction-local GUC removes the two riskiest moving parts of the earlier draft -- cross-request GUC bleed and pinned-connection pool pressure -- by construction, and makes the design pooler-proof. The dominant cost is the ~40-service refactor; the dominant risk is missed out-of-request paths, which the throwing helper catches at dev time and the two-flip rollout isolates by failure class.
