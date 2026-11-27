---
title: "Transfer categories PR 3: what a row may hold, on every write path (#2454)"
author: Node
date: 2026-11-27
branch: claude/issue-2454
cost: { minutes: 153, tokens: 1246571 }
touches:
  - backend/src/action-history/action-history.service.ts
  - backend/src/action-history/rule-run-undo.ts
  - backend/src/categories/categories.service.spec.ts
  - backend/src/categories/categories.service.ts
  - backend/src/categories/category-row-gate.spec.ts
  - backend/src/categories/category-row-gate.ts
  - backend/src/import/mny/map/map-transactions.ts
  - backend/src/import/mny/map/one-category-per-transfer.spec.ts
  - backend/src/scheduled-transactions/scheduled-transactions.service.ts
  - backend/src/transaction-rules/transaction-rules-applier.service.ts
---

## Decided
- One fit helper, `backend/src/categories/category-fit.ts` (`fitCategory`, `fitCategories`, `categoryFits`, `holderOfRow`, `holderOfSplitLine`), asked inside each write's transaction. It takes the category-owner advisory lock only for a category row; a transfer row fits any type, so no type change can race it.
- One category per transfer goes through `backend/src/transactions/transfer-category-partner.ts`: find the other leg or split line, lock it with the row (split parent first, legs ascending), write it only when the value differs, record `categoryPartner` in history so undo restores it.
- The matrix specs (`test/integration/category-fit-*.integration.spec.ts`) use a shrink-only `NOT_YET_BUILT` set run as `it.failing`, so every commit stays green while rows are still unbuilt.
- The guard is AST-based (`category-fit.guard.spec.ts`). A helper is recognised by name (`/^fit\w*Categor(y|ies)$/`); a write that only copies a fitted value carries `category-fit-ok: <reason>`.
- Bulk update and rule runs skip rows the category doesn't fit, with a reason; they never refuse the whole command. Imports count skipped rows in `categoriesNotFitting`.

## Tried and ruled out
- Runtime fit checks in the payee backfill and the shared-expense writer: they broke many spec doubles and added no protection (PR 2 refuses the payee default when it is set). Used a guard marker there instead, plus a type check in the shared-expense plan's existing read.
- Running prettier on frontend files: the frontend is not prettier-formatted, and it rewrote whole files. Edit without reformatting.
- Filling locale files in the English key order: that reorders keys. The fill script must insert after the English predecessor, and must skip the en-GB and en-US overlay locales.

## Watch out
- Many backend spec doubles lack `query`, `findOne` on the Category repo, or `lockCategoryOwnerShared` in `jest.mock("../common/db/locks")`. `src/test-helpers/category-fit-testing.ts` has `categoryFitRepoMock` and `answerCategoryFinds`.
- Frontend tests that mock `@/lib/categoryUtils` wholesale need `buildCategoryPickerOptions` and `getCategorySelectOptionsFor` stubs.
- The MCP tools/list byte budget (`mcp/tools-list-budget.spec.ts`) is tight; keep description additions short.
- `transaction-rules-run.integration.spec.ts` › "evaluates a same-owner transfer once and writes both legs" failed once in an earlier combined run; it passed in a 30-suite `--runInBand` run (501 tests, about 6 minutes) on a throwaway `postgres:18-alpine`. Never run integration suites in parallel processes here: three at once hit the memory limit (exit 137).
- The category-owner lock comes before every row lock. The review passes found it taken late in five places: the override's auto-post check (a schedule `FOR SHARE`), a manual rule run, `applyToNew`, the bulk status pass, and the undos. A category type change takes no transaction or schedule row lock, so none of these could deadlock against it, but the reviewers hold to the protocol in `common/db/locks.ts`.
- A split transfer line's record in bulk history carries its parent's id, so a filter by skipped ids drops it, and an id-sorted lock batch locks the parent beside its leg. Keep partner records apart, and lock split parents on their own first.
- `derived-state-writers.guard` wants `lockTransactionRow(s)(` written inside each `update*`/`remove*` method that moves a balance; a wrapper helper hides the lock from it.
- Pass 3 flagged "the other leg is rewritten when the request resends the category one leg holds". The spec (section 1, "A category write") says that is a write, so it is not a defect.
