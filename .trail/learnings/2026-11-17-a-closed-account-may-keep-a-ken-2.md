---
title: "A closed account may keep a non-zero balance that still counts, and a closed card's credit limit counts as zero"
author: Ken
date: 2026-11-17
branch: feat/close-nonzero-balance
cost: { minutes: 4, tokens: 17962 }
id: l-e619afb2
scope: repo
status: active
replaces: l-88c0bce3
src: agent
touches:
  - backend/src/accounts/account-carries-balance.spec.ts
  - backend/src/accounts/account-carries-balance.ts
  - backend/src/accounts/accounts.controller.ts
  - backend/src/accounts/accounts.service.spec.ts
  - backend/src/accounts/accounts.service.ts
  - backend/src/currencies/currencies.service.spec.ts
  - backend/src/currencies/currencies.service.ts
  - backend/src/currencies/exchange-rate.service.spec.ts
  - backend/src/currencies/exchange-rate.service.ts
  - backend/src/i18n/locales/de/errors.json
---

## Decided
Ken decided on 2026-11-17 that an account can be closed with money still in it; the zero-balance rule came from the first scaffold with no reason given. A close still refuses holdings in an investment account and future-dated transactions (A26-M12), since either would move the balance afterwards. The balance left is frozen until the account is reopened, and still counts in net worth, the account summary's total balance, the Accounts page money cards, credit utilization, the exchange-rate refresh and backfill, and currency usage counts. A closed account at zero stays out; account lists and pickers show only open accounts.

Credit utilization: a closed card owing a balance counts its balance as used and its limit as zero (Ken's call over keeping the recorded limit, which inflated available credit). Its row reads 100% used and -balance available.

## Tried and ruled out
Loading closed accounts into every dashboard widget: many assume open accounts. The dashboard loads every account once and passes `accountsWithClosed` only to the two credit-utilization widgets.
Counting a closed card at its recorded limit: its credit is gone, so it flattered utilization.

## Watch out
A closed account cannot be edited, so the confirm dialog tells the user to switch on exclude-from-net-worth before closing. Close is disabled only by securities (combined value minus cash); a brokerage the portfolio does not report reads as unknown and keeps Close disabled, as before. `trail check` flags lexical false positives on this change.

In the code: backend/src/accounts/account-carries-balance.ts and frontend/src/lib/account-carries-balance.ts; effectiveCreditLimit in frontend/src/lib/credit-utilization.ts; securitiesValueOf / cashBalanceOf in frontend/src/lib/logical-accounts.ts; docs/backend/transactions-and-money.md "A closed account keeps its balance".
