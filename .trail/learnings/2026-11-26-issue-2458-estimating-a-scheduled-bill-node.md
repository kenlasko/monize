---
title: "Issue #2458: estimating a scheduled bill entered in another currency"
author: Node
date: 2026-11-26
branch: claude/issue-2458
cost: { minutes: 49, tokens: 299872 }
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
- Maintainer chose option A: a foreign-currency bill's estimate is priced in the biller's (entry) currency and converted per occurrence into the account currency at the newest stored rate with the account's FX fee (spec section 11 of docs/specs/scheduled-amount-estimate.md).
- `ScheduleEstimateBasis.entry` / `ScheduleAmountEstimate.entry` carry it; `estimatedOccurrenceFor` returns account-currency `amount` plus `originalAmount`, so every existing consumer keeps reading account currency unchanged.
- A history payment whose `original_currency_code` equals the estimate's currency counts at `original_amount` (applies to every estimate, a small behaviour change for account-currency bills too).
- Entry-currency or paying-account changes move the snapshot (`entryConversionChanged`) but are not `basisChanged`, so a delegate is not refused them.

## Tried and ruled out
- Folding the account/entry change into `basisChanged`: it triggers `estimateBasisOwnerOnly` for delegates.
- Sending `originalAmount: 0` for an unknown estimate: leaves amount and original_amount disagreeing; the nightly refresh then zeroes amount.

## Watch out
- Three columns are one snapshot for a foreign estimated bill: amount, original_amount, exchange_rate. Create, update, refreshEstimateSnapshot and the posting undo (`estimatedEntry` on ScheduledPostingSnapshot) must write them together.
- The bills list foreign line and the Post dialog seed read `estimatedOccurrenceOriginalAmount`, never `st.originalAmount`.
- Integration specs DO run here with a throwaway `mirror.gcr.io/library/postgres:18` container on a spare port (DATABASE_PORT); insert EUR/USD into `currencies` before `exchange_rates` (FK).
