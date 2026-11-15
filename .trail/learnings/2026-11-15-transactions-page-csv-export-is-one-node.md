---
title: "Transactions page CSV export is one server-walked request (issue #2198)"
author: Node
date: 2026-11-15
branch: claude/issue-2198
cost: { minutes: 34, tokens: 212537 }
touches:
  - frontend/src/app/transactions/page.test.tsx
  - frontend/src/app/transactions/page.tsx
  - frontend/src/lib/transactions.test.ts
  - frontend/src/lib/transactions.ts
  - frontend/src/types/transaction.ts
  - backend/src/transactions/register-export.spec.ts
  - backend/src/transactions/register-export.ts
  - backend/src/transactions/transactions.controller.spec.ts
  - backend/src/transactions/transactions.controller.ts
  - docs/backend/transactions-and-money.md
---

## Decided
- The Transactions page export calls `GET /transactions/export` (`transactionsApi.getAllForExport`), which walks the register's own `findAll` 200 rows a page inside one request (`collectRegisterExportRows`, `backend/src/transactions/register-export.ts`). The client loop over `GET /transactions` at 50 rows a page hit the global 100/min ThrottlerGuard limit on a 26k-row ledger ("Too many requests").
- `GET /` and `/export` share `resolveRegisterListing` + `findRegisterPage` in `transactions.controller.ts`, so filters, sort, the delegate's readable set and the joint scope cannot drift between them. The route carries `@Throttle` 10/min.
- The answer is a slim `TransactionExportRow` (names only, same nesting as the full row) so the client CSV builder is unchanged and the payload stays small.

## Tried and ruled out
- A client-side walk with `getAllPages` (200/page) still needs 130 requests for 26k rows, which is over the limit. Retrying on 429 eats the user's whole request budget for minutes.
- Raising the throttle on `GET /transactions` weakens a limit (ask-first).
- Moving the CSV builder to the server would make a third CSV builder, twin to the frontend one.

## Watch out
- The slim projection drops the `userId`/`accountId` fields the transfer mask keys on. The mask therefore runs on the full rows before projecting; the HTTP interceptor finds nothing to mask on a slim row.
- `test/transactions.e2e-spec.ts` is broken (documented). To check route resolution over HTTP, use a throwaway supertest spec with all seven controller providers mocked.
- Each page is a full `findAll` (id page, rows, count, maybe the seed balance) in its own transaction, so an edit made mid-walk can shift offsets, as the old client walk could.
