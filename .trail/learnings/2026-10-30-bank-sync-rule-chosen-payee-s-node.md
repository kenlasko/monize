---
title: "Bank sync: rule-chosen payee's default category, and the import notice target"
author: Node
date: 2026-10-30
branch: claude/issue-1950
cost: { minutes: 21, tokens: 247552 }
touches:
  - backend/src/bank-sync/bank-sync-notifications.spec.ts
  - backend/src/bank-sync/bank-sync-notifications.ts
  - docs/specs/bank-sync-notifications.md
  - backend/src/bank-sync/bank-sync-cron.service.spec.ts
  - backend/src/bank-sync/bank-sync-cron.service.ts
  - backend/src/bank-sync/bank-sync-outcome-notifier.service.spec.ts
  - backend/src/bank-sync/bank-sync-outcome-notifier.service.ts
  - backend/src/bank-sync/bank-sync-preview.service.spec.ts
  - backend/src/bank-sync/bank-sync-preview.service.ts
  - backend/src/bank-sync/bank-sync-rule-payee-category.spec.ts
---

## Decided
- Issue #1950 "process rules during import": the bank sync writer already ran the `import` rules in its write transaction, after the insert. The real defect was that a rule changing the payee (`set_payee`, `set_payee_from_text`) never brings that payee's default category. The fix is bank-sync scoped: `payeeGivingDefaultCategory` / `loadPayeeDefaultCategories` (`backend/src/bank-sync/bank-sync-rule-payee-category.ts`), applied by the writer after `applyToNew` and mirrored in the preview's `newRow`. A rule-set category always wins; a structural action (split or transfer) gets none.
- The `BANK_SYNC_IMPORTED` target is `/transactions?accountId=<id>` for one account and `?accountIds=a,b` for several, or `/transactions?` when it would exceed the 255-character `notifications.target` (`boundedTarget` drops an over-long target whole). Consent and failure notices stay on `/settings/bank-sync`.

## Tried and ruled out
- Planning the rules before the insert and saving the rule's payee: the rules then re-run over a row whose payeeId is already the clean payee, so a rule conditioned on the raw (alias-matched) payee stops matching and its other actions are lost.
- Putting "a rule-set payee brings its default category" into the pure planner (`rule-effects.ts`): it is the right general fix, but it changes rule semantics for every trigger (create, manual run, MCP). That needs agreement first. The file import has the same gap.

## Watch out
- The frontend `notification-target.contract.test.ts` parses targets from backend source: a target must be one string or template literal on the `target:` line, and the query part is ignored when it checks the route exists.
- `useTransactionFilters` applies only singular deep links (`accountId`, `categoryId`, `payeeId`) on soft navigation; `accountIds` is read only when the page mounts.
- `test:changed` on the worker runs in America/Toronto: `loan-payment-frequency.guard.spec.ts` fails there and passes with `TZ=UTC`, as CI runs it.
