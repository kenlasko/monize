---
title: "Issue #2323 round 2: refuse investment writes on a deactivated security"
author: Node
date: 2026-11-22
branch: claude/issue-2323
cost: { minutes: 28, tokens: 211770 }
touches:
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/errors.json
  - backend/src/i18n/locales/id/errors.json
  - backend/src/i18n/locales/it/errors.json
  - backend/src/i18n/locales/ja/errors.json
  - backend/src/i18n/locales/ko/errors.json
  - backend/src/i18n/locales/nl/errors.json
  - backend/src/i18n/locales/pl/errors.json
---

## Decided
Supersedes the round-one note that left this as a separate proposal: the maintainer asked for the guard in the same PR ("actions involving deactivated securities should not be allowed to be changed").
One helper, `assertSecuritiesActiveIn(manager, userId, ids)` (backend/src/securities/inactive-security.util.ts), called inside each write's transaction after `lockHoldingScope`, before the first write: InvestmentTransactionsService create, transferSecurity, update, updateLinkedTransfer, updateStatus (VOID crossings only), remove, createEmbeddedForSplit, reverseAndRemoveEmbedded, applyParentStatusToEmbeddedRows (VOID crossings only); ActionHistoryService undoInvestmentCreate/Delete/Update; the QIF/OFX row in import-investment-processor. AI/MCP previews use `assertSecurityActive(entity)` so a card is never offered. 409 `errors.securities.inactiveSecurityLocked`.
Concurrency: writers read the security `FOR KEY SHARE` (what the FK takes anyway); `deactivate` now locks the row `FOR UPDATE` and counts holdings in the same transaction. No cycle: deactivate takes no other lock, and bond recomputes run after commit.
`inactive-security.guard.spec.ts` lists every path (pattern copied from reconciled-lock.guard.spec.ts). INV-HOLDING-003.

## Tried and ruled out
Refusing clear/reconcile status changes too: they move no shares, and refusing them would block reconciling a cash account whose split embeds an inactive-security line.
Guarding backup restore, MNY/KMY import, removeAll, account/user deletes: whole-ledger rewrites, not edits of a security's rows.

## Watch out
A cash transaction whose split embeds an inactive security's line cannot be re-saved with its splits (the rebuild deletes and recreates the embedded row), even for a memo edit. That is intended by the rule; the message says to activate first.
The service spec's default `manager.query` mock answers [] to anything without FOR UPDATE, so existing specs pass the guard silently; `stageDeactivatedSecurity()` in the spec is how to exercise it.
