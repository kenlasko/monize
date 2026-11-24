---
title: "Investments Refresh button 'x ago' read created_at (#2385)"
author: Node
date: 2026-11-24
branch: claude/issue-2385
cost: { minutes: 11, tokens: 87376 }
touches:
  - backend/src/backup/support-backup/support-backup-rules.ts
  - backend/src/securities/entities/security-price.entity.ts
  - backend/src/securities/security-price.service.spec.ts
  - backend/src/securities/security-price.service.ts
  - database/migrations/20261124214314_security_prices_refreshed_at.sql
  - database/schema.sql
  - docs/backend/securities-and-providers.md
  - frontend/src/hooks/useInvestmentData.ts
---

## Decided
GET /securities/prices/status (SecurityPriceService.getLastUpdateTime) now orders by COALESCE(refreshed_at, created_at). security_prices.refreshed_at is a new TIMESTAMPTZ stamped NOW() by the quote upsert (savePriceData) on insert and update. created_at never advances on a same-day refresh, which is why the button said "6 hours ago" after reload while "This minute" right after a click (the client used the refresh result's own lastUpdated).
## Tried and ruled out
quoted_at as the answer: it is the provider's strike time, which stays at the 4 PM close after hours, so a reload after an evening refresh would still disagree with the click's "This minute".
## Watch out
exchange_rates has the same shape (getLastUpdateTime orders by created_at, upsert in place) and was not changed. bulkUpsertPrices (settlement/backfill) does not stamp refreshed_at, deliberately: a backfill would otherwise read as a refresh.
