---
title: "Estimated scheduled amounts (issue #2096): how the estimate reaches every surface"
author: Node
date: 2026-11-10
branch: claude/issue-2096
cost: { minutes: 118, tokens: 878486 }
touches:
  - docs/future-plans/scheduled-amount-estimate-tasks.md
  - docs/specs/scheduled-amount-estimate.md
  - backend/src/i18n/locales/de/emails.json
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/es/emails.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/emails.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/emails.json
  - backend/src/i18n/locales/hi/errors.json
---

## Decided
- `scheduled_transactions.amount_is_estimated`; the estimate is computed on read by `ScheduledAmountEstimateService` (24 months of payee+category payments, split lines included, today's stored rate via `getRateForDate(..., { fetchMissing: false })`), never stored per occurrence. `amount` is only a snapshot, refreshed on save and after each post.
- Per-month pricing happens in `ScheduledOccurrenceService.priceEstimatedOccurrences` after slot expansion, because the resolver has one base amount per schedule. `findAll` sends `amountEstimate.months` for the client forecast. `occurrenceFollowsEstimate` (one per layer) decides that an override stating an amount or its own split lines governs its occurrence.
- An unknown estimate is null with its status. It sets `settlementPair` to the missing pair, and the balance forecast reports it as `unknownEstimate`, never as a missing settlement rate.
- Delegates: the preview route is closed, the toggle is dropped from their create/update, they cannot change an estimated bill's payee or category, and `findAll` withholds `paymentCount` and `latestPaymentDate`.
- No CHECK constraint (expanding migration); auto-post is refused in the service, both cron candidate reads and under the lock.

## Tried and ruled out
- Folding the estimate into `ScheduledEffectiveAmountService` base: one figure per schedule can't be seasonal.
- `Promise.all` of `resolveMany` and `estimateMany`: they may share an ambient transaction's connection.

## Watch out
- The MCP `list_upcoming_bills` description sits at its byte budget (2510); any addition needs an equal cut.
- The client read model covers at most 24 months back and 24 ahead; outside it the client says unknown while the server can price.
- `occurrence-selection.guard.spec.ts` counts base reads per file exactly; findAll is now 1.
