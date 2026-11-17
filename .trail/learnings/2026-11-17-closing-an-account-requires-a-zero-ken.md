---
title: "Closing an account requires a zero balance only because the first scaffold did; dropping it is a net-worth consistency question, not a data-integrity one"
author: Ken
date: 2026-11-17
branch: fix/windows-beta-publish
cost: { minutes: 7, tokens: 87879 }
id: l-f742ef99
scope: repo
status: active
src: agent
touches:
  - backend/src/accounts/accounts.service.ts
  - frontend/src/components/accounts/AccountRow.tsx
  - frontend/src/app/accounts/page.tsx
  - backend/src/net-worth/net-worth.service.ts
  - backend/src/currencies/exchange-rate.service.ts
  - frontend/src/lib/credit-utilization.ts
  - docs/backend/transactions-and-money.md
  - docs/specs/investment-account-consolidation.md
---

## Decided
Nothing decided yet (2026-11-16). This was an investigation for a user who asked why an account must be at zero before it can be closed. The rule came in with the very first accounts commit (8554d7d64, Jan 2026), and nothing in the code, docs or ADRs gives a reason for it. Two later checks in the same close path have real reasons and should stay whatever is decided: no future-dated rows (A26-M12), and no open holdings in a brokerage pair (the brokerage balance is always 0, so the balance check says nothing about holdings).

## Tried and ruled out
Looked for data-integrity breakage from a closed account that still has a balance, and found none. The Money (.mny) importer already writes closed accounts whatever their balance, so production already has some. A closed account is frozen. Every balance write is refused: updateBalance with openOnly, assertAccountOpen, assertAccountsOpen, import, bank sync, loan settlement, rate change, and account edit, including the exclude-from-net-worth flag. Reopen has no conditions, so it is the way back in.

## Watch out
A closed account's balance is counted inconsistently. That is invisible at zero and visible once the account holds money.
- Counted: server net worth, because monthly snapshots keep every account and run to the current month. That feeds the dashboard net worth and the totals in getSummary and getLlmAccounts. The accounts-list group headers also count it.
- Left out: the accounts page summary cards, getSummary.totalBalance, the Account Balances report (open by default), forecasts (frontend and AI), credit utilization, the portfolio, the AI/MCP account rows, balance alerts, and the exchange-rate refresh and backfill. Leaving it out of the refresh means a closed foreign-currency account's rate goes stale, and the read-path rate fill only partly makes up for that.
- The frontend enforces the rule too, so it would need changing as well.
In the code: backend/src/accounts/accounts.service.ts close(); frontend/src/components/accounts/AccountRow.tsx balanceNonZero; frontend/src/app/accounts/page.tsx summary; backend/src/net-worth/net-worth.service.ts recalculateAllAccounts; backend/src/currencies/exchange-rate.service.ts currenciesInUse; frontend/src/lib/credit-utilization.ts; i18n keys closeNonZeroBalance, closeTitleDisabled, confirmDialog.closeMessage; docs/backend/transactions-and-money.md "A closed account holds zero"; docs/specs/investment-account-consolidation.md. The wiki Accounts.md "Closing Accounts" section is out of date (it describes a toggle that does not exist).
