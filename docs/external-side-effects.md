# External Side Effects

PostgreSQL cannot roll back a file written to disk, an object put to S3, an
email handed to an SMTP server, or a request already answered by a provider.
`withScopedDb` makes the database half of every such workflow atomic and gives
the other half no protection at all -- which is why an external call placed
inside a transaction callback reads as safe and is not.

This document records, for every provider-backed workflow in the codebase, what
durable state exists on each side of the external call and what happens when the
two disagree. Where nothing handles that case, it says so.

Related: `docs/concurrency-and-idempotency.md` for the retry classification this
builds on (before commit / after commit / commit unknown). The backup format
and restore semantics themselves are section 3 below, not a separate document.

## 1. The shape of the problem

An external call inside a transaction has two orderings and both leak:

```text
write bytes, then COMMIT metadata      -- COMMIT fails => orphaned bytes
INSERT metadata, then write bytes      -- write fails  => rollback saves you
                                          COMMIT fails after write => orphan again
```

There is no ordering that makes a non-transactional write transactional. What
closes the gap is one of:

| Mechanism | What it gives |
| --- | --- |
| Natural-key upsert (`ON CONFLICT ... DO UPDATE`) | Repeating the effect converges instead of duplicating |
| Whole effect inside one transaction | Nothing to reconcile; a failure leaves nothing |
| Durable state before the call, verified after | An orphan is detectable and attributable |
| Compensating action | The orphan is removed rather than merely known about |
| Reconciliation sweep | An orphan nobody noticed is eventually found |

```text
EXT-001
An external write must be preceded by durable state that identifies it, or be
idempotent on a natural key, or be provably reconstructible. "The transaction
will roll back" is not one of those three.

EXT-002
"Complete" may be reported only after the external effect has been verified, not
after the call returned. A write that did not throw is not a write that landed.

EXT-003
An operation whose external effect cannot be verified must leave its durable
state in a form that says so, and a later pass must be able to find it. An
unverifiable effect recorded as success is indistinguishable from a real one.

EXT-004
A comment asserting that bytes and metadata commit together must name the
provider it is true for. The claim is true of the database provider and false of
the other two.
```

## 2. Attachments

Three providers behind one interface (`save`/`load`/`delete`), selected by
deployment.

**One upload can write two objects.** A scanned document is stored as a pair --
the enhanced image the user sees and the original photo it came from
(`docs/future-plans/document-scanner.md`) -- written by one `create` call in one
transaction. That changes the quantity below, not the mechanism: each object
gets its own upload intent committed before any byte is written, each intent is
cleared inside the metadata transaction, and the compensation path deletes
whichever objects were actually written rather than assuming both were. The
failure windows described in this section are per object and are otherwise
unchanged. Deletion is likewise per object: the metadata `DELETE` names the
original as well as the visible row, so both storage keys come back and both are
swept after the commit.

**Database provider.** `save` opens `withScopedDb`, which joins the ambient
transaction, so bytes and metadata are one PostgreSQL transaction. Genuinely
atomic, genuinely rollback-safe. The FK cascade removes the blob when the
metadata row goes.

**Local filesystem and S3.** `save` is an `fs.writeFile` or a `PutObjectCommand`
executed *inside* the transaction callback, before the commit:

```typescript
const saved = await repo.save(attachment);   // metadata INSERT, uncommitted
await this.storage.save(id, file.buffer);    // bytes, durable immediately
// ...callback returns, then COMMIT
```

If the byte write throws, the callback throws and the metadata rolls back --
that direction is safe. If the **commit** then fails (connection loss, process
kill, DB-side failure), the bytes are already durable and the metadata row is
gone. That is an orphan, and **no code path ever removes it**: there is no
reconciliation sweep, no orphan detection, and no cron that compares provider
contents against `transaction_attachments`.

The comment beside this code says the nested call "joins this transaction, so
the bytes and the metadata row commit together (or roll back together on
failure)". That is EXT-004's case: true for the database provider, false for the
two providers where it matters.

**Deletion** removes the metadata row first, then the bytes, both inside the
callback. A failing byte delete rolls the metadata delete back, so the row and
the bytes both survive together -- the better of the two orderings for that
failure. Both `delete` implementations are explicitly idempotent on a missing
key, so a retried delete is safe.

It is not fully consistent, though, and the remaining window is the mirror image
of the create case: if the byte delete succeeds and the **commit** then fails,
the metadata delete rolls back while the bytes are already gone -- leaving a row
that resolves to nothing. So both directions of the attachment lifecycle have a
commit-failure window; create leaks bytes without a row, delete leaks a row
without bytes. The second is the more visible failure, because a user sees the
attachment and cannot open it, and INV-ATTACHMENT-001's "no metadata without
bytes" half is what it breaches.

## 3. Backups

`AutoBackupService` writes every artifact through `writeFileAtomic`
(`backend/src/backup/atomic-file.ts`): a temp name, `fsync`, a size check, the
`rename`, then an `fsync` of the directory. `rename` within a filesystem is
atomic, so a process killed mid-write or an `ENOSPC` leaves a temp file that the
next run sweeps, never a truncated file under the final name. Promotion to the
weekly and monthly tiers goes through `copyFileAtomic` with the same size check.
`lastBackupStatus` records what the export found -- `success` or `partial` --
and the same verdict travels inside the document (`completeness` in the
envelope, `backup-format.ts`), so restore refuses an artifact whose
`completeness.complete` is false. That is INV-BACKUP-001, and it closes the
direct-write breach of EXT-002 this section used to describe.

What remains is narrower, and it splits by encryption. An encrypted `.mzbe`
artifact is authenticated frame by frame (`backup-envelope.ts`): truncation,
reordering and tampering are rejected on open. A plaintext `.json.gz` carries no
content hash of its own; truncation and random corruption are caught by the gzip
trailer and `JSON.parse` on restore, a deliberate alteration is not. That gap is
recorded in section 8, and it is one more reason a plaintext artifact never
leaves the machine (INV-BACKUP-002).

**Per-user namespacing is already correct on `main`,** and worth recording as
settled: `userFolderPath` uses `shardedSegments(userId)` to build
`<base>/<ab>/<cd>/<userId>/`, because automatic backup filenames carry only a
tier and a date. A flat folder gave every user the same name for the same day,
so whoever's cron ran last overwrote the rest and one user's retention pass
deleted another's files. `enforceRetention` still sweeps the old flat layout for
files written before the fix. The folder browse and validate endpoints are
admin-gated at the controller.

**Encryption.** A support backup is unconditionally encrypted -- the DTO's
`password` is required, and there is no code path returning an unencrypted
support buffer, because a support backup exists in order to leave the user's
machine. An automatic backup is encrypted when a usable password exists; when a
stored password cannot be decrypted (a rotated key) the backup is **refused**
rather than silently written in clear. Refusing is the right failure: it is
visible, and it does not downgrade.

**The writability probe** names its file with `randomUUID()`, so two users or two
replicas probing the same folder in the same millisecond cannot collide on the
name, and the `unlink` sits outside the `try` that decides the verdict: the
write is the answer, and a probe file that could not be removed is a warning
in the log, not a "not writable" that would contradict the write that just
succeeded.

**Restore** is the strongest workflow here. The whole thing -- delete existing
data, insert backup data, fix deferred FKs -- runs inside
`withPreserveTimestamps(() => withScopedDb(...))`, one transaction, because "a
half-applied restore would leave the account in a state that is neither the
backup nor what was there before". Every row's `user_id` is forced to the
restoring user, every backup id is remapped to a fresh UUID so a backup restored
into a different account cannot collide with that account's rows, and every table
and column is checked against an allowlist. What it lacks is integrity
verification of the payload, per EXT-002 above.

### Off-machine copies

A completed automatic backup is also copied to the user's off-machine
destinations -- an S3 bucket, an emailed attachment, or both
(`docs/specs/backup-off-machine.md`, INV-BACKUP-002..005). It is the first backup
egress path in the codebase, and every rule this document argues for is visible
in it:

- **The local artifact is durable and recorded first, and the copy happens
  after, outside the transaction.** `AutoBackupService.dispatchOffsiteCopy` runs
  on the tail of a run, after `applyBackupOutcome`, and only for an artifact
  whose report is complete -- the push-after-commit shape of section 4a. The copy
  never fails the backup: `dispatchAfterBackup` does not throw and the call site
  catches anyway.
- **Each (user, destination, key) copy is claimed before it is attempted.**
  Every replica fires the backup cron and the hourly retry sweep, so the durable
  row is moved `pending`/`failed` -> `uploading` by one conditional
  `UPDATE ... RETURNING`; exactly one caller gets the row back. The claim, the
  external call and the outcome are three separate short steps, with no
  transaction open across the call.
- **Verified, then recorded.** An S3 put declares the artifact's SHA-256 so the
  destination validates it, and the row becomes `uploaded` only when the echoed
  checksum matches (EXT-002). For email, `sendMail` resolving is the whole of the
  verification the medium offers, and the row says `uploaded` only after it.
- **A claim is a lease.** A replica killed mid-upload used to leave the row
  `uploading` with nothing able to reclaim it -- an effect nobody could verify
  and nobody would find, which EXT-003 forbids. Each sweep now expires claims
  older than `OFFSITE_CLAIM_LEASE_MINUTES` (one hour, comfortably above the S3
  deadline times its attempts) back to `failed` before selecting candidates. The
  trade is deliberate and asymmetric: a re-attempted S3 put is a
  digest-reconciled no-op because the key carries the digest, while a re-attempted
  email can deliver the same encrypted artifact twice. A duplicate copy is the
  survivable direction against no copy at all.
- **The application never deletes off-machine.** The uploader constructs no
  delete and no read command and every completing write is conditional, so
  retention of the copies is the operator's bucket lifecycle or object-lock
  policy (INV-BACKUP-004). Nothing here can un-write what it wrote, which is why
  a taken key holding a different digest is recorded as `conflict` and alerted
  rather than resolved.

## 4. Email

`EmailService` is a thin `nodemailer` wrapper. It writes nothing to the
database. There is no outbox, no queue table, no "sent" ledger anywhere.

Every caller is a cron, and each has a different amount of protection:

| Sender | Duplicate protection |
| --- | --- |
| `BillReminderService` | None. It recomputes the window from `nextDueDate`/`reminderDaysBefore` daily; there is no "already reminded for this due date" flag. Sending every day the bill is inside the window is intentional, but a crash-restart or a second replica sends the same reminder twice with nothing able to notice. |
| `MortgageReminderService` | None -- same shape, no dedup state at all. |
| `BudgetAlertService` | Full, by insert-winner, since migration 140. The in-memory dedup against existing rows by `(budgetId, type, budgetCategoryId, periodStart)` is a check-then-act and never was the arbiter; the unique fingerprint index is, through `NotificationService.create`, which answers `null` for the replica that loses the race so only the winner emails. `isEmailSent` is set after the send, so a crash in between leaves it `false` forever without causing a duplicate. |
| Emergency-access grant | The one deliberate design. See section 5. |
| `SystemAlertService` | Full, by insert-winner. Each admin's alert row goes through `NotificationService.create`, whose `INSERT ... ON CONFLICT DO NOTHING RETURNING id` is arbitrated for these rows by the partial unique index from migration 170, and the email goes only to rows the INSERT returned -- with the same at-most-once trade as `ProviderOutageAlertService`: a crash between the commit and SMTP loses that email, and the in-app row survives as the durable notice (`docs/specs/system-alerts.md`, INV-ALERT-001). |
| `ProviderOutageAlertService` | Full, and the opposite trade from the reminders. The notice is claimed with a single conditional `UPDATE ... WHERE state = 'down' AND outage_notified_at IS NULL AND outage_started_at <= now() - 15min AND (last_notified_at IS NULL OR last_notified_at <= now() - 6h) RETURNING ...`, so one replica sends per episode and a flapping provider cannot mail its way around the floor. The claim is taken *before* the send, which makes it **at most once**: a process killed in between loses that alert. Deliberate -- a duplicated monitoring email is the failure mode being designed against, the outage is still in the log and in `provider_health`, and a provider still down when the 6-hour floor elapses becomes notifiable again. |

`BudgetAlertService` is a useful illustration of EXT-001 both before and after
its repair: it always had most of what the rule asks for -- durable state written
before the effect -- and still sent duplicates, because the state was not
*claimed* atomically. Durable-before-effect and atomically-claimed are two
requirements, not one, and the unique index is what turned the first into the
second.

## 4a. Web Push

`WebPushSender` is the only file in `src/` that imports `web-push`, and the one
place a payload crosses an external push service. It is an external effect in
the narrowest sense: once Mozilla, Google or Apple has accepted a message, no
transaction can recall it.

Three rules follow, and all three are the ordering rule rather than new
mechanism:

1. **The send happens after the commit, and never inside a transaction.**
   `PushSubscriptionService.sendTest` loads its targets in one short
   transaction, sends outside any, then records each outcome in its own short
   transaction. A notification is about something that already happened; it must
   not be able to roll that thing back.
2. **The sender never throws.** Every failure is returned as an outcome
   (`sent` / `unconfigured` / `expired` / `transient`), because the caller of a
   future producer is a budget recalculation or a backup sweep, and a delivery
   failure is not that operation's failure. This is the same trade as
   `SystemAlertService`: the durable notice is the in-app row, and the push is
   the best-effort copy.
3. **A dead subscription stops being attempted.** 404 and 410 are the push
   service saying the subscription is gone, and retire the device immediately
   (`disabled_reason = GONE`). Everything else -- 401 and 403 included -- is
   transient, deliberately: an authorization failure usually means this
   instance's key or clock is wrong rather than that the device went away, and
   retiring on it would empty every device list in the deployment over one bad
   configuration. `MAX_CONSECUTIVE_FAILURES` bounds the retry either way
   (`disabled_reason = FAILING`), so nothing is attempted forever.

There is no outbox and no delivery ledger, which is the same gap email has: a
crash between the send and the outcome write loses the bookkeeping for that one
attempt, not the notification. `notification_deliveries` from discussion #1291
is where that would be closed, and the open question recorded there is whether
`job_claims` already does the job -- a third idempotency mechanism beside the
two the codebase has would be a regression, not a feature.

The subscription itself is instance-bound state, not portable user data: see
`INTENTIONALLY_EXCLUDED_TABLES` and INV-PUSH-005.

## 4b. The web-share stash is the device's, not the server's

The Web Share Target stores the files the OS hands over in a Cache API store on
the device (`docs/future-plans/pwa-web-share-target.md`). It is in this document
because it looks like an external side effect and is worth being explicit about
*not* being one:

- **Nothing on the server is written when a share arrives.** The service worker
  answers the manifest's POST itself, so on the ordinary path the request never
  leaves the device. When no worker is controlling, the proxy answers the same
  POST with a redirect *before* its auth check and without reading the body, so
  the bytes are not read into the frontend process either, let alone forwarded.
- **So there is no ordering problem to get right.** The rule this document
  exists for -- write bytes before the commit, delete them after it -- has
  nothing to order here: there is no row, no transaction, and no server-side
  object. The only thing the stash can leak is device storage, and the failure
  mode is bytes nobody references, which is the survivable side by construction
  (the bundle index is written last).
- **What bounds it is expiry and logout, not a reconciliation job.** Bundles are
  swept by the worker on `activate` and before each new share, and by the app on
  mount; `authStore.logout` drops the whole store, because a share is one
  account's document and a browser profile can be shared. INV-SHARE-003 is the
  invariant; there is no server-side sweeper because there is nothing on the
  server to sweep.

A share only becomes a side effect this document governs at the moment the user
presses a destination, and then it is an ordinary attachment upload or an
ordinary import -- section 2 above, unchanged.

## 5. Emergency access

The grant path is the only place in the codebase that gets the external-effect
ordering right on purpose. Per contact, it mints and saves a claim token, then
emails the contact; and it sets `settings.grantedAt` **only if at least one
contact email actually delivered**:

> Only commit the grant if at least one contact actually received a link.
> Otherwise leave `grantedAt` null so the next run retries -- a transient SMTP
> failure must not permanently disable the safeguard.

That is a compensating decision expressed as a state transition: the durable
"the grant happened" marker is withheld until an external effect is confirmed,
and withholding it *is* the retry. Copy this shape.

The reminder path is weaker: `lastReminderSentAt` is written after the send, and
the once-per-day gate reads it, so a crash between send and save re-permits a
send later the same day. Combined with every replica firing every cron, a
duplicate reminder is reachable.

Claim consumption itself sends no email, so there is no external-effect question
there -- but the consumption is a check-then-act with no lock and no conditional
`WHERE`, which `docs/concurrency-and-idempotency.md` covers.

## 6. Providers: AI, prices, FX

**Price and FX are the good case, and the reason is the mechanism.** Both the
single-rate and bulk paths write through natural-key upserts --
`ON CONFLICT (from_currency, to_currency, rate_date) DO UPDATE` and
`ON CONFLICT (security_id, price_date) DO UPDATE` -- so a repeated or concurrent
refresh converges rather than duplicating. This is EXT-001's second clause
satisfied exactly, and it is the cheapest form of idempotency available: the
uniqueness is a property of the data, so no key has to be invented or
remembered.

Failures propagate as `null`, deliberately. `getRateForDate`'s own comment says
it "returns null when no rate can be determined (so the caller can reject or flag
the operation rather than silently assuming 1.0)". The provider layer is
therefore *not* where the missing-rate defects in
`docs/financial-semantics.md` section 10 come from -- it reports honestly and
callers discard the honesty.

**Provider *availability* is now durable state, and it is the one place a
process-local fact and a shared fact are deliberately kept apart.** The circuit
breaker (`ProviderCircuit`, in memory) decides whether this replica calls out: it
describes what this container's own sockets and DNS just did, which no shared
table can know. `provider_health` carries only what memory cannot -- the episode
start, so a container restarting inside an outage does not reset the clock the
alert gate reads, and the notification markers, so the alert is claimed once
across replicas. Writes happen on transitions plus a five-minute heartbeat, never
per failed request, and they run through `runOutsideActiveScopedManager`: an
outage is not part of whatever request happened to discover it, so a rollback
must not erase it. The write is fire-and-forget and swallows its own failures --
availability bookkeeping must never turn a provider outage into a failed request.

**AI insights are the weak case.** The reentrancy guard is a `Set<userId>` in
process memory, which coordinates one replica with itself and nothing across
replicas. The 12-hour cooldown is a plain read of the most recent
`generatedAt` -- a check-then-act. Rows are inserted with no idempotency key, so
a manual regenerate racing the daily cron, or two replicas both past the cooldown
read, produces duplicate insight rows. Ordering is at least correct on failure:
the provider is called and the response parsed before anything is saved, so a
failed call leaves no partial rows, and a total provider failure throws rather
than fabricating a result.

### Payee contact enrichment

`backend/src/payees/lookup/` looks a new payee's website, address, email and
phone up through the user's AI provider (opt-in) and writes the answer to the
row. The provider call runs outside any transaction, on the tail of the
request that created the payee (`PayeeContactEnrichmentService.dispatchAfterCreate`,
dispatched by `PayeesService.create` only once its own `withScopedDb` has
resolved and no ambient transaction exists). The effect is one conditional
statement, `ENRICHMENT_UPDATE_SQL`: every contact column is `COALESCE(column,
$n)` so nothing already stored is touched (INV-PAYEE-001), and the automatic
path adds `WHERE contact_lookup_at IS NULL`, which is the idempotency key --
a second replica, a retried request or a re-dispatch affects zero rows
(EXT-001 by predicate rather than by unique index). `contact_lookup_at` stamps
the *attempt* (found something, or found nothing); a failure -- provider
offline, no provider, feature off, or an answer that could not be read --
stamps nothing, so a later attempt can run (EXT-003). The favicon fetch that follows a looked-up website is keyed on
that website (`UPDATE ... WHERE id AND user_id AND website = $resolved`), so
a concurrent edit to the address cannot end up under a stale icon.

What is process-local: the in-flight map and the admission queue
(`LookupQueue`, two concurrent lookups, fifty waiting) bound what one replica
does; two replicas can both pay for one lookup, and the second UPDATE then
matches no row. The AI/MCP confirmation flow avoids the question by looking
up in the *preview* and carrying the stamp down the signed descriptor to the
commit, so the card and the row agree and nothing looks up twice.

### Google Places, and the quota claimed before the call

The same lookup can be answered by Google Places instead of an AI provider
(`backend/src/payees/lookup/google-places/`), and the ordering rule there is the
opposite of the usual one. Google bills a Text Search request whatever comes
back, so the **quota claim commits before the request goes out**
(`PayeeLookupQuotaService.claim`, INV-PAYEE-002): a slot released because the
request then failed would under-count what the user is paying for, and an
under-count is the direction that spends money. The claim therefore runs through
`runOutsideActiveScopedManager`, so the count of what has been spent cannot be
rolled back by whatever operation discovered it -- exactly as `provider_health`
records an outage outside the request that found it.

What that costs, stated rather than hidden: a crash between the claim and the
call, or a transport failure after it, spends a slot for an answer nobody
received. That is the survivable direction.

The one **compensation** is `PayeeLookupQuotaService.release`, and only the Test
button uses it. A request Google *answered with a refusal* was never served and
never billed, so charging for it would make every check of a broken key cost a
request. A transport failure is deliberately not released: nobody answered, so
whether Google served it is unknown, and under-counting is the direction that
spends money. `ContactLookupUnavailableError.httpStatus` is what tells an
answered refusal from a stall. The release is `GREATEST(x - 1, 0)`, because a
release that crossed a month boundary must return quota rather than mint it.

Whose key is spent, and which source is asked first, are decided together in one
read by `PayeeLookupSettingsService.resolveRouting`: the operator's
`GOOGLE_PLACES_API_KEY` where the deployment set one (counted in
`google_places_instance_usage`, deployment-wide, because one key is one bill),
otherwise the user's own encrypted key (counted per user). The month those
counters roll over on is **Pacific**, not UTC, because that is when Google's free
allowance resets; a counter that rolled over first would hand back a cap the
allowance behind it had not released.

Availability goes through the same `ProviderHealthService` breaker as the
market-data clients, with one asymmetry worth naming: a 400 or 403 from a
rejected key is recorded as a **success**, because the host plainly answered --
counting it as a failure would let one user's bad key open a deployment-wide
breaker and page the operator.

The client sends `PUBLIC_APP_URL`'s origin as `Referer`, which is what makes an
HTTP-referrer key restriction satisfiable at all: a server sends none of its own,
so such a key rejected every lookup. It buys availability rather than security --
a referrer restriction protects a key that is public, shipped in browser
JavaScript where the browser sets the header, and this key never leaves the
server -- so an IP restriction is the one that actually constrains it. The header
is sent because a deployment with no stable egress address cannot use an IP
restriction at all.

## 7. There is no shared lifecycle, and one workflow shows what it would look like

No generic `pending -> externally_created -> verified -> available` state machine
exists. Attachments have no state column; backups have a post-hoc
success/failed string; emergency access has an ad hoc set of timestamp columns;
AI insights and reminder emails have no state beyond a time-window read.

The nearest thing to a lifecycle belongs to the `.mny` import job. It wraps a
local parse rather than a provider call, and it is incomplete in one instructive
way noted below -- but its four ingredients are the template:

- `import_jobs.status` moves `pending -> running -> completed | failed`, with a
  **partial unique index** on `(user_id) WHERE status IN ('pending','running')`
  making double-start a database error rather than an application check.
- The worker claims the job with `UPDATE ... WHERE status = 'pending' RETURNING id`,
  so exactly one of two workers proceeds.
- The worker heartbeats, and a reaper cron fails jobs whose heartbeat went
  stale -- real crash recovery, not a hope that workers do not die.
- The staged-file sweep is documented as "idempotent by construction -- the
  predicate is 'already expired'", which is the correct way to justify an
  unclaimed cron.

None of that machinery is reused for attachments, backups, emails or insights.
Adopting it does not require building the generic abstraction first: the four
ingredients (a state column, a uniqueness constraint, a conditional claim, a
reaper) are independently useful.

**Where it stops short, and why that is the most useful part of the example.**
The status column has no state between "running" and "completed" -- nothing
records that the business data has committed. So the reaper, which correctly
handles a worker that died *before* writing, marks a worker that died *after*
writing as retryable too, and a retry replays committed rows (INV-IMPORT-002).
That is precisely the gap EXT-003 describes: an effect that has happened but
cannot be verified from durable state. A lifecycle needs a state for
"externally done, not yet finalized", and this one has three states where it
needs four. Any workflow copying the template should copy it with that state
added rather than as it stands.

## 8. Gap register

| Workflow | Missing | Rule |
| --- | --- | --- |
| Attachment create, local and S3 | Bytes durable before commit; no orphan detection, no reconciliation sweep, no compensation | EXT-001, EXT-003 |
| Attachment delete, local and S3 | Bytes deleted before commit; a failed commit leaves a metadata row resolving to nothing | EXT-001 |
| Attachment provider comment | Claims joint commit for all providers; true only of the database provider | EXT-004 |
| Backup restore validation, plaintext `.json.gz` | No content hash of its own: truncation and random corruption are caught by the gzip trailer and `JSON.parse`, a deliberate alteration is not. An encrypted `.mzbe` is authenticated frame by frame and has no such gap | EXT-002 |
| Bill and mortgage reminders | No dedup state of any kind; duplicate sends unbounded across replicas and restarts | EXT-001 |
| Budget alerts | Durable state written before the send, but the dedup read and insert are not atomic and no unique constraint backs them | EXT-001 |
| Emergency-access reminder | `lastReminderSentAt` written after the send, and it is the gate | EXT-001 |
| AI insight generation | Process-local `Set` as the reentrancy guard; cooldown is a check-then-act; inserts carry no idempotency key | EXT-001 |
| Payee contact enrichment | In-flight guard and admission queue are process-local; two replicas can both pay for one lookup (the second UPDATE affects zero rows, so the data is right and only the cost is duplicated) | EXT-001 |
| Off-machine backup copy (email) | An accepted trade, not an omission: a claim expired by the lease is re-attempted, and SMTP offers no way to tell a message already delivered from one never sent, so the same artifact can arrive twice. Delivering a duplicate copy is the survivable direction against never delivering it | EXT-003 |
| Off-machine backup copy (S3) | A stuck `uploading` row is reclaimed after the lease and re-attempted, reconciled by digest. What remains: nothing reconciles a bucket object against the ledger, so an object written by an attempt whose row never reached `uploaded` is referenced by nothing -- bytes nobody references, the survivable side, and the operator's lifecycle policy is what ages them out | EXT-003 |

Four rows are absent from this table on purpose, and all four are settled:
per-user backup sharding with admin-gated folder endpoints, the FX/price
natural-key upserts, the atomic backup write with its in-document completeness
verdict (INV-BACKUP-001), and the UUID-named writability probe whose failed
cleanup is a log line rather than a verdict. Section 5's
grant-commit-after-delivery belongs in the same category. Those are the patterns
the rest of this table should be closed by imitating.
