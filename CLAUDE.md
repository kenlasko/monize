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
Every AI tool that reads or aggregates data shares one implementation between the AI Assistant (`backend/src/ai/query/tool-executor.service.ts`) and the MCP server (`backend/src/mcp/tools/*.tool.ts`). Put the shared logic on the relevant domain service (e.g. `PortfolioService.getLlmSummary`, `TransactionAnalyticsService.getTransfersByAccount`); the two tool layers are thin adapters returning the same data shape (the AI executor wraps `{ summary, sources }`; MCP just `toolResult(data)`s it). Adding a tool means wiring both layers in the same PR -- never ship to only one.

### Internationalization (i18n)
Every user-facing string must be internationalized -- no hardcoded literals in toasts, labels, placeholders, validation messages, or emails. Develop **English-first**: while a change is under development, edit only the English catalogs and regenerate the pseudo-locale; translate every other locale in a single pass at acceptance, as the final commit on the same PR. `main` requires full parity; a WIP branch failing parity is expected and not a reason to translate early.
- **Frontend** (`next-intl`): `useTranslations('namespace')`; catalogs in `frontend/src/i18n/messages/{locale}/{namespace}.json` (register new namespaces in `src/i18n/messages.ts`). `t.rich` for embedded markup, `t.raw` for template strings.
- **Backend** (`nestjs-i18n`): wrap exception messages in `tr(key, fallback, args)`; render anything addressed to a person and composed outside a request -- emails, and a Web Push body -- with an `EmailT` translator (`emailTranslator(i18n, recipientLang)`) so copy matches the recipient's stored locale. Catalogs in `backend/src/i18n/locales/{locale}/*.json`.
- **Supported locales** are defined in `frontend/src/i18n/config.ts` and `backend/src/i18n/config.ts` -- keep the two lists in sync. The `en-*` variants are lean regional variants (see their `base` in config): each ships only the strings that differ from `en` and inherits the rest per key. `en-CA` ships no catalog folder at all -- `en` is already the Canadian-flavoured base -- and that absence is intended.
- Parity tests (`frontend/src/i18n/messages.parity.test.ts`, `backend/src/i18n/locales.parity.spec.ts`) fail when a locale is missing a key or references a placeholder `en` does not supply.
- After editing any `en/*.json`, regenerate the pseudo-locale: `npm run i18n:pseudo` (CI enforces freshness via `npm run i18n:check`) -- never hand-edit `xx/*`.
- **Grep for a key before adding it.** `JSON.parse` keeps the *last* duplicate, so a key added to a catalog that already has it loads, passes parity and `i18n:check`, and silently ships the wrong copy. Textual auto-merges (both branches appending to the same object) are how it happens. `frontend/src/i18n/messages.duplicate-keys.test.ts` scans the raw bytes of every catalog.
- **A number is localized too, and by its own preference.** `user_preferences.numberFormat` decides separators, grouping and currency placement, and it is independent of `language` -- an explicit `numberFormat` wins, `"browser"` falls back to the UI language. Every figure addressed to a person goes through that resolution: `useNumberFormat()` on the client (`frontend/CLAUDE.md` has the four banned fingerprints and the guard), `backend/src/common/number-locale.util.ts` on the server, where `"browser"` cannot be resolved and lands on `DEFAULT_LOCALE`. `backend/src/common/format-currency.util.ts`'s `en-US` helpers stay for output read by a MACHINE -- an LLM prompt, and the English `description`/`message` fallback stored on a row whose UI composes its own copy from the structured `data` -- and `number-locale.guard.spec.ts` holds that classification, caller by caller, with the reason each is exempt. A pre-formatted money string in a notification's params is neither: send `amountValue` + `amountCurrency` beside the English `amount` so the reader's client formats it.
- The user's language lives in `user_preferences.language` (Settings -> Preferences, `LanguageSelector`); unauthenticated screens offer `AuthLanguageSwitcher` (cookie-only). Full contributor flow: `frontend/src/i18n/messages/README.md` and `backend/src/i18n/README.md`.

### Code Style
- No emojis in code, comments, or documentation
- Immutability always -- never mutate objects or arrays
- No `console.log` in production code; use NestJS `Logger` class -- including pre-boot scripts and the `docker-entrypoint.sh` steps, so the whole startup log has one shape (backend `no-console` lint rule + `backend/src/startup-logging.spec.ts`)
- Use proxy, not middleware (middleware is deprecated in this project)

### Follow the existing pattern, and pin it down when you miss it

Before writing a UI control, a data access path, or anything a user interacts with, find how the codebase already does that thing and do it the same way. This project has one way to make a table row clickable, one date input, one money formatter, one door to the database. The generic solution (a raw `<input type="date">`, a hand-rolled dropdown) looks fine in isolation and wrong in place.

**When a human points out a defect in code an AI wrote, that is a missing rule, not just a bug.** Fixing it is half the work. Also:

1. Find how the codebase already solves that problem and switch to it -- there is usually an existing helper or hook, and not using it was the actual mistake.
2. Add a regression test that fails on the original mistake, not merely one that covers the fix. Where the mistake is mechanical, prefer a guard test that scans the source and fails for *any* occurrence -- `frontend/src/test/ui-conventions.test.ts` and `frontend/src/lib/tours/anchors.uniqueness.test.ts` are the pattern.
3. Write the rule down here or in the layer's `CLAUDE.md`, in one or two sentences, naming the thing to use and the thing not to.

**Prefer the rule the machine can check.** Ranked by how well they hold: a type the compiler enforces, a lint rule, a test that scans the source, a paragraph in a `CLAUDE.md`. A rule in prose gets read, agreed with, and violated anyway; reach for the highest form the mistake allows.

**A source scan reads code, so strip the comments before matching.** A guard that bans a pattern is documented by prose that has to *name* that pattern, so scanning raw text makes the explanation fail the guard -- and the cheap way out is weakening the comment, which is the opposite of the point. `frontend/src/lib/loan-history.guard.test.ts` blanks comments while preserving line numbers (so the offender report still points at the right line) and tests the stripper in both directions: a scan that prose can trip is also a scan that prose can satisfy.

**A green suite after a behaviour change is a finding.** Either the change is a no-op or the suite had no case for it. Say which in the change description, and if it is the second, add the case in the same commit. `docs/financial-calculation-contract.md` section 8.1 has the long form; it applies everywhere, not only to money.

**Asynchronous data belongs to the request that produced it.** Keep the payload and its request key together, adopt a mutation's response only when its captured origin still matches the current selection, and never treat a failed lookup as an empty result. `frontend/CLAUDE.md` has the full rule and the regression matrix.

**A behavior promised "when a filter is active" keys off the filter itself, carried explicitly on the command -- never off a transport detail that sometimes coincides with it.** Bulk update keyed its split-line restriction off `mode === "filter"`, but hand-picked rows ship as mode `ids`, so the filter silently stopped applying. The client sends the active filter as its own field in both modes (`BulkUpdateDto.categoryFilterIds`) and the server restricts on that; regression tests assert the ids-mode payload carries it and honors it.

**`.dockerignore` is not `.gitignore`: a filename glob needs an explicit `**/`.** A slashless pattern matches only against the path relative to the build context, so `*.spec.ts` excludes nothing under `src/`. Give every filename glob a leading globstar, including its negation (`!**/.env.example`); `frontend/src/test/dockerignore.test.ts` scans all three files and fails on a bare one.

**A list of columns that means something is written once, in the place that can check it.** The columns referencing `currencies(code)` were spelled out in four places and wrong in all four. Prefer a SQL function the database evaluates (`currency_code_in_use_globally`, `currency_codes_referenced_by_user_data`, and `currency_codes_referenced_by_user` derived from the last) so the answer cannot be a tenant's view of a global question; when a caller genuinely cannot ask the database, keep one TypeScript constant checked against `database/schema.sql` in both directions. **Two callers wanting slightly different answers is not a licence to write the list twice** -- derive one from the other and let the guard test check the derivation. `backend/src/currencies/currency-references.spec.ts` is the pattern; the same applies to the restore's insertion order and deferred foreign keys (declared as data in `restore-plan.ts`, proven against the schema by `restore-plan.spec.ts`).

**Where an external side effect sits relative to the commit is a decision, and only one side of it is survivable.** Object stores, filesystems and buckets do not roll back. Order them so a failure leaves *bytes nobody references* (a storage cost), never *a row promising bytes that are gone*: write bytes before the commit and clean up on failure; delete bytes after it. The `database` provider is the exception both ways -- its `save`/`delete` are nested `withScopedDb` calls that genuinely join the transaction -- so the rule is provider-aware, not global.

**A lenient decoder is not a validator.** `Buffer.from(value, "base64")` silently discards characters outside the alphabet instead of failing -- on `x-export-password` that encrypts a backup under a password nobody knows and reports success. Anywhere a decode result is used as a credential or a key, assert the round trip.

**A driver value is not a JSON value.** `pg` returns `bytea` as a `Buffer` and DATE/TIMESTAMP as `Date`; `JSON.stringify` mangles a Buffer into `{"type":"Buffer","data":[...]}`. The backup export reads every bytea column through `encode(col, 'base64')`, and `backend/src/backup/export-driver-values.spec.ts` fails if a new one is added without it. Same family as the raw-select rule in `backend/CLAUDE.md`.

**A column list in the export is a claim that it is the whole table.** A table whose export names its columns (because one of them is `bytea`, so `SELECT *` cannot be used) stops describing the table the moment a migration adds a column: the backup omits it, and a restore -- which deletes the user's rows and reinserts from the archive -- writes NULL over it, reporting success. `payees.address`/`email`/`phone` shipped that way. `backend/src/backup/export-driver-values.spec.ts` now checks every explicit list against `database/schema.sql` as well as the bytea encoding; a column that genuinely must not be exported belongs there with its reason.

**A mocked filesystem cannot demonstrate a filesystem property.** `rename` being called is not the claim; what the directory looks like after an unfinished write is. For anything about atomicity, containment, symlinks or ownership, use a real temporary directory (`mkdtemp`) -- `backend/src/backup/atomic-file.spec.ts` and `auto-backup.service.spec.ts` are the pattern. Skip a permission case under uid 0 rather than weakening it into an assertion that passes for the wrong reason.

**A count of things you did not do never goes in the total of things you did.** `restored` is summed by the client, so deliberately skipped attachments are a sibling field (`skippedAttachments`, omitted when zero) -- "a subtotal is not a total", applied to counts. And the user has to be *told*: a success dialogue silent about files that did not come back is worse than the number being in the wrong place.

**Code and schema ship in one image; they do not arrive in one process.** `db-migrate` runs at container start and the server after it, so "this build calls a SQL function" and "this database has it" are separate facts; the gap surfaces as `function ... does not exist` behind a generic 500. Every SQL function `src/` calls is declared once in `backend/src/common/db/required-db-functions.ts` with the migration that creates it, and both `main.ts` and `db-migrate` refuse to serve a database missing one. `required-db-functions.spec.ts` holds the list in both directions -- crucially, a function defined in `schema.sql` and mentioned anywhere in `src/` must be registered.

**A doc that names an identifier is making a claim about the source.** Renaming or deleting a field, flag or helper means grepping `docs/` and every `CLAUDE.md` in the same commit. A comment asserting that *every* call site does something is a scanning test, not a comment. For named *files* the machine checks: `backend/src/common/doc-paths.spec.ts` fails when a path (bare filenames included) in any `CLAUDE.md` or top-level `docs/*.md` does not resolve. `docs/future-plans/` may name files that do not exist yet, but an unresolved path whose basename exists elsewhere is a moved file and fails. `docs/release-notes/` and `docs/audits/` are shipped records, out of scope. A path in another branch or repository is qualified (`branch:path/to/file.md`); a doc arguing a file is *missing* names it in plain prose, since a backticked span means "this file is here".

### The contract documents

Cross-layer rules live in `docs/`. `docs/system-invariants.md` is the index: every invariant with a stable ID, the mechanism that enforces it, and an honest status of `enforced`, `partial` or `unenforced` (an `unenforced` entry describes something the system currently gets wrong -- editing the document does not close the gap).

| Document | Covers |
|---|---|
| `docs/system-invariants.md` | The invariant catalog and its enforcement status. Name the IDs your change touches. |
| `docs/concurrency-and-idempotency.md` | Which mechanism to use when (atomic delta, unique index, CAS, lock, advisory lock, idempotency key), lock ordering, retry semantics, and the register of values with more than one protocol. |
| `docs/financial-semantics.md` | Signs, transfer legs, FX rate direction and precision, per-field precision, split sum rules, commission basis, split ratios. |
| `docs/external-side-effects.md` | Per-provider lifecycle for anything PostgreSQL cannot roll back: attachments, backups, email, providers. |
| `docs/verification-contract.md` | Which test kind each invariant requires, which CI job owns it, and the known-wrong tests that currently assert defects. |
| `docs/release-integrity.md` | Zero-discovered-tests is a failure; the tested, imaged and tagged revisions must be one revision. |
| `docs/adr/` | Why a decision was made, and what was rejected. Supersede, never rewrite. |

Any use of "atomic", "single-use", "exactly once", "retryable", "cannot", "always", "complete" or "transactional" must name the mechanism that makes it true -- the transaction, the index, the conditional `UPDATE`, the verified checksum. If the mechanism cannot be named, the wording is wrong, not merely vague.

### Running the suites locally

CI runs in UTC with one Playwright worker; a local run does neither, and both differences produce failures that look like regressions and are not.

- **`TZ=UTC npm run test:unit`** matches CI. A few tests count periods against `new Date()` and land on the wrong side of a boundary under other offsets (`backend/src/ai/insights/insights-aggregator.service.spec.ts`, `backend/src/net-worth/net-worth.service.spec.ts`).
- **The backend's database-backed suites never run in parallel with anything, including each other.** `backend/test/integration/*` rebuilds the schema of one shared `monize_test` (`synchronize` + `dropSchema`), so a second Jest worker pulls the tables out from under a running suite. The parallel config (`backend/package.json`) is pinned to `roots: ["<rootDir>/src"]`, `test/jest-e2e.json` pins `maxWorkers: 1`, and `npm test` runs `test:unit` then `test:integration` -- so the default command covers both and needs a reachable PostgreSQL; `npm run test:unit` is the offline path, and a filtered run goes through one of those two, since `npm test` itself takes no arguments. `backend/src/common/jest-config.guard.spec.ts` fails if a spec under `test/` becomes reachable from the parallel config again. Serialization stays until each worker owns its own database or schema -- nothing short of that makes `dropSchema` suites safe to run beside each other.
- **`--workers=1` for the whole E2E suite.** `playwright.config.ts` sets one worker only when `CI` is set, and `e2e/tests/zz-danger-zone.spec.ts` deletes the shared account -- its `zz-` ordering only means anything serially. A single spec file is safe without the flag.
- **A test that reads the wall clock is a test about today's date** -- `TZ=UTC` pins the offset, not the day (auto-backup promotes artifacts on specific days of the month, so ten assertions failed on `main` with nothing changed). Pin the clock in the spec and derive the pinned value from the constants the behaviour branches on (`WEEKLY_DAYS`, `MONTHLY_DAY` are exported for this). `backend/src/backup/auto-backup.service.spec.ts` is the pattern: fake `Date` only (faking `nextTick`/`queueMicrotask` under real `fs.promises` deadlocks), install fake timers once, move the date through a single `withClockAt` helper, and let a source scan fail a second installation.
- **A guard that walks the tree with `gitListFiles` cannot see an untracked file.** `doc-paths.spec.ts`, `source-comment-paths.spec.ts` and `jest-config.guard.spec.ts` list their subjects with `git ls-files` (`backend/src/common/repo-tree.util.ts`), so a brand-new file is invisible to them until staged. Green before `git add` and red in CI on the same content is not a flake -- run those guards after staging (`git add -N` is enough).
- `scripts/verify-schema.sh` reproduces the "Schema vs Migrations Drift" job locally (needs only Docker). Every migration must replay as a no-op on top of `schema.sql` (`CREATE ... IF NOT EXISTS`, `DROP ... IF EXISTS` before `CREATE POLICY`/`TRIGGER`) because that is how the app boots; a migration missing its guard also aborts container start-up, and the E2E and Lighthouse jobs then report only "backend exited (1)".

### Code Intelligence
Prefer LSP over Grep/Read for code navigation — it's faster, precise, and avoids reading entire files:
- `workspaceSymbol` to find where something is defined
- `findReferences` to see all usages across the codebase
- `goToDefinition` / `goToImplementation` to jump to source
- `hover` for type info without reading the file

Use Grep only when LSP isn't available or for text/pattern searches (comments, strings, config).

After writing or editing code, check LSP diagnostics and fix errors before proceeding.

### Files on disk are sharded by an id, and which id differs

Anything the server writes to disk goes through `shardedSegments` in `backend/src/common/shard-path.util.ts`: `[ab, cd, id]` -- two levels of two hex characters, then the id. Do not hand-roll a second sharding scheme.

**The scheme is shared; the shard key and the shape are not.** Automatic backups shard by *user* id with the id as a directory (`<base>/<ab>/<cd>/<userId>/monize-backup-daily-2026-08-03.json.gz`), because the filename carries only tier and date and a flat folder let one user's retention pass delete another's files. Local attachments shard by *attachment* id with the id as the file itself, because that id is already globally unique.

So a backup's owner is recoverable from its path and **an attachment's owner is not**. Attachment ownership is database-authoritative via its metadata row; no cleanup, retention or migration tool may infer it from the filesystem. Sharding is storage distribution, never tenant isolation or authorization. `docs/adr/0003` has the reasoning.

A path built from an id must still be validated (`isShardableId`) and asserted to resolve inside its base before it reaches the filesystem, even when the id is server-generated (CWE-22).

### A scanned document and its original are one attachment

A scan is stored as two rows -- the enhanced image the user sees and the photo
it came from -- linked by `transaction_attachments.original_of_attachment_id`,
which is set on the ORIGINAL and NULL on everything a user is meant to see. So
"is this a visible attachment" is a predicate, not a table scan, and it is
written once: `primaryAttachmentWhere` / `primaryAttachmentSql`
(`backend/src/attachments/primary-attachment.util.ts`). Its four readers -- the
per-transaction cap, the list, the register's `attachmentCount` and the
`hasAttachments` filter -- all go through it, because four hand-written copies
of one condition is how a list showing one attachment ends up beside a register
cell reading "2". `primary-attachment.guard.spec.ts` fails the column being
named anywhere else without a reason on the record. INV-ATTACHMENT-002.

The pair is written in one transaction and deleted by one cascade; a caller
that wants both halves sends them in one request (`upload(id, file, original)`)
rather than uploading the original afterwards.

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

**A rejected command must not already have written.** Every check that can refuse a request -- ownership, tenant or scenario identity, revision, precondition -- runs inside the same transaction as the mutation, and under the same lock where concurrency matters. A `403`, `404`, `409` or validation failure claims the change did not happen, and an HTTP status cannot undo a committed row. Pass the caller's expectation down into the operation so it can refuse, rather than letting a higher layer reject something already done. `docs/financial-calculation-contract.md` section 7 has the rule, the forbidden sequence and the test obligation.

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

`withScopedDb` commits when the callback returns and rolls back when it throws -- no commit/rollback/release bookkeeping. **There are no `QueryRunner`s left in `src/`** -- RLS tasks R1-R7 converted every one, and lint bans the pattern outright (L1). Helpers take an `EntityManager`, never a `QueryRunner`. If you find a `createQueryRunner()` in a diff, it is new and wrong.

An operation that uses `INSERT ... ON CONFLICT DO NOTHING` and then returns a read model must follow a conflict with a fresh read of the authoritative state, inside the same transaction -- never build the response from a snapshot loaded before the insert attempt.

## Database Access & Row-Level Security (RLS lint bans — CRITICAL)

**All** database access goes through `withScopedDb` (`backend/src/common/db/scoped-db.ts`) -- the single RLS-compliant door to the DB. **Never add an `@InjectRepository(...)` field, a `this.dataSource.createQueryRunner()` call, a `this.dataSource.transaction(...)` call, or a bare `this.dataSource.query(...)`.** ESLint bans the first three outright (RLS task L1, `backend/eslint.config.mjs`) anywhere in `src/` outside `scoped-db.ts`, specs and test helpers. `DataSource.transaction()` is banned for a reason the `createQueryRunner` ban did not cover: it opens a transaction that does not know about the ambient scoped manager, so it carries no identity GUCs under enforcement and, nested inside a caller's `withScopedDb`, commits independently of that caller's rollback. Importing `common/db/with-context` is restricted to an explicit `WITH_CONTEXT_ALLOWLIST` -- a new `withSystemContext`/`withUserContext` call site means adding the file to that allowlist in the same PR, as a reviewed decision.

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
- `withScopedDb` **throws** without an ambient identity context. Authenticated cookie/JWT routes have it (`RequestContextInterceptor` seeds `{ userId }`). **Everything else must seed its own** (`backend/src/common/db/with-context.ts`):
  - `withUserContext(userId, fn)` -- cron per-user bodies, background writes, and any surface the interceptor cannot see. **Bearer-only routes count**: `/mcp` has no `AuthGuard('jwt')`, so the MCP transport seeds the bearer's user itself, per request (protocol revision 2026-07-28 has no session at all).
  - `withSystemContext(fn)` -- genuinely cross-user work: cron fan-outs, seeders, bootstrap hooks (`onModuleInit` / `onApplicationBootstrap` have no request), admin, and anything that sweeps every user.
  - `withDelegateContext(ownerUserId, delegateUserId, fn)` -- a delegate acting on an owner's data, where the two GUCs must **differ**. `withUserContext` collapses them onto one id, which silently returns zero rows for whichever half it is not. Used by `jwt.strategy`'s acting-context re-validation and `AccountDelegateGuard`.
  - `withPreserveTimestamps(fn)` -- extends the ambient context (identity inherited, never granted) so the GUC-aware `updated_at` trigger keeps supplied values. Backup restore is the only caller; it replaced the restore's old `DISABLE TRIGGER` DDL, and trigger DDL must never come back (a source-scan guard in `backup.service.spec.ts` enforces this).
- Nested `withScopedDb` calls join the ambient transaction (same connection/atomicity), so a service method calling another is safe. The exceptions are deliberate: `runOutsideActiveScopedManager` for a background timer or a progress write a concurrent reader must see.
- A callback that returns early (before writing) commits an empty transaction -- the correct replacement for an explicit rollback, not a bug.
- Pass an isolation level as the optional third argument only when the logic depends on it (registration uses `"SERIALIZABLE"` for the first-user-admin race). Requesting one while joining an ambient transaction throws rather than silently downgrading.
- At `RLS_MODE=off` (the default) `withScopedDb` still wraps the transaction but skips the identity GUCs. See `docs/future-plans/row-level-security.md`.
- **`docs/row-level-security-contract.md` is canonical** for which tables are exempt from RLS and why. There is exactly one sanctioned direct-`DataSource` exception -- `oauth_payloads`, reached by the `oidc-provider` adapter with no ambient context because the provider is mounted as raw Express middleware outside Nest's pipeline. It is not precedent for a user-owned table; `eslint.config.mjs`'s `OAUTH_PAYLOAD_ALLOWLIST` plus `backend/src/oauth/oauth-payload-access.spec.ts` fail when a second production reader appears. The exempt-table list lives once, as `RLS_EXEMPT_TABLES`.

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

Money is `decimal(20,4)`; an exchange rate is `NUMERIC(20,10)`. `roundMoney(1 / 1.3652)` stored `0.7325`, which inverts back to `1.3661` -- cents off on a four-figure amount. Round rates with `roundFxRate` (`backend/src/common/fx-entry.util.ts`, 10dp) and display them at `FX_RATE_DISPLAY_DECIMALS` (`frontend/src/lib/format.ts`, 6dp) -- never `toFixed(4)`. Convert with `applyFxConversion` (backend) so the account's `fxFeePercent` is folded in the same way the transaction form does; validate a foreign-currency payload with `normalizeFxEntry`, shared by transactions and scheduled transactions so both accept and reject exactly the same shapes.

### Rate 1 means "same currency", never "no rate found"

A failed rate lookup is unknown -- not `1`, and not the amount passed through unchanged (four conversion paths did one of those two, producing plausible-looking 11% errors). Aggregate through `FxAggregate` (`backend/src/common/fx-aggregate.ts`) rather than `total += convert(...)`: it names each unresolvable pair, and its `total` is `null` while `knownSubtotal` carries what did convert. Zero and negative rates are absent, not applicable. `backend/src/common/fx-fallback.guard.spec.ts` scans for a new silent fallback; `docs/specs/fx-conversion-completeness.md` has the invariants.

### A currency code is derived from the account, not accepted from the request

`amount`/`currencyCode` on a transaction are the account-currency pair; foreign entry belongs in `originalAmount`/`originalCurrencyCode`/`exchangeRate`. Derive with `assertTransactionCurrencyMatchesAccount` (`backend/src/common/fx-entry.util.ts`), which rejects a mismatch -- an unchecked `currencyCode` moved 100 EUR while recording 100 USD, and both fields persist into every report and backup.

A transfer is the same rule twice, plus conservation: two same-currency accounts must move the same amount (an explicit destination amount that disagrees is a rejection, not an override), and a cross-currency pair resolves its rate server-side or refuses. A caller holding only one side's currency -- a scheduled transaction -- sends neither code.

### A preview computes what the commit will do, through the same code

A preview that resolves a rate as `?? 1` while the commit resolves a real one has the user approve one figure and receive another (this has happened twice). Call the same resolver from both.

### A stored amount is a snapshot of a rate; the *current* amount is resolved

`ScheduledTransaction.amount` was computed at whatever FX rate was current when it was written, so for an FX-sensitive schedule (a top-level investment, or a split parent carrying an investment line) it stops describing the occurrence the moment a referenced security's or account's currency changes. Ask `ScheduledEffectiveAmountService.resolveMany` (`backend/src/scheduled-transactions/scheduled-effective-amount.service.ts`) and read `effectiveAmount` / `effectiveAmountComplete` / `effectiveCurrencyCode`; on the client that means `nextOccurrenceEffectiveAmount` (`frontend/src/lib/scheduled-effective-amount.ts`), never `nextOverride?.amount ?? amount`. `null` means unknown and is never a licence to fall back to the snapshot -- a total containing it is withheld and the occurrence renders as unavailable (`UnknownAmount`).

**The amount is half the answer; the account is the other half.** A scheduled investment's `accountId` is the brokerage, but the cash settles in the funding account or the brokerage's linked cash account -- so `settlementAccountId` (from `resolveSettlementAccountId`, the decision the posting makes) says whose balance the figure belongs to. An account-level projection keyed on the stored column charged the brokerage for cash it never moved *and* left the funding account's chart missing the outflow it pays: swapping only the amount would have traded one wrong number for another. Ask which account before asking how much.

**The fix for one surface is not the fix.** Issue #1167 taught the cash-flow forecast to re-resolve and left the same decision duplicated in the dashboard, the budget, the reports, the exports, the AI assistant, MCP, the bill reminder, the alert and the account balance projection -- so one schedule read 1,500 CAD on five screens and 1,350 CAD on the forecast that predicts its posting (#1247). When you fix a derived-figure defect, grep every consumer of the raw field in the same commit and give them all one server-authoritative answer; `frontend/src/lib/scheduled-effective-amount.guard.test.ts` is the scan that keeps them there. INV-OCCURRENCE-003 in `docs/system-invariants.md` records the contract.

**Centralizing the arithmetic is not centralizing the answer.** The first pass at #1247 gave every surface one resolver and left each of them to decide *which occurrence* it was pricing: the identity is a recurrence slot (`original_date`), an override can move the occurrence to another date (`override_date`), and a consumer that keys the lookup on the moved date -- as the budget alert path did -- silently reads the template for every occurrence the user changed. So the unit a surface asks for is the **occurrence**, from `ScheduledOccurrenceService` (`backend/src/scheduled-transactions/scheduled-occurrence.service.ts`) and its one expander (`backend/src/common/scheduled-occurrences.ts`): amount, currency, completeness, the date it falls on, and the account whose balance it moves. `ScheduledEffectiveAmountService` stays the arithmetic beneath it, and a schedule-level read model (`findAll`) is the only place `base` is the question. `backend/src/scheduled-transactions/occurrence-selection.guard.spec.ts` fails a second expander, a second override lookup, a stray `base` read or a new resolver call site. **Ask which occurrence before asking how much.**

**Ask which occurrence, then how much -- and its direction is part of "how much".** "An exchange rate is positive, so it cannot flip a sign" is true of one scalar times one rate and false of a **mixed-sign split parent**, where only the investment line re-prices: a parent stored at -200 posts +150 once that line moves. Three surfaces read the snapshot's sign, so AI/MCP called a re-priced deposit a bill, the forecast called an inflow an expense, and a SQL prefilter on `st.amount < 0` dropped the reverse case from the budget entirely. Direction comes from `EffectiveScheduledOccurrence.directionAmount` -- the occurrence's amount when known, and when it is not, the snapshot's sign **only where that sign is provable without the missing rate**: a top-level investment is one scalar times one positive rate, and a split whose lines all point the same way stays on that side of zero because an investment line's cash impact is signed by its action. A **mixed-sign** aggregate is where it is not provable and `directionAmount` is `null`: a +10 parent made of a fixed +100 beside an unpriceable BUY posts -20 at one rate and +20 at another, so both a red bill and a green deposit are inventions. `null` means unknown and travels -- AI/MCP report `kind: "unknown"` and withhold BOTH bucket totals, the reminder email draws a neutral badge, `occurrenceKind` answers `'unknown'`, and an outflow-only read KEEPS such an occurrence rather than dropping a possible payment behind a total that still looks complete. A candidate query may narrow on the stored sign only for shapes no rate can move; every FX-sensitive row stays in, and the direction is applied after pricing. `occurrence-selection.guard.spec.ts` fails a `Number(<anything>.amount)` compared against zero in any file that holds a resolved occurrence -- by shape, not by variable name, because the alias is how the last one got through.

**An amount and its currency are one value, and an aggregate spans one currency or none.** A helper that takes a currency and never reads it is worse than one that has no currency at all: `sumEffectiveOccurrences`'s deleted predecessor accepted `{amount, currencyCode}` and summed only the numbers, so passing it the *right* code fixed nothing and a 1,350 CAD occurrence joined a 500 USD one as 1,850 in the reader's default currency. Convert before summing -- `FxAggregate` on the server, `sumConverted` / `sumEffectiveOccurrences` on the client -- and make the missing rate nameable: a pair with no rate withholds the total and is reported (`upcomingBillsMissingRates`, `LlmUpcomingScheduledResult.missingRatePairs`, `ConvertedTotal.missingCurrencies`), while a component whose own value is unknown is excluded by count, because it is unknown in *every* currency and naming a pair would send the reader to fix a rate that is already there -- two causes, two repairs, so a surface that folds them into one message sends the reader to the wrong one. **A total also has to say which currency it is in**: `totalsCurrency` travels beside the AI/MCP rollups and is named in the summary line a model quotes, because the items keep their own settlement currencies and a bare number is what let a CAD figure be read as USD. Formatting is the same rule at one row's scale: `formatCurrency(amount)` with no code prints whatever the reader's default is.

**The currency a total falls back to is one constant, and it is derived, not restated.** Thirteen sites spelled out `pref?.defaultCurrency || "USD"`; ten said USD, two said CAD, and one hid CAD behind a local `DEFAULT_CURRENCY`, so Portfolio and the GEM report quoted one user's money in a currency Net Worth never used. It was **twenty-three** copies across both layers -- sixteen USD, seven CAD, one of those behind a local `DEFAULT_CURRENCY` alias -- so two widgets on one dashboard disagreed and a preference-less user's bills page converted and labelled in CAD while the assistant answered the same question in USD. `preferredCurrency` / `resolveUserDefaultCurrency` (`backend/src/common/default-currency.util.ts`) and `preferredCurrency` (`frontend/src/lib/default-currency.ts`) are the only readers, `FALLBACK_DEFAULT_CURRENCY` the only literal on each side -- and the currency the startup hook guarantees a `currencies` row for is that same constant, since a fallback to a code with no row resolves no rate and withholds every converted total. `default-currency.guard.spec.ts` and `default-currency.contract.test.ts` scan their own layer for the shape and for an aliased copy, check the constant against the column's own default, and check the two layers against each other -- because a per-layer constant is exactly how the drift came back.

**A filter narrows the list it was applied to, never a total about the window.** `kind: "deposit"` on the AI/MCP rollup left `bills` empty and published `totalUpcomingBills: 0` with `amountsComplete: true` over a window holding a 1,200 bill -- a confident "nothing is due" in place of an answer nobody asked for. The buckets and the unknown-amount names all come from the rollup base (every filter except `kind`); only `items` and the counts follow the caller's filter, and both tool descriptions say so. The previous pass fixed exactly this for the `unknown` bucket and left the other two on the filtered list, which is the shape to look for: when a fix moves one member of a set off a wrong source, move all of them.

**A rate table that has not loaded is not a table with no rate in it.** With no rates fetched every cross-currency `convert` returns `null`, so a surface reading only the missing-pair list tells the reader to add a rate that is already there -- an instruction built from an in-flight request or a failed one. `useExchangeRates().ratesUnavailable` (loading OR failed) is checked *before* any missing pair is named, and `ratesFailed` distinguishes an outage from a table still arriving. Same rule one level up: `readBalanceForecast` carries `unavailable` beside `withheld` because "the server declined to project", "we never heard back" and "this account has nothing scheduled" are three states and only the last has a number to show -- folded together, a 500 printed the current balance under "Projected".

**Withholding a figure is only honest if the reader learns why.** A cumulative series with one unpriceable occurrence is withheld whole -- but a blank forward line is indistinguishable from "nothing scheduled". `BalanceForecastResult.gaps` names the schedule, the currency pair and the cause, and `BalanceForecastUnavailable` renders the fix (refresh rates on Currencies; check the security's and settlement account's currency). A `null` with no explanation is a dead end, not a correction.

### Missing data: a subtotal is not a total (CRITICAL)

A field named `total*`, `portfolioValue`, `transferValue`, `gain`, `tax`, or `estimated*` may only carry a value when **every** component is known. If any component is unknown, the total is `null`, and the partial sum, if returned at all, goes in a separate explicitly named field (`knownMarketValueSubtotal`), never in the total's field. Never default an unknown price, cost basis, or rate to `0` (or an exchange rate to `1`), and never treat a missing period price as a 0% return.

**`null` is not the safe answer either.** It means "not known", so a state that *is* known must not use it: empty accounts hold zero, move zero, realize zero and owe zero. Decide which of the two each branch is in before writing it.

### An investment action is folded into a share count in exactly one place

`applyActionToQuantity` (`backend/src/securities/investment-replay.util.ts`), with `SHARE_MOVING_ACTIONS` naming the set. `quantity` means shares for most actions and a **ratio** for `SPLIT` -- the distinction duplicated replays kept losing (seven replays existed; three added the ratio instead of multiplying, and omitted `ADD_SHARES`/`REMOVE_SHARES`). Cost goes through `acquisitionCost` in the same file -- commission included, `null` for an unpriced row. `investment-replay.guard.spec.ts` scans for a new hand-rolled fold in either the `case` or the `if` form.

**A Money activity label is not always its raw `TRN.act` code.** Money Plus stores some "Redeem CD/Bond" rows as `act = 2` (SELL) with positive `TRN_INV.amtInt`, while older redemptions use `act = 30`. The importer normalizes SELL plus accrued interest to REDEEM, keeps the SELL row's `TRN.amt` as proceeds, and takes the gross payout from the principal-plus-interest split; do not gate accrued-interest import on raw `act = 30` alone.

### VOID means no balance moved -- on every path that writes one

A `VOID` row records something that did not happen, and `recalculateCurrentBalance` excludes it -- so every incremental balance update must agree, on every path (create, status-only edit, bulk void, split parent). Two rows describing one movement of money share a status, and a reversal only reverses what was actually included.

The status is part of what a row is created *with*, not something applied after: when a create helper takes the parent's status, every caller passes it (three separate paths recreated a voided parent's transfer legs as ACTIVE by forgetting that argument).

Where two rows can hold *different* statuses -- a cross-owner transfer, whose status is deliberately per-ledger -- inclusion is decided per row. Using one leg's `wasVoid`/`isVoid` to gate both ledgers is wrong in two of the four combinations. Four states means a four-case test matrix, not a representative one.

### Editing one row must not leave the pair describing two different events

A split parent and the transfer legs its children created are one movement of money, so voiding *one* leg from the target side is refused rather than applied -- refuse and point at the parent, which already has a propagation path. Only the VOID boundary is shared; reconciliation states (`PENDING`/`CLEARED`/`RECONCILED`) are genuinely per-ledger.

A refusal is only worth as much as its least-guarded entry point: the same state was reachable through `bulkUpdate`. When you refuse something on one path, grep for the bulk, AI-action and MCP routes to the same write in the same commit.

### A deletion reverses only what the row actually contributed

A `VOID` row moved no balance, and neither did a future-dated one, so deleting either must move none. Nine hand-written reversal sites got this wrong four times (including checking VOID but forgetting the date). Call `deletionBalanceEffect` (`backend/src/common/deletion-balance.util.ts`); `deletion-balance.guard.spec.ts` fails on a new hand-rolled `-Number(row.amount)` reaching a balance update.

### A balance change is not finished until its derived state is invalidated

Writing the live balance and stopping leaves a stale net-worth snapshot until something unrelated touches the account. A helper that moves an account nobody upstream knows about must **return** the accounts it moved (`applyParentStatusToTransferCounterparts` returned `void`, so its callers invalidated only their own lists). Dispatch the recalculation after the commit, never from inside the transaction: a rollback must not leave a recompute queued for state that was never written.

### A completeness flag nobody displays is not a completeness signal

Backend, AI adapter and MCP all carried `valuationComplete` while `frontend/src/types/investment.ts` omitted it, so the one surface users read rendered a subtotal under "Total Portfolio Value". Adding metadata to a response is half the change; the consumer that branches on it is the other half -- grep the frontend types for the interface in the same commit, and relabel a partial figure rather than leaving a total's caption over it.

Read the field defensively at the consumer (`=== false`, not `!`): during a rolling deploy, absent means "no information". And read the flag from the *same aggregate that produced the numbers on screen* -- a view that switches which aggregate it displays switches which completeness it trusts.

### A weighting is in one currency or it is meaningless

Summing `quantity * nativePrice` across currencies weights holdings by exchange rate as much as by size. Convert every value into one common currency before weighting (which currency does not matter; that they share one does), through the same resolver everything else uses. An unpriced holding dropped from the weights makes the priced subset stand in for the portfolio: refuse the whole statistic (`null`) rather than report a subset's.

### An account, its currency, its rate and its amount are one tuple

Persist all of it or none of it. Moving a transfer's destination leg to an account in another currency wrote the account, currency and new rate but left the old destination *number*, so the next recompute moved the balance with no user action behind it. Key the write on "did this edit re-price the transfer", never on which request fields happened to be present.

### A change is a value difference, not a field being present

The transfer form resends the current accounts, amount and rate on every save, so `updateDto.amount !== undefined` does not mean the amount changed. Compare against what the row holds -- keying repricing off presence made an idempotent full-form payload move a balance from a description-only edit.

### A presentation-only edit does not re-resolve a rate

Resolve FX only when the financial structure changes: either account, the source amount, an explicit destination amount, an explicit rate. A rename or date correction is not a re-pricing; the rate a transfer settled at is a fact about the transfer (renames used to store today's rate beside an unchanged destination amount, and refused outright when the pair had no current rate).

### A clamp bounds the total, not one of its parts

Two children retiring one debt are clamped together. The loan final-payment fix capped the amortized principal but not the extra-principal transfer beside it, so the account crossed zero into credit and the payoff check never fired. Decide which part yields (the amortized figure is owed; the discretionary extra absorbs the shortfall) and write the yielding part back -- shrinking the parent while a child carries the unclamped number fails the split validator's exact-4dp equality.

### A completeness flag covers every total it is documented to cover, on every surface

`fxComplete` claimed to describe all of `PortfolioSummary`'s `total*` fields while one aggregate's gaps went only to the log. Union every aggregate's gaps, and derive anything downstream (a rate, a ratio) only when its own inputs are complete. The flag must survive the trip to each consumer -- the compact LLM shape dropped it, so AI/MCP quoted a subtotal as settled; for a model, the human-readable summary line has to say so too.

The converse is equally wrong: **zero needs no rate.** Asking for one made an empty foreign account take the whole portfolio's totals down to "unknown".

Completeness has more than one cause: track each separately (`fxComplete`, `pricesComplete`) and give consumers one flag meaning "every component of every total is known" (`valuationComplete`). Nested totals need their own answer -- a per-account total converts into the *account's* currency, the top-level into the *user's*, two different conversion graphs, so a global flag cannot speak for a total it did not compute.

### `created_at` cannot order rows written in one transaction

`CURRENT_TIMESTAMP` is **transaction start time** in PostgreSQL and TypeORM leans on the column default, so every row a single transaction writes (a whole `.mny` import, a whole restore) carries the same `created_at`, and any tiebreak on it falls through to the next key -- in the register, a random UUID. The stored balance survives that; the running balance beside it does not (a same-day debit ordered before the credit that funded it shows the account overdrawn).

When the clock cannot separate two rows, their signs do: **credits before debits, chronologically** -- for a newest-first list the tiebreak runs *opposite* to the list direction. `applyRegisterOrder` (`backend/src/transactions/register-order.ts`) is the only place that order is written, because three of its four call sites are the queries that sum previous pages to find a page's starting running balance -- a tiebreak added to the register alone re-splits the pages under those sums.

### The difference of two 4dp decimals is not a 4dp decimal

`roundMoney` the delta, not just its operands -- `newAmount - oldAmount` is what a balance moves by.

The full rules -- cost basis and tax truth table, cash, valuation, materialized-result versioning, stale quotes, backtests over incomplete history, and the required adversarial test matrix -- live in `docs/financial-calculation-contract.md` and `docs/time-series-contract.md`. Read both **before** writing or changing any financial calculation. `docs/testing-contract.md` lists the adversarial inputs that have broken this codebase before (dates, money precision, aggregation, currency conversion, ownership, concurrency) so a test author picks from a list rather than recalling edge cases. A financial feature of any substance starts from a short approved spec (invariants, truth tables, numerical examples, missing-data policy, test matrix), committed *before* the implementation it guides.

### What a category cost is its debits NET OF its credits

A refund, return, chargeback or cashback filed against an expense category is a debit that came back, so it belongs in that category's total. Every surface that reached for the gross (`WHERE amount < 0` + `SUM(ABS(...))`, `if (amount >= 0) return`, `summary.totalExpenses` alone) disagreed with the register's own balance for the same filter (issue #1125). Sum the signed amount over rows of **both** signs, per category, and decide what the row *is* from the net: `isNetSpending` and `NET_SPEND_AMOUNT` (`backend/src/built-in-reports/spending-reports.service.ts`) on the server; `netEntityTotal` (`frontend/src/components/transactions/widget-shared.ts`) for a summary scoped to one category. Never take `totalIncome` or `totalExpenses` alone as a category's headline -- those are a register's in/out split.

Dropping the sign filter means income now reaches the aggregate and has to leave by a different door: a bucket whose net is not spending is not a row in a spending report -- one predicate, not a per-call-site `> 0`. Netting is **within** one category, never across two; both halves come from the same filtered aggregate. (The payee surfaces are deliberately unchanged: `PayeeInfoWidget` prints received credits as their own line beside the spend, so netting them into the headline would count them twice.)

### An INVESTMENT account is a pair, so account type is never the report's filter

`INVESTMENT` is the `account_type` of *both* halves of a linked pair -- the
`INVESTMENT_CASH` sleeve holding ordinary money and the `INVESTMENT_BROKERAGE`
sleeve holding securities -- so `AND a.account_type != 'INVESTMENT'` deleted a
real ledger from fifteen report queries: salary paid into a brokerage's cash
side vanished from Cash Flow, Income by Source, spending, tax and the
Uncategorized list (issue #1257). It never described the rows it was meant to
remove either: the cash leg a BUY/SELL/DIVIDEND posts lives in that same cash
account, carries no category and no transfer flag -- and when the action names an
explicit `fundingAccountId`, that leg lands in an *ordinary* account where no
account-type predicate could ever see it, reporting an investment purchase as
spending nobody did.

What a row *is* decides it, and the predicate is written once in
`backend/src/common/investment-filter.util.ts` -- `investmentExclusionSql` for
raw SQL, `applyInvestmentTransactionFilters` for a QueryBuilder, both built from
the same fragments so the two dialects cannot drift. Use those; never spell an
account-type or sub-type exclusion by hand.
An investment line embedded in a split is the case a transaction-level linkage
check alone gets wrong (its `transaction_id` is null; the split carries the cash),
so it is excluded by both of its representations -- the split's `kind` and an
`investment_transactions` row pointing at the split -- and **at split-row
granularity**: excluding the parent would take the ordinary sibling line with it.

**A report that reads only the parent row cannot exclude a line, so it excludes
an amount.** `t.amount` on a split parent is the sum of every child, so Spending
by Payee, Recurring Expenses, Bill Payment History and the Uncategorized list all
reported a `-560` parent made of `-60` groceries and a `-500` embedded BUY as
`560` of spending. They derive their figure through
`reportableTransactionAmountSql` -- the children that are neither transfer nor
investment, `NULL` when the row represents no ordinary cash at all. Duplicate
Transactions is the one exception and says so in its SQL (`PARENT-IDENTITY
REPORT`): its subject is the stored row, not its cash meaning. The guard checks
the *representation*, not the presence of a token, because a parent-only query
that reached for the no-splits variant is exactly the defect.
`backend/src/common/investment-filter.guard.spec.ts` fails on either shape and
on a built-in-report ledger query that carries no exclusion, and
`backend/test/integration/report-investment-cash.integration.spec.ts` holds the
behaviour against a real database. That guard's transfer-only exemption is
positive proof, never the presence of the token -- the monthly breakdown reads
ordinary rows *and* categorized transfer outflows, so a substring match exempted
a split-joining query from the whole scan. The custom report engine
(`backend/src/reports/`) aggregates hydrated entities in TypeScript, so it uses
the same rule's other dialect -- `ordinarySplitLines` and
`reportableTransactionAmount`, which live beside the SQL -- and its own scans
check the loop rather than a query string. The two dialects differ by exactly one
clause on purpose: the SQL drops transfer children, while a custom report keeps
its own `includeTransfers` decision. The same rule governs what "Uncategorized"
means: an auto-generated trade leg is not a row the user forgot to file, and a
bulk update filtered to uncategorized must not reach it.

## Environment

Key env vars (see `.env.example` for full list):
- `JWT_SECRET` -- minimum 32 chars, enforced at startup
- `ENCRYPTION_KEY` -- minimum 32 chars; encrypts AI provider keys, emergency-access credentials and the stored backup password. Not yet enforced at startup (a deployment without one boots and is warned on every start that a future release will require it), but nothing that needs a secret works without it. `AI_ENCRYPTION_KEY` is the former name, still read and still preferred where both are set
- `DATABASE_*` -- PostgreSQL connection
- `DEMO_MODE=true` -- enables demo restrictions, daily reset at 4 AM UTC
- `LOCAL_AUTH_ENABLED` / `REGISTRATION_ENABLED` -- auth toggles
- `OIDC_*` -- OpenID Connect provider config
