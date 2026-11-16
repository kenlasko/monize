---
title: "Frankfurter's v1 API is ECB-only and starts in 1999; its v2 API blends many central banks and has USD/CAD from 1953"
author: Ken
date: 2026-11-16
branch: feat/desktop-c3-signpath-signing
cost: { minutes: 2, tokens: 40122 }
id: l-65605a48
scope: repo
status: active
src: agent
touches:
  - backend/src/currencies/providers/frankfurter-fx.provider.ts
  - docs/specs/exchange-rate-providers.md
---

## Decided
Nothing changed yet. This explains why USD/CAD history stops at 1999-01-04 even though Frankfurter advertises rates back to 1948.

## Watch out
- The `/v1` API that the adapter calls serves only ECB reference rates, which begin 1999-01-04. Any non-EUR pair is cross-computed through EUR, so nothing exists before 1999.
- `/v2` blends about 100 central-bank providers. `GET /v2/coverage?base=USD&quotes=CAD` reports a start of 1953-05-11. The "1948" figure is the start date of the Bundesbank (BBK) provider, not of USD/CAD.
- v2 is not a drop-in swap of the base URL. It uses different paths and shapes: `/rates?from=&to=&base=&quotes=` returns an array of `{date, base, quote, rate}` instead of `{rates:{date:{Q}}}`, and `/rate/{base}/{quote}?date=` returns a single pair. Blended series can include weekend dates, and a range can start before `from`.
- The `exchange_rate_coverage` rows are keyed by the provider-chain name. If the adapter keeps the name "frankfurter", the stored 1999 floors survive the switch and must be cleared.

In the code: backend/src/currencies/providers/frankfurter-fx.provider.ts (DEFAULT_FRANKFURTER_BASE_URL), docs/specs/exchange-rate-providers.md section 6, entities/exchange-rate-coverage.entity.ts
