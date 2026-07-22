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
| The runtime connects as `${POSTGRES_USER}`, which the official `postgres` image creates as a **cluster superuser**; on the Kubernetes/CNPG deployment the runtime user is the database **owner** (not a superuser, no `CREATEROLE`) | `docker-compose.prod.yml`, `docker-compose.dev.yml`, `k8s` overlay (`DATABASE_HOST: home-rw.cnpg.svc.cluster.local`) | Superusers and table owners both bypass RLS (owners unless `FORCE` is used). RLS is inert today in **both** environments. A separate non-privileged runtime role is **mandatory**, not optional — and role provisioning must work without `CREATEROLE` (CNPG `managed.roles`). |
| Services inject `@InjectRepository(X)` repositories bound to the default pool **and** create ad-hoc `dataSource.createQueryRunner()` transactions | `backend/src/accounts/accounts.service.ts` and ~40 peers | Simple reads land on an arbitrary pooled connection carrying no tenant identity. To make RLS cover them, every query must run inside a transaction that sets the user's identity transaction-locally (`SET LOCAL`), so simple reads move into short tenant transactions. |
| An AsyncLocalStorage request context already exists (`{ userId, timezone }`), entered around `next.handle()` | `backend/src/common/request-context.ts`, `.../interceptors/request-context.interceptor.ts` | Already carries the effective user; the tenant-transaction helper reads it to set the DB variable at the start of each transaction. No new interceptor needed. |
| Delegation rewrites `req.user.id` to the **owner's** id when a delegate acts, but keeps the delegate's own id in `req.user.realUserId` -- and some authenticated paths deliberately operate on the **delegate's** rows: `changePassword` targets `realUserId` (`users.controller.ts:86-90`), and `delegate_account_favourites` is keyed by `delegate_user_id` (`delegation.service.ts:295-335`) | `backend/src/auth/strategies/jwt.strategy.ts:95-97` | Delegation does **not** map to a single variable. The context must carry both ids and policies need a second GUC (`app.real_user_id`) for delegate-keyed tables (`users` self-row, `account_delegates` delegate side, `delegate_account_favourites`). These failures would be silent zero-rows inside normal request scope -- invisible to the fail-loud helper and to flip-A soak -- so they must be designed for, not discovered. |
| ~50 tables; most carry `user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE` + `idx_*_user`; UUID PKs | `database/schema.sql` | Direct tables get a trivial policy. |
| Several tables are scoped **indirectly** (no `user_id`): `holdings`->accounts, `transaction_splits`->transactions, `scheduled_transaction_splits` + `scheduled_transaction_overrides`->scheduled_transactions, `security_prices`->securities, `monte_carlo_cash_flows`->scenarios, `budget_categories`/`budget_periods`/`budget_period_categories`->budgets, `account_delegate_grants`->account_delegates, and junctions (`transaction_tags`, `transaction_split_tags`, `security_tags`, `scheduled_transaction_split_tags`) | `database/schema.sql` | These need join-based (`EXISTS`) policies. |
| Four tables use **owner columns other than `user_id`**: `account_delegates` (`owner_user_id`/`delegate_user_id`), `delegate_account_favourites` (`delegate_user_id`), `emergency_access_settings`/`emergency_access_contacts` (`owner_user_id`) | `database/schema.sql:705-795` | A templated `user_id = ...` policy fails with `column "user_id" does not exist` at migration time -- these need bespoke policies (and the delegate-side ones need `app.real_user_id`). |
| Global reference tables have no owner: `currencies`, `exchange_rates`. `oauth_payloads` has **no owner column at all** (keyed by opaque `id`/`model`/`grant_id`/`uid`; `database/schema.sql:1174`) | schema | Reference tables stay world-readable -- RLS left disabled. `oauth_payloads` is exempted with rationale (access is confined to the pre-session OAuth flow under system context); optional hardening in Phase 4. |
| Migrations are raw numbered SQL (`NNN_*.sql`), run on startup by `db-migrate.ts` as the owner, tracked in `schema_migrations`; every migration must also update `database/schema.sql` | `database/CLAUDE.md` | RLS ships as ordinary migrations + parallel `schema.sql` edits. db-init/db-migrate run as owner -> inherently exempt. |
| ~17 `@Cron` jobs (e.g. `processAutoPostTransactions` does a cross-user `IN (...)` then loops per user) run with **no** request context. Verified: they run **in the API process** -- `ScheduleModule.forRoot()` is in `app.module.ts`, no scheduler entrypoint exists anywhere under `backend/src` (`package.json`'s `start:scheduler` is dead), and no compose file or helm template starts one. `backend/CLAUDE.md`'s separate-process claim is stale (fix in D1). On k8s with >1 backend replica, **every replica runs every cron** (pre-existing) | `app.module.ts:103`, `scheduled-transactions.service.ts` | Under enforcement these would inherit the app role and see **zero rows** unless given explicit context. Biggest operational risk. |
| Integration tests build schema via TypeORM `synchronize` and connect as the superuser | `backend/test/helpers/integration-setup.ts` | `synchronize` cannot create policies and the superuser bypasses them -- tests must explicitly apply policies and drop to the app role. |
| Backup **restore** runs DDL -- `ALTER TABLE ... DISABLE TRIGGER "update_*_updated_at"` -- to preserve restored `updated_at` values | `backend/src/backup/backup.service.ts` (~line 1317) | `ALTER TABLE` requires table **ownership**; neither `app.bypass_rls` nor DML grants help. Restore breaks under `monize_app` unless the trigger function is made GUC-aware (Phase 3) or restore gets an owner DataSource (Phase 4). |
| The emergency-access **claim** flow operates on the grantor's rows while the requester is the grantee (or a bare claim token): reads `users`, deletes trusted devices, revokes refresh tokens | `backend/src/emergency-access/emergency-access-claim.controller.ts` | A cross-user HTTP path running with the *wrong* user context -- worse than none: silent zero-row no-ops under RLS. Must run under `withSystemContext` (Phase 4). |

---

## Design: six pillars

1. **Two roles.** Keep `monize_user` (superuser/owner) for DDL, migrations, seed, and privileged work. Add `monize_app` (LOGIN, **not** superuser, **not** owner, **no** `BYPASSRLS`) as the runtime role. Privilege and row-visibility are orthogonal in Postgres -- `monize_app` gets table DML grants but RLS still filters its rows.
2. **Transaction-scoped identity variables, fail-closed.** Two custom GUCs carry identity: `app.current_user_id` (the effective user -- the owner when a delegate acts) and `app.real_user_id` (the authenticated identity; equal to `current_user_id` outside delegation). Both set with `set_config(..., true)` (`SET LOCAL` semantics) so they exist only inside the transaction that set them and Postgres reverts them automatically at COMMIT/ROLLBACK. Helpers `app_current_user_id()` / `app_real_user_id()` return `NULL` when unset/empty, so every policy predicate is false -> **zero rows** (deny), never allow.
3. **Per-operation tenant transaction (the robust mechanism).** Every database operation runs inside a transaction opened by one helper, `tenantTx()`, whose first statement sets the GUC transaction-locally from the identity in the existing ALS request context. Because the GUC dies with the transaction, no connection ever returns to the pool carrying an identity -- there is no pinning, no reset, and no release bookkeeping. And because the transaction is the unit a transaction-mode pooler (pgBouncer et al.) routes to a single server connection, the design is pooler-safe by construction.
4. **Privileged escape hatch via a second GUC.** `app.bypass_rls = 'on'`, set transaction-locally by `tenantTx()` only inside an explicit, greppable `withSystemContext()` scope, lets admin / auth-bootstrap / cross-user jobs / seeders see across users. Policies OR it in. (A stronger owner-DataSource alternative for admin is noted below.)
5. **Policies for every owned table**: direct (`user_id = app_current_user_id()`), owner-column (`owner_user_id` / `delegate_user_id` on the delegation and emergency-access tables, using both GUCs), and indirect (`EXISTS` against the parent), shipped as numbered migrations mirrored into `schema.sql`. Reference tables and `oauth_payloads` left RLS-disabled with documented rationale.
6. **Phased rollout with one mode flag and two independent flips.** A single `RLS_MODE=off|shadow|enforce` enum (no boolean pair, so no invalid combination is representable). Flip A switches the runtime role to `monize_app` while **no table has RLS enabled** -- only privilege bugs (`permission denied`, DDL) can surface, visibility unchanged. Flip B ships the enable migration -- only context bugs (zero rows) can surface. Each flip reverts instantly by setting `RLS_MODE=shadow` (the owner role bypasses RLS even on enabled tables).

---

## Implementation Phases

### Phase 1: DB roles, ownership, grants, env

**All role and grant management lives in `backend/src/db-init.ts` -- migrations contain no role or grant statements.** This is load-bearing: a migration that mentions `monize_app` (a `GRANT`, an `ALTER DEFAULT PRIVILEGES FOR ROLE ...`) runs unconditionally at startup on every deployment; on any deployment where the role does not exist it errors, `db-migrate` exits 1, and the entrypoint (`set -e`) never starts the app -- a crash-loop on upgrade. Keeping migrations role-free is what makes "existing deployments upgrade with zero new required env vars and zero behavior change" actually true.

db-init runs the role block on **every** startup, **before** its existing "tables already exist" early return (`db-init.ts:44-56` -- role logic placed after that return would never run on an initialized DB, silently breaking both initial role creation and password rotation). Two steps, both idempotent:

1. **Create/rotate the role -- only when `DATABASE_APP_PASSWORD` is set.** The password reaches SQL via a **parameterized** `set_config` -- never string interpolation -- and is re-applied on every startup so rotating the env var is sufficient (an `IF NOT EXISTS`-only create would silently ignore rotation forever):

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

   Catch `insufficient_privilege` (SQLSTATE 42501) and continue with a logged warning: on managed Postgres -- the Kubernetes deployment uses CNPG (`DATABASE_HOST: home-rw.cnpg.svc.cluster.local`), where `DATABASE_USER` is the database owner but has **no `CREATEROLE`** -- the role cannot be created by db-init at all. There it is provisioned declaratively in the CNPG `Cluster` spec (`spec.managed.roles` with `login: true` and `passwordSecret`), and db-init's step degrades to an existence check. If `DATABASE_APP_PASSWORD` is unset, skip with a logged warning; nothing else references the role, so nothing breaks.

   *Password-in-logs caveat:* the DO-block indirection keeps the password out of top-level SQL text, but node-postgres uses the extended protocol, and `log_statement = 'all'` logs bind parameters (`parameters: $1 = ...`). Since the rollout deliberately enables statement logging in staging, either rotate the password after that phase or scrub the logs -- documented in the runbook.

2. **Apply grants -- whenever the role exists, however it was provisioned** (db-init, CNPG, or a manual DBA step). Idempotent, run as the connected owner on every startup:

```sql
GRANT USAGE ON SCHEMA public TO monize_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO monize_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO monize_app;
-- future tables created by the owner (migrations) are auto-granted:
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO monize_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO monize_app;
```

   **No `FOR ROLE` clause.** Without it, `ALTER DEFAULT PRIVILEGES` applies to the *current* role -- the actual owner, whatever its name. The owner role name is operator-chosen (`docker-compose.prod.yml` passes `${POSTGRES_USER}` with no default; CI uses `monize_test`; `monize_user` is only the `.env.example` sample), so a hardcoded `FOR ROLE monize_user` would either fail outright or -- worse -- silently register default privileges for a role that never creates tables. Re-applying grants at every startup also closes the late-provisioning gap: an operator who sets the password (or adds the CNPG role) *after* upgrading converges on the next restart; there is no "the grants migration already ran" trap.

Env / compose / k8s:
- New `DATABASE_APP_USER` / `DATABASE_APP_PASSWORD` in `.env.example` and all `docker-compose*.yml`, referenced with empty defaults (`${DATABASE_APP_PASSWORD:-}`) so existing `.env` files without the new keys neither warn nor break on upgrade.
- Kubernetes: `RLS_MODE` and `DATABASE_APP_USER` go in the backend ConfigMap (`helm/values.yaml` + `helm/templates/configmap-backend.yaml`, and the kustomize overlay's `env-vars-backend` ConfigMap); `DATABASE_APP_PASSWORD` goes in the existing DB Secret. The `monize_app` role itself is declared in the CNPG `Cluster` manifest (`managed.roles`) since db-init cannot create it there.
- **One mode flag, not two booleans:** `RLS_MODE=off|shadow|enforce` (default `off`). `off` = no GUC emission, owner role -- identical to pre-RLS behavior. `shadow` = tenant transactions live and GUCs emitted per transaction, but runtime still the owner (policies bypassed) -- exercises the whole mechanism safely. `enforce` = GUCs emitted and runtime connects as `monize_app`. The dangerous state a two-boolean design allows (unprivileged role with no GUC emission -> zero rows everywhere) is **unrepresentable** by construction; startup validation reduces to one rule: `enforce` requires `DATABASE_APP_PASSWORD`.
- `backend/src/app.module.ts` TypeORM factory reads `DATABASE_APP_USER/PASSWORD` when `RLS_MODE=enforce`, else falls back to `DATABASE_USER` (image is safe to deploy before the role exists; revert is one flag). No pool-size change is needed: connections are held only for the duration of each transaction, so the pg default pool stays adequate -- streaming/SSE endpoints hold no connection between queries.
- `db-init.ts`, `db-migrate.ts`, and the seed entrypoint keep using `DATABASE_USER` (owner). The split is **by process**: startup scripts = owner; long-running API = `monize_app`.

`FORCE ROW LEVEL SECURITY` is intentionally **not** used: migrations and privileged jobs run as the owner and rely on the owner's natural RLS exemption. This exemption comes from table *ownership*, not superuser-ness -- so it holds identically on CNPG, where the owner is not a superuser but did create every table via db-init/db-migrate. The net is enforced by the runtime role being a non-owner, which is sufficient.

### Phase 2: Per-operation tenant transactions (the robust mechanism)

This is the heart of the work and the larger refactor.

**a) Extend the ALS context** (`backend/src/common/request-context.ts`):
```ts
export interface RequestContext {
  userId?: string;         // effective user (the owner when a delegate acts)
  realUserId?: string;     // authenticated identity; equals userId outside delegation
  timezone?: string;
  system?: boolean;
  preserveTimestamps?: boolean;
}
```
The existing `RequestContextInterceptor` already seeds `{ userId, timezone }` around `next.handle()` for authenticated requests (delegation already resolved by `jwt.strategy`); it additionally seeds `realUserId` from `req.user.realUserId`. No new interceptor is needed and there is no connection lifecycle to manage: nothing is acquired per request, so nothing must be released. Streaming/SSE endpoints hold no connection between queries, and requests that never touch the DB never take one from the pool.

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
  const active = getActiveTenantManager(); // stored in the same ALS scope
  if (active) {
    return fn(active); // re-entrant call: join the ambient transaction, no new connection
  }
  return dataSource.transaction(async (m) => {
    if (rlsMode !== 'off') {
      if (ctx.system) {
        await m.query("SELECT set_config('app.bypass_rls', 'on', true)"); // this transaction only
      } else {
        await m.query("SELECT set_config('app.current_user_id', $1, true)", [ctx.userId]); // this transaction only
        await m.query("SELECT set_config('app.real_user_id', $1, true)", [ctx.realUserId ?? ctx.userId]);
      }
    }
    if (ctx.preserveTimestamps) {
      // NOT gated on rlsMode: this replaces the restore path's DISABLE TRIGGER DDL and must
      // work in every mode once the GUC-aware trigger migration has shipped.
      await m.query("SELECT set_config('app.preserve_timestamps', 'on', true)"); // backup restore only
    }
    return runWithActiveTenantManager(m, () => fn(m));
  });
}
```

**Re-entrancy is part of the contract, not an afterthought.** Service methods call other service methods; after the refactor both sides are `tenantTx` calls. A naive nested `dataSource.transaction` opens a **second pooled connection** inside the first -- and under load that deadlocks structurally: with a pool of N, N concurrent requests each holding one connection while waiting for a second means nobody progresses (pool-exhaustion deadlock), independent of any row locks. The helper therefore records the active `EntityManager` in the same ALS scope; a nested `tenantTx` joins the ambient transaction (same connection, same GUCs, same atomicity -- equivalent to today's "pass the QueryRunner down" convention, but automatic). Only with this rule is the "no pool-size change is needed" claim actually sound. Unit tests must cover the nested case explicitly.
Postgres reverts a transaction-local GUC at COMMIT/ROLLBACK unconditionally, so a pooled connection **cannot** carry a prior request's identity -- by construction, not by bookkeeping. There is no reset code, no release hook, and no "destroy on failed reset" path to get wrong. Fail-closed holds at every layer: a query outside `tenantTx` runs with no GUC (zero rows), and `SET LOCAL` outside a transaction is a no-op warning (still zero rows). Because the transaction is exactly the unit a transaction-mode pooler (pgBouncer) routes to one server connection, the mechanism is pooler-safe with no session state to break. At `RLS_MODE=off` the helper still validates context and wraps the transaction but skips the identity GUCs -- behavior identical to pre-RLS. The one mode-independent emission is `app.preserve_timestamps`: it is a functional replacement for the restore path's old `DISABLE TRIGGER` DDL, not an RLS feature, so it must fire in every mode (the GUC-aware trigger migration ships before the restore swap lands).

The unauthenticated health check keeps its direct DataSource ping (it reads no user data and must not depend on the context machinery); anything else touching the DB outside a request must be inside `withUserContext`/`withSystemContext` (Phase 4), which seed this same ALS scope.

**c) Refactor services to run data access through `tenantTx`** instead of injected repos and hand-rolled QueryRunners. The change in each of ~80 service files (86 use `@InjectRepository` today) is mechanical and **fail-loud** -- a call path with no ambient context throws immediately (see (b)), never a silent leak or a silent zero-row result:
- Reads: `this.accountsRepository.findOne(...)` -> `tenantTx(this.dataSource, (m) => m.getRepository(Account).findOne(...))`. A single-statement read-only transaction is semantically identical to today's autocommit read; the cost is one extra BEGIN/COMMIT round-trip pair on the app-DB link.
- Multi-table writes: replace the manual `createQueryRunner()`/`startTransaction()`/`release()` block with `tenantTx(this.dataSource, async (m) => { ... })` -- same transaction boundary, same atomicity, GUC set as its first statement. Helpers that today take a `QueryRunner` parameter take the `EntityManager` instead.
- Scope each `tenantTx` to the unit the code transacts today: one read, or one read-modify-write block. Do not wrap whole request handlers -- per-operation transactions preserve today's atomicity exactly (no request-wide transaction).
- Land the refactor **module-by-module behind `RLS_MODE=off`**, never as one long-lived branch. Add a CI ratchet on the counts of remaining `@InjectRepository` and `createQueryRunner` sites (the numbers may only decrease); when they hit zero, ban both outside `tenant-tx.ts` and test helpers via lint. A hand-rolled QueryRunner is the one way to run a query with no GUC under enforcement -- the lint ban makes "forgot the set_config" unrepresentable.

**d) Fire-and-forget writes** that intentionally outlive the request (`touchLastActivity`, timezone-cache persistence in `request-context.interceptor.ts`) are no longer a lifecycle hazard -- there is no pinned connection to outlive. But they are **not** currently on the request's ALS scope, contrary to what one might assume: in the real interceptor, `touchLastActivity` fires and `resolveTimezone` performs its `user_preferences` read/write **before** `requestContextStorage.run()` is entered (`request-context.interceptor.ts:78-99` -- the scope wraps only `next.handle()`). Converted mechanically to `tenantTx`, all three sites would throw on every authenticated request. The interceptor must be restructured (task C6): either move these calls inside the scope it establishes, or wrap each in `withUserContext(userId)`. Any other path that detaches from the request scope (timers, queues) likewise gets `withUserContext`/`withSystemContext` (Phase 4).

> Alternative considered and rejected for this codebase: the `typeorm-transactional` library would auto-bind injected repos to an ALS transaction with far less churn, but it monkey-patches TypeORM's Repository prototype globally -- too much hidden magic for a security-critical financial app whose conventions favor explicitness. The homegrown helper keeps every transaction's identity explicit.
>
> A previous draft of this plan pinned one connection per request and set **session**-scoped GUCs on it (`set_config(..., false)`). It was dropped: it needed reset-on-release / destroy-on-failed-reset bookkeeping to prevent cross-request GUC bleed, held a connection for the full duration of streaming responses (pool pressure), and silently broke under transaction-mode poolers. Per-operation `SET LOCAL` transactions delete all three problems structurally.

### Phase 3: RLS helper functions and policies

Helpers (migration + `schema.sql`):
```sql
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION app_real_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.real_user_id', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION app_bypass_rls() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.bypass_rls', true) = 'on'
$$;
```

Fail-closed semantics, precisely: an **unset or empty** GUC yields `NULL`, every predicate is false, zero rows -- silent deny. A GUC holding a **non-UUID garbage string** does not yield zero rows: the `::uuid` cast raises `invalid input syntax for type uuid` (SQLSTATE 22P02) and the statement errors. Both are fail-closed (never a leak), but they are different failure classes -- tests must assert the *error* for the garbage case, not an empty result.

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

Direct `user_id` tables (29, verified against `schema.sql` -- `accounts, transactions, categories, payees, payee_aliases, institutions, tags, securities, scheduled_transactions, investment_transactions, budgets, budget_alerts, custom_reports, investment_reports, ai_provider_configs, ai_usage_logs, ai_insights, personal_access_tokens, action_history, monthly_account_balances, monte_carlo_scenarios, loan_scenarios, loan_rate_changes, user_preferences, user_currency_preferences, refresh_tokens, trusted_devices, import_column_mappings, auto_backup_settings`).

> Enumeration corrected from an earlier draft, which wrongly listed `account_delegates`, `emergency_access_*`, and `oauth_payloads` here (none has a `user_id` column -- the templated policy would fail at migration time with `column "user_id" does not exist` and crash-loop startup) and listed `budget_*` as a family (only `budgets` and `budget_alerts` are direct; `budget_categories`, `budget_periods`, `budget_period_categories` are indirect). **M2's authoring step must re-verify every table against `schema.sql`, not this list.**
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
Same shape for `transaction_splits`->transactions, `scheduled_transaction_splits`->scheduled_transactions, `scheduled_transaction_overrides`->scheduled_transactions, `security_prices`->securities, `monte_carlo_cash_flows`->scenarios, `budget_categories`->budgets, `budget_periods`->budgets, `budget_period_categories`->budget_periods (two-hop), `account_delegate_grants`->account_delegates, and the junction tables `transaction_tags`, `transaction_split_tags` (two-hop via transaction_splits), `security_tags`, `scheduled_transaction_split_tags` (two-hop) -- resolve the owning side from `schema.sql`, enumerate, do not guess.

Owner-column tables (bespoke policies -- these have no `user_id`; both GUCs in play):
```sql
-- Both parties see the delegation row: the owner from either side of their own data,
-- the delegate via their authenticated identity (works while acting, when
-- current = owner and real = delegate, and in their own session, when current = real).
CREATE POLICY account_delegates_isolation ON account_delegates
  USING (owner_user_id = (SELECT app_current_user_id())
      OR delegate_user_id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()))
  WITH CHECK (owner_user_id = (SELECT app_current_user_id())
      OR delegate_user_id = (SELECT app_real_user_id())
      OR (SELECT app_bypass_rls()));

-- Favourites belong to the delegate personally, keyed by their real identity even
-- while acting as the owner (current = owner, real = delegate).
CREATE POLICY delegate_account_favourites_isolation ON delegate_account_favourites
  USING (delegate_user_id = (SELECT app_real_user_id()) OR (SELECT app_bypass_rls()))
  WITH CHECK (delegate_user_id = (SELECT app_real_user_id()) OR (SELECT app_bypass_rls()));

-- Emergency access is owner-keyed; the grantee side is email/claim-token based
-- (no grantee user column exists) and runs under withSystemContext (claim flow).
CREATE POLICY emergency_access_settings_isolation ON emergency_access_settings
  USING (owner_user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))
  WITH CHECK (owner_user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()));
-- emergency_access_contacts: same shape on owner_user_id.
```
C4 must audit for any *in-session* grantee-side reads of the emergency-access tables (e.g. a logged-in user listing grants naming their email) -- if found, they run under `withSystemContext` with app-level filtering, or the policy grows an email-match arm as a reviewed decision.

`users` table -- self-access via **either** identity: a delegate acting for an owner must still reach their *own* row (`changePassword` deliberately targets `realUserId`, `users.controller.ts:86-90` -- under a `current`-only policy that read returns null and the endpoint 404s). Cross-user reads (admin, login-by-email/oidc before a session exists) go through `app.bypass_rls`:
```sql
CREATE POLICY users_self ON users
  USING (id = (SELECT app_current_user_id()) OR id = (SELECT app_real_user_id()) OR (SELECT app_bypass_rls()))
  WITH CHECK (id = (SELECT app_current_user_id()) OR id = (SELECT app_real_user_id()) OR (SELECT app_bypass_rls()));
```

Tables left RLS-**disabled**, each with a documented rationale in the migration:
- `currencies`, `exchange_rates` -- global reference data; writes already go through controlled/owner paths.
- `oauth_payloads` -- has **no owner column** (keyed by opaque `id`/`model`/`grant_id`/`uid`; `schema.sql:1174`). All access happens in the pre-session OAuth flow, which runs under `withSystemContext` regardless, so a policy would add nothing but a bypass arm. It does hold sensitive material (codes/tokens in `payload` JSONB); the hardening option is to revoke `monize_app`'s grants on it entirely and give the OAuth module an owner DataSource -- decide at C1.
- `schema_migrations` -- infrastructure.

Migration sequencing (continue from the current max prefix -- verify with `ls database/migrations`; currently `102`). **No migration mentions the `monize_app` role** -- role and grants live in db-init (Phase 1), so every migration below applies cleanly whether or not the role exists. `CREATE POLICY` on a table that has not run `ENABLE ROW LEVEL SECURITY` is inert, so all policies ship early and the enable ships **last, in its own release** -- it is the only behavior-changing migration and it is flip B of the rollout:
- `0NN_rls_helpers_and_trigger.sql` -- the three helper functions + GUC-aware `update_updated_at_column()` replacement. No grants. Inert.
- `0NN+1_rls_policies_direct.sql` -- policies for all direct `user_id` tables (no enable). Inert.
- `0NN+2_rls_policies_indirect.sql` -- `EXISTS` policies for join-scoped + junction tables. Inert.
- `0NN+3_rls_policies_special.sql` -- `users`, `account_delegates`, `delegate_account_favourites`, `emergency_access_*` policies; document the RLS-disabled exemptions (`currencies`, `exchange_rates`, `oauth_payloads`, `schema_migrations`). Inert.
- `0NN+4_rls_enable.sql` -- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` for every policied table. Ships in the flip-B release only after flip A (privilege drop) has soaked in prod.

Each is idempotent (`DROP POLICY IF EXISTS` then `CREATE`; `ENABLE` is idempotent) and **mirrored into `database/schema.sql`** so a fresh `db-init` equals a migrated DB.

> Performance note: indirect policies run the `EXISTS` per candidate row. With existing FK indexes this is a cheap index probe, and because app-level filtering already narrows the result set, the predicate is almost always validating an already-correct, already-small set. Watch the heaviest bulk readers (investment reports, full backup export over `security_prices`/`transaction_splits`) during the monitoring phase; if any regress, run those specific export paths under `withSystemContext`.

### Phase 4: Privileged / out-of-request contexts

`withSystemContext(fn)` and `withUserContext(userId, fn)` (`backend/src/common/db/with-context.ts`) seed the same ALS scope the request interceptor does (`{ system: true }` or `{ userId }`); every `tenantTx()` inside `fn` then sets the matching GUC (`app.bypass_rls = 'on'` or `app.current_user_id`) transaction-locally. The helpers hold no connection and need no cleanup -- they only establish ambient identity for code with no HTTP request. Apply them:

- **Admin** (`backend/src/admin/`, RolesGuard + `@Roles('admin')`): wrap cross-user service calls in `withSystemContext`. *Hardening option:* if the maintainer wants the app role to have **no** self-bypass path at all, give the admin module a second TypeORM DataSource connecting as the owner instead of the `app.bypass_rls` GUC -- strictly more auditable, at the cost of a second connection identity. Default recommendation is the GUC for uniformity.
- **Auth bootstrap -- prefer `withUserContext` when the identity is already known; `withSystemContext` only pre-identity.** `jwt.strategy` validate runs in the guard phase, *before* the interceptor's ALS scope exists -- but it is not identity-less: the verified token's `sub` **is** the authenticated user. Wrap its lookups (`getUserStateById`, `validateActingContext`) in `withUserContext(payload.sub)` -- the `users` self-policy and the `account_delegates` delegate-side arm make both queries visible without bypass. This matters: jwt validation is the **highest-QPS query in the system** (every authenticated request); running it under bypass would make `app.bypass_rls` the common case instead of the exception and hollow out the bypass-fence story. `withSystemContext` remains for the genuinely pre-identity paths:
  - `AuthService` login-by-email / register / refresh (before the token exists).
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

- **Apply policies in the integration harness.** In `backend/test/helpers/integration-setup.ts`, after the `synchronize` schema is built, run a shared `applyRlsPolicies(dataSource)` that executes the **actual migration files** (`database/migrations/0NN_rls_*.sql`, read from disk -- not a duplicated copy of their SQL), creates `monize_app` in the test DB, and applies the Phase 1 grants (the migrations no longer contain them). Crucially it must also create the `update_*_updated_at` **triggers** for the tables the trigger tests touch: `synchronize` builds the schema from entities and creates **no DB triggers** (`@UpdateDateColumn` stamps app-side), and the RLS migrations only `CREATE OR REPLACE` the trigger *function* -- without explicitly creating the triggers (extract their DDL from `schema.sql` so the harness cannot drift), the `preserve_timestamps` assertions pass vacuously and C5's acceptance proves nothing. One source of truth; the harness cannot drift from prod.
- **New `backend/test/integration/rls-enforcement.integration.spec.ts` -- catalog-driven, not hand-listed.** The spec enumerates coverage from the DB itself: every table must fall into exactly one of four buckets -- (1) has a `user_id` column (direct policy expected), (2) appears in an explicit **owner-column map** (table -> owning column(s): `users -> id`, `account_delegates -> owner_user_id/delegate_user_id`, `delegate_account_favourites -> delegate_user_id`, `emergency_access_settings/contacts -> owner_user_id`), (3) appears in an explicit indirect-ownership map (child table -> owning-parent join path), or (4) appears in an explicit exemption list (`currencies`, `exchange_rates`, `oauth_payloads`, `schema_migrations`). A table in no bucket, or a bucketed table missing its policy in `pg_policies`, **fails the suite** -- a future table cannot be forgotten, because forgetting is a test failure, not a review miss. For each covered table, inside a transaction, `SET LOCAL ROLE monize_app` (drops the superuser test connection to the unprivileged role), then generically:
  - GUC = userA -> raw `SELECT * FROM accounts` (no app-level `WHERE`) returns **only** userA's rows; GUC = userB -> only userB's.
  - GUC unset/empty -> **zero rows** for a direct table (`accounts`) and an indirect table (`transaction_splits` / `holdings`). GUC = non-UUID garbage -> the statement **raises** `invalid input syntax for type uuid` (22P02), not zero rows. Both are the fail-closed assertion -- assert each by its actual failure class.
  - Delegation: `current_user_id` = owner, `real_user_id` = delegate -> `delegate_account_favourites` rows for the delegate are visible and insertable, the delegate's own `users` row is visible, and `account_delegates` is visible from both the owner's and the delegate's side.
  - `WITH CHECK`: `INSERT INTO accounts(user_id, ...)` with another user's id while GUC = userA -> fails.
  - `app.bypass_rls = 'on'` -> cross-user `SELECT` returns both users (proves jobs/admin work).
  - `app.preserve_timestamps = 'on'` -> an `UPDATE` keeps the supplied `updated_at` (proves the restore path's trigger bypass); unset -> the trigger stamps `CURRENT_TIMESTAMP` as today.
- **GUC scope test:** run a `tenantTx`, let it COMMIT, then assert on the same physical connection that `current_setting('app.current_user_id', true)` is empty and a follow-up raw `SELECT` returns zero rows -- proves the transaction-local revert that replaces all reset/release bookkeeping.
- **Keep the existing isolation suite green:** `security-cross-user-isolation.integration.spec.ts` must still pass after data access is routed through `tenantTx` in the test DataSource.
- **Unit tests** for `tenantTx`, `withUserContext`, `withSystemContext` (assert the exact `set_config(..., true)` SQL for both identity GUCs including the `realUserId ?? userId` default, the throw on missing context, the **re-entrant path** -- a nested `tenantTx` reuses the ambient EntityManager and opens no second transaction -- no identity-GUC emission at `RLS_MODE=off`, and `preserveTimestamps` emission in **every** mode including `off`), to protect the 95%/85% coverage thresholds.

### Phase 6: Rollout, flags, docs

Phased and independently revertible. The key structural choice: **privileges drop before RLS turns on**, so the two failure classes -- `permission denied` (grants, DDL, ownership) and zero rows (missing context) -- can never surface in the same step:

1. **Plumbing as no-op** (`RLS_MODE=off`): ship the Phase 2 `tenantTx` refactor + the `withSystemContext`/`withUserContext` call sites, module-by-module. Because `tenantTx()` throws on context-less DB access, most context gaps surface right here, in dev and CI -- not under enforcement. No DB change.
2. **Shadow soak** (`RLS_MODE=shadow`, prod): GUCs emitted per transaction, runtime still the owner. Land the helper/trigger + policy migrations (inert without enable; none references the app role -- grants live in db-init). Soak for **weeks, not days** -- the transaction wrapping proves itself (endpoint latency, error rates) while RLS itself is still off.
3. **Staging, fully enforced -- not the demo alone.** The demo cannot be the enforce-verification environment: `docker-compose.demo.yml` sets `DEMO_MODE=true`, and both backup **restore** and the emergency-access **claim** endpoints are `@DemoRestricted` -- `DemoModeGuard` 403s them before any service code runs, so two of the three riskiest paths would go unexercised while the soak looks green. Instead: stand up a non-demo staging stack (the prod compose with `DEMO_MODE=false` and a **pinned pre-release image tag**) at `RLS_MODE=enforce` *with* the enable migration deployed. Postgres statement/policy logging on; full e2e + integration; explicitly exercise backup restore, emergency-access claim, MCP-via-PAT, and **delegate-acting flows** (switch to a delegated account, browse, favourite an account, change the delegate's own password). The demo can still run enforce for general-traffic soak in parallel. Image discipline for the whole rollout window: prod must run a **pinned release tag, not `:latest`** -- demo and prod currently share `ghcr.io/kenlasko/monize-backend:latest`, so without pinning, deploying the flip-B image anywhere deploys it to prod on its next pull.
4. **Prod flip A -- privilege drop** (`RLS_MODE=enforce`; enable migration *not* yet deployed to prod): runtime becomes `monize_app`, but no table has RLS enabled, so row visibility is unchanged. The only bugs that can surface are privilege-class (`permission denied`, DDL) -- loud, greppable, and low-stakes. Revert: `RLS_MODE=shadow`.
5. **Prod flip B -- enable RLS:** deploy the release containing `0NN+4_rls_enable.sql`. The only bugs that can surface now are context-class (zero rows). Emergency revert is unchanged and instant: `RLS_MODE=shadow` -- the owner role bypasses RLS even on enabled tables. Full policy removal remains available via the runbook's down-SQL.

Flags: `RLS_MODE=off|shadow|enforce` selects GUC emission + runtime role in one enum; `DATABASE_APP_USER/PASSWORD` supply the unprivileged role (required for `enforce`, validated at startup). On Kubernetes the flips are a ConfigMap edit (`RLS_MODE`) plus a rollout restart, with `DATABASE_APP_PASSWORD` in the DB Secret and the role in the CNPG `Cluster` `managed.roles`. Document in root `CLAUDE.md`, `database/CLAUDE.md`, `.env.example`, and the runbook `docs/future-plans/row-level-security-runbook.md` (move it to `docs/rls.md` when the feature ships; it includes the manual down-SQL, since the migration runner is forward-only).

i18n: RLS is backend/DB only. A `WITH CHECK` violation surfaces as a Postgres error; ensure `GlobalExceptionFilter` maps "new row violates row-level security policy" to a generic 403/404 (these should never reach users, because app-level filtering prevents hitting them) -- any new user-facing string there must be internationalized per project rules.

---

## Database Migration (representative)

```sql
-- 0NN_rls_helpers_and_trigger.sql  (run as owner; NO role or grant statements --
-- role creation and grants live in db-init so this migration can never fail on a
-- missing role; see Phase 1)
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_real_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.real_user_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_bypass_rls() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.bypass_rls', true) = 'on' $$;
-- + GUC-aware update_updated_at_column() replacement (Phase 3)

-- 0NN+1 / +2 / +3: per-table  DROP/CREATE POLICY  (direct, indirect, special) -- inert without enable
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
| GUC unset (e.g. a code path with no context) | Yes (fail-closed) | `app_current_user_id()` is NULL -> zero rows / write rejected, never an open door. (A *garbage* non-UUID GUC value fails closed too, but as a loud 22P02 cast error, not empty results.) |
| Delegate acting for an owner reaches another user's data beyond the delegation | Yes | `app.current_user_id` = owner scopes the owner's data; `app.real_user_id` = delegate scopes only the delegate-keyed rows (`users` self-row, `account_delegates` delegate side, `delegate_account_favourites`). Neither variable ever holds an id the JWT layer did not authenticate. |
| GUC leaks across pooled requests | Yes (by construction) | The GUC is transaction-local (`SET LOCAL`): Postgres reverts it at COMMIT/ROLLBACK before the connection can serve anything else. No reset code exists to get wrong. |
| Compromised app process sets `app.bypass_rls` | Partial | The GUC is only set by greppable helpers whose import is lint-allowlisted per module, never from user input (all queries parameterized). Invocations are logged with call site. The owner-DataSource hardening removes even this path for admin. |
| DB superuser / owner access (DBA, migrations) | By design exempt | Owner bypass is what lets migrations/seed/jobs operate; not a tenant-isolation threat. |
| Stolen DB backup at rest | No | RLS is access-time, not at-rest. (Encryption-at-rest / the user-encryption plan addresses this.) |

---

## Risks and Complexities

1. **Out-of-request and pre-session paths breaking (highest likelihood).** ~17 crons + seeders run context-less; PAT validation (all MCP traffic), password-reset / OIDC / OAuth bootstrap, the emergency-access claim, and backup restore touch user-scoped tables without (or with the *wrong*) user context -> zero rows, silent no-ops, or permission errors under enforcement. Mitigation: `tenantTx()` **throws** on context-less access, so missed paths fail in dev/CI at `RLS_MODE=off` rather than as silent zero rows in prod; wire `withSystemContext`/`withUserContext` in during Phase 2; audit every route reachable without `req.user` (Phase 4); the two-flip rollout isolates the remaining privilege-class bugs (flip A) from context-class bugs (flip B); the staging soak (Phase 6.3) surfaces any missed path before prod.
2. **A query path that never enters `tenantTx`.** A hand-rolled QueryRunner or a leftover injected repo runs with no GUC -- fail-closed zero rows under enforcement, invisible before it. Mitigation: the CI ratchet, then lint ban, on `@InjectRepository`/`createQueryRunner` outside `tenant-tx.ts` and test helpers; the throwing helper is the only sanctioned door to the DB.
3. **The ~80-service-file refactor.** Mechanical but broad -- roughly double an earlier "~40 services" estimate (measured: 86 files with `@InjectRepository`). Mitigation: it is fail-loud (a missed site throws at call time), it lands module-by-module behind `RLS_MODE=off` -- never one long-lived branch -- and the CI ratchet on remaining `@InjectRepository`/`createQueryRunner` sites makes regression impossible and progress visible.
4. **Per-operation transaction overhead and nesting.** Every simple read gains a BEGIN + `set_config` + COMMIT (~2 extra round-trips) on the app-DB link. Negligible on the Docker-local network; watch endpoint p95 during the shadow soak, and batch any read path that proves hot into one `tenantTx`. The sharper risk is **nested** `tenantTx` (service calling service): without the re-entrancy rule in Phase 2b, each nesting level takes a second pooled connection and the pool deadlocks under load -- the ALS-carried EntityManager makes nesting join the ambient transaction instead; its unit test is not optional.
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
6. Under enforcement, exercise the four paths most likely to break: run a backup **restore** (timestamps preserved, no `must be owner of table` error), complete an emergency-access **claim**, make an MCP request authenticated by PAT, and act as a **delegate** (switch to a delegated account, favourite an account, change the delegate's own password).
7. `npm run i18n:check` -- pseudo-locale fresh (only relevant if any exception copy was added).

---

## Estimated Scope

- **New files (~7):** `tenant-tx.ts`, `with-context.ts`, 5 RLS migrations (policies split from the enable; no grants migration -- grants live in db-init), the catalog-driven `rls-enforcement.integration.spec.ts`, ESLint restrictions (`with-context.ts` import allowlist; `@InjectRepository`/`createQueryRunner` ban), `docs/rls.md` runbook. No new interceptor -- the existing `RequestContextInterceptor` ALS scope is reused (though C6 restructures its fire-and-forget calls into that scope).
- **Modified files (~95+):** ~80 domain service files (data access through `tenantTx` -- measured: 86 files currently use `@InjectRepository`, 61 `createQueryRunner` sites, ~109 service files total; the R1-R7 task sums come to ~81 files -- an earlier "~40 services" figure understated this by half), `app.module.ts` (role selection, flag validation), `db-init.ts` (role + grants), `request-context.ts` (context interface extension incl. `realUserId`), admin/auth/cron/seeder paths, PAT + password-reset + OAuth bootstrap paths, `emergency-access-claim.controller.ts`, `backup.service.ts` (trigger-GUC swap replacing the `DISABLE TRIGGER` DDL), `database/schema.sql`, `integration-setup.ts`, `.env.example`, all `docker-compose*.yml`, `helm/values.yaml` + `helm/templates/configmap-backend.yaml` + the k8s overlay ConfigMap/Secret + CNPG `Cluster` manifest (`managed.roles`), root + `backend` + `database` CLAUDE.md.
- **No new npm dependency** (homegrown transaction helper; `typeorm-transactional` deliberately avoided).
- **DB objects:** 1 new role (provisioned by db-init or CNPG `managed.roles`), ~46 tables x (enable + policy), 3 helper functions + a GUC-aware replacement of `update_updated_at_column()`, grants + default privileges (applied idempotently by db-init).
- **Rollout:** behavior-neutral until flip A; two independent flips (privilege drop, then RLS enable), each with an instant `RLS_MODE=shadow` revert.

**Net assessment:** the defense-in-depth framing is what makes this tractable -- because app-level filtering stays, RLS almost always validates an already-correct query, so the failure modes that matter are *operational* (crons, auth bootstrap, restore) rather than *functional*, and every one of those fails loudly (thrown context errors in dev, `permission denied` at flip A, login failure) rather than silently leaking or silently returning empty. The transaction-local GUC removes the two riskiest moving parts of the earlier draft -- cross-request GUC bleed and pinned-connection pool pressure -- by construction, and makes the design pooler-proof. The dominant cost is the ~80-service-file refactor; the dominant risk is missed out-of-request paths, which the wrap-before-refactor task ordering (C1-C4/C6 before R1-R7), the throwing helper, and the two-flip rollout each catch at a different stage.
