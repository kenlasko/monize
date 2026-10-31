---
title: Accounts list Unreconciled count and keeping the accounts page live
author: Node
date: 2026-10-31
branch: claude/issue-1961
cost: { minutes: 18, tokens: 189264 }
touches:
  - frontend/src/app/accounts/page.test.tsx
  - frontend/src/app/accounts/page.tsx
  - frontend/src/i18n/messages/de/accounts.json
  - frontend/src/i18n/messages/es/accounts.json
  - frontend/src/i18n/messages/fr/accounts.json
  - frontend/src/i18n/messages/hi/accounts.json
  - frontend/src/i18n/messages/id/accounts.json
  - frontend/src/i18n/messages/it/accounts.json
  - frontend/src/i18n/messages/ja/accounts.json
  - frontend/src/i18n/messages/ko/accounts.json
---

## Decided
- Account.unreconciledCount comes from AccountsService.findAll: COUNT of top-level (LEDGER_MOVEMENT_PREDICATE) rows with status UNRECONCILED or CLEARED, no date bound. That is exactly what getReconciliationData lists, so the column and the reconcile screen agree. Zero when none.
- The column reads unreconciledCountOf(account, logical) in AccountRow.tsx, over reconcileLedgerOf like Last Reconciled: a pair's cash half, null (blank cell) for a bare brokerage or a joint row. Sortable, so it joins SORT_FIELD_LABEL_KEYS and the phone card carries it too.
- "Live" on the accounts page: status writes (updateStatus, bulkReconcile, bulkUpdate, create/update/delete) already call invalidateBalanceCaches, so returning to the page is fresh. For writes the tab never saw (another tab or device), the page re-reads with accountsApi.getAllFresh (invalidates accounts:all:<flag>, then getAll) through useRereadOnVisible, guarded by an in-flight ref because focus and visibilitychange both fire on one return.

## Tried and ruled out
- Subscribing the accounts page to subscribeReconciliation: only /reconcile raises it and that page is never mounted alongside /accounts, so it could never fire.

## Watch out
- AccountRow now calls useNumberFormat; a test mocking that hook without numberFormatMockDefaults() crashes on formatNumber (AccountList.mobileWrapped.test had to change).
- Frontend eslint and type-check OOM here without NODE_OPTIONS=--max-old-space-size=4096.
