# Backend: backup and restore

What a backup promises, the streaming export path, the restore's ordering of refusals, the facade and its components, and the operator-owned automatic backups with their encryption. `docs/backup-restore-contract.md` is the contract; read this and it before changing anything under `src/backup/`.

Paths beginning with `src/`, `test/` or `scripts/`, and layer configuration filenames, are relative to `backend/`; other source paths are relative to `backend/src/`. Explicit repository prefixes are preserved. `backend/CLAUDE.md` is the short index; this document is where the reasoning lives.

## Backup and restore

`docs/backup-restore-contract.md` is the contract: what a backup promises, what it deliberately does not, and the known gaps. Read it before changing anything under `src/backup/`. Three things a test enforces:

- **A new foreign key between two backed-up tables** must keep `src/backup/restore-plan.spec.ts` green (it parses every FK out of `database/schema.sql` and fails on ordering/self-reference problems).
- **A new column referencing `currencies(code)`** must keep `src/currencies/currency-references.spec.ts` green -- both SQL functions and the TypeScript constant.
- **A new table** must be exported or listed in `INTENTIONALLY_EXCLUDED_TABLES` with a reason, and classified in the support backup rules.

**A file's name is its identity, so anything that decides whether it may be deleted has to be in the name.** An automatic backup that could not include every attachment is published as `monize-backup-partial-<date>` in its own retention tier, and the name is chosen *after* the export from what the export found -- `writeFileAtomic` replaces a final name by design, so a partial artifact written under the `daily-` name had already destroyed that day's complete copy before any status column could say so. State beside the file cannot govern a decision the write has already made; the durable copy of the fact goes *inside* the document (`completeness` in the envelope).

**Nothing in the export path may hold a whole table, a whole artifact, or a whole attachment set.** Rows come through the cursor in `src/backup/export-cursor.ts`, the document is serialised a row at a time under the chunk budget in `export-json-stream.ts`, and an object store is opened one object at a time. A `manager.query` for an export table, a `JSON.stringify` over an array of rows, or an array of base64 built before serialising are each the same defect (issue #1070). The guards in `src/backup/export-streaming.spec.ts` assert the ordering (batched fetches, loads interleaved with writes, reads that stop when the client does) rather than the memory.

**`verifyAuthentication` is the one refusal deliberately not first.** An OIDC restore is authorized by a single-use `OidcReauthService` artifact, and the round trip that mints one loses the user's file selection -- so the restore validates everything free (decrypt, decompress, envelope) *before* spending it. It still precedes every write. Do not reorder it forward, and do not reorder it backward past a `DELETE FROM`; section 5 of the contract has the reasoning, and `backup.service.spec.ts` pins both edges.

**A value encrypted with server configuration cannot travel in a document.** `ai_provider_configs.api_key_enc` is ciphertext under `ENCRYPTION_KEY`, which is not in the backup and must not be. Exported verbatim it restored onto any other instance *populated and unreadable* -- every "is a key configured?" check said yes and only the AI calls failed. The key is decrypted on the way out and re-encrypted on the way in (`ai-provider-key-transport.ts`), both directions in one file because the field name and fallbacks are one contract. The cost -- the artifact holds the credential in plaintext -- is stated in `docs/backup-restore-contract.md` §1, logged by the export, and why the support backup drops the table. Anything else stored under server-side configuration gets the same treatment, or is excluded.

## `BackupService` is a facade; put new code in the component that owns it

Issue #1092 split the 2,600-line original into `BackupExportService`, `BackupRestoreService`, `BackupAttachmentTransferService` and `BackupRestoreDatabaseService`, with the file format in `backup-format.ts` and the table list in `export-table-queries.ts`. Section 0 of the contract says which owns what. `BackupService` is one delegation per method and holds no `DataSource` and no storage provider; `src/backup/module-shape.spec.ts` fails on the dependency as well as the line count, and its grandfather list may only shrink.

**A source-scanning guard names a file, so a split disarms it silently.** Four guards pointed at `backup.service.ts` and would have gone on passing while scanning code that had moved out from under them. A scan whose subject is "wherever this appears" walks the directory (`backupModuleSources()` in `backup.service.spec.ts` is the pattern); one that must name a file throws when its marker is missing rather than returning an empty match set. Grep `readFileSync(` under the module you are splitting before you split it.

## Automatic backups are an operator setting, not a user preference

Auto-backup endpoints live on `AutoBackupController`, whose class-level `@Roles("admin")` is the whole access rule -- a new endpoint there is admin-only automatically. Manual export/restore (caller's own data) stays on `BackupController` for everyone.

**The files are the user's even though the schedule is not.** `listStoredBackups`
and `openStoredBackup` live on `AutoBackupService` (it owns the folder layout and
the naming) but are reached through `BackupController`, which has no role guard --
a user who cannot see the settings still has to be able to take and restore the
artifacts those settings produced for them. Only the caller's own sharded folder
is enumerated: the flat base folder a pre-per-user version wrote into carries no
owner in its filenames, so nothing there can be attributed to anybody and
offering one for download would hand a user another user's ledger. A name is
served only when `classifyBackupFileName` (`backup-file-names.ts`) recognises it,
and the path that is opened is the directory entry's rather than the caller's
string -- the requested name is compared against the folder's own listing and
the matching entry is what gets joined -- with the join still
containment-checked, because a validated name with an unvalidated join is a
decorative check. The listing carries the caller's own
`enabled` flag: the settings endpoint that would otherwise answer "is anything
backing me up?" is admin-only, and the Settings section hides itself on it.

`AutoBackupService.enrollManagedUsers` runs at the top of the hourly cron and enrolls every other user on the deployment defaults -- without it a non-admin would silently have no backups. It reconciles rather than seeds: drifted rows are written back to the defaults, unchanged ones are not written, and `lastBackup*`/`nextBackupAt` are left alone so enrollment never re-triggers a backup.

Backups are encrypted with the user's own password. Local-auth accounts have it captured at the moment they type it (`rememberLoginPassword` from registration, login and change-password), or from Settings by confirming that same password (`enableWithLoginPassword`) -- the capture at sign-in never fires for a session older than the deploy that shipped it, and that session can outlive the backups it silently leaves in plaintext (issue #1269). OIDC accounts set a dedicated one in Settings (`setBackupPasswordForOidcUser`) or go unencrypted; `getStatus().manageable` gates that UI section, and the dedicated-password methods refuse a local-auth caller. A stored copy is checked against the account's current password hash before use (`resolveBackupPassword`) -- three outcomes, not two: nothing stored (write plaintext), usable password (encrypt), stored-but-undecryptable (refuse -- silently downgrading previous encrypted backups is worse than failing).

**A feature that is on by default cannot hang off optional configuration.** The stored password was encrypted with `AI_ENCRYPTION_KEY`, which was optional -- commented out in `.env.example`, documented as being for cloud AI providers, and passed as `${AI_ENCRYPTION_KEY:-}` by the compose files -- so on a deployment that configured no AI provider the capture returned early and every automatic backup was written in plaintext, with no log line, no status field and nothing on the Settings page (issue #1269). The key is now `ENCRYPTION_KEY`, and `AI_ENCRYPTION_KEY` is still read -- and still wins where both are set -- so an existing deployment upgrades without re-keying a column. It is **announced before it is enforced**: `logEncryptionKeyStatus` warns on every boot that a deployment without a key writes plaintext backups and that a future release will refuse to start, which is the migration a hard requirement would have skipped (an upgrade that boots is not an outage). Flipping the unkeyed branch to a throw is the whole of that later change. One key, one `EncryptionService` (`common/encryption/`), for every secret this deployment stores: provider keys, emergency-access credentials, the backup password. Two rules come out of the defect, and both have tests: a plaintext automatic backup is **logged** on every write (`auto-backup.service.ts`), and "this server cannot encrypt" is a distinct field in `getStatus` from "this user has not enabled it", because they have different fixes. A service spec whose encryption double answers `isConfigured() === true` is structurally blind to this class of bug -- `backup-encryption.service.spec.ts` therefore ends with a block that builds the **real** service, once per live variable name.

## Off-machine copies go through the dispatcher

`BackupOffsiteDispatchService.dispatchAfterBackup` (`src/backup/offsite/`) is the only door a backup artifact leaves this machine by, and `AutoBackupService.dispatchOffsiteCopy` is its only caller: on the tail of a run, after the outcome is recorded, never inside the export's transaction and never for an artifact whose report is not complete. **Only an encrypted `.mzbe` artifact is offered to a destination** -- the artifact holds third-party API keys in the clear inside it, so a plaintext one is refused, recorded `skipped-unencrypted` on every enabled destination and alerted (INV-BACKUP-002); `backup-offsite.guard.spec.ts` holds that mechanically, along with the append-only rule. `BackupOffsiteS3Uploader` is deliberately not `S3StorageProvider`: it constructs no delete and no read command, every completing write carries `IfNoneMatch: "*"`, and the key carries the egress digest so re-running the same artifact is a no-op rather than an overwrite. Each copy is claimed by a conditional `UPDATE`, and the claim is a lease the retry sweep hands back after an hour, because a row nothing reclaims is a copy nobody finds. `docs/specs/backup-off-machine.md` is the contract; INV-BACKUP-002..005 are the invariants.

## A column list in the export is a claim that it is the whole table

A table whose export names its columns (because one of them is `bytea`, so `SELECT *` cannot be used) stops describing the table the moment a migration adds a column: the backup omits it, and a restore -- which deletes the user's rows and reinserts from the archive -- writes NULL over it, reporting success. `payees.address`/`email`/`phone` shipped that way. `backend/src/backup/export-driver-values.spec.ts` now checks every explicit list against `database/schema.sql` as well as the bytea encoding; a column that genuinely must not be exported belongs there with its reason.
