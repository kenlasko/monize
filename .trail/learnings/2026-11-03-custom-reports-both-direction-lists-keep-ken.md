---
title: "Custom reports: Both-direction lists keep row signs; aggregates stay unsigned and are only relabelled"
author: Ken
date: 2026-11-03
branch: feat/1978-signed-both-list
id: l-73e17ccb
scope: repo
status: active
src: agent
touches:
  - AGENTS.md
  - CONTRIBUTING.md
  - backend/src/common/instruction-files.spec.ts
  - docs/agent-instructions.md
  - scripts/check-docs-manifests.mjs
  - backend/src/reports/reports.service.ts
  - frontend/src/lib/custom-report-measure.ts
---

## Decided
- A custom report with No Aggregation and Both direction lists each row with its own sign (in positive, out negative) and its headline is the signed net of the listed rows (discussion #1978). Both legs of an in-scope transfer cancel; a leg whose counterpart is filtered out counts alone.
- Income Only / Expenses Only lists keep showing magnitudes, so existing saved reports did not change.
- Aggregated Both mode (Total/Average) keeps summing |net| per category cell (INV-REPORT-004, pie charts need positives). It is relabelled "Total/Average of unsigned category amounts" instead of being made signed.
- A signed list hides the % column and sizes pie slices by magnitude.

## Tried and ruled out
- Signing aggregated Both mode, or netting transfer pairs inside category cells: changes INV-REPORT-004 and existing saved reports and breaks pie charts; the signed list already covers the user's actual need. Deferred, not rejected outright.

## Watch out
- With transfers included the list total is "Net cash movement", not net income: INV-REPORT-003 says a transfer never enters net, so the caption matters.
- The grouping changes the aggregated Both total (each group sums unsigned cells); only signed aggregation would fix that.

In the code: lineAmount in aggregateNoGrouping (backend/src/reports/reports.service.ts); customReportMeasure / isSignedTransactionList (frontend/src/lib/custom-report-measure.ts); ReportChart props totalLabel and signed.
