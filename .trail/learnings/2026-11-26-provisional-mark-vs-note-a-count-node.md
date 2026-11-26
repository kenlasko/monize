---
title: "Provisional mark vs note: a count shared by several figures is a note (F3 review, issue 2399)"
author: Node
date: 2026-11-26
branch: claude/issue-2399
cost: { minutes: 7, tokens: 22461 }
touches:
  - docs/future-plans/provisional-amounts.md
  - frontend/src/components/currencies/detail/CurrencySummaryCards.test.tsx
  - frontend/src/components/currencies/detail/CurrencySummaryCards.tsx
  - frontend/src/components/reports/CustomReportViewer.tsx
  - frontend/src/components/transactions/CategoryInfoWidget.test.tsx
  - frontend/src/components/transactions/CategoryInfoWidget.tsx
  - frontend/src/components/transactions/PayeeInfoWidget.test.tsx
  - frontend/src/components/transactions/PayeeInfoWidget.tsx
---

## Decided
- A provisionalCount that covers more than one figure (the payee/category info widgets' summary count spans income, expenses, net and average) gets one ProvisionalDataNotice, never a ProvisionalMark on each figure: the count does not say which side holds the estimate.
- A partial figure (knownReportingSubtotal on the currency page) is not marked when the count is over all rows: the unconverted rows may be the estimated ones. Mark only figures the count is provably inside.

## Tried and ruled out
- Passing the summary count to every PartialTotal in a widget: marks an Income of 0 as "includes 1 estimated amount".

## Watch out
- When a surface shows both a mark and a note, read both from one const so they cannot disagree.
- trail check flags provisionalCount files against unrelated MCP/chart learnings; keyword matches.
