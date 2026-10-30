# AGENTS.md

Monize is a personal finance manager (a Microsoft Money replacement). Four layers, each with its own `package.json`: `backend/` (NestJS + TypeORM), `frontend/` (Next.js App Router + React, Tailwind v4, Zustand), `database/` (`schema.sql` plus `migrations/`, PostgreSQL 16), `e2e/` (Playwright). `docs/` holds the cross-layer contracts, `helm/` the chart, `scripts/` the repo-level CI checks. Everything runs in Docker: `docker compose -f docker-compose.dev.yml up`.

This is the canonical instruction file for every coding agent; `CLAUDE.md` imports it and adds only what Claude Code specifically should do. It holds the repo-wide rules and the workflow. The layer files `backend/CLAUDE.md` and `frontend/CLAUDE.md` are indexes over `docs/backend/` and `docs/frontend/`; `database/CLAUDE.md` and `e2e/CLAUDE.md` are short. Read the layer file for the layer you touch, then only the documents its table sends you to.

## How the instruction files are organised

This file and the layer files are read on every task, so they hold only what nearly every task needs, each rule in one or two sentences naming the thing to use and the thing not to.

- **Reading.** Before working in a layer, read its `CLAUDE.md`, then only the rows of its "Read when the work touches it" table that match the task.
- **Writing a rule.** A new rule is one line in the layer index (or one sentence in this file) plus the full entry in the matching `docs/<layer>/*.md` or contract document. If it does not fit in a sentence, it belongs in `docs/`.
- **Never in an instruction file:** the history of the defect, issue and PR numbers, the mechanism of the guard that holds the rule, edge cases, worked examples. Those go in the `docs/` entry, the regression test's comment, or an ADR.
- **A rule the machine enforces needs no essay.** Where a type, a lint rule or a source-scanning test holds a rule, name the abstraction to use and stop; the guard's failure message says what to use instead. `docs/guard-tests.md` says how to write one. `backend/src/common/instruction-files.spec.ts` holds every instruction file under its size ceiling and every `docs/<layer>/*.md` reachable from its index.

## Commands

Run from the layer directory.

```bash
# backend/
npm run lint && npx tsc --noEmit && npm run typecheck   # lint, src-only tsc, tsc over src AND test
npm run test:unit -- <pattern>                            # Jest, src/**/*.spec.ts, no database; npm test takes no args
TZ=UTC npm run test:unit -- --coverage                    # what CI runs (95/94/95/85 thresholds)
npm run test:integration                                  # test/integration/*.spec.ts, real PostgreSQL, one worker
npm run migration:lint:test && npm run migration:lint     # migrations touched
npm run push:client:test && npm run push:tls:test         # backend/scripts push tooling touched
npm run i18n:pseudo && npm run i18n:check                 # after editing en/*.json (not a CI gate for the backend)

# frontend/
npm run lint && npm run type-check && npm run i18n:check
npm run test -- <pattern>                                 # focused; CI runs test:cov (91/90/87/85 thresholds)
npm run test:cov && npm run build                         # the gate; bundle size is checked on every PR

# e2e/  (stack: docker compose -f docker-compose.e2e.yml up -d --wait)
npm test -- --workers=1                                   # whole suite; a single spec file is safe without the flag
npm run test:push                                         # push suite, playwright.push.config.ts, needs no stack

# repo root
node scripts/check-env-docs.mjs                           # a new process.env / configService.get must be in .env.example
node scripts/check-docs-manifests.mjs                     # a doc naming a path, an npm script or a Helm default
node scripts/check-migration-prefixes.mjs                 # needs the base ref (full clone), silently skips in a shallow one
scripts/verify-schema.sh                                  # migrations replay as a no-op on schema.sql; Docker only
```

## Required before you push

Mirrors `.github/workflows/ci.yml`. While developing run `npm run test:changed` (changed specs plus every guard, failures only); the coverage gate is CI's, run it locally only when asked.

- `backend/`: the three lint/typecheck commands, `npm run test:changed`, plus `migration:lint` when a migration changed and `npm run build && npm run test:integration` when a query, an entity, a migration or an RLS context changed.
- `frontend/`: `lint`, `type-check`, `i18n:check`, `test:changed`, `build`.
- A migration or `database/schema.sql`: `migration:lint`, `scripts/verify-schema.sh`, `node scripts/check-migration-prefixes.mjs`.
- An env var, a documented path or a Helm default: the two `scripts/check-*.mjs` above.
- A control an E2E spec drives was renamed or removed: grep `e2e/` for its accessible name; no unit suite loads those specs.
- **Stage new files first.** The guards that walk the tree with `git ls-files` cannot see an untracked file (`git add -N` is enough); green before staging and red in CI is not a flake.
- CI pulls images from `mirror.gcr.io` or `ghcr.io`, never Docker Hub (`ci-images.guard.spec.ts`).
- CI runs in UTC with one worker. The backend's database-backed suites rebuild one shared `monize_test` and never run in parallel with anything, including each other. `docs/verification-contract.md` section 7 explains the rest.
- The pre-commit hook (husky + lint-staged) runs `eslint --max-warnings=0 --fix` and prettier on staged files, which is stricter than CI's `lint`: a warning blocks the commit.

## Conventions you cannot infer from the code

- **`database/schema.sql` changes in the same commit as every migration.** New migrations are `YYYYMMDDHHMMSS_description.sql`; the checklist is in `database/CLAUDE.md`.
- **A guard test is met by fixing the code.** Baselines, allowlists and grandfather lists are shrink-only. If a guard fires and you believe it is wrong, stop and report what it names.
- No emojis anywhere, including commit messages and PR bodies. No `console.log`; the NestJS `Logger`. Immutability always. Many small files (200-400 lines typical, 800 max), organized by feature.
- **Security, do not regress:** parameterized SQL only; controllers under `AuthGuard('jwt')`; `userId` from the JWT, never from the request; `ParseUUIDPipe` on `:id`; DTOs with `whitelist` + `forbidNonWhitelisted` and bounded fields; `escapeHtml()` on every user value in an email template; secrets encrypted (AES-256-GCM) and never returned to the client.

## Internationalization (every change)

Every user-facing string is translated: `useTranslations` on the client, `tr(key, fallback, args)` for exception messages and `emailTranslator(i18n, recipientLang)` for anything composed outside a request on the server. Develop English-first, regenerate the pseudo-locale with `npm run i18n:pseudo`, and translate every other locale as the final commit on the PR; never hand-edit `xx/*`. The locale lists in `frontend/src/i18n/config.ts` and `backend/src/i18n/config.ts` stay in sync. Grep for a key before adding it: `JSON.parse` keeps the last duplicate. A number a person reads is localized by its own preference, `useNumberFormat()` on the client and `backend/src/common/number-locale.util.ts` on the server (`docs/frontend/forms-and-formatting.md`).

## Database access (CRITICAL)

**All** database access goes through `withScopedDb` (`backend/src/common/db/scoped-db.ts`), the single RLS-compliant door. Never add an `@InjectRepository(...)` field, a `this.dataSource.createQueryRunner()` call, a `this.dataSource.transaction(...)` call, or a bare `this.dataSource.query(...)`; ESLint bans the first three (`backend/eslint.config.mjs`). `DataSource.transaction()` is banned for a reason the `createQueryRunner()` ban did not cover: it opens a transaction that knows nothing about the ambient scoped manager, so it carries no identity GUCs under enforcement and commits independently of the caller's rollback. Inject `DataSource`; get repositories from the transaction's `EntityManager`; helpers take an `EntityManager`, never a query runner.

```typescript
await withScopedDb(this.dataSource, async (m) => {
  const repo = m.getRepository(UserPreference);
  const row = await repo.findOne({ where: { userId } });
  // ...mutate + repo.save(row); every query shares the transaction and the tenant GUC.
});
```

`withScopedDb` throws without an ambient identity. Authenticated routes have one (`RequestContextInterceptor`); everything else seeds its own from `backend/src/common/db/with-context.ts`: `withUserContext(userId, fn)` for a cron's per-user body, a background write or a bearer-only route; `withSystemContext(fn)` for genuinely cross-user work (fan-outs, seeders, bootstrap hooks, admin); `withDelegateContext(owner, delegate, fn)` where the two ids must differ; `withPreserveTimestamps(fn)` only in the backup restore. A new call site of any of these is added to `WITH_CONTEXT_ALLOWLIST` in the same PR, as a reviewed decision. Nested `withScopedDb` calls join the ambient transaction, so a service calling another is safe. `docs/row-level-security-contract.md` is canonical for exempt tables and the one sanctioned direct-`DataSource` exception; `docs/backend/database-access-and-tenancy.md` has the details and the "whose row is it" table.

## Transactions (CRITICAL)

Any operation that touches multiple tables or does read-modify-write runs in one `withScopedDb` transaction; this is the most common source of bugs in this codebase. **A rejected command must not already have written**: every check that can refuse a request (ownership, tenant or scenario identity, revision, precondition) runs inside the same transaction as the mutation, under the same lock where concurrency matters. Pass the caller's expectation down so the operation can refuse before writing. `docs/financial-calculation-contract.md` section 7 has the rule and the test obligation.

## Financial math

Money is `decimal(20,4)`. In JavaScript, never accumulate floats: sum `Math.round(Number(x) * 10000)` and divide once, or `roundMoney` every result, including a delta (`newAmount - oldAmount` is what a balance moves by). Balance updates are atomic SQL: `UPDATE accounts SET current_balance = current_balance + $1 WHERE id = $2`.

One sentence each; the reasoning and the guard that holds each one are in the contract documents.

- **An exchange rate is not money.** Rates are `NUMERIC(20,10)`: `roundFxRate`, never `roundMoney` or `toFixed(4)`; convert with `applyFxConversion`, validate with `normalizeFxEntry` (`backend/src/common/fx-entry.util.ts`).
- **A rate for a date is `resolveFxRate`** (`backend/src/common/time-series/fx-rate-resolver.ts`): the newest observation on or before the date within `FX_MAX_RATE_AGE_DAYS`, never one struck after it and never an unboundedly old one; `null` otherwise. INV-FX-001.
- **Rate 1 means "same currency", never "no rate found".** A failed lookup is unknown, not `1` and not the unconverted amount. Aggregate through `FxAggregate` (`backend/src/common/fx-aggregate.ts`); its `total` is `null` while `knownSubtotal` carries what converted.
- **A currency code is derived from the account**, never accepted from the request: `assertTransactionCurrencyMatchesAccount`.
- **A row carrying its own rate is converted at that rate on every surface**; the market rate on its own date is the fallback and the surface says which it used. INV-FX-002.
- **An executed total is the fact and the per-share price is derived from it** (`backend/src/securities/investment-amount.util.ts`), never the reverse on an unchanged row. INV-TRADE-001.
- **A preview computes what the commit will do, through the same code.** Call the same resolver from both.
- **Ask which occurrence before asking how much.** Every surface reads a scheduled occurrence from `ScheduledOccurrenceService` (client: `nextOccurrenceEffectiveAmount`, `nextOccurrenceDueDate`, `occurrenceSettlementAccountId`), never `amount`, `nextDueDate`, `accountId` or `nextOverride?.amount ?? amount`. `null` means unknown and is never a licence to fall back to the snapshot. INV-OCCURRENCE-003.
- **The fix for one surface is not the fix.** When you fix a derived-figure defect, grep every consumer of the raw field (dashboard, reports, exports, AI assistant, MCP, notifications) in the same commit and give them one server-authoritative answer.
- **A daily change needs a current close, not only the last two.** Two stored closes are a day's move only while they are adjacent sessions and the newer one is current: `resolveDailyPriceChange` (`backend/src/securities/daily-change.util.ts`), never a subtraction of the two most recent rows; a refusal is `null` and the surface names the session it does have.
- **A board of movers is one session's.** A ranked list of daily moves keeps only the rows carrying the newest `priceDate` on it (`keepNewestSession`, same file), so a holding whose feed skipped today does not rank yesterday's move against today's; a per-security readout dates each row instead.
- **A period change is not a return.** `PortfolioPeriodResultService` answers `valueChange`, `netExternalFlows` and `investmentResult` as three figures and puts a percentage only over the result; a difference of two closes counts the reader's own deposits as performance. INV-PORTRESULT-001.
- **Cash is not an investment.** A figure captioned as what the INVESTMENTS earned is `investmentPnl` / `investmentReturnPercent` over `securitiesValue` alone, never a measure that holds idle cash in its base. INV-PORTRESULT-002.
- **Convert before summing.** `FxAggregate` on the server, `sumConverted` / `sumEffectiveOccurrences` on the client; a total names its currency; a missing rate and an unknown component are two different reports with two different repairs.
- **The reporting-currency fallback is one constant.** `preferredCurrency` / `resolveUserDefaultCurrency` on the server, `preferredCurrency` on the client, `FALLBACK_DEFAULT_CURRENCY` the only literal per layer.
- **Withholding a figure is only honest if the reader learns why, and what to do.** A message that a figure cannot be worked out names the exact thing that is missing (the security, the currency pair, the account, the dates) and where the reader obtains it; where a provider can supply it, the read path fetches it first and discloses only what is still missing; a request that failed or has not answered is said to be one, never shown as missing data. A bare `null` is a dead end. `docs/financial-calculation-contract.md` section 1.3.
- **A subtotal is not a total (CRITICAL).** A field named `total*`, `portfolioValue`, `gain`, `tax` or `estimated*` carries a value only when every component is known; otherwise it is `null` and the partial sum, if returned, goes in its own named field. Never default a price, cost basis or rate to `0` or `1`. **`null` is not the safe answer either**: empty accounts hold zero, move zero, owe zero. Decide which of the two each branch is in before writing it.
- **A completeness flag is read where the numbers are shown.** Track each cause (`fxComplete`, `pricesComplete`), give consumers one `valuationComplete`, carry it to every surface including the LLM shape, read it as `=== false` (absent means no information), and relabel a partial figure rather than leaving a total's caption over it. Zero needs no rate.
- **VOID means no balance moved, on every path that writes one**; inclusion is decided per row, and a cross-owner transfer's legs may hold different statuses. INV-TRANSFER-001.
- **A refusal is only worth as much as its least-guarded entry point.** When you refuse a state on one path, grep the bulk, AI-action and MCP routes to the same write in the same commit.
- **A deletion reverses only what the row contributed**: `deletionBalanceEffect` (`backend/src/common/deletion-balance.util.ts`), never a hand-rolled `-Number(row.amount)`.
- **A balance change is not finished until derived state is invalidated.** A helper returns the accounts it moved; the recompute is dispatched after the commit, never inside the transaction. INV-CACHE-001.
- **A change is a value difference, not a field being present.** Forms resend every field; compare against the row before repricing or re-resolving anything.
- **A share-count replay is written once**: `applyActionToQuantity` / `acquisitionCost` (`backend/src/securities/investment-replay.util.ts`).
- **A category's cost is its signed sum over rows of both signs**, netted within one category: `isNetSpending` / `NET_SPEND_AMOUNT` on the server, `netEntityTotal` on the client; never `totalIncome` or `totalExpenses` alone.
- **What a row is decides a report's filter, never its account type.** `investmentExclusionSql` / `applyInvestmentTransactionFilters` and `reportableTransactionAmountSql` (`backend/src/common/investment-filter.util.ts`). INV-REPORT-001.
- **Rows written in one transaction share `created_at`**, so a register order is `applyRegisterOrder` (`backend/src/transactions/register-order.ts`), never a hand-written `ORDER BY`.

## Follow the existing pattern, and pin it down when you miss it

Before writing a UI control, a data access path, or anything a user interacts with, find how the codebase already does it and do it the same way. This project has one way to make a table row clickable, one date input, one money formatter, one door to the database; the generic solution looks fine in isolation and wrong in place. Generic helpers live once per layer: `ls backend/src/common/helpers/` or `frontend/src/lib/helpers/` before writing one.

**When a human points out a defect in code an AI wrote, that is a missing rule, not just a bug.** Fix it, switch to the existing helper that should have been used, add a regression test that fails on the original mistake (a source-scanning guard where the mistake is mechanical), and write the rule down as one sentence in the right instruction file plus its full entry in `docs/`.

**Prefer the rule the machine can check.** Ranked by how well they hold: a type, a lint rule, a source-scanning test, a paragraph in an instruction file.

**A green suite after a behaviour change is a finding.** Either the change is a no-op or the suite had no case for it; say which, and add the case in the same commit.

**A list that means something is written once, in the place that can check it**: a SQL function the database evaluates, or one TypeScript constant checked against `database/schema.sql` in both directions. Two callers wanting slightly different answers derive one from the other.

**Bytes before the commit, deletes after it.** Object stores and filesystems do not roll back; order them so a failure leaves bytes nobody references, never a row promising bytes that are gone. Anything the server writes to disk goes through `shardedSegments` (`backend/src/common/shard-path.util.ts`), validated with `isShardableId` and asserted inside its base; sharding is storage distribution, never authorization. `docs/external-side-effects.md` and `docs/adr/0003-filesystem-objects-use-id-sharding.md`.

**A doc that names an identifier or a path is a claim about the source.** Renaming or deleting a field, helper or file means grepping `docs/` and every instruction file in the same commit; `backend/src/common/doc-paths.spec.ts` fails an unresolved path.

## The contract documents

Cross-layer rules live in `docs/`. `docs/system-invariants.md` is the index: every invariant with a stable ID, the mechanism that enforces it, and an honest status of `enforced`, `partial` or `unenforced` (an `unenforced` entry describes something the system currently gets wrong; editing the document does not close the gap). Name the IDs your change touches in the PR.

| Document | Covers |
|---|---|
| `docs/system-invariants.md` | The invariant catalog and its enforcement status. |
| `docs/concurrency-and-idempotency.md` | Which mechanism to use when (atomic delta, unique index, CAS, lock, advisory lock, idempotency key), lock ordering, retry semantics. |
| `docs/financial-semantics.md` | Signs, transfer legs, FX rate direction and precision, per-field precision, split sum rules, commission basis, scheduled occurrences, loan interest. |
| `docs/financial-calculation-contract.md`, `docs/time-series-contract.md` | Cost basis, valuation, missing data, rejection before write, testing requirements, series sampling. Read both before writing or changing any financial calculation. |
| `docs/external-side-effects.md` | Per-provider lifecycle for anything PostgreSQL cannot roll back: attachments, backups, email, providers, id-sharded files on disk. |
| `docs/verification-contract.md`, `docs/testing-contract.md` | Which test kind each invariant requires, which CI job owns it, the adversarial inputs that have broken this codebase before, how to run the suites so a green branch does not read as red. |
| `docs/release-integrity.md` | Zero discovered tests is a failure; the tested, imaged and tagged revisions are one revision. |
| `docs/adr/` | Why a decision was made, and what was rejected. Supersede, never rewrite. |

Any use of "atomic", "single-use", "exactly once", "retryable", "cannot", "always", "complete" or "transactional" must name the mechanism that makes it true: the transaction, the index, the conditional `UPDATE`, the verified checksum. If the mechanism cannot be named, the wording is wrong, not merely vague.

A financial feature of any substance starts from a short approved spec (invariants, truth tables, numerical examples, missing-data policy, test matrix) committed before the implementation it guides; `docs/specs/` holds them.

A change that spans more than one layer or more than one PR starts from a plan in `docs/future-plans/` (a `<feature>.md` beside a `<feature>-tasks.md` task list, the pattern the existing plans follow); the plan says what to edit, what to run and what should be observed, and restates its assumptions so a fresh session can execute it.

## Do not change these casually

Each needs its own agreement, not a drive-by edit:

- `database/migrations/*` already merged to `main` (the tracker keys on the filename), and `database/schema.sql` without a paired migration or vice versa.
- Guard baselines, allowlists and thresholds: `WITH_CONTEXT_ALLOWLIST` and `OAUTH_PAYLOAD_ALLOWLIST` in `backend/eslint.config.mjs`, `RLS_EXEMPT_TABLES`, the ceilings in `backend/src/common/instruction-files.spec.ts`, `frontend/src/store/persisted-storage.guard.test.ts`, coverage thresholds, the Bearer exceptions in `.github/workflows/ci.yml`.
- Generated pseudo-locales `frontend/src/i18n/messages/xx/*` and `backend/src/i18n/locales/xx/*`.
- `.github/workflows/*`, `helm/`, `docker-compose*.yml`, `.env.example` removals, any `package-lock.json` (only as the product of an agreed dependency change).
- `docs/release-notes/` and `docs/audits/` are shipped records; `docs/adr/` is superseded, never rewritten.

## Git and PR workflow

- Branch off `main`; never commit to `main`, never force-push a shared branch, rebase on the latest `main` before review.
- Commit subjects are imperative, no trailing period, Conventional Commits with a scope where one fits (`fix(transactions): ...`, `feat(push): ...`, `docs(backend): ...`, `test(i18n): ...`); one logical change per commit, with its regression test and its doc line. AI-assisted commits carry a `Co-Authored-By:` trailer.
- **Propose first** (`CONTRIBUTING.md`): open a Discussion, get the approach agreed, then implement exactly what was agreed, one concern per PR.
- The PR body is the template in `.github/pull_request_template.md` with every box ticked, a linked discussion or issue carrying the `approved-to-build` label, the invariant IDs touched, and the AI-assistance disclosure. `.github/workflows/pr-checklist.yml` fails a PR that misses any of the first three (maintainer-authored PRs bypass the label).

## Autonomous work

Do without asking: read and search anything; run lint, typecheck, unit tests, focused tests, formatters and the check scripts; create a feature branch; stage and commit on it; regenerate the pseudo-locale after editing `en/*`.

Ask first: any destructive git operation (force-push, `reset --hard`, deleting a branch, rebasing a pushed branch); deleting, skipping or quarantining a test; weakening a guard, allowlist, baseline or threshold; a schema or migration change beyond the agreed task; adding or upgrading a dependency; anything under `.github/`, `helm/` or the release path; opening a PR or pushing to a branch you did not create.

While working: change what was asked and the tests that prove it; report an unrelated defect instead of fixing it in passing. Run the focused test while developing and the gate once before pushing; do not re-run the same suite hoping for a different result. When a guard fails, stop and report what it names rather than routing around it. Keep output short: the diff and what you verified, not a transcript.

## Before you act, read

Each row is a precondition, not a reading list: when the left side describes your task, read the right side in full first.

| Before you | Read |
|---|---|
| write or change any backend query, service or entity | `backend/CLAUDE.md`, then the `docs/backend/*.md` rows its table names for the subject |
| write or change any component, hook, store or client helper | `frontend/CLAUDE.md`, then the `docs/frontend/*.md` rows its table names |
| add or change a migration or `database/schema.sql` | `database/CLAUDE.md` in full, and `docs/database-migrations.md` for the guard recipes |
| add or change a Playwright spec | `e2e/CLAUDE.md` |
| touch a balance, a holding, a transfer, a scheduled occurrence, a loan figure or any total | `docs/financial-semantics.md`, `docs/financial-calculation-contract.md`, `docs/time-series-contract.md`, and the `docs/system-invariants.md` entries you name in the PR |
| write anything to disk, an object store, email or a third-party provider | `docs/external-side-effects.md` |
| add a lock, a retry, an idempotency key or a cron | `docs/concurrency-and-idempotency.md`, `docs/cron-jobs.md` |
| write a test for an invariant, or a source-scanning guard | `docs/verification-contract.md`, `docs/testing-contract.md`, `docs/guard-tests.md` |
| change an MCP tool or the assistant's tools | `docs/backend/mcp.md`, `docs/backend/ai-and-payees.md` |
| open a PR or ask why something was decided | `CONTRIBUTING.md`, `docs/adr/` |
| change what a user can see or do | `website/README.md` "Documentation": the page and its screenshots change in the same PR |
