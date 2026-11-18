---
title: "Investment form: typed price + typed total puts the remainder in commission"
author: Node
date: 2026-11-18
branch: claude/issue-2267
cost: { minutes: 6, tokens: 98825 }
touches:
  - frontend/src/components/investments/InvestmentTransactionForm.test.tsx
  - frontend/src/components/investments/InvestmentTransactionForm.tsx
  - frontend/src/i18n/messages/de/investments.json
  - frontend/src/i18n/messages/en/investments.json
  - frontend/src/i18n/messages/es/investments.json
  - frontend/src/i18n/messages/fr/investments.json
  - frontend/src/i18n/messages/hi/investments.json
  - frontend/src/i18n/messages/id/investments.json
  - frontend/src/i18n/messages/it/investments.json
  - frontend/src/i18n/messages/ja/investments.json
---

## Decided
Issue #2267: in `InvestmentTransactionForm.handleTotalAmountChange`, when `typedPriceBasis` is a person-typed price (kind 'price'), a total above qty x price (buy/reinvest) or below it (sell) writes the remainder to `commission` and keeps the typed price. Otherwise the old behaviour (price follows total) stands. Redemptions (`supportsAccruedInterest`) are excluded: their total carries the engine's accrued interest. A `commissionFromTotal` ref marks a commission the handler wrote so a later total with no remainder clears it; a person's own commission edit resets the ref and is kept.
## Watch out
`NumericInput` calls onChange on every keystroke, so typing 1005 passes through 1, 10, 100. The fallback must not switch the basis to 'total' while a typed price exists, or the final keystroke loses it; tests type totals character by character for that reason. The scheduled-transaction surfaces (ScheduledTransactionForm, PostTransactionDialog, OverrideEditorDialog) derive quantity from a typed total instead and were left unchanged.
