---
title: "Bank sync review: read the rule trace, not net changes; a notice target needs a query"
author: Node
date: 2026-10-30
branch: claude/issue-1950
cost: { minutes: 7, tokens: 70262 }
touches:
  - backend/src/bank-sync/bank-sync-notifications.spec.ts
  - backend/src/bank-sync/bank-sync-notifications.ts
  - docs/specs/bank-sync-notifications.md
  - backend/src/bank-sync/bank-sync-preview.service.spec.ts
  - backend/src/bank-sync/bank-sync-preview.service.ts
  - backend/src/bank-sync/bank-sync-rule-payee-category.spec.ts
  - backend/src/bank-sync/bank-sync-rule-payee-category.ts
  - backend/src/bank-sync/bank-sync-writer.service.spec.ts
  - backend/src/bank-sync/bank-sync-writer.service.ts
  - backend/test/integration/bank-sync.integration.spec.ts
---

## Decided
- Whether a rule "decided" a row's category is read from `RuleEffects.trace`, not `changes`: a `set_category` that matches the current category is skipped as `no_change` and leaves no `categoryId` in the net changes. `payeeGivingDefaultCategory` (`backend/src/bank-sync/bank-sync-rule-payee-category.ts`) treats an applied `set_category`, or one skipped as `no_change`/`already_set`, as the rule's decision.
- The import notice's fallback target is `/transactions?accountStatus=all` (`EVERY_ACCOUNT_QUERY`). A bare `/transactions?` has no URL params, so `useTransactionFilters` restores the reader's saved localStorage filters.

## Tried and ruled out
- Applying `accountIds` on soft navigation in `useTransactionFilters`: the page's own URL rewrites emit the plural params, so a watcher on them would fight the page. That would be a frontend change of its own; the spec documents the limit instead.

## Watch out
- Any query param counts as "URL-driven" in `useTransactionFilters` (`hasAnyUrlParams`) and clears the other saved filters; no query restores them all.
- A unit-test fixture whose trace says `set_category` applied now means "a rule decided the category"; keep fixtures' traces consistent with their net changes.
