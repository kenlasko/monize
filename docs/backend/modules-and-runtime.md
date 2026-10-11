# Backend: modules, boot, environment and logging

Module wiring (require cycles, test stubs), the global providers and `main.ts` setup, environment knobs and whose resource they configure, logging shape, the OIDC provider, CodeQL and the demo login. Read this before adding a module edge, an environment variable, a log line or a boot-time hook.

Paths beginning with `src/`, `test/` or `scripts/`, and layer configuration filenames, are relative to `backend/`; other source paths are relative to `backend/src/`. Explicit repository prefixes are preserved. `backend/CLAUDE.md` is the short index; this document is where the reasoning lives.

## An edge on a require cycle is deferred, or it is `undefined`

Module and service files are CommonJS, so a circular `import` hands the second
file a half-filled `exports`: the `@Module({ imports: [...] })` array holds an
`undefined`, or a constructor's reflected parameter type does, and Nest refuses
to build the application -- "Nest cannot create the NetWorthModule instance...
index [1] ... is undefined", or "can't resolve dependencies of the
ScheduledTransactionsService (AccountsService, TransactionsService, ?, ...)".

**Whether it bites depends on which file `require` reached first**, so the same
code boots from one entry point and dies from another: `AppModule` from the
compiled server entry point, `TransactionsModule` from an integration
`RootTestModule`,
whichever module a spec happens to import. Issue #1247 shipped green through
`npm run test:unit` and took out the integration suite, all four E2E shards and
Lighthouse.

The rule is exact and it is checked: an `imports` entry, or a constructor
parameter, whose class can reach the declaring file back through `import`
statements must be `forwardRef(() => X)` / `@Inject(forwardRef(() => X))`.
`src/module-graph.spec.ts` proves it two ways -- statically over every load order
at once (naming the offending edge), then at runtime from every module file in
turn, walking `imports` and every provider's `design:paramtypes` as Nest reads
them. Reordering imports is not a fix; defer the edge.

## A stub standing in for a real module inherits its export list

`test/helpers/integration-setup.ts` replaces `ScheduledTransactionsModule` with
a stub, so that stub's `exports` are a claim about the real module. It derives
them from `Reflect.getMetadata("exports", ScheduledTransactionsModule)` rather
than restating them: a hand-written copy keeps compiling until a consumer of the
newly added export appears, and then eighteen suites fail somewhere else
entirely ("argument ScheduledOccurrenceService at index [5] is available in the
NotificationsModule module").

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

## A `@Res()` handler sends the response and returns nothing

`ClassSerializerInterceptor` is registered app-wide, so it is handed whatever
every handler returns -- including a handler that took the raw response with
`@Res()` and whose return value Nest itself ignores. `return res.json(payload)`
evaluates to the Express `Response`, and `isObject` is true of it, so the
interceptor calls `classToPlain` on the live HTTP response.

class-transformer walks own enumerable properties and *invokes* the function
values it meets. The reachable graph from a response is `res` -> `socket` ->
`socket._events` -> Node's own HTTP listeners (`socketOnError`, and the rest of
the set `_http_server` installs per connection), which it then calls with a plain
object as the receiver. The first one throws (`this.removeListener is not a
function`), and by then the walk has already cleared the socket's `_httpMessage`
back-reference. When the response -- long since flushed -- emits `finish`,
`ServerResponse.detachSocket` fails its internal assertion and the process exits
with `ERR_INTERNAL_ASSERTION`, which no filter or `try`/`catch` can reach.

The symptom is therefore a correct reply followed by a dead backend: the client
sees the payload, then the container restarts. Five sites had the shape, three of
them on the unauthenticated auth surface, and the one on the 2FA branch of
`POST /auth/login` locked every account with 2FA enabled out of the product.

The rule:

- Send, then return nothing: `res.json(payload); return;`, never
  `return res.json(payload)`, and never `return res`.
- Declare the handler `Promise<void>` where you are touching one, so `tsc`
  refuses the shape instead of a scan reporting it.
- `backend/src/common/res-handler-return.guard.spec.ts` scans every file that
  binds `@Res()` and fails on a `return` of that parameter. It derives the
  parameter's name per file rather than assuming `res`, so a `fetch` result named
  `response` elsewhere is untouched.

A related trap this does not cover: the interceptor runs on a handler's return
value *after* the handler has replied, so any exception raised there reaches
`GlobalExceptionFilter` with the response already sent. An
`uncaughtException` handler that swallows `ERR_INTERNAL_ASSERTION` treats that as
noise; `main.ts` had one, gated to non-production, and the E2E stack runs with
`NODE_ENV=development`, so the crash was invisible everywhere it could have been
caught cheaply and fatal only for users. It is gone, and a crash of this class is
meant to be loud.

## main.ts Setup

- **API prefix:** `api/v1`
- **Body limit:** 10mb (for large QIF file imports)
- **Swagger:** Enabled at `/api/docs` in non-production only
- **DATE column parser:** `pg.types.setTypeParser(1082, val => val)` -- returns DATE columns as strings to prevent timezone-related date shifting
- **Validation pipe:** Global with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`
- **Security:** Helmet (CSP, HSTS, frame-deny), CORS (credentials, configurable origins)
- **Cookie parser:** Required for OIDC state/nonce and auth tokens
- **Trust proxy:** Level 1 (Docker/nginx real client IP)

## A numeric env knob is declared as data, next to its documentation

Coerce every numeric environment variable through `resolvePositiveInt` (`src/common/env-number.util.ts`), never a bare `Number(...)` and never `configService.get<number>(...)` -- the type parameter is an assertion, not a conversion, so the value stays the string `process.env` held and only a mock that returns numbers makes it look otherwise. `SMTP_PORT=465` compared with `=== 465` was false, the transport greeted Gmail's implicit-TLS port in cleartext and the relay closed the socket, which nodemailer reports as `Unexpected socket close` from a timer that names nothing. `src/common/env-number.guard.spec.ts` fails any `get<number>` or `get<boolean>` read; a boolean environment variable is compared as the string it is. `resolvePositiveInt` also separates *absent* from *invalid* so a typo is logged rather than silently running on the default. Where a feature has more than one knob, declare the set as one table of `{ envVar, default, description }` and resolve in a loop (`src/ai/query/query-budgets.ts` is the pattern). `query-budgets.spec.ts` checks `.env.example` in both directions: every declared budget documented with its current default, and no `AI_QUERY_*` line documenting a variable the code does not read.

## An environment variable configures the deployment's own resource, not somebody else's

The AI provider has two owners. `AI_DEFAULT_*` builds the **centrally managed** provider (the operator's, used when a user has configured none, editable nowhere in the UI); everything else in `ai_provider_configs` is a row a *user* created and can edit. So `AI_QUERY_*` sizes the central provider only; a user's provider carries the same five budgets as nullable columns, set in Settings -> AI, defaulting to the built-in numbers -- never to the environment. `resolveQueryBudgetsForConfig` is the single place that decision is made; `AiService.resolveToolUseProvider` hands the caller the configuration alongside the provider, and the transient system-default config is marked `isSystemDefault`.

Before adding an env var for anything a user can also configure, ask which resource it describes -- an operator's ceiling says nothing about a model somebody else is paying for, and the reverse mistake (a per-user knob for the operator's resource) hands out their budget. `query-budgets.spec.ts` holds the split from both sides; a stored value outside the declared range falls back to the documented default rather than being clamped. The bounds live in the same spec table as the defaults, so the DTO (`QueryBudgetFieldsDto`), the migration and the frontend form derive from one place; the form's copy is checked by `frontend/src/lib/ai-query-budgets.contract.test.ts`.

## Every line in the log has the same shape

`[Nest] pid - date LEVEL [Context] message`, produced by the NestJS `Logger` -- including the lines written before the app exists: `db-init`, `db-migrate`, `db-demo-check` and the seeders each construct `new Logger("<Context>")`. Backend `src/` bans `console` outright (`no-console` in `eslint.config.mjs`); the only exception is `oauth/oidc-provider-log-bridge.ts`, which must hold the real console methods to forward non-provider output. `docker-entrypoint.sh` prints nothing itself -- each step logs for itself. `src/startup-logging.spec.ts` scans for both mistakes and for `console` in any pre-boot script.

## OAuth / OIDC provider

**A page whose form submission must redirect off-origin needs its own CSP.** Helmet's app-wide `form-action 'self'` is enforced by Chrome against every redirect hop after a form submit, so the OAuth consent POST's final cross-origin hop to the client's `redirect_uri` was silently cancelled -- server logs `authorization.success`, browser parked on the consent form. The interaction controller sets a per-page `form-action 'self' https:` (`setInteractionPageHeaders`); the redirect_uri is per-client and dynamic, so it cannot be enumerated. Do not loosen the global Helmet `form-action` -- only this page needs it.

`node-oidc-provider` prints `oidc-provider NOTICE:`/`WARNING:` lines with bare `console.info`/`console.warn` and exposes no logger hook, so `oauth/oidc-provider-log-bridge.ts` -- installed at the top of `main.ts` -- re-routes exactly those lines to a `[OidcProvider]` logger. That fixes only the formatting: every such notice means a config option was left at its default, so fix the config. In particular, `ttl` needs an explicit number for every artifact the provider can issue (`AccessToken`, `AuthorizationCode`, `IdToken`, `RefreshToken`, `Grant`, `Interaction`, `Session`); the guard in `src/oauth/oauth-provider.service.spec.ts` fails when one is missing.

## CodeQL runs as default setup, and a suppression annotation closes nothing there

Code scanning on this repository is CodeQL *default setup*, which runs the standard code-scanning suite and never the alert-suppression query -- so a `codeql` bracket annotation in the source does not close an alert on the Security tab. Two of them sat in `password-breach.service.ts` and its spec for months, above the wrong line as well, while the `js/insufficient-password-hash` alerts they named stayed open. An accepted false positive (SHA-1 is what the HIBP k-anonymity protocol hashes with; `fingerprintPublicKey` in `push-config.service.ts` hashes a *public* key, which is not a password hash; `hashToken` in `crypto.util.ts` hashes a high-entropy random token for an equality lookup, which a randomly-salted password hash would make impossible; `pkceChallenge` in `email-receipts/oauth/oauth-state.ts` hashes a random PKCE verifier exactly as RFC 7636 requires) is **dismissed on the Security tab, with its reason**, by someone with security-events write. Touching the flagged line in a PR re-reports the alert as new in that PR and fails its CodeQL check, so a false positive is dismissed first and its file left alone. Prefer a test fixture that carries a known hash over one that recomputes it: the spec now holds SHA-1("password123") as a constant, which proves the protocol against an independent value and gives CodeQL nothing to report. The annotation still goes in, on the line directly above the reported location -- the only line CodeQL's suppression library lets it cover, and for `js/insufficient-password-hash` that is the `.update(...)` call, not the `createHash` statement -- so it takes effect the day the suppression query is added to the analysis. `src/common/codeql-suppression.guard.spec.ts` fails an annotation that follows code on its line, names no query id, sits above a blank or a comment, or sits above the wrong line for a query it knows.

## The demo login is written once

`DEMO_USER_EMAIL` and `DEMO_USER_PASSWORD` live in `src/database/demo-credentials.ts`; the seed, the nightly reset, `db-demo-check` and the demo seeder import them. They are public by design (`.env.example` prints them, the login page pre-fills them), so the Bearer hard-coded-secret finding on that file is an accepted exception in `.github/workflows/ci.yml` -- one, not one per copy. `demo-credentials.spec.ts` fails a second spelling under `src/`, and the client's mirror (`frontend/src/lib/demo-credentials.ts`) is contract-tested against this file from its side.

## `.dockerignore` is not `.gitignore`: a filename glob needs an explicit `**/`

A slashless pattern matches only against the path relative to the build context, so `*.spec.ts` excludes nothing under `src/`. Give every filename glob a leading globstar, including its negation (`!**/.env.example`); `frontend/src/test/dockerignore.test.ts` scans all three files and fails on a bare one.

## Code and schema ship in one image; they do not arrive in one process

`db-migrate` runs at container start and the server after it, so "this build calls a SQL function" and "this database has it" are separate facts; the gap surfaces as `function ... does not exist` behind a generic 500. Every SQL function `src/` calls is declared once in `backend/src/common/db/required-db-functions.ts` with the migration that creates it, and both `main.ts` and `db-migrate` refuse to serve a database missing one. `required-db-functions.spec.ts` holds the list in both directions -- crucially, a function defined in `schema.sql` and mentioned anywhere in `src/` must be registered.

## A day note is the calendar's only write, and it is owner-only by construction

`CalendarModule` (`src/calendar/`) owns `calendar_day_notes`: one free-text note over a RUN of consecutive dates, written and read from the calendar's day panel. `note_date` is the first day of the span and `end_date` the last, inclusive at both ends, so a one-day note has them equal and a vacation is one row rather than nine. The module imports nothing and exports only its own service, because nothing financial reads it -- which is also why a save drops no balance cache and the client keeps it under its own `calendar:` prefix.

Four decisions are load-bearing:

- **Spans of one user never overlap.** The mechanism is the exclusion constraint `ex_calendar_day_notes_user_span` -- `EXCLUDE USING gist (user_id WITH =, daterange(note_date, end_date, '[]') WITH &&)`, which needs the `btree_gist` extension for the equality half. It is what makes "the note covering this day" a question with one answer, and therefore what lets the editor be reached from any day a span touches. The driver reports a collision as SQLSTATE `23P01`, which the service turns into a 409 rather than a 500: the request is well-formed and the state it collided with is one the reader can see and move.
- **The write is one statement, anchored on the day it was made from.** A `WITH target AS (SELECT ... WHERE $2::DATE BETWEEN note_date AND end_date)` CTE resolving the covering row, an `UPDATE ... FROM target` arm and an `INSERT ... WHERE NOT EXISTS (SELECT 1 FROM target)` arm, inside `withScopedDb`, with `userId` from the JWT. Not a convenience: a read followed by a decision would let two saves for the same day interleave between them. Anchoring on the day the panel was showing rather than on the span's first day is what lets one request move either end of a span -- a delete and a create would leave a window where the note does not exist. Two concurrent creates for one day both find no target and both insert; the exclusion constraint refuses the second.
- **A blank body is a 400, never a delete.** Deleting is its own verb. Inferring it from an empty field would make an accidentally cleared textarea destroy the note on save. `DELETE` is idempotent instead, and removes the note COVERING the day named -- whichever of its days that is, because the panel showing the fourth day of a vacation is showing that note. Removing a note from a day that holds none succeeds, because a 404 there describes a state the caller asked for and already has.
- **The routes are not `@AllowDelegate`.** A note is the owner's own writing about their own day; sharing it with a delegate is a separate product decision nobody has made. The decorator is absent rather than unused, so the client hiding the section is not the only thing keeping it private, and `calendar-day-notes.controller.spec.ts` fails if one is ever applied.

`:date` is validated by `ParseCalendarDatePipe` (`common/pipes/parse-calendar-date.pipe.ts`), the counterpart of `ParseUUIDPipe` for a resource keyed by its day: a shape check alone accepts `2100-02-29`, which reaches Postgres as a date literal and fails there as a 500. The span's relationship to that day is `resolveDayNoteSpan` (`src/calendar/day-note-span.ts`), which the DTO cannot express because class-validator cannot see a route parameter: it defaults an absent `startDate` to the day in the URL and an absent `endDate` to the start, and it refuses a backwards span, one longer than `CALENDAR_DAY_NOTE_MAX_SPAN_DAYS + 1` days, and one that does not cover the day it is being written from -- the last because a span that skips the open day would store a note the reader is told they just wrote and cannot see. The body's length is `CALENDAR_DAY_NOTE_MAX_LENGTH` and the span's bound `CALENDAR_DAY_NOTE_MAX_SPAN_DAYS`, both mirrored on the frontend and carried as `CHECK`s on the table; `calendar-day-note.contract.spec.ts` fails when any two of the three copies of either disagree. `GET` asks for spans that OVERLAP its range rather than starting inside it, or the middle of a vacation would come back unmarked on the month it runs through. The table is in the RLS **Direct** bucket and needs no entry in any map in `docs/row-level-security-contract.md` -- the uniform policy covers it, shipped with its own `ENABLE` in its own migration.

## Environment

Key env vars (see `.env.example` for full list):
- `JWT_SECRET` -- required, minimum 32 chars. `backend/src/common/jwt-secret-policy.ts` holds the rule in two severities, read by every caller through `assessJwtSecret`: missing or shorter than 32 is **fatal** (`jwtSecretFatalProblem`, refused by `checkClusterBoot` and `JwtStrategy`); long enough but a published placeholder, built around a placeholder phrase, fewer than 8 distinct characters or one repeated unit is **weak** (`jwtSecretWeakness`) and boots, reported by the boot warning (`logJwtSecretStatus`), the weekly `JWT_SECRET_WEAK` admin system alert and the admin-only banner behind `GET /admin/deployment-status`. Weak is not refused because replacing it has consequences an operator must plan (below)
- `ENCRYPTION_KEY` -- required, minimum 32 chars; `checkClusterBoot` refuses to start without one (`missingEncryptionKeyRefusal`). Encrypts AI provider keys, emergency-access credentials, each user's backup data key and the Web Push and OIDC signing keys. A deployment that ran without one can set one safely: every encrypting path refused or skipped storing while it was unset, so nothing is stored under a key it never had (automatic backups already written stay plaintext `.json.gz`, and a local account's backups are encrypted from its next sign-in). A deployment that once had a key must restore that exact value; a different one cannot read what the old one stored. `AI_ENCRYPTION_KEY` is the former name, still read and still preferred where both are set. The `isConfigured()` refusals in the services are unreachable in a booted server and stay for entry points that build `EncryptionService` outside it
- `DATABASE_*` -- PostgreSQL connection
- `DEMO_MODE=true` -- enables demo restrictions, daily reset at 4 AM UTC
- `LOCAL_AUTH_ENABLED` / `REGISTRATION_ENABLED` -- auth toggles
- `OIDC_*` -- OpenID Connect provider config

## Changing JWT_SECRET

Replace a weak `JWT_SECRET` (the boot warning, the `JWT_SECRET_WEAK` alert or the admin banner said so) with `openssl rand -base64 32`, and restart. Every consequence below was traced to the code that derives from the secret; plan for them before the restart.

**What stops working.** Everything signed or encrypted under the old secret:

- Access tokens (`auth.module.ts`, `delegation.module.ts`) are rejected. Signed-in users are **not** signed out: refresh tokens are random values stored hashed (`token.service.ts`), so the web client's 401 handler refreshes and carries on. CSRF tokens (`csrf.guard.ts`) are refused once and the client fetches a new one the same way.
- In-flight, short-lived artifacts fail and must be started again: a sign-in waiting for its 2FA code (the five-minute pending token), step-up and OIDC re-authentication tokens, OAuth provider interaction cookies (`oauth-provider.service.ts`), restore upload tickets, pending AI and MCP confirmations (`ai-action-signing.service.ts`, `mcp-request-state.ts`) and push chart artifacts.
- Trusted-device cookies (the `trusted-device-cookie` key in `auth.controller.ts`) can no longer be decrypted and are ignored, so every user with 2FA is asked for a code again.
- **TOTP secrets.** Each user's authenticator secret is encrypted under `derivePurposeKey(JWT_SECRET, "totp-encryption")` (`two-factor.service.ts`). After the change it cannot be decrypted, so every 6-digit authenticator code is answered with "Invalid verification code" (counted like a wrong code: ten in a row lock the account for 30 minutes) and the server logs `TOTP secret for user <id> cannot be decrypted`. **Backup codes keep working**: they are bcrypt hashes, checked without touching the TOTP secret.

**How users get back in**, in order of preference:

1. **Keep or restore the previous value** if you can; nothing above happens. A published placeholder should still be replaced, once you can follow the rest of this section.
2. **A backup code, from a session that is still signed in.** Settings > Security > Reset 2FA (`POST /api/v1/auth/2fa/reset`, `TwoFactorService.reset2FA`) takes the account password and an authenticator or backup code; after the change only a backup code can answer, since a 6-digit code is refused as invalid (and counted). It clears the TOTP secret, staged secret and backup codes, switches 2FA off, deletes the user's trusted devices and revokes every other session, keeping the one that asked, and the user enrolls a new authenticator at once. It is allowed under `FORCE_2FA=true`, where disabling 2FA is refused, so a forced deployment needs no administrator for it. There is deliberately no password-only path: a stolen session plus a known password must not be enough to strip the second factor. The one exception is an account with no TOTP secret stored, where there is no second factor to strip (see "Whether 2FA is on" below). Password and code failures draw on the same per-user budget as sign-in (ten lock the account for 30 minutes).
3. **A backup code, from a signed-out browser.** The user signs in with it ("Use a backup code instead"); a sign-in by backup code lands on Settings > Security, where they reset 2FA as in step 2 with another backup code and enroll again. Outside `FORCE_2FA` they may instead disable 2FA with a backup code and enable it again.
4. **An administrator's reset**, for a user with no backup code left. Admin > User Management > Reset 2FA (`POST /api/v1/admin/users/:id/reset-2fa`) clears the user's TOTP secret, staged secret and backup codes, switches 2FA off, deletes their trusted devices and revokes their refresh tokens, without decrypting anything. The user signs in with their password and enrolls again; under `FORCE_2FA` they are sent to set it up at that sign-in. An administrator cannot reset their own 2FA this way.
5. **SQL, when no administrator can sign in**: typically the administrator has 2FA and no backup code left, so cannot reach User Management. Run it against the database as its owner or a superuser (the `POSTGRES_USER` the stack was created with; the application role is subject to row-level security), for that one account, then sign in and use step 4 for everyone else. It writes exactly what the admin reset writes.

   ```sql
   -- psql, e.g. docker compose -f docker-compose.prod.yml exec postgres psql -U "$POSTGRES_USER" "$POSTGRES_DB"
   \set email 'admin@example.com'
   BEGIN;
   UPDATE users
      SET two_factor_secret = NULL, pending_two_factor_secret = NULL, backup_codes = NULL
    WHERE lower(email) = lower(:'email');
   UPDATE user_preferences SET two_factor_enabled = false
    WHERE user_id IN (SELECT id FROM users WHERE lower(email) = lower(:'email'));
   DELETE FROM trusted_devices
    WHERE user_id IN (SELECT id FROM users WHERE lower(email) = lower(:'email'));
   UPDATE refresh_tokens SET is_revoked = true
    WHERE is_revoked = false
      AND user_id IN (SELECT id FROM users WHERE lower(email) = lower(:'email'));
   COMMIT;
   ```

   If the first statement reports `UPDATE 0`, the address matched no account.

**Whether 2FA is on** is `isTwoFactorActive` (`src/auth/two-factor-state.ts`): the `user_preferences.two_factor_enabled` flag on AND a confirmed `users.two_factor_secret` stored. Sign-in, step-up, delegation, `GET /auth/2fa/status` and the `twoFactorEnabled` returned by `GET`/`PATCH /users/preferences` all answer through it, never through the flag alone. The two columns can drift apart (a secret cleared by hand without the flag, as a partial run of the SQL above would leave): the account then signs in on its password while a flag-only reader would show Settings "enabled" and hide the Enable button. Disable and reset treat that state as stale rather than refusing it with "2FA is not enabled": `disable2FA` clears the leftovers without a code, `reset2FA` on the password alone, and the user enrolls again. `disable2FA` writes the secret, the flag and the trusted devices in one transaction against the locked user row, as `reset2FA` does, so a failure part-way cannot produce that state.
