---
title: Crypto is tracked as securities priced by the fiat leg of a Yahoo coin symbol; Bitcoin as a currency is ruled out
author: Ken
date: 2026-11-04
branch: claude/crypto-securities-2005
id: l-fe2ecd90
scope: repo
status: active
src: agent
touches:
  - backend/src/securities/market-indexes.spec.ts
  - backend/src/securities/msn-finance.service.spec.ts
  - backend/src/securities/msn-finance.service.ts
  - backend/src/securities/providers/crypto-pair.util.spec.ts
  - backend/src/securities/providers/crypto-pair.util.ts
  - backend/src/securities/rls-context-smoke.spec.ts
  - backend/src/securities/security-enums.ts
  - backend/src/securities/security-price.service.spec.ts
  - backend/src/securities/security-price.service.ts
  - backend/src/securities/yahoo-finance.service.spec.ts
---

## Decided

Cryptocurrency is tracked as securities (type CRYPTO, a Yahoo `<COIN>-<FIAT>` symbol such as `BTC-EUR`) held in an investment account in the user's fiat currency. The currency of such a security is the fiat leg of its symbol; the exchange is the canonical `CRYPTO`, not Yahoo's `CCC`. A second cron tick on Saturday and Sunday refreshes and settles only CRYPTO securities, because a coin's Yahoo session is the UTC day and the weekday run never fetched weekend bars. A dedicated CRYPTO account type was judged a separate, later step (around 33 backend and 25 frontend files compare against INVESTMENT to decide "holds securities"; it needs a shared helper plus a guard before it is safe).

## Tried and ruled out

Bitcoin as a currency (what the reporter of Discussion #2005 tried first). Money is decimal(20,4) and the currency DTO caps decimal places at 4, Frankfurter carries no crypto, and Yahoo has no `BTCEUR=X` symbol (only `BTC-EUR`), so a BTC currency can never get a rate. The Currencies page now says so when a non-ISO code is typed.

Keying the weekend tick or the alternates suppression on `exchange`: securities created before this change still carry `CCC`, so the cron keys on `security_type = 'CRYPTO'`; alternates accept either `CRYPTO` or `CCC`.

## Watch out

The root cause of #2005 and #379 was `getCurrencyFromExchange` in the Yahoo lookup returning USD for any dotless symbol, so `BTC-EUR` was saved as USD and every EUR price was then refused by `verifyProviderCurrency` (INV-PRICE-001, correct). Existing crypto securities saved that way are not migrated; the user edits the currency.

The `market-indexes.spec.ts` "every exchange has a benchmark" test is a decision point, not a baseline: CRYPTO is recorded there as the exchange without one.

Frontend `npm run lint` on main fails with 6 `react-hooks/set-state-in-effect` errors (dependabot bump of eslint-plugin-react-hooks, 2026-11-02) in files this branch does not touch.

In the code: `backend/src/securities/providers/crypto-pair.util.ts`, `YahooFinanceService.toLookupResult`, `SecurityPriceService.scheduledWeekendCryptoRefresh`, `frontend/src/lib/iso-currency.ts`, `CurrencyForm` crypto notice, `website/docs/investments.md#cryptocurrency`.
