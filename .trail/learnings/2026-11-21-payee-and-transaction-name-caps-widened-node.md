---
title: Payee and transaction name caps widened to match DB VARCHAR(255)
author: Node
date: 2026-11-21
branch: claude/issue-2314
cost: { minutes: 35, tokens: 279414 }
touches:
  - backend/src/accounts/dto/create-account.dto.ts
  - backend/src/accounts/dto/update-account.dto.ts
  - backend/src/ai/query/tool-input-schemas.ts
  - backend/src/auth/dto/register.dto.ts
  - backend/src/categories/dto/create-category.dto.ts
  - backend/src/mcp/tools/payees.tool.ts
  - backend/src/mcp/tools/transactions.tool.ts
  - backend/src/payees/dto/create-payee.dto.ts
  - backend/src/scheduled-transactions/dto/create-scheduled-transaction.dto.ts
  - backend/src/transactions/dto/bulk-update.dto.ts
---

## Decided
Issue #2314: several DTO `@MaxLength` caps on name-like fields were stricter than their `database/schema.sql` `VARCHAR(n)` column, the canonical case being `payees.name VARCHAR(255)` vs the API's `MaxLength(100)`. Audited every DTO `@MaxLength`/`@Length` against its VARCHAR column and fixed every mismatch, DB as master, in both directions:
- Widened to 255: payees.name (create/update-payee.dto.ts), categories.name, accounts.name, accounts.institution, scheduled_transactions.name/payee_name, and `TRANSACTION_PAYEE_NAME_MAX_LENGTH` (backend/src/transactions/dto/create-transaction.dto.ts, was 100) which also fixes create-transfer/update-transfer/bulk-update/convert-to-transfer/quick-add since they all import the one constant.
- Tightened to match a column the API had been looser than: `user_preferences.date_format`/`number_format` (VARCHAR(20), API was 50) and `.timezone` (VARCHAR(50), API was 100) -- these were API-accepts-then-DB-truncates-or-500 bugs, not style.
- Added a missing `@MaxLength(255)` on two `email` fields (`register.dto.ts`, `update-profile.dto.ts`) that had none at all against `users.email VARCHAR(255)`.
- Mirrored the `payees.name`/`TRANSACTION_PAYEE_NAME_MAX_LENGTH` fix into the AI Assistant and MCP write tools that duplicate the cap in their own zod schemas (least-guarded-entry-point rule): `backend/src/mcp/tools/payees.tool.ts`, `backend/src/mcp/tools/transactions.tool.ts`, `backend/src/ai/query/tool-input-schemas.ts` (`managePayeesSchema`, `manageTransactionItemSchema`, `aiReviewRequestsFields`).

## Tried and ruled out
Widening every lookup-by-name filter field (list_accounts `accountNames`, list_transactions `payeeNames`/`categoryNames`, etc.) to 255: those are search/filter strings over an existing row, not a write of a new value, so a DB-column mismatch there is a different, lower-priority bug (a long name's exact-match lookup could fail) rather than the write-path truncation this issue is about. Left them at their existing caps.
Touching `categories.description`/`accounts.description` (DTO caps lower than... actually those columns are TEXT, uncapped in the DB) -- a TEXT column has no DB-side limit, so any API cap on it is a product choice, not a mismatch, and out of scope.

## Watch out
`QUICK_ADD_TEXT_MAX_LENGTH` (200, quick-add-text.util.ts) is now SMALLER than `TRANSACTION_PAYEE_NAME_MAX_LENGTH` (255), so the payee-name-splitting code path in `quick-add-fill-payee.util.ts` (`splitAtWord`) can no longer be reached by any Quick Add typed line -- a leftover is always <= ~197 chars, under the new payee cap. Two tests in `quick-add-interpret.service.entries.spec.ts` that exercised that cut were rewritten to assert the name now comes through whole; if `TRANSACTION_PAYEE_NAME_MAX_LENGTH` is ever lowered back under ~200, that cut path becomes reachable again and deserves a real test.
`trail check` flags three conflicts on this change (TRANSACTION_PAYEE_NAME_MAX_LENGTH 100->255 near a scheduled_transactions.reference_number learning; "pins to 1" near an MCP byte-budget learning; "typed line" near a punctuation-folding learning) -- all three are lexical false positives (shared numbers/words, not shared subject matter); none of those learnings' actual rules were touched.
