# RLS Implementation: Agent Task List

> Companion to [`row-level-security.md`](./row-level-security.md) (the design) and
> [`row-level-security-runbook.md`](./row-level-security-runbook.md) (operations). This file breaks the
> plan into tasks sized for one AI-agent session each. Do the tasks in dependency order; never start a
> task whose dependencies are unmerged. Mark a task done by checking its box and noting the PR.

## How to use this list (read first, every session)

- **One task per session/PR.** Each task lists its files. Touching files outside the task's scope is a
  scope violation — stop and leave a note instead.
- **Every task lands behind `RLS_MODE=off`** and must leave observable behavior at `off` unchanged
  (mechanism may change — see the "Deployment safety" classes below). If your change alters observable
  behavior at `off`, the task is wrong — stop.
- **Definition of done for every task** (in addition to per-task acceptance):
  - `cd backend && npm run build && npm run lint` clean.
  - `npm run test:unit` green; new code covered (95% global / 85% per-file thresholds).
  - Migrations mirrored into `database/schema.sql` in the same PR.
  - No new user-facing strings (RLS is backend-only; if an exception message becomes user-visible, it
    must go through `tr()` + English catalogs, then `npm run i18n:pseudo`).
- **Terminology:** "the design doc" = `row-level-security.md`. Section references (e.g. "Phase 2b")
  point there. Migration numbers below assume the current max is `102_*`; **verify with
  `ls database/migrations` and renumber from the actual max before writing files.**

## Deployment safety

**Every task except M3 is safe to merge and deploy to existing deployments as soon as it is done, in
any order that respects the dependency column.** Existing deployments stay on `RLS_MODE=off` (the
default; unset env = `off`) throughout; nothing in F/M1/M2/T/R/C/L/D changes their behavior. Behavior
changes only when an operator deliberately flips modes per the runbook. The "Deploy impact" column
uses four classes:

| Class | Meaning |
|-------|---------|
| **none** | CI, tests, lint, or docs only — or code that ships but nothing calls yet. The running app is byte-for-byte behaviorally identical. |
| **inert** | Ships real code or DB objects to prod, designed to change nothing at `RLS_MODE=off`: a role nothing connects as, policies without `ENABLE`, a GUC-aware trigger that behaves identically while the GUC is unset, context wrappers that only seed ALS. Safe, but verify the per-task acceptance that proves inertness. |
| **neutral** | Rewrites live code paths (the `tenantTx` refactor, the restore swap). Designed behavior-preserving — same queries, same transaction boundaries — but carries normal regression risk. Full unit + module integration/e2e suites are the gate, not optional. |
| **DO NOT DEPLOY** | M3 only. Merging to a branch is fine; deploying it to prod is flip B, an operator decision after flip A has soaked. |

## Task graph

| ID | Task | Depends on | Deploy impact |
|----|------|-----------|---------------|
| F1 | RLS_MODE flag, role creation + grants in db-init, env plumbing (compose + helm/k8s) | — | inert |
| F2 | Request context extension (incl. `realUserId`) + `tenantTx` (re-entrant, both identity GUCs) + `with-context` helpers + exception-filter mapping | F1 | none |
| F3 | CI ratchet on `@InjectRepository` / `createQueryRunner` counts | F2 | none |
| M1 | Migration: helper functions + GUC-aware trigger (**no grants — they live in db-init, F1**) | — | inert |
| M2 | Migrations: direct + indirect + special (users/delegation/emergency) policies (no enable) | M1 | inert |
| M3 | Migration: `ENABLE ROW LEVEL SECURITY` (authored, **not deployed**) | M2 | **DO NOT DEPLOY** |
| T1 | Integration harness applies real RLS migrations + role/grants + `updated_at` triggers | M2, F1 | none |
| T2 | Catalog-driven `rls-enforcement` integration spec (4 buckets) | T1, M3 | none |
| C1 | Auth wrapping: `jwt.strategy` under `withUserContext(sub)`; PAT + password-reset + OAuth under `withSystemContext`; public-route audit | F2 | inert |
| C2 | Cron jobs: system fan-out + per-user bodies wrapped | F2 | inert |
| C3 | Seeders + demo reset under `withSystemContext` | F2 | inert |
| C4 | Emergency-access claim + expiry monitor under `withSystemContext`; grantee-side read audit | F2 | inert |
| C6 | Interceptor restructure: fire-and-forget writes moved inside the ALS scope | F2 | neutral |
| R1 | Refactor: accounts, categories, payees, tags, institutions | F3, C1–C4, C6 | neutral |
| R2 | Refactor: transactions, scheduled-transactions | F3, C1–C4, C6 | neutral |
| R3 | Refactor: securities, investment-reports, net-worth, monte-carlo, loan-* | F3, C1–C4, C6 | neutral |
| R4 | Refactor: budgets | F3, C1–C4, C6 | neutral |
| R5 | Refactor: built-in-reports, reports | F3, C1–C4, C6 | neutral |
| R6 | Refactor: ai, mcp, import, action-history, currencies, updates, notifications | F3, C1–C4, C6 | neutral |
| R7 | Refactor: auth, users, delegation, admin, emergency-access, backup, database | F3, C1–C4, C6 | neutral |
| C5 | Backup restore: `preserveTimestamps` flag replaces `DISABLE TRIGGER` DDL | F2, M1, R7 | neutral |
| L1 | Lint bans: `with-context.ts` import allowlist; `@InjectRepository`/`createQueryRunner` ban | R1–R7 | none |
| D1 | Docs: CLAUDE.md updates (incl. stale scheduler claim), `.env.example` + helm/k8s finalization, runbook promotion prep | all above | none |

**Why context wrapping (C1–C4, C6) comes BEFORE the refactors (R1–R7), not after.** `tenantTx` throws
on missing ambient context in every mode, including `off`. `jwt.strategy` runs in the guard phase —
before the interceptor's ALS scope exists — and `@Cron` handlers have no scope at all. If an R task
converted those code paths to `tenantTx` while the wrapping was still a later task, every login (and
every cron firing) would throw at `RLS_MODE=off` from the moment the R task deployed until the C task
landed — a broken window the old ordering (C depends on R) guaranteed. The fix is directional:
wrapping call paths in `withUserContext`/`withSystemContext` *before* any refactor is **inert** (the
helpers only seed AsyncLocalStorage; repositories keep working), so all wrapping lands first and every
R task converts code whose context already exists. An R task must never convert a call path whose
wrapping has not landed — if one is found mid-task, stop and note it.

Notes on the subtle rows:
- **M1 is a prod DB change on next deploy** (migrations run at startup): it replaces
  `update_updated_at_column()`. Inert because the new function is exactly the old one while
  `app.preserve_timestamps` is unset — and M1's acceptance test proves that. M1 contains **no role or
  grant statements** — a migration referencing `monize_app` would crash-loop any deployment where the
  role does not exist (role and grants are db-init's job, F1).
- **C5 is neutral, not inert:** it swaps the restore mechanism itself. It must work at `RLS_MODE=off`,
  which is why `tenantTx` emits `app.preserve_timestamps` in **every** mode (see F2) and why C5
  requires M1's trigger to already be in the deployed DB (guaranteed: M1 ships earlier and migrations
  run before the app serves traffic).
- **C6 is neutral, not inert:** it moves the interceptor's `touchLastActivity` / timezone-cache calls,
  which today run **before** `requestContextStorage.run()` is entered, into (or under a
  `withUserContext` wrapper matching) the request scope. Behavior-preserving by design, but it edits a
  hot code path on every authenticated request.

Operator-only steps (not agent tasks — see runbook): shadow flip, staging enforce, prod flip A
(privilege drop), prod flip B (deploy M3), monitoring during soaks.

---

## Foundation tasks

### F1. RLS_MODE flag, role creation, env plumbing

- [x] Status: done (branch `claude/rls-foundation-tasks-s8vgu4`)

**Scope:** `backend/src/db-init.ts`, `backend/src/app.module.ts`, `.env.example`, all
`docker-compose*.yml`, `helm/values.yaml`, `helm/templates/configmap-backend.yaml` (+ document the
CNPG `managed.roles` requirement and the kustomize-overlay ConfigMap/Secret keys).

**Do:**
1. `db-init.ts`: role **and grants** per design Phase 1, running on every startup **before the
   existing "tables already exist" early return** (`db-init.ts:44-56` — placed after it, the logic
   never runs on an initialized DB and rotation silently breaks):
   - When `DATABASE_APP_PASSWORD` is set: create/rotate `monize_app` — password via **parameterized**
     `set_config('monize.app_password', $1, false)`, then the `DO $$` block from the design doc
     (CREATE if absent, ALTER PASSWORD if present). Catch `insufficient_privilege` (42501) and
     continue with a warning naming CNPG `managed.roles` as the provisioning path. If unset, skip
     with a logged warning.
   - Whenever the role **exists** (however provisioned): idempotently apply the DML grants and
     `ALTER DEFAULT PRIVILEGES` (**no `FOR ROLE` clause** — the owner-role name is operator-chosen;
     see design Phase 1). **No migration may contain a role or grant statement.**
2. `app.module.ts` TypeORM factory: read `RLS_MODE` (`off`|`shadow`|`enforce`, default `off`); at
   `enforce` connect as `DATABASE_APP_USER`/`DATABASE_APP_PASSWORD`, else `DATABASE_USER`. Startup
   validation: `enforce` without `DATABASE_APP_PASSWORD` refuses to boot with a clear error. Invalid
   `RLS_MODE` value also refuses to boot. Expose the parsed mode via a small config provider (F2's
   `tenantTx` reads it).
3. Env: add `RLS_MODE`, `DATABASE_APP_USER`, `DATABASE_APP_PASSWORD` to `.env.example` (documented,
   including the `log_statement` password-visibility caveat) and to every `docker-compose*.yml` with
   empty-safe defaults (`${DATABASE_APP_PASSWORD:-}`); add the same keys to the helm chart
   (ConfigMap for mode/user, existing DB Secret for the password).

**Accept:** unit tests for mode parsing/validation (all 3 valid values, invalid value, enforce-without-
password). `docker compose -f docker-compose.dev.yml up` boots unchanged with an untouched `.env`
(no `DATABASE_APP_PASSWORD`): fresh init succeeds and no role is created. With the var set: role
exists with grants after boot; changing the var and restarting rotates the password **on an
already-initialized DB** (proves placement before the early return); revoking a grant and restarting
restores it (proves idempotent re-apply). No pool-size configuration added.

### F2. Request context extension + `tenantTx` + `with-context` helpers

- [x] Status: done (branch `claude/rls-foundation-tasks-s8vgu4`)

**Scope:** `backend/src/common/request-context.ts`, new `backend/src/common/db/tenant-tx.ts`, new
`backend/src/common/db/with-context.ts`, their unit tests. **Do not refactor any service in this task.**

**Do:**
1. Extend `RequestContext` with `realUserId?: string; system?: boolean; preserveTimestamps?: boolean`.
   No `qr` field — the design has no pinned connection.
2. `tenantTx(dataSource, fn)` exactly per design Phase 2b: throw
   `"DB access outside request/user/system context -- wrap the call path in withUserContext/withSystemContext"`
   when no ambient `userId`/`system`. **Re-entrancy first:** if the ALS scope already carries an active
   `EntityManager`, call `fn` with it directly — join the ambient transaction, never open a second one
   (a nested `dataSource.transaction` takes a second pooled connection and deadlocks the pool under
   load; see design Phase 2b). Otherwise open `dataSource.transaction`; when mode is not `off`, first
   emit `set_config('app.bypass_rls', 'on', true)` (system) or **both**
   `set_config('app.current_user_id', $1, true)` and
   `set_config('app.real_user_id', $1, true)` (user; real defaults to `ctx.realUserId ?? ctx.userId`);
   record the manager in the ALS scope; then run `fn(m)`. Additionally emit
   `set_config('app.preserve_timestamps', 'on', true)` whenever the context flag is set — **in every
   mode, including `off`, NOT gated on `RLS_MODE`**: it functionally replaces the restore path's
   `DISABLE TRIGGER` DDL (C5 breaks at `off` if this is mode-gated). All emissions transaction-local
   (`true` third arg) — never `false`.
3. `withUserContext(userId, fn)` / `withSystemContext(fn)`: seed the ALS scope (`{ userId }` /
   `{ system: true }`) and run `fn`. `withUserContext` validates `userId` is a UUID (a garbage value
   would make every policied statement raise 22P02). No connection handling, no cleanup.
   `withSystemContext` logs each invocation with its call site, rate-limited.
4. `RequestContextInterceptor` seeds `{ userId, realUserId, timezone }` for all authenticated routes
   (delegation already resolved by `jwt.strategy`; `realUserId` from `req.user.realUserId`). Do NOT
   move the fire-and-forget calls in this task — that is C6.
5. `GlobalExceptionFilter`: map Postgres `new row violates row-level security policy` (and the 22P02
   helper-cast error) to a generic 403/404 — these must never surface raw to users (design Phase 6
   i18n note).

**Accept:** unit tests assert — exact `set_config(..., true)` SQL per branch including both identity
GUCs and the `realUserId ?? userId` default; throw on missing context in every mode including `off`;
**nested `tenantTx` reuses the ambient manager and opens no second transaction**; no **identity**-GUC
emission at `off`; `preserveTimestamps` emission in **every** mode including `off`; system-vs-user
branch selection; UUID validation in `withUserContext`; filter mapping. LSP diagnostics clean.

### F3. CI ratchet

- [x] Status: done (branch `claude/rls-foundation-tasks-s8vgu4`). Baselines measured
  at implementation time: **251** `@InjectRepository(` call sites, **61**
  `createQueryRunner(` call sites (script counts occurrences, not files). Script:
  `backend/scripts/rls-ratchet.mjs` (+ `--update`), self-test
  `rls-ratchet.test.mjs`, committed baseline `rls-ratchet-baseline.json`; wired
  into the `backend-lint` CI job (`npm run rls:ratchet:test` then
  `npm run rls:ratchet`). Exact-match ratchet: a count above baseline fails
  (banned new site), below baseline fails (lower the baseline in the same PR).

**Scope:** a script under `backend/scripts/` (or repo `scripts/`), CI workflow wiring, a committed
baseline file.

**Do:** count `@InjectRepository(` and `createQueryRunner(` occurrences in `backend/src` (exclude
`tenant-tx.ts`, tests, test helpers). Fail CI if either count exceeds the committed baseline; passing
runs update instructions tell the agent to lower the baseline in the same PR as a refactor. Baselines
start at current counts (measured 2026-07: 86 files with `@InjectRepository` / 61 `createQueryRunner`
call sites — script counts call sites, measure
at implementation time).

**Accept:** script runs in CI; artificially adding one `@InjectRepository` fails it; lowering baseline
below actual also fails (prevents over-claiming).

---

## Migration tasks

### M1. Helper functions + GUC-aware trigger (no grants)

- [ ] Status: not started

**Scope:** new `database/migrations/103_rls_helpers_and_trigger.sql` (renumber from actual max),
`database/schema.sql`.

**Do:** per design Phase 3 — `app_current_user_id()`, `app_real_user_id()`, and `app_bypass_rls()`
helper functions; `CREATE OR REPLACE` of `update_updated_at_column()` with the
`app.preserve_timestamps` check. Idempotent. Behavior-inert (no policy, no enable).
**This migration must contain NO role or grant statements** — `GRANT ... TO monize_app` in a
migration crash-loops every deployment where the role does not exist (role + grants are db-init's
job, F1). Reject the task if any SQL here mentions `monize_app` or an owner-role name.

**Accept:** migration applies cleanly on a fresh dev DB **with and without `DATABASE_APP_PASSWORD`
set** and re-applies idempotently; `updated_at` trigger behavior unchanged when the GUC is unset
(add/extend a unit or integration test); schema.sql mirrored; `grep -i 'grant\|role' 103_*.sql`
returns nothing.

### M2. Policy migrations (direct, indirect, special) — no enable

- [ ] Status: not started

**Scope:** new `database/migrations/104_rls_policies_direct.sql`, `105_rls_policies_indirect.sql`,
`106_rls_policies_special.sql`, `database/schema.sql`.

**Do:** per design Phase 3. Every policy in the `(SELECT app_current_user_id())` initplan form with the
`OR (SELECT app_bypass_rls())` escape. **Enumerate every table's owner column from
`database/schema.sql` — do not trust any list, including the design doc's** (an earlier draft listed
tables under `user_id` policies that have no such column; `CREATE POLICY` validates its expression, so
a wrong column name crash-loops the deploy):
- **Direct** (`user_id`): the 29 tables verified in the design doc.
- **Indirect** (`EXISTS` to parent): `holdings`, `transaction_splits`, `transaction_tags`,
  `transaction_split_tags` (two-hop), `security_tags`, `security_prices`,
  `scheduled_transaction_splits`, `scheduled_transaction_split_tags` (two-hop),
  `scheduled_transaction_overrides`, `monte_carlo_cash_flows`, `budget_categories`, `budget_periods`,
  `budget_period_categories` (two-hop), `account_delegate_grants`.
- **Special** (bespoke owner columns, both GUCs — design Phase 3): `users`
  (`id = current OR id = real`), `account_delegates` (`owner_user_id = current OR
  delegate_user_id = real`), `delegate_account_favourites` (`delegate_user_id = real`),
  `emergency_access_settings` / `emergency_access_contacts` (`owner_user_id = current`).
`DROP POLICY IF EXISTS` before each `CREATE`. `currencies`, `exchange_rates`, `oauth_payloads`,
`schema_migrations` deliberately excluded — say so, with rationale, in a comment.
**No `ENABLE ROW LEVEL SECURITY` and no role/grant statements anywhere in these files.**

**Accept:** migrations apply + re-apply cleanly **on a DB without the `monize_app` role**;
`SELECT count(*) FROM pg_policies` matches the enumerated table count; every policied table's owner
column verified against schema.sql in the PR description; app behavior unchanged (policies inert
without enable); schema.sql mirrored.

### M3. Enable migration — authored, not deployed

- [ ] Status: not started

**Scope:** new `database/migrations/107_rls_enable.sql`, `database/schema.sql`.

**Do:** `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` for exactly the tables policied in M2. **This file
is flip B.** It ships to prod only in its own release after flip A soaks (runbook). Land it on a branch
CI can validate but tag the PR clearly: `do-not-deploy-before-flip-A`.

**Accept:** applies cleanly in a scratch DB; `pg_class.relrowsecurity` true for every policied table;
integration suite (T2) passes against it.

---

## Test tasks

### T1. Integration harness applies real migrations

- [ ] Status: not started

**Scope:** `backend/test/helpers/integration-setup.ts` (+ a new helper file if cleaner).

**Do:** after `synchronize`, run `applyRlsPolicies(dataSource)`:
1. Create `monize_app` in the test DB **before** anything references it, and apply the F1 grants
   (reuse/share db-init's grant SQL — the migrations no longer contain grants).
2. Execute the actual `database/migrations/1NN_rls_*.sql` files read from disk (never duplicated SQL).
3. Create the `update_updated_at_column()` **triggers** for the tables the trigger tests touch,
   extracting their `CREATE TRIGGER` DDL from `database/schema.sql` — `synchronize` builds from
   entities and creates **no** DB triggers (`@UpdateDateColumn` stamps app-side), and the RLS
   migrations only replace the trigger *function*. Without this step, T2's trigger assertions and
   C5's restore acceptance pass vacuously.
Keep existing suites green — notably `security-cross-user-isolation.integration.spec.ts`.

**Accept:** all existing integration suites pass; harness fails loudly if a migration file is missing
or unreadable (no silent skip); a raw `UPDATE` on a trigger-covered table in the test DB stamps
`updated_at` (proves the triggers actually exist in the harness).

### T2. Catalog-driven `rls-enforcement` spec

- [ ] Status: not started

**Scope:** new `backend/test/integration/rls-enforcement.integration.spec.ts`.

**Do:** per design Phase 5. Enumerate every table from the DB; each must be in exactly one of **four**
buckets — `user_id` column / explicit **owner-column map** (`users → id`,
`account_delegates → owner_user_id + delegate_user_id`, `delegate_account_favourites →
delegate_user_id`, `emergency_access_settings|contacts → owner_user_id`) / explicit
indirect-ownership map / explicit exemption list (`currencies`, `exchange_rates`, `oauth_payloads`,
`schema_migrations`) — anything else **fails**. Missing `pg_policies` entry for a bucketed table
fails. Then, per covered table, inside a transaction with `SET LOCAL ROLE monize_app`: userA/userB
visibility; unset/empty GUC → **zero rows**; **non-UUID garbage GUC → the statement raises
`invalid input syntax for type uuid` (22P02), asserted as an error, not as empty results**;
`WITH CHECK` cross-user insert rejection; `app.bypass_rls` cross-user read;
`app.preserve_timestamps` trigger behavior; **delegation semantics** — with `current` = owner and
`real` = delegate: the delegate's `users` row is visible, `delegate_account_favourites` rows are
visible and insertable, `account_delegates` visible from both sides; and the **GUC scope test** —
after a committed `tenantTx`, `current_setting('app.current_user_id', true)` on the same connection
is empty and a raw `SELECT` returns zero rows.

**Accept:** suite green against M1–M3; deliberately dropping one policy in a scratch run makes it fail;
adding a fake unbucketed table makes it fail; the delegation assertions fail if the `real` GUC arm is
removed from any of the three special policies.

---

## Service refactor tasks (R1–R7)

Shared instructions for every R task — the per-task list only names the modules:

- Replace injected-repository data access with `tenantTx(this.dataSource, (m) => ...)`; replace manual
  `createQueryRunner()`/`startTransaction()`/`release()` blocks with
  `tenantTx(this.dataSource, async (m) => { ... })`. Helpers that took a `QueryRunner` take an
  `EntityManager`. Scope each `tenantTx` to the unit the code transacts **today** — one read or one
  read-modify-write block; never a whole request handler. Cross-service calls need no special
  handling: a nested `tenantTx` joins the ambient transaction (F2's re-entrancy).
- **Context precondition:** C1–C4 and C6 have already wrapped every out-of-request entry point
  (guards/strategies, crons, seeders, interceptor writes) — an R task only converts data access whose
  ambient context exists. If you find a call path reaching the module's services with no wrapping
  (`tenantTx` would throw at `off`), **stop and note it** — do not add `withSystemContext` yourself
  and do not convert that path.
- Keep the existing per-module unit tests green by mocking `tenantTx`/`DataSource.transaction` instead
  of repositories; update test helpers once, reuse across the batch.
- Lower the F3 ratchet baselines in the same PR.
- Out of scope: any *new* `withSystemContext`/`withUserContext` wrapping, any module not listed.
- Accept (every R task): build/lint/unit green; module's integration + e2e specs green; **a dev smoke
  of the module's cron/bootstrap paths at `RLS_MODE=off` shows no context throws**; ratchet lowered;
  zero `@InjectRepository`/`createQueryRunner` left in the listed modules.

### R1. accounts, categories, payees, tags, institutions
- [ ] Status: not started — ~13 service files. Includes the balance-update atomic SQL paths
  (`UPDATE accounts SET current_balance = current_balance + $1 ...` stays raw, inside `tenantTx`).

### R2. transactions, scheduled-transactions
- [ ] Status: not started — ~9 service files; the heaviest QueryRunner users (create/update/remove,
  transfers, splits, bulk, reconciliation in dedicated `transaction-*.service.ts` files). Preserve
  transaction boundaries exactly.

### R3. securities, investment-reports, net-worth, monte-carlo, loan-rate-changes, loan-scenarios
- [ ] Status: not started — ~14 service files; includes holdings rebuild and investment CRUD
  QueryRunner flows.

### R4. budgets
- [ ] Status: not started — ~8 service files.

### R5. built-in-reports, reports
- [ ] Status: not started — ~10 service files; read-heavy — watch that report queries stay
  single-`tenantTx` (no per-row transactions in loops).

### R6. ai, mcp, import, action-history, currencies, updates, notifications
- [ ] Status: not started — ~12 service files. AI relay/query SSE and MCP HTTP must hold **no**
  connection between queries (verify streaming paths call `tenantTx` per operation, not around the
  stream).

### R7. auth, users, delegation, admin, emergency-access, backup, database
- [ ] Status: not started — ~15 service files. The context wrapping for these modules already landed
  in C1/C3/C4 (this is why R7 depends on them) — the refactor converts data access *inside* those
  existing scopes. Delegation paths keyed by `realUserId` (`changePassword`,
  `delegate_account_favourites`) need no special handling: the context carries `realUserId` and the
  special policies match it. Restore's `preserveTimestamps` swap stays out of scope (C5).

---

## Context-wrapping tasks (C1–C6)

### C1. Auth wrapping + public-route audit (lands BEFORE the refactors)

- [ ] Status: not started

**Scope:** `backend/src/auth/**`, `backend/src/oauth/**`, PAT validation path, password-reset +
email-verification lookups, plus the audit. Wrapping only — no repository-to-`tenantTx` conversion
(that is R7). Wrapping before refactoring is inert: the helpers only seed ALS.

**Do:** per design Phase 4:
- `jwt.strategy` validate (user + delegation lookups): **`withUserContext(payload.sub)`**, NOT
  `withSystemContext` — the verified token already names the user, and this is the highest-QPS query
  in the system; bypass must not be its steady state.
- `withSystemContext` for the genuinely pre-identity paths: login-by-email / register / refresh, PAT
  token-hash lookup (all MCP traffic), password-reset / email-verification token lookups, OIDC/OAuth
  callback and the MCP-connector OAuth flow's `oauth_payloads` access. While here, record the
  `oauth_payloads` hardening decision (design Phase 3: keep grants + RLS-exempt, or revoke
  `monize_app` grants and use an owner DataSource for the OAuth module) in the PR.
- Then **audit every route reachable without `req.user`** (guard-less controllers, public decorators,
  every Passport strategy) and list the findings in the PR — each either wrapped, or explicitly
  justified as touching no user table.

**Accept:** integration/e2e auth suites green (wrapping is behavior-neutral pre-refactor); audit list
in PR description; grep shows no `withSystemContext` import in `jwt.strategy`.

### C2. Cron jobs

- [ ] Status: not started

**Scope:** every `@Cron` handler (~17 files / ~20 decorators; grep `@Cron` across `backend/src`).
Wrapping only, before any R task refactors these services — wrapping is inert pre-refactor.

**Do:** cross-user fan-out queries under `withSystemContext`; per-user bodies under
`withUserContext(userId)` so they keep the RLS net. Pattern per design Phase 4
(`processAutoPostTransactions`, `getUsersByEffectiveTimezone` are the named examples). Enumerate all
handlers in the PR description with which wrapper each got. (Note: crons verifiably run in the API
process — `ScheduleModule.forRoot()` in `app.module.ts`, no scheduler entrypoint exists; on k8s every
replica fires every cron, pre-existing.)

**Accept:** unit tests for at least the auto-post and demo-reset paths proving wrapper usage; full list
in PR; no handler left unwrapped (grep `@Cron` count == enumerated count).

### C3. Seeders + demo reset

- [ ] Status: not started

**Scope:** `database/seed.service.ts`, `demo-seed.service.ts`, daily demo reset entry. Wrapping only,
before R7 refactors the database module.

**Do:** wrap whole seed/reset flows in `withSystemContext` (raw cross-user SQL keeps working under
bypass).

**Accept:** seed + demo reset run green locally at `RLS_MODE=off`.

### C4. Emergency access

- [ ] Status: not started

**Scope:** `backend/src/emergency-access/emergency-access-claim.controller.ts` + claim service path,
expiry monitor. Wrapping only, before R7 refactors these services.

**Do:** claim flow (grantor's `users`/`trusted_devices`/`refresh_tokens` rows while requester is
grantee or bare token) and the expiry monitor's cross-user sweep under `withSystemContext`. Also
**audit for in-session grantee-side reads** of the emergency-access tables (a logged-in user listing
grants naming their email — the tables are owner-keyed with email/token grantee identification, so
such reads see zero rows under the owner-only policy): wrap any found in `withSystemContext` with
app-level filtering, or record a reviewed decision to extend the policy with an email-match arm.

**Accept:** emergency-access integration/e2e specs green; claim exercised end-to-end in the spec;
grantee-side audit result in the PR description.

### C5. Backup restore

- [ ] Status: not started

**Scope:** `backend/src/backup/backup.service.ts` (restore path, ~line 1317).

**Do:** delete the `ALTER TABLE ... DISABLE TRIGGER` / `ENABLE TRIGGER` pair; run restore transactions
with `preserveTimestamps: true` in the ambient context so `tenantTx` emits the GUC per transaction.
Restore runs under the requesting user's normal context — no system bypass, no DDL.

**Deploy note (why this is "neutral", not "inert"):** this task changes how restore works **at
`RLS_MODE=off`** — the GUC path becomes the only thing preserving restored timestamps. Two
preconditions, both guaranteed by task order but verify anyway: M1's GUC-aware trigger is in the
deployed DB (migrations run at startup, M1 ships earlier), and F2's `tenantTx` emits
`app.preserve_timestamps` unconditionally (not mode-gated).

**Accept:** backup export + restore integration test **at `RLS_MODE=off`** proves restored
`updated_at` values preserved and no `must be owner of table` error path remains; no `DISABLE TRIGGER`
string left in `backup.service.ts`.

### C6. Interceptor restructure: fire-and-forget writes into the ALS scope

- [ ] Status: not started

**Scope:** `backend/src/common/interceptors/request-context.interceptor.ts`, any other post-response
writes found by grep.

**Do:** the interceptor's own DB calls currently run **outside** the scope it creates:
`touchLastActivity` fires and `resolveTimezone` reads/writes `user_preferences` *before*
`requestContextStorage.run()` is entered (`request-context.interceptor.ts:78-99` — the scope wraps
only `next.handle()`). Converted naively in R7, all three sites would throw on every authenticated
request. Restructure: move these calls inside the scope the interceptor establishes, or wrap each in
`withUserContext(userId)`. Behavior at `off` must be preserved (same writes, same fire-and-forget
semantics). Do not convert the repository calls to `tenantTx` here — R7 does that; this task only
guarantees ambient context exists when it happens.

**Accept:** unit tests cover both writes running inside a context scope; interceptor e2e/integration
behavior unchanged; no context-throw in dev smoke once R7 lands (verified again there).

---

## Finalization tasks

### L1. Lint bans

- [ ] Status: not started — requires R1–R7 complete (ratchet at zero).

**Do:** ESLint `no-restricted-imports`: `with-context.ts` importable only from the allowlist (admin,
auth bootstrap, emergency access, cron/jobs, seeders, backup). Ban `@InjectRepository` and
`createQueryRunner` outside `tenant-tx.ts` + test helpers. Remove the F3 ratchet script (superseded).

**Accept:** lint fails on a synthetic violation of each rule; clean on the real tree.

### D1. Docs

- [ ] Status: not started

**Do:** update root `CLAUDE.md` (QueryRunner section now points at `tenantTx` as the required pattern)
and `database/CLAUDE.md` (RLS migration conventions, "adding a new table" policy step — four buckets,
no role/grants in migrations); fix `backend/CLAUDE.md`'s **stale scheduler claim** (crons run in the
API process; there is no separate scheduler — delete or fix the dead `start:scheduler` script
reference); finalize `.env.example` comments; verify the helm chart values/ConfigMap and the CNPG
`managed.roles` requirement are documented for k8s operators; verify the runbook matches the
implemented reality and note it moves to `docs/rls.md` at ship time.

**Accept:** docs match code; `npm run i18n:check` clean; design doc's Verification section items 1–2
runnable as written.
