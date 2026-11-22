---
title: "Issue #2323 CI round: the inactive-security residual cleanup now needs Activate first"
author: Node
date: 2026-11-22
branch: claude/issue-2323
cost: { minutes: 15, tokens: 71871 }
touches:
  - docs/system-invariants.md
  - website/docs/investments.md
  - frontend/src/components/securities/SecurityTransactionHistory.test.tsx
  - frontend/src/components/securities/SecurityTransactionHistory.tsx
  - frontend/src/i18n/messages/de/securities.json
  - frontend/src/i18n/messages/en/securities.json
  - frontend/src/i18n/messages/es/securities.json
  - frontend/src/i18n/messages/fr/securities.json
  - frontend/src/i18n/messages/hi/securities.json
  - frontend/src/i18n/messages/id/securities.json
---

## Decided
The security detail page's Transactions tab (SecurityTransactionHistory + SecurityShareAdjustmentForm) was built to clear stray shares on an INACTIVE security, and security-transaction-history.integration.spec.ts asserted that. INV-HOLDING-003 (maintainer's rule: actions on a deactivated security are not changed) supersedes it: the spec now expects a 409 that writes nothing, then calls SecuritiesService.activate before the adjustment. The tab hides "+ Add transaction" and per-row Edit on an inactive security and shows a role="note" (transactionHistory.inactiveLocked) saying to activate it on the Securities page.

## Tried and ruled out
Exempting ADD_SHARES/REMOVE_SHARES (or writes that move a position toward zero) from the guard: contradicts the maintainer's flat rule, and Activate is always offered on the list now, so activate-adjust-deactivate is the cleanup path.

## Watch out
Unit specs mock manager.query and pass the guard silently; only the integration suite caught this. Raw-SQL fixtures that insert inactive securities (bond-notifications.integration.spec.ts) bypass the service and are unaffected. To run one integration spec locally: a postgres:18-alpine container on a spare port plus DATABASE_* env, `npm run test:integration -- <name>`.
