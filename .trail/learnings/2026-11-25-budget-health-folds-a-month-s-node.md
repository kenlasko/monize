---
title: "Budget Health folds a month's income as one FxAggregate (#2408)"
author: Node
date: 2026-11-25
branch: claude/issue-2408
cost: { minutes: 21, tokens: 146168 }
touches:
  - docs/system-invariants.md
  - backend/src/budgets/budget-health-reports.service.spec.ts
  - backend/src/budgets/budget-health-reports.service.ts
  - backend/src/budgets/budget-spending.util.ts
  - backend/src/budgets/budget-transfer-income.spec.ts
  - docs/future-plans/report-rounding-and-aggregation-tasks.md
  - backend/src/budgets/budget-activity-reports.service.spec.ts
  - backend/src/budgets/budget-alert.service.spec.ts
  - backend/src/budgets/budget-reports.service.spec.ts
  - backend/src/budgets/budget-spending.util.spec.ts
---

## Decided
- getSavingsRate (backend/src/budgets/budget-health-reports.service.ts) holds each month's income as one FxAggregate: native rows addConverted, foreign rate parts merged from convertRatePartAggregates, the transfers-in toggle merged from CategorySpending.outsideTransferIncomeAggregate via resolveOutsideTransferIncomeAggregate (copy, judged on sign). Savings is FxAggregate.difference; the rate divides the unrounded figures but is only given when income.knownSubtotal > 0.
- The four-place case that moved on the old code is the toggle: 10.0049 USD + EUR 0.0001 + EUR 1.0001 transferred in (own rate 1.6) read 10.6301, exact reads 10.6300. Native + foreign alone never moves at four places (native sits on the four-place grid), so the toggle is what makes a runtime test possible without a guard extension.

## Tried and ruled out
- Guarding the rate on income.sign > 0: dust income of 0.00003 that reads 0.0000 gave a rate of trillions of percent.
- Replacing the number fields of CategorySpending with aggregates: right in the long run, but it touches the budget page, period close and alerts, beyond the issue.

## Watch out
- CategorySpending now has outsideTransferIncome (reading) and outsideTransferIncomeAggregate side by side; a fixture setting only the number makes Budget Health read 0 from the toggle. Use the outsideIncome() helper in budget-health-reports.service.spec.ts.
- The budget summary, period close and alerts still sum each line's and the toggle's four-place readings (recorded under INV-REPORT-005's Known gap).
