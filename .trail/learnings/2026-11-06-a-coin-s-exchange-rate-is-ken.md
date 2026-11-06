---
title: "A coin's exchange rate is stored coin-first whatever the codes sort to, and a pair nobody can price is never remembered as empty"
author: Ken
date: 2026-11-06
branch: claude/crypto-account-currency
id: l-a0bcc344
scope: repo
status: active
src: agent
touches:
  - docs/specs/exchange-rate-canonical-orientation.md
  - docs/future-plans/exchange-rate-canonical-orientation-tasks.md
---

## Decided

- A pair with exactly one coin side is stored coin -> fiat regardless of code order. The code-order rule was built for fiat ratios (at most ~1e5); a coin against IDR or KRW is ~1e9, and 1/1.52e9 at ten decimals is 0.0000000007, which inverts back 6% off. A stored rate at or above 1e10, or one that rounds to zero, is refused as out of range for that one pair rather than failing a batch. Coverage keys and the coverage CHECK stay code-ordered; only the rate rows changed.
- The planned contract migration CHECK (from_currency < to_currency) must exclude pairs with a CRYPTO side or become a trigger that reads the currency kind, because as written it would invert and delete the coin-first rows.
- A coverage floor and an empty-window memory are written only for a pair some provider carries, and a coin's coverage is cleared when its price symbol is mapped or re-pointed. Why: a fill on an unmapped coin wrote a floor dated today, the floor outlived the mapping, and the coin's past stayed unknown for every user with no way to repair it.
- The crypto provider answers "could not say" for a code its snapshot lacks (after one throttled re-read). Why: every code in use has a currencies row, so absence means a stale snapshot, and answering "not a coin" routes the pair to the fiat Yahoo adapter, whose carries() is always true.
- A coin cannot be the reporting currency (every converted figure would be four-place coin), and a referenced coin's ticker cannot be re-pointed (rates are global; the fiat leg may change because the provider prices against whichever fiat the pair names).

## Tried and ruled out

Widening the rate columns beyond NUMERIC(20,10) to keep code order: a schema change on every rate column for a problem the orientation rule solves alone.

## Watch out

- Every exhaustive account-type list, the AI/MCP zod `.max(n)` caps and the frontend `global-error.tsx` locale typing fire the moment a type or an `en` key is added; translate before type-checking.
- The adversarial protocol (`/audit`) found eleven real items a standard review missed, most of them precision and routing edge cases; run it before a PR of this size.

In the code: `canonical-rate.util.ts` (`isCanonicalOrientation(from,to,isCoin)`, `canonicalRateRefusal`), `currencies/coin-lookup.ts`, `FxProviderChain` (`carried`), `ExchangeRateHistoryService.forgetEmptyWindowsFor`, `CurrenciesService.kindUpdates`, `crypto-fx.provider.ts` (`factsOf`), `assertReportingCurrencyIsFiatIn`, `docs/specs/exchange-rate-canonical-orientation.md` section 12, `docs/future-plans/exchange-rate-canonical-orientation-tasks.md` T2 note.
