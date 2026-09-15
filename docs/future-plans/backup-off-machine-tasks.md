# Backups Off the Machine: Agent Task List

The task graph for `docs/future-plans/backup-off-machine.md`. The invariants are
`docs/specs/backup-off-machine.md`. Discussion #1369 (`approved-to-build`); the
maintainer's decisions are the table in the plan.

## How to use this list (read first, every session)

- **One task per session/PR.** Each task below is scoped to a single concern and
  names the files it may touch. Touching files outside that scope is a scope
  violation -- split it into its own task instead.
- **Link the discussion** (#1369) and name the invariant IDs in every PR.
- This feature touches shared area (`auto-backup.service.ts`,
  `s3-storage.provider.ts`, `email.service.ts`, the backup docs). If the
  horizontal-scaling S2 task is in flight, name it in your PR so the maintainer
  sequences the two. See the plan's "Relationship to the horizontal-scaling
  plan".

## Definition of done for every task

- `npm run lint && npx tsc --noEmit && npm run typecheck` clean (backend);
  `lint && type-check && i18n:check` clean (frontend).
- Unit tests green: `TZ=UTC npm run test:unit -- --coverage` at or above the
  layer thresholds.
- A **two-connection integration spec** where the claim is that a real
  PostgreSQL property holds (the single-winner claims): `npm run build && npm run
  test:integration`. S3 behaviour is proven against a local fake endpoint that
  implements the documented S3 semantics (412 on a failed `IfNoneMatch`, a
  checksum rejection), the pattern `s3-storage.provider.deadline.spec.ts` uses;
  a mocked client proves the call, not the property.
- A migration is mirrored into `database/schema.sql` in the same commit;
  `npm run migration:lint` and `scripts/verify-schema.sh` pass; new raw-SQL
  columns pass `raw-sql-columns.spec.ts`; new tables carry RLS policies.
- New env vars are in `.env.example`; `node scripts/check-env-docs.mjs` passes.
- A new `@Cron` has its row in `docs/cron-jobs.md`.
- New invariants are added to **both** `docs/system-invariants.md` and
  `docs/verification-contract.md` section 3 (parity spec).
- Every new `withUserContext`/`withSystemContext` call site is added to
  `WITH_CONTEXT_ALLOWLIST` in `backend/eslint.config.mjs` as a reviewed decision.
- English-first strings, then `npm run i18n:pseudo`, then every other locale as
  the final commit (i18n parity).
- New files staged (`git add -N`) before running the tree-walking guard specs.

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
| --- | --- | --- | --- | --- |
| B1 | Egress digest: SHA-256 of the exact bytes in `exportToFile`, returned with `{ filename, report }`. Files: `backend/src/backup/auto-backup.service.ts` (+spec). Invariant: INV-BACKUP-005 (foundation). | -- | neutral | [x] |
| B2 | Shared S3 transport module (client build, deadline, key safety) used by `s3-storage.provider.ts` with no behaviour change. Files: new `backend/src/attachments/storage/s3-transport.ts` (+spec), `s3-storage.provider.ts`. Invariant: none (refactor, named in the PR). | -- | neutral | [x] |
| B3 | `BackupOffsiteS3Uploader`: conditional checksummed put, multipart above `BACKUP_S3_MULTIPART_PART_BYTES`, `IfNoneMatch` on the completing call, abort on failure, no delete import; per-user or deployment credentials. Files: new `backend/src/backup/offsite/*` + spec against a fake S3 endpoint + guard spec. Invariant: INV-BACKUP-004. | B2 | neutral | [x] |
| B4 | Migration + `schema.sql` + entities for `backup_offsite_settings` (encrypted secret columns) and `backup_offsite_uploads`; RLS policies. Files: `database/migrations/*`, `database/schema.sql`, entities. Invariant: INV-BACKUP-005. | -- | two new tables | [x] |
| B5 | Config + settings API: `BACKUP_S3_*`, `BACKUP_EMAIL_MAX_BYTES` in `.env.example`; settings service (secrets masked on read, encrypted on write via `EncryptionService`), DTOs, controller under `AuthGuard('jwt')`. Files: `backend/src/backup/offsite/*`, `.env.example`, i18n `en`. Invariant: none. | B4 | neutral | [x] |
| B6 | Dispatch after `applyBackupOutcome` for a complete, encrypted artifact; per destination claim (`pending -> uploading`, conditional UPDATE), perform, verified outcome; plaintext refusal + admin alert; never fails the backup. Files: `auto-backup.service.ts` (+spec), `backup/offsite/*`, eslint allowlist, integration spec (claim). Invariant: INV-BACKUP-002, -003, -005. | B1, B3, B4, B5 | off until configured | [x] |
| B7 | Email destination: attachment-carrying send on `EmailService`, `BACKUP_EMAIL_MAX_BYTES` bound, notice path above it, encrypted-only. Files: `backend/src/notifications/email.service.ts` (+spec), `backup/offsite/*`, i18n. Invariant: INV-BACKUP-002, -005. | B6 | off until configured | [x] |
| B8 | Retry reaper: hourly cron, conditional claim, bounded attempts + backoff, same key; `docs/cron-jobs.md` row; two-connection integration for the claim. Files: `backup/offsite/*`, `docs/cron-jobs.md`. Invariant: INV-BACKUP-005 (retry). | B6 | new cron | [x] |
| B9 | Guards + catalog: the two `*.guard.spec.ts`; INV-BACKUP-002..005 in `system-invariants.md` + `verification-contract.md`; `external-side-effects.md` and `docs/backend/backup.md` updated. Files: the docs, guard specs. Invariant: all four. | B6, B7 | neutral | [x] |
| F1 | Frontend: destinations settings (S3 mode + own-bucket form with write-only secret, email toggle + address) and per-destination status list, on the Backup & Restore settings surface; i18n all locales; tests. Files: `frontend/src/**` (backup settings), `frontend/src/i18n/messages/*`. Invariant: none. | B5, B6 | neutral | [x] |

## Suggested order

1. **Neutral foundations (parallelizable):** B1, B2, B4.
2. **Uploader and config:** B3 (after B2), B5 (after B4).
3. **Wire it up:** B6, then B7, then B8.
4. **Catalog and guards:** B9.
5. **Surface:** F1.
