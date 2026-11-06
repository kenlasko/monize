# Trash for deleted transactions

Design for a durable, searchable record of every transaction a user deletes,
with per-entry restore, independent of the undo stack. Answers issue #777.
The task list is [`transaction-trash-tasks.md`](./transaction-trash-tasks.md).

Status: **proposal**. It needs its own discussion with the `approved-to-build`
label before any task starts (`CONTRIBUTING.md`). A restore moves a balance
and may rebuild a holding, so sections 4 to 8 are the specification
`docs/financial-calculation-contract.md` section 9 asks for.

## 1. Where this comes from, and what is actually true today

Issue #777 asks for either an audit of deletions or a recoverable trash, and
claims the deleted row already sits in `action_history.before_data`. Reading
the code (2026-09-30) narrows that claim:

- Only a single, non-transfer delete through `TransactionsService.remove`
  records a `before_data` snapshot. `TransactionTransferService.removeTransfer`
  and `TransactionBulkUpdateService.bulkDelete` record nothing, so
  `undoTransferDelete` and `undoBulkDelete` in `ActionHistoryService` are
  unreachable for deletes today.
- The snapshot (`TransactionsService.snapshotTransaction`) is lossy: no
  `originalAmount` / `originalCurrencyCode`, no split `kind`, no split tags,
  no attachments.
- `action_history` keeps 100 rows per user for 30 days
  (`MAX_HISTORY_PER_USER`, `MAX_HISTORY_AGE_DAYS`), is recorded best-effort
  after the commit, and is excluded from backups.
- Attachment bytes are swept within the hour after the cascade
  (`attachment_blob_tombstones`, `AttachmentOrphanSweeperService`); no undo
  can bring them back.

So the audit view the issue calls "largely a read over existing data" is not
one. This plan gives deletions their own table, written inside the deleting
transaction, complete enough to restore from, kept for a configurable
retention, and backed up.

## 2. What exists, and what this composes

| Need | Existing piece | Notes |
|---|---|---|
| The one delete path per shape | `TransactionsService.remove`, `removeAny`, `removeSplit`; `TransactionTransferService.removeTransfer`, `removeCrossOwnerTransfer`; `TransactionBulkUpdateService.bulkDelete`; `InvestmentTransactionsService.deleteCashTransactionInTransaction` | Each gains one call to the trash writer inside its transaction (section 6.2). |
| The ledger effect of a deletion | `deletionBalanceEffect` (`backend/src/common/deletion-balance.util.ts`) | Its exact inverse, `restorationBalanceEffect`, lands in the same file. |
| Reconciled lock | `assertReconciledRowsMutable` (`backend/src/transactions/reconciled-lock.util.ts`), `reconciled-lock.guard.spec.ts` | INV-RECONCILE-001. A restore of a RECONCILED row consults it (decision 7). |
| Holdings replay | `HoldingsService.rebuildScopesFromTransactions` | INV-HOLDING-001: a restored embedded investment split rebuilds in the same transaction. |
| Cache invalidation | `NetWorthService.triggerDebouncedRecalc` | INV-CACHE-001, after the commit. |
| Rules on creation | the rule applier's exemption list (`docs/future-plans/transaction-rules-tasks.md`, the undo entry) | A restore is not a creation; it joins the undo exemption (decision 8). |
| Transfer legs | `docs/financial-semantics.md` sections 1-2; INV-TRANSFER-001 | One deletion event covers both legs; one restore returns both. |
| Attachments | `transaction_attachments`, `attachment_blob_tombstones`, `AttachmentOrphanSweeperService` (`backend/src/attachments/attachment-orphan-sweeper.service.ts`) | INV-ATTACHMENT-001. Phase 2 holds bytes while the entry exists. |
| Deep link to a row | `/transactions?targetTransactionId=<id>` (issue #776) | A restored entry links to its row. |
| A paginated table with row actions | `frontend/src/app/institutions/page.tsx`, `frontend/src/components/institutions/InstitutionList.tsx`, `Pagination` | The Trash page copies the shape. |
| Tools menu | `TOOLS_LINKS`, `NAV_ICONS` (`frontend/src/lib/nav-links.ts`) | Hidden from delegates by default. |
| Daily cleanup cron pattern | `ActionHistoryService.cleanupExpiredHistory` (`0 3 * * *`) | The purge copies it, with a claim. |

## 3. Product decisions

1. **A tombstone table, not a soft-delete flag.** A `deleted_at` column on
   `transactions` would touch every predicate in the system (the register,
   `LEDGER_MOVEMENT_PREDICATE`, every report, the exports, the RLS policies)
   and would carry trashed rows into backups as live rows. A separate table
   leaves every existing query untouched: the deploy is neutral for everyone
   who never opens the Trash.
2. **One deletion event, one entry.** Deleting a transfer deletes two legs;
   deleting a split parent deletes its lines and their legs; a bulk delete
   deletes many. Each *event* is one `transaction_trash` row holding every
   row it removed, so a restore returns exactly what one action removed
   (INV-TRANSFER-001: both legs, one decision). A bulk delete of N
   independent rows writes N entries, one per row (or per transfer pair), so
   a user can restore one of them.
3. **The entry is written inside the deleting transaction.** Not best-effort
   and not after the commit, unlike `action_history`. A delete that cannot
   write its entry does not happen. This is what makes "every deletion is
   recorded" true (TRASH-001).
4. **The snapshot is complete.** Every column of the `transactions` row, every
   split with its `kind` and tags, the parent's tags, and the attachment
   metadata (id, filename, size, storage provider, storage key). It is the
   row as stored, not `snapshotTransaction`'s lossy shape.
5. **Restore re-inserts the original ids.** A restored row has the id it had,
   so deep links, rule-application history already lost to the cascade
   notwithstanding, and the user's memory of it hold. Collision is impossible
   because the id was freed by the delete and a second restore is refused
   (TRASH-003).
6. **Restore is the exact inverse of the delete, through the inverse helper.**
   `restorationBalanceEffect(row)` returns `+amount` for a row
   `deletionBalanceEffect` would have reversed and `0` for a VOID row; the
   balance update is the atomic `UPDATE accounts SET current_balance =
   current_balance + $1`. A restored embedded investment split calls
   `rebuildScopesFromTransactions` in the same transaction.
7. **A RECONCILED row restores only when the lock allows it.** The delete
   passed `assertReconciledRowsMutable`, so either the lock was off or the row
   was not reconciled. On restore the same check runs against the snapshot's
   status: with the strict lock on and a RECONCILED row in the entry, the
   restore is refused and the message names the setting.
8. **A restore is not a creation.** Transaction rules do not run on it
   (INV-RULE-002 is about creation paths; a restore returns a prior state), it
   is exempt the way undo is, and it writes an `action_history` row of action
   `create` described as "restored", so the existing undo can delete it again.
9. **Three entry kinds, two restorable.** `kind = 'deletion'` (register,
   bulk, MCP, AI, transfer): restorable. `kind = 'consequence'`: a cash leg
   removed because its investment transaction was deleted, or a transfer leg
   removed because a split line was edited away; recorded for the audit,
   not restorable on its own (the message says what to restore instead: the
   investment transaction's own undo, or the parent row). `kind = 'cross_owner'`:
   a leg of a cross-owner transfer, recorded under its own owner, not
   restorable in v1 (section 12).
10. **Internal deletes are not deletions.** The import placeholder cleanup,
    `cleanupMergedSplitTransfers`, data reset, backup restore, the demo reset
    and account deletion (which refuses while rows exist) write no entry; data
    reset and backup restore wipe the trash along with the rows.
11. **Retention is per user, bounded by the deployment.** `user_preferences.
    trash_retention_days` (default 90, 0 = keep until emptied), capped by
    `TRASH_MAX_RETENTION_DAYS` (env, default 365; 0 = no cap) so a hosted
    deployment can bound growth (comment 2 on the issue). A daily purge
    deletes expired entries. "Empty trash" and per-entry "Delete permanently"
    exist and confirm.
12. **Who deleted is recorded.** `actor_user_id` (the delegate when one
    acted, INV-ACTIVITY-001) and `deleted_via` (`register`, `bulk`, `mcp`,
    `ai`, `transfer`, `split_edit`, `investment`).
13. **The trash is backed up.** It is user data the user chose to keep.
    Exported, restored, and wiped by the restore before re-insert like every
    other owned table.
14. **The Action History panel is unchanged.** It stays the short undo/redo
    log. Comment 1's deep links from history entries are a separate nicety.

## 4. Definitions

- *Deletion event*: one user action that removed one or more `transactions`
  rows together.
- *Entry*: one `transaction_trash` row for one deletion event.
- *Primary row*: the row the user acted on (the register row, the source leg
  of a transfer, the split parent). Its fields are denormalised onto the entry
  for listing and filtering; every other removed row lives only in the
  snapshot.
- *Restorable*: `kind = 'deletion' AND restored_at IS NULL AND purged_at IS
  NULL` and every account the snapshot names still exists.

## 5. Invariants

| ID | Statement | Mechanism |
|---|---|---|
| TRASH-001 | Every user-initiated deletion of a `transactions` row writes its entry in the deleting transaction | `TransactionTrashWriter.record(manager, ...)` takes the ambient `EntityManager`; a source-scanning guard (`transaction-trash.guard.spec.ts`) fails any `m.delete(Transaction` / `DELETE FROM transactions` in the listed delete sites that is not preceded by `record` in the same function, the `reconciled-lock.guard.spec.ts` pattern. |
| TRASH-002 | A restore moves each account by exactly what the delete reversed | `restorationBalanceEffect` is defined in `deletion-balance.util.ts` as the inverse of `deletionBalanceEffect` and the spec asserts `restoration(row) + deletion(row) === 0` over the row matrix (every status, past and future dates). |
| TRASH-003 | An entry is restored at most once | `UPDATE transaction_trash SET restored_at = NOW() WHERE id = $1 AND restored_at IS NULL AND purged_at IS NULL RETURNING id` is the first statement of the restore transaction; no row returned, no insert. |
| TRASH-004 | The trash changes nothing a delete does for the user | The delete's balance arithmetic, locks and cascades are untouched; the only addition is the insert. The delete suites assert identical balances before and after this feature. |
| TRASH-005 | A purge deletes trash rows only | The purge statement names `transaction_trash` and nothing else; a guard asserts the purge service imports no other repository. |
| TRASH-006 | A restore refuses before writing | Ownership (RLS plus the `user_id` predicate), the restorability predicate, the reconciled lock, and the existence of every account named by the snapshot are checked inside the restore transaction before the first insert. |
| TRASH-007 | A restore rebuilds derived state | A restored embedded investment split calls `rebuildScopesFromTransactions` in the same transaction (INV-HOLDING-001); every moved account is passed to `triggerDebouncedRecalc` after the commit (INV-CACHE-001). |

## 6. Data contracts (new and changed)

### 6.1 Table `transaction_trash`

```sql
CREATE TABLE IF NOT EXISTS transaction_trash (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('deletion','consequence','cross_owner')),
  deleted_via VARCHAR(20) NOT NULL,
  -- denormalised primary row, for the list and its filters
  primary_transaction_id UUID NOT NULL,
  account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  account_name VARCHAR(255) NOT NULL,
  transaction_date DATE NOT NULL,
  amount NUMERIC(24,8) NOT NULL,
  currency_code VARCHAR(3) NOT NULL,
  payee_name VARCHAR(255),
  category_name VARCHAR(255),
  description VARCHAR(1000),
  status VARCHAR(20) NOT NULL,
  is_transfer BOOLEAN NOT NULL DEFAULT FALSE,
  row_count INTEGER NOT NULL CHECK (row_count >= 1),
  -- the complete snapshot (decision 4)
  snapshot JSONB NOT NULL,
  snapshot_version SMALLINT NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  restored_at TIMESTAMPTZ,
  purged_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_transaction_trash_user_deleted ON transaction_trash (user_id, deleted_at DESC) WHERE purged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_transaction_trash_user_account ON transaction_trash (user_id, account_id);
```

Direct RLS bucket (`user_id`), policy and enable in the same migration.
`account_id ON DELETE SET NULL` keeps the audit when an account goes;
`account_name` is the audit's copy. The `currency_code` has no FK so a
removed currency does not block the audit (INV-CURRENCY-001 governs shared
currency deletion elsewhere). Backup: exported, `RESTORE_PLAN` after
`accounts` and `users`, wiped by the restore. Support backup: `payee_name`,
`category_name`, `description`, `account_name` masked, `snapshot` dropped
(`const` is not needed because the column is restored from the export, not
the support backup; the support-backup rules spec confirms a `drop` is
acceptable for a NOT NULL JSONB only when the section is also dropped --
decide in B1 and record it in the rules file).

`user_preferences.trash_retention_days INTEGER NOT NULL DEFAULT 90 CHECK
(trash_retention_days >= 0)`; the env var `TRASH_MAX_RETENTION_DAYS` through
`resolvePositiveInt` in the env table, documented in `.env.example`.

### 6.2 The writer

`TransactionTrashWriter.record(manager: EntityManager, input: { userId;
actorUserId; kind; deletedVia; rows: TrashedRow[]; primaryId })` builds the
snapshot from the locked rows the delete already holds (it does not re-read:
the delete sites lock rows before removing them, and pass those rows). The
snapshot shape is `snapshot_version` 1:

```ts
interface TrashSnapshotV1 {
  transactions: Array<Record<string, unknown>>;   // every column of each removed row, snake_case as stored
  splits: Array<Record<string, unknown> & { tagIds: string[] }>;
  tagIds: Record<string, string[]>;               // transactionId -> tag ids
  attachments: Array<{ id; transactionId; filename; sizeBytes; contentType; storageProvider; storageKey; originalOfAttachmentId }>;
  investmentLinks: Array<{ investmentTransactionId; transactionId | null; transactionSplitId | null }>;
}
```

Call sites (each inside its existing `withScopedDb`, after the locks, before
the first delete): `TransactionsService.remove` (one entry; `removeParentTransaction`
folds the parent and sibling legs into the same entry), `TransactionsService.removeSplit`
(`consequence`, `split_edit`, the removed leg only), `TransactionTransferService.removeTransfer`
and `removeTransferFromSplitInTransaction` (one entry, both legs),
`removeCrossOwnerTransfer` (one `cross_owner` entry per owner, the counterpart's
under `withSystemContext` that the method already holds),
`TransactionBulkUpdateService.bulkDelete` (one entry per independent row or
transfer pair; the parent-plus-legs grouping the method already computes),
`InvestmentTransactionsService.deleteCashTransactionInTransaction` and
`removeAll` (`consequence`, `investment`). `deleted_via` comes from the
caller: the controller passes `register` or `bulk`, the MCP tool `mcp`, the
AI action `ai`; `removeAny` takes it as a parameter.

### 6.3 Endpoints

- `GET /transaction-trash?page&limit&accountId&from&to&search&kind` -- the
  list, newest first, `purged_at IS NULL`; the search is `ILike` over payee,
  description and category names; `limit` bounded 1..100.
- `GET /transaction-trash/:id` -- the entry with its snapshot rendered as
  rows for the detail drawer (never the raw snapshot: the response is an
  allowlist).
- `POST /transaction-trash/:id/restore` -- section 6.4; returns the restored
  primary id and the accounts moved.
- `DELETE /transaction-trash/:id` -- purge one (sets `purged_at` and deletes
  the snapshot's attachment bytes in phase 2).
- `POST /transaction-trash/empty` -- purge all; takes `{ olderThanDays? }`.
- `PATCH /users/preferences` gains `trashRetentionDays`.

Owner-only in v1; no `@AllowDelegate()`.

### 6.4 Restore, in order, in one `withScopedDb`

1. The conditional `UPDATE ... RETURNING` (TRASH-003). No row: 409 "already
   restored" or 404 "purged".
2. Load the snapshot; refuse (and the transaction rolls back the update)
   when `kind !== 'deletion'`, when any `account_id` in the snapshot no
   longer exists (the message names the account), or when the reconciled
   lock refuses a RECONCILED row (decision 7).
3. Lock the affected accounts in ascending id order (the lock order
   `docs/concurrency-and-idempotency.md` prescribes).
4. Insert the `transactions` rows with their original ids and timestamps
   (parents before legs, so `linked_transaction_id` resolves; the insert
   skips the rule applier like undo), the splits, the tags, the split tags,
   and the investment links (`UPDATE investment_transactions SET
   transaction_id = $1 WHERE id = $2 AND transaction_id IS NULL`).
5. Per account, `UPDATE accounts SET current_balance = current_balance + $1`
   with the sum of `restorationBalanceEffect` over its rows (TRASH-002).
6. `rebuildScopesFromTransactions` for any account/security the embedded
   investment splits touch (TRASH-007).
7. Record the `action_history` row (`create`, "restored").
8. After commit: `triggerDebouncedRecalc` per moved account.

A category or payee named by the snapshot that no longer exists: the row is
restored with `category_id` / `payee_id` null and the payee name kept in
`payee_name`; the response lists what was dropped and the UI says so.

### 6.5 Purge cron

`TransactionTrashPurgeService.purgeExpired` at `30 3 * * *`: `withSystemContext`
lists users with a non-zero effective retention, then per user
`claimOnce(JobClaimType.TrashPurge, userId, <YYYY-MM-DD>)` and
`UPDATE transaction_trash SET purged_at = NOW() WHERE user_id = $1 AND
purged_at IS NULL AND deleted_at < NOW() - make_interval(days => $2)`. Rows
with `purged_at` older than 7 days are deleted by the same tick (the gap lets
a support backup still show "purged on"). The effective retention is
`min(user, TRASH_MAX_RETENTION_DAYS)` with 0 meaning unbounded on either
side.

## 7. Truth tables

### A. Ledger movement of a restored row (TRASH-002)

| status | date vs today | `deletionBalanceEffect` | `restorationBalanceEffect` |
|---|---|---|---|
| UNRECONCILED / CLEARED / RECONCILED | any | `-amount` | `+amount` |
| VOID | any | 0 | 0 |

(`deletionBalanceEffect` already decides inclusion per row; future-dated rows
follow whatever it returns today, and the inverse mirrors it. The bulk delete
hand-rolls this decision; B2 switches it to the helper, which is the fix the
AGENTS.md rule asks for.)

### B. Restorability

| kind | restored_at | purged_at | accounts exist | lock refuses | result |
|---|---|---|---|---|---|
| deletion | null | null | yes | no | restored |
| deletion | null | null | yes | yes | 409, names the setting |
| deletion | null | null | no | any | 409, names the account |
| deletion | set | null | any | any | 409 "already restored", links the row |
| any | any | set | any | any | 404 |
| consequence | null | null | any | any | 409, names what to restore instead |
| cross_owner | null | null | any | any | 409, v1 scope cut |

## 8. Numerical examples

1. Chequing balance 1,000.00; delete a CLEARED -50.00 row: balance 1,050.00.
   Restore: `+(-50.00)` = -50.00 applied, balance 1,000.00.
2. Delete a transfer: chequing -200.00 (source), savings +200.00
   (destination); balances 1,200.00 / 4,800.00 after the delete. One entry,
   `row_count` 2. Restore: chequing 1,000.00, savings 5,000.00.
3. Delete a VOID row of -75.00: no balance moves; restore moves nothing;
   the row returns with status VOID.
4. Bulk delete of 3 rows and 1 transfer pair: 4 entries. Restoring one entry
   moves one account by that row's amount and leaves the other three entries
   restorable.

## 9. Missing-data policy

- A snapshot naming an account that no longer exists: not restorable; the
  entry stays in the audit with the account's name.
- A missing category or payee: restored with null and reported (section 6.4).
- Attachments in v1: listed in the detail drawer as "not recoverable"; the
  delete confirmation already warns when the row has attachments (count), a
  line added in F3. Phase 2 (section 12) keeps the bytes.
- A snapshot of a version this build does not know (`snapshot_version` >
  current): listed, not restorable, "created by a newer version".

## 10. Frontend structure

- the Trash page (new, under the app router at route /trash): the Tools > Trash page; filters
  (account, deleted between, search, kind), `Th`/`Td` table with density,
  `Pagination`, per-row Restore and Delete permanently (both through
  `ConfirmDialog`), an Empty trash button, a retention control that writes
  `trashRetentionDays` and shows the deployment cap when it binds.
- `frontend/src/components/trash/TrashEntryDrawer.tsx`: the rows in the entry
  (legs, splits with tags, attachments marked not recoverable), who deleted
  it and how, a Restore button; after a restore, a link to
  `/transactions?targetTransactionId=<id>`.
- `frontend/src/lib/transaction-trash.ts`: `transactionTrashApi`; restore
  calls `invalidateBalanceCaches` like `transactionsApi.delete` does.
- `trash` i18n namespace; `/trash` in `TOOLS_LINKS` with an icon.
- The delete confirmations (`TransactionList`, the bulk banner,
  `TransactionActionSheet`) gain one line: "Moved to Trash for N days" (or
  "until you empty it").

## 11. Test matrix

| Area | Cases |
|---|---|
| TRASH-001 guard | every listed delete site precedes its delete with `record`; a fixture without it fails |
| Writer | snapshot completeness: every column of a row with original amount and currency, split kinds, split tags, parent tags, attachments, investment links; `row_count`; `deleted_via` per caller (register, bulk, mcp, ai, transfer, split_edit, investment); `actor_user_id` for a delegate |
| TRASH-002 | `restoration + deletion === 0` over every status and date; the bulk path moved onto `deletionBalanceEffect` yields identical balances to before (TRASH-004 regression) |
| TRASH-003 | two concurrent restores of one entry on two connections: one insert (the two-connection test `docs/verification-contract.md` requires) |
| Restore | single row; transfer pair; split parent with legs and tags; embedded investment split rebuilds the holding (INV-HOLDING-001); VOID row moves nothing; RECONCILED row with the lock on refused and off restored; missing account refused with the name; missing category restored with null and reported; a `consequence` entry refused with the pointer; a restored row is not re-ruled (INV-RULE-002 exemption); `action_history` row written and undo deletes it again |
| Purge | expired by user retention; capped by the env; 0 on either side; claim once per user per day across two ticks; `purged_at` rows deleted after 7 days; TRASH-005 guard |
| RLS | direct bucket; a user cannot read or restore another's entry |
| Backup | export and restore round-trip carries entries and their snapshots; `runOwnedDataDeletes` wipes them; the support-backup golden test |
| Frontend | list, filters, pagination; restore success and each 409 message; empty trash confirm; retention control with the cap; delete confirmations show the retention line |
| E2E | delete a row, find it in Trash, restore it, see it in the register with its balance; bulk delete three, restore one |

## 12. Explicit v1 scope cuts and phase 2

- **Cross-owner transfer legs are recorded, not restored** (`kind =
  'cross_owner'`). Restoring one leg needs the counterpart owner's consent
  model from `docs/specs/cross-owner-transfers.md`; a follow-up.
- **Attachment bytes are not kept in v1.** Phase 2: `transaction_attachments`
  gains a nullable `trash_entry_id`; the delete re-points the rows to the
  entry instead of letting the cascade drop them (an `UPDATE` before the
  `DELETE`, so no tombstone is written); the restore re-points them back;
  the purge deletes the rows, which writes the tombstones the sweeper
  already honours. INV-ATTACHMENT-001 holds throughout because the rows
  always reference committed bytes. Its own spec amendment and task list.
- **No "rewind to date"** (comment 2): restoring many entries in reverse
  order is the user's loop over per-entry restore; a bulk restore by filter
  is a follow-up once the per-entry path has shipped.
- **No admin view of trash size** in v1; the cap is the admin's control.
- **Deep links from Action History entries** (comment 1) are a separate
  change.

## 13. Open questions

- **T1.** Default retention 90 days, or unbounded (0) as comment 2 asks? This
  plan says 90 with the control visible on the Trash page; a self-hoster who
  wants forever sets 0 once.
- **T2.** Should a restore re-run transaction rules? This plan says no
  (decision 8); the row returns exactly as it was.
- **T3.** Should `deleted_via = 'ai'` and `'mcp'` deletions be restorable
  through the same AI surfaces (a `restore_transaction` tool)? Not in v1; the
  Trash page is the one restore surface.

## 14. Companion task list

[`transaction-trash-tasks.md`](./transaction-trash-tasks.md).
