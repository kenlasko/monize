# Warranty tracker

Specification of the warranty tracker: a purchased item, the date it was
bought, when its warranty ends (or that it never does), who sold it, its
serial and model numbers, the receipt, manual and photos that prove it, the
claims made against it, and a reminder before it runs out. Approved directly
by the maintainer on 2026-10-21 rather than through a Discussion, it shipped
from branch `feat/warranty-tracker` on 2026-10-21 and 2026-10-22, one commit
per task of the retired task list (B1 b0ea503fc through D1 527b03545, the
locale pass in 17d9e51d1), with the maintainer's rulings of 2026-10-22 on a
linked warranty's documents landing in 09ffe7ca5, 9f3ef9f2e and 81e608917:
`backend/src/warranties/`, the Warranties page (route /warranties), and the
invariants `INV-WTY-001` to `INV-WTY-007` in `docs/system-invariants.md`.
Where the build is more specific than the text, "As built" at the end of
section 3 says how. A warranty moves no money, so sections 4 to 9 are short.
The plan is retired and this document is kept as the specification the code
is held to; the questions it answered "not in v1" are recorded under
Follow-ups at the end.

Inspiration: Warracker (https://github.com/sassanix/Warracker), a standalone
warranty manager. Inside Monize most warranties start as a transaction that is
already in the register, with the receipt already attached and scanned, and the
reminder can ride the notification centre that already exists. The point of
doing it here rather than beside Monize is that the purchase, the proof and
the reminder are one record.

## 1. Goal

- A **Warranties** page (Tools menu) listing every warranty with its status
  (lifetime, active, expiring, expired), days left, vendor, purchase price,
  document count and open-claim count; a status filter, a search box, sort,
  archive, export and import.
- A **warranty detail** page: the status card, the documents (receipt, manual,
  photo, other), the claims log, and the linked transaction.
- **From the register**: a shield badge on rows that have one, and a
  Warranties line in the transaction edit form. A row's action sheet and
  Copy dropdown offer no warranty action: the form and the Warranties page
  are where one is added. The register's own behaviour
  does not change.
- **Reminders** 30 and 7 days before expiry and on the day, under a new
  `warranties` notification category, with snooze and repeat from the
  notification centre.
- An opt-in **dashboard widget**, "Warranties expiring soon".
- A **delegate READ section** so a trusted person can look up a warranty.
- A read-only **`list_warranties`** tool on both AI surfaces.
- **CSV import and export** in Warracker's column set, so a Warracker user can
  move over.

A warranty **never moves money**. It carries a purchase price for reference
and never contributes to a balance, a report or a total.

## 2. What exists, and what this composes

| Need | Existing piece | Notes |
|---|---|---|
| A purchase in the ledger | `Transaction` (`backend/src/transactions/entities/transaction.entity.ts`): `transactionDate`, `payeeId`, `payeeName`, `description`, `amount`, `currencyCode`; `transactionsApi.getById` (`frontend/src/lib/transactions.ts`) | The prefill source when a warranty is created from a row. |
| Files on a transaction | `transaction_attachments`, `attachment_blobs` (`database/schema.sql`), `AttachmentsService` (`backend/src/attachments/attachments.service.ts`), `attachmentsApi` (`frontend/src/lib/attachments.ts`), `AttachmentsSection.tsx`, `AttachmentPreviewDialog.tsx`, `ScanDocumentControl.tsx` (`frontend/src/components/transactions/`) | Bound to `transaction_id NOT NULL` today; generalised by decision 7. Ownership is `user_id`; the blob policy, the tombstone trigger, `AttachmentOrphanSweeperService` and `AttachmentStorageMigratorService` are keyed by attachment id and do not change. |
| The register's per-row counts | `attachmentCount` enrichment in `TransactionsService` (`backend/src/transactions/transactions.service.ts`), `AttachmentBadge` in `TransactionRow.tsx` | `warrantyCount` joins it, one more grouped count over the page's ids. |
| `has:attachment` search | `transaction-search.util.ts` (`backend/src/transactions/`) | `has:warranty` is the same shape. |
| Vendor | `payees` (`backend/src/payees/entities/payee.entity.ts`), `usePayeeDisplay` (`frontend/src/hooks/usePayeeDisplay.ts`) | A warranty carries `payee_id` plus a free-text `vendor_name`, as a transaction does. |
| The one date input, the one money input | `DateInput.tsx`, `CurrencyInput.tsx`, `CurrencyPickerButton.tsx` (`frontend/src/components/ui/`, `frontend/src/components/transactions/`) | `docs/frontend/forms-and-formatting.md`. |
| Calendar dates on the server | `IsCalendarDate` (`backend/src/common/validators/is-calendar-date.validator.ts`), `todayInTimezone`, `addDaysYMD` (`backend/src/common/date-utils.ts`), `daysBetweenYMD` (`backend/src/bank-sync/bank-sync-notifications.ts`) | DATE columns hold strings; no `Date` at the boundary. |
| An "expiring soon" reminder cron | `BankSyncConsentReminderService` (`backend/src/bank-sync/bank-sync-consent-reminder.service.ts`), `consentReminderThreshold` (`backend/src/bank-sync/bank-sync-notifications.ts`), `getUsersByEffectiveTimezone` (`backend/src/common/users-by-timezone.util.ts`) | The template: system-context candidate scan, per-user context, days left in the user's timezone, one notification per threshold by `dedupeKey`. |
| The notification door | `NotificationDispatchService.notify` (`backend/src/notifications/notification-dispatch.service.ts`) over `NotificationService.create` | INV-NOTIFY-001, INV-DISPATCH-001..004. |
| Per-category channel matrix | `NOTIFICATION_PREFERENCE_CATEGORIES`, `NOTIFICATION_CATEGORY_DEFAULTS` (`backend/src/notification-center/notification-preference.service.ts`), mirrored in `frontend/src/lib/notification-preferences.ts` | `docs/specs/notification-preferences.md` gains a `warranties` group. |
| Snooze and repeat | `notification_reminders`, `NotificationReminderService` (`backend/src/notification-center/`) | Free for any notification. |
| Delegate sections | `account_delegates.*_can_read`, `DelegateSection`, `DelegateRequiresSection` (`backend/src/delegation/decorators/delegate-access.decorator.ts`), `SECTION_FIELD` (`backend/src/delegation/delegation.service.ts`), `DelegateSectionGuard.tsx` (`frontend/src/components/auth/`), `DelegateAccessModal.tsx` (`frontend/src/components/settings/`) | A sixth section, `warranties`. |
| Narrowing a read to a delegate's accounts | `delegateReadableAccountScope` (`backend/src/delegation/delegate-account-scope.util.ts`) | Decides whether the linked transaction is shown. |
| Dashboard widget registry | `DASHBOARD_WIDGETS` (`frontend/src/components/dashboard/widget-registry.tsx`), `WIDGET_ICONS` (`widget-meta.tsx`) | Template: `InsightsWidget.tsx` (self-fetching). No backend change for a new id. |
| Tools menu | `TOOLS_LINKS`, `NAV_ICONS` (`frontend/src/lib/nav-links.ts`); `AppHeader.tsx`, `MobileNavDrawer.tsx` (`frontend/src/components/layout/`) | Tools links are gated for delegates by capability today; decision 9 adds a section gate beside it. |
| List chrome | `Table.tsx`, `SortableHeader.tsx`, `ListTopToolbar.tsx`, `ListBottomPager.tsx`, `EmptyState.tsx`, `Modal.tsx`, `ConfirmDialog.tsx`, `row-actions/` (`frontend/src/components/ui/`), `useLongPress` (`frontend/src/hooks/useLongPress.ts`), `useFormModal` (`frontend/src/hooks/useFormModal.ts`) | Page to mirror: `PayeeList.tsx` (`frontend/src/components/payees/`) for rows, the Tags page for the shell. |
| The one CSV writer | `csv-export.ts` (`frontend/src/lib/`) | `ui-conventions.test.ts` fails a second one. |
| An RFC 4180 reader | `parseCsv`, `validateCsvContent` (`backend/src/import/csv-parser.ts`) | Reused by the warranty importer. |
| Cron and contexts | `withSystemContext` / `withUserContext` (`backend/src/common/db/with-context.ts`), `WITH_CONTEXT_ALLOWLIST` (`backend/eslint.config.mjs`), `docs/cron-jobs.md` | One row, one allowlist entry. |
| Backup classification | `buildExportTableQueries` (`backend/src/backup/export-table-queries.ts`), `RESTORE_PLAN` (`backend/src/backup/restore-plan.ts`), `restore-references.ts`, `RULES` (`backend/src/backup/support-backup/support-backup-rules.ts`), `restore-labels.ts` (`frontend/src/lib/`) | A new table is exported or excluded, never neither. |
| Currency references | `CURRENCY_REFERENCE_COLUMNS` (`backend/src/currencies/currency-reference-columns.ts`) and the SQL function `currency_codes_referenced_by_user` | A new `currency_code` column joins both or `currency-references.spec.ts` fails. |
| AI tools | `docs/backend/mcp.md` "Adding a tool", `tool-definitions.ts`, `tool-executor.service.ts` (`backend/src/ai/query/`) | One domain method, two registrations, one PR. |
| No warranty concept today | grep of `warrant` over `backend/src`, `frontend/src`, `database` | Hits are the bank-sync terms and unrelated prose. |

## 3. Product decisions

1. **The stored fact is `expires_on`.** The form offers a duration helper
   (years, months, days from the purchase date) and a lifetime switch. The
   create and update DTOs accept exactly one of `expiresOn`, `term
   {years, months, days}` or `isLifetime: true` (a class-level validator, as
   the savings-goals "exactly one source" rule). One pure helper,
   `warranty-expiry.util.ts`, turns a term into a date for the API and the CSV
   importer alike; nothing else adds months to a date.
2. **Status is derived, never stored.** `lifetime`, `active`, `expiring`
   (within the window) or `expired`, from one function
   `warrantyStatus(expiresOn, isLifetime, today, windowDays)` in
   `warranty-status.util.ts`. The list, the detail, the widget, the cron and
   the AI tool all read it. A warranty that expires today is `expiring`, not
   `expired` (Warracker's rule). `archived_at` hides a row from the list, the
   widget, the cron and the AI tool without deleting its history.
3. **The window is 30 days and the reminder thresholds are 30, 7 and 0.**
   Fixed in v1. Open question W1 asks whether a per-user preference is wanted.
4. **A warranty may link to one transaction; a transaction may carry many
   warranties.** A receipt with three items is three warranties. The link is
   `ON DELETE SET NULL`: deleting the transaction keeps the warranty and its
   own documents; the transaction's attachments go with the transaction.
5. **Vendor is `payee_id` plus `vendor_name`.** Creating from a transaction
   prefills the name (the payee, else the description), the vendor and payee,
   the purchase date, the price (`abs(amount)`) and the currency (the
   account's). A split transaction prefills the whole amount; the user edits
   before saving. The link is to the parent row, never to a split line.
6. **The purchase price is informational.** `purchase_price` carries its own
   `currency_code` (both set or both null). No surface sums it; there is no
   "value under warranty" figure in v1 (open question W2).
7. **Attachments gain a second parent.** `transaction_attachments.transaction_id`
   becomes nullable, `warranty_id` is added, a CHECK requires exactly one of
   the two, and `document_kind` (`receipt | manual | photo | warranty | other`,
   default `other`; `warranty` is the warranty certificate itself) is added. Both rows of a scan pair carry the same parent. Ownership
   stays `user_id`, so the `attachment_blobs` policy, the tombstone trigger,
   the orphan sweeper, the storage migrator and the backup transfer do not
   change. The per-parent cap (`MAX_ATTACHMENTS_PER_TRANSACTION`, ten) applies
   to a warranty as well, under a `lockWarrantyRow` with the same doctrine as
   `lockTransactionRow`. The table keeps its name: the name is historical and
   renaming it would touch every consumer for no behaviour. **A transaction's
   attachments are its own rows plus the documents of every warranty linked
   to it**, archived or not (the maintainer's ruling, 2026-10-22, after
   testing the first build, which kept the two apart): the transaction's
   attachment list, the register's paperclip, `has:attachment` and the rule
   engine's attachment fact reach a linked warranty's documents through
   `warranties.transaction_id`, with one fragment
   (`attachmentReachableFromTransactionSql` / `reachedTransactionIdSql` in
   `backend/src/attachments/attachment-parent.ts`); each listed row names its
   warranty (`warrantyName`). The row still has one parent, the warranty, and
   the cap is still counted per parent.
8. **Claims are a child table.** `warranty_claims` carries `claim_date`,
   `status` (`open | approved | denied | resolved`), `description`,
   `resolution` and `resolved_on`. A claim never changes the warranty's status.
9. **Delegates read, never write.** `warranties_can_read` on
   `account_delegates`, a sixth `DelegateSection`. A delegate with the section
   sees warranties, their documents and their claims. The linked transaction is
   shown only when its account is in the delegate's readable scope
   (`delegateReadableAccountScope`); otherwise `linkedTransaction` is `null`
   and `transactionId` is omitted from the response. Create, update, delete,
   archive, import, document upload and claim mutations are owner-only.
10. **Reminders ride the notification centre.** Category `WARRANTIES`; types
    `warranty_expiring` (thresholds 30 and 7) and `warranty_expires_today`
    (threshold 0); in-app on, report email configurable, push off, the
    convention for a new group in `docs/specs/notification-preferences.md`.
    A warranty whose `expires_on` changes gets a fresh set of reminders because
    the date is part of the dedupe key. Nothing fires after the day of expiry.
11. **The AI tools are read-only.** `list_warranties` on MCP and the in-app
    assistant over one `getLlmWarranties` method, with `status`, `daysLeft`,
    `expiresOn`, `vendorName`, `linkedTransactionId` and `openClaimCount`. No
    write tool: creating a warranty is cheap in the UI and a write tool needs
    the MCP confirmation round (INV-MCP-003, INV-MCP-004) for no gain.
12. **CSV is Warracker's column set**, so an export re-imports and a Warracker
    export imports: `ProductName`, `PurchaseDate` (ISO), `WarrantyDurationYears`,
    `WarrantyDurationMonths`, `WarrantyDurationDays`, `ExpirationDate`,
    `IsLifetime`, `PurchasePrice`, `SerialNumber`, `ProductURL`, `Vendor`,
    `Tags`, `Notes`, `Currency`, `ModelNumber`, `WarrantyType`. Serial numbers
    are comma-separated, or a JSON array when a value holds a comma; the
    importer accepts both. `Tags` is read and reported as skipped (no tags on
    a warranty in v1). An unknown or blank `Currency` falls back to
    `resolveUserDefaultCurrency` when a price is present. Import is
    preview-then-commit through one code path (a `dryRun` flag); the file is
    at most 1 MiB and 1000 rows. Export is client-side through `csv-export.ts`
    over the loaded list.
13. **Warranty kind is a short enum**, `manufacturer | extended | store |
    other`, not free text, so the filter and the CSV `WarrantyType` column
    agree.
14. **Explicitly not in v1**: hideable columns on the list, tags on a
    warranty, a total-value card, a Paperless-ngx link, a calendar export,
    multiple photos as a gallery (photos are documents of kind `photo`).

As built (branch `feat/warranty-tracker`), where the implementation is more
specific than the text above or than sections 6 and 10:

- **Primary keys default to `uuid_generate_v4()`**, the default the rest of
  `database/schema.sql` uses, not the `gen_random_uuid()` that 6.1 and 6.2
  show.
- **The notification types are upper-case**, `WARRANTY_EXPIRING` and
  `WARRANTY_EXPIRES_TODAY`, as every other `NotificationType` value is;
  decision 10 and 6.6 write them lower-case.
- **The delegate section migration backfills.**
  `20261022004800_delegate_warranties_section.sql` sets `warranties_can_read`
  on an active delegation that already granted the five older sections and READ
  on every account the owner has: `DelegationService.grantsWholeLedger`
  requires every section, so without the backfill such a delegate would lose
  the AI assistant on deploy. A partial delegation gains nothing.
- **`linkedTransactionHidden`** joins the view (6.5): `true` only for an acting
  delegate when the warranty links to a purchase outside their readable
  accounts, so the detail page says the purchase is in an account they cannot
  read (section 9) rather than that there is none. It carries no id, so
  WTY-007 holds.
- **On import an `ExpirationDate` beside a duration wins.** Warracker's export
  writes both on every row; the stored fact is the date (decision 1), so the
  row uses `ExpirationDate` and notes the `WarrantyDuration` columns as
  ignored, or as disagreeing when they give another date. `IsLifetime` beside
  either is invalid, and an unknown `WarrantyType` imports as `other` with a
  note. The service reads the file's text:
  `WarrantyImportService.run(userId, content, { dryRun, skipInvalid })`.
- **The dashboard widget's id is `warranties-expiring`.**
- **The CHECK constraints are SQL-only.** Those of `warranties` and
  `warranty_claims`, and `chk_attachment_one_parent`, are declared in the
  migrations and `database/schema.sql` and not on the entities: the RLS spec's
  generic row seeder builds its rows from the entities and could not satisfy a
  cross-column rule. `chk_attachment_document_kind`, one column, is on the
  attachment entity as well.
- **The form computes a term on the client.** Its duration helper,
  `warrantyTermEndDate` in `frontend/src/lib/warranties.ts`, applies the same
  month-end rule as `termToExpiresOn` and submits `expiresOn`; decision 1's
  "nothing else adds months to a date" holds on the server.
- **The delegate's account scope is resolved in the controller**, once per
  request, and the service narrows the purchase with `restrictToAccountScope`
  in `loadLinkedTransactions`, the one read of a warranty's purchase.
- **Documents of a linked warranty are the transaction's attachments**, by
  the maintainer's ruling of 2026-10-22, reversing decision 7's original
  consumer rule ("a warranty document never appears in the register count,
  `has:attachment` or the rule facts"); a document's kind can be changed after
  upload (`PATCH attachments/:id`, `AttachmentsService.updateDocumentKind`,
  both halves of a scan pair together).
- **A document's kind is set on its row, not on upload** (the maintainer's
  ruling, 2026-10-22): the Documents section has no upload-time kind picker,
  a new document is stored as `other`, and the owner changes it with the
  row's picker. The upload route and `attachmentsApi.upload` still accept a
  `documentKind` for a caller that knows it.

## 4. Definitions

- `today`: `todayInTimezone(userTimezone)` on the server, echoed in the
  response; the cron uses the same value per user.
- `daysLeft`: `daysBetweenYMD(today, expiresOn)`; negative once expired;
  `null` for a lifetime warranty.
- `status`: decision 2. `windowDays` is 30.
- `linkedTransaction`: `{ id, transactionDate, payeeName, amount, currencyCode,
  accountId }` or `null`; under a delegate context, `null` unless the account
  is readable (decision 9).
- `documentCount`: primary attachments of the warranty (`original_of_attachment_id
  IS NULL`), the same rule as the register's paperclip.

## 5. Invariants

| ID | Statement | Mechanism |
|---|---|---|
| WTY-001 | A warranty never writes a ledger row, a balance or a holding | `warranties.guard.spec.ts` scans `backend/src/warranties/` and fails an import of `TransactionsService`, an `AccountsService` writer, `HoldingsService` or `InvestmentTransactionsService`; the failure message names this ID. |
| WTY-002 | Every status a surface prints is the server's, from one function | `warrantyStatus` is the only place the date comparison lives; the list, detail, widget, cron and AI shapes carry `status` and `daysLeft`; a component formats and never compares dates. `ui-conventions.test.ts` already holds the "a widget's breakdown is the endpoint's own" rule. |
| WTY-003 | An attachment has exactly one parent | `chk_attachment_one_parent` on the table; `AttachmentsService.create` and `findAllFor` take an `AttachmentParent` discriminated union (`{ kind: 'transaction', id }` or `{ kind: 'warranty', id }`), never two ids; the controller has one route per parent. |
| WTY-004 | Each threshold notifies once per (warranty, `expires_on`, threshold), across replicas | `dedupeKey = "wty:exp:<warrantyId>:<expiresOn>:<threshold>"` on the notification row (INV-NOTIFY-001); the threshold is the smallest mark at or above days left (`consentReminderThreshold`'s rule), so a missed day does not fire a burst; a replica that loses the insert gets `null` and sends nothing. |
| WTY-005 | A refusal happens before the write | The linked transaction and payee are loaded by `(id, userId)` inside the `withScopedDb` transaction that inserts or updates; a foreign id is a 404 and nothing is written; the integration test asserts the row count. |
| WTY-006 | Import preview and commit are one computation | `WarrantyImportService.run(userId, rows, { dryRun })` parses, validates and resolves every row once; the commit path calls it again inside its own transaction and inserts only when every row is valid or the caller chose `skipInvalid`. |
| WTY-007 | A delegate never learns a transaction outside their readable accounts through a warranty | `linkedTransaction` is resolved through `delegateReadableAccountScope`; the integration test reads as a delegate lacking the account grant and asserts `null` and no `transactionId`. |

## 6. Data contracts (new)

### 6.1 Table `warranties`

```sql
CREATE TABLE IF NOT EXISTS warranties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  vendor_name VARCHAR(200),
  payee_id UUID REFERENCES payees(id) ON DELETE SET NULL,
  transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  model_number VARCHAR(100),
  serial_numbers TEXT[] NOT NULL DEFAULT '{}',
  warranty_kind VARCHAR(20) NOT NULL DEFAULT 'manufacturer'
    CHECK (warranty_kind IN ('manufacturer', 'extended', 'store', 'other')),
  purchase_date DATE NOT NULL,
  expires_on DATE,
  is_lifetime BOOLEAN NOT NULL DEFAULT false,
  purchase_price NUMERIC(24,8) CHECK (purchase_price IS NULL OR purchase_price >= 0),
  currency_code VARCHAR(3) REFERENCES currencies(code),
  product_url VARCHAR(500),
  notes VARCHAR(2000),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_warranty_expiry CHECK (is_lifetime OR expires_on IS NOT NULL),
  CONSTRAINT chk_warranty_expiry_after_purchase
    CHECK (expires_on IS NULL OR expires_on >= purchase_date),
  CONSTRAINT chk_warranty_price_currency
    CHECK ((purchase_price IS NULL) = (currency_code IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_warranties_user_status ON warranties(user_id, archived_at, expires_on);
CREATE INDEX IF NOT EXISTS idx_warranties_transaction ON warranties(transaction_id);
CREATE INDEX IF NOT EXISTS idx_warranties_payee ON warranties(payee_id);
```

Direct RLS bucket (`user_id`): the uniform policy plus `ENABLE ROW LEVEL
SECURITY` in the same migration, the `20260912034642_calendar_day_notes.sql`
boilerplate; the table name joins `direct_tables` in `database/schema.sql`;
the `update_updated_at_column` trigger. `serial_numbers` is bounded in the
DTO (`@ArrayMaxSize(10)`, each `@MaxLength(100)`). `currency_code` joins
`CURRENCY_REFERENCE_COLUMNS` and the SQL function
`currency_codes_referenced_by_user` in the same PR.

Backup: exported (`warranties` in `buildExportTableQueries`, a `RESTORE_PLAN`
row after `transactions` and `payees` and before `transaction_attachments`, a
`BackupData` field, the per-user `DELETE` in the restore before
`transactions`, a `RESTORE_LABELS` entry, `restore-references.ts` rows for
`transaction_id` and `payee_id`). Support backup: `name`, `vendor_name`,
`model_number`, `serial_numbers`, `product_url` and `notes` masked, the rest
kept. `UsersService.runOwnedDataDeletes` deletes it: the link is SET NULL, so
the transaction purge does not reach it.

### 6.2 Table `warranty_claims`

```sql
CREATE TABLE IF NOT EXISTS warranty_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  warranty_id UUID NOT NULL REFERENCES warranties(id) ON DELETE CASCADE,
  claim_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'approved', 'denied', 'resolved')),
  description VARCHAR(2000),
  resolution VARCHAR(2000),
  resolved_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_warranty_claims_warranty ON warranty_claims(warranty_id);
```

Direct bucket, same boilerplate. Exported, restored after `warranties`,
deleted with it; `description` and `resolution` masked in the support backup.

### 6.3 Attachment generalisation

A migration on `transaction_attachments`, every statement idempotent:

```sql
ALTER TABLE transaction_attachments ALTER COLUMN transaction_id DROP NOT NULL;
ALTER TABLE transaction_attachments
  ADD COLUMN IF NOT EXISTS warranty_id UUID REFERENCES warranties(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS document_kind VARCHAR(20) NOT NULL DEFAULT 'other';
-- CHECK constraints are added with a DO block guarded by pg_constraint, the
-- repository's pattern for idempotent constraints.
--   chk_attachment_document_kind:
--     document_kind IN ('receipt','manual','photo','warranty','other')
--     (`warranty` widened in by a later migration, attachment_kind_warranty)
--   chk_attachment_one_parent:
--     (transaction_id IS NOT NULL)::int + (warranty_id IS NOT NULL)::int = 1
CREATE INDEX IF NOT EXISTS idx_transaction_attachments_warranty
  ON transaction_attachments(warranty_id);
```

The entity gains `warrantyId: string | null` and `documentKind`;
`transactionId` becomes `string | null`. `restore-references.ts` maps
`warranty_id` to `warranties`. The register's count query, `has:attachment`
and `loadAttachmentPresence` in `rule-facts.ts` reach the transaction's own
rows and its linked warranties' documents through the shared fragment
(decision 7, as ruled), and a test asserts a linked warranty's document
appears in each and an unlinked one's in none.

### 6.4 Column `account_delegates.warranties_can_read`

`BOOLEAN NOT NULL DEFAULT false`, the `071_account_delegate_sections.sql`
shape. `DelegateSection` gains `"warranties"`; `SECTION_FIELD`,
`toSectionSet`, `setSectionGrants` and `SetSectionsDto` gain the field;
`DelegateSectionSet` on the client mirrors it.

### 6.5 Routes

```ts
interface WarrantyView {
  id: string; name: string; vendorName: string | null; payeeId: string | null;
  modelNumber: string | null; serialNumbers: string[];
  warrantyKind: 'manufacturer' | 'extended' | 'store' | 'other';
  purchaseDate: string; expiresOn: string | null; isLifetime: boolean;
  purchasePrice: number | null; currencyCode: string | null;
  productUrl: string | null; notes: string | null;
  today: string; status: 'lifetime' | 'active' | 'expiring' | 'expired';
  daysLeft: number | null;
  documentCount: number; openClaimCount: number;
  transactionId?: string;                 // omitted for a delegate without the account
  linkedTransaction: LinkedTransaction | null;
  archivedAt: string | null; createdAt: string; updatedAt: string;
}
```

- `GET /warranties?status=&q=&transactionId=&archived=&sort=&page=&limit=`
  (status is one of the four or `all`; `q` matches name, vendor, model and
  serial numbers; sort is `expiresOn | name | purchaseDate`), `GET
  /warranties/:id`, `GET /warranties/summary` (counts per status for the
  summary strip and the widget). Read routes carry `@AllowDelegate()` and
  `@DelegateRequiresSection('warranties')`.
- `POST /warranties`, `PATCH /warranties/:id`, `DELETE /warranties/:id`,
  `POST /warranties/:id/archive`, `POST /warranties/:id/unarchive`. Owner-only.
  The create and update DTOs carry the columns above as camelCase with the
  "exactly one of `expiresOn`, `term`, `isLifetime`" validator; no `userId`;
  `ParseUUIDPipe` on every `:id`; `@SanitizeHtml()` on every free-text field.
- `GET /warranties/:id/claims`, `POST /warranties/:id/claims`, `PATCH
  /warranties/:id/claims/:claimId`, `DELETE /warranties/:id/claims/:claimId`.
  The GET is delegate-readable.
- `POST /warranties/import?dryRun=true|false` (multipart `file`, CSV): returns
  `{ rows: [{ line, outcome: 'valid' | 'invalid' | 'created', errors: string[],
  skippedColumns: string[] }], created: number }`. Owner-only.
- `POST warranties/:warrantyId/attachments` (multipart `file`, optional
  `original`, field `documentKind`) and `GET warranties/:warrantyId/attachments`
  beside the transaction routes in `attachments.controller.ts`. The GET is
  delegate-readable under the section; `GET attachments/:id/download` is
  reachable by a delegate only when the attachment's parent warranty is (the
  service checks the parent's section when the caller is a delegate). `DELETE
  attachments/:id` is unchanged and owner-only.
- `GET /transactions` rows gain `warrantyCount` beside `attachmentCount`;
  `has:warranty` joins `has:attachment` in `transaction-search.util.ts` and
  `searchInterpretation` echoes it.

### 6.6 Notification types

`warranty_expiring` and `warranty_expires_today` in `NotificationType`
(both fit `VARCHAR(30)`), a `WARRANTY_NOTIFICATION_TYPES` list and a
`WARRANTIES` branch in `notificationCategoryOf` (unmapped types fall through
to BUDGETS, so the list is not optional). `NotificationCategory.WARRANTIES`
with in-app on, email in report mode configurable, push off; the frontend
mirror and `notification-preferences.contract.test.ts` updated in the same
PR. `target` is `/warranties/<id>`, written as a literal in the producer so
`notification-target.contract.test.ts` can read it. `data` holds
`{ warrantyId, name, expiresOn, threshold, daysLeft }`, facts not prose.

### 6.7 Cron

`WarrantyExpiryReminderService.run` at `17 6 * * *` UTC (a minute of its
own, away from the consent reminder at 06:23 and the AI review at 07:41).
`withSystemContext` lists unarchived, non-lifetime warranties with
`expires_on BETWEEN today - 1 AND today + 31` (UTC bounds wide enough for
every timezone), grouped by user. Per user, `withUserContext(userId)`:
`today` in the user's timezone (`getUsersByEffectiveTimezone`), `daysLeft`
per warranty, the threshold by `consentReminderThreshold`'s rule over
`[30, 7, 0]`, then `notify` with the WTY-004 key. A user's failure is caught
and logged so the loop continues. Row in `docs/cron-jobs.md` naming the
dedupe key as the replica mechanism; the file in `WITH_CONTEXT_ALLOWLIST`.

## 7. Truth tables

### A. Status

| `is_lifetime` | `daysLeft` | status |
|---|---|---|
| true | n/a | `lifetime` |
| false | > 30 | `active` |
| false | 1 .. 30 | `expiring` |
| false | 0 | `expiring` (expires today) |
| false | < 0 | `expired` |

### B. Reminder on a tick

| `daysLeft` | threshold picked | key suffix | fires |
|---|---|---|---|
| 45 | none (above 30) | -- | no |
| 30 | 30 | `:30` | yes |
| 29 .. 8 | 30 (already used) | `:30` | no, the key exists |
| 7 | 7 | `:7` | yes |
| 6 .. 1 | 7 (already used) | `:7` | no |
| 0 | 0 | `:0` | yes, `warranty_expires_today` |
| -1 | none | -- | no |
| any, archived or lifetime | not a candidate | -- | no |

A warranty created with 20 days left fires the 30-day reminder on its first
tick (the smallest mark at or above 20 is 30), then the 7-day one.

### C. Linked transaction in the response

| caller | account readable by caller | `transactionId` | `linkedTransaction` |
|---|---|---|---|
| owner | always | present | the row |
| delegate with the section | yes | present | the row |
| delegate with the section | no | omitted | `null` |
| delegate without the section | n/a | 403 on the route | -- |

## 8. Numerical examples

1. Laptop bought 2026-10-01, term 2 years: `expires_on` 2028-10-01. On
   2028-09-02 `daysLeft` is 29, status `expiring`, the 30-day reminder fired
   on 2028-09-01. On 2028-10-01 `daysLeft` is 0, status `expiring`, the
   "expires today" reminder fires. On 2028-10-02 status `expired`, nothing
   fires.
2. Term 18 months from 2026-01-31: `addMonths` clamps to the month end,
   `expires_on` 2027-07-31. Term 1 month from 2026-01-31: 2026-02-28.
3. A warranty created on 2026-10-21 with `expires_on` 2026-11-10 (20 days):
   the first tick fires `:30`; 2026-11-03 fires `:7`; 2026-11-10 fires `:0`.
4. `PATCH` moves `expires_on` from 2026-11-10 to 2027-11-10: the old keys
   stay in the table, the new date forms new keys, and the reminders fire
   again in 2027.

## 9. Missing-data policy

- A lifetime warranty has no `daysLeft`; the card says "Lifetime" and no
  reminder is scheduled.
- A warranty whose linked transaction was deleted keeps `transaction_id`
  null; the detail says "No linked transaction" and offers to link one.
- A price without a currency, or a currency without a price, is refused by
  the CHECK and the DTO; the importer reports the row as invalid rather than
  guessing.
- An import row with neither a duration nor an expiration date nor lifetime
  is invalid; the row says which column to fill.
- A delegate with the section but without the account sees the warranty with
  `linkedTransaction: null`; the detail says the transaction is in an
  account they cannot read, not that there is none.
- The attachment store unreachable (503 `ATTACHMENT_STORE_UNREACHABLE`):
  `isStoreUnreachable` copy, as on a transaction.

## 10. Frontend structure

- `frontend/src/lib/warranties.ts`: `warrantiesApi` over `apiClient` with
  `dedupe` on reads and `invalidateCache('warranties:')` on writes;
  `frontend/src/types/warranty.ts`. The `warranties:` prefix is classified
  in `cache-prefix-classification.guard.test.ts`.
- the Warranties page (route /warranties): `ProtectedRoute`, `PageLayout`,
  `PageHeader`, a `SummaryCard` strip from `GET /warranties/summary`, status
  filter pills (`Badge`), a search box, `ListTopToolbar` with Add, Export CSV
  and Import CSV, `WarrantyList.tsx` (`Table.tsx` chrome, `SortableHeader`,
  `useLongPress` rows with `INTERACTIVE_ROW_FOCUS_CLASS`, `RowActions` and
  `RowActionSheet` from one `RowAction[]`, the `PayeeList.tsx` pattern),
  `ListBottomPager`, `EmptyState`, `useFormModal` with `WarrantyForm.tsx`
  loaded through `dynamic()` (`DateInput`, `CurrencyInput` in a `Controller`,
  `CurrencyPickerButton` in an `items-stretch` row, the payee picker the
  transaction form uses, the duration helper, the lifetime switch, the kind
  select, a serial-numbers list, and on a new warranty a Documents block:
  `AttachmentsSection` in its staged mode, uploaded to the warranty once it
  is created, a failed upload named in a toast and never undoing the save),
  `ConfirmDialog` for delete, an Archived
  toggle, `useDensityPreference('warranties')`. `?new=1&transactionId=<id>`
  opens the form prefilled from `transactionsApi.getById`;
  `?transactionId=<id>` filters the list.
- the warranty detail page (route /warranties/[id]): the status card (days
  left, kind, vendor, price, serials, product link), a Documents section
  (`AttachmentsSection` with `{ warrantyId }`, each row carrying a
  `documentKind` picker;
  preview through `AttachmentPreviewDialog`, scanning through
  `ScanDocumentControl`, both parent-agnostic today), a Claims section
  (`WarrantyClaimList.tsx`, `WarrantyClaimForm.tsx`), and the linked
  transaction row linking to `/transactions?targetTransactionId=<id>` (the
  existing flash deep link). A warranties layout wraps the section in
  `DelegateSectionGuard section="warranties"`.
- Register: `TransactionRow` shows
  `WarrantyBadge` (`ShieldCheckIcon`, count) beside `AttachmentBadge` when
  `warrantyCount > 0`, on the phone card and the table alike;
  `TransactionForm` renders `TransactionWarrantiesLine.tsx` beside
  `AttachmentsSection` (fetches only when `warrantyCount > 0`; offers Add
  warranty), hidden on a joint row as attachments are.
- `frontend/src/lib/attachments.ts`: `list(parent)` and `upload(parent, file,
  original?, documentKind?)` over `AttachmentParent = { transactionId } |
  { warrantyId }`; `Attachment` gains `warrantyId: string | null` and
  `documentKind`, and `transactionId` becomes `string | null`; every caller
  updated (`AttachmentsSection`, `useAttachmentBytes`, the tests).
- `WarrantiesExpiringWidget.tsx` in `DASHBOARD_WIDGETS`, `defaultEnabled:
  false`, `WIDGET_ICONS` entry, `titleHref="/warranties"`, up to five rows
  from `GET /warranties?status=expiring&limit=5`, visible to a delegate with
  the section.
- Delegate section on the client: `DelegateAccessModal.tsx` section list and
  `frontend/src/lib/delegation.ts`; `AppHeader.tsx` and `MobileNavDrawer.tsx`
  gain a `toolsSectionByHref` map beside `toolsCapabilityByHref` so a Tools
  link can be gated by a section; `/warranties` in `TOOLS_LINKS` between
  `/rules` and `/email-receipts`, `ShieldCheckIcon` in `NAV_ICONS`.
- `useNotificationCopy.ts` entries for the two types, `notifications.json`,
  `notification-preferences.ts` mirror, `types/notification.ts` unions, the
  default-target switch in `NotificationList.tsx`.
- i18n: a `warranties` namespace in `frontend/src/i18n/messages.ts` and
  `messages/en/warranties.json`; keys in `navigation.json`, `dashboard.json`,
  `settings.json` (shared access and notification preferences),
  `transactions.json` (badge, action sheet, form line); backend `emails.json`,
  `push.json`, `errors.json`.

## 11. Test matrix

| Area | Cases |
|---|---|
| Entity and DTO | exactly one of `expiresOn` / `term` / `isLifetime` (0 and 2 refused); `expiresOn < purchaseDate` refused; price without currency refused; `serialNumbers` over ten or over 100 chars refused; `warrantyKind` outside the enum refused; no `userId` or `currencyCode`-less price accepted |
| Expiry helper | term in years, months, days; month-end clamping (example 2); zero term refused |
| Status (WTY-002) | truth table A, one test per row; `today` from the user's timezone at a day boundary |
| Ownership (WTY-005) | foreign transaction id and foreign payee id are 404 inside the transaction; integration test asserts no row written |
| Attachments (WTY-003) | CHECK refuses zero and two parents; create with a warranty parent stores both halves of a scan pair under it; the cap counts per parent; a linked warranty's document is in the transaction's list (with `warrantyName`), the register count, `has:attachment` and `loadAttachmentPresence`, archived or not, and an unlinked warranty's in none of them; deleting the warranty drops it from the count; a kind change reaches both halves of a scan pair and refuses a transaction's attachment; download by a delegate without the section is refused; delete cascades with the warranty and tombstones the bytes |
| Claims | CRUD under the parent's ownership; a claim on a foreign warranty is 404 |
| Delegation (WTY-007) | truth table C, one test per row; write routes refuse a delegate; the Tools link appears only with the section |
| Reminders (WTY-004) | truth table B; two concurrent ticks produce one row (the two-connection test `docs/verification-contract.md` asks for); a changed `expires_on` re-fires (example 4); archived and lifetime skipped; category `WARRANTIES` resolves in-app on and email per preference |
| Register | `warrantyCount` on a page with and without warranties; `has:warranty` and its `searchInterpretation`; neither the action sheet nor the Copy dropdown offers a warranty action |
| Import (WTY-006) | dry run and commit agree on the same file; comma-separated and JSON serial numbers; `Tags` reported as skipped; unknown currency falls back; a row with no expiry source is invalid; limits refused with a message; the Warracker sample file round-trips through export |
| RLS | both tables land in the direct bucket (`rls-enforcement.integration.spec.ts`) |
| Backup | export and restore round-trip includes warranties, claims and a warranty's attachment with its bytes; `restore-plan.spec.ts` ordering; support-backup golden test with the masking decided |
| Currency references | `currency-references.spec.ts` sees `warranties.currency_code` in both the constant and the SQL function |
| Frontend | page loading / empty / list / filters; form validation; the badge and action-sheet items; the widget renders the server's `status` and `daysLeft` and never compares dates; `nav-links.test.ts`, `section-layouts.test.tsx`, `density-preference.guard.test.ts`, `notification-target` and `notification-preferences` contract tests |
| AI | `list_warranties` on both surfaces returns the same shape; `EXPECTED_TOOL_COUNT` and the byte budget |
| E2E | from a transaction's edit window, add a warranty, upload a receipt, see the badge, find it on the page, archive it; reload and re-assert |

## 12. Explicit v1 scope cuts

- No per-user window or thresholds (decision 3, W1).
- No value-under-warranty total (decision 6, W2).
- No tags, no hideable columns, no Paperless-ngx, no calendar export, no
  photo gallery (decision 14).
- No write tool on the AI surfaces (decision 11).
- No warranty on a split line; the link is to the parent row (decision 5).
- No automatic warranty from an email receipt (W3).
- `document_kind` is not offered on a transaction's attachments (W4).

## 13. Open questions

- **W1.** Should the expiring window and the reminder thresholds be a user
  preference? This document says no in v1: 30 / 7 / 0 fixed, a preference later.
- **W2.** Should the page show a "value under warranty" figure? This document
  says no: it needs `FxAggregate`, the missing-rate policy and a reporting
  currency for an informational number.
- **W3.** Should the email-receipts pipeline offer "create warranty" when a
  receipt email is linked to a transaction? This document says later: the action
  sheet covers the manual path and the receipt is already attached.
- **W4.** Should `document_kind` be offered on a transaction's attachments
  too (receipt against other)? This document says no; it stays `other` there.

## 14. Follow-ups

Every task of the retired task list is built; its S1 (a Discussion agreeing
the design) was never opened because the maintainer approved the design
directly. The four questions of section 13 stand as this document answered
them, each a proposal of its own if it is ever wanted:

- **W1:** a per-user expiring window and reminder thresholds, in place of the
  fixed 30 / 7 / 0 (decision 3).
- **W2:** a "value under warranty" figure on the page, which needs
  `FxAggregate`, the missing-rate policy and a reporting currency
  (decision 6).
- **W3:** "create warranty" offered by the email-receipts pipeline when a
  receipt email is linked to a transaction.
- **W4:** `document_kind` offered on a transaction's own attachments; it
  stays `other` there.
