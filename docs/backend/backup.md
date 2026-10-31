# Backend: backup and restore

What a backup promises, the streaming export path, the restore's ordering of refusals, the facade and its components, and the operator-owned automatic backups with their encryption. `docs/backup-restore-contract.md` is the contract; read this and it before changing anything under `src/backup/`.

Paths beginning with `src/`, `test/` or `scripts/`, and layer configuration filenames, are relative to `backend/`; other source paths are relative to `backend/src/`. Explicit repository prefixes are preserved. `backend/CLAUDE.md` is the short index; this document is where the reasoning lives.

## Backup and restore

`docs/backup-restore-contract.md` is the contract: what a backup promises, what it deliberately does not, and the known gaps. Read it before changing anything under `src/backup/`. Three things a test enforces:

- **A new foreign key between two backed-up tables** must keep `src/backup/restore-plan.spec.ts` green (it parses every FK out of `database/schema.sql` and fails on ordering/self-reference problems).
- **A new column referencing `currencies(code)`** must keep `src/currencies/currency-references.spec.ts` green -- both SQL functions and the TypeScript constant.
- **A new table** must be exported or listed in `INTENTIONALLY_EXCLUDED_TABLES` with a reason, and classified in the support backup rules.

Shared-document metadata, blob digests and streamed bytes use `exportedAttachment`
from `src/backup/shared-backup.ts`: private ownership applies only to rows without
a shared parent; group and entry documents require ownership of the group or an
unrevoked membership. Uploading a shared file is not a continuing read grant after
revocation. The source guard in `backup.service.spec.ts` pins these three branches;
`test/integration/shared-expenses-lifecycle.integration.spec.ts` exercises the same
queries on a connection that bypasses RLS and checks actual exports under RLS.

`prepareSharedRestore` applies `RESTORE_CLEARED_COLUMNS` in that same module to
remove ownership-transfer consent and upload replay state from a detached copy;
these transient values must not survive restoration as live commands.

Support snapshots check shared references with `withSharedSupportRefs`, including
the owner/group components of composite foreign keys. Missing optional links are
cleared; a missing journal participant, allocation target or refund source
refuses generation instead of silently changing the journal's financial facts.

**A file's name is its identity, so anything that decides whether it may be deleted has to be in the name.** An automatic backup that could not include every attachment is published as `monize-backup-partial-<date>` in its own retention tier, and the name is chosen *after* the export from what the export found -- `writeFileAtomic` replaces a final name by design, so a partial artifact written under the `daily-` name had already destroyed that day's complete copy before any status column could say so. State beside the file cannot govern a decision the write has already made; the durable copy of the fact goes *inside* the document (`completeness` in the envelope).

**Nothing in the export path may hold a whole table, a whole artifact, or a whole attachment set.** Rows come through the cursor in `src/backup/export-cursor.ts`, the document is serialised a row at a time under the chunk budget in `export-json-stream.ts`, and an object store is opened one object at a time. A `manager.query` for an export table, a `JSON.stringify` over an array of rows, or an array of base64 built before serialising are each the same defect (issue #1070). The guards in `src/backup/export-streaming.spec.ts` assert the ordering (batched fetches, loads interleaved with writes, reads that stop when the client does) rather than the memory.

**`verifyAuthentication` is the one refusal deliberately not first.** An OIDC restore is authorized by a single-use `OidcReauthService` artifact, and the round trip that mints one loses the user's file selection -- so the restore validates everything free (decrypt, decompress, envelope) *before* spending it. It still precedes every write. Do not reorder it forward, and do not reorder it backward past a `DELETE FROM`; section 5 of the contract has the reasoning, and `backup.service.spec.ts` pins both edges.

**A restore may fetch the bond series its own file references, and nothing else.** `bond_instruments` is catalog data a backup does not carry and a fresh deployment holds none (INV-BOND-008), so the export writes the identity of each referenced series in a `bondCatalog` member (never terms, INV-BOND-006) and `BackupBondSeriesRecoveryService` fetches the missing ones through `BondSeriesService.fetchSeries` after re-authentication and **before** the restore transaction -- an external effect, so before the commit like attachment staging, sequential, capped at `MAX_BOND_SERIES_FETCHES_PER_RESTORE`. A refused fetch is recorded in the result's `unrecoveredBondSeries` and never fatal. Do not add a second fetching path or call the recovery from inside the transaction; section 3a of the contract has the order and what a failure leaves. What a severed catalog link costs the row is declared beside `CATALOG_REFERENCE_COLUMNS` (`CATALOG_ON_SEVERED`), not branched on inside the generic loop.

**A value encrypted with server configuration cannot travel in a document.** `ai_provider_configs.api_key_enc` is ciphertext under `ENCRYPTION_KEY`, which is not in the backup and must not be. Exported verbatim it restored onto any other instance *populated and unreadable* -- every "is a key configured?" check said yes and only the AI calls failed. The key is decrypted on the way out and re-encrypted on the way in (`ai-provider-key-transport.ts`), both directions in one file because the field name and fallbacks are one contract. The cost -- the artifact holds the credential in plaintext -- is stated in `docs/backup-restore-contract.md` §1, logged by the export, and why the support backup drops the table. Anything else stored under server-side configuration gets the same treatment, or is excluded.

## `BackupService` is a facade; put new code in the component that owns it

Issue #1092 split the 2,600-line original into `BackupExportService`, `BackupRestoreService`, `BackupAttachmentTransferService` and `BackupRestoreDatabaseService`, with the file format in `backup-format.ts` and the table list in `export-table-queries.ts`. Section 0 of the contract says which owns what. `BackupService` is one delegation per method and holds no `DataSource` and no storage provider; `src/backup/module-shape.spec.ts` fails on the dependency as well as the line count, and its grandfather list may only shrink.

**A source-scanning guard names a file, so a split disarms it silently.** Four guards pointed at `backup.service.ts` and would have gone on passing while scanning code that had moved out from under them. A scan whose subject is "wherever this appears" walks the directory (`backupModuleSources()` in `backup.service.spec.ts` is the pattern); one that must name a file throws when its marker is missing rather than returning an empty match set. Grep `readFileSync(` under the module you are splitting before you split it.

## Automatic backups are an operator setting, not a user preference

Auto-backup endpoints live on `AutoBackupController`, whose class-level `@Roles("admin")` is the whole access rule -- a new endpoint there is admin-only automatically. Manual export/restore (caller's own data) stays on `BackupController` for everyone.

**The files are the user's even though the schedule is not.** `listStoredBackups`
and `openStoredBackup` live on `AutoBackupService` (it owns the naming and the
per-user namespace) but are reached through `BackupController`, which has no role
guard -- a user who cannot see the settings still has to be able to take and
restore the artifacts those settings produced for them. Only the caller's own
namespace is enumerated: the store's `legacy` artifacts (on the `local` target,
the flat base folder a pre-per-user version wrote into) carry no owner in their
filenames, so nothing there can be attributed to anybody and offering one for
download would hand a user another user's ledger. A name is served only when
`classifyBackupFileName` (`backup-file-names.ts`) recognises it, and the store
then matches that name against what it is holding and opens its own entry rather
than the caller's string -- on `local` that is the CWE-22 boundary, still
containment-checked on the join, because a validated name with an unvalidated
join is a decorative check. The listing carries the caller's own `enabled` flag:
the settings endpoint that would otherwise answer "is anything backing me up?" is
admin-only, and the Settings section hides itself on it.

**How much a user's backups occupy is the same question, asked for the admin
screen.** `summarizeStoredBackups` reduces that listing to a count and a total
for the `Backups` column on Admin > Users (`AdminService.getUserStorageUsage`,
`GET /admin/users/storage`), and counts exactly the artifacts the owner-facing
listing offers: `legacy` names carry no owner, so billing their bytes to
whichever user happens to be listed would be a guess, and a name
`classifyBackupFileName` does not recognise is not an artifact this module
wrote. On a `local` store still holding pre-namespacing files the column
therefore reads low, which is the honest reading of a shared history nothing can
attribute. A store that cannot be enumerated at all answers `null` for both
figures rather than `0`: "nobody could read it" and "this user has nothing
stored" are different facts with different repairs, and the column renders them
differently. The attachment column beside it needs no store at all -- it is a
`SUM(byte_size)` over `transaction_attachments`, the same figure whichever
provider holds the bytes.

## Where the artifacts live is a target, not a directory

Every storage touch in the automatic backup path goes through
`BACKUP_STORAGE_TARGET` (`src/backup/storage/backup-storage.interface.ts`),
selected by `BACKUP_STORAGE_PROVIDER` and registered the way
`ATTACHMENT_STORAGE_PROVIDER` is. `AutoBackupService` holds no path, no
`BACKUP_ALLOWED_ROOTS` and no `fs` import: the containment model, the atomic
write and the legacy flat-folder listing are `LocalBackupStorageTarget`'s, which is
the default and is what ran before the seam existed. The download route and the
off-machine reader take a stream from `open(location, filename)` rather than a
path, because an object store has none. There is no `write` (only `publish`,
which is INV-BACKUP-006 in the name) and no `exists` (a check that is then acted
on is a race). `docs/specs/backup-storage-targets.md` is the specification.

## One policy, every account

What Admin -> Backups edits is an `AutoBackupPolicy` for the deployment, not the administrator's own preference: `enabled`, folder, frequency, time, timezone and the three retention counts. It lives in its own singleton row, `auto_backup_policy` -- RLS-exempt, and excluded from every account's archive, because a deployment-wide setting stored on a user row is one that deactivating, demoting, deleting or restoring that user silently rewrites. `AutoBackupService.reconcileManagedUsers` writes it onto every **active** account's row -- administrators included, with no excepted account -- at the top of the hourly cron and again on save, so a change does not wait an hour. It reconciles rather than seeds: drifted rows are brought back to the policy, unchanged ones are not written, `lastBackup*` is left alone so a reconcile never re-triggers a backup, and a disabled policy clears `next_backup_at` rather than leaving a schedule the cron would still claim. Only the columns the policy owns are written: `next_backup_at` is the cron's claim, so a whole-entity save -- which could revert a claim another replica had just taken -- is never used, and a held value is replaced only when the operator asked for something now (the policy was disabled, or a schedule-defining field moved); every other drift fills it in only where it is null (`COALESCE`). Two exceptions have been made to "every account" and both cost somebody their backups: every administrator, and then the account the policy was stored on, which left an operator who had never pressed Save the one account the policy did not reach. `defaultPolicy()` -- the fallback when nothing has been saved -- is **enabled**, because the enrollment it replaces hardcoded `enabled: true`.

`runManualBackup` fans out over the same accounts, caller first, one at a time, under a deployment-wide claim on `auto_backup_policy.manual_run_claimed_at` so two presses cannot interleave two passes, and answers counts rather than a filename it could only give one account. `getSettings` answers `accountCount` beside `scheduledAccountCount`, because one number could only have been the first and would state coverage the deployment may not have. `describeCapability` names the bound store (`storageProvider`) beside `locationSelectable`, because "may I choose a location" was never the same question as "where do my backups live".

Backups open with the user's own password, and **the server never stores that password** (INV-BACKUP-008, `docs/specs/backup-envelope-key-wrapping.md`). Each user with encrypted backups has a random data key, held under `ENCRYPTION_KEY` (`backup_key_enc`) so the cron can encrypt, and wrapped under the password (`backup_key_wrap`) so every automatic backup can carry the wrap in its `MZBE` v3 header. Local-auth accounts get a fresh key wrapped when they type the password (`rewrapBackupKey` from registration, login and change-password, bound to the verified `password_hash` by a conditional `UPDATE` and skipped when the wrap is already current), or from Settings by confirming that same password (`enableWithLoginPassword`) -- the sign-in path never fires for a session older than the deploy that shipped it, and that session can outlive the backups it silently leaves in plaintext (issue #1269). OIDC accounts set a dedicated backup password in Settings (`setBackupPasswordForOidcUser`) or go unencrypted; `getStatus().manageable` gates that UI section, and the dedicated-password methods refuse a local-auth caller. A key wrapped under a login password is checked against the account's current hash before use (`resolveBackupKey`, via `backup_key_password_ref`) -- three outcomes, not two: nothing usable (write plaintext), a key (encrypt), stored-but-undecryptable (refuse -- silently downgrading previous encrypted backups is worse than failing). The retired `backup_password_enc` copy is converted and cleared at the next sign-in or the next automatic backup, whichever comes first; the restore still tries it for a row not yet converted, and tries the stored data key after the typed passwords.

**A feature that is on by default cannot hang off optional configuration.** The stored password was encrypted with `AI_ENCRYPTION_KEY`, which was optional -- commented out in `.env.example`, documented as being for cloud AI providers, and passed as `${AI_ENCRYPTION_KEY:-}` by the compose files -- so on a deployment that configured no AI provider the capture returned early and every automatic backup was written in plaintext, with no log line, no status field and nothing on the Settings page (issue #1269). The key is now `ENCRYPTION_KEY`, and `AI_ENCRYPTION_KEY` is still read -- and still wins where both are set -- so an existing deployment upgrades without re-keying a column. It was **announced before it was enforced**: one release warned on every boot that a deployment without a key wrote plaintext backups and that a later release would refuse to start; that release is this one, and `checkClusterBoot` now refuses to boot without a key (`missingEncryptionKeyRefusal`, which also tells a keyless deployment it can set one safely). The `isConfigured()` branches below are therefore unreachable in a booted server and stay for entry points that build the service outside it. One key, one `EncryptionService` (`common/encryption/`), for every secret this deployment stores: provider keys, emergency-access credentials, each user's backup data key. Two rules come out of the defect, and both have tests: a plaintext automatic backup is **logged** on every write (`auto-backup.service.ts`), and "this server cannot encrypt" is a distinct field in `getStatus` from "this user has not enabled it", because they have different fixes. A service spec whose encryption double answers `isConfigured() === true` is structurally blind to this class of bug -- `backup-encryption.service.spec.ts` therefore ends with a block that builds the **real** service, once per live variable name.

## Off-machine copies go through the dispatcher

`BackupOffsiteDispatchService.dispatchAfterBackup` (`src/backup/offsite/`) is the only door a backup artifact leaves this machine by, and `AutoBackupService.dispatchOffsiteCopy` is its only caller: on the tail of a run, after the outcome is recorded, never inside the export's transaction and never for an artifact whose report is not complete. **Only an encrypted `.mzbe` artifact is offered to a destination** -- the artifact holds third-party API keys in the clear inside it, so a plaintext one is refused, recorded `skipped-unencrypted` on every enabled destination and alerted (INV-BACKUP-002); `backup-offsite.guard.spec.ts` holds that mechanically, along with the append-only rule. `BackupOffsiteS3Uploader` is deliberately not `S3StorageProvider`: it constructs no delete and no read command, every completing write carries `IfNoneMatch: "*"`, and the key carries the egress digest so re-running the same artifact is a no-op rather than an overwrite. Each copy is claimed by a conditional `UPDATE`, and the claim is a lease the retry sweep hands back after an hour, because a row nothing reclaims is a copy nobody finds. `docs/specs/backup-off-machine.md` is the contract; INV-BACKUP-002..005 are the invariants.

## A column list in the export is a claim that it is the whole table

A table whose export names its columns (because one of them is `bytea`, so `SELECT *` cannot be used) stops describing the table the moment a migration adds a column: the backup omits it, and a restore -- which deletes the user's rows and reinserts from the archive -- writes NULL over it, reporting success. `payees.address`/`email`/`phone` shipped that way. `backend/src/backup/export-driver-values.spec.ts` now checks every explicit list against `database/schema.sql` as well as the bytea encoding; a column that genuinely must not be exported belongs there with its reason.

The support exclusion set lives in `src/backup/support-backup/support-backup-exclusions.ts`,
re-exported from the rules registry; keep the column rules and table exclusions
separate so the registry stays within the module-shape ceiling.
