---
title: "Issue #2134: MCP dry-run vs save path, and ambiguous split-tag carry"
author: Node
date: 2026-11-12
branch: claude/issue-2134
cost: { minutes: 17, tokens: 156320 }
touches:
  - backend/src/mcp/tools/transactions.tool.spec.ts
  - backend/src/mcp/tools/transactions.tool.ts
  - backend/src/transactions/transaction-tool-prep.service.spec.ts
  - backend/src/transactions/transaction-tool-prep.service.ts
  - backend/src/transactions/update-preview-row.util.ts
  - docs/backend/mcp.md
  - backend/src/ai/query/tool-definitions.ts
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/en/errors.json
  - backend/src/i18n/locales/es/errors.json
---

## Decided
- manage_transactions dryRun for update follows the save's path: one item or approvalMode "individual" (resolveApprovalMode picks it below BULK_APPROVAL_THRESHOLD=6) -> TransactionToolPrepService.prepareUpdateEach (a transfer is its own card); a bulk card -> prepareUpdateBulk (skips transfers). Both map rows via updatePreviewRow (src/transactions/update-preview-row.util.ts).
- carrySplitTags matches unnamed lines by tier: category+amount+memo, then category+amount, then category. Per tier it groups lines and unclaimed candidates by key and pairs them in order only when the result cannot depend on the pairing (candidates share one tag set and n<=m, or the lines are identical and m<=n); otherwise it throws errors.transactions.splitTagCarryAmbiguous asking for splitId. Untagged transactions never throw.

## Tried and ruled out
- Making the splitId .describe() in transactions.tool.ts longer: it put tools-list-budget.spec.ts over the total byte budget, which is a ratchet. The refusal message carries the guidance instead.
- Treating two resent identical lines (same category, amount and memo) against two differently tagged candidates as ambiguous: either pairing leaves the same final set, so it is not a guess.

## Watch out
- backend npm deps may be missing in a fresh worktree (npm ci). eslint over several files needs NODE_OPTIONS=--max-old-space-size=4096 or it OOMs.
- trail check flags tool-definitions.ts:528 (one long description string) and new tag-related error strings as reviving ruled-out "tag lists on splits" ideas; keyword false positives.
