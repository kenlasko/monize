---
title: "Investments page cash register already prints the day close; brokerage list has no Folio/Pebble (issue #2508)"
author: Node
date: 2026-11-28
branch: claude/issue-2508
cost: { minutes: 4, tokens: 107053 }
touches:
  - frontend/src/components/transactions/TransactionList.uiStyles.test.tsx
  - CLAUDE.md
---

## Decided
- The Investments page's cash register is the shared `TransactionList`, so #2486's phone day close (Folio wrapped card, Pebble below md) already works there whenever exactly one cash account is selected. Pinned by `renderInvestmentsCashRegister()` in `frontend/src/components/transactions/TransactionList.uiStyles.test.tsx` (densityView "investments", no sort, seed passed).
- Asked the maintainer before building anything further: (1) whether several cash accounts should get a combined close, and (2) what "Folio/Pebble styling" means for the brokerage tab.
## Tried and ruled out
- Treating "the heading shows the day net" as a frontend bug: with several cash accounts, `app/investments/page.tsx` passes `startingBalance` undefined and the backend (`transactions.service.ts`, `multiAccountSeed`) seeds several accounts only when a content filter is on. That makes it a backend scope question, not a UI fix.
## Watch out
- `InvestmentTransactionList` has no `useUiStyle` branch at all. Its phone layout is `wrapped = isMobile && density === 'normal'` with a per-row card (`InvestmentTransactionCardBody`). A day figure for trades would be a client-side sum across rows in different currencies, which the frontend CLAUDE.md investment-row rule forbids.
- A fresh worktree has no `frontend/node_modules`; run `npm ci` first, or vitest fails with "Cannot find module vitest/config".
