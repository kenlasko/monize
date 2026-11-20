---
title: "Reset a store a test changed at the start of the next test, not at the end of the one that changed it"
author: Ken
date: 2026-11-20
branch: fix/account-option-base-currency
cost: { minutes: 34, tokens: 136047 }
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

## Tried and ruled out
Resetting with `setState` as the test's last line: the component is still mounted, so the reset re-renders it outside `act()`. The test setup turns any act() warning into a failure ("React logged an act() warning during this test"), so the test fails even though its assertions passed.

## Watch out
The failure message names act(), not the store. Look for a `setState` after the last assertion.

In the code: frontend/src/components/transactions/{Normal,Split,Transfer}TransactionFields.test.tsx reset `usePreferencesStore.setState({ preferences: null })` in `beforeEach`; the frontend has no prettier, so `npx prettier` there fetches an unrelated copy.
