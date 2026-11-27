---
title: "Transfer categories PR 4: budget funding split, overlap rule side effects, review fixes"
author: Node
date: 2026-11-27
branch: claude/issue-2455
cost: { minutes: 101, tokens: 443035 }
touches:
  - backend/src/budgets/budget-alert.service.spec.ts
  - backend/src/budgets/budget-alert.service.ts
  - backend/src/budgets/budget-generator.service.ts
  - backend/src/budgets/budget-spending.util.ts
  - backend/src/i18n/locales/en/emails.json
  - backend/src/i18n/locales/xx/emails.json
  - backend/src/notifications/notification-email-copy.spec.ts
  - backend/src/notifications/notification-email-messages.ts
  - backend/test/integration/budget-transfer-category.integration.spec.ts
  - frontend/src/components/reports/ReportChart.test.tsx
---

## Decided
- Total Budget Funding stays `totalIncome` / `actual_income` everywhere; `categoryIncome` and `transferFunding` sit beside it (budget-funding.util.ts). A closed period's Actual Income is derived server-side (`periodCategoryIncome`), null when `transfer_funding` is NULL (closed before the column existed): unknown, never zero.
- MCP `get_budget_status` does not enumerate the two new fields in its output schema: tools/list was 51 bytes over its total budget, and the result is loose, so they still reach the model (spec in budgets.tool.spec.ts). No cap was raised.
- A Transfer category's lines get their own category queries with the transfer-leg rate basis (`transferLegs` in splitByRateBasis), so Income/Expense lines read exactly as before while a moved cross-currency leg keeps its implied rate (INV-FX-002).
- The generator returns `categoryType` per suggestion; the wizard files a Transfer category's outgoing line with the transfers, defaults it to SAVING under 50/30/20, and the generator drops those legs from per-account destination and source suggestions (planned once).
- Income-shortfall alert wording changed to "total budget funding" in en + fallback; other locales are retranslated in PR 5.

## Tried and ruled out
- Excluding Transfer-category lines from the health-score history: the live score already scores per-account transfer lines from the summary, so history and live would disagree. Reverted.
- Fixing the breakdown's account-row drill (it lists transfers the row no longer counts): needs a register filter "transfers without a Transfer category", which changes every category-filter surface. Left as a follow-up in the PR.

## Watch out
- The overlap rule moves legs off per-account transfer lines, which carried provisional tracking and the transfer rate; anything those lines did per leg must be redone on the category line (provisional ids: `categoryProvisionalCounts`).
- The `transfersInAsIncome` toggle nets both directions, so an outgoing leg to an excluded account shows up in `outsideTransferIncomeProvisionalCount`; don't assert `provisionalCount` 0 in such fixtures.
- category-type.guard.spec flags a multi-line `Pick<BudgetCategory, "isIncome" ...>` because "BudgetCategory" is not on the same line; mark it `income-flag-ok:`.
- After `npm ci --ignore-scripts`, frontend `next-body-streams.test.ts` fails (patch-package not applied); not a regression.
