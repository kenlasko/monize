# Backend Directory

NestJS API server (TypeORM, PostgreSQL, class-validator, nestjs-i18n, Jest). All commands run from this directory.

This file is an index. The rules themselves live in `docs/backend/` (start at `docs/backend/README.md`) and are read when the work touches their subject. Most of them are also enforced by a source-scanning spec whose failure message names the thing to use, so a rule is met by fixing the code, never by widening a guard's grandfather list.

Most of this layer's hardest rules are cross-layer and live in `docs/`, indexed by `docs/system-invariants.md`, which also records, per invariant, whether the code currently upholds it. Before changing a balance, a holding, a transfer, a scheduled occurrence, a cron, a token, or anything that writes outside PostgreSQL, read the relevant one and name its ID in the PR:

- `docs/concurrency-and-idempotency.md` -- `withScopedDb` gives atomicity and identity, **not** protection against a concurrent writer of the same row. Which mechanism to use, lock ordering, and what a retry means before commit, after commit, and when the result is unknown.
- `docs/financial-semantics.md` -- signs, transfer legs, FX rate direction and precision, split and commission arithmetic.
- `docs/external-side-effects.md` -- attachments, backups, email, providers: anything a transaction cannot roll back.
- `docs/cron-jobs.md` -- every `@Cron` with what stops a second replica repeating its effect. A new cron fills in that column.
- `docs/verification-contract.md` -- a mock proves the call, not the property; which claims need a real two-connection test.

## Commands

```bash
npm run start:dev          # Dev server with HMR
npm run build              # Production build
npm run lint               # ESLint --fix
npm run format             # Prettier over src/ and test/
npm run typecheck          # tsc over src AND test (CI gate; plain `tsc --noEmit` skips test/)
npm run test               # test:unit then test:integration -- needs PostgreSQL; takes no args
npm run test:unit          # Unit tests only (src/**/*.spec.ts); no database needed
npm run test:integration   # test/integration/*.spec.ts against real PG, one worker
npm run test:cov           # Coverage report (95% lines, 94% stmts, 95% funcs, 85% branches)
npm run test:e2e           # test/*.e2e-spec.ts -- not a CI gate; three of five suites are broken (docs/backend/testing.md)
npm run i18n:pseudo        # Regenerate the xx pseudo-locale from en
npm run i18n:check         # Verify the pseudo-locale is up to date (not a CI gate for this layer; run it anyway)
npm run migration:lint     # Idempotency lint over database/migrations (CI gate)
npm run migration:lint:test # Self-test for the migration lint
```

`npm test` takes no Jest arguments; a filtered run goes through `npm run test:unit -- <pattern>` or `npm run test:integration -- <pattern>`. The database-backed suites never run in parallel with anything, including each other; `docs/backend/testing.md` says why and `src/common/jest-config.guard.spec.ts` holds it.

## Module Structure

Each feature module under `src/` follows the standard layout. Use `ls src/` or LSP `workspaceSymbol` to discover modules; the cron schedule lives in `docs/cron-jobs.md`.

Each module holds `{feature}.module.ts`, controller, service, their specs, `entities/` and `dto/`. Controllers are thin and delegate to services. Services always take `userId` as the first parameter and filter by it for multi-tenancy. An `imports` entry or constructor parameter whose class can reach the declaring file back through `import` statements is `forwardRef(() => X)`; `src/module-graph.spec.ts` names the offending edge.

## Configuration

- **Path alias:** `@/*` maps to `src/*` (tsconfig + Jest moduleNameMapper).
- **ESLint** (`eslint.config.mjs`) bans the direct database primitives `AGENTS.md` names; `WITH_CONTEXT_ALLOWLIST` and `OAUTH_PAYLOAD_ALLOWLIST` live there.
- Coverage excludes `main.ts`, modules, entities, DTOs, seed scripts and migrations.

## Rules that apply to every change

**Find how the codebase already does it and do it the same way.** Each of these exists once; the generic version looks fine in isolation and wrong in place. The guard spec beside each rule in `docs/backend/` fails on most of the hand-rolled versions.

| Need | Use | Never |
|---|---|---|
| Any database access | `withScopedDb` and the identity contexts in `AGENTS.md` | an injected repository, a query runner, a bare `dataSource.query` |
| A refusal (ownership, precondition, revision) | the check inside the same transaction as the write, before it | a check after a commit that a status code then contradicts |
| A raw `SELECT` of a DATE or numeric | `TO_CHAR(col, 'YYYY-MM-DD')` and `Number(...)` at the boundary | trusting the entity transformer or the global DATE parser |
| An optional DTO field with a format validator | `@ValidateIf((_o, v) => v !== null && v !== "")` beside `@IsOptional()` | `@IsOptional()` alone |
| A request-supplied array | `@ArrayMaxSize(n)`; iterate with `entries()` | an unbounded array, `.length` as a loop bound in a scoped callback |
| A user-facing exception message | `tr(key, fallback, args)` | a hardcoded string |
| Copy composed outside a request (email, push body) | `emailTranslator(i18n, recipientLang)` | the request locale or English |
| A notification | `NotificationService.create` | a second `INSERT` into `notifications` |
| Sending a push | ask the notification layer | importing `web-push` outside `WebPushSender` |
| A numeric environment variable | `resolvePositiveInt`, declared in a table beside its documentation | a bare `Number(process.env.X)`, or `configService.get<number>(...)`, which asserts the type without coercing |
| A log line, including pre-boot scripts | NestJS `Logger` | `console.*` |
| A third-party `fetch` | `ProviderHealthService` gates and `describeFetchFailure` | a bare `fetch` or logging `error.stack` from a `catch` |
| A literal inside a regular expression | `escapeRegExp` | a hand-written character class |
| A text filter offered to a person or a model | `ILike` or a case-insensitive comparison | `Like` |
| A predicate that decides which row counts | one named helper called from every site | the clauses spelled out per site |
| A folded investment action | `applyActionToQuantity` / `acquisitionCost` | a hand-rolled replay |
| A register or running-balance order | `applyRegisterOrder` (`src/transactions/register-order.ts`) | a hand-written `ORDER BY created_at` |
| Excluding investment cash from a report | `investmentExclusionSql` / `applyInvestmentTransactionFilters`, `reportableTransactionAmountSql` | an account-type or sub-type predicate |
| A SQL function called from `src/` | declared in `src/common/db/required-db-functions.ts` with its migration | a bare call the boot check does not know |
| A number a person reads | `src/common/number-locale.util.ts` | the `en-US` helpers in `format-currency.util.ts` (machine output only) |

**A cron or bootstrap body seeds its own identity** -- `withSystemContext` for the fan-out, `withUserContext(userId)` per user, `withDelegateContext` when the two ids must differ -- and a per-user loop isolates each user, pre-checks included. `docs/backend/cron-and-background-work.md`.

**A read about somebody else needs somebody else's identity.** Under RLS a query keyed on another person returns zero rows from the caller's scope with no error. Decide whose row it is before writing the query; `docs/backend/database-access-and-tenancy.md` has the three answers.

**A mock returns what the real collaborator returns**, typed so `tsc` rejects a shape the real method cannot produce; a fixture is evidence only if the producer could have written it; and a suite that stays green through a behaviour change is a finding, not a pass. `docs/backend/testing.md`.

**Every user-facing string is translated** (`nestjs-i18n`). Exception messages go through `tr(...)` (`src/i18n/translate.ts`); anything composed outside a request goes through `emailTranslator` (`src/i18n/email-translator.ts`). Catalogs in `src/i18n/locales/{locale}/*.json`; the locale list is `SUPPORTED_LOCALE_CODES` in `src/i18n/config.ts`, kept in sync with the frontend's. Develop English-first and run `npm run i18n:pseudo`; translate every other locale as the final commit on the PR (`src/i18n/locales.parity.spec.ts`). Full flow: `src/i18n/README.md`.

## Read when the work touches it

| Work | Read |
|---|---|
| Specs, mocks, fixtures, Jest configs, the E2E suites | `docs/backend/testing.md` |
| Module edges, global providers, `main.ts`, env vars, logging, OIDC, CodeQL | `docs/backend/modules-and-runtime.md` |
| Entities, DTOs, raw SQL, phone numbers, text caps, regex escaping | `docs/backend/entities-and-dtos.md` |
| Ownership, identity, joint accounts, refusals, predicates | `docs/backend/database-access-and-tenancy.md` and `docs/row-level-security-contract.md` |
| Transaction writes, exports, loans, categories, currency of a value, Money import | `docs/backend/transactions-and-money.md`, then `docs/financial-semantics.md` |
| Prices, securities, outbound providers and the breaker | `docs/backend/securities-and-providers.md` |
| AI assistant, tools, payee lookup and enrichment, search | `docs/backend/ai-and-payees.md` |
| Notifications, push, recipient-locale copy | `docs/backend/notifications-and-push.md` |
| Backup and restore, automatic backups, off-machine copies | `docs/backend/backup.md` and `docs/backup-restore-contract.md` |
| Crons, reapers, background jobs | `docs/backend/cron-and-background-work.md` and `docs/cron-jobs.md` |
| MCP server: transport, tools, confirmation | `docs/backend/mcp.md` (`src/mcp/CLAUDE.md` is its pointer) |

Every AI tool is shared between the assistant and the MCP server: the logic goes on the domain service and both adapters are wired in the same PR (`docs/backend/ai-and-payees.md`, "Shared AI tools").

## Before you finish

Run the focused spec for what you changed while developing (`npm run test:unit -- <pattern>`), then:

1. `npm run lint && npx tsc --noEmit && npm run typecheck` (CI runs all three)
2. `TZ=UTC npm run test:unit -- --coverage` (and `npm run build && npm run test:integration` when a query, an entity, a migration or an RLS context changed)
3. `npm run i18n:check` after editing `en/*.json`
4. `npm run migration:lint:test && npm run migration:lint` when a migration changed, with `database/schema.sql` updated alongside it; `npm run push:client:test && npm run push:tls:test` when the push tooling under `scripts/` changed
5. `node scripts/check-env-docs.mjs` from the repository root when a `process.env` or `configService.get` read was added

The guards that walk the tree with `git ls-files` cannot see an untracked file: stage new files (`git add -N` is enough) before running `doc-paths.spec.ts`, `source-comment-paths.spec.ts` or `jest-config.guard.spec.ts`.
