# Spec: ship backups off the machine (S3 append-only and email, 3-2-1)

Approved specification for copying an automatic backup off the container it was
written on, so the loss of the backup volume is not the loss of every backup.
Written before the implementation, per `docs/financial-calculation-contract.md`
section 7 and `AGENTS.md` ("a financial feature of any substance starts from a
short approved spec"). The staged plan and its task graph are
`docs/future-plans/backup-off-machine.md` and its `-tasks.md`.

This spec governs the invariants of the off-machine copy. They hold for every
destination kind alike: S3 and email are independent destinations a user may
enable together (a 3-2-1 arrangement), and neither loosens the rules for the
other. The ordering and verification rules it builds on are `EXT-001`..`EXT-004`
in `docs/external-side-effects.md`; the completeness rule it builds on is
`INV-BACKUP-001`. The maintainer's decisions on the open questions are the table
in `docs/future-plans/backup-off-machine.md`.

## 1. What this adds

An automatic backup today lands only on the local backup volume
(`BACKUP_CONTAINER_DIR`, per user, sharded). The container is ephemeral; if the
volume is lost, so is every recovery point. This feature adds, **after** a
complete local artifact exists, a copy of that same artifact to an off-machine
destination:

- **S3 (append-only).** Upload the artifact to an S3-compatible bucket with a
  credential and an app-side write mode that can add a new object but can neither
  overwrite nor delete one. The bucket is the deployment's default or the user's
  own (with the user's own credentials, encrypted at rest).
- **Email.** Deliver the encrypted artifact as an attachment to the user's
  configured address when it is at or under a configurable size bound; above it,
  a notice with no bytes.
- **Retry and lifecycle** (both kinds). Durable per-artifact, per-destination
  upload state so a transient failure is retried rather than lost.

The copy is a *copy*. The local artifact remains the primary, is written first,
and is what restore reads. Nothing in this feature changes the on-disk format,
the export pipeline, retention, or restore.

## 2. The behaviour this replaces

There is no off-machine delivery of a backup anywhere in `backend/src` today. The
only "leaves the machine" artifact is the support backup, which is
unconditionally encrypted precisely because it exists to leave the user's machine
(`docs/backup-restore-contract.md` section 9). The only email that mentions a
backup is failure *alerting* (`BACKUP_FAILED` / `BACKUP_PARTIAL` system alerts),
never delivery. This feature is the first backup egress path, so it is the first
place the egress invariants below have to be stated and enforced.

## 3. Definitions

- **Artifact.** One written backup file: `monize-backup-<tier>-<date>.<ext>`,
  `ext` one of `mzbe` (encrypted) or `json.gz` (unencrypted), per
  `backend/src/backup/backup-file-names.ts`.
- **Complete artifact.** One whose `completeness.complete` is true, published
  under a `daily`/`weekly`/`monthly` tier (never `partial`), per
  `INV-BACKUP-001`. Only a complete artifact is a candidate for egress.
- **Off-machine copy.** The bytes of an artifact placed on a destination that
  does not share the backup container's lifecycle: an S3 object or an email
  attachment.
- **Destination.** One configured target of one kind (`s3` or `email`) for one
  user. A user may have both enabled; each is dispatched, claimed and recorded
  independently.
- **Append-only destination.** A destination the application can add a new object
  to but cannot overwrite or delete an existing one -- enforced on two
  independent layers (section 4, `INV-BACKUP-004`).
- **Egress digest.** The SHA-256 of the exact artifact bytes as written locally.
  It is the identity the destination is asked to verify and the value durable
  state records.

## 4. Invariants

Each is proposed for `docs/system-invariants.md` (and the matching row in
`docs/verification-contract.md` section 3) by the implementation PR that first
enforces it. They are listed here as the contract the implementation must meet.

### INV-BACKUP-002 -- an artifact is encrypted before it leaves the machine

```text
Statement           Only an encrypted (.mzbe) artifact is ever copied off the
                    machine. An unencrypted (.json.gz) artifact is refused for
                    egress, not shipped in clear.
Source of truth     The artifact's own extension / envelope magic
                    (backup-envelope.ts "MZBE"); the egress dispatcher reads it.
Enforcement         The dispatcher selects candidates by encrypted extension and
                    refuses any other; a source-scanning guard asserts no egress
                    path is reachable from an unencrypted artifact. Mirrors the
                    support-backup rule (a payload that leaves the machine is
                    unconditionally encrypted, docs/backup-restore-contract.md
                    section 9).
Concurrency scope   per artifact
Failure response    The copy is skipped and an admin alert is raised naming the
                    user whose deployment has no usable backup password, so the
                    off-machine copy is understood to be absent rather than
                    silently unencrypted. The local artifact is unaffected.
Required tests      Unit: a .json.gz artifact is never handed to the uploader; a
                    .mzbe artifact is. Guard: egress is unreachable from a
                    plaintext artifact.
Status              enforced (the dispatcher's gate, the sender's own gate,
                    and backup-offsite.guard.spec.ts; docs/system-invariants.md
                    is canonical)
```

The artifact carries third-party API keys **in the clear** inside its data (they
are decrypted into `api_key_plaintext` for the export). That is why an
unencrypted artifact must never leave the machine, and why this is an invariant
rather than a preference. A deployment with no `ENCRYPTION_KEY`, or a user with
no usable backup password, produces `.json.gz` artifacts; for those the correct
off-machine state is *no copy plus a visible alert*, never a plaintext upload.

### INV-BACKUP-003 -- a local copy exists and is complete before any off-machine copy

```text
Statement           No off-machine copy is attempted until the local artifact is
                    completely written (renamed to its final name) and recorded
                    as complete. The off-machine copy never precedes, replaces, or
                    can delete the local one.
Source of truth     The local artifact on disk + lastBackupStatus.
Enforcement         Egress is dispatched from the tail of a successful backup
                    run, after applyBackupOutcome, outside the export
                    transaction (the push-after-commit shape,
                    docs/external-side-effects.md section 4a). A partial artifact
                    is never a candidate.
Concurrency scope   per artifact, per user
Crash semantics     A crash before the local rename leaves no candidate and no
                    copy -- the survivable direction. A crash after the local
                    write but before the copy leaves the local artifact intact and
                    the copy pending (Stage 2 retries it; Stage 1 records it
                    failed).
Failure response    An egress failure never fails the local backup; it is recorded
                    as its own off-site status.
Required tests      Unit: dispatch runs only on report.complete and only after the
                    outcome write; an upload throw does not change
                    lastBackupStatus from success.
Status              enforced (dispatched after applyBackupOutcome, only
                    on a complete artifact; auto-backup.service.spec.ts)
```

### INV-BACKUP-004 -- the application cannot delete or overwrite an off-machine copy

```text
Statement           The credential and the code path used for egress can add a
                    new object but cannot delete or overwrite an existing one.
                    Retention of off-machine copies is the operator's, via bucket
                    lifecycle / object-lock policy, never the application's.
Source of truth     The IAM policy on the token (operator) AND the code (no
                    DeleteObject, conditional PutObject).
Enforcement         Two independent layers. (1) Operator: the documented token
                    grants s3:PutObject only, on a versioned, object-locked bucket
                    -- no s3:DeleteObject, no overwrite. (2) Application: the
                    off-site uploader is a distinct provider that never
                    constructs a DeleteObjectCommand and issues PutObject with an
                    "object must not already exist" precondition (IfNoneMatch:
                    "*"), so even a mis-scoped token cannot clobber an existing
                    key. A source-scanning guard asserts the off-site uploader
                    imports no delete/overwrite command.
Concurrency scope   deployment (one bucket) / per object (one key)
Failure response    A precondition failure (key already exists) is reconciled by
                    digest, not overwritten -- see the truth table, section 5.
Required tests      Guard: off-site uploader has no DeleteObjectCommand import and
                    no unconditional overwrite. Unit: an existing key is not
                    overwritten.
Status              partial (the application half is enforced by the uploader
                    and its guard; the operator's IAM policy is documentation
                    this repository cannot observe)
```

The existing `S3StorageProvider`
(`backend/src/attachments/storage/s3-storage.provider.ts`) implements
`save`/`load`/`delete` and imports `DeleteObjectCommand`; it is therefore **not**
the egress path. The egress uploader reuses that file's transport concerns only
-- lazy client construction, the aborting total deadline (`withDeadline`), and
`assertSafeStorageKey` from `storage-key.util.ts` -- extracted so both share one
implementation, and adds none of its mutation surface.

### INV-BACKUP-005 -- an off-machine copy is verified before it is recorded as done

```text
Statement           An off-machine copy is reported "uploaded" only after the
                    destination has verified it received the exact bytes (by
                    egress digest), not after the call returned. An unverifiable
                    copy is recorded in a form that says so.
Source of truth     Durable off-site upload state keyed on (user, artifact),
                    carrying the egress digest and the verified outcome.
Enforcement         PutObject sends the SHA-256 as x-amz-checksum-sha256 so S3
                    validates it server-side and rejects a mismatch; the state
                    row moves to "uploaded" only on a 200 that carries back the
                    matching checksum. EXT-002 / EXT-003.
Concurrency scope   per artifact
Crash semantics     A crash between the verified put and the state write leaves
                    the row "uploading", which no ordinary predicate would select
                    again -- so the claim is a lease. Each retry sweep first
                    expires claims older than OFFSITE_CLAIM_LEASE_MINUTES (60,
                    above the S3 total deadline times its attempts) back to
                    "failed" in one statement, and the ordinary backoff
                    re-attempts them. The trade, per destination: an S3 re-put of
                    bytes whose first attempt landed is reconciled by digest
                    under the same key (section 5) and changes nothing, while an
                    email re-attempt can deliver the same encrypted artifact
                    twice -- the survivable direction against a copy that is
                    never delivered and a row nobody finds (EXT-003).
Retry semantics     A transient failure leaves "failed" with the digest recorded;
                    Stage 2's retry re-attempts the same bytes under the same key.
Failure response    "failed" is a durable, findable state, not a silent success.
Required tests      Two-connection / integration where the property is a real S3
                    round-trip (test bucket or MinIO): a corrupted body is
                    rejected; a re-run of an already-uploaded artifact is a no-op.
Status              partial (S3 verifies by checksum; email can only record
                    that SMTP accepted the message, and a lease-expired retry
                    can deliver it twice)
```

## 5. Truth table -- when a copy is attempted and recorded

`local` = local artifact state; `enc` = encrypted?; `dest key` = whether the
destination already holds this artifact's key; the last two columns are the
action and the durable off-site status.

| local | enc (.mzbe) | dest key state | Action | Off-site status |
| --- | --- | --- | --- | --- |
| partial / failed | any | -- | no candidate | (none) |
| complete | no (.json.gz) | -- | refuse egress, alert | `skipped-unencrypted` |
| complete | yes | absent | PutObject with digest + IfNoneMatch | `uploaded` on verified 200 |
| complete | yes | present, same digest | treat as done, no overwrite | `uploaded` (idempotent) |
| complete | yes | present, different digest | do **not** overwrite; alert | `conflict` |
| complete | yes | transient error (timeout, 5xx) | leave for retry | `failed` (the reaper re-attempts) |

Email destination, same first two columns; the third is the artifact's size
against `BACKUP_EMAIL_MAX_BYTES`:

| local | enc (.mzbe) | size | Action | Off-site status |
| --- | --- | --- | --- | --- |
| complete | yes | at or under the bound | send with the artifact attached | `uploaded` once SMTP accepted it |
| complete | yes | over the bound | send a notice (name, size, where it is), no bytes | `skipped-too-large` |
| complete | yes | SMTP failure | leave for retry | `failed` |

"SMTP accepted it" is the strongest verification email offers (EXT-002 as far
as the medium allows); the row says `uploaded` only after `sendMail` resolved,
never before the call.

The "present, different digest" row is the append-only invariant meeting reality:
two different artifacts must never share a key (section 6 makes the key carry the
date and a disambiguator), so a same-key/different-digest collision is an anomaly
to surface, never to resolve by overwriting.

## 6. Object key and idempotency (append-only)

An append-only destination cannot overwrite, so the key must be stable for the
same bytes and distinct for different bytes. The key is:

```text
<BACKUP_S3_PREFIX>/<ab>/<cd>/<userId>/monize-backup-<tier>-<date>-<digest12>.mzbe
```

where `<ab>/<cd>/<userId>` is the same `shardedSegments(userId)` layout the local
volume uses, and `<digest12>` is the first 12 hex chars of the egress digest.
Consequences:

- **Re-running the same complete artifact is a no-op**: same bytes -> same digest
  -> same key, and the `IfNoneMatch` put fails cleanly against the object already
  there; the digest matches, so it is recorded `uploaded` (idempotent, EXT-001 by
  natural key).
- **A same-day re-export that produced different bytes** (an attachment arrived
  between runs) lands under a *different* key and both are kept; append-only means
  the destination keeps every distinct recovery point and the operator's lifecycle
  policy ages them out. This is intentional and is why retention is not the
  application's here.

## 7. Missing data / failure policy

- **No `ENCRYPTION_KEY` / no usable backup password** -> artifact is `.json.gz`
  -> `skipped-unencrypted` + admin alert (INV-BACKUP-002). Never a plaintext
  upload.
- **Destination not configured.** A user on `s3Mode = deployment` while
  `BACKUP_S3_BUCKET` is unset -> the destination is refused at save time with an
  error naming the variable; nothing is dispatched. A user on `own` with an
  incomplete own-bucket form is refused by the DTO. Off by default, so an
  un-configured deployment is unaffected.
- **Destination unreachable / credentials wrong / timeout** -> `failed` with the
  digest recorded; local backup unaffected; the reaper retries under a claim
  with bounded attempts.
- **Own credentials cannot be decrypted** (rotated `ENCRYPTION_KEY`) -> `failed`
  with a message naming the cause, and an alert; never a fallback to the
  deployment bucket, which the user did not choose.
- **Verification mismatch** -> the put is rejected by S3 (checksum) and never
  recorded `uploaded`; treated as `failed`.
- **Bucket returns "key exists" with a different digest** -> `conflict` + alert,
  never overwrite (section 5).
- **The replica holding the claim dies** -> the row stays `uploading` and no
  predicate would ever select it again, so the claim is a lease: the next sweep
  after `OFFSITE_CLAIM_LEASE_MINUTES` (60) moves it back to `failed` with
  `last_error` saying the claim expired, and the ordinary backoff re-attempts it.
  The lease is set above the S3 total deadline (5 minutes) times its attempts (3)
  so a slow-but-live upload is never reclaimed under itself.

Every non-success terminal state is durable and attributable to the user and the
artifact, per EXT-003.

The lease makes one trade explicit rather than leaving it to a crash. **For S3 a
re-attempt is a no-op when the first put landed**: the key carries the digest,
the conditional put refuses the taken key, the recorded digest matches, and the
row is recorded `uploaded` without anything being overwritten. **For email it can
deliver the same encrypted artifact twice**, because SMTP acceptance is the only
signal the medium gives and it cannot distinguish a message already delivered
from one never sent. Delivering a duplicate copy of a backup the user already has
is the survivable direction against a copy that was never made and a row nobody
ever looks at again.

## 8. Numerical / worked examples

1. **Encrypted daily, first upload.** User A, `daily` tier, `2026-09-14`,
   artifact bytes hash to `9f3c...`; key ends `-9f3c1a2b4d5e.mzbe`. PutObject with
   `x-amz-checksum-sha256` = the full digest, `IfNoneMatch: *`. S3 returns 200 and
   echoes the checksum. State -> `uploaded`, digest `9f3c...`.
2. **Cron re-fires on the same complete artifact.** Same bytes, same key.
   `IfNoneMatch` put fails `412 PreconditionFailed`. Recorded digest already
   equals `9f3c...`, so the copy is already present and correct -> `uploaded`
   (no-op). No second object, no overwrite.
3. **Same-day re-export after an attachment landed.** New bytes hash `71aa...`;
   key ends `-71aa9c0d1e2f.mzbe` -- a different object. Both `9f3c...` and
   `71aa...` exist off-machine; the operator's lifecycle rule decides when the
   older ages out. Neither the app nor this run deletes anything.
4. **Plaintext deployment.** No `ENCRYPTION_KEY`; artifact is
   `monize-backup-daily-2026-09-14.json.gz`. Not a candidate. State
   `skipped-unencrypted`; `BACKUP_PARTIAL`-class admin alert says the off-machine
   copy was withheld because the artifact is unencrypted.
5. **Transient S3 outage.** PutObject aborts on the deadline. Local artifact
   intact, `lastBackupStatus` still `success`. Off-site state `failed` with digest
   `9f3c...`. The reaper re-attempts under the same key; step 2's idempotency
   makes a late-landing first attempt safe.
6. **Email over the bound.** `BACKUP_EMAIL_MAX_BYTES` is 20 MiB and the artifact
   is 31 MiB. No attachment; the user receives a notice naming the file, its size
   and the bound. State `skipped-too-large`. The S3 destination on the same user,
   if enabled, is unaffected and proceeds as in example 1.
7. **Multipart.** A 60 MiB artifact with a 16 MiB part size goes as four parts,
   each with its own SHA-256; the completing call carries `IfNoneMatch: *`. A
   failure after two parts aborts the multipart upload (cleaning the incomplete
   parts, which is not object deletion) and records `failed`.

## 9. Shape (durable state)

Two tables, both RLS-scoped to the owning user. Indicative shape (the migration
is the implementation's):

```text
backup_offsite_settings                -- one row per user
  user_id             uuid PRIMARY KEY
  s3_mode             text    -- off | deployment | own
  s3_bucket, s3_region, s3_prefix, s3_endpoint   text (own mode)
  s3_force_path_style boolean
  s3_access_key_id    text    -- encrypted (EncryptionService, AES-256-GCM)
  s3_secret_access_key text   -- encrypted; never returned to the client
  email_enabled       boolean
  email_to            text
  created_at, updated_at

backup_offsite_uploads                 -- one row per (user, destination, key)
  id             uuid
  user_id        uuid
  destination    text    -- s3 | email
  object_key     text    -- S3: the full key; email: the artifact filename
  tier           text    -- daily | weekly | monthly
  digest         char(64)-- egress digest (SHA-256 hex)
  size_bytes     bigint
  status         text    -- pending | uploading | uploaded | failed
                         --   | conflict | skipped-unencrypted | skipped-too-large
  attempts       int
  last_error     text
  created_at, updated_at
  UNIQUE (user_id, destination, object_key)
```

The settings API returns whether a secret is set, never its value. The
LLM/reporting surfaces do not read either table; the upload rows are exposed as a
per-destination status list on the user's backup settings surface.

## 10. Test matrix

| Property | Invariant | Test kind | Where |
| --- | --- | --- | --- |
| A plaintext artifact is never uploaded | INV-BACKUP-002 | unit + source-scan guard | `auto-backup`/egress spec; a `*.guard.spec.ts` |
| Egress runs only after a complete local write | INV-BACKUP-003 | unit | egress dispatch spec |
| An upload throw does not change `lastBackupStatus` | INV-BACKUP-003 | unit | `auto-backup.service.spec.ts` |
| Off-site uploader constructs no delete/overwrite | INV-BACKUP-004 | source-scan guard | a `*.guard.spec.ts` |
| An existing key is not overwritten | INV-BACKUP-004 | unit | egress uploader spec |
| A checksum mismatch is not recorded `uploaded` | INV-BACKUP-005 | unit against a local fake S3 endpoint | egress uploader spec |
| A re-run of an uploaded artifact is a no-op (412 + same digest) | INV-BACKUP-005 | unit against a local fake S3 endpoint | egress uploader spec |
| A multipart failure aborts and records `failed` | INV-BACKUP-004, -005 | unit against a local fake S3 endpoint | egress uploader spec |
| Two replicas claim one pending row; one wins | INV-BACKUP-005 | two-connection integration (PostgreSQL) | new integration spec |
| `failed` is durable and carries the digest | INV-BACKUP-005 | unit + integration | dispatcher spec |
| An email over the bound sends a notice, not bytes | INV-BACKUP-002, -005 | unit | email destination spec |
| Own-credential secrets are never returned by the API | security | unit | settings service/controller spec |

A green suite through any of these behaviours is a finding, per `AGENTS.md`. The
S3 rows run against a local HTTP endpoint that implements the documented S3
semantics (the pattern `s3-storage.provider.deadline.spec.ts` established), so
they prove the property rather than the call; the PostgreSQL claim row needs the
real database, per `docs/verification-contract.md`.

## 11. Out of scope

- Whole-instance disaster recovery (a separate backup of PostgreSQL and the
  attachment store) -- explicitly out of this feature per
  `docs/backup-restore-contract.md`.
- Replacing the local backup store with S3 (that is the `BACKUP_STORAGE_PROVIDER`
  idea in `docs/future-plans/horizontal-scaling.md`, task S2 -- a *different*
  change; see the plan's "Relationship to the horizontal-scaling plan").
- Restoring directly from an off-machine copy; restore continues to read the
  local artifact (or an uploaded file). An operator recovering from S3 first
  copies the object back; a user recovering from email uploads the attachment
  through the existing restore flow.
- Off-machine copies of manual or support backups; this feature copies automatic
  backups only.
- A presigned or otherwise linked download from the bucket: it would need a read
  credential this feature deliberately does not hold.
