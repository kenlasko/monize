---
title: "Reset a store a test changed at the start of the next test, not at the end of the one that changed it"
author: Ken
date: 2026-11-20
branch: fix/account-option-base-currency
cost: { minutes: 48, tokens: 209445 }
id: l-dea128d1
scope: repo
status: active
src: agent
touches:
  - docs/specs/investment-account-consolidation.md
  - e2e/docs-screenshots/rules.spec.ts
  - frontend/src/components/transactions/NormalTransactionFields.test.tsx
  - frontend/src/components/transactions/SplitTransactionFields.test.tsx
  - frontend/src/components/transactions/TransferTransactionFields.test.tsx
  - frontend/src/hooks/useMainAccountName.test.tsx
  - frontend/src/hooks/useMainAccountName.ts
  - frontend/src/lib/logical-accounts.test.ts
  - frontend/src/lib/logical-accounts.ts
  - backend/src/common/jobs/job-claim.module.ts
---

## Decided
A component test that sets a Zustand store (for example the user's default currency) resets it in the file's `beforeEach`, before anything renders. It does not reset at the end of the test that changed it.
Ken (2026-11-20): every account and security picker shows the currency in brackets only when it is not the reader's base currency. Account pickers built from the shared dropdown builder label through the shared account labeller. The rest (investment form, loan and mortgage payment-from, bank sync, Monte Carlo, GEM, the security list) apply only the currency rule and keep the names they showed before.

## Tried and ruled out
Resetting with `setState` as the test's last line: the component is still mounted, so the reset re-renders it outside `act()`. The test setup turns any act() warning into a failure ("React logged an act() warning during this test"), so the test fails even though its assertions passed.
Moving those eight pickers onto the shared account labeller: it also strips the " - Brokerage"/" - Cash" pair suffix, so a list holding both halves of a pair would show two identical "TFSA" rows, and the investment form's brokerage and cash pickers would change names. That is a separate decision from the currency rule.
A row for the rule in the frontend instruction index: it pushes the file over its 16384-byte ceiling, which may not be raised. The source-scanning guard and the ui-conventions entry carry the rule instead.

## Watch out
The failure message names act(), not the store. Look for a `setState` after the last assertion.

In the code: frontend/src/components/transactions/{Normal,Split,Transfer}TransactionFields.test.tsx reset `usePreferencesStore.setState({ preferences: null })` in `beforeEach`; the frontend has no prettier, so `npx prettier` there fetches an unrelated copy.
A user with no saved preference compares against the fallback currency (USD), so a USD fixture in a test shows no code. That is why six existing tests changed.

In the code: labelWithForeignCurrency in frontend/src/lib/default-currency.ts; useAccountOptionLabel and useForeignCurrencyLabel in frontend/src/hooks/useMainAccountName.ts; buildAccountDropdownOptions now requires labelFn; guard "a picker shows a currency code only outside the default currency" in frontend/src/test/ui-conventions.test.ts.
