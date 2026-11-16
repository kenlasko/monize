# Spec: possible duplicates on bank sync and file import

Status: **approved to build.** Scope from issue kenlasko/monize#2233
("Detect duplicate transactions on bank sync/import"), which follows
discussion kenlasko/monize#2169 (a bill entered by hand, or posted from its
schedule, is imported again by bank sync). The maintainer agreed the matching
rule, the four actions, holding back on an unattended sync and the scope
(bank sync, then CSV, QIF and OFX, in one PR) on the issue.

Owner: import. Related: INV-IMPORT-004 (this spec), INV-BANKSYNC-001,
INV-BANKSYNC-004, INV-BALANCE-001, INV-CACHE-001, `docs/specs/bank-sync.md`
sections 7a and 7b, `docs/specs/bank-sync-notifications.md` section 5,
`docs/future-plans/unified-import-preview.md` (this is the first piece of its
"duplicate" outcome that is not a key match).

---

## 1. What this adds

Before an import writes a row, it compares the row with the transactions
already in the destination account. A row that looks like one of them is a
**possible duplicate**: it is not written until the person decides what to do
with it, from a list that shows the incoming row beside the transaction it
looks like, immediately before the final import.

Two sources:

- **Bank sync.** The preview (`docs/specs/bank-sync.md` 7a) gets a
  `possible_duplicate` outcome. An unattended sync (the daily sync, or "Sync
  now" without the preview) holds such rows back and the account then needs
  its preview.
- **CSV, QIF and OFX file imports** into one account
  (`ImportService.importParsedTransactions`). The wizard asks for the possible
  duplicates after the review step and shows them before it imports.

Out of scope: the Microsoft Money import (a whole-database migration into a
fresh setup), the multi-account QIF import (the same, from Quicken), the
investment rows of a brokerage file, and rows repeated inside one file or one
bank answer (two identical coffees on one day are two coffees).

## 2. The matching rule

An incoming row and an existing transaction are a **pair** when:

| Condition | Rule |
|---|---|
| Account | The existing transaction is in the destination account |
| Amount | Exactly equal, sign included, at the storage scale |
| Date | At most `DUPLICATE_WINDOW_DAYS` (3) calendar days apart, either side |
| Existing row | Not VOID, not a split child, not the cash leg of an investment transaction |
| Bank sync only | The existing transaction is not one bank sync wrote or linked (no `bank_sync_imported_transactions` row names it) |
| Payee | Not compared: a bank's text rarely matches a payee typed by hand |

Transfer legs and split parents are compared like any other row: a card
payment entered by hand as a transfer is the common case.

**One to one.** Every candidate pair is ranked by the day difference, then the
incoming row's position, then the existing row's date, then its id; the pairs
are taken in that order and a pair whose incoming row or existing transaction
is already taken is dropped. An existing transaction is therefore the
possible duplicate of at most one incoming row, and an incoming row has at
most one. `matchPossibleDuplicates` (`backend/src/import-preview/possible-duplicates.ts`)
is the one implementation; the preview, the bank sync write and the file
import all call it over rows read by `loadDuplicateCandidates` in the same
file.

The window is fixed (not a setting) in this release.

**Which incoming rows are compared.**

- Bank sync: a planned row whose key the ledger does not hold (a `new` row).
  A row the ledger holds is a `duplicate` or an exception, as before.
- File import: every row of a non-investment file, except a transfer row or a
  loan payment (a non-split row whose category is mapped to a loan; the
  existing `isRecordedTransfer` check owns those), a void row, and a row whose
  OFX FITID the account already holds on a row of the same date and amount (it
  is skipped as `alreadyImported`, as before). The transaction holding such a
  FITID stands for the skipped row, so it pairs with no other row of the
  file.

## 3. The actions

The list shows, per pair, the incoming row (date, amount, payee text,
description, reference) beside the existing transaction (date, amount, payee,
category, description, reference, status, transfer account). Per pair, the
person picks one:

| Action | Ledger (bank sync) | Existing transaction | Incoming row |
|---|---|---|---|
| **Leave for later** (bank sync default) | nothing | unchanged | not written; offered again |
| **Import anyway** | key claimed for the new row | unchanged | written as new |
| **Merge** | key claimed for the existing row | takes the incoming date, the incoming reference (when it has one) and status Cleared; a file import also stores the row's FITID when the existing row has none, no other row holds it and the merge moves the date (recognition needs the file's date) | not written |
| **Keep mine** (file import default) | key claimed for the existing row | unchanged | not written |
| **Delete mine and import** | key claimed for the new row | deleted through `TransactionsService.remove`, with no history entry (`recordHistory: false`; neither import records one per row) and its recomputes deferred to after the commit | written as new |
| **Add to the exceptions** (bank sync) | exception, as today | unchanged | never imported |

Merge keeps the existing row's payee, category, splits, tags, memo and
attachments: it is the "match and merge" of discussion #2169.

**What each action is offered for.** Merge and delete-and-import are not
offered, and are refused (400) when named, for a Reconciled existing row (its
statement is closed; "Keep mine" is the answer). Delete-and-import is not
offered for a transfer leg or a split parent: deleting it removes the other
account's leg, or a split's transfer legs in other accounts, too. A bank sync
deletes only once it has claimed the bank row's key, so a key a concurrent
sync claimed first deletes nothing.
Merge does not move the date of a transfer leg or of a split parent (the
other legs keep theirs); it still takes the reference and the status.

A file has no "later": an undecided pair is kept (the incoming row is
skipped and listed among the skipped rows as `possibleDuplicate`).

## 4. Bank sync

**Preview.** A `new` row that pairs with an existing transaction is reported
with `outcome: "possible_duplicate"`, `existingTransaction` (section 3's
fields) and `duplicateActions` (the actions section 3 allows for it). It is
resolved like a `new` row (payee, category, rules), since "Import anyway"
writes it so. The summary counts it in `possibleDuplicate`, not in `new`, and
`balanceAfter` leaves it out: by default nothing is written for it.

**Fingerprint.** `planFingerprint` covers, in addition, the pairs as
`[key, existing transaction id]` sorted by key, so a pair that changed between
the preview and the commit (a transaction entered by hand in another tab) is a
changed plan (409). With no pair, the fingerprint is what it was.

**Sync body.** `{ planFingerprint, importKeys, excludeKeys, mergeKeys,
keepKeys, replaceKeys }`. The five lists are disjoint (400). `importKeys` and
`excludeKeys` may name a possible duplicate (import anyway, add to the
exceptions). `mergeKeys`, `keepKeys` and `replaceKeys` must each name a
possible duplicate of the plan the write makes under the lock, need
`planFingerprint` (400 without it) and are checked against section 3's
allowed actions (400). Every check runs before the first write.

**What a write does with a possible duplicate it has no decision for.** It is
held: not written, and `bank_sync_accounts.held_duplicate_count` records how
many were held by this write (0 when none). `last_success_at` does not move
when anything is held, so the rows stay inside the next window (7b, "the
window after a partial import").

**Needs its preview.** `bankAccountNeedsPreview` is also true while
`held_duplicate_count > 0`: "Sync now" opens the preview, and the daily sync
and the sync-all route skip the account (INV-BANKSYNC-004's predicate, one
definition). The count goes back to 0 with the next write that holds nothing.

**The result** of a sync adds `merged`, `kept`, `replaced` and
`heldDuplicates`.

**Notification.** A daily sync that held possible duplicates in a connection
writes `BANK_SYNC_DUPLICATES_HELD` (category `BANK_SYNC`, severity warning,
`data = { connectionId, institutionName, held, accounts }`, target
`/settings/bank-sync`, dedupe key `bsc:dup:<connection id>:<UTC date>`), apart
from the success notice and whatever its mode. A sync the person starts says
it in its toast.

**Merge and delete in the write transaction.** Both run inside the one write
transaction of `BankSyncWriterService.write`, under its link and account
locks (accounts before transactions, `docs/concurrency-and-idempotency.md`
section 5). The ledger row is claimed first, `ON CONFLICT DO NOTHING`, exactly
as for an import: a key a concurrent sync claimed is skipped. The balance is
recalculated from the ledger when anything was written, merged or deleted,
and the net-worth recompute is dispatched after the commit (INV-CACHE-001).

## 5. File import

**Check.** `POST /import/qif/duplicates`, `POST /import/ofx/duplicates` and
`POST /import/csv/duplicates` take the body of the matching import, parse the
file the same way and write nothing. The answer lists the pairs:
`{ accountId, currencyCode, rows: [{ row, transactionDate, amount, payee,
memo, referenceNumber, existingTransaction, duplicateActions }] }`, where
`row` is the row's position in the parsed file.

**Import.** The import body gains `duplicateDecisions: [{ row, transactionId,
action }]` (`action` one of `import`, `merge`, `keep`, `replace`; at most
`MAX_DUPLICATE_DECISIONS`). Inside the import's transaction, before the first
write, the import re-reads the candidates and re-pairs the rows through the
same functions. A decision whose `(row, transactionId)` is not a pair now, or
whose action section 3 does not allow, refuses the whole import (409, nothing
written; "check again"). A pair without a decision is kept (section 3).

The wizard asks for the pairs when the person presses Import on the review
step. When there are none it imports at once; otherwise it shows the list
(every pair "Keep mine" until changed) and imports from there. A bulk CSV
import checks every file first and shows one list grouped by file; a pair
that only appears because an earlier file of the same run was imported has
no decision and is kept. A later file whose pair changed because an earlier
file of the same run was imported (both chose to replace one transaction,
say) is refused with nothing written for it and reported among the per-file
results; importing that file again lists its pairs afresh.

## 6. Invariants

**INV-IMPORT-004, a possible duplicate is never written without the person's
decision.** Mechanism: the write paths (`BankSyncWriterService.write`,
`ImportService.importParsedTransactions`) pair the rows inside their write
transaction through `matchPossibleDuplicates` and write a paired row only for
"import anyway" or "delete mine and import"; a decision about a pair that is
not the one shown is refused before the first write (the fingerprint for bank
sync, the re-pairing for a file).

P1 to P3 of `docs/future-plans/unified-import-preview.md` hold for the new
lists: the commit pairs through the same functions as the preview, a key is
claimed at most once, and a rejected selection writes nothing.

## 7. Missing-data policy

- An existing row whose payee, category or transfer account has no name
  shows that field as empty, not as "unknown payee".
- An incoming bank row with an unreadable amount or date is never planned, so
  it is never compared.
- A failed duplicate check in the wizard is an error with a retry, never an
  empty list: an empty list would import every row.

## 8. Test matrix

| Case | Kind |
|---|---|
| Same amount, dates 0 to 3 days apart pair; 4 days, or a cent off, or the other sign, do not | unit, `possible-duplicates.spec.ts` |
| Two incoming rows and one existing row: the closer date pairs, the other is new; ties by position | unit |
| Bank sync preview: a possible duplicate row carries the existing row and its allowed actions, and is left out of `new` and `balanceAfter` | unit, `bank-sync-preview.service.spec.ts` |
| Fingerprint: unchanged with no pair; changes when a pair's existing id changes | unit, `bank-sync-plan-fingerprint.spec.ts` |
| Write without a selection holds the pair, imports the rest, records `held_duplicate_count`, does not move `last_success_at` | unit, `bank-sync-writer.service.spec.ts` |
| Write with merge, keep, replace, import anyway: ledger, existing row and new row as section 3 says | unit |
| merge/keep/replace without a fingerprint, or naming a row that is not a pair, or merge on a Reconciled row: 400 before any write | unit |
| `bankAccountNeedsPreview` while `held_duplicate_count > 0` | unit, `bank-sync-views.spec.ts` |
| Daily sync that held writes `BANK_SYNC_DUPLICATES_HELD` once per connection and day | unit, `bank-sync-outcome-notifier.service.spec.ts` |
| File import: no decision keeps the row; a decision about a stale pair refuses with nothing written; merge and replace | unit, `import.service.spec.ts` |
| Wizard: no pair imports at once; pairs show the list; the decisions reach the import | unit, `useImportWizard` and step tests |
