---
title: PR 1883 accrual mode makes the transaction summary and totals hang for users with investments
author: Ken
date: 2026-10-28
branch: main
id: l-6bebe544
scope: repo
status: active
src: agent
touches:
  - backend/src/transactions/transaction-analytics.service.ts
  - backend/src/common/investment-filter.util.ts
---

## Watch out
- createFilteredAnalyticsQuery always adds investmentLinkedSplitExclusion, a NOT EXISTS over investment_transactions on transaction_split_id. That builder backs getSummary, getGroupedTotals, getMonthlyTotals, tag-key breakdown and the AI flow totals. In accrual mode the condition rewriter points it at accrual_reporting_investment_transactions, whose transaction_split_id calls accrual_reporting_cash_split_id() per row.
- Measured on a copy of the dev DB (35.7k transactions, 4,510 investment transactions, PG16, 50 seeded schedules): reading that column for every investment row took 47 s. The summary-shaped query ran a nested-loop anti join with the function in the join filter and was cancelled after 5 minutes (about 5.4M calls). The cash version took 28 ms. The backend sets no statement_timeout, so such a request holds its connection.
- To benchmark against dev safely, pg_dump the dev DB into a throwaway postgres:16-alpine container, apply only the PR's migrations, and seed schedules there. The dev DB is on main's schema.
In the code: backend/src/transactions/transaction-analytics.service.ts (createFilteredAnalyticsQuery), backend/src/common/investment-filter.util.ts, database/migrations/20261027213808_accrual_explicit_reporting_views.sql.
