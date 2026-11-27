---
title: "Issue #2458: Estimate toggle hidden for foreign-currency scheduled bills"
author: Node
date: 2026-11-26
branch: claude/issue-2458
cost: { minutes: 1, tokens: 38293 }
touches:
  - docs/specs/scheduled-amount-estimate.md
  - AGENTS.md
---

## Decided
- Not implemented yet; asked the maintainer which currency a foreign bill's estimate should be in (biller currency vs account currency), because the exclusion is deliberate in docs/specs/scheduled-amount-estimate.md section 2.
- Read the issue as "amount entered in a currency other than the account's" (isForeign); a bill on a non-base-currency account already shows the toggle.

## Tried and ruled out
- Simply removing `!isForeign` in the form: the backend `assertEstimatable` refuses `isForeign` with estimateRequiresPlain, and the estimate service prices in the schedule's (account) currency only.

## Watch out
- Gate points: ScheduledTransactionForm.tsx `estimating` (~line 487) and `{!isForeign && renderEstimateToggle()}` (~line 1874); backend ScheduledTransactionsService.assertEstimatable; the nightly refreshForeignCurrencyEstimates rewrites `amount` for foreign schedules and would interact with an estimated one.
- A spec amendment must land before implementation (AGENTS.md financial-feature rule).
