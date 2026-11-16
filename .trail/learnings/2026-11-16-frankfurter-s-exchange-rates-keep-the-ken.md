---
title: "Frankfurter's exchange rates keep the frankfurter_v2 name even though v1 is gone; renaming it would bring back the 1999 history floor"
author: Ken
date: 2026-11-16
branch: feat/frankfurter-v2-provider
cost: { minutes: 3, tokens: 20046 }
id: l-bc3f9ece
scope: repo
status: active
src: agent
touches:
  - backend/src/bank-sync/bank-sync.module.ts
  - backend/src/bank-sync/bank-sync.service.spec.ts
  - backend/src/bank-sync/bank-sync.service.ts
  - ".env.example"
  - README.md
  - backend/src/currencies/currencies.controller.ts
  - backend/src/currencies/currencies.module.ts
  - backend/src/currencies/entities/exchange-rate-coverage.entity.ts
  - backend/src/currencies/exchange-rate-history.service.ts
  - backend/src/currencies/exchange-rate.service.ts
---

## Decided
- The Frankfurter adapter's source slug and breaker id stay `frankfurter_v2` after the v1 adapter was removed on 2026-11-16. Do not tidy the name to `frankfurter`.
- Bank sync starts the same rate-history catch-up after its commit that imports and backup restores do.

## Tried and ruled out
- Renaming the slug to `frankfurter`, two reasons:
  - The blend's rows would carry the slug of the ECB-only rows v1 wrote.
  - The coverage fingerprint, the chain's source slugs joined, would equal v1's again (`frankfurter,yahoo_finance,yahoo_crypto`). The stored "history starts 1999-01-04" floors would then be trusted, and no gap fill would ever reach before 1999.
- Removing `frankfurter` from the source guard's ban list: a retired slug still has stored rows, so code must not write it by hand.

## Watch out
- A `provider_health` row under the old id `frankfurter` is never written again. An alert for it shows the raw id.

In the code: backend/src/currencies/providers/frankfurter-v2-fx.provider.ts, exchange-rate-history.service.ts (providerFingerprint), fx-provider-source.guard.spec.ts (PROVIDER_SOURCE_SLUGS), bank-sync/bank-sync.service.ts (rateHistoryCatchUp.start "Post-sync"); docs/specs/frankfurter-v2-provider.md section 8
