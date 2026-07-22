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
| F1 | RLS_MODE flag, role creation, env plumbing | — | inert |
| F2 | Request context extension + `tenantTx` + `with-context` helpers | F1 | none |
| F3 | CI ratchet on `@InjectRepository` / `createQueryRunner` counts | F2 | none |
| M1 | Migration: grants, helper functions, GUC-aware trigger | F1 | inert |
| M2 | Migrations: direct + indirect + users policies (no enable) | M1 | inert |
| M3 | Migration: `ENABLE ROW LEVEL SECURITY` (authored, **not deployed**) | M2 | **DO NOT DEPLOY** |
| T1 | Integration harness applies real RLS migrations | M2 | none |
| T2 | Catalog-driven `rls-enforcement` integration spec | T1, M3 | none |
| R1 | Refactor: accounts, categories, payees, tags, institutions | F3 | neutral |
| R2 | Refactor: transactions, scheduled-transactions | F3 | neutral |
| R3 | Refactor: securities, investment-reports, net-worth, monte-carlo, loan-* | F3 | neutral |
| R4 | Refactor: budgets | F3 | neutral |
| R5 | Refactor: built-in-reports, reports | F3 | neutral |
| R6 | Refactor: ai, mcp, import, action-history, currencies, updates, notifications | F3 | neutral |
| R7 | Refactor: auth, users, delegation, admin, emergency-access, backup, database | F3 | neutral |
| C1 | Auth bootstrap + PAT + password-reset + OAuth under `withSystemContext`; public-route audit | F2, R7 | inert |
| C2 | Cron jobs: system fan-out + per-user bodies | F2, R1–R7 (the modules each cron touches) | inert |
| C3 | Seeders + demo reset under `withSystemContext` | F2, R7 | inert |
| C4 | Emergency-access claim + expiry monitor under `withSystemContext` | F2, R7 | inert |
| C5 | Backup restore: `preserveTimestamps` flag replaces `DISABLE TRIGGER` DDL | F2, M1, R7 | neutral |
| C6 | Fire-and-forget writes (`touchLastActivity`, timezone cache) | F2 | inert |
| L1 | Lint bans: `with-context.ts` import allowlist; `@InjectRepository`/`createQueryRunner` ban | R1–R7 | none |
| D1 | Docs: CLAUDE.md updates, `.env.example` finalization, runbook promotion prep | all above | none |

Notes on the two subtle rows:
- **M1 is a prod DB change on next deploy** (migrations run at startup): it replaces
  `update_updated_at_column()`. Inert because the new function is exactly the old one while
  `app.preserve_timestamps` is unset — and M1's acceptance test proves that.
- **C5 is neutral, not inert:** it swaps the restore mechanism itself. It must work at `RLS_MODE=off`,
  which is why `tenantTx` emits `app.preserve_timestamps` in **every** mode (see F2) and why C5
  requires M1's trigger to already be in the deployed DB (guaranteed: M1 ships earlier and migrations
  run before the app serves traffic).

Operator-only steps (not agent tasks — see runbook): shadow flip, staging enforce, prod flip A
(privilege drop), prod flip B (deploy M3), monitoring during soaks.

---

## Foundation tasks

### F1. RLS_MODE flag, role creation, env plumbing

- [ ] Status: not started

**Scope:** `backend/src/db-init.ts`, `backend/src/app.module.ts`, `.env.example`, all
`docker-compose*.yml`.

**Do:**
1. `db-init.ts`: create/rotate `monize_app` per design Phase 1 — password from `DATABASE_APP_PASSWORD`
   via **parameterized** `set_config('monize.app_password', $1, false)`, then the `DO $$` block from the
   design doc (CREATE if absent, ALTER PASSWORD if present — rotation must work). If the env var is
   unset, skip with a logged warning and continue.
2. `app.module.ts` TypeORM factory: read `RLS_MODE` (`off`|`shadow`|`enforce`, default `off`); at
   `enforce` connect as `DATABASE_APP_USER`/`DATABASE_APP_PASSWORD`, else `DATABASE_USER`. Startup
   validation: `enforce` without `DATABASE_APP_PASSWORD` refuses to boot with a clear error. Invalid
   `RLS_MODE` value also refuses to boot. Expose the parsed mode via a small config provider (F2's
   `tenantTx` reads it).
3. Env: add `RLS_MODE`, `DATABASE_APP_USER`, `DATABASE_APP_PASSWORD` to `.env.example` (documented) and
   to every `docker-compose*.yml` with empty-safe defaults (`${DATABASE_APP_PASSWORD:-}`).

**Accept:** unit tests for mode parsing/validation (all 3 valid values, invalid value, enforce-without-
password). `docker compose -f docker-compose.dev.yml up` boots unchanged with an untouched `.env`.
No pool-size changes (design explicitly drops the raised `extra.max`).

### F2. Request context extension + `tenantTx` + `with-context` helpers

- [ ] Status: not started

**Scope:** `backend/src/common/request-context.ts`, new `backend/src/common/db/tenant-tx.ts`, new
`backend/src/common/db/with-context.ts`, their unit tests. **Do not refactor any service in this task.**

**Do:**
1. Extend `RequestContext` with `system?: boolean; preserveTimestamps?: boolean`. No `qr` field — the
   design has no pinned connection.
2. `tenantTx(dataSource, fn)` exactly per design Phase 2b: throw
   `"DB access outside request/user/system context -- wrap the call path in withUserContext/withSystemContext"`
   when no ambient `userId`/`system`; open `dataSource.transaction`; when mode is not `off`, first emit
   `set_config('app.bypass_rls', 'on', true)` (system) or
   `set_config('app.current_user_id', $1, true)` (user); then run `fn(m)`. Additionally emit
   `set_config('app.preserve_timestamps', 'on', true)` whenever the context flag is set — **in every
   mode, including `off`, NOT gated on `RLS_MODE`**: it functionally replaces the restore path's
   `DISABLE TRIGGER` DDL (C5 breaks at `off` if this is mode-gated). All emissions transaction-local
   (`true` third arg) — never `false`.
3. `withUserContext(userId, fn)` / `withSystemContext(fn)`: seed the ALS scope (`{ userId }` /
   `{ system: true }`) and run `fn`. No connection handling, no cleanup. `withSystemContext` logs each
   invocation with its call site, rate-limited.
4. Verify `RequestContextInterceptor` seeds `{ userId, timezone }` for all authenticated routes
   (delegation already resolved by `jwt.strategy`); extend only if a gap is found — document any gap
   found in the PR description.

**Accept:** unit tests assert — exact `set_config(..., true)` SQL per branch; throw on missing context
in every mode including `off`; no **identity**-GUC emission at `off`; `preserveTimestamps` emission in
**every** mode including `off`; system-vs-user branch selection. LSP diagnostics clean.

### F3. CI ratchet

- [ ] Status: not started

**Scope:** a script under `backend/scripts/` (or repo `scripts/`), CI workflow wiring, a committed
baseline file.

**Do:** count `@InjectRepository(` and `createQueryRunner(` occurrences in `backend/src` (exclude
`tenant-tx.ts`, tests, test helpers). Fail CI if either count exceeds the committed baseline; passing
runs update instructions tell the agent to lower the baseline in the same PR as a refactor. Baselines
start at current counts (~70 service files / 61 QueryRunner files — script counts call sites, measure
at implementation time).

**Accept:** script runs in CI; artificially adding one `@InjectRepository` fails it; lowering baseline
below actual also fails (prevents over-claiming).

---

## Migration tasks

### M1. Grants, helper functions, GUC-aware trigger

- [ ] Status: not started

**Scope:** new `database/migrations/103_rls_role_grants_and_helpers.sql` (renumber from actual max),
`database/schema.sql`.

**Do:** per design Phase 1 + Phase 3 — schema/table/sequence grants + `ALTER DEFAULT PRIVILEGES` for
`monize_app`; `app_current_user_id()` and `app_bypass_rls()` helper functions; `CREATE OR REPLACE` of
`update_updated_at_column()` with the `app.preserve_timestamps` check. Idempotent. Behavior-inert
(no policy, no enable).

**Accept:** migration applies cleanly on a fresh dev DB and re-applies idempotently; `updated_at`
trigger behavior unchanged when the GUC is unset (add/extend a unit or integration test); schema.sql
mirrored.

### M2. Policy migrations (direct, indirect, users) — no enable

- [ ] Status: not started

**Scope:** new `database/migrations/104_rls_policies_direct.sql`, `105_rls_policies_indirect.sql`,
`106_rls_policies_users.sql`, `database/schema.sql`.

**Do:** per design Phase 3. Every policy in the `(SELECT app_current_user_id())` initplan form with the
`OR (SELECT app_bypass_rls())` escape. Direct policies for every table with `user_id`; `EXISTS`
policies for `holdings`, `transaction_splits`, `scheduled_transaction_splits`, `security_prices`,
`monte_carlo_cash_flows`, and all junction tables (resolve the owning side from `database/schema.sql`
— enumerate, do not guess); `users` self-policy. `DROP POLICY IF EXISTS` before each `CREATE`.
`currencies`, `exchange_rates`, `schema_migrations` deliberately excluded — say so in a comment.
**No `ENABLE ROW LEVEL SECURITY` anywhere in these files.**

**Accept:** migrations apply + re-apply cleanly; `SELECT count(*) FROM pg_policies` matches the
enumerated table count; app behavior unchanged (policies inert without enable); schema.sql mirrored.

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

**Do:** after `synchronize`, run `applyRlsPolicies(dataSource)`: execute the actual
`database/migrations/1NN_rls_*.sql` files read from disk (never duplicated SQL), create `monize_app`
in the test DB. Keep existing suites green — notably
`security-cross-user-isolation.integration.spec.ts`.

**Accept:** all existing integration suites pass; harness fails loudly if a migration file is missing
or unreadable (no silent skip).

### T2. Catalog-driven `rls-enforcement` spec

- [ ] Status: not started

**Scope:** new `backend/test/integration/rls-enforcement.integration.spec.ts`.

**Do:** per design Phase 5. Enumerate every table from the DB; each must be in exactly one bucket —
`user_id` column / explicit indirect-ownership map / explicit exemption list — anything else **fails**.
Missing `pg_policies` entry for a bucketed table fails. Then, per covered table, inside a transaction
with `SET LOCAL ROLE monize_app`: userA/userB visibility, unset/empty/bogus GUC → zero rows,
`WITH CHECK` cross-user insert rejection, `app.bypass_rls` cross-user read, `app.preserve_timestamps`
trigger behavior, and the **GUC scope test** — after a committed `tenantTx`,
`current_setting('app.current_user_id', true)` on the same connection is empty and a raw `SELECT`
returns zero rows.

**Accept:** suite green against M1–M3; deliberately dropping one policy in a scratch run makes it fail;
adding a fake unbucketed table makes it fail.

---

## Service refactor tasks (R1–R7)

Shared instructions for every R task — the per-task list only names the modules:

- Replace injected-repository data access with `tenantTx(this.dataSource, (m) => ...)`; replace manual
  `createQueryRunner()`/`startTransaction()`/`release()` blocks with
  `tenantTx(this.dataSource, async (m) => { ... })`. Helpers that took a `QueryRunner` take an
  `EntityManager`. Scope each `tenantTx` to the unit the code transacts **today** — one read or one
  read-modify-write block; never a whole request handler.
- Keep the existing per-module unit tests green by mocking `tenantTx`/`DataSource.transaction` instead
  of repositories; update test helpers once, reuse across the batch.
- Lower the F3 ratchet baselines in the same PR.
- Out of scope: any `withSystemContext`/`withUserContext` wrapping (C tasks), any module not listed.
- Accept (every R task): build/lint/unit green; module's integration + e2e specs green; ratchet lowered;
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
- [ ] Status: not started — ~15 service files. Mechanical refactor only; the context *wrapping* for
  these modules is C1–C5. Where a path clearly needs system context (e.g. PAT lookup), leave a
  `// C1: withSystemContext` marker comment rather than wrapping here.

---

## Context-wrapping tasks (C1–C6)

### C1. Auth bootstrap + public-route audit

- [ ] Status: not started

**Scope:** `backend/src/auth/**`, `backend/src/oauth/**`, PAT validation path, password-reset +
email-verification lookups, plus the audit.

**Do:** wrap every pre-session user-table access in `withSystemContext` per design Phase 4: login /
register / refresh, `jwt.strategy` validate (user + delegation lookups), PAT token-hash lookup (all
MCP traffic), password-reset / email-verification token lookups, OIDC/OAuth callback and the
MCP-connector OAuth flow's `oauth_payloads` access. Then **audit every route reachable without
`req.user`** (guard-less controllers, public decorators, every Passport strategy) and list the findings
in the PR — each either wrapped, or explicitly justified as touching no user table.

**Accept:** integration/e2e auth suites green; audit list in PR description; the `// C1:` markers left
by R7 are all resolved.

### C2. Cron jobs

- [ ] Status: not started

**Scope:** every `@Cron` handler (~17; grep `@Cron` across `backend/src`).

**Do:** cross-user fan-out queries under `withSystemContext`; per-user bodies under
`withUserContext(userId)` so they keep the RLS net. Pattern per design Phase 4
(`processAutoPostTransactions`, `getUsersByEffectiveTimezone` are the named examples). Enumerate all
handlers in the PR description with which wrapper each got.

**Accept:** unit tests for at least the auto-post and demo-reset paths proving wrapper usage; full list
in PR; no handler left unwrapped (grep `@Cron` count == enumerated count).

### C3. Seeders + demo reset

- [ ] Status: not started

**Scope:** `database/seed.service.ts`, `demo-seed.service.ts`, daily demo reset entry.

**Do:** wrap whole seed/reset flows in `withSystemContext` (raw cross-user SQL keeps working under
bypass).

**Accept:** seed + demo reset run green locally at `RLS_MODE=off`.

### C4. Emergency access

- [ ] Status: not started

**Scope:** `backend/src/emergency-access/emergency-access-claim.controller.ts` + claim service path,
expiry monitor.

**Do:** claim flow (grantor's `users`/`trusted_devices`/`refresh_tokens` rows while requester is
grantee or bare token) and the expiry monitor's cross-user sweep under `withSystemContext`.

**Accept:** emergency-access integration/e2e specs green; claim exercised end-to-end in the spec.

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

### C6. Fire-and-forget writes

- [ ] Status: not started

**Scope:** `touchLastActivity`, timezone-cache persistence in `request-context.interceptor.ts`, any
other post-response writes found by grep.

**Do:** confirm each runs on the request's ALS scope (then plain `tenantTx` works) or wrap detached
paths in `withUserContext`/`withSystemContext`.

**Accept:** unit tests cover both writes; no context-throw at runtime in dev smoke.

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
and `database/CLAUDE.md` (RLS migration conventions, "adding a new table" policy step); finalize
`.env.example` comments; verify the runbook matches the implemented reality and note it moves to
`docs/rls.md` at ship time.

**Accept:** docs match code; `npm run i18n:check` clean; design doc's Verification section items 1–2
runnable as written.
