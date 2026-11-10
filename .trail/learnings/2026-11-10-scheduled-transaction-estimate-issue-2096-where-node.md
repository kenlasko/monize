---
title: "Scheduled transaction estimate (issue #2096): where the pieces live"
author: Node
date: 2026-11-10
branch: claude/issue-2096
cost: { minutes: 1, tokens: 43187 }
touches:
  - frontend/src/lib/payee-seasonality.ts
  - frontend/src/components/bills/CashFlowForecastChart.tsx
  - AGENTS.md
---

## Decided
- Nothing implemented yet; asked the maintainer to choose between estimating at read time (a flag on scheduled_transactions, worked out in ScheduledOccurrenceService) and storing estimates as override rows. Read time is recommended.
- Every surface reads an occurrence's amount through ScheduledOccurrenceService.expand -> ScheduledEffectiveAmountService.resolveMany (backend/src/scheduled-transactions/), so an estimate belongs there, not in each consumer.
- Manual per-instance edits are rows in scheduled_transaction_overrides; an override must win over any estimate.

## Tried and ruled out
- Nothing tried yet.

## Watch out
- frontend/src/lib/payee-seasonality.ts (computeSeasonality, MIN_YEARS_FOR_SEASONALITY = 2) already builds a per-calendar-month profile on the client; the server has no equivalent yet.
- "The graph" in the issue is most likely frontend/src/components/bills/CashFlowForecastChart.tsx on the Bills page.
- A financial feature this size needs a spec in docs/specs/ and a plan in docs/future-plans/ before code (AGENTS.md).
