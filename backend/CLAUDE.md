# Backend Directory

NestJS API server. All commands run from this directory.

Most of this layer's hardest rules are cross-layer and live in `docs/`, indexed by [`docs/system-invariants.md`](../docs/system-invariants.md) -- which also records, per invariant, whether the code currently upholds it. Before changing a balance, a holding, a transfer, a scheduled occurrence, a cron, a token, or anything that writes outside PostgreSQL, read the relevant one and name its ID in the PR:

- [`docs/concurrency-and-idempotency.md`](../docs/concurrency-and-idempotency.md) -- `withScopedDb` gives atomicity and identity, **not** protection against a concurrent writer of the same row. Which mechanism to use, lock ordering, and what a retry means before commit, after commit, and when the result is unknown.
- [`docs/financial-semantics.md`](../docs/financial-semantics.md) -- signs, transfer legs, FX rate direction and precision, split and commission arithmetic.
- [`docs/external-side-effects.md`](../docs/external-side-effects.md) -- attachments, backups, email, providers: anything a transaction cannot roll back.
- [`docs/cron-jobs.md`](../docs/cron-jobs.md) -- every `@Cron` with what stops a second replica repeating its effect. A new cron fills in that column.
- [`docs/verification-contract.md`](../docs/verification-contract.md) -- a mock proves the call, not the property; which claims need a real two-connection test.

## Commands

```bash
npm run start:dev          # Dev server with HMR
npm run build              # Production build
npm run lint               # ESLint --fix
npm run typecheck          # tsc over src AND test (CI gate; plain `tsc --noEmit` skips test/)
npm run test               # jest with no filter -- see the note below, this is NOT green
npm run test:unit          # Unit tests only (src/**/*.spec.ts)
npm run test:cov           # Coverage report (95% lines, 94% stmts, 95% funcs, 85% branches)
npm run test:e2e           # E2E tests (test/**/*.spec.ts, 30s timeout, sequential)
npm run i18n:pseudo        # Regenerate the xx pseudo-locale from en
npm run i18n:check         # Verify the pseudo-locale is up to date (CI gate)
npm run migration:lint     # Idempotency lint over database/migrations (CI gate)
npm run migration:lint:test # Self-test for the migration lint
```

### `test/*.e2e-spec.ts` is not a gate, and three of the four suites are broken

CI runs `test:unit` and `test:integration` (filtered to `test/integration/*.spec.ts`). Nothing runs `test:e2e`, and separate rot accumulated behind a since-fixed compile error (`npm run typecheck` now closes the compile half in CI):

| Suite | State | Why |
|---|---|---|
| `test/payee-detail.e2e-spec.ts` | passes (9 tests) | fine; this is the spec that caught the raw-select transformer class of bug |
| `test/payees.e2e-spec.ts` | fails | calls services directly, so no request scope; never converted for RLS (`withScopedDb` throws without ambient context) |
| `test/auth.e2e-spec.ts` | fails | `AuthController` gained a `TokenService` dependency its test module does not provide |
| `test/transactions.e2e-spec.ts` | fails | `DelegateTransferMaskInterceptor` gained a `CrossOwnerAccessService` dependency its test module does not provide |

Repair them or delete them -- what they must not stay is present, cited, and dead. Do not add `test:e2e` to CI until the three are fixed; it will be red.

## Module Structure

Each feature module under `src/` follows the standard layout. Use `ls src/` or LSP `workspaceSymbol` to discover modules; the cron schedule lives in `docs/cron-jobs.md`.

```
{feature}/
  {feature}.module.ts
  {feature}.controller.ts
  {feature}.service.ts
  {feature}.controller.spec.ts
  {feature}.service.spec.ts
  entities/{entity}.entity.ts
  dto/create-{entity}.dto.ts
  dto/update-{entity}.dto.ts
```

Controllers are thin and delegate to services. Services always take `userId` as the first parameter and filter by it for multi-tenancy.

## Configuration

- **Path alias:** `@/*` maps to `src/*` (tsconfig + Jest moduleNameMapper)
- **ESLint:** Flat config (`eslint.config.mjs`) with typescript-eslint + prettier
- **Jest:** Coverage thresholds: 95% lines, 94% statements, 95% functions, 85% branches. Excludes `main.ts`, modules, entities, DTOs, seed scripts, and migrations from coverage.
- **TypeScript:** ES2021 target, CommonJS modules, `strictNullChecks: true`, `noImplicitAny: false`

## Global Providers (app.module.ts)

Registered globally via `APP_FILTER`, `APP_GUARD`, `APP_INTERCEPTOR`:

| Provider | Purpose |
|----------|---------|
| `GlobalExceptionFilter` | Catches all exceptions; handles HttpException and TypeORM QueryFailedError |
| `ThrottlerGuard` | Rate limiting (100 requests/minute) |
| `CsrfGuard` | CSRF double-submit cookie validation |
| `MustChangePasswordGuard` | Blocks access until password change (admin-reset users) |
| `DemoModeGuard` | Restricts write operations in demo mode |
| `CsrfRefreshInterceptor` | Refreshes CSRF token cookie on responses |
| `ClassSerializerInterceptor` | Applies `@Exclude()` / `@Expose()` from class-transformer |

Also configured: `ConfigModule` (global), `TypeOrmModule` (async, PostgreSQL), `ThrottlerModule`, `ScheduleModule`.

## main.ts Setup

- **API prefix:** `api/v1`
- **Body limit:** 10mb (for large QIF file imports)
- **Swagger:** Enabled at `/api/docs` in non-production only
- **DATE column parser:** `pg.types.setTypeParser(1082, val => val)` -- returns DATE columns as strings to prevent timezone-related date shifting
- **Validation pipe:** Global with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`
- **Security:** Helmet (CSP, HSTS, frame-deny), CORS (credentials, configurable origins)
- **Cookie parser:** Required for OIDC state/nonce and auth tokens
- **Trust proxy:** Level 1 (Docker/nginx real client IP)

## Entity Conventions

**DATE columns** must use a string transformer to avoid timezone issues -- without this, PostgreSQL returns a `Date` parsed in UTC and reading `.toISOString()` can shift the day:

```typescript
@Column({
  type: 'date',
  name: 'transaction_date',
  transformer: {
    from: (value: string | Date): string => {
      if (!value) return value as string;
      if (typeof value === 'string') return value;
      return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
    },
    to: (value: string | Date): string | Date => value,
  },
})
transactionDate: string;
```

**Decimal columns** use a `numericTransformer` to convert PostgreSQL's string representation to `number`. **Timestamps** are `@CreateDateColumn({ name: 'created_at' })` and `@UpdateDateColumn({ name: 'updated_at' })`.

**Raw selects bypass both transformers.** `getRawOne`/`getRawMany` return driver values: a DATE comes back as a JS `Date` and a numeric as a string, regardless of the entity transformer. Select a DATE as text in SQL (`TO_CHAR(col, 'YYYY-MM-DD')`) and pass a numeric through `Number()` before it reaches a DTO that declares `string`/`number`. `main.ts` installs a global DATE string parser, which hides the DATE half in the running server but not in tests, jobs, or any other process -- so do not rely on it. `payee-detail.service.ts` is the worked example; `test/payee-detail.e2e-spec.ts` caught it, because a unit spec with mocked query builders cannot.

**A hand-written column name is checked by nobody -- so a scan checks it.** A mocked `manager.query` records the string and resolves, making every raw statement's column names untested by construction (`AutoBackupService` wrote `RETURNING id` against a table whose primary key is `user_id`, the spec pinned the wrong string with `toContain`, and no user's automatic backup ran). `src/common/db/raw-sql-columns.spec.ts` checks every `RETURNING` list, `INSERT` column list and `UPDATE ... SET` target in `src/` against `database/schema.sql`. Assert the *column*, not the substring.

**A per-user loop in a cron isolates each user, including the steps before the work starts.** Wrap the entire per-user body in the `try` -- an error while deciding whether to run (a pre-check, the claim's own `UPDATE`) must not leave the handler and skip every remaining user. Record the failure on the row so the last-run status tells the truth, and record it through a path that cannot itself throw.

## DTO Conventions

### An optional field with a format validator needs `@ValidateIf`, not just `@IsOptional`

`@IsOptional()` waives validation for `undefined` and `null` only. A text input the user left alone arrives as `""` (react-hook-form sends it), so an `@IsUrl` / `@IsEmail` beside `@IsOptional()` still rejects it -- and because validation fails per *request*, one blank optional field breaks every save from that form. Add `@ValidateIf((_o, value) => value !== null && value !== "")` for a nullable column so a blank clears it. `src/common/optional-url-dto.spec.ts` sweeps every URL-validated DTO property; a NOT NULL field belongs on its exemption list with a reason. This class of bug is invisible to unit tests (hand-built payloads); it surfaces in E2E or production.

### A request-supplied array declares an upper bound

Every `@IsArray()` DTO property carries `@ArrayMaxSize(n)` -- an unbounded array turns per-element work downstream into a denial-of-service lever (CodeQL `js/loop-bound-injection`, CWE-834). `src/common/array-bound-dto.spec.ts` sweeps validator metadata; its grandfather list may only shrink. Relatedly, never use a request value's `.length` as a loop bound inside a `withScopedDb` callback (CodeQL cannot track the outer guard through the closure): iterate `for (const [i, v] of xs.entries())`.

## `complete()` is not `completeWithTools()` with the tools left off

Both take `AiCompletionRequest`, but `complete()` maps messages through `toSimpleMessages`, which **filters `role: "tool"` out entirely** -- summarising a tool-use conversation through it sends a transcript stripped of every tool result and returns a confident summary of nothing.

A tool-free turn over a tool-use transcript goes through `completeWithTools`/`streamWithTools` with an empty tool list, and every provider builds the field with `toolsField` (`src/ai/providers/tools-field.util.ts`) so it is **omitted** rather than sent as `[]` (OpenAI rejects `tools: []`). `tools-field.util.spec.ts` scans every `*.provider.ts` for a bare `tools:` key; per-provider specs assert the request body both ways. The one caller is `AiQueryService.streamFinalSynthesis`, the pass that turns an unfinished investigation into an answer.

## A turn that ends on a promise is not an answer

Nothing runs between turns, so a tool-free turn saying "One moment, I'm gathering..." ends the query (the loop exits on `stopReason !== "tool_use"`) and reads as a hang. The loop therefore does not treat every tool-free turn as an answer: `isDeferredContinuation` (`src/ai/query/continuation.ts`) recognises the promise, and the loop replies with `CONTINUATION_NUDGE` in the user's place for at most `MAX_CONTINUATION_NUDGES` passes, then breaks to the tool-free synthesis pass with `cutoff = "stalled"`. The stalled text stays in the thinking buffer and never becomes the answer bubble.

Detector shape (both asymmetries are in its spec): a wait request ("one moment") is decisive; a bare work announcement is not, and an offer ("let me know", a trailing `?`) wins over it; only the tail of the message is examined. A false positive costs one extra pass; a false negative is the hang. The strongest signal needs no prose judgement: `promisesPendingAction` pairs a promise of confirmation cards against `proposingToolResults === 0` -- prefer pairing a text claim against state the loop already tracks over adding another regex phrase. `QUERY_SYSTEM_PROMPT` asks for the same thing, but a prompt rule is not a guarantee.

**A stall is often a dead end the model found and could not name.** Both reported stalls were a request the tools could not express (recategorizing one line in 17 split transactions, with one proposing call allowed per query). Batch rows now carry `splits` (`BatchUpdateTransactionRow.splits`, applied in `executeBatchRow` inside the same `UpdateTransactionDto` as the scalar fields, per invariant I1); the individual-card path passes `result.splits` through. Two rules the tests hold: a row that resends no splits must carry none (an empty set would rewrite the lines it was asked to leave), and a row's preview shows its lines instead of a category name. The general point: when you add a limit, put it in the tool description in the same commit.

**A filtered read is not a complete read, and only one of its two readers can tell.** `applyCategoryFilters` hydrates only the split lines matching the filter -- right for the register, wrong for anything that sends the lines back, because `manage_transactions` replaces a split set with exactly what it is given. The LLM path reloads the full set per split parent (`loadCompleteSplits`). Before reusing a list query in a tool, ask what its `where` does to the collections it hydrates: a filter on a joined child table silently truncates the parent's children.

**A refusal the caller cannot act on is a refusal that ends the task.** Every bulk tool path computes a per-row reason; `describeSkippedRows` (`common/bulk-create.types.ts`) is the only way those messages are built (identical reasons collapse with a count; distinct ones list up to three). `bulk-skip-reporting.spec.ts` scans all four tool sources and fails on a "None of ... could be prepared" message that does not carry its reasons -- a generic message that *guesses* sends the reader away from the fix. Individual-card paths that count skips collect reasons too.

## A numeric env knob is declared as data, next to its documentation

Coerce every numeric environment variable through `resolvePositiveInt` (`src/common/env-number.util.ts`), never a bare `Number(...)` -- it separates *absent* from *invalid* so a typo is logged rather than silently running on the default. Where a feature has more than one knob, declare the set as one table of `{ envVar, default, description }` and resolve in a loop (`src/ai/query/query-budgets.ts` is the pattern). `query-budgets.spec.ts` checks `.env.example` in both directions: every declared budget documented with its current default, and no `AI_QUERY_*` line documenting a variable the code does not read.

## An environment variable configures the deployment's own resource, not somebody else's

The AI provider has two owners. `AI_DEFAULT_*` builds the **centrally managed** provider (the operator's, used when a user has configured none, editable nowhere in the UI); everything else in `ai_provider_configs` is a row a *user* created and can edit. So `AI_QUERY_*` sizes the central provider only; a user's provider carries the same five budgets as nullable columns, set in Settings -> AI, defaulting to the built-in numbers -- never to the environment. `resolveQueryBudgetsForConfig` is the single place that decision is made; `AiService.resolveToolUseProvider` hands the caller the configuration alongside the provider, and the transient system-default config is marked `isSystemDefault`.

Before adding an env var for anything a user can also configure, ask which resource it describes -- an operator's ceiling says nothing about a model somebody else is paying for, and the reverse mistake (a per-user knob for the operator's resource) hands out their budget. `query-budgets.spec.ts` holds the split from both sides; a stored value outside the declared range falls back to the documented default rather than being clamped. The bounds live in the same spec table as the defaults, so the DTO (`QueryBudgetFieldsDto`), the migration and the frontend form derive from one place; the form's copy is checked by `frontend/src/lib/ai-query-budgets.contract.test.ts`.

## A label the exporter writes itself must need no escaping

The CSV formula-injection guard in `account-export.service.ts` exists for user-controlled text; when one of the exporter's *own* strings trips it (`-- Split --` got an apostrophe prefix on every split parent row), rename the label so it opens with a character no spreadsheet evaluates (`CSV_SPLIT_CATEGORY_LABEL` is `(Split)`) -- do not exempt the literal. Assert the *field*, not the line (`toContain` is satisfied by the neutralized cell), and keep the document-level check: export an all-ordinary-text fixture and assert no cell carries the guard's prefix.

A transfer's label is `csvTransferLabel` in the same file, and it names the direction as well as the counterpart (`Transfer To Savings`); a split line is asked with its own amount, not the parent's. Its twin is `transferCsvLabel` in `frontend/src/lib/transfer-label.ts`; the QIF export keeps Quicken's `L[Account]` form deliberately.

## A blank transfer payee is stored blank and resolved at read time

A transfer created without a payee persists `payee_name` as NULL (issue #1214); the display label is resolved per read from the linked leg's account -- its CURRENT name, in the reader's language. The English form for machine-facing surfaces (CSV/QIF export, AI/MCP rows, custom reports) lives only in `src/transactions/transfer-payee-label.util.ts`, and `transfer-payee-stamp.guard.spec.ts` fails on a `Transfer to/from ${...}` template anywhere else in `src/`. Migration 161 blanked the legacy-stamped rows; `updateTransfer` heals a surviving stamp to NULL and never regenerates it. A read surface joining `linkedTransaction.account` for this must mask or restrict cross-owner counterparts the reader cannot read (the account export masks; the custom report query restricts the join to same-owner legs).

The guard also asks what a value *is* rather than what it starts with, matching its twin in `frontend/src/lib/csv-export.ts`: a value a spreadsheet reads as a number is data, and prefixing one stops the column adding up (issue #1134) -- amounts bypass `escapeCsv`, so the rule covers text columns that can still hold a number (a cheque number written `-123`).

## A partial escape is indistinguishable from a correct one

Interpolating a literal into a pattern goes through `escapeRegExp` (`src/common/escape-regexp.util.ts`) -- never a hand-written character class, and never a subset of one (`repo-paths.util.ts` escaped only dots and left `\` alone; CodeQL `js/incomplete-sanitization`, CWE-020). `escape-regexp.guard.spec.ts` scans `src/` for either shape. Where the pattern is built from a list, export the builder and test it against a prefix carrying a metacharacter (`buildPlainRootedPathPattern`) -- over real inputs the broken and correct escapes can agree exactly. Do not escape `-`: outside a class it is literal, and `\-` is a SyntaxError under the `u` flag -- so never interpolate the result *inside* a class.

## A cached brand favicon is four columns, one fetcher, and one export rule

Institutions and payees resolve a website's favicon server-side and cache the bytes so the browser never contacts a third party. Shared code lives in `src/common/favicon/`: `FaviconService` (the gstatic fetch, with timeout, size cap and image-only content-type check) and `brandLogoColumns` (the four columns `logo_data`, `logo_content_type`, `has_logo`, `logo_fetched_at`). A third entity imports `FaviconModule`, not a copy. Four shared rules, each with a test:

- **The fetch stays outside the transaction** -- best-effort, never fails the create/update, never holds a connection on a slow host.
- **Re-resolve only when the address actually changed.** The form resends the current website on every save, and a failed re-fetch would clear a good icon. Clearing the address clears the icon.
- **The flag and the bytes move together.** `has_logo` answers every list read (the bytes are `select: false`, leaving only through `GET /:id/logo`, which 404s so the client draws its own badge); `logo_fetched_at` stamps the *attempt*.
- **A bytea column breaks `SELECT *`.** The export query must list columns and wrap the bytes in `encode(logo_data, 'base64')` (`export-driver-values.spec.ts` catches the omission). The support backup drops the bytes and forces `has_logo` false, because a brand icon re-identifies a masked payee.

## Rejection happens before the write

A check capable of refusing a command belongs inside the transaction that performs it, and under the same lock where concurrency is in play. A service that mutates, commits, and returns a success-shaped value for a caller to reject afterwards has already done the thing the `409` says it did not do.

Give the operation the caller's precondition as a parameter -- the expected owner, scenario or revision -- and let it refuse before writing. Return the refusal distinguishably: "no such row", "not yours" and "done" are three answers, and folding two into `null` makes the caller guess. Tests assert the rejected response **and** the stored state; see `docs/financial-calculation-contract.md` section 7.

## Scheduled loan interest uses a dated ledger balance

`accounts.current_balance` excludes future-dated transactions, so it cannot price an installment after future payments have been posted. Recalculate scheduled loan interest from opening balance plus every non-void, top-level transaction through the schedule's next due date; this includes regular and principal-only payments, while later transactions belong to later installments.

## A category's leaf name is not its identity

"Cell Phone" under **Bills** and under **Business** is an ordinary chart of accounts, so a bare leaf name identifies nothing. Both halves go through `categories/category-name.util.ts`:

- **Emitting**: `qualifiedCategoryName` / `loadQualifiedCategoryNames` produce `"Business: Cell Phone"`. Analytics groups on `SPLIT_CATEGORY_ID` and resolves the label from the map -- there is deliberately no category-*name* SQL fragment left, and `transaction-split-query.util.spec.ts` fails if one reappears.
- **Accepting**: `resolveCategoryNamePaths` matches a name the model sends back, separator- and spacing-insensitive, and **refuses an ambiguous one** with the qualified candidates rather than picking a winner.

The test that matters is the round trip: every name we emit must resolve back to the category we emitted it for (`category-name.util.spec.ts`) -- four hand-rolled resolvers had drifted apart, and one rejected the exact spelling every tool description tells the model to type, falling through to a last-segment fallback that silently read the *other* "Cell Phone".

Also: `Uncategorized` (the user filed it nowhere) and `Unknown category` (we could not resolve the name of the category they did file it under) are different facts with different constants. Do not fold the second into the first.

## A predicate that decides which row counts is written once

When "is this row the one we mean" takes more than one clause (current algorithm version *and* matching configuration fingerprint), name it and call it. Spelled out per site it drifts invisibly: the GEM signal service wrote it four times and the fourth checked only the date, so a superseded row could be stored as the next period's predecessor. Same for the `where` that reads such a row back: a unique key that grew a column selects more than one row under the old `where` -- grep for reads of a unique key in the migration that widens it.

## One classifier decides whether a database role is safe

`common/db/runtime-role-check.ts` owns "may this role serve enforced traffic": one facts query template, one violation list, one verdict. Every surface asks through its exports -- `main.ts` about its own connection (`assertRuntimeRoleSafe`), `db-init` about the configured role by name (`assertRuntimeRoleSafeByName`). Do not write a second role-safety query (a hand-written copy in `app-role.ts` once blessed a role the runtime check then rejected, PR #1076). `runtime-role-check.spec.ts` pins the two exported queries to one template and the two asserts to one verdict per input.

## A read about somebody else needs somebody else's identity

`users_self` exposes exactly two rows to a session: `app_current_user_id()` and `app_real_user_id()`. **Any query keyed on another person -- by id, or worse, by email -- returns zero rows from the caller's own scope** under `RLS_MODE=enforce`, without raising or logging, and "no rows" looks like "no such user". (`AuthService` finds a login by email only because it runs pre-identity, under a bypass; `DelegationService.delegateEmailExists` ran the identical `where` under `scoped()` and told owners an account that demonstrably logs in did not exist.)

Before writing a query, ask whose row it is. There are three answers, not two:

| Whose row | Use | Why |
|---|---|---|
| The caller's | `scoped()` / `withScopedDb` | The policy is the point. |
| An owner's, read by their delegate | `withDelegateContext(owner, delegate)` | `current = owner, real = delegate` is the identity the policies were written for. **No bypass** -- `app.real_user_id` stays true about who is authenticated. |
| A delegate's, read by their owner (or any genuine cross-user sweep) | `withSystemContext` | There is no policy arm for it. Decide authorization *first*, under `scoped()`, and let only the minimum out. |

Reaching for `withSystemContext` when the middle row applies is the easy wrong answer: it works, so nothing complains, and the bypass fence widens by one.

`src/delegation/rls-context-smoke.spec.ts` is the guard, and its shape is worth copying: per-service specs mock `withScopedDb` away and are structurally incapable of seeing this class of bug, so that suite runs the **real** `withScopedDb` at `RLS_MODE=enforce`, records the ambient context at each repository call, and asserts the ordered sequence of identities plus the emitted `set_config` statements. Asserting the order is what proves the fence: the authorization read must appear under the caller's own identity *before* any bypass opens.

## A joint account is only shared where somebody remembered to share it

`transaction.userId = :userId` is the wrong ownership predicate for any own-context read a delegate can reach: a jointly shared account's rows belong to the **owner**, so the grantee matches none of them and the endpoint returns a confident empty answer (the register had joint scope on day one; the summary, grouped totals and monthly totals beside it did not).

Own-context reads resolve their scope through `TransactionsController.resolveOwnContextJointScope` (the accounts controller's equivalents are `jointAccountIdSetFor` for list reads and a `NotFoundException` fallback through `jointAccessFor` for `:id` reads, as on `getBalance` and `getBalanceForecast`). Filtered to exactly one joint account, the query runs as the owner so every derived value is byte-identical to the owner's own view; anything else keeps the caller's scope and widens it by the already-authorized joint ids, never by raw request input. The widened predicate is written once per service (`registerScope`, `analyticsScope`). An endpoint that deliberately stays owner-only says so where it is skipped (`tag-key-breakdown` does: tags are personal).

## A stored price says which session it belongs to, not which minute it was fetched

`security_prices` holds one row per trading day, and that row is the **session**: official close, full-day volume, high/low, adjusted close. A live quote (`regularMarketPrice`) is a true statement about 14:42 and a false one about the day -- and the frontend auto-refreshes quotes through the session (`usePriceRefresh`), so a row for today exists long before the day is over. Three rules, each with a test:

- **"Has a price for today" is not "the day is settled".** Ask whether the *session* has ended -- `isSessionSettled` (`providers/settled-bar.util.ts`), on the market's own clock in the market's own zone, from the stored `market_timezone` / `market_close_time`. Never from the presence of a row or the server's clock.
- **The closing job settles the day from the daily bar, after the quote refresh.** `settleDailyBars` re-reads a bounded recent window and upserts the bars whose sessions have ended, so a missed run or provider outage repairs itself. The quote is what a still-open market can offer; the bar is what the finished session did, and the bar wins.
- **A calculated column needs a writer on the recurring path.** `adjusted_close` was populated only by the on-demand backfill, and because `loadPriceSeries` picks one basis per series and keeps only adjusted rows, that silently truncated every return series at the last backfill date. The quote path fills `adjusted_close` with the close it is writing -- definitional for the newest session (adjustment factor 1), but only where the series already carries an adjusted close; both conditions live in the `CASE ... EXISTS` inside the statement (an MSN-priced series given exactly one adjusted close flips `bool_or(...)` and collapses to that row).

A daily bar is not a quote, so settling clears `quoted_at`; and a `source = 'manual'` row is a user correction no provider write may overwrite -- the quote path and `bulkUpsertPrices` both carry `WHERE security_prices.source IS DISTINCT FROM 'manual'`, and the quote path treats the refusal as a successful no-op that reads back the winning row. The honest cost: a manual row on a provider-priced security has no adjusted close, so that day stays out of the adjusted series.

Related: **a bar's timestamp is the instant its session opened, so the day it belongs to is the exchange's calendar day.** `barDate` reads it in `meta.exchangeTimezoneName`, falling back to UTC; `setHours(0,0,0,0)` made `price_date` a function of the container's timezone.

## A payload coarser than daily is a different series, not a sparse one

A provider asked for a long range may answer weekly or monthly bars; written into a daily table they overwrite the real daily rows on those dates, and under the one-basis-per-series rule monthly rows carrying adjusted closes made `loadPriceSeries` *drop every daily row around them*. `assertDailySeries` (`providers/daily-spacing.util.ts`) is the one test, and it runs inside `bulkUpsertPrices` -- not in its four callers, because a guard one caller forgets is not a guard (each caller already reports a failed security, so the throw surfaces as "this one did not update"). The threshold, the median (never the mean -- one long exchange closure must not make a daily series look weekly) and the minimum sample size live there too; `daily-spacing.util.spec.ts` fails on a second copy of any of them under `securities/`.

## History depth is a request, not a property of the holding

`backfillSecurityHoldingPeriod` clips its write to the first transaction date -- right for position valuation, wrong for backtests, the GEM report and performance comparison, which need prices from before the user bought. Both backfill endpoints take `range` (`BackfillPricesQueryDto`); supplying it means fetch that range **and** store all of it, omitting it keeps the clipped default. When adding a caller, decide which question it asks -- "what is this position worth over the time I held it" or "what did this instrument do" -- rather than reaching for `max`; the clip exists so an untouched catalogue does not accumulate decades of prices nobody reads.

## A money value carries the currency it was calculated into

Not the currency of the account it is filed under. `InvestmentTransaction.exchangeRate` converts a trade into the *settlement* account's currency (the funding account when named, else the brokerage's linked cash account), so a PLN brokerage funded from EUR holds a EUR cost basis. The amount and its currency travel together (`ReplayedLot.currencyCode`), and a consumer compares that field against what it is reporting in. A mismatch is **unknown**, not a conversion -- today's rate answers today's question, not the acquisition's -- and two acquisitions settled in different currencies cannot be summed at all.

## A fallback answers only the question it was asked

A lookup that fails is a fact about *that* lookup. A stale scenario id says nothing about the user's other scenarios, so an empty report hardcoding `strategies: []` made a second claim without looking -- and took away the switcher that was the only route back. Fall back to the default rather than to nothing, and fill the surrounding fields from a real read. And a retry has to change something: recursing with the same id after establishing the id is gone is a comment claiming a recovery that cannot happen.

## Backup and restore

`docs/backup-restore-contract.md` is the contract: what a backup promises, what it deliberately does not, and the known gaps. Read it before changing anything under `src/backup/`. Three things a test enforces:

- **A new foreign key between two backed-up tables** must keep `src/backup/restore-plan.spec.ts` green (it parses every FK out of `database/schema.sql` and fails on ordering/self-reference problems).
- **A new column referencing `currencies(code)`** must keep `src/currencies/currency-references.spec.ts` green -- both SQL functions and the TypeScript constant.
- **A new table** must be exported or listed in `INTENTIONALLY_EXCLUDED_TABLES` with a reason, and classified in the support backup rules.

**A file's name is its identity, so anything that decides whether it may be deleted has to be in the name.** An automatic backup that could not include every attachment is published as `monize-backup-partial-<date>` in its own retention tier, and the name is chosen *after* the export from what the export found -- `writeFileAtomic` replaces a final name by design, so a partial artifact written under the `daily-` name had already destroyed that day's complete copy before any status column could say so. State beside the file cannot govern a decision the write has already made; the durable copy of the fact goes *inside* the document (`completeness` in the envelope).

**Nothing in the export path may hold a whole table, a whole artifact, or a whole attachment set.** Rows come through the cursor in `src/backup/export-cursor.ts`, the document is serialised a row at a time under the chunk budget in `export-json-stream.ts`, and an object store is opened one object at a time. A `manager.query` for an export table, a `JSON.stringify` over an array of rows, or an array of base64 built before serialising are each the same defect (issue #1070). The guards in `src/backup/export-streaming.spec.ts` assert the ordering (batched fetches, loads interleaved with writes, reads that stop when the client does) rather than the memory.

**`verifyAuthentication` is the one refusal deliberately not first.** An OIDC restore is authorized by a single-use `OidcReauthService` artifact, and the round trip that mints one loses the user's file selection -- so the restore validates everything free (decrypt, decompress, envelope) *before* spending it. It still precedes every write. Do not reorder it forward, and do not reorder it backward past a `DELETE FROM`; section 5 of the contract has the reasoning, and `backup.service.spec.ts` pins both edges.

**A value encrypted with server configuration cannot travel in a document.** `ai_provider_configs.api_key_enc` is ciphertext under `AI_ENCRYPTION_KEY`, which is not in the backup and must not be. Exported verbatim it restored onto any other instance *populated and unreadable* -- every "is a key configured?" check said yes and only the AI calls failed. The key is decrypted on the way out and re-encrypted on the way in (`ai-provider-key-transport.ts`), both directions in one file because the field name and fallbacks are one contract. The cost -- the artifact holds the credential in plaintext -- is stated in `docs/backup-restore-contract.md` §1, logged by the export, and why the support backup drops the table. Anything else stored under server-side configuration gets the same treatment, or is excluded.

### `BackupService` is a facade; put new code in the component that owns it

Issue #1092 split the 2,600-line original into `BackupExportService`, `BackupRestoreService`, `BackupAttachmentTransferService` and `BackupRestoreDatabaseService`, with the file format in `backup-format.ts` and the table list in `export-table-queries.ts`. Section 0 of the contract says which owns what. `BackupService` is one delegation per method and holds no `DataSource` and no storage provider; `src/backup/module-shape.spec.ts` fails on the dependency as well as the line count, and its grandfather list may only shrink.

**A source-scanning guard names a file, so a split disarms it silently.** Four guards pointed at `backup.service.ts` and would have gone on passing while scanning code that had moved out from under them. A scan whose subject is "wherever this appears" walks the directory (`backupModuleSources()` in `backup.service.spec.ts` is the pattern); one that must name a file throws when its marker is missing rather than returning an empty match set. Grep `readFileSync(` under the module you are splitting before you split it.

## Testing Conventions

Mock repositories use `Record<string, jest.Mock>`; tests use `Test.createTestingModule` with mocks injected via `getRepositoryToken()`. E2E tests live in `test/` with helpers under `test/helpers/` (`auth-helper.ts`, `test-database.ts`, `test-factories.ts`).

### A mock must return what the real collaborator returns

`Record<string, jest.Mock>` is fine for a repository, whose surface the driver defines. For **one of our own services**, type the double -- `jest.Mocked<TheService>`, or a `Partial<jest.Mocked<T>>` cast once -- so `tsc` rejects a return shape the real method cannot produce. Untyped, a mock quietly becomes fiction, and the branch that reads that fiction is green and unreachable:

- **A shape the driver never returns.** A TypeORM insert result mocked as `{ generatedMaps: [] }` made an entire lost-the-race path testable, tested and dead.
- **A signature that moved.** A method growing from `Promise<boolean>` to `Promise<string | null>` leaves `mockResolvedValue(true)` behind it -- still truthy, still passing. When you change a return type, grep its mocks in the same commit.

### Fixtures are claims about production data

`docs/testing-contract.md` is the shared list of adversarial inputs to choose from. A fixture is evidence only if the code that writes the real data could have written it -- check the producer's sampling, nullability, and format guarantees before adding one. `docs/financial-calculation-contract.md` section 8.3 has the full rule.

### Do not trust a suite that stayed green

Changing what a service computes and seeing every test pass means the change is a no-op or the suite has a hole -- `docs/financial-calculation-contract.md` sections 8.1 and 8.2. Establish which before moving on, and break each new invariant on purpose once to confirm its test actually fails.

## Internationalization (i18n)

Server-rendered strings (exception messages, email copy) are localized via `nestjs-i18n`. Wrap exception messages in `tr(key, fallback, args)` (`src/i18n/translate.ts`), which resolves against the request locale and returns the English `fallback` outside an HTTP context. Render emails with `emailTranslator(i18n, recipientLang)` (`src/i18n/email-translator.ts`) so copy matches the recipient's stored locale. Catalogs live in `src/i18n/locales/{locale}/*.json`; the authoritative locale list is `SUPPORTED_LOCALE_CODES` in `src/i18n/config.ts` (root `CLAUDE.md` enumerates them) -- keep in sync with the frontend's. The `en-*` entries are lean regional variants (`LOCALE_BASES`), falling back to `en` per key. Adding or changing a string means updating every locale (`src/i18n/locales.parity.spec.ts` fails otherwise), then `npm run i18n:pseudo`. Full flow: `src/i18n/README.md`.

## Every line in the log has the same shape

`[Nest] pid - date LEVEL [Context] message`, produced by the NestJS `Logger` -- including the lines written before the app exists: `db-init`, `db-migrate`, `db-demo-check` and the seeders each construct `new Logger("<Context>")`. Backend `src/` bans `console` outright (`no-console` in `eslint.config.mjs`); the only exception is `oauth/oidc-provider-log-bridge.ts`, which must hold the real console methods to forward non-provider output. `docker-entrypoint.sh` prints nothing itself -- each step logs for itself. `src/startup-logging.spec.ts` scans for both mistakes and for `console` in any pre-boot script.

## OAuth / OIDC provider

**A page whose form submission must redirect off-origin needs its own CSP.** Helmet's app-wide `form-action 'self'` is enforced by Chrome against every redirect hop after a form submit, so the OAuth consent POST's final cross-origin hop to the client's `redirect_uri` was silently cancelled -- server logs `authorization.success`, browser parked on the consent form. The interaction controller sets a per-page `form-action 'self' https:` (`setInteractionPageHeaders`); the redirect_uri is per-client and dynamic, so it cannot be enumerated. Do not loosen the global Helmet `form-action` -- only this page needs it.

`node-oidc-provider` prints `oidc-provider NOTICE:`/`WARNING:` lines with bare `console.info`/`console.warn` and exposes no logger hook, so `oauth/oidc-provider-log-bridge.ts` -- installed at the top of `main.ts` -- re-routes exactly those lines to a `[OidcProvider]` logger. That fixes only the formatting: every such notice means a config option was left at its default, so fix the config. In particular, `ttl` needs an explicit number for every artifact the provider can issue (`AccessToken`, `AuthorizationCode`, `IdToken`, `RefreshToken`, `Grant`, `Interaction`, `Session`); the guard in `src/oauth/oauth-provider.service.spec.ts` fails when one is missing.

## Money investment mapping is finalized after both mappers run

`mapInvestments` cannot know whether `mapTransactions` will preserve or collapse a cash split. Reconcile generated investment companions only after cash-source mapping: when a redemption remains embedded, its preserved sibling is the interest record, so the generated companion and mutual link must not be written as a second representation of that income.

## Automatic backups are an operator setting, not a user preference

Auto-backup endpoints live on `AutoBackupController`, whose class-level `@Roles("admin")` is the whole access rule -- a new endpoint there is admin-only automatically. Manual export/restore (caller's own data) stays on `BackupController` for everyone.

`AutoBackupService.enrollManagedUsers` runs at the top of the hourly cron and enrolls every other user on the deployment defaults -- without it a non-admin would silently have no backups. It reconciles rather than seeds: drifted rows are written back to the defaults, unchanged ones are not written, and `lastBackup*`/`nextBackupAt` are left alone so enrollment never re-triggers a backup.

Backups are encrypted with the user's own password. Local-auth accounts have it captured at the moment they type it (`rememberLoginPassword` from registration, login and change-password). OIDC accounts set a dedicated one in Settings (`setBackupPasswordForOidcUser`) or go unencrypted; `getStatus().manageable` gates that UI section, and both management methods refuse a local-auth caller. A stored copy is checked against the account's current password hash before use (`resolveBackupPassword`) -- three outcomes, not two: nothing stored (write plaintext), usable password (encrypt), stored-but-undecryptable (refuse -- silently downgrading previous encrypted backups is worse than failing).

## Cron Jobs

Cron jobs use `@Cron()` from `@nestjs/schedule` and run **in the API process** (`ScheduleModule.forRoot()` in `app.module.ts`; on k8s with multiple replicas, every replica fires every cron). Full schedule: `docs/cron-jobs.md`, or grep `@Cron(`.

Every `@Cron` handler is an out-of-request entry point, so its body must seed its own RLS context (tasks C2-C4): the cross-user fan-out under `withSystemContext`, each per-user body under `withUserContext(userId)`. A handler that reaches the DB with no ambient context throws in every `RLS_MODE`, including `off` -- the per-module `rls-context-smoke.spec.ts` specs are the pattern for proving a cron runs clean.

### Cleanup somebody is blocked on belongs on the request path

Before choosing an interval, ask what the stale row *does* while it sits there. Only untidy: a schedule is the whole answer. But if it **refuses the user's next request** (a slot, a lock, a uniqueness guard), the interval is a lockout the user cannot end. Run the cleanup inside the transaction of the request about to be refused, scoped to that caller, and leave the cron as a cross-user backstop. `MnyImportJobService` is the worked example: `reapStaleJobsForUser` runs in `create` and the poll's `findOne`, so a dead import clears within one 1.5s poll, and `reapStaleJobs` dropped to hourly.

Two things that path must get right, both tested: the staleness predicate is **one exported constant** used by the reap and negated by the advisory pre-check (an advisory check that still counts what the reap would clear reinstates the lockout through the back door); and a per-user cleanup whose predicate is a disjunction needs its own parentheses inside `user_id = $n AND (...)` -- assert the composed clause, not an `"AND ("` prefix.

### Deciding a worker is dead does not stop it -- revoke, do not merely record

A reaper's conclusion can be wrong in the direction that costs money: a merely *blocked* worker gets written off, wakes up, and finishes -- and if the reap also advertised a retry, the file lands twice. So an attempt gets an identity, not just a status: `import_jobs.attempt_token` is minted by `claim()`, required by every write that worker makes, and set to NULL by both reaps. The worker's commit checkpoint (`markDataCommitted`) is a fenced compare-and-set on that token and the **last statement of the transaction that wrote the rows**, so a zero-row result throws and rolls all of them back -- one statement later would be a check after the commit (see "Rejection happens before the write").

Three parts, each a separate way to get it wrong:

- **A status check is not a fence.** `WHERE status = 'running'` passes for a job reaped and re-claimed by a different attempt. Compare the token.
- **A fence the other binary does not know about is not a fence.** During a rolling deployment the previous release's checkpoint names no token, so the rule lives in the database: migration 145's `BEFORE UPDATE` trigger refuses a false -> true `data_committed` on a non-`running` job, from either binary. Deliberately not "and has a token": an old worker's normal state is `running` with a NULL token.
- **Terminal states are monotonic.** `complete()` and `fail()` are compare-and-set on `(status, attempt_token)` and return whether they took; the caller must read that boolean (logging "completed" after a refusal contradicts the reaper's line, with the false one more visible).

The integration suite installs the trigger via `findTriggerMigrations()` in `test/helpers/rls-setup.ts` -- `synchronize` creates no triggers, so without that step a mixed-version test reports the fence as working while nothing enforces it.
