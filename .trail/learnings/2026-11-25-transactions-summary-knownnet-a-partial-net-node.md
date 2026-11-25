---
title: "Transactions summary knownNet: a partial net from one FxAggregate.difference (#2409)"
author: Node
date: 2026-11-25
branch: claude/issue-2409
cost: { minutes: 22, tokens: 79622 }
touches:
  - backend/src/transactions/transaction-analytics.service.spec.ts
  - backend/src/transactions/transaction-analytics.service.ts
  - docs/future-plans/report-rounding-and-aggregation-tasks.md
  - docs/specs/report-rounding-and-aggregation.md
  - frontend/src/components/transactions/widget-shared.test.ts
  - frontend/src/components/transactions/widget-shared.ts
  - frontend/src/types/transaction.ts
---

## Decided
`SummaryInReportingCurrency` (backend/src/transactions/transaction-analytics.service.ts) carries an additive `knownNet` = `FxAggregate.difference(income, expenses).knownSubtotal`, present complete or partial (equals `netCashFlow` when complete). The transactions widget (frontend/src/components/transactions/widget-shared.ts) reads `converted.knownNet`; the `roundMoney(knownIncome - knownExpenses)` fallback is gone.

## Tried and ruled out
Adding `knownNet` to an MCP output schema: no MCP tool returns this summary. The MCP resources call `getSummary` without `inReportingCurrency`, and `list_transactions` uses `LlmConvertedFlowFields` (`known*Subtotal`, left undeclared because of the tools/list budget). Only `TransactionsService.getSummary` (the summary endpoint) opts into `converted`.

## Watch out
A new required field on the frontend `converted` type means every widget-shared.test.ts fixture needs it. `trail check` flags keyword-only "conflicts" on comment text about rates and income, which are false positives here.
