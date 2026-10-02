# Unified import preview

Plan for one preview model, one preview builder and one preview table shared
by every import source: bank sync, CSV, QIF, OFX and Microsoft Money (MNY).
The task list is [`unified-import-preview-tasks.md`](./unified-import-preview-tasks.md).

Status: **proposal**. It is not approved. The discussion that carries it must
get the `approved-to-build` label before any task starts (`CONTRIBUTING.md`).

## 1. Goal

- Before any import writes a row, the user sees what it will do, row by row:
  new, duplicate, refused (with the reason), excluded, before the cut-off.
- The user sees, per row, which payee the text maps to and how (exact name,
  alias, new payee, rule), and what each import rule will change.
- The user chooses which rows to import, skips the rest for now or adds them
  to the exceptions so no later import brings them back.
- What is written is what was shown: the commit recomputes the plan through
  the same code and refuses a changed plan.

The same behaviour for every source, so a user who learns it once knows it
everywhere, and a fix lands once.

## 2. What exists today

| Source | Preview before write | Duplicate detection | Rule effects shown | Row selection |
|---|---|---|---|---|
| Bank sync (`docs/specs/bank-sync.md` 7a, 7b) | full, with plan fingerprint | ledger `(account_id, external_key)` | per row, with traces | per row, skip or exception |
| CSV, QIF, OFX (`backend/src/import/`) | parse step and column mapping (`*/parse` routes) | none for ordinary rows; only duplicate transfers (`isDuplicateTransfer`) | none (transaction rules X4, deferred) | none |
| MNY (`backend/src/import/mny/`) | review step (`MnyReviewStep`) with warnings | none: a second run duplicates (`import-job.entity.ts` comment) | none | whole accounts, one session |

`docs/future-plans/csv-source-profiles.md` already asks CSV for the duplicate
key (P3), "preview equals commit" by fingerprint (P6) and rule effects in the
preview (rules X4). Bank sync is the first implementation of those ideas.

## 3. The shared model

```text
ImportPreviewRow
  key            the row's duplicate key (source-specific function, section 4)
  outcome        new | duplicate | refused(reason) | excluded | pending | before_cutoff
  date, amount, currencyCode, payeeText, description, referenceNumber
  payee          { original, name, via: name | alias | new | rule | none, aliasPattern, payeeId }
  category, tags what payee defaults and the import rules give
  rules          [{ ruleId, ruleName, changes {field: {before, after}}, applied, skipped, stopped }]
  structural     source-specific extras, shown but not shared (transfer, split, operation type)

ImportPreviewSummary
  counts per outcome, balance now, balance after (scaled integers),
  external balance and difference when the source reports one
  planFingerprint  SHA-256 over the new rows' keys and amounts, in key order

ImportCommitRequest
  planFingerprint, importKeys, excludeKeys
```

## 4. What stays per source

- **Reading** the rows (file parser, provider adapter, MNY reader).
- **The duplicate key.** Bank sync: the provider's entry reference or the
  content hash (`bank-transaction-planner.ts`). CSV: the bank's reference
  column or a hash of chosen columns (csv-source-profiles C2). QIF/OFX: FITID
  where present (today the OFX parser drops it), else a content hash. MNY: the
  Money row id within one file, which only protects a re-run of the same file.
- **Structural rows**: transfers, splits, investment actions, loan rows. The
  preview shows them; their own processors still write them (INV-TRANSFER-001).

## 5. What becomes shared

**Backend**, a source-neutral `import-preview` module:

1. `buildImportPreview(m, userId, account, rows, options)`: reads the
   ledger or exception keys for the account, resolves payees with the
   report of how (one function, used by preview and writer), loads the
   `import` rules once and runs `planForRow` per row, keeps each trace.
2. `planFingerprint(rows)`: the one fingerprint function.
3. `checkCommitSelection(plan, request)`: fingerprint equality, keys
   within the plan's new rows, imports and exceptions disjoint.
4. **Exceptions.** A per-account exception table generalizing bank sync's
   `bank_sync_imported_transactions.excluded_at`: `(account_id, source, key)`,
   so an excluded CSV row is excluded on the next CSV import of the same
   account. Whether bank sync moves its exceptions there or keeps its ledger
   is decision D1.

**Frontend**, `components/import-preview/` (BS20 already places the payee cell,
the rule trace and the selection hook there):

1. `ImportPreviewTable`: the responsive table and phone cards, outcome tabs,
   selection column, expandable details.
2. `ImportPreviewSummary`: counts, balances, difference.
3. Each source's wizard renders these with its own structural extras.

## 6. Invariants

- **P1, preview equals commit.** The commit plans through the same functions,
  under the write transaction, and refuses a changed fingerprint (409).
- **P2, at most once per key.** A new key is imported once per account; an
  excluded key is never imported by that source for that account.
- **P3, rejection before write.** A key outside the plan, an overlapping
  import and exception list, or a changed fingerprint refuses the whole
  commit with nothing written.
- **P4, rules never move money.** The preview shows rule effects; rules keep
  INV-RULE-001 and INV-RULE-002.

## 7. Decisions for the maintainer

- **D1.** One exception table for all sources, or bank sync keeps its ledger
  and file imports get their own table.
- **D2.** Whether QIF/OFX/CSV imports gain a durable duplicate ledger like
  bank sync's (needed for P2 across files), or only an in-file check.
- **D3.** Whether MNY joins (its reader and its wizard differ the most) or
  stays with its review step.
- **D4.** The order: CSV first (it already has a plan asking for this), then
  QIF/OFX, then MNY.

## 8. Rejected alternatives

- **A preview per source, written separately.** The current state. Four
  places to fix the same mistake, and none of them shows rule effects.
- **Preview by a dry-run transaction that rolls back.** It would write
  through the real path and roll back, but external effects (payee creation
  side effects, notifications, recalculation dispatch) and locks make a
  rolled-back write a poor read, and the fingerprint still needs a pure plan.
