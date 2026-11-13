---
title: "Issue #2155: recurring charges per currency, budget income and trends through queryCategorySpending"
author: Node
date: 2026-11-13
branch: claude/issue-2155
cost: { minutes: 53, tokens: 374046 }
touches:
  - docs/system-invariants.md
  - "frontend/src/app/payees/[id]/page.tsx"
  - frontend/src/components/payees/detail/PayeeSummaryCards.test.tsx
  - frontend/src/components/payees/detail/PayeeSummaryCards.tsx
  - backend/src/ai/forecast/ai-forecast.service.spec.ts
  - backend/src/ai/insights/ai-insights.service.spec.ts
  - backend/src/transactions/recurring-charges.util.ts
  - backend/src/transactions/transaction-analytics.service.spec.ts
  - backend/src/transactions/transaction-analytics.service.ts
  - backend/test/integration/fx-own-rate-surfaces.integration.spec.ts
---

## Decided
- getRecurringCharges groups by t.currencyCode too and returns currencyCode, so a charge's amounts are one currency. With `reportingCurrency` it adds `converted` (latest and previous occurrence via convertDatedRows: own rate, else the market rate on that day, null with no rate). Only the AI aggregators pass it; the prompts go through ai/context/recurring-charge-prompt.ts ("13.20 (billed 12.00 EUR)" / "unknown (no EUR->USD exchange rate; billed ...)"). The insights change% stays on the billed amounts: a price change, not an FX move.
- Frontend payee surfaces (PayeeRecurringPanel, PayeeInfoWidget, PayeeSummaryCards) format a charge with its own currencyCode, not the display currency. The account panel already used the account's currency.
- Budget income: computeActualIncome was deleted; resolveBudgetIncome derives it from the same queryCategorySpending read as the lines (clamped as a whole, each category once). Savings rate's no-income-category path converts via splitByRateBasis + convertRateParts keyed by month.
- Budget trends (open period, category open periods, both live trends) and the health history's open period read queryCategorySpending / queryCategorySpendingBuckets. Live points carry valuationComplete; closed periods omit it (frozen figures have no completeness).

## Tried and ruled out
- Converting the budget generator: GenerateBudgetDto has no currency, so the target currency is a design choice. Left as a named gap in INV-FX-001.

## Watch out
- Unit specs that jest.mock("./budget-spending.util") must mock queryCategorySpending as well as queryCategorySpendingBuckets: queryCategorySpending calls the bucket version through a module-local binding, so mocking only the export leaves the real query running on a manager the repo mocks lack.
- A mocked query builder for a read that calls splitByRateBasis needs setParameter, and the scoped manager's query must answer [] for the rate history.
- Integration specs run fine against `docker run mirror.gcr.io/library/postgres:16-alpine` on a spare port with DATABASE_PORT set; no schema step is needed.
