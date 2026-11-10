---
title: "Split-line tag edits record exactly what they touched, and undo sets back only that"
author: Ken
date: 2026-11-10
branch: feat/mcp-split-line-tags
id: l-2ff2578d
scope: repo
status: active
replaces: l-ff44e6f8
src: agent
touches:
  - backend/src/action-history/action-history.service.spec.ts
  - backend/src/action-history/action-history.service.ts
  - backend/src/ai/actions/ai-action-builder.service.spec.ts
  - backend/src/ai/actions/ai-action-builder.service.ts
  - backend/src/ai/actions/ai-action.types.ts
  - backend/src/ai/actions/edit-commit-args.spec.ts
  - backend/src/ai/actions/edit-commit-args.ts
  - backend/src/ai/query/tool-definitions.ts
  - backend/src/ai/query/tool-executor.service.spec.ts
  - backend/src/ai/query/tool-executor.service.ts
---

## Decided
- `splitTags: [{ splitId, addTagNames?, removeTagNames? }]` on a manage_transactions update (both surfaces) changes one line's tags without resending the split set. A transfer line's counterpart leg, when it is the user's, changes too.
- The history entry carries `splitTagPlaces` in beforeData and afterData. For each line it lists the tags the edit named (`touched`) and which of them the line and the leg carried, read under the locks. Undo applies the before record and redo the after record (redo swaps before/after), so no other tag moves.
- Legs are locked and checked with assertReconciledRowsMutable at preview (which refuses a reconciled leg), at confirm (in prepareSplitTagChanges, before update() writes anything) and at undo/redo. The card and the MCP prompt name the leg's account.
- Every line's new names resolve in one findOrCreateByNames, which keeps only the first 100. The cap is therefore checked across all lines at both preview and confirm, and a name that fails to resolve is refused, never dropped.
- `transactionTagNames` goes on every split row, because the read's amount filter runs after the rows are built.

## Tried and ruled out
- Inferring the leg's change from the line's before and after tags: the leg's own tags were never recorded. Undo deleted tags the leg had before the edit and missed changes that landed only on the leg.
- Checking the legs inside the apply step: update() has already written the parent by then, so a refusal relies on rollback.

## Watch out
- In transactions.service.spec, `m.find(Transaction)` must be mocked on `mockQueryRunner.manager.find`, not on the repository.
- Undo inserts of tag links first check that the tags still exist (`errors.actionHistory.undoTagGone`), so a deleted tag gives a translated refusal instead of an FK error. The transaction-level tag restore does not do this yet.

In the code: backend/src/transactions/transactions.service.ts (prepareSplitTagChanges, applySplitTagChanges, previewSplitTagChanges), backend/src/action-history/action-history.service.ts (restoreSplitTagPlaces, restoreRecreatedLineTags, assertTagsStillExist), backend/src/tags/tag-change.util.ts (SplitTagPlace).
