---
title: Reviewing the Monthly Breakdown grouping change (issue 2012)
author: Node
date: 2026-11-04
branch: claude/issue-2012
cost: { minutes: 1, tokens: 14606 }
touches:
  - website/docs/reports.html
  - website/docs/reports.md
  - website/docs/search-index.json
---

## Decided
- Moving a parent's direct spending out of "Other expenses" into the parent's section changes those two section subtotals and their Summary recap lines (group totals, Balance and Overall total are unchanged); the PR and website/docs/reports.md say so.
## Tried and ruled out
- persisted-storage.guard.test.ts covers only zustand persist stores, so a new useLocalStorage key needs no registration there.
- Fixing the parent-row drill-through on the client: the transactions list always descendant-expands a category filter (transaction-analytics.service.ts) and has no exact-category option, so it needs a backend filter change.
## Watch out
- e2e covers this report only through docs-screenshots/reports.spec.ts (report-monthly-breakdown); no spec asserts "Other expenses"/"Other income".
- A parent's own row drills into categoryIds=<parent>, which includes subcategories, so the list total exceeds the row.
