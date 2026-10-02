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

### Changing the provider is a migration, not a rebind

`ATTACHMENT_STORAGE_PROVIDER` says where the NEXT object goes.
`transaction_attachments.storage_provider` says where an existing one already is.
Those two were assumed to be the same value, and the download asked the bound
provider for the row's key -- so the boot after an operator changed the setting
answered 404 for every attachment uploaded before it, with the row, the filename
and the size all still listed. Nothing was lost; nothing said so either, and
nothing moved the bytes.

Two mechanisms, both in `backend/src/attachments/storage/`:

- **Reads resolve per row.** `AttachmentStorageRegistry.require(row.storage_provider)`
  answers with the backend that row names, and refuses with a
  `ServiceUnavailableException` **naming the provider** when this deployment
  cannot address it. That refusal is deliberately not the `NotFoundException` a
  missing object gets: nothing is lost, one setting is absent, and the repairs
  differ. `null` from `resolve` therefore means "unconfigured backend", never "no
  bytes". The distinction reaches the reader: `isStoreUnreachable` in
  `frontend/src/lib/attachments.ts` recognises the 503 and the preview says the
  file is intact rather than offering a download that fails identically
  (`docs/frontend/ui-conventions.md`).
- **`AttachmentStorageMigrator` moves them**, on `onApplicationBootstrap` (not
  awaited -- Nest runs the hook inside `app.listen()`) and hourly at :50 until
  nothing is outside the active backend. Any pair of backends, either direction,
  no operator action. It assumes both are configured at once, because the source
  is read through its own provider.

Per attachment, one transaction, in this order: `SELECT ... FOR UPDATE` and
re-read what the row says (gone, or already moved, ends here -- before any byte is
written); read the source bytes; check them against the row's own `byte_size` and
`sha256`; `save` to the destination; **read the copy back** and check it the same
way; flip `storage_provider`; record the source object as unreferenced; commit.
The source object is deleted only after that commit, through
`AttachmentOrphanSweeper.sweepKey(key, provider)`.

Four things make that safe to interrupt, and each is a mechanism rather than an
assurance:

- The destination write takes an **upload intent** first, exactly as `create`
  does, so a crash before the commit leaves bytes the sweep can enumerate and a
  row still naming the copy that is intact. The intent is cleared inside the flip,
  fenced on `swept_at`, so a committed row naming swept bytes stays unreachable
  (audit RV4-002).
- The source is retired **inside** the flip: a tombstone for `local`/`s3`, or the
  blob `DELETE` itself for `database`, which is transactional. The post-commit
  sweep is promptness; the tombstone is the guarantee.
- The read-back is what the source deletion rests on. A resolved `save` is not
  evidence the bytes are readable -- a `PutObject` 200 from a proxy, a cached
  filesystem write -- and this is a move, so the claim has to be checked.
- The sweeper's claim now also refuses any key a live `transaction_attachments`
  row still points at (`NOT_REFERENCED_SQL`). Without it, an intent left behind by
  a crashed relocation would have the sweep delete a migrated attachment's only
  copy once the lease expired, and nothing else in the claim could tell the
  difference -- by shape there is none.

One replica per batch holds `FetchSyncService.withLease("attachment-relocation")`,
which is a cost control only: correctness is the per-row lock, so an expired lease
costs duplicated reads and writes of identical bytes and never a row in the wrong
state. `ATTACHMENT_STORAGE_MIGRATE_ON_SWITCH=false` leaves everything where it
is, and says so in the log once rather than silently.

**Relay attachments are deliberately not in this section.** A file uploaded
with a reverse-relay chat prompt goes to `ai_relay_attachments` and its
cascading `ai_relay_attachment_blobs` row, not through
`ATTACHMENT_STORAGE_PROVIDER` -- the provider's `database` implementation writes
`attachment_blobs`, whose primary key is a foreign key to
`transaction_attachments` and whose policy reads the owner from that row, so a
relay attachment (which has no transaction) cannot be stored there at all, and
branching on the bound provider's name would put a deployment-shaped decision
inside the relay. The consequence is that this one path has no external side
effect: bytes and metadata commit or roll back together on every provider, and
the five-minute relay sweep reclaims both with one `DELETE` -- none of the
commit-failure windows above apply. The cost is that a deployment which keeps
attachment bytes out of PostgreSQL still holds a few megabytes of chat scratch
there for up to twenty minutes.

## 3. Backups

`AutoBackupService` performs no storage operation itself. Every one goes through
the store selected by `BACKUP_STORAGE_PROVIDER`
(`backend/src/backup/storage/backup-storage.interface.ts`): `local`, a container
directory, or `s3`, an S3-compatible bucket. The seam offers `publish` and no
`write`, because the name is the invariant -- **an artifact is published whole or
not at all** (INV-BACKUP-006) -- and a caller cannot ask for a non-atomic write
when no operation offers one.

Each target satisfies it by its own mechanism, and both are named rather than
asserted. `local` writes through `writeFileAtomic`
(`backend/src/backup/atomic-file.ts`): a temp name, `fsync`, a size check, the
`rename`, then an `fsync` of the directory. `rename` within a filesystem is
atomic, so a process killed mid-write or an `ENOSPC` leaves a temp file that the
next run's `sweepIncomplete` removes, never a truncated file under the final
name. `s3` sends one `PutObject` with a known `Content-Length` and a declared
`ChecksumSHA256`, which S3 applies to the key only on a complete,
checksum-matching upload -- so the destination rather than this process is what
verifies the bytes arrived, and an interrupted upload leaves no object to sweep.
Promotion to the weekly and monthly tiers is `copyFileAtomic` with the same size
check, or a server-side `CopyObject`, likewise all-or-nothing at the destination
key.

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

**Per-user namespacing is settled, and is the same tree on both targets:**
`shardedSegments(userId)` builds `<base>/<ab>/<cd>/<userId>/` as a directory on
`local` and as a key prefix on `s3`, because automatic backup filenames carry
only a tier and a date. A flat folder gave every user the same name for the same
day, so whoever's cron ran last overwrote the rest and one user's retention pass
deleted another's files. `enforceRetention` still sweeps the old flat layout for
files written before the fix -- a `local`-only concept, since the `s3` store has
never had a layout without an owner in the key, and one the listing marks
`legacy` so nothing downloadable is served from it. The folder browse and
validate endpoints are admin-gated at the controller, and under an `s3` store
they answer a typed refusal rather than walking a filesystem that has nothing to
do with where the bytes are.

**The store and the off-machine destination must be two places**
(INV-BACKUP-007). The store's variables are `BACKUP_STORE_S3_*` and the
off-machine destination's are `BACKUP_S3_*`; a deployment whose two resolve to
one bucket and overlapping prefix is refused at the boot. This is the one place
in this document where two external side effects have to be told apart rather
than ordered: the off-machine copy exists to survive the loss of the store, so
one bucket holding both is a 3-2-1 arrangement that is actually a 1, and every
ordering rule below would still hold while the arrangement protected nothing.

**Switching stores is forward-only.** Nothing is migrated; the previous recovery
points stay where they were, invisible to the new store's listing. The
capability report carries the count of artifacts the current store holds so the
gap is visible rather than inferred, and the operator keeps the old volume or
bucket until the new store has a full retention window.

**Encryption.** A support backup is unconditionally encrypted -- the DTO's
`password` is required, and there is no code path returning an unencrypted
support buffer, because a support backup exists in order to leave the user's
machine. An automatic backup is encrypted when a usable backup key exists (a
data key the server holds, wrapped under the user's password, never the password
itself; `docs/specs/backup-envelope-key-wrapping.md`); when a stored key cannot
be decrypted (a rotated `ENCRYPTION_KEY`) the backup is **refused** rather than
silently written in clear. Refusing is the right failure: it is
visible, and it does not downgrade.

**The writability probe** on the `local` store names its file with
`randomUUID()`, so two users or two replicas probing the same folder in the same
millisecond cannot collide on the name, and the `unlink` sits outside the `try`
that decides the verdict: the write is the answer, and a probe file that could
not be removed is a warning in the log, not a "not writable" that would
contradict the write that just succeeded. The `s3` store probes with a
`HeadBucket` instead -- it says the bucket exists and this credential reaches it
without writing an object into somebody's recovery points to find out.

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

Most callers are crons, and each has a different amount of protection:

| Sender | Duplicate protection |
| --- | --- |
| `BillReminderService` | Full, and the opposite trade from `ProviderOutageAlertService`. A `claimLease(JobClaimType.BillReminder, ...)` excludes the other replicas for the length of an SMTP round trip, and `markDelivered` writes the durable record **after** the send; the next run re-reads it and skips. The key is `buildReminderClaimKey` -- the run's date plus a sha256 digest of which bills the reminder covers -- so a second bill falling due later the same day is still a reminder to send, and the same set is not re-sent tomorrow. The run's date is passed in rather than read per user, because a run spanning local midnight otherwise claims the early users under one key and the rest under another. The contract is **at-least-once**: a process killed after SMTP accepted but before the record committed re-sends next run, which is the right way round for a reminder. |
| `MortgageReminderService` | The same lease plus delivery record, under `JobClaimType.MortgageReminder`, checked with `wasDelivered` before the send and written with `markDelivered` after it; a lease the send does not use is handed straight back rather than held for its TTL. Its key is fingerprinted on the mortgages and their term-end dates, but the date half is read from the clock inside the key builder rather than passed in from the run, so the midnight split the bill reminder pinned is still reachable here. |
| `BudgetAlertService`, daily alerts (`0 7 * * *`) | Full, by insert-winner, since migration 140. The in-memory dedup against existing rows by `(budgetId, type, budgetCategoryId, periodStart)` is a check-then-act and never was the arbiter; the unique fingerprint index is, through `NotificationService.create`, which answers `null` for the replica that loses the race so only the winner emails. `isEmailSent` is set after the send, so a crash in between leaves it `false` forever without causing a duplicate. |
| `BudgetAlertService`, weekly digest (`0 7 * * 1`) | Full, by lease plus delivery record, the bill reminder's shape. The digest is composed from rows the daily alerts already wrote, so nothing is inserted and the fingerprint index has nothing to arbitrate; before this it sent unconditionally, so N replicas sent N copies. `JobClaimService.claimLease` under `JobClaimType.BudgetWeeklyDigest`, keyed by user and the run date read once per run, excludes the other replicas for the length of one SMTP round trip; `wasDelivered` is re-read under the lease and `markDelivered` is written after the send. A failed send releases the lease so the next run retries. **At-least-once**: a crash between SMTP accepting and the record committing re-sends once. |
| Emergency-access grant | The one deliberate design. See section 5. |
| `SystemAlertService` | Full, by insert-winner. Each admin's alert row goes through `NotificationService.create`, whose `INSERT ... ON CONFLICT DO NOTHING RETURNING id` is arbitrated for these rows by the partial unique index from migration 170, and the email goes only to rows the INSERT returned -- with the same at-most-once trade as `ProviderOutageAlertService`: a crash between the commit and SMTP loses that email, and the in-app row survives as the durable notice (`docs/specs/system-alerts.md`, INV-ALERT-001). |
| Self-service email change (`EmailChangeService`) | Request-driven, not a cron, and none needed: nothing is claimed by the send. The pending address and the sha256 of a single-use token commit first, then the link goes to the new address and a notice to the current one, so a link never names a token the database does not hold. A failed send is logged and the request still succeeds; the pending change expires after 24 hours or is replaced (token and all) by the next request. The confirmation (`AuthEmailService.confirmEmailChange`) sends nothing: one conditional `UPDATE ... WHERE email_change_token = $hash AND email_change_token_expiry > now()` applies it, the unique index on `users.email` refuses a lost race as a 409, and refresh tokens are revoked after the commit. Without SMTP the change applies on the password check alone, as registration creates verified accounts when it cannot send. |
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

Step 1 also takes the same `EmergencyAccessGrantNotify` delivery lease as the
step-1b resume path before it claims the grant, and releases it by token once
delivery ends, so a replica whose sweep sees the freshly claimed grant cannot
resume, and re-send, a delivery that is still in progress on the winner.

The reminder path keeps exclusion and the delivery record apart. It takes
`claimLease(JobClaimType.EmergencyAccessReminder, owner, <server-local day>)` so two
replicas cannot send at the same moment, then re-reads `last_reminder_sent_at`
under that lease and skips if today's reminder is already recorded; the record
is written only after the send succeeds, and a failed send hands the lease back
without writing it. What remains is the window between the SMTP accept and that
`UPDATE`: a process killed there leaves no record, so a replica whose sweep
reaches that owner after the ten-minute lease has expired sends the reminder
again the same day. A duplicate reminder is the survivable direction against a
missing one.

Claim consumption itself sends no email, so there is no external-effect question
there; it is a single conditional `UPDATE ... WHERE claim_token_used_at IS NULL`
(INV-CLAIM-001), which `docs/concurrency-and-idempotency.md` lists among the
conditional claims that exist.

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

**AI insights.** Exclusion is a durable lease:
`generateInsights` (`backend/src/ai/insights/ai-insights.service.ts`) takes
`claimLease(JobClaimType.AiInsightGeneration, userId, ...)` and releases it by
token in its `finally`, so two replicas, or a manual regenerate and the daily
cron, cannot generate for one user at the same time. The in-process
`generatingUsers` `Set` remains only as a local short-circuit. The 12-hour
cooldown (a read of the most recent `generatedAt`) is taken twice: before the
lease as the cheap early out, and again under it, which is the read that
decides. The winner saves before its `finally` releases the lease, so a replica
that read "nothing recent" while the winner was still generating, and claims the
lease the moment it is released, finds the winner's rows and stands down instead
of saving a second set; the inserts carry no idempotency key, so this re-read is
what keeps the rows single. What remains is cost: only saved rows set the
cooldown, so a generation that saves nothing (a provider failure, a response
that parses to no insights -- `saveInsights` returns early on an empty list)
is retried by the next holder, which is the reason the lease is released rather
than kept. Ordering is at
least correct on failure: the provider is called and the response parsed before
anything is saved, so a failed call leaves no partial rows, and a total provider
failure throws rather than fabricating a result.

### Bank sync

A bank sync reads from the provider and writes only to PostgreSQL, so the
external call has no effect to undo; what it has to get right is the order
(`docs/specs/bank-sync.md` section 7). Every provider call runs outside any
transaction: the fetch first, then one `withScopedDb` write that inserts the
ledger row (`ON CONFLICT DO NOTHING RETURNING`, INV-BANKSYNC-001) before each
transaction row. A process that dies between the fetch and the write has
written nothing, and the next sync fetches again. The per-account lease
(`JobClaimType.BankSyncAccount`) is released in a `finally`; it saves the
bank's unattended-read allowance, and the ledger, not the lease, is what keeps
a race correct.

Two calls do have an effect at the provider. Starting an authorization is
preceded by durable state (the connection row with the state hash, EXT-001),
so an authorization that the user never completes is a `pending` row, not an
orphan. Disconnecting asks the provider to delete the session before the
local delete, and does not block on the answer: a session the provider kept
expires with its consent. The previous session after a re-authorization is
revoked the same way.

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
AI insights have no state beyond a time-window read; the bill and mortgage reminders have a lease and a delivery record but no state column tying them together.

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
| Mortgage reminder delivery key | The lease and the delivery record are in place; what is not is the run date. `buildMortgageReminderClaimKey` reads `new Date()` per user, so a run crossing local midnight claims some users under D and the rest under D+1 while the windows are measured from D -- the duplicate the bill reminder closed by taking the date as a parameter | EXT-001 |
| Emergency-access reminder | The lease and the delivery record are in place, and `last_reminder_sent_at` is re-read under the lease. What remains: a process killed between the SMTP accept and the record's `UPDATE` leaves no record, so a replica whose sweep reaches the owner after the lease expires sends again the same day -- the survivable direction | EXT-001 |
| AI insight generation | Duplicate rows are closed: the lease excludes concurrent generation and the cooldown is re-read under it. What remains is cost: only saved rows set the cooldown, so a generation that saved nothing is repeated by the next holder, a replica or a manual regenerate (a provider call, no rows) | EXT-001 |
| Payee contact enrichment | In-flight guard and admission queue are process-local; two replicas can both pay for one lookup (the second UPDATE affects zero rows, so the data is right and only the cost is duplicated) | EXT-001 |
| Off-machine backup copy (email) | An accepted trade, not an omission: a claim expired by the lease is re-attempted, and SMTP offers no way to tell a message already delivered from one never sent, so the same artifact can arrive twice. Delivering a duplicate copy is the survivable direction against never delivering it | EXT-003 |
| Off-machine backup copy (S3) | A stuck `uploading` row is reclaimed after the lease and re-attempted, reconciled by digest. What remains: nothing reconciles a bucket object against the ledger, so an object written by an attempt whose row never reached `uploaded` is referenced by nothing -- bytes nobody references, the survivable side, and the operator's lifecycle policy is what ages them out | EXT-003 |

Six workflows are absent from this table on purpose, and all six are settled:
per-user backup sharding with admin-gated folder endpoints, the FX/price
natural-key upserts, the atomic backup write with its in-document completeness
verdict (INV-BACKUP-001), the UUID-named writability probe whose failed cleanup
is a log line rather than a verdict, the budget alerts (migration 140's unique
fingerprint, arbitrated through `NotificationService.create`, so only the
replica whose INSERT returned a row emails), and the bill reminder (a lease plus
a delivery record written after the send, keyed on the run's date and the set of
bills). Section 5's grant-commit-after-delivery belongs in the same category.
Those are the patterns the rest of this table should be closed by imitating.
