---
title: "Issue #2255: holdings list symbol links dead on the account detail page"
author: Node
date: 2026-11-19
branch: claude/issue-2255
cost: { minutes: 7, tokens: 61329 }
touches:
  - frontend/src/components/accounts/investment-detail/InvestmentDetailView.test.tsx
  - frontend/src/components/accounts/investment-detail/InvestmentDetailView.tsx
  - frontend/src/components/investments/GroupedHoldingsList.test.tsx
  - frontend/src/components/investments/GroupedHoldingsList.tsx
  - frontend/CLAUDE.md
---

## Decided
- Cause: `InvestmentDetailView` rendered `GroupedHoldingsList` without `onSecurityClick` / `onCashClick`; the list calls them with `?.`, so the links rendered but did nothing. Fixed by passing the same routes as `useInvestmentData` (`/securities/{id}`, `/transactions?accountId={cashId}`).
- Made both handlers required props on `GroupedHoldingsList` and `HoldingRow` so a future caller gets a type error instead of a dead link. The list's tests spread a shared `clickHandlers` object.

## Tried and ruled out
- Moving the navigation into `GroupedHoldingsList` itself (useRouter inside): a larger refactor touching the Investments page; not needed for the fix.
- Converting the name button to `useLongPress` on the `<tr>` (the frontend/CLAUDE.md convention): an unrelated refactor; noted in the PR, not done.

## Watch out
- `InvestmentDetailView.test.tsx` stubs `GroupedHoldingsList`; the stub now exposes the handlers as "open security" / "open cash" buttons. A change to the props has to update that stub too.
- Fresh worktree: `npm ci --ignore-scripts` in frontend/ before vitest; run with TZ=UTC.
