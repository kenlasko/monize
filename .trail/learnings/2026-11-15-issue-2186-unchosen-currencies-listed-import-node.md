---
title: "Issue #2186: unchosen currencies listed, import FX history not pulled"
author: Node
date: 2026-11-15
branch: claude/issue-2186
cost: { minutes: 25, tokens: 266369 }
touches:
  - backend/src/currencies/exchange-rate-history.service.ts
  - backend/src/import/import-post-processing.service.spec.ts
  - backend/src/import/import-post-processing.service.ts
  - backend/src/import/import.service.spec.ts
  - backend/test/integration/import-rate-history-fill.integration.spec.ts
  - backend/test/integration/mny-import.integration.spec.ts
  - docs/backend/securities-and-providers.md
  - docs/specs/fx-history-gap-fill.md
  - website/docs/currency-management.html
  - website/docs/currency-management.md
---

## Decided
- "USD and PLN as optional currencies" came from two system rows: the bootstrap USD (inserted ACTIVE, so findAll listed it to every user) and the bond catalog's PLN (inactive, but findAll(includeInactive) listed every created_by_user_id IS NULL row; the Currencies page and CurrencyRegistryLoader call getCurrencies(true)). Fix: insertSystemCurrencyIfMissing always writes inactive; findAll(includeInactive) lists an inactive system row only with a user preference or when the user's accounts/securities use it.
- With the bootstrap USD inactive, findAll ensures the default currency whenever the user has NO preference row for it (not only when the list is empty). A user who kept the registration default USD never wrote a preference (updatePreferences only ensures on a change). The e2e "lists the default currency" test creates a currency first, so the old empty-list-only fallback would have failed it.
- FX after import: backfillHistoricalRates skips any pair with one stored row, so today's rate from the daily refresh blocked the history. ImportPostProcessingService now runs ExchangeRateHistoryService.fillRateGaps per foreign currency in the background (QIF import awaits post-processing inside the HTTP request; each round may take GAP_FILL_BUDGET_MS), looping up to IMPORT_RATE_FILL_MAX_ROUNDS.
## Tried and ruled out
- Fixing the skip inside backfillHistoricalRates: ExchangeRateService cannot inject the history service (the history service depends on it), and the coverage bookkeeping lives in the history service.
- Adding the loop to exchange-rate-history.service.ts: already over 1000 lines.
## Watch out
- investment-void-classification.guard.spec.ts needs the literal `status != 'VOID'` (or `includes VOID`) within 20 lines of a `FROM investment_transactions`; investmentEffectStatusSql("it") alone does not satisfy it, so write the comment "renders `it.status != 'VOID'`" as the history service does.
- Integration specs run fine against `docker run mirror.gcr.io/library/postgres:16` with DATABASE_PORT set, after `npm run pretest:integration` creates monize_test.
- Neither backend/ nor frontend/ node_modules come installed in a worktree; `npm ci` first. Website doc edits need `npm run docs:build` in frontend/.
