# Shared expenses: focused first delivery

Status: Approved by the requester on 28 October 2026.
Specification: `docs/specs/shared-expenses-ui-polish.md`, section 0.
Tasks: `docs/future-plans/shared-expenses-ui-polish-tasks.md`.

## Boundary

Group entry, sharing, balances, repayments and shared documents stay available.
New private accounts/postings and Transactions handoffs are deferred. Existing
private records remain readable and explicitly unlinkable without recalculation.
A server guard blocks new private-finance commands before their service runs;
there is no environment or user toggle around it. This is a compatibility boundary,
not a claim that the existing integration source or schema has been removed.

The earlier spec was committed at `69734062d`; Ken's merge at `dede6ceb9` is retained.
No force push, migration, dependency, guard baseline or release change is included.

## Edit map and sequence

1. Add the refusal guard to private-finance create/preview/book and combined
   entry/finance controllers. Test actual HTTP routing, refusal before service
   invocation, and retained read/unlink routes. Keep deferred calculation tests.
2. Remove the new-booking affordances from shared entry, finance and Transactions
   surfaces; handle old handoff URLs explicitly. Show existing private data only
   where it exists, and retain access to unlink. No new category or FX policy.
3. Put staged attachments in `SharedEntryEditor`, reuse `AttachmentsSection` and
   the shared upload API, and close after success. Retain command/file IDs for
   retries and keep a saved-entry state after partial upload failure.
4. Compose `SharedMoneyInput` with the existing square `CurrencyPickerButton`;
   editable currency belongs to the whole entry, dependent amounts are bound.
5. Use `Table` primitives and wrapped phone rows for overview and entries. Reuse
   Transactions filter-panel presentation, preserve server paging/request keys,
   and keep empty, failed and stale results distinguishable.
6. Add focused regressions and update the relevant convention documentation.
   Run gates once, localize final copy, capture the running UI, publish verified
   commits and a new PR progress comment with the actual evidence.

## Observations required

- The six-person trip supports a payer with zero benefit, selected beneficiaries,
  exact 20 plus equal 40/40, explicit zero, and end-trip repayments after reload.
- Save closes with no attachments or successful uploads; failed files retry on
  the same saved expense without duplicate financial entries or uploads.
- Direct private-finance create calls are refused without calling write services.
  Existing reads and explicit unlink keep their prior ownership checks.
- Filters and paging retain their selections; keyboard/touch rows work, money
  stays readable at 320/390px, and the viewport does not widen.
- Group commands leave private accounts/transactions unchanged. Group FX remains
  the existing server-authoritative result; private FX redesign is deferred.

## Verification and resources

Focused UI and HTTP tests during development, then required frontend/backend
lint, types, changed tests, locale checks and builds. Use the native PostgreSQL
and production-browser harness for the persisted group scenario and refusal
checks. Docs and env checks run from the root. No Docker; one heavy process at a
time, 3500 MiB memory limit and 1536 MiB available host reserve. Do not repeat a
broad suite without a material change or unresolved failure.
