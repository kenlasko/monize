---
title: "Rule actions default onlyIfEmpty to true, so a synced row's set_payee is skipped"
author: Node
date: 2026-10-30
branch: claude/issue-1950
cost: { minutes: 2, tokens: 21940 }
touches:
  - backend/test/integration/bank-sync-notifications.integration.spec.ts
  - backend/test/integration/bank-sync.integration.spec.ts
  - backend/src/transaction-rules/rule-references.ts
---

## Decided
- In integration specs that run a rule over a bank-synced (or file-imported) row, set `onlyIfEmpty: false` on `set_payee`, `set_payee_from_text` and `set_category`. The row already holds the bank's payee, and the raw payee's default category when it has one.

## Watch out
- `withActionDefaults` (`backend/src/transaction-rules/rule-references.ts`) stores `onlyIfEmpty: true` for `set_category`, `set_payee` and `set_payee_from_text` when the field is omitted. A test fixture written without it is skipped as `already_set`, with no error: the payee simply never changes. That cost a CI round trip on #1952.
- The worker has no PostgreSQL, so integration cases can only be type-checked locally; check rule fixtures against `ACTION_DEFAULTS` before pushing.
