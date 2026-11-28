---
title: "Duplicate and quick fill for investment transactions (issue #2482)"
author: Node
date: 2026-11-28
branch: claude/issue-2482
cost: { minutes: 45, tokens: 357413 }
touches:
  - frontend/src/components/investments/InvestmentTransactionForm.duplicate.test.tsx
  - frontend/src/app/investments/page.test.tsx
  - frontend/src/app/investments/page.tsx
  - frontend/src/components/investments/InvestmentRegisterPanel.tsx
  - frontend/src/components/investments/InvestmentTransactionForm.tsx
  - frontend/src/components/investments/InvestmentTransactionList.tsx
  - frontend/src/components/investments/RecentInvestmentTransactionsPopover.tsx
  - frontend/src/hooks/useInvestmentData.ts
  - frontend/src/i18n/messages/de/investments.json
  - frontend/src/i18n/messages/es/investments.json
---

## Decided
- Duplicate on the brokerage register is a `RowAction` (key 'duplicate', icon 'duplicate', tone 'neutral') in `buildInvestmentTxActions`, shown only when the list gets `onDuplicate`. The register uses the shared RowActions, not the cash register's CopyDropdown.
- `InvestmentTransactionForm` takes `duplicateFrom`. `transaction` wins over it, and the wrapper drops it after Create & New, as TransactionForm does. Duplicate and quick fill share `copiedFieldsFrom` in the form file, so they cannot copy different things.
- A copy never carries the exchange rate (it is for the source's trade date, INV-FX-001) or the bond series (re-derived from the date). Transfer legs become the create-only 'TRANSFER'; a duplicate reads the paired leg for the other account.
- The history popover (`RecentInvestmentTransactionsPopover`) reuses `GET /investment-transactions` with a new `securityId` filter (ParseUUIDPipe), plus `limit` from `recentTransactionsLimit`. No new endpoint.
- Quick fill keeps the account and date on screen, but fills an empty account from the picked row, because with no account the list spans every account.

## Tried and ruled out
- Filtering the popover by `symbol`: one symbol can name two securities, so it filters by id.
- Putting the duplicate id in the form's `key`: Modal unmounts its children on close, so the key is not needed, and changing it on Create & New would remount the form and lose its restart state.

## Watch out
- Quick fill must reset `rateEditedRef`, or a rate typed for the previous entry blocks the lookup for the new pair.
- New popovers hit two frontend guards: the inline-hover fingerprint in ui-conventions (use `HOVER_ROW_ON_CARD`, or `Button variant="outline"` for the trigger) and linkified-description (classify the new render in PLAIN).
- `toHaveValue` does not take asymmetric matchers. In this test env the Security combobox reads "SYM - Name (CAD)", because foreignCurrencyLabel reads the preferences store, not the mocked useNumberFormat.
