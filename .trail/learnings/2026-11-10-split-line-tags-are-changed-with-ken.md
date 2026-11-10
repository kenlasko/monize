---
title: "Split-line tags are changed with a separate splitTags field, not by resending the split lines"
author: Ken
date: 2026-11-10
branch: feat/mcp-split-line-tags
id: l-5a0f746b
scope: repo
status: active
src: agent
touches:
  - backend/src/ai/actions/ai-action-builder.service.spec.ts
  - backend/src/ai/actions/ai-action-builder.service.ts
  - backend/src/ai/actions/ai-action.types.ts
  - backend/src/ai/actions/edit-commit-args.spec.ts
  - backend/src/ai/actions/edit-commit-args.ts
  - backend/src/ai/query/tool-definitions.ts
  - backend/src/ai/query/tool-executor.service.spec.ts
  - backend/src/ai/query/tool-executor.service.ts
  - backend/src/ai/query/tool-input-schemas.spec.ts
  - backend/src/ai/query/tool-input-schemas.ts
---

## Decided
- The follow-up to the MCP tag tools (#2094): a manage_transactions update takes `splitTags: [{ splitId, addTagNames?, removeTagNames? }]` on both surfaces. It changes one existing line's tags without resending the split set, so the model never has to round-trip amounts and categories just to tag a line.
- It is a tag change like addTagNames/removeTagNames: previewed in TransactionsService.previewUpdate, signed as `splitTagChanges` (names to add, ids to remove, by splitId), counted toward tagsOnly, and written inside update()'s own transaction. A transfer line mirrors onto its counterpart leg when that leg is the user's, the same way applySplitTags keeps the two in agreement.
- splitTags is refused beside `splits`, on a transfer, and on a transaction that is not split. A replaced line keeps its tags through its splitId, and allowing both in one edit would mean creating new tags for lines whose ids do not exist yet.
- Read rows now carry `tagNames` (a split row's are its line's) and `transactionTagNames` on split rows. Without them the model could not see where a tag sits before moving it.
- tools-list budget: raised by the measured growth (+524 bytes), following the owner's earlier choice.

## Tried and ruled out
- Putting addTagNames/removeTagNames on each line of the `splits` array: it needs the complete replacement set, which deletes and recreates every line, for what is only a tag edit.

## Watch out
- In transactions.service.spec, the `update` helpers queue `manager.findOne.mockResolvedValueOnce(mockTx)`, but update() itself no longer reads through findOne (lockTransactionRows replaced that). The queued row answers the NEXT findOne, such as a leg lookup, so a test of the leg mirror must skip the helper.
- trail check flags lexical false positives on this work, from the split re-totalling and void-mirror learnings. Neither applies.

In the code: backend/src/transactions/transactions.service.ts (previewSplitTagChanges, applySplitTagChanges, ownSplitLegId, toLlmRows), backend/src/tags/tag-change.util.ts (splitTagChangeWriteFields/DisplayFields), backend/src/ai/actions/edit-commit-args.ts, backend/src/mcp/tools-list-budget.spec.ts.
