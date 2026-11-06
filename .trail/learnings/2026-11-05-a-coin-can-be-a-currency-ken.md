---
title: "A coin can be a currency after all: a CRYPTO currency kind priced through its Yahoo pair, held in a CRYPTO wallet account; the four-place money limit stands"
author: Ken
date: 2026-11-05
branch: claude/crypto-account-currency
id: l-807fd2a1
scope: repo
status: active
replaces: l-6c985800
src: agent
touches:
  - docs/specs/crypto-accounts.md
  - docs/future-plans/crypto-accounts.md
  - backend/src/currencies/providers/crypto-fx.provider.ts
  - backend/src/accounts/account-currency-kind.util.ts
  - frontend/src/lib/currency-decimals.ts
---

## Decided

Cryptocurrency now has two models. A coin held as an investment stays a CRYPTO security in a fiat brokerage account (unchanged). A coin a person spends and transfers is a currency of kind CRYPTO, held in an account of the new type CRYPTO, one coin per account. The earlier "Bitcoin as a currency is ruled out" rested on two facts; one is removed and one is kept:

- No rate source: solved by a crypto exchange rate provider that is always the last provider in the chain and never an `FX_PROVIDERS` token. It prices `<coin ticker>-<fiat>` through the same Yahoo chart calls securities use, against every fiat in use (BTC mapped to `BTC-EUR` is still priced against CAD via `BTC-CAD`), because `resolveFxRate` has no pivot currency. The chain gained `claims(code)`: a pair with a claimed (coin) code goes only to the claiming provider, because Yahoo's fiat adapter `carries` everything and would otherwise be asked `BTCCAD=X`. A weekend cron refreshes crypto pairs only. Source slug `yahoo_crypto`.
- Four decimal places: kept. Money is decimal(20,4) everywhere; a crypto currency defaults to 4 and cannot exceed it. A fee under 0.0001 coin rounds to zero; the docs say to book it in fiat or fold it into the transfer. Widening money precision is a separate proposal, as is widening the three-letter currency code (the price symbol carries the real ticker, so `DOG` maps to `DOGE-USD`).

A currency's `kind` (FIAT or CRYPTO) is a stored statement by the user, never inferred from "not an ISO code". An account of type CRYPTO must use a CRYPTO currency and nothing else may (INV-CRYPTO-001, service-level on every account writer, `partial`: no trigger; undo of an account delete and restore bypass it). A security's currency is never a coin. A transfer with a network fee is an ordinary split (transfer line plus expense line), no new mechanism.

The client formats money from Intl, which gives any unknown code two places; a currency decimals registry, filled once per session, now supplies the stored places for non-ISO codes only, so fiat rendering cannot shift.

## Tried and ruled out

- A foreign key from the currency to a security row: securities are per user, a rate is shared.
- Teaching the Yahoo fiat adapter the `-` symbol form: its `carries` is always true and its placeholder cross-check is for `=X` pairs; a separate adapter keeps the grammars apart.
- Counting `user_currency_preferences` when refusing a kind change: the creator always has one, so the kind was immutable from birth. A second SQL function ignores that table.
- Letting the decimals registry override Intl for ISO codes too: a stored `decimal_places` that differs from ISO would change how existing fiat balances render.

## Watch out

- `ALTER TYPE account_type ADD VALUE` had never been done before; the value cannot be used in the same migration.
- Every exhaustive account-type list is hand-copied (about 10 places per layer, plus AI/MCP zod `.max(10)` caps now 11); the inventory is in the plan.
- The frontend `type-check` is red the moment an `en/common.json` key exists without every locale, because `global-error.tsx` types every locale as `typeof enCommon`.
- The demo seed must upsert the BTC currency before the wallet account (FK), so the crypto rate seed runs first.

In the code: `docs/specs/crypto-accounts.md`, `docs/future-plans/crypto-accounts.md` (the inventory), `backend/src/currencies/providers/crypto-fx.provider.ts`, `FxProviderChain.claims`, `ExchangeRateService.refreshCryptoRates`, `backend/src/accounts/account-currency-kind.util.ts`, `currency_code_referenced_by_data`, `frontend/src/lib/currency-decimals.ts`, `CurrencyRegistryLoader`, migrations `20261105182924`, `20261105183544`, `20261105195749`.
