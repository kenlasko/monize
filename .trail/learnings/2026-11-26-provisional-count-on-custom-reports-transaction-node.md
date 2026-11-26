---
title: "Provisional count on custom reports, transaction analytics, the assistant and MCP (issue 2395, B7)"
author: Node
date: 2026-11-26
branch: claude/issue-2395
cost: { minutes: 43, tokens: 369919 }
touches:
  - backend/src/ai/query/tool-executor.service.spec.ts
  - backend/src/ai/query/tool-executor.service.ts
  - backend/src/transactions/transaction-analytics.service.spec.ts
  - backend/src/transactions/transaction-analytics.service.ts
  - backend/test/integration/provisional-count-reports.integration.spec.ts
  - docs/future-plans/provisional-amounts.md
  - backend/src/ai/query/tool-definitions.spec.ts
  - backend/src/ai/query/tool-definitions.ts
  - backend/src/mcp/mcp-server.service.spec.ts
  - backend/src/mcp/mcp-server.service.ts
---

## Decided
- Custom report: `createNetCells` takes a 4th callback `onProvisional`, told once per settle of each provisional row (`NetLine.provisionalRow`, whole rows only) whose converted line sits in a KEPT part of a KEPT cell; `ReportsService` collects them on `RowConverter.provisionalRows`; the NONE-metric list counts rows that converted. `ReportResult.provisionalCount` and `summary.provisionalCount`; the COUNT metric is always 0 (it sums no amount). `summarizeRows` returns `Omit<ReportSummary, "provisionalCount">`.
- Analytics: one SQL fragment `PROVISIONAL_COUNT_SQL` / `provisionalCountSql(alias, splitAlias)` = `COUNT(DISTINCT x.id) FILTER (WHERE split.id IS NULL AND x.amountIsProvisional = true)`; TypeORM resolves the property path inside FILTER (proven in test/integration/provisional-count-reports.integration.spec.ts). `addDatedAmount` now returns whether the amount is in the known figure, so `foldGroups` and the flow totals count only converted parts. Summary: top-level count over native totals, `converted.provisionalCount` over included buckets only.
- MCP: tools/list total had 10 bytes spare, so no schema field or tool-description sentence; one Conventions line in the server instructions (budget 2,600, ~2,300 used) explains provisionalCount and amountIsProvisional for every tool. The assistant's tool-definitions have no byte budget and got a sentence each.

## Tried and ruled out
- Declaring provisionalCount in listTransactionsOutput / comparePeriodsOutput: needs raising shrink-only caps (an "ask first").

## Watch out
- list_transactions/query_transactions flow totals and the period comparison exclude transfers, so their count is always 0; the transfersOnly rollup (`getTransfersByAccount`) is where list_transactions' estimates actually show, and it has its own count.
- `npm run lint` (--fix) rewrites an unrelated trailing newline in src/common/fx-aggregate.spec.ts; revert it.
- To read tools/list byte sizes per tool, a scratch spec that calls collectToolConfigs() and listTools() is quicker than the budget spec, whose Jest diff truncates the table.
