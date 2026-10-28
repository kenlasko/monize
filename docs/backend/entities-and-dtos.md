# Backend: entities, DTOs and raw SQL

Column transformers and the raw-select trap, DTO validation shapes, phone-number normalization, request-array bounds, the transaction-note cap and regex escaping. Read this before adding a column, a DTO field, a raw query or a validator.

Paths beginning with `src/`, `test/` or `scripts/`, and layer configuration filenames, are relative to `backend/`; other source paths are relative to `backend/src/`. Explicit repository prefixes are preserved. `backend/CLAUDE.md` is the short index; this document is where the reasoning lives.

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

**A hand-written column name is checked by nobody -- so a scan checks it.** A mocked `manager.query` records the string and resolves, making every raw statement's column names untested by construction (`AutoBackupService` wrote `RETURNING id` against a table whose primary key is `user_id`, the spec pinned the wrong string with `toContain`, and no user's automatic backup ran). `src/common/db/raw-sql-columns.spec.ts` checks every `RETURNING` list, `INSERT` column list and `UPDATE ... SET` target in `src/` against `database/schema.sql`. Assert the _column_, not the substring.

**A per-user loop in a cron isolates each user, including the steps before the work starts.** Wrap the entire per-user body in the `try` -- an error while deciding whether to run (a pre-check, the claim's own `UPDATE`) must not leave the handler and skip every remaining user. Record the failure on the row so the last-run status tells the truth, and record it through a path that cannot itself throw.

## DTO Conventions

## An optional field with a format validator needs `@ValidateIf`, not just `@IsOptional`

`@IsOptional()` waives validation for `undefined` and `null` only. A text input the user left alone arrives as `""` (react-hook-form sends it), so an `@IsUrl` / `@IsEmail` beside `@IsOptional()` still rejects it -- and because validation fails per _request_, one blank optional field breaks every save from that form. Add `@ValidateIf((_o, value) => value !== null && value !== "")` for a nullable column so a blank clears it. `src/common/optional-format-dto.spec.ts` sweeps every URL- and email-validated DTO property; a NOT NULL field belongs on its exemption list with a reason. This class of bug is invisible to unit tests (hand-built payloads); it surfaces in E2E or production.

## A phone number is normalized by the service, not by a decorator

`payees.phone` is stored in one form for every country -- E.164 with an
optional RFC 3966 extension suffix (`+12064488762`, `+442079460958;ext=12`) --
and rendered through `formatPhoneForDisplay`. Both live in
`src/common/phone-number.util.ts`, over `libphonenumber-js/max`; `min` reduces
`isValid()` to a length check, so the browser would accept numbers the server
then had to accept too.

The check is **not** a DTO decorator, because placing a number written without a
country code needs the caller's region and class-validator cannot see it. The
region comes from preferences the user has already set (`number_format`, then
`language`), and `null` -- no region derivable -- makes a bare national number a
_question_ (`phoneNeedsCountryCode`) rather than a rejection: telling somebody
their perfectly correct number is invalid sends them to check digits that are
right. Three writers exist and all three go through
`PayeesService.previewContactFields`: the preview an AI or MCP card is built
from, the create, and the update. A preview that did not normalize would show
one value on the card and store another.

Two rules the tests hold. **A resent value is not an edit** -- the form sends
every field on every save, and rows written before this existed are not
backfilled, so validating a value merely _present_ in the payload would make
such a payee impossible to edit at all. Only a value that actually moved is
normalized. And **the lookup normalizes before any caller sees a suggestion**
(`PayeeContactLookupService.vetCandidate`), which is what makes the background
enrichment `UPDATE` safe: it writes a model's answer straight into the column
with no DTO anywhere in its path. `phone-normalization.guard.spec.ts` fails on a
file that both writes a phone and reaches the database without going through a
door -- an object field, an assignment, an `UPDATE` naming the column or an
`INSERT` listing it -- and `common/phone-number-cases.json` is the truth table
this layer and the frontend both assert, so the two can never disagree about
which numbers are accepted.

**A region is a fact about the reader, not evidence about a third party.**
`number_format` says where _this user_ dials from, which is exactly what places
a number _they_ typed -- and is unrelated to where a payee's office is. So the
contact lookup normalizes a model's suggestion with **no** region
(`vetCandidate` passes `null`) and drops one that carries no country code, which
is what the prompt asks the model for. Read in the reader's region, a Mexico
City `55 1234 5678` is a valid `+15512345678` in New Jersey -- a different
number that dials, written into the column by the background enrichment with
nobody in the loop, under a name the user trusts. An empty field they can fill
beats a confident wrong number. The rule splits by _who supplied the value_, not
by which function normalizes it: user-typed gets the region, model-supplied does
not.

**A stored form is not an answer.** `getLlmPayees` renders `phone` through
`formatPhoneForDisplay` before the row reaches a model, the same decision the AI
executor's `contactSummary` and the MCP contact card make about a preview -- a
model quotes these rows back to the reader, and bare E.164 in the assistant
beside grouped digits on the payee page is one number printed two ways.

## A request-supplied array declares an upper bound

Every `@IsArray()` DTO property carries `@ArrayMaxSize(n)` -- an unbounded array turns per-element work downstream into a denial-of-service lever (CodeQL `js/loop-bound-injection`, CWE-834). `src/common/array-bound-dto.spec.ts` sweeps validator metadata; its grandfather list may only shrink. Relatedly, never use a request value's `.length` as a loop bound inside a `withScopedDb` callback (CodeQL cannot track the outer guard through the closure): iterate `for (const [i, v] of xs.entries())`.

## A `@Query()` parameter typed `string` is only a string by declaration

Express parses a repeated key into an array, so `?date=2026-07-20&date=2026-07-21` reaches a handler parameter declared `string` as a `string[]`, and `@Query()` validates nothing by itself. A format check written as `/^\d{4}-\d{2}-\d{2}$/.test(value)` coerces that array to text and passes it: the rate route handed the array on to `resolveFxRate`, where `slice(0, 10)` returned an array and every `YYYY-MM-DD` comparison became a comparison of coerced text, so the resolver answered with a rate for a day nobody asked about (CodeQL `js/type-confusion-through-parameter-tampering`, CWE-843). Two places hold it: the boundary rejects a non-string first -- a pipe (`ParseCurrencyCodePipe`, `ParseCalendarDatePipe`, `ParseUUIDPipe`) or `isCalendarDate` (`src/common/validators/is-calendar-date.validator.ts`), never a bare regular expression on the raw value -- and the helper the value reaches refuses a shape it cannot compare instead of coercing it (`fxReferenceDate` in `src/common/time-series/fx-rate-resolver.ts` returns `null`, which the resolver reports as `invalid_date`). An optional bound takes `ParseOptionalCalendarDatePipe` (same file), which reads an absent or blank value as no bound and holds anything else to the same check -- an optional parameter is the case where a truthiness test (`if (startDate)`) reads as validation and is not. A `@Body()` field needs neither: `ValidationPipe` and class-validator check its runtime type.

## The note on a transaction has one length -- `TRANSACTION_NOTE_MAX_LENGTH`

A transaction's `description` and a split's `memo` are one field to the person
typing in them, so they share one cap (`src/common/transaction-note.ts`) across
all twenty-three places that write one: fifteen DTO fields plus the AI query
schemas and the MCP tools, which write the same field with no DTO in the path.
Splitting the number is how a split memo comes to be rejected at a length its
parent's description accepts, with nothing on screen saying why.

The columns are all `TEXT`, so the cap is a product decision about how much a
person should type, not a storage limit -- it went 500 to 750 when descriptions
started rendering their web addresses as links, since a ticket URL plus a note
does not fit in 500. Raising it needs no migration, and
`transaction-note.contract.spec.ts` proves that by checking those columns are
still unbounded.

**The frontend has the same number**, in `frontend/src/lib/transaction-note.ts`:
without it a form accepts a save the server rejects, which is what the main
transaction form did -- a bare 400 with nothing pointing at the field, while the
one form that did cap reported it properly. The contract spec reads the
frontend's file and fails when the two disagree.

## A partial escape is indistinguishable from a correct one

Interpolating a literal into a pattern goes through `escapeRegExp` (`src/common/escape-regexp.util.ts`) -- never a hand-written character class, and never a subset of one (`repo-paths.util.ts` escaped only dots and left `\` alone; CodeQL `js/incomplete-sanitization`, CWE-020). `escape-regexp.guard.spec.ts` scans `src/` for either shape. Where the pattern is built from a list, export the builder and test it against a prefix carrying a metacharacter (`buildPlainRootedPathPattern`) -- over real inputs the broken and correct escapes can agree exactly. Do not escape `-`: outside a class it is literal, and `\-` is a SyntaxError under the `u` flag -- so never interpolate the result _inside_ a class.

## A list of columns that means something is written once, in the place that can check it

The columns referencing `currencies(code)` were spelled out in four places and wrong in all four. Prefer a SQL function the database evaluates (`currency_code_in_use_globally`, `currency_codes_referenced_by_user_data`, and `currency_codes_referenced_by_user` derived from the last) so the answer cannot be a tenant's view of a global question; when a caller genuinely cannot ask the database, keep one TypeScript constant checked against `database/schema.sql` in both directions. **Two callers wanting slightly different answers is not a licence to write the list twice** -- derive one from the other and let the guard test check the derivation. `backend/src/currencies/currency-references.spec.ts` is the pattern; the same applies to the restore's insertion order and deferred foreign keys (declared as data in `restore-plan.ts`, proven against the schema by `restore-plan.spec.ts`).

## A driver value is not a JSON value

`pg` returns `bytea` as a `Buffer` and DATE/TIMESTAMP as `Date`; `JSON.stringify` mangles a Buffer into `{"type":"Buffer","data":[...]}`. The backup export reads every bytea column through `encode(col, 'base64')`, and `backend/src/backup/export-driver-values.spec.ts` fails if a new one is added without it. Same family as the raw-select rule in `docs/backend/entities-and-dtos.md`.

## `created_at` cannot order rows written in one transaction

`CURRENT_TIMESTAMP` is **transaction start time** in PostgreSQL and TypeORM leans on the column default, so every row a single transaction writes (a whole `.mny` import, a whole restore) carries the same `created_at`, and any tiebreak on it falls through to the next key -- in the register, a random UUID. The stored balance survives that; the running balance beside it does not (a same-day debit ordered before the credit that funded it shows the account overdrawn).

When the clock cannot separate two rows, their signs do: **credits before debits, chronologically** -- for a newest-first list the tiebreak runs _opposite_ to the list direction. `applyRegisterOrder` (`backend/src/transactions/register-order.ts`) is the only place that order is written -- with the sort field the reader chose as its primary key -- and `restrictToRowsNewerThanPage` is the only place the page window is written, because three of its call sites are the queries that sum the rows a page's starting running balance is seeded from; a tiebreak added to the register alone re-splits the pages under those sums. INV-REGISTER-001.

## Recognition detail query arrays

A selection can contain one UUID or repeated UUID query keys. Normalize a string to a one-element array before `IsArray`, `ArrayMaxSize` and per-item UUID validation. Do not discard malformed selections, accept unknown bracketed properties, or change the global Express query parser to accommodate one endpoint. Verify real HTTP requests in `backend/src/accruals/reporting-details-http.spec.ts`.
