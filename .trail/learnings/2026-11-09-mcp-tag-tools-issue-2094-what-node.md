---
title: "MCP tag tools (issue 2094): what tag plumbing already exists"
author: Node
date: 2026-11-09
branch: claude/issue-2094
cost: { minutes: 3, tokens: 128269 }
---

## Decided
- Nothing decided yet: design questions (byte budget, where bulk add/remove lives, split-line scope, replace semantics, new create_tag/update_tag/delete_tag card types + frontend) were put to the owner before coding.

## Tried and ruled out
- Nothing implemented; the scope is cross-layer (backend action types, AiActionsService commit, assistant tool-definitions/executor, MCP tools, frontend TransactionConfirmationCard + i18n), so asking first was cheaper than guessing.

## Watch out
- update_transaction cards already carry additive `tagNames` end to end: TransactionToolPrepService.prepareUpdate (item.tagNames) -> TransactionsService.previewUpdate -> AiActionBuilderService.buildUpdateTransaction -> AiActionsService.executeUpdateTransaction (options.addTagNames -> TagsService.findOrCreateByNames + addTransactionTags). MCP manage_transactions does not pass tagNames yet; removal has no card path.
- TagsService already has idempotent addTransactionTags (ON CONFLICT DO NOTHING) and removeTransactionTags on a caller EntityManager; there is no split-level add/remove, only setSplitTags/setSplitTagsBulk (replace).
- Split-line tags mirror onto a transfer split's counterpart leg (TransactionsService.applySplitTags); transfer tags are synced on both legs in updateTransfer. SplitRowDescriptor carries no tagIds, so resending a splits array through manage_transactions likely drops split-line tags (unverified).
- Adding any MCP tool exceeds TOTAL_BYTE_BUDGET (64,595) in tools-list-budget.spec.ts; the owner once refused raising it (search_help) but approved raises for list_warranties and bond series.
