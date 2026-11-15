---
title: "Issue #2141: incoming transfers as budget income, design survey"
author: Node
date: 2026-11-14
branch: claude/issue-2141
cost: { minutes: 1, tokens: 63491 }
touches:
  - backend/src/budgets/budget-spending.util.ts
---

## Decided
- Nothing built yet; design questions posted to the maintainer (granularity, which budget types, which income surfaces, netting, generator).
- Budget lines today: category lines, or outgoing transfer lines (is_transfer + transfer_account_id, created only via generator apply DTO). Actuals for transfers come from outgoingParentTransfers / outgoingSplitTransfers in backend/src/budgets/budget-spending.util.ts (amount < 0 only).
- Budget income is resolveBudgetIncome (income category lines, netted, clamped at 0); it feeds getSummary, incomeLinked percentage budgets, period close actual_income, income alerts, trend/health reports.

## Tried and ruled out
- A literal "every incoming transfer is income" toggle: an internal transfer between two in-budget accounts (chequing->savings, card payment) would count its incoming leg as income.

## Watch out
- budgets.config.includeTransfers exists in BudgetConfig but nothing reads it; config.excludedAccountIds is read by budgetExcludedAccountIds/excludeBudgetAccounts on every actuals query.
- Many filters assume isTransfer implies outgoing and not income (`!bc.isIncome && !bc.isTransfer`) across alert, trend, health, activity services; an incoming-transfer income line must be checked against each.
