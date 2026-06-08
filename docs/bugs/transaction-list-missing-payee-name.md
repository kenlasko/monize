# Bug: transaction list shows "-" for payee when only `payeeId` is set

## Symptom
In the transaction list, the payee column shows `-` (empty) for transactions
that have a `payeeId` (foreign key to the payee) but a `null` `payeeName`. Opening
the transaction detail shows the payee correctly.

Example API response:
```json
{ "payeeName": null, "payeeId": "04b2701c-1e0a-43c5-9c12-e9526aff13ed" }
```
Reported after bulk-importing ~8,400 transactions via the REST API using only
`payeeId` (no `payeeName`).

## Root cause
`payeeName` is a **denormalized** column on `transactions`, kept alongside the
`payeeId` FK and the `payee` relation (`backend/.../transaction.entity.ts`).
Create/update store whatever `payeeName` the client sends and do **not** derive
it from `payeeId` (`transactions.service.ts`), so `payeeName` can legitimately be
`null` while `payeeId` is set.

The list **does** load the payee relation — `findAll` uses
`leftJoinAndSelect("transaction.payee", "payee")` — and the frontend `Transaction`
type includes `payee`. The actual defect is in the renderer:
`frontend/src/components/transactions/TransactionRow.tsx` rendered
`{transaction.payeeName || '-'}` with **no fallback** to `transaction.payee?.name`.

This made `TransactionRow` inconsistent with the rest of the app, which already
falls back to the linked payee name:
- `app/transactions/page.tsx` (CSV export): `tx.payee?.name ?? tx.payeeName`
- `components/transactions/RecentTransactionsPopover.tsx`: `t.payeeName || t.payee?.name`
- `components/dashboard/UpcomingBills.tsx`: `item.payeeName || item.payee?.name`

## Fix
`TransactionRow.tsx` now derives a single `payeeLabel`:
```ts
const payeeLabel = transaction.payeeName || transaction.payee?.name || null;
```
and uses it for the payee text and the title attributes in both the
clickable-button and plain-text branches. The payee data is already fetched, so
this is a display-only fix — no schema, write-path, or migration changes.

## Notes / not done here
The original report also proposed auto-populating `payeeName` from `payeeId` on
`POST`/`PATCH` plus a backfill migration for the ~8,400 existing rows. That is a
reasonable API-contract / data-hygiene improvement but is **separate** from this
display fix and not required to resolve the symptom. If pursued, it should keep
the write paths transactional (QueryRunner) and would not change `schema.sql`
(data backfill only).

## Verification
- New `TransactionRow` tests: payee name still renders from `payeeName`, and now
  also falls back to `payee.name` when `payeeName` is null (button + text branches).
- `tsc --noEmit` clean.
