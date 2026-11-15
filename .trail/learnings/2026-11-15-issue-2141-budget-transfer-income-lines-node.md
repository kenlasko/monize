---
title: "Issue #2141: budget transfer income (lines and the excluded-accounts toggle)"
author: Node
date: 2026-11-15
branch: claude/issue-2141
cost: { minutes: 56, tokens: 514646 }
touches:
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/errors.json
  - backend/src/i18n/locales/id/errors.json
  - backend/src/i18n/locales/it/errors.json
  - backend/src/i18n/locales/ja/errors.json
  - backend/src/i18n/locales/ko/errors.json
  - backend/src/i18n/locales/nl/errors.json
  - backend/src/i18n/locales/pl/errors.json
---

## Decided
- Two options (maintainer): a transfer income line (is_transfer + is_income, transfer_account_id = SOURCE) and config.transfersInAsIncome, which sweeps the excluded accounts no transfer line names. Spec: docs/specs/budget-transfer-income.md.
- Net change: incomingParentTransfers / incomingSplitTransfers (budget-spending.util.ts) read the leg in a budget account whose counterpart is the source, both directions, signed SUM; a line clamps at 0, resolveBudgetIncome nets then clamps. CategorySpending carries transferIncomeMap and outsideTransferIncome; resolveCategorySpent takes a 4th map.
- One transfer line per account per budget (savings or income), refused in apply and in POST /budgets/:id/categories/transfer-income (budget row locked). The toggle's "named" set is read from budget_categories in the same query as the config, not from the caller's subset of lines.
- A line added mid-period writes its open-period budget_period_categories row, or the close leaves it out of actual_income.

## Tried and ruled out
- Representing the toggle as a budget line with a null transfer_account_id: ON DELETE SET NULL on an account would silently turn a "from HISA" line into the sweep-everything line.
- A synthetic categoryBreakdown row for the toggle's figure: rows are keyed by budgetCategoryId everywhere; it is a summary field (outsideTransferIncome) included in totalIncome instead.

## Watch out
- Callers that pass only expense lines to queryCategorySpending still trigger the incoming queries when the toggle is on (ignored result).
- Generator suggestions (incomeTransfers) do not know the excluded accounts (chosen after the Categories step) and, like the outgoing analysis, sum raw amounts across currencies; none is preselected.
- addCategory (category lines) has the same missing open-period row gap as transfer income lines had.
- Frontend: a new checkbox needs focus-visible:ring, never focus:ring (ui-conventions guard); BudgetForm never sends isActive (pre-existing).
