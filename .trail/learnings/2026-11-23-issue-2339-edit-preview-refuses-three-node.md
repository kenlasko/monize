---
title: "Issue #2339: edit preview refuses three foreign figures that disagree"
author: Node
date: 2026-11-23
branch: claude/issue-2339
cost: { minutes: 9, tokens: 43916 }
touches:
  - backend/src/transactions/foreign-entry-preview.spec.ts
  - backend/src/transactions/foreign-entry-preview.ts
  - docs/financial-semantics.md
---

## Decided
- In `previewForeignEntry` (backend/src/transactions/foreign-entry-preview.ts), a resent stored rate is dropped beside a moved amount only when `request.originalAmount` is undefined. With amount, originalAmount and rate all sent, `resolveForeignEntry` applies the create's agreement check.
- Kept the older test "derives the rate from a new amount beside the row's own rate resent" (amount + rate, no originalAmount), because the issue limited the change to "all three explicitly supplied". Tightening that case is a separate one-condition change.

## Tried and ruled out
- No change was needed in transactions.service.ts or foreign-entry.util.ts. The whole difference was the single `exchangeRate = undefined` line.

## Watch out
- The issue's linked test sends no originalAmount, but the user's scenario does. Read the test body, not just the link.
- The doc paragraph to update is docs/financial-semantics.md, under the amount/exchangeRate truth table.
