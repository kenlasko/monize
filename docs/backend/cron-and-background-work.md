# Backend: cron jobs and background work

How a cron seeds its identity, where a cleanup somebody is blocked on belongs, and how a worker attempt is fenced so a reaper cannot double a side effect. `docs/cron-jobs.md` holds the schedule; read this before adding a `@Cron`, a reaper or a long-running job.

Paths beginning with `src/`, `test/` or `scripts/`, and layer configuration filenames, are relative to `backend/`; other source paths are relative to `backend/src/`. Explicit repository prefixes are preserved. `backend/CLAUDE.md` is the short index; this document is where the reasoning lives.

## Cron Jobs

Cron jobs use `@Cron()` from `@nestjs/schedule` and run **in the API process** (`ScheduleModule.forRoot()` in `app.module.ts`; on k8s with multiple replicas, every replica fires every cron). Full schedule: `docs/cron-jobs.md`, or grep `@Cron(`.

Every `@Cron` handler is an out-of-request entry point, so its body must seed its own RLS context (tasks C2-C4): the cross-user fan-out under `withSystemContext`, each per-user body under `withUserContext(userId)`. A handler that reaches the DB with no ambient context throws in every `RLS_MODE`, including `off` -- the per-module `rls-context-smoke.spec.ts` specs are the pattern for proving a cron runs clean.

## The wrapper goes around the lease, not only around its body

`FetchSyncService.withLease` (`src/common/jobs/fetch-sync.service.ts`) is database access in its own right: `claim`, `markSuccess`, `markFailure` and `release` each open a `withScopedDb` transaction against `fetch_sync`, and that table belongs to no user, so the identity they need is the system one. A call site that seeds `withSystemContext` around only the *leased body* therefore leaves the claim with no ambient context at all, and `withScopedDb` refuses it before the body ever runs -- "DB access outside request/user/system context", every pass, with nothing done.

`AttachmentStorageMigrator.relocateAll` (`src/attachments/storage/attachment-storage-migrator.service.ts`) had exactly that shape. Its per-batch scan seeded `withSystemContext` and its per-row work seeded `withUserContext`, both correctly, but the `withLease` call around them did not -- so the first boot after an operator set `ATTACHMENT_STORAGE_PROVIDER=s3` logged the relocation starting and then the refusal, and no attachment moved. The three fetch crons wrap the whole `withLease` call (`securities/security-price.service.ts`, `securities/market-index.service.ts`, `currencies/exchange-rate.service.ts`), which is the shape to copy; `ExchangeRateService.checkRatesOnStartup` is wrapped one level up, at its `onModuleInit` caller, which is the same rule and not a second one.

A unit spec that substitutes a `FetchSyncService` double cannot see this -- the double never touches the database -- which is why the per-module `rls-context-smoke.spec.ts` runs the *real* `withScopedDb` over a mock `DataSource`. `src/attachments/rls-context-smoke.spec.ts` is the one that holds this path: a missing wrapper anywhere on it surfaces there as the same message the boot log carried.

## A provider cron waits out a wake from sleep, outside its lease

A cron that fell due while the machine slept fires the moment the process resumes, in the same second the network adapter comes back: Monize for Windows ran the 17:00 price refresh and the 17:05 FX refresh together at 19:54 on wake, and every lookup failed with `getaddrinfo ENOTFOUND`. The price and FX crons therefore go through `afterWakeSettles` (`src/common/jobs/wake-settle.service.ts`), which waits `WAKE_SETTLE_MS` after `WakeSettleService` sees the clock jump. The wait goes outside `withLease`, so a deferred replica holds nothing. The service is an `@Optional()` last constructor parameter so hand-built specs need no double; `JobClaimModule` is global, so the app always supplies it.

## A boot-time diagnostic reports; it does not repair

`HoldingsDriftReportService` (`securities/holdings-drift-report.service.ts`) runs
once per process start (`OnApplicationBootstrap`) and compares every stored
holding with a replay of its own ledger through
`HoldingsService.findLedgerDiscrepancies`, logging each disagreement with both
figures and the repair to run. What it compares against is `projectedHoldingRow`
(`securities/investment-replay.util.ts`), the same projection of the fold the
rebuild writers store, so a position it reports is one a rebuild would change --
a short position, whose stored average cost is `0` by that projection, is not. It **writes nothing**: no migration, no delete,
no automatic rebuild. A rebuild replaces a figure a person may have reconciled
against a statement, and the same replay that repairs pre-rule drift would
overwrite an incomplete imported history without asking; the owner runs `POST
/holdings/rebuild` once they have seen what would change. INV-HOLDING-001.

The shape is the ordinary out-of-request one: `withSystemContext` for the
cross-user enumeration (`holdings` has no `user_id`, so the query joins
`accounts`), then `withUserContext(userId)` per user so the replay it reports is
the one that user's own rebuild would perform, and a failure for one user is
caught and the loop continues. It is deliberately not awaited by
`onApplicationBootstrap` and its failures are logged, never thrown: a diagnostic
must not stop the application booting.

## Cleanup somebody is blocked on belongs on the request path

Before choosing an interval, ask what the stale row *does* while it sits there. Only untidy: a schedule is the whole answer. But if it **refuses the user's next request** (a slot, a lock, a uniqueness guard), the interval is a lockout the user cannot end. Run the cleanup inside the transaction of the request about to be refused, scoped to that caller, and leave the cron as a cross-user backstop. `MnyImportJobService` is the worked example: `reapStaleJobsForUser` runs in `create` and the poll's `findOne`, so a dead import clears within one 1.5s poll, and `reapStaleJobs` dropped to hourly.

Two things that path must get right, both tested: the staleness predicate is **one exported constant** used by the reap and negated by the advisory pre-check (an advisory check that still counts what the reap would clear reinstates the lockout through the back door); and a per-user cleanup whose predicate is a disjunction needs its own parentheses inside `user_id = $n AND (...)` -- assert the composed clause, not an `"AND ("` prefix.

## Deciding a worker is dead does not stop it -- revoke, do not merely record

A reaper's conclusion can be wrong in the direction that costs money: a merely *blocked* worker gets written off, wakes up, and finishes -- and if the reap also advertised a retry, the file lands twice. So an attempt gets an identity, not just a status: `import_jobs.attempt_token` is minted by `claim()`, required by every write that worker makes, and set to NULL by both reaps. The worker's commit checkpoint (`markDataCommitted`) is a fenced compare-and-set on that token and the **last statement of the transaction that wrote the rows**, so a zero-row result throws and rolls all of them back -- one statement later would be a check after the commit (see "Rejection happens before the write" in `docs/backend/database-access-and-tenancy.md`).

Three parts, each a separate way to get it wrong:

- **A status check is not a fence.** `WHERE status = 'running'` passes for a job reaped and re-claimed by a different attempt. Compare the token.
- **A fence the other binary does not know about is not a fence.** During a rolling deployment the previous release's checkpoint names no token, so the rule lives in the database: migration 145's `BEFORE UPDATE` trigger refuses a false -> true `data_committed` on a non-`running` job, from either binary. Deliberately not "and has a token": an old worker's normal state is `running` with a NULL token.
- **Terminal states are monotonic.** `complete()` and `fail()` are compare-and-set on `(status, attempt_token)` and return whether they took; the caller must read that boolean (logging "completed" after a refusal contradicts the reaper's line, with the false one more visible).
- **A failure after the checkpoint is a committed failure, on every surface, and the next start knows it.** `fail()` switches `error_key` and `error_detail` on `data_committed` exactly as the reaper does (`mnyImportFailedAfterCommit` beside `mnyJobStalledAfterCommit`), the job DTO carries `dataCommitted` and the wizard's copy follows it, never the generic "nothing was saved". The checkpoint also copies the staged file's digest into `import_jobs.content_sha256`, held by the partial unique index `idx_import_jobs_committed_content (user_id, content_sha256)`: `create` refuses, under the `UserImport` lock and before the job row exists, a start over bytes this user's ledger already holds (same staged id or a re-upload), naming the earlier import, and the index aborts the import transaction of anything that slips past. Only a start that replaces the user's data may import the same bytes again; its wipe releases the keys (`releaseCommittedContent`), after the wipe and never before (audit A26-H08).

The integration suite installs the trigger via `findTriggerMigrations()` in `test/helpers/rls-setup.ts` -- `synchronize` creates no triggers, so without that step a mixed-version test reports the fence as working while nothing enforces it.

## Persisted job messages use the owner's locale

Bank sync scopes `tr` with `withTranslationLocale` from `src/i18n/translate.ts`
after reading the owner's stored language. The async-local scope uses the public
`I18nService.translate` API, keeps concurrent jobs' languages separate, and restores
the surrounding locale after completion. Do not import formatter internals from
`nestjs-i18n/dist` to create a request context for a background job.
