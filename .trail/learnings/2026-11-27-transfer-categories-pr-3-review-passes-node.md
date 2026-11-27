---
title: "Transfer categories PR 3: review passes 2 and 3, lock order and history shape (#2454)"
author: Node
date: 2026-11-27
branch: claude/issue-2454
cost: { minutes: 108, tokens: 576316 }
touches:
  - backend/src/transaction-rules/transaction-rules-applier.service.ts
  - backend/src/transaction-rules/transaction-rules-run.service.ts
  - frontend/src/components/import-preview/ImportPreviewRuleTest.test.tsx
  - frontend/src/components/import-preview/ImportPreviewRuleTest.tsx
  - frontend/src/lib/categoryUtils.test.ts
  - frontend/src/lib/categoryUtils.ts
  - backend/src/action-history/action-history.service.spec.ts
  - backend/src/action-history/action-history.service.ts
  - backend/src/transaction-rules/transaction-rules-applier.loan-settlement.spec.ts
  - backend/src/transaction-rules/transaction-rules-applier.settlement-write.spec.ts
---

## Decided
- A conversion writes the category the plan left the row with: an undefined net `categoryId` means "keep the row's own", never "ask clearCategory again" (the plan already applied it).
- Every category write takes the shared category-owner lock before any row lock: first statement of a manual rule run, of `applyToNew`, of an override create/update (`lockOverrideCategoryOwner`); bulk status+category folds a selected linked row's split parent into the status lock set's parents.
- Undo paths lock the other side of a transfer with the row in the forward order (`lockRowsWithCategoryPartners`: line parent first, legs ascending); the bulk undo locks split parents on their own first.
- A run locks the split parents whose transfer lines link a candidate before the candidates (`loadCandidateUnits`), and skips a linked row whose parent is reconciled as `reconciled_locked`.
- Money import: a split's transfer line takes its linked row's category (`withOneCategoryPerTransfer`).
- A model's category name ambiguous within a group stops there (null), never falls through to another type.

## Tried and ruled out
- Widening `derived-state-writers.guard` to accept a lock wrapper: inlined `lockTransactionRow(s)` in `update` instead.
- Changing the plain patch to write the other leg only on a value difference against the row itself: the spec (section 1, "A category write") says naming one leg's category on legs that differ IS a write.
- Unit-testing a "first line signs the split total" fix through TransactionForm: its spec mocks SplitEditor so every line is a category line; extracted `splitTotalSigningCategoryId` into split-rows.ts and tested that.

## Watch out
- A split transfer line's bulk-history record carries its PARENT's id: a filter by skipped ids drops it, and an id-sorted lock batch mixes parent and leg.
- A split's linked row has no `parent_transaction_id`, so `lockTransactionRows`' parent+leg refusal never catches that mix.
- The `{{ name }}` tr() fallbacks are an existing convention (bank sync, receipts); not a defect.
- The earlier-reported flake in transaction-rules-run.integration did not reproduce in a 30-suite --runInBand run (501 tests, ~6 min).
