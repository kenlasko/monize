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

CI runs `test:unit` and `test:integration` (the latter filtered to
`test/integration/*.spec.ts`). Nothing runs `test:e2e`, and `tsconfig.json`
excludes `test/`, so for over a week four suites did not even compile -- a
namespace `import * as cookieParser` left behind when `main.ts` moved to a
default import. ESLint's glob covers the directory, but that is a type error, not
a lint error. `npm run typecheck` now closes the compile half in CI.

What the compile error was hiding, once removed:

| Suite | State | Why |
|---|---|---|
| `test/payee-detail.e2e-spec.ts` | passes (9 tests) | nothing wrong with it; its coverage was simply absent. This is the spec cited below as what caught the raw-select transformer class of bug |
| `test/payees.e2e-spec.ts` | fails | calls services directly, so there is no request scope; never converted for RLS (`withScopedDb` throws without ambient context) |
| `test/auth.e2e-spec.ts` | fails | `AuthController` gained a `TokenService` dependency its test module does not provide |
| `test/transactions.e2e-spec.ts` | fails | `DelegateTransferMaskInterceptor` gained a `CrossOwnerAccessService` dependency its test module does not provide |

Each is separate rot that accumulated *behind* the compile error: the RLS
conversion, the token-service split and the cross-owner-transfers work each moved
on without these files and nothing complained. Repair them or delete them --
what they must not stay is present, cited, and dead. Do not add `test:e2e` to CI
until the three are fixed; it will be red.

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

**Raw selects bypass both transformers.** `getRawOne`/`getRawMany` return driver values, not entity-hydrated ones, so a DATE column comes back as a JS `Date` and a numeric as a string -- regardless of the transformer on the entity. Select a DATE as text in SQL (`TO_CHAR(col, 'YYYY-MM-DD')`) and pass a numeric through `Number()` before it reaches a DTO that declares `string`/`number`. `main.ts` installs a global DATE string parser, which hides the DATE half of this in the running server but not in tests, jobs, or any other process -- so do not rely on it. `payee-detail.service.ts` is the worked example; its `test/payee-detail.e2e-spec.ts` is what caught it, because a unit spec with mocked query builders cannot.

## DTO Conventions

### An optional field with a format validator needs `@ValidateIf`, not just `@IsOptional`

`@IsOptional()` waives validation for `undefined` and `null` only. A text input the user left alone arrives as `""` -- react-hook-form gives the empty string and the form sends it -- so an `@IsUrl` / `@IsEmail` sitting beside `@IsOptional()` still runs on it and rejects it. Because validation fails per *request*, one blank optional field breaks every save from that form, not just the field. Add `@ValidateIf((_o, value) => value !== null && value !== "")` for a column that is nullable, so a blank clears it. `src/common/optional-url-dto.spec.ts` sweeps every URL-validated DTO property and fails on a new one; a field whose column is NOT NULL belongs on that file's exemption list with the reason, not silently rejecting a blank.

This class of bug is invisible to unit tests, which construct payloads by hand and never send what the form sends. It surfaces in E2E or in production.

### A request-supplied array declares an upper bound

Every `@IsArray()` DTO property carries `@ArrayMaxSize(n)` beside it -- an unbounded array turns any per-element work downstream (one UPDATE per id inside a transaction) into a denial-of-service lever, and CodeQL flags the loop as `js/loop-bound-injection` (CWE-834). `src/common/array-bound-dto.spec.ts` sweeps validator metadata and fails on a new unbounded property; properties older than the guard are grandfathered there, and that list may only shrink. Relatedly, never use a request value's `.length` as a loop bound inside a `withScopedDb` callback: CodeQL cannot track an outer `Array.isArray` guard through the closure, so iterate `for (const [i, v] of xs.entries())` instead of `for (let i = 0; i < xs.length; i++)`.

## Rejection happens before the write

A check capable of refusing a command belongs inside the transaction that performs it, and under the same lock when concurrency is in play. A service that mutates, commits, and returns a success-shaped value for a caller to reject afterwards has already done the thing the `409` says it did not do.

Give the operation the caller's precondition as a parameter -- the expected owner, scenario or revision -- and let it refuse before writing. Return the refusal distinguishably: "no such row", "not yours" and "done" are three answers, and folding two into `null` makes the caller guess. Tests assert the rejected response **and** the stored state; see `docs/financial-calculation-contract.md` section 7.

## A predicate that decides which row counts is written once

When "is this row the one we mean" takes more than one clause -- current
algorithm version *and* matching configuration fingerprint, say -- name it and
call it. Written out at each site it drifts, and the drift is invisible: the
GEM signal service spelled the condition out four times, and the fourth asked
only whether the *date* had an answer. A date can hold two rows once a unique
key carries a version, so a superseded row could win the lookup and be stored
as the next period's predecessor -- a wrong decision, persisted, from rules no
longer in force.

The same goes for the `where` clause that reads such a row back. A key that
grew a column selects more than one row now; a query still written against the
old key returns whichever the database offers first. Grep for reads of a
unique key in the migration that widens it.

## A read about somebody else needs somebody else's identity

`users_self` exposes exactly two rows to a session: `app_current_user_id()` and
`app_real_user_id()`. So **any query keyed on another person -- by their id, or
worse, by their email -- returns zero rows from the caller's own scope**, and
under `RLS_MODE=enforce` that empty result is what the caller gets back. It does
not raise, it does not log, and "no rows" is the same shape as "no such user".
`AuthService` finds a login by email only because it runs pre-identity, under a
bypass; `DelegationService.delegateEmailExists` ran the identical `where` under
`scoped()` and told owners that an account which demonstrably logs in did not
exist. `listDelegates` had the same defect as a `relations: ["delegate"]` join,
`revokeDelegate` decided whether to delete a login from three counts the
database had refused to answer, and the delegate 2FA gate concluded that no
owner requires 2FA.

Before writing a query, ask whose row it is. There are three answers, not two:

| Whose row | Use | Why |
|---|---|---|
| The caller's | `scoped()` / `withScopedDb` | The policy is the point. |
| An owner's, read by their delegate | `withDelegateContext(owner, delegate)` | `current = owner, real = delegate` is the identity `users_self` and `user_preferences_isolation` were written for. **No bypass** -- the delegation is an identity the policies already understand, and `app.real_user_id` stays true about who is authenticated. |
| A delegate's, read by their owner (or any genuine cross-user sweep) | `withSystemContext` | There is no policy arm for it. Decide authorization *first*, under `scoped()`, and let only the minimum out. |

Reaching for `withSystemContext` when the middle row applies is the easy wrong
answer: it works, so nothing complains, and the bypass fence widens by one.

`src/delegation/rls-context-smoke.spec.ts` is the guard, and the shape is worth
copying. Per-service specs mock `withScopedDb` away, which makes them
structurally incapable of seeing this class of bug -- so that suite runs the
**real** `withScopedDb` at `RLS_MODE=enforce`, records the ambient context at
each repository call, and asserts the ordered sequence of identities plus the
`set_config` statements actually emitted. Asserting the order is what proves the
fence: the authorization read must appear under the caller's own identity
*before* any bypass opens.

## A joint account is only shared where somebody remembered to share it

`transaction.userId = :userId` is the wrong ownership predicate for any
own-context read a delegate can reach: a jointly shared account's rows belong
to the **owner**, so the grantee matches none of them and the endpoint returns
a confident empty answer rather than an error. That is how the register got the
joint scope on day one while the summary, grouped totals and monthly totals
beside it did not -- a joint account's detail page drew a full balance chart
with an empty cash flow, no top categories and no top payees under it.

Own-context reads resolve their scope through
`TransactionsController.resolveOwnContextJointScope` (the accounts controller's
equivalents are `jointAccountIdSetFor` for list reads and a `NotFoundException`
fallback through `jointAccessFor` for `:id` reads, as on `getBalance` and
`getBalanceForecast`). Filtered to exactly one joint account, the query runs as
the owner so every derived value -- category descendant expansion, the search
term parsed in the user's number/date format, the money math -- is byte-identical
to the owner's own view; anything else keeps the caller's scope and widens it by
the already-authorized joint ids, never by raw request input. The widened
predicate itself is written once per service (`registerScope`,
`analyticsScope`).

An endpoint that deliberately stays owner-only says so where it is skipped:
`tag-key-breakdown` does, because tags are personal and a joint row never
carries the grantee's.

## A money value carries the currency it was calculated into

Not the currency of the account it is filed under. `InvestmentTransaction.exchangeRate`
converts a trade out of the security's currency and into the *settlement*
account's -- the funding account when the row names one, otherwise the
brokerage's linked cash account -- so a replayed cost basis is denominated
there, and a PLN brokerage funded from EUR holds a EUR basis. A consumer that
assumed the holding account's currency set that against a PLN market value and
reported the exchange rate as profit, then taxed it.

So the amount and its currency travel together (`ReplayedLot.currencyCode`),
and a consumer compares that field against what it is reporting in. A mismatch
is **unknown**, not a conversion: today's rate answers today's question, and
the acquisition happened at its own. Two acquisitions that settled in
different currencies cannot be summed at all.

## A fallback answers only the question it was asked

A lookup that fails is a fact about *that* lookup. A stale scenario id that no
longer resolves says nothing about the user's other scenarios, so an empty
report hardcoding `strategies: []` made a second claim -- that there are none
-- without looking, and took away the switcher that was the only route back.
Fall back to the default rather than to nothing, and fill the surrounding
fields from a real read.

And a retry has to change something. `getReport` recursed with the same
strategy id after establishing that the id was gone, so every attempt took the
identical path: a retry whose inputs are unchanged is a comment claiming a
recovery that cannot happen.

## Testing Conventions

Mock repositories use `Record<string, jest.Mock>`; tests use `Test.createTestingModule` with mocks injected via `getRepositoryToken()`. E2E tests live in `test/` with helpers under `test/helpers/` (`auth-helper.ts`, `test-database.ts`, `test-factories.ts`).

### A mock must return what the real collaborator returns

`Record<string, jest.Mock>` is fine for a repository, whose surface the driver defines. For **one of our own services**, type the double -- `jest.Mocked<TheService>`, or a `Partial<jest.Mocked<T>>` cast once -- so `tsc` rejects a return shape the real method cannot produce.

Untyped, a mock quietly becomes fiction, and the branch that reads that fiction is green and unreachable. Two ways it happens:

- **A shape the driver never returns.** A TypeORM insert result mocked as `{ generatedMaps: [] }` made an entire lost-the-race path testable, tested and dead: the real driver signals a conflict elsewhere, so the branch never ran in production and its tests never ran anything else.
- **A signature that moved.** A service method growing from `Promise<boolean>` to `Promise<string | null>` leaves `mockResolvedValue(true)` behind it -- still truthy, still passing, still describing a contract nothing has any more. When you change a method's return type, grep its mocks in the same commit.

### Fixtures are claims about production data

`docs/testing-contract.md` is the shared list of adversarial inputs to choose from. A fixture is evidence only if the code that writes the real data could have written it. Before adding one, look at the producer: the query's sampling, whether the column is nullable, whether the format guarantees what the fixture assumes. A price series three points a quarter apart proves nothing about code reading daily closes, and weightings that always sum to 1 never exercise the remainder the storage format allows. `docs/financial-calculation-contract.md` section 8.3 has the full rule.

### Do not trust a suite that stayed green

Changing what a service computes and seeing every test pass means the change is a no-op or the suite has a hole -- see `docs/financial-calculation-contract.md` sections 8.1 and 8.2. Establish which before moving on, and break each new invariant on purpose once to confirm its test actually fails.

## Internationalization (i18n)

Server-rendered strings (exception messages, email copy) are localized via `nestjs-i18n`. Wrap exception messages in `tr(key, fallback, args)` (`src/i18n/translate.ts`), which resolves against the request locale and returns the English `fallback` outside an HTTP context (jobs, schedulers, tests). Render emails with an `EmailT` translator (`emailTranslator(i18n, recipientLang)` from `src/i18n/email-translator.ts`) so copy matches the recipient's stored locale rather than the request's. Catalogs live in `src/i18n/locales/{locale}/*.json`, one folder per supported locale; the authoritative locale list is `SUPPORTED_LOCALE_CODES` in `src/i18n/config.ts` (root `CLAUDE.md` enumerates them) -- keep it in sync with the frontend's. The `en-*` entries are lean regional variants (declared in `LOCALE_BASES`): they hold only the keys that differ from `en` and fall back to it per key. Adding or changing a string means updating every locale -- the parity test `src/i18n/locales.parity.spec.ts` fails otherwise -- then regenerating the pseudo-locale with `npm run i18n:pseudo`. Full contributor flow: `src/i18n/README.md`.

## Every line in the log has the same shape

`[Nest] pid - date LEVEL [Context] message`, produced by the NestJS `Logger`.
That includes the lines written before the app exists: `Logger` works outside an
application context, so `db-init`, `db-migrate`, `db-demo-check` and the seeders
each construct `new Logger("<Context>")` rather than calling `console`. Backend
`src/` bans `console` outright (`no-console`, `eslint.config.mjs`); the only
exception is `oauth/oidc-provider-log-bridge.ts`, which has to hold the real
console methods in order to forward everything that is not a provider notice.

`docker-entrypoint.sh` prints nothing itself. A shell `echo` is the one line in
the container log with no timestamp, level or context, and an inline `node -e`
blob cannot reach the `Logger` without restating its format -- so each step logs
for itself and the entrypoint just runs the steps.
`src/startup-logging.spec.ts` scans for both mistakes and for a `console` call in
any pre-boot script.

## OAuth / OIDC provider

`node-oidc-provider` prints its own `oidc-provider NOTICE:`/`WARNING:` lines with bare `console.info`/`console.warn`, outside the Nest `Logger`. The library exposes no logger hook, so `oauth/oidc-provider-log-bridge.ts` -- installed at the top of `main.ts`, before anything can instantiate the provider -- re-routes exactly those lines to a `[OidcProvider]` logger and passes any other console output through untouched. That fixes the formatting only: every such notice still means a config option was left at its default, so fix the config rather than treating the bridge as the answer. In particular, `ttl` needs an explicit number for every artifact the provider can issue (`AccessToken`, `AuthorizationCode`, `IdToken`, `RefreshToken`, `Grant`, `Interaction`, `Session`); the guard test in `src/oauth/oauth-provider.service.spec.ts` fails when one is missing.

## Automatic backups are an operator setting, not a user preference

The auto-backup endpoints live on `AutoBackupController`, whose class-level
`@Roles("admin")` is the whole access rule -- put a new endpoint there and it is
admin-only without anyone remembering to say so. Manual export/restore, which
touches only the caller's own data, stays on `BackupController` for everyone.

Every other user is enrolled on the deployment defaults by
`AutoBackupService.enrollManagedUsers`, which runs at the top of the hourly
cron: nobody but an admin can switch the feature on, so without it a non-admin
would silently have no backups. It reconciles rather than seeds -- a row that
has drifted is written back to the defaults, an unchanged one is not written at
all, and `lastBackup*`/`nextBackupAt` are left alone so enrollment never
re-triggers a backup.

Backups are encrypted with the user's own password. For a local-auth account
the server only ever holds that in plaintext at the moment they type it, so
`rememberLoginPassword` captures it from registration, login and
change-password and nothing asks them to configure anything. An OIDC account
has no password of ours, so those users set a dedicated one in Settings
(`setBackupPasswordForOidcUser`) or go unencrypted; `getStatus().manageable` is
what the UI gates that section on, and both management methods refuse a
local-auth caller rather than accepting a change the next login would undo.

A stored copy is checked against the account's current password hash before it
is used (`resolveBackupPassword`) -- encrypting with a password the user has
since changed produces a file that looks like a backup and cannot be opened.
That resolution has three outcomes, not two: nothing stored (write plaintext), a
usable password (encrypt), and stored-but-undecryptable (refuse, because the
previous backups are encrypted and silently downgrading is worse than failing).

## Cron Jobs

Cron jobs use `@Cron()` from `@nestjs/schedule` and run **in the API process** -- `ScheduleModule.forRoot()` is registered in `app.module.ts`; there is no separate scheduler process (on k8s with more than one backend replica, every replica fires every cron). For the full schedule, see `docs/cron-jobs.md` or grep `@Cron(`.

Every `@Cron` handler is an out-of-request entry point, so its body must seed its own RLS context (tasks C2-C4): the cross-user fan-out under `withSystemContext`, each per-user body under `withUserContext(userId)`. A handler that reaches the DB with no ambient context throws `DB access outside request/user/system context` in every `RLS_MODE`, including `off` -- the per-module `rls-context-smoke.spec.ts` specs are the pattern for proving a cron runs clean.
