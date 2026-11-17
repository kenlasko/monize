---
title: "A closed account may keep a non-zero balance, and that balance still counts everywhere balances are summed"
author: Ken
date: 2026-11-17
branch: feat/close-nonzero-balance
cost: { minutes: 25, tokens: 355950 }
id: l-88c0bce3
scope: repo
status: active
replaces: l-f742ef99
src: agent
touches:
  - backend/src/accounts/accounts.service.ts
  - backend/src/accounts/accounts.service.spec.ts
  - backend/test/integration/account-close-pending.integration.spec.ts
  - backend/src/accounts/account-carries-balance.ts
  - backend/src/accounts/account-carries-balance.spec.ts
  - frontend/src/lib/account-carries-balance.ts
  - frontend/src/app/transactions/page.tsx
  - frontend/src/lib/logical-accounts.ts
  - docs/backend/transactions-and-money.md
---

## Decided
Ken decided on 2026-11-17 that an account can be closed with money still in it. The zero-balance check came from the first scaffold and nobody could give a reason for it, and the Money importer already created closed accounts with a balance. A close still refuses two things, because either would move the balance after the account is closed: holdings in an investment account, and future-dated transactions (A26-M12). The balance left behind is frozen; to change it, reopen the account. It still counts: net worth, the account summary's total balance, the Accounts page money cards, credit utilization (at the card's recorded limit), the exchange-rate refresh and backfill, and the currency usage counts all include a closed account whose balance is not zero. A closed account at zero stays out. Lists of accounts (pickers, the AI and MCP account rows, reconcile) still show only open ones.

## Tried and ruled out
Loading closed accounts into every dashboard widget: many widgets assume open accounts. The dashboard now loads every account once and keeps two lists. `accounts` (open only) goes to every widget as before, and `accountsWithClosed` goes only to the two credit-utilization widgets.

## Watch out
Because a closed account cannot be edited, the confirm dialog tells the user to switch on exclude-from-net-worth before closing. The Close action is now disabled only by securities, measured as combined value minus cash. A brokerage the portfolio does not report reads as unknown, not zero, so Close stays disabled for it, as it already was. `trail check` flags lexical false positives on this change (backfill wording, "twin", Name/Balance tests, the generated search index).

In the code: backend/src/accounts/account-carries-balance.ts (accountCarriesBalance, accountCarriesBalanceSql) and its frontend twin frontend/src/lib/account-carries-balance.ts; securitiesValueOf / cashBalanceOf in frontend/src/lib/logical-accounts.ts; docs/backend/transactions-and-money.md "A closed account keeps its balance".
