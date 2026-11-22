---
title: "Issue #2323: Activate hidden on inactive security with holdings"
author: Node
date: 2026-11-22
branch: claude/issue-2323
cost: { minutes: 6, tokens: 62556 }
touches:
  - frontend/src/components/securities/SecurityList.test.tsx
  - frontend/src/components/securities/SecurityListParts.tsx
---

## Decided
`buildSecurityActions` (frontend/src/components/securities/SecurityListParts.tsx) hid both toggle variants with `hidden: hasHoldings`. Only Deactivate needs that rule (backend `deactivate` refuses non-zero holdings; `activate` has no check). Activate is now never hidden, so an inactive security that regained shares (a transaction edited/deleted after deactivation) can be reactivated.

## Tried and ruled out
Guarding transaction edits/deletes on inactive securities (the maintainer's idea in the issue thread) was left as a separate proposal: a different concern, it touches backend write paths (bulk, AI, MCP), and the reporter's data is already in that state.

## Watch out
`SecurityList.test.tsx` has "hides deactivate button when security has holdings"; the inverse for Activate is the new case beside it.
