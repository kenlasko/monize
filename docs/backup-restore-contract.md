# Backup and restore contract

What a Monize backup promises, what it deliberately does not, and where the
boundaries are. Written because these guarantees were spread across five files
and a set of assumptions, and the gaps between them were where the defects lived:
an audit found a backup that could not be restored, attachments that came back
pointing at nothing, and a de-identified artifact carrying a user's name.

Read this before changing anything under `backend/src/backup/`.

For what was done about each audit finding that produced these rules -- including
the ones deliberately left open -- see the issues those findings were filed as
(#1069, #1070, #1071, #1073) and, for the full response, the audit branch's
`claude/detailed-error-review-4pbug7:docs/audit-phase-3-response.md`. That path is
branch-qualified on purpose: it is not a claim about this tree, and the doc-path
guard reads it as such.

## 0. Where the code lives

`BackupService` is a facade, not the implementation. Issue #1092 split the
original 2,600-line class into four components, each of which owns one of the
concerns this document describes:

| File | Owns |
|---|---|
| `backend/src/backup/backup.service.ts` | The facade the controller, the auto-backup cron and the support export call. One delegation per method, no decisions. |
| `backend/src/backup/backup-export.service.ts` | §1 and §4's export half: the `REPEATABLE READ` snapshot, the streamed and buffered assemblies, the carried attachment bytes, the completeness report. |
| `backend/src/backup/export-cursor.ts` | §6's bounded reads: the database cursor every export table is fetched through, and the batch sizes. |
| `backend/src/backup/export-json-stream.ts` | The document, assembled one row at a time under a chunk budget (and the in-memory collection the support export needs). |
| `backend/src/backup/export-attachments.ts` | The completeness audit that holds no bytes, and the external objects carried one at a time. |
| `backend/src/backup/export-writer.ts` | gzip, the encrypted container, backpressure, and unwinding when the client leaves. |
| `backend/src/backup/backup-envelope.ts`, `backup-stream-crypto.ts`, `backup-key-wrap.ts` | The encrypted-backup format: all three container versions, the framed writer and reader, and the key-wrapped (v3) container the automatic backup writes. |
| `backend/src/backup/backup-restore.service.ts` | §3 and §6: the processing gate, decryption, decompression, format validation, re-authentication ordering, id remapping, and the one transaction the rest runs inside. |
| `backend/src/backup/backup-attachment-transfer.service.ts` | §4's restore half: staging carried bytes, the legacy ownership proof, and both object-store cleanup paths. |
| `backend/src/backup/backup-restore-database.service.ts` | The restore's SQL: teardown, currency preparation, row inserts, deferred-FK repair. |
| `backend/src/backup/backup-format.ts` | The file format itself -- version, `BackupData`, the two result types -- shared by all four. |
| `backend/src/backup/export-table-queries.ts` | §2's other half: what is read, in what order, and what is deliberately not read. |
| `backend/src/backup/restore-plan.ts` | §2: insertion order and deferred foreign keys, as data. |

The split is why §4's ordering rule is reviewable at all: the object store is
touched from exactly one of these files, and the transaction is opened in exactly
one other.

## 1. What travels in a backup

Everything the export produces, in one gzipped JSON document with a
`version`/`exportedAt` envelope. Coverage is not a judgement call: the guard test
in `backend/test/integration/backup-restore.integration.spec.ts` fails unless
every live table is either exported or named in
`INTENTIONALLY_EXCLUDED_TABLES` with a reason.

**Included and complete:**

- Every user-owned table in `RESTORE_PLAN` (`backend/src/backup/restore-plan.ts`).
- Attachment **metadata** for every provider.
- Attachment **bytes** for every provider, base64-encoded in `attachment_blobs`.
  (This said "only for the `database` provider" long after section 4 stopped
  being true of it.) See section 4.
- Every currency definition the user's data references, whoever created it —
  not just the ones they created. Currencies are shared, and a code without its
  definition means the restore invents a name, symbol and decimal places.
- AI provider API keys and the Google Places key for the payee lookup,
  **decrypted**, in `api_key_plaintext` (both tables spell the column
  `api_key_enc`, which is what makes one transport serve them)
  (`backend/src/backup/ai-provider-key-transport.ts`). `api_key_enc` is
  ciphertext under `ENCRYPTION_KEY`, which is server configuration and cannot
  travel — shipping the master key beside the ciphertext would make encrypting
  the column pointless — so the key is decrypted on the way out and re-encrypted
  on the way in under whichever key the receiving instance holds. The exported
  row's `api_key_enc` is nulled: one secret, one representation.

  **The artifact therefore holds third-party credentials in the clear.** A backup
  encrypted with the user's password is fine; an unencrypted export (an OIDC
  account that has set no backup password) and an unencrypted automatic backup on
  disk are not, and `BackupExportService` logs when it writes one. The support
  (de-identified) backup drops `ai_provider_configs` and
  `payee_lookup_settings` outright
  (`support-backup-rules.ts`) and must keep doing so.

  A key the exporting instance cannot itself decrypt travels as ciphertext,
  unchanged — that is the pre-transport behaviour, so an artifact is never worse
  than the one this replaced, and a restore back onto the instance that wrote it
  still works.

**Deliberately excluded**, each for a stated reason in
`INTENTIONALLY_EXCLUDED_TABLES`: the `users` row itself, credentials and sessions,
the undo log, regenerable AI caches, global `exchange_rates`, cross-user sharing
and emergency-access configuration, and import working state.

### The export is one snapshot

Every table is read inside a single `REPEATABLE READ` transaction
(`inExportSnapshot`). This is not an optimisation. With a transaction per table,
a backup taken while the user was active could contain a transaction whose
account was created after the `accounts` query ran — a file that verifies, gzips
correctly, and fails on restore with a foreign-key violation. READ COMMITTED is
not sufficient even as a single transaction: it takes a fresh snapshot per
statement.

The cost is one pooled connection and a held `xmin` for the duration — for the
streaming export, the duration of the download. That is the price of a backup
that restores.

## 2. Ordering is data, not a sequence of calls

`restore-plan.ts` declares three things:

- `RESTORE_PLAN` — the insertion order, and whether `user_id` is forced.
- `DEFERRED_FK_COLUMNS` — columns stripped on insert because they point forward
  or at the row's own table.
- `DEFERRED_FK_REPAIRS` — the Phase-3 `UPDATE`s that put them back.

`restore-plan.spec.ts` parses every foreign key out of `database/schema.sql` and
proves no restored table references a table inserted later, or itself, unless the
column is stripped and repaired. It also fails on a deferred column that names no
real FK (a rename), a strip with no repair (a silently dropped link), and a repair
with no strip.

**A migration that adds a foreign key between two backed-up tables must keep that
test green.** `accounts.linked_loan_account_id` is why the test exists: a
self-referential FK from migration 093 that nobody added to the deferred list, so
every user who linked a property to its mortgage held a valid backup that could
not be restored — and nothing said so until the restore ran.

### Notification field bounds on restore

`notification-restore-bounds.ts` validates notification title/target/dedupe-key
types before re-authentication, attachment staging and any destructive SQL.
The dynamic insert applies `boundRestoredNotification`, sharing the producer
door's bounds: titles over 255 UTF-16 code units get an ellipsis, dedupe keys
are truncated to 120, and targets over 255 are dropped rather than cut.
Each adjustment is logged. This deliberately normalizes oversized archive
values instead of failing with PostgreSQL 22001; source IDs (after remapping),
timestamps and other notification fields retain the normal restore policy.
The same-origin navigation check remains at each consumer.

## 3. Rejection happens before the destruction

A restore deletes everything the user owns and then inserts the backup, in one
transaction. Everything that can refuse the request must refuse it before the
delete:

- decryption;
- decompression, under a hard expanded-size ceiling (section 6);
- version and envelope validation;
- **the reference graph** (below);
- re-authentication (section 5);
- **staging of external attachment objects** (section 4).

That list is in execution order, and the position of re-authentication is a
decision rather than an accident: it is last among the refusals because the OIDC
artifact is single-use and minting a replacement costs the user their file
selection, so nothing that can fail for free may fail *after* it. Section 5 has
the reasoning. What the ordering must never become is re-authentication after any
write — the check precedes every `DELETE FROM` on every path.

Any SQL or foreign-key error rolls the whole transaction back. The one effect
that is not transactional is the object store; that is what makes staging-first
necessary rather than merely tidy.

### A restored reference names a row of the same file (INV-BACKUP-009)

The uploaded document is untrusted, and `RLS_MODE` defaults to `off`, so the
restore code is the only thing between a crafted file and another user's rows.
`insertRows` forces `user_id` on the tables that have one; every other
identifier comes from the file. That used to be enough only for the ids the
remap recognised: a reference to a row the file did not contain (another user's
account on a transaction, their security on a price or holding, their schedule
on an override) was inserted verbatim, and a primary key spelled in a UUID form
PostgreSQL accepts but `UUID_REGEX` does not (no hyphens, braces) escaped the
remap, conflicted on insert, and was then rewritten in place by the Phase-3
`UPDATE ... WHERE id = $2`.

`resolveRestoreReferences` (`backend/src/backup/restore-references.ts`) now runs
before re-authentication -- it is free, and it writes nothing:

- every UUID primary key and reference column is canonicalised with
  `canonicalUuid`, which accepts exactly the spellings PostgreSQL's `uuid`
  input does; a key or reference that is not a UUID refuses the restore;
- every reference must name a row of the referenced table **in the same file**,
  or the restore is refused with a 400 naming the table, column and value. The
  reference columns are `RESTORE_REFERENCE_COLUMNS`, which
  `restore-references.spec.ts` checks against every foreign key and every scalar
  UUID column of every restored table in `database/schema.sql`;
- two columns a genuine export can leave dangling are set NULL instead and
  logged (`SEVERED_WHEN_UNRESOLVED`): `transactions.linked_transaction_id`,
  whose counterpart is another user's transaction on a cross-owner transfer --
  so a restore now comes back with such a leg unlinked rather than re-linked
  one-way to a row the file cannot vouch for -- and `accounts.institution_id`
  from a backup older than the institution export.

Every key is then remapped to a fresh id, so the restored graph is closed over
rows this restore inserted. A UUID nested in a JSONB or array value
(`tag_ids`, override `splits`, `monte_carlo_scenarios.account_ids`, report
filters) cannot be classified by column, so one that names no row of the file is
replaced with a fresh id that names nothing (`remapRestoreRow`); it was a stale
reference or someone else's, and neither may come back as a working pointer.
Finally, every Phase-3 repair is confined to the restoring user's rows --
`user_id = $3`, or the owning parent's for a table without one
(`DeferredFkRepair.ownedThrough`) -- as the guard that still holds if an id ever
reaches it by another route.

## 4. Attachments: the bytes travel

**A backup that cannot restore an attachment is not a backup of it.** That
sentence took four attempts to arrive at, and it is the whole of this section.

For the `database` provider the bytes were always in the artifact, base64 in
`attachment_blobs`. For `local` and `s3` they were not: the artifact carried
metadata, and the operator was told to restore the sidecar volume or bucket
alongside it. Every problem below follows from that split, and the fix is to end
it — **the export now reads every external object and carries it in
`attachment_blobs` too** (`externalAttachmentRows`), for all three export
paths.

That makes the artifact self-sufficient, which has three consequences:

- **Recovery works where it has to.** A fresh instance, and an account whose
  attachment metadata was deleted, both restore. Under the previous design neither
  could: the restore has to prove the caller may read an object before reading it,
  the only available proof was a current `transaction_attachments` row, and in both
  those cases there is no such row. So the two situations backups exist for were
  precisely the two that returned success with the attachments counted as skipped.
- **No authority question arises.** The bytes are inside a file the user
  downloaded, so there is nothing to authorize. This is what the rest of this
  section spent two rounds failing to achieve with checks on uploaded fields.
- **The provider is the target's decision.** A backup taken under `local` restores
  onto a `database` deployment and vice versa; the bytes land wherever this runtime
  keeps them and `storage_provider` is rewritten to match. Both directions used to
  be an unrestorable skip.
- **The export reads each row's own backend, not the bound one.** Those two differ
  while a storage switch is being relocated (`AttachmentStorageMigrator`, and
  `docs/external-side-effects.md` section 2), so comparing every row against
  `ATTACHMENT_STORAGE_PROVIDER` counted each not-yet-moved attachment as missing and
  made the artifact **incomplete** -- for bytes the process could read perfectly
  well. Readability is now `AttachmentStorageRegistry.resolve`, so an artifact taken
  mid-relocation is complete. A row naming a backend this deployment has no
  configuration for is still counted missing, which is the honest answer: nothing
  can read those bytes here.

What it costs, stated plainly: artifacts are larger. What it no longer costs is
memory. The export used to accumulate every carried object as base64 in one array
before serialising — thirty 10 MiB receipts are ~400 MiB of text on a pod the
chart sizes at 400 MiB — and each object is now opened, written and dropped one
at a time (§6). The bytes still have to travel for the backup to be a backup;
they no longer have to be resident all at once.

**An omitted or inconsistent object does not silently pass as a complete backup
(F3R7-001).** An object the store cannot produce is logged and omitted — the ledger
is the point, and one unreadable receipt must not cost the user the whole file — but
the artifact is then **incomplete**, and the export says so. Every buffered export
returns a `BackupCompletenessReport`: how many attachment rows were expected, how
many had their bytes, how many were missing or (for the database provider,
`auditAttachments`) inconsistent with their metadata. The auto-backup
path acts on it — a partial artifact is written so the ledger is captured, but it is
**never promoted to weekly/monthly, never given a complete artifact's filename, and
never counted as one by retention**, so it cannot displace or age out a complete
copy, and its status is `partial`, not `success`. A later complete backup resumes
normal promotion and retention. This is the invariant that a backup shown as
successful is one that restores in full; section 7 has the on-disk half of it.

**The claim travels inside the artifact too (F3RB-001, issue #1069).** Every
buffered and streamed export writes a `completeness` member into the envelope,
beside `version` and `exportedAt`, holding the same report. Completeness used to
live only in `auto_backup_settings.lastBackupStatus`, which is state on the instance
that produced the file: copy the artifact elsewhere, restart, or find it in a
directory rescan, and a partial one was indistinguishable from a complete one. A
restore reads it back through `parseArtifactCompleteness` and logs what cannot come
back from that file — it does not refuse, because restoring a partial artifact is
usually the whole point and the alternative on offer is nothing. Three states, not
two: `complete: true`, `complete: false`, and **absent**, which means the artifact
predates the field and makes no claim at all. Absent is never read as "incomplete".

**The verdict is reached before the first byte, and without holding the bytes.**
The completeness report is produced by an audit (`auditAttachments`) that runs
inside the export snapshot ahead of the body: for the `database` provider,
Postgres computes `octet_length` and `sha256` over each blob and only the digests
travel; for `local`/`s3`, each object is opened, checked and dropped. Because both
passes read the same `REPEATABLE READ` snapshot, the database half of the verdict
is a fact rather than a forecast. The external half costs one extra read of each
object — the deliberate price of knowing the answer before the download starts,
and it trades bounded work for bounded memory rather than the other way round. An
object that changes between the two passes is caught again by the second and
logged; the artifact never carries an object the headers said was missing.

**A `sha256` and a `byte_size` are checked against the carried bytes**, at both
ends. One comparison, `attachmentBytesConsistent` (`attachment-integrity.util.ts`),
used from both ends with different provenance — and `attachmentDigestConsistent`
beneath it, so the audit's SQL-computed digest goes through the same judgement
rather than restating it in SQL. At export, the store is compared
against the database, so a source object that was truncated or replaced is caught
before it is packaged. At restore, the carried bytes are compared against their own
metadata — same file both sides, so that proves consistency rather than authority,
catching a corrupt or truncated artifact.

### The legacy path, and why it is still ownership-gated

An artifact produced before the above carries no external bytes. For those, the
restore still reads the source object from the store, and everything below applies:
the read is gated on the restoring user currently owning a matching row. Nothing
here is dead code — it is what an older file gets — but it is no longer the path a
new backup takes, and the disaster-recovery cases it cannot serve are the reason the
bytes now travel.

`storage_key` equals the attachment's UUID, and a restore mints a fresh UUID for
every row. Two obvious approaches are both wrong:

- **Remap the key and stop there** (what the code did): metadata points at
  `<new-uuid>` while the object is still at `<old-uuid>`. Every externally stored
  attachment is unreachable after a restore that reported success, and restoring
  the sidecar directory byte-for-byte does not help, because the mismatch is in
  the database.
- **Preserve the old key**: the bytes are not in the backup, so restoring into a
  different user on the same instance hands that user working links to files whose
  contents they were never sent.

So the bytes are **copied**. Before the destructive delete, each external object
is read at its old key, checked against the byte size and SHA-256 the metadata
claims, and written under the new key. The new keys are recorded so a failed
database transaction can remove them again. Old-key objects are left alone: the
same backup may be restored more than once.

**Both keys are derived, never read from the file.** The destination is the
remapped attachment id; the source is the id the backup was written with. The
uploaded `storage_key` is overwritten with the derived value before the insert and
is otherwise ignored, for every provider.

**And the right to read a source object comes from the database, not the file.**
Before any external object is opened, the restoring user must currently own an
attachment with that original id, on the configured provider, whose stored byte
size and SHA-256 equal the ones the uploaded row publishes — read from
`transaction_attachments`, which is still intact because staging runs before the
destructive delete. Integrity is then checked against the *stored* values, so an
object that changed under the row since is caught too. A row that fails any of
this is unrestorable: dropped and counted, with no read attempted.

This is a confidentiality boundary, not tidiness, and it has been got wrong twice
— the second time as the fix for the first:

1. The destination came from `row.storage_key`, and a key the restore did not
   recognise as a remapped id was treated as legacy or operator-chosen: skip the
   load, skip the checksum, skip the copy, on the reasoning that the object already
   sat where the metadata pointed. A crafted backup could therefore name *any*
   syntactically valid key — including one belonging to another tenant — and the row
   was inserted under the uploader's `user_id` without a byte being read.
   Downloading their own metadata returned somebody else's receipt.
2. So both keys were derived from the identifier remap instead, with "a row whose
   id is not in the remap did not come from this backup's graph" as the boundary.
   But the graph is the *uploaded* graph: `collectRowIdRemap` admits every
   UUID-shaped `row.id` in the file, so for a well-formed crafted row that guard
   could not fire. Put the victim's attachment id in `transaction_attachments.id`,
   with the byte size and hash a standard backup publishes beside it, and the
   restore read their object and copied it under the attacker's ownership. The
   uploaded document was authorizing itself.

`assertSafeStorageKey` establishes that a key is a safe *string*; nothing there
establishes that an object is *theirs*. Which field to trust was never the
question: **no unsigned value from the uploaded file can establish ownership — not
a key, not an id, not a checksum, not a byte count. Only a record the server
already holds can.**

The consequence is deliberate and matches what this section already concluded
about preserving the old key: restoring one user's backup into a **different** user
on the same instance skips external attachments rather than disclosing them, and a
fresh instance skips them because the objects are not there. Those attachments show
up in `skippedAttachments`, so the user is told.

An object that cannot be staged — missing, failing its checksum, or written by a
different provider — makes that attachment unrestorable. Refusing the whole
restore over a receipt image is the wrong trade, so the metadata row is dropped
and counted. **The count is reported as `skippedAttachments`, beside `restored`
and never inside it**: the client sums `restored`'s values into a row total, and
rows deliberately not written must not be counted as written.

**The objects the restore displaced are deleted after it commits.** A destructive
restore removes every `transaction_attachments` row the user had, and for `local`
and `s3` the bytes are not in those rows — so they used to stay in the volume or
the bucket forever, referenced by nothing. A receipt or a medical document survived
the replacement of the account it belonged to, remained in whatever backs that
storage up, and could never be found again because the metadata naming it was gone.

The timing and the scope are both load-bearing:

- **After the commit**, because bytes deleted before a transaction that then rolls
  back leave a row promising a download that does not exist — indistinguishable
  from a working attachment. Same rule as `AttachmentsService.remove`.
- **Only keys the target user held**, read before the delete because afterwards
  there is nothing to read them from. Never the old keys named by the uploaded file
  — for the legacy path, those are the source objects it reads, and the same file
  may be restored twice. (The original wording here said a cross-user restore
  "legitimately reads another user's objects as its source". That has not been true
  since the ownership rule above: such a read is now refused. The rule stands for
  the reason that survived, which is repeat restore.)
- **Never a key the restore just staged.** Restoring a backup taken from the same
  account re-uses ids, so a displaced key and a newly written key can be the same
  string.
- **Never a key the backup reads as its source.** A backup taken from this account
  names the keys this account currently holds, so its source objects *are* its
  displaced objects. Deleting them left the artifact naming bytes that no longer
  existed: the first restore worked, and a second restore of the same file skipped
  every attachment and then deleted the copy the first restore had made — losing
  the content entirely while still reporting success.

  When a key is both an orphan and a source, **the source wins**. That knowingly
  keeps an object nothing in the database references, which is what this cleanup
  exists to remove — and it is the right way round: an orphaned copy of the user's
  own receipt costs storage, while a backup that can only be restored once costs
  the receipt.

**The objects the restore staged are discarded when it fails.** Staging writes
bytes to the store *before* the destructive transaction, so a failure between
the first successful write and the transaction's `.catch` would leave those
objects orphaned — bytes no row will ever name again (issue #1094). Two throw
sites are handled so it does not:

- A destination write that fails *inside* the stage loop drops that one
  attachment rather than aborting the whole restore (`tryStageAttachmentObject`):
  it best-effort deletes the object it was writing, logs, and counts the row in
  `skippedAttachments`. The objects already staged this run stay — they are
  referenced by attachments still being restored. Crucially, a **legacy** row's
  source object (`sourceKeys`) is recorded the moment its bytes are read and
  verified, *before* the copy is attempted, so a failed copy on a same-account
  restore never lets the post-commit sweep delete the file's only copy of those
  bytes.
- The displaced-key lookup and the AI-provider re-keying run after staging but
  before the transaction's `.catch` is wired; a throw there discards every staged
  object before re-raising. The discard swallows its own delete failures, so a
  failed tidy-up cannot mask the error that aborted the restore.

**Known gap:** this covers *catchable* failures only. A process crash or kill
between staging and commit still orphans the staged objects, and there is no
sweeper or recovery pass for them yet. It is a bounded storage cost, never a row
promising bytes that are gone, so it is a leak to reclaim rather than a
correctness hazard — tracked as a separate follow-up, not closed by the #1094
fix.

Operationally: for an artifact that carries its own bytes there is nothing to
restore alongside it — that is the point. The sidecar directory or bucket only
matters for an artifact produced before the bytes travelled, and for those it must
be restored **before or alongside** the database *and* the target must still hold
the attachment metadata. If it does not — a fresh instance, a deleted attachment —
those bytes are not recoverable from that artifact at all, whatever order they are
restored in, and the restore reports them in `skippedAttachments`. Take a fresh
backup to get a self-contained one.

**`storage_key` is attacker-chosen input.** It is a column, and a restore writes
it from the uploaded file, so by the time a provider sees it the key may be
anything. Every provider therefore addresses objects through
`assertSafeStorageKey` (`attachments/storage/storage-key.util.ts`), whose
allowlist excludes `.` and `/` so neither a traversal segment nor a separator can
be expressed. The S3 provider lacked this while the local one had it, which made
a crafted key address arbitrary objects in the bucket -- an S3 prefix is a naming
convention, not a boundary. `storage-key.util.spec.ts` asserts every provider in
the module routes its key through the validator, and names the database
provider's exemption (a parameterised primary-key lookup) rather than assuming
it.

## 5. Confirming a destructive restore

`verifyAuthentication` in `backend/src/backup/backup-restore.service.ts` decides
this, and it has exactly three branches — there is no fall-through that proves
nothing:

| Account | Second proof |
|---------|--------------|
| Local, password set | `password`, bcrypt-checked against `passwordHash`. |
| Local, no `passwordHash` (admin-provisioned, reset never completed) | **Refused.** No proof is available, so the restore is not offered — this branch used to fall off the end of the `else if` and require nothing. |
| OIDC | A signed, action-bound, single-use re-authentication artifact from `OidcReauthService`, consumed for the purpose `"restore-backup"`. |

### The OIDC artifact, and what it replaced

Until #1060 this branch read `if (!input.oidcIdToken) reject` and nothing else.
The frontend sent the literal `"oidc-session-confirmed"`, so `x` passed just as
well: the second proof for the most destructive action in the product was
possession of the session that was already required (audit P3-009 / F3RB-007).

What is there now is `OidcReauthService`
(`backend/src/auth/oidc/oidc-reauth.service.ts`), shared by every destructive
surface rather than reimplemented per caller. `GET /auth/oidc/reauth?purpose=…`
sends the user to the identity provider with `prompt=login` and `max_age=0`; the
callback — after `openid-client` has verified state, nonce, issuer, audience and
signature — mints an artifact signed with `JWT_SECRET`, carrying the user id, the
purpose, a one-time `jti`, and a five-minute expiry. `consume(userId, purpose,
token)` checks all of it: signature, type, subject, action, freshness, single
use. Every rejection is the same `401` with the same message, because which check
failed is a fact about the server's state.

Two bindings matter and are easy to lose:

- **Purpose.** `"restore-backup"` is not `"delete-data"`. An artifact minted to
  empty an account must not authorize overwriting it with someone else's file.
- **The round trip.** The pending marker carries a hash of the `state` it was
  issued alongside, so an artifact is bound to *its own* challenge and not merely
  to the fact that one was started. Without that, an ordinary `GET /auth/oidc`
  answered silently from a live SSO session minted a valid artifact for a
  challenge nobody ever answered (FV-001).

`STEP_UP_PURPOSES` is a different mechanism for a different question, and this
path deliberately does not route through it: a step-up token is a second proof,
but for an OIDC account it was itself issued on a client-asserted
`oidcConfirmed: true`. That branch now consumes the same artifact
(`backend/src/auth/step-up/step-up.service.ts`), so there is one implementation of
cryptographic step-up in the repository rather than two.

### Naming: the header does not carry an ID token

The wire names are historical. The header is `X-Restore-OIDC-Token` and the field
is `oidcIdToken` (`backend/src/backup/backup-format.ts`,
`frontend/src/lib/backupApi.ts`), but the value is a Monize-minted
re-authentication artifact, **not** an OIDC ID token — nothing verifies it against
the provider's JWKS, and it would fail if it did. Do not add ID-token claim
checks here on the strength of the name.

### The artifact is spent last, and that is a requirement

The round trip that mints the artifact navigates away from the settings page,
which loses the user's file selection. So a restore that fails for a reason
having nothing to do with identity — a wrong backup password, a truncated file,
a foreign JSON document — must not cost one: the user would have to re-select a
large file *and* re-authenticate, and the retry's honest failure would read as a
spent artifact.

`restoreData` therefore runs everything free first — decrypt, decompress under
the expanded-size ceiling, validate the envelope — and calls
`verifyAuthentication` only once the file is known to be restorable. This is the
one place where section 3's "refuse before the destruction" ordering is refined
rather than simply followed: the check still precedes every write, but it no
longer precedes the checks that cost nothing. `backup.service.spec.ts` pins both
halves — a bad file leaves the artifact spendable, and no `DELETE FROM` reaches
the database on any path where the artifact is refused.

## 6. Size ceilings

Three, for three different failure modes. All configurable, all fail loudly.

| Setting | Bounds | Default |
|---|---|---|
| `BACKUP_RESTORE_LIMIT` | the compressed upload | the lower of the expanded ceiling below and what the container can hold |
| `BACKUP_RESTORE_EXPANDED_LIMIT` | the **decompressed** payload | `(headroom * RESTORE_HEADROOM_SHARE - fixed) / slope`, no floor |
| `BACKUP_EXPORT_BUFFER_LIMIT` | the artifact a buffered export may accumulate | a quarter of the container's memory limit |

The buffered default is cgroup-derived with a 64 MiB usability floor, a 1024 MiB cap
and a 256 MiB fallback when there is no limit to read. There are no fixed byte
defaults left; the `1024mb` and `512mb` this table used to name were the numbers that
could not fire.

**The two restore ceilings are the same number** — about 23 MiB on the chart's
default 400 MiB backend — solved out of the capacity rather than taken as a share of
it (issue #1073; the measured cost model is below). The compressed ceiling follows
the expanded one because gzip output is never smaller than what it expands to: an
upload above the expanded ceiling is one this deployment could never decompress. Two
separately derived numbers let a 66 MiB upload be accepted against a 100 MiB expanded
ceiling and refused at decompression; reading the *derived* ceiling instead of the
*resolved* one did the same to an operator who lowered
`BACKUP_RESTORE_EXPANDED_LIMIT`. It is the **lower** of the two, though: an operator
may raise what this deployment will attempt to decompress, but raising what
`express.raw` will buffer without raising the container is an OOM kill, so the wire
ceiling never rises above what the container can hold.

**Neither restore default has a floor, and that is deliberate (F3R6-005).** A
usability minimum and a safety maximum are different quantities: `max(64 MiB, safe)`
let the floor win, so on a 128 MiB pod the upload limit was 64 MiB whose modeled peak
exceeded the whole container. The safety bound is the only bound —
`baseline + restorePeakBytes(expanded) <= container` at every supported pod size,
asserted in `backup-limits.spec.ts` — so a small pod derives a small, safe ceiling
and `warnIfRestoreUploadLimitIsCramped` says so at startup.

**A container that cannot afford the fixed cost derives `0`, and that is a bigger
container than it sounds**: the fixed part is about 78 MiB, so anything at or below
roughly 220 MiB refuses every restore however small. Refusing is the point — the
measurement says those decodes do not complete — and the refusal is a 503 naming the
two levers, from the admission middleware as well as the processing gate, rather than
a 413 about a size no file could meet.

The compressed limit bounds nothing about what comes out of gzip: a few hundred
kilobytes of repeated text expands to gigabytes. Decompression is asynchronous
(libuv threadpool) with `maxOutputLength`, so a hostile payload neither allocates
past the ceiling nor blocks the event loop. `JSON.parse` still needs a whole
document — unavoidably — but it now gets a string of bounded length.

The buffered ceiling now applies to two paths, not three: the **automatic** backup,
which writes a file and therefore holds the artifact, and the **support** export,
which holds every table at once to reconcile scaled balances. Both HTTP downloads
stream and are deliberately unbounded. The encrypted download used to be on the
buffered side because AES-GCM's single auth tag needs the whole plaintext before
it can be computed; it writes a framed container now (below), so it streams like
the plain one and a large encrypted export is no longer refused.

**What that ceiling counts changed with it.** It used to bound the uncompressed
JSON, because that JSON really was accumulated — per-table strings, a
concatenated buffer and gzip's output all live at the peak. The buffered path now
holds only the compressed (and, when encrypted, framed) artifact, so the limit is
measured against the bytes actually resident. That is more permissive for
compressible data and stricter for attachments, which are already-compressed
bytes in base64 — and in both directions it is measuring the thing it protects
rather than a proxy for it. The quarter-share default already assumes the payload
is resident more than once, which covers the single `Buffer.concat` at the end.

**Every default is derived from the container's cgroup memory limit**, not fixed.
A ceiling larger than the process it protects cannot fire — the pod is killed
first — and all three used to be exactly that on the chart's 400 MiB backend.

**And the wire bytes are not the cost.** The upload limit was half the container on
the reasoning that a compressed upload is one buffer, unlike the several a buffered
export holds. That was wrong about what happens next: the request goes on to hold
the envelope, `decipher.update`'s output, `Buffer.concat`'s result, the decompressed
payload, the UTF-8 string and the parsed object graph, several of them at once. Half
of 400 MiB on the wire is `PEAK_MULTIPLE` times that at peak, so a *single* legal
request could not fit the pod it was sized for.

`PEAK_MULTIPLE` was `3` — a floor argued from counting those allocations rather than
from measuring them. The measurement replaced it with a **line**, not a bigger
multiple: the record's implied multiple rises as the artifact shrinks (6.9 at 96 MiB,
8.0 at 24 MiB) because part of the cost does not scale with the payload, so the model
is `restorePeakBytes(expanded) = 6.081 * expanded + 78 MiB` — the record's own
least-squares slope, and the intercept that puts the line above every one of its 36
measured cases. A line through the middle of the points is wrong half the time, and
the half it is wrong about is the half that OOM-kills a pod. `PEAK_MULTIPLE` survives
only as the upload gate's per-byte claim, where wire bytes make an exact model
impossible anyway.

An operator's explicit value always wins, and one too large for the container is
warned about at startup — against the ceiling actually in force, in the same units
they set, so the derived default never warns about itself and the figure the warning
suggests is one they can paste back. With no cgroup limit visible there is nothing to
warn against, and the check stays silent rather than quoting a fallback nobody
measured.

**The upload limit is the earliest one and therefore the only one that matters for
an oversized request.** `express.raw` buffers the whole body before the controller,
the guards, the authentication lookup, the decryption and every service ceiling, so
a request none of those layers ever sees can still kill the process.

**A per-request ceiling bounds one request, and the process has to survive two.**
The JWT guard and the `ThrottlerGuard` are both Nest guards, so neither runs until
after `express.raw` has buffered the body — nothing downstream can refuse an
allocation that already happened. `createRestoreUploadAdmission`
(`backend/src/backup/restore-upload-admission.ts`) therefore runs as Express
middleware **ahead of** the parser and keeps a process-wide total of the peak bytes
it has promised. Three properties, each of which was wrong once:

- **The claim is the peak, not the wire.** The first version reserved the declared
  `Content-Length`, which counts the smallest of the buffers a restore holds. Three
  60 MiB encrypted uploads declared 180 MiB, fitted a 200 MiB budget, and could pass
  540 MiB in flight. A request now claims `PEAK_MULTIPLE` times its wire bytes.
- **A reservation is held until the work is done, not until the socket shuts.**
  `ServerResponse` emits `close` when the connection ends, which is not the handler
  finishing. Releasing on `close` let a client upload a full body, let the controller
  enter `restoreData`, then hang up — freeing the reservation while the decryption,
  the staging and the SQL were still running, so a second large upload was admitted
  beside the first. The reservation now has a lifecycle: while *receiving*, a `close`
  releases it (nothing downstream took ownership); once the body has arrived, only
  the handler's `finally` (`releaseRestoreReservation`) or a completed response does.
- **A body that never arrives is reclaimed.** The gate necessarily runs before
  authentication, and a chunked request declares no length, so it reserves the whole
  ceiling. Without a deadline an unauthenticated client could trickle or withhold the
  body and hold the recovery path closed for as long as the socket survived — during
  exactly the incident a restore is for. A body that has not arrived inside
  `DEFAULT_RECEIVE_TIMEOUT_MS` gets a 408 and its socket destroyed. The deadline is
  armed only while receiving: a timeout on *processing* would be the
  release-too-early defect with a delay.

**Authorization now runs before the reservation (DR-F3RB-003).** An unauthenticated
client used to be able to occupy the budget for that bounded interval, so it could
make a legitimate caller retry — during exactly the incident a restore is for.
Authentication cannot move earlier, because Nest's guards run after parsing, so
authorization moved instead: a caller asks `POST /backup/restore/ticket` (ordinary
authenticated JSON, behind the JWT guard, CSRF and the throttler) for a short-lived
signed ticket, and the admission middleware verifies it **before reserving anything**.
An upload with no ticket is refused `403` having claimed no memory at all — `403`
rather than `401` because the caller's session is valid and it is this request that
carries no upload authorization, and because a client that reads `401` as an expired
session retries the request after refreshing its token: a silent re-upload of the
whole artifact, or a logout mid-restore.

The ticket is an HMAC over `{userId, expiresAt}` keyed by a value derived from
`JWT_SECRET` with a domain separator, not a database row
(`backend/src/backup/restore-upload-ticket.ts`). Three reasons, and one honest cost:
it verifies on any replica, where an in-memory single-use set would fail on the
multi-replica deployments that matter; verification is one HMAC, so the check in front
of the body parser stays synchronous and allocation-free, where a database round trip
there would be a new lever for the load the gate exists to refuse; and rotating
`JWT_SECRET` invalidates outstanding tickets, which is correct for a five-minute
credential. The cost is that it is **not single-use** — it can be replayed until it
expires. What that buys is bounded: the ticket authorizes *occupying upload budget*,
not restoring anything, since the restore still needs the caller's JWT, the CSRF pair
and (for an OIDC account) a single-use re-authentication artifact.

Two things remain unaddressed, and both are named rather than implied. Ingress-level
body and rate limits are a deployment concern the chart cannot express portably
(`helm/README.md` says which annotation to set, and that the Gateway API path has no
equivalent). And the memory shape itself: streaming the upload through decryption and
gzip into a bounded temporary file or an incremental parser is what would replace
`PEAK_MULTIPLE` with a real bound rather than a measured one.

**The compressed budget does not bound decompressed memory (F3R6-004).** A small
gzip expands to the `BACKUP_RESTORE_EXPANDED_LIMIT` ceiling regardless of its wire
size, so a request's *processing* peak — decompressed payload, string, parsed graph
— is independent of the compressed bytes the upload gate reserved against. Four
1 MiB uploads that each expand to the ~100 MiB expanded limit pass upload admission
on their small claims and then hold ~400 MiB between them. So restore *processing*
is capped separately: `restoreProcessingGate`
(`backend/src/backup/restore-processing-gate.ts`) admits only as many concurrent
restores as fit the container. The service acquires a slot before decompression and
releases it in a `finally`, and on the default pod the count is one — a second
restore waits rather than decompressing beside the first.

The slot count budgets against the numbers that actually cost (F3R7-002): each
restore's peak is `PEAK_MULTIPLE` × the **resolved** `BACKUP_RESTORE_EXPANDED_LIMIT`
`gunzip` enforces — so an operator override is accounted for, where the earlier
version modeled every restore at the derived default and admitted five 2 GiB
restores on a 16 GiB pod — and the ordinary process baseline
(`restoreProcessBaselineBytes`) is subtracted before dividing. When one modeled
restore does not fit at all, the count is `0` and **stays** `0` (F3RB-005): `acquire`
refuses with a 503 naming the levers (raise the container limit, or lower
`BACKUP_RESTORE_EXPANDED_LIMIT`), and startup logs the same thing as an error. There
is no floor left — an earlier version of this paragraph said the gate raised such a
zero back to one so a running process could always attempt a restore, which is the
behaviour F3RB-005 removed: admitting work the model says cannot fit turned a fixable
misconfiguration into an OOM kill mid-restore.

What the gate establishes is concurrency, and only concurrency. It used to establish
nothing else either, and could not: every ceiling in the chain was derived by dividing
by `PEAK_MULTIPLE` — `safeDerivedUploadLimit` *was* `container * share /
PEAK_MULTIPLE` — so none of them could vouch for it, and on the default 400 MiB pod
the model left 4 MiB spare against a break-even multiple of 3.04. What makes one
restore fit now is the ceiling it is admitted with, and that ceiling is solved out of
the capacity (below).
**The multiple was measured, and the derivation inverted (issue #1073).**
`backend/src/backup/restore-peak-rss.harness.ts` decodes generated artifacts in a
fresh process and records the peak; the committed result
(`backend/src/backup/restore-peak-rss.record.json`) puts the **decode phases alone**
at an implied multiple of 6.9 to 7.9 — rising as the artifact shrinks, because part of
the cost does not scale with the payload — and shows four of five 96 MiB artifacts
failing to decode inside the headroom the old model left on the chart's default pod.
`PEAK_MULTIPLE` is now `8`, from `MEASURED_PEAK_MULTIPLE` rounded up, and
`restore-peak-rss.record.spec.ts` holds the two to each other in both directions.

Raising the constant alone would have refused every restore on an ordinary pod,
because the expanded ceiling was a *share* of the container while the peak was a
*multiple* of the ceiling — the same number on both sides of the inequality. So the
ceiling is solved out of the capacity instead (`deriveRestoreExpandedLimitBytes`):

    expanded = (container - baseline) * RESTORE_HEADROOM_SHARE / PEAK_MULTIPLE

with no usability floor (F3R6-005: a floor resolved with `max()` beats the safety
bound it was meant to respect), a 1 GiB cap, and `0` where the container has no
headroom at all. One slot is then the answer by construction wherever there is
headroom: a bigger pod buys a bigger artifact, not a second concurrent restore, and
an operator wanting concurrency lowers `BACKUP_RESTORE_EXPANDED_LIMIT` deliberately.
The process baseline's floor moved from 96 MiB to the 140 MiB the chart *requests*,
because two numbers describing the same thing and disagreeing was the clearest
argument in the issue for measuring anything.

**The compressed ceiling is now the same number as the expanded one.** They were
derived separately, so the default pod accepted a 66 MiB upload against a 100 MiB
expanded ceiling it would then blow past on decompression. gzip output is never
smaller than what it expands to, so an upload above the expanded ceiling is one this
deployment could never decompress — refusing it before `express.raw` buffers it is
strictly better than refusing it after.

What this costs, plainly: the default 400 MiB pod now accepts about 23 MiB of
expanded artifact rather than a nominal 100 MiB, and a pod below about 220 MiB
accepts none. The nominal figure was never real —
attempting it lost the pod — so the trade is a readable refusal for an OOM kill, and
`resources.limits.memory` is the lever the startup warning already names. What is
still open: the measurement covers the decode phases only, so the multiple is a lower
bound, and no run has been cgroup-constrained, so "refused rather than killed" rests
on the model rather than on a demonstration.

**The queue behind those slots is bounded, deadlined and cancellation-aware
(DR-F3RB-002).** It was a plain array of resolve callbacks: no limit, no deadline,
and no removal when the request disconnected — so a client could hang up while
queued and its **destructive** restore still ran when a slot freed. Three bounds,
and one asymmetry that is the whole design:

- **`BACKUP_RESTORE_QUEUE_LIMIT`** (default 4) caps the waiters. A request arriving
  at a full queue is refused with 503 and `Retry-After` rather than joining it.
- **`BACKUP_RESTORE_QUEUE_WAIT_MS`** (default 120000) caps one wait, so nobody holds
  a socket and an upload reservation for a slot indefinitely. Same refusal.
- **A waiter whose caller disconnected leaves the queue and never runs.** The
  controller derives that signal from the response socket closing before the
  response finished, and the request answers 499 nobody reads.

The asymmetry: cancellation governs the **wait** and stops at the slot boundary. A
queued restore has done nothing and may be dropped; a restore holding a slot is
part-way through deleting and re-inserting the user's data, so no socket event
cancels it — the gate unsubscribes from the signal the instant it grants the slot.
This is the same receiving/processing split the upload reservation already draws,
and both halves are tested (`restore-processing-gate.spec.ts` for the gate,
`backup.controller.spec.ts` for where the signal comes from).

Why queue at all rather than refuse the second restore outright: the caller has
already uploaded up to `BACKUP_RESTORE_LIMIT` of artifact through a gate that
budgeted memory for it, and an immediate 503 makes them upload it again. The three
transient refusals — upload budget occupied, queue full, wait timed out — state one
fact ("capacity exists, not for you now") and carry one `RESTORE_RETRY_AFTER_SECONDS`.
The zero-capacity 503 carries no `Retry-After`, deliberately: retrying it without
changing the deployment cannot help.

**A budget checked after the allocation is not a budget.** The support export
always discards `attachment_blobs`, which is base64 — thirty 10 MiB receipts are
~400 MiB of text — and `collectRawExport` loaded it anyway before any ceiling was
consulted. It now takes a `skipTables` set, and a test asserts the support path
passes `ALWAYS_EXCLUDED_TABLES` — and, since attachment bytes now travel, that the
augmentation does not read a single object off disk for a table the caller is going
to discard either.

### The export is bounded by its chunk size, not by the dataset (F3R6-001, issue #1070)

This was open through five audits under four labels, and the shape of it never
changed: the export was described as streaming because it wrote a table at a
time, while each individual step held something whole. All of it is now a pull
pipeline, and each stage bounds the one before it:

- **Rows** arrive through a database cursor declared inside the snapshot
  (`export-cursor.ts`), so a table contributes a batch at a time rather than one
  `manager.query` result the size of the table.
- **`attachment_blobs` fetches one row at a time**, because one row is one whole
  base64-encoded object. That batch size is the number of attachments resident at
  once, and a source guard fails if it is removed.
- **The document is serialised per row** under a 256 KiB chunk budget
  (`export-json-stream.ts`) instead of one `JSON.stringify` per table, which used
  to make the array and a string of the array live at the same instant.
- **External objects are opened one at a time** and dropped once written, rather
  than accumulated into one array of base64 before serialisation began.
- **The writer resolves each write only when the pipeline has taken it**
  (`export-writer.ts`), so a slow client stops the database reads instead of
  letting a queue grow behind the socket, and a client that disappears unwinds the
  snapshot rather than pinning it.
- **The encrypted download streams too**, through the framed container below.

What is irreducible: one row. A 10 MiB attachment is 13.6 MiB of base64 whatever
the budget says, because a row is serialised whole. The floor is therefore the
largest single attachment, not the largest table.

**The framed encrypted container (`MZBE` v2).** AES-GCM's auth tag covers the whole
message, so a single-tag envelope cannot emit a byte until the last byte of
plaintext exists — which is exactly why the encrypted export buffered. v2 seals
256 KiB frames, each with its own tag, following the STREAM construction: the
nonce is `prefix || counter || finalFlag`, and the header is additional
authenticated data for every frame. So a frame cannot be reordered, duplicated,
moved between files, or **dropped from the end** — the frame that would become
last was sealed as non-final and is opened expecting the final flag. Truncation is
the failure a naive chunked format gets wrong, and half a backup that decrypts
cleanly is worse than one that does not decrypt at all. v1 envelopes still open:
every backup a user already holds is one, and the support export still writes one
because it assembles in memory anyway.

**The key-wrapped container (`MZBE` v3).** The automatic backup's frames are
v2's, sealed under a per-file key derived (HKDF) from the user's random data key
rather than under a key derived from the password, and the header carries that
data key wrapped under the password. The cron holds the data key and never the
password; the file still opens with the password alone, and the restore prompt
does not change. Readers accept v1, v2 and v3; the manual download still writes
v2 under the password typed for it. `docs/specs/backup-envelope-key-wrapping.md`
has the layout and the key flow.

**What this does not settle.** The claim is bounded peak RSS, and the honest
measurement of that is the cgroup-constrained harness this repository still does
not have (`DR-F3R6-002` / `DR-F3R7-003`). What the suite proves instead is the
property the claim rests on — the export never has the whole of anything in hand:
reads happen in batches, objects are opened one at a time between writes, bytes go
out before the last table is read, and a blocked client stops the reads
(`export-streaming.spec.ts`). The **restore** side's cost has since been measured
(§6, issue #1073) — a multiple of `3` when this paragraph was written, a measured
line now — but the restore's shape is unchanged: its `express.raw` upload is buffered
before any of our code runs, so making the restore stream is a different change from
this one, and it is what would replace a measured multiple with a bound.

## 7. Automatic backups in the store

**Who configures it, and where.** Automatic backup is a deployment/operator
concern, not an account preference, so its configuration surface is admin-only:
**Admin → Backups** (`frontend/src/app/admin/backups/page.tsx`, route
`/admin/backups`), reading and writing the admin-restricted `AutoBackupController`
endpoints. That page states plainly what an automatic backup is — a **compressed
per-user backup file** of a user's own financial records, written to the store on
a schedule and pruned by retention — and what it is **not**: a full
PostgreSQL/database dump. The schedule, folder and retention configured there are
**one deployment policy that every active account runs on** (below). It is
related to, but not the same on-disk format as, the manual per-account export a
person can download themselves. It does not capture the schema, another
deployment's data, or server configuration; whole-instance disaster recovery is a
separate backup of PostgreSQL and the attachment storage. A person's own manual
export/restore stays in **Settings → Backup & Restore**
(`frontend/src/components/settings/BackupRestoreSection.tsx`), open to every user
and touching only their own data. The two were previously stacked in one Settings
screen, which made a deployment policy look like a personal preference.

**Configuring the schedule is an operator's; the artifacts it produces are the
user's.** Settings → Backup & Restore therefore carries a folded **Automatic
Backups** listing
(`frontend/src/components/settings/StoredBackupsSubsection.tsx`) of the files
this server is holding for the signed-in account, with a download and a restore
per file. It reads `GET /backup/stored-backups` and
`GET /backup/stored-backups/:filename` on the *unrestricted* `BackupController`,
not on `AutoBackupController`: a user who may not change the policy still has to
be able to take and restore what it produced for them. Three things bound it —
only the caller's own server-computed folder is enumerated (never the legacy flat
root, whose filenames carry no owner), only names `classifyBackupFileName`
recognises are served, and the listing reports the caller's own `enabled` so the
section is absent on a deployment that runs no automatic backups. A download
opens what the **store** holds under that name, never the caller's string: the
requested name is matched against the store's own entry, which is what is opened
and streamed, so the value reaching the filesystem is one this deployment wrote.
On the `local` store the join is still containment-checked, because a validated
name with an unvalidated join is a decorative check; on the `s3` store the name
is composed into a key that cannot leave the user's prefix and there is no path
to traverse at all. The route streams the store's stream rather than a file
handle, and deliberately does **not** redirect to a presigned URL: that would
move an authenticated, demo-restricted, owner-scoped download onto a URL
carrying its own authority that outlives the request. Restoring from
that list **downloads the artifact and hands it to the existing restore form**,
so the encryption sniff, the warning, the account-password or OIDC confirmation
and the summary dialogue are the same ones a file picked from disk goes through;
there is no second restore path to keep in step.

**The policy is the deployment's, and it reaches every account.** What Admin →
Backups edits is one `AutoBackupPolicy` — `enabled`, folder, frequency, time,
timezone and the three retention counts. `AutoBackupService.reconcileManagedUsers`
writes it onto every active account's `auto_backup_settings` row, at the top of
the hourly cron and again the moment the policy is saved, so an operator does not
wait an hour to see a change take. The per-account row stays the runtime source
the cron claims and records against; only its **bookkeeping** columns
(`last_backup_at`, `last_backup_status`, `last_backup_error`, `next_backup_at`)
are that account's own. Three consequences worth stating:

- **Where the policy lives.** Its own singleton row, `auto_backup_policy` —
  a boolean primary key with `CHECK (id)`, the shape `update_check_state` and
  `push_instance_config` use. It is RLS-exempt (no owner column) and excluded
  from `INTENTIONALLY_EXCLUDED_TABLES`, so no account's archive carries it.
  It previously lived on the earliest-created active administrator's
  `auto_backup_settings` row, which let three ordinary operations silently
  rewrite a deployment-wide setting: **deactivating or demoting** that
  administrator handed the policy to the next one, whose row usually did not
  exist, so every account reverted to the built-in defaults — and with them a
  folder that may not be mounted, failing every backup; **deleting** them
  cascaded the policy away; and **restoring their own backup** replayed a
  months-old policy over the whole instance, with `withPreserveTimestamps`
  keeping even `updated_at` from showing it had moved.
- **A deployment that has never saved** runs on `defaultPolicy()`, which is
  **enabled**: the enrollment it replaces hardcoded `enabled: true` for managed
  users, so a disabled default would have switched automatic backups off for
  every such deployment.
- **Every active account, with no exception.** Two have been made here and both
  cost somebody their backups: first every administrator was excluded, so a
  second operator who never opened the screen was enrolled by nothing; then the
  account holding the policy was excluded, which on a deployment whose
  administrator had never pressed Save left the operator's own data the single
  account the policy did not reach — while the screen counted it as covered. A
  row that already matches costs one comparison and no write, so an exception
  buys nothing.
- **Disabling the policy disarms every account**, by clearing `next_backup_at`;
  leaving it behind would have a disabled policy keep taking backups. An account
  a disabled policy has never reached gets no row written at all.
- **A reconcile writes only the columns it owns.** `next_backup_at` is the
  cron's **claim** (`claimDueBackup`), so a whole-entity `save` carrying a
  snapshot read before the loop could revert a claim another replica had just
  taken and have that account backed up twice — the mirror image of the reason
  `recordBackupOutcome` was already a targeted `UPDATE`. A held value is
  overwritten in exactly two cases, both of them an operator asking for
  something now: a disabled policy clears it, and a change to a
  **schedule-defining** field (`frequency`, `backupTime`, `timezone`) replaces
  it. Neither can revert a claim into the past — the claim's whole property is
  `next_backup_at > now` and `calculateNextBackupAt` returns a future slot, so
  one future value gives way to another. Every other drift (retention, folder)
  only fills in a row that has none (`COALESCE(next_backup_at, …)`). Carrying
  the old value forward unconditionally ran the next backup on the schedule the
  operator had just replaced — up to a week late on `weekly` — with the status
  line contradicting the form that set it. `runBackupForUser` records its
  outcome through `recordBackupOutcome` for the same reason, and a manual run
  deliberately does not move the automatic schedule at all.

The admin surface reads back what the deployment is actually doing rather than
one row: `accountCount` (active accounts the policy governs) beside
`scheduledAccountCount` (how many of them hold an armed row right now), and
deployment-wide `lastBackup*` / `nextBackupAt` aggregates — the most recent run of
any account and the soonest next run of any armed one. A policy screen reporting
one row's `lastBackupAt` says "Last backup: today" on an instance where eleven of
twelve accounts have never been backed up at all. The counts are **two** numbers
because a single one could only have been `accountCount`, which states coverage
the deployment may not have: an account whose reconcile threw is logged, skipped,
and still governed by the policy. They match on a settled deployment.

**"Back Up Every Account Now" means every account.** `runManualBackup` fans out
over every active account through the same per-user path the cron uses, caller
first, one at a time; one account's failure never stops the rest. The fan-out is
**claimed deployment-wide** before it starts — a conditional `UPDATE` on
`auto_backup_policy.manual_run_claimed_at`, released in a `finally` **by token**
so a run that outran `MANUAL_RUN_CLAIM_TTL_HOURS` cannot free the claim a later
one has since taken, and bounded by that TTL so a killed replica frees it — because the button
walks every account inside one request, and a proxy timeout that leaves the run
going plus an operator who presses again otherwise interleaves two full passes
over the same rows. A second caller is refused, not queued. It answers
counts (`usersRequested`, `usersBackedUp`, `usersSkipped`, `usersFailed`,
`usersPartial`) plus `filename` for the caller's *own* artifact only — one
filename cannot describe a fan-out. A run that wrote nothing refuses rather than
answering 200 with zeroes: the single account's own error when exactly one
failed, so its status and reason survive; the count and the first reason when
more did; the maintenance conflict when every account was skipped. Backing up one
row under a deployment policy was the same defect as the policy governing one
row — an operator pressed it to prove backups worked and proved it for
themselves only.

**Which store is in use is named, not inferred.** `describeCapability` carries
`storageProvider` (the bound target's `name`) beside `locationSelectable`, and the
settings screen shows a storage row on every deployment: the provider, the store's
own display location, and how many artifacts it already holds for the reader. The
folder input, Browse and Validate render only where `locationSelectable` is true,
the save omits `folderPath` where it is false (an object store's `acceptBase`
refuses one, so the form used to fail every save on `s3`), and the run button is
no longer gated on a stored folder — an object store has none, which hid it
entirely on every `s3` deployment. `locationSelectable` answers "may I choose a
location"; it never answered "where do my backups live".

- **The store is a target, not a directory.** Every storage operation goes
  through `BACKUP_STORAGE_TARGET`
  (`backend/src/backup/storage/backup-storage.interface.ts`), selected by
  `BACKUP_STORAGE_PROVIDER`: `local` (the default) writes to a container
  directory, `s3` puts the artifacts in an S3-compatible bucket. Nothing above
  the store knows which is bound — the naming, the tiers, the promotion and the
  retention arithmetic are the same either way, and the key layout is the same
  tree. `docs/specs/backup-storage-targets.md` is the specification.
- **Switching stores is forward-only.** Nothing is migrated. The previous
  recovery points stay where they were and the new store's listing cannot see
  them, so an operator keeps the old volume or bucket until the new store holds
  a full retention window. The Backup settings page reports how many artifacts
  the **current** store holds, so the gap is visible rather than inferred.
- **Per-user namespace.** Each user's artifacts go in a server-computed
  namespace named by their user id — a sharded subdirectory on `local`, the same
  sharded key prefix on `s3`. Filenames carry only frequency and date, so
  isolation has to come from the namespace, and retention only ever enumerates
  one user's. Artifacts sitting directly in a `local` root predate this, carry no
  owner in their names, and are left exactly where they are; the `s3` store has
  never had a layout without an owner in the key.
- **Published whole or not at all (INV-BACKUP-006).** There is no `write`
  operation on the seam, only `publish`, so a caller cannot ask for a non-atomic
  one. `local`: temp file in the same directory, `fsync`, length check, atomic
  rename, `fsync` the directory. `s3`: one `PutObject` with a known
  `Content-Length` and a declared `ChecksumSHA256`, which the service applies to
  the key only on a complete, checksum-matching upload. Either way a final name
  never refers to a partial artifact and a failed publish leaves the previous one
  intact. Leftovers of an interrupted write are swept separately from retention,
  because a partial write is not a backup and counting one would silently shorten
  the retention window; on `s3` there is nothing to sweep.
- **Confined destinations.** `BACKUP_ALLOWED_ROOTS` (defaulting to
  `BACKUP_CONTAINER_DIR`) bounds every user-influenced path, canonically — a
  symlink inside a permitted directory cannot lead out of one. It is the `local`
  store's own concern and appears nowhere in the seam. An `s3` store has no
  folder for a user to choose or an admin to browse, so the setting is inert
  there: `updateSettings` refuses a `folderPath`, `validateFolder` and
  `browseFolders` answer a typed refusal, and the capability report carries
  `locationSelectable: false` for the settings screen to hide its picker on.
- **The store and the off-machine copy are two places (INV-BACKUP-007).** The
  store's variables are `BACKUP_STORE_S3_*`; `BACKUP_S3_*` is the off-machine
  destination's. A deployment whose two resolve to one bucket and overlapping
  prefix refuses to start: the off-machine copy exists to survive the loss of the
  store, so one bucket holding both is a 3-2-1 arrangement that is actually a 1.
- **Completeness is part of an artifact's identity, not a note beside it
  (F3RB-001, issue #1069).** A run that knows its artifact is incomplete publishes
  it as `monize-backup-partial-<date>.<ext>`, in its own retention tier; nothing
  named `daily-`, `weekly-` or `monthly-` is ever written by such a run. The name
  is chosen *after* the export, from what the export found, because
  a publish replaces a final name by design: choosing it first destroyed
  that day's complete artifact and then recorded `partial` in the settings row,
  with nothing left to preserve. Retention then read the ordinary name and counted
  it as a complete daily, so `retentionDaily = 3` over three partial days could
  keep two partials and delete three complete artifacts.

  The tier is what makes both halves hold at once: a partial run may delete
  **older partial artifacts and nothing else**, so a storage outage cannot fill
  the volume with them and cannot cost a single complete copy. Partials are kept
  to `retentionDaily` — the same depth, counted separately — because they arrive
  on the same cadence; the two counts never draw on each other.

  Retention classifies from the filename alone. That is deliberate rather than
  lazy: the settings row is on one instance, and an encrypted artifact's envelope
  claim is inside the ciphertext, so a rescan after a restart has nothing else to
  read. The envelope claim (section 4) is the durable copy for everything that is
  not retention.

  **Artifacts written before this change keep their `daily-` names and keep being
  counted as complete.** A pre-existing ordinary-named partial cannot be told from
  a complete one — its completeness was never in the file, and for an encrypted
  artifact could not be read back without the user's password. The fix stops new
  losses; it does not reclassify history it cannot inspect.

  A manual run that produced any partial artifact now says so: `runManualBackup`
  counts `usersPartial` and spells out in its message that those artifacts were
  written as partials, were not promoted and displaced no complete backup, and
  the settings screen shows that as a plain toast rather than a success one. It
  previously reported every run through "Backup created: `<filename>`", so the
  only thing telling the user was `partial-` in the name it showed them.

- **Encryption is on by default, and its key is announced before it is enforced
  (issue #1269).** An automatic backup opens with the user's own password
  whenever the server holds a usable backup key for them: a random data key
  wrapped under the password when a local account types it (registration, login,
  password change) or confirms it in Settings, and under the dedicated backup
  password an OIDC account sets. The server keeps the data key in
  `users.backup_key_enc` under `EncryptionService`, keyed by `ENCRYPTION_KEY`,
  and the wrap in `users.backup_key_wrap`; it never keeps the password
  (INV-BACKUP-008). The retired `users.backup_password_enc`, which did, is
  converted and cleared at each user's next sign-in or automatic backup.
  `AI_ENCRYPTION_KEY` is the variable's former name: still read, and still
  preferred where both are set, so an existing deployment upgrades without
  re-keying a column.

  The key is **announced before it is enforced**. A deployment with neither
  variable still boots — refusing would turn an upgrade into an outage for
  exactly the deployments that have the problem — but `logEncryptionKeyStatus`
  warns at every start that backups are going out unencrypted and that a future
  release will require the variable. Until that release, the refusals live on
  the write paths: `EncryptionService` throws rather than inventing a fallback,
  so no secret is ever stored in the clear.

  The previous arrangement keyed this on `AI_ENCRYPTION_KEY` while that variable
  was optional and documented as being for cloud AI providers: a deployment that
  configured no provider stored no password and wrote every automatic backup in
  plaintext, while the release notes, the docs and Settings all said backups were
  encrypted by default. Two rules follow. **A plaintext automatic backup is
  logged, every time** — it stays a legitimate outcome (an OIDC account with no
  backup password; a local account with no backup key yet) but
  never a silent one. And **"this server cannot encrypt" is reported separately
  from "this user has not enabled it"** (`available` beside `enabled` in
  `getStatus`), because the two have different fixes and rendering both as a
  blank space is what made the defect invisible.

- **`ENCRYPTION_KEY` does not open a backup file; the user's password does.** The
  artifact carries its data key wrapped under the password it was written under,
  so a restore needs *that* password and nothing else — losing `ENCRYPTION_KEY`
  does not lock anyone out of a backup they can still supply the password for.
  What losing it does cost: every AI provider key and emergency-access credential
  in the database becomes unreadable, each user's stored backup data key becomes
  unreadable, and automatic backups then *refuse to run* (the `unrecoverable`
  outcome above) until a fresh key is wrapped at the next sign-in. The password
  half has its own trap, which the wiki states plainly: a local account's
  artifact opens with the login password **as it was when that artifact was
  written**, so changing a password strands every backup taken before the change
  unless the old one is written down. A password change wraps a fresh data key,
  so the old password opens only the files written before it. A password changed
  by a reset link, an admin or an emergency claim does not re-wrap: the key's
  `backup_key_password_ref` no longer matches the account's hash, and the next
  automatic backup drops it and is written unencrypted (and logged) until the
  user signs in again, rather than under a password they no longer know.

On Kubernetes this needs `backend.persistence.backups.enabled` (see
`helm/README.md`). With a read-only root filesystem and no mount, a schedule
reports errors forever while the UI shows it as configured.

## 8. Cross-version and cross-instance limits

The retired `user_preferences.notification_browser` column (migration 188) is
ignored when restoring older artifacts: `insertRows` filters columns against
`information_schema.columns` on the receiving database. Other preferences and
the per-category push matrix are restored normally; the retired flag is never
translated into matrix values because it did not gate delivery.

The two dropped mortgage flags, `accounts.is_canadian_mortgage` and
`accounts.is_variable_rate` (the mortgage-type contract migration), ARE
translated before that filter drops them, because they decided how a mortgage
compounds: `insertRows` resolves every `accounts` row through
`backend/src/accounts/legacy-mortgage-type.util.ts`, so a backup taken before
the type existed restores a Canadian fixed-rate mortgage as `CANADIAN_FIXED`
rather than the column default, and a row whose `mortgage_type` is null (any
non-mortgage, or a mortgage an older release wrote) restores with the type the
migration gives it rather than failing `NOT NULL`
(`docs/specs/mortgage-types.md`, section 4.2).

Known and unresolved; none of these is a bug report waiting to be filed:

- **Format version is strict equality.** Only `1` is accepted, rejected before
  any deletion. There is no compatibility window and no offline upgrader; define
  one before incrementing. This is the `version` field *inside* the document; the
  encrypted **envelope** carries its own version and accepts both containers
  (§6), which is a separate number and deliberately not strict.
- **A framed envelope does not open on an older instance.** Encrypted downloads
  are `MZBE` v2 as of issue #1070, and a build from before it recognises only v1 —
  it reports the file as not being in the encrypted Monize format. Restoring
  backwards across that boundary means an unencrypted export, or restoring on a
  build at least as new as the one that produced the file. The reverse direction
  is fine: every version reads v1. Automatic backups are `MZBE` v3 from the
  release that stopped storing passwords, and the same holds one step further on:
  a build from before it does not open them.
- **AI provider keys written by an older build do not cross instances.** Keys now
  travel decrypted and are re-encrypted on arrival (§1), so a current artifact is
  portable. One made before that carries `api_key_enc` under the exporting
  instance's `ENCRYPTION_KEY`, and restores onto any other instance populated
  and unreadable; so does any key the exporting instance could not decrypt
  itself. Re-entering the key is the only recovery.

  What *was* a defect is that this happened silently. The column is non-null, so
  every check that asks "is a key configured?" answered yes and the provider row
  drew a masked key; the only symptom was that AI calls failed. The restore now
  counts those rows — plus any it could not re-encrypt because this server has no
  `ENCRYPTION_KEY` — and reports `unusableAiProviderKeys` beside `restored`:
  beside, never inside, for the same reason as `skippedAttachments` (§4), since
  the client sums `restored` into a row total and these rows *were* written. It
  is the key inside them that did not survive. `AiService.testConnection` says
  the same thing on demand, in place of the generic "check your provider
  settings", which is advice about settings that are in fact correct.

  Both the re-encryption and the count run before the restore's transaction:
  `EncryptionService`'s derivation is `scryptSync`, tens of milliseconds per
  key, which does not belong inside the transaction holding every one of the
  user's rows — and does not belong on a list endpoint at all, which is why
  `getConfigs` still reports only whether the column is populated.
- **A renamed table needs an alias, and this is the mechanism.** A backup keys
  its tables by SQL table name, so renaming a table renames a key that every
  artifact written before the rename does not carry. Nothing about that failure
  is loud: `insertRows` is handed `undefined` for the new key, restores zero rows
  and reports zero — silent data loss inside an operation whose whole promise is
  that nothing is lost. The version cannot carry the fix, since it is compared
  for strict equality (above) and bumping it would reject every existing artifact
  rather than read one. `LEGACY_TABLE_KEYS` in `backend/src/backup/backup-format.ts`
  maps each current name to the names older artifacts used, and
  `renameLegacyTableKeys` moves the key once, on the parsed document, before
  anything walks it — id remapping, attachment staging, currency pre-creation and
  the insert loop all address tables by name, and a rule applied at one of them
  is a rule that holds for one of them. An artifact carrying both names keeps the
  current one: it was written by an instance that already knew it — and because
  that decision *discards* the legacy rows, it is reported rather than made
  quietly: `renameLegacyTableKeys` returns `{ renamed, discarded }` and the
  restore logs a warning naming the table and the row count, since rows in the
  artifact that do not come back are exactly what a restore may not be silent
  about. So far the map holds one entry, `notifications` ← `budget_alerts`
  (migration 179).
  `backup-format.spec.ts` covers the moves and
  `backend/src/common/db/migration-table-renames.spec.ts` reads the renames out
  of the migrations themselves, so the next rename is checked without being
  registered.
- **Delegation is reset.** `account_delegates`, `account_delegate_grants` and
  `delegate_account_favourites` are excluded by design, and cascade away when
  accounts are deleted. A restore therefore removes existing grants and
  favourites. Whether that security reset is the intended product behaviour is
  undecided.
- **`ON CONFLICT DO NOTHING` counts optimistically.** `insertRows` increments its
  counter per attempted row, not per affected row, and there is no post-restore
  cardinality or closure check. UUID remapping removes ordinary primary-key
  collisions, but a natural or composite-key conflict would be reported as
  restored.

## 9. The support (de-identified) backup

`docs/support-backup.md` is authoritative. Two things belong here because they are
restore contract, not privacy policy:

- A support backup restores through the same path as any other and is logged as
  such. Its amounts are scaled by a hidden factor, so scaled balances must not
  later be mistaken for corruption.
- Custom currency codes are pseudonymised, and every reference is rewritten
  through `CURRENCY_REFERENCE_COLUMNS`. A reference left behind is a foreign-key
  violation, which would make the artifact de-identified *and* useless.
- `currencies.created_by_user_id` is rewritten to the exporting user before the
  identifier remap. The row has no `id` column, so the row-id sweep that remaps
  every other identifier never sees it — and since the export includes every code
  the user's data references whoever defined it, the column can hold another
  user's real UUID. Two support files from two users of one instance would then be
  correlatable by the creator id they share, which is the one thing the remap
  exists to prevent.

## 10. Rules recorded from `AGENTS.md`

### A lenient decoder is not a validator

`Buffer.from(value, "base64")` silently discards characters outside the alphabet instead of failing -- on `x-export-password` that encrypts a backup under a password nobody knows and reports success. Anywhere a decode result is used as a credential or a key, assert the round trip.

### A count of things you did not do never goes in the total of things you did

`restored` is summed by the client, so deliberately skipped attachments are a sibling field (`skippedAttachments`, omitted when zero) -- "a subtotal is not a total", applied to counts. And the user has to be *told*: a success dialogue silent about files that did not come back is worse than the number being in the wrong place.
