# Monize

Personal finance management app (Microsoft Money replacement). NestJS backend, Next.js frontend, PostgreSQL database, all running in Docker/Kubernetes

See `backend/CLAUDE.md`, `frontend/CLAUDE.md`, and `database/CLAUDE.md` for layer-specific details (commands, structure, conventions).

## Tech Stack

| Layer | Tech | Version |
|-------|------|---------|
| Backend | NestJS + TypeORM | 11.x, TS 6.0 |
| Frontend | Next.js (App Router) + React | 16.x, React 19 |
| Database | PostgreSQL | 16 |
| Styling | Tailwind CSS | 4.x |
| State | Zustand (frontend), class-validator DTOs (backend) |
| Forms | react-hook-form + Zod (frontend), class-validator (backend) |
| Auth | JWT + Passport + OIDC + TOTP 2FA |
| AI | Anthropic SDK, OpenAI SDK, Ollama (user-configurable) |
| i18n | next-intl (frontend), nestjs-i18n (backend) -- locales: `de`, `en`,`en-US`, `en-CA`, `en-GB`, `es`, `fr`, `hi`, `id`, `it`, `ja`, `ko`, `nl`, `pl`, `pt`, `pt-BR`, `ru`, `tr`, `uk`, `vi`, `zh-CN`, `zh-TW`, `xx` (pseudo) |
| Testing | Jest (backend), Vitest (frontend), Playwright (e2e) |

Everything runs in Docker: `docker compose -f docker-compose.dev.yml up`.

## Critical Rules

### Code Organization
- Many small files over few large files (200-400 lines typical, 800 max)
- Organize by feature/domain, not by type
- Always update `database/schema.sql` alongside any migration
- Always create tests for any new functionality added

### Shared AI tools (AI Assistant + MCP server)
- Every AI tool that reads or aggregates data must share its implementation between the AI Assistant (`backend/src/ai/query/tool-executor.service.ts`) and the MCP server (`backend/src/mcp/tools/*.tool.ts`).
- Put the shared logic on the relevant domain service (e.g., `PortfolioService.getLlmSummary`, `TransactionAnalyticsService.getTransfersByAccount`). The two tool layers become thin adapters that call it.
- Both surfaces must return the same data shape. The AI tool executor wraps it with `{ summary, sources }`; MCP just `toolResult(data)`s it.
- Adding a new AI tool means wiring it into both layers in the same PR -- never ship a tool to only one of the two.

### Internationalization (i18n)
Every user-facing string must be internationalized -- no hardcoded literals in toasts, labels, placeholders, validation messages, or emails. Develop **English-first**: while a change is under development and review, add and edit only the English catalogs and regenerate the pseudo-locale; defer translating the other locales until the code and its copy are functionally accepted. A feature is not *merged* until it is fully internationalized and translated for every supported locale, but that full translation is a single pass done at acceptance as the final commit on the same PR, not continuous work throughout development.
- **Frontend** (`next-intl`): read strings via `useTranslations('namespace')`; catalogs live in `frontend/src/i18n/messages/{locale}/{namespace}.json` (register new namespaces in `src/i18n/messages.ts`). Use `t.rich` for embedded markup and `t.raw` for template strings.
- **Backend** (`nestjs-i18n`): wrap exception messages in `tr(key, fallback, args)`; render emails with an `EmailT` translator (`emailTranslator(i18n, recipientLang)`) so copy matches the recipient's stored locale, not the request's. Catalogs live in `backend/src/i18n/locales/{locale}/*.json`.
- **Supported locales** are defined in `frontend/src/i18n/config.ts` and `backend/src/i18n/config.ts` -- keep the two lists in sync. Currently `de` (German), `en` (English -- Canadian-flavoured base), `en-US` (American English), `en-CA` (Canadian English), `en-GB` (British English), `es` (Spanish), `fr` (French), `hi` (Hindi), `id` (Indonesian), `it` (Italian), `ja` (Japanese), `ko` (Korean), `nl` (Dutch), `pl` (Polish), `pt` (Portuguese), `pt-BR` (Brazilian Portuguese), `ru` (Russian), `tr` (Turkish), `uk` (Ukrainian), `vi` (Vietnamese), `zh-CN` (Simplified Chinese), `zh-TW` (Traditional Chinese), and `xx` (dev-only pseudo-locale for QA). The `en-*` variants are lean regional variants (see their `base` in config): each ships only the strings that differ from `en` and inherits the rest per key -- `en-CA` ships no catalog folder at all, because `en` is already the Canadian-flavoured base, and that absence is intended rather than missing work.
- **During development, edit only the English catalogs (`en/*`)** -- do not hand-translate the other locales while the copy is still in flux. Once the change is functionally accepted, run one localization pass that fills every locale. Parity tests (`frontend/src/i18n/messages.parity.test.ts`, `backend/src/i18n/locales.parity.spec.ts`) fail when a locale is missing a key or references a placeholder `en` does not supply -- on a work-in-progress branch that failure is expected until the localization pass, and is not a reason to translate early. `main` still requires full parity, so released code is never partially translated.
- After editing any `en/*.json`, regenerate the pseudo-locale: `npm run i18n:pseudo` (CI enforces freshness via `npm run i18n:check`).
- The user's language lives in `user_preferences.language` and is chosen in Settings -> Preferences (`LanguageSelector`); unauthenticated screens offer `AuthLanguageSwitcher` (cookie-only) on login/register. See `frontend/src/i18n/messages/README.md` and `backend/src/i18n/README.md` for the full contributor flow.

### Code Style
- No emojis in code, comments, or documentation
- Immutability always -- never mutate objects or arrays
- No `console.log` in production code; use NestJS `Logger` class -- including the scripts that run before the app boots and the `docker-entrypoint.sh` steps, so the whole startup log has one shape (backend `no-console` lint rule + `backend/src/startup-logging.spec.ts`)
- Use proxy, not middleware (middleware is deprecated in this project)

### Follow the existing pattern, and pin it down when you miss it

Before writing a UI control, a data access path, or anything a user interacts with, find how the codebase already does that thing and do it the same way. This project has one way to make a table row clickable, one date input, one money formatter, one door to the database. Reaching for the generic solution -- a raw `<input type="date">`, a hand-rolled dropdown, a fresh `overflow-y-auto` -- when one already exists produces code that looks fine in isolation and wrong in place.

**When a human points out a defect in code an AI wrote, that is a missing rule, not just a bug.** Fixing it is half the work. Also:

1. Find how the codebase already solves that problem, and switch to it -- there is usually an existing helper or hook, and not using it was the actual mistake.
2. Add a regression test that fails on the original mistake, not merely one that covers the fix. Where the mistake is mechanical (a raw element instead of the shared component), prefer a guard test that scans the source and fails for *any* occurrence, so the next instance is caught wherever it appears -- `frontend/src/test/ui-conventions.test.ts` and `frontend/src/lib/tours/anchors.uniqueness.test.ts` are the pattern.
3. Write the rule down here or in the layer's `CLAUDE.md`, in one or two sentences, naming the thing to use and the thing not to.

The point is that the next agent inherits the correction. A fix that lives only in one file will be re-broken in the next one.

**Prefer the rule the machine can check.** A rule in prose gets read, agreed with, and violated anyway; the financial contracts in `docs/` have been all three more than once. Ranked by how well they hold: a type the compiler enforces, a lint rule, a test that scans the source, a paragraph in a `CLAUDE.md`. Reach for the highest one the mistake allows, and use prose for the part that genuinely needs judgement rather than as the first resort.

**A green suite after a behaviour change is a finding.** If you changed what the code produces and nothing failed, either the change is a no-op or the suite had no case for it. Say which, in the change description, and if it is the second, add the case in the same commit. `docs/financial-calculation-contract.md` section 8.1 has the long form; it applies everywhere, not only to money.

**Asynchronous data belongs to the request that produced it.** A payload without its request key cannot be told apart from the previous payload, so every action offered beside it may be aimed at the wrong thing. Keep the pair together, adopt a mutation's response only when its captured origin still matches the current selection, and never treat a failed lookup as an empty result. `frontend/CLAUDE.md` has the full rule and the regression matrix.

**`.dockerignore` is not `.gitignore`: a filename glob needs an explicit `**/`.** A pattern with no slash is matched against the path relative to the build context and nothing else, so `*.spec.ts` excludes a spec beside the Dockerfile and none under `src/`. Git would have walked it down the tree; Docker does not, and nothing says so until something reads the files that were supposed to be gone -- `src/test/` (a directory path, so it matched) was excluded while every test importing `@/test/render` was copied in, and `next build` type-checks those as of 16.3. Give every filename glob a leading globstar, including its negation (`!**/.env.example`); `frontend/src/test/dockerignore.test.ts` scans all three files and fails on a bare one.

**A doc that names an identifier is making a claim about the source.** Renaming or deleting a field, flag or helper means grepping `docs/` and every `CLAUDE.md` in the same commit. A document describing a model that no longer exists is worse than none: it gets read, believed, and built on. The same goes for a comment asserting that *every* call site does something -- that is a scanning test, not a comment.

### The contract documents

Cross-layer rules live in `docs/`, not in this file, because they are too long to state twice and too easily violated to state loosely. `docs/system-invariants.md` is the index: it lists every invariant with a stable ID, the mechanism that enforces it, and an honest status of `enforced`, `partial` or `unenforced`. An entry marked `unenforced` describes something the system currently gets wrong, with the violation cited -- that gap is the point, and editing the document does not close it.

| Document | Covers |
|---|---|
| `docs/system-invariants.md` | The invariant catalog and its enforcement status. Name the IDs your change touches. |
| `docs/concurrency-and-idempotency.md` | Which mechanism to use when (atomic delta, unique index, CAS, lock, advisory lock, idempotency key), lock ordering, retry semantics, and the register of values with more than one protocol. |
| `docs/financial-semantics.md` | Signs, transfer legs, FX rate direction and precision, per-field precision, split sum rules, commission basis, split ratios. |
| `docs/external-side-effects.md` | Per-provider lifecycle for anything PostgreSQL cannot roll back: attachments, backups, email, providers. |
| `docs/verification-contract.md` | Which test kind each invariant requires, which CI job owns it, and the known-wrong tests that currently assert defects. |
| `docs/release-integrity.md` | Zero-discovered-tests is a failure; the tested, imaged and tagged revisions must be one revision. |
| `docs/adr/` | Why a decision was made, and what was rejected. Supersede, never rewrite. |

Two of these say something about a guarantee's wording that applies everywhere: any use of "atomic", "single-use", "exactly once", "retryable", "cannot", "always", "complete" or "transactional" must name the mechanism that makes it true -- the transaction, the index, the conditional `UPDATE`, the verified checksum. Three comments in this codebase claimed a lock, an atomic increment and a joint commit that the code beside them did not implement, and each was believed for as long as it existed. If the mechanism cannot be named, the wording is wrong, not merely vague.

### Running the suites locally -- two ways a green branch reads as red

CI runs in UTC with one Playwright worker. A local run does neither, and both differences produce failures that look like regressions and are not.

- **`TZ=UTC` for the unit suites.** A handful of tests read `new Date()` and count completed periods against fixtures; under any other offset they can land on the wrong side of a boundary. `backend/src/ai/insights/insights-aggregator.service.spec.ts` and `backend/src/net-worth/net-worth.service.spec.ts` are the ones that bite. `TZ=UTC npm run test:unit` matches CI; without it, believing the failures means chasing a bug that does not exist.
- **`--workers=1` for the whole E2E suite.** `playwright.config.ts` sets one worker only when `CI` is set, so a local `npx playwright test` runs several in parallel -- and `e2e/tests/zz-danger-zone.spec.ts` deletes the shared account. The `zz-` prefix orders it last, which only means anything when the run is serial; in parallel it takes out whatever is still running. A single spec file is safe to run without the flag.

Also: `scripts/verify-schema.sh` reproduces the "Schema vs Migrations Drift" job locally and needs nothing but Docker. Every migration has to be a no-op replayed on top of `schema.sql` (`CREATE ... IF NOT EXISTS`, `DROP ... IF EXISTS` before `CREATE POLICY`/`TRIGGER`), because that is also how the app boots: `db-init` applies `schema.sql` and `db-migrate` then replays the whole directory. A migration missing its guard does not just fail the drift check -- it aborts container start-up, and the E2E and Lighthouse jobs then report only "backend exited (1)".

### Code Intelligence
Prefer LSP over Grep/Read for code navigation — it's faster, precise, and avoids reading entire files:
- `workspaceSymbol` to find where something is defined
- `findReferences` to see all usages across the codebase
- `goToDefinition` / `goToImplementation` to jump to source
- `hover` for type info without reading the file

Use Grep only when LSP isn't available or for text/pattern searches (comments, strings, config).

After writing or editing code, check LSP diagnostics and fix errors before proceeding.

### Files on disk are sharded by an id, and which id differs

Anything the server writes to disk goes through `shardedSegments` in
`backend/src/common/shard-path.util.ts`, which returns `[ab, cd, id]` -- two
levels of two hex characters, then the id. That keeps any one directory small
enough for filesystems that scan linearly or over a network. Do not hand-roll a
second sharding scheme.

**The scheme is shared; the shard key and the shape are not.** Automatic backups
shard by *user* id and the last segment is a directory
(`<base>/<ab>/<cd>/<userId>/monize-backup-daily-2026-08-03.json.gz`), because the
filename carries only a tier and a date -- a flat folder gave every user the same
name for the same day, whoever's cron ran last overwrote the rest, and one user's
retention pass deleted another's files. Local attachments shard by *attachment*
id and the last segment is the file itself (`<base>/<ab>/<cd>/<attachmentId>`),
because that id is already globally unique.

So a backup's owner is recoverable from its path and **an attachment's owner is
not** -- no user id appears in an attachment path. Attachment ownership is
database-authoritative via its metadata row, and no cleanup, retention or
migration tool may infer it from the filesystem. Sharding is storage
distribution, never tenant isolation or authorization. `docs/adr/0003` has the
reasoning and the rejected alternatives.

A path built from an id must still be validated (`isShardableId`) and asserted
to resolve inside its base before it reaches the filesystem, even when the id is
server-generated (CWE-22).

### Security (Do Not Regress)
- Parameterized queries only (TypeORM QueryBuilder or parameterized raw SQL). Never interpolate user input into SQL strings
- All controllers use `@UseGuards(AuthGuard('jwt'))` at class level (except health + auth)
- All service methods derive `userId` from JWT (`req.user.id`), never from request params/body
- All path `:id` params use `ParseUUIDPipe`
- DTOs use `whitelist: true` + `forbidNonWhitelisted: true`, with `@MaxLength` on strings, `@Min`/`@Max` on numbers, `@IsUUID` on ID references, `@SanitizeHtml()` on user-facing text fields
- All user-controlled values in HTML email templates must use `escapeHtml()`
- API keys encrypted with AES-256-GCM before storage, never returned to client
- CSRF double-submit cookie pattern is global; use `@SkipCsrf()` only for non-cookie auth (e.g., PAT bearer)

## Transactions (CRITICAL)

Any operation that touches multiple tables or does read-modify-write MUST run in a single transaction. This is the most common source of bugs in this codebase.

**A rejected command must not already have written.** Every check that can refuse a request -- ownership, tenant or scenario identity, revision, precondition -- runs inside the same transaction as the mutation, and under the same lock where concurrency matters. A `403`, `404`, `409` or validation failure claims the change did not happen, and an HTTP status cannot undo a committed row: validating after a service has saved and committed leaves the client with an error on screen and the write in the database. Pass the caller's expectation down into the operation so it can refuse, rather than letting a higher layer reject something already done. `docs/financial-calculation-contract.md` section 7 has the rule, the forbidden sequence and the test obligation.

```typescript
async createSomething(userId: string, dto: CreateDto) {
  return withScopedDb(this.dataSource, async (manager) => {
    // All DB operations use the transaction's EntityManager
    const entity = manager.create(Entity, { ...dto, userId });
    await manager.save(entity);
    await this.updateBalance(accountId, amount, manager);
    return entity;
  });
}
```

`withScopedDb` commits when the callback returns and rolls back when it throws, so there is no
commit/rollback/release bookkeeping to get wrong. **There are no `QueryRunner`s left in `src/`** —
RLS tasks R1–R7 converted every one, and lint now bans the pattern outright (L1). Helpers take an `EntityManager`,
never a `QueryRunner`. If you find a `createQueryRunner()` in a diff, it is new and wrong.

An operation that uses `INSERT ... ON CONFLICT DO NOTHING` and then returns a read model must follow a conflict
with a fresh read of the authoritative state, inside the same transaction. Never build the response from a snapshot
loaded before the insert attempt -- the request that lost the race would return data missing the rows the winner
just inserted.

## Database Access & Row-Level Security (RLS lint bans — CRITICAL)

**All** database access goes through `withScopedDb` (`backend/src/common/db/scoped-db.ts`) — the single RLS-compliant door to the DB. **Never add an `@InjectRepository(...)` field, a `this.dataSource.createQueryRunner()` call, a `this.dataSource.transaction(...)` call, or a bare `this.dataSource.query(...)`.** ESLint bans the first three outright (RLS task L1, `backend/eslint.config.mjs`): importing `InjectRepository`, or calling `.createQueryRunner()` or `.transaction()`, anywhere in `src/` (outside `scoped-db.ts`, specs and test helpers) fails "Backend Lint & Type Check". `DataSource.transaction()` is banned for a reason the `createQueryRunner` ban did not cover: it opens a transaction that does not know about the ambient scoped manager, so it carries no identity GUCs under enforcement and, nested inside a caller's `withScopedDb`, commits independently of that caller's rollback. The same config restricts importing `common/db/with-context` to an explicit `WITH_CONTEXT_ALLOWLIST` — a new `withSystemContext`/`withUserContext` call site means adding the file to that allowlist in the same PR, as a reviewed decision. (R1–R7 converted the ~91 original sites; the old counting ratchet is gone.)

```typescript
// Read: one short tenant transaction, identical to today's autocommit read.
const prefs = await withScopedDb(this.dataSource, (m) =>
  m.getRepository(UserPreference).findOne({ where: { userId } }),
);

// Read-modify-write / multi-table: one withScopedDb replaces the QueryRunner block.
await withScopedDb(this.dataSource, async (m) => {
  const repo = m.getRepository(UserPreference);
  const row = await repo.findOne({ where: { userId } });
  // ...mutate + repo.save(row); all queries share the transaction + tenant GUC.
});
```

- Inject `DataSource`, not a repository. Get repositories from the transaction's `EntityManager` (`m.getRepository(X)`); helpers take the `EntityManager`, never a `QueryRunner`.
- `withScopedDb` **throws** without an ambient identity context. Authenticated cookie/JWT routes already have it (the `RequestContextInterceptor` seeds `{ userId }` around the handler). **Everything else must seed its own** (`backend/src/common/db/with-context.ts`):
  - `withUserContext(userId, fn)` — cron per-user bodies, background writes, and any surface the interceptor cannot see. **Bearer-only routes count**: `/mcp` has no `AuthGuard('jwt')`, so `req.user` is unset and the interceptor's scope carries an undefined userId — the MCP transport seeds the session's user itself.
  - `withSystemContext(fn)` — genuinely cross-user work: cron fan-outs, seeders, bootstrap hooks (`onModuleInit` / `onApplicationBootstrap` have no request), admin, and anything that sweeps every user.
  - `withDelegateContext(ownerUserId, delegateUserId, fn)` — a delegate acting on an owner's data, where the two GUCs must **differ**. `withUserContext` collapses them onto one id, which silently returns zero rows for whichever half it is not. Used by `jwt.strategy`'s acting-context re-validation and `AccountDelegateGuard`.
  - `withPreserveTimestamps(fn)` — extends the ambient context (identity inherited, never granted) so every transaction inside emits `app.preserve_timestamps` and the GUC-aware `updated_at` trigger keeps supplied values instead of stamping. Backup restore is the only caller; it replaced the restore's old `DISABLE TRIGGER` DDL, and trigger DDL must never come back (a source-scan guard in `backup.service.spec.ts` enforces this).
- Nested `withScopedDb` calls join the ambient transaction (same connection/atomicity), so a service method calling another is safe — no pool-exhaustion deadlock. The exceptions are deliberate: `runOutsideActiveScopedManager` for a background timer or a progress write a concurrent reader must see.
- A callback that returns early (before writing) commits an empty transaction — that is the correct replacement for an explicit rollback, not a bug.
- Pass an isolation level as the optional third argument only when the logic depends on it (registration uses `"SERIALIZABLE"` for the first-user-admin race). Requesting one while joining an ambient transaction throws rather than silently downgrading.
- At `RLS_MODE=off` (the default) `withScopedDb` still wraps the transaction but skips the identity GUCs, so behavior is identical to pre-RLS. See `docs/future-plans/row-level-security.md`.

## Financial Math

All money values are stored as `decimal(20,4)` in PostgreSQL. In JavaScript, always round to avoid floating-point drift:

```typescript
// WRONG: floating-point accumulation
const total = items.reduce((sum, item) => sum + item.amount, 0);

// RIGHT: integer arithmetic
const totalCents = items.reduce(
  (sum, item) => sum + Math.round(Number(item.amount) * 10000), 0
);
const total = totalCents / 10000;

// For simple rounding
const rounded = Math.round(value * 10000) / 10000;
```

Balance updates use atomic SQL: `UPDATE accounts SET current_balance = current_balance + $1 WHERE id = $2`.

### An exchange rate is not money -- never round one to 4dp

Money is `decimal(20,4)`; an exchange rate is `NUMERIC(20,10)` (`exchange_rates.rate` and every `exchange_rate` column that mirrors it). Reaching for `roundMoney` on a rate looks harmless and is not: `roundMoney(1 / 1.3652)` stored `0.7325`, which inverts back to `1.3661` -- and a bank quoting USD/CAD to six decimals reconciles cents off on a four-figure amount. Round rates with `roundFxRate` (`backend/src/common/fx-entry.util.ts`, 10dp) and display them at `FX_RATE_DISPLAY_DECIMALS` (`frontend/src/lib/format.ts`, 6dp) -- never `toFixed(4)`.

Convert with `applyFxConversion` (backend) so the account's `fxFeePercent` is folded in the same way the transaction form does; validate a foreign-currency payload with `normalizeFxEntry`, which transactions and scheduled transactions share so both accept and reject exactly the same shapes.

### Missing data: a subtotal is not a total (CRITICAL)

A field named `total*`, `portfolioValue`, `transferValue`, `gain`, `tax`, or `estimated*` may only carry a value when **every** component of the calculation is known. Filtering out `null` components and summing the rest produces a subtotal, not a total -- if any component is unknown, the total is `null`, and the partial sum, if returned at all, goes in a separate explicitly named field (`knownMarketValueSubtotal`), never in the total's field. Never default an unknown price, cost basis, or rate to `0` (or an exchange rate to `1`) to keep a formula running, and never treat a missing period price as a 0% return.

**`null` is not the safe answer either.** It means "not known", so a state that *is* known must not use it: empty accounts hold zero, move zero, realize zero and owe zero, and reporting those as unknown tells the user a settled question could not be worked out -- while making "nothing to do" indistinguishable from "cannot compute". Decide which of the two each branch is in before writing it.

The full rules -- cost basis and tax truth table, cash, valuation, materialized-result versioning, stale quotes, backtests over incomplete history, and the required adversarial test matrix -- live in `docs/financial-calculation-contract.md` and `docs/time-series-contract.md`. Read both **before** writing or changing any financial calculation, not when a review asks about them: every rule those documents contain has been read, agreed with and broken anyway by someone who reached them afterwards. `docs/testing-contract.md` lists the adversarial inputs that have broken this codebase before -- dates, money precision, aggregation, currency conversion, ownership, concurrency -- so a test author picks from a list rather than recalling edge cases; it is explicitly not a requirement that every test use every value. A financial feature of any substance -- it computes money, materializes a derived result, or reads a time series -- starts from a short approved spec (invariants, truth tables, numerical examples, missing-data policy, test matrix), committed *before* the implementation it guides.

## Environment

Key env vars (see `.env.example` for full list):
- `JWT_SECRET` -- minimum 32 chars, enforced at startup
- `AI_ENCRYPTION_KEY` -- minimum 32 chars, for API key encryption
- `DATABASE_*` -- PostgreSQL connection
- `DEMO_MODE=true` -- enables demo restrictions, daily reset at 4 AM UTC
- `LOCAL_AUTH_ENABLED` / `REGISTRATION_ENABLED` -- auth toggles
- `OIDC_*` -- OpenID Connect provider config
