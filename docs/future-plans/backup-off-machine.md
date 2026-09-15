# Plan: ship backups off the machine (S3 append-only and email, 3-2-1)

Staged plan for copying an automatic backup off the container it was written on.
The invariants are the approved spec `docs/specs/backup-off-machine.md`; this file
is the work breakdown, the configuration, the guards, and the rollout. The task
graph is `docs/future-plans/backup-off-machine-tasks.md`. Proposed in discussion
#1369 (`approved-to-build`).

## Goal

After a complete local automatic backup exists, place a copy of the same artifact
on one or more off-machine destinations, so losing the backup volume is not
losing every recovery point. Two destination kinds, independently enabled per
user, so a deployment can hold the local copy, an S3 copy **and** an emailed copy
at once (a 3-2-1 arrangement: three copies, two media, one off-site):

1. **S3 (append-only).** Upload the encrypted artifact to an S3-compatible bucket
   with a credential and code path that can add a new object but cannot overwrite
   or delete one. Integrity verified before the copy is recorded as done.
2. **Email.** Deliver the encrypted artifact as an attachment when it fits a
   configurable size bound, otherwise a notice that it did not.

Plus, across both: **retry and lifecycle** -- durable per-artifact upload state
with a conditional claim and a reaper, so a transient failure is retried rather
than lost.

The local artifact stays primary: written first, read by restore, never replaced
or deleted by anything here.

## Maintainer decisions (discussion #1369 follow-up)

Recorded here so a fresh session builds what was agreed. The numbering below is
how the answers were read against the two open-question lists (the discussion's
four, then this plan's); where the mapping was inferred it is marked so the
maintainer can correct it.

| # | Question | Decision |
| --- | --- | --- |
| 1 | Share the existing S3 code? | **Yes, the transport.** Client construction, the aborting deadline and key safety are extracted into one shared module both providers use. The egress uploader stays a distinct class with no delete or overwrite surface (INV-BACKUP-004). |
| 2 | Require encryption before egress? | **Yes.** INV-BACKUP-002 stands: a plaintext artifact never leaves the machine. |
| 3 | Multipart upload? | **Yes.** Above a part-size threshold the uploader uses multipart (create / upload parts / complete), each part checksummed, `IfNoneMatch` applied on the completing call so the no-overwrite rule holds for multipart too. A failed multipart is aborted (`AbortMultipartUpload` cleans an *incomplete* upload; it is not object deletion and the IAM note says so). |
| 4 | Who manages off-machine retention? | **Unknown.** The spec's stance holds: the application never deletes; retention is the bucket's lifecycle / object-lock policy, documented for the operator. |
| 5 | One destination per deployment, or per user? | **Per user, with optional per-user S3 credentials.** A deployment-level S3 destination (env `BACKUP_S3_*`) is the default; a user may instead supply their own bucket and credentials. Secrets are AES-256-GCM encrypted at rest through `EncryptionService` and never returned to the client. (Inferred mapping to this plan's former "per-user vs deployment" question.) |
| 6 | Email: attach or link? | **Implementer decides.** Decision: attach when the artifact is at or under `BACKUP_EMAIL_MAX_BYTES`; otherwise send a notice naming the artifact and its size, with no bytes and no presigned link (a link would need a read credential this feature otherwise avoids). Recorded as `skipped-too-large`. |
| 7 | Retention visibility / destination behaviour | **Configurable.** Each destination is independently enabled per user; the deployment defaults are env-driven. The admin/user surface shows per-destination status, not a retention count the app cannot know. (Inferred mapping.) |
| + | Both S3 and email at once | **Yes -- 3-2-1.** Destinations are a set, not a choice. |

## Relationship to the horizontal-scaling plan

`docs/future-plans/horizontal-scaling.md` reserves `BACKUP_STORAGE_PROVIDER`
(task S2) for making S3 the *storage* of the automatic backup -- replacing the
local volume. This plan is a different idea: the local volume stays the primary
and S3/email are *additional* copies taken afterward. Their configuration must
not collide:

- This plan owns `BACKUP_S3_*`, `BACKUP_EMAIL_*` and the per-user
  `backup_offsite_settings` row (egress copies).
- The horizontal-scaling plan owns `BACKUP_STORAGE_PROVIDER` (the primary store).
- Because destinations here are explicit, a deployment whose primary store later
  becomes S3 simply does not point an egress destination at the same bucket.

Both touch `auto-backup.service.ts`; whoever builds first names the other in
their PR so the maintainer sequences them (shared-area work under
`CONTRIBUTING.md`).

## Why this is non-trivial here (current state)

- **The artifact write has no integrity record yet.** `INV-BACKUP-001` made the
  local write crash-atomic and put the completeness verdict in the envelope, but
  no content digest is stored for the finished bytes. Egress needs one (the
  egress digest, INV-BACKUP-005), computed once over the exact bytes written
  locally and reused as the S3 checksum, the key disambiguator and the durable
  identity.
- **The existing S3 provider is the wrong door.**
  `backend/src/attachments/storage/s3-storage.provider.ts` implements
  `save`/`load`/`delete` and imports `DeleteObjectCommand`. Reusing it whole would
  hand the egress path a delete it must never have (INV-BACKUP-004). The transport
  concerns are shared; the mutation surface is not.
- **Encryption is conditional.** Automatic backups are `.mzbe` only when a usable
  backup password exists; otherwise `.json.gz`, in the clear, holding third-party
  API keys decrypted. Egress must refuse the plaintext case, loudly.
- **Email has no attachment mechanism.** `EmailService.sendMail(to, subject,
  html)` (`backend/src/notifications/email.service.ts`) carries no attachment
  parameter and no size bound. The attachment path is new and size-bounded.
- **Per-user credentials are secrets.** A user's own S3 key pair lives in the
  database encrypted with `EncryptionService` (AES-256-GCM), is write-only from
  the client's point of view (masked on read), and is decrypted only inside the
  upload under that user's context.
- **Every replica fires the backup cron.** Dispatch and the retry claim must be
  single-winner across replicas, the way `claimDueBackup` already is.

## Principles

- **Local first, copy after, outside the transaction.** Dispatch egress on the
  tail of a successful run, after `applyBackupOutcome`, never inside the export
  transaction (the push-after-commit shape, `docs/external-side-effects.md`
  section 4a). An egress failure is never the backup's failure.
- **Verify, then record.** "Uploaded" is written only after the destination
  confirms the bytes (EXT-002). Copy the emergency-access shape: the durable "it
  happened" marker is withheld until the external effect is confirmed
  (`docs/external-side-effects.md` section 5).
- **Append-only on two layers.** Operator IAM grants `s3:PutObject` (and
  `s3:AbortMultipartUpload`) only, on a versioned, object-locked bucket; the app
  additionally never constructs a delete and completes every put with
  `IfNoneMatch: "*"`. Neither layer alone is trusted.
- **Encrypted or nothing.** Only `.mzbe` leaves the machine.
- **One digest, computed once.** The SHA-256 over the exact local bytes is the S3
  checksum, the key disambiguator and the durable identity.
- **Off by default.** No destination is enabled until configured.
- **Secrets stay server-side.** Per-user credentials are encrypted at rest and
  never echoed back; the API returns presence, not value.

## Configuration

Deployment defaults, documented in `.env.example` mirroring the
`ATTACHMENT_S3_*` block. New `configService.get` reads are added to
`.env.example` in the same PR or `node scripts/check-env-docs.mjs` fails.

```text
# --- s3 egress default destination (append-only) ---
# Present (bucket set) = a deployment-wide S3 destination users may opt into.
BACKUP_S3_BUCKET=my-monize-offsite
BACKUP_S3_REGION=us-east-1
BACKUP_S3_PREFIX=backups/
BACKUP_S3_ENDPOINT=                           # MinIO/R2/B2; unset for AWS
BACKUP_S3_FORCE_PATH_STYLE=false
BACKUP_S3_ACCESS_KEY_ID=                       # PutObject + AbortMultipartUpload only
BACKUP_S3_SECRET_ACCESS_KEY=
BACKUP_S3_REQUEST_TIMEOUT_MS=300000            # shorten-only, same as attachments
BACKUP_S3_MULTIPART_PART_BYTES=16777216        # parts above this size go multipart

# --- email egress ---
BACKUP_EMAIL_MAX_BYTES=20971520                # attach at or under; notice above
```

Per user (`backup_offsite_settings`, one row per user, RLS-scoped):
`s3Mode` (`off` | `deployment` | `own`), the own-bucket fields (bucket, region,
prefix, endpoint, path style, access key id, encrypted secret), `emailEnabled`,
`emailTo`. The `.env.example` comment for the credential states the append-only
requirement explicitly.

## Work packages

Each names its mechanism, the invariant it serves, the test kind it owes, and its
deploy impact.

**WP1. Egress digest at write time.** Compute the SHA-256 of the exact bytes in
`exportToFile`, return it alongside `{ filename, report }`. *Invariant:
INV-BACKUP-005 (foundation). Tests: unit. Deploy impact: neutral.*

**WP2. Shared S3 transport, distinct egress uploader.** Extract client build,
`withDeadline` and key safety into a shared module used by
`s3-storage.provider.ts` (no behaviour change); add `BackupOffsiteS3Uploader`
with one operation -- a conditional, checksummed put, multipart above the
threshold -- importing no delete/overwrite command. *Invariant: INV-BACKUP-004.
Tests: unit against a local fake S3 endpoint (the pattern
`s3-storage.provider.deadline.spec.ts` already uses); guard on imports. Deploy
impact: neutral.*

**WP3. Durable state + per-user settings.** Migration + `schema.sql` for
`backup_offsite_settings` (encrypted secret columns) and `backup_offsite_uploads`
(one row per user, destination, key), both RLS-scoped; entities; DTOs with
`whitelist`/bounded fields; settings service that masks secrets on read.
*Invariant: INV-BACKUP-005. Tests: unit; integration where the migration is
exercised. Deploy impact: two new tables.*

**WP4. Dispatch.** After `applyBackupOutcome` for a complete, encrypted artifact,
under the user's context and outside the export transaction, for each enabled
destination: claim a row (`pending -> uploading`, conditional `UPDATE ...
RETURNING`, one replica wins), perform, record the verified outcome. Plaintext
artifacts are refused with an admin alert. *Invariant: INV-BACKUP-002,
INV-BACKUP-003, INV-BACKUP-005. Tests: unit (gating, refusal, no status
regression); integration (single winner). Deploy impact: off until configured.*

**WP5. Email destination.** Attachment-carrying send on `EmailService`, bounded
by `BACKUP_EMAIL_MAX_BYTES`; the notice path above it; encrypted-only.
*Invariant: INV-BACKUP-002, INV-BACKUP-005. Tests: unit. Deploy impact: off
until configured.*

**WP6. Retry reaper.** Hourly cron re-attempts `failed` rows under a conditional
claim with bounded attempts and backoff, same key and bytes; `docs/cron-jobs.md`
row. *Invariant: INV-BACKUP-005 (retry half). Tests: unit; two-connection
integration for the claim. Deploy impact: new cron.*

**WP7. Guards + catalog.** The two source-scanning guards; INV-BACKUP-002..005
added to `docs/system-invariants.md` and `docs/verification-contract.md`
together; `docs/external-side-effects.md` and `docs/backend/backup.md` updated.
*Deploy impact: neutral.*

**WP8. Surface.** Settings UI for the user's destinations (S3 mode and own-bucket
fields with write-only secret, email toggle and address) and a per-destination
status list; i18n English-first, pseudo-locale, every locale. *Tests: frontend
unit + i18n parity. Deploy impact: neutral.*

## Invariants to add

Reserved here; each is added to `docs/system-invariants.md` **and**
`docs/verification-contract.md` section 3 by WP7 (both files together, or
`invariant-catalog-parity.spec.ts` fails). Full text in
`docs/specs/backup-off-machine.md` section 4.

| ID | Statement | Mechanism | Test kind |
| --- | --- | --- | --- |
| INV-BACKUP-002 | Only an encrypted artifact leaves the machine | encrypted-extension gate in the dispatcher + source-scan guard | unit + guard |
| INV-BACKUP-003 | A complete local copy exists before any off-machine copy | dispatch after `applyBackupOutcome`, outside the transaction | unit |
| INV-BACKUP-004 | The app cannot delete or overwrite an off-machine copy | PutObject-only IAM + no delete import + `IfNoneMatch` on every completing put | guard + unit |
| INV-BACKUP-005 | An off-machine copy is verified before it is recorded done | checksummed put + durable claimed state | unit against fake S3 + integration |

## Guards to add

- A `*.guard.spec.ts` that the off-site uploader imports no `DeleteObjectCommand`
  and every completing put carries `IfNoneMatch` (INV-BACKUP-004).
- A `*.guard.spec.ts` that egress candidates are selected by encrypted extension
  only (INV-BACKUP-002).
- New raw SQL is column-checked by the existing `raw-sql-columns.spec.ts`.

## Rollout order and deployment safety

1. WP1 and WP2 are neutral and land first.
2. WP3 adds the tables; WP4/WP5 add the dispatch, all **off until configured**.
3. Enable in staging against MinIO first; confirm `uploaded` states and that the
   token genuinely cannot delete (attempt a delete with it and observe the deny).
4. WP6 (retry) is additive.

Migrations already merged to `main` are never edited; the new tables are a new
migration with `schema.sql` updated in the same commit.

## Open questions (remaining)

- **Digest column reuse.** WP1's egress digest is close to a general artifact
  content hash `INV-BACKUP-001`'s restore path could also use. Kept egress-only
  for now.
- **Answer mapping.** Rows 5 and 7 of the decisions table are inferred mappings;
  the maintainer should confirm or correct them in the discussion.
