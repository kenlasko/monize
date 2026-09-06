# Document scanner for attachments

Design for the first part of Discussion #1292: an optional, deterministic
"scan" step that turns a phone photo of a receipt, invoice or agreement into a
clean document image before it is attached to a transaction, while keeping the
original photo. The second part of that discussion (a PWA share target) is a
separate plan and is not covered here.

Companion task list: [`document-scanner-tasks.md`](./document-scanner-tasks.md).

## Context

Attachments today are one file per row in `transaction_attachments`, uploaded
through `POST transactions/:transactionId/attachments` (multipart field
`file`), listed per transaction, downloaded whole, and deleted by id
(`backend/src/attachments/attachments.controller.ts`). Bytes go to one of three
storage providers behind `AttachmentStorageProvider`; the upload writes a
durable upload-intent tombstone, saves the metadata row and the bytes inside one
`withScopedDb`, and an hourly sweeper removes anything a rollback left behind
(`backend/src/attachments/attachments.service.ts`,
`backend/src/attachments/attachment-orphan-sweeper.service.ts`, INV-ATTACHMENT-001).
The client is `AttachmentsSection` in
`frontend/src/components/transactions/AttachmentsSection.tsx`: an "Upload"
button over a hidden file input, a 40px thumbnail list, and a staged mode for
the New Transaction window where files are held in memory and uploaded by
`TransactionForm` after the transaction is created.

Nothing in either layer processes images. The backend has no image library at
all; the frontend's `sharp` dependency is Next's own optimizer. The app is a
hand-rolled PWA (`frontend/public/sw.js`) with no Web Worker and no
WebAssembly anywhere yet. The production Content Security Policy in
`frontend/src/proxy.ts` is `script-src 'self' 'nonce-...' 'strict-dynamic'`
with no `'wasm-unsafe-eval'`, and `Permissions-Policy` disables `camera`
(`frontend/next.config.js`), which governs `getUserMedia` and not the file
input's `capture` attribute.

## Decisions

Answers to the discussion's open questions, confirmed with the maintainer on
2026-09-06:

| # | Question | Decision |
|---|---|---|
| 1 | Where does processing run? | **In the browser, in a Web Worker**, using a self-hosted OpenCV.js WebAssembly build loaded lazily the first time the scan dialog opens. No backend image dependency, no async job, identical behaviour for the database, local and S3 storage providers, and the photo never leaves the device unprocessed unless the user asks to keep it. |
| 2 | Store the original, the enhanced image, or both? | **Both, as two linked `transaction_attachments` rows written in one request and one transaction.** The enhanced image is the attachment the user sees; the original is a hidden sibling reachable through "View original". |
| 3 | Automatic detection or an explicit choice? | **An explicit "Scan document" button** beside "Upload". A plain upload is never modified. Auto-offering on every image upload is a possible follow-up behind a preference. |
| 4 | Quality checks? | **Yes, as warnings, never as a block**: motion blur, document edges outside the frame, and low output resolution, each with a Retake action. |
| 5 | Camera? | **Direct rear-camera capture on mobile** via `capture="environment"` on the scan control's file input; desktop gets the normal file picker. |
| 6 | Manual correction? | **Yes**: four draggable corner handles on the preview so a wrong boundary is fixed instead of retaken. |
| 7 | Black-and-white variant | Out of scope for v1. |
| 8 | Multi-page scanning, PDF assembly, OCR / invoice extraction | Out of scope for v1, per the discussion author's own preference. OCR is a separate feature that would consume the enhanced image this plan produces. |

## Invariants

| ID | Invariant | Mechanism |
|---|---|---|
| I1 | **A scan pair is one attachment.** It lists as one row, counts as one against the per-transaction cap and the register's `attachmentCount`, commits together and is deleted together. | One `withScopedDb` writes both rows and both objects; `original_of_attachment_id` carries `ON DELETE CASCADE`; every "is this a visible attachment" read goes through one predicate (`primaryAttachmentWhere`, section "Backend"). Recorded as INV-ATTACHMENT-002. |
| I2 | **The original is byte-for-byte what the device produced.** No re-encoding, no orientation rewrite, no metadata stripping. | The client uploads the `File` it was handed; the server sniffs and hashes it exactly as a plain upload. |
| I3 | **The enhanced image is a pure function of (original bytes, corner coordinates, rotation).** Re-running the pipeline on the same inputs yields the same output, so the preview the user approved is the file that is stored. | Detection, warp and enhancement are deterministic OpenCV operations with fixed constants; the dialog uploads the exact `Blob` it displayed, never a re-render. |
| I4 | **INV-ATTACHMENT-001 holds for both objects.** A rollback after either object is written leaves bytes nobody references, never a row promising absent bytes. | Two upload intents are committed before the transaction opens; both are cleared inside it; the compensation path deletes every object that was written. |
| I5 | **A quality check never discards information the user wanted.** Every warning offers "Use anyway". | Dialog state machine (section "Frontend"). |
| I6 | **A scan result belongs to the request that produced it.** A stale worker reply (from a previous photo, or after Retake) is dropped. | Every worker message carries a request id; the hook adopts a reply only when its id matches the current request (`frontend/CLAUDE.md`, asynchronous data rule). |
| I7 | **The scanner engine loads only when asked.** No page pays for OpenCV.js until a user opens the scan dialog. | The engine is imported only from the worker module; a source scan fails any other import site. |

## Data model

One nullable self-referencing column on `transaction_attachments`:

```sql
ALTER TABLE transaction_attachments
    ADD COLUMN IF NOT EXISTS original_of_attachment_id UUID NULL
        REFERENCES transaction_attachments(id) ON DELETE CASCADE;
-- "This row is the unprocessed original of that attachment." NULL for every
-- ordinary attachment and for the enhanced (visible) half of a scan pair.
ALTER TABLE transaction_attachments
    ADD CONSTRAINT chk_attachment_not_own_original
        CHECK (original_of_attachment_id IS NULL OR original_of_attachment_id <> id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_transaction_attachments_original_of
    ON transaction_attachments(original_of_attachment_id)
    WHERE original_of_attachment_id IS NOT NULL;
```

The link sits on the **original**, pointing at the visible row, so that deleting
the visible attachment cascades to its original with no application code, and
the existing `AFTER DELETE` trigger tombstones both objects for the sweeper. The
partial unique index makes "at most one original per attachment" a database
fact. The two rows share `transaction_id` and `user_id`, so every existing
cascade (transaction delete, user delete, restore wipe) and the RLS policy on
`user_id` apply to both without change.

Why not a `variant` column on a single row: the two files have different bytes,
sizes, checksums and storage keys, and every part of the backup, restore,
integrity audit and sweeper machinery is written per row. Two rows reuse all of
it; a second set of columns would need a second copy of each.

Filename convention: the original keeps the device's filename; the enhanced
file is `<original basename>-scan.jpg`, sanitized by the existing
`sanitizeFilename`.

Migration: one file named per `docs/database-migrations.md` (the
`YYYYMMDDHHMMSS_` form; the numbered series is frozen), mirrored into
`database/schema.sql`, idempotent (`IF NOT EXISTS` on every statement, the
CHECK added through a `DO` block that tests `pg_constraint`), and lint-clean
under `npm run migration:lint` and `scripts/verify-schema.sh`. Deploy impact
is inert: nullable, no backfill, no read path changes until the backend task
ships.

## Backend

### Upload: one request, one transaction, both or neither

`POST transactions/:transactionId/attachments` grows an optional second
multipart part, `original`, beside the existing `file`. The controller swaps
`FileInterceptor("file")` for `FileFieldsInterceptor([{ name: "file", maxCount: 1 }, { name: "original", maxCount: 1 }])`
with the same `memoryStorage()` and per-file `MAX_ATTACHMENT_BYTES` limit.
Body ceilings already exceed two 10 MB parts (`main.ts` and the Next proxy's
`proxyClientMaxBodySize`).

`AttachmentsService.create(userId, transactionId, file, original?)`:

1. Validate both parts exactly as today (non-empty, size cap, sniffed MIME).
   When `original` is present, both parts must sniff to an image type: a scan
   pair is two images by construction, and a PDF with an "original" is a
   malformed request (`errors.attachments.pairRequiresImages`).
2. Generate two ids, commit **two** upload intents on their own connection
   (the existing `recordUploadIntent`, called twice, before the transaction
   opens).
3. Inside one `withScopedDb`: lock the parent transaction row, count
   **primary** rows only (`primaryAttachmentWhere`) against
   `MAX_ATTACHMENTS_PER_TRANSACTION`, save the visible row, save its bytes,
   save the original row with `originalOfAttachmentId` set, save its bytes,
   clear both intents, return the visible row.
4. On any throw, delete every object that was written (`objectWritten` becomes
   a set of keys) and clear or keep each intent exactly as the single-file path
   does today.

The response is the visible row plus `originalAttachmentId: string | null`.

### Reads: one predicate for "a visible attachment"

`backend/src/attachments/primary-attachment.util.ts` exports the one place the
visibility rule is written, in both dialects the codebase uses:

```typescript
export const PRIMARY_ATTACHMENT_SQL = "original_of_attachment_id IS NULL";
export const primaryAttachmentWhere = { originalOfAttachmentId: IsNull() };
```

Its users, all switched in the same task:

- the cap count in `create`;
- `findAllForTransaction`, which returns primaries only, each carrying
  `originalAttachmentId` resolved by one `LEFT JOIN` on
  `original_of_attachment_id = ta.id` (no per-row query);
- the register's grouped `attachmentCount` and the `hasAttachments` EXISTS
  filter in `backend/src/transactions/transactions.service.ts`.

A guard spec (`primary-attachment.guard.spec.ts`) fails on the column name
appearing in a query outside that util, the entity, the migration mirror and
the restore plan. Without it the fourth site drifts, and a scan pair shows as
"2" in the register while the list shows one.

`getForDownload` is unchanged: it authorizes by `user_id` and the original has
its own id, so "View original" is the existing download route.

### Delete

`remove(userId, id)` deletes by `id = $1 OR original_of_attachment_id = $1`
(both keys `RETURNING storage_key`) and sweeps each key. The cascade would
delete the original anyway; naming it in the statement returns its key so the
bytes go promptly rather than on the next hourly sweep. Deleting an original's
id directly is allowed and leaves the visible row with `originalAttachmentId:
null`; the UI does not offer it.

### Backup and restore

The export reads `transaction_attachments` with `SELECT *`
(`backend/src/backup/export-table-queries.ts`), so the column ships in every
backup from the migration onwards. The restore inserts rows in archive order,
and a self-reference can point at a row that sorts later, so
`original_of_attachment_id` is added to `DEFERRED_FK_COLUMNS` and
`DEFERRED_FK_REPAIRS` in `backend/src/backup/restore-plan.ts` (the same
treatment as `accounts.linked_loan_account_id`);
`backend/src/backup/restore-plan.spec.ts` proves both lists against the schema.
`backend/test/integration/backup-restore.integration.spec.ts` gains a pair
whose original id sorts before its visible id. Legacy backups without the
column restore unchanged (`insertRows` inserts the columns present in the
archive).

### AI assistant and MCP

Neither surface lists attachment rows; both persist chat attachments through
`AttachmentsService.create` with a single file and continue to do so. No tool
changes.

## Frontend

### Engine and worker

New directory `frontend/src/lib/document-scanner/`:

| File | Role |
|---|---|
| `document-scan.types.ts` | `ScanRequest`, `ScanResult`, `Quad` (four `{x, y}` in source-image pixels, TL/TR/BR/BL), `QualityWarning`, worker message envelopes with `requestId`. Plain data only, transferable. |
| `opencv-engine.ts` | The one import of the OpenCV.js module, plus `loadEngine()` that resolves once `cv` is initialised. |
| `document-scan-pipeline.ts` | Pure functions over `{ width, height, data: Uint8ClampedArray }`: `detectDocument`, `warpToQuad`, `enhance`. No DOM types, so Vitest runs them under Node with the real engine. |
| `document-scan-quality.ts` | `assessCapture(image, quad)` returning `QualityWarning[]`. |
| `document-scan-messages.ts` | `handleScanMessage(msg)`: the worker's dispatcher, testable without a `Worker`. |
| `document-scan.worker.ts` | A shim: `onmessage = (e) => postMessage(await handleScanMessage(e.data), transfer)`. Excluded from coverage; everything it calls is covered. |
| `document-scan-client.ts` | Main-thread wrapper: creates the worker with `new Worker(new URL('./document-scan.worker.ts', import.meta.url))`, assigns request ids, transfers buffers, times out, terminates on dispose. |
| `synthetic-document.ts` | Test fixture generator: a dark frame with a white, rotated, perspective-skewed quad at known corners, optionally blurred or dim. Used by unit tests and by the e2e spec's PNG fixture. |

The hook `frontend/src/hooks/useDocumentScanner.ts` owns the client's
lifecycle, exposes `scan(file)`, `rewarp(quad, rotation)` and the engine's
loading state, and adopts a reply only when its `requestId` is the current one
(I6).

Engine packaging: the OpenCV.js build is a pinned npm dependency
(`@techstark/opencv-js`, Apache-2.0) imported only from `opencv-engine.ts`, so
the bundler emits it as its own chunk under `/_next/static/`, fetched on first
scan and thereafter cached by the service worker's existing static-asset rule.
The first task measures the gzipped chunk; if it exceeds 4 MB, the follow-up is
a trimmed build (core and imgproc only) vendored under `frontend/public/`, with
the recipe checked in. A source-scan test fails any import of the engine module
outside `opencv-engine.ts` (I7), and a bundle check asserts the shared app
chunks do not contain it.

Image decode: the main thread decodes the `File` with
`createImageBitmap(file, { imageOrientation: 'from-image' })` so EXIF rotation
is applied before the pipeline sees pixels, draws it to a canvas, and transfers
the `ImageData` buffer. The worker therefore has exactly one input shape;
browsers without `createImageBitmap` orientation support fall back to an
`<img>` decode on the main thread with the same output. The enhanced result
comes back as a buffer and is encoded to JPEG (quality 0.85, long edge capped
at 2500 px) on the main thread; that `Blob` is what the preview shows and what
is uploaded (I3).

CSP: `'wasm-unsafe-eval'` is added to `script-src` in `frontend/src/proxy.ts`
for production and development (`WebAssembly.instantiate` is refused without it
under a nonce policy), with the assertion added to `frontend/src/proxy.test.ts`.
Workers resolve through `default-src 'self'`, and the page's COOP/COEP headers
already permit a same-origin worker. `Permissions-Policy: camera=()` stays as
it is: the scan control uses the file input's `capture` attribute, which hands
off to the OS camera and is not gated by that policy; a live in-page viewfinder
(`getUserMedia`) is explicitly not part of v1.

### Pipeline

Detection runs on a working copy no larger than 1000 px on its long edge;
warp and enhancement run on the full image with the corners scaled back up.

1. **Detect** (discussion steps 1 and 2): grayscale, Gaussian blur, Canny
   with thresholds from the median intensity, dilate, `findContours`, and the
   largest convex `approxPolyDP` quadrilateral covering at least 20% of the
   frame. No candidate means `documentFound: false` and the quad defaults to
   the full frame, so every later step still runs.
2. **Perspective and crop** (steps 3 and 4): corners ordered TL/TR/BR/BL,
   output size from the longer of each opposite edge pair,
   `getPerspectiveTransform` and `warpPerspective`. Skew is corrected by the
   warp; a Rotate button turns the result by 90 degrees. Automatic
   upright-orientation needs text recognition and is out of scope.
3. **Lighting and shadow** (steps 5 and 6): per-channel background estimate by
   a large-kernel morphological close, divided out (division normalisation),
   then CLAHE (clip 2.0, 8x8 tiles) on the L channel in Lab.
4. **Contrast, denoise, sharpen** (steps 7 and 8): bilateral filter (d 5) and
   an unsharp mask (sigma 1.0, amount 0.6). Colour is kept; the
   black-and-white variant is deferred.

Every constant is named and lives in `document-scan-pipeline.ts`; the tests
that calibrate them cite the synthetic fixture they were tuned on.

### Quality checks

`assessCapture` returns zero or more of:

| Warning | Signal |
|---|---|
| `blurry` | Variance of the Laplacian on the working grayscale below a threshold scaled to the working size. |
| `edgesOutsideFrame` | `documentFound` is false, or any detected corner lies within 1% of the frame edge. |
| `lowResolution` | The warped output's short edge is under 600 px. |

Each is a warning with Retake beside Use anyway (I5). Overexposure and focus
scoring are noted as follow-ups; they need real-capture calibration data this
plan does not have.

### Dialog

`frontend/src/components/transactions/DocumentScanDialog.tsx` is a shared
`Modal` (`frontend/src/components/ui/Modal.tsx`, titled, `pushHistory`) driven
by one state value:

| State | Shown | Actions |
|---|---|---|
| `loadingEngine` | Spinner, "Preparing the scanner" | Cancel |
| `analysing` | Spinner over the original | Cancel |
| `review` | Preview with an Original / Enhanced toggle (two shared `Button`s, not a tablist), the corner handles over the original, quality warnings, Rotate | Use enhanced, Keep original only, Retake, Cancel |
| `failed` | The error (engine failed to load, unsupported image) | Keep original only, Retake, Cancel |

"Keep original only" hands the untouched `File` to the same path a plain
upload takes. "Use enhanced" hands back `{ file: enhancedBlobAsFile, original }`.
When the original exceeds `MAX_ATTACHMENT_BYTES` the review state says the
original cannot be kept and offers to continue with the enhanced image alone;
it never silently drops it.

`DocumentCornerHandles.tsx` draws the quad as an SVG overlay in display
coordinates with four handles using pointer events and `setPointerCapture`,
`touch-action: none`, arrow-key nudging for keyboard users, and a convexity
check that snaps an invalid drag back. Releasing a handle calls `rewarp`,
which re-runs steps 2 to 4 without re-detecting.

### Attachments section

`ScanDocumentControl.tsx` is the sibling of the existing `UploadControl`: an
outline `Button` labelled "Scan document" over a hidden
`<input type="file" accept="image/*">` that adds `capture="environment"` when
`useIsMobile()` is true. On mobile this opens the rear camera directly, which
is what was chosen; scanning a photo already in the gallery is then a desktop
flow in v1, and a two-entry menu (Camera / Choose photo) is the recorded
follow-up if that proves limiting.

Saved mode: the dialog's result is uploaded through
`attachmentsApi.upload(transactionId, file, original?)`
(`frontend/src/lib/attachments.ts`), which appends the second part when
present and keeps the existing `invalidateCache('attachments:')`.

Staged mode: `stagedFiles: File[]` becomes `StagedAttachment[]`
(`{ file: File; original?: File }`) in `frontend/src/types/attachment.ts`;
`TransactionForm.tsx`'s post-create loop passes both parts. The staged
thumbnail shows the enhanced file.

The saved list shows one row per pair with the enhanced thumbnail and, when
`originalAttachmentId` is set, a "View original" link to
`attachmentDownloadUrl(originalAttachmentId)`. Delete removes the pair (one
confirm, as today).

### i18n

New keys go under the existing `attachments` namespace
(`frontend/src/i18n/messages/en/attachments.json`) with a `scan.` prefix
(button, dialog title, state labels, the three warnings, the four actions, the
too-large notice, the failure copy) and under `errors.attachments.` in
`backend/src/i18n/locales/en/errors.json` for the two new refusals. English
only until the final localisation task; `npm run i18n:pseudo` after every
English edit.

## Storage and lifecycle notes

- Two objects per scan, each ordered before the commit exactly as one object
  is today; `docs/external-side-effects.md` section 2 is updated to say so and
  its gap table gains no new row, because the pair inherits the existing
  intent-and-sweep mechanism rather than a new window.
- Storage cost is roughly the original plus 15 to 30% (a 2500 px JPEG at
  quality 0.85 is typically 400 to 900 KB). The 10-per-transaction cap counts
  pairs as one.
- The sweeper's tombstone trigger fires per row, so a cascade-deleted original
  is swept like any other external object; the prompt sweep in `remove` is an
  optimisation, not the mechanism.
- Sharding is untouched: both rows use their own id as the storage key
  (`docs/adr/0003-filesystem-objects-use-id-sharding.md`).

## Testing

| Layer | Suite | What it proves |
|---|---|---|
| Database | `scripts/verify-schema.sh`, `npm run migration:lint` | The migration replays as a no-op over `schema.sql`. |
| Backend unit | `attachments.service.spec.ts` | Pair create writes two rows and two objects in one transaction; a throw after the first object deletes it and keeps the intent; a PDF with an original is refused; the cap counts primaries only; `remove` returns and sweeps both keys. |
| Backend unit | `primary-attachment.guard.spec.ts` | The visibility column appears in no query outside the util. |
| Backend unit | `restore-plan.spec.ts` | The new deferred column is in both lists and matches the schema. |
| Backend integration | `attachment-scan-pair.integration.spec.ts` | Against a real database: cascade delete, the partial unique index, the CHECK, `attachmentCount` and `hasAttachments` on a pair. |
| Backend integration | `backup-restore.integration.spec.ts` | A pair whose original sorts first survives export and restore. |
| Frontend unit | `document-scan-pipeline.test.ts`, `document-scan-quality.test.ts` | Real engine under Node on synthetic fixtures: detected corners within tolerance of the planted ones, `documentFound: false` on a blank frame, a blurred fixture flags `blurry`, a sharp one does not, determinism (same input twice is byte-equal, I3). |
| Frontend unit | `document-scan-client.test.ts`, `useDocumentScanner.test.ts` | Mocked `Worker`: request ids, a stale reply is dropped (I6), timeout, dispose terminates. |
| Frontend unit | `DocumentScanDialog.test.tsx`, `DocumentCornerHandles.test.tsx`, `AttachmentsSection.test.tsx` | State transitions, every warning keeps "Use anyway", handle drag calls `rewarp`, staged pairs upload both parts, "View original" renders only when the id is present. |
| Frontend guard | `document-scan.guard.test.ts` | The engine module is imported only from `opencv-engine.ts`; `new Worker(` appears only in `document-scan-client.ts`. |
| Frontend guard | `proxy.test.ts` | `'wasm-unsafe-eval'` is in `script-src`. |
| E2E | `e2e/tests/attachments.spec.ts` | Chromium runs the real WASM: plain upload, scan a generated fixture PNG, accept, one row with "View original", download both, delete removes both. Follows `e2e/tests/import.spec.ts` for `setInputFiles`. |

A green suite after any behaviour change in this list is a finding, per the
root `CLAUDE.md`.

## Follow-ups recorded, not planned

- Black-and-white scan variant as a third preview toggle.
- Auto-offer the scan dialog on any image upload, behind a
  Settings > Preferences toggle.
- Camera / Choose-photo menu on mobile.
- Overexposure and focus scoring in the quality checks.
- Trimmed custom OpenCV.js build if the npm chunk is too large.
- Multi-page capture into one PDF; OCR and invoice field extraction feeding the
  transaction form; generalising attachments beyond transactions
  (`security_documents` already notes that dependency).
- PWA share target (the second part of Discussion #1292).
