---
title: "An aggregate in a row's own currency is read at the column scale and rounded only after conversion; writers read a currency's places under a key-share lock"
author: Ken
date: 2026-11-06
branch: claude/crypto-account-currency
id: l-dab37d01
scope: repo
status: active
src: agent
touches:
  - backend/src/common/money-precision.guard.spec.ts
  - backend/src/common/currency-places.util.ts
  - backend/test/integration/money-precision.integration.spec.ts
  - docs/concurrency-and-idempotency.md
---

## Decided

- A SQL aggregate grouped by currency (the built-in reports' per-category sums) is an amount in that row's own currency until it is converted, so it is read at the column scale (8) and rounded only once it is in the reporting currency. Reading it at the fiat default first turned a 2,500-satoshi fee into 0 and cost 7% on a coffee in BTC. A repo-wide guard refuses a bare toMoneyNumber call so the next aggregate reader must state the scale.
- A precision refusal keys on the value the row will hold, not on the field being present: moving a row, a split parent, a transfer leg or a schedule to an account in another currency re-checks the stored amount (and stored split lines) against the target currency.
- Writers read a currency's decimal places under FOR KEY SHARE, the same pattern as the kind gate, so a lowering of decimal places in flight (FOR UPDATE on the currency row, then a cross-tenant SECURITY DEFINER scan) is waited out and re-read; readers keep an unlocked read. A two-connection test holds it in both orders.
- A support copy scales each amount at its own account's precision; one global 8-place scale made fiat rows carry six places after multiplication, which a later edit would refuse.

## Tried and ruled out

Scanning the lowering gate's columns under the caller's row-level security: it sees only the editing user's rows while a user-created currency can carry other users' rows. The scan is a SECURITY DEFINER function, like the kind gate's.

## Watch out

- Transfer create and the frozen, cross-owner and split-leg transfer edits still read places in their own transaction before the write, so a lowering that starts after that read can slip in; only the same-owner transfer update re-checks inside its write.
- The rounding nudge path in roundToDecimals hands over to exact string rounding at 0.01 units; between 1e6 and 4.5e6 at 8 places the old limit rounded some values one unit high.
- The adversarial protocol found a MEDIUM (the reports) that the standard review and five implementation agents all missed; run it on any money change.

In the code: `backend/src/built-in-reports/*.service.ts` (`toMoneyNumber(x, MONEY_SCALE)`), `backend/src/common/money-precision.guard.spec.ts`, `backend/src/common/currency-places.util.ts` (`loadCurrencyPlaces` locked, `loadCurrencyPlacesForRead`), `currency_min_decimal_places_in_use`, `CurrenciesService.assertDecimalPlacesFit`, `backend/test/integration/money-precision.integration.spec.ts`, `support-backup-scope.ts` (`moneyDecimalsResolver`), `docs/concurrency-and-idempotency.md` section 8.
