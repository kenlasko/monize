---
title: manage_transactions foreign-currency entries (originalAmount/originalCurrencyCode)
author: Node
date: 2026-11-12
branch: claude/issue-2132
cost: { minutes: 98, tokens: 673447 }
touches:
  - backend/src/common/foreign-entry.util.ts
  - backend/src/transactions/foreign-entry-preview.spec.ts
  - backend/src/transactions/foreign-entry-preview.ts
  - backend/src/transactions/transaction-tool-prep.service.ts
  - backend/src/transactions/transactions.service.spec.ts
  - backend/src/transactions/transactions.service.ts
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/errors.json
---

## Decided
- The entry is resolved once, in `previewForeignEntry` (`backend/src/transactions/foreign-entry-preview.ts`) over the pure `resolveForeignEntry` (`backend/src/common/foreign-entry.util.ts`), called from `TransactionsService.previewCreate` / `previewUpdate`; both tool surfaces only pick the three fields (`pickForeignEntryRequest`) and the prep service adds the market-rate lookup. Every descriptor builder and commit path spreads `foreignEntryWriteFields`, the cards `foreignEntryDisplayFields`; `exchangeRateSource` is display only, never signed.
- Truth table: amount + rate must agree within one unit of the account currency's `decimal_places` (refused otherwise, rewriting neither); amount alone derives the rate with the fee backed out (`fxBaseFromCharged`); rate alone computes the amount; neither uses the market rate (create only).
- On an edit the row's amount is the fact: it stays unless the edit moves it or sends a rate; a figure resent as the row holds it is no change; a new currency needs its own originalAmount; the account's own currency as originalCurrencyCode clears the entry and its originalAmount must equal the amount charged.
- The tools/list cap for manage_transactions was raised by the measured bytes (+397), following the #2094 precedent; flagged in the PR for the owner.

## Tried and ruled out
- Resolving the market rate inside the preview's `withScopedDb`: `getRateForDate` can fetch a provider and persist rows into the joined transaction, so a failed write aborts the preview. The resolver runs outside any transaction and takes a `CurrencyPlacesLoader` instead of a manager.
- Reusing the stored rate when an edit changes only originalAmount (the form's recompute): it replaces the amount charged with a conversion. Re-deriving the rate from the row's amount instead.
- `?? 1` for an absent rate in the write helper and `fx.amount ?? amount`: `fx-fallback.guard.spec.ts` fails both; leave the rate absent and return the row's amount from the resolver.

## Watch out
- Three code-review passes each found real edit-path defects (resent fields, currency change reusing the old-currency amount, tagsOnly when the entry moved the amount, precision of an amount the entry stands in). Any change to the edit branch needs cases for resent-equal figures.
- Tests that mock `previewCreate` with a fixed amount break once splits are validated against `preview.amount`; make the mock echo the input amount.
- The fee inverse also lives inline in `ScheduledTransactionsService.resolveFxForPosting`; not unified here (separate proposal).
