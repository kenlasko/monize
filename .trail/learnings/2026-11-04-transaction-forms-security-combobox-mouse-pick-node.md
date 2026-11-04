---
title: "Transaction forms: security combobox, mouse-pick focus, auto-grow description"
author: Node
date: 2026-11-04
branch: claude/issue-2009
cost: { minutes: 22, tokens: 282603 }
touches:
  - frontend/src/components/transactions/TransactionForm.test.tsx
  - frontend/src/components/transactions/TransactionForm.tsx
  - frontend/src/hooks/useAutoGrowTextarea.test.ts
  - frontend/src/hooks/useAutoGrowTextarea.ts
  - website/docs/search-index.json
  - website/docs/transactions.html
  - website/docs/transactions.md
  - e2e/docs-screenshots/investments.spec.ts
  - e2e/tests/investments.spec.ts
  - frontend/src/app/investments/page.tsx
---

## Decided
- Issue #2009: InvestmentTransactionForm's Security is a `Combobox` (aria-label "Security", usePortal, valueIsId); "+ Create" opens SecurityForm with `securityDefaultsFromTypedText` (one word = symbol, uppercased; words = name). Transfers keep held-only options and no Create.
- Modal width for every host of the investment form comes from `investmentTransactionModalClass` in `components/investments/investment-transaction-modal.ts`, a module of its own because the host pages' tests `vi.mock` the form module wholesale.
- "Create & New" carries the action through the wrapper's restart state (`defaultAction`), beside the account.
- Cash TransactionForm description is a rows=1 textarea auto-fitted by `hooks/useAutoGrowTextarea` (stable callback ref, merged with the register ref inline).

## Tried and ruled out
- Blaming the split editor for the Tab-to-app-menu bug: the cause was Combobox option rows taking the mousedown (focus left the input, the row then unmounted). Fixed once in Combobox with preventDefault on row mousedown.

## Watch out
- Tests pick a Combobox option with `chooseComboboxOption` (`src/test/combobox.ts`). Typing via fireEvent.change within 100ms of a focus/click open is ignored by Combobox (justOpenedRef), so change without clicking first.
- InvestmentTransactionForm.test.tsx: `getSecurities` mockResolvedValue leaks across describes; the top-level beforeEach now resets it, and `chooseSecurity(id)` reads the symbol from the mock's last result.
