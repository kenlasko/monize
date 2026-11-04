---
title: Custom report drill-down into the Transactions register (issue 2013)
author: Node
date: 2026-11-04
branch: claude/issue-2013
cost: { minutes: 13, tokens: 148322 }
touches:
  - frontend/src/components/reports/CustomReportViewer.test.tsx
  - frontend/src/components/reports/CustomReportViewer.tsx
  - frontend/src/lib/custom-report-links.test.ts
  - frontend/src/lib/custom-report-links.ts
  - frontend/src/lib/transactions-href.test.ts
  - frontend/src/lib/transactions-href.ts
  - website/docs/reports.html
  - website/docs/reports.md
  - website/docs/search-index.json
  - backend/src/reports/reports.service.ts
---

## Decided
- Clicks on a custom report go through `customReportDrillDownHref` (frontend/src/lib/custom-report-links.ts), which reads the report's filters the way `getFilteredTransactions` in backend/src/reports/reports.service.ts does: filter groups win over legacy fields, and legacy `tagIds` are ignored there, so they are ignored here.
- An ungrouped list row carries the transaction id, so it becomes `targetTransactionId` together with the report filters; the backend's `calculateTargetPage` counts within the filtered set, so the row lands on its page and flashes.
- Plural params (`categoryIds`, `payeeIds`, `tagIds`) work on a fresh mount of /transactions; the singular-param watcher only matters for soft navigation within the page.
- `accountStatus=all` is sent only when the link names accounts (the Institutions/AI-link precedent); it does persist the Show Accounts toggle.

## Tried and ruled out
- Carrying a group that ORs two fields, or a field two groups constrain: the register ANDs one list per field, so either would narrow past the report and could hide the clicked row. They are dropped (the register shows a superset).
- Mapping report direction / includeTransfers onto amountFrom/amountTo: split parents make the sign of a row not its direction.

## Watch out
- The register expands a category to its children and the report does not; the register is a superset, which is fine for a highlight.
- The report's `uncategorized` bucket includes uncategorised transfer legs when transfers are included; the register's `uncategorized` excludes transfers.
- Payee `unknown` and tag `untagged` buckets are not register ids: the link keeps only the report filters.
- CustomReportViewer.test.tsx mocks ReportChart; its mock renders a `chart-point-<id>` button per data row to drive clicks.
