# Document scanner: Agent Task List

> Companion to [`document-scanner.md`](./document-scanner.md) (the design). Same
> conventions as `joint-accounts-tasks.md`: one task per session/PR where
> practical, dependency order, deploy-impact classes (`none` / `inert` /
> `neutral`), definition of done includes `npm run build && npm run lint`,
> `TZ=UTC npm run test:unit`, migrations mirrored into `database/schema.sql`
> with `npm run migration:lint` + `scripts/verify-schema.sh` clean, and
> English-only catalogs until the final localization pass.

The invariants I1 to I7 in the design apply to every task. A task that changes
the behaviour of a plain (non-scan) upload, list, count or delete is wrong;
stop and re-read I1.

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
|----|------|-----------|---------------|--------|
| S1 | Design + task docs (this file) | -- | none | [x] |
| D1 | Migration: `original_of_attachment_id` + CHECK + partial unique index; restore plan deferral | S1 | inert | [ ] |
| B1 | Backend: pair upload, primary-attachment predicate, list with `originalAttachmentId`, pair delete | D1 | neutral | [ ] |
| F1 | Frontend engine: OpenCV.js dependency, worker, pipeline, quality checks, client, hook, CSP | S1 | inert | [ ] |
| F2 | `DocumentScanDialog` + `DocumentCornerHandles` | F1 | inert | [ ] |
| F3 | `AttachmentsSection` integration: scan control, staged pairs, API client, "View original" | B1, F2 | neutral | [ ] |
| V1 | Playwright journey (`e2e/tests/attachments.spec.ts`) | F3 | none | [ ] |
| Q1 | Contract docs + full-locale i18n pass (final acceptance commit) | all above | none | [ ] |

B1 is neutral because no client sends the `original` part until F3; F1 and F2
are inert because nothing mounts them until F3. F3 is the commit that turns the
feature on.

## Task details

### D1 -- Migration and restore deferral

- One migration file named with `date -u +%Y%m%d%H%M%S` per
  `docs/database-migrations.md`; every statement idempotent (the CHECK through
  a `DO` block guarded on `pg_constraint`).
- Mirror into `database/schema.sql` beside the `transaction_attachments`
  definition, with the column comment from the design.
- `backend/src/attachments/entities/transaction-attachment.entity.ts`: nullable
  `originalOfAttachmentId` column.
- `backend/src/backup/restore-plan.ts`: add the column to
  `DEFERRED_FK_COLUMNS.transaction_attachments` and a matching
  `DEFERRED_FK_REPAIRS` entry; extend `restore-plan.spec.ts` if its schema
  derivation does not already pick the column up.
- `backend/test/integration/backup-restore.integration.spec.ts`: a pair whose
  original id sorts before its visible id round-trips.
- Done when `scripts/verify-schema.sh` and `npm run migration:lint` are clean
  and the integration suite passes serially (`npm run test:integration`).

### B1 -- Backend pair upload and reads

- `backend/src/attachments/primary-attachment.util.ts`: `PRIMARY_ATTACHMENT_SQL`
  and `primaryAttachmentWhere`; `primary-attachment.guard.spec.ts` scanning
  `src/` for the column name outside the util, entity and restore plan.
- `attachments.controller.ts`: `FileFieldsInterceptor` for `file` + optional
  `original`, same limits; the upload handler passes both to the service.
- `attachments.service.ts`: `create(userId, transactionId, file, original?)`
  per the design (two intents before the transaction, one `withScopedDb`,
  primaries-only cap, compensation over a set of written keys);
  `findAllForTransaction` returns primaries with `originalAttachmentId` via one
  LEFT JOIN; `remove` deletes `id = $1 OR original_of_attachment_id = $1` and
  sweeps every returned key.
- `backend/src/transactions/transactions.service.ts`: `attachmentCount` and the
  `hasAttachments` filter use the predicate.
- New refusals in `backend/src/i18n/locales/en/errors.json`:
  `errors.attachments.pairRequiresImages`, `errors.attachments.originalTooLarge`.
- Tests: the `attachments.service.spec.ts` cases listed in the design's
  Testing table; `attachments.controller.spec.ts` for the two-part body;
  `backend/test/integration/attachment-scan-pair.integration.spec.ts`.
- Update `docs/external-side-effects.md` section 2 (two objects, same
  mechanism) in this task so the doc never describes a shipped behaviour it
  does not have.

### F1 -- Scanner engine

- Add the pinned OpenCV.js dependency; record the gzipped chunk size in the PR.
  If it exceeds 4 MB, open the trimmed-build follow-up before F3 ships.
- Create `frontend/src/lib/document-scanner/` with the files in the design's
  table, plus `frontend/src/hooks/useDocumentScanner.ts`.
- `frontend/src/proxy.ts`: `'wasm-unsafe-eval'` in `script-src`;
  `frontend/src/proxy.test.ts` asserts it.
- `frontend/vitest.config.ts`: exclude `document-scan.worker.ts` from
  coverage (the shim cannot run under jsdom); everything it delegates to is
  covered.
- Tests: pipeline and quality suites on `synthetic-document.ts` fixtures with
  the real engine under Node (one engine load per file, inside the 30 s
  timeout); client and hook suites with a mocked `Worker`;
  `document-scan.guard.test.ts` for the two source scans (engine import site,
  `new Worker(` site).
- Measure and record: detect + warp + enhance on a 12 MP synthetic image in a
  mid-range phone profile (Chromium CPU throttling x4). Target under 2 s;
  if missed, lower the working-copy size before touching the pipeline.

### F2 -- Dialog and corner handles

- `frontend/src/components/transactions/DocumentScanDialog.tsx` on the shared
  `Modal`, states and actions per the design; the preview toggle is two
  `Button`s, never a second `role="tablist"`
  (`frontend/src/test/ui-conventions.test.ts`).
- `frontend/src/components/transactions/DocumentCornerHandles.tsx`: pointer
  events with capture, `touch-action: none`, arrow-key nudging, convexity
  snap-back, `rewarp` on release.
- English keys under `attachments.scan.*`; `npm run i18n:pseudo`.
- Tests: every state renders its actions; every warning renders "Use anyway";
  an original over `MAX_ATTACHMENT_BYTES` shows the cannot-keep notice and
  still offers the enhanced-only path; a stale scan reply after Retake does not
  change the preview (I6, through the hook).

### F3 -- Attachments section integration

- `frontend/src/types/attachment.ts`: `originalAttachmentId` on the
  attachment type; `StagedAttachment`.
- `frontend/src/lib/attachments.ts`: `upload(transactionId, file, original?)`.
- `frontend/src/components/transactions/ScanDocumentControl.tsx`; mount it
  beside `UploadControl` in `AttachmentsSection.tsx` in both modes; staged
  mode carries pairs; `TransactionForm.tsx`'s post-create loop sends both
  parts; "View original" link on saved rows.
- Verify on a real Android and iOS device that `capture="environment"` opens
  the camera with `Permissions-Policy: camera=()` in place, and record the
  result in the PR. If either platform refuses, drop the attribute (the OS
  picker still offers the camera) rather than widening the policy.
- Tests: `AttachmentsSection.test.tsx` for the scan control in both modes and
  the pair upload; `TransactionForm` staged-pair coverage.

### V1 -- E2E journey

- `e2e/tests/attachments.spec.ts`: create a transaction through the API
  helper; plain upload; scan a fixture PNG generated by a small helper under
  `e2e/helpers/` from the same planted-quad recipe as `synthetic-document.ts`;
  accept; one row with "View original"; both downloads return 200 with
  different byte lengths; delete removes the row and both downloads 404.
- Region-scope any alert locator (`frontend/src/test/e2e-conventions.test.ts`).

### Q1 -- Contract docs and localisation

- `docs/system-invariants.md`: add INV-ATTACHMENT-002 (a scan pair is one
  attachment) with its mechanism and `enforced` status, and the index row.
- `docs/verification-contract.md`: the INV-ATTACHMENT-002 row naming the
  unit, integration and E2E suites above.
- Root `CLAUDE.md`: one paragraph under "Files on disk" or the attachments
  rule naming `primaryAttachmentWhere` as the only visibility predicate.
- Translate every new key in all locales for both layers in one pass;
  parity tests and `npm run i18n:check` green.
