---
title: "Reviewing a payee merge: which FKs clear, which block, and the shared_* RLS trap"
author: Node
date: 2026-11-06
branch: claude/issue-2026
cost: { minutes: 1, tokens: 28073 }
touches:
  - backend/src/payees/payee-references.ts
  - docs/backend/ai-and-payees.md
  - docs/system-invariants.md
  - website/docs/categories-and-payees.md
  - docs/concurrency-and-idempotency.md
---

## Decided
- Review of the #2026 fix: reassignPayeeReferences moves every FK to payees(id) before the remove, in the merge's withScopedDb transaction. The review's findings were doc-only and were fixed in the same PR.
## Tried and ruled out
- Lock order (the loan account row is locked after the transaction rows): this matches what the other transaction writers do (docs/concurrency-and-idempotency.md section 4 table), so it is not a finding.
- Delegate path: neither POST /payees/merge nor /payees/auto-merge/apply has @AllowDelegate, so the shared_* RLS gap cannot be reached today. The comment on PAYEE_REFERENCE_MOVES says so.
## Watch out
- transactions.payee_id and scheduled_transactions.payee_id have no ON DELETE action, so a missed move makes the delete fail. Only aliases cascade; the other references are SET NULL.
- The shared_people/shared_postings policies require user_id = app_current_user_id() AND app_real_user_id(). Under a delegate context, a raw UPDATE matches 0 rows with no error, and the FK SET NULL then clears the rows.
- website/docs/categories-and-payees.md "What Happens During a Merge" must change whenever merge behaviour changes.
