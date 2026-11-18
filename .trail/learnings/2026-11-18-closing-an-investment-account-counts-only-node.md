---
title: "Closing an investment account counts only holdings the portfolio shows (>= 0.0001 shares)"
author: Node
date: 2026-11-18
branch: claude/issue-2271
cost: { minutes: 14, tokens: 100557 }
touches:
  - backend/src/accounts/accounts.service.spec.ts
  - backend/src/accounts/accounts.service.ts
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/en/errors.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/errors.json
  - backend/src/i18n/locales/id/errors.json
  - backend/src/i18n/locales/it/errors.json
  - backend/src/i18n/locales/ja/errors.json
---

## Decided
For #2271, `AccountsService.close` treats an investment account as holding securities only when a holding has `|quantity| >= HELD_QUANTITY_THRESHOLD` (0.0001, in `backend/src/securities/investment-replay.util.ts`). That is the predicate the portfolio views (`portfolio-calculation.service.ts`, `portfolio.service.ts`, `sector-weighting.service.ts`, `HoldingsService.remove`) already apply before showing or valuing a holding. Before this, close refused any non-zero quantity, so a sell that left a residue such as 0.00005 shares blocked the close while the Investments page and the Close button (which read the portfolio's `positionCount` and value) said there were 0 holdings. The refusal now lists the symbols still held (`{{ symbols }}` in `errors.accounts.closeWithHoldings`), not a count.

## Tried and ruled out
Deleting residue holding rows during the close: holdings are derived, and a rebuild (`projectedHoldingRow`, epsilon 1e-8) would write them back. The residue just stays in the closed account.
Converting every `0.0001` literal in the portfolio services to the new constant: that is a refactor beyond the fix, so it was left as a proposal.

## Watch out
Two thresholds exist and they mean different things. `HOLDING_QUANTITY_EPSILON` (1e-8) decides whether a rebuild stores a row at all. `HELD_QUANTITY_THRESHOLD` (1e-4) decides whether the user holds the position. A check that refuses because something is held should use the second one. Integration spec: `backend/test/integration/account-close-holdings.integration.spec.ts`.
