---
title: "Split-line tags are changed with a separate splitTags field, checked before the edit writes and undoable"
author: Ken
date: 2026-11-10
branch: feat/mcp-split-line-tags
id: l-ff44e6f8
scope: repo
status: active
replaces: l-5a0f746b
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
- manage_transactions updates take `splitTags: [{ splitId, addTagNames?, removeTagNames? }]` (both surfaces): one line's tags change without resending the split set. Previewed in previewUpdate, signed as `splitTagChanges` (names to add, ids to remove), counts toward tagsOnly. A transfer line's counterpart leg gets the same change when it is the user's (as applySplitTags mirrors them).
- Refused: beside `splits`, on a transfer, on an unsplit transaction, an unknown or repeated splitId, and an entry naming no tag (schemas/MCP handler), since a silently dropped entry let the model think the line changed.
- In update() the lines are checked and the legs locked + assertReconciledRowsMutable in prepareSplitTagChanges, right after the parent's own reconciled check, before anything is written; applySplitTagChanges only writes (one findOrCreateByNames for every line).
- History: snapshotTransaction records each line's `tagIds`; undo/redo (restoreSplitLineTags) rewrites a line whose tags changed, restores a re-created line's tags, and reverses the difference on the leg; delete-undo re-inserts line tags. Entries without line tagIds leave line tags alone.
- Read rows: `tagNames` per row (a split row's are its line's), `transactionTagNames` once, on a split's first row.
- Card text for a line comes from one helper (frontend split-tag-change-text.ts) with punctuation in catalog keys (splitLineName, splitLineNameWithMemo, splitLineTagChange, splitLineTagChangeBoth).

## Tried and ruled out
- Tag lists on each line of `splits`: that needs the full replacement set, which deletes and recreates every line for a tag edit.
- Locking and asserting the legs inside the apply step: update() has already written the parent then, so the refusal relied on rollback.

## Watch out
- transactions.service.spec: the update helpers' queued `manager.findOne` Once answers the next findOne (update() locks via lockTransactionRows); a leg lookup through `m.find(Transaction)` must be mocked on `mockQueryRunner.manager.find`, not the repository.
- Frontend files have no Prettier config; default Prettier switches them to double quotes. Lint only.
- trail check flags this work lexically against the split re-total and void-mirror learnings; neither applies now.

In the code: backend/src/transactions/transactions.service.ts (previewSplitTagChanges, ownLegTags, prepareSplitTagChanges, applySplitTagChanges, snapshotTransaction, toLlmRows), backend/src/action-history/action-history.service.ts (restoreSplitLineTags), backend/src/tags/tag-change.util.ts, frontend/src/components/ai/split-tag-change-text.ts, backend/src/mcp/tools-list-budget.spec.ts.
